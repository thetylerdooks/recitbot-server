// Self-host literal guard: fails when an operator-specific value (a hosted deployment's domains, Cloudflare ids, Stripe
// ids or keys, Turnstile or Resend keys, contact addresses, account ids, people's or companies' names) appears in anything
// that is part of the public server: the Worker with its tests and migrations, the scripts, the docs, the committed configs
// and the recorder releases' text files. Those values belong in each deployment's own git-ignored worker/wrangler.jsonc and
// secrets (SELFHOST_CONFIG.md). Only generic patterns live here, never a real value, and they are written so that this file
// passes its own scan.
// Usage: npm run check:literals                                 (the scope below)
//        node scripts/check-selfhost-literals.mjs --dir <path>  (every text file under <path>, e.g. a server snapshot)
// Prints file:line and the rule name only, never the matched text.
// worker/test/selfhost-literals.test.ts runs the same scanText over the same scope.

/** Rule name -> pattern (global, so every match is reported). */
export const RULES = [
  ["operator name", /tyler[\s._-]*dooks|\btdooks\b/gi],
  ["operator company name", /\bpersonal\s+brand\s+corp|\bP[B]C\b/gi],
  ["numbered company name", /\b\d{6,8}\s+[A-Z][A-Za-z. ]{2,40}?\s(?:Ltd|Limited|Inc|Incorporated|Corp)\b/g],
  [
    "regional company name",
    /\bA[l]berta\b[^\n]{0,60}\b(?:Ltd|Limited|Inc|Incorporated|Corp|Corporation)\b|\b(?:Ltd|Limited|Inc|Incorporated|Corp|Corporation)\b[^\n]{0,60}\bA[l]berta\b/gi,
  ],
  ["hosted domain", /\b(?:[a-z0-9-]+\.)*recitbot\.com\b/gi],
  ["hosted Worker/resource name", /agent-recorder[-]demo/gi],
  ["account's workers.dev host", /\b[a-z0-9-]+\.(?!example\b|<)[a-z0-9-]+\.workers\.dev\b/gi],
  ["bot template link", /x\.ai\/bot\//gi],
  ["Stripe object id", /\b(?:price|prod|bpc|cus|sub|pi|cs|in|acct|we|evt)_(?:(?:test|live)_)?(?!PLACEHOLDER)[A-Za-z0-9]{10,}/g],
  ["Stripe API key", /\b(?:sk|pk|rk)_(?:live|test)_/g],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]/g],
  ["Resend API key", /\bre_[A-Za-z0-9]{20,}/g],
  ["Turnstile key", /\b0x4A{4}[A-Za-z0-9_-]+/g],
  // Cloudflare's documented test keys (always pass / always block / force interactive) are the only ones allowed.
  ["Turnstile-shaped key", /\b(?!(?:[123]x0{20}(?:AA|AB|BB|FF)|[123]x0{31}AA)\b)[1-9]x0{4}[0-9A-Za-z_-]{16,}/g],
  ["32-hex id (Cloudflare account/zone/D1)", /\b[0-9a-f]{32}\b/g],
  ["D1 database id (uuid)", /"database_id"\s*:\s*"[0-9a-f]{8}-[0-9a-f-]{27}"/g],
  ["operator email address", /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*(?:tyler-?dooks|recitbot)\.[A-Za-z]{2,}/gi],
  // Windows' default computer names; DESKTOP-EXAMPLE is the made-up one tests use.
  ["Windows default hostname", /\bDESKTOP-(?!EXAMPLE\b)[A-Z0-9]{7}\b/g],
  ["developer machine path", /\b[A-Z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)\w+/gi],
];

/** Also in migrations: an id in quotes (an account, device or recording of one deployment). */
export const SQL_RULES = [["account or device id in SQL", /'[A-Za-z0-9_-]{20,}'/g]];

