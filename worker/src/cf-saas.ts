// Cloudflare for SaaS: the operator zone's custom hostnames (CF_ZONE_ID; customers' own video domains, custom-domains.ts).
// A minimal REST client (fetch, no SDK) with typed results. Errors carry Cloudflare's codes and a sanitised message,
// never the request headers or the token.
import { getConfig } from "./config";
import type { Env } from "./env";
import { log } from "./util";

export const CF_API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;

/** Test seam: tests replace fetch to stand in for the Cloudflare API. */
export const cfDeps = { fetch: (input: string, init: RequestInit) => fetch(input, init) };

/** Custom domains are on only with the API token (secret), the zone id and the CNAME target (vars): config.ts. */
export const customDomainsEnabled = (env: Env): boolean => getConfig(env).customDomains.enabled;

/** The part of Cloudflare's custom hostname object Recitbot reads. */
export type CustomHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string; validation_errors?: { message?: string }[] } | null;
  verification_errors?: string[] | null;
};

/**
 * taken_elsewhere = the hostname already exists as a custom hostname (here or on another Cloudflare zone);
 * not_found = no such custom hostname; config = our token or zone is wrong (log it, tell the user it's off);
 * cloudflare_error = anything else, timeouts included.
 */
export type CfErrorKind = "taken_elsewhere" | "not_found" | "config" | "cloudflare_error";
export type CfResult<T> = { ok: true; result: T } | { ok: false; kind: CfErrorKind; status: number; codes: number[]; message: string };

type CfEnvelope = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: unknown };

/** Cloudflare's "Duplicate custom hostname found" (create); other wordings are caught by the message test below. */
const DUPLICATE_CODES = new Set([1406]);
/** Authentication / authorization codes: the token is missing a permission or the zone id is wrong. */
const AUTH_CODES = new Set([10000, 10001, 9103, 9106, 9109, 6003, 6111, 7003]);

/** Cloudflare's message, safe to show: one line, no control characters, nothing token-like, at most 200 chars. */
export function sanitizeCfMessage(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bbearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function classify(status: number, codes: number[], message: string): CfErrorKind {
  if (status === 401 || status === 403 || codes.some((c) => AUTH_CODES.has(c))) return "config";
  if (codes.some((c) => DUPLICATE_CODES.has(c)) || /already exists|duplicate/i.test(message)) return "taken_elsewhere";
  if (status === 404) return "not_found";
  return "cloudflare_error";
}

async function cfApi<T>(env: Env, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<CfResult<T>> {
  if (!customDomainsEnabled(env)) return { ok: false, kind: "config", status: 0, codes: [], message: "custom domains not configured" };
  const url = `${CF_API}/zones/${encodeURIComponent(getConfig(env).customDomains.zoneId!)}${path}`;
  const headers: Record<string, string> = { authorization: `Bearer ${env.CF_SAAS_API_TOKEN!.trim()}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await cfDeps.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    log("warn", "cloudflare api unreachable", { method, op: path.split("?")[0].split("/").slice(0, 2).join("/"), timeout });
    return { ok: false, kind: "cloudflare_error", status: 0, codes: [], message: timeout ? "Cloudflare didn't answer in time" : "Cloudflare couldn't be reached" };
  }
  const data = (await res.json().catch(() => ({}))) as CfEnvelope;
  if (res.ok && data.success !== false) return { ok: true, result: data.result as T };
  const codes = (data.errors ?? []).map((e) => Number(e.code)).filter((c) => Number.isFinite(c));
  const message = sanitizeCfMessage((data.errors ?? []).map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${res.status}`);
  const kind = classify(res.status, codes, message);
  // Only the status, codes and kind: never the request (headers carry the token).
  log(kind === "not_found" ? "info" : "warn", "cloudflare api error", { method, status: res.status, codes, kind });
  return { ok: false, kind, status: res.status, codes, message };
}

/** Creates the custom hostname with an HTTP-validated DV certificate (the customer's CNAME alone proves ownership). */
export function createCustomHostname(env: Env, hostname: string): Promise<CfResult<CustomHostname>> {
  return cfApi<CustomHostname>(env, "POST", "/custom_hostnames", {
    hostname,
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  });
}

export function getCustomHostname(env: Env, id: string): Promise<CfResult<CustomHostname>> {
  return cfApi<CustomHostname>(env, "GET", `/custom_hostnames/${encodeURIComponent(id)}`);
}

/** The zone's custom hostname with exactly this name, or null (result: null) when there is none. */
export async function findCustomHostname(env: Env, hostname: string): Promise<CfResult<CustomHostname | null>> {
  const r = await cfApi<CustomHostname[]>(env, "GET", `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
  if (!r.ok) return r;
  return { ok: true, result: (r.result ?? []).find((h) => h.hostname === hostname) ?? null };
}

/** Deletes it (and its certificate). Already gone counts as deleted. */
export async function deleteCustomHostname(env: Env, id: string): Promise<CfResult<null>> {
  const r = await cfApi<unknown>(env, "DELETE", `/custom_hostnames/${encodeURIComponent(id)}`);
  return r.ok || r.kind === "not_found" ? { ok: true, result: null } : r;
}

/** The zone's fallback origin (where customer hostnames are served from) and its status. */
export function getFallbackOrigin(env: Env): Promise<CfResult<{ origin?: string; status?: string; errors?: string[] }>> {
  return cfApi(env, "GET", "/custom_hostnames/fallback_origin");
}
