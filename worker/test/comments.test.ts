import { env } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as commentsModule from "../src/comments";
import { listComments } from "../src/comments";
import type { Env } from "../src/env";
import { cleanup } from "../src/index";
import * as sessionModule from "../src/oauth/web-session";
import { now, randomId } from "../src/util";
import { call, freshIp, mcp, ORIGIN, seedAccount, seedReady, withEnv } from "./helpers";

// Tests say who is signed in on the website by mocking oauth/web-session getWebSession.
const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);

// Turnstile siteverify, answered like Cloudflare does for its test secrets: 1x... passes (any token), 2x... fails.
// "bad-token" stands in for a token Cloudflare rejects. (The request itself is built by verifyTurnstile; only the
// network hop is replaced.)
const PASS_SECRET = "1x0000000000000000000000000000000AA";
const verified: { secret: string; token: string }[] = [];
const verifySpy = vi.spyOn(commentsModule.siteverify, "post").mockImplementation(async (form) => {
  const secret = String(form.get("secret"));
  const token = String(form.get("response"));
  verified.push({ secret, token });
  const success = secret === PASS_SECRET && token !== "bad-token";
  return Response.json({ success, "error-codes": success ? [] : ["invalid-input-response"] });
});
afterAll(() => verifySpy.mockRestore());
beforeEach(() => {
  session.account = null;
  verified.length = 0;
});

const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

async function sharedVideo(e: Env = env) {
  const a = await seedAccount();
  const id = await seedReady(a.accountId);
  const r = await mcp("share", { recording_id: id }, a.key, e);
  expect(r.isError).toBe(false);
  const path = r.data.share_url.slice(ORIGIN.length) as string;
  return { ...a, id, path, username: path.split("/")[1] };
}

/** Opens the watch page like a browser; returns the comment key the page carries. */
async function open(path: string, opts: { cookie?: string; e?: Env } = {}) {
  const res = await call(path, { headers: opts.cookie ? { cookie: opts.cookie } : {} }, opts.e);
  const html = await res.text();
  return { res, html, ck: /data-ck="([^"]+)"/.exec(html)?.[1] ?? "" };
}

type PostOpts = { ck?: string; cookie?: string; ip?: string; origin?: string | null; e?: Env };
async function post(path: string, body: Record<string, unknown>, o: PostOpts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": o.ip ?? freshIp() };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.ck) headers["x-comment-key"] = o.ck;
  if (o.cookie) headers.cookie = o.cookie;
  const res = await call(`${path}/comments`, { method: "POST", headers, body: JSON.stringify(body) }, o.e);
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML (the generic 404 page)
  }
  return { status: res.status, data, text, cookie: /(rc=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] };
}

async function del(path: string, commentId: string, o: PostOpts = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? freshIp() };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.ck) headers["x-comment-key"] = o.ck;
  if (o.cookie) headers.cookie = o.cookie;
  const res = await call(`${path}/comments/${commentId}`, { method: "DELETE", headers }, o.e);
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

const rowsFor = async (videoId: string) =>
  (await env.DB.prepare("SELECT * FROM comments WHERE video_id = ?").bind(videoId).all<Record<string, unknown>>()).results;

/** The generic 404 page body (private, revoked, nonexistent all look the same). */
const generic404 = async () => (await call("/nobody/v/NoSuchSlug0000")).text();

