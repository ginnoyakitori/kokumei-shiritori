"use strict";

const crypto = require("crypto");
const settingsModule = require("./settings");


/* =========================================================
   マッチング情報
========================================================= */

/* socketId => 待機情報 */
const waitingPlayers = new Map();

/* socketId => roomId */
const playerRooms = new Map();

/* roomId => 対局情報 */
const matches = new Map();


/* =========================================================
   設定値の正規化(settings.jsへ委譲)
========================================================= */

function normalizeWordList(value) {
    return settingsModule.normalizeSettings({
        wordList: value
    }).wordList;
}

function normalizeRule(value) {
    return settingsModule.normalizeSettings({
        rule: value
    }).rule;
}

function normalizeNRule(
    value,
    wordList,
    rule
) {
    return settingsModule.normalizeSettings({
        nRule: value,
        wordList,
        rule
    }).nRule;
}

function normalizeDuplicateRule(
    value,
    wordList
) {
    return settingsModule.normalizeSettings({
        duplicateRule: value,
        wordList
    }).duplicateRule;
}

/**
 * ルール項目だけを返す(cpuLevel / guideEnabled は含まない)。
 */
function normalizeSettings(
    rawSettings = {}
) {
    return settingsModule.normalizeRuleSettings(
        rawSettings
    );
}


/* =========================================================
   設定比較キー
========================================================= */

function createSettingsKey(
    rawSettings = {}
) {
    return settingsModule.createMatchKey(
        rawSettings
    );
}


/* =========================================================
   ルームID・先手決定
========================================================= */

function createRoomId() {
    let roomId;

    do {
        roomId =
            `room-${crypto.randomBytes(8).toString("hex")}`;
    } while (
        matches.has(roomId)
    );

    return roomId;
}

function selectFirstPlayer(players) {
    if (
        !Array.isArray(players) ||
        players.length === 0
    ) {
        return null;
    }

    return players[
        Math.floor(
            Math.random() *
            players.length
        )
    ];
}


/* =========================================================
   対戦相手検索
========================================================= */

function findOpponent(
    socketId,
    settingsKey
) {
    const candidates = [];

    for (const player of waitingPlayers.values()) {
        if (player.socketId === socketId) {
            continue;
        }

        if (player.settingsKey !== settingsKey) {
            continue;
        }

        if (playerRooms.has(player.socketId)) {
            continue;
        }

        candidates.push(player);
    }

    if (candidates.length === 0) {
        return null;
    }

    return candidates[
        Math.floor(
            Math.random() *
            candidates.length
        )
    ];
}


/* =========================================================
   待機列への参加
========================================================= */

function joinQueue(
    rawSocketId,
    rawSettings = {}
) {
    const socketId =
        String(
            rawSocketId ?? ""
        ).trim();

    if (!socketId) {
        return {
            ready: false,
            waiting: false,
            error: "Socket IDが指定されていません。"
        };
    }

    /*
     * すでに対局中の場合は、
     * 新しい待機列へ参加させない。
     * (呼び出し側が事前に isInMatch で確認する)
     */
    if (playerRooms.has(socketId)) {
        return {
            ready: false,
            waiting: false,
            error: "すでに対局へ参加しています。",
            roomId: playerRooms.get(socketId)
        };
    }

    /* 同じSocket IDの重複待機を防ぐ */
    waitingPlayers.delete(socketId);

    const settings =
        normalizeSettings(
            rawSettings
        );

    const settingsKey =
        createSettingsKey(
            settings
        );

    const opponent =
        findOpponent(
            socketId,
            settingsKey
        );

    /* 対戦相手が見つからない場合は、待機列へ登録する */
    if (!opponent) {
        waitingPlayers.set(
            socketId,
            {
                socketId,
                settings: { ...settings },
                settingsKey,
                joinedAt: Date.now()
            }
        );

        return {
            ready: false,
            waiting: true,
            socketId,
            settings: { ...settings }
        };
    }

    /* 対戦相手が見つかったため、相手を待機列から削除する */
    waitingPlayers.delete(
        opponent.socketId
    );

    const roomId =
        createRoomId();

    const players = [
        opponent.socketId,
        socketId
    ];

    const firstPlayer =
        selectFirstPlayer(
            players
        );

    matches.set(
        roomId,
        {
            roomId,
            players: [...players],
            settings: { ...settings },
            firstPlayer,
            createdAt: Date.now()
        }
    );

    for (const playerId of players) {
        playerRooms.set(
            playerId,
            roomId
        );
    }

    return {
        ready: true,
        waiting: false,
        roomId,
        opponent: opponent.socketId,
        players: [...players],
        firstPlayer,
        settings: { ...settings }
    };
}


/* =========================================================
   待機列・対局からの削除

   leaveQueue : 待機列から抜くだけ(対局情報には触れない)
   removeRoom : 対局(ルーム)を破棄する
   remove     : 待機列と所属する対局の両方を片付ける
                (切断時などの完全な後始末)
========================================================= */

