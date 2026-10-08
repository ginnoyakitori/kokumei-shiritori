"use strict";

const logic = require("./logic");
const { createExactSolver } = require("./exact-solver");
const { normalizeRuleSettings } = require("./settings");


/* =========================================================
   解析の既定値
========================================================= */

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 5000;
const DEFAULT_MAX_MOVES = 20;
const DEFAULT_LIMITED_MOVES = 8;

/* 強いCPUが評価する候補数の上限 */
const STRONG_MAX_CANDIDATES = 40;

/* 強いCPUが1手ごとに確認する相手の返し手の数 */
const STRONG_OPPONENT_SAMPLE = 12;

/* 完全解析(exact-solver)の既定値 */
const EXACT_MAX_STATES_COUNTRIES = 1000000;
const EXACT_MAX_STATES_OTHER = 300000;
const EXACT_DEADLINE_MS = 6000;
const MAX_EXACT_SOLVERS = 4;

/* 探索キャッシュの上限件数 */
const MAX_CACHE_ENTRIES = 20000;


/* =========================================================
   キャッシュ・探索状態
========================================================= */

/*
 * 勝敗が確定した局面だけを保存する。
 * 確定した結果は探索の深さや打ち切りに左右されないため、
 * 異なる解析設定の間でも再利用できる。
 * 未確定の結果(winning === null)は保存しない。
 */
const analysisCache = new Map();

/* 現在の再帰経路上にある局面 */
const analyzingStates = new Set();

let analyzedNodeCount = 0;

/* 設定ごとの完全解析ソルバー */
const exactSolvers = new Map();


/* =========================================================
   状態の正規化
========================================================= */

function normalizeState(state = {}) {
    return {
        currentLetter:
            String(
                state.currentLetter ??
                state.nextLetter ??
                ""
            ),

        usedWords:
            Array.isArray(state.usedWords)
                ? [...state.usedWords]
                : [],

        history:
            Array.isArray(state.history)
                ? [...state.history]
                : [],

        nEndCount:
            Number(
                state.nEndCount ?? 0
            ) || 0
    };
}

function normalizeLimits(options = {}) {
    const maxDepth = Number(options.maxDepth);
    const maxNodes = Number(options.maxNodes);
    const maxMoves = Number(options.maxMoves);
    const limitedMoves = Number(options.limitedMoves);

    return {
        maxDepth:
            Number.isFinite(maxDepth) && maxDepth >= 1
                ? Math.floor(maxDepth)
                : DEFAULT_MAX_DEPTH,

        maxNodes:
            Number.isFinite(maxNodes) && maxNodes >= 100
                ? Math.floor(maxNodes)
                : DEFAULT_MAX_NODES,

        maxMoves:
            Number.isFinite(maxMoves) && maxMoves >= 1
                ? Math.floor(maxMoves)
                : DEFAULT_MAX_MOVES,

        limitedMoves:
            Number.isFinite(limitedMoves) && limitedMoves >= 1
                ? Math.floor(limitedMoves)
                : DEFAULT_LIMITED_MOVES
    };
}


/* =========================================================
   手の返却形式
========================================================= */

function createMoveResult(
    entry,
    nextLetter,
    extra = {}
) {
    if (!entry) {
        return null;
    }

    return {
        id: entry.id,
        word: entry.name,
        name: entry.name,
        reading: entry.reading,
        type: entry.type,
        nextLetter: nextLetter ?? "",
        ...extra
    };
}

function createUsedWordEntry(entry) {
    return {
        id: entry.id,
        name: entry.name,
        word: entry.name,
        reading: entry.reading,
        type: entry.type
    };
}


/* =========================================================
   次の局面
========================================================= */

