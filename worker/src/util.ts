// Shared helpers: random IDs, hashing, HMAC, constant-time compare, redacted logging.

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const enc = new TextEncoder();

/** Random base62 string carrying at least `bits` bits of entropy (rejection sampling, no modulo bias). */
export function randomId(bits = 128): string {
  const len = Math.ceil(bits / Math.log2(62));
  let out = "";
  while (out.length < len) {
    const buf = crypto.getRandomValues(new Uint8Array(len * 2));
    for (const b of buf) {
      if (b < 248 && out.length < len) out += B62[b % 62];
    }
  }
  return out;
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacB64(secret: string, msg: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(msg)));
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(msg)));
}

/** Constant-time string equality (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

const PBKDF2_DEFAULT = 100_000;
/** A new passcode's salt. A round count other than the default is part of it ("i10000.<random>"), so pbkdf2 can tell. */
export const passcodeSalt = (iterations: number): string => (iterations === PBKDF2_DEFAULT ? randomId(128) : `i${iterations}.${randomId(128)}`);

export async function pbkdf2(passcode: string, salt: string): Promise<string> {
  const iterations = Number(/^i(\d{4,6})\./.exec(salt)?.[1] ?? PBKDF2_DEFAULT);
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations },
    key,
    256,
  );
  return hex(bits);
}

export const now = () => Math.floor(Date.now() / 1000);

/** HTML-escapes text for element content and quoted attribute values. */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- redaction ----------

const REDACTIONS: [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;]+/gi, "$1$2[REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b(ark|ardt)_[A-Za-z0-9]+_[A-Za-z0-9]+/g, "$1_[REDACTED]"],
  [/\/mcp\/k\/[^\s/?#"']+/g, "/mcp/k/[REDACTED]"],
  [/\/i\/[^\s/?#"']+/g, "/i/[REDACTED]"],
  // Video slugs: a public video's URL is its access key.
  [/\/(v|m)\/[A-Za-z0-9]{10,40}\b/g, "/$1/[REDACTED]"],
  [/([?&](?:s|t|e|o|ot|code|token|key|upload_token|sig)=)[^&\s#"']+/gi, "$1[REDACTED]"],
  [/("(?:api_key|device_token|device_secret|upload_token|code|passcode|token)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"'],
];

export function redact(input: string): string {
  let s = input;
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  return s;
}

/** The only logging entry point. Everything goes through `redact`. */
export function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  const line = redact(extra ? `${msg} ${JSON.stringify(extra)}` : msg);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Path safe to log: strips the query string and any URL-embedded key. */
export function logPath(url: URL): string {
  return redact(url.pathname);
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "127.0.0.1";
}

/** Network bucket for the IP: /24 for IPv4, /64 for IPv6. */
export function ipNet(ip: string): string {
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + "::/64";
  return ip.split(".").slice(0, 3).join(".") + ".0/24";
}
