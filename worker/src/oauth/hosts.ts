// Issuer and resource URIs per host. Our public hosts (PUBLIC_BASE_URL's and MCP_BASE_URL's, config.ts oauthHosts) are
// their own issuer, loopback dev hosts too; anything else is treated as MCP_BASE_URL (else PUBLIC_BASE_URL, else the
// request's own origin).
import { getConfig } from "../config";
import type { Env } from "../env";

const DEV_HOSTS = new Set(["127.0.0.1", "localhost"]);

export const SCOPE = "recitbot";
export const SCOPES = [SCOPE, "offline_access"];

export function issuerFor(env: Env, url: URL): string {
  const { site } = getConfig(env);
  if (site.oauthHosts.has(url.hostname)) return `https://${url.hostname}`;
  if (DEV_HOSTS.has(url.hostname)) return url.origin;
  return site.mcpBaseUrl ?? site.publicBaseUrl ?? url.origin;
}

export const resourceFor = (env: Env, url: URL) => `${issuerFor(env, url)}/mcp`;

export function isDevHost(url: URL): boolean {
  return DEV_HOSTS.has(url.hostname);
}

/** WWW-Authenticate challenge for /mcp (RFC 9728 resource_metadata). */
export function mcpChallenge(env: Env, url: URL, invalidToken = false): string {
  const meta = `resource_metadata="${issuerFor(env, url)}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`;
  return invalidToken ? `Bearer error="invalid_token", ${meta}` : `Bearer ${meta}`;
}