describe("visibility: comments exist only while the video is shared", () => {
  it("a private (never shared) video: page, comment list and POST all give the page's generic 404", async () => {
    const a = await seedAccount();
    const id = await seedReady(a.accountId);
    const priv = (await mcp("get_video", { recording_id: id }, a.key)).data;
    const path = new URL(priv.share_url).pathname;
    const page = await call(path);
    expect(page.status).toBe(404);
    const g = await generic404();
    const list = await call(`${path}/comments`);
    expect(list.status).toBe(404);
    expect(await list.text()).toBe(g);
    const p = await post(path, { name: "Ann", body: "hi", turnstile: TOKEN });
    expect(p.status).toBe(404);
    expect(p.text).toBe(g);
    // The signed-in owner sees the private page, but no comments section and no comment API.
    session.account = a.accountId;
    const own = await open(path);
    expect(own.res.status).toBe(200);
    expect(own.html).not.toContain('id="cm"');
    expect((await post(path, { body: "note to self" })).status).toBe(404);
  });

  it("revoked: old and new URL answer 404 and the comments are hard-deleted", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    expect((await post(v.path, { name: "Ann", body: "first", turnstile: TOKEN }, { ck })).status).toBe(201);
    expect(await rowsFor(v.id)).toHaveLength(1);
    const r = await mcp("revoke_share", { recording_id: v.id }, v.key);
    const newPath = r.data.share_url.slice(ORIGIN.length);
    expect(await rowsFor(v.id)).toHaveLength(0);
    const g = await generic404();
    for (const p of [v.path, newPath]) {
      const res = await call(`${p}/comments`, { headers: { "x-comment-key": ck } });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(g);
      const pp = await post(p, { name: "Ann", body: "second", turnstile: TOKEN }, { ck });
      expect(pp.status).toBe(404);
    }
    // Sharing again starts with no comments.
    const again = await mcp("share", { recording_id: v.id }, v.key);
    const html = (await open(again.data.share_url.slice(ORIGIN.length))).html;
    expect(html).toContain('<span class="cm-n" id="cm-n">0</span>');
  });

  it("an expired video: 404", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    await env.DB.prepare("UPDATE recordings SET expires_at = ? WHERE id = ?").bind(now() - 1, v.id).run();
    expect((await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck })).status).toBe(404);
    expect((await call(`${v.path}/comments`, { headers: { "x-comment-key": ck } })).status).toBe(404);
  });

  it("a viewer without the page's comment key (or with a forged one) gets the 404", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    expect((await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN })).status).toBe(404);
    const exp = Number(ck.split(".")[0]);
    expect((await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck: `${exp}.AAAA` })).status).toBe(404);
    expect((await call(`${v.path}/comments`)).status).toBe(404);
    const ok = await call(`${v.path}/comments`, { headers: { "x-comment-key": ck } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ comments: [] });
  });

  it("POST and DELETE are same-origin only", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    expect((await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck, origin: null })).status).toBe(403);
    expect((await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck, origin: "https://evil.example" })).status).toBe(403);
    const ok = await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck });
    expect(ok.status).toBe(201);
    expect((await del(v.path, ok.data.comment.id, { ck, cookie: ok.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(verified).toHaveLength(1);
  });
});

