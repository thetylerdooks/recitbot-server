// Renders everything a deployment shows to viewers, users and bots, with one config: golden.test.ts compares it with the
// recorded baseline (hosted-shaped config), brand-unset.test.ts checks the self-host defaults.
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { issueApiKey } from "../src/auth";
import { getConfig } from "../src/config";
import { clearCustomHostCache } from "../src/custom-host";
import type { Env } from "../src/env";
import { emailSite, renderEmailChangeCode, renderEmailChangedNotice, renderEmailChangeOldCode, renderSigninEmail } from "../src/oauth/email-template";
import { setPasscode } from "../src/share";
import { stripeDeps } from "../src/stripe";
import { callUrl, fakeSiteverify, mailbox, suspendAccount, TURNSTILE_TOKEN, withEnv } from "./helpers";

const ROOT = "https://example.test";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const BOT_UA = "Slackbot-LinkExpanding 1.0";
const OWNER = "GoldenOwner00000000001";
const FREE = "GoldenFree000000000001";
const FULL = "GoldenFull000000000001";
const PRO = "GoldenPro0000000000001";
const YEARLY = "GoldenYear000000000001";
const CANCELED = "GoldenGone000000000001";
const FAR = 4_000_000_000;
const T0 = 1_760_000_000;
const box = mailbox();
fakeSiteverify();

let G: Env;

const out: Record<string, string> = {};
const jar = new Map<string, string>();
let ip = 1;

/** Per-run values only. */
const norm = (s: string): string =>
  s
    .replace(/\?v=[0-9a-f]{10}/g, "?v=V")
    .replace(/(name="(?:p|csrf|f)" value=")[^"]+/g, "$1X")
    .replace(/(data-(?:vt|key|k|ck)=")[^"]+/g, "$1X")
    .replace(/(\?p=)[A-Za-z0-9]+/g, "$1X")
    .replace(/(\?ot=)[A-Za-z0-9_.-]+/g, "$1X")
    .replace(/\b\d{10}\.[A-Za-z0-9_-]{43}/g, "TOKEN")
    .replace(/\b((?:mt|rb_session|__Host-rb_session|rbc_[a-z]+)=)[^;]*/g, "$1X")
    .replace(/\brbo_[A-Za-z0-9]{20,}=[^;]*/g, "rbo_ID=X")
    .replace(/(oauth\/magic\?t=)[A-Za-z0-9]+/g, "$1X");

async function record(name: string, res: Response): Promise<string> {
  const body = res.status === 204 || res.status === 304 ? "" : await res.text();
  const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).sort();
  expect(out[name], name).toBeUndefined();
  out[name] = norm(`${res.status}\n${headers.join("\n")}\n\n${body}`);
  return body;
}

async function send(url: string, init: RequestInit = {}, e: Env = G): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", UA);
  headers.set("cf-connecting-ip", `198.51.100.${ip++ & 255}`);
  if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await callUrl(url.startsWith("https:") ? url : ROOT + url, { redirect: "manual", ...init, headers }, e);
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    jar.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
  }
  return res;
}
const page = async (name: string, url: string, init: RequestInit = {}) => record(name, await send(url, init));
const post = (url: string, fields: Record<string, string>, e: Env = G) =>
  send(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ROOT }, body: new URLSearchParams(fields).toString() }, e);
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1];

