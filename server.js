"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const logic = require("./src/logic");
const cpu = require("./src/cpu");
const matchmaking = require("./src/matchmaking");
const analysisManager = require("./src/analysis-manager");
const {
    normalizeSettings: sanitizeSettings,
    pickRuleSettings
} = require("./src/settings");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/* roomId => ゲーム情報 */
const onlineGames = new Map();
/* roomId => intervalId (20秒タイマー) */
const timers = new Map();
/* roomId => intervalId (カウントダウン) */
const countdownTimers = new Map();


/* =========================================================
   入力サイズ制限・サニタイズ
========================================================= */

const MAX_USED_WORDS = 300;
const MAX_HISTORY = 300;
const MAX_TEXT = 100;

function toText(value, max = MAX_TEXT) {
    return String(value ?? "").slice(0, max);
}

function sanitizeType(type) {
    return type === "country" || type === "capital" ? type : null;
}

function sanitizeUsedWords(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .slice(0, MAX_USED_WORDS)
        .map(item => {
            if (typeof item === "string") {
                return toText(item);
            }

            if (!item || typeof item !== "object") {
                return null;
            }

            return {
                id: toText(item.id),
                name: toText(item.name ?? item.word),
                word: toText(item.word ?? item.name),
                reading: toText(item.reading ?? item.name ?? item.word),
                type: sanitizeType(item.type)
            };
        })
        .filter(Boolean);
}

function sanitizeHistory(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .slice(0, MAX_HISTORY)
        .map((item, index) => {
            if (typeof item === "string") {
                return toText(item);
            }

            if (!item || typeof item !== "object") {
                return null;
            }

            return {
                turnNumber: Number.isFinite(Number(item.turnNumber))
                    ? Math.floor(Number(item.turnNumber))
                    : index + 1,
                player: item.player == null ? null : toText(item.player),
                word: toText(item.word ?? item.name),
                reading: toText(item.reading),
                type: sanitizeType(item.type),
                requiredLetter: toText(item.requiredLetter, 4),
                immediateLoss: item.immediateLoss === true,
                lossReason: toText(item.lossReason)
            };
        })
        .filter(Boolean);
}

function sanitizeNEndCount(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return 0;
    }

    return Math.min(Math.floor(number), 1000);
}

function sanitizeCpuState(raw) {
    const state = raw && typeof raw === "object" ? raw : {};

    return {
        currentLetter: toText(state.currentLetter, 4),
        usedWords: sanitizeUsedWords(state.usedWords),
        history: sanitizeHistory(state.history),
        nEndCount: sanitizeNEndCount(state.nEndCount)
    };
}

/**
 * ソケットごとの簡易レート制限。
 * windowMs の間に max 回まで許可する。
 */
function allow(socket, key, max, windowMs) {
    const now = Date.now();

    socket.data.rate = socket.data.rate ?? {};

    const entry = socket.data.rate[key];

    if (!entry || now - entry.start >= windowMs) {
        socket.data.rate[key] = { start: now, count: 1 };
        return true;
    }

    entry.count += 1;
    return entry.count <= max;
}


/* =========================================================
   Socket.IO接続処理
========================================================= */

