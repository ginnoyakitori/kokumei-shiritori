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
 * exact-solver(高速版)
 *
 * 探索の考え方:
 *
 * 1. 単語は「読み」ごとにまとめる。
 *    ゲーム本体は読みごとに使用回数を数えるため、同じ読みは1グループ。
 *    使える回数は logic.getSafeUseLimit と同じ
 *    (通常1回、duplicateRule=separate かつ国名・首都名の両方にある読みは2回)。
 *
 * 2. 通常ルールでは「最初の文字・最後の文字・「ン」で終わるか・使用可能回数」
 *    が同じ単語は区別する必要がない。これを1つのクラスにまとめ、
 *    状態は「クラスごとの使用数」だけで表す。
 *    同じ形の単語を別々に試さないので、状態数が大きく減る。
 *
 * 3. 状態は Zobrist ハッシュ(32bit x 2 = 64bit)で表し、
 *    TypedArray の開番地ハッシュ表にメモする。
 *    文字列や BigInt を作らないので速く、メモリも小さい。
 *
 * 4. 着手の順番は「相手の返せる語が少なくなる手」から。
 *    勝ち手が早く見つかり、枝刈りが効く。
 *
 * 5. 時間は timeCheckInterval ノードごとにだけ確認する。
 *
 * 勝敗のルール(従来と同じ):
 *   - 続ける単語が1つもなければ、その手番側の負け。
 *   - 即負けになる手(使用済み・「ン」)は合法だが、選んだ側の負けなので
 *     勝ち手には数えない。安全な手が1つもなければ負け。
 *   - special / 2 ルールの次の文字は、着手した読みを右から左へ見て
 *     「安全に続けられる語がある」最初の文字。無ければ着手した側の勝ち。
 *
 * distance:
 *   勝ちなら最短で勝つまでの手数、負けなら最長で粘れる手数(いずれも手数=ply)。
 *   探索の予算内で求められなかった場合は、見つかった1本の手順の長さを使い、
 *   statistics.distanceExact = false になる。
 */


/* =========================================================
   ハッシュ表
========================================================= */

class StateTable {
    constructor(initialBits, maxBits) {
        this.maxBits = maxBits;
        this.allocate(Math.min(initialBits, maxBits));
    }

    allocate(bits) {
        this.bits = bits;
        this.capacity = 1 << bits;
        this.mask = this.capacity - 1;
        this.keys1 = new Uint32Array(this.capacity);
        this.keys2 = new Uint32Array(this.capacity);
        this.values = new Uint16Array(this.capacity);
        this.count = 0;
    }

    /* 上限の大きさで、かなり埋まっているか */
    isNearlyFull() {
        return (
            this.bits >= this.maxBits &&
            this.count * 2 >= this.capacity * 0.5
        );
    }

    clear() {
        this.keys1.fill(0);
        this.keys2.fill(0);
        this.values.fill(0);
        this.count = 0;
    }

    /* 0 は「未登録」 */
    get(key1, key2) {
        const keys1 = this.keys1;
        const keys2 = this.keys2;
        const values = this.values;
        const mask = this.mask;

        let index = key1 & mask;

        while (values[index] !== 0) {
            if (
                keys1[index] === key1 &&
                keys2[index] === key2
            ) {
                return values[index];
            }

            index = (index + 1) & mask;
        }

        return 0;
    }

    /* value は 1 以上 */
    set(key1, key2, value) {
        if (this.count * 2 >= this.capacity) {
            if (this.bits < this.maxBits) {
                this.grow();
            } else {
                /*
                 * 上限に達したら、新しい局面は記録しない。
                 * (探索中に表を空にすると、解いたばかりの局面まで
                 *  失われるため。表を空にするのは解析の合間だけ)
                 */
                return;
            }
        }

        const keys1 = this.keys1;
        const keys2 = this.keys2;
        const values = this.values;
        const mask = this.mask;

        let index = key1 & mask;

        while (values[index] !== 0) {
            if (
                keys1[index] === key1 &&
                keys2[index] === key2
            ) {
                values[index] = value;
                return;
            }

            index = (index + 1) & mask;
        }

        keys1[index] = key1;
        keys2[index] = key2;
        values[index] = value;
        this.count += 1;
    }

    grow() {
        const oldKeys1 = this.keys1;
        const oldKeys2 = this.keys2;
        const oldValues = this.values;
        const oldCapacity = this.capacity;

        this.allocate(this.bits + 1);

        for (let i = 0; i < oldCapacity; i += 1) {
            if (oldValues[i] !== 0) {
                this.set(
                    oldKeys1[i],
                    oldKeys2[i],
                    oldValues[i]
                );
            }
        }
    }
}


/* =========================================================
   ソルバー本体
========================================================= */

