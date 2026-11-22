// The watch page on a customer's custom domain (custom-host.ts -> share.ts handleViewer): the account's branding
// (branding.ts) instead of Recitbot's. Brand name for the title and site name, logo and favicon from /b/<hash> on the
// same host, the social image as og:image, and colours through a tiny inline <style> built only from hex values that
// are validated again here (its sha256 goes into the page's CSP). The "Powered by <BRAND_NAME>" / Report footer isn't
// brand-styled (fixed colours in recitbot.css .pwr); without BRAND_NAME it is only the Report link.
import { getConfig } from "./config";
import {
  contrast,
  DEFAULT_BACKGROUND,
  getBranding,
  MIN_ACCENT_CONTRAST,
  mixColor,
  parseColor,
  textColorFor,
  type Branding,
} from "./branding";
import { accountLimits, type AccountLimits, type Env } from "./env";

/** The product's icons and logos among the static files (worker/web). */
const BRAND_FILES: ReadonlySet<string> = new Set([
  "/favicon.ico",
  "/apple-touch-icon.png",
  ...["favicon.ico", "favicon.svg", "icon.svg", "apple-touch-icon.png", "og-card.png", "recitbot-lockup.svg"].map((f) => `/s/${f}`),
]);
/** A product icon or logo on a deployment without BRAND_NAME: 404, like a file that doesn't exist. */
export const hiddenBrandFile = (env: Env, path: string): boolean => getConfig(env).site.brandName === null && BRAND_FILES.has(path);

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/** Everything page() needs to render a customer-host page. */
export type BrandShell = {
  hostname: string;
  /** The brand name, else the hostname: <title> suffix, og:site_name. */
  siteName: string;
  /** The brand name as set (null = none): shown in the header next to the logo. */
  name: string | null;
  logo: { href: string; width: number; height: number } | null;
  /** Same-host /b/<hash>. */
  favicon: string | null;
  /** Absolute https://<hostname>/b/<hash>, never a video frame or a signed URL. */
  og: { url: string; type: string; width: number; height: number } | null;
  /** Page background (theme-color), when set. */
  background: string | null;
  /** Inline CSS and its CSP source ('sha256-...'), or null when no colour is set. */
  style: { css: string; hash: string } | null;
  /** <our base>/report?host=<hostname>&v=<slug> (raw: escaped where rendered); null without a configured base. */
  report: string | null;
  /** The "Powered by" link (config.ts homeUrl); null = plain text. */
  home: string | null;
};

const HEX6 = /^#[0-9a-f]{6}$/;
/** A stored colour checked again at render: #rrggbb lowercase, else null. Nothing else ever reaches the CSS. */
const hex = (c: string | null): string | null => {
  const p = c === null ? null : parseColor(c);
  return p && HEX6.test(p) ? p : null;
};

/** The player keeps its own dark palette (it sits on black video), whatever the page background. */
const PLAYER_VARS = "--ink:#111318;--paper:#f5f3ee;--muted:#a3a8b3;--line:#262a33;--panel:#1a1d24";

/**
 * The branded colours as CSS, or null: only validated #rrggbb values, mixed shades of them and fixed text. The text
 * colour is derived from the background again (never read from storage); a pair that no longer passes the contrast
 * check (checkColors, as set_branding applies it) drops the accent.
 */
export function brandCss(accentRaw: string | null, backgroundRaw: string | null): string | null {
  let bg = hex(backgroundRaw);
  let accent = hex(accentRaw);
  const text = bg ? textColorFor(bg) : null;
  // An unreadable background is ignored; an accent is checked against the background shown (or the default), as
  // set_branding checks it.
  if (!text) bg = null;
  if (accent && contrast(accent, bg ?? DEFAULT_BACKGROUND) < MIN_ACCENT_CONTRAST) accent = null;
  const root: string[] = [];
  if (bg && text) {
    root.push(
      `--ink:${bg}`,
      `--paper:${text}`,
      `--panel:${mixColor(bg, text, 0.06)}`,
      `--line:${mixColor(bg, text, 0.16)}`,
      `--muted:${mixColor(bg, text, 0.72)}`,
      `color-scheme:${text === "#ffffff" ? "dark" : "light"}`,
    );
  }
  if (accent) root.push(`--red:${accent}`, `--teal:${accent}`);
  if (!root.length) return null;
  const css = `:root{${root.join(";")}}.player{${PLAYER_VARS}}${accent ? `main a{color:${accent}}` : ""}`;
  // Defence in depth: the only characters a hex-built rule can contain.
  return /^[a-z0-9#:;{}.()\s,-]+$/i.test(css) ? css : null;
}

/** The account's branding when its plan still includes it (accountLimits.customDomain), else null. */
export async function shownBranding(env: Env, accountId: string, limits?: AccountLimits): Promise<Branding | null> {
  const l = limits ?? (await accountLimits(env, accountId));
  return l.customDomain ? getBranding(env, accountId) : null;
}

/** The report page on our own host (config.ts canonicalBaseUrl); null when none is configured. */
export const reportUrl = (env: Env, hostname: string, slug: string): string | null => {
  const base = getConfig(env).site.canonicalBaseUrl;
  return base ? `${base}/report?host=${encodeURIComponent(hostname)}&v=${encodeURIComponent(slug)}` : null;
};

/** The page shell for `slug` on this customer host. Branding not set (or not on the plan): hostname only, still unbranded. */
export async function brandShell(env: Env, host: { hostname: string; accountId: string }, slug: string, limits?: AccountLimits): Promise<BrandShell> {
  const b = await shownBranding(env, host.accountId, limits);
  const name = b?.brand_name?.trim() || null;
  const css = brandCss(b?.accent_color ?? null, b?.background_color ?? null);
  const style = css ? { css, hash: `'sha256-${b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css)))}'` } : null;
  const asset = (h: string) => `/b/${h}`;
  return {
    hostname: host.hostname,
    siteName: name ?? host.hostname,
    name,
    logo: b?.logo && /^[0-9a-f]{64}$/.test(b.logo.hash) ? { href: asset(b.logo.hash), width: b.logo.width, height: b.logo.height } : null,
    favicon: b?.favicon && /^[0-9a-f]{64}$/.test(b.favicon.hash) ? asset(b.favicon.hash) : null,
    og:
      b?.social_image && /^[0-9a-f]{64}$/.test(b.social_image.hash)
        ? { url: `https://${host.hostname}${asset(b.social_image.hash)}`, type: b.social_image.content_type, width: b.social_image.width, height: b.social_image.height }
        : null,
    background: css ? hex(b?.background_color ?? null) : null,
    style,
    report: reportUrl(env, host.hostname, slug),
    home: getConfig(env).site.homeUrl,
  };
}
