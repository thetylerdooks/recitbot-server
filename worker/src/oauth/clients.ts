// OAuth clients: dynamic registration (RFC 7591), Client ID Metadata Documents, redirect URI rules, client authentication.
import type { Env } from "../env";
import { governor } from "../governor";
import { clientIp, hmacHex, now, randomId, safeEqual, sha256Hex } from "../util";
import { outbound } from "./net";
import { corsJson, oauthError } from "./http";

export type Client = { client_id: string; client_name: string | null; redirect_uris: string[] };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const AUTH_METHODS = new Set(["none", "client_secret_basic", "client_secret_post"]);
const GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const UNUSED_CLIENT_TTL = 7 * 86400;
const CIMD_TTL = 3600;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_FETCHES_PER_IP_PER_HOUR = 20;
const REGISTRATIONS_PER_IP_PER_HOUR = 20;

function parseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** https, or http on a loopback host. No fragment, no credentials, nothing else (no custom schemes). */
export function validRedirectUri(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2000 || s.includes("#")) return false;
  const u = parseUrl(s);
  if (!u || u.username || u.password) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

/** Exact match, except loopback http redirects, where only the port may differ (RFC 8252 7.3). */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!validRedirectUri(requested)) return false;
  const a = parseUrl(registered);
  const b = new URL(requested);
  return (
    !!a &&
    a.protocol === "http:" &&
    b.protocol === "http:" &&
    LOOPBACK.has(a.hostname) &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

export const isLoopback = (hostname: string) => LOOPBACK.has(hostname);

const cleanName = (v: unknown) => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 100) || null : null);

export async function register(req: Request, env: Env): Promise<Response> {
  const ipHash = await hmacHex(env.IP_HASH_KEY, `ip:${clientIp(req)}`);
  const rl = await governor(env).hit(`oauth-register:${ipHash}`, REGISTRATIONS_PER_IP_PER_HOUR, 3600, now());
  if (!rl.ok) return corsJson({ error: "too_many_requests", error_description: "Too many registrations." }, 429, { "retry-after": String(rl.retry_after) });
  const text = await req.text();
  let body: Record<string, unknown> | null = null;
  try {
    const v = text.length <= 16384 ? JSON.parse(text) : null;
    body = v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    // body stays null
  }
  if (!body) return oauthError("invalid_client_metadata", "Body must be a JSON object.");
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs, or http on 127.0.0.1, localhost or [::1], without fragments.");
  }
  const method = body.token_endpoint_auth_method ?? "client_secret_basic";
  if (typeof method !== "string" || !AUTH_METHODS.has(method)) {
    return oauthError("invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_basic or client_secret_post.");
  }
  const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || !grants.includes("authorization_code") || !grants.every((g) => GRANT_TYPES.has(g))) {
    return oauthError("invalid_client_metadata", "grant_types may only be authorization_code and refresh_token.");
  }
  const responses = body.response_types ?? ["code"];
  if (!Array.isArray(responses) || responses.some((r) => r !== "code")) {
    return oauthError("invalid_client_metadata", "response_types must be [\"code\"].");
  }
  const clientId = randomId(128);
  const secret = method === "none" ? null : `rbcs_${randomId(256)}`;
  const name = cleanName(body.client_name);
  const t = now();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(clientId, secret ? await sha256Hex(secret) : null, name, JSON.stringify(uris), JSON.stringify(grants), method, t)
    .run();
  return corsJson(
    {
      client_id: clientId,
      client_id_issued_at: t,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name ?? undefined,
      redirect_uris: uris,
      grant_types: grants,
      response_types: ["code"],
      token_endpoint_auth_method: method,
    },
    201,
  );
}

type ClientRow = { client_id: string; client_name: string | null; redirect_uris: string; client_secret_hash: string | null; token_endpoint_auth_method: string };

async function registeredClient(env: Env, clientId: string): Promise<ClientRow | null> {
  if (!/^[A-Za-z0-9]{20,30}$/.test(clientId)) return null;
  return env.DB.prepare(
    "SELECT client_id, client_name, redirect_uris, client_secret_hash, token_endpoint_auth_method FROM oauth_clients " +
      "WHERE client_id = ? AND (last_used_at IS NOT NULL OR created_at > ?)",
  )
    .bind(clientId, now() - UNUSED_CLIENT_TTL)
    .first<ClientRow>();
}

export const isCimdId = (clientId: string) => clientId.startsWith("https://");

