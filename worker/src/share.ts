// Share links, viewer page and media streaming.
import { getConfig } from "./config";
import { brandShell, type BrandShell } from "./brand-page";
import { commentsSection, handleCommentsApi, sameOrigin } from "./comments";
import { liveCustomDomain } from "./custom-domains";
import type { Env } from "./env";
import { accountLimits, isOwnerAccount, LIMITS, serviceMode, type Tier } from "./env";
import { governor } from "./governor";
import { isOwner, ownerCookie, verifyOwnerToken } from "./owner-link";
import { WEB_ASSETS_VERSION } from "./generated-web";
import { recordingExpired, retentionHoldCol, retentionHoldSql } from "./retention-hold";
import { countPreview, handleBeacon, isLinkPreview, viewToken, withWatchPct } from "./stats";
import { heldSql, recordingRemoved, sharingBlocked } from "./takedown-state";
import { accountByline, assignUsername } from "./username";
import type { StatsRow } from "./stats";
import { clientIp, cookie, esc, hmacB64, hmacHex, json, now, passcodeSalt, pbkdf2, randomId, safeEqual } from "./util";
import { DESCRIPTION_MAX, setVideoMeta, TITLE_MAX, validateVideoMeta, type VideoMetaInput } from "./video-meta";

export type Segment = { start: number; end: number; text: string };

export { isLinkPreview } from "./stats";

