// Requests on a host that isn't ours (hosts.ts classifyHost): a customer's custom video domain, or nothing.
//
// A customer host (custom_domains row, migration 0027) answers an allow-list and 404s everything else, so it never
// aliases /mcp, OAuth, /.well-known, /device, /upload, billing, the homepage, installer files or any owner/comment route:
//   GET|HEAD /<slug>      the account's public video (handleViewer in custom-host mode); not public: 302 to our own host;
//                         taken down (takedown-state.ts): 451 removal page
//   POST     /<slug>/b    view beacon (player.js posts to its page path + /b)
//   GET|HEAD /m/<slug>    media, with the per-host `mt` cookie the page sets (Path=/m/<slug>)
//   GET|HEAD /s/*         the page's static assets
//   GET|HEAD /b/<sha256>  the account's brand images (brandAsset below; 404 while the account is suspended)
//   GET|HEAD /robots.txt, /favicon.ico (302 to the branded favicon, or 404; 404 while the account is suspended)
// Every other method or path: 404 (never 405, so nothing tells routes apart). A slug of another account answers exactly
// like an unknown one. disabled_at = a neutral 451 on every path, whatever the status; 'redirecting' = 301 until
// redirect_until, then 404 (to a customer host that isn't live yet: 302 to our own host instead).
// Responses here never set a cookie other than `mt`, never carry CORS headers, and carry x-robots-tag on every path.
import { hiddenBrandFile, shownBranding } from "./brand-page";
import { getConfig } from "./config";
import { handleBrandAsset } from "./branding";
import type { Env } from "./env";
import { serviceMode } from "./env";
import { classifyHost, normalizeHost } from "./hosts";
import { recordingExpired, retentionHoldCol } from "./retention-hold";
import { handleMedia, handleVideoBeacon, handleViewer, removedPage } from "./share";
import { accountSuspended, recordingRemoved } from "./takedown-state";
import { accountByline } from "./username";
import { now } from "./util";

type DomainRow = {
  account_id: string;
  hostname: string;
  status: string;
  redirect_to: string | null;
  redirect_until: number | null;
  disabled_at: number | null;
};

// ---------- host -> custom_domains row, cached per isolate ----------

const HIT_TTL_MS = 30_000;
/** Unknown hosts are cached too (scanners hit many), but shorter so a new domain goes live quickly. */
const MISS_TTL_MS = 10_000;
const CACHE_MAX = 1000;
const cache = new Map<string, { row: DomainRow | null; until: number }>();

/** Tests (and anything that just changed a row) drop the cache so the next request reads D1. */
export function clearCustomHostCache(): void {
  cache.clear();
}

async function lookupDomain(env: Env, hostname: string): Promise<DomainRow | null> {
  const t = Date.now();
  const hit = cache.get(hostname);
  if (hit && hit.until > t) return hit.row;
  const row = await env.DB.prepare(
    "SELECT account_id, hostname, status, redirect_to, redirect_until, disabled_at FROM custom_domains WHERE hostname = ?",
  )
    .bind(hostname)
    .first<DomainRow>();
  cache.delete(hostname);
  // Oldest first (Map keeps insertion order): drop it when full.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(hostname, { row, until: t + (row ? HIT_TTL_MS : MISS_TTL_MS) });
  return row;
}

// ---------- responses ----------

const NOINDEX = "noindex";
const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": NOINDEX, ...extra },
  });
const notFound = () => plain(404, "Not found\n");
const DISABLED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>Unavailable</title></head><body><p>This page is unavailable.</p></body></html>\n";
/** A disabled (taken down) host, every path and method: the same neutral page, nothing of the customer's, no reason. */
const disabled = (req: Request) =>
  new Response(req.method === "HEAD" ? null : DISABLED_PAGE, {
    status: 451,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "referrer-policy": "no-referrer",
    },
  });
const redirect = (status: 301 | 302, location: string) =>
  new Response(null, {
    status,
    headers: { location, "cache-control": status === 301 ? "public, max-age=3600" : "no-store", "x-robots-tag": NOINDEX, "referrer-policy": "no-referrer" },
  });
const ROBOTS = "User-agent: *\nDisallow: /m/\n";

/** Our own links: config.ts canonicalBaseUrl (never the customer host the request came in on). null = not configured. */
const ourBase = (env: Env) => getConfig(env).site.canonicalBaseUrl;

