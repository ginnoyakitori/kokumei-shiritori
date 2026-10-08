"use strict";

/* =========================================================
   Socket.IO接続
========================================================= */

const socket = io();


/* =========================================================
   DOM要素
========================================================= */

const elements = {
    screens: Array.from(
        document.querySelectorAll(".screen")
    ),

    connectionStatus:
        document.getElementById("connectionStatus"),

    homeScreen:
        document.getElementById("homeScreen"),

    settingsScreen:
        document.getElementById("settingsScreen"),

    matchingScreen:
        document.getElementById("matchingScreen"),

    countdownScreen:
        document.getElementById("countdownScreen"),

    gameScreen:
        document.getElementById("gameScreen"),

    resultScreen:
        document.getElementById("resultScreen"),

    analysisScreen:
        document.getElementById("analysisScreen"),

    selectCpuModeButton:
        document.getElementById("selectCpuModeButton"),

    selectOnlineModeButton:
        document.getElementById("selectOnlineModeButton"),

    backToHomeButton:
        document.getElementById("backToHomeButton"),

    selectedModeLabel:
        document.getElementById("selectedModeLabel"),

    settingsForm:
        document.getElementById("settingsForm"),

    settingsError:
        document.getElementById("settingsError"),

    cpuSettingsGroup:
        document.getElementById("cpuSettingsGroup"),


    matchingStatus:
        document.getElementById("matchingStatus"),

    cancelMatchingButton:
        document.getElementById("cancelMatchingButton"),

    countdownNumber:
        document.getElementById("countdownNumber"),

    countdownTurnMessage:
        document.getElementById("countdownTurnMessage"),

    gameModeLabel:
        document.getElementById("gameModeLabel"),

    timerArea:
        document.getElementById("timerArea"),

    timerValue:
        document.getElementById("timerValue"),

    turnDisplay:
        document.getElementById("turnDisplay"),

    currentLetter:
        document.getElementById("currentLetter"),

    letterInstruction:
        document.getElementById("letterInstruction"),

    wordForm:
        document.getElementById("wordForm"),

    wordInput:
        document.getElementById("wordInput"),

    submitWordButton:
        document.getElementById("submitWordButton"),

    moveMessage:
        document.getElementById("moveMessage"),

    cpuThinking:
        document.getElementById("cpuThinking"),

    guidePanel:
        document.getElementById("guidePanel"),

    guideLoading:
        document.getElementById("guideLoading"),

    availableWordCount:
        document.getElementById("availableWordCount"),

    availableWordsList:
        document.getElementById("availableWordsList"),

    noAvailableWordsMessage:
        document.getElementById("noAvailableWordsMessage"),

    historyCount:
        document.getElementById("historyCount"),

    historyList:
        document.getElementById("historyList"),

    emptyHistoryMessage:
        document.getElementById("emptyHistoryMessage"),

    resultIcon:
        document.getElementById("resultIcon"),

    resultTitle:
        document.getElementById("resultTitle"),

    resultReason:
        document.getElementById("resultReason"),

    analyzeGameButton:
        document.getElementById("analyzeGameButton"),

    playAgainButton:
        document.getElementById("playAgainButton"),

    returnHomeButton:
        document.getElementById("returnHomeButton"),

    resultHistoryCount:
        document.getElementById("resultHistoryCount"),

    resultHistoryList:
        document.getElementById("resultHistoryList"),

    emptyResultHistoryMessage:
        document.getElementById("emptyResultHistoryMessage"),

    analysisLoading:
        document.getElementById("analysisLoading"),

    analysisError:
        document.getElementById("analysisError"),

    analysisContent:
        document.getElementById("analysisContent"),

    analysisVerdict:
        document.getElementById("analysisVerdict"),

    analysisStartLetter:
        document.getElementById("analysisStartLetter"),

    analysisBestMove:
        document.getElementById("analysisBestMove"),

    analysisDistance:
        document.getElementById("analysisDistance"),

    analysisSummary:
        document.getElementById("analysisSummary"),

    turningPointSection:
        document.getElementById("turningPointSection"),

    turningPointTurn:
        document.getElementById("turningPointTurn"),

    turningPointActual:
        document.getElementById("turningPointActual"),

    turningPointBest:
        document.getElementById("turningPointBest"),

    turningPointEvaluation:
        document.getElementById("turningPointEvaluation"),

    analysisMoveCount:
        document.getElementById("analysisMoveCount"),

    moveAnalysisList:
        document.getElementById("moveAnalysisList"),

    emptyMoveAnalysisMessage:
        document.getElementById("emptyMoveAnalysisMessage"),

    backToResultButton:
        document.getElementById("backToResultButton"),

    analysisPlayAgainButton:
        document.getElementById("analysisPlayAgainButton"),

    analysisHomeButton:
        document.getElementById("analysisHomeButton"),

    messageModal:
        document.getElementById("messageModal"),

    modalTitle:
        document.getElementById("modalTitle"),

    modalMessage:
        document.getElementById("modalMessage"),

    closeModalButton:
        document.getElementById("closeModalButton")
};


/* =========================================================
   ゲーム状態
========================================================= */

const gameState = {
    mode: null,
    settings: null,

    roomId: null,
    players: [],
    firstPlayer: null,

    startLetter: "",
    currentLetter: "",

    turn: null,
    myTurn: false,

    usedWords: [],
    history: [],

    nEndCount: 0,

    started: false,
    finished: false,

    lastResult: null
};

/*
 * getAvailableWordsイベントは初心者ガイドだけでなく、
 * CPU対戦の入力検証や特殊ルール判定にも利用する。
 *
 * pendingAvailableRequestにPromiseの解決関数を保存する。
 */
const availableWordRequests =
    new Map();

let availableRequestSequence = 0;

let pendingStartLetterRequest = null;

/* =========================================================
   初期化
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    bindDomEvents();
    updateConditionalSettings();
    resetInterface();
});


/* =========================================================
   DOMイベント登録
========================================================= */
function updateConditionalSettings() {
    const wordList =
        document.querySelector(
            'input[name="wordList"]:checked'
        )?.value ?? "countries";

    const rule =
        document.querySelector(
            'input[name="rule"]:checked'
        )?.value ?? "normal";

    const nRuleLose =
        document.getElementById(
            "nRuleLose"
        );

    const nRuleOnce =
        document.getElementById(
            "nRuleOnce"
        );

    const nRuleUnlimited =
        document.getElementById(
            "nRuleUnlimited"
        );

    const duplicateRuleGroup =
        document.getElementById(
            "duplicateRuleGroup"
        );

    const canUseOnce =
        wordList === "capitals" ||
        wordList === "both";

    const canUseUnlimited =
        rule === "special";

    nRuleOnce.disabled =
        !canUseOnce;

    nRuleUnlimited.disabled =
        !canUseUnlimited;

    duplicateRuleGroup.hidden =
        wordList !== "both";

    if (
        nRuleOnce.checked &&
        !canUseOnce
    ) {
        nRuleLose.checked = true;
    }

    if (
        nRuleUnlimited.checked &&
        !canUseUnlimited
    ) {
        nRuleLose.checked = true;
    }
}