const SECURITY_HEADERS = {
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

// ---------- retention ----------

/** expires_at of owner-tier recordings (9999-12-31): kept until deleted, the hourly cleanup skips them. */
export const KEEP_FOREVER = 253402300799;

/**
 * expires_at for a new recording: owner tier or a paid plan (keepForever, from accountLimits) = KEEP_FOREVER, free = 7
 * days. Existing rows keep the expiry they got.
 */
export const retentionExpiry = (env: Env, accountId: string, t: number, keepForever = false) =>
  keepForever || isOwnerAccount(env, accountId) ? KEEP_FOREVER : t + LIMITS.retentionSeconds;

/**
 * Recordings the hourly cleanup deletes: those past their own stored expires_at (free tier: 24 h for rows from before
 * 7-day retention, 7 days after), never held ones (takedown-state.ts: taken down, or ever for csam) and none of
 * an account on retention hold (retention-hold.ts). Owner-tier rows (OWNER_ACCOUNT_IDS or plan 'owner') from before KEEP_FOREVER (or
 * from an account promoted since) are never returned; they are moved to KEEP_FOREVER instead.
 */
export async function expiredRecordingIds(env: Env, t: number, limit = 500): Promise<string[]> {
  const old = await env.DB.prepare(
    "SELECT id, account_id, (SELECT plan FROM accounts WHERE accounts.id = recordings.account_id) AS plan FROM recordings WHERE expires_at < ? " +
      `AND NOT ${heldSql("recordings.id", "recordings.account_id")} AND NOT ${retentionHoldSql("recordings.account_id")} LIMIT ?`,
  )
    .bind(t, limit)
    .all<{ id: string; account_id: string; plan: string | null }>();
  const keep = old.results.filter((r) => r.plan === "owner" || isOwnerAccount(env, r.account_id)).map((r) => r.id);
  if (keep.length) {
    await env.DB.prepare(`UPDATE recordings SET expires_at = ? WHERE id IN (${keep.map(() => "?").join(",")})`)
      .bind(KEEP_FOREVER, ...keep)
      .run();
  }
  return old.results.filter((r) => !keep.includes(r.id)).map((r) => r.id);
}

// ---------- links ----------

// One URL per video: <origin>/<username>/v/<slug>. Private (shared_at NULL) = only its owner (isOwner) can open it;
// shared = anyone with the URL. revoke_share makes it private and replaces the slug, so the old URL dies for everyone.
// Private, revoked and nonexistent all get the same 404 page.

/** A new slug: 80 random bits, base62 (14 chars). */
export const newSlug = () => randomId(80);

/**
 * videoLinks for many of one account's videos at once, plus each one's owner_version: one query for all of them (a
 * Workers Free invocation has few), and one each only for rows without a slug yet. Ids of other accounts are left out.
 */
export async function videoLinksMany(
  env: Env,
  origin: string,
  ids: string[],
  accountId: string,
  custom: string | null,
): Promise<Map<string, { url: string; home: string; owner_version: number }>> {
  const out = new Map<string, { url: string; home: string; owner_version: number }>();
  if (!ids.length) return out;
  const username = await assignUsername(env.DB, accountId);
  const rows = await env.DB.prepare(`SELECT id, slug, owner_version FROM recordings WHERE account_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(accountId, ...ids)
    .all<{ id: string; slug: string | null; owner_version: number }>();
  for (const r of rows.results) {
    const slug = r.slug ?? (await ensureSlug(env, r.id));
    const home = `${origin}/${username}/v/${slug}`;
    out.set(r.id, { url: custom ? `${custom}/${slug}` : home, home, owner_version: r.owner_version });
  }
  return out;
}

/** The recording's slug, giving it one if it has none (rows from before migration 0005's backfill). */
async function ensureSlug(env: Env, id: string): Promise<string> {
  await env.DB.prepare("UPDATE recordings SET slug = ? WHERE id = ? AND slug IS NULL").bind(newSlug(), id).run();
  const row = await env.DB.prepare("SELECT slug FROM recordings WHERE id = ?").bind(id).first<{ slug: string | null }>();
  if (!row?.slug) throw new Error("ensureSlug: no such recording");
  return row.slug;
}

/** The video's one URL. Private or public, it is the same URL; sharing only changes who it opens for. */
export async function videoUrl(env: Env, origin: string, id: string, accountId: string): Promise<string> {
  return `${origin}/${await assignUsername(env.DB, accountId)}/v/${await ensureSlug(env, id)}`;
}

/**
 * https://<hostname> of the account's ACTIVE custom domain (custom-domains.ts liveCustomDomain: live, not disabled), or
 * null. Pending, redirecting, failed or none: null, so links stay on our own host until the domain really works.
 */
export async function customVideoBase(env: Env, accountId: string): Promise<string | null> {
  const d = await liveCustomDomain(env, accountId);
  return d ? `https://${d.hostname}` : null;
}

/**
 * The link to hand out for a video. Every video of an account with a live custom domain (`custom`, from
 * customVideoBase: look it up once per tool call) gets https://<hostname>/<slug>, whatever its state: private,
 * passcode, not ready or expired, custom-host.ts sends the viewer to the URL on our own host. Every account without a
 * live domain: its URL on our own host. home is always that URL (owner links are built on it: they only work there).
 */
export async function videoLinks(env: Env, origin: string, id: string, accountId: string, custom: string | null): Promise<{ url: string; home: string }> {
  const home = await videoUrl(env, origin, id, accountId);
  if (!custom) return { url: home, home };
  const r = await env.DB.prepare("SELECT slug FROM recordings WHERE id = ? AND account_id = ?").bind(id, accountId).first<{ slug: string }>();
  return { url: r ? `${custom}/${r.slug}` : home, home };
}

/** The custom-domain URL of this account's video (videoLinks' rule), or null without a live domain. */
async function customVideoUrl(env: Env, accountId: string, slug: string): Promise<string | null> {
  const custom = await customVideoBase(env, accountId);
  if (!custom) return null;
  const r = await env.DB.prepare("SELECT id FROM recordings WHERE slug = ? AND account_id = ?").bind(slug, accountId).first<{ id: string }>();
  return r ? (await videoLinks(env, "", r.id, accountId, custom)).url : null;
}

/** share_recording: makes the URL public (keeps the current slug) and returns it. */
export async function shareRecording(env: Env, origin: string, id: string, accountId: string): Promise<string> {
  await env.DB.prepare("INSERT INTO shares (recording_id) VALUES (?) ON CONFLICT DO NOTHING").bind(id).run();
  await env.DB.prepare("UPDATE recordings SET shared_at = coalesce(shared_at, ?) WHERE id = ?").bind(now(), id).run();
  return videoUrl(env, origin, id, accountId);
}

/**
 * revoke_share: private again, with a new slug, so the old URL stops working at once, even for people who have it.
 * Bumping the share version also kills media cookies already handed out and every legacy /v/<id> link; bumping
 * owner_version kills every owner link and owner cookie handed out so far. Comments exist only while the video is
 * shared, so they go too. Returns the new (private) URL.
 */
export async function revokeShare(env: Env, origin: string, id: string, accountId: string): Promise<string> {
  await env.DB.batch([
    env.DB.prepare("UPDATE recordings SET shared_at = NULL, slug = ?, owner_version = owner_version + 1 WHERE id = ?").bind(newSlug(), id),
    env.DB.prepare(
      "INSERT INTO shares (recording_id, version) VALUES (?, 2) ON CONFLICT (recording_id) DO UPDATE SET version = version + 1",
    ).bind(id),
    env.DB.prepare("DELETE FROM comments WHERE video_id = ?").bind(id),
  ]);
  return videoUrl(env, origin, id, accountId);
}

/** Legacy link signature (`/v/<id>?e=<exp>&s=<sig>`, 24 h). No longer handed out; checked only to 301 old links. */
export async function shareSig(env: Env, id: string, exp: number, version: number): Promise<string> {
  return hmacB64(env.SHARE_HMAC_KEY, `share.${id}.${exp}.${version}`);
}

type ShareRow = {
  version: number;
  passcode_hash: string | null;
  passcode_salt: string | null;
  failed_attempts: number;
  locked_until: number | null;
};

async function shareRow(env: Env, id: string): Promise<ShareRow> {
  await env.DB.prepare("INSERT INTO shares (recording_id) VALUES (?) ON CONFLICT DO NOTHING").bind(id).run();
  return (await env.DB.prepare(
    "SELECT version, passcode_hash, passcode_salt, failed_attempts, locked_until FROM shares WHERE recording_id = ?",
  )
    .bind(id)
    .first<ShareRow>())!;
}

/** A customer's custom video domain the request came in on (custom-host.ts): its hostname and account. */
export type CustomHost = { hostname: string; accountId: string };
export type ViewerOpts = { customHost?: CustomHost };

type VideoRow = {
  id: string;
  account_id: string;
  slug: string | null;
  shared_at: number | null;
  title: string | null;
  description: string | null;
  status: string;
  expires_at: number;
  retention_hold: number;
  transcript: string | null;
  transcript_status: string;
  owner_version: number;
};
const VIDEO_SELECT =
  `SELECT id, account_id, slug, shared_at, title, description, status, expires_at, ${retentionHoldCol()}, transcript, transcript_status, owner_version FROM recordings`;

/**
 * The video when this request may see it: ready, not expired, and public or opened by its owner (owner-link.ts isOwner:
 * the account's web session or this recording's owner cookie). null for everything else, so callers answer private,
 * revoked and nonexistent alike. owner is the only source of owner rights on the page. "removed": taken down
 * (takedown-state.ts), for everyone, owner included; only the pages say so (removedPage), everything else treats it as null.
 */
async function findVideo(
  req: Request,
  env: Env,
  where: "id" | "slug",
  key: string,
  customHost?: CustomHost,
): Promise<{ rec: VideoRow; owner: boolean } | "removed" | null> {
  const rec = await env.DB.prepare(`${VIDEO_SELECT} WHERE ${where} = ?`).bind(key).first<VideoRow>();
  if (!rec) return null;
  // On a customer's domain only that account's videos exist, and nobody is the owner there (no sign-in on that host).
  if (customHost && rec.account_id !== customHost.accountId) return null;
  if (await recordingRemoved(env, rec.id, rec.account_id)) return "removed";
  if (rec.status !== "ready" || recordingExpired(rec, now())) return null;
  const owner = customHost ? false : await isOwner(req, env, rec);
  return owner || rec.shared_at !== null ? { rec, owner } : null;
}

async function visibleVideo(req: Request, env: Env, where: "id" | "slug", key: string, customHost?: CustomHost) {
  const v = await findVideo(req, env, where, key, customHost);
  return v === "removed" ? null : v;
}

/** POST /<username>/v/<slug>/b — view beacons from the page (player.js posts to its own path + /b). */
export async function handleVideoBeacon(req: Request, env: Env, slug: string): Promise<Response> {
  const rec = await env.DB.prepare("SELECT id FROM recordings WHERE slug = ?").bind(slug).first<{ id: string }>();
  return rec ? handleBeacon(req, env, rec.id) : new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
}

/** Bound to the share version: revoking kills media cookies already handed out. */
async function mediaToken(env: Env, id: string, version: number, exp: number): Promise<string> {
  return `${exp}.${await hmacB64(env.SHARE_HMAC_KEY, `media.${id}.${version}.${exp}`)}`;
}

export const mmss = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// ---------- page templates (styles and script are static files under /s/, see worker/web) ----------

const asset = (path: string) => `/s/${path}?v=${WEB_ASSETS_VERSION}`;
/** BRAND_NAME is set: our own pages carry the product's name, logo, icons and preview card. Without it they carry none. */
const branded = (env: Env): boolean => getConfig(env).site.brandName !== null;
/** The page's style or script: without a brand the neutral copies scripts/build-web.mjs makes (same code, no product name). */
const webFile = (env: Env, file: "recitbot.css" | "player.js" | "meta.js" | "comments.js") =>
  asset(branded(env) ? file : `plain/${file === "recitbot.css" ? "watch.css" : file}`);
/** The default page description: "private" only on a private video's page (its owner's view), nowhere else. */
const sharedWith = (env: Env) => (branded(env) ? " shared with Recitbot" : "");
const siteDesc = (env: Env) => `A screen recording${sharedWith(env)}.`;
const privateDesc = (env: Env) => `A private screen recording${sharedWith(env)}.`;
const defaultTitle = (env: Env) => (branded(env) ? "Recitbot recording" : "Screen recording");

type PageOpts = {
  /** <title> and og:title. */
  title: string;
  body: string;
  status?: number;
  description?: string;
  /** The page shows a private video (only its owner gets here): the footer says so. Everything else: a neutral footer. */
  private?: boolean;
  /** Load /s/player.js (viewer page only). */
  player?: boolean;
  /** Load /s/meta.js (the owner's title/description editor). */
  editor?: boolean;
  /** Load /s/comments.js (the comments section). */
  comments?: boolean;
  /** Load Cloudflare Turnstile (viewer comment form): its script and its challenge frame, nothing else. */
  turnstile?: boolean;
  /** The page's own absolute URL: <link rel="canonical"> and og:url (custom-host pages only). */
  canonical?: string;
  /** A customer-host page: that account's branding instead of Recitbot's (brandedPage). */
  brand?: BrandShell;
  extra?: Record<string, string | string[]>;
};

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Every share-route HTML response. Strict CSP: no inline script or style at all; scripts, styles, fonts and images only
 * from this origin's /s/ path (plus Turnstile's script and frame on pages with the viewer comment form). Link-preview meta
 * (og/twitter) is the same on every page and never carries a media or signed URL: og:image is the static branded card.
 */
function page(env: Env, origin: string, o: PageOpts): Response {
  if (o.brand) return brandedPage(env, origin, o, o.brand);
  const s = `${origin}/s/`;
  const csp = [
    "default-src 'none'",
    "media-src 'self'",
    // Turnstile probes with fetch('data:,'). Nothing else: the Cloudflare analytics beacon stays blocked.
    `connect-src 'self'${o.turnstile ? " data:" : ""}`,
    `style-src ${s}`,
    `script-src ${s}${o.turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
    ...(o.turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    `font-src ${s}`,
    `img-src ${s}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const t = esc(o.title);
  const d = esc(o.description ?? siteDesc(env));
  const brand = getConfig(env).site.brandName;
  const img = `${origin}${asset("og-card.png")}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="theme-color" content="#111318"><title>${t}${brand === null ? "" : " · Recitbot"}</title><meta name="description" content="${d}">
${o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}"><meta property="og:url" content="${esc(o.canonical)}">
` : ""}<meta property="og:type" content="video.other">${brand === null ? "" : `<meta property="og:site_name" content="Recitbot">`}<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">${brand === null ? "" : `<meta property="og:image" content="${img}"><meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Recitbot: a screen recording was shared with you">`}
<meta name="twitter:card" content="${brand === null ? "summary" : "summary_large_image"}"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}">${brand === null ? "" : `<meta name="twitter:image" content="${img}">
<link rel="icon" href="${asset("favicon.ico")}" sizes="16x16 32x32 48x48"><link rel="icon" href="${asset("favicon.svg")}" type="image/svg+xml"><link rel="apple-touch-icon" href="${asset("apple-touch-icon.png")}">`}
<link rel="preload" href="/s/fonts/space-grotesk-700.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/s/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${webFile(env, "recitbot.css")}"></head>
<body>${brand === null ? "" : `<header class="top"><img src="${asset("recitbot-lockup.svg")}" alt="Recitbot" width="143" height="52"></header>`}
<main>${o.body}</main>
${brand === null ? "" : `<footer class="foot">${o.private ? "Shared privately" : "Recorded"} with ${esc(brand)}</footer>`}${o.player ? `<script src="${webFile(env, "player.js")}" defer></script>` : ""}${o.editor ? `<script src="${webFile(env, "meta.js")}" defer></script>` : ""}${o.comments ? `<script src="${webFile(env, "comments.js")}" defer></script>` : ""}${o.turnstile ? `<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>` : ""}</body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": csp, ...SECURITY_HEADERS });
  for (const [k, v] of Object.entries(o.extra ?? {})) for (const x of [v].flat()) headers.append(k, x);
  return new Response(html, { status: o.status ?? 200, headers });
}

/**
 * A customer-host page (brand-page.ts): the account's name, logo, favicon, social image and colours, nothing of
 * Recitbot's but the fixed footer ("Powered by <brand name>" and Report, outside every brand-styled element). The CSP is the
 * viewer's minus Turnstile and comments, with img-src 'self' (brand images are /b/ on this host), no form posts, and
 * the inline brand <style> allowed by its hash only. og:image is the brand's social image on this host, or none.
 */
function brandedPage(env: Env, origin: string, o: PageOpts, b: BrandShell): Response {
  const s = `${origin}/s/`;
  const csp = [
    "default-src 'none'",
    "media-src 'self'",
    "connect-src 'self'",
    `style-src ${s}${b.style ? ` ${b.style.hash}` : ""}`,
    `script-src ${s}`,
    `font-src ${s}`,
    "img-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const t = esc(o.title);
  const d = esc(o.description ?? "");
  const site = esc(b.siteName);
  const og = b.og;
  const brandName = getConfig(env).site.brandName;
  const powered = brandName === null ? "" : `Powered by ${esc(brandName)}`;
  const report = b.report ? `<a href="${esc(b.report)}" rel="noopener nofollow">Report</a>` : "";
  const footer = [powered && (b.home ? `<a href="${esc(b.home)}" rel="noopener">${powered}</a>` : powered), report].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  const header =
    b.logo || b.name
      ? `<header class="top brand">${b.logo ? `<img src="${esc(b.logo.href)}" alt="${site}" width="${Math.trunc(b.logo.width)}" height="${Math.trunc(b.logo.height)}">` : ""}${b.name ? `<span class="bn">${esc(b.name)}</span>` : ""}</header>
`
      : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="theme-color" content="${b.background ?? "#111318"}"><title>${t} · ${site}</title><meta name="description" content="${d}">
${o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}"><meta property="og:url" content="${esc(o.canonical)}">
` : ""}<meta property="og:type" content="video.other"><meta property="og:site_name" content="${site}"><meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">${og ? `<meta property="og:image" content="${esc(og.url)}"><meta property="og:image:type" content="${esc(og.type)}">
<meta property="og:image:width" content="${Math.trunc(og.width)}"><meta property="og:image:height" content="${Math.trunc(og.height)}"><meta property="og:image:alt" content="${site}">` : ""}
<meta name="twitter:card" content="${og ? "summary_large_image" : "summary"}"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}">${og ? `<meta name="twitter:image" content="${esc(og.url)}">` : ""}
${b.favicon ? `<link rel="icon" href="${esc(b.favicon)}" type="image/png">` : ""}<link rel="preload" href="/s/fonts/space-grotesk-700.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/s/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${webFile(env, "recitbot.css")}">${b.style ? `<style>${b.style.css}</style>` : ""}</head>
<body>${header}<main>${o.body}</main>
${footer && `<footer class="pwr">${footer}</footer>`}${o.player ? `<script src="${webFile(env, "player.js")}" defer></script>` : ""}</body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": csp, ...SECURITY_HEADERS });
  for (const [k, v] of Object.entries(o.extra ?? {})) for (const x of [v].flat()) headers.append(k, x);
  return new Response(html, { status: o.status ?? 200, headers });
}

/** Centered message card: expired links, passcode, limits. `html` is trusted markup. Customer hosts: no Recitbot mark. */
const message = (env: Env, heading: string, html: string, brand?: BrandShell) =>
  `<div class="msg">${brand || !branded(env) ? "" : `<img class="mark" src="${asset("icon.svg")}" alt="" width="72" height="72">`}<h1>${esc(heading)}</h1>${html}</div>`;

/**
 * A taken-down video (takedown-state.ts), on every host: 451 with a neutral Recitbot page, never the account's branding,
 * title or anything else of the video.
 */
export const removedPage = (env: Env, origin: string) =>
  page(env, origin, {
    title: "Video removed",
    description: "This video was removed for a policy violation.",
    status: 451,
    body: message(env, "This video was removed", "<p>It was removed for a policy violation.</p>"),
  });

/** The one answer for private, revoked, expired and nonexistent videos, so they can't be told apart. */
const notFound = (env: Env, origin: string, brand?: BrandShell) =>
  page(env, origin, {
    title: "Video not available",
    description: brand || !branded(env) ? "This video is private or doesn't exist." : "This Recitbot video is private or doesn't exist.",
    status: 404,
    brand,
    body: message(env, "This video is private or doesn't exist", "<p>If someone sent you this link, ask them to share it again.</p>", brand),
  });

const REDIRECT_HEADERS = { ...SECURITY_HEADERS, "cache-control": "no-store" };

const ICON = {
  play: '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  vol: '<svg class="i-vol" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  muted:
    '<svg class="i-muted" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 9v6h4l5 5V4L7 9H3zm15.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>',
  enter:
    '<svg class="i-enter" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  exit: '<svg class="i-exit" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Free-plan watermark: a small Recitbot pill (web/favicon.svg's bot head and record dot, inline so it costs no request)
 * over the bottom-right of the video, inside .player so it stays in container fullscreen. Only the pill takes clicks.
 * It links to config.ts homeUrl (no link when none is configured).
 */
const watermark = (home: string | null) =>
  `<a class="wm" id="wm"${home ? ` href="${esc(home)}" target="_blank" rel="noopener"` : ""} aria-label="Made with Recitbot">` +
  '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="3" r="3" fill="#F2463A"/><rect x="4" y="7" width="24" height="23" rx="6" fill="#F5F3EE"/><rect x="0" y="14" width="2" height="8" rx="1" fill="#F5F3EE"/><rect x="30" y="14" width="2" height="8" rx="1" fill="#F5F3EE"/><circle cx="16" cy="18" r="6" fill="#F2463A"/></svg>' +
  "<span>Recitbot</span></a>";

/**
 * The player. Server-rendered with native `controls` so it works without script; player.js removes them and shows the
 * custom controls. The only media URL is /m/<slug>, which needs the per-view HttpOnly cookie set with this page.
 */
function playerHtml(slug: string, vt: string | null, wm: string | null): string {
  return `<figure class="player" id="player">
<video id="v" src="/m/${slug}"${vt ? ` data-vt="${vt}"` : ""} controls playsinline webkit-playsinline preload="metadata" controlslist="nodownload noremoteplayback" disablepictureinpicture disableremoteplayback></video>
<button type="button" class="big" id="big" aria-label="Play (k)">${ICON.play}</button>
${wm !== null ? `${wm}
` : ""}<p class="fail" id="fail" role="alert" hidden>Playback stopped. Reload the page to keep watching.</p>
<div class="ctl" id="ctl">
<div class="scrub" id="scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="00:00"><div class="track"><div class="buf" id="buf"></div><div class="fill" id="fill"></div><div class="knob" id="knob"></div></div><div class="tip" id="tip" hidden></div></div>
<div class="bar">
<button type="button" class="b" id="play" aria-label="Play (k)">${ICON.play}${ICON.pause}</button>
<span class="time"><span id="cur">00:00</span> <span class="of">/ <span id="dur">--:--</span></span></span>
<span class="grow"></span>
<div class="vol"><button type="button" class="b" id="mute" aria-label="Mute (m)">${ICON.vol}${ICON.muted}</button><input type="range" id="vol" min="0" max="1" step="0.05" value="1" aria-label="Volume"></div>
<label class="speed"><span class="sr">Playback speed</span><select id="speed">${SPEEDS.map((x) => `<option value="${x}"${x === 1 ? " selected" : ""}>${x}×</option>`).join("")}</select></label>
<button type="button" class="b" id="fs" aria-label="Full screen (f)">${ICON.enter}${ICON.exit}</button>
</div></div></figure>`;
}

/** Transcript lines are buttons: data-t is the start (seconds) the player seeks to. */
function transcriptHtml(segments: Segment[], status: string): string {
  const inner = segments.length
    ? `<ol id="lines">${segments
        .map(
          (s) =>
            `<li><button type="button" class="l" data-t="${Number(s.start)}"><span class="t">${mmss(s.start)}</span><span>${esc(String(s.text).trim())}</span></button></li>`,
        )
        .join("")}</ol>`
    : `<p class="muted">${status === "unavailable" ? "Transcript unavailable." : status === "silent" ? "No speech detected." : "No transcript."}</p>`;
  return `<section class="tx" aria-labelledby="txh"><h2 id="txh">Transcript</h2>${inner}</section>`;
}

/**
 * ?ot= (owner link, owner-link.ts): always a 303 to the URL without it, never an error. A valid token for this very video
 * at its current owner_version, opened by a browser (not a link-preview bot), first adds the video to that browser's
 * owner cookie (rights on this video only; not a web sign-in), and the redirect goes to the video's current URL.
 * Anything else (expired, tampered, revoked, another video's, a preview bot): only the redirect.
 */
async function ownerLinkRedirect(req: Request, env: Env, url: URL, where: "id" | "slug", key: string): Promise<Response> {
  const clean = new URL(url);
  clean.searchParams.delete("ot");
  let location = clean.pathname + clean.search;
  const headers: Record<string, string> = { ...REDIRECT_HEADERS, "referrer-policy": "no-referrer" };
  const rec = await env.DB.prepare(`SELECT id, account_id, status, expires_at, ${retentionHoldCol()}, owner_version FROM recordings WHERE ${where} = ?`)
    .bind(key)
    .first<{ id: string; account_id: string; status: string; expires_at: number; retention_hold: number; owner_version: number }>();
  if (
    rec &&
    rec.status === "ready" &&
    !recordingExpired(rec, now()) &&
    !isLinkPreview(req.headers.get("user-agent")) &&
    (await verifyOwnerToken(env, url.searchParams.get("ot"), rec))
  ) {
    headers["set-cookie"] = await ownerCookie(req, env, rec);
    location = (await videoUrl(env, "", rec.id, rec.account_id)) + (where === "slug" ? clean.search : "");
  }
  headers.location = location;
  return new Response(null, { status: 303, headers });
}

/**
 * GET /v/:id — links handed out before /<username>/v/<slug>. 301 to the video's URL when it is shared and the link's
 * signature is valid at the current share version (revoking bumps it, so a revoked video's old links stay dead even
 * after it is shared again), or when its owner opens it. Otherwise the 404. The ready push opens /v/<id>?ot=<owner
 * token> (shipped recorders only open /v/<id>), which makes that browser the video's owner first.
 */
export async function handleLegacyViewer(req: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.has("ot")) return ownerLinkRedirect(req, env, url, "id", id);
  const v = await findVideo(req, env, "id", id);
  if (v === "removed") return removedPage(env, url.origin);
  if (!v) return notFound(env, url.origin);
  const share = await shareRow(env, id);
  const headers: Record<string, string> = { ...REDIRECT_HEADERS, location: await videoUrl(env, "", id, v.rec.account_id) };
  if (!v.owner) {
    const e = url.searchParams.get("e");
    const exp = Number(e);
    if (e === null || !Number.isInteger(exp) || exp < now() || exp > now() + LIMITS.legacyShareMaxSeconds) return notFound(env, url.origin);
    if (!safeEqual(url.searchParams.get("s") ?? "", await shareSig(env, id, exp, share.version))) return notFound(env, url.origin);
  }
  return new Response(null, { status: 301, headers });
}

/**
 * GET/POST /<username>/v/<slug> (HEAD is not routed, so it never renders or counts). The slug decides what is shown.
 * A wrong username (old, other case, anything) 301s to the right one only when the video is public; a private video
 * answers 404 to everyone but its owner. Owner rights on the page (editor, deleting any comment, commenting without
 * Turnstile, the Owner view chip) come only from v.owner (owner-link.ts isOwner).
 *
 * opts.customHost: GET /<slug> on that account's custom domain (custom-host.ts, which already sent everything that isn't
 * plainly public to our own host). Only that account's videos; never the owner (no ?ot=, editor, stats or download); no
 * comments and no watermark; canonical and og:url on the custom host; the account's branding (brand-page.ts) and the
 * fixed Recitbot footer instead of Recitbot's header. Media (/m/<slug>) and the beacon (<page path>/b) are relative, so
 * they stay on that host.
 */
export async function handleViewer(req: Request, env: Env, username: string, slug: string, opts: ViewerOpts = {}): Promise<Response> {
  const url = new URL(req.url);
  const custom = opts.customHost;
  if (url.searchParams.has("ot") && !custom) return ownerLinkRedirect(req, env, url, "slug", slug);
  // Customer host: that account's branding (only while its plan includes it) on every answer, never Recitbot's.
  const customLimits = custom ? await accountLimits(env, custom.accountId) : null;
  const brand = custom ? await brandShell(env, custom, slug, customLimits!) : undefined;
  const v = await findVideo(req, env, "slug", slug, custom);
  if (v === "removed") return removedPage(env, url.origin);
  if (!v) return notFound(env, url.origin, brand);
  const { rec } = v;
  const id = rec.id;
  const by = await accountByline(env.DB, rec.account_id);
  // Self-links on a customer host are https://<hostname>/<slug>: /<username>/v/<slug> doesn't exist there.
  const canonical = custom ? `https://${custom.hostname}/${slug}` : undefined;
  if (!custom && username !== by.username) {
    if (rec.shared_at === null || req.method !== "GET") return notFound(env, url.origin);
    return new Response(null, { status: 301, headers: { ...REDIRECT_HEADERS, location: `/${by.username}/v/${slug}${url.search}` } });
  }
  const share = await shareRow(env, id);
  const title = rec.title || (custom ? "Video" : defaultTitle(env));
  const origin = url.origin;
  const description = brand
    ? [...(rec.description ?? "").replace(/\s+/g, " ").trim()].slice(0, DESCRIPTION_MAX).join("") || `A video from ${brand.siteName}.`
    : rec.shared_at === null
      ? privateDesc(env)
      : rec.transcript_status === "ready"
        ? `A screen recording${sharedWith(env)}, with a timestamped transcript. Click any line to jump to that moment.`
        : siteDesc(env);
  const msg = (status: number, heading: string, html: string) => page(env, origin, { title, description, status, brand, body: message(env, heading, html, brand) });

  // Link-preview bots: meta + title only, counted as a preview (not a view), no media token, no player and no media URL.
  // The only absolute URL is the static og:image on the host the bot asked (the URL works on every host).
  if (isLinkPreview(req.headers.get("user-agent"))) {
    await countPreview(env, id);
    return page(env, origin, { title, description, canonical, brand, body: `<h1>${esc(title)}</h1>` });
  }

  // custom-host.ts sends passcode videos to our own host; a passcode set since then: the same 404 as anything else.
  if (custom && share.passcode_hash) return notFound(env, origin, brand);
  // The owner never needs the passcode.
  if (share.passcode_hash && !v.owner) {
    const t = now();
    if (share.locked_until && share.locked_until > t) {
      return msg(429, "Too many wrong passcodes", "<p>Try again in a few minutes.</p>");
    }
    if (req.method !== "POST") return passcodeForm(env, origin, title, description, url, false);
    const form = await req.formData().catch(() => null);
    const given = String(form?.get("passcode") ?? "").slice(0, 128);
    const ok = safeEqual(await pbkdf2(given, share.passcode_salt!), share.passcode_hash);
    if (!ok) {
      const fails = share.failed_attempts + 1;
      const lock = fails >= LIMITS.passcodeMaxFailures ? t + LIMITS.passcodeLockSeconds : null;
      await env.DB.prepare("UPDATE shares SET failed_attempts = ?, locked_until = ? WHERE recording_id = ?")
        .bind(lock ? 0 : fails, lock, id)
        .run();
      return lock
        ? msg(429, "Too many wrong passcodes", "<p>Try again in a few minutes.</p>")
        : passcodeForm(env, origin, title, description, url, true);
    }
    await env.DB.prepare("UPDATE shares SET failed_attempts = 0, locked_until = NULL WHERE recording_id = ?").bind(id).run();
  }

  // The owner is never view-capped. Viewers are counted by a salted hash of the IP only. A video of an Owner-tier
  // account (accountLimits) has no per-video ceiling; its viewers still get the per-viewer cap.
  const limits = customLimits ?? (await accountLimits(env, rec.account_id));
  if (!v.owner) {
    const viewer = (await hmacHex(env.IP_HASH_KEY, `ip:${clientIp(req)}`)).slice(0, 32);
    const perVideo = limits.tier === "owner" ? Number.POSITIVE_INFINITY : LIMITS.viewsPerVideoPerDay;
    const cap = await governor(env).checkView(id, viewer, now(), LIMITS.viewsPerViewerPerVideoPerDay, perVideo);
    if (cap === "viewer") {
      return msg(429, "Too many reloads", "<p>You've opened this video too many times today. Try again tomorrow.</p>");
    }
    if (cap === "video") {
      return msg(429, "Daily view limit reached", "<p>This video has been watched as often as it can be today. Try again tomorrow.</p>");
    }
  }

  const exp = now() + LIMITS.mediaTokenSeconds;
  const token = await mediaToken(env, id, share.version, exp);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  const setCookie = [`mt=${token}; Path=/m/${slug}; Max-Age=${LIMITS.mediaTokenSeconds}; HttpOnly; SameSite=Strict${secure}`];

  // Owner views carry no view token, so nothing on this page can count them.
  const vt = v.owner ? null : await viewToken(env, id);

  let segments: Segment[] = [];
  try {
    segments = rec.transcript ? (JSON.parse(rec.transcript).segments ?? []) : [];
  } catch {
    segments = [];
  }
  // Comments exist only while the video is shared, and never on a custom host.
  const cm = rec.shared_at === null || custom ? null : await commentsSection(req, env, { id, accountId: rec.account_id, owner: v.owner, version: share.version, by });
  // The owner's Share popover (our own host only) offers the link the tools hand out: on the account's live custom
  // domain if it has one (whatever the video's state), else this URL.
  const publicUrl = custom
    ? canonical!
    : v.owner
      ? (await customVideoUrl(env, rec.account_id, slug)) ?? `${origin}/${by.username}/v/${slug}`
      : `${origin}/${by.username}/v/${slug}`;
  const stats = v.owner ? await ownerStatsHtml(env, id) : "";
  // The Free watermark never shows on a customer host (custom domains are a paid feature anyway), nor without BRAND_NAME.
  const wm = !custom && limits.watermark && branded(env);
  const download = canDownload(v.owner, limits.tier) ? `/${by.username}/v/${slug}/download` : null;
  const body = `${metaHtml(env, rec, title, v.owner, by.shown, segments, publicUrl, rec.shared_at !== null, download)}${stats}
${rec.shared_at === null ? '<p class="chip" id="priv">Private: only you can see this video</p>' : ""}${v.owner ? '<p class="chip">Owner view: not counted in view stats</p>' : ""}<div class="layout">${playerHtml(slug, vt, wm ? watermark(getConfig(env).site.homeUrl) : null)}
${transcriptHtml(segments, rec.transcript_status)}</div>${cm ? `
${cm.html}` : ""}`;
  return page(env, origin, {
    title,
    description,
    body,
    private: rec.shared_at === null,
    player: true,
    editor: v.owner,
    comments: !!cm,
    turnstile: cm?.turnstile,
    canonical,
    brand,
    extra: { "set-cookie": setCookie },
  });
}

