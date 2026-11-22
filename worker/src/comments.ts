// Comments on shared videos: anyone with the shared link (under a display name, behind Turnstile) and the owner
// (owner-link.ts isOwner: web session or this video's owner cookie; no Turnstile, shown under their Recitbot name with an Owner badge). They exist only while the video is shared:
// share.ts answers private / revoked / expired videos with the page's generic 404 before anything here runs, and
// revoke_share and video deletion hard-delete the rows.
//
// Viewers carry no account, so "a viewer" is HMAC(IP_HASH_KEY) of an HttpOnly random cookie token and of the IP; only
// those hashes are stored. Comment API calls from viewers also need the page's comment key (data-ck, signed, bound to the
// video and share version, 6 h), so a passcode-protected video's comments stay behind its passcode.
import { getConfig } from "./config";
import type { Env } from "./env";
import { LIMITS, serviceMode } from "./env";
import { accountByline } from "./username";
import { clientIp, cookie, esc, hmacB64, hmacHex, json, log, now, randomId, safeEqual } from "./util";

/** One comment as list_comments (MCP) sees it. Newest first. */
export type CommentRow = { id: string; author: string; is_owner: boolean; body: string; t_seconds: number | null; created_at: number };

/** The video a comment request is about, already checked shared + visible + right username by share.ts. */
export type CommentVideo = {
  id: string;
  accountId: string;
  /** The request comes from the video's owner (share.ts visibleVideo, owner-link.ts isOwner). */
  owner: boolean;
  /** shares.version: the comment key dies with it. */
  version: number;
  by: { username: string; shown: string };
};

type DbRow = {
  id: string;
  author_kind: "viewer" | "owner";
  display_name: string;
  body: string;
  t_seconds: number | null;
  created_at: number;
  viewer_token_hash: string | null;
};

const COOKIE = "rc";
const COOKIE_SECONDS = 30 * 24 * 3600;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const COLS = "id, author_kind, display_name, body, t_seconds, created_at, viewer_token_hash";

// ---------- input ----------

// Control characters, and the invisible formatting ones (bidi overrides, zero-width) that let a name pass for another.
const CTRL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const BODY_CTRL = /[\p{Cf}\p{Zl}\p{Zp}]|(?!\n)\p{Cc}/gu;

/** Display name as stored: whitespace (tabs, newlines) collapsed to one space, other control/format characters stripped, trimmed. */
export const cleanName = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").replace(CTRL, "").replace(/ {2,}/g, " ").trim();

/** Body as stored: plain text, newlines kept (at most one blank line in a row), other control characters stripped. */
export const cleanBody = (s: string) =>
  s.normalize("NFC").replace(/\r\n?/g, "\n").replace(BODY_CTRL, "").replace(/\n{3,}/g, "\n\n").trim();

/** Compared case- and width-insensitively: "Demo", "DEMO" and "ｄｅｍｏ" are all the owner "demo". */
const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

type Input = { name: string | null; body: string; t: number | null };

function parseInput(raw: unknown, owner: boolean): { ok: true; v: Input; token: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Expected a JSON object." };
  const o = raw as Record<string, unknown>;
  if (typeof o.body !== "string") return { ok: false, error: "Write a comment first." };
  const body = cleanBody(o.body);
  if (!body) return { ok: false, error: "Write a comment first." };
  if (body.length > LIMITS.commentBodyMax) return { ok: false, error: `Comments can be at most ${LIMITS.commentBodyMax} characters.` };
  let t: number | null = null;
  if (o.t !== undefined && o.t !== null) {
    if (typeof o.t !== "number" || !Number.isFinite(o.t) || o.t < 0 || o.t > 86400) return { ok: false, error: "Invalid time." };
    t = Math.round(o.t * 10) / 10;
  }
  let name: string | null = null;
  if (!owner) {
    name = typeof o.name === "string" ? cleanName(o.name) : "";
    if (!name) return { ok: false, error: "Add your name." };
    if (name.length > LIMITS.commentNameMax) return { ok: false, error: `Names can be at most ${LIMITS.commentNameMax} characters.` };
  }
  const token = typeof o.turnstile === "string" ? o.turnstile.slice(0, 2048) : "";
  return { ok: true, v: { name, body, t }, token };
}