/** Also for worker/home pages (scripts/sync-home.mjs): where the operator is named, only a marker may stand. */
export const HOME_RULES = [
  ["homepage: contact address not a marker", /mailto:(?!\{\{)/g],
  ["homepage: footer operator not a marker", /Built by (?!<a href="\{\{OPERATOR_URL\}\}"[^>]*>\{\{OPERATOR_NAME\}\}<)/g],
  ["homepage: copyright holder not a marker", /©\s*\d{4}\s+(?!\{\{)/g],
  ["homepage: card statement line not a marker", /card statement as "(?!\{\{)/g],
];

/**
 * Harmless matches, by exact file (repo-relative, forward slashes) and rule, each with its reason. Add an entry only for a
 * value that is not operator-specific.
 * @type {{ file: string; rule: string; reason: string }[]}
 */
export const ALLOW = [
  // The license names its licensor, as it must; the text is verbatim. Nowhere else may that name appear.
  { file: "LICENSE", rule: "numbered company name", reason: "the licensor's legal name in the verbatim license text" },
  { file: "LICENSE", rule: "regional company name", reason: "the licensor's legal name in the verbatim license text" },
  // The public GitHub organization that publishes this repo and the recorder releases is named in the README and the Directory skills; that is not a private deployment value.
  { file: "README.md", rule: "operator name", reason: "the public GitHub organization that publishes this repo and the recorder releases" },
  { file: "skills/recitbot-selfhost-getting-started/SKILL.md", rule: "operator name", reason: "the public GitHub organization that publishes this repo and the recorder releases" },
  { file: "skills/recitbot-selfhost-playbook/SKILL.md", rule: "operator name", reason: "the public GitHub organization that publishes this repo and the recorder releases" },
];

/** What the public server is made of (repo-relative): everything under the directories, and the files. */
export const SCAN = {
  dirs: ["worker", "scripts", "docs", "recorder/release", "recorder-mac", "skills"],
  files: ["README.md", "SELFHOST_CONFIG.md", "LICENSE", "package.json", "package-lock.json", ".gitignore", ".gitattributes", ".gitleaks.toml", "mcp.json"],
};

/** Never scanned: files that are git-ignored (so never in the public server): build output and a deployment's own files. */
export const isExcluded = (file) =>
  /(?:^|\/)(?:node_modules|\.wrangler|\.git)\//.test(file) ||
  /^worker\/(?:public|home)\//.test(file) ||
  /^worker\/src\/generated[^/]*\.ts$/.test(file) ||
  file === "worker/wrangler.jsonc" ||
  (/^worker\/\.dev\.vars/.test(file) && file !== "worker/.dev.vars.example");

/** Every rule violation in one file's text: [{ file, line, rule }]. */
export function scanText(file, text) {
  const out = [];
  const rules = [...RULES, ...(file.endsWith(".sql") ? SQL_RULES : []), ...(file.startsWith("worker/home/") ? HOME_RULES : [])];
  for (const [rule, re] of rules) {
    if (ALLOW.some((a) => a.file === file && a.rule === rule)) continue;
    for (const m of text.matchAll(re)) {
      out.push({ file, line: text.slice(0, m.index).split("\n").length, rule });
    }
  }
  return out;
}

async function main(argv) {
  const { readdirSync, readFileSync, statSync, existsSync } = await import("node:fs");
  const { dirname, join, relative, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const at = argv.indexOf("--dir");
  if (at >= 0 && !(argv[at + 1] && existsSync(argv[at + 1]))) {
    console.error("check:literals: --dir needs an existing directory");
    process.exit(2);
  }
  const wholeDir = at >= 0;
  const root = wholeDir ? resolve(argv[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rel = (f) => relative(root, f).replaceAll("\\", "/");
  const walk = (dir) =>
    readdirSync(dir).flatMap((n) => {
      const f = join(dir, n);
      // --dir scans everything (a snapshot must not hold ignored files either); only git's own and npm's folders are skipped.
      if (wholeDir ? n === ".git" || n === "node_modules" : isExcluded(rel(f)) || isExcluded(`${rel(f)}/`)) return [];
      return statSync(f).isDirectory() ? walk(f) : [f];
    });
  if (!wholeDir) {
    const missing = [...SCAN.dirs, ...SCAN.files].filter((f) => !existsSync(join(root, f)));
    if (missing.length) {
      console.error(`check:literals: missing ${missing.join(", ")}`);
      process.exit(1);
    }
  }
  const files = wholeDir ? walk(root) : [...SCAN.dirs.flatMap((d) => walk(join(root, d))), ...SCAN.files.map((f) => join(root, f))];
  let binary = 0;
  const found = files.flatMap((f) => {
    const buf = readFileSync(f);
    if (buf.subarray(0, 8192).includes(0)) {
      binary++;
      return [];
    }
    return scanText(rel(f), buf.toString("utf8"));
  });
  if (found.length) {
    console.error(`check:literals: ${found.length} operator-specific value(s) found (move them to config, SELFHOST_CONFIG.md):`);
    for (const v of found) console.error(`  ${v.file}:${v.line}  ${v.rule}`);
    process.exit(1);
  }
  console.log(`check:literals: ${files.length - binary} text files clean (${binary} binary files not scanned)`);
}

if (typeof process !== "undefined" && process.argv?.[1] && /check-selfhost-literals\.mjs$/.test(process.argv[1].replaceAll("\\", "/"))) {
  await main(process.argv.slice(2));
}