/**
 * GET/POST /<username>/v/<slug>/comments, DELETE /<username>/v/<slug>/comments/<id> (comments.ts). POST and DELETE are
 * same-origin only. Unless the video is shared, visible and at this username: the page's generic 404.
 */
export async function handleComments(req: Request, env: Env, username: string, slug: string, commentId: string | null): Promise<Response> {
  const origin = new URL(req.url).origin;
  if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "forbidden" }, 403);
  const v = await visibleVideo(req, env, "slug", slug);
  if (!v || v.rec.shared_at === null) return notFound(env, origin);
  const by = await accountByline(env.DB, v.rec.account_id);
  if (username !== by.username) return notFound(env, origin);
  const share = await shareRow(env, v.rec.id);
  return handleCommentsApi(req, env, { id: v.rec.id, accountId: v.rec.account_id, owner: v.owner, version: share.version, by }, commentId, () =>
    notFound(env, origin),
  );
}

const SHARE_ICON =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';
const PEN_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>';

/**
 * Owner only: the Share pill and its popover (meta.js opens it and copies). url is the video's clean public URL (what
 * the MCP share tool returns: no ?ot=, no query at all). While the video is private (shared false) the popover looks the
 * same, but Copy link first POSTs ./share (makes it public) and copies the URL that returns.
 */
