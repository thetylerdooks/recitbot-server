// Which kind of host a request came in on. Routing on our hosts is path-only (index.ts route()); a customer's custom
// video domain (videos.example.com CNAME <CUSTOM_DOMAIN_CNAME_TARGET>, Cloudflare for SaaS, the `*/*` zone route) only ever
// reaches custom-host.ts, never our MCP, sign-in, device, upload or billing routes.
//
// The hostname is the request URL's own (Workers builds req.url from Host). X-Forwarded-Host, Forwarded, X-Original-Host,
// X-Host and cf-* headers are never read: anyone can send them.
import { getConfig } from "./config";
import type { Env } from "./env";

export type HostKind = "ours" | "customer" | "reserved";

// Our hosts are config.site.hostnames (PUBLIC_BASE_URL's, MCP_BASE_URL's, SITE_HOSTNAMES) and *.workers.dev
// (recorders installed with that URL still use it). Any other name under config.site.zone is reserved (404 on every path).
/** Only with DEV_MODE on: loopback dev servers. */
const DEV_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Only with DEV_MODE on: names under the reserved .example TLD (RFC 2606; nobody can own one, so no customer domain can
 * be one). The test suite's origin is https://rec.example.
 */
const DEV_SUFFIX = ".example";

/** Lowercase, one trailing dot dropped: the form custom_domains.hostname is stored in. */
export const normalizeHost = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, "");

export function classifyHost(hostname: string, env: Env): HostKind {
  const h = normalizeHost(hostname);
  const { site, devMode } = getConfig(env);
  if (site.hostnames.has(h) || h.endsWith(".workers.dev")) return "ours";
  if (devMode && (DEV_HOSTS.has(h) || h.endsWith(DEV_SUFFIX))) return "ours";
  if (site.zone && (h === site.zone || h.endsWith(`.${site.zone}`))) return "reserved";
  return "customer";
}

/** The request's host kind, from new URL(req.url).hostname only. */
export const requestHostKind = (req: Request, env: Env): HostKind => classifyHost(new URL(req.url).hostname, env);
