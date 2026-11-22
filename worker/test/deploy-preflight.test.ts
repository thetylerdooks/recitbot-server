// deploy:prod's preflight (scripts/deploy-preflight.mjs): the checks only. wrangler and the network are never touched; the
// secret list call is a function the tests hand in.
import { describe, expect, it, vi } from "vitest";
import {
  configProblems,
  impliedSecrets,
  type ListResult,
  placeholderProblems,
  preflight,
  secretNames,
  secretProblems,
  skipReason,
  type Vars,
} from "../../scripts/deploy-preflight.mjs";
import { parseJsonc } from "../../scripts/home-markers.mjs";
import * as config from "../src/config";
import configSource from "../src/config.ts?raw";
import example from "../wrangler.example.jsonc?raw";
import testConfig from "../wrangler.test.jsonc?raw";

const GOOD: Vars = { DEV_MODE: "false", PUBLIC_BASE_URL: "https://videos.acme.io", EMAIL_FROM: "rec@acme.io", TURNSTILE_DISABLED: "true" };
const REQUIRED = [...config.REQUIRED_SECRETS];
const FULL: Vars = {
  ...GOOD,
  TURNSTILE_DISABLED: undefined,
  STRIPE_PRO_PRICE_ID: "price_x",
  CF_ZONE_ID: "zone",
  CUSTOM_DOMAIN_CNAME_TARGET: "customers.acme.io",
};
const FULL_SECRETS = [...REQUIRED, "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "CF_SAAS_API_TOKEN"];
const listed = (names: string[]): ListResult => ({ status: 0, stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))), stderr: "" });
const names = (vars: Vars) => impliedSecrets(vars, REQUIRED).map((s) => s.name);

describe("placeholders", () => {
  it("names the var, never its value", () => {
    const bad: [string, string][] = [
      ["REPLACE_ME", "REPLACE_ME"],
      ["REPLACE_ME", "REPLACE_ME_ZONE_ID"],
      ["REPLACE_ME", "replace-me"],
      ["example.com", "https://videos.example.com"],
      ["example.com", "hello@Example.COM"],
      ["example.test", "https://mcp.example.test"],
      ["local-only", "local-only"],
      ["PLACEHOLDER", "price_PLACEHOLDER_PRO"],
      ["a Cloudflare Turnstile test key", "1x00000000000000000000AA"],
      ["a Cloudflare Turnstile test key", "1x0000000000000000000000000000000AA"],
    ];
    for (const [label, value] of bad) {
      expect(placeholderProblems({ ...GOOD, SOME_VAR: value }), value).toEqual([`SOME_VAR still holds a placeholder (${label}).`]);
    }
    expect(placeholderProblems({ NESTED: { url: "https://secretive.example.com" } })).toEqual(["NESTED still holds a placeholder (example.com)."]);
    expect(placeholderProblems({ ...GOOD, EMPTY: "", NUM: 3, OFF: false, NONE: null, OWNER_ACCOUNT_IDS: "__SET_BY_DEPLOY__" })).toEqual([]);
  });

  it("refuses the committed template and the test config as they are", () => {
    const production = (parseJsonc(example) as { env: { production: { vars: Vars } } }).env.production;
    expect(placeholderProblems(production.vars).map((p) => p.split(" ")[0]).sort()).toEqual(["PUBLIC_BASE_URL"]);
    expect(placeholderProblems((parseJsonc(testConfig) as { vars: Vars }).vars).length).toBeGreaterThan(0);
    // The optional settings too, once someone uncomments them without filling them in.
    const optional = [...example.matchAll(/^\s*\/\/ "([A-Z_]+)": "([^"]+)"/gm)].filter(([, , v]) => /REPLACE|example|PLACEHOLDER/.test(v));
    expect(optional.length).toBeGreaterThan(10);
    for (const [, k, v] of optional) expect(placeholderProblems({ [k]: v }), k).toHaveLength(1);
  });
});

describe("configuration errors", () => {
  it("getConfig's errors for the production vars, with the secrets stubbed as present", () => {
    expect(configProblems({ vars: GOOD }, GOOD, config)).toEqual([]);
    expect(configProblems({ vars: FULL, send_email: [{ name: "EMAIL" }] }, FULL, config)).toEqual([]);
    const bad = { ...GOOD, PUBLIC_BASE_URL: "http://do-not-print.acme.io", BLOCKED_COUNTRIES: "Narnia" };
    const problems = configProblems({ vars: bad }, bad, config);
    expect(problems).toEqual([expect.stringMatching(/^PUBLIC_BASE_URL must be/), expect.stringMatching(/^BLOCKED_COUNTRIES must be/)]);
    expect(problems.join(" ")).not.toMatch(/do-not-print|Narnia/);
  });

  it("config.ts stays loadable on its own (loadConfigModule): type imports only", () => {
    const imports = configSource.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type /);
  });
});