io.on("connection", socket => {
    console.log(`[接続] ${socket.id}`);

    /* CPU対戦用の開始文字を取得する */
    socket.on("getRandomStartLetter", rawSettings => {
        if (!allow(socket, "getRandomStartLetter", 10, 1000)) {
            return;
        }

        const settings = sanitizeSettings(rawSettings);
        const startLetter = logic.randomStartLetter(settings);

        if (!startLetter) {
            socket.emit("randomStartLetter", {
                success: false,
                letter: "",
                message: "使用可能な開始文字がありません。"
            });

            return;
        }

        const words = logic.getGuideWords(startLetter, [], settings);

        socket.emit("randomStartLetter", {
            success: true,
            letter: startLetter,
            words
        });
    });

           /* オンライン対戦のマッチング */
    socket.on("findMatch", rawSettings => {
        /*
         * 対局中は新しいマッチングを受け付けない。
         * 対局情報が残っているだけ(対局はすでに終了)の場合は片付ける。
         */
        const currentRoomId = matchmaking.getPlayerRoom(socket.id);

        if (currentRoomId) {
            if (onlineGames.has(currentRoomId)) {
                socket.emit("matchingError", {
                    message: "対局中のため、新しいマッチングは開始できません。"
                });

                return;
            }

            matchmaking.removeRoom(currentRoomId);
        }

        matchmaking.leaveQueue(socket.id);

        const settings = sanitizeSettings(rawSettings);

        const matchResult = matchmaking.joinQueue(socket.id, settings);

        if (matchResult.error) {
            socket.emit("matchingError", {
                message: "マッチングを開始できませんでした。"
            });

            return;
        }

        if (!matchResult.ready) {
            socket.emit("matching", {
                message: "対戦相手を探しています。"
            });

            return;
        }

        const roomId = matchResult.roomId;
        const opponentId = matchResult.opponent;

        /*
         * 対局の設定にはルール項目だけを入れる。
         * guideEnabled / cpuLevel は個人の設定なので含めない。
         */
        const matchedSettings = pickRuleSettings(
            matchResult.settings ?? settings
        );

        const firstPlayer =
            matchResult.firstPlayer ??
            (Math.random() < 0.5 ? socket.id : opponentId);

        const players = [opponentId, socket.id].filter(Boolean);

        const opponentSocket = io.sockets.sockets.get(opponentId);

        if (!opponentSocket) {
            matchmaking.removeRoom(roomId);

            socket.emit("matchingError", {
                message:
                    "対戦相手との接続を確認できませんでした。もう一度マッチングしてください。"
            });

            return;
        }

        socket.join(roomId);
        opponentSocket.join(roomId);

        const startLetter = logic.randomStartLetter(matchedSettings);

        if (!startLetter) {
            io.to(roomId).emit("matchingError", {
                message:
                    "使用可能な開始文字がありません。単語リストを確認してください。"
            });

            io.in(roomId).socketsLeave(roomId);
            matchmaking.removeRoom(roomId);

            return;
        }

        const game = {
            roomId,
            players,
            settings: matchedSettings,

            startLetter,
            currentLetter: startLetter,

            usedWords: [],
            history: [],

            nEndCount: 0,

            turn: firstPlayer,
            timer: 20,
            started: false,
            finished: false,
            createdAt: Date.now()
        };

        onlineGames.set(roomId, game);

        io.to(roomId).emit("matchFound", {
            roomId,
            players,
            startLetter,
            firstPlayer,
            settings: matchedSettings
        });

        startCountdown(roomId);
    });

        /* オンライン対戦で単語を出す */
    socket.on("playWord", data => {
        const roomId = String(data?.roomId ?? "");
        const inputWord = String(data?.word ?? "").trim().slice(0, MAX_TEXT);

        const game = onlineGames.get(roomId);

        if (!game) {
            socket.emit("invalidMove", {
                reason: "対局情報が見つかりません。"
            });

            return;
        }

        if (game.finished || !game.started) {
            socket.emit("invalidMove", {
                reason: "現在は単語を入力できません。"
            });

            return;
        }

        if (!game.players.includes(socket.id)) {
            socket.emit("invalidMove", {
                reason: "この対局には参加していません。"
            });

            return;
        }

        if (game.turn !== socket.id) {
            socket.emit("invalidMove", {
                reason: "現在はあなたの番ではありません。"
            });

            return;
        }

        const opponentId = game.players.find(
            playerId => playerId !== socket.id
        );

        const result = logic.validateMove({
            word: inputWord,
            currentLetter: game.currentLetter,
            usedWords: game.usedWords,
            settings: game.settings
        });

        if (!result.valid) {
            socket.emit("invalidMove", {
                reason: result.reason,
                requiredLetter:
                    result.requiredLetter ?? game.currentLetter,
                actualLetter: result.actualLetter ?? ""
            });

            return;
        }

        const acceptedWord = result.word;
        const acceptedEntry = result.entry;

        /* 同じ単語・読みの即負け判定 */
        const duplicateLoss = logic.willLoseByDuplicate(
            acceptedEntry,
            game.usedWords,
            game.settings
        );

        if (duplicateLoss) {
            const safeLimit = logic.getSafeUseLimit(
                acceptedEntry,
                game.settings
            );

            game.history.push({
                turnNumber: game.history.length + 1,
                player: socket.id,
                word: acceptedEntry.name,
                reading: acceptedEntry.reading,
                type: acceptedEntry.type,
                requiredLetter: game.currentLetter,
                immediateLoss: true,
                lossReason:
                    safeLimit === 2
                        ? "同じ単語の3回目"
                        : "同じ単語の2回目"
            });

            finishOnlineGame(roomId, {
                winner: opponentId ?? null,
                loser: socket.id,
                reason:
                    safeLimit === 2
                        ? `「${acceptedEntry.name}」を3回目に使用したため負けです。`
                        : `「${acceptedEntry.name}」を2回目に使用したため負けです。`,
                lastWord: acceptedEntry.name
            });

            return;
        }

        /* 「ン」での即負け判定 */
        const nLoss = logic.willLoseByN(
            acceptedEntry,
            game.nEndCount,
            game.settings
        );

        if (nLoss) {
            game.history.push({
                turnNumber: game.history.length + 1,
                player: socket.id,
                word: acceptedEntry.name,
                reading: acceptedEntry.reading,
                type: acceptedEntry.type,
                requiredLetter: game.currentLetter,
                immediateLoss: true,
                lossReason: "ン終了"
            });

            finishOnlineGame(roomId, {
                winner: opponentId ?? null,
                loser: socket.id,
                reason:
                    game.settings.nRule === "once"
                        ? "対局中2回目の「ン」で終わる単語を使用したため負けです。"
                        : "「ン」で終わる単語を使用したため負けです。",
                lastWord: acceptedEntry.name
            });

            return;
        }

        /* 正常な手を履歴・使用済み単語へ追加 */
        game.usedWords.push({
            id: acceptedEntry.id,
            name: acceptedEntry.name,
            word: acceptedEntry.name,
            reading: acceptedEntry.reading,
            type: acceptedEntry.type
        });

        game.history.push({
            turnNumber: game.history.length + 1,
            player: socket.id,
            word: acceptedEntry.name,
            reading: acceptedEntry.reading,
            type: acceptedEntry.type,
            requiredLetter: game.currentLetter
        });

        if (logic.endsWithN(acceptedEntry, game.settings)) {
            game.nEndCount += 1;
        }

        game.currentLetter = logic.getNextLetter(
    acceptedEntry,
    game.settings,
    game.usedWords,
    game.nEndCount
);

        const gameOverResult = logic.checkGameOver({
            currentLetter: game.currentLetter,
            usedWords: game.usedWords,
            settings: game.settings
        });

        if (gameOverResult.gameOver || !opponentId) {
            io.to(roomId).emit("wordAccepted", {
                word: acceptedWord,
                reading: result.reading ?? acceptedEntry.reading,
                player: socket.id,
                nextLetter: "",
                turn: null,
                nEndCount: game.nEndCount,
                history: game.history
            });

            finishOnlineGame(roomId, {
                winner: socket.id,
                loser: opponentId ?? null,
                reason:
                    gameOverResult.reason ||
                    "対戦相手が見つかりません。",
                lastWord: acceptedWord
            });

            return;
        }

        game.turn = opponentId;

        io.to(roomId).emit("wordAccepted", {
            word: acceptedWord,
            reading: result.reading ?? acceptedEntry.reading,
            player: socket.id,
            nextLetter: game.currentLetter,
            turn: opponentId,
            nEndCount: game.nEndCount,
            history: game.history
        });

        resetTurnTimer(roomId);
    });

    /*
     * CPUの手を取得する。
     *
     * easy   : 軽いのでメインスレッドで処理
     * normal : worker(cpuレーン)で処理
     * hard   : worker(cpuレーン)で処理
     *
     * workerが失敗・タイムアウトした場合は、
     * ランダムな手にフォールバックする。
     */
    socket.on("cpuMove", async data => {
        if (socket.data.cpuBusy) {
            return;
        }

        if (!allow(socket, "cpuMove", 5, 1000)) {
            return;
        }

        socket.data.cpuBusy = true;

        const settings = sanitizeSettings(data?.settings);
        const state = sanitizeCpuState(data?.state);

        try {
            let move = null;

            if (
                settings.cpuLevel === "normal" ||
                settings.cpuLevel === "hard"
            ) {
                const response = await analysisManager.cpuMove({
                    state,
                    settings
                });

                move = response.move ?? null;
            } else {
                move = cpu.randomMove(state, settings);
            }

            socket.emit("cpuResponse", { move });
        } catch (error) {
            console.error("[CPUエラー]", error);

            try {
                const fallbackMove = cpu.randomMove(state, settings);

                socket.emit("cpuResponse", { move: fallbackMove });
            } catch (fallbackError) {
                console.error("[CPUフォールバックエラー]", fallbackError);

                socket.emit("cpuResponse", {
                    move: null,
                    error: "CPUの手を決定できませんでした。"
                });
            }
        } finally {
            socket.data.cpuBusy = false;
        }
    });

    /* 対局終了後の必勝解析(workerで実行) */
    socket.on("analyzeGame", async data => {
        if (socket.data.analyzing) {
            socket.emit("analysisResult", {
                success: false,
                error: "解析中です。しばらくお待ちください。"
            });

            return;
        }

        if (!allow(socket, "analyzeGame", 3, 10000)) {
            socket.emit("analysisResult", {
                success: false,
                error: "解析の依頼が多すぎます。少し待ってからお試しください。"
            });

            return;
        }

        socket.data.analyzing = true;

        try {
            const settings = sanitizeSettings(data?.settings);
            const history = sanitizeHistory(data?.history);
            const startLetter = toText(data?.startLetter, 4);

            const gameResult = {
                winner: data?.result?.winner ?? null,
                loser: data?.result?.loser ?? null,
                reason: toText(data?.result?.reason, 200)
            };

            const response = await analysisManager.analyzeGame({
                history,
                settings,
                startLetter,
                gameResult
            });

            socket.emit("analysisResult", response.result);
        } catch (error) {
            console.error("[解析エラー]", error);

            socket.emit("analysisResult", {
                success: false,
                error:
                    error?.userMessage ??
                    "対局を解析できませんでした。"
            });
        } finally {
            socket.data.analyzing = false;
        }
    });

    /* 初心者ガイド用の使用可能単語取得 */
    /* 初心者ガイド用の使用可能単語取得 */
socket.on("getAvailableWords", data => {
    if (!allow(socket, "getAvailableWords", 60, 1000)) {
        return;
    }

    const settings = sanitizeSettings(data?.settings);
    const currentLetter = toText(data?.currentLetter, 4);
    const usedWords = sanitizeUsedWords(data?.usedWords);
    const nEndCount = sanitizeNEndCount(data?.nEndCount);

    const words = logic.getGuideWords(
        currentLetter,
        usedWords,
        settings,
        nEndCount
    );

    socket.emit("availableWords", {
        requestId: data?.requestId ?? null,
        currentLetter,
        count: words.length,
        words
    });
});

/*
 * CPU対戦用：次の文字をサーバー側で決定する。
 *
 * 特殊ルールでは、
 * 「その文字で始まる単語が存在するか」ではなく、
 * 「実際に次の手として安全に使用できる単語が存在するか」
 * を logic.js 側で判定する。
 *
 * これにより、CPU対戦でもオンライン対戦と同じ
 * logic.getNextLetter() を使用する。
 */
socket.on("getNextLetter", data => {
    if (!allow(socket, "getNextLetter", 60, 1000)) {
        return;
    }

    const settings = sanitizeSettings(data?.settings);
    const usedWords = sanitizeUsedWords(data?.usedWords);
    const nEndCount = sanitizeNEndCount(data?.nEndCount);

    const word = toText(data?.word);

    const entry = logic.findWord(
        word,
        settings
    );

    if (!entry) {
        socket.emit("nextLetterResult", {
            requestId: data?.requestId ?? null,
            success: false,
            nextLetter: "",
            message: "単語が見つかりません。"
        });

        return;
    }

    const nextLetter = logic.getNextLetter(
        entry,
        settings,
        usedWords,
        nEndCount
    );

    socket.emit("nextLetterResult", {
        requestId: data?.requestId ?? null,
        success: true,
        nextLetter
    });
});

        /* 切断処理 */
    socket.on("disconnect", () => {
        console.log(`[切断] ${socket.id}`);

        /* 対局情報を消す前に、所属ルームを控えておく */
        const roomId = matchmaking.getPlayerRoom(socket.id);

        matchmaking.leaveQueue(socket.id);

        if (!roomId) {
            return;
        }

        const game = onlineGames.get(roomId);

        if (!game) {
            /* 対局はすでに終了している。残った対局情報だけ片付ける */
            matchmaking.removeRoom(roomId);
            return;
        }

        const opponentId = game.players.find(
            playerId => playerId !== socket.id
        );

        finishOnlineGame(roomId, {
            winner: opponentId ?? null,
            loser: socket.id,
            reason: "対戦相手が切断しました。"
        });
    });
});