function createNextState(
    rawState,
    entry,
    settings = {}
) {
    const state = normalizeState(rawState);

    const usedWords = [
        ...state.usedWords,
        createUsedWordEntry(entry)
    ];

    const endedWithN =
        logic.endsWithN(
            entry,
            settings
        );

    const nEndCount =
        state.nEndCount +
        (endedWithN ? 1 : 0);

    /*
     * 特殊しりとりでは、
     *
     * 1. 今回の単語を usedWords に追加
     * 2. 更新後の nEndCount を使う
     * 3. その状態で「実際に続けられる文字」を探す
     *
     * 必ずこの順番にする。
     */
    const nextLetter =
        logic.getNextLetter(
            entry,
            settings,
            usedWords,
            nEndCount
        );

    return {
        currentLetter: nextLetter,
        usedWords,
        nEndCount,

        history: [
            ...state.history,
            {
                turnNumber:
                    state.history.length + 1,

                word:
                    entry.name,

                name:
                    entry.name,

                reading:
                    entry.reading,

                type:
                    entry.type
            }
        ]
    };
}

/* =========================================================
   候補取得
========================================================= */

/**
 * 同じ読みの候補を1つにまとめる。
 */
function removeDuplicateReadingMoves(
    entries,
    settings = {}
) {
    const seen = new Set();
    const result = [];

    for (const entry of entries) {
        const reading = logic.normalizeReading(
            entry.reading ?? entry.name,
            settings
        );

        if (seen.has(reading)) {
            continue;
        }

        seen.add(reading);
        result.push(entry);
    }

    return result;
}

function getAllMoves(
    rawState,
    settings = {}
) {
    const state = normalizeState(rawState);

    if (!state.currentLetter) {
        return [];
    }

    return removeDuplicateReadingMoves(
        logic.getAvailableWords(
            state.currentLetter,
            state.usedWords,
            settings
        ),
        settings
    );
}

/**
 * 即負けにならない候補だけを返す。
 */
function getSafeMoves(
    rawState,
    settings = {}
) {
    const state = normalizeState(rawState);

    if (!state.currentLetter) {
        return [];
    }

    return removeDuplicateReadingMoves(
        logic.getSafeAvailableWords(
            state.currentLetter,
            state.usedWords,
            state.nEndCount,
            settings
        ),
        settings
    );
}

function getImmediateLossReasons(
    state,
    entry,
    settings = {}
) {
    return logic.getImmediateLossReasons(
        entry,
        state.usedWords,
        state.nEndCount,
        settings
    );
}


/* =========================================================
   ランダム
========================================================= */

function randomChoice(array) {
    if (
        !Array.isArray(array) ||
        array.length === 0
    ) {
        return null;
    }

    return array[
        Math.floor(Math.random() * array.length)
    ];
}

function shuffled(array) {
    const copy = [...array];

    for (let index = copy.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(
            Math.random() * (index + 1)
        );

        [copy[index], copy[randomIndex]] =
            [copy[randomIndex], copy[index]];
    }

    return copy;
}


/* =========================================================
   弱いCPU:使用できる単語からランダムに選ぶ
========================================================= */

function randomMove(
    rawState,
    settings = {}
) {
    const state = normalizeState(rawState);

    const safeMoves = getSafeMoves(state, settings);

    if (safeMoves.length === 0) {
        return null;
    }

    const selectedEntry = randomChoice(safeMoves);

    if (!selectedEntry) {
        return null;
    }

    const nextState = createNextState(
        state,
        selectedEntry,
        settings
    );

    return createMoveResult(
        selectedEntry,
        nextState.currentLetter,
        {
            cpuLevel: "easy",
            evaluation: "random",
            availableCount: safeMoves.length,
            nEndCount: nextState.nEndCount,
            immediateLoss: false
        }
    );
}


/* =========================================================
   強いCPU:相手が続けにくい単語を優先して選ぶ
========================================================= */

/**
 * 1つの手を評価する。
 *
 * 評価の中心は「相手が返せる安全な単語の少なさ」。
 * 相手の返し手の後に自分が続けられる数は補助に使う。
 */