describe("secrets", () => {
  it("implied by what is configured", () => {
    expect(names(GOOD)).toEqual(REQUIRED);
    expect([...names(FULL)].sort()).toEqual([...FULL_SECRETS].sort());
    expect(names({ ...GOOD, STRIPE_PRO_PRICE_ID: "price_x" })).toEqual([...REQUIRED, "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    expect(names({ ...GOOD, TURNSTILE_DISABLED: "false" })).toEqual([...REQUIRED, "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]);
    // A site key var only needs its pair, whatever TURNSTILE_DISABLED says.
    expect(names({ ...GOOD, TURNSTILE_SITE_KEY: "k" })).toEqual([...REQUIRED, "TURNSTILE_SECRET_KEY"]);
    // A CNAME target alone is not the feature (it stays shown while custom domains are off).
    expect(names({ ...GOOD, CUSTOM_DOMAIN_CNAME_TARGET: "c.acme.io" })).toEqual(REQUIRED);
  });

  it("missing ones are named with their reason", () => {
    const implied = impliedSecrets(FULL, REQUIRED);
    expect(secretProblems(listed([...FULL_SECRETS, "OTHER"]), implied)).toEqual({ problems: [], skipped: null });
    for (const name of FULL_SECRETS) {
      const { problems, skipped } = secretProblems(listed(FULL_SECRETS.filter((n) => n !== name)), implied);
      expect(problems, name).toEqual([expect.stringMatching(new RegExp(`^${name} is not set \\(secret; `))]);
      expect(skipped).toBeNull();
    }
    expect(secretProblems(listed([]), implied).problems).toHaveLength(FULL_SECRETS.length);
  });

  it("reads names out of wrangler's JSON, banner or not", () => {
    const json = JSON.stringify([{ name: "A", type: "secret_text" }, { name: "B" }], null, 2);
    expect(secretNames(json)).toEqual(["A", "B"]);
    expect(secretNames(`\n wrangler 4\n[WARNING] something\n${json}\n`)).toEqual(["A", "B"]);
    expect(secretNames("[]")).toEqual([]);
    for (const text of ["", "oops", '{"name":"A"}', '[{"x":1}]', "[WARNING] x", undefined]) expect(secretNames(text), String(text)).toBeNull();
  });

  it("a list call that can't run skips the check with a reason, never wrangler's own output", () => {
    const leak = "someone@acme.io";
    const cases: [ListResult, RegExp][] = [
      [{ status: null, error: { code: "ENOENT" } }, /could not run \(ENOENT\)/],
      [{ status: null, error: { code: "ETIMEDOUT" }, signal: "SIGTERM" }, /timed out/],
      [{ status: 1, stderr: `You are not authenticated, ${leak}. Run wrangler login` }, /not signed in/],
      [{ status: 1, stderr: `it's necessary to set a CLOUDFLARE_API_TOKEN environment variable ${leak}` }, /not signed in/],
      [{ status: 1, stderr: `TypeError: fetch failed getaddrinfo ENOTFOUND ${leak}` }, /could not be reached/],
      [{ status: 1, stderr: `Worker "${leak}" not found.` }, /does not exist yet/],
      [{ status: 7, stderr: leak }, /exit 7/],
      [{ status: 0, stdout: leak }, /not a list/],
    ];
    for (const [result, re] of cases) {
      expect(skipReason(result)).toMatch(re);
      expect(skipReason(result)).not.toContain(leak);
      expect(secretProblems(result, impliedSecrets(FULL, REQUIRED))).toEqual({ problems: [], skipped: skipReason(result) });
    }
  });
});

describe("preflight", () => {
  it("passes a filled-in deployment", () => {
    expect(preflight({ vars: FULL }, config, () => listed(FULL_SECRETS))).toEqual({ problems: [], skipped: null });
    expect(preflight({ vars: GOOD }, config, () => ({ status: 1, stderr: "fetch failed" }))).toEqual({ problems: [], skipped: "Cloudflare could not be reached" });
    expect(preflight({ vars: GOOD }, config, () => listed([])).problems).toHaveLength(REQUIRED.length);
  });

  it("calls the secret list only once everything local is right", () => {
    const list = vi.fn(() => listed(FULL_SECRETS));
    expect(preflight(undefined, config, list).problems).toEqual(["env.production is missing."]);
    expect(preflight({ vars: { ...GOOD, SUPPORT_EMAIL: "support@example.com" } }, config, list).problems).toHaveLength(1);
    expect(preflight({ vars: { ...GOOD, EMAIL_FROM: "nope" } }, config, list).problems).toEqual(["EMAIL_FROM is not an email address."]);
    expect(list).not.toHaveBeenCalled();
    preflight({ vars: GOOD }, config, list);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