describe("Turnstile", () => {
  it("is required for viewers and verified server-side on every POST", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const none = await post(v.path, { name: "Ann", body: "hi" }, { ck });
    expect(none.status).toBe(403);
    expect(verified).toHaveLength(0);
    const bad = await post(v.path, { name: "Ann", body: "hi", turnstile: "bad-token" }, { ck });
    expect(bad.status).toBe(403);
    expect(bad.data.error).toMatch(/verify/);
    expect(verified).toEqual([{ secret: PASS_SECRET, token: "bad-token" }]);
    const good = await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck });
    expect(good.status).toBe(201);
    expect(verified.at(-1)).toEqual({ secret: PASS_SECRET, token: TOKEN });
    expect(await rowsFor(v.id)).toHaveLength(1);
  });

  it("an unreachable siteverify fails closed", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    verifySpy.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    expect((await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck })).status).toBe(403);
    expect(await rowsFor(v.id)).toHaveLength(0);
  });

  it("the always-fail test secret is refused", async () => {
    const e = withEnv({ TURNSTILE_SECRET_KEY: "2x0000000000000000000000000000000AA" });
    const v = await sharedVideo(e);
    const { ck } = await open(v.path, { e });
    expect((await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck, e })).status).toBe(403);
  });

  it("missing keys: viewer POST 503, form hidden, no Turnstile in the CSP; with keys the CSP allows only its script and frame", async () => {
    const v = await sharedVideo();
    const withKeys = await open(v.path);
    const csp = withKeys.res.headers.get("content-security-policy")!;
    expect(csp).toContain(`script-src ${ORIGIN}/s/ https://challenges.cloudflare.com;`);
    expect(csp).toContain("frame-src https://challenges.cloudflare.com;");
    // Turnstile's fetch('data:,') probe; the Cloudflare analytics beacon stays blocked.
    expect(csp).toContain("connect-src 'self' data:;");
    expect(csp).not.toContain("cloudflareinsights");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|nonce-/);
    expect(withKeys.html).toContain('class="cf-turnstile" data-sitekey="1x00000000000000000000AA"');
    expect(withKeys.html).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>');

    for (const missing of [{ TURNSTILE_SECRET_KEY: undefined }, { TURNSTILE_SITE_KEY: "" }] as Partial<Env>[]) {
      const e = withEnv(missing);
      const p = await open(v.path, { e });
      expect(p.res.status).toBe(200);
      expect(p.html).not.toContain('id="cm-form"');
      expect(p.html).toContain("Comments are closed right now.");
      expect(p.html).not.toContain("challenges.cloudflare.com");
      expect(p.res.headers.get("content-security-policy")).not.toContain("challenges.cloudflare.com");
      const r = await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck: p.ck, e });
      expect(r.status).toBe(503);
    }
    // No hashing secret: a required secret is missing, so the server answers nothing but what to fix (config.ts).
    const noSalt = await post(v.path, { name: "Ann", body: "hi", turnstile: TOKEN }, { ck: withKeys.ck, e: withEnv({ IP_HASH_KEY: "" }) });
    expect(noSalt.status).toBe(500);
    expect(verified).toHaveLength(0);
  });

  it("the owner needs no Turnstile and no name; shows their Recitbot name with an Owner badge", async () => {
    const v = await sharedVideo();
    await env.DB.prepare("UPDATE accounts SET display_name = 'Dana Owner' WHERE id = ?").bind(v.accountId).run();
    session.account = v.accountId;
    const page = await open(v.path);
    expect(page.html).toContain('<p class="cm-as">Commenting as <span class="c-a">Dana Owner</span><span class="badge">Owner</span></p>');
    expect(page.html).not.toContain('id="cm-name"');
    expect(page.html).not.toContain("cf-turnstile");
    expect(page.res.headers.get("content-security-policy")).not.toContain("challenges.cloudflare.com");
    // Owner posts work even with the Turnstile keys missing.
    const e = withEnv({ TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined });
    const r = await post(v.path, { name: "Ignored", body: "Thanks for watching", t: 12.34 }, { e });
    expect(r.status).toBe(201);
    expect(r.data.comment).toMatchObject({ author: "Dana Owner", is_owner: true, body: "Thanks for watching", t_seconds: 12.3, can_delete: true });
    expect(verified).toHaveLength(0);
    const [row] = await rowsFor(v.id);
    expect(row).toMatchObject({ author_kind: "owner", viewer_token_hash: null, ip_hash: null });

    session.account = null;
    const viewer = await open(v.path);
    expect(viewer.html).toContain('<span class="c-a">Dana Owner</span><span class="badge">Owner</span>');
    expect(viewer.html).toContain('<button type="button" class="c-t" data-t="12.3" aria-label="Play from 0:12">0:12</button>');
  });
});

describe("input", () => {
  it("rejects a viewer name equal to the owner's username or name (any case/width), and bad lengths", async () => {
    const v = await sharedVideo();
    await env.DB.prepare("UPDATE accounts SET display_name = 'Dana Owner' WHERE id = ?").bind(v.accountId).run();
    const { ck } = await open(v.path);
    const fullwidth = [...v.username].map((c) => (/[a-z]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");
    for (const name of [v.username, v.username.toUpperCase(), ` ${v.username}​ `, fullwidth, "dana owner", "DANA\tOWNER"]) {
      const r = await post(v.path, { name, body: "hi", turnstile: TOKEN }, { ck });
      expect(r.status, name).toBe(400);
      expect(r.data.error).toMatch(/owner/);
    }
    expect((await post(v.path, { name: "x".repeat(41), body: "hi", turnstile: TOKEN }, { ck })).status).toBe(400);
    expect((await post(v.path, { name: " \u0007 ", body: "hi", turnstile: TOKEN }, { ck })).status).toBe(400);
    expect((await post(v.path, { name: "Ann", body: "y".repeat(501), turnstile: TOKEN }, { ck })).status).toBe(400);
    expect((await post(v.path, { name: "Ann", body: "   ", turnstile: TOKEN }, { ck })).status).toBe(400);
    expect((await post(v.path, { name: "Ann", body: "hi", t: -1, turnstile: TOKEN }, { ck })).status).toBe(400);
    expect(verified).toHaveLength(0);
    const ok = await post(v.path, { name: "  An\u0000n‮  ", body: "a\r\nb\u0007\n\n\n\nc", turnstile: TOKEN }, { ck });
    expect(ok.status).toBe(201);
    expect(ok.data.comment).toMatchObject({ author: "Ann", body: "a\nb\n\nc", t_seconds: null, is_owner: false });
  });

  it("escapes <script> and markup in names and bodies; URLs are not linkified", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const body = '<script>alert(1)</script> see https://evil.example/x "q" \'s\' &amp;';
    const r = await post(v.path, { name: "<img src=x onerror=alert(1)>", body, turnstile: TOKEN }, { ck });
    expect(r.status).toBe(201);
    expect(r.data.comment.body).toBe(body); // stored as plain text; the page escapes it
    const { html } = await open(v.path);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html.replace(/<a class="wm"[^]*?<\/a>/, "")).not.toMatch(/<a\b/); // the Free watermark is the only link
    expect(html).toContain(
      '<p class="c-b">&lt;script&gt;alert(1)&lt;/script&gt; see https://evil.example/x &quot;q&quot; &#39;s&#39; &amp;amp;</p>',
    );
    expect(html).toContain('<span class="c-a">&lt;img src=x onerror=alert(1)&gt;</span>');
  });
});

