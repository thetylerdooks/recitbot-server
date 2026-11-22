// Watch page Share pill + popover: owner only, the popover's read-only field holds the clean public URL (server-rendered,
// never ?ot=); a private video's popover looks the same and its Copy link first POSTs ./share; viewers and signed-out
// users get none of it.
import { afterEach, describe, expect, it, vi } from "vitest";
import metaJs from "../web/meta.js?raw";
import * as sessionModule from "../src/oauth/web-session";
import { call, mcp, ORIGIN, seedAccount, seedReady } from "./helpers";

const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const COOKIE = /(__Host-rb_owner=[^;]+)/;
const linkUrl = (html: string) => /<input id="pop-url" class="pop-url" type="text" readonly value="([^"]*)" aria-label="Public link">/.exec(html)?.[1] ?? null;
const SHARE_BTN =
  '<button type="button" class="shr" id="shr" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>Share</button>';

async function video(opts: { shared?: boolean } = {}) {
  const a = await seedAccount();
  const id = await seedReady(a.accountId);
  let shareUrl: string | null = null;
  if (opts.shared) {
    const s = await mcp("share", { recording_id: id }, a.key);
    expect(s.isError).toBe(false);
    shareUrl = s.data.url as string;
  }
  const g = await mcp("get_video", { recording_id: id }, a.key);
  expect(g.isError).toBe(false);
  return { ...a, id, shareUrl, url: g.data.url as string, path: (g.data.url as string).slice(ORIGIN.length), ownerUrl: g.data.owner_url as string };
}

async function get(pathOrUrl: string, headers: Record<string, string> = {}) {
  const res = await call(pathOrUrl.replace(ORIGIN, ""), { headers: { "user-agent": UA, ...headers } });
  return { res, html: await res.text(), cookie: COOKIE.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null };
}

describe("watch page Share popover", () => {
  it("the signed-in owner gets the pill at the end of the title row and a popover with the share tool's clean url", async () => {
    const v = await video({ shared: true });
    session.account = v.accountId;
    const { res, html } = await get(v.path);
    expect(res.status).toBe(200);
    expect(html).toContain(SHARE_BTN);
    // title row: title, byline, then Share last
    expect(html).toMatch(/<div class="vtitle">.*<h1 id="ttl"[\s\S]*?<span class="by">[\s\S]*?<div class="shr-w">/);
    expect(html).toContain('<div class="pop" id="pop" role="dialog" aria-labelledby="pop-h" hidden><p class="pop-h" id="pop-h">Share this video</p>');
    expect(html).toContain('<button type="button" class="cpb" id="cpb">Copy link</button>');
    expect(html).toContain('<p class="pop-n">Anyone with the link can watch</p>');
    expect(html).toContain('<span id="pop-live" class="sr" aria-live="polite"></span>');
    const u = linkUrl(html);
    expect(u).toBe(v.shareUrl);
    expect(u).toBe(`${ORIGIN}${v.path}`);
    expect(u).not.toContain("ot=");
    expect(u).not.toContain("?");
    expect(html).toContain("/s/meta.js");
  });

  it("opened via the owner link (owner cookie): the link is still clean", async () => {
    const v = await video({ shared: true });
    const claim = await get(v.ownerUrl);
    expect(claim.res.status).toBe(303);
    expect(claim.cookie).toBeTruthy();
    const { html } = await get(v.path, { cookie: claim.cookie! });
    expect(html).toContain(SHARE_BTN);
    const u = linkUrl(html);
    expect(u).toBe(v.shareUrl);
    expect(u).not.toContain("ot=");
    expect(u).not.toContain("?");
    expect(html).not.toContain("ot=");
  });

  it("viewers and signed-out users get no Share, no popover and no link field", async () => {
    const v = await video({ shared: true });
    const other = await seedAccount();
    for (const who of [null, other.accountId]) {
      session.account = who;
      const { res, html } = await get(v.path);
      expect(res.status, String(who)).toBe(200);
      expect(html).not.toMatch(/id="shr"|class="shr|id="pop"|pop-url|cpb|Share this video|data-url/);
    }
  });

  it("a private video: the same popover (clean url, Copy link marked private, new note), no 'ask your bot'", async () => {
    const v = await video();
    session.account = v.accountId;
    const { res, html } = await get(v.path);
    expect(res.status).toBe(200);
    expect(html).toContain(SHARE_BTN);
    expect(html).toContain('<p class="pop-h" id="pop-h">Share this video</p>');
    expect(html).toContain('<button type="button" class="cpb" id="cpb" data-private="1">Copy link</button>');
    expect(html).toContain('<p class="pop-n">Anyone with the link can watch</p>');
    expect(html).not.toMatch(/Ask your bot|Only people with the link/);
    const u = linkUrl(html);
    expect(u).toBe(`${ORIGIN}${v.path}`);
    expect(u).not.toContain("?");
    expect(html).toContain('<p class="chip" id="priv">Private: only you can see this video</p>');
  });

  it("Copy link on a private video flips the page to the shared state in place, only once POST ./share succeeds", async () => {
    // The shared state meta.js flips to: what the server renders for the owner of a shared video (no Private chip,
    // Owner view chip kept, Copy link not marked private).
    const v = await video({ shared: true });
    session.account = v.accountId;
    const { html } = await get(v.path);
    expect(html).not.toContain('id="priv"');
    expect(html).not.toContain("Private: only you");
    expect(html).toContain('<p class="chip">Owner view: not counted in view stats</p>');
    expect(html).toContain('<button type="button" class="cpb" id="cpb">Copy link</button>');

    const fn = /const makePublic = async \(\) => \{([\s\S]*?)\n {2}\};/.exec(metaJs)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toContain('fetch(location.pathname + "/share", { method: "POST"');
    // A failed POST (or no url back) throws before anything on the page changes, so the chip stays.
    const fail = fn!.indexOf("throw new Error()");
    expect(fail).toBeGreaterThan(-1);
    for (const step of ["input.value = data.url", "delete cpb.dataset.private", 'document.getElementById("priv")', "priv.remove()"]) {
      expect(fn!.indexOf(step), step).toBeGreaterThan(fail);
    }
    // The click handler stops on failure: no copy, no chip change.
    expect(metaJs).toMatch(/await makePublic\(\);\s*\} catch \{\s*return say\("Couldn't share the video\. Try again\."\);/);
  });
});
