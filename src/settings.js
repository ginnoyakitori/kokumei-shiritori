"use strict";

/* =========================================================
   設定の正規化(唯一の定義)

   サーバー・マッチング・解析・exact-solver は
   すべてこのモジュールを通して設定を解釈する。
========================================================= */

const WORD_LISTS = Object.freeze([
    "countries",
    "capitals",
    "both"
]);

const RULES = Object.freeze([
    "normal",
    "special"
]);

const N_RULES = Object.freeze([
    "lose",
    "once",
    "unlimited"
]);

const DUPLICATE_RULES = Object.freeze([
    "once",
    "separate"
]);

const CPU_LEVELS = Object.freeze([
    "easy",
    "normal",
    "hard"
]);

/* 旧形式・別名の値 */
const WORD_LIST_ALIASES = new Map([
    ["1", "countries"],
    ["country", "countries"],
    ["2", "capitals"],
    ["capital", "capitals"],
    ["3", "both"],
    ["all", "both"],
    ["countries-capitals", "both"]
]);

const RULE_ALIASES = new Map([
    ["1", "normal"],
    ["2", "special"]
]);

const NO_ALIASES = new Map();

/*
 * マッチング相手の判定に使う、
 * 「対局のルールを決める」設定項目。
 * cpuLevel と guideEnabled は個人の設定なので含めない。
 */
const RULE_KEYS = Object.freeze([
    "wordList",
    "removeMarks",
    "nRule",
    "rule",
    "duplicateRule"
]);


/* =========================================================
   基本関数
========================================================= */

function toBoolean(value) {
    return (
        value === true ||
        value === "true" ||
        value === 1 ||
        value === "1"
    );
}

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

/**
 * 値を許可リストの中の値へ変換する。
 * 別名があれば変換し、該当しなければ fallback を返す。
 */
function pickEnum(
    value,
    allowed,
    aliases,
    fallback
) {
    if (
        typeof value !== "string" &&
        typeof value !== "number"
    ) {
        return fallback;
    }

    const key =
        String(value);

    const resolved =
        aliases.get(key) ??
        key;

    return allowed.includes(resolved)
        ? resolved
        : fallback;
}


/* =========================================================
   設定の正規化
========================================================= */

/**
 * 任意の入力から、安全で矛盾のない設定を作る。
 *
 * 何度通しても結果は変わらない(冪等)。
 *
 * ルール間の制約:
 *   nRule "once"      : 国名のみでは選べない(国名のみ → lose)
 *   nRule "unlimited" : 特殊ルールでのみ選べる(通常ルール → lose)
 *   duplicateRule     : 「国名と首都名」のときだけ有効(それ以外は once)
 */
function normalizeSettings(rawSettings) {
    const raw =
        isPlainObject(rawSettings)
            ? rawSettings
            : {};

    const wordList =
        pickEnum(
            raw.wordList ??
            raw.wordMode ??
            raw.list,
            WORD_LISTS,
            WORD_LIST_ALIASES,
            "countries"
        );

    const rule =
        pickEnum(
            raw.rule ??
            raw.shiritoriRule,
            RULES,
            RULE_ALIASES,
            "normal"
        );

    /*
     * 旧クライアントは allowN だけを送る。
     * nRule がない場合のみ、allowN を変換する。
     */
    let rawNRule =
        raw.nRule;

    if (
        rawNRule === undefined ||
        rawNRule === null ||
        rawNRule === ""
    ) {
        rawNRule =
            toBoolean(raw.allowN)
                ? "unlimited"
                : "lose";
    }

    let nRule =
        pickEnum(
            rawNRule,
            N_RULES,
            NO_ALIASES,
            "lose"
        );

    if (
        nRule === "once" &&
        wordList === "countries"
    ) {
        nRule = "lose";
    }

    if (
        nRule === "unlimited" &&
        rule !== "special"
    ) {
        nRule = "lose";
    }

    const duplicateRule =
        wordList === "both"
            ? pickEnum(
                raw.duplicateRule,
                DUPLICATE_RULES,
                NO_ALIASES,
                "once"
            )
            : "once";

    return {
        wordList,

        removeMarks:
            toBoolean(
                raw.removeMarks
            ),

        /* 旧logic.js互換用(nRuleから導出) */
        allowN:
            nRule !== "lose",

        nRule,
        rule,
        duplicateRule,

        cpuLevel:
            pickEnum(
                raw.cpuLevel,
                CPU_LEVELS,
                NO_ALIASES,
                "easy"
            ),

        guideEnabled:
            toBoolean(
                raw.guideEnabled
            )
    };
}

/**
 * 対局のルールに関わる項目だけを取り出す。
 * cpuLevel / guideEnabled は含まない。
 */
function pickRuleSettings(settings) {
    const normalized =
        normalizeSettings(
            settings
        );

    return {
        wordList:
            normalized.wordList,

        removeMarks:
            normalized.removeMarks,

        allowN:
            normalized.allowN,

        nRule:
            normalized.nRule,

        rule:
            normalized.rule,

        duplicateRule:
            normalized.duplicateRule
    };
}

/**
 * 解析・exact-solver向け。
 * 正規化したうえで、ルール項目だけを返す。
 */
function normalizeRuleSettings(rawSettings) {
    return pickRuleSettings(
        rawSettings
    );
}

/**
 * マッチング相手を判定するキー。
 * ルール項目が同じなら同じ文字列になる。
 */
function createMatchKey(rawSettings) {
    const settings =
        normalizeSettings(
            rawSettings
        );

    return RULE_KEYS
        .map(key => {
            return `${key}:${settings[key]}`;
        })
        .join("|");
}


module.exports = {
    WORD_LISTS,
    RULES,
    N_RULES,
    DUPLICATE_RULES,
    CPU_LEVELS,
    RULE_KEYS,

    toBoolean,

    normalizeSettings,
    normalizeRuleSettings,
    pickRuleSettings,
    createMatchKey
};