describe("rate limits", () => {
  it("3 per 10 minutes per viewer cookie, even from different IPs", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const first = await post(v.path, { name: "Ann", body: "c1", turnstile: TOKEN }, { ck });
    expect(first.status).toBe(201);
    const cookie = first.cookie!;
    expect(cookie).toMatch(/^rc=[A-Za-z0-9]{20,30}$/);
    for (const body of ["c2", "c3"]) expect((await post(v.path, { name: "Ann", body, turnstile: TOKEN }, { ck, cookie })).status).toBe(201);
    const fourth = await post(v.path, { name: "Ann", body: "c4", turnstile: TOKEN }, { ck, cookie });
    expect(fourth.status).toBe(429);
    expect(fourth.data.error).toMatch(/Wait a few minutes/);
    expect(verified).toHaveLength(3); // the limit is checked before siteverify
    // ...and it counts across videos.
    const w = await sharedVideo();
    const w2 = await open(w.path);
    expect((await post(w.path, { name: "Ann", body: "c5", turnstile: TOKEN }, { ck: w2.ck, cookie })).status).toBe(429);
    // Ten minutes on, it's allowed again.
    await env.DB.prepare("UPDATE comments SET created_at = created_at - 601 WHERE video_id = ?").bind(v.id).run();
    expect((await post(v.path, { name: "Ann", body: "c6", turnstile: TOKEN }, { ck, cookie })).status).toBe(201);
  });

  it("3 per 10 minutes per IP, whatever the cookie", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const ip = freshIp();
    for (const body of ["a", "b", "c"]) expect((await post(v.path, { name: "Bo", body, turnstile: TOKEN }, { ck, ip })).status).toBe(201);
    expect((await post(v.path, { name: "Bo", body: "d", turnstile: TOKEN }, { ck, ip })).status).toBe(429);
    expect((await post(v.path, { name: "Bo", body: "d", turnstile: TOKEN }, { ck })).status).toBe(201);
  });

  it("deleting doesn't refund the limit", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const ip = freshIp();
    const first = await post(v.path, { name: "Cy", body: "x1", turnstile: TOKEN }, { ck, ip });
    const cookie = first.cookie!;
    expect((await del(v.path, first.data.comment.id, { ck, cookie })).status).toBe(200);
    for (const body of ["x2", "x3"]) expect((await post(v.path, { name: "Cy", body, turnstile: TOKEN }, { ck, cookie })).status).toBe(201);
    expect((await post(v.path, { name: "Cy", body: "x4", turnstile: TOKEN }, { ck, cookie })).status).toBe(429);
  });

  it("100 per video per day and 500 per video per 30 days", async () => {
    const seed = async (videoId: string, n: number, at: number) => {
      const stmts = Array.from({ length: n }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO comments (id, video_id, author_kind, display_name, body, created_at, viewer_token_hash, ip_hash) VALUES (?, ?, 'viewer', 'x', ?, ?, ?, ?)",
        ).bind(randomId(96), videoId, `seed ${i}`, at, randomId(64), randomId(64)),
      );
      await env.DB.batch(stmts);
    };
    const v = await sharedVideo();
    await seed(v.id, 100, now() - 60);
    const { ck } = await open(v.path);
    const day = await post(v.path, { name: "Di", body: "one more", turnstile: TOKEN }, { ck });
    expect(day.status).toBe(429);
    expect(day.data.error).toMatch(/today/);
    session.account = v.accountId; // the cap is per video: the owner is held to it too
    expect((await post(v.path, { body: "owner too" })).status).toBe(429);
    session.account = null;

    const w = await sharedVideo();
    await seed(w.id, 500, now() - 5 * 86400);
    const p = await open(w.path);
    const month = await post(w.path, { name: "Di", body: "one more", turnstile: TOKEN }, { ck: p.ck });
    expect(month.status).toBe(429);
    expect(month.data.error).toMatch(/limit/);
    await env.DB.prepare("UPDATE comments SET created_at = ? WHERE video_id = ?").bind(now() - 31 * 86400, w.id).run();
    expect((await post(w.path, { name: "Di", body: "one more", turnstile: TOKEN }, { ck: p.ck })).status).toBe(201);
    expect(verified).toHaveLength(1);
  });

  it("the same viewer can't post the exact same body on the same video within 24 h", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const first = await post(v.path, { name: "Ed", body: "Great video!", turnstile: TOKEN }, { ck });
    const cookie = first.cookie!;
    const dup = await post(v.path, { name: "Ed", body: "  Great video!  ", turnstile: TOKEN }, { ck, cookie });
    expect(dup.status).toBe(409);
    expect(dup.data.error).toMatch(/already posted/);
    // Same IP without the cookie is the same viewer too.
    const ip = freshIp();
    const w = await sharedVideo();
    const w2 = await open(w.path);
    expect((await post(w.path, { name: "Ed", body: "dup", turnstile: TOKEN }, { ck: w2.ck, ip })).status).toBe(201);
    expect((await post(w.path, { name: "Ed", body: "dup", turnstile: TOKEN }, { ck: w2.ck, ip })).status).toBe(409);
    // A different body, a different viewer, or a day later: fine.
    expect((await post(v.path, { name: "Ed", body: "Great video!!", turnstile: TOKEN }, { ck, cookie })).status).toBe(201);
    expect((await post(v.path, { name: "Fay", body: "Great video!", turnstile: TOKEN }, { ck })).status).toBe(201);
    await env.DB.prepare("UPDATE comments SET created_at = created_at - 86401 WHERE video_id = ?").bind(v.id).run();
    expect((await post(v.path, { name: "Ed", body: "Great video!", turnstile: TOKEN }, { ck, cookie })).status).toBe(201);
  });
});