async function rpc(method: string, params: unknown, key?: string): Promise<any> {
  const res = await callUrl(
    `${ROOT}/mcp`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${ip++ & 255}`, ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    G,
  );
  return (await res.json()) as any;
}
async function tool(name: string, t: string, args: Record<string, unknown>, key: string): Promise<void> {
  const r = await rpc("tools/call", { name: t, arguments: args }, key);
  out[name] = norm(JSON.stringify(r.result ?? r.error ?? r));
}

const insert = (table: string, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  return env.DB.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .bind(...Object.values(cols))
    .run();
};
async function account(id: string, username: string, plan: string, over: Record<string, unknown> = {}): Promise<string> {
  await insert("accounts", { id, username, plan, email: `${username}@example.test`, created_at: T0, ...over });
  return issueApiKey(G, id);
}
const video = (id: string, slug: string, accountId: string, over: Record<string, unknown> = {}) =>
  insert("recordings", {
    id,
    slug,
    account_id: accountId,
    device_id: "dev",
    status: "ready",
    max_seconds: 60,
    created_at: T0,
    expires_at: FAR,
    transcript: JSON.stringify({ segments: [{ start: 0, end: 2, text: "Hello there." }] }),
    transcript_status: "ready",
    shared_at: T0 + 100,
    ...over,
  });

/** Name -> output. `over` = the config under test, on top of the test deployment's. One call per test file (fixed ids). */
export async function collect(over: Partial<Env>): Promise<Record<string, string>> {
  G = withEnv({ PUBLIC_BASE_URL: ROOT, OWNER_ACCOUNT_IDS: OWNER, EMAIL: box.binding, OAUTH_DEV_LOG_LINKS: undefined, ...over });
  stripeDeps.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if ((init?.method ?? "GET") === "GET" && path.includes("/customers/")) {
      return Response.json({ id: "cus_x", metadata: { app: "recitbot", account_id: path.endsWith("cus_year") ? YEARLY : PRO } });
    }
    return Response.json({ id: "obj_x", url: "https://stripe.example.test/page", expires_at: FAR });
  };
  const owner = await account(OWNER, "golden-owner", "free");
  const free = await account(FREE, "golden-free", "free");
  const full = await account(FULL, "golden-full", "free", { free_recordings_used: 25 });
  const paid = { plan_status: "active", current_period_end: 1_800_000_000, stripe_customer_id: "cus_x", stripe_subscription_id: "sub_x" };
  const pro = await account(PRO, "golden-pro", "pro", paid);
  const yearly = await account(YEARLY, "golden-year", "pro", { ...paid, stripe_customer_id: "cus_year", billing_interval: "yearly" });
  const gone = await account(CANCELED, "golden-gone", "free", { plan_status: "canceled" });

  // ---------- watch pages ----------
  await video("GoldenRec0000000000001", "GoldenSlug0001", FREE, { title: "Q3 walkthrough", description: "A short\ndescription" });
  await video("GoldenRec0000000000002", "GoldenSlug0002", FREE, { transcript: null, transcript_status: "none" });
  await video("GoldenRec0000000000003", "GoldenSlug0003", FREE, { shared_at: null });
  await video("GoldenRec0000000000004", "GoldenSlug0004", FREE, { title: "Locked" });
  await video("GoldenRec0000000000005", "GoldenSlug0005", PRO, { title: "Paid" });
  await env.DB.prepare("INSERT INTO shares (recording_id) VALUES ('GoldenRec0000000000004')").run();
  await setPasscode(G, "GoldenRec0000000000004", "1234");
  await page("watch: public", "/golden-free/v/GoldenSlug0001");
  await page("watch: public, untitled, no transcript", "/golden-free/v/GoldenSlug0002");
  await page("watch: private to a stranger", "/golden-free/v/GoldenSlug0003");
  await page("watch: not found", "/golden-free/v/GoldenSlug9999");
  await page("watch: legacy not found", "/v/GoldenRec0000000000003");
  await page("watch: passcode", "/golden-free/v/GoldenSlug0004");
  await record("watch: wrong passcode", await post("/golden-free/v/GoldenSlug0004", { passcode: "0000" }));
  await page("watch: paid, no watermark", "/golden-pro/v/GoldenSlug0005");
  await page("watch: link preview", "/golden-free/v/GoldenSlug0001", { headers: { "user-agent": BOT_UA } });
  await page("watch: link preview, untitled", "/golden-free/v/GoldenSlug0002", { headers: { "user-agent": BOT_UA } });
  const owned = [
    ["private", free, "GoldenRec0000000000003"],
    ["public", free, "GoldenRec0000000000001"],
    ["untitled", free, "GoldenRec0000000000002"],
    ["paid", pro, "GoldenRec0000000000005"],
  ];
  for (const [who, key, rec] of owned) {
    jar.clear();
    const r = await rpc("tools/call", { name: "get_video", arguments: { recording_id: rec } }, key);
    const open = await send(r.result.structuredContent.owner_url);
    expect(open.status).toBe(303);
    await page(`watch: owner, ${who}`, open.headers.get("location")!);
  }
  await env.MEDIA.put("v/GoldenRec0000000000005.mp4", new Uint8Array([1, 2, 3]));
  await page("download: titled", "/golden-pro/v/GoldenSlug0005/download", { method: "HEAD" });
  await env.DB.prepare("UPDATE recordings SET title = NULL WHERE id = 'GoldenRec0000000000005'").run();
  await page("download: untitled", "/golden-pro/v/GoldenSlug0005/download", { method: "HEAD" });
  jar.clear();
  await video("GoldenRec0000000000006", "GoldenSlug0006", CANCELED);
  await suspendAccount(CANCELED);
  await page("watch: removed", "/golden-gone/v/GoldenSlug0006");

  // ---------- customer hosts ----------
  for (const [hostname, account_id] of [["golden.example.com", PRO], ["plain.example.com", YEARLY]]) {
    await insert("custom_domains", { id: `dom-${hostname}`, account_id, hostname, status: "active", created_at: T0, updated_at: T0 });
  }
  clearCustomHostCache();
  await video("GoldenRec0000000000007", "GoldenSlug0007", YEARLY, { title: "Plain" });
  await insert("branding", { account_id: PRO, brand_name: "Acme", accent: "#ff8800", background: "#101010", updated_at: T0 });
  await page("custom host: branded", "https://golden.example.com/GoldenSlug0005");
  await page("custom host: unbranded", "https://plain.example.com/GoldenSlug0007");
  await page("custom host: link preview", "https://golden.example.com/GoldenSlug0005", { headers: { "user-agent": BOT_UA } });
  await page("custom host: robots", "https://golden.example.com/robots.txt");

  // ---------- sign-in ----------
  jar.clear();
  await page("sign-in: web", "/signin?next=/");
  await page("sign-in: bad authorize", "/oauth/authorize?client_id=x");
  await page("sign-in: expired link", `/oauth/magic?t=${"A".repeat(43)}`);
  await page("sign-out: page", "/signout?next=/");
  await record("sign-out: cross-site", await send("/signout", { method: "POST", headers: { origin: "https://other.example.com" } }));
  const reg = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Golden App", redirect_uris: ["http://127.0.0.1/cb"], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://127.0.0.1/cb", state: "golden", code_challenge: "A".repeat(43), code_challenge_method: "S256" });
  const first = await page("sign-in: app connecting", `/oauth/authorize?${q}`);
  const f = { p: field(first, "p"), csrf: field(first, "csrf") };
  await record("sign-in: bad email", await post("/oauth/authorize/email", { ...f, email: "nope" }));
  await record("sign-in: code page", await post("/oauth/authorize/email", { ...f, email: "golden-new@example.com", "cf-turnstile-response": TURNSTILE_TOKEN }));
  const code = /\b(\d{6})\b/.exec(box.sent[0].subject)![1];
  out["email: as sent"] = norm(JSON.stringify(box.sent[0]).replaceAll(code, "CODE"));
  await record("sign-in: wrong code", await post("/oauth/authorize/code", { ...f, code: code === "000000" ? "000001" : "000000" }));
  const done = await post("/oauth/authorize/code", { ...f, code });
  expect(done.status).toBe(303);
  await page("sign-in: consent", done.headers.get("location")!);
  expect((await post("/oauth/authorize/decide", { ...f, decision: "allow" })).status).toBe(303);
  await page("sign-in: consent with a web session", `/oauth/authorize?${q}`);
  jar.clear();
  await record("claim: GET", await send("/oauth/authorize/claim"));
  await record("claim: POST", await post("/oauth/authorize/claim", { p: "A".repeat(22), csrf: "x", secret: "x" }));
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) await page(`discovery: ${p}`, p);

  // ---------- emails ----------
  const site = emailSite(getConfig(G));
  const LINK = `https://example.test/oauth/magic?t=${"A".repeat(43)}`;
  out["email: sign-in"] = JSON.stringify(renderSigninEmail({ code: "482915", link: LINK, email: "alex@example.com" }, site));
  out["email: sign-in, code only"] = JSON.stringify(renderSigninEmail({ code: "482915", email: "alex@example.com" }, site));
  out["email: change code"] = JSON.stringify(renderEmailChangeCode({ code: "482915", email: "new@example.com" }, site));
  out["email: change approval"] = JSON.stringify(renderEmailChangeOldCode({ code: "482915", newEmail: "new@example.com" }, site));
  out["email: changed notice"] = JSON.stringify(renderEmailChangedNotice({ oldEmail: "old@example.com", newEmail: "new@example.com" }, site));

  // ---------- report, geo, billing pages, static brand files ----------
  await page("report: plain", "/report");
  await page("report: host and video", "/report?host=golden.example.com&v=GoldenSlug0005");
  await page("report: video", "/report?v=GoldenSlug0005");
  await page("report: POST", "/report", { method: "POST" });
  const eu = { "cf-ipcountry": "DE" };
  await page("geo: html", "/oauth/authorize", { headers: { ...eu, accept: "text/html" } });
  await page("geo: text", "/install.ps1", { headers: eu });
  await page("geo: mcp", "/mcp", { method: "POST", headers: eu });
  for (const p of ["success", "cancel", "return", "storage"]) await page(`billing page: ${p}`, `/billing/${p}`);
  await record("config error", await send("/", {}, { ...G, SHARE_HMAC_KEY: "" } as Env));
  await page("not found", "/nothing-here");
  // Status and type only: the files themselves are in worker/web.
  for (const p of ["/favicon.ico", "/apple-touch-icon.png", "/s/favicon.svg", "/s/icon.svg", "/s/og-card.png", "/s/recitbot-lockup.svg", "/s/recitbot.css", "/s/meta.js"]) {
    const res = await send(p, { method: "HEAD" });
    out[`asset: ${p}`] = `${res.status} ${res.headers.get("content-type")}`;
  }

  // ---------- model-facing ----------
  out["mcp: initialize"] = JSON.stringify((await rpc("initialize", {})).result);
  out["mcp: tools/list"] = JSON.stringify((await rpc("tools/list", {}, free)).result);
  out["mcp: tools/list, anonymous"] = JSON.stringify((await rpc("tools/list", {})).result);
  out["mcp: tools/list, owner"] = JSON.stringify((await rpc("tools/list", {}, owner)).result);
  out["mcp: playbook"] = JSON.stringify((await rpc("tools/call", { name: "get_latest", arguments: {} }, free)).result.structuredContent.playbook);
  for (const [who, key] of [["free", free], ["pro", pro], ["yearly", yearly], ["canceled", gone], ["owner", owner]]) {
    for (const t of ["get_plan", "upgrade", "add_storage", "billing", "cancel_subscription", "account_info", "get_branding"]) {
      await tool(`tool: ${t}, ${who}`, t, {}, key);
    }
  }
  await tool("tool: start_recording, free limit", "start_recording", {}, full);
  await tool("tool: start_recording, too long", "start_recording", { max_seconds: 900 }, free);
  await tool("tool: set_branding, free", "set_branding", { brand_name: "Acme" }, free);
  await tool("tool: set_custom_domain, free", "set_custom_domain", { hostname: "videos.example.com" }, free);
  await tool("tool: skill video, free", "get_recording_for_skill", { recording_id: "GoldenRec0000000000001", include_video: true }, free);
  await env.DB.prepare("UPDATE recordings SET bytes = ? WHERE id = 'GoldenRec0000000000005'").bind(95e9).run();
  await tool("tool: account_info, storage warning", "account_info", {}, pro);
  await env.DB.prepare("UPDATE recordings SET bytes = ? WHERE id = 'GoldenRec0000000000005'").bind(100e9).run();
  await tool("tool: start_recording, storage limit", "start_recording", {}, pro);
  for (const i of [0, 1]) {
    await insert("devices", { id: `golden-dev-${i}`, account_id: FREE, token_hash: "x", name: "PC", platform: "windows", created_at: T0 });
  }
  const inst = (await rpc("tools/call", { name: "get_installer", arguments: { platform: "windows" } }, free)).result.structuredContent;
  out["tool: get_installer, device limit"] = inst.device_limit;
  const enroll = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: inst.pairing_code }) };
  await page("enroll: device limit", "/device/enroll", enroll);

  // ---------- signups closed, retention hold ----------
  jar.clear();
  const closed = { ...G, SIGNUPS_DISABLED: "true" } as Env;
  const start = async () => {
    const html = await (await send(`/oauth/authorize?${q}`)).text();
    return { p: field(html, "p"), csrf: field(html, "csrf") };
  };
  const late = { ...(await start()), email: "golden-late@example.com", "cf-turnstile-response": TURNSTILE_TOKEN };
  await record("sign-in: signups closed, email step", await post("/oauth/authorize/email", late, closed));
  expect((await post("/oauth/authorize/email", late)).status).toBe(200);
  const lateCode = /\b(\d{6})\b/.exec(box.sent.at(-1)!.subject)![1];
  await record("sign-in: signups closed, code step", await post("/oauth/authorize/code", { p: late.p, csrf: late.csrf, code: lateCode }, closed));
  await tool("tool: admin_retention_hold, on", "admin_retention_hold", { account_id: FREE, hold: true }, owner);
  await tool("tool: admin_retention_hold, again", "admin_retention_hold", { account_id: FREE, hold: true }, owner);
  await tool("tool: get_video, held", "get_video", { recording_id: "GoldenRec0000000000001" }, free);
  await tool("tool: admin_retention_hold, off", "admin_retention_hold", { account_id: FREE, hold: false }, owner);
  await tool("tool: admin_retention_hold, not an owner", "admin_retention_hold", { account_id: FREE, hold: true }, free);
  return out;
}
