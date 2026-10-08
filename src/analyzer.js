"use strict";

const {
    createExactSolver
} = require("./exact-solver");

const logic = require("./logic");
const cpu = require("./cpu");
const {
    normalizeRuleSettings: normalizeSettings
} = require("./settings");

/* =========================================================
   単語リスト別の解析設定
========================================================= */

const ANALYSIS_OPTIONS = {
    countries: {
        initial: {
            maxDepth: 10,
            maxNodes: 20000,
            maxMoves: 50,
            limitedMoves: 12
        },

        move: {
            maxDepth: 7,
            maxNodes: 5000,
            maxMoves: 40,
            limitedMoves: 10
        }
    },

    capitals: {
        initial: {
            maxDepth: 8,
            maxNodes: 10000,
            maxMoves: 30,
            limitedMoves: 8
        },

        move: {
            maxDepth: 5,
            maxNodes: 2500,
            maxMoves: 24,
            limitedMoves: 6
        }
    },

    both: {
        initial: {
            maxDepth: 6,
            maxNodes: 3000,
            maxMoves: 18,
            limitedMoves: 5
        },

        move: {
            maxDepth: 4,
            maxNodes: 800,
            maxMoves: 14,
            limitedMoves: 4
        }
    }
};

/* =========================================================
   完全解析(exact-solver)の設定

   1回の対局解析の中で、同じソルバーを
   初期局面と各手の評価で共有する。
   maxStates は対局解析全体での累計の上限。
========================================================= */

const EXACT_ANALYSIS = {
    countries: {
        maxStates: 2000000,
        deadlineMilliseconds: 15000
    },

    other: {
        maxStates: 600000,
        deadlineMilliseconds: 8000
    },

    /*
     * 解析開始からこの時間を過ぎたら、
     * 以降の手は完全解析を試さず限定解析にする。
     * (analysis-manager のタイムアウト45秒に収めるため)
     */
    budgetMilliseconds: 25000
};

/* =========================================================
   解析設定の取得
========================================================= */

function getAnalysisOptions(
    settings,
    type = "move"
) {
    const wordList =
        settings?.wordList ??
        "countries";

    const group =
        ANALYSIS_OPTIONS[wordList] ??
        ANALYSIS_OPTIONS.countries;

    return {
        ...(
            group[type] ??
            group.move
        )
    };
}


/**
 * 現在の候補数に応じて探索深度を調整する。
 */
function createAdaptiveOptions(
    state,
    settings,
    baseOptions
) {
    const candidateCount =
        logic.getSafeAvailableWords(
            state.currentLetter,
            state.usedWords ?? [],
            Number(
                state.nEndCount ?? 0
            ),
            settings
        ).length;

    const options = {
        ...baseOptions
    };

    /*
     * 候補が1～2語なら、
     * 基本値より4手深く探索する。
     */
    if (candidateCount <= 2) {
        options.maxDepth += 4;
        options.maxNodes *= 2;

        return options;
    }

    /*
     * 候補が3～4語なら、
     * 基本値より2手深く探索する。
     */
    if (candidateCount <= 4) {
        options.maxDepth += 2;

        options.maxNodes =
            Math.floor(
                options.maxNodes *
                1.5
            );

        return options;
    }

    /*
     * 候補が9語以上なら、
     * 探索量を抑える。
     */
    if (candidateCount > 8) {
        options.maxDepth =
            Math.max(
                3,
                options.maxDepth - 2
            );

        options.maxNodes =
            Math.max(
                500,
                Math.floor(
                    options.maxNodes *
                    0.7
                )
            );
    }

    return options;
}


/* =========================================================
   棋譜の正規化
========================================================= */

function normalizeHistory(
    rawHistory = []
) {
    if (!Array.isArray(rawHistory)) {
        return [];
    }

    return rawHistory
        .map((item, index) => {
            if (
                typeof item ===
                "string"
            ) {
                const word =
                    item.trim();

                if (!word) {
                    return null;
                }

                return {
                    turnNumber:
                        index + 1,

                    player:
                        null,

                    word,

                    reading:
                        "",

                    type:
                        null,

                    requiredLetter:
                        "",

                    immediateLoss:
                        false,

                    lossReason:
                        ""
                };
            }

            if (
                !item ||
                typeof item !==
                    "object"
            ) {
                return null;
            }

            const word =
                String(
                    item.word ??
                    item.name ??
                    ""
                ).trim();

            if (!word) {
                return null;
            }

            return {
                turnNumber:
                    Number(
                        item.turnNumber ??
                        index + 1
                    ),

                player:
                    item.player ??
                    item.playerId ??
                    null,

                word,

                reading:
                    String(
                        item.reading ??
                        item.yomi ??
                        ""
                    ),

                type:
                    item.type ??
                    null,

                requiredLetter:
                    String(
                        item.requiredLetter ??
                        item.currentLetter ??
                        ""
                    ),

                immediateLoss:
                    item.immediateLoss ===
                    true,

                lossReason:
                    String(
                        item.lossReason ??
                        ""
                    )
            };
        })
        .filter(Boolean);
}


