// Watch page, owner only: POST /<username>/v/<slug>/share (Copy link on a private video), the stats row and the muted
// transcript-fallback description.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionModule from "../src/oauth/web-session";
import { now } from "../src/util";
import { call, mcp, ORIGIN, seedAccount, seedReady } from "./helpers";

const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const OWNER_COOKIE = /(__Host-rb_owner=[^;]+)/;

async function video(opts: { shared?: boolean; transcript?: unknown } = {}) {
  const a = await seedAccount();
  const id = await seedReady(a.accountId, { transcript: opts.transcript });
  if (opts.shared) expect((await mcp("share", { recording_id: id }, a.key)).isError).toBe(false);
  const g = await mcp("get_video", { recording_id: id }, a.key);
  return { ...a, id, url: g.data.url as string, path: (g.data.url as string).slice(ORIGIN.length), ownerUrl: g.data.owner_url as string };
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await call(path.replace(ORIGIN, ""), { headers: { "user-agent": UA, ...headers } });
  return { res, html: await res.text(), setCookie: res.headers.get("set-cookie") ?? "" };
}

const share = (path: string, headers: Record<string, string> = {}) =>
  call(path + "/share", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "user-agent": UA, ...headers } });

const sharedAt = async (id: string) =>
  (await env.DB.prepare("SELECT shared_at FROM recordings WHERE id = ?").bind(id).first<{ shared_at: number | null }>())!.shared_at;

describe("POST /<username>/v/<slug>/share", () => {
  it("the signed-in owner, same-origin: 200 {url} (the clean url) and anyone can now load the video", async () => {
    const v = await video();
    expect((await get(v.path)).res.status).toBe(404);
    session.account = v.accountId;
    const r = await share(v.path);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: v.url });
    expect(await sharedAt(v.id)).not.toBeNull();
    session.account = null;
    const page = await get(v.path);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("data-vt=");
    // Same function as the MCP share tool: the url is unchanged.
    expect((await mcp("get_video", { recording_id: v.id }, v.key)).data.url).toBe(v.url);
  });

  it("the owner cookie (owner link) may share too", async () => {
    const v = await video();
    const claim = await get(v.ownerUrl);
    const cookie = OWNER_COOKIE.exec(claim.setCookie)![1];
    expect((await share(v.path, { cookie })).status).toBe(200);
    expect(await sharedAt(v.id)).not.toBeNull();
  });

  it("signed-out and another account: 404, still private", async () => {
    const v = await video();
    const other = await seedAccount();
    const callers: [string, string | null][] = [
      ["signed out", null],
      ["viewer", other.accountId],
    ];
    for (const [who, acct] of callers) {
      session.account = acct;
      const r = await share(v.path);
      expect(r.status, who).toBe(404);
      expect(await r.json(), who).toEqual({ error: "not found" });
    }
    expect(await sharedAt(v.id)).toBeNull();
  });

  it("the owner cross-origin (or without Origin): 403, still private", async () => {
    const v = await video();
    session.account = v.accountId;
    expect((await share(v.path, { origin: "https://evil.example" })).status).toBe(403);
    expect((await share(v.path, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call(v.path + "/share", { method: "POST", headers: { "user-agent": UA } })).status).toBe(403);
    expect(await sharedAt(v.id)).toBeNull();
  });

  it("wrong username: 404", async () => {
    const v = await video();
    session.account = v.accountId;
    const slug = v.path.split("/v/")[1];
    expect((await share(`/nobody-here/v/${slug}`)).status).toBe(404);
    expect(await sharedAt(v.id)).toBeNull();
  });
});

describe("owner stats row", () => {
  it("the owner sees views, unique viewers and average completion; viewers and signed-out users get none of it", async () => {
    const v = await video({ shared: true });
    await env.DB.prepare("UPDATE recordings SET views = 3, unique_views = 2 WHERE id = ?").bind(v.id).run();
    const rows: [string, number][] = [
      ["aaaaaaaaaaaa", 50],
      ["bbbbbbbbbbbb", 100],
      ["cccccccccccc", 75],
    ];
    for (const [vid, pct] of rows) {
      await env.DB.prepare("INSERT INTO video_views (id, recording_id, viewer_hash, created_at, max_pct) VALUES (?, ?, ?, ?, ?)")
        .bind(vid, v.id, vid, now(), pct)
        .run();
    }
    session.account = v.accountId;
    const owner = await get(v.path);
    expect(owner.html).toContain(
      '<ul class="vstats" id="vstats" aria-label="View stats"><li>3 views</li><li>2 unique viewers</li><li>75% average completion</li></ul>',
    );
    // Owner page views stay uncounted.
    expect(owner.html).not.toContain("data-vt=");

    const other = await seedAccount();
    for (const who of [null, other.accountId]) {
      session.account = who;
      const { res, html } = await get(v.path);
      expect(res.status).toBe(200);
      expect(html).not.toMatch(/vstats|unique viewer|average completion|3 views/);
    }
  });

  it("no counted views: views and unique viewers only, no completion", async () => {
    const v = await video();
    session.account = v.accountId;
    const { html } = await get(v.path);
    expect(html).toContain('<ul class="vstats" id="vstats" aria-label="View stats"><li>0 views</li><li>0 unique viewers</li></ul>');
  });
});

describe("transcript-fallback description", () => {
  const transcript = { segments: [{ start: 0, end: 2, text: "Hello from the transcript" }] };

  it("is muted (desc ed fb) for the owner only; a saved description is not", async () => {
    const v = await video({ shared: true, transcript });
    session.account = v.accountId;
    expect((await get(v.path)).html).toContain('<p class="desc ed fb" id="desc"');
    session.account = null;
    const viewer = await get(v.path);
    expect(viewer.html).toContain('<p class="desc">Hello from the transcript</p>');
    expect(viewer.html).not.toMatch(/class="desc[^"]* fb/);

    await env.DB.prepare("UPDATE recordings SET description = 'Saved' WHERE id = ?").bind(v.id).run();
    session.account = v.accountId;
    const html = (await get(v.path)).html;
    expect(html).toContain('<p class="desc ed" id="desc"');
    expect(html).not.toContain("desc ed fb");
  });
});
