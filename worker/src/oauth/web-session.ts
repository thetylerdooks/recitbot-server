// Browser sign-in sessions: a random 256-bit token in an HttpOnly cookie (__Host-rb_session; rb_session on loopback dev
// hosts, which are plain http), stored only as its SHA-256 in web_sessions. A session ends 30 days after sign-in, or
// after 7 idle days. getWebSession only reads (it can't set cookies); the sign-in pages (/signin, /oauth/authorize)
// rotate a token older than 24 h, and the replaced token keeps working for 60 s for requests already in flight.
import type { Env } from "../env";
import { cookie, now, randomId, sha256Hex } from "../util";
import { isDevHost } from "./hosts";

const ABSOLUTE_TTL = 30 * 86400;
const IDLE_TTL = 7 * 86400;
const ROTATE_AFTER = 86400;
const ROTATE_GRACE = 60;
/** last_seen_at is written at most this often per session. */
const TOUCH_EVERY = 300;
const NEXT_MAX = 512;

type Row = { id: string; account_id: string; created_at: number; last_seen_at: number; expires_at: number; rotated_from: string | null };

const cookieName = (url: URL) => (isDevHost(url) ? "rb_session" : "__Host-rb_session");
const cookieHeader = (url: URL, value: string, maxAge: number) =>
  `${cookieName(url)}=${value}; Path=/; HttpOnly; ${isDevHost(url) ? "" : "Secure; "}SameSite=Lax; Max-Age=${maxAge}`;

async function find(req: Request, env: Env): Promise<Row | null> {
  const token = cookie(req, cookieName(new URL(req.url)));
  if (!token || !/^[A-Za-z0-9]{40,60}$/.test(token)) return null;
  const t = now();
  const row = await env.DB.prepare(
    "SELECT id, account_id, created_at, last_seen_at, expires_at, rotated_from FROM web_sessions " +
      "WHERE token_hash = ? AND expires_at > ? AND last_seen_at > ? AND (revoked_at IS NULL OR revoked_at > ?)",
  )
    .bind(await sha256Hex(token), t, t - IDLE_TTL, t)
    .first<Row>();
  if (row && t - row.last_seen_at >= TOUCH_EVERY) await env.DB.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE id = ?").bind(t, row.id).run();
  return row;
}

/** The signed-in account id for this request's session cookie; null when there is none or it is invalid, expired or revoked. */
export async function getWebSession(req: Request, env: Env): Promise<string | null> {
  return (await find(req, env))?.account_id ?? null;
}

async function create(env: Env, url: URL, accountId: string, expiresAt?: number, rotatedFrom?: string): Promise<string> {
  const token = randomId(256);
  const t = now();
  const end = expiresAt ?? t + ABSOLUTE_TTL;
  await env.DB.prepare(
    "INSERT INTO web_sessions (id, token_hash, account_id, created_at, last_seen_at, expires_at, rotated_from) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(128), await sha256Hex(token), accountId, t, t, end, rotatedFrom ?? null)
    .run();
  return cookieHeader(url, token, end - t);
}

/** A fresh sign-in in this browser: the session it had is revoked. Returns the Set-Cookie value. */
export async function startWebSession(req: Request, env: Env, url: URL, accountId: string): Promise<string> {
  const current = await find(req, env);
  if (current) await env.DB.prepare("UPDATE web_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), current.id).run();
  return create(env, url, accountId);
}

/**
 * The session, for a sign-in page that can set cookies: a token older than 24 h is rotated (setCookie = the new one; the
 * new token keeps the original 30-day end). Only the request that marks the old token rotated issues a new one.
 */
export async function useWebSession(req: Request, env: Env, url: URL): Promise<{ accountId: string; setCookie?: string } | null> {
  const s = await find(req, env);
  if (!s) return null;
  const t = now();
  if (t - s.created_at < ROTATE_AFTER) return { accountId: s.account_id };
  const won = await env.DB.prepare("UPDATE web_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id")
    .bind(t + ROTATE_GRACE, s.id)
    .first();
  if (!won) return { accountId: s.account_id };
  return { accountId: s.account_id, setCookie: await create(env, url, s.account_id, s.expires_at, s.id) };
}

/** Signs this browser out: its session (and the token it replaced, if still in its grace window) is revoked. Returns the Set-Cookie that clears the cookie. */
export async function endWebSession(req: Request, env: Env, url: URL): Promise<string> {
  const s = await find(req, env);
  if (s) {
    const t = now();
    await env.DB.prepare("UPDATE web_sessions SET revoked_at = ? WHERE id IN (?, ?) AND (revoked_at IS NULL OR revoked_at > ?)")
      .bind(t, s.id, s.rotated_from ?? s.id, t)
      .run();
  }
  return cookieHeader(url, "", 0);
}

/** Sign out everywhere: every session of the account stops working now. */
export async function revokeWebSessions(env: Env, accountId: string): Promise<void> {
  const t = now();
  await env.DB.prepare("UPDATE web_sessions SET revoked_at = ? WHERE account_id = ? AND (revoked_at IS NULL OR revoked_at > ?)").bind(t, accountId, t).run();
}

/**
 * Where to send the browser after sign-in: a same-origin path ("/" or "/" followed by anything but "/" or "\", printable
 * ASCII, at most 512 chars, and still such a path once percent-decoded). Anything else is "/".
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > NEXT_MAX || !/^[\x21-\x7e]+$/.test(raw)) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  for (const s of [raw, decoded]) {
    if ((s !== "/" && !/^\/[^/\\]/.test(s)) || /[\x00-\x1f\x7f]/.test(s)) return "/";
  }
  return raw;
}
