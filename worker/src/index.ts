import { z } from "zod";
import { bearer, pairDevice, revokedDeviceToken, verifyDeviceToken } from "./auth";
import { handleBrandAsset, sweepBrandAssets } from "./branding";
import { deviceCommandKey, deviceHub, type UninstallScope } from "./device-hub";
import { configErrorResponse, getConfig } from "./config";
import { hostGate } from "./custom-host";
import type { Env } from "./env";
import { refreshCustomDomains } from "./custom-domains";
import { deviceLimitMessage, LIMITS, serviceMode } from "./env";
import { geoGate, isGatedAsset, MAC_ZIP } from "./geo";
import { governor } from "./governor";
import { hiddenBrandFile } from "./brand-page";
import { handleHealth } from "./health";
import { handleHome, isHomeFile, isHtml, isPagePath, pageRequest, renderPage } from "./home";
import { handleInstallerLink } from "./installer";
import { deleteRecordings, handleMcp } from "./mcp";
import { routeOAuth, withMcpCors } from "./oauth";
import { expiredRecordingIds, handleComments, handleLegacyViewer, handleMedia, handleVideoBeacon, handleVideoDownload, handleVideoFile, handleVideoMeta, handleVideoShare, handleViewer } from "./share";
import { handleBeacon, rememberDeviceIp } from "./stats";
import { handleReport } from "./report";
import { reconcileStorage } from "./storage";
import { SUSPENDED_MESSAGE } from "./takedown-state";
import { handleStripeWebhook } from "./stripe";
import { abortMultipartUploads, handleKeyframe, handleUpload } from "./upload";
import { clientIp, hmacHex, json, log, logPath, now } from "./util";

export { DeviceHub } from "./device-hub";
export { Governor } from "./governor";