function shareHtml(url: string, shared: boolean): string {
  return `<div class="shr-w"><button type="button" class="shr" id="shr" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop">${SHARE_ICON}Share</button>
<div class="pop" id="pop" role="dialog" aria-labelledby="pop-h" hidden><p class="pop-h" id="pop-h">Share this video</p>
<div class="pop-row"><input id="pop-url" class="pop-url" type="text" readonly value="${esc(url)}" aria-label="Public link"><button type="button" class="cpb" id="cpb"${shared ? "" : ' data-private="1"'}>Copy link</button></div>
<p class="pop-n">Anyone with the link can watch</p><span id="pop-live" class="sr" aria-live="polite"></span></div></div>`;
}

const DOWNLOAD_ICON =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';

/**
 * The one rule for handing out the video file: its owner, on Pro, Teams or the Owner tier. Free never gets it: not the
 * page's Download, not ./download, not get_recording_for_skill's video.url, not /m/<slug>/file.
 */
export const canDownload = (owner: boolean, tier: Tier) => owner && tier !== "free";

/** Owner on a paid tier only: the Download pill next to Share, a plain link to ./download (works without script). */
function downloadHtml(href: string): string {
  return `<a class="shr dlb" id="dlb" href="${esc(href)}" download>${DOWNLOAD_ICON}Download</a>`;
}

