// Owner links and owner rights on the watch page.
//
// owner_url = the video's URL plus ?ot=<token>, handed to the user by the tools and opened by the recorder after an
// upload. Opening one (share.ts ownerLinkRedirect) sets a per-recording owner cookie and redirects to the clean URL, so
// the user who recorded can edit and moderate THAT video without signing in on the web. It is not an account session.
//
// Token  = base64url(JSON {a: account id, v: recording id, ov: owner_version, exp, p: "owner"}) "." base64url(HMAC), 24 h.
// Cookie = one cookie holding up to MAX_ENTRIES [account id, recording id, owner_version, exp] entries (30 days each),
//          newest first, as base64url(JSON) "." base64url(HMAC).
// The key is derived from SHARE_HMAC_KEY under its own label (no new secret), and tokens and cookies sign under different
// prefixes, so neither can stand in for the other or for any other signature. revoke_share bumps owner_version, which
// kills every token and cookie entry issued before.
import type { Env } from "./env";
import { getWebSession } from "./oauth/web-session";
import { isDevHost } from "./oauth/hosts";
import { b64url, cookie, hmacB64, now, safeEqual } from "./util";

export const OWNER_LINK_SECONDS = 24 * 3600;
export const OWNER_COOKIE_SECONDS = 30 * 86400;
const MAX_ENTRIES = 20;
const PURPOSE = "owner";
const MAX_LEN = 3500;
const B64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9]{10,40}$/;

/** What an owner check needs to know about the recording. */
export type OwnedRec = { id: string; account_id: string; owner_version: number };
type Entry = [a: string, v: string, ov: number, exp: number];

const linkKey = (env: Env) => hmacB64(env.SHARE_HMAC_KEY, "owner-link-v1");
const sign = async (env: Env, kind: "ot" | "oc", payload: string) => hmacB64(await linkKey(env), `${kind}.${payload}`);
const enc = (data: unknown) => b64url(new TextEncoder().encode(JSON.stringify(data)));

/** The payload of a well-formed, correctly signed `<payload>.<sig>`, parsed; null for anything else. */
async function opened(env: Env, kind: "ot" | "oc", s: string | null): Promise<unknown> {
  if (!s || s.length > MAX_LEN) return null;
  const parts = s.split(".");
  if (parts.length !== 2 || !B64URL.test(parts[0]) || !B64URL.test(parts[1])) return null;
  if (!safeEqual(parts[1], await sign(env, kind, parts[0]))) return null;
  try {
    const bin = atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** `<url>?ot=<token>`: the owner link for this account's recording at its current owner_version. */
export async function ownerUrl(env: Env, url: string, rec: OwnedRec, t = now()): Promise<string> {
  const payload = enc({ a: rec.account_id, v: rec.id, ov: rec.owner_version, exp: t + OWNER_LINK_SECONDS, p: PURPOSE });
  return `${url}?ot=${payload}.${await sign(env, "ot", payload)}`;
}

/**
 * Does this token grant owner rights on exactly this recording? Well-formed, correctly signed, the owner purpose, not
 * expired, and for this recording of the account that owns it at its current owner_version. The caller checks that the
 * recording exists, is ready and is not expired.
 */
export async function verifyOwnerToken(env: Env, token: string | null, rec: OwnedRec): Promise<boolean> {
  const p = (await opened(env, "ot", token)) as { a?: unknown; v?: unknown; ov?: unknown; exp?: unknown; p?: unknown } | null;
  if (!p || typeof p !== "object" || p.p !== PURPOSE) return false;
  const t = now();
  if (typeof p.exp !== "number" || !Number.isInteger(p.exp) || p.exp < t || p.exp > t + OWNER_LINK_SECONDS) return false;
  return p.v === rec.id && p.a === rec.account_id && p.ov === rec.owner_version;
}

// ---------- the owner cookie ----------

const cookieName = (url: URL) => (isDevHost(url) ? "rb_owner" : "__Host-rb_owner");

/** The cookie's live, well-typed entries (none when it is missing, tampered or malformed). */
async function entries(req: Request, env: Env): Promise<Entry[]> {
  const list = await opened(env, "oc", cookie(req, cookieName(new URL(req.url))));
  if (!Array.isArray(list)) return [];
  const t = now();
  return list
    .filter(
      (e): e is Entry =>
        Array.isArray(e) &&
        e.length === 4 &&
        typeof e[0] === "string" &&
        typeof e[1] === "string" &&
        Number.isInteger(e[2]) &&
        Number.isInteger(e[3]) &&
        e[3] >= t &&
        e[3] <= t + OWNER_COOKIE_SECONDS,
    )
    .slice(0, MAX_ENTRIES);
}

/**
 * Set-Cookie that adds (or refreshes) this recording to the browser's owner cookie: HttpOnly, Secure (but on a loopback
 * dev host), SameSite=Lax so it rides along when the user clicks their own link from elsewhere, Path=/ (the page, its
 * /meta and /comments, /m/ media and the legacy /v/<id> all need it). Oldest entries beyond MAX_ENTRIES drop off.
 */
export async function ownerCookie(req: Request, env: Env, rec: OwnedRec): Promise<string> {
  const url = new URL(req.url);
  const keep = (await entries(req, env)).filter((e) => e[1] !== rec.id);
  if (!ID.test(rec.id) || !ID.test(rec.account_id)) throw new Error("ownerCookie: bad id");
  const entry: Entry = [rec.account_id, rec.id, rec.owner_version, now() + OWNER_COOKIE_SECONDS];
  const list = [entry, ...keep].slice(0, MAX_ENTRIES);
  const payload = enc(list);
  const secure = isDevHost(url) ? "" : " Secure;";
  return `${cookieName(url)}=${payload}.${await sign(env, "oc", payload)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${OWNER_COOKIE_SECONDS}`;
}

/**
 * THE owner check for a recording: the request's web session (/signin) is that recording's account, or the browser holds
 * a live owner-cookie entry for this very recording, of that account, at its current owner_version. Every owner right on
 * the page (seeing it while private, the editor and its PATCH, deleting any comment, commenting without Turnstile, the
 * Owner view chip, media while private) goes through this and nothing else.
 */
export async function isOwner(req: Request, env: Env, rec: OwnedRec): Promise<boolean> {
  if ((await getWebSession(req, env)) === rec.account_id) return true;
  return (await entries(req, env)).some((e) => e[1] === rec.id && e[0] === rec.account_id && e[2] === rec.owner_version);
}
