// Abuse screen for custom video domains: set_custom_domain refuses (HOSTNAME_NEEDS_REVIEW) a hostname that could pass
// for a bank, a payment or sign-in page, a big brand or Recitbot itself, so it gets a manual review first.
//
// Every label left of the public suffix (so the registrable domain's own label too, and never the TLD: .td is Chad) is
// checked after: punycode -> Unicode, accents dropped, Cyrillic / Greek look-alikes mapped to Latin, lowercase; then
// again with the digit and letter-pair homoglyphs folded (0->o, 1->l or i, 3->e, 5->s, rn->m, vv->w). Each label is
// split on hyphens into words. Distinctive names match anywhere in the label (hyphens dropped: "pay-pal", "mypaypal");
// short or everyday ones only as a whole word, or two adjacent words joined ("sign-in"), so "td" never blocks "studio"
// and "chase" never blocks "purchase". A punycode label that mixes scripts, or is written wholly in Cyrillic or Greek
// letters that all look Latin, is blocked whatever it spells.
import { parse } from "tldts";

/** Anywhere in a label (hyphens removed). Long, distinctive names only: no everyday word contains them. */
const PARTS = [
  "paypal",
  "icloud",
  "google",
  "gmail",
  "microsoft",
  "outlook",
  "office365",
  "amazon",
  "netflix",
  "facebook",
  "instagram",
  "whatsapp",
  "coinbase",
  "binance",
  "metamask",
  "banking",
  "wellsfargo",
  "citibank",
  "hsbc",
  "scotiabank",
  "mastercard",
  "craarc",
  "login",
  "logon",
  "helpdesk",
  "recitbot",
];

/** A whole word, or two adjacent words joined. Short or everyday names that sit inside harmless words. */
const WORDS = [
  "stripe",
  "apple",
  "aws",
  "meta",
  "bank",
  "chase",
  "citi",
  "rbc",
  "td",
  "bmo",
  "cibc",
  "interac",
  "visa",
  "amex",
  "irs",
  "gov",
  "signin",
  "signon",
  "account",
  "accounts",
  "myaccount",
];

/** The start of a word (or of two adjacent words joined): "verify", "verification", "securelogin", "walletconnect". */
const PREFIXES = ["verif", "secure", "wallet"];

/** Labels like support-paypal, support-billing: the usual fake help-desk shape. */
const SUPPORT_LABEL = /^support-/;

/** Cyrillic and Greek letters that pass for Latin ones (lowercase; uppercase is folded first). */
const LOOKALIKE: Record<string, string> = {
  // Cyrillic
  "а": "a", "б": "b", "в": "b", "г": "r", "е": "e", "ё": "e", "з": "3", "и": "u", "к": "k", "м": "m", "н": "h", "о": "o",
  "п": "n", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ь": "b", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "һ": "h",
  "ԁ": "d", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ɡ": "g", "ү": "y", "ҽ": "e", "ԍ": "g",
  // Greek
  "α": "a", "β": "b", "γ": "y", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u",
  "χ": "x", "ω": "w", "ϲ": "c", "ϳ": "j",
  // Latin letters that pass for others
  "ı": "i", "ɩ": "i", "ɑ": "a", "ʟ": "l", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ŀ": "l",
};

/** Letters near-identical to a Latin one: a label made only of these (and digits / hyphens) is a whole-script fake. */
const STRONG_LOOKALIKES = new Set([..."аеорсухіјѕһԁӏԛԝү", ..."αονικρτυχεϲω"]);

/** Scripts told apart for the mixed-script rule. Han, kana and Hangul count as one (Japanese mixes them). */
const SCRIPTS: [string, RegExp][] = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Georgian", /\p{Script=Georgian}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
  ["Cherokee", /\p{Script=Cherokee}/u],
  ["CJK", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
];
const COMMON = /[\p{Script=Common}\p{Script=Inherited}]/u;

