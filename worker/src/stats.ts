// View stats: counted views, unique viewers, watch depth, link previews and owner exclusion. D1 only.
//
// A view is counted when the player page's script sends its first beacon (POST /v/:id/b) carrying a view token signed
// into that page. Link-preview bots never get a token, HEAD and media (Range) requests never count, and the owner's
// page carries no token at all. Totals are counters on the recording row; each counted view is one video_views row
// whose max_pct later beacons raise. Nothing here stores or logs a raw IP or user agent.
import type { Env } from "./env";
import { LIMITS, serviceMode } from "./env";
import { governor } from "./governor";
import { unexpiredSql } from "./retention-hold";
import { clientIp, hmacB64, hmacHex, now, randomId, safeEqual } from "./util";

const DAY = 86400;

const PREVIEW_UA =
  /(Slackbot|facebookexternalhit|Facebot|Twitterbot|Discordbot|WhatsApp|TelegramBot|LinkedInBot|SkypeUriPreview|Pinterest|redditbot|Applebot|Googlebot|bingbot|Embedly|vkShare|Iframely|preview)/i;

export const isLinkPreview = (ua: string | null) => !!ua && PREVIEW_UA.test(ua);

/** Stats are writes: READ_ONLY (and OFF) record nothing. */
const statsWritable = (env: Env) => {
  const m = serviceMode(env);
  return m === "ON" || m === "NO_TRANSCRIBE";
};

// The owner is whoever isOwner (owner-link.ts) says: signed in on the website or holding the owner link's cookie. Their
// page gets no view token. Never by network: everyone behind the paired PC's public IP (an office, home Wi-Fi, carrier
// NAT) is a real viewer.

/** Remembers the paired PC's public IP (keyed hash): re-pairing and list_devices' this_device match on it. Writes only on change. */
export async function rememberDeviceIp(env: Env, req: Request, deviceId: string): Promise<void> {
  const ipHash = await hmacHex(env.IP_HASH_KEY, `ip:${clientIp(req)}`);
  await env.DB.prepare("UPDATE devices SET ip_hash = ? WHERE id = ? AND ip_hash IS NOT ?").bind(ipHash, deviceId, ipHash).run();
}

// ---------- counting ----------

const viewSig = (env: Env, id: string, vid: string, exp: number) => hmacB64(env.SHARE_HMAC_KEY, `view.${id}.${vid}.${exp}`);

/** `<view id>.<exp>.<sig>`, embedded in a counted player page. */
export async function viewToken(env: Env, id: string): Promise<string> {
  const vid = randomId(96);
  const exp = now() + LIMITS.viewTokenSeconds;
  return `${vid}.${exp}.${await viewSig(env, id, vid, exp)}`;
}

async function viewIdFrom(env: Env, id: string, tok: string): Promise<string | null> {
  const [vid, expStr, sig] = tok.split(".");
  const exp = Number(expStr);
  if (!vid || !sig || !/^[A-Za-z0-9]{10,30}$/.test(vid)) return null;
  if (!Number.isInteger(exp) || exp < now() || exp > now() + LIMITS.viewTokenSeconds) return null;
  return safeEqual(sig, await viewSig(env, id, vid, exp)) ? vid : null;
}

let saltCache: { day: number; salt: string } | null = null;

/** Random salt per UTC day, kept in D1 so every isolate agrees; the cron deletes it after a day. */
async function daySalt(env: Env, day: number): Promise<string> {
  if (saltCache?.day === day) return saltCache.salt;
  await env.DB.prepare("INSERT INTO view_salts (day, salt) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(day, randomId(128)).run();
  const row = await env.DB.prepare("SELECT salt FROM view_salts WHERE day = ?").bind(day).first<{ salt: string }>();
  saltCache = { day, salt: row!.salt };
  return row!.salt;
}

async function smallBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * POST /v/:id/b — body `t=<view token>&p=<0-100>` (navigator.sendBeacon). The first beacon of a view inserts its row and
 * bumps the counters; later ones only raise max_pct. Replays are no-ops (idempotent per view id).
 */
export async function handleBeacon(req: Request, env: Env, id: string): Promise<Response> {
  const res = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return res(403);
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return res(403);
  const text = await smallBody(req, 256);
  if (text === null) return res(413);
  const body = new URLSearchParams(text);
  const vid = await viewIdFrom(env, id, body.get("t") ?? "");
  if (!vid) return res(403);
  const p = Number(body.get("p") ?? "0");
  if (!Number.isInteger(p) || p < 0 || p > 100) return res(400);
  if (isLinkPreview(req.headers.get("user-agent")) || !statsWritable(env)) return res(204);

  const t = now();
  try {
    if (!(await governor(env).hit(`beacon:${vid}`, LIMITS.beaconsPerViewPerHour, 3600, t)).ok) return res(429);
  } catch {
    return res(503); // fail closed: nothing is written without the rate limiter
  }
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 512);
  const viewer = (await hmacHex(env.IP_HASH_KEY, `viewer.${await daySalt(env, Math.floor(t / DAY))}.${id}.${clientIp(req)}.${ua}`)).slice(0, 32);
  // One transaction. changes() = 1 only when this beacon inserted the view, so counters move once per view id; the view
  // is unique when it is the first row for this viewer hash (which changes daily) on this recording.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO video_views (id, recording_id, viewer_hash, created_at) " +
        `SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM recordings WHERE id = ?2 AND status = 'ready' AND ${unexpiredSql("?4")})`,
    ).bind(vid, id, viewer, t),
    env.DB.prepare(
      "UPDATE recordings SET views = views + 1, last_viewed_at = ?3, unique_views = unique_views + " +
        "(SELECT count(*) = 1 FROM video_views WHERE recording_id = ?1 AND viewer_hash = ?2) WHERE id = ?1 AND changes() = 1",
    ).bind(id, viewer, t),
    env.DB.prepare("UPDATE video_views SET max_pct = ?1 WHERE id = ?2 AND recording_id = ?3 AND max_pct < ?1").bind(p, vid, id),
  ]);
  return res(204);
}

