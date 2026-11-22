// Token endpoint (authorization_code with PKCE, rotating refresh tokens), revocation (RFC 7009) and access token checks.
// Tokens are opaque: rbat_<id>_<secret> (access, 1 h) and rbrt_<id>_<secret> (refresh, 30 days). Only hashes are stored.
import type { Principal } from "../auth";
import type { Env } from "../env";
import { b64url, now, randomId, safeEqual, sha256Hex } from "../util";
import { authenticateClient } from "./clients";
import { SCOPE } from "./hosts";
import { corsJson, oauthError, readForm } from "./http";

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const TOKEN_RE = /^(rbat|rbrt)_([A-Za-z0-9]{8,20})_([A-Za-z0-9]{40,60})$/;
const NO_HASH = "0".repeat(64);

type Grant = { family_id: string; client_id: string; account_id: string; aud: string; scope: string };
type TokenRow = Grant & { id: string; kind: string; token_hash: string; expires_at: number; used_at: number | null; revoked_at: number | null };

/** The stored row for a well-formed token whose hash matches, else null. */
async function findToken(env: Env, token: string, kind?: "access" | "refresh"): Promise<TokenRow | null> {
  const m = TOKEN_RE.exec(token);
  if (!m || (kind && m[1] !== (kind === "access" ? "rbat" : "rbrt"))) return null;
  const row = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE id = ? AND kind = ?")
    .bind(m[2], m[1] === "rbat" ? "access" : "refresh")
    .first<TokenRow>();
  // Compare against a dummy when the id is unknown so timing does not reveal valid ids.
  return safeEqual(await sha256Hex(token), row?.token_hash ?? NO_HASH) && row ? row : null;
}

const revokeFamily = (env: Env, familyId: string) =>
  env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").bind(now(), familyId).run();

async function issueTokens(env: Env, g: Grant): Promise<Response> {
  const t = now();
  const ids = [randomId(64), randomId(64)];
  const access = `rbat_${ids[0]}_${randomId(256)}`;
  const refresh = `rbrt_${ids[1]}_${randomId(256)}`;
  const insert = env.DB.prepare(
    "INSERT INTO oauth_tokens (id, kind, token_hash, family_id, client_id, account_id, aud, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await env.DB.batch([
    insert.bind(ids[0], "access", await sha256Hex(access), g.family_id, g.client_id, g.account_id, g.aud, g.scope, t, t + ACCESS_TTL),
    insert.bind(ids[1], "refresh", await sha256Hex(refresh), g.family_id, g.client_id, g.account_id, g.aud, g.scope, t, t + REFRESH_TTL),
  ]);
  return corsJson(
    { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: g.scope },
    200,
    { pragma: "no-cache" },
  );
}

/** Form body of at most 8 KB without repeated parameters (RFC 6749 section 3.2). */
async function tokenForm(req: Request): Promise<URLSearchParams | null> {
  const form = await readForm(req, 8192);
  if (form) for (const k of new Set(form.keys())) if (form.getAll(k).length > 1) return null;
  return form;
}

async function codeGrant(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  if (!code || !verifier || !form.get("redirect_uri")) return oauthError("invalid_request", "code, redirect_uri and code_verifier are required.");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_request", "Malformed code_verifier.");
  const hash = await sha256Hex(code);
  const t = now();
  // Single use: the UPDATE only succeeds once, and only before expiry. Any failed redemption still burns the code.
  const row = await env.DB.prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING *")
    .bind(t, hash, t)
    .first<{ client_id: string; redirect_uri: string; code_challenge: string; resource: string; scope: string; account_id: string }>();
  if (!row) {
    // A replayed code revokes what it already issued (RFC 6749 section 4.1.2).
    const used = await env.DB.prepare("SELECT family_id FROM oauth_codes WHERE code_hash = ? AND used_at IS NOT NULL")
      .bind(hash)
      .first<{ family_id: string | null }>();
    if (used?.family_id) await revokeFamily(env, used.family_id);
    return oauthError("invalid_grant", "The authorization code is invalid, expired or already used.");
  }
  if (row.client_id !== clientId) return oauthError("invalid_grant", "The authorization code was issued to another client.");
  if (form.get("redirect_uri") !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  if (!safeEqual(challenge, row.code_challenge)) return oauthError("invalid_grant", "PKCE verification failed.");
  const resource = form.get("resource");
  if (resource !== null && resource !== row.resource) return oauthError("invalid_target", "resource does not match the authorization request.");
  const family = randomId(128);
  await env.DB.prepare("UPDATE oauth_codes SET family_id = ? WHERE code_hash = ?").bind(family, hash).run();
  return issueTokens(env, { family_id: family, client_id: clientId, account_id: row.account_id, aud: row.resource, scope: row.scope });
}

async function refreshGrant(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const token = form.get("refresh_token");
  if (!token) return oauthError("invalid_request", "refresh_token is required.");
  const invalid = () => oauthError("invalid_grant", "The refresh token is invalid, expired or revoked.");
  const row = await findToken(env, token, "refresh");
  if (!row || row.client_id !== clientId) return invalid();
  const t = now();
  if (row.revoked_at || row.expires_at <= t) return invalid();
  const resource = form.get("resource");
  if (resource !== null && resource !== row.aud) return oauthError("invalid_target", "resource does not match the token.");
  // Rotation: a refresh token works once. Presenting a used one means it leaked, so the whole family goes.
  const consumed = row.used_at
    ? null
    : await env.DB.prepare("UPDATE oauth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL RETURNING id")
        .bind(t, row.id)
        .first();
  if (!consumed) {
    await revokeFamily(env, row.family_id);
    return invalid();
  }
  return issueTokens(env, row);
}

export async function tokenEndpoint(req: Request, env: Env): Promise<Response> {
  const form = await tokenForm(req);
  if (!form) return oauthError("invalid_request", "Send a form-encoded body without repeated parameters.");
  const auth = await authenticateClient(req, form, env);
  if (auth instanceof Response) return auth;
  const grant = form.get("grant_type");
  if (grant === "authorization_code") return codeGrant(env, form, auth.clientId);
  if (grant === "refresh_token") return refreshGrant(env, form, auth.clientId);
  return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
}

/** RFC 7009. Unknown tokens, and tokens of other clients, are answered 200 and left alone. */
export async function revokeEndpoint(req: Request, env: Env): Promise<Response> {
  const form = await tokenForm(req);
  if (!form?.get("token")) return oauthError("invalid_request", "token is required.");
  const auth = await authenticateClient(req, form, env);
  if (auth instanceof Response) return auth;
  const row = await findToken(env, form.get("token")!);
  if (row && row.client_id === auth.clientId) {
    if (row.kind === "refresh") await revokeFamily(env, row.family_id);
    else await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), row.id).run();
  }
  return corsJson({});
}

/**
 * Principal for a live access token bound to `resource` with the recitbot scope. "stale" = a genuine token that is
 * expired, revoked or for another resource (not an auth failure worth rate limiting); null = no such token.
 */
export async function verifyAccessToken(env: Env, token: string, resource: string): Promise<Principal | "stale" | null> {
  const row = await findToken(env, token, "access");
  if (!row) return null;
  if (row.revoked_at || row.expires_at <= now() || row.aud !== resource || !row.scope.split(" ").includes(SCOPE)) return "stale";
  return { accountId: row.account_id, keyId: `oauth:${row.family_id}`, oauth: true };
}
