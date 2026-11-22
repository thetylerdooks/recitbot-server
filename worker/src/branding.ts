// Page branding (Pro, Teams, owner): brand name, accent and background colour, logo, favicon and social image, set
// through set_branding (branding-tools.ts) and read by the page renderer through getBranding. Images are checked by
// their bytes (PNG, JPEG, WebP; never SVG or GIF), stored in R2 at brand/<account_id>/<sha256>.<ext> (migration 0028)
// and served at /b/<sha256> by handleBrandAsset (cached briefly, see BRAND_ASSET_CACHE). Branding bytes don't count toward recording
// storage. No custom CSS, HTML or links: the name is plain text and is escaped wherever it is rendered.
import { getConfig } from "./config";
import type { Env } from "./env";
import { suspendedSql } from "./takedown-state";
import { hex, log } from "./util";

/** A rejected input: the tool turns it into a ToolError with this code and message. */
export class BrandingError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Test seam: every image link goes through this fetch (tests replace it, nothing reaches the network). */
export const brandingDeps = { fetch: (input: string, init: RequestInit) => fetch(input, init), timeoutMs: 10_000 };

export const BRANDING_LIMITS = {
  nameMax: 60,
  /** set_branding calls per account per UTC day (Governor). */
  callsPerDay: 20,
  /** Image links: redirects followed (each one checked again). */
  maxRedirects: 2,
} as const;

// ---------- colours ----------

/** The watch page's own colours (worker/web/recitbot.css --ink, --red): what a colour is checked against when only the other one is set. */
export const DEFAULT_BACKGROUND = "#111318";
export const DEFAULT_ACCENT = "#f2463a";
const DARK_TEXT = "#111111";
const LIGHT_TEXT = "#ffffff";
export const MIN_ACCENT_CONTRAST = 3;
export const MIN_TEXT_CONTRAST = 4.5;

/** "#1FA" / "#1fa89a" / "1fa89a" -> "#1fa89a"; null when it isn't a hex colour. */
export function parseColor(s: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
}

const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (v: number[]) => "#" + v.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");