/** Path forms that could mean something else to another layer: rejected before any matching. */
const BAD_PATH = /\/\/|%2f|%5c|\\|\/\.\.|%2e%2e/i;
const SLUG = "([A-Za-z0-9]{10,40})";
const PAGE_PATH = new RegExp(`^/${SLUG}$`);
const BEACON_PATH = new RegExp(`^/${SLUG}/b$`);
const MEDIA_PATH = new RegExp(`^/m/${SLUG}$`);
const BRAND_PATH = /^\/b\/([0-9a-f]{64})$/;
/** A plain hostname (custom_domains.redirect_to), nothing that could change the Location's meaning. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * GET|HEAD /b/<64 lowercase hex sha256>: the domain's account's brand images only (brand_assets.account_id), served by
 * branding.ts handleBrandAsset. A hash of any other account, or any hash while the account is suspended, answers like
 * an unknown one.
 */
async function brandAsset(req: Request, env: Env, domain: DomainRow, sha256: string): Promise<Response> {
  if (await accountSuspended(env, domain.account_id)) return notFound();
  const own = await env.DB.prepare("SELECT 1 AS ok FROM brand_assets WHERE account_id = ? AND hash = ?").bind(domain.account_id, sha256).first();
  return own ? handleBrandAsset(req, env, sha256) : notFound();
}

/** /favicon.ico: 302 to the account's branded favicon (/b/<hash>) while its plan includes branding, else 404 (also while suspended). */
async function favicon(env: Env, domain: DomainRow): Promise<Response> {
  if (await accountSuspended(env, domain.account_id)) return notFound();
  const hash = (await shownBranding(env, domain.account_id))?.favicon?.hash;
  return hash && /^[0-9a-f]{64}$/.test(hash) ? redirect(302, `/b/${hash}`) : notFound();
}

/** A customer host that serves pages now: its row is active, not disabled, and the same account's. */
async function liveHost(env: Env, hostname: string, accountId: string): Promise<boolean> {
  const row = await lookupDomain(env, hostname);
  return !!row && row.account_id === accountId && row.status === "active" && row.disabled_at === null;
}

type Rec = { id: string; account_id: string; shared_at: number | null; status: string; expires_at: number; retention_hold: number; passcode_hash: string | null };

/** The recording with this slug when it belongs to the domain's account; null otherwise (same answer as unknown). */
async function accountRecording(env: Env, domain: DomainRow, slug: string): Promise<Rec | null> {
  const rec = await env.DB.prepare(
    `SELECT r.id, r.account_id, r.shared_at, r.status, r.expires_at, ${retentionHoldCol("r.account_id")}, s.passcode_hash FROM recordings r ` +
      "LEFT JOIN shares s ON s.recording_id = r.id WHERE r.slug = ?",
  )
    .bind(slug)
    .first<Rec>();
  return rec && rec.account_id === domain.account_id ? rec : null;
}

/** <our host>/<username>/v/<slug>: where private, passcode, not-ready and expired videos send viewers. null = no base configured. */
async function homeUrl(env: Env, accountId: string, slug: string): Promise<string | null> {
  const base = ourBase(env);
  return base ? `${base}/${(await accountByline(env.DB, accountId)).username}/v/${slug}` : null;
}

/** A redirect to the video's URL on our own host, or 404 when no base is configured. */
const toHome = async (env: Env, status: 301 | 302, accountId: string, slug: string) => {
  const url = await homeUrl(env, accountId, slug);
  return url ? redirect(status, url) : notFound();
};

/**
 * 'redirecting' rows: 301 for GET/HEAD while redirect_until is in the future, else 404. To another customer hostname
 * only once that one is live (active, not disabled, same account); until then (the customer hasn't added its CNAME yet)
 * /<slug> of this account goes to its URL on our own host with a 302 and every other path 404s, so no link breaks.
 * redirect_to = the canonical host (config.ts canonicalHost) means "back to our own host"; any other host of ours 404s.
 */
async function redirecting(req: Request, env: Env, domain: DomainRow, path: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();
  if (domain.redirect_until === null || domain.redirect_until <= now() || !domain.redirect_to) return notFound();
  const to = normalizeHost(domain.redirect_to);
  const back = async (status: 301 | 302) => {
    const m = PAGE_PATH.exec(path);
    const rec = m ? await accountRecording(env, domain, m[1]) : null;
    return rec ? toHome(env, status, domain.account_id, m![1]) : notFound();
  };
  if (to === getConfig(env).site.canonicalHost) return back(301);
  // Only to another customer domain: never to one of our hosts' routes, never to a reserved name.
  if (!HOSTNAME.test(to) || classifyHost(to, env) !== "customer") return notFound();
  if (!(await liveHost(env, to, domain.account_id))) return back(302);
  return redirect(301, `https://${to}${path}`);
}