/* =========================================================
   開始文字の取得
========================================================= */

function resolveStartLetter(
    history,
    explicitStartLetter,
    settings
) {
    const explicit =
        logic.normalizeCharacter(
            explicitStartLetter,
            settings
        );

    if (explicit) {
        return explicit;
    }

    const recorded =
        logic.normalizeCharacter(
            history[0]
                ?.requiredLetter ??
            "",
            settings
        );

    if (recorded) {
        return recorded;
    }

    const firstEntry =
        history[0]
            ? logic.findWord(
                history[0].word,
                settings
            )
            : null;

    return firstEntry
        ? logic.getFirstLetter(
            firstEntry,
            settings
        )
        : "";
}


/* =========================================================
   プレイヤー
========================================================= */

function createPlayerMap(history) {
    const players = [];

    for (const move of history) {
        if (
            move.player &&
            !players.includes(
                move.player
            )
        ) {
            players.push(
                move.player
            );
        }
    }

    const map =
        new Map();

    if (players[0]) {
        map.set(
            players[0],
            "先手"
        );
    }

    if (players[1]) {
        map.set(
            players[1],
            "後手"
        );
    }

    return map;
}

function getTurnName(index) {
    return index % 2 === 0
        ? "先手"
        : "後手";
}

function getOpponentName(player) {
    return player === "先手"
        ? "後手"
        : "先手";
}


/* =========================================================
   局面表示
========================================================= */

function positionLabel(
    winning,
    index,
    limited
) {
    const current =
        getTurnName(index);

    const winner =
        winning
            ? current
            : getOpponentName(
                current
            );

    return {
        currentPlayer:
            current,

        winningPlayer:
            winner,

        position:
            limited
                ? `${winner}有利（限定解析）`
                : `${winner}必勝`
    };
}


/* =========================================================
   単語比較
========================================================= */

function isSameWord(
    actualWord,
    bestMove,
    settings
) {
    if (!bestMove) {
        return false;
    }

    const actual =
        logic.findWord(
            actualWord,
            settings
        );

    const best =
        logic.findWord(
            bestMove.word ??
            bestMove.name ??
            "",
            settings
        );

    const actualReading =
        actual?.reading ??
        actualWord;

    const bestReading =
        best?.reading ??
        bestMove.word ??
        bestMove.name ??
        "";

    return (
        logic.normalizeReading(
            actualReading,
            settings
        ) ===
        logic.normalizeReading(
            bestReading,
            settings
        )
    );
}

function createUsedEntry(entry) {
    return {
        id:
            entry.id,

        name:
            entry.name,

        word:
            entry.name,

        reading:
            entry.reading,

        type:
            entry.type
    };
}


/* =========================================================
   実際の手の適用
========================================================= */

function applyActualMove(
    state,
    move,
    settings
) {
    const entry =
        logic.findWord(
            move.word,
            settings
        );

    if (!entry) {
        return {
            valid:
                false,

            terminalLoss:
                false,

            reason:
                "単語リストに存在しない単語です。",

            state
        };
    }

    const validation =
        logic.validateMove({
            word:
                move.word,

            currentLetter:
                state.currentLetter,

            usedWords:
                state.usedWords,

            settings
        });

    if (!validation.valid) {
        return {
            valid:
                false,

            terminalLoss:
                false,

            reason:
                validation.reason,

            entry,
            state
        };
    }

    /*
     * 履歴へ追加する前の状態で
     * 即負け判定を行う。
     */
    const calculated =
        logic.getImmediateLossReasons(
            entry,
            state.usedWords,
            Number(
                state.nEndCount ?? 0
            ),
            settings
        );

    const reasons =
        calculated.length > 0
            ? calculated
            : (
                move.immediateLoss &&
                move.lossReason
                    ? [
                        move.lossReason
                    ]
                    : []
            );

    if (reasons.length > 0) {
        return {
            valid:
                true,

            terminalLoss:
                true,

            reason:
                reasons.join("・"),

            entry,

            state: {
                ...state,

                usedWords: [
                    ...state.usedWords,

                    createUsedEntry(
                        entry
                    )
                ],

                nEndCount:
                    Number(
                        state.nEndCount ??
                        0
                    ) +
                    (
                        logic.endsWithN(
                            entry,
                            settings
                        )
                            ? 1
                            : 0
                    ),

                history: [
                    ...state.history,

                    {
                        word:
                            entry.name,

                        reading:
                            entry.reading,

                        type:
                            entry.type,

                        immediateLoss:
                            true,

                        lossReason:
                            reasons.join(
                                "・"
                            )
                    }
                ]
            }
        };
    }

    return {
        valid:
            true,

        terminalLoss:
            false,

        reason:
            "",

        entry,

        state:
            cpu.createNextState(
                state,
                entry,
                settings
            )
    };
}