/**
 * Content-Disposition for a download: attachment, an ASCII filename from the title (path, quote and control characters
 * dropped; `fallback` when nothing is left) and the cleaned UTF-8 title as filename* (RFC 6266/5987).
 */
export function downloadDisposition(title: string | null, fallback = "recitbot-recording"): string {
  const edges = (s: string) => s.replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  const clean = edges([...edges((title ?? "").replace(/[\p{Cc}\\/:*?"<>|]+/gu, " "))].slice(0, 100).join(""));
  const ascii = edges(clean.normalize("NFKD").replace(/[^A-Za-z0-9 ._-]+/g, "")) || fallback;
  const utf8 = encodeURIComponent(`${clean || ascii}.mp4`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${utf8}`;
}

/**
 * Owner only: the video's view stats, from the same counters and query the MCP get_stats tool reads (stats.ts). Views
 * and unique viewers always; average completion only once there are counted views. No watch time: it isn't recorded.
 */
async function ownerStatsHtml(env: Env, id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id AS recording_id, views, unique_views, last_viewed_at, previews FROM recordings WHERE id = ?")
    .bind(id)
    .first<StatsRow>();
  if (!row) return "";
  const [s] = await withWatchPct(env, [row]);
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  const items = [n(s.views, "view", "views"), n(s.unique_views, "unique viewer", "unique viewers")];
  if (s.avg_watch_pct !== null) items.push(`${s.avg_watch_pct}% average completion`);
  return `
<ul class="vstats" id="vstats" aria-label="View stats">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
}

/** Display-only default description: the first transcript segment, trimmed, capped at DESCRIPTION_MAX characters. */
function defaultDescription(segments: Segment[]): string {
  return [...(segments[0]?.text ?? "").trim()].slice(0, DESCRIPTION_MAX).join("").trim();
}

/**
 * Title row (title, byline, owner's Download on paid tiers, owner's Share) + description. Everyone sees the same plain text; the owner also gets pencil
 * buttons and meta.js, which makes the text contenteditable in place and saves it to ./meta. An unset description shows
 * the first transcript line (never stored). All of it is escaped here; meta.js only ever sets .textContent.
 */
function metaHtml(env: Env, rec: VideoRow, title: string, owner: boolean, shown: string, segments: Segment[], url: string, shared: boolean, download: string | null): string {
  const desc = rec.description || defaultDescription(segments);
  // The transcript-line fallback: muted for the owner so it reads as a placeholder; viewers see it as plain text.
  const fb = !rec.description && desc ? " fb" : "";
  const by = `<span class="by"><span class="av" aria-hidden="true">${esc([...shown][0]?.toUpperCase() ?? "?")}</span>Recorded by ${esc(shown)}</span>`;
  if (!owner) {
    return `<div class="vtitle"><h1>${esc(title)}</h1>${by}</div>${desc ? `
<p class="desc">${esc(desc)}</p>` : ""}`;
  }
  return `<div class="meta" id="meta"><div class="vtitle"><span class="tl"><h1 id="ttl" class="ed" data-max="${TITLE_MAX}" data-default="${defaultTitle(env)}">${esc(rec.title || defaultTitle(env))}</h1><button type="button" class="pen" id="ttl-pen" aria-label="Edit title">${PEN_ICON}</button></span>${by}${download ? downloadHtml(download) : ""}${shareHtml(url, shared)}</div>
<div class="dl"><p class="desc ed${fb}" id="desc" data-max="${DESCRIPTION_MAX}" data-placeholder="Add a description">${esc(desc)}</p><button type="button" class="pen" id="desc-pen" aria-label="Edit description">${PEN_ICON}</button></div>
<p id="meta-st" class="st" aria-live="polite"></p></div>`;
}

/**
 * PATCH /<username>/v/<slug>/meta — the owner (isOwner: web session or this video's owner cookie) edits title and/or
 * description ({title?, description?} JSON). Same-origin only (Origin must be this origin). Not the owner, wrong
 * username or no such video: the same generic 404. Invalid input: 400 with the error.
 */
export async function handleVideoMeta(req: Request, env: Env, username: string, slug: string): Promise<Response> {
  const notFound = () => json({ error: "not found" }, 404);
  if (req.headers.get("origin") !== new URL(req.url).origin) return json({ error: "forbidden" }, 403);
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ error: "forbidden" }, 403);
  const rec = await env.DB.prepare("SELECT id, account_id, owner_version FROM recordings WHERE slug = ?")
    .bind(slug)
    .first<{ id: string; account_id: string; owner_version: number }>();
  if (!rec || !(await isOwner(req, env, rec))) return notFound();
  const accountId = rec.account_id;
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "expected application/json" }, 415);
  const text = await req.text();
  if (text.length > 4096) return json({ error: "too large" }, 413);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "expected an object" }, 400);
  const v = validateVideoMeta(input as VideoMetaInput);
  if (!v.ok) return json({ error: v.error }, 400);
  if ((await accountByline(env.DB, accountId)).username !== username) return notFound();
  // setVideoMeta validates the raw input again (it takes the request shape, not validateVideoMeta's output).
  const row = await setVideoMeta(env, accountId, rec.id, input as VideoMetaInput);
  if (!row) return notFound();
  return json({ title: row.title, description: row.description });
}