/** A link-preview bot fetched the page: counted separately, capped per video per day, never as a view. */
export async function countPreview(env: Env, id: string): Promise<void> {
  if (!statsWritable(env)) return;
  try {
    if (!(await governor(env).hit(`previews:${id}`, LIMITS.previewsPerVideoPerDay, DAY, now())).ok) return;
  } catch {
    return;
  }
  await env.DB.prepare("UPDATE recordings SET previews = previews + 1 WHERE id = ?").bind(id).run();
}

// The sender is worker/web/player.js: one beacon on load (counts the view), then 25/50/75/100 % as playback passes
// them, 100 on ended, and the furthest point on pagehide.

// ---------- reading ----------

export type StatsRow = {
  recording_id: string;
  views: number;
  unique_views: number;
  last_viewed_at: number | null;
  previews: number;
};

/** Adds avg_watch_pct (mean furthest point reached over counted views; null without views). One read for all rows. */
export async function withWatchPct<T extends StatsRow>(env: Env, rows: T[]): Promise<(T & { avg_watch_pct: number | null })[]> {
  const ids = rows.filter((r) => r.views > 0).map((r) => r.recording_id);
  const avg = new Map<string, number>();
  if (ids.length) {
    const r = await env.DB.prepare(
      `SELECT recording_id, round(avg(max_pct)) AS a FROM video_views WHERE recording_id IN (${ids.map(() => "?").join(",")}) GROUP BY recording_id`,
    )
      .bind(...ids)
      .all<{ recording_id: string; a: number }>();
    for (const x of r.results) avg.set(x.recording_id, x.a);
  }
  return rows.map((r) => ({ ...r, avg_watch_pct: avg.get(r.recording_id) ?? null }));
}

export const isoDay = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);

/** Per UTC day, newest first, last LIMITS.statsDays days; days without views are omitted. */
export async function dailyStats(env: Env, id: string, t = now()) {
  const since = (Math.floor(t / DAY) - LIMITS.statsDays + 1) * DAY;
  const r = await env.DB.prepare(
    "SELECT created_at / 86400 AS day, count(*) AS views, count(DISTINCT viewer_hash) AS unique_views, round(avg(max_pct)) AS avg_watch_pct " +
      "FROM video_views WHERE recording_id = ? AND created_at >= ? GROUP BY day ORDER BY day DESC",
  )
    .bind(id, since)
    .all<{ day: number; views: number; unique_views: number; avg_watch_pct: number }>();
  return r.results.map(({ day, ...x }) => ({ date: isoDay(day), ...x }));
}

// ---------- search ----------

/** Relevance of a video to a free-text query: whole query in the title, then per-word hits in title and transcript. */
export function relevance(query: string, title: string | null, transcript: string): number {
  const q = query.toLowerCase().trim();
  const words = queryWords(q);
  if (!words.length) return 0;
  const ti = (title ?? "").toLowerCase();
  const tx = transcript.toLowerCase();
  let score = ti.includes(q) ? 10 : words.length > 1 && tx.includes(q) ? 4 : 0;
  for (const w of words) {
    if (ti.includes(w)) score += 3;
    score += Math.min(tx.split(w).length - 1, 3);
  }
  return score;
}

/** The query's distinct words (letters and digits only, so `%`, `_` and other symbols never match anything). */
const queryWords = (query: string) => [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];

export type MatchedIn = "title" | "description" | "transcript";
const TIERS: Record<MatchedIn, number> = { title: 3, description: 2, transcript: 1 };

/**
 * Where a video matches a query, case-insensitively (the best field: title, then description, then transcript), and how
 * well (relevance over all three). null = no query word occurs anywhere.
 */
export function searchHit(
  query: string,
  v: { title: string | null; description: string | null; transcript: string },
): { matched_in: MatchedIn; score: number } | null {
  const words = queryWords(query);
  const has = (s: string | null) => !!s && words.some((w) => s.toLowerCase().includes(w));
  const matched_in: MatchedIn | null = has(v.title) ? "title" : has(v.description) ? "description" : has(v.transcript) ? "transcript" : null;
  if (!matched_in) return null;
  return { matched_in, score: relevance(query, v.title, `${v.description ?? ""} ${v.transcript}`) };
}

/** Search order: title matches, then description, then transcript-only; better score first; then newest first. */
export const searchOrder = (
  x: { matched_in: MatchedIn; score: number; created_at: number },
  y: { matched_in: MatchedIn; score: number; created_at: number },
) => TIERS[y.matched_in] - TIERS[x.matched_in] || y.score - x.score || y.created_at - x.created_at;

export function transcriptText(raw: string | null): string {
  if (!raw) return "";
  try {
    return ((JSON.parse(raw) as { segments?: { text: string }[] }).segments ?? []).map((s) => s.text).join(" ");
  } catch {
    return "";
  }
}
