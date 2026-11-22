import type { DeviceHub } from "./device-hub";
import { getConfig } from "./config";
import { canUseCustomBranding } from "./entitlements";
import type { Governor } from "./governor";
import { claimedOwner } from "./oauth/claim";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  GOVERNOR: DurableObjectNamespace<Governor>;
  ASSETS: Fetcher;
  AI?: Ai;

  DEV_MODE: string;
  SERVICE_MODE: string;
  ALLOW_URL_KEY: string;
  GLOBAL_MAX_VIDEOS_PER_DAY: string;
  GLOBAL_MAX_TRANSCRIBE_MIN_PER_DAY: string;
  /**
   * "free" = this deployment runs on the Workers Free plan: cheaper settings that fit its CPU and subrequest limits
   * (config.ts workers, docs/workers-free-plan.md). Anything else or unset = the standard ones.
   */
  WORKERS_PLAN?: string;
  // Operator configuration (config.ts parses all of it; SELFHOST_CONFIG.md documents every name). All optional.
  /** Origin for every absolute URL the Worker hands out (share links, installer). Unset = the request's origin. */
  PUBLIC_BASE_URL?: string;
  /** Origin of the MCP host (its own OAuth issuer). Requests on hosts that aren't ours use it as their issuer. */
  MCP_BASE_URL?: string;
  /** Comma-separated extra hostnames that are ours (e.g. www.). The first is the canonical host without PUBLIC_BASE_URL. */
  SITE_HOSTNAMES?: string;
  /** The zone our hosts live in: any other name under it is reserved (404). Unset = PUBLIC_BASE_URL's host. */
  SITE_ZONE?: string;
  /** Name shown to viewers and in emails, with the product's logo and icons. Unset = none of them (config.ts brandName). */
  BRAND_NAME?: string;
  /** Contact address in user-facing messages. Unset = EMAIL_FROM. */
  SUPPORT_EMAIL?: string;
  /** Where video pages are reported. Unset = SUPPORT_EMAIL. */
  ABUSE_EMAIL?: string;
  /** The "Powered by" / watermark link. Unset = PUBLIC_BASE_URL. */
  HOME_URL?: string;
  /** "true" = serve the static homepage (worker/home) on "/" and its pages, once the five below are set too. Else 404. */
  HOME_SITE_ENABLED?: string;
  /** The homepage's operator values ({{MARKERS}} in worker/home): footer name and link, company on the legal pages, card
   * statement line, "Add to" bot template link. */
  OPERATOR_NAME?: string;
  OPERATOR_URL?: string;
  LEGAL_ENTITY_NAME?: string;
  STATEMENT_DESCRIPTOR?: string;
  TEMPLATE_URL?: string;
  /** MCP documentation link in OAuth discovery. Unset = <base>/docs/mcp while the homepage is on, else none. */
  DOCS_URL?: string;
  /** Comma-separated ISO country codes (or EU_EEA_UK) refused the MCP, sign-in and installer routes (451). */
  BLOCKED_COUNTRIES?: string;
  /** Comma-separated owner account ids: no plan time limit per recording, kept until deleted. Empty or "__SET_BY_DEPLOY__" = none. */
  OWNER_ACCOUNT_IDS?: string;
  /**
   * One-time owner claim (oauth/claim.ts): whoever sends this secret to POST /claim of a fresh server becomes its
   * owner. Random, 32+ characters. Unset, or once the server has an owner or any account = no claim.
   */
  OWNER_CLAIM_SECRET?: string;
  /** Sign-in email (Cloudflare Email Sending). Without it sign-in fails closed, except on loopback with OAUTH_DEV_LOG_LINKS=1. */
  EMAIL?: SendEmail;
  /** Sign-in email sender address (display name BRAND_NAME). Unset = no email is sent. */
  EMAIL_FROM?: string;
  /** "1" on a loopback dev host: sign-in links and codes are logged instead of emailed. Never set in production. */
  OAUTH_DEV_LOG_LINKS?: string;
  /**
   * Cloudflare Turnstile for sign-in and viewer comments (site key in the page, secret for siteverify). Either one
   * missing = viewers can't comment (the form is hidden and POST answers 503) and sign-in is refused, unless
   * TURNSTILE_DISABLED is "true" (sign-in without a bot check). Local dev and tests use Cloudflare's always-pass test keys.
   */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_DISABLED?: string;
  /** Exactly "true" = no new accounts by any path; existing accounts sign in as normal. */
  SIGNUPS_DISABLED?: string;
  /**
   * Comma-separated emails that may still create an account while SIGNUPS_DISABLED is on (trimmed, case-insensitive,
   * exact address). Ignored while signups are open. Unset = nobody.
   */
  SIGNUPS_ALLOWLIST?: string;

  /** Stripe (Pro). Billing is on only with STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRO_PRICE_ID; off =
   * upgrade/billing answer "billing is not enabled on this server" and the webhook route is 404. Price and portal
   * configuration ids are plain vars. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Pro monthly ($10/mo) and yearly ($100/yr) prices on the Pro product: subscriptions on either get plan 'pro'. */
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_PRO_YEARLY_PRICE_ID?: string;
  /**
   * Teams per-seat monthly ($8/user/mo) and yearly ($80/user/yr) prices: subscriptions on either get plan 'teams'.
   * Checkout for Teams is not built yet (upgrade sells Pro only); checkoutLineItem (stripe.ts) already prices it per seat.
   */
  STRIPE_TEAMS_PRICE_ID?: string;
  STRIPE_TEAMS_YEARLY_PRICE_ID?: string;
  STRIPE_PORTAL_CONFIG_ID?: string;
  /** Storage add-on price (+100 GB, $3/mo, recurring monthly): add_storage adds it to the account's subscription (monthly plans only). Empty = off. */
  STRIPE_STORAGE_ADDON_PRICE_ID?: string;

  /**
   * Custom video domains (Cloudflare for SaaS on the operator's zone). Secret CF_SAAS_API_TOKEN (Zone -> SSL and
   * Certificates: Edit, that zone only), var CF_ZONE_ID and var CUSTOM_DOMAIN_CNAME_TARGET (what customers point their
   * CNAME at); any missing = custom domains are off. Requests on those hosts: custom-host.ts.
   */
  CF_SAAS_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CUSTOM_DOMAIN_CNAME_TARGET?: string;

  SHARE_HMAC_KEY: string;
  UPLOAD_HMAC_KEY: string;
  DEVICE_CMD_KEY: string;
  IP_HASH_KEY: string;
  /** Signs the short-lived installer download links (/i/<token>). */
  INSTALLER_URL_KEY: string;
}

