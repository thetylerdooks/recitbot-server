import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { createAccount, findAccount, findOrCreateAccount, signupAllowed, SignupsDisabledError } from "../src/oauth/accounts";
import { redirectMatches } from "../src/oauth/clients";
import { outbound } from "../src/oauth/net";
import { b64url, randomId, sha256Hex } from "../src/util";
import { fakeSiteverify, freshIp, mailbox, seedAccount, type SentEmail, TURNSTILE_TOKEN, withEnv } from "./helpers";

const MCP = "https://mcp.example.test";
const ROOT = "https://example.test";
const LOCAL = "http://127.0.0.1:8799";
const CB = "https://app.example/cb";
const box = mailbox();
fakeSiteverify();
const mail = withEnv({ EMAIL: box.binding, OAUTH_DEV_LOG_LINKS: undefined });

const realFetch = outbound.fetch;
const emails: SentEmail[] = box.sent;
let cimd: Record<string, () => Response> = {};
let fetched: string[] = [];

beforeEach(() => {
  box.sent.length = 0;
  cimd = {};
  fetched = [];
  outbound.fetch = async (input) => {
    fetched.push(input);
    if (cimd[input]) return cimd[input]();
    throw new Error(`unexpected network call: ${input}`);
  };
});
afterEach(() => {
  outbound.fetch = realFetch;
});