/* =========================================================
   局面キャッシュ
========================================================= */

function createStateKey(
    state,
    settings,
    options
) {
    const used =
        (
            state.usedWords ??
            []
        )
            .map(item => {
                return logic.normalizeReading(
                    typeof item ===
                        "string"
                        ? item
                        : (
                            item?.reading ??
                            item?.name ??
                            item?.word ??
                            ""
                        ),
                    settings
                );
            })
            .sort();

    return JSON.stringify({
        currentLetter:
            logic.normalizeCharacter(
                state.currentLetter,
                settings
            ),

        used,

        nEndCount:
            Number(
                state.nEndCount ??
                0
            ),

        settings,
        options
    });
}

function analyzeStateCached(
    state,
    settings,
    baseOptions,
    cache
) {
    const options =
        createAdaptiveOptions(
            state,
            settings,
            baseOptions
        );

    const key =
        createStateKey(
            state,
            settings,
            options
        );

    if (cache.has(key)) {
        return cache.get(key);
    }

    const result =
        cpu.analyzePosition(
            state,
            settings,
            options
        );

    cache.set(
        key,
        result
    );

    return result;
}


/* =========================================================
   完全解析(exact-solver)による局面評価
========================================================= */

/**
 * 対局解析用の完全解析ソルバーを作る。
 * 通常しりとりルール以外では使えないため null を返す。
 */
function createExactAnalysisSolver(settings) {
    if (settings.rule !== "normal") {
        return null;
    }

    const config =
        settings.wordList === "countries"
            ? EXACT_ANALYSIS.countries
            : EXACT_ANALYSIS.other;

    try {
        return createExactSolver(
            settings,
            {
                maxStates: config.maxStates,
                deadlineMilliseconds: config.deadlineMilliseconds
            }
        );
    } catch (error) {
        console.error(
            "[analyzer] exact-solverの作成に失敗しました。",
            error
        );

        return null;
    }
}

/**
 * 完全解析で局面を評価する。
 *
 * 戻り値:
 *   null      解析できない
 *             (特殊ルール・上限到達・時間超過・エラー)
 *
 *   オブジェクト
 *             勝敗が確定した評価
 *
 * winning は「現在の手番側が勝つか」。
 *
 * 勝勢局面:
 *   最短で勝つ手を bestMove / distance にする。
 *
 * 敗勢局面:
 *   負けるまで最も長く粘れる手を bestMove / distance にする。
 */
function analyzeStateExact(state, context) {
    if (!context?.solver) {
        return null;
    }

    if (
        Date.now() - context.startedAt >
        context.budgetMilliseconds
    ) {
        return null;
    }

    let analysis;

    try {
        analysis =
            context.solver.analyzePosition({
                requiredLetter:
                    state.currentLetter,

                usedWords:
                    state.usedWords ?? [],

                nEndCount:
                    Number(
                        state.nEndCount ?? 0
                    )
            });
    } catch (error) {
        console.error(
            "[analyzer] exact-solverの解析に失敗しました。",
            error
        );

        return null;
    }

    if (!analysis?.exact) {
        return null;
    }

    const winning =
        analysis.winning === true;

    return {
        winning,

        /*
         * 勝勢なら最短勝利距離、
         * 敗勢なら最長抵抗距離。
         */
        distance:
            analysis.distance,

        /*
         * 勝勢なら勝ちを最短化する手、
         * 敗勢なら負けを最長化する抵抗手。
         */
        bestMove:
            analysis.bestMove,

        principalVariation:
            analysis.principalVariation ?? [],

        limited:
            false,

        exact:
            true,

        analyzedNodeCount:
            analysis.statistics?.visitedStates ?? 0
    };
}