function bindDomEvents() {
    elements.selectCpuModeButton.addEventListener(
        "click",
        () => {
            openSettings("cpu");
        }
    );

    elements.selectOnlineModeButton.addEventListener(
        "click",
        () => {
            openSettings("online");
        }
    );

    elements.backToHomeButton.addEventListener(
        "click",
        returnToHome
    );

    elements.settingsForm.addEventListener(
        "submit",
        handleSettingsSubmit
    );

    document
.querySelectorAll(
'input[name="wordList"], input[name="rule"]'
)
.forEach(input => {
input.addEventListener(
"change",
updateConditionalSettings
);
});

    elements.cancelMatchingButton.addEventListener(
        "click",
        cancelMatching
    );

    elements.wordForm.addEventListener(
        "submit",
        handleWordSubmit
    );

    elements.analyzeGameButton.addEventListener(
        "click",
        requestGameAnalysis
    );

    elements.playAgainButton.addEventListener(
        "click",
        playAgain
    );

    elements.returnHomeButton.addEventListener(
        "click",
        returnToHome
    );

    elements.backToResultButton.addEventListener(
        "click",
        () => {
            showScreen("resultScreen");
        }
    );

    elements.analysisPlayAgainButton.addEventListener(
        "click",
        playAgain
    );

    elements.analysisHomeButton.addEventListener(
        "click",
        returnToHome
    );

    elements.closeModalButton.addEventListener(
        "click",
        closeModal
    );

    elements.messageModal.addEventListener(
        "click",
        event => {
            if (
                event.target ===
                elements.messageModal
            ) {
                closeModal();
            }
        }
    );

    document.addEventListener(
        "keydown",
        event => {
            if (
                event.key === "Escape" &&
                !elements.messageModal.hidden
            ) {
                closeModal();
            }
        }
    );
}


/* =========================================================
   Socket.IO接続イベント
========================================================= */

socket.on("connect", () => {
    elements.connectionStatus.textContent =
        "サーバー接続済み";

    elements.connectionStatus.classList.remove(
        "connecting",
        "disconnected"
    );

    elements.connectionStatus.classList.add(
        "connected"
    );
});

socket.on("disconnect", () => {
    elements.connectionStatus.textContent =
        "サーバー切断中";

    elements.connectionStatus.classList.remove(
        "connecting",
        "connected"
    );

    elements.connectionStatus.classList.add(
        "disconnected"
    );

    if (
        gameState.mode === "online" &&
        gameState.started &&
        !gameState.finished
    ) {
        setInputEnabled(false);

        showMoveMessage(
            "サーバーとの接続が切れました。",
            "error"
        );
    }
});

socket.on("connect_error", () => {
    elements.connectionStatus.textContent =
        "接続できません";

    elements.connectionStatus.classList.remove(
        "connecting",
        "connected"
    );

    elements.connectionStatus.classList.add(
        "disconnected"
    );
});


/* =========================================================
   オンラインマッチングイベント
========================================================= */

socket.on("matching", data => {
    elements.matchingStatus.textContent =
        data?.message ??
        "対戦相手を探しています。";
});

socket.on("matchingCancelled", () => {
    showScreen("settingsScreen");
});

socket.on("matchingError", data => {
    showScreen("settingsScreen");

    showModal(
        "マッチングエラー",
        data?.message ??
        "マッチングに失敗しました。"
    );
});

socket.on("matchFound", data => {
    gameState.roomId =
        data.roomId;

    gameState.players =
        Array.isArray(data.players)
            ? data.players
            : [];

    gameState.firstPlayer =
        data.firstPlayer;

    gameState.startLetter =
        data.startLetter;

    gameState.currentLetter =
        data.startLetter;

    gameState.settings = {
    ...(gameState.settings ?? {}),
    ...(data.settings ?? {})
};

    gameState.history = [];
    gameState.usedWords = [];
    gameState.finished = false;
    gameState.started = false;

    elements.countdownTurnMessage.textContent =
        data.firstPlayer === socket.id
            ? "あなたが先手です"
            : "対戦相手が先手です";

    elements.countdownNumber.textContent = "3";

    showScreen("countdownScreen");
});

socket.on("countdown", value => {
    const count =
        typeof value === "object"
            ? value.count
            : value;

    elements.countdownNumber.textContent =
        String(count ?? "");
});
socket.on("startGame", state => {
    gameState.started = true;
    gameState.finished = false;

    gameState.roomId =
        state.roomId ??
        gameState.roomId;

    gameState.players =
        state.players ??
        gameState.players;

    gameState.settings = {
        ...(gameState.settings ?? {}),
        ...(state.settings ?? {})
    };

    gameState.currentLetter =
        state.currentLetter;

    gameState.startLetter =
        gameState.startLetter ||
        state.currentLetter;

    gameState.usedWords =
        Array.isArray(state.usedWords)
            ? state.usedWords
            : [];

    gameState.history =
        Array.isArray(state.history)
            ? state.history
            : [];

    gameState.nEndCount =
        Number(state.nEndCount ?? 0) || 0;

    gameState.turn =
        state.turn;

    gameState.myTurn =
        state.turn === socket.id;

    prepareGameScreen();
    updateGameInterface();

    if (
    gameState.mode === "cpu" &&
    gameState.settings?.guideEnabled &&
    gameState.myTurn
) {
    refreshGuide();
} else {
    clearGuide();
}
});
socket.on("timer", data => {
    const seconds =
        typeof data === "number"
            ? data
            : Number(data?.seconds ?? 0);

    elements.timerValue.textContent =
        String(seconds);

    elements.timerArea.classList.remove(
        "warning",
        "danger"
    );

    if (seconds <= 5) {
        elements.timerArea.classList.add(
            "danger"
        );
    } else if (seconds <= 10) {
        elements.timerArea.classList.add(
            "warning"
        );
    }
});

socket.on("invalidMove", data => {
    const reason =
        typeof data === "string"
            ? data
            : data?.reason;

    showMoveMessage(
        reason ??
        "その単語は使用できません。",
        "error"
    );

    if (gameState.myTurn) {
        setInputEnabled(true);
        elements.wordInput.focus();
    }
});
socket.on("wordAccepted", data => {
    if (Array.isArray(data.history)) {
        /*
         * サーバーの履歴が正。
         * 使用済み単語も履歴から作り直す。
         */
        gameState.history =
            data.history;

        gameState.usedWords =
            data.history
                .filter(move => !move.immediateLoss)
                .map(move => ({
                    name:
                        move.word,

                    word:
                        move.word,

                    reading:
                        move.reading ??
                        move.word,

                    type:
                        move.type ?? null
                }));
    } else {
        gameState.history.push({
            turnNumber:
                gameState.history.length + 1,

            player:
                data.player,

            word:
                data.word,

            reading:
                data.reading ?? "",

            requiredLetter:
                gameState.currentLetter
        });

        gameState.usedWords.push({
            name:
                data.word,

            word:
                data.word,

            reading:
                data.reading ??
                data.word,

            type:
                null
        });
    }

    if (data.nEndCount !== undefined) {
        gameState.nEndCount =
            Number(data.nEndCount) || 0;
    }

    gameState.currentLetter =
        data.nextLetter ?? "";

    gameState.turn =
        data.turn ?? null;

    gameState.myTurn =
        data.turn === socket.id;

    /*
     * 自分の単語が受理された場合は、
     * 念のためここでも入力欄を空にする。
     *
     * handleWordSubmit() でも空にしているが、
     * サーバーからの受理通知を最終的な確定地点とする。
     */
    if (data.player === socket.id) {
        elements.wordInput.value = "";
    }

    showMoveMessage(
        `「${data.word}」が使用されました。`,
        "success"
    );

    updateGameInterface();
    renderHistory();

    /*
     * オンライン対戦では初心者ガイドを使用しない。
     *
     * CPU戦の場合だけ、従来どおりガイドを表示する。
     */
    if (
        gameState.mode === "cpu" &&
        gameState.settings?.guideEnabled &&
        gameState.myTurn &&
        gameState.currentLetter
    ) {
        refreshGuide();
    } else {
        clearGuide();
    }
});