function evaluateStrongMove(
    rawState,
    entry,
    settings = {}
) {
    const state = normalizeState(rawState);

    const lossReasons = getImmediateLossReasons(
        state,
        entry,
        settings
    );

    if (lossReasons.length > 0) {
        return {
            score: Number.NEGATIVE_INFINITY,
            nextLetter: "",
            opponentMoveCount: 0,
            futureMoveCount: 0,
            immediateLoss: true,
            lossReasons
        };
    }

    const nextState = createNextState(
        state,
        entry,
        settings
    );

    /* 相手へ渡す文字がなければ勝ち */
    if (!nextState.currentLetter) {
        return {
            score: 1000000,
            nextLetter: "",
            opponentMoveCount: 0,
            futureMoveCount: 0,
            winningMove: true,
            immediateLoss: false
        };
    }

    const opponentMoves = getSafeMoves(
        nextState,
        settings
    );

    /* 相手に安全な手がなければ勝ち */
    if (opponentMoves.length === 0) {
        return {
            score: 1000000,
            nextLetter: nextState.currentLetter,
            opponentMoveCount: 0,
            futureMoveCount: 0,
            winningMove: true,
            immediateLoss: false
        };
    }

    const sampledOpponentMoves = shuffled(opponentMoves)
        .slice(0, STRONG_OPPONENT_SAMPLE);

    let minimumFutureMoves = Number.POSITIVE_INFINITY;
    let totalFutureMoves = 0;

    for (const opponentEntry of sampledOpponentMoves) {
        const afterOpponentState = createNextState(
            nextState,
            opponentEntry,
            settings
        );

        const cpuFutureCount = getSafeMoves(
            afterOpponentState,
            settings
        ).length;

        minimumFutureMoves = Math.min(
            minimumFutureMoves,
            cpuFutureCount
        );

        totalFutureMoves += cpuFutureCount;
    }

    if (minimumFutureMoves === Number.POSITIVE_INFINITY) {
        minimumFutureMoves = 0;
    }

    const averageFutureMoves =
        sampledOpponentMoves.length > 0
            ? totalFutureMoves / sampledOpponentMoves.length
            : 0;

    /*
     * 相手の返し手が少ないほど高得点。
     * 自分の将来の選択肢が多いほど加点。
     */
    const score =
        -(opponentMoves.length * 100) +
        (minimumFutureMoves * 10) +
        (averageFutureMoves * 2);

    return {
        score,
        nextLetter: nextState.currentLetter,
        opponentMoveCount: opponentMoves.length,
        futureMoveCount: minimumFutureMoves,
        averageFutureMoves,
        winningMove: false,
        immediateLoss: false
    };
}

function strongMove(
    rawState,
    settings = {}
) {
    const state = normalizeState(rawState);

    const safeMoves = getSafeMoves(state, settings);

    if (safeMoves.length === 0) {
        return null;
    }

    /*
     * 候補が多い場合に単語リストの順番で偏らないよう、
     * シャッフルしてから上限件数まで評価する。
     */
    const evaluatedMoves = shuffled(safeMoves)
        .slice(0, STRONG_MAX_CANDIDATES)
        .map(entry => ({
            entry,
            ...evaluateStrongMove(state, entry, settings)
        }))
        .sort((a, b) => b.score - a.score);

    if (evaluatedMoves.length === 0) {
        return null;
    }

    const bestScore = evaluatedMoves[0].score;

    const bestCandidates = evaluatedMoves.filter(
        item => item.score === bestScore
    );

    const selected = randomChoice(bestCandidates);

    if (!selected) {
        return null;
    }

    const nextState = createNextState(
        state,
        selected.entry,
        settings
    );

    return createMoveResult(
        selected.entry,
        selected.nextLetter,
        {
            cpuLevel: "normal",
            evaluation: "heuristic",
            score: selected.score,
            opponentMoveCount: selected.opponentMoveCount,
            futureMoveCount: selected.futureMoveCount,
            winningMove: selected.winningMove === true,
            nEndCount: nextState.nEndCount,
            immediateLoss: false
        }
    );
}


/* =========================================================
   局面キー
========================================================= */

function createUsedWordKey(
    usedWords,
    settings = {}
) {
    return usedWords
        .map(used => {
            return logic.normalizeReading(
                typeof used === "string"
                    ? used
                    : (
                        used?.reading ??
                        used?.name ??
                        used?.word ??
                        ""
                    ),
                settings
            );
        })
        .sort()
        .join(",");
}