/**
 * 完全解析を優先し、できなければ限定解析で局面を評価する。
 */
function analyzeStateAuto(
    state,
    settings,
    baseOptions,
    cache,
    context
) {
    return (
        analyzeStateExact(
            state,
            context
        ) ??
        analyzeStateCached(
            state,
            settings,
            baseOptions,
            cache
        )
    );
}


/* =========================================================
   初期局面
========================================================= */

function analyzeInitialPosition(
    startLetter,
    settings,
    cache
) {
    /*
     * 通常ルールでは、
     * ビット集合による完全後退解析を優先する。
     */
    if (settings.rule === "normal") {
        const exactSolver =
            createExactSolver(
                settings,
                {
                    maxStates:
                        settings.wordList ===
                        "countries"
                            ? 1000000
                            : 300000,

                    deadlineMilliseconds:
                        settings.wordList ===
                        "countries"
                            ? 30000
                            : 10000
                }
            );

        const exactResult =
            exactSolver.analyzeStart(
                startLetter,
                [],
                0
            );

        if (exactResult.exact) {
            return {
                state: {
                    currentLetter:
                        startLetter,

                    usedWords:
                        [],

                    history:
                        [],

                    nEndCount:
                        0
                },

                winning:
                    exactResult.winning,

                distance:
                    exactResult.distance,

                bestMove:
                    exactResult.bestMove,

                limited:
                    false,

                /*
                 * 初期局面も完全解析済みであることを明示する。
                 */
                exact:
                    true,

                analyzedNodeCount:
                    exactResult
                        .statistics
                        .visitedStates,

                analysisOptions: {
                    method:
                        "exact-retrograde",

                    maxStates:
                        exactResult
                            .statistics
                            .maxStates
                },

                verdict:
                    exactResult.winning
                        ? "先手必勝"
                        : "後手必勝",

                winningPlayer:
                    exactResult.winning
                        ? "先手"
                        : "後手",

                principalVariation:
                    exactResult
                        .principalVariation
            };
        }
    }

    /*
     * 完全解析が上限に達した場合は、
     * 従来の限定解析へ切り替える。
     */
    const state = {
        currentLetter:
            startLetter,

        usedWords:
            [],

        history:
            [],

        nEndCount:
            0
    };

    const initialOptions =
        getAnalysisOptions(
            settings,
            "initial"
        );

    const result =
        analyzeStateCached(
            state,
            settings,
            initialOptions,
            cache
        );

    const limited =
        result.limited === true;

    return {
        state,

        winning:
            result.winning,

        distance:
            result.distance,

        bestMove:
            result.bestMove,

        limited,

        exact:
            result.exact === true,

        analyzedNodeCount:
            result.analyzedNodeCount,

        analysisOptions:
            initialOptions,

        verdict:
            limited
                ? (
                    result.winning
                        ? "先手有利（限定解析）"
                        : "後手有利（限定解析）"
                )
                : (
                    result.winning
                        ? "先手必勝"
                        : "後手必勝"
                ),

        winningPlayer:
            result.winning
                ? "先手"
                : "後手"
    };
}


/* =========================================================
   手の評価コメント
========================================================= */

