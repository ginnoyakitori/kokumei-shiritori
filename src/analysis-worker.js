"use strict";

const {
    parentPort
} = require("node:worker_threads");

const cpu =
    require("./cpu");

const analyzer =
    require("./analyzer");


/* =========================================================
   解析結果の保存
========================================================= */

/*
 * 対局中に先行解析した局面を保存する。
 *
 * キー:
 * roomId:turnNumber
 *
 * 値:
 * {
 *     roomId,
 *     turnNumber,
 *     currentLetter,
 *     usedWordCount,
 *     nEndCount,
 *     result,
 *     completedAt
 * }
 */
const positionResults =
    new Map();


/* =========================================================
   Worker起動確認
========================================================= */

if (!parentPort) {
    throw new Error(
        "analysis-worker.jsはWorkerスレッドから起動してください。"
    );
}


/* =========================================================
   メッセージ受信
========================================================= */
parentPort.on(
    "message",
    message => {
        try {
            handleMessage(
                message
            );
        } catch (error) {
            /*
             * スタックトレースはサーバーのログにだけ残す。
             */
            console.error(
                "[analysis-worker]",
                error
            );

            parentPort.postMessage({
                success:
                    false,

                type:
                    "worker-error",

                jobId:
                    message?.jobId ??
                    null,

                roomId:
                    message?.roomId ??
                    "",

                error:
                    normalizeErrorMessage(
                        error
                    )
            });
        }
    }
);

/* =========================================================
   処理の振り分け
========================================================= */
function handleMessage(
    message = {}
) {
    const type =
        String(
            message.type ?? ""
        );

    switch (type) {
        case "cpu-move":
            cpuMoveJob(
                message
            );
            break;

        case "analyze-position":
            analyzePositionJob(
                message
            );
            break;

        case "analyze-game":
            analyzeGameJob(
                message
            );
            break;

        case "get-room-results":
            getRoomResultsJob(
                message
            );
            break;

        case "clear-room":
            clearRoomJob(
                message
            );
            break;

        case "clear-all":
            clearAllJob(
                message
            );
            break;

        case "ping":
            parentPort.postMessage({
                success:
                    true,

                type:
                    "pong",

                jobId:
                    message.jobId ??
                    null,

                timestamp:
                    Date.now()
            });
            break;

        default:
            parentPort.postMessage({
                success:
                    false,

                type:
                    "unsupported-job",

                jobId:
                    message.jobId ??
                    null,

                roomId:
                    message.roomId ??
                    "",

                error:
                    `未対応の解析処理です: ${
                        type || "未指定"
                    }`
            });
            break;
    }
}


/* =========================================================
   CPUの手
========================================================= */

function cpuMoveJob(
    message
) {
    const state =
        normalizeState(
            message.state
        );

    const settings =
        normalizeObject(
            message.settings
        );

    const options =
        normalizeObject(
            message.options
        );

    /*
     * normal : 評価関数による「強いCPU」
     * それ以外: 探索による「最強CPU」
     */
    const move =
        settings.cpuLevel ===
        "normal"
            ? cpu.strongMove(
                state,
                settings
            )
            : cpu.bestMove(
                state,
                settings,
                options
            );

    parentPort.postMessage({
        success:
            true,

        type:
            "cpu-move-result",

        jobId:
            message.jobId ??
            null,

        move
    });
}

/* =========================================================
   単一局面の解析
========================================================= */

function analyzePositionJob(
    message
) {
    const jobId =
        message.jobId ??
        null;

    const roomId =
        normalizeRoomId(
            message.roomId
        );

    const turnNumber =
        normalizeNonNegativeInteger(
            message.turnNumber,
            0
        );

    if (!roomId) {
        throw new Error(
            "局面解析に必要なルームIDがありません。"
        );
    }

    const state =
        normalizeState(
            message.state
        );

    const settings =
        normalizeObject(
            message.settings
        );

    const options =
        normalizeAnalysisOptions(
            message.options
        );

    const result =
        cpu.analyzePosition(
            state,
            settings,
            options
        );

    const storedResult = {
        roomId,
        turnNumber,

        currentLetter:
            state.currentLetter,

        usedWordCount:
            state.usedWords.length,

        nEndCount:
            state.nEndCount,

        result,

        completedAt:
            Date.now()
    };

    positionResults.set(
        createResultKey(
            roomId,
            turnNumber
        ),
        storedResult
    );

    parentPort.postMessage({
        success:
            true,

        type:
            "position-result",

        jobId,
        roomId,
        turnNumber,
        result
    });
}


/* =========================================================
   対局全体の解析
========================================================= */

function analyzeGameJob(
    message
) {
    const jobId =
        message.jobId ??
        null;

    const roomId =
        normalizeRoomId(
            message.roomId
        );

    const history =
        Array.isArray(
            message.history
        )
            ? message.history
            : [];

    const settings =
        normalizeObject(
            message.settings
        );

    const startLetter =
        String(
            message.startLetter ??
            ""
        );

    const gameResult =
        normalizeGameResult(
            message.gameResult
        );

    /*
     * analyzer.jsで棋譜全体を解析する。
     */
    const result =
        analyzer.analyze(
            history,
            settings,
            startLetter,
            gameResult
        );

    /*
     * 対局中に先行解析した結果も取得する。
     */
    const preliminaryResults =
        roomId
            ? collectRoomResults(
                roomId
            )
            : [];

    /*
     * analyzer.analyze()が
     * success:falseを返した場合も、
     * Worker自体は正常に応答する。
     */
    if (
        result?.success ===
        false
    ) {
        parentPort.postMessage({
            success:
                false,

            type:
                "game-result",

            jobId,
            roomId,

            result,

            preliminaryResults,

            precomputedPositionCount:
                preliminaryResults.length,

            error:
                result.error ??
                "対局解析に失敗しました。"
        });

        return;
    }

    parentPort.postMessage({
        success:
            true,

        type:
            "game-result",

        jobId,
        roomId,

        result,

        preliminaryResults,

        precomputedPositionCount:
            preliminaryResults.length
    });
}


