// The self-host literal guard (scripts/check-selfhost-literals.mjs, `npm run check:literals`) inside the test suite: no
// operator-specific value in anything that is part of the public server. The workers pool can't read files, so Vite's
// import.meta.glob brings them in as text (all but this file itself, which glob leaves out and the script scans).
import { describe, expect, it } from "vitest";
import { ALLOW, HOME_RULES, isExcluded, RULES, scanText, SQL_RULES } from "../../scripts/check-selfhost-literals.mjs";

/** "./x" is here (worker/test), "../x" in worker/, "../../x" at the repo root. */
const repoPath = (p: string) =>
  p.startsWith("../../") ? p.slice(6) : p.startsWith("../") ? `worker/${p.slice(3)}` : `worker/test/${p.replace(/^\.\//, "")}`;
const load = (files: Record<string, unknown>) =>
  Object.entries(files)
    .map(([path, text]) => ({ file: repoPath(path), text: String(text) }))
    .filter((f) => !isExcluded(f.file));

const files = [
  ...load(import.meta.glob(["../src/**/*.{ts,json}", "!../src/generated*.ts"], { query: "?raw", import: "default", eager: true })),
  ...load(import.meta.glob(["../web/**/*.{js,css,html,svg,txt}"], { query: "?raw", import: "default", eager: true })),
  ...load(import.meta.glob(["./**/*.ts"], { query: "?raw", import: "default", eager: true })),
  ...load(import.meta.glob(["../migrations/*.sql"], { query: "?raw", import: "default", eager: true })),
  ...load(
    import.meta.glob(["../wrangler.example.jsonc", "../wrangler.test.jsonc", "../tsconfig.json", "../vitest.config.ts", "../.dev.vars.example"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  ...load(import.meta.glob(["../../scripts/*.{mjs,mts,ps1,html}"], { query: "?raw", import: "default", eager: true })),
  ...load(import.meta.glob(["../../docs/**/*.md"], { query: "?raw", import: "default", eager: true })),
  ...load(
    import.meta.glob(["../../README.md", "../../LICENSE", "../../SELFHOST_CONFIG.md", "../../package.json", "../../package-lock.json", "../../.gitleaks.toml", "../../mcp.json"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  ...load(import.meta.glob(["../../recorder/release/*.{md,json,ps1}", "../../recorder-mac/*.{md,json,sh,txt}"], { query: "?raw", import: "default", eager: true })),
  ...load(import.meta.glob(["../../skills/**/*.md"], { query: "?raw", import: "default", eager: true })),
];

describe("self-host literal guard", () => {
  it("finds the files it is meant to scan", () => {
    const names = files.map((f) => f.file);
    expect(names).toEqual(
      expect.arrayContaining([
        "worker/src/config.ts",
        "worker/src/oauth/hosts.ts",
        "worker/web/comments.js",
        "worker/test/helpers.ts",
        "worker/migrations/0001_init.sql",
        "worker/wrangler.example.jsonc",
        "worker/wrangler.test.jsonc",
        "worker/vitest.config.ts",
        "worker/.dev.vars.example",
        "scripts/deploy-prod.mjs",
        "scripts/check-selfhost-literals.mjs",
        "README.md",
        "LICENSE",
        "SELFHOST_CONFIG.md",
        "package.json",
        ".gitleaks.toml",
        "mcp.json",
        "skills/recitbot-selfhost-getting-started/SKILL.md",
        "skills/recitbot-selfhost-playbook/SKILL.md",
        "recorder/release/install.ps1",
        "recorder-mac/install.sh",
      ]),
    );
    expect(names.some((n) => n.startsWith("docs/"))).toBe(true);
    for (const f of files) expect(f.text.length, f.file).toBeGreaterThan(0);
    // Git-ignored files are a deployment's own or build output.
    for (const f of ["worker/wrangler.jsonc", "worker/.dev.vars", "worker/home/index.html", "worker/public/index.html", "worker/src/generated.ts"]) {
      expect(isExcluded(f), f).toBe(true);
    }
    expect(isExcluded("worker/.dev.vars.example")).toBe(false);
  });

  it("no operator-specific value in any of them", () => {
    expect(files.flatMap((f) => scanText(f.file, f.text))).toEqual([]);
  });

  it("the license may name its licensor, and nothing else may", () => {
    expect(ALLOW.map((a) => `${a.file}: ${a.rule}`)).toEqual(["LICENSE: numbered company name", "LICENSE: regional company name"]);
    const name = ["1234567 ", "Albert", "a Ltd."].join("");
    expect(scanText("LICENSE", name)).toEqual([]);
    for (const f of ["README.md", "docs/LICENSE", "LICENSE.md", "worker/LICENSE", "worker/src/x.ts"]) {
      expect(scanText(f, name).map((v) => v.rule), f).toEqual(["numbered company name", "regional company name"]);
    }
    // Every other rule holds in it too.
    expect(scanText("LICENSE", ["sk", "_live_", "x"].join("")).map((v) => v.rule)).toEqual(["Stripe API key"]);
    const license = files.find((f) => f.file === "LICENSE")!.text;
    expect(license).toContain("Elastic License 2.0");
  });

  it("a public GitHub org URL is not an operator name, but a bare name in a skill still is", () => {
    const skill = "skills/recitbot-selfhost-playbook/SKILL.md";
    const orgUrl = ["https://github.com/the", "tyler", "dooks/recitbot-screen-recorder"].join("");
    expect(scanText(skill, `Recorder: ${orgUrl}`)).toEqual([]);
    expect(scanText("README.md", orgUrl)).toEqual([]);
    expect(scanText("README.md", orgUrl.toUpperCase())).toEqual([]);
    expect(scanText(skill, ["Tyler", " Dooks"].join("")).map((v) => v.rule)).toEqual(["operator name"]);
    expect(scanText(skill, ["t", "dooks"].join("")).map((v) => v.rule)).toEqual(["operator name"]);
    expect(scanText(skill, `Built by ${["Tyler", " Dooks"].join("")} ${orgUrl}`).map((v) => v.rule)).toEqual(["operator name"]);
  });

  it("each rule catches what it is for (samples built at run time, so this file holds none)", () => {
    const j = (...p: string[]) => p.join("");
    const samples: [string, string][] = [
      ["operator name", j("tyler", "dooks")],
      ["operator company name", j("Personal", " Brand Corp")],
      ["numbered company name", j("1234567", " Somewhere ", "Ltd.")],
      ["regional company name", j("1234567 ", "Albert", "a Ltd.")],
      ["hosted domain", j("https://mcp.", "recitbot", ".com/mcp")],
      ["hosted Worker/resource name", j("agent-recorder", "-demo-media")],
      ["account's workers.dev host", j("my-worker.someone", ".workers.dev")],
      ["bot template link", j("https://x", ".ai/bot/", "abc")],
      ["Stripe object id", j("price", "_1AbCdEfGhIjK")],
      ["Stripe API key", j("sk", "_live_", "abc")],
      ["Stripe webhook secret", j("whsec", "_abc")],
      ["Resend API key", j("re", "_", "A".repeat(24))],
      ["Turnstile key", j("0x4", "AAAAAAbcdef")],
      ["Turnstile-shaped key", j("2x0000", "0000000abcdefghijkl")],
      ["32-hex id (Cloudflare account/zone/D1)", "0123456789abcdef".repeat(2)],
      ["D1 database id (uuid)", j('"database_id": "01234567', "-89ab-cdef-0123-", '456789abcdef"')],
      ["operator email address", j("support@", "recitbot", ".com")],
      ["Windows default hostname", j("DESK", "TOP-1A2B3C4")],
      ["developer machine path", j("C:", "\\Users\\Someone")],
    ];
    expect(samples.map(([rule]) => rule).sort()).toEqual(RULES.map(([rule]) => rule).sort());
    for (const [rule, text] of samples) {
      expect(scanText("worker/src/x.ts", `const a = ${text};`).map((v) => v.rule), rule).toContain(rule);
    }
    const hit = (text: string, file = "worker/src/x.ts") => scanText(file, text).map((v) => v.rule);
    expect(hit(j("Tyler", " Dooks"))).toContain("operator name");
    expect(hit(j("T", "DOOKS* X"))).toContain("operator name");
    expect(hit(j("a P", "BC account"))).toContain("operator company name");
    expect(hit(j("Some Corp. of Albert", "a"))).toContain("regional company name");
    for (const prefix of ["prod", "bpc", "cus", "sub", "pi", "cs", "in", "acct", "evt"]) expect(hit(j(prefix, "_", "1AbCdEfGhIjK")), prefix).toContain("Stripe object id");
    expect(hit(j("cs_te", "st_a1B2c3D4e5F6"))).toContain("Stripe object id");
    const sql = j("UPDATE accounts SET plan = 'x' WHERE id = '", "A1b2C3d4E5f6G7h8I9j0Kl", "'");
    expect(hit(sql, "worker/migrations/9999_x.sql")).toEqual([SQL_RULES[0][0]]);
    expect(hit(sql)).toEqual([]);
    // Placeholders, reserved example hosts and Cloudflare's public Turnstile test keys are fine.
    const fine = [
      "price_PLACEHOLDER_PRO bpc_PLACEHOLDER recitbot.commentName my-worker.example.workers.dev <name>.<subdomain>.workers.dev",
      "1x00000000000000000000AA 1x00000000000000000000BB 2x00000000000000000000BB",
      "1x0000000000000000000000000000000AA 2x0000000000000000000000000000000AA 3x00000000000000000000FF",
      "a subscription in_progress cus_test",
      "DESKTOP-EXAMPLE DESKTOP-PC desktop-during-recording",
    ];
    for (const text of fine) expect(hit(text), text).toEqual([]);
  });

  it("homepage pages may only name their operator through markers, whoever it is", () => {
    const samples = [
      'Email <a href="mailto:me@acme.example">me</a>',
      'Built by <a href="https://acme.example" rel="noopener">Acme</a>',
      "© 2026 Acme Ltd.",
      'on your card statement as "ACME"',
    ];
    samples.forEach((text, i) => {
      expect(scanText("worker/home/x.html", text).map((v) => v.rule)).toEqual([HOME_RULES[i][0]]);
      expect(scanText("worker/src/x.ts", text)).toEqual([]);
    });
    const marked =
      '<a href="mailto:{{SUPPORT_EMAIL}}">x</a> Built by <a href="{{OPERATOR_URL}}" rel="noopener">{{OPERATOR_NAME}}</a> ' +
      '© 2026 {{LEGAL_ENTITY_NAME}} card statement as "{{STATEMENT_DESCRIPTOR}}"';
    expect(scanText("worker/home/x.html", marked)).toEqual([]);
  });
});