/** Public DNS name only: no IP literals, no localhost or other local-only names. */
function publicHost(host: string): boolean {
  const h = host.replace(/\.$/, "");
  if (h.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || !h.includes(".")) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(h);
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max || !res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function fetchCimd(clientId: string): Promise<Client | string> {
  let res: Response;
  try {
    res = await outbound.fetch(clientId, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  } catch {
    return "The client's metadata document could not be fetched.";
  }
  if (res.status !== 200) return "The client's metadata document could not be fetched.";
  const text = await readCapped(res, CIMD_MAX_BYTES);
  let doc: Record<string, unknown> | null = null;
  try {
    doc = text === null ? null : JSON.parse(text);
  } catch {
    // doc stays null
  }
  if (!doc || typeof doc !== "object") return "The client's metadata document is not valid JSON.";
  if (doc.client_id !== clientId) return "The client's metadata document has a different client_id.";
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    return "Only public clients (token_endpoint_auth_method none) can use a metadata document.";
  }
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(validRedirectUri) : [];
  if (!uris.length) return "The client's metadata document lists no usable redirect_uris.";
  return { client_id: clientId, client_name: cleanName(doc.client_name), redirect_uris: uris };
}

async function cimdClient(env: Env, clientId: string, ipHash: string): Promise<Client | string> {
  const u = clientId.length <= 2000 ? parseUrl(clientId) : null;
  if (!u || u.protocol !== "https:" || u.username || u.password || u.hash || clientId.includes("#") || u.pathname === "/" || !publicHost(u.hostname)) {
    return "This client_id URL is not allowed.";
  }
  const cached = await env.DB.prepare("SELECT client_name, redirect_uris FROM oauth_cimd_cache WHERE client_id = ? AND fetched_at > ?")
    .bind(clientId, now() - CIMD_TTL)
    .first<{ client_name: string | null; redirect_uris: string }>();
  if (cached) return { client_id: clientId, client_name: cached.client_name, redirect_uris: JSON.parse(cached.redirect_uris) };
  if (!(await governor(env).hit(`oauth-cimd:${ipHash}`, CIMD_FETCHES_PER_IP_PER_HOUR, 3600, now())).ok) {
    return "Too many client lookups from this network. Try again later.";
  }
  const client = await fetchCimd(clientId);
  if (typeof client === "string") return client;
  await env.DB.prepare("INSERT OR REPLACE INTO oauth_cimd_cache (client_id, client_name, redirect_uris, fetched_at) VALUES (?, ?, ?, ?)")
    .bind(clientId, client.client_name, JSON.stringify(client.redirect_uris), now())
    .run();
  return client;
}

/** The client for an authorization request, or why it can't be used. */
export async function getClient(env: Env, clientId: string, ipHash: string): Promise<Client | string> {
  if (isCimdId(clientId)) return cimdClient(env, clientId, ipHash);
  const row = await registeredClient(env, clientId);
  if (!row) return "Unknown client. Register it again from your app.";
  return { client_id: row.client_id, client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) };
}

export async function markClientUsed(env: Env, clientId: string): Promise<void> {
  if (isCimdId(clientId)) return;
  await env.DB.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").bind(now(), clientId).run();
}

function basicAuth(req: Request): { id: string; secret: string } | null | undefined {
  const h = req.headers.get("authorization");
  if (!h) return undefined;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (!m) return null;
  try {
    const raw = atob(m[1]);
    const i = raw.indexOf(":");
    return i < 0 ? null : { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
  } catch {
    return null;
  }
}

/** Token and revocation endpoint client authentication: client_id for public clients, the secret (basic or post) otherwise. */
export async function authenticateClient(req: Request, form: URLSearchParams, env: Env): Promise<{ clientId: string } | Response> {
  const basic = basicAuth(req);
  const challenge = basic !== undefined ? { "www-authenticate": 'Basic realm="recitbot"' } : undefined;
  const invalid = () => oauthError("invalid_client", "Client authentication failed.", 401, challenge);
  if (basic === null || (basic && form.has("client_secret"))) return invalid();
  const formId = form.get("client_id");
  const id = basic?.id ?? formId;
  if (!id || (basic && formId && formId !== basic.id)) return invalid();
  const secret = basic?.secret ?? form.get("client_secret");
  if (isCimdId(id)) return secret ? invalid() : { clientId: id };
  const row = await registeredClient(env, id);
  if (!row) return invalid();
  if (row.token_endpoint_auth_method === "none") return { clientId: id };
  const ok = !!secret && !!row.client_secret_hash && safeEqual(await sha256Hex(secret), row.client_secret_hash);
  return ok ? { clientId: id } : invalid();
}
