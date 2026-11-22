import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { cleanup } from "../src/index";
import { getWebSession } from "../src/oauth/web-session";
import { hmacB64, now, randomId } from "../src/util";
import { fakeSiteverify, freshIp, mailbox, TURNSTILE_TOKEN, withEnv } from "./helpers";

const ROOT = "https://example.test";
const box = mailbox();
fakeSiteverify();
const mail = withEnv({ EMAIL: box.binding, OAUTH_DEV_LOG_LINKS: undefined });

beforeEach(() => {
  box.sent.length = 0;
});

type Browser = { ip: string; jar: Map<string, string> };
const browser = (): Browser => ({ ip: freshIp(), jar: new Map() });

async function send(b: Browser, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("cookie", [...b.jar].map(([k, v]) => `${k}=${v}`).join("; "));
  headers.set("cf-connecting-ip", b.ip);
  const res = await worker.fetch(new Request(ROOT + path, { ...init, headers }), mail, ctx);
  await waitOnExecutionContext(ctx);
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    const name = kv.slice(0, kv.indexOf("="));
    if (/Max-Age=0/.test(c)) b.jar.delete(name);
    else b.jar.set(name, kv.slice(kv.indexOf("=") + 1));
  }
  return res;
}

const post = (b: Browser, fields: Record<string, string>) =>
  send(b, "/signin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ROOT }, body: new URLSearchParams({ "cf-turnstile-response": TURNSTILE_TOKEN, ...fields }).toString() });

const pendingCount = async () => (await env.DB.prepare("SELECT count(*) AS n FROM oauth_pending").first<{ n: number }>())!.n;
const fOf = (html: string) => /name="f" value="([^"]+)"/.exec(html)![1];
const newEmail = () => `r${randomId(64).toLowerCase()}@example.com`;
/** A /signin form token signed like the worker signs it (the test env's key). */
const forge = async (exp: number, next: string) =>
  `${exp}.${next}.${await hmacB64(await hmacB64(env.SHARE_HMAC_KEY, "signin-form-v1"), `signin-form.${exp}.${next}`)}`;

describe("GET /signin writes no row", () => {
  it("GET /signin writes no oauth_pending row, and still renders the email form", async () => {
    const b = browser();
    const before = await pendingCount();
    const res = await send(b, "/signin?next=/alex/v/abc");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(await pendingCount()).toBe(before);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(html).toContain('<form method="post" action="/signin">');
    expect(html).toContain('<input id="email" name="email" type="email"');
    expect(fOf(html)).toMatch(/^\d+\.\/alex\/v\/abc\.[A-Za-z0-9_-]{43}$/);
    expect(html).not.toContain('name="p"');
  });

  it("POST /signin email step creates the row and sends the code; the code step signs in and goes to next", async () => {
    const b = browser();
    const f = fOf(await (await send(b, "/signin?next=/alex/v/abc")).text());
    const before = await pendingCount();
    const email = newEmail();
    const res = await post(b, { f, email });
    expect(res.status).toBe(200);
    expect(await pendingCount()).toBe(before + 1);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^rbo_[A-Za-z0-9]+=[A-Za-z0-9]+; Path=\/; HttpOnly; SameSite=Lax; Secure$/)]);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].to).toBe(email);
    const html = await res.text();
    const p = /name="p" value="([^"]+)"/.exec(html)![1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const row = await env.DB.prepare("SELECT kind, next, email FROM oauth_pending WHERE id = ?").bind(p).first<any>();
    expect(row).toEqual({ kind: "web", next: "/alex/v/abc", email });

    const code = /^(\d{6})$/m.exec(box.sent[0].text)![1];
    const done = await post(b, { p, csrf, code });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/alex/v/abc");
    const token = b.jar.get("__Host-rb_session")!;
    const account = await env.DB.prepare("SELECT account_id FROM oauth_identities WHERE email = ?").bind(email).first<{ account_id: string }>();
    expect(await getWebSession(new Request(`${ROOT}/`, { headers: { cookie: `__Host-rb_session=${token}` } }), env)).toBe(account!.account_id);
  });

  it("an invalid email on the signed form re-renders it without writing a row", async () => {
    const b = browser();
    const f = fOf(await (await send(b, "/signin?next=/")).text());
    const before = await pendingCount();
    const res = await post(b, { f, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(fOf(await res.text())).toBe(f);
    expect(await pendingCount()).toBe(before);
    expect(box.sent).toEqual([]);
  });

  it("tampered, expired, missing or cross-site form token -> refused, no row, no email", async () => {
    const b = browser();
    const f = fOf(await (await send(b, "/signin?next=/alex/v/abc")).text());
    const exp = f.slice(0, f.indexOf("."));
    const sig = f.slice(f.lastIndexOf(".") + 1);
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const before = await pendingCount();
    const email = newEmail();
    const refused: Record<string, string>[] = [
      { f: `${exp}./evil.${sig}`, email },
      { f: `${Number(exp) + 3600}./alex/v/abc.${sig}`, email },
      { f: `${exp}./alex/v/abc.${flipped}`, email },
      { f: await forge(now() - 1, "/alex/v/abc"), email },
      { f: "", email },
      { email },
    ];
    for (const form of refused) {
      const res = await post(b, form);
      expect(res.status).toBe(400);
    }
    expect(await (await post(b, { f: await forge(now() - 1, "/"), email })).text()).toContain("This sign-in expired.");
    const cross = await send(b, "/signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ f, email }).toString(),
    });
    expect(cross.status).toBe(403);
    expect(await pendingCount()).toBe(before);
    expect(box.sent).toEqual([]);
    expect(b.jar.size).toBe(0);
    // The untouched token still works.
    expect((await post(b, { f: await forge(now() + 60, "/alex/v/abc"), email })).status).toBe(200);
    expect(await pendingCount()).toBe(before + 1);
  });
});