function createExactSolver(rawSettings = {}, rawOptions = {}) {
    const settings = normalizeSettings(rawSettings);

    const isSpecialRule =
        settings.rule === "special" ||
        settings.rule === "2";

    const nRule = settings.nRule ?? "lose";

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
        ),

        /* ハッシュ表の最大スロット数(2のべき乗)。1スロット約10バイト */
        maxMemoSlots: powerOfTwo(
            rawOptions.maxMemoSlots,
            1 << 23
        )
    };

    const maxMemoBits =
        Math.round(Math.log2(options.maxMemoSlots));

    /* ---------------------------------------------------------
       単語を読みごとのグループにまとめる
    --------------------------------------------------------- */

    const sourceWords = logic.getWords(settings) || [];

    const groups = [];
    const groupByReading = new Map();

    for (const source of sourceWords) {
        const reading = logic.normalizeReading(
            source.reading ?? source.name,
            settings
        );

        if (!reading || groupByReading.has(reading)) {
            continue;
        }

        const first = logic.getFirstLetter(source, settings);
        const last = logic.getLastLetter(source, settings);

        if (!first || !last) {
            continue;
        }

        const group = {
            index: groups.length,
            reading,
            /* ゲーム本体の findWord と同じく最初の語を代表にする */
            entry: source,
            first,
            last,
            endsN: logic.endsWithN(source, settings) === true,
            limit: Math.max(
                1,
                Number(logic.getSafeUseLimit(source, settings)) || 1
            ),
            classIndex: -1
        };

        groupByReading.set(reading, group);
        groups.push(group);
    }

    /* ---------------------------------------------------------
       文字ID
    --------------------------------------------------------- */

    const letterToId = new Map();
    const idToLetter = [];

    function registerLetter(letter) {
        if (!letter) {
            return -1;
        }

        let id = letterToId.get(letter);

        if (id === undefined) {
            id = idToLetter.length;
            letterToId.set(letter, id);
            idToLetter.push(letter);
        }

        return id;
    }

    for (const group of groups) {
        registerLetter(group.first);
        registerLetter(group.last);

        for (const ch of Array.from(group.reading)) {
            registerLetter(ch);
        }
    }

    const letterCount = idToLetter.length;

    /* ---------------------------------------------------------
       クラス(同じ形の読みをまとめたもの)
    --------------------------------------------------------- */

    const classes = [];
    const classByKey = new Map();

    for (const group of groups) {
        /*
         * special ルールは読みの途中の文字も使うので、まとめない。
         * 2回使える読みも、使用数の管理が複雑になるのでまとめない。
         */
        const key =
            isSpecialRule || group.limit > 1
                ? `#${group.index}`
                : `${group.first}|${group.last}|${group.endsN ? 1 : 0}`;

        let cls = classByKey.get(key);

        if (!cls) {
            cls = {
                index: classes.length,
                firstId: letterToId.get(group.first),
                lastId: letterToId.get(group.last),
                endsN: group.endsN,
                members: [],
                cap: 0,
                charIds: isSpecialRule
                    ? Array.from(group.reading).map(
                        ch => letterToId.get(ch)
                    )
                    : null
            };

            classByKey.set(key, cls);
            classes.push(cls);
        }

        cls.members.push(group);
        cls.cap += group.limit;
        group.classIndex = cls.index;
    }

    const classCount = classes.length;

    const classFirst = new Int32Array(classCount);
    const classLast = new Int32Array(classCount);
    const classCap = new Int32Array(classCount);
    const classEndsN = new Uint8Array(classCount);

    const classesByFirst = Array.from(
        { length: letterCount },
        () => []
    );

    /*
     * 文字ごとの「まだ安全に使える回数」。
     * 「ン」で終わる語とそれ以外を分けて数え、
     * 続けられる語があるかを O(1) で判定する。
     */
    const remainingByFirst = new Int32Array(letterCount);
    const remainingEnd = new Int32Array(letterCount);
    const remainingOther = new Int32Array(letterCount);

    for (const cls of classes) {
        classFirst[cls.index] = cls.firstId;
        classLast[cls.index] = cls.lastId;
        classCap[cls.index] = cls.cap;
        classEndsN[cls.index] = cls.endsN ? 1 : 0;

        classesByFirst[cls.firstId].push(cls.index);
    }

    let maxMovesPerLetter = 1;

    for (const list of classesByFirst) {
        maxMovesPerLetter = Math.max(maxMovesPerLetter, list.length);
    }

    /* ---------------------------------------------------------
       Zobrist ハッシュ用の乱数(固定シード)
    --------------------------------------------------------- */

    let seed = 0x9e3779b9;

    function random32() {
        seed = (seed + 0x6d2b79f5) | 0;

        let t = seed;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return (t ^ (t >>> 14)) >>> 0;
    }

    const classOffset = new Int32Array(classCount);

    let zobristSize = 0;

    for (let c = 0; c < classCount; c += 1) {
        classOffset[c] = zobristSize;
        zobristSize += classCap[c] + 1;
    }

    const zobrist1 = new Uint32Array(zobristSize);
    const zobrist2 = new Uint32Array(zobristSize);

    for (let c = 0; c < classCount; c += 1) {
        /* 使用数0の値は0にしておく */
        for (let k = 1; k <= classCap[c]; k += 1) {
            zobrist1[classOffset[c] + k] = random32();
            zobrist2[classOffset[c] + k] = random32();
        }
    }

    const letterZobrist1 = new Uint32Array(letterCount);
    const letterZobrist2 = new Uint32Array(letterCount);

    for (let i = 0; i < letterCount; i += 1) {
        letterZobrist1[i] = random32();
        letterZobrist2[i] = random32();
    }

    const nZobrist1 = new Uint32Array([0, random32()]);
    const nZobrist2 = new Uint32Array([0, random32()]);

    /* ---------------------------------------------------------
       探索状態
    --------------------------------------------------------- */

    const usedCount = new Int32Array(classCount);

    let hash1 = 0;
    let hash2 = 0;

    const realUses = new Int32Array(groups.length);

    const memo = new StateTable(16, maxMemoBits);
    const distanceMemo = new StateTable(12, maxMemoBits);

    const orderBuffers = [];

    function getOrderBuffer(depth) {
        let buffer = orderBuffers[depth];

        if (!buffer) {
            buffer = new Int32Array(maxMovesPerLetter);
            orderBuffers[depth] = buffer;
        }

        return buffer;
    }

    /* 予算 */
    let startedAt = Date.now();
    let deadline = startedAt + options.deadlineMilliseconds;
    let maxStates = options.maxStates;
    let activeDeadlineMs = options.deadlineMilliseconds;

    let visitedStates = 0;
    let cacheHits = 0;
    let aborted = false;
    let stopReason = "";

    let distanceVisited = 0;
    let distanceMax = 0;
    let distanceAborted = false;

    const timeMask = options.timeCheckInterval - 1;

    function resetBudget(overrides = {}) {
        startedAt = Date.now();

        activeDeadlineMs = positiveInt(
            overrides.deadlineMilliseconds,
            options.deadlineMilliseconds
        );

        deadline = startedAt + activeDeadlineMs;

        maxStates = positiveInt(
            overrides.maxStates,
            options.maxStates
        );

        visitedStates = 0;
        cacheHits = 0;
        aborted = false;
        stopReason = "";

        distanceVisited = 0;
        distanceMax = Math.max(1000, Math.floor(maxStates / 2));
        distanceAborted = false;
    }

    function checkBudget() {
        if (visitedStates > maxStates) {
            aborted = true;
            stopReason = "maxStates";
            return true;
        }

        if (
            (visitedStates & timeMask) === 0 &&
            Date.now() >= deadline
        ) {
            aborted = true;
            stopReason = "deadline";
            return true;
        }

        return false;
    }

    /* ---------------------------------------------------------
       着手の適用・取り消し
    --------------------------------------------------------- */

    function applyClass(c) {
        const k = usedCount[c];
        const offset = classOffset[c];

        hash1 ^= zobrist1[offset + k] ^ zobrist1[offset + k + 1];
        hash2 ^= zobrist2[offset + k] ^ zobrist2[offset + k + 1];

        usedCount[c] = k + 1;
        remainingByFirst[classFirst[c]] -= 1;

        if (classEndsN[c] === 1) {
            remainingEnd[classFirst[c]] -= 1;
        } else {
            remainingOther[classFirst[c]] -= 1;
        }
    }

    function undoClass(c) {
        const k = usedCount[c];
        const offset = classOffset[c];

        hash1 ^= zobrist1[offset + k] ^ zobrist1[offset + k - 1];
        hash2 ^= zobrist2[offset + k] ^ zobrist2[offset + k - 1];

        usedCount[c] = k - 1;
        remainingByFirst[classFirst[c]] += 1;

        if (classEndsN[c] === 1) {
            remainingEnd[classFirst[c]] += 1;
        } else {
            remainingOther[classFirst[c]] += 1;
        }
    }

    /* ---------------------------------------------------------
       手の生成
    --------------------------------------------------------- */

    function isSafeClassMove(c, nEnd) {
        if (usedCount[c] >= classCap[c]) {
            return false;
        }

        if (classEndsN[c] === 1) {
            if (nRule === "lose") {
                return false;
            }

            if (nRule === "once" && nEnd >= 1) {
                return false;
            }
        }

        return true;
    }

    function hasSafeMove(letterId, nEnd) {
        if (remainingOther[letterId] > 0) {
            return true;
        }

        if (remainingEnd[letterId] <= 0) {
            return false;
        }

        if (nRule === "unlimited") {
            return true;
        }

        return nRule === "once" && nEnd < 1;
    }

    /*
     * 安全な手を buffer に入れ、相手の選択肢が少ない順に並べる。
     * 個数を返す。
     */
    const scoreScratch = new Int32Array(maxMovesPerLetter);

    function collectMoves(letterId, nEnd, buffer, sorted) {
        const list = classesByFirst[letterId];

        let count = 0;

        for (let i = 0; i < list.length; i += 1) {
            const c = list[i];

            if (isSafeClassMove(c, nEnd)) {
                buffer[count] = c;
                count += 1;
            }
        }

        if (sorted && count > 1) {
            /* 相手の選択肢が少ない手(=勝ちやすい手)を先に調べる */
            for (let i = 0; i < count; i += 1) {
                scoreScratch[i] = replyScore(buffer[i], nEnd);
            }

            for (let i = 1; i < count; i += 1) {
                const c = buffer[i];
                const key = scoreScratch[i];

                let j = i - 1;

                while (j >= 0 && scoreScratch[j] > key) {
                    buffer[j + 1] = buffer[j];
                    scoreScratch[j + 1] = scoreScratch[j];
                    j -= 1;
                }

                buffer[j + 1] = c;
                scoreScratch[j + 1] = key;
            }
        }

        return count;
    }

    /* 手 c を指した後に、相手が安全に指せる語の数(少ないほど有利) */
    function replyScore(c, nEnd) {
        if (isSpecialRule) {
            applyClass(c);

            const next = childLetter(c, nextNEnd(c, nEnd));

            const score =
                next < 0
                    ? -1
                    : remainingByFirst[next];

            undoClass(c);

            return score;
        }

        const next = classLast[c];

        if (next < 0) {
            return -1;
        }

        /* 手を指す前の値なので、同じ文字から続くなら自分の分は引く */
        return (
            remainingByFirst[next] -
            (classFirst[c] === next ? 1 : 0)
        );
    }

    function nextNEnd(c, nEnd) {
        return (
            nRule === "once" &&
            classEndsN[c] === 1
        )
            ? 1
            : nEnd;
    }

    /*
     * 着手(適用済み)の後の次の文字ID。
     * -1 は「相手に安全な手がない(着手側の勝ち)」を表す。
     */
    function childLetter(c, childN) {
        if (!isSpecialRule) {
            const next = classLast[c];

            return (
                next >= 0 &&
                classesByFirst[next].length > 0
            )
                ? next
                : -1;
        }

        const ids = classes[c].charIds;

        for (let i = ids.length - 1; i >= 0; i -= 1) {
            const id = ids[i];

            if (id >= 0 && hasSafeMove(id, childN)) {
                return id;
            }
        }

        return -1;
    }

    /* ---------------------------------------------------------
       勝敗の探索
    --------------------------------------------------------- */

    function solve(letterId, nEnd, depth) {
        const key1 =
            (hash1 ^ letterZobrist1[letterId] ^ nZobrist1[nEnd]) >>> 0;

        const key2 =
            (hash2 ^ letterZobrist2[letterId] ^ nZobrist2[nEnd]) >>> 0;

        const cached = memo.get(key1, key2);

        if (cached !== 0) {
            cacheHits += 1;
            return cached;
        }

        visitedStates += 1;

        if (checkBudget()) {
            return RESULT.UNKNOWN;
        }

        const buffer = getOrderBuffer(depth);

        const count = collectMoves(letterId, nEnd, buffer, true);

        let result = RESULT.LOSE;

        for (let i = 0; i < count; i += 1) {
            const c = buffer[i];

            const childN = nextNEnd(c, nEnd);

            applyClass(c);

            const next = childLetter(c, childN);

            let childResult;

            if (next < 0) {
                childResult = RESULT.LOSE;
            } else {
                childResult = solve(next, childN, depth + 1);
            }

            undoClass(c);

            if (aborted) {
                return RESULT.UNKNOWN;
            }

            if (childResult === RESULT.LOSE) {
                result = RESULT.WIN;
                break;
            }
        }

        memo.set(key1, key2, result);

        return result;
    }

    /* ---------------------------------------------------------
       距離(勝ちは最短、負けは最長)
    --------------------------------------------------------- */

    let bestClassOut = -1;

    /*
     * 戻り値: 距離(0以上)、求められなければ -1。
     * 終了時に bestClassOut に「その局面での最善手のクラス」が入る。
     */
    function distance(letterId, nEnd, depth) {
        const key1 =
            (hash1 ^ letterZobrist1[letterId] ^ nZobrist1[nEnd]) >>> 0;

        const key2 =
            (hash2 ^ letterZobrist2[letterId] ^ nZobrist2[nEnd]) >>> 0;

        const cachedDistance = distanceMemo.get(key1, key2);

        const outcome = solve(letterId, nEnd, depth);

        if (outcome === RESULT.UNKNOWN) {
            return -1;
        }

        const buffer = getOrderBuffer(depth);

        const count = collectMoves(letterId, nEnd, buffer, true);

        if (count === 0) {
            bestClassOut = -1;
            return 0;
        }

        const winning = outcome === RESULT.WIN;

        /*
         * 距離だけ必要な再帰呼び出しでは、保存済みの値をそのまま返す。
         * (最善手が必要なのは一番上の局面と手順を作るときだけなので、
         *  そのときは wantMove を使う別関数で求める)
         */
        if (cachedDistance !== 0 && !distanceNeedsMove) {
            return cachedDistance - 1;
        }

        distanceVisited += 1;

        if (
            distanceVisited > distanceMax ||
            (
                (distanceVisited & timeMask) === 0 &&
                Date.now() >= deadline
            )
        ) {
            distanceAborted = true;
            return -1;
        }

        const wantMove = distanceNeedsMove;

        distanceNeedsMove = false;

        let best = winning ? Infinity : -1;
        let bestClass = -1;

        for (let i = 0; i < count; i += 1) {
            const c = buffer[i];

            const childN = nextNEnd(c, nEnd);

            applyClass(c);

            const next = childLetter(c, childN);

            let childDistance;
            let compatible;

            if (next < 0) {
                compatible = winning;
                childDistance = 0;
            } else {
                const childResult = solve(next, childN, depth + 1);

                if (aborted) {
                    undoClass(c);
                    distanceNeedsMove = wantMove;
                    return -1;
                }

                compatible = winning
                    ? childResult === RESULT.LOSE
                    : childResult === RESULT.WIN;

                childDistance = compatible
                    ? distance(next, childN, depth + 1)
                    : 0;
            }

            undoClass(c);

            if (compatible) {
                if (childDistance < 0) {
                    distanceNeedsMove = wantMove;
                    return -1;
                }

                const total = childDistance + 1;

                if (
                    winning
                        ? total < best
                        : total > best
                ) {
                    best = total;
                    bestClass = c;
                }

                /* 1手で勝てるなら、これ以上短い手はない */
                if (winning && best === 1) {
                    break;
                }
            }
        }

        distanceNeedsMove = wantMove;

        if (bestClass < 0) {
            return -1;
        }

        distanceMemo.set(key1, key2, best + 1);

        bestClassOut = bestClass;

        return best;
    }

    /*
     * distance() に「最善手のクラスも必要」と伝えるフラグ。
     * 1回の呼び出しの先頭だけで有効になり、再帰の中では常に false。
     */
    let distanceNeedsMove = false;

    function distanceWithMove(letterId, nEnd) {
        distanceNeedsMove = true;
        bestClassOut = -1;

        const value = distance(letterId, nEnd, 0);

        distanceNeedsMove = false;

        return {
            distance: value,
            bestClass: value >= 0 ? bestClassOut : -1
        };
    }

    /* ---------------------------------------------------------
       手順の作成
    --------------------------------------------------------- */

    function pickMember(c) {
        for (const group of classes[c].members) {
            if (realUses[group.index] < group.limit) {
                return group;
            }
        }

        return classes[c].members[0];
    }

    function toPublicMove(group) {
        if (!group) {
            return null;
        }

        const entry = group.entry;

        return {
            id: entry.id,
            word: entry.name,
            name: entry.name,
            reading: group.reading,
            type: entry.type,
            firstLetter: group.first,
            nextLetter: group.last
        };
    }

    /* 手順の途中で最善手が求められないとき用の簡易選択 */
    function greedyClass(letterId, nEnd, depth) {
        const outcome = solve(letterId, nEnd, depth);

        const buffer = getOrderBuffer(depth);

        const count = collectMoves(letterId, nEnd, buffer, true);

        for (let i = 0; i < count; i += 1) {
            const c = buffer[i];

            if (outcome !== RESULT.WIN) {
                return c;
            }

            const childN = nextNEnd(c, nEnd);

            applyClass(c);

            const next = childLetter(c, childN);

            const childResult =
                next < 0
                    ? RESULT.LOSE
                    : solve(next, childN, depth + 1);

            undoClass(c);

            if (childResult === RESULT.LOSE) {
                return c;
            }
        }

        return -1;
    }

    function buildPrincipalVariation(
        letterId,
        nEnd,
        maxMoves,
        distanceIsExact
    ) {
        const variation = [];
        const applied = [];

        let letter = letterId;
        let n = nEnd;

        for (
            let ply = 0;
            ply < maxMoves && letter >= 0;
            ply += 1
        ) {
            const outcome = solve(letter, n, 0);

            if (outcome === RESULT.UNKNOWN) {
                break;
            }

            let c = -1;

            if (distanceIsExact) {
                c = distanceWithMove(letter, n).bestClass;
            }

            if (c < 0) {
                c = greedyClass(letter, n, 0);
            }

            if (c < 0) {
                break;
            }

            const group = pickMember(c);
            const childN = nextNEnd(c, n);

            applyClass(c);
            realUses[group.index] += 1;
            applied.push({ c, group });

            const next = childLetter(c, childN);

            variation.push({
                word: group.entry.name,
                name: group.entry.name,
                reading: group.reading,
                firstLetter: group.first,
                lastLetter: group.last,
                nextLetter:
                    next >= 0
                        ? idToLetter[next]
                        : "",
                outcome: getOutcomeName(outcome)
            });

            letter = next;
            n = childN;
        }

        for (let i = applied.length - 1; i >= 0; i -= 1) {
            realUses[applied[i].group.index] -= 1;
            undoClass(applied[i].c);
        }

        return variation;
    }

    /* ---------------------------------------------------------
       使用済み単語の取り込み
    --------------------------------------------------------- */

    /*
     * 履歴を「読みごとの使用回数」に直し、探索状態に反映する。
     * (ゲーム本体の countWordUses と同じく、読みで数える)
     */
    function loadUsedWords(usedWords) {
        realUses.fill(0);

        if (Array.isArray(usedWords)) {
            for (const used of usedWords) {
                const reading = logic.getUsedReading(used, settings);
                const group = groupByReading.get(reading);

                if (group) {
                    realUses[group.index] += 1;
                }
            }
        }

        usedCount.fill(0);
        hash1 = 0;
        hash2 = 0;
        remainingByFirst.fill(0);
        remainingEnd.fill(0);
        remainingOther.fill(0);

        for (const cls of classes) {
            let used = 0;

            for (const group of cls.members) {
                used += Math.min(
                    realUses[group.index],
                    group.limit
                );
            }

            used = Math.min(used, cls.cap);

            usedCount[cls.index] = used;

            hash1 ^= zobrist1[classOffset[cls.index] + used];
            hash2 ^= zobrist2[classOffset[cls.index] + used];

            remainingByFirst[cls.firstId] += cls.cap - used;

            if (cls.endsN) {
                remainingEnd[cls.firstId] += cls.cap - used;
            } else {
                remainingOther[cls.firstId] += cls.cap - used;
            }
        }
    }

    /* ---------------------------------------------------------
       公開API
    --------------------------------------------------------- */

    function normalizeLetterValue(value) {
        return logic.normalizeCharacter(
            String(value ?? "").trim(),
            settings
        );
    }

    function normalizeNEnd(value) {
        const n = Number(value);

        return (
            nRule === "once" &&
            Number.isFinite(n) &&
            n > 0
        )
            ? 1
            : 0;
    }

    function parsePositionArguments(arg1, arg2, arg3) {
        if (
            arg1 &&
            typeof arg1 === "object" &&
            !Array.isArray(arg1)
        ) {
            return {
                requiredLetter:
                    arg1.requiredLetter ?? arg1.currentLetter,
                usedWords: arg1.usedWords ?? [],
                nEndCount: arg1.nEndCount ?? 0,
                maxMoves: positiveInt(
                    arg1.maxMoves,
                    options.principalVariationLimit
                ),
                overrides: {
                    maxStates: arg1.maxStates,
                    deadlineMilliseconds: arg1.deadlineMilliseconds
                }
            };
        }

        return {
            requiredLetter: arg1,
            usedWords: arg2 ?? [],
            nEndCount: arg3 ?? 0,
            maxMoves: options.principalVariationLimit,
            overrides: {}
        };
    }

    /*
     * 局面を解析する。
     *
     * analyzePosition({
     *   requiredLetter, usedWords, nEndCount,
     *   maxMoves,
     *   maxStates,             // この呼び出しだけの上限(省略可)
     *   deadlineMilliseconds   // この呼び出しだけの制限時間(省略可)
     * })
     */
    function analyzePosition(arg1, arg2, arg3) {
        const input = parsePositionArguments(arg1, arg2, arg3);

        resetBudget(input.overrides);

        /* 解析の合間にだけ、いっぱいになったメモを空にする */
        if (memo.isNearlyFull() || distanceMemo.isNearlyFull()) {
            memo.clear();
            distanceMemo.clear();
        }

        const letter = normalizeLetterValue(input.requiredLetter);
        const letterId = letterToId.get(letter);

        if (letterId === undefined) {
            return unknownAnalysis("unknown-letter");
        }

        loadUsedWords(input.usedWords);

        const nEnd = normalizeNEnd(input.nEndCount);

        const outcome = solve(letterId, nEnd, 0);

        if (outcome === RESULT.UNKNOWN) {
            return unknownAnalysis(stopReason || "search-limit");
        }

        let distanceValue;
        let bestClass;
        let distanceExact = true;

        const measured = distanceWithMove(letterId, nEnd);

        const stats = getStatistics();

        /*
         * 手順を作るために、上限に達していた場合も予算を少し延ばす。
         * (勝敗はすでに確定している)
         */
        aborted = false;
        deadline = Math.max(deadline, Date.now() + 500);
        maxStates = Math.max(maxStates, visitedStates + 100000);

        if (measured.distance >= 0) {
            distanceValue = measured.distance;
            bestClass = measured.bestClass;
        } else {
            distanceExact = false;
            bestClass = greedyClass(letterId, nEnd, 0);
            distanceValue = null;
        }

        stats.distanceExact = distanceExact;

        const bestGroup =
            bestClass >= 0
                ? pickMember(bestClass)
                : null;

        const variation = buildPrincipalVariation(
            letterId,
            nEnd,
            input.maxMoves,
            distanceExact
        );

        if (distanceValue === null) {
            distanceValue = variation.length;
        }

        return {
            exact: true,
            winning: outcome === RESULT.WIN,
            outcome: getOutcomeName(outcome),
            distance: distanceValue,
            bestMove: toPublicMove(bestGroup),
            principalVariation: variation,
            statistics: stats,
            limited: false
        };
    }

    /* ---------------------------------------------------------
       時間制限つきの着手選択(モンテカルロ木探索+部分的な完全解析)

       解き切れない局面(特殊ルールの序盤など)で、
       できるだけ良い手を選ぶために使う。

       - 木探索で有望な手を深く調べる(UCB)
       - 木の端からは、最後までランダムに指して勝敗を見る
       - 新しい局面では、小さな予算で完全解析を試し、勝敗が確定したら
         確定結果として木に記録する(終盤に近いほど正確になる)
    --------------------------------------------------------- */

    function createTreeNode(parent, cls, letter, nEnd) {
        return {
            parent,
            cls,
            letter,
            nEnd,
            children: [],
            untried: null,
            visits: 0,
            wins: 0,
            /* 0=未確定 / 1=この局面へ着手した側が勝つ / 2=その側が負ける */
            proven: 0
        };
    }

    /* 現在の探索状態から、小さな予算で勝敗を確定させてみる */
    function quickSolve(letterId, nEnd, states) {
        const savedMax = maxStates;
        const savedDeadline = deadline;
        const savedVisited = visitedStates;

        aborted = false;
        visitedStates = 0;
        maxStates = states;
        deadline = Date.now() + 1000;

        const result = solve(letterId, nEnd, 0);

        const solved = !aborted && result !== RESULT.UNKNOWN;

        aborted = false;
        maxStates = savedMax;
        deadline = savedDeadline;
        visitedStates = savedVisited;

        return solved ? result : RESULT.UNKNOWN;
    }

    /*
     * letterId の手番側から最後までランダムに指し、
     * 「その手番側が勝つか」を返す。状態は元に戻す。
     */
    function playout(letterId, nEnd) {
        const stack = [];
        const buffer = getOrderBuffer(0);

        let letter = letterId;
        let n = nEnd;
        let toMoveWins = false;

        for (let ply = 0; ply < 5000; ply += 1) {
            const count = collectMoves(letter, n, buffer, false);

            if (count === 0) {
                /* 指せる手がない側の負け */
                toMoveWins = ply % 2 === 1;
                break;
            }

            /* 数手だけ候補を見て、即勝ちできる手があれば選ぶ */
            let chosen = -1;
            let chosenNext = -1;
            let instant = false;

            const tries = Math.min(count, 3);

            for (let t = 0; t < tries; t += 1) {
                const c = buffer[Math.floor(Math.random() * count)];

                applyClass(c);

                const next = childLetter(c, nextNEnd(c, n));

                undoClass(c);

                if (next < 0) {
                    chosen = c;
                    instant = true;
                    break;
                }

                if (t === 0) {
                    chosen = c;
                    chosenNext = next;
                }
            }

            const childN = nextNEnd(chosen, n);

            applyClass(chosen);
            stack.push(chosen);

            if (instant) {
                /* 着手側の勝ち */
                toMoveWins = ply % 2 === 0;
                break;
            }

            letter = chosenNext;
            n = childN;
        }

        for (let i = stack.length - 1; i >= 0; i -= 1) {
            undoClass(stack[i]);
        }

        return toMoveWins;
    }

    /* 子ノードを作り、終局・確定していれば proven を設定する */
    function expandChild(node, cls, quickStates) {
        const childN = nextNEnd(cls, node.nEnd);

        applyClass(cls);

        const next = childLetter(cls, childN);

        const child = createTreeNode(node, cls, next, childN);

        if (next < 0) {
            /* 相手に安全な続きがない = 着手側の勝ち */
            child.proven = 1;
        } else {
            const result = quickSolve(next, childN, quickStates);

            if (result === RESULT.LOSE) {
                child.proven = 1;
            } else if (result === RESULT.WIN) {
                child.proven = 2;
            }
        }

        undoClass(cls);

        node.children.push(child);

        return child;
    }

    /* 子の確定結果から、親の確定結果を求める */
    function updateProven(node) {
        if (node.proven !== 0 || node.untried === null) {
            return;
        }

        let allLose = node.untried.length === 0;

        for (const child of node.children) {
            if (child.proven === 1) {
                /* 相手(次の手番側)が勝つ手がある */
                node.proven = 2;
                return;
            }

            if (child.proven !== 2) {
                allLose = false;
            }
        }

        if (allLose) {
            node.proven = 1;
        }
    }

    function selectChild(node, exploration) {
        let best = null;
        let bestScore = -Infinity;

        const logVisits = Math.log(node.visits + 1);

        for (const child of node.children) {
            /* その手で着手側が負けると確定している手は選ばない */
            if (child.proven === 2) {
                continue;
            }

            let score;

            if (child.proven === 1) {
                score = Infinity;
            } else {
                score =
                    child.wins / child.visits +
                    exploration *
                        Math.sqrt(logVisits / child.visits);
            }

            if (score > bestScore) {
                bestScore = score;
                best = child;
            }
        }

        return best;
    }

    /*
     * 時間内で最善手を探す。
     *
     * suggestMove({
     *   requiredLetter, usedWords, nEndCount,
     *   timeLimitMilliseconds,  // 既定 3000
     *   quickSolveStates,       // 新しい局面で試す完全解析の上限(既定 1500)
     *   exploration             // 既定 0.9
     * })
     *
     * 戻り値: { found, bestMove, winRate, proven("WIN"/"LOSE"/null),
     *           simulations, candidates[] }
     */
    function suggestMove(rawInput = {}) {
        const timeLimit = positiveInt(
            rawInput.timeLimitMilliseconds,
            3000
        );

        const quickStates = positiveInt(
            rawInput.quickSolveStates,
            1500
        );

        const exploration =
            Number(rawInput.exploration) > 0
                ? Number(rawInput.exploration)
                : 0.9;

        const empty = {
            found: false,
            bestMove: null,
            winRate: null,
            proven: null,
            simulations: 0,
            candidates: []
        };

        const letterId = letterToId.get(
            normalizeLetterValue(
                rawInput.requiredLetter ?? rawInput.currentLetter
            )
        );

        if (letterId === undefined) {
            return empty;
        }

        resetBudget({});

        loadUsedWords(rawInput.usedWords);

        const nEnd = normalizeNEnd(rawInput.nEndCount);

        const root = createTreeNode(null, -1, letterId, nEnd);

        const endAt = Date.now() + timeLimit;

        let simulations = 0;

        while (Date.now() < endAt) {
            /* --- 選択 --- */
            let node = root;
            const path = [];

            for (;;) {
                if (node.untried === null) {
                    const buffer = getOrderBuffer(0);

                    const count = collectMoves(
                        node.letter,
                        node.nEnd,
                        buffer,
                        true
                    );

                    /* 有望そうな手(相手の選択肢が少ない手)を先に試す */
                    node.untried = Array.from(
                        buffer.subarray(0, count)
                    ).reverse();

                    updateProven(node);
                }

                if (node.proven !== 0) {
                    break;
                }

                if (node.untried.length > 0) {
                    break;
                }

                const child = selectChild(node, exploration);

                if (!child) {
                    break;
                }

                applyClass(child.cls);
                path.push(child.cls);

                node = child;

                if (node.proven !== 0 || node.letter < 0) {
                    break;
                }
            }

            /* --- 拡張 --- */
            let leaf = node;
            let leafWon;

            if (leaf.proven === 0 && leaf.untried && leaf.untried.length > 0) {
                const cls = leaf.untried.pop();

                const child = expandChild(leaf, cls, quickStates);

                applyClass(cls);
                path.push(cls);

                leaf = child;
            }

            /* --- 結果 --- */
            if (leaf.proven === 1) {
                leafWon = true;
            } else if (leaf.proven === 2) {
                leafWon = false;
            } else {
                /* 葉の手番側が勝つか → 着手側が勝つかへ反転 */
                leafWon = !playout(leaf.letter, leaf.nEnd);
            }

            for (let i = path.length - 1; i >= 0; i -= 1) {
                undoClass(path[i]);
            }

            /* --- 逆伝播 --- */
            let current = leaf;
            let moverWon = leafWon;

            while (current) {
                current.visits += 1;

                if (moverWon) {
                    current.wins += 1;
                }

                if (current.parent) {
                    updateProven(current.parent);
                }

                current = current.parent;
                moverWon = !moverWon;
            }

            simulations += 1;

            if (root.proven !== 0) {
                /* 根の勝敗が確定したら、これ以上は不要 */
                break;
            }
        }

        /* --- 手の決定 --- */
        let best = null;

        const winningChild =
            root.children.find(child => child.proven === 1) ?? null;

        if (winningChild) {
            best = winningChild;
        } else {
            for (const child of root.children) {
                if (child.proven === 2) {
                    continue;
                }

                if (
                    !best ||
                    child.visits > best.visits ||
                    (
                        child.visits === best.visits &&
                        child.wins > best.wins
                    )
                ) {
                    best = child;
                }
            }

            /* すべての手が負けでも、最も試した手(粘れる手)を返す */
            if (!best) {
                for (const child of root.children) {
                    if (!best || child.visits > best.visits) {
                        best = child;
                    }
                }
            }
        }

        if (!best) {
            return { ...empty, simulations };
        }

        const members = classes[best.cls].members;

        const group =
            members.find(g => realUses[g.index] < g.limit) ??
            members[0];

        return {
            found: true,
            bestMove: toPublicMove(group),

            winRate:
                best.visits > 0
                    ? best.wins / best.visits
                    : null,

            proven:
                best.proven === 1
                    ? OUTCOME.WIN
                    : (
                        root.proven === 1
                            ? OUTCOME.LOSE
                            : null
                    ),

            simulations,

            candidates: root.children.map(child => {
                const cMembers = classes[child.cls].members;

                const g =
                    cMembers.find(m => realUses[m.index] < m.limit) ??
                    cMembers[0];

                return {
                    word: g.entry.name,
                    reading: g.reading,
                    visits: child.visits,
                    winRate:
                        child.visits > 0
                            ? child.wins / child.visits
                            : null,
                    proven:
                        child.proven === 1
                            ? OUTCOME.WIN
                            : (
                                child.proven === 2
                                    ? OUTCOME.LOSE
                                    : null
                            )
                };
            })
        };
    }

    function analyzeStart(letter, usedWords = [], nEndCount = 0) {
        return analyzePosition({
            requiredLetter: letter,
            usedWords,
            nEndCount,
            maxMoves: options.principalVariationLimit
        });
    }

    /* 勝敗だけを RESULT で返す(旧 solve 互換) */
    function solveCompat(letter, usedWords = [], nEndCount = 0) {
        resetBudget();

        const letterId = letterToId.get(
            normalizeLetterValue(letter)
        );

        if (letterId === undefined) {
            return RESULT.UNKNOWN;
        }

        loadUsedWords(usedWords);

        return solve(letterId, normalizeNEnd(nEndCount), 0);
    }

    /* 次の1手で勝ちが確定する手(相手に安全な続きがなくなる手) */
    function getTerminalWinningWords(
        letter,
        usedWords = [],
        nEndCount = 0
    ) {
        const letterId = letterToId.get(
            normalizeLetterValue(letter)
        );

        if (letterId === undefined) {
            return [];
        }

        loadUsedWords(usedWords);

        const nEnd = normalizeNEnd(nEndCount);

        const buffer = getOrderBuffer(0);

        const count = collectMoves(letterId, nEnd, buffer, false);

        const result = [];

        for (let i = 0; i < count; i += 1) {
            const c = buffer[i];

            const childN = nextNEnd(c, nEnd);

            applyClass(c);

            const next = childLetter(c, childN);

            undoClass(c);

            if (next < 0) {
                for (const group of classes[c].members) {
                    if (realUses[group.index] < group.limit) {
                        result.push(toPublicMove(group));
                    }
                }
            }
        }

        return result;
    }

    function getStatistics() {
        return {
            visitedStates,
            memoStates: memo.count,
            cacheHits,
            elapsedMs: Date.now() - startedAt,
            stoppedByLimit: aborted,
            stopReason,
            maxStates,
            deadlineMilliseconds: activeDeadlineMs
        };
    }

    function clear() {
        memo.clear();
        distanceMemo.clear();
        resetBudget();
    }

    function unknownAnalysis(reason) {
        return {
            exact: false,
            winning: null,
            outcome: OUTCOME.UNKNOWN,
            distance: null,
            bestMove: null,
            principalVariation: [],
            statistics: {
                ...getStatistics(),
                stopReason: reason
            },
            limited: true
        };
    }

    return {
        analyzeStart,
        analyzePosition,
        suggestMove,
        solve: solveCompat,
        solveOutcome: solveCompat,
        clear,
        getStatistics,
        getTerminalWinningWords,
        settings: { ...settings },
        options: { ...options },
        wordCount: sourceWords.length,
        searchWordCount: groups.length,
        classCount
    };
}


/* =========================================================
   補助関数
========================================================= */

function getOutcomeName(result) {
    if (result === RESULT.WIN) {
        return OUTCOME.WIN;
    }

    if (result === RESULT.LOSE) {
        return OUTCOME.LOSE;
    }

    return OUTCOME.UNKNOWN;
}

function positiveInt(value, fallback) {
    const n = Number(value);

    return (
        Number.isFinite(n) &&
        n > 0
    )
        ? Math.floor(n)
        : fallback;
}

function powerOfTwo(value, fallback) {
    const wanted = positiveInt(value, fallback);

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