/** a mixed toward b by t (0..1), both #rrggbb: shades derived from validated colours only. */
export function mixColor(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

/** WCAG 2 relative luminance of a #rrggbb colour. */
export function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const ratioText = (r: number) => `${Math.floor(r * 10) / 10}:1`;

/** Dark (#111111) or white (#ffffff) text, whichever reads better on bg; null when neither reaches 4.5:1. */
export function textColorFor(bg: string): string | null {
  const dark = contrast(DARK_TEXT, bg);
  const light = contrast(LIGHT_TEXT, bg);
  const best = Math.max(dark, light);
  return best < MIN_TEXT_CONTRAST ? null : dark >= light ? DARK_TEXT : LIGHT_TEXT;
}

/** c mixed toward white (or black) in 5% steps until ok(c) holds; null if it never does. */
function nudge(c: string, toward: "white" | "black", ok: (c: string) => boolean): string | null {
  const from = rgb(c);
  const end = toward === "white" ? 255 : 0;
  for (let i = 1; i <= 20; i++) {
    const next = toHex(from.map((v) => v + ((end - v) * i) / 20));
    if (ok(next)) return next;
  }
  return null;
}

/** A nearby accent that reaches 3:1 on bg (lighter on dark backgrounds, darker on light ones). */
function suggestAccent(accent: string, bg: string): string | null {
  const ok = (c: string) => contrast(c, bg) >= MIN_ACCENT_CONTRAST;
  const first = luminance(bg) < 0.18 ? "white" : "black";
  return nudge(accent, first, ok) ?? nudge(accent, first === "white" ? "black" : "white", ok);
}

/** A nearby background that dark or white text can be read on. */
function suggestBackground(bg: string): string | null {
  const ok = (c: string) => textColorFor(c) !== null;
  const first = luminance(bg) < 0.18 ? "black" : "white";
  return nudge(bg, first, ok) ?? nudge(bg, first === "white" ? "black" : "white", ok);
}

/** Throws when accent/background don't contrast enough; returns the text colour for the background. */
export function checkColors(accent: string, bg: string): string {
  const text = textColorFor(bg);
  if (!text) {
    const s = suggestBackground(bg);
    throw new BrandingError(
      "LOW_CONTRAST",
      `Text can't be read on background ${bg}: neither dark nor white text reaches ${MIN_TEXT_CONTRAST}:1 on it ` +
        `(best ${ratioText(Math.max(contrast(DARK_TEXT, bg), contrast(LIGHT_TEXT, bg)))}). Pick a lighter or darker background` +
        (s ? `, for example ${s}.` : "."),
      { background_color: bg, suggestion: s },
    );
  }
  const r = contrast(accent, bg);
  if (r < MIN_ACCENT_CONTRAST) {
    const s = suggestAccent(accent, bg);
    throw new BrandingError(
      "LOW_CONTRAST",
      `Accent ${accent} on background ${bg} has a contrast of ${ratioText(r)}; it needs at least ${MIN_ACCENT_CONTRAST}:1 so ` +
        `buttons and links stand out. Try ${s ? `${s} as the accent` : "a different accent"}, or change the background.`,
      { accent_color: accent, background_color: bg, contrast: Math.round(r * 100) / 100, suggestion: s },
    );
  }
  return text;
}

// ---------- brand name ----------

/** "acme.com", "shop.acme.io": something that reads as a domain. */
const DOMAIN = /(?:^|[^a-z0-9-])[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9-]+(?![a-z0-9-])/;

/** The brand name as stored (trimmed, control and format characters removed), or throws. Escaped on render. */
export function checkBrandName(raw: string): string {
  const s = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const len = [...s].length;
  if (len < 1 || len > BRANDING_LIMITS.nameMax) {
    throw new BrandingError("INVALID_BRAND_NAME", `The brand name must be 1 to ${BRANDING_LIMITS.nameMax} characters (it is ${len}).`);
  }
  if (/[<>]/.test(s)) throw new BrandingError("INVALID_BRAND_NAME", "The brand name can't contain < or >. Use plain text.");
  // NFKC folds full-width and other look-alike letters, so "ｗｗｗ．" is caught too.
  const n = s.normalize("NFKC").toLowerCase();
  if (n.includes("http") || n.includes("www.") || DOMAIN.test(n)) {
    throw new BrandingError(
      "INVALID_BRAND_NAME",
      "The brand name can't contain a link or a web address. Use just the name, like \"Acme Studio\".",
    );
  }
  return s;
}

// ---------- images ----------

export type BrandKind = "logo" | "favicon" | "og";
type ImageType = "png" | "jpeg" | "webp";
export type ImageInfo = { type: ImageType; contentType: string; ext: string; width: number; height: number };

const TYPES: Record<ImageType, { contentType: string; ext: string; name: string }> = {
  png: { contentType: "image/png", ext: "png", name: "PNG" },
  jpeg: { contentType: "image/jpeg", ext: "jpg", name: "JPG" },
  webp: { contentType: "image/webp", ext: "webp", name: "WebP" },
};

type KindSpec = { label: string; maxBytes: number; types: ImageType[]; check: (w: number, h: number) => string | null };
export const KINDS: Record<BrandKind, KindSpec> = {
  logo: {
    label: "logo",
    maxBytes: 512 * 1024,
    types: ["png", "jpeg", "webp"],
    check: (w, h) =>
      w < 32 || h < 32 || w > 2048 || h > 2048
        ? `Your logo is ${w}×${h} pixels; each side must be between 32 and 2048 pixels.`
        : null,
  },
  favicon: {
    label: "favicon",
    maxBytes: 100 * 1024,
    types: ["png"],
    check: (w, h) =>
      w !== h
        ? `Your favicon is ${w}×${h} pixels; it must be square (for example 32×32, 180×180 or 512×512).`
        : w < 16 || w > 512
          ? `Your favicon is ${w}×${h} pixels; it must be between 16×16 and 512×512.`
          : null,
  },
  og: {
    label: "social image",
    maxBytes: 1024 * 1024,
    types: ["png", "jpeg", "webp"],
    check: (w, h) =>
      w < 600
        ? `Your social image is ${w}×${h} pixels; it must be at least 600 pixels wide (1200×630 is best).`
        : Math.abs(w / h / 1.91 - 1) > 0.05
          ? `Your social image is ${w}×${h} pixels; it must be about 1.91:1 wide (like 1200×630).`
          : null,
  },
};

/** "3.1 MB", "512 KB". */
export function sizeText(n: number): string {
  if (n >= 1024 * 1024) return `${String(Math.round((n / (1024 * 1024)) * 10) / 10)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "PNG", "PNG, JPG or WebP". */
function typesText(k: KindSpec): string {
  const n = k.types.map((t) => TYPES[t].name);
  return n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} or ${n.at(-1)}`;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function pngSize(b: Uint8Array): [number, number] | null {
  // Signature, then the IHDR chunk first: length 13, "IHDR", width, height (big-endian).
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return [u32be(b, 16), u32be(b, 20)];
}

/** Walks the JPEG markers to the first SOFn frame header (no decoding). */
function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) m = b[++i + 1];
    i += 2;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone markers, no length
    if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan before any frame header
    if (i + 1 >= b.length) return null;
    const len = u16be(b, i);
    if (len < 2) return null;
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) return i + 6 < b.length ? [u16be(b, i + 5), u16be(b, i + 3)] : null;
    i += len;
  }
  return null;
}