export type ServiceMode = "ON" | "NO_TRANSCRIBE" | "READ_ONLY" | "OFF";

/** Unknown values fail closed to OFF. */
export function serviceMode(env: Env): ServiceMode {
  const m = (env.SERVICE_MODE ?? "").toUpperCase();
  return m === "ON" || m === "NO_TRANSCRIBE" || m === "READ_ONLY" || m === "OFF" ? m : "OFF";
}

/**
 * True when accountId is listed in OWNER_ACCOUNT_IDS. Unset, empty or the deploy placeholder = no owners. (The account
 * that claimed the server has accounts.plan 'owner', so everything that asks for the tier treats it the same.)
 */
export function isOwnerAccount(env: Env, accountId: string): boolean {
  return accountId !== "" && getConfig(env).auth.ownerAccountIds.includes(accountId);
}

/**
 * May use the operator tools: in OWNER_ACCOUNT_IDS, or, while that is empty, the account that claimed this server
 * (server_claim, oauth/claim.ts). Never accounts.plan, which a migration or Stripe bug could set.
 */
export async function isOperatorAccount(env: Env, accountId: string): Promise<boolean> {
  if (getConfig(env).auth.ownerAccountIds.length > 0) return isOwnerAccount(env, accountId);
  return accountId !== "" && (await claimedOwner(env)) === accountId;
}

/**
 * Base for generated absolute URLs: PUBLIC_BASE_URL (https, or loopback for dev) when set and valid, else the request
 * origin. Lets public-site links come out of requests that arrived on workers.dev or the MCP host.
 */
export function publicBase(env: Env, requestOrigin: string): string {
  return getConfig(env).site.publicBaseUrl ?? requestOrigin;
}

