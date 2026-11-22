import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { LIMITS } from "../src/env";
import { governor } from "../src/governor";
import worker from "../src/index";
import { now, randomId } from "../src/util";
import { fakeSiteverify, freshIp, mailbox, TURNSTILE_TOKEN, withEnv } from "./helpers";

const ROOT = "https://example.test";
const MCP = "https://mcp.example.test";
const box = mailbox();
const verify = fakeSiteverify();
const mail = withEnv({ EMAIL: box.binding, OAUTH_DEV_LOG_LINKS: undefined });
const RETRY = "Please complete the check and try again.";

beforeEach(() => {
  box.sent.length = 0;
  verify.mockClear();
});

/** A browser: one host, one IP, a cookie jar. */
type Browser = { origin: string; ip: string; jar: Map<string, string> };
const browser = (origin = ROOT): Browser => ({ origin, ip: freshIp(), jar: new Map() });

async function send(b: Browser, path: string, init: RequestInit = {}, e: Env = mail): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("cookie", [...b.jar].map(([k, v]) => `${k}=${v}`).join("; "));
  headers.set("cf-connecting-ip", b.ip);
  const res = await worker.fetch(new Request(b.origin + path, { ...init, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    b.jar.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
  }
  return res;
}

const post = (b: Browser, path: string, fields: Record<string, string>, e: Env = mail) =>
  send(b, path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: b.origin }, body: new URLSearchParams(fields).toString() }, e);

/** The form's hidden fields: the signed `f` of a /signin email page (it has no row yet), else `p` + `csrf`. */
const formFields = (html: string): Record<string, string> => {
  const f = /name="f" value="([^"]+)"/.exec(html);
  if (f) return { f: f[1].replace(/&amp;/g, "&") };
  return { p: /name="p" value="([^"]+)"/.exec(html)![1], csrf: /name="csrf" value="([^"]+)"/.exec(html)![1] };
};
const newEmail = () => `t${randomId(64).toLowerCase()}@example.com`;

/** GET /signin: the email page and its form fields. */
async function signinPage(b: Browser, e: Env = mail) {
  const res = await send(b, "/signin?next=/", {}, e);
  expect(res.status).toBe(200);
  const html = await res.text();
  return { res, html, f: formFields(html) };
}

