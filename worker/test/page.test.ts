import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { shareSig } from "../src/share";
import { now } from "../src/util";
import * as sessionModule from "../src/oauth/web-session";
import css from "../web/recitbot.css?raw";
import iconSvg from "../web/icon.svg?raw";
import lockupSvg from "../web/recitbot-lockup.svg?raw";
import playerJs from "../web/player.js?raw";
import { call, mcp, ORIGIN, seedAccount, seedReady, videoLinkOf, withEnv } from "./helpers";

// Tests say who is signed in on the website by mocking oauth/web-session getWebSession.
// vi.mock can't reach it: the worker's main module (Durable Objects) is loaded before this file. Spy on the shared module.
const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const BOT = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const FORBIDDEN = /personal\s*brand\s*corp/i;

async function shareLink(key: string, id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await mcp("share", { recording_id: id, ...extra }, key);
  expect(r.isError).toBe(false);
  return (await videoLinkOf(id)).slice(ORIGIN.length);
}

async function get(path: string, ua = UA): Promise<{ res: Response; html: string }> {
  const res = await call(path, { headers: { "user-agent": ua } });
  return { res, html: await res.text() };
}

const meta = (html: string, attr: "name" | "property", key: string) =>
  new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)">`).exec(html)?.[1];

/** Every page must be private and branded, whatever its status. */
function expectPrivateBrandedPage(res: Response, html: string) {
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("x-robots-tag")).toContain("noindex");
  expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
  expect(meta(html, "property", "og:site_name")).toBe("Recitbot");
  expect(meta(html, "name", "twitter:card")).toBe("summary_large_image");
  expect(meta(html, "property", "og:image")).toMatch(new RegExp(`^${ORIGIN}/s/og-card\\.png\\?v=\\w+$`));
  // icons come from /s/ like everything else: CSP img-src only allows that path
  expect(html).toMatch(/<link rel="icon" href="\/s\/favicon\.ico\?v=\w+" sizes="16x16 32x32 48x48">/);
  expect(html).toMatch(/<link rel="icon" href="\/s\/favicon\.svg\?v=\w+" type="image\/svg\+xml">/);
  expect(html).toMatch(/<link rel="apple-touch-icon" href="\/s\/apple-touch-icon\.png\?v=\w+">/);
  for (const m of html.matchAll(/<(?:link|img)\b[^>]*(?:href|src)="([^"]+)"/g)) expect(m[1]).toMatch(/^\/s\//);
  expect(html).toMatch(/<link rel="stylesheet" href="\/s\/recitbot\.css\?v=\w+">/);
  expect(html).toMatch(/<img src="\/s\/recitbot-lockup\.svg\?v=\w+" alt="Recitbot"/);
  expect(html).not.toMatch(FORBIDDEN);
  // no third-party anything: every absolute URL is this origin's static card, (viewer comment form) Turnstile's script,
  // or the Free-plan watermark's plain link to example.test (an anchor, not a load)
  for (const u of html.match(/https?:\/\/[^"\s<]+/g) ?? []) {
    const ok = u.startsWith(`${ORIGIN}/s/`) || u === "https://challenges.cloudflare.com/turnstile/v0/api.js" || u === "https://example.test";
    expect(ok, u).toBe(true);
  }
  // strict CSP: nothing inline
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain(`script-src ${ORIGIN}/s/`);
  expect(csp).toContain(`style-src ${ORIGIN}/s/`);
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|nonce-/);
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  expect(html).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/i);
}