/**
 * 局面のキー。
 *
 * キャッシュするのは勝敗が確定した結果だけなので、
 * 探索の深さやノード数はキーに含めない。
 * 「負け」の確定は候補を全て調べたときに限るため、
 * 候補数の上限(maxMoves)だけキーに含める。
 */
function createStateKey(
    rawState,
    settings = {},
    maxMoves = DEFAULT_MAX_MOVES
) {
    const state = normalizeState(rawState);

    return JSON.stringify({
        currentLetter: logic.normalizeCharacter(
            state.currentLetter,
            settings
        ),
        used: createUsedWordKey(state.usedWords, settings),
        nEndCount: state.nEndCount,
        maxMoves,
        wordList: settings.wordList ?? "countries",
        removeMarks: settings.removeMarks === true,
        nRule: settings.nRule ?? "lose",
        rule: settings.rule ?? "normal",
        duplicateRule: settings.duplicateRule ?? "once"
    });
}

function cacheResult(key, result) {
    if (analysisCache.size >= MAX_CACHE_ENTRIES) {
        analysisCache.clear();
    }

    analysisCache.set(key, result);
}


/* =========================================================
   候補の並べ替え
========================================================= */

/**
 * 相手の安全な候補数が少なくなる手を優先する。
 */
function orderMoves(
    rawState,
    moves,
    settings = {},
    maxMoves = DEFAULT_MAX_MOVES
) {
    const state = normalizeState(rawState);

    return moves
        .map(entry => {
            const nextState = createNextState(
                state,
                entry,
                settings
            );

            const opponentMoveCount =
                nextState.currentLetter
                    ? getSafeMoves(nextState, settings).length
                    : 0;

            return { entry, opponentMoveCount };
        })
        .sort((a, b) => {
            return a.opponentMoveCount - b.opponentMoveCount;
        })
        .slice(0, maxMoves)
        .map(item => item.entry);
}


/* =========================================================
   探索結果の形式

   winning:
     true  : 手番側の勝ちが確定
     false : 手番側の負けが確定
     null  : 未確定(探索上限に達した)
========================================================= */

function createUnknownResult() {
    return {
        winning: null,
        distance: 0,
        bestEntry: null,
        nextLetter: "",
        limited: true,
        score: 0
    };
}

/**
 * 探索上限に達した局面の簡易評価。
 *
 * 少数の候補だけを調べ、勝ちか負けが確定すればそれを返す。
 * 確定しなければ「未確定」とし、勝ち負けは断定しない。
 */
function createLimitedResult(
    rawState,
    settings = {},
    limits = {}
) {
    const state = normalizeState(rawState);

    const safeMoves = getSafeMoves(state, settings);

    /* 安全な手が1つもなければ、負けが確定する */
    if (safeMoves.length === 0) {
        return {
            winning: false,
            distance: 0,
            bestEntry: null,
            nextLetter: "",
            limited: false,
            score: -100000
        };
    }

    const candidates = orderMoves(
        state,
        safeMoves,
        settings,
        limits.limitedMoves ?? DEFAULT_LIMITED_MOVES
    );

    let bestEntry = candidates[0] ?? safeMoves[0];
    let bestNextLetter = "";
    let bestOpponentCount = Number.POSITIVE_INFINITY;

    for (const entry of candidates) {
        const nextState = createNextState(
            state,
            entry,
            settings
        );

        /* 相手に渡す文字がなければ、勝ちが確定する */
        if (!nextState.currentLetter) {
            return {
                winning: true,
                distance: 1,
                bestEntry: entry,
                nextLetter: "",
                limited: false,
                score: 100000
            };
        }

        const opponentMoveCount = getSafeMoves(
            nextState,
            settings
        ).length;

        /* 相手に安全な手がなければ、勝ちが確定する */
        if (opponentMoveCount === 0) {
            return {
                winning: true,
                distance: 1,
                bestEntry: entry,
                nextLetter: nextState.currentLetter,
                limited: false,
                score: 100000
            };
        }

        if (opponentMoveCount < bestOpponentCount) {
            bestOpponentCount = opponentMoveCount;
            bestEntry = entry;
            bestNextLetter = nextState.currentLetter;
        }
    }

    return {
        winning: null,
        distance: 0,
        bestEntry,
        nextLetter: bestNextLetter,
        limited: true,
        score: -bestOpponentCount
    };
}


