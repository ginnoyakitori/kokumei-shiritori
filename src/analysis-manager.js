"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

const WORKER_FILE = path.join(__dirname, "analysis-worker.js");

/* 1レーンで待たせられるジョブ数の上限 */
const MAX_QUEUE_PER_LANE = 10;

/* 再起動が多すぎる場合は、一定時間ジョブを受け付けない */
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS_IN_WINDOW = 5;

/* 既定のタイムアウト(実行開始からの時間) */
const TIMEOUT_ANALYZE_GAME_MS = 45000;
const TIMEOUT_ANALYZE_POSITION_MS = 8000;
const TIMEOUT_CPU_MOVE_MS = 10000;
const TIMEOUT_SMALL_JOB_MS = 5000;


/* =========================================================
   エラー
========================================================= */

class AnalysisError extends Error {
    /**
     * @param {string} message  ログ用メッセージ
     * @param {string} code     エラー種別
     * @param {string} userMessage クライアントへ返してよい文言
     */
    constructor(message, code, userMessage) {
        super(message);

        this.name = "AnalysisError";
        this.code = code;
        this.userMessage = userMessage;
    }
}

function createError(code, detail = "") {
    switch (code) {
        case "TIMEOUT":
            return new AnalysisError(
                `処理が上限時間を超えました。${detail}`,
                code,
                "解析に時間がかかりすぎたため中断しました。"
            );

        case "BUSY":
            return new AnalysisError(
                "待機中のジョブが上限に達しています。",
                code,
                "解析が混み合っています。しばらくしてからもう一度お試しください。"
            );

        case "UNSTABLE":
            return new AnalysisError(
                "解析ワーカーの再起動が短時間に続いています。",
                code,
                "解析機能が不安定です。しばらくしてからもう一度お試しください。"
            );

        case "CLOSED":
            return new AnalysisError(
                "解析マネージャーは終了しています。",
                code,
                "サーバー終了のため解析できません。"
            );

        default:
            return new AnalysisError(
                `解析処理に失敗しました。${detail}`,
                "WORKER",
                "対局を解析できませんでした。"
            );
    }
}


/* =========================================================
   ジョブID
========================================================= */

let jobSequence = 0;

function createJobId() {
    jobSequence += 1;
    return `analysis-${Date.now()}-${jobSequence}`;
}


/* =========================================================
   レーン(workerを1本持ち、ジョブを1件ずつ実行する)
========================================================= */

class Lane {
    constructor(name) {
        this.name = name;
        this.worker = null;
        this.current = null;
        this.queue = [];
        this.restartTimes = [];
        this.closed = false;
    }

    /** ジョブを待ち行列へ入れ、結果のPromiseを返す */
    enqueue(message, timeoutMilliseconds) {
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(createError("CLOSED"));
                return;
            }

            if (this.countRecentRestarts() >= MAX_RESTARTS_IN_WINDOW) {
                reject(createError("UNSTABLE"));
                return;
            }

            if (this.queue.length >= MAX_QUEUE_PER_LANE) {
                reject(createError("BUSY"));
                return;
            }

            this.queue.push({
                jobId: createJobId(),
                message,
                timeoutMilliseconds,
                resolve,
                reject,
                timeoutId: null
            });