export const LIMITS = {
  /** Free tier: length and per-recording totals (5 min; past one PUT the video goes up through the chunked upload). */
  maxSeconds: 300,
  maxVideoBytes: 250 * 1024 * 1024,
  /** 5 min of the 16 kHz mono PCM16 transcription WAV is ~9.6 MB. */
  maxAudioBytes: 10 * 1024 * 1024,
  /** Recorders without chunked_upload can only send one PUT per file: they record at most this long. */
  singleUploadMaxSeconds: 120,
  viewsPerVideoPerDay: 20000,
  /** Page loads per viewer (salted IP hash) per video per UTC day. The owner is never capped. */
  viewsPerViewerPerVideoPerDay: 300,
  /** Free tier: new recordings are deleted this long after they start (each row keeps its own expires_at). */
  retentionSeconds: 7 * 24 * 3600,
  /**
   * Legacy /v/<id>?e= links only (no longer handed out, always signed for at most 24 h). Today's video URL lives exactly
   * as long as its video: 7 days for new free recordings, until deleted for owners.
   */
  legacyShareMaxSeconds: 24 * 3600,
  mediaTokenSeconds: 300,
  /** get_recording_for_skill include_video: the signed /m/<slug>/file link to the MP4 works this long. */
  videoFileUrlSeconds: 900,
  pairingCodeSeconds: 600,
  mcpCallsPerMinute: 60,
  signupsPerIpPerDay: 3,
  signupsPerNetPerDay: 10,
  /** Sign-in emails (code + magic link) across all users per UTC day. */
  signinEmailsPerDay: 500,
  authFailuresPer10Min: 10,
  passcodeMaxFailures: 5,
  passcodeLockSeconds: 900,
  deviceReportMaxAgeSeconds: 600,
  deviceReportTimeoutMs: 4000,
  /**
   * A device socket counts as online only while it shows life this recently (its "ping", every 45 s on Windows and
   * Mac, any message, or the connect). Older = a dead connection the runtime has not noticed (sleep, network change).
   */
  deviceHeartbeatTimeoutSeconds: 120,
  /** uninstall_recorder waits this long for the recorder's ack before revoking anyway (pending_on_device). */
  uninstallAckTimeoutMs: 30_000,
  /** start_recording(window) uses the last window list when it is younger than this and has the window, else asks the PC live. */
  windowReportMaxAgeSeconds: 60,
  /** View stats: how long a player page may send beacons, beacons per view per hour, counted bot previews per day. */
  viewTokenSeconds: 6 * 3600,
  beaconsPerViewPerHour: 20,
  previewsPerVideoPerDay: 50,
  /** The per-day breakdown window of get_video_stats. */
  statsDays: 30,
  /** The ready push (auto-open of the share link) waits at most this long for the transcript. */
  readyPushWaitMs: 10_000,
  /** Pro and Teams: longest recording (4 h). The start command's max_seconds; past it LIMIT_EXCEEDED. */
  paidMaxSeconds: 4 * 3600,
  /**
   * The most start_recording accepts, and the owner tier's length (it has no plan time limit, AccountLimits.maxSeconds
   * null): the signed start command still needs a max_seconds (0 would stop the recorder after 1 s), and the upload
   * token and the stuck-recording timeout are sized from it. Recorder 0.6.1 clamps every start to 14400 s on its own
   * (older ones to 1800 s).
   */
  recordingCeilingSeconds: 4 * 3600,
  /**
   * Owner and paid tiers: per-recording totals. Free = maxVideoBytes / maxAudioBytes. Video: recorder 0.6.1 caps a
   * chunked recording's video at 8 GiB (ffmpeg -fs, for up to 4 h); past one PUT it comes through the chunked upload.
   */
  ownerMaxVideoBytes: 8 * 1024 * 1024 * 1024,
  /**
   * The 16 kHz mono PCM16 transcription WAV is 32000 bytes/s: 4 h is ~461 MB (the Windows mic runs 30 s past
   * max_seconds). More than one PUT: it goes through the chunked upload.
   */
  ownerMaxAudioBytes: 480 * 1024 * 1024,
  /**
   * The most of a transcription WAV read into memory at once (a short WAV, or one whose header is not plain PCM16 and so
   * can't be windowed). Longer ones are read in transcribeChunkSeconds windows.
   */
  wholeWavMaxBytes: 64 * 1024 * 1024,
  /** One PUT body (Cloudflare caps a request body at 100 MB). Larger files use the chunked (R2 multipart) upload. */
  singleUploadMaxBytes: 80 * 1024 * 1024,
  /** Chunked upload: every part but the last is the same size, 16-50 MiB; the recorder is told uploadPartBytes. */
  uploadPartBytes: 32 * 1024 * 1024,
  minPartBytes: 16 * 1024 * 1024,
  maxPartBytes: 50 * 1024 * 1024,
  /** Enough for ownerMaxVideoBytes at the smallest part size (8 GiB / 16 MiB); recorders use 256 parts of 32 MiB. */
  maxParts: 512,
  /** Upload token lifetime after max_seconds: short recordings, and long ones (bigger files, slower uploads). */
  uploadGraceSeconds: 1800,
  longUploadGraceSeconds: 7200,
  /**
   * Keyframes (recorder 0.6.1): JPEG stills per recording (slots 1..maxKeyframes) and the most one may weigh. The
   * recorder sends at most 6 of at most 1 MiB each, after the MP4 upload (upload.ts handleKeyframe).
   */
  maxKeyframes: 6,
  keyframeMaxBytes: 1024 * 1024,
  /** Long audio is transcribed in windows of this length (Whisper input size, Worker memory). */
  transcribeChunkSeconds: 300,
  /** Transcription minutes per account per UTC day: free, and paid (pro, teams). Owners have none (global cap only). */
  transcribeMinPerDay: 60,
  paidTranscribeMinPerDay: 600,
  /** Comments on shared videos: per viewer (cookie or IP, whichever trips first), per video, sizes, delete window. */
  commentsPerViewer: 3,
  commentsViewerWindowSeconds: 600,
  commentsPerVideoPerDay: 100,
  commentsPerVideoPer30Days: 500,
  commentDuplicateSeconds: 24 * 3600,
  commentDeleteSeconds: 600,
  commentBodyMax: 500,
  commentNameMax: 40,
  /** Newest comments rendered on the watch page. */
  commentsShown: 200,
  /** Free tier: paired devices at once (owners: any number). Pairing past it is refused until one is removed. */
  maxDevices: 2,
  /** request_email_change: code lifetime, wrong codes before the request is locked, requests per account / new address per hour. */
  emailChangeCodeSeconds: 600,
  emailChangeMaxAttempts: 5,
  emailChangesPerAccountPerHour: 3,
  emailChangesPerAddressPerHour: 3,
  /**
   * Free tier: recordings an account may start while on Free, in its whole lifetime (accounts.free_recordings_used).
   * Never resets; deleting a recording never gives one back; failed starts are handed back.
   */
  freeRecordings: 25,
  /**
   * Recording starts per UTC day on the owner tier (failed starts are handed back). Pro and Teams have no daily count
   * (storage is their limit); Free has freeRecordings. GLOBAL_MAX_VIDEOS_PER_DAY still applies to every tier.
   */
  ownerStartsPerDay: 500,
  /**
   * Free starts may use at most this share of GLOBAL_MAX_VIDEOS_PER_DAY; the rest is room only paid and owner starts
   * can use, so Free usage never locks out paying users.
   */
  freeShareOfGlobalVideos: 0.8,
  /**
   * Pro and Teams: stored video per account (Teams: per seat, i.e. per member account), decimal GB as sold. At or over
   * it start_recording is refused (storage_limit_reached); each storage add-on adds storageAddonBytes. storage.ts.
   */
  storageBytesPerSeat: 100 * 1e9,
  storageAddonBytes: 100 * 1e9,
  /** start_recording and account_info carry storage_warning from this share of the cap on. */
  storageWarnShare: 0.9,
} as const;