/** VP8 (lossy), VP8L (lossless) or VP8X (extended) header sizes. Animated WebP is refused like GIF. */
function webpSize(b: Uint8Array): [number, number] | "animated" | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const w = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return [w, h];
  }
  if (chunk === "VP8X") {
    if (b[20] & 0x02) return "animated";
    return [1 + u24le(b, 24), 1 + u24le(b, 27)];
  }
  return null;
}

/**
 * The image's type and size from its first bytes; the claimed content type is never trusted. Throws a clear error for
 * SVG, GIF, animated WebP and anything that isn't a PNG, JPEG or WebP.
 */
export function sniffImage(b: Uint8Array, label: string): ImageInfo {
  const bad = (why: string) => new BrandingError("UNSUPPORTED_IMAGE", why);
  let type: ImageType | null = null;
  let size: [number, number] | null = null;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    type = "png";
    size = pngSize(b);
  } else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    type = "jpeg";
    size = jpegSize(b);
  } else if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    type = "webp";
    const s = webpSize(b);
    if (s === "animated") throw bad(`Your ${label} is an animated WebP; animated images aren't supported. Send a still PNG or JPG.`);
    size = s;
  } else {
    const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
    if (ascii(b, 0, 4) === "GIF8") throw bad(`Your ${label} is a GIF; GIFs aren't supported. Send a PNG or JPG.`);
    if (head.includes("<svg")) {
      throw bad(`Your ${label} is an SVG; SVG isn't allowed for security reasons. Send a PNG or JPG.`);
    }
    throw bad(`That ${label} isn't a PNG, JPEG or WebP image. Send a PNG or JPG.`);
  }
  if (!size || size[0] < 1 || size[1] < 1) throw bad(`That ${label} looks like a ${TYPES[type].name} but its header is damaged. Send another file.`);
  return { type, contentType: TYPES[type].contentType, ext: TYPES[type].ext, width: size[0], height: size[1] };
}

/** Bytes that make a valid image for `kind`, or throws with what to send instead. */
export function checkImage(b: Uint8Array, kind: BrandKind): ImageInfo {
  const k = KINDS[kind];
  if (b.length > k.maxBytes) {
    throw new BrandingError("IMAGE_TOO_LARGE", `Your ${k.label} is ${sizeText(b.length)}; the limit is ${sizeText(k.maxBytes)}. Send a smaller ${typesText(k)}.`);
  }
  const info = sniffImage(b, k.label);
  if (!k.types.includes(info.type)) {
    throw new BrandingError("UNSUPPORTED_IMAGE", `Your ${k.label} is a ${TYPES[info.type].name}; a ${k.label} must be a ${typesText(k)}.`);
  }
  const why = k.check(info.width, info.height);
  if (why) throw new BrandingError("IMAGE_DIMENSIONS", why);
  return info;
}

// ---------- getting the bytes ----------

/** One image as the bot hands it over: an https link, or the file itself as base64 (a data: URL is fine too). */
export type ImageInput = { url: string } | { data: string; content_type?: string };