            this.next();
        });
    }

    /** 実行中でなければ、次のジョブを開始する */
    next() {
        if (this.current || this.queue.length === 0) {
            return;
        }

        const job = this.queue.shift();

        let worker;

        try {
            worker = this.ensureWorker();
        } catch (error) {
            console.error(`[analysis-manager:${this.name}] worker作成失敗`, error);

            job.reject(createError("WORKER", String(error?.message ?? "")));
            this.next();

            return;
        }

        this.current = job;

        /* タイムアウトは実行開始時点から測る */
        job.timeoutId = setTimeout(() => {
            this.handleTimeout(job);
        }, job.timeoutMilliseconds);

        try {
            worker.postMessage({
                ...job.message,
                jobId: job.jobId
            });
        } catch (error) {
            this.finish(job);
            job.reject(createError("WORKER", String(error?.message ?? "")));
            this.next();
        }
    }

    /** workerがなければ作る */
    ensureWorker() {
        if (this.worker) {
            return this.worker;
        }

        const worker = new Worker(WORKER_FILE);

        worker.on("message", message => {
            this.handleMessage(worker, message);
        });

        worker.on("error", error => {
            this.handleCrash(worker, error);
        });

        worker.on("exit", exitCode => {
            this.handleCrash(
                worker,
                new Error(`workerが停止しました。終了コード: ${exitCode}`)
            );
        });

        this.worker = worker;

        return worker;
    }

    /** 実行中ジョブを終了扱いにする(タイマー解除) */
    finish(job) {
        clearTimeout(job.timeoutId);

        if (this.current === job) {
            this.current = null;
        }
    }

    /** workerからの応答 */
    handleMessage(worker, message) {
        /* 破棄済みworkerからの遅れた応答は無視する */
        if (worker !== this.worker) {
            return;
        }

        const job = this.current;

        if (!job || message?.jobId !== job.jobId) {
            return;
        }

        this.finish(job);

        if (message.success === false) {
            /*
             * game-resultの失敗は「開始文字がない」などの
             * 利用者向けメッセージなのでそのまま返す。
             * それ以外(worker-errorなど)は内部情報を含むので
             * ログだけに出し、利用者には定型文を返す。
             */
            if (message.type === "game-result") {
                const error = new AnalysisError(
                    message.error ?? "対局解析に失敗しました。",
                    "ANALYSIS_FAILED",
                    message.error ?? "対局を解析できませんでした。"
                );

                job.reject(error);
            } else {
                console.error(
                    `[analysis-manager:${this.name}] workerエラー`,
                    message.error
                );

                job.reject(createError("WORKER"));
            }

            this.next();
            return;
        }

        job.resolve(message);
        this.next();
    }

    /** タイムアウト: workerを強制終了して作り直す */
    handleTimeout(job) {
        if (this.current !== job) {
            return;
        }

        console.warn(
            `[analysis-manager:${this.name}] ` +
            `ジョブがタイムアウトしました(${job.timeoutMilliseconds}ms)。` +
            "workerを再起動します。"
        );

        this.current = null;

        job.reject(createError("TIMEOUT"));

        this.discardWorker();
        this.next();
    }

    /** worker異常終了・エラー */
    handleCrash(worker, error) {
        /* すでに破棄したworkerのイベントは無視する */
        if (worker !== this.worker) {
            return;
        }

        console.error(
            `[analysis-manager:${this.name}] workerが異常終了しました。`,
            error
        );

        this.worker = null;
        this.restartTimes.push(Date.now());

        const job = this.current;

        if (job) {
            this.finish(job);
            job.reject(createError("WORKER", String(error?.message ?? "")));
        }

        this.next();
    }

    /** workerを強制終了する(実行中の同期計算も止まる) */
    discardWorker() {
        const old = this.worker;

        this.worker = null;
        this.restartTimes.push(Date.now());

        if (old) {
            old.terminate().catch(error => {
                console.error(
                    `[analysis-manager:${this.name}] terminate失敗`,
                    error
                );
            });
        }
    }

    countRecentRestarts() {
        const threshold = Date.now() - RESTART_WINDOW_MS;

        this.restartTimes = this.restartTimes.filter(
            time => time >= threshold
        );

        return this.restartTimes.length;
    }

    /** 終了処理 */
    async close(reason) {
        this.closed = true;

        const error = new AnalysisError(
            reason,
            "CLOSED",
            "サーバー終了のため解析できません。"
        );

        for (const job of this.queue) {
            job.reject(error);
        }

        this.queue = [];

        if (this.current) {
            const job = this.current;

            this.finish(job);
            job.reject(error);
        }

        const worker = this.worker;

        this.worker = null;

        if (worker) {
            await worker.terminate();
        }
    }

    getStatus() {
        return {
            workerRunning: this.worker !== null,
            running: this.current !== null,
            queued: this.queue.length,
            recentRestarts: this.countRecentRestarts()
        };
    }
}

const lanes = {
    /* 対局解析・先行解析結果の保存 */
    analysis: new Lane("analysis"),

    /* CPUの手 */
    cpu: new Lane("cpu")
};


