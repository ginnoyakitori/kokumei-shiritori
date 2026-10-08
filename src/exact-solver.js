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

/*
 * exact-solver
 *
 * 重要な点:
 *
 * 1. 通常ルールでは「最後の文字」を次局面の要求文字にする。
 * 2. special / 2 ルールではゲーム本体と同じく、着手した単語の
 *    読みを右から左へ調べ、実際に安全に続けられる文字を探す。
 * 3. 使用済み単語しかない文字は「続けられる文字」にはしない。
 * 4. 直後に即負けになる単語は合法手として残すが、その手を選んだ
 *    側の敗北として minimax に入れる。
 *
 * これにより、例えば
 *   ダイカンミンコク → クックショトウ → ウガンダ
 * の局面で、ウガンダの「ダ」をそのまま次文字にせず、
 * ダ候補が使用済みなら右から次の「ガ」へ進める。
 */

function createExactSolver(rawSettings = {}, rawOptions = {}) {
    const settings = normalizeSettings(rawSettings);

    const options = {
        maxStates: positiveInt(
            rawOptions.maxStates,
            settings.wordList === "countries"
                ? 5000000
                : 1000000
        ),

        deadlineMilliseconds: positiveInt(
            rawOptions.deadlineMilliseconds,
            settings.wordList === "countries"
                ? 60000
                : 20000
        ),

        principalVariationLimit: positiveInt(
            rawOptions.principalVariationLimit,
            100
        ),

        timeCheckInterval: powerOfTwo(
            rawOptions.timeCheckInterval,
            1024
        )
    };

    let startedAt = Date.now();

    let deadline =
        startedAt +
        options.deadlineMilliseconds;

    let stoppedByLimit = false;
    let stopReason = "";

    let visitedStates = 0;
    let cacheHits = 0;
    let memoStateCount = 0;

    const sourceWords =
        logic.getWords(settings) || [];

    const rawWords =
        sourceWords.map(
            (source, sourceIndex) => {
                const reading =
                    logic.normalizeReading(
                        source.reading ??
                        source.name,
                        settings
                    );

                const firstLetter =
                    logic.getFirstLetter(
                        source,
                        settings
                    );

                const lastLetter =
                    logic.getLastLetter(
                        source,
                        settings
                    );

                return {
                    ...source,

                    sourceIndex,

                    reading,

                    firstLetter,

                    lastLetter,

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

                    usedKey:
                        makeUsedKey(
                            source,
                            reading
                        ),

                    endsWithN:
                        endsWithN(
                            source,
                            reading,
                            settings
                        ),

                    immediateLossStatic:
                        false
                };
            }
        );

    /*
     * duplicateRule=once の場合、
     * 同じ読みは一度しか使えない。
     */
    const readingGroups =
        new Map();

    for (const entry of rawWords) {
        const list =
            readingGroups.get(
                entry.reading
            ) || [];

        list.push(entry);

        readingGroups.set(
            entry.reading,
            list
        );
    }

    /*
     * duplicateRule=once では同じ読みの語を
     * 1代表にまとめる。
     *
     * それ以外では個別単語として扱う。
     */
    const searchWords =
        buildSearchWords(
            rawWords,
            settings
        );

    const letterIndex =
        buildLetterIndex(
            searchWords
        );

    const wordsByFirstLetterId =
        Array.from(
            {
                length:
                    letterIndex
                        .idToLetter
                        .length
            },
            () => []
        );

    for (
        let i = 0;
        i < searchWords.length;
        i += 1
    ) {
        const entry =
            searchWords[i];

        entry.searchIndex =
            i;

        entry.bit =
            1n <<
            BigInt(i);

        entry.usageBit =
            entry.bit;

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

        if (
            entry.firstLetterId !==
            undefined
        ) {
            wordsByFirstLetterId[
                entry.firstLetterId
            ].push(entry);
        }
    }

    /*
     * 同じ読みを一括使用禁止にするための usageBit。
     */
    if (
        settings.duplicateRule ===
        "once"
    ) {
        const byReadingMask =
            new Map();

        for (
            const entry
            of searchWords
        ) {
            byReadingMask.set(
                entry.reading,

                (
                    byReadingMask.get(
                        entry.reading
                    ) ||
                    0n
                ) |
                entry.bit
            );
        }

        for (
            const entry
            of searchWords
        ) {
            entry.usageBit =
                byReadingMask.get(
                    entry.reading
                ) ||
                entry.bit;
        }
    }

    for (
        const entries
        of wordsByFirstLetterId
    ) {
        entries.sort(
            (a, b) =>
                a.sourceIndex -
                b.sourceIndex
        );
    }

    /*
     * special rule が読み中間文字を要求できるため、
     * 全読み文字を登録する。
     */
    for (
        const entry
        of searchWords
    ) {
        for (
            const ch
            of Array.from(
                entry.reading
                || ""
            )
        ) {
            if (
                !letterIndex
                    .letterToId
                    .has(ch)
            ) {
                const id =
                    letterIndex
                        .idToLetter
                        .length;

                letterIndex
                    .letterToId
                    .set(
                        ch,
                        id
                    );

                letterIndex
                    .idToLetter
                    .push(ch);

                wordsByFirstLetterId[
                    id
                ] = [];
            }
        }
    }

    /*
     * 読み中間文字を追加したので
     * firstLetterId / lastLetterId を再確認。
     */
    for (
        const entry
        of searchWords
    ) {
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

        if (
            entry.firstLetterId !==
                undefined &&
            !wordsByFirstLetterId[
                entry.firstLetterId
            ].includes(entry)
        ) {
            wordsByFirstLetterId[
                entry.firstLetterId
            ].push(entry);
        }
    }

    const memo =
        new Map();

    const distanceMemo =
        new Map();

    const bestMoveMemo =
        new Map();

    function resetBudget() {
        startedAt =
            Date.now();

        deadline =
            startedAt +
            options.deadlineMilliseconds;

        stoppedByLimit =
            false;

        stopReason =
            "";

        visitedStates =
            0;

        cacheHits =
            0;
    }

    function limitReached() {
        if (
            visitedStates >=
            options.maxStates
        ) {
            stoppedByLimit =
                true;

            stopReason =
                "maxStates";

            return true;
        }

        if (
            Date.now() >=
            deadline
        ) {
            stoppedByLimit =
                true;

            stopReason =
                "deadline";

            return true;
        }

        return false;
    }

    function stateKey(
        letterId,
        usedMask,
        nEndCount
    ) {
        return (
            `${letterId}|` +
            `${nEndCount}|` +
            `${usedMask.toString(16)}`
        );
    }

    function isUsed(
        entry,
        usedMask
    ) {
        return (
            (
                entry.usageBit &
                usedMask
            ) !== 0n
        );
    }
        function isImmediateLoss(
        entry,
        usedMask,
        nEndCount
    ) {
        if (
            isUsed(
                entry,
                usedMask
            )
        ) {
            return true;
        }

        /*
         * ゲーム本体と同じ n ルールを優先。
         */
        if (
            settings.nRule ===
                "lose" &&
            entry.endsWithN
        ) {
            return true;
        }

        if (
            settings.nRule ===
                "once" &&
            entry.endsWithN &&
            nEndCount >= 1
        ) {
            return true;
        }

        return false;
    }

    /*
     * 「安全に続けられる語」だけを返す。
     *
     * 特殊ルールの次文字決定で使用する。
     */
    function safeEntriesForLetter(
        letter,
        usedMask,
        nEndCount
    ) {
        const id =
            letterIndex
                .letterToId
                .get(letter);

        if (
            id === undefined
        ) {
            return [];
        }

        const result = [];

        for (
            const entry
            of (
                wordsByFirstLetterId[
                    id
                ] || []
            )
        ) {
            if (
                isUsed(
                    entry,
                    usedMask
                )
            ) {
                continue;
            }

            if (
                isImmediateLoss(
                    entry,
                    usedMask,
                    nEndCount
                )
            ) {
                continue;
            }

            result.push(entry);
        }

        return result;
    }

    /*
     * ゲーム本体の findSpecialNextLetter と
     * 同じ考え方。
     *
     * 着手語の読みを右から左へ見て、
     * 実際に安全な続きが存在する
     * 最も右側の文字を返す。
     */
    function findSpecialNextLetter(
        entry,
        usedMask,
        nEndCount
    ) {
        const chars =
            Array.from(
                entry.reading || ""
            );

        for (
            let i =
                chars.length - 1;
            i >= 0;
            i -= 1
        ) {
            const ch =
                chars[i];

            if (
                safeEntriesForLetter(
                    ch,
                    usedMask,
                    nEndCount
                ).length > 0
            ) {
                return ch;
            }
        }

        return null;
    }

    function getChildState(
        entry,
        usedMask,
        nEndCount
    ) {
        const nextUsedMask =
            usedMask |
            entry.usageBit;

        const nextNEndCount =
            nEndCount +
            (
                entry.endsWithN
                    ? 1
                    : 0
            );

        /*
         * 特殊ルール:
         *
         * 単純に lastLetter を見るのではなく、
         * 読みを右から左に走査して
         * 「安全に続けられる文字」を探す。
         */
        if (
            settings.rule ===
                "special" ||
            settings.rule ===
                "2"
        ) {
            const nextLetter =
                findSpecialNextLetter(
                    entry,
                    nextUsedMask,
                    nextNEndCount
                );

            /*
             * 安全な次文字が存在しない。
             *
             * これは相手に安全な着手がないということなので、
             * 今この語を指した側の勝利。
             */
            if (
                nextLetter ===
                null
            ) {
                return {
                    terminal: true,

                    usedMask:
                        nextUsedMask,

                    nEndCount:
                        nextNEndCount,

                    letterId:
                        -1,

                    nextLetter:
                        null
                };
            }

            return {
                terminal: false,

                usedMask:
                    nextUsedMask,

                nEndCount:
                    nextNEndCount,

                letterId:
                    letterIndex
                        .letterToId
                        .get(
                            nextLetter
                        ),

                nextLetter
            };
        }

        /*
         * 通常ルール。
         */
        const nextLetter =
            entry.lastLetter;

        const letterId =
            letterIndex
                .letterToId
                .get(
                    nextLetter
                );

        if (
            letterId ===
            undefined
        ) {
            return {
                terminal: true,

                usedMask:
                    nextUsedMask,

                nEndCount:
                    nextNEndCount,

                letterId:
                    -1,

                nextLetter:
                    null
            };
        }

        return {
            terminal: false,

            usedMask:
                nextUsedMask,

            nEndCount:
                nextNEndCount,

            letterId,

            nextLetter
        };
    }

    function legalEntries(
        letterId,
        usedMask
    ) {
        return (
            wordsByFirstLetterId[
                letterId
            ] || []
        ).filter(
            entry =>
                !isUsed(
                    entry,
                    usedMask
                )
        );
    }

    function solveOutcome(
        letterId,
        usedMask = 0n,
        nEndCount = 0
    ) {
        const key =
            stateKey(
                letterId,
                usedMask,
                nEndCount
            );

        const cached =
            memo.get(key);

        if (
            cached !==
            undefined
        ) {
            cacheHits += 1;

            return cached;
        }

        if (
            limitReached()
        ) {
            return RESULT.UNKNOWN;
        }

        visitedStates += 1;

        const moves =
            legalEntries(
                letterId,
                usedMask
            );

        /*
         * 指せる単語が存在しない。
         *
         * 現在手番側の負け。
         */
        if (
            moves.length ===
            0
        ) {
            memo.set(
                key,
                RESULT.LOSE
            );

            memoStateCount =
                memo.size;

            return RESULT.LOSE;
        }

        let hasUnknown =
            false;

        for (
            const move
            of moves
        ) {
            if (
                limitReached()
            ) {
                return RESULT.UNKNOWN;
            }

            /*
             * 即負け手は合法手として存在するが、
             * その手を選んだ側の敗北。
             *
             * よって相手にとっては勝ち手であり、
             * 現在側の勝ち判定には使えない。
             */
            if (
                isImmediateLoss(
                    move,
                    usedMask,
                    nEndCount
                )
            ) {
                continue;
            }

            const child =
                getChildState(
                    move,
                    usedMask,
                    nEndCount
                );

            /*
             * 次文字が見つからない
             *
             * = 今指した側の即時勝利。
             */
            if (
                child.terminal
            ) {
                memo.set(
                    key,
                    RESULT.WIN
                );

                bestMoveMemo.set(
                    key,
                    move.searchIndex
                );

                memoStateCount =
                    memo.size;

                return RESULT.WIN;
            }

            const childResult =
                solveOutcome(
                    child.letterId,
                    child.usedMask,
                    child.nEndCount
                );

            /*
             * 相手側がLOSEなら、
             * 現在側はこの手でWIN。
             */
            if (
                childResult ===
                RESULT.LOSE
            ) {
                memo.set(
                    key,
                    RESULT.WIN
                );

                bestMoveMemo.set(
                    key,
                    move.searchIndex
                );

                memoStateCount =
                    memo.size;

                return RESULT.WIN;
            }

            if (
                childResult ===
                RESULT.UNKNOWN
            ) {
                hasUnknown =
                    true;
            }
        }

        /*
         * 未確定の子が残っている場合、
         * exactな勝敗はまだ保証できない。
         */
        if (
            hasUnknown
        ) {
            return RESULT.UNKNOWN;
        }

        /*
         * 安全な手が全部相手の勝ちにつながるなら
         * 現在手番は負け。
         *
         * 即負け手しかない場合もここ。
         */
        memo.set(
            key,
            RESULT.LOSE
        );

        memoStateCount =
            memo.size;

        return RESULT.LOSE;
    }

    function getDistance(
        letterId,
        usedMask,
        nEndCount
    ) {
        const key =
            stateKey(
                letterId,
                usedMask,
                nEndCount
            );

        if (
            distanceMemo.has(key)
        ) {
            return distanceMemo.get(
                key
            );
        }

        const outcome =
            solveOutcome(
                letterId,
                usedMask,
                nEndCount
            );

        if (
            outcome ===
            RESULT.UNKNOWN
        ) {
            return null;
        }

        const moves =
            legalEntries(
                letterId,
                usedMask
            );

        if (
            moves.length ===
            0
        ) {
            distanceMemo.set(
                key,
                0
            );

            return 0;
        }

        let best =
            outcome === RESULT.WIN
                ? Number.POSITIVE_INFINITY
                : -1;

        let unknown =
            false;

        for (
            const move
            of moves
        ) {
            if (
                limitReached()
            ) {
                return null;
            }

            /*
             * 即負け手は
             * 勝ち側の最適手にはならない。
             */
            if (
                isImmediateLoss(
                    move,
                    usedMask,
                    nEndCount
                )
            ) {
                continue;
            }

            const child =
                getChildState(
                    move,
                    usedMask,
                    nEndCount
                );

            const childResult =
                child.terminal
                    ? RESULT.LOSE
                    : solveOutcome(
                        child.letterId,
                        child.usedMask,
                        child.nEndCount
                    );

            if (
                childResult ===
                RESULT.UNKNOWN
            ) {
                unknown = true;
                continue;
            }

            const compatible =
                outcome === RESULT.WIN
                    ? childResult ===
                        RESULT.LOSE
                    : childResult ===
                        RESULT.WIN;

            if (
                !compatible
            ) {
                continue;
            }

            const childDistance =
                child.terminal
                    ? 0
                    : getDistance(
                        child.letterId,
                        child.usedMask,
                        child.nEndCount
                    );

            if (
                childDistance ===
                null
            ) {
                unknown = true;
                continue;
            }

            const total =
                childDistance +
                1;

            if (
                outcome === RESULT.WIN
            ) {
                best =
                    Math.min(
                        best,
                        total
                    );

                /*
                 * 1手勝利は最短なので
                 * これ以上調べる必要がない。
                 */
                if (
                    best === 1
                ) {
                    break;
                }
            } else {
                best =
                    Math.max(
                        best,
                        total
                    );
            }
        }

        if (
            unknown
        ) {
            return null;
        }

        if (
            !Number.isFinite(best) &&
            outcome === RESULT.WIN
        ) {
            return null;
        }

        if (
            best < 0 &&
            outcome === RESULT.LOSE
        ) {
            return null;
        }

        distanceMemo.set(
            key,
            best
        );

        return best;
    }
        function findBestMove(
        letterId,
        usedMask,
        nEndCount
    ) {
        const key =
            stateKey(
                letterId,
                usedMask,
                nEndCount
            );

        const outcome =
            memo.get(key);

        if (
            outcome ===
                undefined ||
            outcome ===
                RESULT.UNKNOWN
        ) {
            return null;
        }

        const moves =
            legalEntries(
                letterId,
                usedMask
            );

        let fallback =
            null;

        let best =
            null;

        let bestDistance =
            outcome === RESULT.WIN
                ? Number.POSITIVE_INFINITY
                : -1;

        for (
            const move
            of moves
        ) {
            /*
             * 即負け手。
             *
             * 現在側が勝つ局面では当然選ばない。
             */
            if (
                isImmediateLoss(
                    move,
                    usedMask,
                    nEndCount
                )
            ) {
                continue;
            }

            const child =
                getChildState(
                    move,
                    usedMask,
                    nEndCount
                );

            const childResult =
                child.terminal
                    ? RESULT.LOSE
                    : solveOutcome(
                        child.letterId,
                        child.usedMask,
                        child.nEndCount
                    );

            const compatible =
                outcome === RESULT.WIN
                    ? childResult ===
                        RESULT.LOSE
                    : childResult ===
                        RESULT.WIN;

            if (
                !compatible
            ) {
                continue;
            }

            /*
             * 時間切れなどで距離が取れなくても、
             * 勝敗を維持する手はフォールバックとして保持。
             */
            if (
                !fallback
            ) {
                fallback =
                    move;
            }

            /*
             * special rule で
             *
             * ウガンダ
             *   ↓
             * 安全な次文字なし
             *
             * となった場合など。
             */
            if (
                child.terminal &&
                outcome === RESULT.WIN
            ) {
                return move;
            }

            const childDistance =
                child.terminal
                    ? 0
                    : getDistance(
                        child.letterId,
                        child.usedMask,
                        child.nEndCount
                    );

            if (
                childDistance ===
                null
            ) {
                continue;
            }

            const total =
                childDistance +
                1;

            if (
                (
                    outcome ===
                        RESULT.WIN &&
                    total <
                        bestDistance
                ) ||
                (
                    outcome ===
                        RESULT.LOSE &&
                    total >
                        bestDistance
                )
            ) {
                bestDistance =
                    total;

                best =
                    move;
            }
        }

        return (
            best ||
            fallback
        );
    }

    function buildPrincipalVariation(
        letterId,
        usedMask,
        nEndCount,
        limit =
            options.principalVariationLimit
    ) {
        const result = [];

        let currentLetterId =
            letterId;

        let currentUsedMask =
            usedMask;

        let currentNEndCount =
            nEndCount;

        for (
            let i = 0;
            i < limit;
            i += 1
        ) {
            const move =
                findBestMove(
                    currentLetterId,
                    currentUsedMask,
                    currentNEndCount
                );

            if (
                !move
            ) {
                break;
            }

            const before =
                solveOutcome(
                    currentLetterId,
                    currentUsedMask,
                    currentNEndCount
                );

            const child =
                getChildState(
                    move,
                    currentUsedMask,
                    currentNEndCount
                );

            result.push({
                word:
                    move.name,

                name:
                    move.name,

                reading:
                    move.reading,

                firstLetter:
                    move.firstLetter,

                lastLetter:
                    move.lastLetter,

                /*
                 * special rule の場合、
                 * ここが実際にゲームで表示される
                 * 「次の文字」に対応する。
                 */
                nextLetter:
                    child.nextLetter,

                outcome:
                    getOutcomeName(
                        before
                    )
            });

            if (
                child.terminal
            ) {
                break;
            }

            currentLetterId =
                child.letterId;

            currentUsedMask =
                child.usedMask;

            currentNEndCount =
                child.nEndCount;
        }

        return result;
    }

    function analyzePosition(
        arg1,
        arg2 = [],
        arg3 = 0
    ) {
        resetBudget();

        let requiredLetter;
        let usedWords;
        let nEndCount;

        let maxMoves =
            options
                .principalVariationLimit;

        /*
         * analyzer.js の現在の呼び出し:
         *
         * solver.analyzePosition({
         *     requiredLetter,
         *     usedWords,
         *     nEndCount
         * })
         *
         * に対応。
         *
         * 旧形式:
         *
         * solver.analyzePosition(
         *     "カ",
         *     usedWords,
         *     0
         * )
         *
         * にも対応。
         */
        if (
            arg1 &&
            typeof arg1 ===
                "object" &&
            !Array.isArray(arg1)
        ) {
            requiredLetter =
                arg1.requiredLetter ??
                arg1.currentLetter;

            usedWords =
                arg1.usedWords ??
                [];

            nEndCount =
                Number(
                    arg1.nEndCount ??
                    0
                );

            maxMoves =
                positiveInt(
                    arg1.maxMoves,
                    maxMoves
                );
        } else {
            requiredLetter =
                arg1;

            usedWords =
                arg2 ?? [];

            nEndCount =
                Number(
                    arg3 ?? 0
                );
        }

        const normalizedRequired =
            normalizeLetter(
                requiredLetter,
                settings
            );

        const letterId =
            letterIndex
                .letterToId
                .get(
                    normalizedRequired
                );

        if (
            letterId ===
            undefined
        ) {
            return unknownAnalysis(
                "unknown-letter"
            );
        }

        const usedMask =
            buildUsedMask(
                usedWords
            );

        const normalizedN =
            normalizeNEndCount(
                nEndCount
            );

        const outcome =
            solveOutcome(
                letterId,
                usedMask,
                normalizedN
            );

        if (
            outcome ===
            RESULT.UNKNOWN
        ) {
            return unknownAnalysis(
                stopReason ||
                "search-limit"
            );
        }

        const distance =
            getDistance(
                letterId,
                usedMask,
                normalizedN
            );

        const bestMove =
            findBestMove(
                letterId,
                usedMask,
                normalizedN
            );

        return {
            exact: true,

            winning:
                outcome ===
                RESULT.WIN,

            outcome:
                getOutcomeName(
                    outcome
                ),

            distance,

            bestMove:
                toPublicMove(
                    bestMove
                ),

            principalVariation:
                buildPrincipalVariation(
                    letterId,
                    usedMask,
                    normalizedN,
                    maxMoves
                ),

            statistics:
                getStatistics(),

            limited:
                false
        };
    }

    function analyzeStart(
        letter,
        usedWords = [],
        nEndCount = 0
    ) {
        return analyzePosition({
            requiredLetter:
                letter,

            usedWords,

            nEndCount,

            maxMoves:
                options
                    .principalVariationLimit
        });
    }

    function solveCompat(
        letter,
        usedWords = [],
        nEndCount = 0
    ) {
        /*
         * BigInt mask を直接渡す旧API。
         */
        if (
            typeof usedWords ===
            "bigint"
        ) {
            const normalized =
                normalizeLetter(
                    letter,
                    settings
                );

            const letterId =
                letterIndex
                    .letterToId
                    .get(
                        normalized
                    );

            if (
                letterId ===
                undefined
            ) {
                return RESULT.UNKNOWN;
            }

            resetBudget();

            return solveOutcome(
                letterId,
                usedWords,
                Number(
                    nEndCount
                ) || 0
            );
        }

        const analysis =
            analyzePosition(
                letter,
                usedWords,
                nEndCount
            );

        return (
            analysis.outcome ===
            OUTCOME.WIN
        )
            ? RESULT.WIN
            : (
                analysis.outcome ===
                OUTCOME.LOSE
            )
                ? RESULT.LOSE
                : RESULT.UNKNOWN;
    }

    function buildUsedMask(
        usedWords
    ) {
        if (
            typeof usedWords ===
            "bigint"
        ) {
            return usedWords;
        }

        if (
            !Array.isArray(
                usedWords
            )
        ) {
            return 0n;
        }

        let mask =
            0n;

        for (
            const used
            of usedWords
        ) {
            const reading =
                normalizeReadingValue(
                    used?.reading ??
                    used?.word ??
                    used?.name ??
                    used,
                    settings
                );

            /*
             * duplicateRule=once:
             * 同じ読みを持つ語をまとめて使用済みにする。
             */
            if (
                settings
                    .duplicateRule ===
                "once"
            ) {
                for (
                    const entry
                    of searchWords
                ) {
                    if (
                        entry.reading ===
                        reading
                    ) {
                        mask |=
                            entry.usageBit;
                    }
                }

                continue;
            }

            /*
             * duplicateRule=once 以外では
             * 実際に使われた単語を特定する。
             */
            const name =
                String(
                    used?.name ??
                    used?.word ??
                    used ??
                    ""
                );

            const id =
                used?.id;

            const type =
                used?.type ??
                "";

            for (
                const entry
                of searchWords
            ) {
                const sameId =
                    id !==
                        undefined &&
                    entry.id !==
                        undefined &&
                    String(
                        entry.id
                    ) ===
                    String(id);

                const sameName =
                    String(
                        entry.name ??
                        entry.word ??
                        ""
                    ) ===
                    name;

                const sameType =
                    String(
                        entry.type ??
                        ""
                    ) ===
                    String(type);

                if (
                    entry.reading ===
                        reading &&
                    (
                        sameId ||
                        (
                            sameName &&
                            (
                                !type ||
                                sameType
                            )
                        )
                    )
                ) {
                    mask |=
                        entry.usageBit;
                }
            }
        }

        return mask;
    }

    function getTerminalWinningWords(
        letter,
        usedWords = [],
        nEndCount = 0
    ) {
        const normalized =
            normalizeLetter(
                letter,
                settings
            );

        const letterId =
            letterIndex
                .letterToId
                .get(
                    normalized
                );

        if (
            letterId ===
            undefined
        ) {
            return [];
        }

        const usedMask =
            buildUsedMask(
                usedWords
            );

        const result = [];

        for (
            const move
            of legalEntries(
                letterId,
                usedMask
            )
        ) {
            if (
                isImmediateLoss(
                    move,
                    usedMask,
                    nEndCount
                )
            ) {
                continue;
            }

            const child =
                getChildState(
                    move,
                    usedMask,
                    nEndCount
                );

            if (
                child.terminal
            ) {
                result.push(
                    toPublicMove(
                        move
                    )
                );
            }
        }

        return result;
    }

    function getStatistics() {
        return {
            visitedStates,
            memoStates:
                memo.size,
            cacheHits,
            elapsedMs:
                Date.now() -
                startedAt,
            stoppedByLimit,
            stopReason
        };
    }

    function clear() {
        memo.clear();

        distanceMemo.clear();

        bestMoveMemo.clear();

        memoStateCount =
            0;

        resetBudget();
    }

    function unknownAnalysis(
        reason
    ) {
        return {
            exact: false,

            winning: null,

            outcome:
                OUTCOME.UNKNOWN,

            distance: null,

            bestMove: null,

            principalVariation:
                [],

            statistics: {
                ...getStatistics(),

                stopReason:
                    reason
            },

            limited: true
        };
    }

    return {
        analyzeStart,

        analyzePosition,

        solve:
            solveCompat,

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
            entry => ({
                ...entry
            })
        );
    }

    const representatives =
        new Map();

    for (
        const entry
        of rawWords
    ) {
        /*
         * duplicateRule=once では
         * 読みそのものを1単位とする。
         */
        const key =
            entry.reading;

        if (
            !representatives.has(
                key
            )
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

function buildLetterIndex(
    words
) {
    const letterToId =
        new Map();

    const idToLetter =
        [];

    function add(
        letter
    ) {
        if (
            letter ===
                undefined ||
            letter ===
                null ||
            letter ===
                ""
        ) {
            return;
        }

        if (
            !letterToId.has(
                letter
            )
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

    for (
        const entry
        of words
    ) {
        add(
            entry.firstLetter
        );

        add(
            entry.lastLetter
        );

        /*
         * special rule では読みの途中の文字も
         * 次文字候補になる。
         */
        for (
            const ch
            of Array.from(
                entry.reading ||
                ""
            )
        ) {
            add(ch);
        }
    }

    return {
        letterToId,
        idToLetter
    };
}

function normalizeLetter(
    value,
    settings
) {
    const raw =
        String(
            value ??
            ""
        );

    /*
     * logic.js 側に normalizeKana があれば
     * ゲーム本体と同じ正規化を使う。
     */
    if (
        typeof logic.normalizeKana ===
        "function"
    ) {
        try {
            return logic.normalizeKana(
                raw,
                settings
            );
        } catch (_) {
            /*
             * フォールバック。
             */
        }
    }

    return raw;
}

function normalizeReadingValue(
    value,
    settings
) {
    const raw =
        String(
            value ??
            ""
        );

    if (
        typeof logic.normalizeReading ===
        "function"
    ) {
        return logic.normalizeReading(
            raw,
            settings
        );
    }

    return raw;
}

function endsWithN(
    source,
    reading,
    settings
) {
    /*
     * ゲーム本体の endsWithN を優先。
     */
    if (
        typeof logic.endsWithN ===
        "function"
    ) {
        try {
            return !!logic.endsWithN(
                source,
                settings
            );
        } catch (_) {
            /*
             * フォールバック。
             */
        }
    }

    return String(
        reading
    ).endsWith("ン");
}

function makeUsedKey(
    source,
    reading
) {
    return (
        `${String(
            source?.id ??
            ""
        )}|` +

        `${String(
            source?.name ??
            source?.word ??
            ""
        )}|` +

        `${String(
            source?.type ??
            ""
        )}|` +

        `${reading}`
    );
}

function toPublicMove(
    entry
) {
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

function getOutcomeName(
    result
) {
    if (
        result ===
        RESULT.WIN
    ) {
        return OUTCOME.WIN;
    }

    if (
        result ===
        RESULT.LOSE
    ) {
        return OUTCOME.LOSE;
    }

    return OUTCOME.UNKNOWN;
}

function normalizeNEndCount(
    value
) {
    const n =
        Number(value);

    return (
        Number.isFinite(n) &&
        n > 0
    )
        ? 1
        : 0;
}

function positiveInt(
    value,
    fallback
) {
    const n =
        Number(value);

    return (
        Number.isFinite(n) &&
        n > 0
    )
        ? Math.floor(n)
        : fallback;
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

    let result =
        1;

    while (
        result <
        wanted
    ) {
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