socket.on("gameOver", data => {
    finishGame({
        winner:
            data.winner ?? null,

        loser:
            data.loser ?? null,

        reason:
            data.reason ??
            "対局が終了しました。",

        history:
            Array.isArray(data.history)
                ? data.history
                : gameState.history,

        settings:
            data.settings ??
            gameState.settings,

        startLetter:
            data.startLetter ??
            gameState.startLetter
    });
});


/* =========================================================
   CPUイベント
========================================================= */

socket.on("cpuResponse", async data => {
    if (
        gameState.mode !== "cpu" ||
        gameState.finished
    ) {
        return;
    }

    elements.cpuThinking.hidden = true;

    if (data?.error) {
        showMoveMessage(
            data.error,
            "error"
        );

        /*
         * CPU側の処理エラーなので、
         * 対局を強制終了する。
         */
        finishGame({
            winner: null,
            loser: null,
            reason:
                data.error,
            history:
                gameState.history,
            settings:
                gameState.settings,
            startLetter:
                gameState.startLetter
        });

        return;
    }

    const move =
        data?.move ?? null;

    if (!move || !move.word) {
    finishGame({
        winner: "human",
        loser: "cpu",
        reason:
            `CPUが「${gameState.currentLetter}」から使用できる単語を見つけられませんでした。`,
        history:
            gameState.history,
        settings:
            gameState.settings,
        startLetter:
            gameState.startLetter
    });

    return;
}
    const requiredLetter =
        gameState.currentLetter;

    gameState.history.push({
        turnNumber:
            gameState.history.length + 1,

        player: "cpu",

        word:
            move.word,

        reading:
            move.reading ?? move.word,

        requiredLetter
    });

    gameState.usedWords.push({
    id:
        move.id ?? null,

    name:
        move.word,

    word:
        move.word,

    reading:
        move.reading ??
        move.word,

    type:
        move.type ?? null
});

if (
    getClientLastLetter(move) ===
    "ン"
) {
    gameState.nEndCount += 1;
}

gameState.currentLetter =
    move.nextLetter ?? "";

    showMoveMessage(
        `CPUは「${move.word}」を使用しました。`,
        "info"
    );

    renderHistory();

    if (!gameState.currentLetter) {
        finishGame({
            winner: "cpu",
            loser: "human",
            reason:
                "続けられる文字がありません。",
            history:
                gameState.history,
            settings:
                gameState.settings,
            startLetter:
                gameState.startLetter
        });

        return;
    }

    const available =
        await requestAvailableWords(
            gameState.currentLetter,
            gameState.usedWords
        );

    if (
        gameState.finished ||
        gameState.mode !== "cpu"
    ) {
        return;
    }

    if (available.length === 0) {
        finishGame({
            winner: "cpu",
            loser: "human",
            reason:
                `「${gameState.currentLetter}」から始まる未使用単語がありません。`,
            history:
                gameState.history,
            settings:
                gameState.settings,
            startLetter:
                gameState.startLetter
        });

        return;
    }

    gameState.turn = "human";
    gameState.myTurn = true;

    updateGameInterface();

    if (gameState.settings.guideEnabled) {
        renderGuideWords(available);
    }

    elements.wordInput.focus();
});


/* =========================================================
   使用可能単語イベント
========================================================= */

socket.on("availableWords", data => {
    const requestId =
        data?.requestId;

    const words =
        Array.isArray(data?.words)
            ? data.words
            : [];

    if (
        requestId &&
        availableWordRequests.has(
            requestId
        )
    ) {
        const request =
            availableWordRequests.get(
                requestId
            );

        availableWordRequests.delete(
            requestId
        );

        window.clearTimeout(
            request.timeoutId
        );

        request.resolve(words);
        return;
    }

    /*
     * requestIdのない応答は、
     * 初心者ガイド表示として扱う。
     */
    if (
        gameState.settings?.guideEnabled &&
        gameState.myTurn
    ) {
        renderGuideWords(words);
    }
});


/* =========================================================
   解析イベント
========================================================= */

socket.on("analysisResult", result => {
    elements.analysisLoading.hidden = true;

    if (!result?.success) {
        elements.analysisContent.hidden = true;
        elements.analysisError.hidden = false;

        elements.analysisError.textContent =
            result?.error ??
            "対局を解析できませんでした。";

        return;
    }

    elements.analysisError.hidden = true;
    elements.analysisContent.hidden = false;

    renderAnalysis(result);
});

socket.on("randomStartLetter", data => {
    if (!pendingStartLetterRequest) {
        return;
    }

    const request =
        pendingStartLetterRequest;

    pendingStartLetterRequest = null;

    window.clearTimeout(
        request.timeoutId
    );

    if (!data?.success) {
        request.resolve(null);
        return;
    }

    request.resolve({
        letter:
            data.letter,

        words:
            Array.isArray(data.words)
                ? data.words
                : []
    });
});
/* =========================================================
   画面切り替え
========================================================= */

function showScreen(screenId) {
    elements.screens.forEach(screen => {
        const active =
            screen.id === screenId;

        screen.hidden = !active;
        screen.classList.toggle(
            "active",
            active
        );
    });

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}


/* =========================================================
   設定画面
========================================================= */

function openSettings(mode) {
    gameState.mode = mode;

    elements.selectedModeLabel.textContent =
        mode === "cpu"
            ? "CPU対戦"
            : "オンライン対戦";

    elements.cpuSettingsGroup.hidden =
        mode !== "cpu";

    elements.settingsError.hidden = true;

    showScreen("settingsScreen");
}


function readSettings() {
    const formData =
        new FormData(
            elements.settingsForm
        );

    return {
        wordList:
            formData.get("wordList") ??
            "countries",

        removeMarks:
            formData.get("removeMarks") ===
            "true",

        nRule:
            formData.get("nRule") ??
            "lose",

        rule:
            formData.get("rule") ??
            "normal",

        duplicateRule:
            formData.get(
                "duplicateRule"
            ) ?? "once",

        cpuLevel:
            formData.get("cpuLevel") ??
            "easy",

        guideEnabled:
            formData.get(
                "guideEnabled"
            ) === "true"
    };
}