/* =========================================================
   公開API
========================================================= */

/**
 * 対局終了後に棋譜全体を解析する。
 */
function analyzeGame({
    roomId = "",
    history = [],
    settings = {},
    startLetter = "",
    gameResult = {},
    timeoutMilliseconds = TIMEOUT_ANALYZE_GAME_MS
}) {
    return lanes.analysis.enqueue(
        {
            type: "analyze-game",
            roomId: String(roomId ?? ""),
            history: Array.isArray(history) ? history : [],
            settings: settings ?? {},
            startLetter: String(startLetter ?? ""),
            gameResult: {
                winner: gameResult?.winner ?? null,
                loser: gameResult?.loser ?? null,
                reason: String(gameResult?.reason ?? "")
            }
        },
        normalizePositiveInteger(
            timeoutMilliseconds,
            TIMEOUT_ANALYZE_GAME_MS
        )
    );
}

/**
 * 対局中の局面を解析する(結果はworker内に保存される)。
 */
function analyzePosition({
    roomId,
    turnNumber,
    state,
    settings,
    options = {}
}) {
    const normalizedRoomId = String(roomId ?? "").trim();

    if (!normalizedRoomId) {
        return Promise.reject(
            new Error("局面解析に必要なルームIDがありません。")
        );
    }

    return lanes.analysis.enqueue(
        {
            type: "analyze-position",
            roomId: normalizedRoomId,
            turnNumber: Number(turnNumber ?? 0),
            state: state ?? {},
            settings: settings ?? {},
            options: options ?? {}
        },
        normalizePositiveInteger(
            options?.timeoutMilliseconds,
            TIMEOUT_ANALYZE_POSITION_MS
        )
    );
}

/**
 * CPU(強い・最強)の手を求める。
 * 結果は response.move に入る。
 */
function cpuMove({
    state = {},
    settings = {},
    options = {},
    timeoutMilliseconds = TIMEOUT_CPU_MOVE_MS
}) {
    return lanes.cpu.enqueue(
        {
            type: "cpu-move",
            state,
            settings,
            options
        },
        normalizePositiveInteger(
            timeoutMilliseconds,
            TIMEOUT_CPU_MOVE_MS
        )
    );
}

/**
 * 対局中に解析した局面一覧を取得する。
 */
function getRoomResults(roomId) {
    const normalizedRoomId = String(roomId ?? "").trim();

    if (!normalizedRoomId || !lanes.analysis.worker) {
        return Promise.resolve({
            success: true,
            type: "room-results",
            roomId: normalizedRoomId,
            results: []
        });
    }

    return lanes.analysis.enqueue(
        {
            type: "get-room-results",
            roomId: normalizedRoomId
        },
        TIMEOUT_SMALL_JOB_MS
    );
}

/**
 * 指定ルームの解析結果を削除する。
 * workerがまだ起動していなければ、何もせず完了する。
 */
function clearRoom(roomId) {
    const normalizedRoomId = String(roomId ?? "").trim();

    if (!normalizedRoomId || !lanes.analysis.worker) {
        return Promise.resolve({
            success: true,
            type: "room-cleared",
            roomId: normalizedRoomId
        });
    }

    return lanes.analysis.enqueue(
        {
            type: "clear-room",
            roomId: normalizedRoomId
        },
        TIMEOUT_SMALL_JOB_MS
    );
}

/**
 * デバッグ用の状態表示。
 */
function getStatus() {
    return {
        analysis: lanes.analysis.getStatus(),
        cpu: lanes.cpu.getStatus()
    };
}

/**
 * サーバー終了時にworkerを終了する。
 */
async function terminate() {
    await Promise.all([
        lanes.analysis.close("サーバー終了のため、解析処理を停止しました。"),
        lanes.cpu.close("サーバー終了のため、CPU処理を停止しました。")
    ]);

    return { terminated: true };
}


/* =========================================================
   数値の正規化
========================================================= */

function normalizePositiveInteger(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
        return fallback;
    }

    return Math.floor(number);
}


module.exports = {
    analyzeGame,
    analyzePosition,
    cpuMove,

    getRoomResults,
    clearRoom,

    getStatus,
    terminate
};