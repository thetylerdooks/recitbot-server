// owner_url (owner-link.ts): the video's URL + ?ot=<24 h token>. Opening it sets a per-recording owner cookie (not a web
// sign-in) and 303s to the clean URL; owner rights on the page come only from isOwner (web session for the account, or
// that cookie for that recording at its owner_version). revoke_share bumps owner_version. Also: every write route
// refuses non-owners, and the MCP delete_comment tool.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionModule from "../src/oauth/web-session";
import { ownerUrl } from "../src/owner-link";
import { now } from "../src/util";
import { call, mcp, ORIGIN, seedAccount, seedReady } from "./helpers";

// Who is signed in on the website (/signin): mocked like the other page tests. Owner cookies are real.
const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const COOKIE = /(__Host-rb_owner=[^;]+)/;

async function video(opts: { shared?: boolean } = {}) {
  const a = await seedAccount();
  const id = await seedReady(a.accountId);
  if (opts.shared) expect((await mcp("share", { recording_id: id }, a.key)).isError).toBe(false);
  const g = await mcp("get_video", { recording_id: id }, a.key);
  expect(g.isError).toBe(false);
  return { ...a, id, url: g.data.url as string, path: (g.data.url as string).slice(ORIGIN.length), ownerUrl: g.data.owner_url as string };
}

/** Opens a URL like a browser (no redirects followed). */
async function get(pathOrUrl: string, headers: Record<string, string> = {}) {
  const res = await call(pathOrUrl.replace(ORIGIN, ""), { headers: { "user-agent": UA, ...headers } });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { res, html: await res.text(), cookie: COOKIE.exec(setCookie)?.[1] ?? null, setCookie };
}

/** Opens the owner link and returns the owner cookie it set (asserting the clean 303). */
async function claim(v: { ownerUrl: string; path: string }, cookie?: string): Promise<string> {
  const r = await get(v.ownerUrl, cookie ? { cookie } : {});
  expect(r.res.status).toBe(303);
  expect(r.res.headers.get("location")).toBe(v.path);
  expect(r.cookie).toBeTruthy();
  return r.cookie!;
}

const isOwnerPage = (html: string) => html.includes('id="meta"') && html.includes("Owner view: not counted");

function patch(path: string, cookie: string | null, headers: Record<string, string> = {}) {
  return call(`${path}/meta`, {
    method: "PATCH",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify({ title: "Edited" }),
  });
}

async function commentKey(path: string, cookie?: string): Promise<string> {
  return /data-ck="([^"]+)"/.exec((await get(path, cookie ? { cookie } : {})).html)?.[1] ?? "";
}