/* =========================================================
   カウントダウン・タイマー
========================================================= */

function startCountdown(roomId) {
    clearCountdown(roomId);

    const game = onlineGames.get(roomId);

    if (!game || game.finished) {
        return;
    }

    let count = 3;

    io.to(roomId).emit("countdown", count);

    const countdownId = setInterval(() => {
        const currentGame = onlineGames.get(roomId);

        if (!currentGame || currentGame.finished) {
            clearCountdown(roomId);
            return;
        }

        count -= 1;

        if (count > 0) {
            io.to(roomId).emit("countdown", count);
            return;
        }

        clearCountdown(roomId);

        currentGame.started = true;

        io.to(roomId).emit("startGame", {
            roomId: currentGame.roomId,
            players: currentGame.players,
            settings: currentGame.settings,
            currentLetter: currentGame.currentLetter,
            usedWords: currentGame.usedWords,
            history: currentGame.history,
            turn: currentGame.turn,
            timer: 20
        });

        resetTurnTimer(roomId);
    }, 1000);

    countdownTimers.set(roomId, countdownId);
}

function resetTurnTimer(roomId) {
    clearTurnTimer(roomId);

    const game = onlineGames.get(roomId);

    if (!game || game.finished || !game.started) {
        return;
    }

    game.timer = 20;

    io.to(roomId).emit("timer", {
        seconds: game.timer,
        turn: game.turn
    });

    const timerId = setInterval(() => {
        const currentGame = onlineGames.get(roomId);

        if (!currentGame || currentGame.finished) {
            clearTurnTimer(roomId);
            return;
        }

        currentGame.timer -= 1;

        io.to(roomId).emit("timer", {
            seconds: currentGame.timer,
            turn: currentGame.turn
        });

        if (currentGame.timer <= 0) {
            const loserId = currentGame.turn;

            const winnerId =
                currentGame.players.find(
                    playerId => playerId !== loserId
                ) ?? null;

            finishOnlineGame(roomId, {
                winner: winnerId,
                loser: loserId,
                reason: "制限時間の20秒を超えました。"
            });
        }
    }, 1000);

    timers.set(roomId, timerId);
}

