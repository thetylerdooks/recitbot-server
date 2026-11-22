import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { getWebSession, revokeWebSessions, safeNext } from "../src/oauth/web-session";
import { now, randomId } from "../src/util";
import { fakeSiteverify, freshIp, mailbox, TURNSTILE_TOKEN, withEnv } from "./helpers";

const ROOT = "https://example.test";
const LOCAL = "http://127.0.0.1:8799";
const CB = "https://app.example/cb";
const box = mailbox();
fakeSiteverify();
const mail = withEnv({ EMAIL: box.binding, OAUTH_DEV_LOG_LINKS: undefined });

beforeEach(() => {
  box.sent.length = 0;
});

/** A browser: one host, one IP, a cookie jar. */
type Browser = { origin: string; ip: string; jar: Map<string, string> };
const browser = (origin = ROOT): Browser => ({ origin, ip: freshIp(), jar: new Map() });
const jarHeader = (b: Browser) => [...b.jar].map(([k, v]) => `${k}=${v}`).join("; ");

async function send(b: Browser, path: string, init: RequestInit = {}, e: Env = mail): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", jarHeader(b));
  headers.set("cf-connecting-ip", b.ip);
  const res = await worker.fetch(new Request(b.origin + path, { ...init, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    const name = kv.slice(0, kv.indexOf("="));
    if (/Max-Age=0/.test(c)) b.jar.delete(name);
    else b.jar.set(name, kv.slice(kv.indexOf("=") + 1));
  }
  return res;
}

const get = (b: Browser, path: string, e: Env = mail) => send(b, path, {}, e);
const post = (b: Browser, path: string, fields: Record<string, string>, headers: Record<string, string> = {}, e: Env = mail) =>
  send(b, path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: b.origin, ...headers }, body: new URLSearchParams({ "cf-turnstile-response": TURNSTILE_TOKEN, ...fields }).toString() }, e);

const formFields = (html: string) => ({ p: /name="p" value="([^"]+)"/.exec(html)![1], csrf: /name="csrf" value="([^"]+)"/.exec(html)![1] });
/** The signed form of GET /signin (no row behind it yet). */
const signinForm = (html: string) => ({ f: /name="f" value="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&") });
const sessionName = (b: Browser) => (b.origin === ROOT ? "__Host-rb_session" : "rb_session");
const sessionOf = (b: Browser) => b.jar.get(sessionName(b));
const whoIs = (b: Browser, token = sessionOf(b)) =>
  getWebSession(new Request(`${b.origin}/alex/v/abc`, { headers: { cookie: `${sessionName(b)}=${token}` } }), env);
const newEmail = () => `w${randomId(64).toLowerCase()}@example.com`;
const accountFor = async (email: string) =>
  (await env.DB.prepare("SELECT account_id FROM oauth_identities WHERE email = ?").bind(email).first<{ account_id: string }>())!.account_id;

/** GET /signin?next=..., submit the email; returns the code page's form fields, the emailed link (path) and code. */
async function startSignin(b: Browser, next: string, email = newEmail()) {
  const page = await get(b, `/signin?next=${encodeURIComponent(next)}`);
  expect(page.status).toBe(200);
  const res = await post(b, "/signin", { ...signinForm(await page.text()), email });
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = box.sent.at(-1)!;
  const link = new URL(/^https?:\/\/\S+\/oauth\/magic\?t=[A-Za-z0-9]+$/m.exec(m.text)![0]);
  return { f: formFields(html), email, path: link.pathname + link.search, code: /^(\d{6})$/m.exec(m.text)![1], html };
}

/** A browser signed in through /signin and the magic link. */
async function signedIn(origin = ROOT) {
  const b = browser(origin);
  const s = await startSignin(b, "/");
  expect((await get(b, s.path)).status).toBe(302);
  return { b, email: s.email, accountId: await accountFor(s.email) };
}

const sessionRow = (token: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(token))
    .then((d) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""))
    .then((h) => env.DB.prepare("SELECT * FROM web_sessions WHERE token_hash = ?").bind(h).first<any>());

