import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { brandCss, reportUrl } from "../src/brand-page";
import { clearCustomHostCache } from "../src/custom-host";
import type { Env } from "../src/env";
import worker from "../src/index";
import { setPasscode } from "../src/share";
import { now, randomId } from "../src/util";
import { connectDevice, freshIp, mcp, ORIGIN, seedAccount, seedReady, suspendAccount, videoLinkOf } from "./helpers";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";

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

async function account(plan: "free" | "pro" | "teams" = "pro") {
  const a = await seedAccount();
  if (plan !== "free") await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, a.accountId).run();
  return a;
}

/** A custom_domains row for a fresh hostname; returns the hostname. */
async function seedDomain(accountId: string, over: Record<string, unknown> = {}): Promise<string> {
  const hostname = (over.hostname as string) ?? `brand-${randomId(30).toLowerCase()}.example.com`;
  const row = { status: "active", redirect_to: null, redirect_until: null, disabled_at: null, ...over };
  const t = now();
  await env.DB.prepare(
    "INSERT INTO custom_domains (id, account_id, hostname, status, redirect_to, redirect_until, disabled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(), accountId, hostname, row.status, row.redirect_to, row.redirect_until, row.disabled_at, t, t)
    .run();
  return hostname;
}

/** A ready recording of this account; shared = public. */
async function video(accountId: string, key: string, shared = true) {
  const id = await seedReady(accountId);
  if (shared) expect((await mcp("share", { recording_id: id }, key)).isError).toBe(false);
  const path = new URL(await videoLinkOf(id)).pathname;
  const [, username, , slug] = path.split("/");
  return { id, slug, username, path };
}

const hash = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A brand image row + R2 object for the account; returns its hash. */
async function seedAsset(accountId: string, kind: "logo" | "favicon" | "og", width: number, height: number): Promise<string> {
  const h = hash();
  const key = `brand/${accountId}/${h}.png`;
  await env.MEDIA.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare(
    "INSERT INTO brand_assets (account_id, hash, kind, r2_key, content_type, bytes, width, height, created_at) VALUES (?, ?, ?, ?, 'image/png', 7, ?, ?, ?)",
  )
    .bind(accountId, h, kind, key, width, height, now())
    .run();
  return h;
}

/** Writes a branding row as given: no checks, so tests can store what set_branding would refuse. */
async function seedBranding(
  accountId: string,
  b: { brand_name?: string | null; accent?: string | null; background?: string | null; logo?: string | null; favicon?: string | null; og?: string | null },
) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO branding (account_id, brand_name, accent, background, logo_hash, favicon_hash, og_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(accountId, b.brand_name ?? null, b.accent ?? null, b.background ?? null, b.logo ?? null, b.favicon ?? null, b.og ?? null, now())
    .run();
}

async function fullyBranded() {
  const a = await account();
  const host = await seedDomain(a.accountId);
  const v = await video(a.accountId, a.key);
  const logo = await seedAsset(a.accountId, "logo", 400, 100);
  const favicon = await seedAsset(a.accountId, "favicon", 32, 32);
  const og = await seedAsset(a.accountId, "og", 1200, 630);
  await seedBranding(a.accountId, { brand_name: "Acme Studio", accent: "#0b6e64", background: "#ffffff", logo, favicon, og });
  return { ...a, ...v, host, base: `https://${host}`, logo, favicon, og };
}

const styleOf = (html: string) => /<style>([^<]*)<\/style>/.exec(html)?.[1] ?? null;
const sha256b64 = async (s: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))));
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]);

beforeEach(() => clearCustomHostCache());