export function decodeBase64(data: string, kind: BrandKind): Uint8Array {
  const k = KINDS[kind];
  const s = data.replace(/^data:[^,]{0,100};base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s) || s.length === 0) {
    throw new BrandingError("INVALID_IMAGE_DATA", `The ${k.label} data isn't valid base64. Send the image file as base64, or an https link to it.`);
  }
  const approx = Math.floor((s.length * 3) / 4);
  if (approx > k.maxBytes + 2) {
    throw new BrandingError("IMAGE_TOO_LARGE", `Your ${k.label} is ${sizeText(approx)}; the limit is ${sizeText(k.maxBytes)}. Send a smaller ${typesText(k)}.`);
  }
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new BrandingError("INVALID_IMAGE_DATA", `The ${k.label} data isn't valid base64. Send the image file as base64, or an https link to it.`);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Our zone and hostnames (config.ts): never a brand image source. */
const ownZones = (env: Env): string[] => {
  const { site } = getConfig(env);
  return [...(site.zone ? [site.zone] : []), ...site.hostnames];
};

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".intranet", ".corp", ".home", ".home.arpa"];

/**
 * Why an image link may not be fetched, or null when it may: https on the default port, no user:password, a public
 * DNS name (no IP literal, localhost, single-label or *.local-style host, nothing in `ownZones` (our zone and hostnames,
 * config.ts) or on our own host).
 */
export function linkProblem(raw: string, selfHosts: string[] = [], ownZones: readonly string[] = []): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That isn't a valid link.";
  }
  if (u.protocol !== "https:") return "Only https:// image links work.";
  if (u.username || u.password) return "Links with a username or password aren't allowed.";
  if (u.port && u.port !== "443") return "Image links must use the normal https port.";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  // The URL parser turns every IPv4 spelling (decimal, hex, octal) into dotted form; IPv6 comes in brackets.
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return "Links to an IP address aren't allowed; use a link with a domain name.";
  if (!host.includes(".") || host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s)) || ownZones.some((z) => host === z || host.endsWith(`.${z}`))) {
    return "That link points to a private or internal address. Use a public https link.";
  }
  if (selfHosts.some((h) => h.toLowerCase() === host)) return "That link points to Recitbot itself. Use a link to the original image.";
  return null;
}

/** Reads at most `cap` bytes of a body; null when there is more (the stream is cancelled, Content-Length is never trusted). */
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/**
 * Downloads an image link for `kind`: every hop (the link and up to 2 redirects, followed by hand) is checked with
 * linkProblem; 10 s for the whole download; the body is cut off past the kind's byte limit.
 */