/** Plan stored on accounts.plan (set by the Stripe webhook, stripe.ts). "teams" has Pro's limits. */
export type Plan = "free" | "pro" | "teams";
/**
 * "owner" comes from OWNER_ACCOUNT_IDS or accounts.plan = 'owner' (set by the owner claim or by hand, never by Stripe): a
 * permanent free admin plan, never billed.
 */
export type Tier = Plan | "owner";
/**
 * maxDevices null = unlimited. watermark: the watch page shows the Recitbot pill over the player (share.ts), the one
 * source of truth for it. Read per page load from the account's current tier, never stored on the recording, so an
 * upgrade removes it everywhere at once; only the page overlay, the media file is never stamped.
 */
export type AccountLimits = {
  tier: Tier;
  /** Longest recording in seconds; null = no plan time limit (owner; start uses LIMITS.recordingCeilingSeconds). */
  maxSeconds: number | null;
  maxVideoBytes: number;
  maxAudioBytes: number;
  maxDevices: number | null;
  /** True = new recordings are kept until deleted (expires_at KEEP_FOREVER); false = LIMITS.retentionSeconds. */
  keepForever: boolean;
  watermark: boolean;
  /** Recording starts per UTC day (LIMITS.ownerStartsPerDay), enforced by Governor.checkStart; null = none (free, pro, teams). */
  startsPerDay: number | null;
  /** Recordings started on Free, lifetime (LIMITS.freeRecordings); null = no such limit (paid, owner). */
  freeRecordings: number | null;
  /** Transcription minutes per UTC day; null = no per-account cap (owner), the global cap still applies. */
  transcribeMinPerDay: number | null;
  /** One custom video domain and page branding (entitlements.ts): pro, teams, owner. */
  customDomain: boolean;
};

/** Daily start cap for checkStart: owner only. Free's limit is LIMITS.freeRecordings in total; Pro and Teams have none. */
export const startsPerDay = (tier: Tier): number | null => (tier === "owner" ? LIMITS.ownerStartsPerDay : null);