// ---------- Turnstile, keys, viewer identity ----------

/**
 * Viewers can post: Turnstile is on (both keys, config.ts) and the hashing secret is set, and the service isn't
 * read-only. TURNSTILE_DISABLED never opens viewer comments: anonymous posting always needs the bot check.
 */
export const viewerCommentsOpen = (env: Env) => getConfig(env).turnstile.enabled && !!env.IP_HASH_KEY && serviceMode(env) !== "READ_ONLY";

/** The siteverify request, as an object property so tests can answer it without touching the global fetch. */
export const siteverify = { post: (body: FormData): Promise<Response> => fetch(SITEVERIFY, { method: "POST", body }) };

/** Server-side siteverify of a Turnstile token. Anything but an explicit success (network error included) is a no. */
export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!token || !env.TURNSTILE_SECRET_KEY) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", ip);
    const res = await siteverify.post(form);
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch (e) {
    log("warn", "turnstile siteverify failed", { err: String(e) });
    return false;
  }
}

/** The page's comment key: `<exp>.<sig>` over video + share version. */
export async function commentKey(env: Env, id: string, version: number, exp: number): Promise<string> {
  return `${exp}.${await hmacB64(env.SHARE_HMAC_KEY, `comment.${id}.${version}.${exp}`)}`;
}

async function commentKeyOk(env: Env, v: CommentVideo, given: string | null): Promise<boolean> {
  const exp = Number((given ?? "").split(".")[0]);
  if (!given || !Number.isInteger(exp) || exp < now() || exp > now() + LIMITS.viewTokenSeconds) return false;
  return safeEqual(given, await commentKey(env, v.id, v.version, exp));
}

const viewerToken = (req: Request) => {
  const t = cookie(req, COOKIE);
  return t && /^[A-Za-z0-9]{20,30}$/.test(t) ? t : null;
};
const tokenHash = (env: Env, token: string) => hmacHex(env.IP_HASH_KEY, `comment-viewer:${token}`);
const ipHash = (env: Env, req: Request) => hmacHex(env.IP_HASH_KEY, `comment-ip:${clientIp(req)}`);

// ---------- reading ----------

const author = (r: DbRow, v: { by: { shown: string } }) => (r.author_kind === "owner" ? v.by.shown : r.display_name);