async function handleSettingsSubmit(event) {
    event.preventDefault();

    elements.settingsError.hidden = true;

    if (!socket.connected) {
        elements.settingsError.textContent =
            "サーバーへ接続されていません。";

        elements.settingsError.hidden = false;
        return;
    }

    gameState.settings =
        readSettings();

    resetGameState();

    if (gameState.mode === "online") {
        startOnlineMatching();
        return;
    }

    await startCpuGame();
}


/* =========================================================
   オンライン対戦開始
========================================================= */

function startOnlineMatching() {
    elements.matchingStatus.textContent =
        "対戦相手を探しています。";

    showScreen("matchingScreen");

    socket.emit(
        "findMatch",
        gameState.settings
    );
}

function cancelMatching() {
    socket.emit("cancelMatching");
}


/* =========================================================
   CPU対戦開始
========================================================= */

async function startCpuGame() {
    gameState.started = false;
    gameState.finished = false;

    showScreen("countdownScreen");

    elements.countdownTurnMessage.textContent =
        "開始文字を選んでいます";

    elements.countdownNumber.textContent =
        "…";

    const startResult =
        await findRandomStartLetter();

    if (!startResult) {
        showScreen("settingsScreen");

        showModal(
            "開始できません",
            "使用できる開始文字が見つかりませんでした。単語データを確認してください。"
        );

        return;
    }

    gameState.startLetter =
        startResult.letter;

    gameState.currentLetter =
        startResult.letter;

    /*
     * CPU戦の先手をランダムに決定する。
     */
    const humanFirst =
        Math.random() < 0.5;

    gameState.firstPlayer =
        humanFirst
            ? "human"
            : "cpu";

    elements.countdownTurnMessage.textContent =
        humanFirst
            ? "あなたが先手です"
            : "CPUが先手です";

    for (
        let count = 3;
        count >= 1;
        count -= 1
    ) {
        elements.countdownNumber.textContent =
            String(count);

        await delay(700);
    }

    gameState.started = true;
    gameState.turn =
        humanFirst
            ? "human"
            : "cpu";

    gameState.myTurn =
        humanFirst;

    prepareGameScreen();
    updateGameInterface();

    if (humanFirst) {
        if (
            gameState.settings.guideEnabled
        ) {
            renderGuideWords(
                startResult.words
            );
        }

        elements.wordInput.focus();
    } else {
        requestCpuMove();
    }
}


/**
 * 使用可能な単語がある開始文字をランダムに探す。
 */
function findRandomStartLetter() {
    return new Promise(resolve => {
        if (pendingStartLetterRequest) {
            window.clearTimeout(
                pendingStartLetterRequest
                    .timeoutId
            );

            pendingStartLetterRequest
                .resolve(null);
        }

        const timeoutId =
            window.setTimeout(() => {
                if (
                    !pendingStartLetterRequest
                ) {
                    return;
                }

                pendingStartLetterRequest =
                    null;

                resolve(null);
            }, 10000);

        pendingStartLetterRequest = {
            resolve,
            timeoutId
        };

        socket.emit(
            "getRandomStartLetter",
            gameState.settings
        );
    });
}


/* =========================================================
   対局画面準備
========================================================= */

function prepareGameScreen() {
    elements.gameModeLabel.textContent =
        gameState.mode === "cpu"
            ? createCpuModeLabel()
            : "オンライン対戦";

    elements.timerArea.hidden =
        gameState.mode !== "online";

    /*
     * オンライン対戦では初心者ガイドを
     * 常に非表示にする。
     */
    elements.guidePanel.hidden =
        gameState.mode === "online" ||
        !gameState.settings?.guideEnabled;

    elements.timerValue.textContent =
        "20";

    elements.timerArea.classList.remove(
        "warning",
        "danger"
    );

    elements.wordInput.value = "";
    elements.moveMessage.hidden = true;
    elements.cpuThinking.hidden = true;

    renderHistory();
    clearGuide();

    showScreen("gameScreen");
}

function createCpuModeLabel() {
    const levelLabels = {
        easy: "弱いCPU",
        normal: "強いCPU",
        hard: "最強CPU"
    };

    return (
        `CPU対戦・${
            levelLabels[
                gameState.settings?.cpuLevel
            ] ?? "CPU"
        }`
    );
}


/* =========================================================
   単語入力
========================================================= */

async function handleWordSubmit(event) {
    event.preventDefault();

    if (
        !gameState.started ||
        gameState.finished ||
        !gameState.myTurn
    ) {
        return;
    }

    const inputWord =
        elements.wordInput.value.trim();

    if (!inputWord) {
        showMoveMessage(
            "単語を入力してください。",
            "error"
        );

        return;
    }

    setInputEnabled(false);

    if (gameState.mode === "online") {
        socket.emit("playWord", {
            roomId:
                gameState.roomId,

            word:
                inputWord
        });

        /*
         * 送信した単語は入力欄から消す。
         *
         * 不正入力だった場合は invalidMove で
         * 入力欄を再び有効にする。
         */
        elements.wordInput.value = "";

        return;
    }

    await handleCpuGameHumanMove(
        inputWord
    );
}
/**
 * 単語の最後の有効文字を取得する。
 */
function getClientLastLetter(entry) {
    const reading =
        normalizeReading(
            entry?.reading ??
            entry?.name ??
            entry?.word ??
            ""
        );

    const characters =
        Array.from(reading);

    return (
        characters[
            characters.length - 1
        ] ?? ""
    );
}

/**
 * 同じ読みの単語が何回使用されたか返す。
 */
function countClientWordUses(entry) {
    const target =
        normalizeReading(
            entry?.reading ??
            entry?.name ??
            entry?.word ??
            ""
        );

    return gameState.usedWords.filter(used => {
        const usedReading =
            normalizeReading(
                typeof used === "string"
                    ? used
                    : (
                        used?.reading ??
                        used?.name ??
                        used?.word ??
                        ""
                    )
            );

        return usedReading === target;
    }).length;
}

/**
 * 国名と首都名の同名語かどうかは、
 * サーバーの初心者ガイド情報から判定する。
 */
function getClientSafeUseLimit(entry) {
    if (
        Number.isFinite(
            Number(entry?.safeUseLimit)
        )
    ) {
        return Number(
            entry.safeUseLimit
        );
    }

    return 1;
}

/**
 * 今この単語を言うと即負けになる理由を返す。
 */
function getClientImmediateLossReason(entry) {
    const useCount =
        countClientWordUses(entry);

    const safeUseLimit =
        getClientSafeUseLimit(entry);

    if (useCount >= safeUseLimit) {
        return safeUseLimit === 2
            ? `「${entry.name}」を3回目に使用したため負けです。`
            : `「${entry.name}」を2回目に使用したため負けです。`;
    }

    const lastLetter =
        getClientLastLetter(entry);

    if (lastLetter !== "ン") {
        return "";
    }

    const nRule =
        gameState.settings?.nRule ??
        "lose";

    if (nRule === "lose") {
        return (
            `「${entry.name}」が「ン」で終わるため負けです。`
        );
    }

    if (
        nRule === "once" &&
        gameState.nEndCount >= 1
    ) {
        return (
            "対局中2回目の「ン」で終わる単語を言ったため負けです。"
        );
    }

    return "";
}