/**
 * POST /<username>/v/<slug>/share — the owner (isOwner) makes the video watchable by anyone with the link, through the
 * same shareRecording the MCP share tool uses (no passcode change, no rotate). Same guards as ./meta: same-origin only
 * (403), not the owner / wrong username / not ready / no such video: 404, taken down or the account suspended
 * (takedown-state.ts): 451 {error: RECORDING_REMOVED | ACCOUNT_SUSPENDED}. Returns {url}, the clean public URL.
 */
export async function handleVideoShare(req: Request, env: Env, username: string, slug: string): Promise<Response> {
  const notFound = () => json({ error: "not found" }, 404);
  const origin = new URL(req.url).origin;
  if (req.headers.get("origin") !== origin) return json({ error: "forbidden" }, 403);
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ error: "forbidden" }, 403);
  const rec = await env.DB.prepare(`SELECT id, account_id, owner_version, status, expires_at, ${retentionHoldCol()} FROM recordings WHERE slug = ?`)
    .bind(slug)
    .first<{ id: string; account_id: string; owner_version: number; status: string; expires_at: number; retention_hold: number }>();
  if (!rec || rec.status !== "ready" || recordingExpired(rec, now()) || !(await isOwner(req, env, rec))) return notFound();
  if ((await accountByline(env.DB, rec.account_id)).username !== username) return notFound();
  const blocked = await sharingBlocked(env, rec.id, rec.account_id);
  if (blocked) return json({ error: blocked }, 451);
  await shareRecording(env, origin, rec.id, rec.account_id);
  return json({ url: (await videoLinks(env, origin, rec.id, rec.account_id, await customVideoBase(env, rec.account_id))).url });
}

