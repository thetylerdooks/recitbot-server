// Response helpers for the OAuth endpoints and CORS for /mcp.
import { json } from "../util";

/** application/x-www-form-urlencoded body of at most `max` bytes, else null. */
export async function readForm(req: Request, max: number): Promise<URLSearchParams | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const buf = await req.arrayBuffer();
  return buf.byteLength <= max ? new URLSearchParams(new TextDecoder().decode(buf)) : null;
}

const PUBLIC_CORS = { "access-control-allow-origin": "*" };

export const corsJson = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  json(data, status, { ...PUBLIC_CORS, ...headers });

/** RFC 6749 section 5.2 error body. */
export const oauthError = (error: string, description: string, status = 400, headers: Record<string, string> = {}) =>
  corsJson({ error, error_description: description }, status, headers);

/** Preflight for the discovery documents and the token, registration and revocation endpoints. */
export const publicPreflight = () =>
  new Response(null, {
    status: 204,
    headers: {
      ...PUBLIC_CORS,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version",
      "access-control-max-age": "600",
    },
  });

/** Origins refused at /mcp. Empty: /mcp is bearer-only (no cookies), so any origin may call it. */
const MCP_DENIED_ORIGINS: ReadonlySet<string> = new Set();

/** CORS for /mcp: answers the preflight and echoes the caller's Origin on the actual response. */
export async function withMcpCors(req: Request, next: () => Promise<Response>): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin && MCP_DENIED_ORIGINS.has(origin)) return json({ error: "forbidden origin" }, 403);
  const cors: Record<string, string> = origin
    ? { "access-control-allow-origin": origin, "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id", vary: "Origin" }
    : {};
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
        "access-control-max-age": "600",
      },
    });
  }
  const res = await next();
  if (!origin) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}