/**
 * 使用履歴へ正式な単語情報を追加する。
 */
function addClientUsedWord(entry) {
    gameState.usedWords.push({
        id:
            entry.id ?? null,

        name:
            entry.name,

        word:
            entry.name,

        reading:
            entry.reading ??
            entry.name,

        type:
            entry.type ?? null
    });
}
async function handleCpuGameHumanMove(
    inputWord
) {
    const availableWords =
        await requestAvailableWords(
            gameState.currentLetter,
            gameState.usedWords
        );

    const entry =
        findInputEntry(
            inputWord,
            availableWords
        );

    if (!entry) {
        showMoveMessage(
            `「${gameState.currentLetter}」から始まる単語リスト内の単語ではありません。`,
            "error"
        );

        setInputEnabled(true);
        elements.wordInput.focus();

        return;
    }

    const requiredLetter =
        gameState.currentLetter;

    /*
     * 使用履歴へ追加する前に即負けを判定する。
     */
    const immediateLossReason =
        getClientImmediateLossReason(
            entry
        );

    /*
     * 棋譜には、負けになった最後の単語も保存する。
     */
    gameState.history.push({
        turnNumber:
            gameState.history.length + 1,

        player:
            "human",

        word:
            entry.name,

        reading:
            entry.reading ??
            entry.name,

        type:
            entry.type ?? null,

        requiredLetter,

        immediateLoss:
            Boolean(
                immediateLossReason
            ),

        lossReason:
            immediateLossReason ||
            ""
    });

    elements.wordInput.value = "";

    renderHistory();

    /*
     * 「ン」または重複による即負けは、
     * 次の文字を計算する前に終了する。
     */
    if (immediateLossReason) {
        finishGame({
            winner:
                "cpu",

            loser:
                "human",

            reason:
                immediateLossReason,

            history:
                gameState.history,

            settings:
                gameState.settings,

            startLetter:
                gameState.startLetter
        });

        return;
    }

    /*
     * 正常な手を使用済み単語へ追加する。
     */
    addClientUsedWord(
        entry
    );

    /*
     * 「ン」で終わる正常な手の場合、
     * nEndCount を更新する。
     *
     * nRule: once の判定に必要。
     */
    if (
        getClientLastLetter(entry) ===
        "ン"
    ) {
        gameState.nEndCount += 1;
    }

    /*
     * =====================================================
     * 重要：
     * 次の文字はクライアント側では判定しない。
     *
     * サーバーの logic.getNextLetter() に
     * usedWords / nEndCount / settings を渡して、
     * 正式な次文字を取得する。
     * =====================================================
     */
    const nextLetter =
        await requestNextLetter(
            entry.name,
            gameState.usedWords,
            gameState.nEndCount
        );

    gameState.currentLetter =
        nextLetter;

    showMoveMessage(
        `「${entry.name}」を使用しました。`,
        "success"
    );

    /*
     * 特殊ルールで単語内のどの文字からも
     * 続けられない場合は、単語を言った側の勝ち。
     *
     * 「ン」で即負けの場合は、
     * ここへ到達する前に終了している。
     */
    if (!nextLetter) {
        finishGame({
            winner:
                "human",

            loser:
                "cpu",

            reason:
                "CPUが続けられる文字を失いました。",

            history:
                gameState.history,

            settings:
                gameState.settings,

            startLetter:
                gameState.startLetter
        });

        return;
    }

    /*
     * 次の文字からCPUが使える単語そのものが
     * 存在するか確認する。
     */
    const cpuCandidates =
        await requestAvailableWords(
            nextLetter,
            gameState.usedWords
        );

    /*
     * 候補が0件ならCPUの負け。
     *
     * 即負け候補も候補として返される仕様なので、
     * 本当に単語そのものがない場合だけ0件になる。
     */
    if (
        cpuCandidates.length === 0
    ) {
        finishGame({
            winner:
                "human",

            loser:
                "cpu",

            reason:
                `「${nextLetter}」から始まる単語がありません。`,

            history:
                gameState.history,

            settings:
                gameState.settings,

            startLetter:
                gameState.startLetter
        });

        return;
    }

    gameState.turn =
        "cpu";

    gameState.myTurn =
        false;

    updateGameInterface();
    clearGuide();

    requestCpuMove();
}
/* =========================================================
   CPUの手
========================================================= */

function requestCpuMove() {
    if (
        gameState.finished ||
        gameState.mode !== "cpu"
    ) {
        return;
    }

    gameState.turn = "cpu";
    gameState.myTurn = false;

    setInputEnabled(false);

    elements.cpuThinking.hidden = false;

    updateGameInterface();

    /*
     * 少し間を空けてCPUが考えているように見せる。
     */
    window.setTimeout(() => {
        if (gameState.finished) {
            return;
        }

        socket.emit("cpuMove", {
    settings:
        gameState.settings,

    state: {
        currentLetter:
            gameState.currentLetter,

        usedWords:
            gameState.usedWords,

        history:
            gameState.history,

        nEndCount:
            gameState.nEndCount
    }
});
    }, 500);
}


/* =========================================================
   次の文字判定
========================================================= */

/* =========================================================
   使用可能単語取得
========================================================= */
/* =========================================================
   次の文字をサーバーから取得
========================================================= */

function requestNextLetter(
    word,
    usedWords,
    nEndCount
) {
    return new Promise(resolve => {
        const requestId =
            `next-letter-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}`;

        let finished =
            false;

        const cleanup = () => {
            socket.off(
                "nextLetterResult",
                handleResult
            );

            window.clearTimeout(
                timeoutId
            );
        };

        const finish = nextLetter => {
            if (finished) {
                return;
            }

            finished = true;

            cleanup();

            resolve(
                nextLetter || ""
            );
        };

        const handleResult = data => {
            if (
                data?.requestId !==
                requestId
            ) {
                return;
            }

            if (
                data?.success !== true
            ) {
                finish("");
                return;
            }

            finish(
                String(
                    data.nextLetter ?? ""
                )
            );
        };

        const timeoutId =
            window.setTimeout(() => {
                finish("");
            }, 10000);

        socket.on(
            "nextLetterResult",
            handleResult
        );

        socket.emit(
            "getNextLetter",
            {
                requestId,

                word,

                usedWords:
                    Array.isArray(
                        usedWords
                    )
                        ? usedWords
                        : [],

                nEndCount:
                    Number.isFinite(
                        Number(
                            nEndCount
                        )
                    )
                        ? Number(
                            nEndCount
                        )
                        : 0,

                settings:
                    gameState.settings
            }
        );
    });
}

/* =========================================================
   使用可能単語取得
========================================================= */

