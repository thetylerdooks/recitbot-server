// The one-time owner claim (src/oauth/claim.ts, claim-route.ts): POST /claim with OWNER_CLAIM_SECRET gives a fresh server its
// owner and returns the owner's API key, once. It is the 404 of an unknown path on every server that has an owner, an
// account or no secret, and the sign-in page never mentions it.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBearer } from "../src/auth";
import { accountLimits, isOperatorAccount, type Env } from "../src/env";
import { getConfig } from "../src/config";
import { governor } from "../src/governor";
import worker from "../src/index";
import { createAccount, findOrCreateAccount, SignupsDisabledError } from "../src/oauth/accounts";
import { CLAIMS_PER_DAY, CLAIMS_PER_IP_PER_HOUR, claimSecretMatches, takeClaim } from "../src/oauth/claim";
import { now, sha256Hex } from "../src/util";
import { brokenGovernor, fakeSiteverify, freshIp, mailbox, seedAccount, withEnv } from "./helpers";

const ROOT = "https://example.test";
const SECRET = `claim-${"s3cret".repeat(8)}`;
const box = mailbox();
const verify = fakeSiteverify();

/** A fresh self-host (wrangler.example.jsonc): no email, no Turnstile, the claim secret. */
const fresh = (over: Partial<Env> = {}): Env =>
  withEnv({
    OWNER_CLAIM_SECRET: SECRET,
    OWNER_ACCOUNT_IDS: undefined,
    EMAIL: undefined,
    EMAIL_FROM: undefined,
    OAUTH_DEV_LOG_LINKS: undefined,
    TURNSTILE_SITE_KEY: undefined,
    TURNSTILE_SECRET_KEY: undefined,
    TURNSTILE_DISABLED: "true",
    ...over,
  });
const withTurnstile = { TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY, TURNSTILE_DISABLED: undefined };