describe("share page: meta and privacy", () => {
  it("viewer page: og/twitter meta, favicons, noindex header + meta, referrer policy", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId, { transcript: { segments: [{ start: 1, end: 2, text: "hi" }] } });
    const { res, html } = await get(await shareLink(key, id));
    expect(res.status).toBe(200);
    expectPrivateBrandedPage(res, html);
    expect(meta(html, "property", "og:title")).toBe("Demo");
    expect(meta(html, "name", "twitter:title")).toBe("Demo");
    expect(meta(html, "property", "og:description")).toMatch(/timestamped transcript/);
    expect(meta(html, "name", "referrer")).toBe("strict-origin-when-cross-origin");
    expect(html).toContain("<title>Demo · Recitbot</title>");
    expect(html).toMatch(/<script src="\/s\/player\.js\?v=\w+" defer><\/script>/);
  });

  it('untitled recordings fall back to "Recitbot recording"', async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    await env.DB.prepare("UPDATE recordings SET title = NULL WHERE id = ?").bind(id).run();
    const { html } = await get(await shareLink(key, id));
    expect(meta(html, "property", "og:title")).toBe("Recitbot recording");
    expect(meta(html, "property", "og:description")).toBe("A screen recording shared with Recitbot.");
  });

  it("titles are escaped in the title tag, meta and heading", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    await env.DB.prepare("UPDATE recordings SET title = ? WHERE id = ?").bind(`"><script>alert(1)</script>`, id).run();
    const { html } = await get(await shareLink(key, id));
    expect(html).not.toContain("<script>alert");
    expect(meta(html, "property", "og:title")).toBe("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("link-preview bots get the meta but no player, no media URL, no tokens, no cookie", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { res, html } = await get(await shareLink(key, id), BOT);
    expect(res.status).toBe(200);
    expectPrivateBrandedPage(res, html);
    expect(meta(html, "property", "og:title")).toBe("Demo");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).not.toMatch(/<video|\/m\/|data-vt|player\.js|[?&](s|e|o)=/);
    const row = await env.DB.prepare("SELECT views, previews FROM recordings WHERE id = ?").bind(id).first<{ views: number; previews: number }>();
    expect(row).toEqual({ views: 0, previews: 1 });
  });

  it("expired and invalid links get the branded 404 page, still noindex", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const privateUrl = (await mcp("get_video", { recording_id: await seedReady(accountId) }, key)).data.share_url.slice(ORIGIN.length);
    const past = now() - 10;
    const pages = [
      `/v/${id}?e=${past}&s=${await shareSig(env, id, past, 1)}`,
      `/v/${id}?e=${now() + 60}&s=X`,
      `/v/${id}`,
      privateUrl,
      (await shareLink(key, id)).replace(/\/v\/.*/, "/v/NoSuchSlug1234"),
    ];
    for (const path of pages) {
      for (const ua of [UA, BOT]) {
        const { res, html } = await get(path, ua);
        expect(res.status).toBe(404);
        expectPrivateBrandedPage(res, html);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(html).toContain("This video is private or doesn&#39;t exist");
        expect(html).toMatch(/<img class="mark" src="\/s\/icon\.svg\?v=\w+"/);
        expect(meta(html, "property", "og:title")).toBe("Video not available");
        expect(html).not.toMatch(/<video|\/m\/|player\.js|Demo/);
      }
    }
  });

  it("passcode form is branded and does not reveal media", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { res, html } = await get(await shareLink(key, id, { passcode: "open-sesame" }));
    expect(res.status).toBe(200);
    expectPrivateBrandedPage(res, html);
    expect(html).toContain('<input id="pc" name="passcode" type="password"');
    expect(html).not.toMatch(/<video|\/m\/|data-vt/);
  });
});