function requestAvailableWords(
    currentLetter,
    usedWords
) {
    return new Promise(resolve => {
        availableRequestSequence += 1;

        const requestId =
            `available-${Date.now()}-${availableRequestSequence}`;

        const timeoutId =
            window.setTimeout(() => {
                if (
                    !availableWordRequests.has(
                        requestId
                    )
                ) {
                    return;
                }

                availableWordRequests.delete(
                    requestId
                );

                resolve([]);
            }, 10000);

        availableWordRequests.set(
            requestId,
            {
                resolve,
                timeoutId
            }
        );

        socket.emit(
    "getAvailableWords",
    {
        requestId,
        currentLetter,

        usedWords:
            Array.isArray(usedWords)
                ? usedWords
                : [],

        nEndCount:
            gameState.nEndCount,

        settings:
            gameState.settings
    }
);
    });
}
async function refreshGuide() {
    /*
     * オンライン対戦では初心者ガイドを使用しない。
     */
    if (
        gameState.mode === "online" ||
        !gameState.settings?.guideEnabled ||
        !gameState.myTurn ||
        !gameState.currentLetter
    ) {
        clearGuide();
        return;
    }

    elements.guidePanel.hidden = false;
    elements.guideLoading.hidden = false;
    elements.availableWordsList.innerHTML = "";

    const words =
        await requestAvailableWords(
            gameState.currentLetter,
            gameState.usedWords
        );

    elements.guideLoading.hidden = true;

    if (
        gameState.mode === "cpu" &&
        gameState.myTurn &&
        !gameState.finished
    ) {
        renderGuideWords(words);
    } else {
        clearGuide();
    }
}

function renderGuideWords(words) {
    elements.guidePanel.hidden =
        !gameState.settings?.guideEnabled;

    elements.guideLoading.hidden = true;
    elements.availableWordsList.innerHTML = "";

    elements.availableWordCount.textContent =
        `${words.length}語`;

    elements.noAvailableWordsMessage.hidden =
        words.length > 0;

    for (const entry of words) {
    const button =
        document.createElement("button");

    button.type = "button";
    button.className =
        "available-word-button";

    const wordText =
        document.createElement("span");

    wordText.className =
        "guide-word-name";

    wordText.textContent =
        entry.name;

    button.appendChild(wordText);

    if (entry.immediateLoss) {
        button.classList.add(
            "immediate-loss-word"
        );

        const warning =
            document.createElement("span");

        warning.className =
            "immediate-loss-label";

        warning.textContent =
            "言うと負け";

        button.appendChild(warning);

        const reasons =
            Array.isArray(
                entry.lossReasons
            )
                ? entry.lossReasons.join("・")
                : "即負け";

        button.title =
            `${entry.name}：${reasons}`;
    } else {
        const remainingSafeUses =
            Math.max(
                0,
                Number(
                    entry.safeUseLimit ?? 1
                ) -
                Number(
                    entry.useCount ?? 0
                )
            );

        if (
            entry.safeUseLimit > 1 &&
            entry.useCount > 0
        ) {
            const remaining =
                document.createElement("span");

            remaining.className =
                "remaining-use-label";

            remaining.textContent =
                `あと${remainingSafeUses}回`;

            button.appendChild(
                remaining
            );
        }

        button.title =
            entry.reading &&
            entry.reading !== entry.name
                ? `読み：${entry.reading}`
                : entry.name;
    }

    button.addEventListener(
        "click",
        () => {
            if (!gameState.myTurn) {
                return;
            }

            elements.wordInput.value =
                entry.name;

            elements.wordInput.focus();
        }
    );

    elements.availableWordsList.appendChild(
        button
    );
}
}

function clearGuide() {
    elements.availableWordsList.innerHTML = "";
    elements.availableWordCount.textContent =
        "0語";

    elements.noAvailableWordsMessage.hidden =
        true;

    elements.guideLoading.hidden = true;
}