function postComment(path: string, body: Record<string, unknown>, o: { cookie?: string | null; ck?: string } = {}) {
  return call(`${path}/comments`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.ck ? { "x-comment-key": o.ck } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deleteComment(path: string, id: string, o: { cookie?: string | null; ck?: string; origin?: string } = {}) {
  return call(`${path}/comments/${id}`, {
    method: "DELETE",
    headers: { origin: o.origin ?? ORIGIN, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.ck ? { "x-comment-key": o.ck } : {}) },
  });
}

async function seedComment(videoId: string, author: "viewer" | "owner" = "viewer"): Promise<string> {
  const id = `c${Math.random().toString(36).slice(2).replace(/[^a-z0-9]/g, "")}AAAAAAAA`.slice(0, 16);
  await env.DB.prepare("INSERT INTO comments (id, video_id, author_kind, display_name, body, t_seconds, created_at) VALUES (?, ?, ?, 'Ann', 'hello', NULL, ?)")
    .bind(id, videoId, author, now())
    .run();
  return id;
}

const commentRow = (id: string) => env.DB.prepare("SELECT deleted_at, body FROM comments WHERE id = ?").bind(id).first<{ deleted_at: number | null; body: string }>();

describe("owner_url", () => {
  it("is the video's one URL + ?ot=<token> from every tool; url, share_url and the page never carry the token", async () => {
    const v = await video({ shared: true });
    expect(v.ownerUrl).toMatch(new RegExp(`^${v.url.replace(/[.?]/g, "\\$&")}\\?ot=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
    const token = new URL(v.ownerUrl).searchParams.get("ot")!;
    const share = await mcp("share", { recording_id: v.id }, v.key);
    expect(share.data).toMatchObject({ url: v.url, share_url: v.url });
    expect(share.data.owner_url).toMatch(/\?ot=/);
    for (const tool of ["list_videos", "list"]) {
      const r = await mcp(tool, { limit: 5 }, v.key);
      expect(r.data.recordings[0].owner_url.startsWith(`${v.url}?ot=`), tool).toBe(true);
    }
    const s = await mcp("search_videos", { query: "Demo" }, v.key);
    expect(s.data.recordings[0].owner_url.startsWith(`${v.url}?ot=`)).toBe(true);
    for (const r of [share.data, (await mcp("get_video", { recording_id: v.id }, v.key)).data]) {
      expect(r.url).not.toContain("ot=");
      expect(r.share_url).not.toContain("ot=");
      expect(r.display).not.toContain("ot=");
    }
    const cookie = await claim(v);
    const page = await get(v.path, { cookie });
    expect(page.html).not.toContain(token);
    expect(page.html).not.toContain("ot=");
  });

  it("valid token: owner cookie (not a web session) + 303 to the clean URL; that browser is the owner of that video", async () => {
    const v = await video({ shared: true });
    const r = await get(v.ownerUrl);
    expect(r.res.status).toBe(303);
    expect(r.res.headers.get("location")).toBe(v.path);
    expect(r.res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.html).toBe("");
    expect(r.setCookie).toMatch(/^__Host-rb_owner=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    expect(r.setCookie).not.toContain("rb_session");
    const sessions = await env.DB.prepare("SELECT count(*) AS n FROM web_sessions WHERE account_id = ?").bind(v.accountId).first<{ n: number }>();
    expect(sessions!.n).toBe(0);

    const page = await get(v.path, { cookie: r.cookie! });
    expect(page.res.status).toBe(200);
    expect(isOwnerPage(page.html)).toBe(true);
    expect(page.html).toContain("/s/meta.js");
    expect(page.html).not.toContain("data-vt="); // not counted
    expect(page.html).not.toContain('class="cf-turnstile"'); // owner comments skip Turnstile
    expect(page.html).toContain('data-owner="1"');
    expect((await patch(v.path, r.cookie)).status).toBe(200);
    expect((await env.DB.prepare("SELECT title FROM recordings WHERE id = ?").bind(v.id).first<{ title: string }>())!.title).toBe("Edited");

    // Without the cookie the same page is a viewer's.
    expect(isOwnerPage((await get(v.path)).html)).toBe(false);
  });

  it("works on a private video, and from the ready push's /v/<id>?ot= form", async () => {
    const v = await video();
    expect((await get(v.path)).res.status).toBe(404);
    const cookie = await claim(v);
    const page = await get(v.path, { cookie });
    expect(page.res.status).toBe(200);
    expect(isOwnerPage(page.html)).toBe(true);
    expect(page.html).toContain("Private: only you can see this video");
    expect((await call(`/m/${v.path.split("/").pop()}`, { headers: { cookie: `${cookie}; ${/(mt=[^;]+)/.exec(page.setCookie)![1]}` } })).status).toBe(200);

    const rec = { id: v.id, account_id: v.accountId, owner_version: 0 };
    const pushed = await get(await ownerUrl(env, `${ORIGIN}/v/${v.id}`, rec));
    expect(pushed.res.status).toBe(303);
    expect(pushed.res.headers.get("location")).toBe(v.path);
    expect(isOwnerPage((await get(v.path, { cookie: pushed.cookie! })).html)).toBe(true);
  });

  it("expired, tampered, wrong-purpose, other-video and other-account tokens: 303 to the clean URL, no cookie", async () => {
    const v = await video({ shared: true });
    const other = await video({ shared: true });
    const sameAcct = await seedReady(v.accountId);
    const rec = { id: v.id, account_id: v.accountId, owner_version: 0 };
    const token = (u: string) => new URL(u).searchParams.get("ot")!;
    const t = token(v.ownerUrl);
    const flipped = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    const cookieValue = (await claim(v)).split("=")[1];
    const bad: Record<string, string> = {
      expired: token(await ownerUrl(env, v.url, rec, now() - 24 * 3600 - 5)),
      tampered: flipped,
      "payload swapped": `${token(other.ownerUrl).split(".")[0]}.${t.split(".")[1]}`,
      "owner cookie as token": cookieValue,
      "other video": token(other.ownerUrl),
      "same account, other video": token(await ownerUrl(env, v.url, { ...rec, id: sameAcct })),
      "other account": token(await ownerUrl(env, v.url, { ...rec, account_id: other.accountId })),
      "old owner_version": token(await ownerUrl(env, v.url, { ...rec, owner_version: 5 })),
      garbage: "not-a-token",
      empty: "",
    };
    for (const [why, ot] of Object.entries(bad)) {
      const r = await get(`${v.path}?ot=${ot}`);
      expect(r.res.status, why).toBe(303);
      expect(r.res.headers.get("location"), why).toBe(v.path);
      expect(r.setCookie, why).toBe("");
      expect(r.html, why).toBe("");
    }
    // Other query parameters survive the clean redirect.
    expect((await get(`${v.path}?x=1&ot=${flipped}`)).res.headers.get("location")).toBe(`${v.path}?x=1`);
  });

  it("link-preview bots get the redirect but never the cookie", async () => {
    const v = await video({ shared: true });
    for (const ua of ["Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "Discordbot/2.0", "WhatsApp/2.23"]) {
      const r = await get(v.ownerUrl, { "user-agent": ua });
      expect(r.res.status, ua).toBe(303);
      expect(r.setCookie, ua).toBe("");
    }
  });

  it("the cookie covers only its own recording; the web session covers all of the account's", async () => {
    const v = await video({ shared: true });
    const g = await mcp("share", { recording_id: await seedReady(v.accountId) }, v.key);
    const second = g.data.url.slice(ORIGIN.length);
    const cookie = await claim(v);
    expect(isOwnerPage((await get(second, { cookie })).html)).toBe(false);
    expect((await patch(second, cookie)).status).toBe(404);
    session.account = v.accountId;
    expect(isOwnerPage((await get(second)).html)).toBe(true);
    expect(isOwnerPage((await get(v.path)).html)).toBe(true);
  });

  it("one cookie holds at most 20 videos, newest kept", async () => {
    const a = await seedAccount();
    let cookie = "";
    const paths: string[] = [];
    for (let i = 0; i < 21; i++) {
      const id = await seedReady(a.accountId);
      const g = await mcp("get_video", { recording_id: id }, a.key);
      paths.push(g.data.url.slice(ORIGIN.length));
      cookie = await claim({ ownerUrl: g.data.owner_url, path: paths[i] }, cookie || undefined);
    }
    expect(cookie.length).toBeLessThan(3500);
    expect((await get(paths[0], { cookie })).res.status).toBe(404); // the oldest dropped off (private: 404)
    for (const p of [paths[1], paths[20]]) expect(isOwnerPage((await get(p, { cookie })).html), p).toBe(true);
  });

  it("revoke_share and share rotate=true bump owner_version: old owner links and owner cookies stop working at once", async () => {
    const v = await video({ shared: true });
    const cookie = await claim(v);
    const r = await mcp("revoke_share", { recording_id: v.id }, v.key);
    expect(r.isError).toBe(false);
    const fresh = r.data.share_url.slice(ORIGIN.length);
    expect((await env.DB.prepare("SELECT owner_version FROM recordings WHERE id = ?").bind(v.id).first<{ owner_version: number }>())!.owner_version).toBe(1);
    // The old cookie no longer opens the (now private) video or edits it.
    expect((await get(fresh, { cookie })).res.status).toBe(404);
    expect((await patch(fresh, cookie)).status).toBe(404);
    // The old token, even on the /v/<id> path that survives the new slug, sets nothing.
    const oldToken = new URL(v.ownerUrl).searchParams.get("ot");
    expect((await get(`/v/${v.id}?ot=${oldToken}`)).setCookie).toBe("");
    // The owner_url revoke_share returns works.
    const again = await claim({ ownerUrl: r.data.owner_url, path: fresh });
    expect(isOwnerPage((await get(fresh, { cookie: again })).html)).toBe(true);

    const rot = await mcp("share", { recording_id: v.id, rotate: true }, v.key);
    expect(rot.isError).toBe(false);
    const rotated = rot.data.url.slice(ORIGIN.length);
    expect(isOwnerPage((await get(rotated, { cookie: again })).html)).toBe(false);
    expect(isOwnerPage((await get(rotated, { cookie: await claim({ ownerUrl: rot.data.owner_url, path: rotated }) })).html)).toBe(true);
  });
});

describe("owner rights on the page come only from isOwner", () => {
  it("signed-out and a viewer with the public url are refused on every write route", async () => {
    const v = await video({ shared: true });
    const ck = await commentKey(v.path);
    const commentId = await seedComment(v.id);
    const callers: [string, { cookie: string | null; ck?: string }][] = [
      ["signed out", { cookie: null }],
      ["viewer with the public url", { cookie: null, ck }],
    ];
    for (const [who, o] of callers) {
      // meta PATCH: the route's existing generic 404.
      const m = await patch(v.path, o.cookie);
      expect(m.status, who).toBe(404);
      expect(await m.json(), who).toEqual({ error: "not found" });
      // DELETE someone's comment: without the page's comment key the generic 404 page, with it 403.
      expect((await deleteComment(v.path, commentId, o)).status, who).toBe(o.ck ? 403 : 404);
      // An owner comment (no name, no Turnstile): without the key 404, with it 400/403 (a viewer must name themselves
      // and pass Turnstile); never stored as the owner's.
      const p = await postComment(v.path, { body: "as the owner?" }, o);
      expect([400, 403, 404], who).toContain(p.status);
    }
    expect((await commentRow(commentId))!.deleted_at).toBeNull();
    expect((await env.DB.prepare("SELECT title FROM recordings WHERE id = ?").bind(v.id).first<{ title: string }>())!.title).toBe("Demo");
    const owners = await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE video_id = ? AND author_kind = 'owner'").bind(v.id).first<{ n: number }>();
    expect(owners!.n).toBe(0);
  });

  it("the owner (owner cookie) edits, posts owner comments without Turnstile and deletes any comment; cross-origin is refused", async () => {
    const v = await video({ shared: true });
    const cookie = await claim(v);
    const commentId = await seedComment(v.id);

    expect((await patch(v.path, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await deleteComment(v.path, commentId, { cookie, origin: "https://evil.example" })).status).toBe(403);

    // The response shape comments.js consumes: 201 JSON {comment: {id, author, is_owner, body, t_seconds, created_at,
    // can_delete, delete_until}}.
    const p = await postComment(v.path, { body: "Thanks all", t: 3 }, { cookie });
    expect(p.status).toBe(201);
    expect(p.headers.get("content-type")).toBe("application/json");
    const { comment } = (await p.json()) as any;
    expect(comment).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9]+$/),
      author: expect.any(String),
      is_owner: true,
      body: "Thanks all",
      t_seconds: 3,
      created_at: expect.any(Number),
      can_delete: true,
      delete_until: null,
    });

    const d = await deleteComment(v.path, commentId, { cookie });
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ deleted: true });
    expect(await commentRow(commentId)).toMatchObject({ body: "" });
    expect((await commentRow(commentId))!.deleted_at).toBeGreaterThan(0);
    expect((await deleteComment(v.path, commentId, { cookie })).status).toBe(404); // already gone
  });

  it("a signed-in owner (web session) deletes from the page too", async () => {
    const v = await video({ shared: true });
    const commentId = await seedComment(v.id);
    session.account = v.accountId;
    expect(isOwnerPage((await get(v.path)).html)).toBe(true);
    expect((await deleteComment(v.path, commentId)).status).toBe(200);
    expect((await commentRow(commentId))!.deleted_at).toBeGreaterThan(0);
  });
});

describe("MCP delete_comment", () => {
  it("the owning account deletes; other accounts, no auth and unknown ids are refused", async () => {
    const v = await video({ shared: true });
    const commentId = await seedComment(v.id);
    const listed = await mcp("list_comments", { video_id: v.id }, v.key);
    expect(listed.data.comments.map((c: any) => c.id)).toEqual([commentId]);

    const stranger = await seedAccount();
    const theirs = await mcp("delete_comment", { recording_id: v.id, comment_id: commentId }, stranger.key);
    expect(theirs.isError).toBe(true);
    expect(theirs.data.error).toBe("NOT_FOUND");
    const anon = await mcp("delete_comment", { recording_id: v.id, comment_id: commentId });
    expect(anon.isError).toBe(true);
    expect((await commentRow(commentId))!.deleted_at).toBeNull();

    const ok = await mcp("delete_comment", { recording_id: v.id, comment_id: commentId }, v.key);
    expect(ok.isError).toBe(false);
    expect(ok.data).toEqual({ recording_id: v.id, comment_id: commentId, deleted: true });
    expect((await commentRow(commentId))!.deleted_at).toBeGreaterThan(0);
    expect((await mcp("list_comments", { video_id: v.id }, v.key)).data.comments).toEqual([]);

    const again = await mcp("delete_comment", { recording_id: v.id, comment_id: commentId }, v.key);
    expect(again.isError).toBe(true);
    expect(again.data.error).toBe("NOT_FOUND");
    // A comment of another of the user's videos can't be deleted through this one.
    const otherVideo = await video({ shared: true });
    const elsewhere = await seedComment(otherVideo.id);
    expect((await mcp("delete_comment", { recording_id: v.id, comment_id: elsewhere }, v.key)).isError).toBe(true);
    expect((await commentRow(elsewhere))!.deleted_at).toBeNull();
  });
});
