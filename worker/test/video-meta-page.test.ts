// Watch page title + description: the owner-only PATCH /<username>/v/<slug>/meta and how both render. Validation and
// setVideoMeta are covered by video-meta.test.ts.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shareRecording, videoUrl } from "../src/share";
import * as sessionModule from "../src/oauth/web-session";
import { setVideoMeta } from "../src/video-meta";
import metaJs from "../web/meta.js?raw";
import { call, ORIGIN, seedAccount, seedReady } from "./helpers";

// Tests say who is signed in on the website by mocking oauth/web-session getWebSession (see page.test.ts).
const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";

async function video(opts: { shared?: boolean } = {}) {
  const { accountId } = await seedAccount();
  const id = await seedReady(accountId);
  const url = opts.shared ? await shareRecording(env, ORIGIN, id, accountId) : await videoUrl(env, ORIGIN, id, accountId);
  return { accountId, id, path: url.slice(ORIGIN.length) };
}

function patch(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path + "/meta", {
    method: "PATCH",
    headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const row = (id: string) => env.DB.prepare("SELECT title, description FROM recordings WHERE id = ?").bind(id).first<{ title: string | null; description: string | null }>();
const page = async (path: string) => (await call(path, { headers: { "user-agent": UA } })).text();

describe("PATCH /<username>/v/<slug>/meta", () => {
  it("the owner saves title and description; the response is what was stored", async () => {
    const v = await video();
    session.account = v.accountId;
    const res = await patch(v.path, { title: "  New title ", description: "Line one\nLine two" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "New title", description: "Line one\nLine two" });
    expect(await row(v.id)).toEqual({ title: "New title", description: "Line one\nLine two" });
    // one field at a time leaves the other alone; empty clears
    expect(await (await patch(v.path, { description: "" })).json()).toEqual({ title: "New title", description: null });
    // an empty or blank title resets it to the default (null)
    const reset = await patch(v.path, { title: "  " });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ title: null, description: null });
    expect(await row(v.id)).toEqual({ title: null, description: null });
  });

  it("no session, a non-owner, a wrong username or an unknown slug: the same generic 404, nothing changes", async () => {
    const v = await video({ shared: true });
    const other = await seedAccount();
    const cases: [string | null, string][] = [
      [null, v.path],
      [other.accountId, v.path],
      [v.accountId, v.path.replace(/^\/[^/]+/, "/someone-else")],
      [v.accountId, v.path.replace(/[^/]+$/, "NoSuchSlug1234")],
    ];
    for (const [who, path] of cases) {
      session.account = who;
      const res = await patch(path, { title: "hijacked" });
      expect(res.status, `${who} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
    expect((await row(v.id))!.title).toBe("Demo");
  });

  it("cross-origin (or missing Origin) is rejected even for the owner", async () => {
    const v = await video();
    session.account = v.accountId;
    for (const headers of <Record<string, string>[]>[
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const res = await patch(v.path, { title: "csrf" }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    // a form post can't send JSON: anything else is refused before it is read
    expect((await patch(v.path, "title=csrf", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await row(v.id))!.title).toBe("Demo");
  });

  it("over-length and malformed input: 400 with the error", async () => {
    const v = await video();
    session.account = v.accountId;
    let res = await patch(v.path, { title: "a".repeat(121) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "title is longer than 120 characters." });
    res = await patch(v.path, { description: "b".repeat(281) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "description is longer than 280 characters." });
    expect((await patch(v.path, "{nope")).status).toBe(400);
    expect((await patch(v.path, {})).status).toBe(400);
    expect(await row(v.id)).toEqual({ title: "Demo", description: null });
  });

  it("other methods on /meta are not routed", async () => {
    const v = await video();
    session.account = v.accountId;
    expect((await call(v.path + "/meta", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(404);
    expect((await call(v.path + "/meta")).status).toBe(404);
  });
});

describe("watch page: title and description", () => {
  const XSS_T = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const XSS_D = `</textarea><script>alert(3)</script>\n<b>bold</b>`;

  it("viewers see both read-only, escaped", async () => {
    const v = await video({ shared: true });
    await setVideoMeta(env, v.accountId, v.id, { title: XSS_T, description: XSS_D });
    const html = await page(v.path);
    expect(html).not.toMatch(/<script>alert|<img src=x|<b>bold|<\/textarea><script/);
    expect(html).toContain("<h1>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;</h1>");
    expect(html).toContain('<p class="desc">&lt;/textarea&gt;&lt;script&gt;alert(3)&lt;/script&gt;\n&lt;b&gt;bold&lt;/b&gt;</p>');
    expect(html).not.toMatch(/<input id="ttl"|<textarea id="desc"|meta\.js/);
  });

  it("viewers get no description element when it is empty", async () => {
    const v = await video({ shared: true });
    const html = await page(v.path);
    expect(html).toContain("<h1>Demo</h1>");
    expect(html).not.toContain('class="desc"');
  });

  it("the owner gets the same plain text plus pencils (no input boxes), escaped, with limits, a live status and meta.js", async () => {
    const v = await video();
    await setVideoMeta(env, v.accountId, v.id, { title: XSS_T, description: XSS_D });
    session.account = v.accountId;
    const html = await page(v.path);
    expect(html).not.toMatch(/<script>alert|<img src=x|<b>bold/);
    expect(html).not.toMatch(/<textarea|<input id="ttl"|id="desc-n"|contenteditable/);
    expect(html).toContain(
      '<h1 id="ttl" class="ed" data-max="120" data-default="Recitbot recording">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;</h1><button type="button" class="pen" id="ttl-pen" aria-label="Edit title">',
    );
    expect(html).toContain(
      '<p class="desc ed" id="desc" data-max="280" data-placeholder="Add a description">&lt;/textarea&gt;&lt;script&gt;alert(3)&lt;/script&gt;\n&lt;b&gt;bold&lt;/b&gt;</p><button type="button" class="pen" id="desc-pen" aria-label="Edit description">',
    );
    expect(html).toContain('<p id="meta-st" class="st" aria-live="polite"></p>');
    expect(html).toMatch(/<script src="\/s\/meta\.js\?v=\w+" defer><\/script>/);
  });

  it("an untitled video with no transcript: the owner sees the default title and an empty description with the placeholder", async () => {
    const v = await video();
    await setVideoMeta(env, v.accountId, v.id, { title: "" });
    session.account = v.accountId;
    const html = await page(v.path);
    expect(html).toContain('data-default="Recitbot recording">Recitbot recording</h1>');
    expect(html).toContain('<p class="desc ed" id="desc" data-max="280" data-placeholder="Add a description"></p>');
    session.account = null;
    expect(await page(v.path)).not.toContain('class="desc');
  });

  it("viewers get no pencil, no contenteditable, no Share and no editor script", async () => {
    const v = await video({ shared: true });
    const html = await page(v.path);
    expect(html).not.toMatch(/class="pen"|Edit title|Edit description|contenteditable|class="ed|id="shr"|id="pop"|Share this video|meta\.js/);
  });

  it("no description set: everyone sees the first transcript line (trimmed, capped at 280), and nothing is stored", async () => {
    const { accountId } = await seedAccount();
    const first = "  " + "word ".repeat(80) + " ";
    const id = await seedReady(accountId, { transcript: { segments: [{ start: 0, end: 1, text: first }, { start: 1, end: 2, text: "second" }] } });
    const path = (await shareRecording(env, ORIGIN, id, accountId)).slice(ORIGIN.length);
    const want = [...first.trim()].slice(0, 280).join("").trim();
    expect(want.length).toBeLessThanOrEqual(280);
    expect(await page(path)).toContain(`<p class="desc">${want}</p>`);
    session.account = accountId;
    expect(await page(path)).toContain(`data-placeholder="Add a description">${want}</p>`);
    expect(await row(id)).toEqual({ title: "Demo", description: null });
  });

  it("the owner's saved description wins over the transcript line", async () => {
    const { accountId } = await seedAccount();
    const id = await seedReady(accountId, { transcript: { segments: [{ start: 0, end: 1, text: "From the transcript" }] } });
    const path = (await shareRecording(env, ORIGIN, id, accountId)).slice(ORIGIN.length);
    await setVideoMeta(env, accountId, id, { description: "Mine" });
    const html = await page(path);
    expect(html).toContain('<p class="desc">Mine</p>');
    expect(html).not.toContain('<p class="desc">From the transcript</p>');
  });

  it("meta.js writes text only through value/textContent and PATCHes its own path + /meta", () => {
    expect(metaJs).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(metaJs).toContain('location.pathname + "/meta"');
    expect(metaJs).toContain('method: "PATCH"');
  });
});