beforeEach(async () => {
  box.sent.length = 0;
  verify.mockClear();
  await env.DB.batch(["accounts", "api_keys", "oauth_identities", "oauth_pending", "web_sessions", "server_claim"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await runInDurableObject(governor(env), (_g, state) => void state.storage.sql.exec("DELETE FROM rl WHERE k LIKE 'owner-claim:%'"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fakeSiteverify();
});

async function send(path: string, init: RequestInit, e: Env, ip = freshIp()): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", ip);
  const res = await worker.fetch(new Request(path.startsWith("https:") ? path : ROOT + path, { redirect: "manual", ...init, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const post = (path: string, body: string, type: string, e: Env, ip?: string) => send(path, { method: "POST", headers: { "content-type": type }, body }, e, ip);
const claim = (secret: string, e: Env, ip?: string) => post("/claim", JSON.stringify({ secret }), "application/json", e, ip);
const claimForm = (secret: string, e: Env, ip?: string) => post("/claim", new URLSearchParams({ secret }).toString(), "application/x-www-form-urlencoded", e, ip);

async function rpc(key: string, method: string, params: unknown, e: Env): Promise<any> {
  const res = await send(
    "/mcp",
    { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
    e,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as any).result;
}
const toolNames = async (key: string, e: Env): Promise<string[]> => (await rpc(key, "tools/list", {}, e)).tools.map((t: { name: string }) => t.name);

/** GET /oauth/authorize for a new public client: the sign-in page. */
async function signinPage(e: Env): Promise<string> {
  const reg = await send(
    "/oauth/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Some App", redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" }) },
    e,
  );
  const { client_id } = (await reg.json()) as { client_id: string };
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://app.example/cb", state: "st", code_challenge: "A".repeat(43), code_challenge_method: "S256" });
  const res = await send(`/oauth/authorize?${q}`, {}, e);
  expect(res.status).toBe(200);
  return res.text();
}

const count = async (table: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const logs = () => {
  const lines: string[] = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...x) => void lines.push(x.join(" ")));
  return lines;
};

/** /claim is what any unknown path is, even with the right secret, and nothing is created. */
async function expectInert(e: Env) {
  const before = [await count("accounts"), await count("api_keys"), await count("server_claim")];
  const unknown = await post("/no-such-path", "{}", "application/json", e);
  for (const res of [await claim(SECRET, e), await claimForm(SECRET, e), await send("/claim", {}, e)]) {
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"not found"}');
    expect([...res.headers]).toEqual([...unknown.headers]);
  }
  expect([await count("accounts"), await count("api_keys"), await count("server_claim")]).toEqual(before);
}

describe("a fresh server with OWNER_CLAIM_SECRET", () => {
  it("claims once: the key works on /mcp as the owner; a second claim is 404", async () => {
    const e = fresh({ SIGNUPS_DISABLED: "true" });
    const lines = logs();
    const res = await claim(SECRET, e);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { owner_key: string };
    expect(Object.keys(body)).toEqual(["owner_key"]);
    const key = body.owner_key;
    expect(key).toMatch(/^ark_/);

    const owner = (await env.DB.prepare("SELECT id, email, plan, username FROM accounts").all<{ id: string; email: string | null; plan: string; username: string }>()).results;
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ email: null, plan: "owner", username: "owner" });
    expect(await count("oauth_identities")).toBe(0);
    expect((await accountLimits(e, owner[0].id)).tier).toBe("owner");
    expect(await isOperatorAccount(e, owner[0].id)).toBe(true);
    // Stored as every API key: hashed.
    expect(await verifyBearer(e, key, `${ROOT}/mcp`)).toMatchObject({ accountId: owner[0].id });
    const stored = (await env.DB.prepare("SELECT * FROM api_keys").all<Record<string, unknown>>()).results;
    expect(stored).toHaveLength(1);
    expect(stored[0].key_hash === (await sha256Hex(key))).toBe(true);
    expect(JSON.stringify(stored).includes(key)).toBe(false);

    expect((await rpc(key, "initialize", {}, e)).serverInfo).toBeTruthy();
    const names = await toolNames(key, e);
    expect(names).toContain("start_recording");
    expect(names).toContain("admin_overview");
    expect((await rpc(key, "tools/call", { name: "admin_overview", arguments: {} }, e)).isError).toBe(false);
    expect((await rpc(key, "tools/call", { name: "account_info", arguments: {} }, e)).structuredContent).toMatchObject({ username: "owner", email: null });

    await expectInert(e);
    expect(await count("accounts")).toBe(1);
    expect(await toolNames(key, e)).toEqual(names);
    for (const s of [SECRET, key]) expect(lines.some((l) => l.includes(s))).toBe(false);
  });

  it("takes a form too, and answers on every host of ours", async () => {
    const res = await claimForm(SECRET, fresh());
    expect(res.status).toBe(200);
    await env.DB.batch(["accounts", "server_claim"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const mcp = await post("https://mcp.example.test/claim", JSON.stringify({ secret: SECRET }), "application/json; charset=utf-8", fresh());
    expect(mcp.status).toBe(200);
  });

  it("stays claimed when every account is gone", async () => {
    const e = fresh();
    expect((await claim(SECRET, e)).status).toBe(200);
    await env.DB.prepare("DELETE FROM accounts").run();
    await expectInert(e);
  });

  it("of concurrent claims exactly one wins", async () => {
    const e = fresh();
    const res = await Promise.all([claim(SECRET, e), claim(SECRET, e), claim(SECRET, e)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    expect([await count("accounts"), await count("api_keys"), await count("server_claim")]).toEqual([1, 1, 1]);
    // Past the open check too: the transaction itself lets one in, and the loser's key is not stored.
    await env.DB.batch(["accounts", "api_keys", "server_claim"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const ids = await Promise.all(["k1", "k2"].map((id) => takeClaim(e, { id, hash: id })));
    expect(ids.filter(Boolean)).toHaveLength(1);
    expect([await count("accounts"), await count("api_keys")]).toEqual([1, 1]);
  });

  it("OWNER_ACCOUNT_IDS set later is the whole list of operators; the owner keeps the owner plan", async () => {
    await claim(SECRET, fresh());
    const { id } = (await env.DB.prepare("SELECT id FROM accounts").first<{ id: string }>())!;
    const later = fresh({ OWNER_ACCOUNT_IDS: "SomeOtherAccount0001" });
    expect(await isOperatorAccount(later, id)).toBe(false);
    expect(await isOperatorAccount(fresh({ OWNER_ACCOUNT_IDS: `SomeOtherAccount0001,${id}` }), id)).toBe(true);
    expect((await accountLimits(later, id)).tier).toBe("owner");
  });

  it("Turnstile doesn't apply, whatever its settings", async () => {
    for (const t of [withTurnstile, { TURNSTILE_DISABLED: undefined }]) {
      await env.DB.batch(["accounts", "api_keys", "server_claim"].map((x) => env.DB.prepare(`DELETE FROM ${x}`)));
      expect((await claim(SECRET, fresh(t))).status).toBe(200);
    }
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("with SIGNUPS_DISABLED=true", () => {
  it("the claim makes the first owner; signups stay refused before and after it", async () => {
    const e = fresh({ SIGNUPS_DISABLED: "true" });
    const refused = async () => {
      await expect(createAccount(e, "someone@example.com")).rejects.toThrow(SignupsDisabledError);
      await expect(findOrCreateAccount(e, "someone@example.com")).rejects.toThrow(SignupsDisabledError);
    };
    await refused();
    expect((await claim(`${SECRET}x`, e)).status).toBe(403);
    expect(await count("accounts")).toBe(0);
    expect((await claim(SECRET, e)).status).toBe(200);
    await refused();
    expect(await count("accounts")).toBe(1);
  });

  it("takeClaim is the only account creation besides createAccount", () => {
    const src = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
    const creators = Object.entries(src).flatMap(([f, s]) => Array.from({ length: s.split("INTO accounts ").length - 1 }, () => f));
    expect(creators.sort()).toEqual(["../src/oauth/accounts.ts", "../src/oauth/claim.ts"]);
  });
});

describe("the sign-in page", () => {
  it("never shows the claim, open or not, and has no claim POST", async () => {
    for (const e of [fresh(), fresh({ SIGNUPS_DISABLED: "true" }), fresh({ ...withTurnstile, EMAIL: box.binding, EMAIL_FROM: "hello@example.test" }), fresh({ OWNER_CLAIM_SECRET: undefined })]) {
      const html = await signinPage(e);
      expect(html).not.toMatch(/claim/i);
      expect(html).not.toContain('type="password"');
      const res = await post("/oauth/authorize/claim", new URLSearchParams({ secret: SECRET }).toString(), "application/x-www-form-urlencoded", e);
      expect(res.status).toBe(404);
    }
    expect([await count("accounts"), await count("server_claim")]).toEqual([0, 0]);
  });
});

describe("inert", () => {
  it("with OWNER_ACCOUNT_IDS set", async () => {
    await expectInert(fresh({ OWNER_ACCOUNT_IDS: "SomeOwnerAccount0001" }));
    await expectInert(fresh({ OWNER_ACCOUNT_IDS: "SomeOwnerAccount0001", SIGNUPS_DISABLED: "true" }));
  });

  it("with any account in D1", async () => {
    await seedAccount(false);
    await expectInert(fresh());
    await expectInert(fresh({ SIGNUPS_DISABLED: "true" }));
    expect(await takeClaim(fresh(), { id: "k", hash: "h" })).toBeNull();
    expect([await count("accounts"), await count("server_claim")]).toEqual([1, 0]);
  });

  it("without the secret, or with one that is too short", async () => {
    await expectInert(fresh({ OWNER_CLAIM_SECRET: undefined }));
    await expectInert(fresh({ OWNER_CLAIM_SECRET: "" }));
    const short = fresh({ OWNER_CLAIM_SECRET: "a".repeat(31) });
    await expectInert(short);
    expect((await claim("a".repeat(31), short)).status).toBe(404);
    expect(getConfig(short).auth.claim.enabled).toBe(false);
    expect(getConfig(short).warnings.join(" ")).toMatch(/OWNER_CLAIM_SECRET is too short/);
    expect(await claimSecretMatches(fresh({ OWNER_CLAIM_SECRET: undefined }), "")).toBe(false);
  });

  it("while the service is read-only", async () => {
    await expectInert(fresh({ SERVICE_MODE: "READ_ONLY" }));
  });

  it("every method but POST, while a claim is open", async () => {
    for (const method of ["GET", "PUT", "OPTIONS"]) expect((await send("/claim", { method }, fresh())).status, method).toBe(404);
  });
});

describe("a wrong secret", () => {
  it("fails with a generic answer that echoes nothing, logs nothing of it, and is limited per IP", async () => {
    const e = fresh();
    const lines = logs();
    const ip = freshIp();
    for (let i = 0; i < CLAIMS_PER_IP_PER_HOUR; i++) {
      const res = await claim(`wrong-guess-${i}`, e, ip);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('{"error":"claim failed"}');
    }
    // The limit holds for the right secret too.
    const limited = await claim(SECRET, e, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect([await count("accounts"), await count("api_keys"), await count("server_claim")]).toEqual([0, 0, 0]);
    expect(lines.join("\n")).not.toMatch(/wrong-guess/);
    // Another IP still can.
    expect((await claim(SECRET, e)).status).toBe(200);
    expect(lines.some((l) => l.includes(SECRET))).toBe(false);
  });

  it("a body without a usable secret fails the same way", async () => {
    const e = fresh();
    const bodies: [string, string][] = [
      ["", "application/json"],
      ["not json", "application/json"],
      ["null", "application/json"],
      [JSON.stringify({ secret: [SECRET] }), "application/json"],
      [JSON.stringify({ secret: SECRET, pad: "x".repeat(5000) }), "application/json"],
      [SECRET, "text/plain"],
      ["secret=", "application/x-www-form-urlencoded"],
    ];
    for (const [body, type] of bodies) {
      const res = await post("/claim", body, type, e);
      expect([res.status, await res.text()]).toEqual([403, '{"error":"claim failed"}']);
    }
    expect(await count("accounts")).toBe(0);
  });

  it("a prefix, a longer value and an empty one don't match; surrounding white space does not matter", async () => {
    const e = fresh();
    for (const s of ["", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) expect(await claimSecretMatches(e, s), s.length.toString()).toBe(false);
    expect(await claimSecretMatches(e, ` ${SECRET}\n`)).toBe(true);
    expect(await claimSecretMatches(fresh({ OWNER_CLAIM_SECRET: `${SECRET}\n` }), SECRET)).toBe(true);
  });

  it("limits wrong secrets across all IPs, but a used-up daily limit can't stall the real claim", async () => {
    const t = now();
    for (let i = 0; i < CLAIMS_PER_DAY; i++) await governor(env).hit("owner-claim:global", CLAIMS_PER_DAY, 86400, t);
    expect((await claim("wrong-secret-wrong-secret-wrong-secret", fresh())).status).toBe(429);
    expect(await count("server_claim")).toBe(0);
    expect((await claim(SECRET, fresh())).status).toBe(200);
    expect(await count("server_claim")).toBe(1);
  });

  it("fails closed when the limits can't be checked", async () => {
    expect((await claim(SECRET, fresh({ GOVERNOR: brokenGovernor }))).status).toBe(503);
    expect(await count("server_claim")).toBe(0);
  });
});