function clearTurnTimer(roomId) {
    const timerId = timers.get(roomId);

    if (timerId) {
        clearInterval(timerId);
    }

    timers.delete(roomId);
}

function clearCountdown(roomId) {
    const countdownId = countdownTimers.get(roomId);

    if (countdownId) {
        clearInterval(countdownId);
    }

    countdownTimers.delete(roomId);
}


/* =========================================================
   オンライン対局の終了
========================================================= */
function finishOnlineGame(roomId, result) {
    const game = onlineGames.get(roomId);

    if (!game || game.finished) {
        return;
    }

    game.finished = true;

    clearTurnTimer(roomId);
    clearCountdown(roomId);

    io.to(roomId).emit("gameOver", {
        winner: result.winner ?? null,
        loser: result.loser ?? null,
        reason: result.reason ?? "対局が終了しました。",
        lastWord: result.lastWord ?? null,
        startLetter: game.history[0]?.requiredLetter ?? null,
        history: game.history,
        settings: game.settings
    });

    /* 終局後の通信がルームに残らないよう、全員を抜けさせる */
    io.in(roomId).socketsLeave(roomId);

    matchmaking.removeRoom(roomId);
    onlineGames.delete(roomId);

    /* workerに保存された先行解析結果を破棄する(失敗しても無視) */
    analysisManager.clearRoom(roomId).catch(() => {});
}

/* =========================================================
   サーバー起動・終了
========================================================= */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`サーバーを起動しました: ポート ${PORT}`);

    console.log(
        `国名単語数: ${logic.getWords({ wordList: "countries" }).length}`
    );

    console.log(
        `首都名単語数: ${logic.getWords({ wordList: "capitals" }).length}`
    );
});

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(`[終了] ${signal} を受信しました。`);

    try {
        await analysisManager.terminate();
    } catch (error) {
        console.error("[終了処理エラー]", error);
    }

    server.close(() => {
        process.exit(0);
    });

    /* server.closeが終わらない場合の保険 */
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));