async function at(origin: string, path: string, init: RequestInit = {}, e: Env = mail): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", freshIp());
  const res = await worker.fetch(new Request(origin + path, { ...init, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const rpc = (method: string, params?: unknown, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const toolCall = (name: string, args = {}) => rpc("tools/call", { name, arguments: args });

function mcpAt(origin: string, body: string, token?: string, headers: Record<string, string> = {}, e: Env = mail) {
  return at(origin, "/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body }, e);
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function registerClient(origin: string, body: Record<string, unknown>) {
  const res = await at(origin, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { res, data: (await res.json()) as any };
}

const publicClient = async (origin = MCP, redirect = CB) =>
  (await registerClient(origin, { client_name: "Test App", redirect_uris: [redirect], token_endpoint_auth_method: "none" })).data.client_id as string;

async function pkce() {
  const verifier = randomId(256) + "-._~" + randomId(64);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

type Session = { origin: string; cookie: string; p: string; csrf: string; verifier: string; state: string; ip: string };

/** GET /oauth/authorize; returns the response, plus the session when it rendered the email form. */
async function authorize(origin: string, params: Record<string, string>, e: Env = mail) {
  const { verifier, challenge } = await pkce();
  const state = randomId(64);
  const ip = freshIp();
  const q = new URLSearchParams({ response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", ...params });
  for (const [k, v] of Object.entries(params)) if (v === "") q.delete(k);
  const res = await at(origin, `/oauth/authorize?${q}`, { headers: { "cf-connecting-ip": ip } }, e);
  const html = res.status === 200 ? await res.text() : "";
  const p = /name="p" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { res, html, s: { origin, cookie, p, csrf, verifier, state, ip } as Session };
}

function post(s: Session, path: string, fields: Record<string, string>, headers: Record<string, string> = {}, e: Env = mail) {
  return at(s.origin, path, {
    method: "POST",
    headers: { ...FORM, cookie: s.cookie, origin: s.origin, "cf-connecting-ip": s.ip, ...headers },
    body: form({ p: s.p, csrf: s.csrf, "cf-turnstile-response": TURNSTILE_TOKEN, ...fields }),
  }, e);
}

/** Submits the email; returns the emailed link (path) and code. */
async function sendEmail(s: Session, email: string, e: Env = mail) {
  const res = await post(s, "/oauth/authorize/email", { email }, {}, e);
  const last = emails.at(-1);
  const link = last ? new URL(/https?:\/\/\S+\/oauth\/magic\?t=[A-Za-z0-9]+/.exec(last.text)![0]) : null;
  return { res, path: link ? link.pathname + link.search : "", code: last ? /^(\d{6})$/m.exec(last.text)![1] : "" };
}

const openLink = (s: Session, path: string, cookie = s.cookie, e: Env = mail) => at(s.origin, path, { headers: cookie ? { cookie, "cf-connecting-ip": s.ip } : {} }, e);

/** Consent page after sign-in, then Allow (or Deny). Returns the redirect. */
async function approve(s: Session, decision = "allow") {
  const consent = await at(s.origin, `/oauth/authorize/consent?p=${s.p}`, { headers: { cookie: s.cookie } });
  expect(consent.status).toBe(200);
  const res = await post(s, "/oauth/authorize/decide", { decision });
  expect(res.status).toBe(303);
  return new URL(res.headers.get("location")!);
}

/** Whole browser flow up to the redirect with ?code=. */
async function getCode(origin: string, client_id: string, opts: { redirect?: string; email?: string; resource?: string; scope?: string } = {}) {
  const { s } = await authorize(origin, {
    client_id,
    redirect_uri: opts.redirect ?? CB,
    ...(opts.resource ? { resource: opts.resource } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  expect(s.p).not.toBe("");
  const { path } = await sendEmail(s, opts.email ?? `u${randomId(32)}@example.com`);
  const linked = await openLink(s, path);
  expect(linked.status).toBe(303);
  const loc = await approve(s);
  return { code: loc.searchParams.get("code")!, loc, s };
}

function token(origin: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return at(origin, "/oauth/token", { method: "POST", headers: { ...FORM, ...headers }, body: form(fields) });
}

async function tokensFor(origin: string, client_id: string, opts: { redirect?: string; email?: string } = {}) {
  const { code, s } = await getCode(origin, client_id, opts);
  const res = await token(origin, { grant_type: "authorization_code", code, redirect_uri: opts.redirect ?? CB, code_verifier: s.verifier, client_id });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string };
}

const listVideos = (origin: string, t: string, headers: Record<string, string> = {}) => mcpAt(origin, toolCall("list_videos"), t, headers);

describe("MCP auth gate", () => {
  for (const host of [MCP, ROOT]) {
    it(`unauthenticated tools/call is a 401 with the resource metadata challenge (${host})`, async () => {
      const res = await mcpAt(host, toolCall("list_videos"));
      expect(res.status).toBe(401);
      const challenge = `Bearer resource_metadata="${host}/.well-known/oauth-protected-resource/mcp", scope="recitbot"`;
      expect(res.headers.get("www-authenticate")).toBe(challenge);
      const body = (await res.json()) as any;
      expect(body.result.isError).toBe(true);
      expect(body.result._meta["mcp/www_authenticate"]).toEqual([challenge]);
    });
  }

  it("initialize, tools/list and ping work without a token", async () => {
    for (const m of ["initialize", "tools/list", "ping"]) expect((await mcpAt(MCP, rpc(m, m === "initialize" ? { protocolVersion: "2025-11-25" } : {}))).status).toBe(200);
    const init = (await (await mcpAt(MCP, rpc("initialize", {}))).json()) as any;
    expect(init.result.instructions).toContain("OAuth connector");
    expect(init.result.instructions).not.toMatch(/signup/);
  });

  it("an invalid token is a 401 invalid_token challenge", async () => {
    const res = await mcpAt(ROOT, toolCall("list_videos"), `rbat_${randomId(64)}_${randomId(256)}`);
    expect(res.status).toBe(401);
    const challenge = `Bearer error="invalid_token", resource_metadata="${ROOT}/.well-known/oauth-protected-resource/mcp", scope="recitbot"`;
    expect(res.headers.get("www-authenticate")).toBe(challenge);
    expect(((await res.json()) as any)._meta["mcp/www_authenticate"]).toEqual([challenge]);
  });

  it("signup is gone: not listed, and calling it fails", async () => {
    const names = ((await (await mcpAt(MCP, rpc("tools/list"))).json()) as any).result.tools.map((t: any) => t.name);
    expect(names).not.toContain("signup");
    expect((await mcpAt(MCP, toolCall("signup"))).status).toBe(401);
    const { key } = await seedAccount(false);
    const body = (await (await mcpAt(MCP, toolCall("signup"), key)).json()) as any;
    expect(body.error.message).toContain("Unknown tool");
  });

  it("legacy ark_ API keys still work on tools/call", async () => {
    const { key } = await seedAccount();
    for (const host of [MCP, ROOT, "https://rec.example"]) {
      const res = await mcpAt(host, toolCall("list_videos"), key);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).result.isError).toBe(false);
    }
  });
});

describe("discovery", () => {
  for (const host of [MCP, ROOT]) {
    it(`protected resource and authorization server metadata (${host})`, async () => {
      const prm = {
        resource: `${host}/mcp`,
        authorization_servers: [host],
        scopes_supported: ["recitbot"],
        bearer_methods_supported: ["header"],
        resource_name: "Recitbot",
        resource_documentation: "https://example.test/docs/mcp",
      };
      const as = {
        issuer: host,
        authorization_endpoint: `${host}/oauth/authorize`,
        token_endpoint: `${host}/oauth/token`,
        registration_endpoint: `${host}/oauth/register`,
        revocation_endpoint: `${host}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["recitbot", "offline_access"],
        service_documentation: "https://example.test/docs/mcp",
      };
      for (const [path, want] of [
        ["/.well-known/oauth-protected-resource/mcp", prm],
        ["/.well-known/oauth-protected-resource", prm],
        ["/.well-known/oauth-authorization-server", as],
        ["/.well-known/openid-configuration", as],
      ] as const) {
        const res = await at(host, path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        expect(await res.json()).toEqual(want);
      }
    });
  }

  it("loopback dev hosts keep their origin; unknown hosts fall back to mcp.example.test", async () => {
    expect(((await (await at(LOCAL, "/.well-known/oauth-protected-resource")).json()) as any).resource).toBe(`${LOCAL}/mcp`);
    expect(((await (await at("https://evil.example", "/.well-known/oauth-authorization-server")).json()) as any).issuer).toBe(MCP);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client", async () => {
    const { res, data } = await registerClient(MCP, { client_name: "Claude", redirect_uris: [CB, "http://127.0.0.1/cb"], token_endpoint_auth_method: "none" });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(data).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none", redirect_uris: [CB, "http://127.0.0.1/cb"], response_types: ["code"] });
    expect(data.client_secret).toBeUndefined();
    expect(typeof data.client_id_issued_at).toBe("number");
  });

  it("registers a confidential client; only the secret's hash is stored", async () => {
    const { res, data } = await registerClient(MCP, { redirect_uris: [CB], token_endpoint_auth_method: "client_secret_post" });
    expect(res.status).toBe(201);
    expect(data.client_secret).toMatch(/^rbcs_/);
    expect(data.client_secret_expires_at).toBe(0);
    const row = await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").bind(data.client_id).first<Record<string, unknown>>();
    expect(row!.client_secret_hash).toBe(await sha256Hex(data.client_secret));
    expect(JSON.stringify(row)).not.toContain(data.client_secret);
  });

  it("rejects bad redirect_uris", async () => {
    for (const uris of [[], ["myapp://cb"], ["http://app.example/cb"], ["https://app.example/cb#frag"], ["javascript:alert(1)"], "https://app.example/cb"]) {
      const { res, data } = await registerClient(MCP, { redirect_uris: uris, token_endpoint_auth_method: "none" });
      expect(res.status).toBe(400);
      expect(data.error).toBe("invalid_redirect_uri");
    }
  });

  it("rate limits registrations per IP", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await at(MCP, "/oauth/register", { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ redirect_uris: [CB], token_endpoint_auth_method: "none" }) });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("client ID metadata documents", () => {
  const doc = (url: string, over: Record<string, unknown> = {}) => () =>
    Response.json({ client_id: url, client_name: "CIMD App", redirect_uris: [CB], token_endpoint_auth_method: "none", ...over });

  it("accepts a valid document and completes the flow", async () => {
    const id = `https://cimd.example/${randomId(64)}/client.json`;
    cimd[id] = doc(id);
    const { res, html } = await authorize(MCP, { client_id: id, redirect_uri: CB });
    expect(res.status).toBe(200);
    expect(html).toContain("CIMD App");
    const t = await tokensFor(MCP, id);
    expect((await listVideos(MCP, t.access_token)).status).toBe(200);
    expect(fetched.filter((f) => f === id)).toHaveLength(1); // cached after the first fetch
  });

  it("rejects a document whose client_id differs", async () => {
    const id = `https://cimd.example/${randomId(64)}`;
    cimd[id] = doc(id, { client_id: "https://cimd.example/other" });
    const { res } = await authorize(MCP, { client_id: id, redirect_uri: CB });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rejects a redirect_uri the document doesn't list", async () => {
    const id = `https://cimd.example/${randomId(64)}`;
    cimd[id] = doc(id);
    const { res } = await authorize(MCP, { client_id: id, redirect_uri: "https://attacker.example/cb" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rejects confidential clients, redirects and oversized documents", async () => {
    const ids = [1, 2, 3].map(() => `https://cimd.example/${randomId(64)}`);
    cimd[ids[0]] = doc(ids[0], { token_endpoint_auth_method: "client_secret_basic" });
    cimd[ids[1]] = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/doc" } });
    cimd[ids[2]] = doc(ids[2], { pad: "x".repeat(70 * 1024) });
    for (const id of ids) expect((await authorize(MCP, { client_id: id, redirect_uri: CB })).res.status).toBe(400);
  });

  it("never fetches IP literals, localhost, local names or root paths", async () => {
    for (const id of [
      "https://127.0.0.1/client.json",
      "https://10.0.0.5/client.json",
      "https://[::1]/client.json",
      "https://localhost/client.json",
      "https://printer.local/client.json",
      "https://intranet/client.json",
      "https://cimd.example/",
      "http://cimd.example/client.json",
    ]) {
      const { res } = await authorize(MCP, { client_id: id, redirect_uri: CB });
      expect(res.status).toBe(400);
    }
    expect(fetched).toEqual([]);
  });
});

describe("authorize", () => {
  it("rejects missing or plain PKCE, bad resource and bad scope by redirect with state and iss", async () => {
    const client_id = await publicClient(ROOT);
    for (const [params, error] of [
      [{ code_challenge: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: "" }, "invalid_request"],
      [{ resource: `${MCP}/mcp` }, "invalid_target"],
      [{ resource: "https://evil.example/mcp" }, "invalid_target"],
      [{ scope: "recitbot admin" }, "invalid_scope"],
      [{ response_type: "token" }, "unsupported_response_type"],
    ] as const) {
      const { res, s } = await authorize(ROOT, { client_id, redirect_uri: CB, ...params });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe(CB);
      expect(loc.searchParams.get("error")).toBe(error);
      expect(loc.searchParams.get("state")).toBe(s.state);
      expect(loc.searchParams.get("iss")).toBe(ROOT);
    }
  });

  it("shows an error page (never redirects) for an unknown client or unregistered redirect_uri", async () => {
    const client_id = await publicClient();
    for (const params of [
      { client_id: randomId(128), redirect_uri: CB },
      { client_id, redirect_uri: "https://attacker.example/cb" },
      { client_id, redirect_uri: `${CB}?x=1` },
      { client_id, redirect_uri: "" },
    ]) {
      const { res } = await authorize(MCP, params);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("defaults resource to this host's /mcp; pages are never framed or cached", async () => {
    const client_id = await publicClient();
    const { res, s } = await authorize(MCP, { client_id, redirect_uri: CB });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(s.cookie).toMatch(/^rbo_/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Secure/);
    const row = await env.DB.prepare("SELECT resource, scope FROM oauth_pending WHERE id = ?").bind(s.p).first<any>();
    expect(row).toEqual({ resource: `${MCP}/mcp`, scope: "recitbot" });
  });

  it("magic links are single use and stored only as hashes", async () => {
    const client_id = await publicClient();
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB });
    const { res, path } = await sendEmail(s, `u${randomId(32)}@example.com`);
    expect(res.status).toBe(200);
    expect(emails.at(-1)!.to).toMatch(/^u[A-Za-z0-9]+@example\.com$/);
    const t = new URL(MCP + path).searchParams.get("t")!;
    const row = await env.DB.prepare("SELECT magic_hash FROM oauth_pending WHERE id = ?").bind(s.p).first<any>();
    expect(row.magic_hash).toBe(await sha256Hex(t));
    expect((await openLink(s, path)).status).toBe(303);
    expect((await openLink(s, path)).status).toBe(400);
  });

  it("expired magic links are rejected", async () => {
    const client_id = await publicClient();
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB });
    const { path } = await sendEmail(s, `u${randomId(32)}@example.com`);
    await env.DB.prepare("UPDATE oauth_pending SET magic_expires_at = 0 WHERE id = ?").bind(s.p).run();
    const res = await openLink(s, path);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("expired");
  });

  it("a magic link opened in another browser is refused and not used up", async () => {
    const client_id = await publicClient();
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB });
    const { path } = await sendEmail(s, `u${randomId(32)}@example.com`);
    expect((await openLink(s, path, "")).status).toBe(403);
    expect((await openLink(s, path, `${s.cookie.split("=")[0]}=${randomId(256)}`)).status).toBe(403);
    expect((await openLink(s, path)).status).toBe(303);
  });

  it("the 6-digit code signs in; it locks after 5 wrong tries", async () => {
    const client_id = await publicClient();
    const ok = (await authorize(MCP, { client_id, redirect_uri: CB })).s;
    const sent = await sendEmail(ok, `u${randomId(32)}@example.com`);
    const res = await post(ok, "/oauth/authorize/code", { code: sent.code });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${MCP}/oauth/authorize/consent?p=${ok.p}`);
    expect((await approve(ok)).searchParams.get("code")).toBeTruthy();

    const bad = (await authorize(MCP, { client_id, redirect_uri: CB })).s;
    const { code, path } = await sendEmail(bad, `u${randomId(32)}@example.com`);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      const r = await post(bad, "/oauth/authorize/code", { code: wrong });
      expect(r.status).toBe(400);
      expect(await r.text()).toContain(`${5 - i} tr`);
    }
    expect(await (await post(bad, "/oauth/authorize/code", { code: wrong })).text()).toContain("too many times");
    expect((await post(bad, "/oauth/authorize/code", { code })).status).toBe(400);
    expect((await openLink(bad, path)).status).toBe(400);
  });

  it("consent needs a same-origin POST with the CSRF token and the browser cookie", async () => {
    const client_id = await publicClient();
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB });
    const { path } = await sendEmail(s, `u${randomId(32)}@example.com`);
    await openLink(s, path);
    expect((await post(s, "/oauth/authorize/decide", { decision: "allow" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(s, "/oauth/authorize/decide", { decision: "allow" }, { origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(s, "/oauth/authorize/decide", { decision: "allow", csrf: "x" })).status).toBe(403);
    expect((await post(s, "/oauth/authorize/decide", { decision: "allow" }, { cookie: "" })).status).toBe(403);
    // Referrer-Policy no-referrer makes browsers send Origin: null on same-origin form posts; Sec-Fetch-Site decides.
    const res = await post(s, "/oauth/authorize/decide", { decision: "allow" }, { origin: "null", "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("deny redirects with access_denied, state and iss", async () => {
    const client_id = await publicClient();
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB });
    await openLink(s, (await sendEmail(s, `u${randomId(32)}@example.com`)).path);
    const loc = await approve(s, "deny");
    expect(Object.fromEntries(loc.searchParams)).toEqual({ error: "access_denied", error_description: "The user denied access.", state: s.state, iss: MCP });
  });

  it("allow redirects with code, state and iss; the same email signs in to the same account", async () => {
    const client_id = await publicClient();
    const email = `Same${randomId(32)}@Example.com`;
    const a = await getCode(MCP, client_id, { email });
    expect(a.loc.searchParams.get("state")).toBe(a.s.state);
    expect(a.loc.searchParams.get("iss")).toBe(MCP);
    await getCode(MCP, client_id, { email: ` ${email.toLowerCase()} ` });
    const rows = await env.DB.prepare("SELECT id, email FROM accounts WHERE email = ?").bind(email.toLowerCase()).all();
    expect(rows.results).toHaveLength(1);
  });

  it("new accounts follow the per-IP daily limit, disposable domains and READ_ONLY", async () => {
    const client_id = await publicClient();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { s } = await authorize(MCP, { client_id, redirect_uri: CB });
      s.ip = ip;
      const { res, path } = await sendEmail(s, `n${randomId(32)}@example.com`);
      statuses.push(res.status === 200 ? (await openLink(s, path)).status : res.status);
    }
    expect(statuses).toEqual([303, 303, 303, 429]);

    const { s } = await authorize(MCP, { client_id, redirect_uri: CB });
    const disposable = await sendEmail(s, "x@mailinator.com");
    expect(disposable.res.status).toBe(400);
    expect(await disposable.res.text()).toContain("Disposable");

    const ro = withEnv({ ...mail, SERVICE_MODE: "READ_ONLY" });
    const r = await authorize(MCP, { client_id, redirect_uri: CB }, ro);
    expect((await sendEmail(r.s, `n${randomId(32)}@example.com`, ro)).res.status).toBe(503);
  });

  it("without the EMAIL binding: links are logged on loopback with OAUTH_DEV_LOG_LINKS=1, and sign-in fails closed otherwise", async () => {
    const devLog = withEnv({ EMAIL: undefined, OAUTH_DEV_LOG_LINKS: "1" });
    const noMail = withEnv({ EMAIL: undefined });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const client_id = await publicClient(LOCAL, "http://127.0.0.1/cb");
    const { s } = await authorize(LOCAL, { client_id, redirect_uri: "http://127.0.0.1:9999/cb" }, devLog);
    expect((await post(s, "/oauth/authorize/email", { email: `d${randomId(32)}@example.com` }, {}, devLog)).status).toBe(200);
    const line = spy.mock.calls.flat().find((l) => String(l).startsWith("[magic-link]"));
    spy.mockRestore();
    expect(line).toMatch(new RegExp(`link=${LOCAL}/oauth/magic\\?t=[A-Za-z0-9]+ code=\\d{6}`));

    const local = await authorize(LOCAL, { client_id, redirect_uri: "http://127.0.0.1:9999/cb" }, noMail);
    expect((await post(local.s, "/oauth/authorize/email", { email: `d${randomId(32)}@example.com` }, {}, noMail)).status).toBe(503);
    const prodClient = await publicClient();
    const p = await authorize(MCP, { client_id: prodClient, redirect_uri: CB }, devLog);
    expect((await post(p.s, "/oauth/authorize/email", { email: `d${randomId(32)}@example.com` }, {}, devLog)).status).toBe(503);
    expect(emails).toEqual([]);
  });
});

describe("SIGNUPS_DISABLED", () => {
  const closed = withEnv({ ...mail, SIGNUPS_DISABLED: "true" });
  const accounts = async () => (await env.DB.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>())!.n;
  const newEmail = () => `c${randomId(32).toLowerCase()}@example.com`;

  it("on: a new email is refused plainly (403), no email sent and no account created, for an app and for the website", async () => {
    const client_id = await publicClient();
    const before = await accounts();
    const email = newEmail();
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB }, closed);
    const { res } = await sendEmail(s, email, closed);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("New signups are closed.");
    expect(text).not.toMatch(/try again|later|tomorrow/i);

    const ip = freshIp();
    const form0 = await (await at(ROOT, "/signin?next=/", { headers: { "cf-connecting-ip": ip } }, closed)).text();
    const f = /name="f" value="([^"]+)"/.exec(form0)![1];
    const web = await at(ROOT, "/signin", {
      method: "POST",
      headers: { ...FORM, origin: ROOT, "cf-connecting-ip": ip },
      body: form({ f, email, "cf-turnstile-response": TURNSTILE_TOKEN }),
    }, closed);
    expect(web.status).toBe(403);
    expect(await web.text()).toContain("New signups are closed.");

    expect(emails).toEqual([]);
    expect(await accounts()).toBe(before);
    expect(await findAccount(env, email)).toBeNull();
    // It wins over READ_ONLY's "try again later", and uses up nothing of the signup limits.
    const both = withEnv({ ...closed, SERVICE_MODE: "READ_ONLY" });
    const r = await authorize(MCP, { client_id, redirect_uri: CB }, both);
    expect((await sendEmail(r.s, newEmail(), both)).res.status).toBe(403);
  });

  it("on: a sign-in started before the freeze can't create an account either (link or code)", async () => {
    const client_id = await publicClient();
    const before = await accounts();
    const a = await authorize(MCP, { client_id, redirect_uri: CB });
    const byLink = await openLink(a.s, (await sendEmail(a.s, newEmail())).path, a.s.cookie, closed);
    expect(byLink.status).toBe(403);
    expect(await byLink.text()).toContain("New signups are closed.");
    const b = await authorize(MCP, { client_id, redirect_uri: CB });
    const { code } = await sendEmail(b.s, newEmail());
    expect((await post(b.s, "/oauth/authorize/code", { code }, {}, closed)).status).toBe(403);
    expect(await accounts()).toBe(before);
  });

  it("on: an existing account signs in as normal", async () => {
    const client_id = await publicClient();
    const email = newEmail();
    const id = await createAccount(mail, email);
    const before = await accounts();
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB }, closed);
    const { res, path } = await sendEmail(s, email, closed);
    expect(res.status).toBe(200);
    expect((await openLink(s, path, s.cookie, closed)).status).toBe(303);
    expect((await env.DB.prepare("SELECT account_id FROM oauth_pending WHERE id = ?").bind(s.p).first<{ account_id: string }>())!.account_id).toBe(id);
    const loc = await approve(s);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(await accounts()).toBe(before);
  });

  it("off (unset, or anything but exactly \"true\"): a new email creates its account", async () => {
    const client_id = await publicClient();
    for (const v of [undefined, "false", "TRUE", "1"]) {
      const open = withEnv({ ...mail, SIGNUPS_DISABLED: v });
      const email = newEmail();
      const { s } = await authorize(MCP, { client_id, redirect_uri: CB }, open);
      const { res, path } = await sendEmail(s, email, open);
      expect(res.status, String(v)).toBe(200);
      expect((await openLink(s, path, s.cookie, open)).status, String(v)).toBe(303);
      expect(await findAccount(env, email), String(v)).toBeTruthy();
    }
  });

  it("createAccount and findOrCreateAccount refuse by themselves; existing emails still resolve", async () => {
    const email = newEmail();
    const before = await accounts();
    await expect(createAccount(closed, email)).rejects.toThrow(SignupsDisabledError);
    await expect(createAccount(closed, email)).rejects.toThrow("New signups are closed.");
    await expect(findOrCreateAccount(closed, email)).rejects.toThrow(SignupsDisabledError);
    expect(await accounts()).toBe(before);
    const id = await findOrCreateAccount(mail, email);
    expect(await findOrCreateAccount(closed, email.toUpperCase())).toBe(id);
    expect(await accounts()).toBe(before + 1);
  });
});

describe("SIGNUPS_ALLOWLIST", () => {
  const accounts = async () => (await env.DB.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>())!.n;
  const newEmail = () => `l${randomId(32).toLowerCase()}@example.com`;
  const closedFor = (...emails: string[]) => withEnv({ ...mail, SIGNUPS_DISABLED: "true", SIGNUPS_ALLOWLIST: emails.join(" , ") });

  it("closed: an allowlisted email signs up through the app flow (any case, padded), and nobody else does", async () => {
    const client_id = await publicClient();
    const allowed = newEmail();
    const other = newEmail();
    const closed = closedFor(`  ${allowed.toUpperCase()} `, newEmail());
    const before = await accounts();

    const { s } = await authorize(MCP, { client_id, redirect_uri: CB }, closed);
    const { res, path } = await sendEmail(s, allowed, closed);
    expect(res.status).toBe(200);
    expect((await openLink(s, path, s.cookie, closed)).status).toBe(303);
    const id = await findAccount(env, allowed);
    expect(id).toBeTruthy();
    expect((await approve(s)).searchParams.get("code")).toBeTruthy();
    expect(await accounts()).toBe(before + 1);

    // Someone not on the list: the same plain refusal as without an allowlist, no email, no account.
    const sent = emails.length;
    const o = await authorize(MCP, { client_id, redirect_uri: CB }, closed);
    const refused = await sendEmail(o.s, other, closed);
    expect(refused.res.status).toBe(403);
    expect(await refused.res.text()).toContain("New signups are closed.");
    expect(emails.length).toBe(sent);
    expect(await findAccount(env, other)).toBeNull();
    expect(await accounts()).toBe(before + 1);
  });

  it("closed: the website sign-in lets the allowlisted email through (sign-in email sent, not 403)", async () => {
    const allowed = newEmail();
    const closed = closedFor(allowed);
    const ip = freshIp();
    const form0 = await (await at(ROOT, "/signin?next=/", { headers: { "cf-connecting-ip": ip } }, closed)).text();
    const f = /name="f" value="([^"]+)"/.exec(form0)![1];
    const web = await at(ROOT, "/signin", {
      method: "POST",
      headers: { ...FORM, origin: ROOT, "cf-connecting-ip": ip },
      body: form({ f, email: allowed, "cf-turnstile-response": TURNSTILE_TOKEN }),
    }, closed);
    expect(web.status).toBe(200);
    expect(emails.at(-1)?.to).toBe(allowed);
  });

  it("exact address only: +tags, other domains and look-alikes stay refused; createAccount enforces it by itself", async () => {
    const allowed = newEmail();
    const closed = closedFor(allowed);
    const [local, domain] = allowed.split("@");
    for (const e of [`${local}+x@${domain}`, `${local}@other.example`, `x${allowed}`]) {
      expect(signupAllowed(closed, e), e).toBe(false);
      await expect(createAccount(closed, e)).rejects.toThrow(SignupsDisabledError);
    }
    expect(signupAllowed(closed, ` ${allowed.toUpperCase()} `)).toBe(true);
    const id = await createAccount(closed, allowed);
    expect(await findAccount(env, allowed)).toBe(id);
    // Closed with no allowlist (or an empty one): nobody.
    for (const v of [undefined, "", " , "]) {
      const none = withEnv({ ...mail, SIGNUPS_DISABLED: "true", SIGNUPS_ALLOWLIST: v });
      expect(signupAllowed(none, newEmail()), String(v)).toBe(false);
    }
  });

  it("open: the allowlist changes nothing (everyone may sign up)", async () => {
    const client_id = await publicClient();
    const open = withEnv({ ...mail, SIGNUPS_DISABLED: undefined, SIGNUPS_ALLOWLIST: newEmail() });
    const email = newEmail();
    expect(signupAllowed(open, email)).toBe(true);
    const { s } = await authorize(MCP, { client_id, redirect_uri: CB }, open);
    const { res, path } = await sendEmail(s, email, open);
    expect(res.status).toBe(200);
    expect((await openLink(s, path, s.cookie, open)).status).toBe(303);
    expect(await findAccount(env, email)).toBeTruthy();
  });
});

describe("token endpoint", () => {
  it("checks PKCE; a code works once and a replay revokes what it issued", async () => {
    const client_id = await publicClient();
    const first = await getCode(MCP, client_id);
    const wrong = await token(MCP, { grant_type: "authorization_code", code: first.code, redirect_uri: CB, code_verifier: (await pkce()).verifier, client_id });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error).toBe("invalid_grant");

    const { code, s } = await getCode(MCP, client_id);
    const fields = { grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: s.verifier, client_id };
    const ok = await token(MCP, fields);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const t = (await ok.json()) as any;
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "recitbot" });
    expect(t.access_token).toMatch(/^rbat_/);
    expect(t.refresh_token).toMatch(/^rbrt_/);
    expect((await listVideos(MCP, t.access_token)).status).toBe(200);

    const again = await token(MCP, fields);
    expect(((await again.json()) as any).error).toBe("invalid_grant");
    expect((await listVideos(MCP, t.access_token)).status).toBe(401);
  });

  it("rejects a redirect_uri mismatch, another client, a different resource and an expired code", async () => {
    const client_id = await publicClient();
    const other = await publicClient();
    for (const [over, error] of [
      [{ redirect_uri: "https://app.example/other" }, "invalid_grant"],
      [{ client_id: other }, "invalid_grant"],
      [{ resource: `${ROOT}/mcp` }, "invalid_target"],
    ] as [Record<string, string>, string][]) {
      const { code, s } = await getCode(MCP, client_id);
      const res = await token(MCP, { grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: s.verifier, client_id, ...over });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe(error);
    }
    const { code, s } = await getCode(MCP, client_id);
    await env.DB.prepare("UPDATE oauth_codes SET expires_at = 0 WHERE code_hash = ?").bind(await sha256Hex(code)).run();
    const res = await token(MCP, { grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: s.verifier, client_id });
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("confidential clients must authenticate (basic or post)", async () => {
    const { data } = await registerClient(MCP, { redirect_uris: [CB] });
    expect(data.token_endpoint_auth_method).toBe("client_secret_basic");
    const basic = `Basic ${btoa(`${data.client_id}:${data.client_secret}`)}`;
    const a = await getCode(MCP, data.client_id);
    const base = { grant_type: "authorization_code", code: a.code, redirect_uri: CB, code_verifier: a.s.verifier };
    const missing = await token(MCP, { ...base, client_id: data.client_id });
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as any).error).toBe("invalid_client");
    const bad = await token(MCP, base, { authorization: `Basic ${btoa(`${data.client_id}:rbcs_wrong`)}` });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("Basic");

    const b = await getCode(MCP, data.client_id);
    const viaBasic = await token(MCP, { grant_type: "authorization_code", code: b.code, redirect_uri: CB, code_verifier: b.s.verifier }, { authorization: basic });
    expect(viaBasic.status).toBe(200);
    const c = await getCode(MCP, data.client_id);
    const viaPost = await token(MCP, { grant_type: "authorization_code", code: c.code, redirect_uri: CB, code_verifier: c.s.verifier, client_id: data.client_id, client_secret: data.client_secret });
    expect(viaPost.status).toBe(200);
  });

  it("rejects other grant types and non-form bodies", async () => {
    const client_id = await publicClient();
    expect(((await (await token(MCP, { grant_type: "client_credentials", client_id })).json()) as any).error).toBe("unsupported_grant_type");
    const json = await at(MCP, "/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(((await json.json()) as any).error).toBe("invalid_request");
  });
});

describe("audience binding", () => {
  it("a token for example.test/mcp works there and nowhere else", async () => {
    const client_id = await publicClient(ROOT);
    const t = await tokensFor(ROOT, client_id);
    expect((await listVideos(ROOT, t.access_token)).status).toBe(200);
    const elsewhere = await listVideos(MCP, t.access_token);
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp", scope="recitbot"`,
    );
    expect((await listVideos("https://rec.example", t.access_token)).status).toBe(401);
  });

  it("OAuth sessions see their own account and can't mint API keys", async () => {
    const client_id = await publicClient();
    const t = await tokensFor(MCP, client_id);
    const body = (await (await mcpAt(MCP, toolCall("rotate_key"), t.access_token)).json()) as any;
    expect(body.result.structuredContent.error).toBe("NOT_SUPPORTED");
    const row = await env.DB.prepare("SELECT account_id FROM oauth_tokens WHERE id = ?").bind(t.access_token.split("_")[1]).first<any>();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM api_keys WHERE account_id = ?").bind(row.account_id).first("n")).toBe(0);
  });

  it("expired access tokens are refused without counting as failed logins", async () => {
    const client_id = await publicClient();
    const ip = freshIp();
    const t = await tokensFor(MCP, client_id);
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = 0 WHERE id = ?").bind(t.access_token.split("_")[1]).run();
    for (let i = 0; i < 12; i++) expect((await listVideos(MCP, t.access_token, { "cf-connecting-ip": ip })).status).toBe(401);
  });
});

describe("refresh tokens", () => {
  it("rotate on use; replaying a used one revokes the whole family", async () => {
    const client_id = await publicClient();
    const t1 = await tokensFor(MCP, client_id);
    const r = await token(MCP, { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id });
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as any;
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await listVideos(MCP, t2.access_token)).status).toBe(200);

    const replay = await token(MCP, { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id });
    expect(((await replay.json()) as any).error).toBe("invalid_grant");
    expect((await listVideos(MCP, t2.access_token)).status).toBe(401);
    expect((await token(MCP, { grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id })).status).toBe(400);
  });

  it("must come from the same client and for the same resource", async () => {
    const client_id = await publicClient();
    const other = await publicClient();
    const t = await tokensFor(MCP, client_id);
    expect((await token(MCP, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: other })).status).toBe(400);
    const wrongRes = await token(MCP, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id, resource: `${ROOT}/mcp` });
    expect(((await wrongRes.json()) as any).error).toBe("invalid_target");
    expect((await token(MCP, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id, resource: `${MCP}/mcp` })).status).toBe(200);
  });
});

describe("revocation", () => {
  const revoke = (client_id: string, tok: string) =>
    at(MCP, "/oauth/revoke", { method: "POST", headers: FORM, body: form({ token: tok, client_id }) });

  it("revokes access tokens", async () => {
    const client_id = await publicClient();
    const t = await tokensFor(MCP, client_id);
    expect((await revoke(client_id, t.access_token)).status).toBe(200);
    expect((await listVideos(MCP, t.access_token)).status).toBe(401);
    expect((await token(MCP, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id })).status).toBe(200);
  });

  it("revoking a refresh token revokes its family", async () => {
    const client_id = await publicClient();
    const t = await tokensFor(MCP, client_id);
    expect((await revoke(client_id, t.refresh_token)).status).toBe(200);
    expect((await listVideos(MCP, t.access_token)).status).toBe(401);
    expect((await token(MCP, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id })).status).toBe(400);
  });

  it("answers 200 for unknown tokens and leaves other clients' tokens alone", async () => {
    const client_id = await publicClient();
    expect((await revoke(client_id, "not-a-token")).status).toBe(200);
    expect((await revoke(client_id, `rbat_${randomId(64)}_${randomId(256)}`)).status).toBe(200);
    const t = await tokensFor(MCP, client_id);
    expect((await revoke(await publicClient(), t.access_token)).status).toBe(200);
    expect((await listVideos(MCP, t.access_token)).status).toBe(200);
  });
});

describe("CORS", () => {
  it("preflight on /mcp echoes the origin", async () => {
    const res = await at(MCP, "/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
    expect(res.status).toBe(204);
    expect(Object.fromEntries([...res.headers].filter(([k]) => k.startsWith("access-control-")))).toEqual({
      "access-control-allow-origin": "https://claude.ai",
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
      "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id",
      "access-control-max-age": "600",
    });
  });

  it("preflight on the token, registration and revocation endpoints and discovery", async () => {
    for (const path of ["/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/oauth-authorization-server"]) {
      const res = await at(MCP, path, { method: "OPTIONS", headers: { origin: "https://claude.ai" } });
      expect(res.status).toBe(204);
      expect(Object.fromEntries([...res.headers].filter(([k]) => k.startsWith("access-control-")))).toEqual({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version",
        "access-control-max-age": "600",
      });
    }
  });

  it("cross-origin POST /mcp works and exposes WWW-Authenticate; no Origin means no CORS headers", async () => {
    const client_id = await publicClient();
    const t = await tokensFor(MCP, client_id);
    const ok = await listVideos(MCP, t.access_token, { origin: "https://claude.ai" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const denied = await mcpAt(MCP, toolCall("list_videos"), undefined, { origin: "https://claude.ai" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    expect((await listVideos(MCP, t.access_token)).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("loopback redirect URIs", () => {
  it("ignore the port only", () => {
    expect(redirectMatches("http://127.0.0.1/cb", "http://127.0.0.1:53111/cb")).toBe(true);
    expect(redirectMatches("http://localhost:3000/cb?a=1", "http://localhost:4000/cb?a=1")).toBe(true);
    expect(redirectMatches("http://[::1]/cb", "http://[::1]:8080/cb")).toBe(true);
    expect(redirectMatches("http://127.0.0.1/cb", "http://127.0.0.1:53111/other")).toBe(false);
    expect(redirectMatches("http://127.0.0.1/cb", "http://localhost:53111/cb")).toBe(false);
    expect(redirectMatches("http://127.0.0.1/cb", "https://127.0.0.1:53111/cb")).toBe(false);
    expect(redirectMatches("http://127.0.0.1/cb?a=1", "http://127.0.0.1:1/cb?a=2")).toBe(false);
    expect(redirectMatches("https://app.example/cb", "https://app.example:8443/cb")).toBe(false);
  });

  it("complete a flow on another port, with a warning on the consent page", async () => {
    const client_id = await publicClient(MCP, "http://127.0.0.1/callback");
    const { s } = await authorize(MCP, { client_id, redirect_uri: "http://127.0.0.1:53111/callback" });
    expect(s.p).not.toBe("");
    await openLink(s, (await sendEmail(s, `u${randomId(32)}@example.com`)).path);
    const consent = await at(MCP, `/oauth/authorize/consent?p=${s.p}`, { headers: { cookie: s.cookie } });
    expect(await consent.text()).toContain("runs on your own computer");
    const res = await post(s, "/oauth/authorize/decide", { decision: "allow" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("http://127.0.0.1:53111/callback");
    const t = await token(MCP, { grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: "http://127.0.0.1:53111/callback", code_verifier: s.verifier, client_id });
    expect(t.status).toBe(200);
    expect((await authorize(MCP, { client_id, redirect_uri: "http://127.0.0.1:53111/other" })).res.status).toBe(400);
  });
});
