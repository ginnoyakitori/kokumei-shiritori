"use strict";

const fs = require("fs");
const path = require("path");


/* =========================================================
   単語ファイル
========================================================= */

const COUNTRIES_FILE = path.join(
    __dirname,
    "..",
    "words",
    "countries.txt"
);

const CAPITALS_FILE = path.join(
    __dirname,
    "..",
    "words",
    "capitals.txt"
);


/* =========================================================
   文字変換用定数
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

/*
 * 読みの途中から除外する文字。
 *
 * 長音記号「ー」も除外するため、
 * 「ノルウェー」の最後は「エ」、
 * 「ニューヨーク」の最後は「ク」と判定される。
 */
const IGNORE_CHARACTERS = new Set([
    " ",
    "　",

    "・",
    "･",

    "-",
    "‐",
    "‑",
    "‒",
    "–",
    "—",
    "―",
    "ー",
    "_",

    ".",
    "．",

    ",",
    "，",

    "、",
    "。",

    "'",
    "\"",

    "「",
    "」",
    "『",
    "』",

    "(",
    ")",
    "（",
    "）",

    "[",
    "]",
    "【",
    "】"
]);


/* =========================================================
   単語データ
========================================================= */

let countries = [];
let capitals = [];

/*
 * 設定ごとの単語索引。
 * キー: `${mode}|${removeMarks}`
 * 値: { mode, removeMarks, words, byFirstLetter }
 */
const wordIndexCache = new Map();

/*
 * 名前・読みから単語を探す検索表。
 * キー: mode("countries" / "capitals" / "both")
 */
const lookupCache = new Map();

/*
 * 単語ごとの正規化済み情報(読み・先頭文字・末尾文字)。
 * 添字 0: 濁点を取り外さない / 1: 取り外す
 */
let entryInfoMaps = [
    new WeakMap(),
    new WeakMap()
];

/*
 * 文字列の正規化結果のメモ。
 * クライアントから任意の文字列が届くため、件数に上限を設ける。
 */
const READING_MEMO_LIMIT = 20000;

const readingMemos = [
    new Map(),
    new Map()
];

/*
 * 国名と首都名の両方にある読みの集合。
 * 添字は entryInfoMaps と同じ。使うときに作る。
 */
let duplicateReadingSets = [
    null,
    null
];

loadWordFiles();


/* =========================================================
   TXTファイル読み込み
========================================================= */

/**
 * 国名・首都名のTXTを読み込み、
 * 検索用の索引と事前計算データを作り直す。
 */
function loadWordFiles() {
    countries = freezeEntries(
        loadTextFile(
            COUNTRIES_FILE,
            "country"
        )
    );

    capitals = freezeEntries(
        loadTextFile(
            CAPITALS_FILE,
            "capital"
        )
    );

    resetDerivedData();
    precomputeEntryInfo();

    console.log(
        `[logic] 国名 ${countries.length}件、` +
        `首都名 ${capitals.length}件を読み込みました。`
    );
}

/**
 * 単語データを読み取り専用にする。
 *
 * getWordsは同じオブジェクトを共有して返すため、
 * 呼び出し側が書き換えられないようにする。
 */
function freezeEntries(entries) {
    for (const entry of entries) {
        Object.freeze(entry);
    }

    return entries;
}

/**
 * 単語データから作った派生データを破棄する。
 */
function resetDerivedData() {
    wordIndexCache.clear();
    lookupCache.clear();

    entryInfoMaps = [
        new WeakMap(),
        new WeakMap()
    ];

    for (const memo of readingMemos) {
        memo.clear();
    }

    duplicateReadingSets = [
        null,
        null
    ];
}

/**
 * 全単語の正規化済みの読み・先頭文字・末尾文字を
 * 2通り(濁点の取り外し有無)計算しておく。
 */
function precomputeEntryInfo() {
    const allEntries = [
        ...countries,
        ...capitals
    ];

    for (
        let variant = 0;
        variant <= 1;
        variant += 1
    ) {
        const settings = {
            removeMarks:
                variant === 1
        };

        for (const entry of allEntries) {
            const reading =
                computeNormalizedReading(
                    entry.reading ??
                    entry.name,
                    settings
                );

            const characters =
                Array.from(reading);

            entryInfoMaps[variant].set(
                entry,
                {
                    reading,

                    first:
                        characters[0] ??
                        "",

                    last:
                        characters[
                            characters.length - 1
                        ] ?? ""
                }
            );
        }
    }
}