export async function fetchImage(url: string, kind: BrandKind, selfHosts: string[] = [], ownZones: readonly string[] = []): Promise<Uint8Array> {
  const k = KINDS[kind];
  const fail = (why: string) => new BrandingError("IMAGE_LINK_FAILED", `Couldn't use the ${k.label} link: ${why}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), brandingDeps.timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const problem = linkProblem(current, selfHosts, ownZones);
      if (problem) throw fail(problem);
      let res: Response;
      try {
        res = await brandingDeps.fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: ctl.signal,
          headers: { accept: "image/png,image/jpeg,image/webp", "user-agent": "Recitbot-Branding/1" },
        });
      } catch {
        throw fail(ctl.signal.aborted ? "it took longer than 10 seconds." : "the site didn't answer. Check the link, or send the image itself.");
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const loc = res.headers.get("location");
        if (!loc) throw fail("the site sent a redirect without a target.");
        if (hop >= BRANDING_LIMITS.maxRedirects) throw fail("it redirects too many times. Use the image's direct link.");
        try {
          current = new URL(loc, current).toString();
        } catch {
          throw fail("the site redirected to an invalid link.");
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw fail(`the site answered ${res.status}. Check the link is public, or send the image itself.`);
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await readCapped(res.body, k.maxBytes);
      } catch {
        throw fail(ctl.signal.aborted ? "it took longer than 10 seconds." : "the download broke off. Try again, or send the image itself.");
      }
      if (!bytes) {
        throw new BrandingError("IMAGE_TOO_LARGE", `The ${k.label} at that link is bigger than ${sizeText(k.maxBytes)}, the limit. Send a smaller ${typesText(k)}.`);
      }
      return bytes;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function sha256Bytes(b: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", b));
}

// ---------- storage ----------

type BrandingRow = {
  account_id: string;
  brand_name: string | null;
  accent: string | null;
  background: string | null;
  logo_hash: string | null;
  favicon_hash: string | null;
  og_hash: string | null;
  updated_at: number;
};
type AssetRow = { hash: string; kind: BrandKind; r2_key: string; content_type: string; bytes: number; width: number; height: number };

export type BrandAsset = { hash: string; r2_key: string; content_type: string; bytes: number; width: number; height: number };
/** An account's branding with its asset metadata (getBranding). Colours are #rrggbb; text_color derives from background. */
export type Branding = {
  account_id: string;
  brand_name: string | null;
  accent_color: string | null;
  background_color: string | null;
  text_color: string | null;
  logo: BrandAsset | null;
  favicon: BrandAsset | null;
  social_image: BrandAsset | null;
  updated_at: number;
};

async function brandingRow(env: Env, accountId: string): Promise<BrandingRow | null> {
  return env.DB.prepare("SELECT * FROM branding WHERE account_id = ?").bind(accountId).first<BrandingRow>();
}

/**
 * The account's branding with asset metadata, or null when it has none. It does not check the plan: callers decide
 * whether the account may show it (the branded page, brand-page.ts, shows it only while accountLimits.customDomain).
 */
export async function getBranding(env: Env, accountId: string): Promise<Branding | null> {
  const row = await brandingRow(env, accountId);
  if (!row) return null;
  const assets = (
    await env.DB.prepare("SELECT hash, kind, r2_key, content_type, bytes, width, height FROM brand_assets WHERE account_id = ?")
      .bind(accountId)
      .all<AssetRow>()
  ).results;
  const asset = (h: string | null): BrandAsset | null => {
    const a = h ? assets.find((x) => x.hash === h) : undefined;
    return a ? { hash: a.hash, r2_key: a.r2_key, content_type: a.content_type, bytes: a.bytes, width: a.width, height: a.height } : null;
  };
  return {
    account_id: accountId,
    brand_name: row.brand_name,
    accent_color: row.accent,
    background_color: row.background,
    text_color: row.background ? textColorFor(row.background) : null,
    logo: asset(row.logo_hash),
    favicon: asset(row.favicon_hash),
    social_image: asset(row.og_hash),
    updated_at: row.updated_at,
  };
}

/** What get_branding / set_branding return (image URLs under `base`). */
export type BrandingView = {
  brand_name: string | null;
  accent_color: string | null;
  background_color: string | null;
  text_color: string | null;
  logo_url: string | null;
  favicon_url: string | null;
  social_image_url: string | null;
};

export const assetUrl = (base: string, hash: string | null | undefined) => (hash ? `${base}/b/${hash}` : null);

export function brandingView(b: Branding | null, base: string): BrandingView {
  return {
    brand_name: b?.brand_name ?? null,
    accent_color: b?.accent_color ?? null,
    background_color: b?.background_color ?? null,
    text_color: b?.text_color ?? null,
    logo_url: assetUrl(base, b?.logo?.hash),
    favicon_url: assetUrl(base, b?.favicon?.hash),
    social_image_url: assetUrl(base, b?.social_image?.hash),
  };
}

export type ClearField = "logo" | "favicon" | "social_image" | "brand_name" | "colors";
export type BrandingChange = {
  brand_name?: string;
  accent_color?: string;
  background_color?: string;
  logo?: ImageInput;
  favicon?: ImageInput;
  social_image?: ImageInput;
  clear?: ClearField[];
};

const IMAGE_FIELDS = [
  ["logo", "logo", "logo_hash"],
  ["favicon", "favicon", "favicon_hash"],
  ["social_image", "og", "og_hash"],
] as const;

/** A just-uploaded asset no other set_branding call is still writing into the row: unreferenced ones older than this go. */
const ORPHAN_GRACE_SECONDS = 3600;

/**
 * Applies one set_branding change: checks everything (name, colours, then each image: downloaded or decoded, then
 * checked), stores new images (R2 + brand_assets), writes the branding row (or deletes it when nothing is left), then
 * deletes the account's images it no longer uses. Nothing is written when any input is refused.
 */
export async function applyBranding(env: Env, accountId: string, ch: BrandingChange, t: number, selfHosts: string[] = []): Promise<Branding | null> {
  const clear = new Set(ch.clear ?? []);
  const clash = (f: ClearField, set: boolean) => {
    if (clear.has(f) && set) throw new BrandingError("CONFLICTING_ARGUMENTS", `You asked to both set and clear ${f}. Do one or the other.`);
  };
  clash("brand_name", ch.brand_name !== undefined);
  clash("colors", ch.accent_color !== undefined || ch.background_color !== undefined);
  for (const [field] of IMAGE_FIELDS) clash(field, ch[field] !== undefined);

  const prev = await brandingRow(env, accountId);
  const next: BrandingRow = prev
    ? { ...prev }
    : { account_id: accountId, brand_name: null, accent: null, background: null, logo_hash: null, favicon_hash: null, og_hash: null, updated_at: t };

  if (clear.has("brand_name")) next.brand_name = null;
  if (ch.brand_name !== undefined) next.brand_name = checkBrandName(ch.brand_name);

  if (clear.has("colors")) next.accent = next.background = null;
  const color = (v: string | undefined, what: string) => {
    if (v === undefined) return undefined;
    const c = parseColor(v);
    if (!c) throw new BrandingError("INVALID_COLOR", `${what} "${v}" isn't a hex colour. Use #RRGGBB, like #1fa89a.`);
    return c;
  };
  const accent = color(ch.accent_color, "accent_color");
  const background = color(ch.background_color, "background_color");
  if (accent !== undefined) next.accent = accent;
  if (background !== undefined) next.background = background;
  if (accent !== undefined || background !== undefined) checkColors(next.accent ?? DEFAULT_ACCENT, next.background ?? DEFAULT_BACKGROUND);

  // Every image is fetched and checked before anything is stored.
  const uploads: { kind: BrandKind; col: (typeof IMAGE_FIELDS)[number][2]; bytes: Uint8Array; info: ImageInfo; hash: string }[] = [];
  for (const [field, kind, col] of IMAGE_FIELDS) {
    if (clear.has(field)) next[col] = null;
    const input = ch[field];
    if (!input) continue;
    const bytes = "url" in input ? await fetchImage(input.url, kind, selfHosts, ownZones(env)) : decodeBase64(input.data, kind);
    const info = checkImage(bytes, kind);
    uploads.push({ kind, col, bytes, info, hash: await sha256Bytes(bytes) });
  }

  for (const u of uploads) {
    const key = `brand/${accountId}/${u.hash}.${u.info.ext}`;
    await env.MEDIA.put(key, u.bytes, { httpMetadata: { contentType: u.info.contentType } });
    await env.DB.prepare(
      "INSERT INTO brand_assets (account_id, hash, kind, r2_key, content_type, bytes, width, height, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, hash) DO UPDATE SET created_at = excluded.created_at",
    )
      .bind(accountId, u.hash, u.kind, key, u.info.contentType, u.bytes.length, u.info.width, u.info.height, t)
      .run();
    next[u.col] = u.hash;
  }

  next.updated_at = t;
  const empty = [next.brand_name, next.accent, next.background, next.logo_hash, next.favicon_hash, next.og_hash].every((v) => v === null);
  if (empty) {
    await env.DB.prepare("DELETE FROM branding WHERE account_id = ?").bind(accountId).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO branding (account_id, brand_name, accent, background, logo_hash, favicon_hash, og_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (account_id) DO UPDATE SET brand_name = excluded.brand_name, accent = excluded.accent, background = excluded.background, " +
        "logo_hash = excluded.logo_hash, favicon_hash = excluded.favicon_hash, og_hash = excluded.og_hash, updated_at = excluded.updated_at",
    )
      .bind(accountId, next.brand_name, next.accent, next.background, next.logo_hash, next.favicon_hash, next.og_hash, t)
      .run();
  }

  // Replaced or cleared images go now; other unused ones (left by a call that failed half way) once they're an hour old.
  const replaced = prev ? [prev.logo_hash, prev.favicon_hash, prev.og_hash].filter((h): h is string => !!h) : [];
  await deleteUnusedAssets(env, accountId, [next.logo_hash, next.favicon_hash, next.og_hash], replaced, t - ORPHAN_GRACE_SECONDS);
  return getBranding(env, accountId);
}