async function rows(env: Env, videoId: string, limit: number, since?: number): Promise<DbRow[]> {
  const res = await env.DB.prepare(
    `SELECT ${COLS} FROM comments WHERE video_id = ? AND deleted_at IS NULL AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
    .bind(videoId, since ?? -1, limit)
    .all<DbRow>();
  return res.results;
}

/**
 * A video's live comments, newest first, for its owner (MCP list_comments). null when the video doesn't exist or
 * isn't accountId's. since = only comments created after that unix time. A private video has none (revoking deletes them).
 */
export async function listComments(
  env: Env,
  accountId: string,
  videoId: string,
  opts: { since?: number } = {},
): Promise<CommentRow[] | null> {
  const rec = await env.DB.prepare("SELECT account_id FROM recordings WHERE id = ?").bind(videoId).first<{ account_id: string }>();
  if (!rec || rec.account_id !== accountId) return null;
  const by = await accountByline(env.DB, accountId);
  return (await rows(env, videoId, LIMITS.commentsPerVideoPer30Days, opts.since)).map((r) => ({
    id: r.id,
    author: author(r, { by }),
    is_owner: r.author_kind === "owner",
    body: r.body,
    t_seconds: r.t_seconds,
    created_at: r.created_at,
  }));
}

/** Seconds as the comment UI shows them: 1:23, 12:05, 1:02:03. */
export const clock = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

const ago = (t: number, at: number) => {
  const d = at - t;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)} d ago`;
  return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/** Until when the requester may delete r (0 = never). Owner: always; viewer: their own, for 10 minutes. */
const deletableUntil = (r: DbRow, owner: boolean, mine: string | null) =>
  owner ? Number.MAX_SAFE_INTEGER : r.author_kind === "viewer" && mine !== null && r.viewer_token_hash === mine ? r.created_at + LIMITS.commentDeleteSeconds : 0;

/** One comment, server-rendered. comments.js builds the same markup with textContent for new ones. */
function commentHtml(r: DbRow, v: CommentVideo, mine: string | null, at: number): string {
  const until = deletableUntil(r, v.owner, mine);
  const name = author(r, v);
  const del =
    until > at
      ? `<button type="button" class="c-x" data-until="${v.owner ? 0 : until}" aria-label="Delete comment by ${esc(name)}">Delete</button>`
      : "";
  const pin =
    r.t_seconds !== null
      ? `<button type="button" class="c-t" data-t="${r.t_seconds}" aria-label="Play from ${clock(r.t_seconds)}">${clock(r.t_seconds)}</button>`
      : "";
  return `<li class="c" data-id="${r.id}"><div class="c-h"><span class="c-a">${esc(name)}</span>${r.author_kind === "owner" ? '<span class="badge">Owner</span>' : ""}<time datetime="${new Date(r.created_at * 1000).toISOString()}">${ago(r.created_at, at)}</time>${pin}${del}</div><p class="c-b">${esc(r.body)}</p></li>`;
}

/**
 * The comments section under the player, fully server-rendered (list, count, form, Turnstile box at its final size) so
 * nothing shifts when comments.js and Turnstile load. turnstile = the page must load Turnstile and allow it in its CSP.
 */
export async function commentsSection(req: Request, env: Env, v: CommentVideo): Promise<{ html: string; turnstile: boolean }> {
  const at = now();
  const list = await rows(env, v.id, LIMITS.commentsShown);
  const total =
    list.length < LIMITS.commentsShown
      ? list.length
      : ((await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE video_id = ? AND deleted_at IS NULL").bind(v.id).first<{ n: number }>())?.n ??
        list.length);
  const tok = !v.owner && env.IP_HASH_KEY ? viewerToken(req) : null;
  const mine = tok ? await tokenHash(env, tok) : null;

  const open = v.owner ? serviceMode(env) !== "READ_ONLY" : viewerCommentsOpen(env);
  const ck = v.owner ? "" : await commentKey(env, v.id, v.version, at + LIMITS.viewTokenSeconds);
  const who = v.owner
    ? `<p class="cm-as">Commenting as <span class="c-a">${esc(v.by.shown)}</span><span class="badge">Owner</span></p>`
    : `<div class="cm-f"><label for="cm-name">Your name</label><input id="cm-name" name="name" type="text" maxlength="${LIMITS.commentNameMax}" required autocomplete="nickname" spellcheck="false"></div>`;
  const form = open
    ? `<form class="cm-form" id="cm-form" novalidate>${who}
<div class="cm-f"><label for="cm-body" class="sr">Comment</label><textarea id="cm-body" name="body" maxlength="${LIMITS.commentBodyMax}" rows="3" required placeholder="Add a comment" aria-describedby="cm-count"></textarea></div>
<div class="cm-row"><label class="cm-at"><input type="checkbox" id="cm-at"><span>at <span id="cm-at-t" class="mono">0:00</span></span></label><span id="cm-count" class="n">0/${LIMITS.commentBodyMax}</span></div>
${v.owner ? "" : `<div class="cm-ts"><div class="cf-turnstile" data-sitekey="${esc(getConfig(env).turnstile.siteKey!)}" data-action="comment" data-theme="dark"></div></div>`}
<div class="cm-row cm-send"><p id="cm-st" class="st" role="status"></p><button type="submit" class="btn cm-post" id="cm-post" disabled>Post comment</button></div>
</form>`
    : '<p class="muted cm-closed">Comments are closed right now.</p>';
  const html = `<section class="cm" id="cm" aria-labelledby="cmh"${ck ? ` data-ck="${ck}"` : ""}${v.owner ? ' data-owner="1"' : ""}>
<h2 id="cmh">Comments <span class="cm-n" id="cm-n">${total}</span></h2>
${form}
<p class="muted cm-empty" id="cm-empty"${list.length ? " hidden" : ""}>No comments yet.</p>
<ol class="cm-list" id="cm-list">${list.map((r) => commentHtml(r, v, mine, at)).join("")}</ol>
</section>`;
  return { html, turnstile: open && !v.owner };
}

// ---------- API: GET / POST <video>/comments, DELETE <video>/comments/<id> ----------

/** Same-origin only: Origin must be this origin (and Sec-Fetch-Site, when sent, same-origin). */
export function sameOrigin(req: Request): boolean {
  if (req.headers.get("origin") !== new URL(req.url).origin) return false;
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin";
}

const tooMany = (message: string) => json({ error: message }, 429);
const out = (r: DbRow, v: CommentVideo, mine: string | null, at: number) => {
  const until = deletableUntil(r, v.owner, mine);
  return {
    id: r.id,
    author: author(r, v),
    is_owner: r.author_kind === "owner",
    body: r.body,
    t_seconds: r.t_seconds,
    created_at: r.created_at,
    /** The requester may delete it: the owner any time (delete_until null), a viewer their own until delete_until. */
    can_delete: until > at,
    delete_until: v.owner || until <= at ? null : until,
  };
};

/**
 * The comment API. `notFound` is the watch page's generic 404 (also for a viewer without a valid comment key). Origin is
 * checked by the caller for POST/DELETE before the video is looked up.
 */
export async function handleCommentsApi(
  req: Request,
  env: Env,
  v: CommentVideo,
  commentId: string | null,
  notFound: () => Response,
): Promise<Response> {
  if (!v.owner && !(await commentKeyOk(env, v, req.headers.get("x-comment-key")))) return notFound();
  if (req.method === "GET") {
    const tok = !v.owner && env.IP_HASH_KEY ? viewerToken(req) : null;
    const mine = tok ? await tokenHash(env, tok) : null;
    const at = now();
    return json({ comments: (await rows(env, v.id, LIMITS.commentsShown)).map((r) => out(r, v, mine, at)) });
  }
  if (serviceMode(env) === "READ_ONLY") return json({ error: "Comments are closed right now." }, 503);
  return req.method === "DELETE" && commentId ? deleteComment(req, env, v, commentId) : postComment(req, env, v);
}

async function postComment(req: Request, env: Env, v: CommentVideo): Promise<Response> {
  if (!v.owner && !viewerCommentsOpen(env)) return json({ error: "Comments are closed right now." }, 503);
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "expected application/json" }, 415);
  const text = await req.text();
  if (text.length > 8192) return json({ error: "too large" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const p = parseInput(raw, v.owner);
  if (!p.ok) return json({ error: p.error }, 400);
  const { name, body, t } = p.v;
  if (name !== null && (fold(name) === fold(v.by.username) || fold(name) === fold(v.by.shown))) {
    return json({ error: "That name belongs to the video's owner. Pick another one." }, 400);
  }
  if (!v.owner && !p.token) return json({ error: "Please complete the check below and try again." }, 403);

  const at = now();
  let token: string | null = null;
  let fresh = false;
  let th: string | null = null;
  let ih: string | null = null;
  if (!v.owner) {
    token = viewerToken(req);
    if (!token) {
      token = randomId(128);
      fresh = true;
    }
    th = await tokenHash(env, token);
    ih = await ipHash(env, req);
  }

  // Limits before siteverify, so a flood costs no Turnstile calls. Deleted comments still count.
  const c = await env.DB.prepare(
    `SELECT
      (SELECT count(*) FROM comments WHERE viewer_token_hash = ?1 AND created_at > ?3) AS by_token,
      (SELECT count(*) FROM comments WHERE ip_hash = ?2 AND created_at > ?3) AS by_ip,
      (SELECT count(*) FROM comments WHERE video_id = ?4 AND created_at > ?5) AS day,
      (SELECT count(*) FROM comments WHERE video_id = ?4 AND created_at > ?6) AS month,
      (SELECT count(*) FROM comments WHERE video_id = ?4 AND created_at > ?7 AND deleted_at IS NULL AND body = ?8
        AND (viewer_token_hash = ?1 OR ip_hash = ?2)) AS dup`,
  )
    .bind(th, ih, at - LIMITS.commentsViewerWindowSeconds, v.id, at - 86400, at - 30 * 86400, at - LIMITS.commentDuplicateSeconds, body)
    .first<{ by_token: number; by_ip: number; day: number; month: number; dup: number }>();
  if (!c) throw new Error("comment limits: no row");
  if (!v.owner && (c.by_token >= LIMITS.commentsPerViewer || c.by_ip >= LIMITS.commentsPerViewer)) {
    return tooMany("You're commenting quickly. Wait a few minutes, then try again.");
  }
  if (c.day >= LIMITS.commentsPerVideoPerDay) return tooMany("This video got a lot of comments today. Try again tomorrow.");
  if (c.month >= LIMITS.commentsPerVideoPer30Days) return tooMany("This video has reached its comment limit for now. Try again later.");
  if (!v.owner && c.dup > 0) return json({ error: "You already posted that comment." }, 409);

  if (!v.owner && !(await verifyTurnstile(env, p.token, clientIp(req)))) {
    return json({ error: "We couldn't verify you're human. Try again." }, 403);
  }

  const row: DbRow = {
    id: randomId(96),
    author_kind: v.owner ? "owner" : "viewer",
    display_name: name ?? v.by.shown,
    body,
    t_seconds: t,
    created_at: at,
    viewer_token_hash: th,
  };
  await env.DB.prepare(
    "INSERT INTO comments (id, video_id, author_kind, display_name, body, t_seconds, created_at, viewer_token_hash, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, v.id, row.author_kind, row.display_name, row.body, row.t_seconds, row.created_at, th, ih)
    .run();
  const headers: Record<string, string> = {};
  if (fresh) {
    const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
    headers["set-cookie"] = `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Strict${secure}`;
  }
  return json({ comment: out(row, v, th, at) }, 201, headers);
}

/**
 * The owner deletes a comment on their video (the page's Delete, MCP delete_comment). The body goes; the row stays
 * (deleted_at) so it still counts toward the rate limits. false = no such live comment on that video.
 */
export async function ownerDeleteComment(env: Env, videoId: string, commentId: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE comments SET deleted_at = ?, body = '' WHERE id = ? AND video_id = ? AND deleted_at IS NULL")
    .bind(now(), commentId, videoId)
    .run();
  return r.meta.changes > 0;
}

async function deleteComment(req: Request, env: Env, v: CommentVideo, id: string): Promise<Response> {
  if (v.owner) return (await ownerDeleteComment(env, v.id, id)) ? json({ deleted: true }) : json({ error: "not found" }, 404);
  const at = now();
  const tok = env.IP_HASH_KEY ? viewerToken(req) : null;
  const r = tok
    ? await env.DB.prepare(
        "UPDATE comments SET deleted_at = ?, body = '' WHERE id = ? AND video_id = ? AND deleted_at IS NULL AND author_kind = 'viewer' AND viewer_token_hash = ? AND created_at >= ?",
      )
        .bind(at, id, v.id, await tokenHash(env, tok), at - LIMITS.commentDeleteSeconds)
        .run()
    : null;
  return r?.meta.changes
    ? json({ deleted: true })
    : json({ error: "You can delete your own comment for 10 minutes after posting it." }, 403);
}