/** Where Stripe Checkout and the billing portal send the user back. Everything else happens in the bot. */
const BILLING_PAGES: Record<string, string> = {
  "/billing/success": "You're on {product}Pro. Go back to your bot to keep going.",
  "/billing/cancel": "Checkout canceled. Nothing was charged. Go back to your bot.",
  "/billing/return": "All set. Go back to your bot.",
  "/billing/storage": "Your extra 100 GB is on its way and should show up within a minute. Go back to your bot.",
};
const billingPage = (msg: string, branded: boolean) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<title>${branded ? "Recitbot" : "Billing"}</title></head><body><p>${msg.replace("{product}", branded ? "Recitbot " : "")}</p></body></html>
`;

const EnrollBody = z.object({
  code: z.string().regex(/^[A-Za-z0-9]{10,40}$/),
  name: z.string().min(1).max(64).default("Windows PC"),
  /** What the recorder runs on. Optional: older recorders do not send it (the pairing code's platform fills in). */
  platform: z.enum(["windows", "macos"]).optional(),
  /** Re-pairing a PC that is already paired: its current device token; with the same platform its device row is reused. */
  device_token: z.string().max(200).optional(),
});

/**
 * A device token of an uninstalled device (uninstall_recorder). The recorder removes what `scope` says: "account" =
 * this account's pairing only, "all" = Recitbot completely.
 */
const DEVICE_REVOKED = (scope: UninstallScope) => json({ error: "device_revoked", scope }, 410);

async function enroll(req: Request, env: Env): Promise<Response> {
  const ipHash = await hmacHex(env.IP_HASH_KEY, `ip:${clientIp(req)}`);
  const g = governor(env);
  const t = now();
  if (!(await g.hit(`authfail:${ipHash}`, LIMITS.authFailuresPer10Min, 600, t, false)).ok) {
    return json({ error: "too many failed attempts" }, 429);
  }
  const parsed = EnrollBody.safeParse(await req.json().catch(() => null));
  const p = parsed.success
    ? await pairDevice(env, parsed.data.code, {
        name: parsed.data.name,
        platform: parsed.data.platform ?? null,
        ipHash,
        deviceToken: parsed.data.device_token,
      })
    : null;
  if (!p || (!p.ok && p.error === "invalid_code")) {
    await g.hit(`authfail:${ipHash}`, LIMITS.authFailuresPer10Min, 600, t);
    return json({ error: "invalid or expired pairing code" }, 401);
  }
  // A valid code for a full account: nothing changed, the code still works once a device is removed.
  if (!p.ok && p.error === "device_revoked") return DEVICE_REVOKED(p.scope);
  if (!p.ok && p.error === "account_suspended") {
    log("warn", "enroll refused: account suspended", { account_id: p.accountId });
    return json({ error: "ACCOUNT_SUSPENDED", message: SUSPENDED_MESSAGE }, 403);
  }
  if (!p.ok) return json({ error: "device_limit", message: deviceLimitMessage(env, p.max), max_devices: p.max }, 409);
  if (p.replaced) await deviceHub(env, p.accountId).disconnect(p.replaced);
  return json({
    account_id: p.accountId,
    device_id: p.deviceId,
    device_token: p.token,
    device_secret: await deviceCommandKey(env, p.deviceId),
  });
}

async function deviceSocket(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
  const token = bearer(req) ?? "";
  const dev = await verifyDeviceToken(env, token);
  if (!dev) {
    const revoked = await revokedDeviceToken(env, token);
    return revoked ? DEVICE_REVOKED(revoked.scope) : new Response("unauthorized", { status: 401 });
  }
  await rememberDeviceIp(env, req, dev.deviceId);
  // The connect counts as a sighting. Written here, not in the DeviceHub, which keeps awaited I/O out of socket events.
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now(), dev.deviceId).run();
  // Never forward client-supplied identity headers: build a fresh request.
  const headers = new Headers({ upgrade: "websocket", "x-ar-account": dev.accountId, "x-ar-device": dev.deviceId, "x-ar-origin": new URL(req.url).origin });
  return deviceHub(env, dev.accountId).fetch(new Request("https://hub/ws", { headers }));
}

/** Our hosts' routes. null = no route matched: index.ts then tries the static assets (staticAsset), else 404. */
async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  const mode = serviceMode(env);
  // How to report a video page (ABUSE_EMAIL). Static, so it answers even while the service is off. Our hosts only: the
  // host gate 404s it on customer hosts.
  if (p === "/report") return handleReport(req, env);
  if (mode === "OFF") return (await staticAsset(req, env, p)) ?? json({ error: "SERVICE_PAUSED" }, 503);

  // Stripe retries for days, so a paused service answering 503 above loses nothing.
  if (p === "/api/stripe/webhook") return handleStripeWebhook(req, env);
  if (p === "/mcp") return withMcpCors(req, () => handleMcp(req, env, ctx, null));
  const oauth = await routeOAuth(req, env, url);
  if (oauth) return oauth;
  if (p.startsWith("/mcp/k/")) {
    // Key-in-URL is off by default; enable only for clients that cannot send headers.
    if (env.ALLOW_URL_KEY !== "true") return json({ error: "not found" }, 404);
    return handleMcp(req, env, ctx, decodeURIComponent(p.slice("/mcp/k/".length)));
  }
  if (p === "/device/enroll" && req.method === "POST") {
    if (mode === "READ_ONLY") return json({ error: "SERVICE_PAUSED" }, 503);
    return enroll(req, env);
  }
  if (p === "/device/ws") return deviceSocket(req, env);

  let m = /^\/upload\/([A-Za-z0-9]{20,30})\/(video|audio|complete)$/.exec(p);
  if (m) return handleUpload(req, env, ctx, m[1], m[2]);
  m = /^\/upload\/([A-Za-z0-9]{20,30})\/(video|audio)\/mp(?:\/(\d{1,3}|complete))?$/.exec(p);
  if (m) return handleUpload(req, env, ctx, m[1], m[2], m[3] ?? "");
  m = /^\/upload\/([A-Za-z0-9]{20,30})\/keyframes\/(\d{1,2})$/.exec(p);
  if (m) return handleKeyframe(req, env, m[1], m[2]);
  m = /^\/v\/([A-Za-z0-9]{20,30})$/.exec(p);
  if (m && (req.method === "GET" || req.method === "POST")) return handleLegacyViewer(req, env, m[1]);
  m = /^\/v\/([A-Za-z0-9]{20,30})\/b$/.exec(p);
  if (m && req.method === "POST") return handleBeacon(req, env, m[1]);
  if (p.startsWith("/i/") && req.method === "GET") return handleInstallerLink(req, env, p.slice("/i/".length));
  m = /^\/([A-Za-z0-9-]{1,64})\/v\/([A-Za-z0-9]{10,40})(\/b)?$/.exec(p);
  if (m && !m[3] && (req.method === "GET" || req.method === "POST")) return handleViewer(req, env, m[1], m[2]);
  if (m && m[3] && req.method === "POST") return handleVideoBeacon(req, env, m[2]);
  m = /^\/([A-Za-z0-9-]{1,64})\/v\/([A-Za-z0-9]{10,40})\/meta$/.exec(p);
  if (m && req.method === "PATCH") {
    if (mode === "READ_ONLY") return json({ error: "SERVICE_PAUSED" }, 503);
    return handleVideoMeta(req, env, m[1], m[2]);
  }
  m = /^\/([A-Za-z0-9-]{1,64})\/v\/([A-Za-z0-9]{10,40})\/share$/.exec(p);
  if (m && req.method === "POST") {
    if (mode === "READ_ONLY") return json({ error: "SERVICE_PAUSED" }, 503);
    return handleVideoShare(req, env, m[1], m[2]);
  }
  m = /^\/([A-Za-z0-9-]{1,64})\/v\/([A-Za-z0-9]{10,40})\/download$/.exec(p);
  if (m && (req.method === "GET" || req.method === "HEAD")) return handleVideoDownload(req, env, m[1], m[2]);
  m = /^\/([A-Za-z0-9-]{1,64})\/v\/([A-Za-z0-9]{10,40})\/comments(?:\/([A-Za-z0-9]{10,40}))?$/.exec(p);
  if (m && (m[3] ? req.method === "DELETE" : req.method === "GET" || req.method === "POST")) {
    return handleComments(req, env, m[1], m[2], m[3] ?? null);
  }
  m = /^\/b\/([0-9a-f]{64})$/.exec(p);
  if (m && (req.method === "GET" || req.method === "HEAD")) return handleBrandAsset(req, env, m[1]);
  m = /^\/m\/([A-Za-z0-9]{10,40})$/.exec(p);
  if (m && req.method === "GET") return handleMedia(req, env, m[1]);
  m = /^\/m\/([A-Za-z0-9]{10,40})\/file$/.exec(p);
  if (m && (req.method === "GET" || req.method === "HEAD")) return handleVideoFile(req, env, m[1]);
  if (BILLING_PAGES[p] && getConfig(env).billing.enabled && (req.method === "GET" || req.method === "HEAD")) {
    return new Response(req.method === "HEAD" ? null : billingPage(BILLING_PAGES[p], getConfig(env).site.brandName !== null), {
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff", "cache-control": "no-store" },
    });
  }
  // "/" is the Worker's only: the homepage on our site (HOME_SITE_ENABLED), never the asset server's index.html on the MCP host.
  if (p === "/") return ((req.method === "GET" || req.method === "HEAD") && (await handleHome(req, env))) || NOT_FOUND();
  return null;
}

const NOT_FOUND = () => json({ error: "not found" }, 404);

/**
 * run_worker_first is true (wrangler.jsonc), so on our hosts the asset server's files (homepage pages, /s/*, fonts,
 * favicons) come through here once no route matched, exactly as the asset server served them before. GET/HEAD only;
 * missing: null. Customer hosts never get here (custom-host.ts serves only /s/*).
 */
async function staticAsset(req: Request, env: Env, p: string): Promise<Response | null> {
  if ((req.method !== "GET" && req.method !== "HEAD") || p === "/") return null;
  // The homepage's pages and files only with the homepage on (config.ts homeSiteEnabled).
  const homeOn = getConfig(env).site.homeSiteEnabled;
  if (!homeOn && isHomeFile(p)) return null;
  // No BRAND_NAME: the product's icons and logos are not there (browsers ask for /favicon.ico by themselves).
  if (!isHomeFile(p) && hiddenBrandFile(env, p)) return null;
  const res = await env.ASSETS.fetch(isPagePath(p) ? pageRequest(req) : req);
  // Every HTML asset is a homepage page, however its path was spelled (%74erms): filled in, or with the homepage off 404.
  if (res.status !== 404 && (homeOn || !isHtml(res))) return renderPage(req, env, res);
  await res.body?.cancel();
  return null;
}

export async function cleanup(
  env: Env,
  t = now(),
): Promise<{ deleted: number; storage?: Awaited<ReturnType<typeof reconcileStorage>>; domains?: Awaited<ReturnType<typeof refreshCustomDomains>> }> {
  // Workers Free (config.ts workers): fewer rows per run, so one run stays under its subrequest limit. What's left waits an hour.
  const { cleanupBatch, cleanupRecordings, readyBeforeTranscript } = getConfig(env).workers;
  const batch = cleanupBatch ?? undefined;
  // Each recording goes at its own expires_at (free tier: 7 days, 24 h for older rows). Owner-tier ones are kept until deleted.
  const ids = await expiredRecordingIds(env, t, cleanupRecordings);
  await deleteRecordings(env, ids);
  // Chunked uploads older than a day (far past any upload token) never complete: abort them.
  await abortMultipartUploads(env, "created_at < ?", [t - 86400], batch);
  await env.DB.batch([
    // Stuck once the upload token is dead: max_seconds plus the upload grace (longer for long recordings, see uploadGrace).
    env.DB.prepare(
      "UPDATE recordings SET status = 'failed', error = 'TIMEOUT' WHERE status IN ('starting','recording','uploading') " +
        "AND created_at + max_seconds + CASE WHEN max_seconds > ? THEN ? ELSE ? END < ?",
    ).bind(LIMITS.maxSeconds, LIMITS.longUploadGraceSeconds, LIMITS.uploadGraceSeconds, t),
    env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").bind(t - 86400),
    // Yesterday's salt is still needed until today's views stop deduping against it; older ones go.
    env.DB.prepare("DELETE FROM view_salts WHERE day < ?").bind(Math.floor(t / 86400) - 1),
    // Sign-ins and sessions past their own expires_at are never read as valid again. Codes and tokens are kept a day
    // longer, so a replayed code still revokes its family and an expired token still reads as stale, not unknown.
    env.DB.prepare("DELETE FROM oauth_pending WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM web_sessions WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(t - 86400),
    env.DB.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(t - 86400),
    // A transcription that ran out of CPU never finishes: the video is ready, its transcript isn't coming (ready.ts).
    ...(readyBeforeTranscript
      ? [
          env.DB.prepare(
            "UPDATE recordings SET status = 'ready', transcript_status = 'unavailable' WHERE created_at + max_seconds + ? < ? " +
              "AND (status = 'transcribing' OR (status = 'ready' AND transcript_status = 'pending'))",
          ).bind(LIMITS.uploadGraceSeconds, t),
        ]
      : []),
  ]);
  await governor(env).prune(t);
  // Brand images no branding uses any more (left by a set_branding that failed half way).
  await sweepBrandAssets(env, t, batch).catch((e) => log("error", "brand asset sweep failed", { err: String(e) }));
  // Recordings from before migration 0024 get their real sizes (and lose already-transcribed WAVs), a batch per hour.
  const storage = await reconcileStorage(env, batch).catch((e) => {
    log("error", "storage reconcile failed", { err: String(e) });
    return null;
  });
  // Custom video domains: re-check pending ones, fail the stale, delete expired redirects (custom-domains.ts).
  const domains = await refreshCustomDomains(env, t, batch).catch((e) => {
    log("error", "custom domain refresh failed", { err: String(e) });
    return null;
  });
  return { deleted: ids.length, ...(storage && { storage }), ...(domains && { domains }) };
}

/** install.ps1, recorder.zip, ...: as the asset server sends them. The Mac files get explicit types (.sh has none). */
async function installerAsset(req: Request, env: Env, p: string): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  const type = p.endsWith(".sh") ? "text/x-shellscript; charset=utf-8" : MAC_ZIP.test(p) ? "application/zip" : null;
  if (!type || !res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set("content-type", type);
  headers.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    let res: Response;
    try {
      // A misconfigured deployment answers what to fix (names only, never values) instead of failing deep in a handler.
      const cfg = getConfig(env);
      const health = handleHealth(req, env);
      if (health) return health;
      if (cfg.errors.length) {
        log("error", "configuration errors", { errors: cfg.errors });
        return configErrorResponse(cfg);
      }
      // Customer and reserved hosts stop at the host gate; only our hosts reach geoGate, installer files and route().
      res =
        (await hostGate(req, env)) ??
        geoGate(req, env) ??
        (isGatedAsset(url.pathname)
          ? await installerAsset(req, env, url.pathname)
          : ((await route(req, env, ctx)) ?? (await staticAsset(req, env, url.pathname)) ?? NOT_FOUND()));
    } catch (e) {
      log("error", "unhandled", { path: logPath(url), err: String(e) });
      res = json({ error: "internal error" }, 500);
    }
    log("info", `${req.method} ${logPath(url)} ${res.status}`);
    return res;
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cfg = getConfig(env);
    if (cfg.errors.length) {
      log("error", "cleanup skipped: configuration errors", { errors: cfg.errors });
      return;
    }
    ctx.waitUntil(cleanup(env).then((r) => log("info", "cleanup", r)));
  },
} satisfies ExportedHandler<Env>;