/** Deletes (R2 + row) the account's assets not in `keep` that are in `replaced` or were created before `olderThan`. */
async function deleteUnusedAssets(env: Env, accountId: string, keep: (string | null)[], replaced: string[], olderThan: number): Promise<void> {
  const rows = (
    await env.DB.prepare("SELECT hash, r2_key, created_at FROM brand_assets WHERE account_id = ?").bind(accountId).all<{ hash: string; r2_key: string; created_at: number }>()
  ).results.filter((r) => !keep.includes(r.hash) && (replaced.includes(r.hash) || r.created_at < olderThan));
  if (!rows.length) return;
  await env.MEDIA.delete(rows.map((r) => r.r2_key));
  await env.DB.batch(rows.map((r) => env.DB.prepare("DELETE FROM brand_assets WHERE account_id = ? AND hash = ?").bind(accountId, r.hash)));
}

/** Hourly cron: brand images no branding row uses any more, older than the grace period (a batch per run). */
export async function sweepBrandAssets(env: Env, t: number, batch = 100): Promise<number> {
  const rows = (
    await env.DB.prepare(
      "SELECT a.account_id, a.hash, a.r2_key FROM brand_assets a LEFT JOIN branding b ON b.account_id = a.account_id " +
        "WHERE a.created_at < ? AND (b.account_id IS NULL OR a.hash NOT IN (coalesce(b.logo_hash, ''), coalesce(b.favicon_hash, ''), coalesce(b.og_hash, ''))) LIMIT ?",
    )
      .bind(t - ORPHAN_GRACE_SECONDS, batch)
      .all<{ account_id: string; hash: string; r2_key: string }>()
  ).results;
  if (!rows.length) return 0;
  await env.MEDIA.delete(rows.map((r) => r.r2_key));
  await env.DB.batch(rows.map((r) => env.DB.prepare("DELETE FROM brand_assets WHERE account_id = ? AND hash = ?").bind(r.account_id, r.hash)));
  return rows.length;
}

