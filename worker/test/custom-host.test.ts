import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCustomHostCache } from "../src/custom-host";
import type { Env } from "../src/env";
import worker from "../src/index";
import { setPasscode, videoFileUrl } from "../src/share";
import { now, randomId } from "../src/util";
import { homeEnv } from "./home-fixture";
import { freshIp, mcp, ORIGIN, seedAccount, seedReady, videoLinkOf, withEnv } from "./helpers";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const recit = withEnv({ PUBLIC_BASE_URL: "https://example.test" });

/** The Worker's fetch for a full URL (any host). */
async function at(url: string, init: RequestInit = {}, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", freshIp());
  if (!headers.has("user-agent")) headers.set("user-agent", UA);
  const res = await worker.fetch(new Request(url, { ...init, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let hostN = 0;
/** A custom_domains row for a fresh hostname (videos<n>.example.com); returns the hostname. */
async function seedDomain(accountId: string, over: Record<string, unknown> = {}): Promise<string> {
  const hostname = (over.hostname as string) ?? `videos${++hostN}-${randomId(30).toLowerCase()}.example.com`;
  const row = { status: "active", redirect_to: null, redirect_until: null, disabled_at: null, ...over };
  const t = now();
  await env.DB.prepare(
    "INSERT INTO custom_domains (id, account_id, hostname, status, redirect_to, redirect_until, disabled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(), accountId, hostname, row.status, row.redirect_to, row.redirect_until, row.disabled_at, t, t)
    .run();
  return hostname;
}

/** A ready recording of this account; shared = public. Returns its id, slug and the account's username. */
async function video(accountId: string, key: string, shared = true) {
  const id = await seedReady(accountId);
  if (shared) expect((await mcp("share", { recording_id: id }, key)).isError).toBe(false);
  const path = new URL(await videoLinkOf(id)).pathname;
  const [, username, , slug] = path.split("/");
  return { id, slug, username, path };
}

async function setup() {
  const { accountId, key } = await seedAccount();
  const host = await seedDomain(accountId);
  const v = await video(accountId, key);
  return { accountId, key, host, base: `https://${host}`, ...v };
}

beforeEach(() => clearCustomHostCache());

describe("customer host: allow-list only", () => {
  it("every other route is a 404, whatever the method", async () => {
    const { base, id, slug, username } = await setup();
    const file = new URL((await videoFileUrl(env, ORIGIN, id)).url);
    const upload = randomId(128);
    const cases: [string, string, RequestInit?][] = [
      ["POST", "/mcp", { headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }],
      ["GET", "/mcp"],
      ["OPTIONS", "/mcp", { headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } }],
      ["POST", "/mcp/k/ark_x"],
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
      ["GET", "/.well-known/acme-challenge/x"],
      ["GET", "/oauth/authorize?client_id=x"],
      ["POST", "/oauth/token"],
      ["POST", "/oauth/register"],
      ["GET", "/authorize"],
      ["POST", "/token"],
      ["POST", "/register"],
      ["GET", "/signin"],
      ["POST", "/signout"],
      ["GET", "/device/ws", { headers: { upgrade: "websocket" } }],
      ["POST", "/device/enroll", { body: "{}" }],
      ["PUT", `/upload/${upload}/video`, { body: "x" }],
      ["POST", `/upload/${upload}/complete`],
      ["PUT", `/upload/${upload}/keyframes/1`, { body: "x" }],
      ["POST", "/api/stripe/webhook", { body: "{}" }],
      ["GET", "/billing/success"],
      ["GET", "/billing/return"],
      ["GET", "/i/x"],
      ["GET", "/"],
      ["HEAD", "/"],
      ["POST", "/"],
      ["GET", "/install.ps1"],
      ["GET", "/uninstall.ps1"],
      ["GET", "/install.sh"],
      ["GET", "/uninstall.sh"],
      ["GET", "/recorder.zip"],
      ["GET", "/Recitbot-mac-0.6.1.zip"],
      ["GET", "/Recitbot-mac-x.zip"],
      ["GET", "/index.html"],
      ["GET", "/terms/"],
      ["GET", "/privacy/"],
      ["GET", "/eu/"],
      ["GET", "/favicon.ico"],
      ["GET", "/lockup.svg"],
      ["GET", "/fonts/inter400.woff2"],
      ["GET", `/v/${id}`],
      ["POST", `/v/${id}/b`],
      ["GET", `/${username}/v/${slug}`],
      ["POST", `/${username}/v/${slug}`],
      ["GET", `/${username}/v/${slug}/download`],
      ["GET", `/${username}/v/${slug}/comments`],
      ["POST", `/${username}/v/${slug}/comments`],
      ["PATCH", `/${username}/v/${slug}/meta`, { body: "{}" }],
      ["POST", `/${username}/v/${slug}/share`],
      ["GET", `${file.pathname}${file.search}`],
      ["HEAD", `${file.pathname}${file.search}`],
      ["POST", `/m/${slug}`],
      ["PUT", `/${slug}`],
      ["DELETE", `/${slug}`],
      ["POST", `/${slug}`],
      ["GET", `/${slug}/b`],
      ["GET", `/${slug}/`],
      ["GET", `/${slug}/download`],
      ["GET", `/b/${"a".repeat(64)}`],
      ["GET", `/b/${"A".repeat(64)}`],
      ["GET", "/s/no-such-file.js"],
      ["POST", "/s/player.js"],
      // Path tricks
      ["GET", `//${slug}`],
      ["GET", `/s//player.js`],
      ["GET", `/%2e%2e/mcp`],
      ["GET", `/s/%2e%2e/mcp`],
      ["GET", `/s/%2E%2E%2Fmcp`],
      ["GET", `/s/..%2fmcp`],
      ["GET", `/s/..%5cmcp`],
      ["GET", `/m%2f${slug}`],
      ["GET", `/m/${slug}%2ffile`],
      ["GET", `/${slug}%2fb`],
      ["GET", `/s/..\\mcp`],
      ["GET", `/s/../mcp`],
    ];
    for (const [method, path, init] of cases) {
      const res = await at(base + path, { method, ...init });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers.get("set-cookie"), `${method} ${path}`).toBeNull();
      expect(res.headers.get("access-control-allow-origin"), `${method} ${path}`).toBeNull();
      expect(res.headers.get("x-robots-tag"), `${method} ${path}`).toMatch(/noindex/);
      if (method !== "HEAD") expect(await res.text(), `${method} ${path}`).not.toMatch(/jsonrpc|issuer|Recitbot Pro|<video|Write-Host/);
    }
  });

  it("the spec's must-404 set: /, /install.ps1, /recorder.zip, /Recitbot-mac-x.zip", async () => {
    const { base } = await setup();
    for (const p of ["/", "/install.ps1", "/recorder.zip", "/Recitbot-mac-x.zip"]) expect((await at(base + p)).status, p).toBe(404);
  });

  it("an unknown host is a 404 on every path, and a 'failed' row counts as unknown", async () => {
    const { accountId, slug } = await setup();
    for (const p of ["/", `/${slug}`, "/mcp", "/s/player.js", "/robots.txt"]) {
      expect((await at(`https://nobody-${randomId(30).toLowerCase()}.example.com${p}`)).status, p).toBe(404);
    }
    const failed = await seedDomain(accountId, { status: "failed" });
    expect((await at(`https://${failed}/${slug}`)).status).toBe(404);
  });

  it("reserved *.example.test names are a 404 on every path", async () => {
    const { slug, username } = await setup();
    for (const h of ["customers.example.test", "fallback.example.test", "x.example.test"]) {
      for (const p of ["/", "/mcp", `/${slug}`, `/${username}/v/${slug}`, "/s/player.js", "/install.ps1"]) {
        const res = await at(`https://${h}${p}`, p === "/mcp" ? { method: "POST", body: "{}" } : {});
        expect(res.status, h + p).toBe(404);
      }
    }
  });

  it("a disabled host answers 451 on every path, uncached", async () => {
    const { accountId, key } = await seedAccount();
    const host = await seedDomain(accountId, { disabled_at: now() });
    const { slug } = await video(accountId, key);
    for (const [m, p] of [["GET", "/"], ["GET", `/${slug}`], ["GET", `/m/${slug}`], ["POST", "/mcp"], ["GET", "/s/player.js"], ["GET", "/%2e%2e/x"]]) {
      const res = await at(`https://${host}${p}`, { method: m });
      expect(res.status, p).toBe(451);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("This page is unavailable.");
    }
  });

  it("the host is the URL's own: X-Forwarded-Host and friends change nothing", async () => {
    const { base } = await setup();
    const spoof = { "x-forwarded-host": "example.test", forwarded: "host=example.test", "x-original-host": "example.test", "x-host": "example.test" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const mcpInit = (headers: Record<string, string>) => ({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body,
    });
    expect((await at(`${base}/mcp`, mcpInit(spoof))).status).toBe(404);
    expect((await at(`${base}/`, { headers: spoof })).status).toBe(404);
    // Our host with customer-looking headers is unaffected.
    const fake = { "x-forwarded-host": new URL(base).host, forwarded: `host=${new URL(base).host}`, "x-original-host": new URL(base).host, host: new URL(base).host };
    const res = await at("https://example.test/mcp", mcpInit({ ...fake, origin: "https://example.test" }));
    expect(res.status).toBe(200); // MCP's own answer (tools/list), not the gate
    expect(JSON.stringify(await res.json())).toContain("share_recording");
    const meta = await at("https://example.test/.well-known/oauth-authorization-server", { headers: fake });
    expect(((await meta.json()) as { issuer: string }).issuer).toBe("https://example.test");
    expect((await at("https://example.test/x", { headers: fake })).status).toBe(404);
  });
});

describe("customer host: the video page", () => {
  it("a public video of the account renders, with relative media/beacon URLs and no comments, owner controls or download", async () => {
    const { base, slug } = await setup();
    const res = await at(`${base}/${slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<video id="v" src="/m/${slug}"`);
    expect(html).toMatch(/data-vt="[^"]+"/);
    expect(html).toContain(`<link rel="canonical" href="${base}/${slug}">`);
    expect(html).toContain(`<meta property="og:url" content="${base}/${slug}">`);
    expect(html).toContain(`<script src="/s/player.js`);
    expect(html).not.toContain("cm-form");
    expect(html).not.toContain("comments.js");
    expect(html).not.toContain("meta.js");
    expect(html).not.toContain('id="dlb"');
    expect(html).not.toContain("/download");
    expect(html).not.toContain("Owner view");
    expect(html).not.toContain("/v/");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`script-src ${base}/s/`);
    expect(csp).not.toContain("challenges.cloudflare.com");
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(new RegExp(`^mt=[^;]+; Path=/m/${slug}; Max-Age=\\d+; HttpOnly; SameSite=Strict; Secure$`));
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  it("a 'pending' host serves the same allow-list (it can't be reached before its CNAME exists anyway)", async () => {
    const { accountId, key } = await seedAccount();
    const host = await seedDomain(accountId, { status: "pending" });
    const { slug } = await video(accountId, key);
    expect((await at(`https://${host}/${slug}`)).status).toBe(200);
    expect((await at(`https://${host}/mcp`, { method: "POST" })).status).toBe(404);
  });

  it("HEAD renders nothing: no body, no cookie, nothing counted", async () => {
    const { base, slug } = await setup();
    const res = await at(`${base}/${slug}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("a slug of another account is a 404, the same as an unknown slug", async () => {
    const { base } = await setup();
    const other = await seedAccount();
    const { slug: foreign } = await video(other.accountId, other.key);
    const a = await at(`${base}/${foreign}`);
    const b = await at(`${base}/${"Z".repeat(14)}`);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
    expect([...a.headers.keys()].sort()).toEqual([...b.headers.keys()].sort());
    // Its media and beacon too.
    expect((await at(`${base}/m/${foreign}`)).status).toBe(404);
    expect((await at(`${base}/${foreign}/b`, { method: "POST", body: "t=x&p=0" })).status).toBe(404);
  });

  it("private, passcode, expired and not-ready videos 302 to their example.test URL", async () => {
    const { accountId, key } = await seedAccount();
    const host = await seedDomain(accountId);
    const priv = await video(accountId, key, false);
    const pass = await video(accountId, key);
    await setPasscode(env, pass.id, "hunter22");
    const old = await video(accountId, key);
    await env.DB.prepare("UPDATE recordings SET expires_at = ? WHERE id = ?").bind(now() - 10, old.id).run();
    const pend = await video(accountId, key);
    await env.DB.prepare("UPDATE recordings SET status = 'uploading' WHERE id = ?").bind(pend.id).run();
    for (const v of [priv, pass, old, pend]) {
      for (const e of [env, recit]) {
        const res = await at(`https://${host}/${v.slug}?x=1`, {}, e);
        expect(res.status, v.slug).toBe(302);
        expect(res.headers.get("location")).toBe(`https://example.test/${v.username}/v/${v.slug}`);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    }
    // PUBLIC_BASE_URL decides where "example.test" is.
    const res = await at(`https://${host}/${priv.slug}`, {}, withEnv({ PUBLIC_BASE_URL: "https://staging.example.net" }));
    expect(res.headers.get("location")).toBe(`https://staging.example.net/${priv.username}/v/${priv.slug}`);
  });

  it("an owner link (?ot=) does nothing on a custom host: no owner cookie, no owner view", async () => {
    const { accountId, key } = await seedAccount();
    const host = await seedDomain(accountId);
    const id = await seedReady(accountId);
    const r = await mcp("share", { recording_id: id }, key);
    const ot = new URL(r.data.owner_url).search;
    const slug = new URL(r.data.owner_url).pathname.split("/")[3];
    const res = await at(`https://${host}/${slug}${ot}`);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().every((c) => c.startsWith("mt="))).toBe(true);
    const html = await res.text();
    expect(html).not.toContain("meta.js");
    expect(html).not.toContain("Owner view");
  });

  it("/m/<slug> streams with the page's cookie on the custom host, and only with it", async () => {
    const { base, slug } = await setup();
    const page = await at(`${base}/${slug}`);
    const mt = /mt=[^;]+/.exec(page.headers.get("set-cookie")!)![0];
    const ok = await at(`${base}/m/${slug}`, { headers: { cookie: mt, range: "bytes=0-99", "sec-fetch-site": "same-origin" } });
    expect(ok.status).toBe(206);
    expect(ok.headers.get("content-type")).toBe("video/mp4");
    expect((await ok.arrayBuffer()).byteLength).toBe(100);
    const head = await at(`${base}/m/${slug}`, { method: "HEAD", headers: { cookie: mt } });
    expect(head.status).toBe(200);
    expect((await at(`${base}/m/${slug}`)).status).toBe(403);
    expect((await at(`${base}/m/${slug}`, { headers: { cookie: mt, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("the view beacon on /<slug>/b counts the view", async () => {
    const { base, slug, key, id } = await setup();
    const html = await (await at(`${base}/${slug}`, { headers: { "cf-connecting-ip": "10.9.9.9" } })).text();
    const vt = /data-vt="([^"]+)"/.exec(html)![1];
    const res = await at(`${base}/${slug}/b`, {
      method: "POST",
      body: new URLSearchParams({ t: vt, p: "0" }),
      headers: { "sec-fetch-site": "same-origin", origin: base, "cf-connecting-ip": "10.9.9.9" },
    });
    expect(res.status).toBe(204);
    const stats = (await mcp("get_video_stats", { recording_id: id }, key)).data;
    expect(stats.views).toBe(1);
  });

  it("static player assets, robots.txt; unknown brand assets and an unset favicon are 404s", async () => {
    const { base } = await setup();
    const js = await at(`${base}/s/player.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(js.headers.get("set-cookie")).toBeNull();
    expect((await at(`${base}/s/recitbot.css`, { method: "HEAD" })).status).toBe(200);
    expect((await at(`${base}/s/player.js`, { headers: { cookie: "mt=x" } })).headers.get("set-cookie")).toBeNull();
    const robots = await at(`${base}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /m/\n");
    expect(robots.headers.get("x-robots-tag")).toBe("noindex");
    expect((await at(`${base}/b/${"0f".repeat(32)}`)).status).toBe(404);
    expect((await at(`${base}/favicon.ico`)).status).toBe(404);
  });

  it("the host is matched case-insensitively and with a trailing dot", async () => {
    const { host, slug } = await setup();
    expect((await at(`https://${host.toUpperCase()}./${slug}`)).status).toBe(200);
  });
});

describe("customer host: redirecting", () => {
  it("to another (live) hostname: 301 to the same path there, no query, GET/HEAD only", async () => {
    const { accountId, slug, host } = await setup();
    const old = await seedDomain(accountId, { status: "redirecting", redirect_to: host, redirect_until: now() + 86400 });
    for (const m of ["GET", "HEAD"]) {
      const res = await at(`https://${old}/${slug}?ot=abc&x=1`, { method: m });
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`https://${host}/${slug}`);
    }
    expect((await at(`https://${old}/s/player.js`)).headers.get("location")).toBe(`https://${host}/s/player.js`);
    expect((await at(`https://${old}/${slug}`, { method: "POST" })).status).toBe(404);
    expect((await at(`https://${old}/s%2f..%2fmcp`)).status).toBe(404);
  });

  it("never to one of our hosts or a reserved name", async () => {
    const { accountId, slug } = await setup();
    for (const to of ["mcp.example.test", "customers.example.test", "x.workers.dev", "evil.example/x", "a b.example.org"]) {
      const old = await seedDomain(accountId, { status: "redirecting", redirect_to: to, redirect_until: now() + 86400 });
      expect((await at(`https://${old}/${slug}`)).status, to).toBe(404);
    }
  });

  it("to example.test: /<slug> of the account 301s to its example.test URL; anything else 404s", async () => {
    const { accountId, slug, username } = await setup();
    const other = await seedAccount();
    const { slug: foreign } = await video(other.accountId, other.key);
    const old = await seedDomain(accountId, { status: "redirecting", redirect_to: "example.test", redirect_until: now() + 86400 });
    const res = await at(`https://${old}/${slug}?x=1`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://example.test/${username}/v/${slug}`);
    expect((await at(`https://${old}/${foreign}`)).status).toBe(404);
    expect((await at(`https://${old}/`)).status).toBe(404);
    expect((await at(`https://${old}/m/${slug}`)).status).toBe(404);
    expect((await at(`https://${old}/mcp`, { method: "POST" })).status).toBe(404);
  });

  it("past redirect_until: 404", async () => {
    const { accountId, slug } = await setup();
    for (const to of ["example.test", "watch.example.org"]) {
      const old = await seedDomain(accountId, { status: "redirecting", redirect_to: to, redirect_until: now() - 1 });
      expect((await at(`https://${old}/${slug}`)).status, to).toBe(404);
    }
  });
});

describe("our hosts are unchanged", () => {
  const tools = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  it("example.test, mcp.example.test and workers.dev still answer /mcp, / and the viewer page", async () => {
    const { key, path } = await setup();
    for (const h of ["https://example.test", "https://mcp.example.test", "https://my-recorder.example.workers.dev"]) {
      const res = await at(`${h}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}`, origin: h },
        body: tools,
      });
      expect(res.status, h).toBe(200);
      const page = await at(`${h}${path}`);
      expect(page.status, h).toBe(200);
      expect(await page.text()).not.toContain('rel="canonical"');
    }
    expect((await at("https://example.test/", {}, homeEnv())).status).toBe(200);
    expect((await at("https://example.test/.well-known/oauth-authorization-server")).status).toBe(200);
    expect((await at("https://example.test/install.ps1", { headers: { "cf-ipcountry": "US" } })).status).toBe(200);
  });

  it("the comments section is still on the example.test page", async () => {
    const { path } = await setup();
    const html = await (await at(`https://example.test${path}`, {}, recit)).text();
    expect(html).toContain("comments.js");
  });
});