/* =========================================================
   探索(深さ・ノード数の上限つき)
========================================================= */

function solvePosition(
    rawState,
    settings = {},
    depth = 0,
    rawLimits = {}
) {
    const limits = normalizeLimits(rawLimits);
    const state = normalizeState(rawState);

    const key = createStateKey(
        state,
        settings,
        limits.maxMoves
    );

    /* 確定済みの結果があれば再利用する */
    const cached = analysisCache.get(key);

    if (cached) {
        return cached;
    }

    /* 同じ局面へ戻ってきた場合は未確定として扱う */
    if (analyzingStates.has(key)) {
        return createUnknownResult();
    }

    if (
        depth >= limits.maxDepth ||
        analyzedNodeCount >= limits.maxNodes
    ) {
        return createLimitedResult(state, settings, limits);
    }

    analyzedNodeCount += 1;

    const unorderedMoves = getSafeMoves(state, settings);

    /* 安全な手がなければ、手番側の負けが確定する */
    if (unorderedMoves.length === 0) {
        const result = {
            winning: false,
            distance: 0,
            bestEntry: null,
            nextLetter: "",
            limited: false,
            score: -100000
        };

        cacheResult(key, result);

        return result;
    }

    const safeMoves = orderMoves(
        state,
        unorderedMoves,
        settings,
        limits.maxMoves
    );

    /* 候補を絞った場合、「全ての手が負け」とは断定できない */
    const truncated = unorderedMoves.length > safeMoves.length;

    analyzingStates.add(key);

    let winningChoice = null;
    let longestLosingChoice = null;
    let bestUnknownChoice = null;
    let hasUnknown = false;

    try {
        for (const entry of safeMoves) {
            if (analyzedNodeCount >= limits.maxNodes) {
                hasUnknown = true;
                break;
            }

            const nextState = createNextState(
                state,
                entry,
                settings
            );

            /* 相手へ渡す文字がなければ、その手で勝ち */
            if (!nextState.currentLetter) {
                winningChoice = {
                    entry,
                    nextState,
                    distance: 1
                };

                break;
            }

            const opponentResult = solvePosition(
                nextState,
                settings,
                depth + 1,
                limits
            );

            const candidate = {
                entry,
                nextState,
                distance: opponentResult.distance + 1
            };

            /* 相手の負けが確定 → この手は勝ち手 */
            if (opponentResult.winning === false) {
                if (
                    !winningChoice ||
                    candidate.distance < winningChoice.distance
                ) {
                    winningChoice = candidate;
                }

                /* 十分短い勝ちが見つかれば、残りを省略する */
                if (candidate.distance <= 2) {
                    break;
                }

                continue;
            }

            /* 相手の勝ちが確定 → この手は負け手(長く粘れる手を記録) */
            if (opponentResult.winning === true) {
                if (
                    !longestLosingChoice ||
                    candidate.distance > longestLosingChoice.distance
                ) {
                    longestLosingChoice = candidate;
                }

                continue;
            }

            /* 未確定 → 相手の評価が低い手を優先して記録 */
            hasUnknown = true;

            const score = -(opponentResult.score ?? 0);

            if (
                !bestUnknownChoice ||
                score > bestUnknownChoice.score
            ) {
                bestUnknownChoice = {
                    ...candidate,
                    score
                };
            }
        }
    } finally {
        analyzingStates.delete(key);
    }

    let result;

    if (winningChoice) {
        /* 勝ちが確定 */
        result = {
            winning: true,
            distance: winningChoice.distance,
            bestEntry: winningChoice.entry,
            nextLetter: winningChoice.nextState.currentLetter,
            limited: false,
            score: 100000
        };

        cacheResult(key, result);

        return result;
    }

    if (!hasUnknown && !truncated && longestLosingChoice) {
        /* 全ての手が相手の勝ちに繋がる → 負けが確定 */
        result = {
            winning: false,
            distance: longestLosingChoice.distance,
            bestEntry: longestLosingChoice.entry,
            nextLetter: longestLosingChoice.nextState.currentLetter,
            limited: false,
            score: -100000
        };

        cacheResult(key, result);

        return result;
    }

    /*
     * 未確定。
     * 負けが確定した手より、未確定の手を優先する
     * (未確定の手には勝ちの可能性が残るため)。
     */
    const fallbackChoice =
        bestUnknownChoice ??
        longestLosingChoice;

    return {
        winning: null,
        distance: 0,
        bestEntry: fallbackChoice?.entry ?? safeMoves[0],
        nextLetter: fallbackChoice?.nextState?.currentLetter ?? "",
        limited: true,
        score: bestUnknownChoice?.score ?? -50
    };
}