describe("/signin", () => {
  it("GET renders the branded email step: no-store, never framed, no referrer, no third-party resources but Turnstile", async () => {
    const b = browser();
    const res = await get(b, "/signin?next=/alex/v/abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("<h1>What&#39;s your email to sign up for Rec It Bot?</h1>");
    expect(html).toContain('<img src="/s/apple-touch-icon.png"');
    expect(html).toContain('<form method="post" action="/signin">');
    expect(html).toContain('<label for="email">');
    expect(html.match(/https?:\/\/[^"]*/g)).toEqual(["https://challenges.cloudflare.com/turnstile/v0/api.js"]);
    expect(html).not.toMatch(/personals+brand/i);
    expect([...b.jar.keys()]).toEqual([]);
  });

  it("POST is refused from another origin; after the email, without the CSRF token or the browser cookie", async () => {
    const b = browser();
    const f = signinForm(await (await get(b, "/signin?next=/")).text());
    const email = newEmail();
    expect((await post(b, "/signin", { ...f, email }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(b, "/signin", { ...f, email }, { origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(box.sent).toEqual([]);
    const res = await post(b, "/signin", { ...f, email }, { origin: "null", "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(box.sent).toHaveLength(1);
    const p = formFields(await res.text());
    expect((await post(b, "/signin", { ...p, resend: "1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(b, "/signin", { ...p, resend: "1", csrf: "x" })).status).toBe(403);
    expect((await post(b, "/signin", { ...p, resend: "1" }, { cookie: "" })).status).toBe(403);
    expect(box.sent).toHaveLength(1);
  });

  it("email -> magic link -> 302 to next with a __Host- session cookie; next comes from the pending sign-in, not the link", async () => {
    const b = browser();
    const s = await startSignin(b, "/alex/v/abc");
    const m = box.sent[0];
    expect(m.from).toEqual({ email: "hello@example.test", name: "Recitbot" });
    expect(m.to).toBe(s.email);
    expect(m.subject).toBe(`Your Recitbot code: ${s.code}`);
    expect(m.html).toContain(s.code);
    expect(s.html).toContain(`We emailed a code to <strong>${s.email}</strong>`);

    const res = await get(b, `${s.path}&next=//evil.example`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/alex/v/abc");
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("__Host-rb_session="))!;
    expect(session).toMatch(/^__Host-rb_session=[A-Za-z0-9]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    expect(session).not.toMatch(/Domain=/i);
    expect(cookies.some((c) => /^rbo_\w+=; Max-Age=0/.test(c))).toBe(true);
    expect(await whoIs(b)).toBe(await accountFor(s.email));

    const row = await sessionRow(sessionOf(b)!);
    expect(row.token_hash).not.toBe(sessionOf(b));
    expect(row.expires_at - row.created_at).toBe(30 * 86400);
  });

  it("on loopback dev hosts the cookie is rb_session without Secure", async () => {
    const b = browser(LOCAL);
    const s = await startSignin(b, "/alex/v/abc");
    const res = await get(b, s.path);
    expect(res.headers.get("location")).toBe("/alex/v/abc");
    const session = res.headers.getSetCookie().find((c) => c.startsWith("rb_session="))!;
    expect(session).toMatch(/^rb_session=[A-Za-z0-9]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect(await whoIs(b)).toBe(await accountFor(s.email));
  });

  it("the code step: one numeric one-time-code field; the right code signs in and goes to next", async () => {
    const b = browser();
    const s = await startSignin(b, "/alex/v/xyz");
    expect(s.html).toMatch(/<input class="code" id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"[^>]*>/);
    expect(s.html).toContain('<label for="code">6-digit code</label>');
    const wrong = s.code === "000000" ? "111111" : "000000";
    const bad = await post(b, "/signin", { ...s.f, code: wrong });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Wrong code. 4 tries left.");
    const res = await post(b, "/signin", { ...s.f, code: `${s.code.slice(0, 3)} ${s.code.slice(3)}` });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alex/v/xyz");
    expect(await whoIs(b)).toBe(await accountFor(s.email));
  });

  it("the magic link is single use", async () => {
    const b = browser();
    const s = await startSignin(b, "/");
    expect((await get(b, s.path)).status).toBe(302);
    const again = await get(b, s.path);
    expect(again.status).toBe(400);
    expect(again.headers.getSetCookie()).toEqual([]);
    expect((await post(b, "/signin", { ...s.f, code: s.code })).status).toBe(403);
  });

  it("resend replaces the code and is rate limited per address", async () => {
    const b = browser();
    const s = await startSignin(b, "/");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(b, "/signin", { ...s.f, resend: "1" })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    expect(box.sent).toHaveLength(5);
    expect(new Set(box.sent.map((m) => m.to))).toEqual(new Set([s.email]));
    const latest = /^(\d{6})$/m.exec(box.sent.at(-1)!.text)![1];
    if (latest !== s.code) expect((await post(b, "/signin", { ...s.f, code: s.code })).status).toBe(400);
    expect((await post(b, "/signin", { ...s.f, code: latest })).status).toBe(303);
  });

  it("already signed in: GET /signin goes straight to next, without a new cookie", async () => {
    const { b } = await signedIn();
    const res = await get(b, "/signin?next=/alex/v/abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/alex/v/abc");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("an unsafe next ends at /", async () => {
    const b = browser();
    const s = await startSignin(b, "//evil.example/x");
    expect((await get(b, s.path)).headers.get("location")).toBe("/");
  });
});

describe("getWebSession", () => {
  it("valid -> account id; missing, tampered or wrongly named -> null", async () => {
    const { b, accountId } = await signedIn();
    const token = sessionOf(b)!;
    expect(await whoIs(b)).toBe(accountId);
    expect(await getWebSession(new Request(`${ROOT}/alex/v/abc`), env)).toBeNull();
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(await whoIs(b, flipped)).toBeNull();
    expect(await whoIs(b, token + "x")).toBeNull();
    expect(await whoIs(b, "")).toBeNull();
    expect(await getWebSession(new Request(`${ROOT}/`, { headers: { cookie: `rb_session=${token}` } }), env)).toBeNull();
  });

  it("expired: 30 days after sign-in, or 7 days idle", async () => {
    const a = await signedIn();
    expect(await whoIs(a.b)).toBe(a.accountId);
    await env.DB.prepare("UPDATE web_sessions SET expires_at = ? WHERE account_id = ?").bind(now() - 1, a.accountId).run();
    expect(await whoIs(a.b)).toBeNull();

    const i = await signedIn();
    await env.DB.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE account_id = ?").bind(now() - 7 * 86400 + 30, i.accountId).run();
    expect(await whoIs(i.b)).toBe(i.accountId);
    const row = await sessionRow(sessionOf(i.b)!);
    expect(row.last_seen_at).toBeGreaterThanOrEqual(now() - 5);
    await env.DB.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE account_id = ?").bind(now() - 7 * 86400 - 1, i.accountId).run();
    expect(await whoIs(i.b)).toBeNull();
  });

  it("POST /signout (same-origin only) revokes the session and clears the cookie", async () => {
    const { b, accountId } = await signedIn();
    const token = sessionOf(b)!;
    const page = await get(b, "/signout?next=/alex/v/abc");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post" action="/signout"><input type="hidden" name="next" value="/alex/v/abc">');

    expect((await post(b, "/signout", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect(await whoIs(b, token)).toBe(accountId);

    const res = await post(b, "/signout", { next: "/alex/v/abc" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alex/v/abc");
    expect(res.headers.getSetCookie()).toEqual(["__Host-rb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"]);
    expect(await whoIs(b, token)).toBeNull();
  });

  it("revokeWebSessions signs the account out everywhere, and nobody else", async () => {
    const one = await signedIn();
    const two = browser();
    const s = await startSignin(two, "/", one.email);
    await get(two, s.path);
    const other = await signedIn();
    expect(await whoIs(two)).toBe(one.accountId);
    await revokeWebSessions(env, one.accountId);
    expect(await whoIs(one.b)).toBeNull();
    expect(await whoIs(two)).toBeNull();
    expect(await whoIs(other.b)).toBe(other.accountId);
  });

  it("rotation: a session older than 24 h gets a new token on /signin; the old one works for 60 s more", async () => {
    const { b, accountId } = await signedIn();
    const old = sessionOf(b)!;
    const oldRow = await sessionRow(old);
    await env.DB.prepare("UPDATE web_sessions SET created_at = ? WHERE id = ?").bind(now() - 86400 - 1, oldRow.id).run();

    const res = await get(b, "/signin?next=/alex/v/abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/alex/v/abc");
    const fresh = sessionOf(b)!;
    expect(fresh).not.toBe(old);
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-rb_session=[A-Za-z0-9]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
    const newRow = await sessionRow(fresh);
    expect(newRow.rotated_from).toBe(oldRow.id);
    expect(newRow.expires_at).toBe(oldRow.expires_at);

    // A parallel request with the old token: still signed in, and no second rotation.
    const parallel = await send(b, "/signin?next=/", { headers: { cookie: `__Host-rb_session=${old}` } });
    expect(parallel.status).toBe(302);
    expect(parallel.headers.getSetCookie()).toEqual([]);
    expect(await whoIs(b, old)).toBe(accountId);

    await env.DB.prepare("UPDATE web_sessions SET revoked_at = ? WHERE id = ?").bind(now() - 1, oldRow.id).run();
    expect(await whoIs(b, old)).toBeNull();
    expect(await whoIs(b, fresh)).toBe(accountId);
  });

  it("a fresh sign-in in the same browser replaces the session it had", async () => {
    const b = browser();
    const a = await startSignin(b, "/");
    const other = await startSignin(b, "/");
    await get(b, other.path);
    const first = sessionOf(b)!;
    expect(await whoIs(b)).toBe(await accountFor(other.email));
    await get(b, a.path);
    expect(sessionOf(b)).not.toBe(first);
    expect(await whoIs(b, first)).toBeNull();
    expect(await whoIs(b)).toBe(await accountFor(a.email));
  });
});

describe("next guard", () => {
  const accepted = ["/", "/alex/v/abc", "/alex/v/abc?t=10#x"];
  const rejected = [
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "/%2F%2Fevil.com",
    "%2F%2Fevil.com",
    "/%5Cevil.com",
    "/%5cevil.com",
    "/" + "a".repeat(512),
    "/foo\r\nSet-Cookie:x",
    "/foo%0d%0aSet-Cookie:x",
    "/\t/evil.com",
    "/%zz",
    "",
    "alex/v/abc",
  ];
  for (const n of accepted) it(`accepts ${JSON.stringify(n)}`, () => expect(safeNext(n)).toBe(n));
  for (const n of rejected) it(`rejects ${JSON.stringify(n.length > 40 ? n.slice(0, 20) + "..." : n)}`, () => expect(safeNext(n)).toBe("/"));
  it("null and undefined -> /", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

describe("OAuth with a web session", () => {
  async function registerClient(b: Browser) {
    const res = await send(b, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Grok Bot", redirect_uris: [CB], token_endpoint_auth_method: "none" }),
    });
    return ((await res.json()) as any).client_id as string;
  }
  const authorizePath = (client_id: string) =>
    `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: CB, state: "st", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`;

  it("an existing web session skips the email step; consent is still asked; Approve issues the code", async () => {
    const { b, accountId, email } = await signedIn();
    const client_id = await registerClient(b);
    box.sent.length = 0;
    const res = await get(b, authorizePath(client_id));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Allow access?</h1>");
    expect(html).toContain(`<strong>${email}</strong>`);
    expect(html).toContain('value="allow">Approve</button>');
    expect(html).not.toContain('name="email"');
    expect(box.sent).toEqual([]);

    const approved = await post(b, "/oauth/authorize/decide", { ...formFields(html), decision: "allow" });
    expect(approved.status).toBe(303);
    const loc = new URL(approved.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(approved.headers.getSetCookie().some((c) => c.startsWith("__Host-rb_session="))).toBe(false);
    const row = await env.DB.prepare("SELECT account_id FROM oauth_codes ORDER BY rowid DESC LIMIT 1").first<{ account_id: string }>();
    expect(row!.account_id).toBe(accountId);
  });

  it("signed out after the consent page was shown: Approve is refused", async () => {
    const { b, accountId } = await signedIn();
    const client_id = await registerClient(b);
    const html = await (await get(b, authorizePath(client_id))).text();
    await revokeWebSessions(env, accountId);
    expect((await post(b, "/oauth/authorize/decide", { ...formFields(html), decision: "allow" })).status).toBe(403);
  });

  it("without a session: the same branded email step; Approve after the code also signs the browser in", async () => {
    const b = browser();
    const client_id = await registerClient(b);
    const page = await get(b, authorizePath(client_id));
    const html = await page.text();
    expect(html).toContain("<h1>What&#39;s your email to sign up for Rec It Bot?</h1>");
    expect(html).toContain("<strong>Grok Bot</strong> wants to connect");
    const f = formFields(html);
    const email = newEmail();
    expect((await post(b, "/oauth/authorize/email", { ...f, email })).status).toBe(200);
    const code = /^(\d{6})$/m.exec(box.sent.at(-1)!.text)![1];
    const verified = await post(b, "/oauth/authorize/code", { ...f, code });
    expect(verified.status).toBe(303);
    expect(sessionOf(b)).toBeUndefined();
    const consent = await get(b, new URL(verified.headers.get("location")!).pathname + new URL(verified.headers.get("location")!).search);
    expect(await consent.text()).toContain("Approve");
    const approved = await post(b, "/oauth/authorize/decide", { ...f, decision: "allow" });
    expect(approved.status).toBe(303);
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    expect(approved.headers.getSetCookie().find((c) => c.startsWith("__Host-rb_session="))).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    expect(await whoIs(b)).toBe(await accountFor(email));
  });

  it("deny does not sign the browser in", async () => {
    const b = browser();
    const client_id = await registerClient(b);
    const f = formFields(await (await get(b, authorizePath(client_id))).text());
    await post(b, "/oauth/authorize/email", { ...f, email: newEmail() });
    await post(b, "/oauth/authorize/code", { ...f, code: /^(\d{6})$/m.exec(box.sent.at(-1)!.text)![1] });
    const denied = await post(b, "/oauth/authorize/decide", { ...f, decision: "deny" });
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(sessionOf(b)).toBeUndefined();
  });
});