function createMoveComment(move) {
    if (move.immediateLoss) {
        return (
            `「${move.actualWord}」は` +
            `${move.lossReason}のため、` +
            `${move.player}の即負けです。`
        );
    }

    if (move.limited) {
        if (
            move.wasBestMove &&
            move.evaluationChangedUnderLimit
        ) {
            return (
                `${move.player}は限定解析上の最善手を選びました。` +
                "指す前後で評価表示が変化していますが、" +
                "探索上限による評価の揺れであり、" +
                "勝ち筋を逃したことを意味しません。"
            );
        }

        if (move.wasBestMove) {
            return (
                `${move.player}は限定解析で` +
                "最も評価の高い手を選びました。"
            );
        }

        if (move.evaluationChangedUnderLimit) {
            return (
                "指す前後で評価表示が変化しましたが、" +
                "限定解析のため勝負の分岐点とは断定できません。"
            );
        }

        return (
            "探索上限に達したため、" +
            "この手の評価は参考値です。"
        );
    }

    /*
     * 完全解析で、手番側がすでに負けている局面。
     *
     * この場合の bestMove は
     * 「勝つための手」ではなく、
     * 「負けるまでの手数を最大化する最善の抵抗手」。
     */
    if (
        move.exact &&
        move.winningPlayerBefore !== move.player
    ) {
        const best =
            move.bestMove?.word ??
            move.bestMove?.name ??
            "";

        if (
            move.wasBestMove &&
            best
        ) {
            return (
                `${move.player}は必敗局面ですが、` +
                `負けるまでの手数を最大化する最善の抵抗手「${best}」を選びました。` +
                (
                    Number.isFinite(
                        move.optimalDistance
                    )
                        ? `最善応手に対して${move.optimalDistance}手粘れます。`
                        : ""
                )
            );
        }

        return best
            ? (
                `${move.player}は必敗局面です。` +
                `最善の抵抗手は「${best}」で、` +
                (
                    Number.isFinite(
                        move.optimalDistance
                    )
                        ? `最善応手に対して${move.optimalDistance}手粘れます。`
                        : "できるだけ長く粘れます。"
                )
            )
            : (
                `${move.player}は必敗局面です。` +
                "最善の抵抗手を特定できませんでした。"
            );
    }

    if (move.wasBestMove) {
        return (
            move.winningPlayerBefore === move.player
        )
            ? (
                `${move.player}は最善手を選び、` +
                "勝ち筋を維持しました。"
            )
            : (
                `${move.player}は不利な局面で` +
                "最善の抵抗手を選びました。"
            );
    }

    if (move.lostWinningPosition) {
        const best =
            move.bestMove?.word ??
            move.bestMove?.name ??
            "";

        return best
            ? (
                `${move.player}は勝ち筋を逃しました。` +
                `最善手は「${best}」でした。`
            )
            : (
                `${move.player}はこの手で` +
                "勝ち筋を逃しました。"
            );
    }

    return (
        "最善手とは異なる手が選ばれました。"
    );
}


/* =========================================================
   棋譜の各手を解析
========================================================= */