describe("share page: footer follows the video's visibility", () => {
  const PRIVATE_FOOT = '<footer class="foot">Shared privately with Recitbot</footer>';
  const NEUTRAL_FOOT = '<footer class="foot">Recorded with Recitbot</footer>';

  it("a shared (public) video never says private: viewer page, link preview, owner view and passcode form", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const path = await shareLink(key, id);
    for (const ua of [UA, BOT]) {
      const { res, html } = await get(path, ua);
      expect(res.status).toBe(200);
      expect(html).toContain(NEUTRAL_FOOT);
      expect(html).not.toMatch(/privately|private screen recording/i);
    }
    session.account = accountId;
    const owner = await get(path).finally(() => (session.account = null));
    expect(owner.html).toContain(NEUTRAL_FOOT);
    expect(owner.html).not.toContain("Shared privately");
    const locked = await seedReady(accountId);
    const form = await get(await shareLink(key, locked, { passcode: "open-sesame" }));
    expect(form.html).toContain(NEUTRAL_FOOT);
    expect(form.html).not.toContain("Shared privately");
  });

  it("a private video (its owner's view) says so in the footer and the description", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const path = (await mcp("get_video", { recording_id: id }, key)).data.url.slice(ORIGIN.length);
    session.account = accountId;
    const { res, html } = await get(path).finally(() => (session.account = null));
    expect(res.status).toBe(200);
    expect(html).toContain('id="priv"');
    expect(html).toContain(PRIVATE_FOOT);
    expect(meta(html, "property", "og:description")).toBe("A private screen recording shared with Recitbot.");
  });

  it("the footer names the deployment's BRAND_NAME, escaped", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const acme = withEnv({ BRAND_NAME: "Acme & Co" });
    const path = (await mcp("get_video", { recording_id: id }, key)).data.url.slice(ORIGIN.length);
    session.account = accountId;
    const own = await call(path, { headers: { "user-agent": UA } }, acme).finally(() => (session.account = null));
    expect(await own.text()).toContain('<footer class="foot">Shared privately with Acme &amp; Co</footer>');
    const missing = await call(path, { headers: { "user-agent": UA } }, acme);
    expect(await missing.text()).toContain('<footer class="foot">Recorded with Acme &amp; Co</footer>');
  });

  it("revoke_share makes the page private again: the private footer comes back", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    await shareLink(key, id);
    expect((await mcp("revoke_share", { recording_id: id }, key)).isError).toBe(false);
    const path = (await mcp("get_video", { recording_id: id }, key)).data.url.slice(ORIGIN.length);
    session.account = accountId;
    const { html } = await get(path).finally(() => (session.account = null));
    expect(html).toContain(PRIVATE_FOOT);
  });

  it("the not-found page (private to others, or missing) has the neutral footer", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const path = (await mcp("get_video", { recording_id: id }, key)).data.url.slice(ORIGIN.length);
    const { res, html } = await get(path);
    expect(res.status).toBe(404);
    expect(html).toContain(NEUTRAL_FOOT);
    expect(html).not.toContain("Shared privately");
  });
});