/**
 * GET or HEAD /<username>/v/<slug>/download — the MP4 as an attachment, for the video's owner (isOwner, as on the page) when the
 * owner's account is on Pro, Teams or the Owner tier. Same request guards as /m/ (a cross-site request or a foreign
 * Origin: 403). Not visible to this request (private, revoked, expired, nonexistent) or a wrong username: 404. Visible
 * but not the owner, or the owner on Free: 403.
 */
export async function handleVideoDownload(req: Request, env: Env, username: string, slug: string): Promise<Response> {
  const deny = () => new Response("forbidden", { status: 403, headers: SECURITY_HEADERS });
  const missing = () => new Response("not found", { status: 404, headers: SECURITY_HEADERS });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return deny();
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return deny();
  const v = await visibleVideo(req, env, "slug", slug);
  if (!v || (await accountByline(env.DB, v.rec.account_id)).username !== username) return missing();
  if (!canDownload(v.owner, (await accountLimits(env, v.rec.account_id)).tier)) return deny();
  const obj = await env.MEDIA.get(`v/${v.rec.id}.mp4`);
  if (!obj) return missing();
  return new Response(await bodyFor(req, obj), {
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "video/mp4",
      "content-length": String(obj.size),
      "content-disposition": downloadDisposition(v.rec.title, branded(env) ? undefined : "screen-recording"),
    },
  });
}

function passcodeForm(env: Env, origin: string, title: string, description: string, url: URL, wrong: boolean): Response {
  const action = `${url.pathname}?${url.searchParams.toString()}`;
  return page(env, origin, {
    title,
    description,
    status: wrong ? 401 : 200,
    body: message(
      env,
      "This recording needs a passcode",
      `<p>${esc(title)}</p><form method="post" action="${esc(action)}"><label class="sr" for="pc">Passcode</label>
<input id="pc" name="passcode" type="password" autocomplete="off" placeholder="Passcode" required autofocus>
${wrong ? '<p class="err" role="alert">Wrong passcode. Try again.</p>' : ""}<button type="submit" class="btn">Watch</button></form>`,
    ),
  });
}

/**
 * GET /m/<slug> — streams the private R2 object with Range support. Same rule as the page: a private (revoked) or unknown
 * video has no media for anyone but its owner, whatever other cookie comes with the request. It is the page's <video>
 * source, not a download: opened as a document (the URL in a tab) it is refused (403) unless canDownload (the owner of
 * a paid-tier video). Media elements send Sec-Fetch-Dest video, or none at all (older Safari), and still play.
 */
export async function handleMedia(req: Request, env: Env, slug: string): Promise<Response> {
  const deny = () => new Response("forbidden", { status: 403, headers: SECURITY_HEADERS });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return deny();
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return deny();

  const v = await visibleVideo(req, env, "slug", slug);
  if (!v) return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
  const id = v.rec.id;
  const share = await shareRow(env, id);

  const tok = cookie(req, "mt");
  const [expStr, sig] = (tok ?? "").split(".");
  const exp = Number(expStr);
  if (!tok || !Number.isInteger(exp) || exp < now() || exp > now() + LIMITS.mediaTokenSeconds) return deny();
  if (!safeEqual(tok, await mediaToken(env, id, share.version, exp)) || !sig) return deny();
  if (req.headers.get("sec-fetch-dest") === "document" && !canDownload(v.owner, (await accountLimits(env, v.rec.account_id)).tier)) return deny();
  if (serviceMode(env) === "OFF") return new Response("unavailable", { status: 503 });
  return streamVideo(req, env, id);
}