function analyzeMoves(
    history,
    initialAnalysis,
    settings,
    playerMap,
    cache,
    context
) {
    const moves = [];

    const moveOptions =
        getAnalysisOptions(
            settings,
            "move"
        );

    const initialState =
        initialAnalysis.state;

    let state = {
        currentLetter:
            initialState.currentLetter,

        usedWords:
            [...initialState.usedWords],

        history:
            [...initialState.history],

        nEndCount:
            Number(
                initialState.nEndCount ?? 0
            )
    };

    let firstTurningPoint = null;

    /*
     * 1手目を指す前の局面は初期局面そのものなので、
     * 初期解析の結果をそのまま利用する。
     */
    let previousAfterAnalysis = {
        winning:
            initialAnalysis.winning,

        distance:
            initialAnalysis.distance,

        bestMove:
            initialAnalysis.bestMove,

        limited:
            initialAnalysis.limited,

        exact:
            initialAnalysis.exact === true,

        analyzedNodeCount:
            initialAnalysis.analyzedNodeCount
    };

    for (
        let index = 0;
        index < history.length;
        index += 1
    ) {
        const recorded =
            history[index];

        const player =
            recorded.player
                ? (
                    playerMap.get(
                        recorded.player
                    ) ??
                    getTurnName(index)
                )
                : getTurnName(index);

        const before =
            previousAfterAnalysis ??
            analyzeStateAuto(
                state,
                settings,
                moveOptions,
                cache,
                context
            );

        const beforeEval =
            positionLabel(
                before.winning,
                index,
                before.limited === true
            );

        const applied =
            applyActualMove(
                state,
                recorded,
                settings
            );

        if (!applied.valid) {
            moves.push({
                turnNumber:
                    index + 1,

                player,

                actualWord:
                    recorded.word,

                requiredLetter:
                    state.currentLetter,

                valid:
                    false,

                error:
                    applied.reason,

                positionBefore:
                    beforeEval.position,

                bestMove:
                    before.bestMove,

                wasBestMove:
                    false
            });

            break;
        }

        /*
         * 「ン」または重複による即負け。
         */
        if (applied.terminalLoss) {
            const winner =
                getOpponentName(
                    player
                );

            const result = {
                turnNumber:
                    index + 1,

                player,

                actualWord:
                    applied.entry.name,

                reading:
                    applied.entry.reading,

                requiredLetter:
                    state.currentLetter,

                nextLetter:
                    "",

                valid:
                    true,

                immediateLoss:
                    true,

                lossReason:
                    applied.reason,

                positionBefore:
                    beforeEval.position,

                positionAfter:
                    `${winner}勝利`,

                winningPlayerBefore:
                    beforeEval.winningPlayer,

                winningPlayerAfter:
                    winner,

                bestMove:
                    before.bestMove,

                wasBestMove:
                    false,

                optimalDistance:
                    before.distance,

                limited:
                    before.limited === true,

                exact:
                    before.exact === true,

                lostWinningPosition:
                    before.limited !== true &&
                    beforeEval.winningPlayer ===
                        player
            };

            result.comment =
                createMoveComment(
                    result
                );

            moves.push(
                result
            );

            /*
             * 即負けは確定的な終局なので、
             * 分岐点として記録する。
             */
            firstTurningPoint =
                firstTurningPoint ??
                {
                    turnNumber:
                        index + 1,

                    player,

                    actualWord:
                        applied.entry.name,

                    bestMove:
                        before.bestMove,

                    positionBefore:
                        beforeEval.position,

                    positionAfter:
                        `${winner}勝利`,

                    immediateLoss:
                        true
                };

            state =
                applied.state;

            break;
        }

        const nextState =
            applied.state;

        /*
         * 指した後の局面。
         * 通常ルールは完全解析、できなければ限定解析。
         */
        const after =
            analyzeStateAuto(
                nextState,
                settings,
                moveOptions,
                cache,
                context
            );

        /*
         * この結果は、次の手の指す前の解析結果と同じ。
         */
        previousAfterAnalysis =
            after;

        const afterEval =
            positionLabel(
                after.winning,
                index + 1,
                after.limited === true
            );

        const bothExact =
            before.exact === true &&
            after.exact === true;

        const moverWasWinning =
            beforeEval.winningPlayer ===
            player;

        const moverStillWinning =
            afterEval.winningPlayer ===
            player;

        /*
         * 完全解析どうしの場合:
         *
         *   勝ちの局面で勝ちを維持した手は
         *   すべて最善手。
         *
         *   敗勢局面では、
         *   solver が選んだ
         *   「最も長く粘れる手」と一致した場合を
         *   最善抵抗手とする。
         *
         * それ以外の場合:
         *   解析が挙げた最善手と同じ単語かどうか。
         */
        const wasBestMove =
            bothExact
                ? (
                    moverWasWinning
                        ? moverStillWinning
                        : isSameWord(
                            recorded.word,
                            before.bestMove,
                            settings
                        )
                )
                : isSameWord(
                    recorded.word,
                    before.bestMove,
                    settings
                );

        const evaluationChanged =
            beforeEval.winningPlayer !==
            afterEval.winningPlayer;

        const evaluationChangedUnderLimit =
            (
                before.limited === true ||
                after.limited === true
            ) &&
            evaluationChanged;

        /*
         * 本当に勝ち筋を逃したと判定するのは、
         * 指す前後が両方とも完全に確定していて、
         * かつ最善手ではない場合だけ。
         */
        const lostWinningPosition =
            before.limited !== true &&
            after.limited !== true &&
            moverWasWinning &&
            !moverStillWinning &&
            !wasBestMove;

        const result = {
            turnNumber:
                index + 1,

            player,

            actualWord:
                applied.entry.name,

            reading:
                applied.entry.reading,

            requiredLetter:
                state.currentLetter,

            nextLetter:
                nextState.currentLetter,

            valid:
                true,

            positionBefore:
                beforeEval.position,

            positionAfter:
                afterEval.position,

            winningPlayerBefore:
                beforeEval.winningPlayer,

            winningPlayerAfter:
                afterEval.winningPlayer,

            bestMove:
                before.bestMove,

            wasBestMove,

            /*
             * 勝勢なら最短勝利手数。
             * 敗勢なら最長抵抗手数。
             */
            optimalDistance:
                before.distance,

            limited:
                before.limited === true ||
                after.limited === true,

            exact:
                bothExact,

            evaluationChanged,

            evaluationChangedUnderLimit,

            lostWinningPosition
        };

        result.comment =
            createMoveComment(
                result
            );

        moves.push(
            result
        );

        /*
         * 限定解析の評価変動は
         * 勝負の分岐点にしない。
         */
        if (
            !firstTurningPoint &&
            lostWinningPosition
        ) {
            firstTurningPoint = {
                turnNumber:
                    index + 1,

                player,

                actualWord:
                    applied.entry.name,

                bestMove:
                    before.bestMove,

                positionBefore:
                    beforeEval.position,

                positionAfter:
                    afterEval.position
            };
        }

        state =
            nextState;
    }

    return {
        moves,

        finalState:
            state,

        firstTurningPoint,

        moveOptions
    };
}