/* =========================================================
   完全解析(exact-solver)
========================================================= */

/**
 * 設定に応じた完全解析ソルバーを返す。
 * 通常しりとりルール以外では使えないため null を返す。
 */
function getExactSolver(settings) {
    const ruleSettings = normalizeRuleSettings(settings);

    if (ruleSettings.rule !== "normal") {
        return null;
    }

    const key = JSON.stringify(ruleSettings);

    let solver = exactSolvers.get(key);

    if (!solver) {
        if (exactSolvers.size >= MAX_EXACT_SOLVERS) {
            const oldestKey = exactSolvers.keys().next().value;

            exactSolvers.delete(oldestKey);
        }

        solver = createExactSolver(
            ruleSettings,
            {
                maxStates:
                    ruleSettings.wordList === "countries"
                        ? EXACT_MAX_STATES_COUNTRIES
                        : EXACT_MAX_STATES_OTHER,

                deadlineMilliseconds: EXACT_DEADLINE_MS
            }
        );

        exactSolvers.set(key, solver);
    }

    return solver;
}

/**
 * exact-solverで現在局面を解く。
 *
 * 戻り値:
 *   null                                   解析できない(特殊ルール・上限到達・エラー)
 *   { winning: false, entry: null, ... }   手番側の負けが確定
 *   { winning: true,  entry, ... }         勝ち手が見つかった
 */
function findExactMove(
    state,
    settings,
    safeMoves
) {
    let solver;

    try {
        solver = getExactSolver(settings);
    } catch (error) {
        console.error("[cpu] exact-solverの作成に失敗しました。", error);
        return null;
    }

    if (!solver) {
        return null;
    }

    /*
     * 探索回数は呼び出しをまたいで累積するため、
     * 上限の半分を超えたらメモを作り直す。
     */
    if (
        solver.getStatistics().visitedStates >=
        solver.options.maxStates * 0.5
    ) {
        solver.clear();
    }

    let analysis;

    try {
        analysis = solver.analyzePosition({
            requiredLetter: state.currentLetter,
            usedWords: state.usedWords,
            nEndCount: state.nEndCount
        });
    } catch (error) {
        console.error("[cpu] exact-solverの解析に失敗しました。", error);
        return null;
    }

    if (!analysis.exact) {
        return null;
    }

    if (analysis.winning !== true) {
        return {
            winning: false,
            entry: null,
            distance: analysis.distance
        };
    }

    const bestReading = logic.normalizeReading(
        analysis.bestMove?.reading ??
        analysis.bestMove?.name ??
        "",
        settings
    );

    /* solverの手を、現局面の候補(安全な手)のデータへ対応づける */
    const entry = safeMoves.find(candidate => {
        return (
            logic.normalizeReading(
                candidate.reading ?? candidate.name,
                settings
            ) === bestReading
        );
    }) ?? null;

    if (!entry) {
        return null;
    }

    return {
        winning: true,
        entry,
        distance: analysis.distance
    };
}


/* =========================================================
   最強CPU:必勝解析を使用して最善手を選ぶ
========================================================= */