describe("delete", () => {
  it("the owner deletes any comment; it disappears from the page and the API", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const c = await post(v.path, { name: "Gil", body: "spam spam", turnstile: TOKEN }, { ck });
    expect(c.data.comment.can_delete).toBe(true);
    session.account = v.accountId;
    const ownerPage = await open(v.path);
    expect(ownerPage.html).toContain(`<li class="c" data-id="${c.data.comment.id}">`);
    expect(ownerPage.html).toContain('aria-label="Delete comment by Gil">Delete</button>');
    // a day later still deletable by the owner
    await env.DB.prepare("UPDATE comments SET created_at = created_at - 86400 WHERE video_id = ?").bind(v.id).run();
    expect((await del(v.path, c.data.comment.id)).status).toBe(200);
    expect((await del(v.path, c.data.comment.id)).status).toBe(404);
    session.account = null;
    const after = await open(v.path);
    expect(after.html).not.toContain("spam spam");
    expect(after.html).toContain('<span class="cm-n" id="cm-n">0</span>');
    const list = (await (await call(`${v.path}/comments`, { headers: { "x-comment-key": ck } })).json()) as any;
    expect(list.comments).toEqual([]);
    const [row] = await rowsFor(v.id);
    expect(row).toMatchObject({ body: "" });
    expect(row.deleted_at).toBeTypeOf("number");
  });

  it("a viewer deletes their own comment within 10 minutes, nobody else's", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const mine = await post(v.path, { name: "Hal", body: "oops", turnstile: TOKEN }, { ck });
    const cookie = mine.cookie!;
    expect(mine.data.comment.delete_until).toBe(mine.data.comment.created_at + 600);
    const other = await post(v.path, { name: "Ivy", body: "keep me", turnstile: TOKEN }, { ck });
    // The page shows a delete button on their own comment only.
    const page = await open(v.path, { cookie });
    expect(page.html).toContain('aria-label="Delete comment by Hal"');
    expect(page.html).not.toContain('aria-label="Delete comment by Ivy"');
    expect((await del(v.path, other.data.comment.id, { ck, cookie })).status).toBe(403);
    expect((await del(v.path, mine.data.comment.id, { ck })).status).toBe(403); // no cookie
    expect((await del(v.path, mine.data.comment.id, { cookie })).status).toBe(404); // no comment key
    expect((await del(v.path, mine.data.comment.id, { ck, cookie })).status).toBe(200);

    const late = await post(v.path, { name: "Hal", body: "too late", turnstile: TOKEN }, { ck, cookie });
    await env.DB.prepare("UPDATE comments SET created_at = created_at - 601 WHERE id = ?").bind(late.data.comment.id).run();
    const r = await del(v.path, late.data.comment.id, { ck, cookie });
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/10 minutes/);
    expect((await open(v.path, { cookie })).html).not.toContain('aria-label="Delete comment by Hal"');
  });
});