/** GET /oauth/authorize for a fresh public client: the email page and its form fields. */
async function authorizePage(b: Browser) {
  const reg = await send(b, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test App", redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: "https://app.example/cb",
    state: randomId(64),
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
  });
  const res = await send(b, `/oauth/authorize?${q}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, f: formFields(html) };
}

const globalCount = () =>
  runInDurableObject(env.GOVERNOR.get(env.GOVERNOR.idFromName("global")), (_i, s) =>
    Number(s.storage.sql.exec<{ n: number }>("SELECT coalesce(sum(n), 0) AS n FROM rl WHERE k = 'oauth-email:global'").one().n),
  );

describe("Turnstile on the sign-in email step", () => {
  it("the email page carries the managed widget with the site key, and its CSP allows Turnstile's script and frame only", async () => {
    for (const { html, res } of [await signinPage(browser()), { ...(await authorizePage(browser(MCP))), res: null }]) {
      expect(html).toContain('<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA" data-action="signin" data-theme="dark"></div>');
      expect(html).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>');
      if (res) {
        const csp = res.headers.get("content-security-policy")!;
        expect(csp).toContain("script-src https://challenges.cloudflare.com");
        expect(csp).toContain("frame-src https://challenges.cloudflare.com");
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
      }
    }
  });

  it("the code page loads no Turnstile and keeps the strict CSP", async () => {
    const b = browser();
    const { f } = await signinPage(b);
    const res = await post(b, "/signin", { ...f, email: newEmail(), "cf-turnstile-response": TURNSTILE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).not.toContain("challenges.cloudflare.com");
    expect(await res.text()).not.toContain('class="cf-turnstile"');
  });

  it("a valid token sends the email, on /signin and on /oauth/authorize/email", async () => {
    const b = browser();
    const { f } = await signinPage(b);
    const email = newEmail();
    const res = await post(b, "/signin", { ...f, email, "cf-turnstile-response": TURNSTILE_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Enter your code");
    expect(box.sent.map((m) => m.to)).toEqual([email]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0].get("response")).toBe(TURNSTILE_TOKEN);
    expect(verify.mock.calls[0][0].get("remoteip")).toBe(b.ip);

    const a = browser(MCP);
    const { f: af } = await authorizePage(a);
    const other = newEmail();
    const r2 = await post(a, "/oauth/authorize/email", { ...af, email: other, "cf-turnstile-response": TURNSTILE_TOKEN });
    expect(r2.status).toBe(200);
    expect(box.sent.map((m) => m.to)).toEqual([email, other]);
  });

  it("missing, failing or unverifiable tokens, or a missing key: no email, the page asks to retry with the email kept", async () => {
    const cases: { name: string; token?: string; e?: Env; throws?: boolean }[] = [
      { name: "missing token" },
      { name: "empty token", token: "" },
      { name: "failing token", token: "bad-token" },
      { name: "siteverify throws", token: TURNSTILE_TOKEN, throws: true },
      { name: "no TURNSTILE_SECRET_KEY", token: TURNSTILE_TOKEN, e: withEnv({ ...mail, TURNSTILE_SECRET_KEY: undefined }) },
      { name: "no TURNSTILE_SITE_KEY", token: TURNSTILE_TOKEN, e: withEnv({ ...mail, TURNSTILE_SITE_KEY: undefined }) },
      { name: "failing secret", token: TURNSTILE_TOKEN, e: withEnv({ ...mail, TURNSTILE_SECRET_KEY: "2x0000000000000000000000000000000AA" }) },
    ];
    for (const c of cases) {
      for (const path of ["/signin", "/oauth/authorize/email"]) {
        const b = browser(path === "/signin" ? ROOT : MCP);
        const f = path === "/signin" ? (await signinPage(b, c.e)).f : (await authorizePage(b)).f;
        if (c.throws) verify.mockImplementationOnce(async () => Promise.reject(new Error("network down")));
        const email = newEmail();
        const fields: Record<string, string> = { ...f, email, ...(c.token !== undefined ? { "cf-turnstile-response": c.token } : {}) };
        const res = await post(b, path, fields, c.e);
        const html = await res.text();
        expect(res.status, `${c.name} ${path}`).toBe(400);
        expect(html, c.name).toContain(RETRY);
        expect(html, c.name).toContain(`value="${email}"`);
        expect(box.sent, c.name).toEqual([]);
      }
    }
    // The page without a site key has no widget (and every submit is refused, above).
    const noSite = await signinPage(browser(), withEnv({ ...mail, TURNSTILE_SITE_KEY: undefined }));
    expect(noSite.html).not.toContain('class="cf-turnstile"');
    expect(noSite.res.headers.get("content-security-policy")).not.toContain("challenges.cloudflare.com");
  });

  it("a resend needs a fresh token; the code step does not", async () => {
    const b = browser();
    const { f } = await signinPage(b);
    const email = newEmail();
    const first = await post(b, "/signin", { ...f, email, "cf-turnstile-response": TURNSTILE_TOKEN });
    expect(first.status).toBe(200);
    expect(box.sent).toHaveLength(1);
    // The sign-in has its row now: resends and the code go with the code page's fields.
    const cf = formFields(await first.text());

    const noToken = await post(b, "/signin", { ...cf, resend: "1" });
    expect(noToken.status).toBe(400);
    const html = await noToken.text();
    expect(html).toContain(RETRY);
    expect(html).toContain(`value="${email}"`);
    expect(box.sent).toHaveLength(1);
    expect((await post(b, "/signin", { ...cf, resend: "1", "cf-turnstile-response": "bad-token" })).status).toBe(400);
    expect(box.sent).toHaveLength(1);
    expect((await post(b, "/signin", { ...cf, resend: "1", "cf-turnstile-response": TURNSTILE_TOKEN })).status).toBe(200);
    expect(box.sent).toHaveLength(2);

    verify.mockClear();
    const code = /^(\d{6})$/m.exec(box.sent.at(-1)!.text)![1];
    expect((await post(b, "/signin", { ...cf, code })).status).toBe(303);
    expect(verify).not.toHaveBeenCalled();
  });

  it("cheap checks come first: an invalid or disposable address costs no siteverify call", async () => {
    const b = browser();
    const { f } = await signinPage(b);
    expect((await post(b, "/signin", { ...f, email: "nope", "cf-turnstile-response": TURNSTILE_TOKEN })).status).toBe(400);
    expect((await post(b, "/signin", { ...f, email: "x@mailinator.com", "cf-turnstile-response": TURNSTILE_TOKEN })).status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
    expect(box.sent).toEqual([]);
  });
});

describe("global daily cap on sign-in emails", () => {
  it(`counts only emails about to be sent; past ${LIMITS.signinEmailsPerDay} in a UTC day the next is refused with 429 and no email`, async () => {
    expect(LIMITS.signinEmailsPerDay).toBe(500);
    const before = await globalCount();
    const b = browser();
    const { f } = await signinPage(b);
    expect((await post(b, "/signin", { ...f, email: newEmail(), "cf-turnstile-response": "bad-token" })).status).toBe(400);
    expect(await globalCount()).toBe(before);
    expect((await post(b, "/signin", { ...f, email: newEmail(), "cf-turnstile-response": TURNSTILE_TOKEN })).status).toBe(200);
    expect(await globalCount()).toBe(before + 1);

    // Use up the rest of today's sends directly on the Governor.
    const g = governor(env);
    while ((await g.hit("oauth-email:global", LIMITS.signinEmailsPerDay, 86400, now())).ok);
    expect(await globalCount()).toBe(LIMITS.signinEmailsPerDay);
    box.sent.length = 0;

    for (const path of ["/signin", "/oauth/authorize/email"]) {
      const c = browser(path === "/signin" ? ROOT : MCP);
      const cf = path === "/signin" ? (await signinPage(c)).f : (await authorizePage(c)).f;
      const res = await post(c, path, { ...cf, email: newEmail(), "cf-turnstile-response": TURNSTILE_TOKEN });
      expect(res.status).toBe(429);
      expect(await res.text()).toContain("Sign-in emails are paused for today. Try again later.");
    }
    expect(box.sent).toEqual([]);
  });
});