/** The account's plan (accounts.plan); unknown values and missing rows are free. */
export async function accountPlan(env: Env, accountId: string): Promise<Tier> {
  const r = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string | null }>();
  const p = r?.plan;
  return p === "pro" || p === "teams" || p === "owner" ? p : "free";
}

/**
 * Limits for a tier. Owners and paid plans (pro, teams) share them: no recording count, kept forever (storage is the
 * limit, storage.ts), up to 4 h per recording (owners: no plan time limit, only the start ceiling); only free has the
 * other caps and the watermark.
 */
export function tierLimits(tier: Tier): AccountLimits {
  return tier === "free"
    ? {
        tier,
        maxSeconds: LIMITS.maxSeconds,
        maxVideoBytes: LIMITS.maxVideoBytes,
        maxAudioBytes: LIMITS.maxAudioBytes,
        maxDevices: LIMITS.maxDevices,
        keepForever: false,
        watermark: true,
        startsPerDay: startsPerDay(tier),
        freeRecordings: LIMITS.freeRecordings,
        transcribeMinPerDay: LIMITS.transcribeMinPerDay,
        customDomain: canUseCustomBranding(tier),
      }
    : {
        tier,
        maxSeconds: tier === "owner" ? null : LIMITS.paidMaxSeconds,
        maxVideoBytes: LIMITS.ownerMaxVideoBytes,
        maxAudioBytes: LIMITS.ownerMaxAudioBytes,
        maxDevices: null,
        keepForever: true,
        watermark: false,
        startsPerDay: startsPerDay(tier),
        freeRecordings: null,
        transcribeMinPerDay: tier === "owner" ? null : LIMITS.paidTranscribeMinPerDay,
        customDomain: canUseCustomBranding(tier),
      };
}

/** Recordings the account has started while on Free (lifetime; a missing row counts as 0). */
export async function freeRecordingsUsed(env: Env, accountId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT free_recordings_used AS n FROM accounts WHERE id = ?").bind(accountId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Takes one of the account's `max` Free recordings in one statement (no race between check and count). False = all used. */
export async function takeFreeRecording(env: Env, accountId: string, max: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE accounts SET free_recordings_used = free_recordings_used + 1 WHERE id = ? AND free_recordings_used < ?")
    .bind(accountId, max)
    .run();
  return r.meta.changes === 1;
}

/** Hands back a Free recording taken by a start that then failed (never below 0). */
export async function returnFreeRecording(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET free_recordings_used = max(free_recordings_used - 1, 0) WHERE id = ?").bind(accountId).run();
}

/** Owner accounts (OWNER_ACCOUNT_IDS) first, then accounts.plan (which may itself be 'owner'). */
export async function accountLimits(env: Env, accountId: string): Promise<AccountLimits> {
  return tierLimits(isOwnerAccount(env, accountId) ? "owner" : await accountPlan(env, accountId));
}

/** What a refused pairing tells the user (enroll response, get_installer, remove_device). */
export const deviceLimitMessage = (env: Env, max: number) =>
  `This account already has ${max} paired devices, the most ${getConfig(env).billing.enabled ? "the Free plan allows" : "this server allows per account"}. Remove one first (remove_device; ` +
  "list_devices shows them), then pair this PC again.";

/** What start_recording says when a Free account has used all its recordings (error free_limit_reached). */
export const freeLimitMessage = (max: number) =>
  `You've used all ${max} recordings on the Recitbot Free plan (${max} in total; deleting videos doesn't give any back). ` +
  "Upgrade to Recitbot Pro to remove the limit and keep recording: just ask me to upgrade.";

/** Seconds an upload token outlives max_seconds (also when a stuck recording times out). */
export const uploadGrace = (maxSeconds: number) => (maxSeconds > LIMITS.maxSeconds ? LIMITS.longUploadGraceSeconds : LIMITS.uploadGraceSeconds);

/**
 * A per-account limit was exceeded (start_recording max_seconds, upload sizes). upgrade_url is reserved: when set, it is
 * where the user can raise the limit. Never set today (the upgrade tool covers it).
 */
export type LimitError = {
  error: "LIMIT_EXCEEDED";
  message: string;
  limit: "max_seconds" | "video_bytes" | "audio_bytes";
  max: number;
  requested?: number;
  tier: Tier;
  upgrade_url?: string;
};

export function limitError(limit: LimitError["limit"], max: number, requested: number, tier: Tier): LimitError {
  const what = limit === "max_seconds" ? `${max} seconds per recording` : `${max} bytes of ${limit === "video_bytes" ? "video" : "audio"} per recording`;
  return { error: "LIMIT_EXCEEDED", message: `This account can record at most ${what} (asked for ${requested}).`, limit, max, requested, tier };
}