/* =========================================================
   実際の勝者
========================================================= */

function determineHistoryWinner(
    history,
    playerMap
) {
    if (history.length === 0) {
        return null;
    }

    const last =
        history[
            history.length - 1
        ];

    if (last.immediateLoss) {
        const loser =
            last.player &&
            playerMap.has(
                last.player
            )
                ? playerMap.get(
                    last.player
                )
                : getTurnName(
                    history.length - 1
                );

        return getOpponentName(
            loser
        );
    }

    if (
        last.player &&
        playerMap.has(
            last.player
        )
    ) {
        return playerMap.get(
            last.player
        );
    }

    return history.length % 2 === 1
        ? "先手"
        : "後手";
}


function resolveActualWinner(
    gameResult,
    playerMap,
    history
) {
    const firstPlayer =
        history[0]?.player ??
        null;

    function convert(player) {
        if (
            player === "先手" ||
            player === "後手"
        ) {
            return player;
        }

        if (
            player &&
            playerMap.has(player)
        ) {
            return playerMap.get(
                player
            );
        }

        if (player === "human") {
            return firstPlayer === "human"
                ? "先手"
                : "後手";
        }

        if (player === "cpu") {
            return firstPlayer === "cpu"
                ? "先手"
                : "後手";
        }

        return null;
    }

    const winner =
        convert(
            gameResult?.winner
        );

    if (winner) {
        return winner;
    }

    const loser =
        convert(
            gameResult?.loser
        );

    if (loser) {
        return getOpponentName(
            loser
        );
    }

    const last =
        history[
            history.length - 1
        ];

    if (last?.immediateLoss) {
        const losingPlayer =
            convert(
                last.player
            ) ??
            getTurnName(
                history.length - 1
            );

        return getOpponentName(
            losingPlayer
        );
    }

    return null;
}


/* =========================================================
   解析結果の文章
========================================================= */

function createSummary(
    initial,
    actualWinner,
    turningPoint
) {
    const lines = [
        `初期局面は${initial.verdict}です。`
    ];

    if (initial.limited) {
        lines.push(
            "探索上限に達したため、" +
            "一定手数までの限定解析結果です。"
        );
    }

    if (initial.bestMove?.word) {
        lines.push(
            `開始時の最善手は「${initial.bestMove.word}」です。`
        );
    }

    if (actualWinner) {
        lines.push(
            `実際の勝者は${actualWinner}です。`
        );
    }

    if (turningPoint) {
        const best =
            turningPoint.bestMove
                ?.word ??
            turningPoint.bestMove
                ?.name ??
            "";

        if (
            turningPoint.immediateLoss
        ) {
            lines.push(
                `${turningPoint.turnNumber}手目の` +
                `「${turningPoint.actualWord}」で` +
                "即負けとなり、勝敗が決まりました。"
            );
        } else if (best) {
            lines.push(
                `${turningPoint.turnNumber}手目の` +
                `「${turningPoint.actualWord}」で` +
                "確定的な勝敗評価が変化しました。" +
                `最善手は「${best}」でした。`
            );
        } else {
            lines.push(
                `${turningPoint.turnNumber}手目で` +
                "勝敗が決まりました。"
            );
        }
    } else {
        lines.push(
            "棋譜内に確定的な勝敗評価の変化はありませんでした。"
        );
    }

    return lines.join("\n");
}


/* =========================================================
   対局全体の解析
========================================================= */