describe("cleanup", () => {
  it("deleting the video deletes its comments", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    await post(v.path, { name: "Jo", body: "bye", turnstile: TOKEN }, { ck });
    expect(await rowsFor(v.id)).toHaveLength(1);
    expect((await mcp("delete", { recording_id: v.id }, v.key)).isError).toBe(false);
    expect(await rowsFor(v.id)).toHaveLength(0);
  });

  it("the 24 h free-tier cleanup deletes the expired video's comments", async () => {
    const a = await seedAccount();
    const id = await seedReady(a.accountId, { createdAt: now() - 25 * 3600 });
    await env.DB.prepare(
      "INSERT INTO comments (id, video_id, author_kind, display_name, body, created_at) VALUES (?, ?, 'viewer', 'Kim', 'old', ?)",
    )
      .bind(randomId(96), id, now() - 24 * 3600)
      .run();
    await cleanup(env);
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(id).first()).toBeNull();
    expect(await rowsFor(id)).toHaveLength(0);
  });
});

describe("listComments (MCP list_comments)", () => {
  it("newest first for the owner, null for anyone else, since filters", async () => {
    const v = await sharedVideo();
    const { ck } = await open(v.path);
    const a = await post(v.path, { name: "Lu", body: "first", t: 5, turnstile: TOKEN }, { ck });
    await env.DB.prepare("UPDATE comments SET created_at = created_at - 100 WHERE id = ?").bind(a.data.comment.id).run();
    session.account = v.accountId;
    const b = await post(v.path, { body: "second" });
    session.account = null;
    const rows = await listComments(env, v.accountId, v.id);
    expect(rows).toEqual([
      { id: b.data.comment.id, author: v.username, is_owner: true, body: "second", t_seconds: null, created_at: b.data.comment.created_at },
      { id: a.data.comment.id, author: "Lu", is_owner: false, body: "first", t_seconds: 5, created_at: a.data.comment.created_at - 100 },
    ]);
    expect(await listComments(env, v.accountId, v.id, { since: now() - 50 })).toHaveLength(1);
    const stranger = await seedAccount(false);
    expect(await listComments(env, stranger.accountId, v.id)).toBeNull();
    expect(await listComments(env, v.accountId, "NoSuchVideo00000000000")).toBeNull();
  });
});

describe("page", () => {
  it("renders the section server-side below the player and transcript, with labels and a counter", async () => {
    const v = await sharedVideo();
    const { html, res } = await open(v.path);
    expect(res.status).toBe(200);
    expect(html.indexOf('<section class="cm"')).toBeGreaterThan(html.indexOf('<section class="tx"'));
    expect(html).toContain('<h2 id="cmh">Comments <span class="cm-n" id="cm-n">0</span></h2>');
    expect(html).toContain('<label for="cm-name">Your name</label><input id="cm-name" name="name" type="text" maxlength="40"');
    expect(html).toContain('<label for="cm-body" class="sr">Comment</label><textarea id="cm-body" name="body" maxlength="500"');
    expect(html).toContain('<span id="cm-count" class="n">0/500</span>');
    expect(html).toMatch(/<script src="\/s\/comments\.js\?v=\w+" defer><\/script>/);
    expect(html).toContain('<p class="muted cm-empty" id="cm-empty">No comments yet.</p>');
  });
});