describe("cleanup prunes sign-in rows", () => {
  it("cleanup prunes expired pending, code and session rows and keeps live ones", async () => {
    const t = now();
    const pending = (id: string, exp: number) =>
      env.DB.prepare("INSERT INTO oauth_pending (id, kind, cookie_hash, next, created_at, expires_at) VALUES (?, 'web', 'h', '/', ?, ?)").bind(id, t - 700, exp);
    const code = (hash: string, exp: number) =>
      env.DB.prepare(
        "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, account_id, expires_at) VALUES (?, 'c', 'https://a.example/cb', 'x', 'r', 's', 'a', ?)",
      ).bind(hash, exp);
    const session = (id: string, exp: number) =>
      env.DB.prepare("INSERT INTO web_sessions (id, token_hash, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'a', ?, ?, ?)").bind(id, `th-${id}`, t - 100, t - 100, exp);
    const tok = (id: string, exp: number) =>
      env.DB.prepare(
        "INSERT INTO oauth_tokens (id, kind, token_hash, family_id, client_id, account_id, aud, scope, created_at, expires_at) VALUES (?, 'access', 'h', 'fam', 'c', 'a', 'r', 's', ?, ?)",
      ).bind(id, t - 100, exp);
    const id = () => randomId(128);
    const ids = { pOld: id(), pLive: id(), cOld: id(), cRecent: id(), cLive: id(), sOld: id(), sLive: id(), tOld: id(), tRecent: id(), tLive: id() };
    await env.DB.batch([
      pending(ids.pOld, t - 1),
      pending(ids.pLive, t + 600),
      code(ids.cOld, t - 86400 - 1),
      code(ids.cRecent, t - 10),
      code(ids.cLive, t + 60),
      session(ids.sOld, t - 1),
      session(ids.sLive, t + 86400),
      tok(ids.tOld, t - 86400 - 1),
      tok(ids.tRecent, t - 10),
      tok(ids.tLive, t + 3600),
    ]);

    await cleanup(env, t);

    const has = async (sql: string, key: string) => !!(await env.DB.prepare(sql).bind(key).first());
    expect(await has("SELECT 1 FROM oauth_pending WHERE id = ?", ids.pOld)).toBe(false);
    expect(await has("SELECT 1 FROM oauth_pending WHERE id = ?", ids.pLive)).toBe(true);
    expect(await has("SELECT 1 FROM oauth_codes WHERE code_hash = ?", ids.cOld)).toBe(false);
    expect(await has("SELECT 1 FROM oauth_codes WHERE code_hash = ?", ids.cRecent)).toBe(true);
    expect(await has("SELECT 1 FROM oauth_codes WHERE code_hash = ?", ids.cLive)).toBe(true);
    expect(await has("SELECT 1 FROM web_sessions WHERE id = ?", ids.sOld)).toBe(false);
    expect(await has("SELECT 1 FROM web_sessions WHERE id = ?", ids.sLive)).toBe(true);
    expect(await has("SELECT 1 FROM oauth_tokens WHERE id = ?", ids.tOld)).toBe(false);
    expect(await has("SELECT 1 FROM oauth_tokens WHERE id = ?", ids.tRecent)).toBe(true);
    expect(await has("SELECT 1 FROM oauth_tokens WHERE id = ?", ids.tLive)).toBe(true);
  });
});
