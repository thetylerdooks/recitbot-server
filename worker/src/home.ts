// "/": the static homepage (worker/home, the deployment's own and not committed, put into public/ by scripts/sync-home.mjs),
// only with HOME_SITE_ENABLED (config.ts homeSiteEnabled). Built without worker/home, there is none: 404. "/" is run_worker_first so the host decides: the MCP host never serves it. Visitors from
// BLOCKED_COUNTRIES get its /eu/ notice page (no sign-up CTA) with 451.
// /terms/, /privacy/, /eu/ and the homepage's files are static assets; their headers come from public/_headers.
// The pages name their operator through {{MARKERS}} (config.ts homeValues), filled in here on every serve.
// With the homepage off, none of them is served (index.ts staticAsset).
import { getConfig, type HomeMarker } from "./config";
import type { Env } from "./env";
import { HOME_FILES } from "./generated-home";
import { isBlockedCountry } from "./geo";
import HEADERS from "./home-headers.json";
import { esc } from "./util";

/** A request path that serves one of the homepage's files (/terms -> /terms/index.html, ...). */
export function isHomeFile(p: string): boolean {
  const base = p.replace(/\/+$/, "");
  return HOME_FILES.has(p) || HOME_FILES.has(`${base}/index.html`) || (p.endsWith(".html") && HOME_FILES.has(p));
}

/** A path the asset server may answer with a page: no file extension, or .html. */
export const isPagePath = (p: string): boolean => /(?:\/[^/.]*|\.html)$/.test(p);

/**
 * The same request with nothing that could make the asset server answer a 304 or a part of the file: its validators are
 * for the file with its markers, not for what the page says with this deployment's values.
 */
export function pageRequest(req: Request, url: string | URL = req.url): Request {
  const headers = new Headers(req.headers);
  for (const h of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range", "range"]) headers.delete(h);
  return new Request(url, { method: req.method, headers, redirect: "manual" });
}

export const isHtml = (res: Response): boolean => /^text\/html\b/i.test(res.headers.get("content-type") ?? "");

/** The page's markers as this deployment's values, HTML-escaped. */
export const fillMarkers = (html: string, values: Readonly<Record<HomeMarker, string>>): string =>
  html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (Object.hasOwn(values, k) ? esc(values[k as HomeMarker]) : m));

/** A homepage page from the asset server, filled in. Only with the homepage on. */
export async function renderPage(req: Request, env: Env, res: Response): Promise<Response> {
  const { homeValues } = getConfig(env).site;
  if (!homeValues || !isHtml(res)) return res;
  const headers = new Headers(res.headers);
  for (const h of ["etag", "last-modified", "content-length", "accept-ranges"]) headers.delete(h);
  const body = req.method === "HEAD" ? null : fillMarkers(await res.text(), homeValues);
  return new Response(body, { status: res.status, headers });
}

export async function handleHome(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const { site } = getConfig(env);
  if (!site.homeSiteEnabled) return null;
  const mcpHost = site.mcpBaseUrl ? new URL(site.mcpBaseUrl).hostname : null;
  if (url.hostname.startsWith("mcp.") || (url.hostname === mcpHost && mcpHost !== site.canonicalHost)) return null;
  if (!isBlockedCountry(env, (req.cf?.country as string | undefined) ?? req.headers.get("cf-ipcountry"))) {
    const page = await homePage(env, pageRequest(req));
    return page && withHeaders(await renderPage(req, env, page));
  }
  const page = await homePage(env, pageRequest(req, new URL("/eu/", url)));
  return page && withHeaders(await renderPage(req, env, page), 451);
}

/** The page from the asset server, or null: this build had no worker/home. */
async function homePage(env: Env, req: Request): Promise<Response | null> {
  const res = await env.ASSETS.fetch(req);
  if (res.status !== 404) return res;
  await res.body?.cancel();
  return null;
}

function withHeaders(res: Response, status = res.status): Response {
  const out = new Response(res.body, { status, headers: res.headers });
  for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
  out.headers.set("vary", "CF-IPCountry");
  return out;
}