function requestNextLetter(word, usedWords, nEndCount) {
    return new Promise(resolve => {
        const requestId =
            `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const timeout = setTimeout(() => {
            socket.off(
                "nextLetterResult",
                handler
            );

            resolve("");
        }, 5000);

        const handler = data => {
            if (data?.requestId !== requestId) {
                return;
            }

            clearTimeout(timeout);

            socket.off(
                "nextLetterResult",
                handler
            );

            resolve(
                data?.success
                    ? String(data.nextLetter ?? "")
                    : ""
            );
        };

        socket.on(
            "nextLetterResult",
            handler
        );

        socket.emit("getNextLetter", {
            requestId,

            word,

            usedWords:
                Array.isArray(usedWords)
                    ? usedWords
                    : [],

            nEndCount:
                Number.isFinite(
                    Number(nEndCount)
                )
                    ? Number(nEndCount)
                    : 0,

            settings:
                gameState.settings
        });
    });
}
/* =========================================================
   ゲーム画面更新
========================================================= */

function updateGameInterface() {
    elements.currentLetter.textContent =
        gameState.currentLetter || "－";

    if (gameState.currentLetter) {
        elements.letterInstruction.textContent =
            `「${gameState.currentLetter}」から始まる単語を入力してください`;
    } else {
        elements.letterInstruction.textContent =
            "続けられる文字がありません";
    }

    if (gameState.finished) {
        elements.turnDisplay.textContent =
            "対局終了";

        elements.turnDisplay.classList.remove(
            "opponent-turn"
        );

        setInputEnabled(false);
        return;
    }

    if (gameState.myTurn) {
        elements.turnDisplay.textContent =
            "あなたの番です";

        elements.turnDisplay.classList.remove(
            "opponent-turn"
        );

        setInputEnabled(true);
    } else {
        elements.turnDisplay.textContent =
            gameState.mode === "cpu"
                ? "CPUの番です"
                : "対戦相手の番です";

        elements.turnDisplay.classList.add(
            "opponent-turn"
        );

        setInputEnabled(false);
    }
}

function setInputEnabled(enabled) {
    const actualEnabled =
        Boolean(enabled) &&
        gameState.started &&
        !gameState.finished;

    elements.wordInput.disabled =
        !actualEnabled;

    elements.submitWordButton.disabled =
        !actualEnabled;
}


/* =========================================================
   棋譜表示
========================================================= */

function renderHistory() {
    renderHistoryInto(
        elements.historyList,
        elements.historyCount,
        elements.emptyHistoryMessage,
        gameState.history
    );
}

function renderResultHistory(history) {
    renderHistoryInto(
        elements.resultHistoryList,
        elements.resultHistoryCount,
        elements.emptyResultHistoryMessage,
        history
    );
}

function renderHistoryInto(
    listElement,
    countElement,
    emptyElement,
    history
) {
    listElement.innerHTML = "";

    countElement.textContent =
        `${history.length}手`;

    emptyElement.hidden =
        history.length > 0;

    history.forEach((move, index) => {
        const listItem =
            document.createElement("li");

        const turnNumber =
            document.createElement("span");

        turnNumber.className =
            "history-turn-number";

        turnNumber.textContent =
            String(index + 1);

        const content =
            document.createElement("div");

        const word =
            document.createElement("span");

        word.className =
            "history-word";

        word.textContent =
            move.word ?? "";

        const player =
            document.createElement("span");

        player.className =
            "history-player";

        player.textContent =
            createPlayerLabel(
                move.player,
                index
            );

        content.appendChild(word);
        content.appendChild(player);

        if (
            move.reading &&
            move.reading !== move.word
        ) {
            const reading =
                document.createElement("span");

            reading.className =
                "history-reading";

            reading.textContent =
                `読み：${move.reading}`;

            content.appendChild(reading);
        }

        listItem.appendChild(
            turnNumber
        );

        listItem.appendChild(
            content
        );

        listElement.appendChild(
            listItem
        );
    });

    listElement.scrollTop =
        listElement.scrollHeight;
}

function createPlayerLabel(
    player,
    index
) {
    if (gameState.mode === "cpu") {
        return player === "cpu"
            ? "CPU"
            : "あなた";
    }

    if (player === socket.id) {
        return "あなた";
    }

    if (player) {
        return "対戦相手";
    }

    return index % 2 === 0
        ? "先手"
        : "後手";
}


/* =========================================================
   対局終了
========================================================= */

function finishGame(result) {
    if (gameState.finished) {
        return;
    }

    gameState.finished = true;
    gameState.started = false;
    gameState.myTurn = false;

    setInputEnabled(false);

    elements.cpuThinking.hidden = true;

    gameState.history =
        Array.isArray(result.history)
            ? result.history
            : gameState.history;

    gameState.lastResult = {
        winner:
            result.winner ?? null,

        loser:
            result.loser ?? null,

        reason:
            result.reason ??
            "対局が終了しました。",

        history:
            gameState.history,

        settings:
            result.settings ??
            gameState.settings,

        startLetter:
            result.startLetter ??
            gameState.startLetter
    };

    const didWin =
        determineMyResult(
            result.winner,
            result.loser
        );

    elements.resultIcon.classList.remove(
        "lose",
        "draw"
    );

    if (didWin === true) {
        elements.resultIcon.textContent =
            "WIN";

        elements.resultTitle.textContent =
            "あなたの勝ち";
    } else if (didWin === false) {
        elements.resultIcon.textContent =
            "LOSE";

        elements.resultIcon.classList.add(
            "lose"
        );

        elements.resultTitle.textContent =
            "あなたの負け";
    } else {
        elements.resultIcon.textContent =
            "END";

        elements.resultIcon.classList.add(
            "draw"
        );

        elements.resultTitle.textContent =
            "対局終了";
    }

    elements.resultReason.textContent =
        result.reason ??
        "対局が終了しました。";

    renderResultHistory(
        gameState.history
    );

    showScreen("resultScreen");
}

function determineMyResult(
    winner,
    loser
) {
    if (gameState.mode === "cpu") {
        if (winner === "human") {
            return true;
        }

        if (winner === "cpu") {
            return false;
        }

        if (loser === "human") {
            return false;
        }

        if (loser === "cpu") {
            return true;
        }

        return null;
    }

    if (winner === socket.id) {
        return true;
    }

    if (loser === socket.id) {
        return false;
    }

    if (winner) {
        return false;
    }

    return null;
}


/* =========================================================
   必勝解析
========================================================= */

function requestGameAnalysis() {
    if (!gameState.lastResult) {
        showModal(
            "解析できません",
            "解析する対局情報がありません。"
        );

        return;
    }

    elements.analysisLoading.hidden = false;
    elements.analysisContent.hidden = true;
    elements.analysisError.hidden = true;

    showScreen("analysisScreen");

    socket.emit("analyzeGame", {
    history:
        gameState.lastResult.history,

    settings:
        gameState.lastResult.settings,

    startLetter:
        gameState.lastResult.startLetter,

    result: {
        winner:
            gameState.lastResult.winner,

        loser:
            gameState.lastResult.loser,

        reason:
            gameState.lastResult.reason
    }
});
}

function renderAnalysis(result) {
    elements.analysisVerdict.textContent =
        result.verdict ?? "判定不能";

    elements.analysisStartLetter.textContent =
        result.startLetter ?? "－";

    elements.analysisBestMove.textContent =
        result.bestMove?.word ??
        result.bestMove?.name ??
        "なし";

    elements.analysisDistance.textContent =
        Number.isFinite(
            result.optimalDistance
        )
            ? `${result.optimalDistance}手`
            : "－";

    elements.analysisSummary.textContent =
        result.summary ??
        "解析結果を表示できませんでした。";

    renderTurningPoint(
        result.firstTurningPoint
    );

    renderMoveAnalysis(
        Array.isArray(result.moveAnalysis)
            ? result.moveAnalysis
            : []
    );
}

function renderTurningPoint(
    turningPoint
) {
    if (!turningPoint) {
        elements.turningPointSection.hidden =
            true;

        return;
    }

    elements.turningPointSection.hidden =
        false;

    elements.turningPointTurn.textContent =
        `${turningPoint.turnNumber}手目・${turningPoint.player}`;

    elements.turningPointActual.textContent =
        turningPoint.actualWord ??
        "不明";

    elements.turningPointBest.textContent =
        turningPoint.bestMove?.word ??
        turningPoint.bestMove?.name ??
        "なし";

    elements.turningPointEvaluation.textContent =
        `${turningPoint.positionBefore ?? ""} → ${turningPoint.positionAfter ?? ""}`;
}

function renderMoveAnalysis(moves) {
    elements.moveAnalysisList.innerHTML = "";

    elements.analysisMoveCount.textContent =
        `${moves.length}手`;

    elements.emptyMoveAnalysisMessage.hidden =
        moves.length > 0;

    for (const move of moves) {
        const item =
            document.createElement("article");

        item.className =
            "move-analysis-item";

        let statusText =
            "解析済み";

        let statusClass = "";

        if (move.valid === false) {
            item.classList.add("invalid");
            statusText = "不正な手";
        } else if (move.wasBestMove) {
            item.classList.add("best");
            statusText = "最善手";
            statusClass = "best";
        } else if (
            move.lostWinningPosition
        ) {
            item.classList.add("mistake");
            statusText = "勝ち筋を逃した手";
            statusClass = "mistake";
        }

        const header =
            document.createElement("div");

        header.className =
            "move-analysis-header";

        const title =
            document.createElement("h4");

        title.textContent =
            `${move.turnNumber}手目　${move.player}：${move.actualWord}`;

        const badge =
            document.createElement("span");

        badge.className =
            `analysis-status-badge ${statusClass}`.trim();

        badge.textContent =
            statusText;

        header.appendChild(title);
        header.appendChild(badge);

        item.appendChild(header);

        const details =
            document.createElement("div");

        details.className =
            "move-analysis-details";

        details.appendChild(
            createAnalysisDetail(
                "必要な文字",
                move.requiredLetter ?? "－"
            )
        );

        details.appendChild(
            createAnalysisDetail(
                "次の文字",
                move.nextLetter ?? "－"
            )
        );

        details.appendChild(
            createAnalysisDetail(
                "指す前",
                move.positionBefore ?? "－"
            )
        );

        details.appendChild(
            createAnalysisDetail(
                "指した後",
                move.positionAfter ?? "－"
            )
        );

        details.appendChild(
            createAnalysisDetail(
                "最善手",
                move.bestMove?.word ??
                move.bestMove?.name ??
                "なし"
            )
        );

        if (
            Number.isFinite(
                move.optimalDistance
            )
        ) {
            details.appendChild(
                createAnalysisDetail(
                    "最善進行",
                    `${move.optimalDistance}手`
                )
            );
        }

        item.appendChild(details);

        if (move.comment || move.error) {
            const comment =
                document.createElement("p");

            comment.className =
                "move-analysis-comment";

            comment.textContent =
                move.error ??
                move.comment;

            item.appendChild(comment);
        }

        elements.moveAnalysisList.appendChild(
            item
        );
    }
}

function createAnalysisDetail(
    label,
    value
) {
    const paragraph =
        document.createElement("p");

    const strong =
        document.createElement("strong");

    strong.textContent =
        `${label}：`;

    paragraph.appendChild(strong);
    paragraph.appendChild(
        document.createTextNode(
            String(value)
        )
    );

    return paragraph;
}


/* =========================================================
   再戦・ホームへ戻る
========================================================= */

function playAgain() {
    if (
        !gameState.mode ||
        !gameState.settings
    ) {
        returnToHome();
        return;
    }

    resetGameState();

    if (gameState.mode === "online") {
        startOnlineMatching();
    } else {
        startCpuGame();
    }
}

function returnToHome() {
    if (
        gameState.mode === "online"
    ) {
        socket.emit(
            "cancelMatching"
        );
    }

    resetGameState();
    gameState.mode = null;
    gameState.settings = null;

    resetInterface();
    showScreen("homeScreen");
}

function resetGameState() {
    gameState.roomId = null;
    gameState.players = [];
    gameState.firstPlayer = null;

    gameState.startLetter = "";
    gameState.currentLetter = "";

    gameState.turn = null;
    gameState.myTurn = false;

    gameState.usedWords = [];
    gameState.history = [];

    gameState.nEndCount = 0;

    gameState.started = false;
    gameState.finished = false;

    gameState.lastResult = null;

    for (
    const request
    of availableWordRequests.values()
) {
    window.clearTimeout(
        request.timeoutId
    );

    request.resolve([]);
}

availableWordRequests.clear();

if (pendingStartLetterRequest) {
    pendingStartLetterRequest.resolve(null);
    pendingStartLetterRequest = null;
}
}

function resetInterface() {
    elements.wordInput.value = "";

    elements.currentLetter.textContent =
        "？";

    elements.letterInstruction.textContent =
        "開始文字を決定しています";

    elements.turnDisplay.textContent =
        "対局開始前です";

    elements.moveMessage.hidden = true;
    elements.cpuThinking.hidden = true;

    elements.timerValue.textContent =
        "20";

    elements.timerArea.classList.remove(
        "warning",
        "danger"
    );

    elements.historyList.innerHTML = "";
    elements.historyCount.textContent =
        "0手";

    elements.emptyHistoryMessage.hidden =
        false;

    clearGuide();
}


/* =========================================================
   入力単語検索
========================================================= */

function findInputEntry(
    input,
    words
) {
    const normalizedInput =
        normalizeWordForMatch(input);

    return words.find(entry => {
        const normalizedName =
            normalizeWordForMatch(
                entry.name
            );

        const normalizedReading =
            normalizeWordForMatch(
                entry.reading
            );

        return (
            normalizedInput ===
                normalizedName ||
            normalizedInput ===
                normalizedReading
        );
    }) ?? null;
}


/* =========================================================
   文字正規化
========================================================= */

const SMALL_KANA_MAP = {
    "ァ": "ア",
    "ィ": "イ",
    "ゥ": "ウ",
    "ェ": "エ",
    "ォ": "オ",
    "ッ": "ツ",
    "ャ": "ヤ",
    "ュ": "ユ",
    "ョ": "ヨ",
    "ヮ": "ワ",
    "ヵ": "カ",
    "ヶ": "ケ"
};

const DAKUTEN_MAP = {
    "ガ": "カ",
    "ギ": "キ",
    "グ": "ク",
    "ゲ": "ケ",
    "ゴ": "コ",

    "ザ": "サ",
    "ジ": "シ",
    "ズ": "ス",
    "ゼ": "セ",
    "ゾ": "ソ",

    "ダ": "タ",
    "ヂ": "チ",
    "ヅ": "ツ",
    "デ": "テ",
    "ド": "ト",

    "バ": "ハ",
    "ビ": "ヒ",
    "ブ": "フ",
    "ベ": "ヘ",
    "ボ": "ホ",

    "パ": "ハ",
    "ピ": "ヒ",
    "プ": "フ",
    "ペ": "ヘ",
    "ポ": "ホ",

    "ヴ": "ウ"
};

function hiraganaToKatakana(value) {
    return Array.from(
        String(value ?? "")
    )
        .map(character => {
            const code =
                character.charCodeAt(0);

            if (
                code >= 0x3041 &&
                code <= 0x3096
            ) {
                return String.fromCharCode(
                    code + 0x60
                );
            }

            return character;
        })
        .join("");
}

function normalizeCharacter(character) {
    if (!character) {
        return "";
    }

    let normalized =
        hiraganaToKatakana(
            character
        );

    normalized =
        SMALL_KANA_MAP[normalized] ??
        normalized;

    if (
        gameState.settings?.removeMarks
    ) {
        normalized =
            DAKUTEN_MAP[normalized] ??
            normalized;
    }

    return normalized;
}

function normalizeReading(value) {
    const cleaned =
        hiraganaToKatakana(
            String(value ?? "")
        )
            .replace(
                /[\s　・･\-‐‑‒–—―ー_.,，、。'"「」『』()（）[\]【】]/g,
                ""
            );

    return Array.from(cleaned)
        .map(normalizeCharacter)
        .join("");
}

function normalizeWordForMatch(value) {
    return hiraganaToKatakana(
        String(value ?? "")
            .trim()
    )
        .replace(/\s+/g, "")
        .toUpperCase();
}


/* =========================================================
   メッセージ
========================================================= */

function showMoveMessage(
    message,
    type = "success"
) {
    elements.moveMessage.textContent =
        message;

    elements.moveMessage.classList.remove(
        "error",
        "info"
    );

    if (type === "error") {
        elements.moveMessage.classList.add(
            "error"
        );
    } else if (type === "info") {
        elements.moveMessage.classList.add(
            "info"
        );
    }

    elements.moveMessage.hidden = false;
}

function showModal(
    title,
    message
) {
    elements.modalTitle.textContent =
        title;

    elements.modalMessage.textContent =
        message;

    elements.messageModal.hidden =
        false;

    elements.closeModalButton.focus();
}

function closeModal() {
    elements.messageModal.hidden =
        true;
}


/* =========================================================
   汎用関数
========================================================= */

function delay(milliseconds) {
    return new Promise(resolve => {
        window.setTimeout(
            resolve,
            milliseconds
        );
    });
}

function shuffleArray(array) {
    for (
        let index =
            array.length - 1;
        index > 0;
        index -= 1
    ) {
        const randomIndex =
            Math.floor(
                Math.random() *
                (index + 1)
            );

        [
            array[index],
            array[randomIndex]
        ] = [
            array[randomIndex],
            array[index]
        ];
    }

    return array;
}