describe("branded page on a customer host", () => {
  it("renders the brand: title, og tags, logo, favicon, colours; nothing of Recitbot's but the footer", async () => {
    const b = await fullyBranded();
    const res = await at(`${b.base}/${b.slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Demo · Acme Studio</title>");
    expect(html).toContain('<meta property="og:site_name" content="Acme Studio">');
    expect(html).toContain('<meta property="og:title" content="Demo">');
    expect(html).toContain(`<meta property="og:image" content="${b.base}/b/${b.og}">`);
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<link rel="canonical" href="${b.base}/${b.slug}">`);
    expect(html).toContain(`<meta property="og:url" content="${b.base}/${b.slug}">`);
    expect(html).toContain(`<img src="/b/${b.logo}" alt="Acme Studio" width="400" height="100">`);
    expect(html).toContain('<span class="bn">Acme Studio</span>');
    expect(html).toContain(`<link rel="icon" href="/b/${b.favicon}" type="image/png">`);
    expect(html).toContain('<meta name="theme-color" content="#ffffff">');
    // No Recitbot header, logo, icons, card image or watermark; no comments, download, owner controls or forms.
    for (const s of ["recitbot-lockup.svg", 'alt="Recitbot"', "og-card.png", "/s/favicon", "apple-touch-icon", "icon.svg", 'class="wm"', "comments.js", "meta.js", "/download", "Recorded with Recitbot", "<form", "<textarea", "/v/"]) {
      expect(html, s).not.toContain(s);
    }
    expect(html).not.toMatch(/<input(?![^>]*type="range")/);
    // The only links are the footer's.
    expect(anchors(html)).toEqual(["https://example.test", `https://example.test/report?host=${b.host}&amp;v=${b.slug}`]);
    expect(html).toContain('<footer class="pwr"><a href="https://example.test" rel="noopener">Powered by Recitbot</a>');
    const acme = await (await at(`${b.base}/${b.slug}`, {}, { ...env, BRAND_NAME: "Acme & Co" })).text();
    expect(acme).toContain('<footer class="pwr"><a href="https://example.test" rel="noopener">Powered by Acme &amp; Co</a>');
    // og:image is the brand's image on this host: never a video frame, media or signed URL.
    const og = /og:image" content="([^"]+)"/.exec(html)![1];
    expect(og).not.toMatch(/\/m\/|[?&](e|s)=/);
  });

  it("colours reach the page only as validated hex in a hashed inline <style>", async () => {
    const b = await fullyBranded();
    const res = await at(`${b.base}/${b.slug}`);
    const html = await res.text();
    const css = styleOf(html)!;
    expect(css).toContain("--ink:#ffffff");
    expect(css).toContain("--paper:#111111");
    expect(css).toContain("--red:#0b6e64");
    expect(css).toMatch(/^[a-z0-9#:;{}.()\s,-]+$/i);
    for (const c of css.match(/#[0-9a-z]+/gi)!) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(res.headers.get("content-security-policy")).toContain(`style-src ${b.base}/s/ 'sha256-${await sha256b64(css)}'`);
    // The footer's colours are fixed in the stylesheet, not variables the brand style sets.
    expect(css).not.toContain("pwr");
    const sheet = await (await at(`${b.base}/s/recitbot.css`)).text();
    expect(sheet).toMatch(/\.pwr\{[^}]*background:#111318!important;color:#f5f3ee!important/);
  });

  it("CSP: the viewer's plus form-action/base-uri/frame-ancestors 'none', img-src 'self', no third-party origins", async () => {
    const b = await fullyBranded();
    const csp = (await at(`${b.base}/${b.slug}`)).headers.get("content-security-policy")!;
    for (const d of ["default-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'", "img-src 'self'", "media-src 'self'", "connect-src 'self'", `script-src ${b.base}/s/`]) {
      expect(csp, d).toContain(d);
    }
    for (const origin of csp.match(/https?:\/\/[^\s;/]+/g)!) expect(origin).toBe(b.base);
    expect(csp).not.toContain("challenges.cloudflare.com");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("escapes a malicious title, description and brand name", async () => {
    const a = await account();
    const host = await seedDomain(a.accountId);
    const v = await video(a.accountId, a.key);
    await env.DB.prepare("UPDATE recordings SET title = ?, description = ? WHERE id = ?")
      .bind(`"><img src=x onerror=alert(1)>`, `</title><script>alert(2)</script>`, v.id)
      .run();
    await seedBranding(a.accountId, { brand_name: `<script>alert(3)</script>"&'` });
    for (const ua of [UA, "Slackbot-LinkExpanding 1.0"]) {
      const html = await (await at(`https://${host}/${v.slug}`, { headers: { "user-agent": ua } })).text();
      expect(html).not.toMatch(/<script>alert|<img src=x|<\/title><script/);
      expect(html).toContain("<title>&quot;&gt;&lt;img src=x onerror=alert(1)&gt; · &lt;script&gt;alert(3)&lt;/script&gt;&quot;&amp;&#39;</title>");
      expect(html).toContain('<meta property="og:site_name" content="&lt;script&gt;alert(3)&lt;/script&gt;&quot;&amp;&#39;">');
      expect(html).toContain('content="&lt;/title&gt;&lt;script&gt;alert(2)&lt;/script&gt;"');
    }
  });

  it("stored colours that aren't plain hex (or fail contrast) never reach the CSS", async () => {
    const a = await account();
    const host = await seedDomain(a.accountId);
    const v = await video(a.accountId, a.key);
    for (const [accent, background] of [
      ["red;}body{display:none", "url(javascript:alert(1))"],
      ["#12345g", "#ffffff;}x{"],
      ["expression(alert(1))", null],
    ]) {
      await seedBranding(a.accountId, { brand_name: "Acme", accent, background });
      const res = await at(`https://${host}/${v.slug}`);
      const html = await res.text();
      expect(styleOf(html), String(accent)).toBeNull();
      expect(html).not.toMatch(/javascript:|expression\(|display:none/);
      expect(res.headers.get("content-security-policy")).not.toContain("sha256-");
    }
    // A low-contrast accent is dropped; the readable background stays.
    expect(brandCss("#fefefe", "#ffffff")).toBe(brandCss(null, "#ffffff"));
    expect(brandCss("#1fa89a", null)).toBe(":root{--red:#1fa89a;--teal:#1fa89a}.player{--ink:#111318;--paper:#f5f3ee;--muted:#a3a8b3;--line:#262a33;--panel:#1a1d24}main a{color:#1fa89a}");
    expect(brandCss("#1FA", "#FFF")).toContain("--ink:#ffffff");
    expect(brandCss(null, "#777777")).toBeNull(); // neither dark nor white text reaches 4.5:1
    expect(brandCss(null, null)).toBeNull();
  });

  it("empty branding: hostname as the site name, no og:image, no header, footer and Report link still there", async () => {
    const a = await account();
    const host = await seedDomain(a.accountId);
    const v = await video(a.accountId, a.key);
    const html = await (await at(`https://${host}/${v.slug}`)).text();
    expect(html).toContain(`<title>Demo · ${host}</title>`);
    expect(html).toContain(`<meta property="og:site_name" content="${host}">`);
    expect(html).not.toContain("og:image");
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain("<header");
    expect(html).not.toContain("<style>");
    expect(html).not.toContain('rel="icon"');
    expect(html).not.toContain("Recitbot recording");
    expect(anchors(html)).toEqual(["https://example.test", `https://example.test/report?host=${host}&amp;v=${v.slug}`]);
    expect(reportUrl(env, "a.example.com", "abc")).toBe("https://example.test/report?host=a.example.com&v=abc");
    expect(reportUrl(env, "a&b", "x y")).toBe("https://example.test/report?host=a%26b&v=x%20y");
  });

  it("a plan without branding (Free) shows none of it, and never the Free watermark on the custom host", async () => {
    for (const plan of ["free"] as const) {
      const a = await account(plan);
      const host = await seedDomain(a.accountId);
      const v = await video(a.accountId, a.key);
      const fav = await seedAsset(a.accountId, "favicon", 32, 32);
      await seedBranding(a.accountId, { brand_name: "Acme", accent: "#1fa89a", favicon: fav });
      const html = await (await at(`https://${host}/${v.slug}`)).text();
      expect(html, plan).toContain(`<title>Demo · ${host}</title>`);
      expect(html).not.toContain("Acme");
      expect(html).not.toContain("<style>");
      expect(html).not.toContain('class="wm"');
      expect(html).toContain('class="pwr"');
      expect((await at(`https://${host}/favicon.ico`)).status).toBe(404);
      if (plan === "free") {
        // The same video on example.test still carries the Free watermark.
        expect(await (await at(`${ORIGIN}${v.path}`)).text()).toContain('class="wm"');
      }
    }
  });

  it("link-preview bots get the branded meta and nothing else", async () => {
    const b = await fullyBranded();
    const res = await at(`${b.base}/${b.slug}`, { headers: { "user-agent": "Slackbot-LinkExpanding 1.0" } });
    const html = await res.text();
    expect(html).toContain(`<meta property="og:image" content="${b.base}/b/${b.og}">`);
    expect(html).toContain('<meta property="og:site_name" content="Acme Studio">');
    expect(html).not.toContain("<video");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("brand assets and favicon on a customer host", () => {
  it("/favicon.ico 302s to the branded favicon; /b/ serves only the domain's account's hashes", async () => {
    const b = await fullyBranded();
    const fav = await at(`${b.base}/favicon.ico`);
    expect(fav.status).toBe(302);
    expect(fav.headers.get("location")).toBe(`/b/${b.favicon}`);
    const own = await at(`${b.base}/b/${b.logo}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("image/png");
    expect(own.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await at(`${b.base}/b/${b.logo}`, { method: "HEAD" })).status).toBe(200);
    // Another account's image: unknown here, still served on our hosts.
    const other = await account();
    const theirs = await seedAsset(other.accountId, "logo", 64, 64);
    expect((await at(`${b.base}/b/${theirs}`)).status).toBe(404);
    expect((await at(`${ORIGIN}/b/${theirs}`)).status).toBe(200);
    // No favicon set: 404.
    await seedBranding(b.accountId, { brand_name: "Acme Studio" });
    expect((await at(`${b.base}/favicon.ico`)).status).toBe(404);
  });

  it("while the account is suspended: /favicon.ico and /b/ 404 on its host and /b/ 404s on ours", async () => {
    const b = await fullyBranded();
    expect((await at(`${b.base}/favicon.ico`)).status).toBe(302);
    await suspendAccount(b.accountId);
    expect((await at(`${b.base}/favicon.ico`)).status).toBe(404);
    for (const h of [b.logo, b.favicon, b.og]) {
      expect((await at(`${b.base}/b/${h}`)).status, h).toBe(404);
      expect((await at(`${ORIGIN}/b/${h}`)).status, h).toBe(404);
    }
    expect((await at(`${b.base}/b/${b.logo}`, { method: "HEAD" })).status).toBe(404);
  });
});

describe("redirecting hosts with the branded page", () => {
  it("to a customer host that isn't live yet: /<slug> 302s to example.test, other paths 404; once live, 301", async () => {
    const a = await account();
    const v = await video(a.accountId, a.key);
    const next = await seedDomain(a.accountId, { status: "pending" });
    const old = await seedDomain(a.accountId, { status: "redirecting", redirect_to: next, redirect_until: now() + 86400 });
    const res = await at(`https://${old}/${v.slug}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://example.test/${v.username}/v/${v.slug}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await at(`https://${old}/s/player.js`)).status).toBe(404);
    expect((await at(`https://${old}/${"Z".repeat(14)}`)).status).toBe(404);

    await env.DB.prepare("UPDATE custom_domains SET status = 'active' WHERE hostname = ?").bind(next).run();
    clearCustomHostCache();
    const live = await at(`https://${old}/${v.slug}`);
    expect(live.status).toBe(301);
    expect(live.headers.get("location")).toBe(`https://${next}/${v.slug}`);
    const page = await at(`https://${next}/${v.slug}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('class="pwr"');

    // Disabled, or missing, target: back to example.test.
    await env.DB.prepare("UPDATE custom_domains SET disabled_at = ? WHERE hostname = ?").bind(now(), next).run();
    clearCustomHostCache();
    expect((await at(`https://${old}/${v.slug}`)).status).toBe(302);
    const gone = await seedDomain(a.accountId, { status: "redirecting", redirect_to: "nowhere.example.net", redirect_until: now() + 86400 });
    expect((await at(`https://${gone}/${v.slug}`)).status).toBe(302);
  });

  it("to another account's live host: treated as not live (302 to example.test)", async () => {
    const a = await account();
    const v = await video(a.accountId, a.key);
    const other = await account();
    const theirs = await seedDomain(other.accountId);
    const old = await seedDomain(a.accountId, { status: "redirecting", redirect_to: theirs, redirect_until: now() + 86400 });
    const res = await at(`https://${old}/${v.slug}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://example.test/${v.username}/v/${v.slug}`);
  });
});

describe("links the tools hand out", () => {
  const slugOf = (u: string) => new URL(u).pathname.split("/").pop()!;

  it("no domain, or a pending or failed one: example.test links, for private and not-ready videos too", async () => {
    for (const status of [null, "pending", "failed"]) {
      const a = await account();
      if (status) await seedDomain(a.accountId, { status });
      const id = await seedReady(a.accountId);
      const priv = await seedReady(a.accountId);
      const notReady = await seedReady(a.accountId);
      await env.DB.prepare("UPDATE recordings SET status = 'transcribing' WHERE id = ?").bind(notReady).run();
      const r = await mcp("share_recording", { recording_id: id }, a.key);
      expect(r.data.url, String(status)).toMatch(new RegExp(`^${ORIGIN}/[^/]+/v/[A-Za-z0-9]+$`));
      for (const v of [priv, notReady]) {
        expect((await mcp("get_video", { recording_id: v }, a.key)).data.url, String(status)).toBe(await videoLinkOf(v));
      }
    }
  });

  it("an active domain: every video gets https://<host>/<slug>, whatever its state; owner_url stays on example.test", async () => {
    const a = await account();
    const host = await seedDomain(a.accountId);
    const pub = await seedReady(a.accountId);
    const priv = await seedReady(a.accountId);
    const pass = await seedReady(a.accountId);
    const custom = async (id: string) => `https://${host}/${slugOf(await videoLinkOf(id))}`;

    const s = await mcp("share_recording", { recording_id: pub }, a.key);
    expect(s.data.url).toBe(await custom(pub));
    expect(s.data.share_url).toBe(s.data.url);
    expect(s.data.display).toBe(`[Demo](${s.data.url})`);
    expect(s.data.owner_url).toMatch(new RegExp(`^${ORIGIN}/[^/]+/v/${slugOf(s.data.url)}\\?ot=`));
    // The custom URL really opens the video there.
    expect((await at(s.data.url)).status).toBe(200);

    const p = await mcp("share_recording", { recording_id: pass, passcode: "hunter22" }, a.key);
    expect(p.data.url).toBe(await custom(pass));
    expect(p.data.owner_url.startsWith(`${ORIGIN}/`)).toBe(true);

    const g = await mcp("get_video", { recording_id: pub }, a.key);
    expect(g.data.url).toBe(s.data.url);
    expect(g.data.owner_url.startsWith(`${ORIGIN}/`)).toBe(true);
    const gp = await mcp("get_video", { recording_id: priv }, a.key);
    expect(gp.data.visibility).toBe("private");
    expect(gp.data.url).toBe(await custom(priv));
    expect(gp.data.owner_url).toMatch(new RegExp(`^${ORIGIN}/[^/]+/v/${slugOf(gp.data.url)}\\?ot=`));
    expect((await mcp("get_video_stats", { recording_id: pub }, a.key)).data.url).toBe(s.data.url);

    const list = (await mcp("list_videos", {}, a.key)).data.recordings as { recording_id: string; url: string; owner_url: string }[];
    const byId = Object.fromEntries(list.map((r) => [r.recording_id, r]));
    expect(byId[pub].url).toBe(s.data.url);
    expect(byId[priv].url).toBe(await custom(priv));
    expect(byId[pass].url).toBe(await custom(pass));
    for (const r of list) expect(r.owner_url.startsWith(`${ORIGIN}/`)).toBe(true);
    const found = (await mcp("search_videos", { query: "demo" }, a.key)).data.recordings as { recording_id: string; url: string }[];
    expect(found.find((r) => r.recording_id === pub)!.url).toBe(s.data.url);

    // revoke_share: private again with a new slug, still on the custom host; owner_url on example.test.
    const rv = await mcp("revoke_share", { recording_id: pub }, a.key);
    expect(rv.data.share_url).toBe(await custom(pub));
    expect(rv.data.share_url).not.toBe(s.data.url);
    expect(rv.data.owner_url).toMatch(new RegExp(`^${ORIGIN}/[^/]+/v/${slugOf(rv.data.share_url)}\\?ot=`));
    expect((await mcp("get_video", { recording_id: pub }, a.key)).data.url).toBe(rv.data.share_url);
    // ...and the custom host sends viewers of the now-private video to example.test.
    const res = await at(rv.data.share_url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://example.test${new URL(await videoLinkOf(pub)).pathname}`);
  });

  it("an active domain: a not-ready recording (start_recording, get_video) gets the custom URL, which 302s to example.test", async () => {
    const a = await account();
    const host = await seedDomain(a.accountId);
    const dev = await connectDevice(a.deviceToken!);
    const started = await mcp("start_recording", { max_seconds: 10 }, a.key);
    expect(started.isError).toBe(false);
    const id = started.data.recording_id as string;
    const home = await videoLinkOf(id);
    expect(started.data.url).toBe(`https://${host}/${slugOf(home)}`);
    expect(started.data.display).toBe(`[${started.data.title}](${started.data.url})`);

    const g = await mcp("get_video", { recording_id: id }, a.key);
    expect(g.data.status).not.toBe("ready");
    expect(g.data.url).toBe(started.data.url);
    expect(g.data.owner_url).toMatch(new RegExp(`^${ORIGIN}/[^/]+/v/${slugOf(home)}\\?ot=`));

    const res = await at(started.data.url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://example.test${new URL(home).pathname}`);
    dev.ws.close();
  });

  it("the owner's page on example.test offers the custom URL for a private video of a live domain", async () => {
    const a = await account();
    const host = await seedDomain(a.accountId);
    const id = await seedReady(a.accountId);
    const g = await mcp("get_video", { recording_id: id }, a.key);
    expect(g.data.url).toBe(`https://${host}/${slugOf(await videoLinkOf(id))}`);
    // The owner link sets the owner cookie (303); the page opened with it is the owner's view.
    const claim = await at(g.data.owner_url);
    expect(claim.status).toBe(303);
    const cookie = /(__Host-rb_owner=[^;]+)/.exec(claim.headers.get("set-cookie") ?? "")![1];
    const html = await (await at(await videoLinkOf(id), { headers: { cookie } })).text();
    expect(html).toContain(`<input id="pop-url" class="pop-url" type="text" readonly value="${g.data.url}" aria-label="Public link">`);
  });

  it("a disabled domain and a redirecting one: example.test links; old example.test links keep working", async () => {
    for (const over of [{ disabled_at: now() }, { status: "redirecting", redirect_to: "example.test", redirect_until: now() + 86400 }]) {
      const a = await account();
      await seedDomain(a.accountId, over);
      const id = await seedReady(a.accountId);
      const r = await mcp("share_recording", { recording_id: id }, a.key);
      expect(r.data.url.startsWith(`${ORIGIN}/`)).toBe(true);
      expect((await at(r.data.url)).status).toBe(200);
    }
    // Live domain: the example.test URL of a public video still opens.
    const a = await account();
    await seedDomain(a.accountId);
    const v = await video(a.accountId, a.key);
    expect((await at(`${ORIGIN}${v.path}`)).status).toBe(200);
  });

  it("get_branding / set_branding URLs use the live custom host", async () => {
    const a = await account();
    const logo = await seedAsset(a.accountId, "logo", 64, 64);
    await seedBranding(a.accountId, { brand_name: "Acme", logo });
    expect((await mcp("get_branding", {}, a.key)).data.logo_url).toBe(`${ORIGIN}/b/${logo}`);
    const host = await seedDomain(a.accountId, { status: "pending" });
    expect((await mcp("get_branding", {}, a.key)).data.logo_url).toBe(`${ORIGIN}/b/${logo}`);
    await env.DB.prepare("UPDATE custom_domains SET status = 'active' WHERE hostname = ?").bind(host).run();
    expect((await mcp("get_branding", {}, a.key)).data.logo_url).toBe(`https://${host}/b/${logo}`);
    const set = await mcp("set_branding", { brand_name: "Acme Two" }, a.key);
    expect(set.isError).toBe(false);
    expect(set.data.logo_url).toBe(`https://${host}/b/${logo}`);
  });

  it("passcode videos on a live domain get the custom URL; the custom host sends their viewers to example.test", async () => {
    const a = await account();
    const host = await seedDomain(a.accountId);
    const v = await video(a.accountId, a.key);
    await setPasscode(env, v.id, "hunter22");
    expect((await mcp("get_video", { recording_id: v.id }, a.key)).data.url).toBe(`https://${host}/${v.slug}`);
    const res = await at(`https://${host}/${v.slug}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://example.test${v.path}`);
  });
});

describe("example.test viewer is unchanged", () => {
  it("an account with a live domain and branding still gets the Recitbot page on example.test", async () => {
    const b = await fullyBranded();
    const res = await at(`${ORIGIN}${b.path}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("recitbot-lockup.svg");
    expect(html).toContain('<meta property="og:site_name" content="Recitbot">');
    expect(html).toContain("og-card.png");
    expect(html).toContain("<title>Demo · Recitbot</title>");
    expect(html).not.toContain("Acme Studio");
    expect(html).not.toContain('class="pwr"');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain('rel="canonical"');
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(res.headers.get("content-security-policy")).toContain(`img-src ${ORIGIN}/s/`);
  });
});