/* =========================================================
   先行解析結果の取得
========================================================= */

function getRoomResultsJob(
    message
) {
    const jobId =
        message.jobId ??
        null;

    const roomId =
        normalizeRoomId(
            message.roomId
        );

    const results =
        roomId
            ? collectRoomResults(
                roomId
            )
            : [];

    parentPort.postMessage({
        success:
            true,

        type:
            "room-results",

        jobId,
        roomId,
        results
    });
}


/* =========================================================
   ルーム別解析結果の削除
========================================================= */

function clearRoomJob(
    message
) {
    const jobId =
        message.jobId ??
        null;

    const roomId =
        normalizeRoomId(
            message.roomId
        );

    const removedCount =
        clearRoomResults(
            roomId
        );

    parentPort.postMessage({
        success:
            true,

        type:
            "room-cleared",

        jobId,
        roomId,
        removedCount
    });
}


/* =========================================================
   すべての解析結果を削除
========================================================= */

function clearAllJob(
    message
) {
    const jobId =
        message.jobId ??
        null;

    const removedCount =
        positionResults.size;

    positionResults.clear();

    /*
     * cpu.js内部の局面キャッシュも削除する。
     */
    if (
        typeof cpu.clearAnalysisCache ===
        "function"
    ) {
        cpu.clearAnalysisCache();
    }

    parentPort.postMessage({
        success:
            true,

        type:
            "all-cleared",

        jobId,
        removedCount
    });
}


/* =========================================================
   ルーム別解析結果
========================================================= */

function collectRoomResults(
    roomId
) {
    return Array.from(
        positionResults.values()
    )
        .filter(item => {
            return (
                item.roomId ===
                roomId
            );
        })
        .sort((a, b) => {
            return (
                a.turnNumber -
                b.turnNumber
            );
        })
        .map(item => {
            return {
                roomId:
                    item.roomId,

                turnNumber:
                    item.turnNumber,

                currentLetter:
                    item.currentLetter,

                usedWordCount:
                    item.usedWordCount,

                nEndCount:
                    item.nEndCount,

                result:
                    item.result,

                completedAt:
                    item.completedAt
            };
        });
}

function clearRoomResults(
    roomId
) {
    if (!roomId) {
        return 0;
    }

    let removedCount = 0;

    for (
        const [
            key,
            item
        ]
        of positionResults.entries()
    ) {
        if (
            item.roomId !==
            roomId
        ) {
            continue;
        }

        positionResults.delete(
            key
        );

        removedCount += 1;
    }

    return removedCount;
}

function createResultKey(
    roomId,
    turnNumber
) {
    return (
        `${roomId}:` +
        `${turnNumber}`
    );
}


/* =========================================================
   状態の正規化
========================================================= */

function normalizeState(
    rawState = {}
) {
    return {
        currentLetter:
            String(
                rawState
                    ?.currentLetter ??
                ""
            ),

        usedWords:
            Array.isArray(
                rawState
                    ?.usedWords
            )
                ? rawState.usedWords
                : [],

        history:
            Array.isArray(
                rawState
                    ?.history
            )
                ? rawState.history
                : [],

        nEndCount:
            normalizeNonNegativeInteger(
                rawState
                    ?.nEndCount,
                0
            )
    };
}

function normalizeGameResult(
    rawResult = {}
) {
    return {
        winner:
            rawResult
                ?.winner ??
            null,

        loser:
            rawResult
                ?.loser ??
            null,

        reason:
            String(
                rawResult
                    ?.reason ??
                ""
            )
    };
}

function normalizeAnalysisOptions(
    rawOptions = {}
) {
    return {
        maxDepth:
            normalizePositiveInteger(
                rawOptions?.maxDepth,
                4
            ),

        maxNodes:
            normalizePositiveInteger(
                rawOptions?.maxNodes,
                700
            ),

        maxMoves:
            normalizePositiveInteger(
                rawOptions?.maxMoves,
                10
            ),

        limitedMoves:
            normalizePositiveInteger(
                rawOptions
                    ?.limitedMoves,
                4
            )
    };
}

function normalizeObject(value) {
    return (
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
    )
        ? value
        : {};
}

function normalizeRoomId(value) {
    return String(
        value ?? ""
    ).trim();
}

function normalizePositiveInteger(
    value,
    fallback
) {
    const number =
        Number(value);

    if (
        !Number.isFinite(number) ||
        number <= 0
    ) {
        return fallback;
    }

    return Math.floor(
        number
    );
}

function normalizeNonNegativeInteger(
    value,
    fallback
) {
    const number =
        Number(value);

    if (
        !Number.isFinite(number) ||
        number < 0
    ) {
        return fallback;
    }

    return Math.floor(
        number
    );
}


/* =========================================================
   エラー
========================================================= */
function normalizeErrorMessage(
    error
) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(
        error ??
        "解析処理に失敗しました。"
    );
}