/**
 * 1行1単語のTXTファイルを読み込む。
 *
 * 空行と「#」で始まる行は無視する。
 */
function loadTextFile(filePath, type) {
    try {
        if (!fs.existsSync(filePath)) {
            console.warn(
                `[logic] ファイルがありません: ${filePath}`
            );

            return [];
        }

        const text = fs.readFileSync(
            filePath,
            "utf8"
        );

        const entries = text
            .replace(/^\uFEFF/, "")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => {
                return (
                    line.length > 0 &&
                    !line.startsWith("#")
                );
            })
            .map((reading, index) => {
                return {
                    id: `${type}-${index}`,
                    name: reading,
                    reading,
                    type
                };
            });

        return removeDuplicateEntries(entries);
    } catch (error) {
        console.error(
            `[logic] TXTの読み込みに失敗しました: ${filePath}`,
            error
        );

        return [];
    }
}

/**
 * 同じファイル内にある完全な重複行を削除する。
 *
 * 国名と首都名に同じ読みがある場合は、
 * typeが異なるため両方とも残る。
 */
function removeDuplicateEntries(entries) {
    const seen = new Set();

    return entries.filter(entry => {
        const key =
            `${entry.type}|${entry.reading}`;

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}


/* =========================================================
   文字の正規化
========================================================= */

/**
 * ひらがなをカタカナへ変換する。
 */
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

/**
 * 空白、長音、記号を除去し、
 * カタカナへ統一する。
 */
function cleanReading(value) {
    const katakana =
        hiraganaToKatakana(
            String(value ?? "").trim()
        );

    return Array.from(katakana)
        .filter(character => {
            return !IGNORE_CHARACTERS.has(
                character
            );
        })
        .join("");
}

/**
 * 1文字を比較用に正規化する。
 */
function normalizeCharacter(
    character,
    settings = {}
) {
    if (!character) {
        return "";
    }

    let normalized =
        hiraganaToKatakana(
            String(character)
        );

    normalized =
        SMALL_KANA_MAP[normalized] ??
        normalized;

    if (settings.removeMarks === true) {
        normalized =
            DAKUTEN_MAP[normalized] ??
            normalized;
    }

    return normalized;
}

/**
 * 読み全体を比較用に正規化する。
 *
 * 結果は濁点の取り外し有無ごとにメモする。
 */
function normalizeReading(
    value,
    settings = {}
) {
    const text =
        String(value ?? "");

    const memo =
        readingMemos[
            settings.removeMarks === true
                ? 1
                : 0
        ];

    const cached =
        memo.get(text);

    if (cached !== undefined) {
        return cached;
    }

    const result =
        computeNormalizedReading(
            text,
            settings
        );

    if (memo.size >= READING_MEMO_LIMIT) {
        memo.clear();
    }

    memo.set(
        text,
        result
    );

    return result;
}

/**
 * 読み全体の正規化(メモを使わない本体)。
 */
function computeNormalizedReading(
    value,
    settings = {}
) {
    const cleaned =
        cleanReading(value);

    return Array.from(cleaned)
        .map(character => {
            return normalizeCharacter(
                character,
                settings
            );
        })
        .join("");
}

/**
 * 入力単語の照合用文字列を作る。
 */
function normalizeWordValue(value) {
    return cleanReading(value)
        .toUpperCase();
}


/* =========================================================
   単語リスト取得
========================================================= */

/**
 * 設定から単語リストの種類を決める。
 *
 * countries : 国名
 * capitals  : 首都名
 * both      : 国名＋首都名
 */
function resolveWordMode(settings = {}) {
    const mode =
        settings.wordList ??
        settings.wordMode ??
        settings.list ??
        "countries";

    switch (mode) {
        case "capitals":
        case "capital":
        case "2":
            return "capitals";

        case "both":
        case "all":
        case "countries-capitals":
        case "3":
            return "both";

        case "countries":
        case "country":
        case "1":
        default:
            return "countries";
    }
}

/**
 * 設定に応じた単語索引を取得する。
 *
 * 初回だけ作り、以降は同じものを返す。
 *
 * words         : 単語の一覧(読み取り専用)
 * byFirstLetter : 頭文字 → 単語の一覧
 */
function getWordIndex(settings = {}) {
    const mode =
        resolveWordMode(settings);

    const removeMarks =
        settings.removeMarks === true;

    const key =
        `${mode}|${removeMarks}`;

    const cached =
        wordIndexCache.get(key);

    if (cached) {
        return cached;
    }

    let source;

    if (mode === "capitals") {
        source = capitals;
    } else if (mode === "both") {
        source = [
            ...countries,
            ...capitals
        ];
    } else {
        source = countries;
    }

    const words =
        Object.freeze([
            ...source
        ]);

    const byFirstLetter =
        new Map();

    const variantSettings = {
        removeMarks
    };

    for (const entry of words) {
        const first =
            getEntryInfo(
                entry,
                variantSettings
            )?.first ?? "";

        if (!first) {
            continue;
        }

        if (!byFirstLetter.has(first)) {
            byFirstLetter.set(
                first,
                []
            );
        }

        byFirstLetter
            .get(first)
            .push(entry);
    }

    const index = {
        mode,
        removeMarks,
        words,
        byFirstLetter
    };

    wordIndexCache.set(
        key,
        index
    );

    return index;
}

/**
 * 設定に応じた単語一覧を取得する。
 *
 * 戻り値は共有された読み取り専用のデータ。
 * 並べ替えや書き換えをしたい場合は、
 * [...getWords(settings)] のようにコピーして使うこと。
 */
function getWords(settings = {}) {
    return getWordIndex(
        settings
    ).words;
}

/**
 * 名前・読みから単語を探す検索表を取得する。
 *
 * 同じ名前・読みの単語が複数ある場合は、
 * 単語リストの中で最初のものを返す。
 */
function getWordLookup(mode) {
    const cached =
        lookupCache.get(mode);

    if (cached) {
        return cached;
    }

    let source;

    if (mode === "capitals") {
        source = capitals;
    } else if (mode === "both") {
        source = [
            ...countries,
            ...capitals
        ];
    } else {
        source = countries;
    }

    const lookup =
        new Map();

    for (const entry of source) {
        const keys = [
            normalizeWordValue(
                entry.name
            ),

            normalizeWordValue(
                entry.reading
            )
        ];

        for (const key of keys) {
            if (
                key &&
                !lookup.has(key)
            ) {
                lookup.set(
                    key,
                    entry
                );
            }
        }
    }

    lookupCache.set(
        mode,
        lookup
    );

    return lookup;
}

/**
 * 入力された単語を現在の単語リストから検索する。
 *
 * 国名・首都名の両方に同じ単語がある場合は、
 * 最初に見つかったデータを返す。
 *
 * 使用回数は読み全体で管理するため、
 * 重複ルールの判定には影響しない。
 */
function findWord(input, settings = {}) {
    const target =
        normalizeWordValue(input);

    if (!target) {
        return null;
    }

    return (
        getWordLookup(
            resolveWordMode(
                settings
            )
        ).get(target) ??
        null
    );
}


/* =========================================================
   単語の先頭・末尾
========================================================= */

/**
 * 単語リストにある単語の、事前計算済みの情報を返す。
 *
 * 単語リストにない値(文字列やクライアントから届いた
 * オブジェクト)の場合は null を返す。
 */
function getEntryInfo(
    entry,
    settings = {}
) {
    if (
        entry === null ||
        typeof entry !== "object"
    ) {
        return null;
    }

    return (
        entryInfoMaps[
            settings.removeMarks === true
                ? 1
                : 0
        ].get(entry) ??
        null
    );
}

/**
 * 単語の正規化済みの読みを返す。
 */
function getEntryReading(
    entry,
    settings = {}
) {
    const info =
        getEntryInfo(
            entry,
            settings
        );

    if (info) {
        return info.reading;
    }

    return normalizeReading(
        entry?.reading ??
        entry?.name ??
        "",
        settings
    );
}

/**
 * 単語の最初の文字を取得する。
 */
function getFirstLetter(
    wordOrEntry,
    settings = {}
) {
    const info =
        getEntryInfo(
            wordOrEntry,
            settings
        );

    if (info) {
        return info.first;
    }

    const reading =
        (
            wordOrEntry !== null &&
            typeof wordOrEntry === "object"
        )
            ? (
                wordOrEntry.reading ??
                wordOrEntry.name ??
                ""
            )
            : wordOrEntry;

    return (
        Array.from(
            normalizeReading(
                reading,
                settings
            )
        )[0] ?? ""
    );
}

/**
 * 単語の最後の有効文字を取得する。
 */
function getLastLetter(
    wordOrEntry,
    settings = {}
) {
    const info =
        getEntryInfo(
            wordOrEntry,
            settings
        );

    if (info) {
        return info.last;
    }

    const reading =
        (
            wordOrEntry !== null &&
            typeof wordOrEntry === "object"
        )
            ? (
                wordOrEntry.reading ??
                wordOrEntry.name ??
                ""
            )
            : wordOrEntry;

    const characters =
        Array.from(
            normalizeReading(
                reading,
                settings
            )
        );

    return (
        characters[
            characters.length - 1
        ] ?? ""
    );
}

/**
 * 「ン」で終わる単語か判定する。
 */
function endsWithN(
    wordOrEntry,
    settings = {}
) {
    return (
        getLastLetter(
            wordOrEntry,
            settings
        ) === "ン"
    );
}


/* =========================================================
   使用回数
========================================================= */

/**
 * 使用履歴から読みを取得する。
 *
 * 文字列とオブジェクトの両方に対応する。
 */
function getUsedReading(
    used,
    settings = {}
) {
    if (typeof used === "string") {
        return normalizeReading(
            used,
            settings
        );
    }

    if (
        !used ||
        typeof used !== "object"
    ) {
        return "";
    }

    return normalizeReading(
        used.reading ??
        used.name ??
        used.word ??
        "",
        settings
    );
}

/**
 * 同じ読みの単語が何回使用されたか返す。
 */
function countWordUses(
    entry,
    usedWords = [],
    settings = {}
) {
    const targetReading =
        getEntryReading(
            entry,
            settings
        );

    let count = 0;

    for (const used of usedWords) {
        if (
            getUsedReading(
                used,
                settings
            ) === targetReading
        ) {
            count += 1;
        }
    }

    return count;
}

/**
 * 従来コードとの互換性用。
 *
 * 1回以上使われていればtrueを返す。
 */
function isUsedWord(
    entry,
    usedWords = [],
    settings = {}
) {
    return (
        countWordUses(
            entry,
            usedWords,
            settings
        ) > 0
    );
}

/**
 * 国名と首都名の両方にある読みの集合を返す。
 *
 * 濁点の取り外し有無ごとに、初回だけ作る。
 */
function getDuplicateReadingSet(
    settings = {}
) {
    const variant =
        settings.removeMarks === true
            ? 1
            : 0;

    if (duplicateReadingSets[variant]) {
        return duplicateReadingSets[variant];
    }

    const variantSettings = {
        removeMarks:
            variant === 1
    };

    const countryReadings =
        new Set(
            countries.map(word => {
                return getEntryReading(
                    word,
                    variantSettings
                );
            })
        );

    const duplicates =
        new Set();

    for (const word of capitals) {
        const reading =
            getEntryReading(
                word,
                variantSettings
            );

        if (countryReadings.has(reading)) {
            duplicates.add(reading);
        }
    }

    duplicateReadingSets[variant] =
        duplicates;

    return duplicates;
}

/**
 * 国名と首都名の両方に存在する読みか判定する。
 */
function isCountryCapitalDuplicate(
    entry,
    settings = {}
) {
    return getDuplicateReadingSet(
        settings
    ).has(
        getEntryReading(
            entry,
            settings
        )
    );
}

/**
 * 即負けにならずに使用できる回数を返す。
 *
 * 通常の単語:
 * 1回目は安全
 * 2回目で即負け
 *
 * 国名・首都名で同じ単語を2回使える設定:
 * 1回目と2回目は安全
 * 3回目で即負け
 */
function getSafeUseLimit(
    entry,
    settings = {}
) {
    const canUseTwice =
        settings.wordList === "both" &&
        settings.duplicateRule ===
            "separate" &&
        isCountryCapitalDuplicate(
            entry,
            settings
        );

    return canUseTwice ? 2 : 1;
}

/**
 * この単語を今言うと、
 * 重複回数によって即負けになるか判定する。
 */
function willLoseByDuplicate(
    entry,
    usedWords = [],
    settings = {}
) {
    const usedCount =
        countWordUses(
            entry,
            usedWords,
            settings
        );

    const safeLimit =
        getSafeUseLimit(
            entry,
            settings
        );

    return usedCount >= safeLimit;
}


/* =========================================================
   「ン」の即負け判定
========================================================= */

/**
 * この単語を今言うと、
 * 「ン」のルールで即負けになるか判定する。
 *
 * nRule:
 *
 * lose:
 *   「ン」で終わった時点で負け
 *
 * once:
 *   対局全体の1回目は安全
 *   2回目以降は負け
 *
 * unlimited:
 *   何回でも安全
 */
function willLoseByN(
    entry,
    nEndCount = 0,
    settings = {}
) {
    if (!endsWithN(entry, settings)) {
        return false;
    }

    const nRule =
        settings.nRule ?? "lose";

    if (nRule === "lose") {
        return true;
    }

    if (
        nRule === "once" &&
        Number(nEndCount) >= 1
    ) {
        return true;
    }

    return false;
}

/**
 * 今言うと即負けになる理由を返す。
 */
function getImmediateLossReasons(
    entry,
    usedWords = [],
    nEndCount = 0,
    settings = {}
) {
    const reasons = [];

    if (
        willLoseByDuplicate(
            entry,
            usedWords,
            settings
        )
    ) {
        const safeLimit =
            getSafeUseLimit(
                entry,
                settings
            );

        reasons.push(
            safeLimit === 2
                ? "同じ単語の3回目"
                : "同じ単語の2回目"
        );
    }

    if (
        willLoseByN(
            entry,
            nEndCount,
            settings
        )
    ) {
        reasons.push(
            settings.nRule === "once"
                ? "2回目の「ン」終了"
                : "「ン」で終了"
        );
    }

    return reasons;
}


/* =========================================================
   使用可能単語
========================================================= */

/**
 * 指定文字で始まる単語を取得する。
 *
 * 即負けになる単語も候補として返す。
 * 初心者ガイドではimmediateLossを付けて警告する。
 */
function getAvailableWords(
    currentLetter,
    usedWords = [],
    settings = {}
) {
    const requiredLetter =
        normalizeCharacter(
            currentLetter,
            settings
        );

    if (!requiredLetter) {
        return [];
    }

    const entries =
        getWordIndex(
            settings
        ).byFirstLetter.get(
            requiredLetter
        );

    return entries
        ? entries.slice()
        : [];
}

/**
 * 即負けにならずに使用できる単語を取得する。
 *
 * CPUの手の選択などで利用できる。
 */
function getSafeAvailableWords(
    currentLetter,
    usedWords = [],
    nEndCount = 0,
    settings = {}
) {
    return getAvailableWords(
        currentLetter,
        usedWords,
        settings
    ).filter(entry => {
        const reasons =
            getImmediateLossReasons(
                entry,
                usedWords,
                nEndCount,
                settings
            );

        return reasons.length === 0;
    });
}

/**
 * 現在の文字から何らかの単語を言えるか判定する。
 *
 * 即負けになる単語も「言える単語」には含む。
 */
function hasAvailableMove(
    currentLetter,
    usedWords = [],
    settings = {}
) {
    return (
        getAvailableWords(
            currentLetter,
            usedWords,
            settings
        ).length > 0
    );
}

/**
 * 即負けせずに言える単語があるか判定する。
 */
function hasSafeAvailableMove(
    currentLetter,
    usedWords = [],
    nEndCount = 0,
    settings = {}
) {
    return (
        getSafeAvailableWords(
            currentLetter,
            usedWords,
            nEndCount,
            settings
        ).length > 0
    );
}


/* =========================================================
   特殊しりとり
========================================================= */
/**
 * 特殊ルールで、末尾から先頭へ調べ、
 * 「未使用かつ即負けにならずに続けられる単語」が
 * 存在する最も後ろの文字を返す。
 *
 * 例:
 *
 * ダイカンミンコク
 *      ↓
 * クックショトウ
 *      ↓
 * ウガンダ
 *
 * 「ウガンダ」の文字を後ろから調べると、
 *
 * ダ:
 *   ダイカンミンコクしかない
 *   → 既に使用済みなので不可
 *
 * ン:
 *   ンから始まる国名がない
 *   → 不可
 *
 * ガ:
 *   未使用のガ始まりの国名がある
 *   → 「ガ」で続ける
 *
 * となる。
 */
/**
 * 特殊ルールで、末尾から先頭へ調べ、
 * 「実際にその文字から安全に着手できる単語」が
 * 存在する最も後ろの文字を返す。
 *
 * 例:
 *
 * ダイカンミンコク
 *      ↓
 * クックショトウ
 *      ↓
 * ウガンダ
 *
 * 「ウガンダ」の文字を後ろから調べると、
 *
 * ダ:
 *   ダイカンミンコクしかない
 *   → 既に使用済み
 *   → 不可
 *
 * ン:
 *   ンから始まる国名がない
 *   → 不可
 *
 * ガ:
 *   未使用のガ始まりの国名がある
 *   → 「ガ」で続ける
 *
 * となる。
 */
function findSpecialNextLetter(
    wordOrEntry,
    usedWords = [],
    settings = {},
    nEndCount = 0
) {
    const entry =
        typeof wordOrEntry === "object"
            ? wordOrEntry
            : findWord(
                wordOrEntry,
                settings
            );

    const reading =
        entry
            ? (
                entry.reading ??
                entry.name ??
                ""
            )
            : wordOrEntry;

    const normalized =
        normalizeReading(
            reading,
            settings
        );

    const characters =
        Array.from(normalized);

    /*
     * 末尾から先頭へ調べる。
     *
     * 重要:
     * getAvailableWords() ではなく
     * getSafeAvailableWords() を使う。
     *
     * これにより、
     *
     * ・既に使用済み
     * ・重複使用で即負け
     * ・「ン」で即負け
     *
     * の単語しかない文字は
     * 「続けられる文字」と判定しない。
     */
    for (
        let index =
            characters.length - 1;
        index >= 0;
        index -= 1
    ) {
        const candidateLetter =
            normalizeCharacter(
                characters[index],
                settings
            );

        if (!candidateLetter) {
            continue;
        }

        const candidates =
            getSafeAvailableWords(
                candidateLetter,
                usedWords,
                nEndCount,
                settings
            );

        /*
         * 実際に使用可能な単語が1つでもあれば、
         * その文字を採用する。
         */
        if (candidates.length > 0) {
            return candidateLetter;
        }
    }

    /*
     * どの文字からも安全に続けられない。
     */
    return "";
}/**
 * 次に接続する文字を返す。
 */
function getNextLetter(
    wordOrEntry,
    settings = {},
    usedWords = [],
    nEndCount = 0
) {
    const rule =
        settings.rule ??
        settings.shiritoriRule ??
        "normal";

    if (
        rule === "special" ||
        rule === "2"
    ) {
        return findSpecialNextLetter(
            wordOrEntry,
            usedWords,
            settings,
            nEndCount
        );
    }

    return getLastLetter(
        wordOrEntry,
        settings
    );
}

/* =========================================================
   入力検証
========================================================= */

/**
 * 入力された手を検証する。
 *
 * 重複や「ン」終了は不正な入力にはしない。
 * 入力受付後に即負けとして判定する。
 */
function validateMove({
    word,
    currentLetter,
    usedWords = [],
    settings = {}
}) {
    const input =
        String(word ?? "").trim();

    if (!input) {
        return {
            valid: false,
            reason:
                "単語を入力してください。"
        };
    }

    const entry =
        findWord(
            input,
            settings
        );

    if (!entry) {
        return {
            valid: false,
            reason:
                "選択中の単語リストに載っていない単語です。"
        };
    }

    const requiredLetter =
        normalizeCharacter(
            currentLetter,
            settings
        );

    const firstLetter =
        getFirstLetter(
            entry,
            settings
        );

    if (
        requiredLetter &&
        firstLetter !== requiredLetter
    ) {
        return {
            valid: false,

            reason:
                `「${requiredLetter}」から始まる単語を入力してください。`,

            requiredLetter,
            actualLetter:
                firstLetter
        };
    }

    return {
        valid: true,
        reason: "",

        word:
            entry.name,

        entry,

        reading:
            entry.reading,

        firstLetter,

        lastLetter:
            getLastLetter(
                entry,
                settings
            ),

        usedCount:
            countWordUses(
                entry,
                usedWords,
                settings
            ),

        safeUseLimit:
            getSafeUseLimit(
                entry,
                settings
            )
    };
}


/* =========================================================
   開始文字
========================================================= */

/**
 * 使用できる単語が存在する開始文字を
 * ランダムに返す。
 *
 * 開始文字として「ン」は選ばない。
 */
function randomStartLetter(settings = {}) {
    const letters = [];

    for (
        const letter
        of getWordIndex(
            settings
        ).byFirstLetter.keys()
    ) {
        if (letter !== "ン") {
            letters.push(letter);
        }
    }

    if (letters.length === 0) {
        return "";
    }

    return letters[
        Math.floor(
            Math.random() *
            letters.length
        )
    ];
}


/* =========================================================
   ゲーム終了判定
========================================================= */

/**
 * 現在の文字から単語が存在するか判定する。
 *
 * 即負け単語も入力可能であるため、
 * 候補が1つでもあればgameOverはfalse。
 */
function checkGameOver({
    currentLetter,
    usedWords = [],
    settings = {}
}) {
    if (!currentLetter) {
        return {
            gameOver: true,
            reason:
                "続けられる文字がありません。",
            availableWords: []
        };
    }

    const availableWords =
        getAvailableWords(
            currentLetter,
            usedWords,
            settings
        );

    if (availableWords.length === 0) {
        return {
            gameOver: true,

            reason:
                `「${currentLetter}」から始まる単語がありません。`,

            availableWords: []
        };
    }

    return {
        gameOver: false,
        reason: "",
        availableWords
    };
}


/* =========================================================
   初心者ガイド
========================================================= */

/**
 * 初心者ガイド用の単語一覧を返す。
 *
 * immediateLossがtrueの場合、
 * その単語を今言うと即負けになる。
 */
function getGuideWords(
    currentLetter,
    usedWords = [],
    settings = {},
    nEndCount = 0
) {
    return getAvailableWords(
        currentLetter,
        usedWords,
        settings
    ).map(entry => {
        const useCount =
            countWordUses(
                entry,
                usedWords,
                settings
            );

        const safeUseLimit =
            getSafeUseLimit(
                entry,
                settings
            );

        const lossReasons =
            getImmediateLossReasons(
                entry,
                usedWords,
                nEndCount,
                settings
            );

        return {
            id:
                entry.id,

            name:
                entry.name,

            reading:
                entry.reading,

            type:
                entry.type,

            useCount,

            safeUseLimit,

            remainingSafeUses:
                Math.max(
                    0,
                    safeUseLimit -
                    useCount
                ),

            immediateLoss:
                lossReasons.length > 0,

            lossReasons,

            endsWithN:
                endsWithN(
                    entry,
                    settings
                ),

            countryCapitalDuplicate:
                isCountryCapitalDuplicate(
                    entry,
                    settings
                )
        };
    });
}


/* =========================================================
   単語リスト再読み込み
========================================================= */

/**
 * TXTファイルを読み直す。
 *
 * 索引と事前計算データも作り直される。
 * cpu.jsが保持しているexact-solverは古いままなので、
 * 呼び出し後にcpu.clearAnalysisCache()も呼ぶこと。
 */
function reloadWords() {
    loadWordFiles();

    return {
        countries:
            countries.length,

        capitals:
            capitals.length
    };
}


/* =========================================================
   エクスポート
========================================================= */

module.exports = {
    hiraganaToKatakana,
    cleanReading,
    normalizeCharacter,
    normalizeReading,

    getWords,
    findWord,

    getFirstLetter,
    getLastLetter,
    endsWithN,

    getUsedReading,
    countWordUses,
    isUsedWord,

    isCountryCapitalDuplicate,
    getSafeUseLimit,

    willLoseByDuplicate,
    willLoseByN,
    getImmediateLossReasons,

    getAvailableWords,
    getSafeAvailableWords,
    hasAvailableMove,
    hasSafeAvailableMove,

    findSpecialNextLetter,
    getNextLetter,

    validateMove,
    randomStartLetter,
    checkGameOver,

    getGuideWords,
    reloadWords
};