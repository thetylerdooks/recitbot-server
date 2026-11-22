// GET /health on our hosts (hosts.ts "ours"; on any other host it is whatever that host answers for an unknown path): is
// this server up and configured. No sign-in, no D1, R2 or Durable Object call, and nothing about the deployment but its
// version and, while its configuration has errors, the names of the settings to fix (the same ones the 500 answer names).
import { getConfig } from "./config";
import type { Env } from "./env";
import { requestHostKind } from "./hosts";
import { json } from "./util";

/** The server's version: here and in the MCP initialize answer. */
export const SERVER_VERSION = "0.1.0";

/** null = not a health request (index.ts goes on). */
export function handleHealth(req: Request, env: Env): Response | null {
  if (new URL(req.url).pathname !== "/health" || requestHostKind(req, env) !== "ours") return null;
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD" });
  const { errors } = getConfig(env);
  const ok = errors.length === 0;
  // Every error starts with the name of its var or secret.
  const names = [...new Set(errors.map((e) => /^[A-Z][A-Z0-9_]*/.exec(e)?.[0] ?? "CONFIG"))];
  const res = json({ ok, version: SERVER_VERSION, configured: ok, ...(!ok && { errors: names }) }, ok ? 200 : 500);
  return req.method === "HEAD" ? new Response(null, res) : res;
}
