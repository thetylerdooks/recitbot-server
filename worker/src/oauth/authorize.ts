// Browser sign-in, for an app connecting (/oauth/authorize) and for the website (/signin): an emailed 6-digit code (or
// the magic link in the same email) proves the email. An app then gets consent and a single-use code; the website gets
// a web session and a redirect to `next`. An existing web session skips the email step (consent is still asked). Every
// step is bound to the browser that started it by a cookie; POSTs also need a same-origin request and the CSRF token
// derived from that cookie. Sending an email (or a resend) also needs a Turnstile pass and stays under a global daily cap.
import { z } from "zod";
import { verifyTurnstile } from "../comments";
import { disposableDomain } from "../disposable";
import { getConfig } from "../config";
import type { Env } from "../env";
import { LIMITS, serviceMode } from "../env";
import { governor } from "../governor";
import { clientIp, cookie, hmacB64, hmacHex, ipNet, now, randomId, safeEqual, sha256Hex } from "../util";
import { accountEmail, canonicalEmail, findAccount, findOrCreateAccount, normalizeEmail, signupAllowed } from "./accounts";
import { getClient, isCimdId, isLoopback, markClientUsed, redirectMatches } from "./clients";
import { sendSigninEmail } from "./email";
import { issuerFor, resourceFor, SCOPE, SCOPES } from "./hosts";
import { readForm } from "./http";
import { codePage, consentPage, emailPage, errorPage, page, signoutPage, type Steps } from "./pages";
import { endWebSession, getWebSession, safeNext, startWebSession, useWebSession } from "./web-session";

const PENDING_TTL = 600;
const MAGIC_TTL = 600;
const CODE_TTL = 60;
const MAX_CODE_ATTEMPTS = 5;
const EMAILS_PER_IP_PER_HOUR = 10;
const EMAILS_PER_ADDRESS_PER_HOUR = 5;

type OAuthFields = {
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  resource: string;
  scope: string;
  issuer: string;
};
type Pending = {
  id: string;
  cookie_hash: string;
  email: string | null;
  verified_at: number | null;
  via_session: number;
  account_id: string | null;
  done_at: number | null;
} & (({ kind: "oauth"; next: null } & OAuthFields) | ({ kind: "web"; next: string } & { [K in keyof OAuthFields]: null }));