describe("share page: player and transcript markup", () => {
  it("the only media URL is the cookie-gated /m/<slug>; the page never shows the internal id", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const path = await shareLink(key, id);
    const slug = path.split("/").pop()!;
    const { res, html } = await get(path);
    expect(html.match(/\/m\/[^"]*/g)).toEqual([`/m/${slug}`]);
    expect(html).toContain(`<video id="v" src="/m/${slug}" data-vt="`);
    expect(html).not.toContain(id);
    expect(html).not.toMatch(/[?&](s|e|o)=/);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`mt=[^;]+; Path=/m/${slug}; Max-Age=\\d+; HttpOnly; SameSite=Strict; Secure`));
  });

  it("video is inline-playable with native controls as the no-script fallback", async () => {
    const { accountId, key } = await seedAccount();
    const { html } = await get(await shareLink(key, await seedReady(accountId)));
    const video = /<video [^>]*>/.exec(html)![0];
    for (const a of [" controls", " playsinline", " webkit-playsinline", 'preload="metadata"', 'controlslist="nodownload noremoteplayback"']) {
      expect(video).toContain(a);
    }
  });

  it("custom controls are labelled buttons with keyboard hints; scrub bar is an ARIA slider", async () => {
    const { accountId, key } = await seedAccount();
    const { html } = await get(await shareLink(key, await seedReady(accountId)));
    expect(html).toContain('<button type="button" class="big" id="big" aria-label="Play (k)">');
    expect(html).toContain('<button type="button" class="b" id="play" aria-label="Play (k)">');
    expect(html).toContain('<button type="button" class="b" id="mute" aria-label="Mute (m)">');
    expect(html).toContain('<button type="button" class="b" id="fs" aria-label="Full screen (f)">');
    expect(html).toContain('<input type="range" id="vol" min="0" max="1" step="0.05" value="1" aria-label="Volume">');
    expect(html).toMatch(/<div class="scrub" id="scrub" role="slider" tabindex="0" aria-label="Seek"/);
    expect(html).toContain('<span class="sr">Playback speed</span>');
    const speeds = [...html.matchAll(/<option value="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(speeds).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    expect(html).toContain('<option value="1" selected>');
    // every button has an accessible name; icons are hidden from assistive tech
    for (const b of html.match(/<button\b[^>]*>/g) ?? []) expect(b).toMatch(/aria-label="[^"]+"|type="submit"/);
    for (const s of html.match(/<svg\b[^>]*>/g) ?? []) expect(s).toContain('aria-hidden="true"');
  });

  it("transcript lines are seek buttons with start times, timestamps in their own element", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId, {
      transcript: {
        segments: [
          { start: 0, end: 2, text: " hello " },
          { start: 65.4, end: 67, text: "<b>bye</b>" },
          { start: 3600, end: 3601, text: "late" },
        ],
      },
    });
    const { html } = await get(await shareLink(key, id));
    expect(html).toContain('<section class="tx" aria-labelledby="txh"><h2 id="txh">Transcript</h2><ol id="lines">');
    const lines = [...html.matchAll(/<button type="button" class="l" data-t="([\d.]+)"><span class="t">([\d:]+)<\/span><span>(.*?)<\/span><\/button>/g)];
    expect(lines.map((m) => [m[1], m[2], m[3]])).toEqual([
      ["0", "00:00", "hello"],
      ["65.4", "01:05", "&lt;b&gt;bye&lt;/b&gt;"],
      ["3600", "60:00", "late"],
    ]);
  });

  it("no transcript: a message instead of the list", async () => {
    const { accountId, key } = await seedAccount();
    const { html } = await get(await shareLink(key, await seedReady(accountId)));
    expect(html).toContain('<h2 id="txh">Transcript</h2><p class="muted">No transcript.</p>');
    expect(html).not.toContain('id="lines"');
  });

  it("owner view is labelled and carries no view token", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const path = await shareLink(key, id);
    session.account = accountId;
    const { html } = await get(path).finally(() => (session.account = null));
    expect(html).toContain('<p class="chip">Owner view: not counted in view stats</p>');
    expect(html).not.toContain("data-vt");
  });
});