function scriptOf(ch: string): string | null {
  if (COMMON.test(ch)) return null;
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
  return `other-${ch.codePointAt(0)! >> 7}`; // some other script: its 128-code-point block stands in for it
}

// ---------- punycode (RFC 3492 decode only) ----------

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / 700) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + 38));
}

/** The Unicode form of a punycode label's payload (after "xn--"), or null when it isn't valid punycode. */
export function punycodeDecode(input: string): string | null {
  const out: number[] = [];
  const dash = input.lastIndexOf("-");
  const basicEnd = dash < 0 ? 0 : dash;
  for (let j = 0; j < basicEnd; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let idx = dash < 0 ? 0 : dash + 1; idx < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const c = input.charCodeAt(idx++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : BASE;
      if (digit >= BASE) return null;
      i += digit * w;
      if (i > 0x7fffffff) return null;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return null;
    out.splice(i, 0, n);
    i++;
  }
  try {
    return String.fromCodePoint(...out);
  } catch {
    return null;
  }
}

// ---------- matching ----------

/** Lowercase, accents dropped, look-alike letters mapped to Latin. Anything else is kept as it is. */
function latinFold(s: string): string {
  return [...s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")].map((c) => LOOKALIKE[c] ?? c).join("");
}

/** The digit / letter-pair homoglyph readings of an ASCII-ish label (1 reads as l and as i). */
function homoglyphFolds(s: string): string[] {
  const base = s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/0/g, "o").replace(/3/g, "e").replace(/5/g, "s");
  return [...new Set([base.replace(/1/g, "l"), base.replace(/1/g, "i")])].filter((v) => v !== s);
}

/** The listed name this label spells, or null. */
function nameIn(label: string): string | null {
  const words = label.split("-").filter(Boolean);
  const pairs = words.slice(1).map((w, k) => words[k] + w);
  const whole = [...words, ...pairs];
  const joined = words.join("");
  return (
    PARTS.find((p) => joined.includes(p)) ??
    WORDS.find((w) => whole.includes(w)) ??
    PREFIXES.find((p) => whole.some((w) => w.startsWith(p))) ??
    null
  );
}

/** Why one label (ASCII, as stored) can't be used, or null. */
function labelReason(label: string): string | null {
  let text = label;
  if (label.startsWith("xn--")) {
    const decoded = punycodeDecode(label.slice(4));
    if (decoded === null) return `"${label}" isn't a readable international name`;
    text = decoded;
    const scripts = new Set([...decoded].map(scriptOf).filter((s): s is string => s !== null));
    if (scripts.size > 1) return `"${decoded}" mixes ${[...scripts].sort().join(" and ")} letters`;
    const letters = [...decoded].filter((c) => !COMMON.test(c));
    const script = [...scripts][0];
    if ((script === "Cyrillic" || script === "Greek") && letters.length && letters.every((c) => STRONG_LOOKALIKES.has(c.toLowerCase()))) {
      return `"${decoded}" is written in ${script} letters that look like Latin ones`;
    }
  }
  if (SUPPORT_LABEL.test(text)) return `"${text}" looks like a help desk`;
  const folded = latinFold(text);
  const direct = nameIn(folded);
  if (direct) return folded === text ? `it contains "${direct}"` : `"${text}" looks like "${direct}"`;
  for (const v of homoglyphFolds(folded)) {
    const name = nameIn(v);
    if (name) return `"${text}" looks like "${name}"`;
  }
  return null;
}

/**
 * Why `hostname` (already normalised: lowercase ASCII, IDN as punycode, no trailing dot) needs a manual review before it
 * can be used, as a short plain-English reason; null when it may be used.
 */
export function hostnameBlockedReason(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  const p = parse(h, { extractHostname: false });
  const suffixLabels = p.publicSuffix ? p.publicSuffix.split(".").length : 1;
  const labels = h.split(".");
  for (const label of labels.slice(0, Math.max(labels.length - suffixLabels, 1))) {
    const why = labelReason(label);
    if (why) return why;
  }
  return null;
}
