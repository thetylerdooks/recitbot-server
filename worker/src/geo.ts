// Countries the operator doesn't serve (BLOCKED_COUNTRIES, config.ts; "EU_EEA_UK" = EU 27 + EEA + UK). Unset = none.
import { getConfig } from "./config";
import type { Env } from "./env";
import { esc } from "./util";

/** brand null (no BRAND_NAME): "This service". */
const regionMessage = (brand: string | null) => `${brand ?? "This service"} isn't available in your region.`;
/** `brand` is already HTML-escaped. */
const regionPage = (brand: string | null) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<title>${brand ?? "Not available"}</title></head><body><p>${regionMessage(brand)}</p></body></html>\n`;

export const isBlockedCountry = (env: Env, c: string | null | undefined): boolean =>
  !!c && getConfig(env).site.blockedCountries.has(c.trim().toUpperCase());

/** Static files served by the ASSETS binding; wrangler run_worker_first sends them through geoGate. */
export const GATED_ASSETS: ReadonlySet<string> = new Set(["/install.ps1", "/uninstall.ps1", "/recorder.zip", "/install.sh", "/uninstall.sh"]);
/** The macOS recorder zip (its name carries the version install.sh asks for). */
export const MAC_ZIP = /^\/Recitbot-mac-\d{1,3}\.\d{1,3}\.\d{1,3}\.zip$/;
export const isGatedAsset = (p: string): boolean => GATED_ASSETS.has(p) || MAC_ZIP.test(p);

const under = (p: string, base: string) => p === base || p.startsWith(`${base}/`);
const gated = (p: string) =>
  under(p, "/mcp") || under(p, "/oauth") || under(p, "/.well-known") || p.startsWith("/i/") || isGatedAsset(p);

export function geoGate(req: Request, env: Env): Response | null {
  const p = new URL(req.url).pathname;
  if (!gated(p) || !isBlockedCountry(env, (req.cf?.country as string | undefined) ?? req.headers.get("cf-ipcountry"))) return null;
  const { brandName } = getConfig(env).site;
  const h = { vary: "CF-IPCountry", "cache-control": "no-store" };
  if (req.method === "POST" && under(p, "/mcp")) {
    const body = { jsonrpc: "2.0", id: null, error: { code: -32000, message: regionMessage(brandName) } };
    return new Response(JSON.stringify(body), { status: 451, headers: { ...h, "content-type": "application/json" } });
  }
  if (req.headers.get("accept")?.includes("text/html")) {
    return new Response(regionPage(brandName === null ? null : esc(brandName)), { status: 451, headers: { ...h, "content-type": "text/html; charset=utf-8" } });
  }
  return new Response(regionMessage(brandName), { status: 451, headers: { ...h, "content-type": "text/plain; charset=utf-8" } });
}