/** A media response's body: the object's stream, or null for HEAD (the stream is cancelled; headers stay as for GET). */
async function bodyFor(req: Request, obj: R2ObjectBody): Promise<ReadableStream | null> {
  if (req.method !== "HEAD") return obj.body;
  await obj.body.cancel();
  return null;
}

/** The recording's MP4 from private R2, with Range support (inline). HEAD: the same status and headers, no body. */
async function streamVideo(req: Request, env: Env, id: string): Promise<Response> {
  const rangeHeader = req.headers.get("range");
  const obj = await env.MEDIA.get(`v/${id}.mp4`, rangeHeader ? { range: req.headers } : undefined);
  if (!obj) return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "content-type": "video/mp4",
    "content-disposition": "inline",
    "accept-ranges": "bytes",
  };
  const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (rangeHeader && r) {
    const offset = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - offset);
    headers["content-range"] = `bytes ${offset}-${offset + length - 1}/${obj.size}`;
    headers["content-length"] = String(length);
    return new Response(await bodyFor(req, obj), { status: 206, headers });
  }
  headers["content-length"] = String(obj.size);
  return new Response(await bodyFor(req, obj), { status: 200, headers });
}

// ---------- get_recording_for_skill (learn-tools.ts) ----------

/** A Recitbot video URL's slug (/<username>/v/<slug>) or legacy /v/<id> id; null = not a video URL. ?ot= is ignored. */
export function parseVideoRef(raw: string): { slug: string } | { id: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const m = /^\/[A-Za-z0-9-]{1,64}\/v\/([A-Za-z0-9]{10,40})\/?$/.exec(u.pathname);
  if (m) return { slug: m[1] };
  const legacy = /^\/v\/([A-Za-z0-9]{20,30})\/?$/.exec(u.pathname);
  return legacy ? { id: legacy[1] } : null;
}

export type SkillVideo = {
  id: string;
  account_id: string;
  slug: string | null;
  title: string | null;
  description: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  retention_hold: number;
  duration_s: number | null;
  transcript: string | null;
  transcript_status: string;
};

/**
 * The recording get_recording_for_skill may read for this account, with the watch page's rule: the account's own
 * recording (by id or URL), or, by URL only, another account's video that is ready, unexpired and shared, i.e. what
 * opens for anyone with that URL. A private video of another account, a revoked URL (its slug is gone) and a bare id
 * of someone else's video are all null, like nonexistent. passcode = shared with a passcode (the page asks viewers for it).
 */
export async function skillVideo(env: Env, accountId: string, ref: { slug: string } | { id: string }): Promise<{ rec: SkillVideo; own: boolean; passcode: boolean } | null> {
  const [where, key] = "slug" in ref ? ["slug", ref.slug] : ["id", ref.id];
  const rec = await env.DB.prepare(
    `SELECT id, account_id, slug, shared_at, title, description, status, created_at, expires_at, ${retentionHoldCol()}, duration_s, transcript, transcript_status FROM recordings WHERE ${where} = ?`,
  )
    .bind(key)
    .first<SkillVideo & { shared_at: number | null }>();
  if (!rec) return null;
  const { shared_at, ...out } = rec;
  if (rec.account_id === accountId) return { rec: out, own: true, passcode: false };
  if (where !== "slug" || shared_at === null || rec.status !== "ready" || recordingExpired(rec, now())) return null;
  return { rec: out, own: false, passcode: (await shareRow(env, rec.id)).passcode_hash !== null };
}

/** /m/<slug>/file signature: bound to the recording, its current slug and share version (revoking kills it) and exp. */
const fileSig = (env: Env, id: string, slug: string, version: number, exp: number) =>
  hmacB64(env.SHARE_HMAC_KEY, `video-file.${id}.${slug}.${version}.${exp}`);

/** A signed link to the recording's MP4 that a bot can fetch without cookies, for LIMITS.videoFileUrlSeconds. */
export async function videoFileUrl(env: Env, origin: string, id: string, t = now()): Promise<{ url: string; expires_at: number }> {
  const slug = await ensureSlug(env, id);
  const exp = t + LIMITS.videoFileUrlSeconds;
  const sig = await fileSig(env, id, slug, (await shareRow(env, id)).version, exp);
  return { url: `${origin}/m/${slug}/file?e=${exp}&s=${sig}`, expires_at: exp };
}

/**
 * GET or HEAD /m/<slug>/file?e=<exp>&s=<sig> — the MP4 for a link from videoFileUrl (get_recording_for_skill include_video).
 * The signature is the only credential; it dies at exp, on revoke (new slug, new share version) and never fits another
 * recording. Not ready, expired or unknown: 404; bad or expired signature: 403. Only the owner is handed this link, so
 * canDownload is checked again here for the owner: a link to a Free account's video (minted before that rule, or before
 * a downgrade) answers 403 like a bad signature.
 */
export async function handleVideoFile(req: Request, env: Env, slug: string): Promise<Response> {
  const deny = () => new Response("forbidden", { status: 403, headers: SECURITY_HEADERS });
  const rec = await env.DB.prepare(`SELECT id, account_id, status, expires_at, ${retentionHoldCol()} FROM recordings WHERE slug = ?`)
    .bind(slug)
    .first<{ id: string; account_id: string; status: string; expires_at: number; retention_hold: number }>();
  if (!rec || rec.status !== "ready" || recordingExpired(rec, now()) || (await recordingRemoved(env, rec.id, rec.account_id))) {
    return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
  }
  const url = new URL(req.url);
  const e = url.searchParams.get("e");
  const exp = Number(e);
  if (e === null || !Number.isInteger(exp) || exp < now() || exp > now() + LIMITS.videoFileUrlSeconds) return deny();
  const version = (await shareRow(env, rec.id)).version;
  if (!safeEqual(url.searchParams.get("s") ?? "", await fileSig(env, rec.id, slug, version, exp))) return deny();
  if (!canDownload(true, (await accountLimits(env, rec.account_id)).tier)) return deny();
  return streamVideo(req, env, rec.id);
}

export async function setPasscode(env: Env, id: string, passcode: string | null): Promise<void> {
  if (passcode === null) {
    await env.DB.prepare("UPDATE shares SET passcode_hash = NULL, passcode_salt = NULL WHERE recording_id = ?").bind(id).run();
    return;
  }
  const salt = passcodeSalt(getConfig(env).workers.passcodeIterations);
  await env.DB.prepare(
    "UPDATE shares SET passcode_hash = ?, passcode_salt = ?, failed_attempts = 0, locked_until = NULL WHERE recording_id = ?",
  )
    .bind(await pbkdf2(passcode, salt), salt, id)
    .run();
}