function analyze(
    rawHistory,
    rawSettings = {},
    explicitStartLetter = "",
    actualGameResult = {}
) {
    const startedAt =
        Date.now();

    const settings =
        normalizeSettings(
            rawSettings
        );

    const history =
        normalizeHistory(
            rawHistory
        );

    const startLetter =
        resolveStartLetter(
            history,
            explicitStartLetter,
            settings
        );

    if (!startLetter) {
        return {
            success:
                false,

            error:
                "開始文字を特定できないため、解析できませんでした。",

            settings,

            historyLength:
                history.length
        };
    }

    const startWords =
        logic.getAvailableWords(
            startLetter,
            [],
            settings
        );

    if (startWords.length === 0) {
        return {
            success:
                false,

            error:
                `開始文字「${startLetter}」から始まる単語がありません。`,

            startLetter,

            settings,

            historyLength:
                history.length
        };
    }

    /*
     * 1回の対局解析の中で、
     * 局面解析結果と完全解析ソルバーを再利用する。
     */
    const cache =
        new Map();

    const context = {
        solver:
            createExactAnalysisSolver(
                settings
            ),

        startedAt,

        budgetMilliseconds:
            EXACT_ANALYSIS
                .budgetMilliseconds
    };

    const initial =
        analyzeInitialPosition(
            startLetter,
            settings,
            cache,
            context
        );

    const playerMap =
        createPlayerMap(
            history
        );

    const detail =
        analyzeMoves(
            history,
            initial,
            settings,
            playerMap,
            cache,
            context
        );

    const actualWinner =
        resolveActualWinner(
            actualGameResult,
            playerMap,
            history
        ) ??
        determineHistoryWinner(
            history,
            playerMap
        );

    const finalState =
        detail.finalState;

    const finalLetter =
        finalState.currentLetter ??
        "";

    return {
        success:
            true,

        startLetter,

        settings,

        verdict:
            initial.verdict,

        winningPlayer:
            initial.winningPlayer,

        firstPlayerWinning:
            initial.winning,

        limited:
            initial.limited,

        optimalDistance:
            initial.distance,

        bestMove:
            initial.bestMove,

        actualWinner,

        actualResultReason:
            String(
                actualGameResult?.reason ??
                ""
            ),

        historyLength:
            history.length,

        moveAnalysis:
            detail.moves,

        firstTurningPoint:
            detail.firstTurningPoint,

        finalState: {
            currentLetter:
                finalLetter,

            usedWordCount:
                finalState
                    .usedWords
                    ?.length ??
                0,

            nEndCount:
                Number(
                    finalState.nEndCount ??
                    0
                ),

            availableWordCount:
                finalLetter
                    ? logic.getAvailableWords(
                        finalLetter,
                        finalState.usedWords ??
                            [],
                        settings
                    ).length
                    : 0
        },

        summary:
            createSummary(
                initial,
                actualWinner,
                detail.firstTurningPoint
            ),

        analysisInfo: {
            elapsedMilliseconds:
                Date.now() -
                startedAt,

            cacheSize:
                cache.size,

            cpuCacheSize:
                cpu.getCacheSize(),

            analyzedNodeCount:
                initial.analyzedNodeCount,

            limited:
                initial.limited,

            exactSolverUsed:
                context.solver !== null,

            exactMoveCount:
                detail.moves.filter(
                    move =>
                        move.exact === true
                ).length,

            initialOptions: {
                ...initial.analysisOptions
            },

            moveOptions: {
                ...detail.moveOptions
            }
        }
    };
}


/* =========================================================
   特定局面の解析
========================================================= */

function analyzePosition({
    currentLetter,
    usedWords = [],
    nEndCount = 0,
    settings = {},
    options = null
}) {
    const normalizedSettings =
        normalizeSettings(
            settings
        );

    const letter =
        logic.normalizeCharacter(
            currentLetter,
            normalizedSettings
        );

    if (!letter) {
        return {
            success:
                false,

            error:
                "解析する文字が指定されていません。"
        };
    }

    const state = {
        currentLetter:
            letter,

        usedWords:
            Array.isArray(usedWords)
                ? [...usedWords]
                : [],

        history:
            [],

        nEndCount:
            Number(nEndCount)
    };

    const baseOptions =
        options &&
        typeof options ===
            "object"
            ? options
            : getAnalysisOptions(
                normalizedSettings,
                "move"
            );

    const normalizedOptions =
        createAdaptiveOptions(
            state,
            normalizedSettings,
            baseOptions
        );

    const result =
        cpu.analyzePosition(
            state,
            normalizedSettings,
            normalizedOptions
        );

    return {
        success:
            true,

        currentLetter:
            letter,

        winning:
            result.winning,

        limited:
            result.limited === true,

        verdict:
            result.limited
                ? (
                    result.winning
                        ? "現在の手番側が有利（限定解析）"
                        : "現在の手番側が不利（限定解析）"
                )
                : (
                    result.winning
                        ? "現在の手番側が必勝"
                        : "現在の手番側が敗勢"
                ),

        distance:
            result.distance,

        bestMove:
            result.bestMove,

        analysisOptions:
            normalizedOptions,

        availableWordCount:
            logic.getAvailableWords(
                letter,
                state.usedWords,
                normalizedSettings
            ).length
    };
}


/* =========================================================
   キャッシュ削除
========================================================= */

function clearCache() {
    return cpu.clearAnalysisCache();
}


/* =========================================================
   エクスポート
========================================================= */

module.exports = {
    analyze,
    analyzePosition,
    clearCache,

    normalizeHistory,
    normalizeSettings,
    getAnalysisOptions
};