/**
 * 待機列から抜く。
 * 対局に参加している場合も、対局情報は変更しない。
 */
function leaveQueue(rawSocketId) {
    const socketId =
        String(
            rawSocketId ?? ""
        ).trim();

    if (!socketId) {
        return {
            removed: false,
            reason: "Socket IDが指定されていません。"
        };
    }

    return {
        removed:
            waitingPlayers.delete(
                socketId
            )
    };
}

/**
 * 対局(ルーム)を破棄する。
 * 参加していたプレイヤーの対局情報をすべて削除する。
 */
function removeRoom(rawRoomId) {
    const roomId =
        String(
            rawRoomId ?? ""
        ).trim();

    if (!roomId) {
        return {
            removed: false,
            reason: "ルームIDが指定されていません。"
        };
    }

    const match =
        matches.get(roomId);

    if (!match) {
        return {
            removed: false,
            roomId
        };
    }

    for (const playerId of match.players) {
        /* 別の対局へ移っている場合は消さない */
        if (playerRooms.get(playerId) === roomId) {
            playerRooms.delete(playerId);
        }
    }

    matches.delete(roomId);

    return {
        removed: true,
        roomId,
        players: [...match.players]
    };
}

/**
 * 待機列と所属する対局の両方を片付ける。
 */
function remove(rawSocketId) {
    const socketId =
        String(
            rawSocketId ?? ""
        ).trim();

    if (!socketId) {
        return {
            removed: false,
            reason: "Socket IDが指定されていません。"
        };
    }

    const removedFromQueue =
        leaveQueue(socketId).removed;

    const roomId =
        playerRooms.get(socketId) ?? null;

    let removedFromMatch = false;

    if (roomId) {
        removedFromMatch =
            removeRoom(roomId).removed;

        /* matchesに情報が残っていなかった場合の安全対策 */
        playerRooms.delete(socketId);
    }

    return {
        removed:
            removedFromQueue ||
            removedFromMatch,

        removedFromQueue,
        removedFromMatch,
        roomId
    };
}


/* =========================================================
   状態確認
========================================================= */

function isWaiting(rawSocketId) {
    return waitingPlayers.has(
        String(rawSocketId ?? "").trim()
    );
}

function isInMatch(rawSocketId) {
    return playerRooms.has(
        String(rawSocketId ?? "").trim()
    );
}

function getPlayerRoom(rawSocketId) {
    return (
        playerRooms.get(
            String(rawSocketId ?? "").trim()
        ) ?? null
    );
}

function getMatch(rawRoomId) {
    const match =
        matches.get(
            String(rawRoomId ?? "").trim()
        );

    if (!match) {
        return null;
    }

    return {
        roomId: match.roomId,
        players: [...match.players],
        settings: { ...match.settings },
        firstPlayer: match.firstPlayer,
        createdAt: match.createdAt
    };
}


/* =========================================================
   件数取得
========================================================= */

function getWaitingCount() {
    return waitingPlayers.size;
}

function getMatchCount() {
    return matches.size;
}

function getWaitingCountBySettings(
    rawSettings = {}
) {
    const settingsKey =
        createSettingsKey(
            rawSettings
        );

    let count = 0;

    for (const player of waitingPlayers.values()) {
        if (player.settingsKey === settingsKey) {
            count += 1;
        }
    }

    return count;
}


/* =========================================================
   デバッグ・動作確認用
========================================================= */

function getWaitingPlayers() {
    return Array.from(
        waitingPlayers.values()
    ).map(player => ({
        socketId: player.socketId,
        settings: { ...player.settings },
        settingsKey: player.settingsKey,
        joinedAt: player.joinedAt
    }));
}

function getMatches() {
    return Array.from(
        matches.values()
    ).map(match => ({
        roomId: match.roomId,
        players: [...match.players],
        settings: { ...match.settings },
        firstPlayer: match.firstPlayer,
        createdAt: match.createdAt
    }));
}


/* =========================================================
   全情報削除
========================================================= */

function clearAll() {
    const previousCounts = {
        waitingPlayers: waitingPlayers.size,
        matches: matches.size,
        playerRooms: playerRooms.size
    };

    waitingPlayers.clear();
    matches.clear();
    playerRooms.clear();

    return {
        cleared: true,
        previousCounts
    };
}


/* =========================================================
   エクスポート
========================================================= */

module.exports = {
    joinQueue,

    leaveQueue,
    removeRoom,
    remove,

    isWaiting,
    isInMatch,

    getPlayerRoom,
    getMatch,

    getWaitingCount,
    getMatchCount,
    getWaitingCountBySettings,

    getWaitingPlayers,
    getMatches,

    normalizeWordList,
    normalizeRule,
    normalizeNRule,
    normalizeDuplicateRule,
    normalizeSettings,
    createSettingsKey,

    clearAll
};