/** The allow-list for 'pending' and 'active' hosts. */
async function serve(req: Request, env: Env, domain: DomainRow, url: URL): Promise<Response> {
  const p = url.pathname;
  const read = req.method === "GET" || req.method === "HEAD";
  let m: RegExpExecArray | null;

  if ((m = PAGE_PATH.exec(p)) && read) {
    const slug = m[1];
    const rec = await accountRecording(env, domain, slug);
    if (!rec) return notFound();
    // Taken down (takedown-state.ts): the 451 removal page here, whatever else is true of it.
    if (await recordingRemoved(env, rec.id, rec.account_id)) return removedPage(env, url.origin);
    // Anything a viewer can't just watch (private, owner-only, passcode, not ready, expired) goes to our own host, so any
    // sign-in or passcode happens there, never on a customer domain. The tools hand out this host's URL for every video
    // of a live domain (share.ts videoLinks), whatever its state: this redirect is what makes that safe.
    if (rec.shared_at === null || rec.passcode_hash !== null || rec.status !== "ready" || recordingExpired(rec, now())) {
      return toHome(env, 302, domain.account_id, slug);
    }
    // HEAD never renders (and so never counts a view or sets a media cookie).
    if (req.method === "HEAD") {
      return new Response(null, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive" } });
    }
    // No username in a custom-host URL: handleViewer skips that check in custom-host mode.
    return handleViewer(req, env, "", slug, { customHost: { hostname: domain.hostname, accountId: domain.account_id } });
  }
  if ((m = BEACON_PATH.exec(p)) && req.method === "POST") {
    return (await accountRecording(env, domain, m[1])) ? handleVideoBeacon(req, env, m[1]) : notFound();
  }
  if ((m = MEDIA_PATH.exec(p)) && read) {
    return (await accountRecording(env, domain, m[1])) ? handleMedia(req, env, m[1]) : notFound();
  }
  if (p.startsWith("/s/") && read) {
    if (hiddenBrandFile(env, p)) return notFound();
    // Only GET/HEAD and only the conditional/range headers reach the asset server: no cookies, no body.
    const headers = new Headers();
    for (const h of ["accept", "accept-encoding", "if-none-match", "if-modified-since", "range"]) {
      const v = req.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    const res = await env.ASSETS.fetch(new Request(url.origin + p, { method: req.method, headers }));
    if (res.status === 404 || (res.status >= 300 && res.status < 400 && res.status !== 304)) {
      await res.body?.cancel();
      return notFound();
    }
    return res;
  }
  if ((m = BRAND_PATH.exec(p)) && read) return brandAsset(req, env, domain, m[1]);
  if (p === "/robots.txt" && read) {
    return new Response(req.method === "HEAD" ? null : ROBOTS, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
    });
  }
  if (p === "/favicon.ico" && read) return favicon(env, domain);
  return notFound();
}

/**
 * Every response on a customer host: no cookie but the per-path `mt` media cookie, no CORS headers, and x-robots-tag
 * (noindex) when the handler didn't set a stricter one.
 */
function sealed(res: Response): Response {
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
  const cookies = out.headers.getSetCookie();
  out.headers.delete("set-cookie");
  for (const c of cookies) if (/^mt=/.test(c)) out.headers.append("set-cookie", c);
  for (const k of [...out.headers.keys()]) if (k.startsWith("access-control-")) out.headers.delete(k);
  if (!out.headers.has("x-robots-tag")) out.headers.set("x-robots-tag", NOINDEX);
  return out;
}

/**
 * The host gate (index.ts fetch, before geoGate, installer assets and route()). null = one of our hosts: route as usual.
 * A reserved name under our zone: 404. A customer host: the allow-list above.
 */
export async function hostGate(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const kind = classifyHost(url.hostname, env);
  if (kind === "ours") return null;
  if (kind === "reserved") return notFound();
  if (serviceMode(env) === "OFF") return plain(503, "Unavailable\n");
  const domain = await lookupDomain(env, normalizeHost(url.hostname));
  // Disabled first, whatever the status (a purged row is 'failed' and still disabled) and whatever the path or method.
  if (domain && domain.disabled_at !== null) return disabled(req);
  if (!domain || domain.status === "failed") return notFound();
  if (BAD_PATH.test(url.pathname)) return notFound();
  if (domain.status === "redirecting") return redirecting(req, env, domain, url.pathname);
  if (domain.status !== "pending" && domain.status !== "active") return notFound();
  return sealed(await serve(req, env, domain, url));
}
