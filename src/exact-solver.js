"use strict";
const logic = require("./logic");
const {
    normalizeRuleSettings: normalizeSettings
} = require("./settings");

const RESULT = Object.freeze({
    UNKNOWN: 0,
    WIN: 1,
    LOSE: 2
});

const OUTCOME = Object.freeze({
    UNKNOWN: "UNKNOWN",
    WIN: "WIN",
    LOSE: "LOSE"
});



function createExactSolver(
    rawSettings = {},
    rawOptions = {}
) {
    const settings =
        normalizeSettings(
            rawSettings
        );

    if (settings.rule !== "normal") {
        throw new Error(
            "exact-solver.jsは通常しりとりルール専用です。"
        );
    }

    const options = {
        maxStates:
            positiveInt(
                rawOptions.maxStates,
                settings.wordList === "countries"
                    ? 5000000
                    : 1000000
            ),

        deadlineMilliseconds:
            positiveInt(
                rawOptions.deadlineMilliseconds,
                settings.wordList === "countries"
                    ? 60000
                    : 20000
            ),

        principalVariationLimit:
            positiveInt(
                rawOptions.principalVariationLimit,
                100
            ),

        timeCheckInterval:
            powerOfTwo(
                rawOptions.timeCheckInterval,
                1024
            )
    };

    let startedAt =
        Date.now();

    let deadline =
        startedAt +
        options.deadlineMilliseconds;

    const rawWords =
        logic.getWords(
            settings
        ).map(
            (source, index) => {
                const reading =
                    logic.normalizeReading(
                        source.reading ??
                        source.name,
                        settings
                    );

                return {
                    ...source,

                    sourceIndex:
                        index,

                    reading,

                    firstLetter:
                        logic.getFirstLetter(
                            source,
                            settings
                        ),

                    lastLetter:
                        logic.getLastLetter(
                            source,
                            settings
                        ),

                    firstLetterId:
                        -1,

                    lastLetterId:
                        -1,

                    searchIndex:
                        -1,

                    bit:
                        0n,

                    usageBit:
                        0n,

                    nextNState0:
                        0,

                    nextNState1:
                        0,

                    childLegalMask0:
                        0n,

                    childLegalMask1:
                        0n,

                    childTerminalMask0:
                        0n,

                    childTerminalMask1:
                        0n,

                    staticReplyCount:
                        0,

                    staticTerminalWin:
                        false
                };
            }
        );

    const searchWords =
        buildSearchWords(
            rawWords,
            settings
        );

    const letterIndex =
        buildLetterIndex(
            searchWords
        );

    for (
        let index = 0;
        index < searchWords.length;
        index += 1
    ) {
        const entry =
            searchWords[index];

        entry.searchIndex =
            index;

        entry.bit =
            1n <<
            BigInt(index);

        entry.firstLetterId =
            letterIndex
                .letterToId
                .get(
                    entry.firstLetter
                );

        entry.lastLetterId =
            letterIndex
                .letterToId
                .get(
                    entry.lastLetter
                );

        entry.nextNState0 =
            getNextNState(
                0,
                entry.lastLetter,
                settings
            );

        entry.nextNState1 =
            getNextNState(
                1,
                entry.lastLetter,
                settings
            );
    }

    const readingMasks =
        buildReadingMasks(
            searchWords
        );

    for (const entry of searchWords) {
        entry.usageBit =
            settings.duplicateRule === "once"
                ? (
                    readingMasks.get(
                        entry.reading
                    ) ??
                    entry.bit
                )
                : entry.bit;
    }

    const wordsByFirstLetterId =
        buildWordsByFirstLetterId(
            searchWords,
            letterIndex
                .idToLetter
                .length
        );

    const legalMoveMasks =
        buildLegalMoveMasks(
            searchWords,
            letterIndex
                .idToLetter
                .length,
            settings
        );

    const terminalMasks =
        buildTerminalMasks(
            searchWords,
            letterIndex
                .idToLetter
                .length,
            legalMoveMasks,
            settings
        );

    for (const entry of searchWords) {
        entry.childLegalMask0 =
            legalMoveMasks[
                entry.nextNState0
            ][
                entry.lastLetterId
            ] ??
            0n;

        entry.childLegalMask1 =
            legalMoveMasks[
                entry.nextNState1
            ][
                entry.lastLetterId
            ] ??
            0n;

        entry.childTerminalMask0 =
            terminalMasks[
                entry.nextNState0
            ][
                entry.lastLetterId
            ] ??
            0n;

        entry.childTerminalMask1 =
            terminalMasks[
                entry.nextNState1
            ][
                entry.lastLetterId
            ] ??
            0n;
    }

    prepareStaticOrder(
        searchWords,
        wordsByFirstLetterId,
        legalMoveMasks,
        settings
    );

    const wordByReading =
        new Map();

    const wordByReadingAndType =
        new Map();

    for (const entry of searchWords) {
        if (
            !wordByReading.has(
                entry.reading
            )
        ) {
            wordByReading.set(
                entry.reading,
                entry
            );
        }

        wordByReadingAndType.set(
            createReadingTypeKey(
                entry.reading,
                entry.type
            ),
            entry
        );
    }

    const memo =
        Array.from(
            {
                length:
                    letterIndex
                        .idToLetter
                        .length
            },
            () => {
                return [
                    new Map(),
                    new Map()
                ];
            }
        );

    const killerMoves =
        [
            new Int32Array(
                letterIndex.idToLetter.length
            ),
            new Int32Array(
                letterIndex.idToLetter.length
            )
        ];

    /*
     * 勝敗が確定した局面から終局までの最適距離。
     * WIN  : 自分が最短で勝つ手数
     * LOSE : 相手が最善を尽くしても、最も長く粘れる手数
     */
    const distanceMemo =
        Array.from(
            {
                length:
                    letterIndex.idToLetter.length
            },
            () => {
                return [
                    new Map(),
                    new Map()
                ];
            }
        );

    for (const table of killerMoves) {
        table.fill(-1);
    }

    let memoStateCount = 0;
    let visitedStates = 0;
    let cacheHits = 0;
    let terminalShortcutHits = 0;
    let childTerminalHits = 0;
    let stoppedByLimit = false;
    let stopReason = "";

    const timeCheckMask =
        options.timeCheckInterval - 1;

    function solveOutcome(
        letterId,
        usedMask = 0n,
        nState = 0
    ) {
        const cached =
            memoGet(
                letterId,
                nState,
                usedMask
            );

        if (cached !== undefined) {
            cacheHits += 1;

            return decodeMemoResult(
                cached
            );
        }

        if (limitReachedFast()) {
            return RESULT.UNKNOWN;
        }

        visitedStates += 1;

        const legalMask =
            legalMoveMasks[nState][letterId] ??
            0n;

        const availableMask =
            legalMask ^
            (legalMask & usedMask);

        if (availableMask === 0n) {
            memoSet(
                letterId,
                nState,
                usedMask,
                RESULT.LOSE,
                -1
            );

            return RESULT.LOSE;
        }

        const moves =
            wordsByFirstLetterId[letterId] ??
            [];

        const terminalMask =
            terminalMasks[nState][letterId] ??
            0n;

        const terminalAvailable =
            terminalMask ^
            (terminalMask & usedMask);

        if (terminalAvailable !== 0n) {
            terminalShortcutHits += 1;

            const moveIndex =
                firstEntryIndexFromMask(
                    moves,
                    terminalAvailable
                );

            killerMoves[nState][letterId] =
                moveIndex;

            memoSet(
                letterId,
                nState,
                usedMask,
                RESULT.WIN,
                moveIndex
            );

            return RESULT.WIN;
        }

        let hasUnknownChild = false;
        let fallbackMoveIndex = -1;
        let moveChecks = 0;

        const killerIndex =
            killerMoves[nState][letterId];

        if (killerIndex >= 0) {
            const killer =
                searchWords[killerIndex];

            if (
                killer &&
                (
                    (
                        availableMask &
                        killer.bit
                    ) !== 0n
                )
            ) {
                const nextMask =
                    usedMask |
                    killer.usageBit;

                const nextNState =
                    nState === 0
                        ? killer.nextNState0
                        : killer.nextNState1;

                const childLegalMask =
                    nState === 0
                        ? killer.childLegalMask0
                        : killer.childLegalMask1;

                const childAvailable =
                    childLegalMask ^
                    (childLegalMask & nextMask);

                if (childAvailable === 0n) {
                    childTerminalHits += 1;

                    memoSet(
                        killer.lastLetterId,
                        nextNState,
                        nextMask,
                        RESULT.LOSE,
                        -1
                    );

                    memoSet(
                        letterId,
                        nState,
                        usedMask,
                        RESULT.WIN,
                        killer.searchIndex
                    );

                    return RESULT.WIN;
                }

                const childTerminalMask =
                    nState === 0
                        ? killer.childTerminalMask0
                        : killer.childTerminalMask1;

                const childTerminalAvailable =
                    childTerminalMask ^
                    (childTerminalMask & nextMask);

                if (childTerminalAvailable !== 0n) {
                    childTerminalHits += 1;

                    const childMoveIndex =
                        firstEntryIndexFromMask(
                            wordsByFirstLetterId[
                                killer.lastLetterId
                            ],
                            childTerminalAvailable
                        );

                    memoSet(
                        killer.lastLetterId,
                        nextNState,
                        nextMask,
                        RESULT.WIN,
                        childMoveIndex
                    );
                } else {
                    const child =
                        solveOutcome(
                            killer.lastLetterId,
                            nextMask,
                            nextNState
                        );

                    if (child === RESULT.LOSE) {
                        memoSet(
                            letterId,
                            nState,
                            usedMask,
                            RESULT.WIN,
                            killer.searchIndex
                        );

                        return RESULT.WIN;
                    }

                    if (child === RESULT.UNKNOWN) {
                        hasUnknownChild = true;
                    }
                }
            }
        }

        for (const move of moves) {
            if (
                move.searchIndex ===
                killerIndex
            ) {
                continue;
            }

            moveChecks += 1;

            if (
                (
                    moveChecks &
                    timeCheckMask
                ) === 0 &&
                Date.now() >= deadline
            ) {
                stoppedByLimit = true;
                stopReason = "deadline";

                return RESULT.UNKNOWN;
            }

            if (
                (
                    availableMask &
                    move.bit
                ) === 0n
            ) {
                continue;
            }

            if (fallbackMoveIndex < 0) {
                fallbackMoveIndex =
                    move.searchIndex;
            }

            const nextMask =
                usedMask |
                move.usageBit;

            const nextNState =
                nState === 0
                    ? move.nextNState0
                    : move.nextNState1;

            const childLegalMask =
                nState === 0
                    ? move.childLegalMask0
                    : move.childLegalMask1;

            const childAvailable =
                childLegalMask ^
                (childLegalMask & nextMask);

            if (childAvailable === 0n) {
                childTerminalHits += 1;

                memoSet(
                    move.lastLetterId,
                    nextNState,
                    nextMask,
                    RESULT.LOSE,
                    -1
                );

                killerMoves[nState][letterId] =
                    move.searchIndex;

                memoSet(
                    letterId,
                    nState,
                    usedMask,
                    RESULT.WIN,
                    move.searchIndex
                );

                return RESULT.WIN;
            }

            const childTerminalMask =
                nState === 0
                    ? move.childTerminalMask0
                    : move.childTerminalMask1;

            const childTerminalAvailable =
                childTerminalMask ^
                (childTerminalMask & nextMask);

            if (childTerminalAvailable !== 0n) {
                childTerminalHits += 1;

                const childMoveIndex =
                    firstEntryIndexFromMask(
                        wordsByFirstLetterId[
                            move.lastLetterId
                        ],
                        childTerminalAvailable
                    );

                memoSet(
                    move.lastLetterId,
                    nextNState,
                    nextMask,
                    RESULT.WIN,
                    childMoveIndex
                );

                continue;
            }

            const child =
                solveOutcome(
                    move.lastLetterId,
                    nextMask,
                    nextNState
                );

            if (child === RESULT.LOSE) {
                killerMoves[nState][letterId] =
                    move.searchIndex;

                memoSet(
                    letterId,
                    nState,
                    usedMask,
                    RESULT.WIN,
                    move.searchIndex
                );

                return RESULT.WIN;
            }

            if (child === RESULT.UNKNOWN) {
                hasUnknownChild = true;
            }
        }

        if (!hasUnknownChild) {
            memoSet(
                letterId,
                nState,
                usedMask,
                RESULT.LOSE,
                fallbackMoveIndex
            );

            return RESULT.LOSE;
        }

        return RESULT.UNKNOWN;
    }

    function memoGet(
        letterId,
        nState,
        usedMask
    ) {
        return memo[letterId][nState].get(
            usedMask
        );
    }

    function memoSet(
        letterId,
        nState,
        usedMask,
        value,
        moveIndex = -1
    ) {
        if (value === RESULT.UNKNOWN) {
            return;
        }

        const table =
            memo[letterId][nState];

        const packed =
            moveIndex >= 0
                ? (
                    value |
                    ((moveIndex + 1) << 2)
                )
                : value;

        if (!table.has(usedMask)) {
            memoStateCount += 1;
        }

        table.set(
            usedMask,
            packed
        );
    }

    function decodeMemoResult(
        packed
    ) {
        return packed & 3;
    }

    function decodeMemoMoveIndex(
        packed
    ) {
        return (
            packed >>> 2
        ) - 1;
    }

    function getDistance(
        letterId,
        usedMask,
        nState
    ) {
        const cached =
            distanceMemo[letterId][nState].get(
                usedMask
            );

        if (cached !== undefined) {
            return cached;
        }

        const packed =
            memoGet(
                letterId,
                nState,
                usedMask
            );

        if (packed === undefined) {
            return null;
        }

        const result =
            decodeMemoResult(
                packed
            );

        if (result === RESULT.UNKNOWN) {
            return null;
        }

        const legalMask =
            legalMoveMasks[nState][letterId] ??
            0n;

        const availableMask =
            legalMask &
            ~usedMask;

        /* 手がない局面は、その時点で終局。 */
        if (availableMask === 0n) {
            distanceMemo[letterId][nState].set(
                usedMask,
                0
            );

            return 0;
        }

        let bestDistance =
            result === RESULT.WIN
                ? Number.POSITIVE_INFINITY
                : -1;

        const moves =
            wordsByFirstLetterId[letterId] ??
            [];
                    for (const move of moves) {
            if (
                (availableMask & move.bit) ===
                0n
            ) {
                continue;
            }

            if (Date.now() >= deadline) {
                stoppedByLimit = true;
                stopReason = "deadline";
                return null;
            }

            const nextMask =
                usedMask |
                move.usageBit;

            const nextNState =
                nState === 0
                    ? move.nextNState0
                    : move.nextNState1;

            const childLegalMask =
                nState === 0
                    ? move.childLegalMask0
                    : move.childLegalMask1;

            let childResult;
            let childDistance = 0;

            if (childLegalMask === 0n) {
                childResult = RESULT.LOSE;
            } else {
                childResult =
                    solveOutcome(
                        move.lastLetterId,
                        nextMask,
                        nextNState
                    );

                if (childResult === RESULT.UNKNOWN) {
                    return null;
                }

                childDistance =
                    getDistance(
                        move.lastLetterId,
                        nextMask,
                        nextNState
                    );

                if (childDistance === null) {
                    return null;
                }
            }

            const totalDistance =
                1 + childDistance;

            if (result === RESULT.WIN) {
                /*
                 * 勝勢なら、相手を必敗にできる手のうち
                 * 最短で勝てるものを選ぶ。
                 */
                if (
                    childResult === RESULT.LOSE &&
                    totalDistance < bestDistance
                ) {
                    bestDistance =
                        totalDistance;
                }
            } else if (result === RESULT.LOSE) {
                /*
                 * 敗勢なら、相手の必勝を前提として
                 * 最も長く粘れる手を選ぶ。
                 */
                if (
                    childResult === RESULT.WIN &&
                    totalDistance > bestDistance
                ) {
                    bestDistance =
                        totalDistance;
                }
            }
        }

        if (
            !Number.isFinite(bestDistance) ||
            bestDistance < 0
        ) {
            return null;
        }

        distanceMemo[letterId][nState].set(
            usedMask,
            bestDistance
        );

        return bestDistance;
    }

    function findBestMove(
        letterId,
        usedMask,
        nState
    ) {
        const packed =
            memoGet(
                letterId,
                nState,
                usedMask
            );

        if (packed === undefined) {
            return null;
        }

        const result =
            decodeMemoResult(
                packed
            );

        if (result === RESULT.UNKNOWN) {
            return null;
        }

        const optimalDistance =
            getDistance(
                letterId,
                usedMask,
                nState
            );

        if (optimalDistance === null) {
            return null;
        }

        const legalMask =
            legalMoveMasks[nState][letterId] ??
            0n;

        const availableMask =
            legalMask &
            ~usedMask;

        if (availableMask === 0n) {
            return null;
        }

        const moves =
            wordsByFirstLetterId[letterId] ??
            [];

        let selectedMove = null;

        for (const move of moves) {
            if (
                (availableMask & move.bit) ===
                0n
            ) {
                continue;
            }

            const nextMask =
                usedMask |
                move.usageBit;

            const nextNState =
                nState === 0
                    ? move.nextNState0
                    : move.nextNState1;

            const childLegalMask =
                nState === 0
                    ? move.childLegalMask0
                    : move.childLegalMask1;

            let childResult;
            let childDistance = 0;

            if (childLegalMask === 0n) {
                childResult = RESULT.LOSE;
            } else {
                childResult =
                    solveOutcome(
                        move.lastLetterId,
                        nextMask,
                        nextNState
                    );

                if (childResult === RESULT.UNKNOWN) {
                    continue;
                }

                childDistance =
                    getDistance(
                        move.lastLetterId,
                        nextMask,
                        nextNState
                    );

                if (childDistance === null) {
                    continue;
                }
            }

            const totalDistance =
                1 + childDistance;

            if (totalDistance !== optimalDistance) {
                continue;
            }

            if (
                result === RESULT.WIN &&
                childResult !== RESULT.LOSE
            ) {
                continue;
            }

            if (
                result === RESULT.LOSE &&
                childResult !== RESULT.WIN
            ) {
                continue;
            }

            selectedMove = move;
            break;
        }

        return selectedMove;
    }

    function buildPrincipalVariation(
        letterId,
        usedMask,
        nState,
        limit
    ) {
        const line = [];

        let currentLetterId =
            letterId;

        let currentMask =
            usedMask;

        let currentNState =
            nState;

        for (
            let index = 0;
            index < limit;
            index += 1
        ) {
            const currentResult =
                memoGet(
                    currentLetterId,
                    currentNState,
                    currentMask
                );

            if (
                currentResult ===
                undefined
            ) {
                break;
            }

            const move =
                findBestMove(
                    currentLetterId,
                    currentMask,
                    currentNState
                );

            if (!move) {
                break;
            }

            line.push(
                toPublicMove(
                    move
                )
            );

            const nextMask =
                currentMask |
                move.usageBit;

            const nextNState =
                currentNState === 0
                    ? move.nextNState0
                    : move.nextNState1;

            const childLegalMask =
                currentNState === 0
                    ? move.childLegalMask0
                    : move.childLegalMask1;

            const childAvailable =
                childLegalMask ^
                (childLegalMask & nextMask);

            if (childAvailable === 0n) {
                break;
            }

            currentMask =
                nextMask;

            currentNState =
                nextNState;

            currentLetterId =
                move.lastLetterId;
        }

        return line;
    }

    function analyzeStart(
        startLetter,
        usedWords = [],
        nEndCount = 0
    ) {
        return analyzeInternal(
            startLetter,
            usedWords,
            nEndCount,
            true
        );
    }

    function analyzePosition({
        requiredLetter,
        currentLetter,
        usedWords = [],
        nEndCount = 0
    }) {
        return analyzeInternal(
            requiredLetter ??
            currentLetter ??
            "",
            usedWords,
            nEndCount,
            false
        );
    }

    function analyzeInternal(
        letterValue,
        usedWords,
        nEndCount,
        isInitial
    ) {
        startedAt =
            Date.now();

        deadline =
            startedAt +
            options.deadlineMilliseconds;

        stoppedByLimit =
            false;

        stopReason =
            "";

        const normalizedLetter =
            logic.normalizeCharacter(
                letterValue,
                settings
            );

        const letterId =
            letterIndex
                .letterToId
                .get(
                    normalizedLetter
                );

        if (letterId === undefined) {
            return {
                success:
                    true,

                exact:
                    true,

                outcome:
                    OUTCOME.LOSE,

                winning:
                    false,

                verdict:
                    isInitial
                        ? "後手必勝"
                        : "現在手番側の必敗",

                distance:
                    0,

                bestMove:
                    null,

                principalVariation:
                    [],

                proof: {
                    type:
                        "no-safe-move",

                    requiredLetter:
                        normalizedLetter,

                    reason:
                        `「${normalizedLetter}」で始まる安全な単語が存在しません。`
                },

                statistics:
                    getStatistics()
            };
        }

        const usedMask =
            createUsedMask(
                usedWords
            );

        const nState =
            normalizeNState(
                nEndCount,
                settings
            );

        const result =
            solveOutcome(
                letterId,
                usedMask,
                nState
            );

        /*
         * 勝敗が確定した後は、同じ締切を使い続けない。
         *
         * 勝敗探索で時間を使い切ってしまうと、
         * 「最短勝利手」や「最長抵抗手」を求める
         * 距離探索に入った瞬間にタイムアウトしてしまう。
         *
         * そこで、勝敗が確定している場合は、
         * 追加で deadlineMilliseconds / 2 を距離探索に与える。
         */
        if (result !== RESULT.UNKNOWN) {
            deadline =
                Date.now() +
                Math.max(
                    1000,
                    Math.floor(
                        options.deadlineMilliseconds / 2
                    )
                );
        }

        const optimalDistance =
            result === RESULT.UNKNOWN
                ? null
                : getDistance(
                    letterId,
                    usedMask,
                    nState
                );

        const bestMove =
            result === RESULT.UNKNOWN ||
            optimalDistance === null
                ? null
                : findBestMove(
                    letterId,
                    usedMask,
                    nState
                );

        const principalVariation =
            result === RESULT.UNKNOWN ||
            optimalDistance === null
                ? []
                : buildPrincipalVariation(
                    letterId,
                    usedMask,
                    nState,
                    options
                        .principalVariationLimit
                );

        return {
            success:
                true,

            exact:
                result !==
                RESULT.UNKNOWN,

            outcome:
                getOutcomeName(
                    result
                ),

            winning:
                result === RESULT.WIN
                    ? true
                    : (
                        result === RESULT.LOSE
                            ? false
                            : null
                    ),

            verdict:
                getVerdict(
                    result,
                    isInitial
                ),

            distance:
                optimalDistance,

            bestMove:
                toPublicMove(
                    bestMove
                ),

            principalVariation,

            proof:
                buildProof(
                    normalizedLetter,
                    letterId,
                    usedMask,
                    nState,
                    result,
                    bestMove
                ),

            terminalWinningWords:
                isInitial
                    ? getTerminalWinningWords()
                    : undefined,

            statistics:
                getStatistics()
        };
    }

    function buildProof(
        letter,
        letterId,
        usedMask,
        nState,
        result,
        bestMove
    ) {
        if (result === RESULT.UNKNOWN) {
            return {
                type:
                    "search-limit",

                reason:
                    "状態数または解析時間の上限に達しました。"
            };
        }

        const availableMask =
            (
                legalMoveMasks[nState][letterId] ??
                0n
            ) &
            ~usedMask;

        if (result === RESULT.LOSE) {
            if (availableMask === 0n) {
                return {
                    type:
                        "no-safe-move",

                    requiredLetter:
                        letter,

                    reason:
                        `「${letter}」で始まる安全な単語が存在しません。`
                };
            }

            return {
                type:
                    "all-moves-give-opponent-win",

                requiredLetter:
                    letter,

                reason:
                    `「${letter}」からのすべての安全手が、相手の必勝状態へ移ります。`
            };
        }

        const terminalAvailable =
            (
                terminalMasks[nState][letterId] ??
                0n
            ) &
            ~usedMask;

        if (
            bestMove &&
            (
                terminalAvailable &
                bestMove.bit
            ) !== 0n
        ) {
            return {
                type:
                    "terminal-word",

                requiredLetter:
                    letter,

                move:
                    toPublicMove(
                        bestMove
                    ),

                nextLetter:
                    bestMove.lastLetter,

                opponentReplies:
                    [],

                reason:
                    `「${bestMove.name}」は「${bestMove.lastLetter}」で終わり、` +
                    `単語リストに「${bestMove.lastLetter}」で始まる安全な単語が存在しないため、` +
                    "相手は続けられません。"
            };
        }

        return {
            type:
                "force-opponent-loss",

            requiredLetter:
                letter,

            move:
                toPublicMove(
                    bestMove
                ),

            reason:
                bestMove
                    ? (
                        `「${bestMove.name}」により、` +
                        "相手を必敗状態へ移します。"
                    )
                    : (
                        "相手を必敗状態へ移す手が存在します。"
                    )
        };
    }

    function createUsedMask(
        usedWords = []
    ) {
        let mask = 0n;

        for (const used of usedWords) {
            const reading =
                logic.normalizeReading(
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

            if (!reading) {
                continue;
            }

            if (
                settings.duplicateRule ===
                "once"
            ) {
                const representative =
                    wordByReading.get(
                        reading
                    );

                if (representative) {
                    mask |=
                        representative
                            .usageBit;
                }

                continue;
            }

            const type =
                typeof used === "object"
                    ? used?.type
                    : null;

            const entry =
                type
                    ? wordByReadingAndType.get(
                        createReadingTypeKey(
                            reading,
                            type
                        )
                    )
                    : wordByReading.get(
                        reading
                    );

            if (entry) {
                mask |=
                    entry.usageBit;
            }
        }

        return mask;
    }

    function getTerminalWinningWords() {
        const result = [];

        for (const entry of searchWords) {
            const initialTerminalMask =
                terminalMasks[0][
                    entry.firstLetterId
                ] ??
                0n;

            if (
                (
                    initialTerminalMask &
                    entry.bit
                ) !== 0n
            ) {
                result.push(
                    toPublicMove(
                        entry
                    )
                );
            }
        }

        return result;
    }

    function limitReachedFast() {
        if (
            visitedStates >=
            options.maxStates
        ) {
            stoppedByLimit =
                true;

            stopReason =
                "max-states";

            return true;
        }

        if (
            (
                visitedStates &
                (
                    options.timeCheckInterval -
                    1
                )
            ) === 0 &&
            Date.now() >= deadline
        ) {
            stoppedByLimit =
                true;

            stopReason =
                "deadline";

            return true;
        }

        return false;
    }

    /* =====================================================
       旧 solve() API 完全互換
    ===================================================== */

    function solveCompat(
        requiredLetter,
        usedMask = 0n,
        nEndCount = 0
    ) {
        /*
         * solveCompat() も毎回独立した解析として扱う。
         * 前回の解析で使い切った deadline を引き継がない。
         */
        startedAt =
            Date.now();

        deadline =
            startedAt +
            options.deadlineMilliseconds;

        stoppedByLimit =
            false;

        stopReason =
            "";

        /*
         * 旧API:
         *
         *   solver.solve("あ")
         *   solver.solve("あ", usedMask)
         *   solver.solve("あ", usedWords, 0)
         *
         * のすべてを受け付ける。
         */

        const normalizedLetter =
            logic.normalizeCharacter(
                requiredLetter,
                settings
            );

        const letterId =
            letterIndex
                .letterToId
                .get(
                    normalizedLetter
                );

        /*
         * 第2引数が使用済み単語配列でもOK。
         */
        let initialMask =
            usedMask;

        if (Array.isArray(usedMask)) {
            initialMask =
                createUsedMask(
                    usedMask
                );
        }

        /*
         * 不正な第2引数は空局面として扱う。
         */
        if (
            typeof initialMask !==
            "bigint"
        ) {
            initialMask =
                0n;
        }

        const normalizedNState =
            normalizeNState(
                nEndCount,
                settings
            );

        /*
         * 開始文字が存在しない。
         */
        if (
            letterId === undefined
        ) {
            return {
                outcome:
                    OUTCOME.LOSE,

                winning:
                    false,

                complete:
                    true,

                distance:
                    0,

                bestMove:
                    null,

                principalVariation:
                    [],

                proof: {
                    type:
                        "no-safe-move",

                    requiredLetter:
                        normalizedLetter,

                    reason:
                        `「${normalizedLetter}」で始まる安全な単語が存在しません。`
                }
            };
        }

        /*
         * 高速完全解析。
         */
        const result =
            solveOutcome(
                letterId,
                initialMask,
                normalizedNState
            );

        /*
         * 勝敗が確定したら、距離探索用の追加時間を確保する。
         *
         * 敗勢の場合もここで距離を求めることで、
         * 「どの手を選んでも負けるが、その中で最も長く
         * 粘れる手」を bestMove として返せる。
         */
        let optimalDistance =
            null;

        if (result !== RESULT.UNKNOWN) {
            /*
             * 勝敗探索と距離探索を分離する。
             *
             * 勝敗探索で deadline 直前まで使っていても、
             * 敗勢局面の「最長抵抗手」や勝勢局面の
             * 「最短勝利手」を求める時間を確保する。
             */
            deadline =
                Date.now() +
                Math.max(
                    1000,
                    Math.floor(
                        options.deadlineMilliseconds / 2
                    )
                );

            optimalDistance =
                getDistance(
                    letterId,
                    initialMask,
                    normalizedNState
                );
        }

        const bestMove =
            result === RESULT.UNKNOWN ||
            optimalDistance === null
                ? null
                : findBestMove(
                    letterId,
                    initialMask,
                    normalizedNState
                );

        /*
         * 最適進行を後から復元。
         */
        const principalVariation =
            result === RESULT.UNKNOWN ||
            optimalDistance === null
                ? []
                : buildPrincipalVariation(
                    letterId,
                    initialMask,
                    normalizedNState,
                    options
                        .principalVariationLimit
                );

        return {
            outcome:
                getOutcomeName(
                    result
                ),

            winning:
                result === RESULT.WIN
                    ? true
                    : (
                        result === RESULT.LOSE
                            ? false
                            : null
                    ),

            complete:
                result !== RESULT.UNKNOWN,

            distance:
                optimalDistance,

            bestMove:
                bestMove
                    ? toPublicMove(
                        bestMove
                    )
                    : null,

            principalVariation,

            proof:
                buildProof(
                    normalizedLetter,
                    letterId,
                    initialMask,
                    normalizedNState,
                    result,
                    bestMove
                )
        };
    }

    function getStatistics() {
        return {
            visitedStates,

            cachedStates:
                memoStateCount,

            cacheHits,

            terminalShortcutHits,

            childTerminalHits,

            stoppedByLimit,

            stopReason,

            elapsedMilliseconds:
                Date.now() -
                startedAt,

            maxStates:
                options.maxStates,

            deadlineMilliseconds:
                options.deadlineMilliseconds,

            timeCheckInterval:
                options.timeCheckInterval,

            sourceWordCount:
                rawWords.length,

            searchWordCount:
                searchWords.length,

            letterCount:
                letterIndex
                    .idToLetter
                    .length,

            duplicateWordsRemoved:
                rawWords.length -
                searchWords.length
        };
    }

    function clear() {
        for (const byLetter of memo) {
            byLetter[0].clear();
            byLetter[1].clear();
        }

        memoStateCount = 0;
        visitedStates = 0;
        cacheHits = 0;
        terminalShortcutHits = 0;
        childTerminalHits = 0;
        stoppedByLimit = false;
        stopReason = "";

        for (const table of killerMoves) {
            table.fill(-1);
        }

        for (const byLetter of distanceMemo) {
            byLetter[0].clear();
            byLetter[1].clear();
        }

        startedAt =
            Date.now();

        deadline =
            startedAt +
            options.deadlineMilliseconds;
    }

    return {
        analyzeStart,
        analyzePosition,

        /*
         * 旧API完全互換。
         *
         * solver.solve("あ")
         * solver.solve("あ", usedMask)
         * solver.solve("あ", usedWords, 0)
         */
        solve:
            solveCompat,

        /*
         * 高速内部API。
         *
         * 第1引数は文字ID。
         */
        solveOutcome,

        clear,
        getStatistics,
        getTerminalWinningWords,

        settings: {
            ...settings
        },

        options: {
            ...options
        },

        wordCount:
            rawWords.length,

        searchWordCount:
            searchWords.length
    };
}

function buildSearchWords(
    rawWords,
    settings
) {
    if (
        settings.duplicateRule !==
        "once"
    ) {
        return rawWords.map(
            entry => {
                return {
                    ...entry
                };
            }
        );
    }

    const representatives =
        new Map();

    for (const entry of rawWords) {
        const key =
            `${entry.reading}|` +
            `${entry.firstLetter}|` +
            `${entry.lastLetter}`;

        if (
            !representatives.has(key)
        ) {
            representatives.set(
                key,
                {
                    ...entry
                }
            );
        }
    }

    return [
        ...representatives.values()
    ];
}

function buildLetterIndex(words) {
    const letterToId =
        new Map();

    const idToLetter =
        [];

    function add(letter) {
        if (
            !letterToId.has(letter)
        ) {
            const id =
                idToLetter.length;

            letterToId.set(
                letter,
                id
            );

            idToLetter.push(
                letter
            );
        }
    }

    for (const entry of words) {
        add(entry.firstLetter);
        add(entry.lastLetter);
    }

    return {
        letterToId,
        idToLetter
    };
}

function buildWordsByFirstLetterId(
    words,
    letterCount
) {
    const result =
        Array.from(
            {
                length:
                    letterCount
            },
            () => {
                return [];
            }
        );

    for (const entry of words) {
        result[
            entry.firstLetterId
        ].push(entry);
    }

    return result;
}

function buildReadingMasks(words) {
    const result =
        new Map();

    for (const entry of words) {
        const current =
            result.get(
                entry.reading
            ) ??
            0n;

        result.set(
            entry.reading,
            current |
            entry.bit
        );
    }

    return result;
}

function buildLegalMoveMasks(
    words,
    letterCount,
    settings
) {
    const masks = [
        Array(
            letterCount
        ).fill(0n),

        Array(
            letterCount
        ).fill(0n)
    ];

    for (const entry of words) {
        if (
            isSafeForNState(
                entry,
                0,
                settings
            )
        ) {
            masks[0][
                entry.firstLetterId
            ] |=
                entry.bit;
        }

        if (
            isSafeForNState(
                entry,
                1,
                settings
            )
        ) {
            masks[1][
                entry.firstLetterId
            ] |=
                entry.bit;
        }
    }

    return masks;
}

function buildTerminalMasks(
    words,
    letterCount,
    legalMoveMasks,
    settings
) {
    const masks = [
        Array(
            letterCount
        ).fill(0n),

        Array(
            letterCount
        ).fill(0n)
    ];

    for (const entry of words) {
        for (
            let nState = 0;
            nState <= 1;
            nState += 1
        ) {
            if (
                !isSafeForNState(
                    entry,
                    nState,
                    settings
                )
            ) {
                continue;
            }

            const nextNState =
                nState === 0
                    ? entry.nextNState0
                    : entry.nextNState1;

            const replies =
                legalMoveMasks[
                    nextNState
                ][
                    entry.lastLetterId
                ] ??
                0n;

            if (replies === 0n) {
                masks[nState][
                    entry.firstLetterId
                ] |=
                    entry.bit;
            }
        }
    }

    return masks;
}

function prepareStaticOrder(
    words,
    wordsByFirstLetterId,
    legalMoveMasks,
    settings
) {
    for (const entry of words) {
        const nextNState =
            entry.nextNState0;

        const replyMask =
            legalMoveMasks[
                nextNState
            ][
                entry.lastLetterId
            ] ??
            0n;

        entry.staticReplyCount =
            bitCount(
                replyMask
            );

        entry.staticTerminalWin =
            entry.staticReplyCount ===
                0 &&
            isSafeForNState(
                entry,
                0,
                settings
            );
    }

    for (
        const entries
        of wordsByFirstLetterId
    ) {
        entries.sort((a, b) => {
            if (
                a.staticTerminalWin !==
                b.staticTerminalWin
            ) {
                return a.staticTerminalWin
                    ? -1
                    : 1;
            }

            if (
                a.staticReplyCount !==
                b.staticReplyCount
            ) {
                return (
                    a.staticReplyCount -
                    b.staticReplyCount
                );
            }

            return (
                a.sourceIndex -
                b.sourceIndex
            );
        });
    }
}

function isSafeForNState(
    entry,
    nState,
    settings
) {
    if (entry.lastLetter !== "ン") {
        return true;
    }

    if (settings.nRule === "lose") {
        return false;
    }

    if (
        settings.nRule === "once" &&
        nState === 1
    ) {
        return false;
    }

    return true;
}

function getNextNState(
    nState,
    lastLetter,
    settings
) {
    if (settings.nRule !== "once") {
        return 0;
    }

    return lastLetter === "ン"
        ? 1
        : nState;
}

function normalizeNState(
    value,
    settings
) {
    if (settings.nRule !== "once") {
        return 0;
    }

    return Number(value) >= 1
        ? 1
        : 0;
}

function firstEntryIndexFromMask(
    entries,
    mask
) {
    for (
        const entry
        of (
            entries ??
            []
        )
    ) {
        if (
            (
                mask &
                entry.bit
            ) !== 0n
        ) {
            return entry.searchIndex;
        }
    }

    return -1;
}

function firstEntryFromMask(
    entries,
    mask
) {
    const index =
        firstEntryIndexFromMask(
            entries,
            mask
        );

    if (index < 0) {
        return null;
    }

    for (
        const entry
        of (
            entries ??
            []
        )
    ) {
        if (entry.searchIndex === index) {
            return entry;
        }
    }

    return null;
}

function bitCount(value) {
    let count = 0;
    let current = value;

    while (current !== 0n) {
        current &=
            current -
            1n;

        count += 1;
    }

    return count;
}

function toPublicMove(entry) {
    if (!entry) {
        return null;
    }

    return {
        id:
            entry.id,

        word:
            entry.name,

        name:
            entry.name,

        reading:
            entry.reading,

        type:
            entry.type,

        firstLetter:
            entry.firstLetter,

        nextLetter:
            entry.lastLetter
    };
}

function getOutcomeName(result) {
    if (result === RESULT.WIN) {
        return OUTCOME.WIN;
    }

    if (result === RESULT.LOSE) {
        return OUTCOME.LOSE;
    }

    return OUTCOME.UNKNOWN;
}

function getVerdict(
    result,
    isInitial
) {
    if (result === RESULT.WIN) {
        return isInitial
            ? "先手必勝"
            : "現在手番側の必勝";
    }

    if (result === RESULT.LOSE) {
        return isInitial
            ? "後手必勝"
            : "現在手番側の必敗";
    }

    return "未確定（探索上限到達）";
}

function createReadingTypeKey(
    reading,
    type
) {
    return (
        `${reading}|` +
        `${type ?? ""}`
    );
}

function positiveInt(
    value,
    fallback
) {
    const number =
        Number(value);

    if (
        Number.isFinite(number) &&
        number > 0
    ) {
        return Math.floor(
            number
        );
    }

    return fallback;
}

function powerOfTwo(
    value,
    fallback
) {
    const wanted =
        positiveInt(
            value,
            fallback
        );

    let result = 1;

    while (result < wanted) {
        result *= 2;
    }

    return result;
}

module.exports = {
    createExactSolver,
    RESULT,
    OUTCOME,
    normalizeSettings
};