describe("static assets", () => {
  it("player.js: beacon protocol, shortcuts, iOS fullscreen fallback, transcript follow", () => {
    expect(playerJs).toContain('navigator.sendBeacon(location.pathname + "/b", new URLSearchParams({ t: vt, p: String(pct) }))');
    expect(playerJs).toContain("[100, 75, 50, 25]");
    expect(playerJs).toMatch(/addEventListener\("pagehide"/);
    // A prerendered page sends its load beacon only once it is shown.
    expect(playerJs).toContain('if (document.prerendering) document.addEventListener("prerenderingchange", () => send(0), { once: true });');
    for (const k of ['case " "', 'case "k"', 'case "ArrowLeft"', 'case "ArrowRight"', 'case "ArrowUp"', 'case "ArrowDown"', 'case "m"', 'case "f"']) {
      expect(playerJs).toContain(k);
    }
    expect(playerJs).toContain('tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"');
    expect(playerJs).toContain("webkitEnterFullscreen");
    expect(playerJs).toContain("prefers-reduced-motion");
    expect(playerJs).not.toMatch(/https?:\/\/|eval\(|innerHTML/);
  });

  it("css: brand palette, self-hosted fonts only, focus-visible, reduced motion", () => {
    for (const c of ["#111318", "#F5F3EE", "#F2463A", "#5B606B", "#1FA89A", "#FFE1DC"]) expect(css).toContain(c);
    expect([...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1])).toEqual([
      "fonts/space-grotesk-700.woff2",
      "fonts/inter-var.woff2",
      "fonts/jetbrains-mono-500.woff2",
    ]);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(css).not.toMatch(/@import|https?:\/\//);
  });

  // The CSS rule bodies for a selector (all occurrences, any media block), whitespace-free.
  const rules = (sel: string) =>
    [...css.replace(/\s+/g, " ").matchAll(new RegExp(`(?:^|[}\\s])${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g"))].map((m) =>
      m[1].replace(/\s+/g, ""),
    );

  it("transcript panel: locked to the player's row side by side, stacked with a cap, scrolls inside", () => {
    // Side by side the panel adds nothing to the row height (the player's) and stretches to it: never past the video.
    const wide = /@media \(min-width:900px\)\{([^@]*?)\}\s*@media/.exec(css.replace(/\n/g, " "))![1];
    expect(wide).toMatch(/\.layout\{grid-template-columns:minmax\(0,1fr\) 300px;align-items:start\}/);
    expect(wide).toMatch(/\.tx\{contain:size;align-self:stretch\}/);
    expect(css).toMatch(/@media \(min-width:1200px\)\{\.layout\{grid-template-columns:minmax\(0,1fr\) 360px\}\}/);
    expect(css).toMatch(/@media \(min-width:900px\)\{\.tx ol\{max-height:none;flex:1;min-height:0\}\}/);
    // the player's height comes from its width alone, so the row (and the panel) can't change after load
    expect(rules(".player")[0]).toContain("aspect-ratio:16/9");
    // no sticky / viewport-height panel any more (that is what ran past the video)
    expect(rules(".tx").join(";")).not.toMatch(/sticky|100vh/);
    const ol = rules(".tx ol")[0];
    expect(ol).toContain("overflow-y:auto");
    expect(ol).toContain("max-height:min(55vh,480px)");
    expect(ol).toContain("overscroll-behavior:contain");
    // thin on-brand scrollbar, standard + WebKit
    expect(ol).toContain("scrollbar-width:thin");
    expect(ol).toContain("scrollbar-color:var(--sb)transparent");
    expect(rules(".tx ol::-webkit-scrollbar")[0]).toBe("width:8px");
    expect(rules(".tx ol::-webkit-scrollbar-thumb")[0]).toContain("background:var(--sb)");
    expect(rules(".tx")).toContain("--sb:rgba(245,243,238,.2);--sb-hover:rgba(245,243,238,.34)");
  });

  it("active transcript line: highlighted background only, no teal left-edge bar", () => {
    expect(rules('button.l[aria-current="true"]')).toEqual(["background:rgba(31,168,154,.16)"]);
    expect(css).not.toMatch(/border-left/);
  });

  it("player.js follows the active line by easing the panel's scrollTop only, pausing for manual scrolls", () => {
    // the panel only: never the page
    expect(playerJs).not.toMatch(/scrollIntoView|window\.scroll|document\.(documentElement|body|scrollingElement)\.scroll|\bscrollTo\(|\bscrollBy\(/);
    expect(playerJs).toContain("list.scrollTop = from + (to - from) * e;");
    // re-centre past ~50 % of the visible height; target puts the line mid-panel
    expect(playerJs).toContain("y <= view * 0.55");
    expect(playerJs).toContain("mid - view / 2");
    // manual scrolling (wheel, touch, keys, scrollbar drag) holds following for 3 s; a line click resumes at once
    for (const ev of ['"wheel"', '"touchstart"', '"touchmove"', '"pointerdown"', '"keydown"', '"scroll"']) expect(playerJs).toContain(`list.addEventListener(${ev}`);
    expect(playerJs).toContain("const HOLD_MS = 3000;");
    expect(playerJs).toMatch(/b\.addEventListener\("click", \(\) => \{[^}]*manualUntil = 0;/);
    // reduced motion: jump, no easing
    expect(playerJs).toMatch(/if \(reduced\.matches\) \{\s*wrote = to;\s*list\.scrollTop = to;/);
  });

  it("no shipped file names the parent company", () => {
    for (const s of [css, playerJs, lockupSvg, iconSvg]) expect(s).not.toMatch(FORBIDDEN);
  });
});