const cookieName = (id: string) => `rbo_${id}`;
const cookieAttrs = (url: URL) => `Path=/; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
const clearPending = (id: string, url: URL) => `${cookieName(id)}=; Max-Age=0; ${cookieAttrs(url)}`;
const csrfFor = (browserSecret: string, id: string) => hmacB64(browserSecret, `csrf:${id}`);
const clientLabel = (p: { client_name: string | null; client_id: string }) =>
  p.client_name ?? (isCimdId(p.client_id) ? new URL(p.client_id).host : "An app");
const steps = (row: Pending, csrf: string): Steps =>
  row.kind === "web"
    ? { p: row.id, csrf, emailAction: "/signin", codeAction: "/signin" }
    : { p: row.id, csrf, emailAction: "/oauth/authorize/email", codeAction: "/oauth/authorize/code" };

function redirect(location: string, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

const redirectTo = (uri: string, params: Record<string, string>, status = 302, cookies: string[] = []) =>
  redirect(uri + (uri.includes("?") ? "&" : "?") + new URLSearchParams(params).toString(), status, cookies);

/**
 * The pages send Referrer-Policy: no-referrer, so a same-origin form POST may carry Origin: null; Sec-Fetch-Site decides
 * then, and a same-origin Referer for browsers that send neither.
 */
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return origin === url.origin;
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const referer = req.headers.get("referer");
  return !!referer && URL.canParse(referer) && new URL(referer).origin === url.origin;
}

export async function netHashes(req: Request, env: Env): Promise<{ ipHash: string; netHash: string }> {
  const ip = clientIp(req);
  return { ipHash: await hmacHex(env.IP_HASH_KEY, `ip:${ip}`), netHash: await hmacHex(env.IP_HASH_KEY, `net:${ipNet(ip)}`) };
}

type NewPending = ({ kind: "oauth" } & OAuthFields) | { kind: "web"; next: string };

/** Starts a sign-in in this browser. `signedIn` = already signed in with a web session (the email step is skipped). */
async function createPending(
  env: Env,
  url: URL,
  p: NewPending,
  signedIn?: { accountId: string; email: string },
): Promise<{ id: string; csrf: string; cookie: string }> {
  const id = randomId(128);
  const secret = randomId(256);
  const t = now();
  const o = p.kind === "oauth" ? p : null;
  await env.DB.prepare(
    "INSERT INTO oauth_pending (id, kind, cookie_hash, client_id, client_name, redirect_uri, state, code_challenge, resource, scope, issuer, next, " +
      "email, verified_at, via_session, account_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      p.kind,
      await sha256Hex(secret),
      o?.client_id ?? null,
      o?.client_name ?? null,
      o?.redirect_uri ?? null,
      o?.state ?? null,
      o?.code_challenge ?? null,
      o?.resource ?? null,
      o?.scope ?? null,
      o?.issuer ?? null,
      p.kind === "web" ? p.next : null,
      signedIn?.email ?? null,
      signedIn ? t : null,
      signedIn ? 1 : 0,
      signedIn?.accountId ?? null,
      t,
      t + PENDING_TTL,
    )
    .run();
  return { id, csrf: await csrfFor(secret, id), cookie: `${cookieName(id)}=${secret}; ${cookieAttrs(url)}` };
}

/** Pending sign-in for this browser. With a form: also the same-origin and CSRF checks. */
async function load(req: Request, env: Env, url: URL, id: string | null, form?: URLSearchParams): Promise<{ row: Pending; csrf: string } | Response> {
  if (form && !sameOrigin(req, url)) return errorPage(env, "This request came from another site and was blocked.", 403);
  if (!id || !/^[A-Za-z0-9]{20,30}$/.test(id)) return errorPage(env, "This sign-in request is not valid.");
  const row = await env.DB.prepare("SELECT * FROM oauth_pending WHERE id = ? AND expires_at > ?").bind(id, now()).first<Pending>();
  if (!row) return errorPage(env, "This sign-in expired.");
  const secret = cookie(req, cookieName(id));
  if (!secret || !safeEqual(await sha256Hex(secret), row.cookie_hash)) {
    return errorPage(env, "Open this in the browser where you started signing in, or type the 6-digit code from the email there.", 403);
  }
  const csrf = await csrfFor(secret, id);
  if (form && !safeEqual(form.get("csrf") ?? "", csrf)) return errorPage(env, "This form expired. Go back and try again.", 403);
  return { row, csrf };
}

/**
 * Why a new account can't be created for email (SIGNUPS_DISABLED and not on SIGNUPS_ALLOWLIST, READ_ONLY, or the per-IP /
 * per-network daily limits), else null. An allowlisted email goes through the same limits as any signup.
 */
async function newAccountRefusal(req: Request, env: Env, consume: boolean, email: string): Promise<Response | null> {
  if (!signupAllowed(env, email)) {
    return page(env, "New signups are closed", "<p>New signups are closed. Existing accounts can still sign in with their email.</p>", 403);
  }
  if (serviceMode(env) === "READ_ONLY") return errorPage(env, "New accounts are paused right now. Try again later.", 503);
  const { ipHash, netHash } = await netHashes(req, env);
  const g = governor(env);
  const t = now();
  const ip = await g.hit(`signup:ip:${ipHash}`, LIMITS.signupsPerIpPerDay, 86400, t, consume);
  const net = ip.ok ? await g.hit(`signup:net:${netHash}`, LIMITS.signupsPerNetPerDay, 86400, t, consume) : ip;
  return ip.ok && net.ok ? null : page(env, "Too many new accounts", `<p>Too many ${getConfig(env).site.brandName === null ? "" : "Recitbot "}accounts were created from this network today. Try again tomorrow.</p>`, 429);
}

export function sixDigits(): string {
  const b = new Uint32Array(1);
  do crypto.getRandomValues(b);
  while (b[0] >= 4_294_000_000); // a multiple of 10^6: no modulo bias
  return String(b[0] % 1_000_000).padStart(6, "0");
}

export async function authorize(req: Request, env: Env, url: URL): Promise<Response> {
  const q = url.searchParams;
  // Until client_id and redirect_uri are verified, errors are shown here and never redirected.
  if (q.getAll("client_id").length !== 1 || q.getAll("redirect_uri").length !== 1) return errorPage(env, "client_id and redirect_uri are required.");
  const redirectUri = q.get("redirect_uri")!;
  const client = await getClient(env, q.get("client_id")!, (await netHashes(req, env)).ipHash);
  if (typeof client === "string") return errorPage(env, client);
  if (!client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) return errorPage(env, "This redirect_uri is not registered for the app.");

  const iss = issuerFor(env, url);
  const state = q.get("state");
  const fail = (error: string, description: string) =>
    redirectTo(redirectUri, { error, error_description: description, ...(state ? { state } : {}), iss });
  for (const k of new Set(q.keys())) if (q.getAll(k).length > 1) return fail("invalid_request", `Repeated parameter: ${k}.`);
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code.");
  if (!state || state.length > 1024) return fail("invalid_request", "state is required.");
  if (q.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  const challenge = q.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "code_challenge must be a base64url SHA-256 hash.");
  // RFC 8707 resource: optional, defaults to this host's MCP endpoint, and nothing else is accepted.
  const resource = q.get("resource") ?? resourceFor(env, url);
  if (resource !== resourceFor(env, url)) return fail("invalid_target", `resource must be ${resourceFor(env, url)}.`);
  const asked = (q.get("scope") ?? SCOPE).split(" ").filter(Boolean);
  if (asked.some((s) => !SCOPES.includes(s))) return fail("invalid_scope", `Supported scopes: ${SCOPES.join(" ")}.`);
  const scope = SCOPES.filter((s) => s === SCOPE || asked.includes(s)).join(" ");

  const fields: NewPending = {
    kind: "oauth",
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    resource,
    scope,
    issuer: iss,
  };
  const session = await useWebSession(req, env, url);
  const email = session && (await accountEmail(env, session.accountId));
  if (session && email) {
    const p = await createPending(env, url, fields, { accountId: session.accountId, email });
    const r = new URL(redirectUri);
    return consentPage(
    env,
      p.id,
      p.csrf,
      { client: clientLabel(client), clientHost: isCimdId(client.client_id) ? new URL(client.client_id).host : null, redirectHost: r.host, loopback: isLoopback(r.hostname), email },
      [p.cookie, ...(session.setCookie ? [session.setCookie] : [])],
    );
  }
  const p = await createPending(env, url, fields);
  const cookies = [p.cookie, ...(session?.setCookie ? [session.setCookie] : [])];
  return emailPage(
    env,
    { p: p.id, csrf: p.csrf, emailAction: "/oauth/authorize/email", codeAction: "/oauth/authorize/code" },
    clientLabel(client),
    turnstileSiteKey(env),
    "",
    cookies,
  );
}

/** The Turnstile site key for the email step's widget (config.ts): undefined while Turnstile is off. */
const turnstileSiteKey = (env: Env): string | undefined => getConfig(env).turnstile.siteKey ?? undefined;

// The /signin email form writes no row: it carries `<exp>.<next>.<sig>`, signed with a key derived from SHARE_HMAC_KEY
// under its own label (no new secret). The pending sign-in (and its browser cookie) is created when an email goes out.
const signinFormKey = (env: Env) => hmacB64(env.SHARE_HMAC_KEY, "signin-form-v1");
const signinFormSig = async (env: Env, exp: string, next: string) => hmacB64(await signinFormKey(env), `signin-form.${exp}.${next}`);

async function signinForm(env: Env, next: string): Promise<string> {
  const exp = String(now() + PENDING_TTL);
  return `${exp}.${next}.${await signinFormSig(env, exp, next)}`;
}

/** `next` from a signed, unexpired /signin form posted same-origin; else the error page. */
async function openSigninForm(req: Request, env: Env, url: URL, f: string | null): Promise<string | Response> {
  if (!sameOrigin(req, url)) return errorPage(env, "This request came from another site and was blocked.", 403);
  const m = f && f.length <= 1024 ? /^([1-9]\d{0,11})\.(.+)\.([A-Za-z0-9_-]{43})$/.exec(f) : null;
  if (!m || !safeEqual(m[3], await signinFormSig(env, m[1], m[2]))) return errorPage(env, "This sign-in request is not valid.");
  if (Number(m[1]) <= now()) return errorPage(env, "This sign-in expired.");
  return m[2];
}

/** GET /signin?next=/path: already signed in = straight to next; else the email step. */
export async function signin(req: Request, env: Env, url: URL): Promise<Response> {
  const next = safeNext(url.searchParams.get("next"));
  const session = await useWebSession(req, env, url);
  if (session) return redirect(next, 302, session.setCookie ? [session.setCookie] : []);
  return emailPage(env, { f: await signinForm(env, next), emailAction: "/signin" }, null, turnstileSiteKey(env));
}

/** POST /signin: the email step (or a resend), or the code step when the form has a code. */
export async function signinPost(req: Request, env: Env, url: URL): Promise<Response> {
  const form = await readForm(req, 4096);
  if (!form) return errorPage(env, "Bad request.");
  if (form.has("code")) return codeStep(req, env, url, form);
  if (form.has("p")) return emailStep(req, env, url, form);
  const next = await openSigninForm(req, env, url, form.get("f"));
  return typeof next === "string" ? emailStep(req, env, url, form, { next, f: form.get("f")! }) : next;
}

export async function submitEmail(req: Request, env: Env, url: URL): Promise<Response> {
  const form = await readForm(req, 4096);
  if (!form) return errorPage(env, "Bad request.");
  return emailStep(req, env, url, form);
}

export async function submitCode(req: Request, env: Env, url: URL): Promise<Response> {
  const form = await readForm(req, 4096);
  if (!form) return errorPage(env, "Bad request.");
  return codeStep(req, env, url, form);
}

/** The email step. `start` = the checked /signin form, for a sign-in that has no row yet. */
async function emailStep(req: Request, env: Env, url: URL, form: URLSearchParams, start?: { next: string; f: string }): Promise<Response> {
  const s = start ?? (await load(req, env, url, form.get("p"), form));
  if (s instanceof Response) return s;
  const row = "row" in s ? s.row : null;
  if (row?.verified_at) return errorPage(env, "You already signed in for this request.");
  const client = row?.kind === "oauth" ? clientLabel(row) : null;
  const site = turnstileSiteKey(env);
  const again = (error: string, email = "") =>
    emailPage(env, "row" in s ? steps(s.row, s.csrf) : { f: s.f, emailAction: "/signin" }, client, site, error, [], email);
  const email = form.get("resend") === "1" && row?.email ? row.email : normalizeEmail(form.get("email") ?? "");
  if (!z.email().max(254).safeParse(email).success) return again("Enter a valid email address.");
  if (disposableDomain(email)) return again("Disposable email addresses can't be used.");

  const g = governor(env);
  const t = now();
  const perIp = await g.hit(`oauth-email:ip:${(await netHashes(req, env)).ipHash}`, EMAILS_PER_IP_PER_HOUR, 3600, t);
  const perTo = perIp.ok ? await g.hit(`oauth-email:to:${await sha256Hex(canonicalEmail(email))}`, EMAILS_PER_ADDRESS_PER_HOUR, 3600, t) : perIp;
  if (!perIp.ok || !perTo.ok) return page(env, "Too many sign-in emails", "<p>Wait a while, then try again.</p>", 429);
  if (!(await findAccount(env, email))) {
    const refusal = await newAccountRefusal(req, env, false, email);
    if (refusal) return refusal;
  }
  // Turnstile after the limits above, so a flood costs no siteverify calls. Both keys are required (fail closed),
  // unless the operator switched the check off (TURNSTILE_DISABLED without keys, config.ts; the limits above still apply).
  const token = (form.get("cf-turnstile-response") ?? "").slice(0, 2048);
  if (!getConfig(env).turnstile.signinCheckDisabled && (!site || !(await verifyTurnstile(env, token, clientIp(req))))) {
    return again("Please complete the check and try again.", email);
  }
  if (!(await g.hit("oauth-email:global", LIMITS.signinEmailsPerDay, 86400, t)).ok) {
    return page(env, "Sign-in emails are paused", "<p>Sign-in emails are paused for today. Try again later.</p>", 429);
  }

  // From the /signin form, the sign-in gets its row, and this browser its cookie, only now.
  let to: Steps;
  let cookies: string[] = [];
  if ("row" in s) to = steps(s.row, s.csrf);
  else {
    const p = await createPending(env, url, { kind: "web", next: s.next });
    to = { p: p.id, csrf: p.csrf, emailAction: "/signin", codeAction: "/signin" };
    cookies = [p.cookie];
  }

  // A new email (or a resend) replaces the previous link and code.
  const magic = randomId(256);
  const code = sixDigits();
  await env.DB.prepare(
    "UPDATE oauth_pending SET email = ?, magic_hash = ?, code_hash = ?, code_attempts = 0, magic_expires_at = ?, expires_at = ? WHERE id = ? AND verified_at IS NULL",
  )
    .bind(email, await sha256Hex(magic), await sha256Hex(`${to.p}:${code}`), t + MAGIC_TTL, t + PENDING_TTL, to.p)
    .run();
  const sent = await sendSigninEmail(env, email, `${url.origin}/oauth/magic?t=${magic}`, code);
  if (sent === "unconfigured" || sent === "failed") return errorPage(env, "Email sign-in isn't available right now. Try again later.", 503);
  return codePage(env, to, email, "", cookies);
}

/**
 * The email is proven: find or create its account. A web sign-in then gets its session and goes to `next`; an app
 * connecting goes on to the consent page.
 */
async function signedIn(req: Request, env: Env, url: URL, row: Pending, email: string, status: number): Promise<Response> {
  let accountId = await findAccount(env, email);
  if (!accountId) {
    const refusal = await newAccountRefusal(req, env, true, email);
    if (refusal) return refusal;
    accountId = await findOrCreateAccount(env, email);
  }
  if (row.kind === "web") {
    await env.DB.prepare("UPDATE oauth_pending SET account_id = ?, done_at = ? WHERE id = ?").bind(accountId, now(), row.id).run();
    return redirect(row.next, status, [clearPending(row.id, url), await startWebSession(req, env, url, accountId)]);
  }
  await env.DB.prepare("UPDATE oauth_pending SET account_id = ?, expires_at = ? WHERE id = ?").bind(accountId, now() + PENDING_TTL, row.id).run();
  return redirect(`${url.origin}/oauth/authorize/consent?p=${row.id}`, 303);
}

export async function magicLink(req: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  if (!/^[A-Za-z0-9]{40,60}$/.test(token)) return errorPage(env, "This sign-in link is not valid.");
  const hash = await sha256Hex(token);
  const found = await env.DB.prepare("SELECT id FROM oauth_pending WHERE magic_hash = ?").bind(hash).first<{ id: string }>();
  if (!found) return errorPage(env, "This sign-in link was already used or is not valid.");
  // The cookie check comes first, so link scanners and other browsers can't use up the link.
  const s = await load(req, env, url, found.id);
  if (s instanceof Response) return s;
  const t = now();
  const row = await env.DB.prepare(
    "UPDATE oauth_pending SET magic_hash = NULL, code_hash = NULL, verified_at = ? WHERE id = ? AND magic_hash = ? AND verified_at IS NULL AND magic_expires_at > ? RETURNING email",
  )
    .bind(t, found.id, hash, t)
    .first<{ email: string }>();
  if (!row) return errorPage(env, "This sign-in link expired. Links work for 10 minutes.");
  return signedIn(req, env, url, s.row, row.email, 302);
}

async function codeStep(req: Request, env: Env, url: URL, form: URLSearchParams): Promise<Response> {
  const s = await load(req, env, url, form.get("p"), form);
  if (s instanceof Response) return s;
  const { row, csrf } = s;
  const code = (form.get("code") ?? "").replace(/[\s-]/g, "");
  const t = now();
  const tried = await env.DB.prepare(
    "UPDATE oauth_pending SET code_attempts = code_attempts + 1 WHERE id = ? AND verified_at IS NULL AND code_hash IS NOT NULL " +
      "AND magic_expires_at > ? AND code_attempts < ? RETURNING code_hash, code_attempts, email",
  )
    .bind(row.id, t, MAX_CODE_ATTEMPTS)
    .first<{ code_hash: string; code_attempts: number; email: string }>();
  if (!tried) return errorPage(env, "This code expired or was entered wrong too many times.");
  if (!/^\d{6}$/.test(code) || !safeEqual(await sha256Hex(`${row.id}:${code}`), tried.code_hash)) {
    const left = MAX_CODE_ATTEMPTS - tried.code_attempts;
    if (left > 0) return codePage(env, steps(row, csrf), tried.email, `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.`);
    // Locked: the emailed link dies with the code.
    await env.DB.prepare("UPDATE oauth_pending SET magic_hash = NULL, code_hash = NULL WHERE id = ?").bind(row.id).run();
    return errorPage(env, "Wrong code too many times.");
  }
  const done = await env.DB.prepare(
    "UPDATE oauth_pending SET magic_hash = NULL, code_hash = NULL, verified_at = ? WHERE id = ? AND verified_at IS NULL RETURNING email",
  )
    .bind(t, row.id)
    .first<{ email: string }>();
  if (!done) return errorPage(env, "This code was already used.");
  return signedIn(req, env, url, row, done.email, 303);
}

export async function consent(req: Request, env: Env, url: URL): Promise<Response> {
  const s = await load(req, env, url, url.searchParams.get("p"));
  if (s instanceof Response) return s;
  const { row, csrf } = s;
  if (row.kind !== "oauth" || !row.verified_at || !row.account_id || !row.email || row.done_at) return errorPage(env, "There's nothing to approve here.");
  const r = new URL(row.redirect_uri);
  return consentPage(env, row.id, csrf, {
    client: clientLabel(row),
    clientHost: isCimdId(row.client_id) ? new URL(row.client_id).host : null,
    redirectHost: r.host,
    loopback: isLoopback(r.hostname),
    email: row.email,
  });
}

export async function decide(req: Request, env: Env, url: URL): Promise<Response> {
  const form = await readForm(req, 4096);
  if (!form) return errorPage(env, "Bad request.");
  const s = await load(req, env, url, form.get("p"), form);
  if (s instanceof Response) return s;
  // Signed in with a web session: it must still be valid (not signed out since the consent page was shown).
  if (s.row.via_session && (await getWebSession(req, env)) !== s.row.account_id) return errorPage(env, "You were signed out. Go back to your app and connect again.", 403);
  const t = now();
  const p = await env.DB.prepare(
    "UPDATE oauth_pending SET done_at = ? WHERE id = ? AND kind = 'oauth' AND done_at IS NULL AND verified_at IS NOT NULL AND account_id IS NOT NULL RETURNING *",
  )
    .bind(t, s.row.id)
    .first<Pending & { kind: "oauth"; account_id: string }>();
  if (!p) return errorPage(env, "There's nothing to approve here.");
  const clear = clearPending(p.id, url);
  if (form.get("decision") !== "allow") {
    return redirectTo(p.redirect_uri, { error: "access_denied", error_description: "The user denied access.", state: p.state, iss: p.issuer }, 303, [clear]);
  }
  const code = randomId(256);
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, account_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(code), p.client_id, p.redirect_uri, p.code_challenge, p.resource, p.scope, p.account_id, t + CODE_TTL)
    .run();
  await markClientUsed(env, p.client_id);
  // The same browser is now signed in to the website too (unless it already was, through the session it came with).
  const cookies = p.via_session ? [clear] : [clear, await startWebSession(req, env, url, p.account_id)];
  return redirectTo(p.redirect_uri, { code, state: p.state, iss: p.issuer }, 303, cookies);
}

/** GET /signout: a button (sign-out is a POST). */
export function signoutConfirm(_req: Request, env: Env, url: URL): Response {
  return signoutPage(env, safeNext(url.searchParams.get("next")));
}

/** POST /signout (same-origin only): revokes this browser's session, clears the cookie, then goes to next. */
export async function signout(req: Request, env: Env, url: URL): Promise<Response> {
  if (!sameOrigin(req, url)) return page(env, "Can't sign out", "<p>This request came from another site and was blocked.</p>", 403);
  const form = (await readForm(req, 4096)) ?? new URLSearchParams();
  return redirect(safeNext(form.get("next")), 303, [await endWebSession(req, env, url)]);
}