function bestMove(
    rawState,
    settings = {},
    options = {}
) {
    const state = normalizeState(rawState);

    const safeMoves = getSafeMoves(state, settings);

    if (safeMoves.length === 0) {
        return null;
    }

    /*
     * 1. 通常ルールは完全解析を使う。
     *    勝ち手があれば、それが最善手。
     */
    const exact = findExactMove(state, settings, safeMoves);

    if (exact?.entry) {
        const nextState = createNextState(
            state,
            exact.entry,
            settings
        );

        return createMoveResult(
            exact.entry,
            nextState.currentLetter,
            {
                cpuLevel: "hard",
                evaluation: "exact",
                winning: true,
                distance: exact.distance,
                limited: false,
                nEndCount: nextState.nEndCount,
                immediateLoss: false
            }
        );
    }

    /*
     * 2. 特殊ルール、完全解析の上限到達、または負けが確定している局面は、
     *    限定探索で最も粘れる(または有望な)手を選ぶ。
     */
    analyzedNodeCount = 0;
    analyzingStates.clear();

    const limits = normalizeLimits(options);

    const result = solvePosition(state, settings, 0, limits);

    if (!result.bestEntry) {
        const fallback = strongMove(state, settings);

        if (!fallback) {
            return null;
        }

        return {
            ...fallback,
            cpuLevel: "hard",
            evaluation: "heuristic-fallback",
            limited: true,
            analyzedNodeCount
        };
    }

    const nextState = createNextState(
        state,
        result.bestEntry,
        settings
    );

    let evaluation;

    if (exact?.winning === false) {
        evaluation = "exact-lost-resist";
    } else if (result.winning === true) {
        evaluation = "search-win";
    } else if (result.winning === false) {
        evaluation = "search-lost-resist";
    } else {
        evaluation = "search-limited";
    }

    return createMoveResult(
        result.bestEntry,
        result.nextLetter || nextState.currentLetter,
        {
            cpuLevel: "hard",
            evaluation,
            winning:
                exact?.winning === false
                    ? false
                    : result.winning,
            distance: result.distance,
            limited: result.winning === null,
            analyzedNodeCount,
            analysisDepthLimit: limits.maxDepth,
            analysisNodeLimit: limits.maxNodes,
            nEndCount: nextState.nEndCount,
            immediateLoss: false
        }
    );
}


/* =========================================================
   対局後解析(analyzer.jsから使用)
========================================================= */

/**
 * 局面を限定探索で解析する。
 *
 * winning は「勝ちが確定したときだけ true」。
 * 負けが確定した場合も、未確定の場合も false になる。
 * 区別は proven で行う(未確定は proven: false, limited: true)。
 */
function analyzePosition(
    rawState,
    settings = {},
    options = {}
) {
    const state = normalizeState(rawState);

    analyzedNodeCount = 0;
    analyzingStates.clear();

    const limits = normalizeLimits(options);

    const result = solvePosition(state, settings, 0, limits);

    return {
        winning: result.winning === true,
        proven: result.winning !== null,
        distance: result.distance,
        limited: result.winning === null,
        analyzedNodeCount,
        analysisDepthLimit: limits.maxDepth,
        analysisNodeLimit: limits.maxNodes,

        bestMove:
            result.bestEntry
                ? {
                    id: result.bestEntry.id,
                    word: result.bestEntry.name,
                    name: result.bestEntry.name,
                    reading: result.bestEntry.reading,
                    type: result.bestEntry.type,
                    nextLetter: result.nextLetter
                }
                : null
    };
}


/* =========================================================
   キャッシュ
========================================================= */

function clearAnalysisCache() {
    analysisCache.clear();
    analyzingStates.clear();
    exactSolvers.clear();

    analyzedNodeCount = 0;

    return {
        cleared: true
    };
}

function getCacheSize() {
    return analysisCache.size;
}

function getAnalysisLimits() {
    return {
        maxDepth: DEFAULT_MAX_DEPTH,
        maxNodes: DEFAULT_MAX_NODES,
        maxMoves: DEFAULT_MAX_MOVES,
        limitedMoves: DEFAULT_LIMITED_MOVES
    };
}


/* =========================================================
   エクスポート
========================================================= */

module.exports = {
    randomMove,
    strongMove,
    bestMove,

    analyzePosition,
    solvePosition,

    clearAnalysisCache,
    getCacheSize,
    getAnalysisLimits,

    createNextState,
    normalizeState,

    getAllMoves,
    getSafeMoves
};