// ---------- serving ----------

const ASSET_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'",
  "cross-origin-resource-policy": "cross-origin",
};

/** If-None-Match holds this ETag (or *). Weak and strong forms both match. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((v) => {
    const s = v.trim().replace(/^W\//, "");
    return s === "*" || s === etag || s === etag.slice(1, -1);
  });
}

/**
 * Brand images cache for 5 minutes, not a year: the bytes behind a hash never change, but an account takedown must stop
 * them within minutes without a CDN purge (an impersonation logo or favicon). The etag keeps revalidation cheap.
 */
const BRAND_ASSET_CACHE = "public, max-age=300";

/**
 * GET|HEAD /b/<64 lowercase hex sha256>: a brand image, on our hosts and (PR1) on customer hosts. The type comes from
 * the stored row, never sniffed by the browser. When two accounts uploaded the same bytes, either account's copy is
 * served (they're identical). Only copies of accounts that aren't suspended (takedown-state.ts): when every account
 * that has it is suspended, 404.
 */
export async function handleBrandAsset(req: Request, env: Env, hash: string): Promise<Response> {
  const notFound = () => new Response("not found", { status: 404, headers: { ...ASSET_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  if (!/^[0-9a-f]{64}$/.test(hash)) return notFound();
  const row = await env.DB.prepare(`SELECT r2_key, content_type, bytes FROM brand_assets b WHERE hash = ? AND NOT ${suspendedSql("b.account_id")} LIMIT 1`)
    .bind(hash)
    .first<{ r2_key: string; content_type: string; bytes: number }>();
  if (!row) return notFound();
  const etag = `"${hash}"`;
  const headers: Record<string, string> = {
    ...ASSET_HEADERS,
    "content-type": row.content_type,
    "cache-control": BRAND_ASSET_CACHE,
    "content-disposition": "inline",
    etag,
  };
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  const obj = req.method === "HEAD" ? await env.MEDIA.head(row.r2_key) : await env.MEDIA.get(row.r2_key);
  if (!obj) {
    log("warn", "brand asset missing in R2", { hash });
    return notFound();
  }
  headers["content-length"] = String(obj.size);
  return new Response(req.method === "HEAD" ? null : (obj as R2ObjectBody).body, { headers });
}
