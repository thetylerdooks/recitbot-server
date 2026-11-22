// Remote MCP server (Streamable HTTP, stateless JSON responses). Every tool input is validated with zod.
import { z } from "zod";
import { bearer, issueApiKey, revokeApiKey, revokeDevice, uninstallDevice, verifyBearer, type Principal } from "./auth";
import { deviceHub, type RecorderFeature, type UninstallScope, WEBCAM_SHAPES, WEBCAM_SIZE_PX, WEBCAM_SIZES } from "./device-hub";
import {
  DEVICE_QUERY,
  describeMonitor,
  describeWindow,
  type Match,
  matchAv,
  matchMonitor,
  matchWindow,
  MAX_WINDOWS,
  type StoredInventory,
} from "./devices";
import { listComments, ownerDeleteComment } from "./comments";
import { getConfig } from "./config";
import type { Env } from "./env";
import {
  accountLimits,
  isOperatorAccount,
  freeLimitMessage,
  freeRecordingsUsed,
  limitError,
  LIMITS,
  publicBase,
  returnFreeRecording,
  serviceMode,
  takeFreeRecording,
  uploadGrace,
} from "./env";
import { governor } from "./governor";
import { SERVER_VERSION } from "./health";
import { accountSuspended, heldRecordingIds, recordingRemoved, REMOVED_MESSAGE, sharingBlocked, SUSPENDED_MESSAGE } from "./takedown-state";
import { ACCOUNT_TOOLS } from "./account-tools";
import { ADMIN_DOMAIN_TOOLS } from "./admin-domain-tools";
import { ADMIN_RETENTION_TOOLS } from "./admin-retention-tools";
import { ADMIN_TAKEDOWN_TOOLS } from "./admin-takedown-tools";
import { ADMIN_TOOLS } from "./admin-tools";
import { BILLING_TOOLS } from "./billing-tools";
import { BRANDING_TOOLS } from "./branding-tools";
import { DOMAIN_TOOLS } from "./domain-tools";
import { INSTALL_TOOLS } from "./installer-tools";
import { LEARN_TOOLS } from "./learn-tools";
import { COMMENTS_RULE, mcpInstructions, NAME_VIDEO_RULE, OWNER_URL_RULE, VIDEO_LINK_HINT } from "./playbook";
import { ownerUrl } from "./owner-link";
import { mcpChallenge, resourceFor } from "./oauth/hosts";
import { recordingExpired, retentionHoldCol, unexpiredSql } from "./retention-hold";
import { BILLING_ONLY_TOOLS, plainRecordingLimitMessage, plainStorageLimitMessage, plainTool } from "./selfhost-text";
import { customVideoBase, KEEP_FOREVER, mmss, newSlug, retentionExpiry, revokeShare, setPasscode, shareRecording, videoLinksMany, type Segment } from "./share";
import { dailyStats, searchHit, searchOrder, transcriptText, withWatchPct, type StatsRow } from "./stats";
import { BILLING_NOT_ENABLED, billingConfigured } from "./stripe";
import { atStorageLimit, storageLimitMessage, storageStatus, type StorageStatus, withStorageWarning } from "./storage";
import { abortMultipartUploads, issueUploadToken, keyframeKeys, toVtt } from "./upload";
import { assignUsername, setUsername } from "./username";
import { clientIp, hmacHex, json, log, now, randomId } from "./util";
import { setVideoMeta, VideoMetaError } from "./video-meta";
import { videoLink, videoLinkFields, videoTitle } from "./video-url";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** base = origin for generated URLs (PUBLIC_BASE_URL, else the request origin). ipHash = the caller's keyed IP hash. */
type Ctx = { env: Env; exec: ExecutionContext; base: string; principal: Principal | null; ipHash: string };

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** start_recording on a Free account that has used all its recordings. The upgrade tool is the way to Pro (billing on). */
const freeLimitReached = (env: Env, max: number) =>
  billingConfigured(env)
    ? new ToolError("free_limit_reached", freeLimitMessage(max), {
        limit: max,
        used: max,
        upgrade: "Call upgrade to get the user's Recitbot Pro checkout link (ask monthly or yearly unless they said, then tell them the price and how often it renews first).",
      })
    : new ToolError("free_limit_reached", plainRecordingLimitMessage(max), { limit: max, used: max });

/** start_recording on a Pro or Teams account at or over its storage cap. add_storage is the way to more. */
const storageLimitReached = (env: Env, s: StorageStatus) =>
  billingConfigured(env)
    ? new ToolError("storage_limit_reached", storageLimitMessage(s.limit!), {
        storage_used_bytes: s.used,
        storage_limit_bytes: s.limit,
        storage_addons: s.addons,
        add_storage: "Call add_storage for the user's checkout link to add 100 GB for $3/mo (tell them the price first), or help them delete old videos.",
      })
    : new ToolError("storage_limit_reached", plainStorageLimitMessage(s.limit!), { storage_used_bytes: s.used, storage_limit_bytes: s.limit });

const RecId = z.string().regex(/^[A-Za-z0-9]{20,30}$/, "invalid recording_id");

/** Per-video columns for list_videos / search_videos, view stats included. */
const VIDEO_COLS =
  `id AS recording_id, title, description, status, created_at, expires_at, ${retentionHoldCol()}, duration_s, has_system_audio, views, unique_views, last_viewed_at, previews`;
type VideoRow = StatsRow & {
  title: string | null;
  description: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  /** 0/1 from D1; in tool results only as auto_delete_paused: true. */
  retention_hold?: number;
  auto_delete_paused?: true;
  duration_s: number | null;
  /** 0/1 from D1, boolean in tool results. */
  has_system_audio: number | boolean;
};

const STATS_MEANING =
  "Stats per video: views = times the video page was opened and its player loaded, NOT counting the owner (signed " +
  "in, or opened from their owner link) or link-preview bots; unique_views = distinct viewers (IP + browser, counted once " +
  "per day); last_viewed_at (unix seconds, null = never); avg_watch_pct = average furthest point reached in the video " +
  "(0-100, null without views); previews = link-preview bot fetches (Slack/Discord/X unfurls; not views). For 'how many " +
  "people watched' answer with unique_views (and views for total opens). Free-plan videos and their stats are deleted " +
  `at expires_at (${LIMITS.retentionSeconds / 86400} days after recording); expires_at null = kept until deleted; ` +
  "auto_delete_paused: true = not deleted at expires_at for now.";

// Video URLs: one per video, https://<host>/<username>/v/<slug>, private until shared (see share.ts).
const LINK_SHAPE = "https://<host>/<username>/v/<slug>";
const VISIBILITY_MEANING =
  "Every video has exactly one URL. visibility 'private' (the default) = only the user can open it (with owner_url, or " +
  "signed in on the website); 'public' = anyone with the URL can watch. share_recording makes it public; revoke_share makes it private " +
  "and replaces the URL.";
const NOTE_PRIVATE =
  "Private: only the user can open it (with owner_url, or signed in on the website). Call share_recording to make it public.";
const NOTE_PUBLIC = "Public: anyone with this link can watch. revoke_share makes it private and retires this link.";
const NOTE_REVOKED =
  "The old link and old owner links no longer work. This new link is private: only the user can open it (with the new " +
  "owner_url, or signed in on the website). " +
  "Call share_recording to make it public.";

const SHARE_DESCRIPTION =
  `Make a ready recording public and get its URL (${LINK_SHAPE}; with a live custom domain: ` +
  "https://<custom domain>/<slug>): anyone with it can watch. It is the same URL " +
  "get_video shows; sharing again keeps it. Send url (or share_url) to viewers, never owner_url. Optionally set a " +
  "passcode viewers must enter. To retire the URL, call revoke_share (rotate=true here = revoke_share then share, giving " +
  "a new public URL). Returns title, url, display, share_url (= url, for older clients) and owner_url. " +
  OWNER_URL_RULE +
  " " +
  VIDEO_LINK_HINT;
const ShareInput = z.object({
  recording_id: RecId,
  passcode: z.string().min(4).max(64).optional(),
  rotate: z.boolean().default(false),
});

async function shareTool(a: z.infer<typeof ShareInput>, c: Ctx) {
  const rec = await ownRecording(c, a.recording_id);
  if (rec.status !== "ready") throw new ToolError("NOT_READY", `Recording status is ${rec.status}.`);
  const acct = c.principal!.accountId;
  const blocked = await sharingBlocked(c.env, rec.id, acct);
  if (blocked) throw new ToolError(blocked, blocked === "ACCOUNT_SUSPENDED" ? SUSPENDED_MESSAGE : REMOVED_MESSAGE);
  if (a.rotate) await revokeShare(c.env, c.base, rec.id, acct);
  await shareRecording(c.env, c.base, rec.id, acct);
  if (a.passcode !== undefined) await setPasscode(c.env, rec.id, a.passcode);
  const { fields: links, home } = await videoLinks(c, rec);
  return {
    recording_id: rec.id,
    ...links,
    share_url: links.url,
    owner_url: await ownerLink(c, home, rec.id),
    visibility: "public",
    passcode_required: a.passcode !== undefined,
    note: NOTE_PUBLIC,
  };
}

async function listVideos(c: Ctx, limit: number) {
  const rows = await c.env.DB.prepare(`SELECT ${VIDEO_COLS} FROM recordings WHERE account_id = ? AND ${unexpiredSql()} ORDER BY created_at DESC LIMIT ?`)
    .bind(c.principal!.accountId, now(), limit)
    .all<VideoRow>();
  return { recordings: await withLinks(c, await withWatchPct(c.env, rows.results.map(asBool))) };
}

/** Adds title, url, display (the Markdown link) and owner_url to every listed video. */
async function withLinks<T extends VideoRow>(c: Ctx, rows: T[]): Promise<T[]> {
  const account_id = c.principal!.accountId;
  const links = await videoLinksMany(c.env, c.base, rows.map((r) => r.recording_id), account_id, rows.length ? await customBase(c) : null);
  return Promise.all(
    rows.map(async (r) => {
      const l = links.get(r.recording_id);
      if (!l) throw new ToolError("NOT_FOUND", "No such recording on this account.");
      const title = videoTitle(r);
      const owner_url = await ownerUrl(c.env, l.home, { id: r.recording_id, account_id, owner_version: l.owner_version });
      return { ...r, title, url: l.url, display: videoLink(title, l.url), owner_url };
    }),
  );
}

const customBases = new WeakMap<Ctx, Promise<string | null>>();
/**
 * https://<hostname> of the calling account's live custom domain (share.ts customVideoBase), or null. Looked up once
 * per tool call (one Ctx per request). Every video's url uses it; owner_url stays on c.base (our own host).
 */
export function customBase(c: Ctx): Promise<string | null> {
  let p = customBases.get(c);
  if (!p) customBases.set(c, (p = customVideoBase(c.env, c.principal!.accountId)));
  return p;
}

/** One recording's title, url, display, plus home (its URL on our own host, for owner_url). */
async function videoLinks(c: Ctx, rec: { id: string; title: string | null; created_at: number }) {
  return videoLinkFields(c.env, c.base, c.principal!.accountId, rec, await customBase(c));
}

/**
 * owner_url: the video's URL on our own host (home; owner links never work on a custom domain) with a 24 h owner token
 * (owner-link.ts). For the user only, never for viewers.
 */
async function ownerLink(c: Ctx, url: string, id: string): Promise<string> {
  const account_id = c.principal!.accountId;
  const rec = await c.env.DB.prepare("SELECT owner_version FROM recordings WHERE id = ? AND account_id = ?")
    .bind(id, account_id)
    .first<{ owner_version: number }>();
  if (!rec) throw new ToolError("NOT_FOUND", "No such recording on this account.");
  return ownerUrl(c.env, url, { id, account_id, owner_version: rec.owner_version });
}

/** title, url and display for one recording of the calling account. */
async function linkFields(c: Ctx, rec: { id: string; title: string | null; created_at: number }) {
  return (await videoLinks(c, rec)).fields;
}

/** Test seam: vi.mock of ./comments doesn't reach this module under vitest-pool-workers, so tests spy on this. */
export const commentDeps = { listComments };

/** m:ss (minutes unpadded) for a comment's moment in the video. */
const mss = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function asBool<T extends VideoRow>(row: T) {
  const { retention_hold, ...r } = row;
  return { ...r, ...(retention_hold && { auto_delete_paused: true as const }), has_system_audio: row.has_system_audio === 1 };
}

/** What to tell the agent when the recorder is too old for an option (the recording still starts without it). */
const UNSUPPORTED: Record<RecorderFeature, string> = {
  system_audio: "System audio isn't supported on this recorder version: recording the mic only. Run get_installer again to update it.",
  webcam_shape: "This recorder version can't change the webcam shape: the bubble stays round. Run get_installer again to update it.",
  webcam_pct: "This recorder version only knows small/medium/large: it used the bubble size set on the PC. Run get_installer again to update it.",
  ready_push: "This recorder version can't open the link by itself.",
  chunked_upload: `This recorder version can't upload long videos: it records at most ${LIMITS.singleUploadMaxSeconds} s. Run get_installer again to update it.`,
  self_update: "This recorder version can't update itself. Run get_installer again to update it.",
  multi_account: "This recorder version holds one account per computer: uninstalling it removes Recitbot completely.",
  update_defer_rollback: "This recorder version refuses an update while recording (it is sent again later) and can't roll a failed update back.",
  keyframes: "This recorder version sends no still frames: get_recording_for_skill has the transcript only.",
  signed_update: "This recorder version checks updates by their SHA-256 only, not by a release signature.",
};

export type Tool<S extends z.ZodType> = {
  description: string;
  input: S;
  auth: boolean;
  /**
   * Operator tools: only operators (env.ts isOperatorAccount) see them in tools/list or can call them. To anyone else they
   * don't exist (left out of tools/list; a call answers exactly like an unknown tool).
   */
  ownerOnly?: boolean;
  run: (args: z.infer<S>, c: Ctx) => Promise<Record<string, unknown>>;
};
export function tool<S extends z.ZodType>(t: Tool<S>): Tool<S> {
  return t;
}

export function requireWritable(env: Env): void {
  const m = serviceMode(env);
  if (m === "READ_ONLY" || m === "OFF") throw new ToolError("SERVICE_PAUSED", "The service is paused for new activity. Try later.");
}

/** The caller's account is suspended (an open admin takedown, takedown-state.ts): ACCOUNT_SUSPENDED, nothing changes. */
export async function requireNotSuspended(c: Ctx): Promise<void> {
  if (await accountSuspended(c.env, c.principal!.accountId)) throw new ToolError("ACCOUNT_SUSPENDED", SUSPENDED_MESSAGE);
}

/** stop_recording without recording_id: the id of the account's one recording that is starting or recording. */
async function onlyActiveRecording(c: Ctx): Promise<string> {
  const rows = (
    await c.env.DB.prepare(
      "SELECT r.id, r.title, r.status, r.created_at, r.device_id, d.name AS device_name FROM recordings r " +
        "LEFT JOIN devices d ON d.id = r.device_id " +
        "WHERE r.account_id = ? AND r.status IN ('starting','recording') ORDER BY r.created_at DESC, r.id",
    )
      .bind(c.principal!.accountId)
      .all<{ id: string; title: string | null; status: string; created_at: number; device_id: string; device_name: string | null }>()
  ).results;
  if (!rows.length) throw new ToolError("NO_ACTIVE_RECORDING", "No recording is in progress on this account, so there is nothing to stop.");
  if (rows.length > 1) {
    throw new ToolError(
      "MULTIPLE_ACTIVE_RECORDINGS",
      `${rows.length} recordings are in progress (on more than one device). Ask the user which one to stop and call ` +
        "stop_recording again with its recording_id.",
      {
        active: rows.map((r) => ({
          recording_id: r.id,
          title: r.title,
          status: r.status,
          created_at: r.created_at,
          device: r.device_id,
          device_name: r.device_name,
        })),
      },
    );
  }
  return rows[0].id;
}

async function ownRecording(c: Ctx, id: string) {
  const rec = await c.env.DB.prepare(`SELECT *, ${retentionHoldCol()} FROM recordings WHERE id = ? AND account_id = ?`)
    .bind(id, c.principal!.accountId)
    .first<{
      id: string;
      device_id: string;
      title: string | null;
      description: string | null;
      status: string;
      max_seconds: number;
      created_at: number;
      expires_at: number;
      retention_hold: number;
      duration_s: number | null;
      transcript_status: string;
      transcript: string | null;
      error: string | null;
      has_system_audio: number;
      shared_at: number | null;
      views: number;
      unique_views: number;
      last_viewed_at: number | null;
      previews: number;
    }>();
  if (!rec) throw new ToolError("NOT_FOUND", "No such recording on this account.");
  if (recordingExpired(rec, now())) rec.status = "expired";
  return rec;
}

/** get_video's (and update_video's) result for one recording. */
async function videoResult(c: Ctx, rec: Awaited<ReturnType<typeof ownRecording>>) {
  const { fields: links, home } = await videoLinks(c, rec);
  const out: Record<string, unknown> = {
    recording_id: rec.id,
    status: rec.status,
    ...links,
    owner_url: await ownerLink(c, home, rec.id),
    description: rec.description,
    duration_s: rec.duration_s,
    expires_at: rec.expires_at >= KEEP_FOREVER ? null : rec.expires_at,
    transcript_status: rec.transcript_status,
  };
  if (rec.retention_hold) out.auto_delete_paused = true;
  if (rec.error) out.error = rec.error;
  out.has_system_audio = rec.has_system_audio === 1;
  if (rec.status === "ready") {
    out.share_url = links.url;
    out.visibility = rec.shared_at === null ? "private" : "public";
    out.note = rec.shared_at === null ? NOTE_PRIVATE : NOTE_PUBLIC;
  }
  // Taken down (takedown-state.ts): say so, so the bot stops handing out a link that answers 451.
  const suspended = await accountSuspended(c.env, c.principal!.accountId);
  if (suspended || (await recordingRemoved(c.env, rec.id, c.principal!.accountId))) {
    out.removed = true;
    if (suspended) out.suspended = true;
    out.note = `${suspended ? SUSPENDED_MESSAGE : REMOVED_MESSAGE} Its link answers 451 "removed"; don't share it.`;
  }
  return out;
}

type DeviceRow = { id: string; name: string; platform: string | null; created_at: number; last_seen_at: number | null; ip_hash: string | null };
/** A paired device as the tools show it. this_device = the call comes from that device's network (the only match). */
export type PairedDevice = {
  id: string;
  name: string;
  platform: string | null;
  paired_at: number;
  last_seen_at: number | null;
  online: boolean;
  this_device: boolean;
};

/**
 * The account's paired (not removed) devices: online ones first, most recently connected first, then the rest by when
 * they were last seen.
 */
export async function pairedDevices(c: Ctx): Promise<PairedDevice[]> {
  const acct = c.principal!.accountId;
  // online = a live socket with a heartbeat in the last LIMITS.deviceHeartbeatTimeoutSeconds; its last_seen_at is that
  // heartbeat (devices.last_seen_at is only written on connect and disconnect). Asked first: it also writes the hub's
  // pending disconnect sightings to devices.last_seen_at, read below.
  const presence = await deviceHub(c.env, acct).presence(acct);
  const rows = (
    await c.env.DB.prepare(
      "SELECT id, name, platform, created_at, last_seen_at, ip_hash FROM devices WHERE account_id = ? AND revoked_at IS NULL " +
        "ORDER BY coalesce(last_seen_at, created_at) DESC, created_at DESC",
    )
      .bind(acct)
      .all<DeviceRow>()
  ).results;
  if (!rows.length) return [];
  const online = presence.map((p) => p.id);
  const seen = new Map(presence.map((p) => [p.id, p.seen]));
  const rank = (id: string) => (online.includes(id) ? online.indexOf(id) : online.length);
  const here = rows.filter((r) => r.ip_hash === c.ipHash);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.id) - rank(b.r.id) || a.i - b.i)
    .map(({ r }) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      paired_at: r.created_at,
      last_seen_at: seen.has(r.id) ? Math.max(r.last_seen_at ?? 0, seen.get(r.id)!) : r.last_seen_at,
      online: online.includes(r.id),
      this_device: here.length === 1 && here[0].id === r.id,
    }));
}

/** One of the paired devices by id, exact name or a unique part of the name. */
function matchPaired(all: PairedDevice[], query: string): PairedDevice {
  const q = query.trim().toLowerCase();
  const hit = all.find((d) => d.id.toLowerCase() === q) ?? all.filter((d) => d.name.toLowerCase() === q).at(0);
  const hits = hit ? [hit] : all.filter((d) => d.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  throw new ToolError(
    hits.length ? "DEVICE_AMBIGUOUS" : "DEVICE_NOT_FOUND",
    hits.length
      ? `Several paired devices match "${query}". Ask the user which one, then pass its id.`
      : `No paired device matches "${query}". Pick one of the candidates (list_devices shows them) and pass its id.`,
    { field: "device", candidates: hits.length ? hits : all },
  );
}

/**
 * The device a command goes to: `query` (id or name) when given, else the most recently connected online device, else
 * (none online) the most recently seen one. DEVICE_NOT_PAIRED when the account has none.
 */
export async function targetDevice(c: Ctx, query?: string): Promise<{ device: PairedDevice; all: PairedDevice[] }> {
  const all = await pairedDevices(c);
  if (!all.length) throw new ToolError("DEVICE_NOT_PAIRED", "No device paired yet. Call get_installer first.");
  return { device: query === undefined ? all[0] : matchPaired(all, query), all };
}

/** A command for a device that is not connected (no live socket). */
export function deviceOffline(name: string, extra: Record<string, unknown> = {}): ToolError {
  return new ToolError(
    "DEVICE_OFFLINE",
    `${name} is offline. Make sure Recitbot is running on it and it's connected to the internet, then try again.`,
    extra,
  );
}

/** The device was connected when the command started and dropped (or did not answer) before it was delivered. */
export function connectionLost(name: string, extra: Record<string, unknown> = {}): ToolError {
  return new ToolError("DEVICE_OFFLINE", `${name} lost connection, try again.`, extra);
}

/**
 * A device-hub call made for a command. A failure there (the socket closed mid-send, the hub timed out or was reset) is
 * the device dropping, not an internal error: DEVICE_OFFLINE "lost connection".
 */
export async function onDevice<P extends PromiseLike<unknown>>(name: string, p: P, extra: Record<string, unknown> = {}): Promise<Awaited<P>> {
  try {
    return await p;
  } catch (e) {
    log("warn", "device command failed", { err: String(e) });
    throw connectionLost(name, extra);
  }
}

/**
 * The account's most recently revoked device: removed or replaced (devices) or uninstalled (revoked_device_tokens).
 * `query` = its id or exact name (case-insensitive); omitted = any.
 */
async function revokedDevice(env: Env, accountId: string, query?: string) {
  return env.DB.prepare(
    "SELECT id, name, platform, created_at, last_seen_at, revoked_at, revoke_reason FROM devices " +
      "WHERE account_id = ?1 AND revoked_at IS NOT NULL AND (?2 IS NULL OR id = ?2 OR lower(name) = lower(?2)) " +
      "UNION ALL SELECT device_id, name, platform, NULL, NULL, revoked_at, 'uninstalled' FROM revoked_device_tokens " +
      "WHERE account_id = ?1 AND (?2 IS NULL OR device_id = ?2 OR lower(name) = lower(?2)) ORDER BY revoked_at DESC LIMIT 1",
  )
    .bind(accountId, query?.trim() ?? null)
    .first<{
      id: string;
      name: string | null;
      platform: string | null;
      created_at: number | null;
      last_seen_at: number | null;
      revoked_at: number;
      revoke_reason: string | null;
    }>();
}

/** Offline target: which device, and whether another one could record instead. */
function offlineError(device: PairedDevice, all: PairedDevice[], asked: boolean): ToolError {
  const other = asked && all.length > 1 ? all.find((d) => d.online) : undefined;
  const e = deviceOffline(device.name, { device: device.id, device_name: device.name });
  if (other) e.message += ` Or record on ${other.name} (device:'${other.id}').`;
  return e;
}

const DeviceQuery = (what: string) =>
  z.string().min(1).max(128).regex(DEVICE_QUERY, `invalid ${what}`);

/** start_recording / list_devices / device_status / update_recorder: which paired PC. */
const DEVICE_PARAM =
  "Which paired device (PC) to use when the account has several: its id from list_devices (paired_devices), or its name " +
  "or a unique part of it. Default: the most recently connected online device.";

/** Resolves one requested device against the last inventory, or explains what to do instead. */
function resolved<T extends { id: string }>(kind: string, query: string, m: Match<T>, show: (t: T) => unknown): string {
  if ("item" in m) return m.item.id;
  const ambiguous = m.error === "DEVICE_AMBIGUOUS";
  throw new ToolError(
    m.error,
    ambiguous
      ? `Several ${kind}s match "${query}". Ask the user which one, then pass its id.`
      : `No ${kind} matches "${query}". Pick one of the candidates (or call list_devices) and pass its id.`,
    { field: kind === "camera" ? "camera" : kind === "microphone" ? "mic_device" : "monitor", candidates: m.candidates.map(show) },
  );
}

const TOOLS = {
  ...INSTALL_TOOLS,
  ...BILLING_TOOLS,
  ...BRANDING_TOOLS,
  ...ACCOUNT_TOOLS,
  ...LEARN_TOOLS,
  ...DOMAIN_TOOLS,
  ...ADMIN_DOMAIN_TOOLS,
  ...ADMIN_TOOLS,
  ...ADMIN_TAKEDOWN_TOOLS,
  ...ADMIN_RETENTION_TOOLS,

  device_status: tool({
    auth: true,
    description:
      "Check whether a recorder device is paired to this account and currently online (connected). With several paired " +
      "devices, `device` is the one commands go to by default (the most recently connected online one) unless you pass " +
      "`device`; paired_devices counts them (list_devices lists them). device.revoked_at (ISO time) and " +
      "device.revoke_reason (replaced_by_repair, user_revoked or uninstalled) are null while the device is paired; a " +
      "device id or name that is no longer paired, or (with no `device`) the account's last revoked device when none is " +
      "paired, comes back with them set and revoked:true. A revoked device can never record again: do NOT retry " +
      "start_recording or wait for it to come online; call get_installer right away and pair the PC again.",
    input: z.object({ device: DeviceQuery("device").optional().describe(DEVICE_PARAM) }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      const all = await pairedDevices(c);
      const max = (await accountLimits(c.env, acct)).maxDevices;
      let dev: PairedDevice | undefined;
      let notFound: ToolError | undefined;
      try {
        dev = a.device === undefined || !all.length ? all[0] : matchPaired(all, a.device);
      } catch (e) {
        if (!(e instanceof ToolError) || e.code !== "DEVICE_NOT_FOUND") throw e;
        notFound = e;
      }
      if (dev) {
        return {
          paired: true,
          online: dev.online,
          device: {
            id: dev.id,
            name: dev.name,
            platform: dev.platform,
            created_at: dev.paired_at,
            last_seen_at: dev.last_seen_at,
            revoked_at: null,
            revoke_reason: null,
          },
          paired_devices: all.length,
          max_devices: max,
        };
      }
      const gone = await revokedDevice(c.env, acct, a.device);
      if (gone) {
        return {
          paired: all.length > 0,
          online: false,
          revoked: true,
          device: { ...gone, revoked_at: new Date(gone.revoked_at * 1000).toISOString() },
          paired_devices: all.length,
          max_devices: max,
          note: "This device is revoked and can never record again. Call get_installer now and pair the PC again; do not retry recording on it.",
        };
      }
      if (notFound) throw notFound;
      return { paired: false, online: false, device: null, paired_devices: 0, max_devices: max };
    },
  }),

  remove_device: tool({
    auth: true,
    description:
      "Remove (unpair) one of the account's paired devices: its key stops working at once, its recorder is disconnected " +
      "and a recording in progress on it fails. The other devices stay paired. Use it when the user wants to drop a PC, " +
      `or when pairing another PC is refused because the Free plan's ${LIMITS.maxDevices} devices are taken. Get the id ` +
      "from list_devices (paired_devices); confirm with the user which device first. Removing the device this call comes " +
      "from works too (removed_this_device:true); pair it again later with get_installer.",
    input: z.object({
      device: DeviceQuery("device").describe("The device to remove: its id from list_devices (best), or its name or a unique part of it."),
    }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      const all = await pairedDevices(c);
      if (!all.length) throw new ToolError("DEVICE_NOT_PAIRED", "This account has no paired devices.");
      const dev = matchPaired(all, a.device);
      if (await revokeDevice(c.env, acct, dev.id)) {
        await c.env.DB.prepare(
          "UPDATE recordings SET status = 'failed', error = 'DEVICE_REMOVED' WHERE account_id = ? AND device_id = ? AND status IN ('starting','recording','uploading')",
        )
          .bind(acct, dev.id)
          .run();
        await deviceHub(c.env, acct).disconnect(dev.id);
      }
      const remaining = all.filter((d) => d.id !== dev.id);
      return {
        removed: { id: dev.id, name: dev.name, platform: dev.platform },
        removed_this_device: dev.this_device,
        paired_devices: remaining,
        max_devices: (await accountLimits(c.env, acct)).maxDevices,
        note: dev.this_device
          ? `Removed ${dev.name}, the device this call came from. Its recorder is disconnected and can no longer record; to use it again, pair it with get_installer.`
          : `Removed ${dev.name}. Its recorder is disconnected; the other devices stay paired. To use it again, pair it with get_installer.`,
      };
    },
  }),

  uninstall_recorder: tool({
    auth: true,
    description:
      "Use this whenever the user wants to uninstall Recitbot, remove the recorder, delete Recitbot from their computer, " +
      "or get rid of it on a PC or Mac. One computer can be paired with several Recitbot accounts. By default this " +
      "removes only this account from the computer: when no other account uses Recitbot there, the recorder removes " +
      "itself completely (the app, its startup item and its data) with no visible windows; otherwise it stays installed " +
      "for the other accounts (accounts_remaining says how many). full_removal:true removes Recitbot from the computer " +
      "for every account: pass it only when the user explicitly asks to remove Recitbot completely, for everyone. Either " +
      "way this account's device key is revoked for good and the device is removed from this account. Pass device_id " +
      "(one device) or all:true (every device). With neither: one paired device is uninstalled directly; with several " +
      "you get needs_choice:true and the device list: ask the user which one, or offer to remove it from all of them, " +
      "then call again. You MUST call this BEFORE the user removes Recitbot from Grok Bot (disconnects the connector / " +
      "removes the app), with all:true unless they only want one device gone, and then tell the user the result in plain " +
      "words (each device's message). A device that is offline or does not answer within 30 s is still revoked and " +
      "removed (pending_on_device:true): tell the user it'll finish next time it connects. To use Recitbot there again " +
      "later, install and pair it again with get_installer.",
    input: z.object({
      device_id: DeviceQuery("device").optional().describe("The device to uninstall: its id from list_devices (paired_devices)."),
      all: z.literal(true).optional().describe("true = uninstall from every paired device of the account."),
      full_removal: z
        .literal(true)
        .optional()
        .describe("true = remove Recitbot from the computer for every account on it. Only when the user explicitly asks for that."),
    }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      if (a.device_id !== undefined && a.all !== undefined) {
        throw new ToolError("INVALID_ARGUMENTS", "Pass either device_id (one device) or all:true (every device), not both.");
      }
      const all = await pairedDevices(c);
      if (!all.length) throw new ToolError("DEVICE_NOT_PAIRED", "This account has no paired devices: nothing to uninstall.");
      if (a.device_id === undefined && !a.all && all.length > 1) {
        return {
          needs_choice: true,
          devices: all.map((d) => ({ device_id: d.id, name: d.name, platform: d.platform, online: d.online, last_seen: d.last_seen_at })),
          note:
            "Several devices are paired. Ask the user which one to uninstall Recitbot from (by name), or offer to remove " +
            "it from all of them, then call uninstall_recorder again with device_id or all:true. Nothing was uninstalled.",
        };
      }
      const targets = a.all || a.device_id === undefined ? all : [matchPaired(all, a.device_id)];
      const scope: UninstallScope = a.full_removal ? "all" : "account";
      const hub = deviceHub(c.env, acct);
      // In parallel: with all:true the call waits at most one ack timeout, not one per device.
      const results = await Promise.all(
        targets.map(async (d) => {
          const r = d.online ? await hub.uninstall(acct, d.id, scope, LIMITS.uninstallAckTimeoutMs) : { online: false, acked: false, accounts_remaining: null };
          await uninstallDevice(c.env, acct, d.id, scope);
          await hub.disconnect(d.id);
          const others = scope === "account" ? (r.accounts_remaining ?? 0) : 0;
          return {
            id: d.id,
            name: d.name,
            platform: d.platform,
            scope,
            was_online: r.online,
            pending_on_device: !r.acked,
            accounts_remaining: r.acked ? others : null,
            message: !r.acked
              ? scope === "all"
                ? `${d.name} was unpaired and its key revoked; it'll remove Recitbot completely next time it connects.`
                : `${d.name} was unpaired and its key revoked; next time it connects it removes this account, and Recitbot itself if no other account uses it.`
              : others > 0
                ? `This account was removed from ${d.name}. Recitbot stays installed there for ${others} other account${others === 1 ? "" : "s"}.`
                : `Recitbot was removed from ${d.name}.`,
          };
        }),
      );
      const pending = results.some((r) => r.pending_on_device);
      return {
        uninstalled: results,
        pending_on_device: pending,
        paired_devices: all.filter((d) => !targets.some((t) => t.id === d.id)).map((d) => ({ id: d.id, name: d.name })),
        message: results.map((r) => r.message).join(" "),
      };
    },
  }),

  list_devices: tool({
    auth: true,
    description:
      "List the account's paired devices (PCs) and, for one of them, its monitors (screens/displays), microphones " +
      "(mics/headsets), webcams (cams/cameras) and open windows (apps).\n" +
      "paired_devices: id, name, platform, paired_at, last_seen_at (unix seconds), online, this_device (the call comes " +
      `from its network). Free accounts may have up to ${LIMITS.maxDevices} paired devices at once (max_devices; null = ` +
      "unlimited); remove_device removes one. The hardware below is for `device` (the PC the result names in `device`; " +
      "default: the most recently connected online one).\n" +
      "Call this BEFORE start_recording whenever the user names a specific monitor, mic or camera: '2nd mon', 'left " +
      "screen', 'main display', 'HyperX mic', 'Logitech cam'. Then pass the chosen ids to start_recording (monitor, " +
      "mic_device, camera). For a window ('my chrome', 'the youtube window', 'zoom', 'that notepad') you can pass the " +
      "user's words straight to start_recording's window; do NOT call list_devices(refresh:true) before a start: " +
      "start_recording uses the PC's window list from the last minute and asks the PC itself only when the window is not " +
      "in it. " +
      "Monitors: id, index, primary, label (left/center/right by physical position), position (0 = leftmost), resolution, " +
      "model name. 'second/2nd/other monitor' usually means the non-primary one. Mics: default:true marks the Windows default. " +
      `Open windows (topmost first, at most ${MAX_WINDOWS}): id, app (e.g. 'Google Chrome'), exe, title (e.g. the page or ` +
      "document name), monitor + monitor_label, minimized, size. Match by app name and title words ('chrome' + " +
      "'YouTube'); if two windows fit, ask the user which one (show app, title, monitor). Match devices by position, name " +
      "or brand; ask the user only when two entries genuinely fit. Without refresh this uses the recorder's latest report " +
      "(sent on connect); refresh:true asks the PC live (up to ~4 s).",
    input: z.object({
      refresh: z
        .boolean()
        .default(false)
        .describe(
          "Ask the PC for a fresh list: after the user plugged in a device, or to show the user what is open right now. Not before start_recording.",
        ),
      device: DeviceQuery("device").optional().describe(DEVICE_PARAM),
    }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      const max = (await accountLimits(c.env, acct)).maxDevices;
      const all = await pairedDevices(c);
      if (!all.length) {
        throw new ToolError("DEVICE_NOT_PAIRED", "No device paired yet. Call get_installer first.", { paired_devices: [], max_devices: max });
      }
      const dev = a.device === undefined ? all[0] : matchPaired(all, a.device);
      const r = await deviceHub(c.env, acct).devices(acct, dev.id, a.refresh);
      const inv = r.inventory;
      const head = { paired_devices: all, max_devices: max, device: dev.id, device_name: dev.name };
      if (!inv) {
        return {
          ...head,
          online: r.online,
          monitors: [],
          mics: [],
          cameras: [],
          note: r.online
            ? "The recorder did not report its devices. It may be an older version: run get_installer again to update it. Recording the primary monitor still works."
            : "The PC is offline and has not reported its devices yet. Ask the user to turn it on.",
        };
      }
      return {
        ...head,
        online: r.online,
        reported_at: inv.at,
        ...(r.online ? {} : { note: "The PC is offline; this is its last report." }),
        monitors: inv.monitors.map((m) => ({ ...describeMonitor(m), position: m.position, name: m.name, x: m.x, y: m.y, scale: m.scale })),
        mics: inv.mics,
        cameras: inv.cameras,
        ...(inv.windows
          ? {
              windows: inv.windows.map((w) => ({
                id: w.id,
                app: w.app,
                exe: w.exe,
                title: w.title,
                monitor: w.monitor || null,
                monitor_label: inv.monitors.find((m) => m.id === w.monitor)?.label ?? null,
                minimized: w.minimized,
                size: `${w.width}x${w.height}`,
              })),
            }
          : { windows: [], windows_note: "This recorder version cannot list or record windows. Run get_installer again to update it." }),
      };
    },
  }),

  start_recording: tool({
    auth: true,
    description:
      "Start recording (rec) the user's screen on their paired, online computer (Windows PC or Mac) immediately. The user sees a floating " +
      "recording bar at the top of the recorded screen with a timer, a Stop button and mic/speaker mute toggles (excluded " +
      "from the video). Stops at max_seconds (default: the " +
      `account's limit: ${LIMITS.maxSeconds} s = 5 minutes on the Free plan, ${LIMITS.paidMaxSeconds} s = 4 hours on Pro), on ` +
      "stop_recording, or when the user clicks Stop, then uploads; call get_video with wait_seconds for the video's URL (private until share_recording).\n" +
      "Users talk casually and misspell. rec/record/recording = this tool. mon/monitor/screen/display = monitor. " +
      "2nd/second/other = the non-primary monitor; main/primary = primary; left/right = physical position. " +
      "cam/webcam/webcame/camera/face = webcam:true; 'no cam' = webcam:false. 'square cam'/'rectangle'/'box' = " +
      "webcam_shape:'rect'; 'round'/'circle' = webcam_shape:'circle'.\n" +
      "AUDIO: the mic AND system audio (the sound playing on the PC: videos, calls, notifications) are both ON by default; " +
      "omit mic and system_audio. 'no mic' = mic:false only. 'no system audio'/'no computer sound'/'mute desktop audio'/" +
      "'just my voice' = system_audio:false only. 'mute'/'muted'/'no audio'/'silent' = mic:false AND system_audio:false. " +
      "The user can also mute/unmute either one from the recording bar while recording.\n" +
      "When the user names a specific monitor, mic or camera, call list_devices first and " +
      "pass ids; match by position, name or brand (e.g. 'HyperX'). Ask the user only when it is truly ambiguous (e.g. two " +
      "monitors both match). Defaults: primary monitor, Windows default mic ON (no mic on the PC = no mic), system audio ON, " +
      "webcam per PC setting (off). When the video is ready the PC opens it in the user's browser (open_link).\n" +
      "Examples: 'rec my 2nd monitor with webcam on' -> list_devices, then {monitor:'<id of the non-primary monitor>', webcam:true} " +
      "(records the default mic and system audio too). " +
      "'record left monitor, HyperX mic, no cam' -> list_devices, then {monitor:'<id of label left>', mic_device:'<HyperX mic id>', webcam:false}. " +
      "'record my screen muted' -> {mic:false, system_audio:false}. 'record my screen with my face, no audio' -> " +
      "{webcam:true, mic:false, system_audio:false}. 'rec my screen, just my voice' -> {system_audio:false}. 'record the " +
      "youtube video sound but no mic' -> {mic:false}. 'record with a square cam' -> {webcam:true, webcam_shape:'rect'}. " +
      "'big round webcam' -> {webcam:true, webcam_shape:'circle', webcam_size:'large'}. " +
      "'record main display' -> {monitor:'primary'}.\n" +
      "WINDOWS: when the user names an app or window instead of a screen ('rec my chrome', 'the youtube window', 'record " +
      "zoom', 'that notepad', 'record excel'), record just that window with `window`, not a monitor: pass the user's " +
      "words ('chrome youtube') or a window id from list_devices. Do NOT call list_devices(refresh:true) first: " +
      "start_recording uses the PC's window list from the last minute and asks the PC itself only when the window is " +
      "not in it. On " +
      "WINDOW_AMBIGUOUS, show the user the candidates (app, title, monitor) and ask which one; never guess. window and " +
      "monitor are mutually exclusive. The window is brought to the front when recording starts; keep it uncovered (things " +
      "on top of it are recorded too). Moves and resizes are followed; while minimized the video is black.\n" +
      "Window examples: 'rec my chrome with youtube open window right now with webcam' -> {window:'chrome youtube', " +
      "webcam:true}. 'record that notepad with my mic' -> {window:'notepad'}; WINDOW_AMBIGUOUS with two Notepad windows " +
      "-> ask the user which one, then {window:'<chosen id>'}.\n" +
      "SEVERAL PCs: with more than one paired device, the recording runs on the most recently connected online one " +
      "(result: device, device_name) unless you pass `device` (an id from list_devices' paired_devices, or the PC's name); " +
      "when the user names a PC ('on my laptop'), pass it.\n" +
      `Free plan: ${LIMITS.freeRecordings} recordings in total (never resets; deleting videos doesn't give any back); after that ` +
      "free_limit_reached{limit,used}: nothing was started; tell the user the message and offer upgrade.\n" +
      `Pro: ${LIMITS.storageBytesPerSeat / 1e9} GB of stored video per account (more with add_storage). At or over it: ` +
      "storage_limit_reached{storage_used_bytes,storage_limit_bytes}: nothing was started; tell the user the message and offer " +
      "add_storage or deleting old videos. At 90% or more a started recording carries storage_warning: tell the user it.\n" +
      "Errors: DEVICE_OFFLINE (the device is not connected, or lost connection: tell the user the message), DEVICE_NOT_PAIRED, free_limit_reached, storage_limit_reached, CAP_REACHED{resets_at}, LIMIT_EXCEEDED{limit,max}, SERVICE_PAUSED, DEVICE_NOT_FOUND{field,candidates}, " +
      "DEVICE_AMBIGUOUS{field,candidates}, WINDOW_NOT_FOUND{candidates}, WINDOW_AMBIGUOUS{candidates}, RECORDER_UPDATE_REQUIRED.\n" +
      NAME_VIDEO_RULE +
      " " +
      VIDEO_LINK_HINT,
    input: z.object({
      title: z.string().max(120).optional(),
      device: DeviceQuery("device").optional().describe(DEVICE_PARAM),
      max_seconds: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.recordingCeilingSeconds)
        .optional()
        .describe(
          `Stop after this many seconds. On the Free plan the default and maximum is ${LIMITS.maxSeconds} s (5 minutes); above it: ` +
            `LIMIT_EXCEEDED{limit:'max_seconds', max}. On Pro the default and maximum is ${LIMITS.paidMaxSeconds} s (4 hours). ` +
            "Omit it for 'until I stop'.",
        ),
      monitor: z
        .union([DeviceQuery("monitor"), z.number().int().min(0).max(63)])
        .optional()
        .describe(
          "Monitor to record: an id from list_devices (best), an index, 'primary' (default), 'left'/'right'/'center', or " +
            "'second'/'other' (the only non-primary monitor). The video is scaled to fit 1920x1080.",
        ),
      window: DeviceQuery("window")
        .optional()
        .describe(
          "Record one window instead of a monitor: a window id from list_devices, or words matched " +
            "against app name, exe and title, all of which must match ('chrome youtube', 'zoom', 'notepad'). Fails with " +
            "WINDOW_AMBIGUOUS (ask the user) or WINDOW_NOT_FOUND, both with candidates, before anything is recorded.",
        ),
      mic: z
        .boolean()
        .optional()
        .describe(
          "Record a microphone (enables a transcript). Default true (the Windows default mic, or mic_device). Pass false only " +
            "for 'no mic', or with system_audio:false for 'mute'/'muted'/'no audio'/'silent'. A PC without a mic still records.",
        ),
      system_audio: z
        .boolean()
        .optional()
        .describe(
          "Record the sound playing on the PC (default output device: speakers or headset), mixed with the mic. Default true. " +
            "false for 'no system audio'/'no computer sound'/'mute desktop audio'/'just my voice', and together with mic:false " +
            "for 'mute'/'no audio'. Note it can pick up call audio and notifications.",
        ),
      mic_device: DeviceQuery("mic_device")
        .optional()
        .describe("Microphone id from list_devices, or its name or a unique part of it ('HyperX'). Default: the Windows default mic."),
      webcam: z
        .boolean()
        .optional()
        .describe(
          "Show a draggable webcam bubble (round, or a rounded rectangle with webcam_shape) that is recorded into the video. Omit to use the device's setting " +
            "(off unless enabled on the PC). If the camera fails, the recording continues without it.",
        ),
      camera: DeviceQuery("camera")
        .optional()
        .describe("Camera id from list_devices, or its name or a unique part of it. Default: the camera last chosen on the PC, else the first."),
      webcam_size: z
        .union([z.enum(WEBCAM_SIZES), z.number().int().min(1).max(100)])
        .optional()
        .describe(
          `Bubble size: small (${WEBCAM_SIZE_PX.small} px), medium (${WEBCAM_SIZE_PX.medium} px), large (${WEBCAM_SIZE_PX.large} px), ` +
            "or a number = percent of the monitor's shorter side (e.g. 25), clamped to the bubble's range. The slider on the " +
            "PC is continuous; default: the size last set there.",
        ),
      webcam_shape: z
        .enum(WEBCAM_SHAPES)
        .optional()
        .describe("circle (round bubble) or rect (16:9 rounded rectangle). Default: the shape last chosen on the PC (circle)."),
      open_link: z
        .boolean()
        .optional()
        .describe(
          "Open the video's URL in the user's default browser on the PC when the video is ready (default true; the PC's " +
            "auto_open_link setting can turn it off for good). false for 'don't open it'.",
        ),
    }),
    async run(a, c) {
      requireWritable(c.env);
      const acct = c.principal!.accountId;
      await requireNotSuspended(c);
      const limits = await accountLimits(c.env, acct);
      // The plan's limit (Free 300 s, Pro and Teams 4 h); owners have none: the start command still carries the ceiling.
      const requested = a.max_seconds ?? limits.maxSeconds ?? LIMITS.recordingCeilingSeconds;
      if (limits.maxSeconds !== null && requested > limits.maxSeconds) {
        const { error, message, ...extra } = limitError("max_seconds", limits.maxSeconds, requested, limits.tier);
        throw new ToolError(error, message, extra);
      }
      // Free: refused up front once all its recordings are used (the count is taken for real at the reservation below).
      const freeMax = limits.freeRecordings;
      if (freeMax !== null && (await freeRecordingsUsed(c.env, acct)) >= freeMax) throw freeLimitReached(c.env, freeMax);
      // Pro and Teams: refused at or over the storage cap (free and owners have none).
      const storage = await storageStatus(c.env, acct, limits);
      if (atStorageLimit(storage)) throw storageLimitReached(c.env, storage);
      const { device, all } = await targetDevice(c, a.device);
      if (!device.online) throw offlineError(device, all, a.device !== undefined);
      const hub = deviceHub(c.env, acct);

      if (a.window !== undefined && a.monitor !== undefined) {
        throw new ToolError("INVALID_ARGUMENTS", "window and monitor are mutually exclusive: record either one window or a whole monitor.");
      }
      // Device choices. Mic and system audio are on by default; mic:false / system_audio:false turn them off.
      const mic = a.mic ?? true;
      const systemAudio = a.system_audio ?? true;
      let monitor = a.monitor === undefined ? undefined : String(a.monitor);
      let micDevice = mic ? a.mic_device : undefined;
      let camera = a.webcam === false ? undefined : a.camera;
      let window: ReturnType<typeof describeWindow> | undefined;
      // With a known inventory, resolve here (before any quota is spent) and send ids; the recorder re-checks.
      let inv: StoredInventory | null =
        monitor !== undefined || micDevice !== undefined || camera !== undefined || a.window !== undefined ? await hub.lastDevices(acct, device.id) : null;
      if (a.window !== undefined) {
        // The last window list answers when it is recent and the window is in it; otherwise ask the PC live. Never
        // forward raw text to the recorder.
        let m = inv?.windows && now() - inv.at < LIMITS.windowReportMaxAgeSeconds ? matchWindow(inv.windows, a.window) : null;
        if (!m || ("error" in m && m.error === "WINDOW_NOT_FOUND")) {
          const live = await hub.devices(acct, device.id, true);
          if (live.inventory) inv = live.inventory;
          m = inv?.windows ? matchWindow(inv.windows, a.window) : null;
        }
        if (!inv || !m) {
          throw new ToolError(
            "RECORDER_UPDATE_REQUIRED",
            "The recorder on this PC cannot record single windows (or did not answer). Run get_installer again to update it, or record a monitor.",
          );
        }
        const monitors = inv.monitors;
        if ("error" in m) {
          throw new ToolError(
            m.error,
            m.error === "WINDOW_AMBIGUOUS"
              ? `Several windows match "${a.window}". Ask the user which one (show app, title and monitor), then pass its id.`
              : `No open window matches "${a.window}" (the PC was just asked). Show the user the candidates, then pass the chosen id.`,
            { field: "window", candidates: m.candidates.map((w) => describeWindow(w, monitors)) },
          );
        }
        window = describeWindow(m.item, monitors);
      }
      if (inv) {
        if (monitor !== undefined) monitor = resolved("monitor", monitor, matchMonitor(inv.monitors, monitor), describeMonitor);
        if (micDevice !== undefined) micDevice = resolved("microphone", micDevice, matchAv(inv.mics, micDevice), (m) => m);
        if (camera !== undefined) camera = resolved("camera", camera, matchAv(inv.cameras, camera), (m) => m);
      }
      const t = now();
      // Free: take one of the account's lifetime recordings first; handed back below if the start does not happen.
      if (freeMax !== null && !(await takeFreeRecording(c.env, acct, freeMax))) throw freeLimitReached(c.env, freeMax);
      const giveBackFree = async () => {
        if (freeMax === null) return;
        try {
          await returnFreeRecording(c.env, acct);
        } catch (e) {
          log("error", "free recording give-back failed", { err: String(e) });
        }
      };
      let decision;
      try {
        decision = await governor(c.env).checkStart({
          accountId: acct,
          paired: true,
          accountMaxPerDay: limits.startsPerDay,
          tier: limits.tier,
          globalMaxPerDay: Number(c.env.GLOBAL_MAX_VIDEOS_PER_DAY),
          now: t,
        });
      } catch (e) {
        log("error", "governor unreachable", { err: String(e) });
        await giveBackFree();
        throw new ToolError("SERVICE_PAUSED", "Guardrails unavailable; refusing to start.");
      }
      if (!decision.ok) {
        await giveBackFree();
        throw new ToolError(decision.code, decision.reason, decision.resets_at ? { resets_at: decision.resets_at } : {});
      }

      // From here on a slot is reserved: any failure hands it back (releaseStart, and the Free recording) before the
      // error goes out, so failed starts never count against the account's limits or the global ceiling.
      const id = randomId(128);
      const { info, sent, maxSeconds } = await (async () => {
        try {
          const info = await hub.recorderInfo(acct, device.id);
          const canSystemAudio = !!info?.features.includes("system_audio");
          // Past the single-upload size only recorders with the chunked upload can deliver: older ones are held to
          // singleUploadMaxSeconds. Chunked recorders get the part size and send any file bigger than one part in parts.
          const chunked = !!info?.features.includes("chunked_upload");
          const maxSeconds = chunked ? requested : Math.min(requested, LIMITS.singleUploadMaxSeconds);
          await c.env.DB.prepare(
            "INSERT INTO recordings (id, account_id, device_id, title, status, max_seconds, mic, system_audio, open_link, created_at, expires_at, slug) " +
              "VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?)",
          )
            .bind(id, acct, device.id, a.title ?? null, maxSeconds, mic ? 1 : 0, systemAudio && canSystemAudio ? 1 : 0, a.open_link === false ? 0 : 1, t, retentionExpiry(c.env, acct, t, limits.keepForever), newSlug())
            .run();
          const uploadToken = await issueUploadToken(c.env, id, device.id, t + maxSeconds + uploadGrace(maxSeconds));
          const sent = await onDevice(device.name, hub.sendCommand(acct, {
            type: "start",
            recording_id: id,
            max_seconds: maxSeconds,
            upload_part_bytes: chunked ? LIMITS.uploadPartBytes : undefined,
            mic,
            upload_token: uploadToken,
            webcam: a.webcam,
            camera,
            webcam_size: a.webcam === false ? undefined : a.webcam_size,
            monitor,
            mic_device: micDevice,
            window: window?.id,
            system_audio: systemAudio,
            webcam_shape: a.webcam === false ? undefined : a.webcam_shape,
          }, device.id), { device: device.id, device_name: device.name }).catch(async (e) => {
            await c.env.DB.prepare("UPDATE recordings SET status = 'failed', error = 'DEVICE_OFFLINE' WHERE id = ?").bind(id).run();
            throw e;
          });
          if (!sent.ok || sent.device_id !== device.id) {
            await c.env.DB.prepare("UPDATE recordings SET status = 'failed', error = 'DEVICE_OFFLINE' WHERE id = ?").bind(id).run();
            throw connectionLost(device.name, { device: device.id, device_name: device.name });
          }
          return { info, sent, maxSeconds };
        } catch (e) {
          try {
            await governor(c.env).releaseStart(acct, t, limits.tier);
          } catch (re) {
            log("error", "start release failed", { err: String(re) });
          }
          await giveBackFree();
          throw e;
        }
      })();
      // Older recorders still record; the agent hears what they left out. system_audio is always sent, so a recorder
      // older than 0.4 always shows up here.
      const dropped: RecorderFeature[] = [...sent.dropped, ...(maxSeconds < requested ? (["chunked_upload"] as const) : [])];
      const notes = dropped.map((f) => UNSUPPORTED[f]);
      return {
        recording_id: id,
        ...(await linkFields(c, { id, title: a.title ?? null, created_at: t })),
        status: "recording",
        max_seconds: maxSeconds,
        mic,
        system_audio: systemAudio && !sent.dropped.includes("system_audio"),
        ...(dropped.length && { recorder_version: info?.version ?? "older than 0.4", unsupported: dropped, notes }),
        ...(monitor !== undefined && { monitor }),
        ...(micDevice !== undefined && { mic_device: micDevice }),
        ...(camera !== undefined && { camera }),
        ...(window && { window: window.id, window_app: window.app, window_title: window.title }),
        device: device.id,
        device_name: device.name,
        ...withStorageWarning(storage),
        note: "The user sees a recording bar with a Stop button at the top of the screen. Call get_video with wait_seconds to get the link once it stops.",
      };
    },
  }),

  stop_recording: tool({
    auth: true,
    description:
      "Stop an in-progress recording. It then uploads; call get_video with wait_seconds until it is ready. " +
      "recording_id is optional: omitted, it stops the account's one active recording (NO_ACTIVE_RECORDING when none is; " +
      "MULTIPLE_ACTIVE_RECORDINGS with the list in `active` when several devices are recording: call again with " +
      "recording_id). " +
      NAME_VIDEO_RULE +
      " " +
      VIDEO_LINK_HINT,
    input: z.object({
      recording_id: RecId.optional().describe("The recording to stop. Omitted: the account's only active recording."),
    }),
    async run(a, c) {
      const rec = await ownRecording(c, a.recording_id ?? (await onlyActiveRecording(c)));
      const links = await linkFields(c, rec);
      if (rec.status !== "starting" && rec.status !== "recording") return { recording_id: rec.id, ...links, status: rec.status };
      // To the device that is recording it.
      const acct = c.principal!.accountId;
      const name =
        (await c.env.DB.prepare("SELECT name FROM devices WHERE id = ?").bind(rec.device_id).first<{ name: string }>())?.name ?? "The recorder";
      const extra = { recording_id: rec.id, device: rec.device_id, device_name: name, note: "The recording stops by itself at max_seconds." };
      const sent = await onDevice(name, deviceHub(c.env, acct).sendCommand(acct, { type: "stop", recording_id: rec.id }, rec.device_id), extra);
      if (!sent.ok) throw deviceOffline(name, extra);
      return { recording_id: rec.id, ...links, status: "stopping" };
    },
  }),

  get_video: tool({
    auth: true,
    description:
      "Get a recording's status (starting|recording|uploading|transcribing|ready|failed|expired) with its title, description, url (" +
      `the video's one URL, ${LINK_SHAPE}: show it to the user; share it with anyone else only after the user approves), ` +
      "display (the ready-made Markdown link) and owner_url. Use wait_seconds (<=25) to long-poll until it is ready. When ready: share_url " +
      "(= url, for older clients), visibility and note. " +
      VISIBILITY_MEANING + " With a live custom domain, every video's url is https://<custom domain>/<slug> (owner_url " +
      "stays on this server's own host). expires_at null = kept until deleted (owner tier); " +
      "auto_delete_paused: true = not deleted at expires_at for now. " + OWNER_URL_RULE + " " +
      "has_system_audio = the video includes the PC's sound. transcript_status 'pending' = ready to watch, transcript still coming. " +
      "removed: true = taken down for a policy violation (suspended: true = the whole account): its link answers 451, so " +
      "don't share it; tell the user note. " +
      NAME_VIDEO_RULE +
      " " +
      VIDEO_LINK_HINT,
    input: z.object({ recording_id: RecId, wait_seconds: z.number().int().min(0).max(25).default(0) }),
    async run(a, c) {
      const deadline = Date.now() + a.wait_seconds * 1000;
      let rec = await ownRecording(c, a.recording_id);
      while (!["ready", "failed", "expired"].includes(rec.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        rec = await ownRecording(c, a.recording_id);
      }
      return videoResult(c, rec);
    },
  }),

  update_video: tool({
    auth: true,
    description:
      "Set or change a recording's title and/or short description (<=280 chars; empty string clears it). When the user " +
      "names or describes a recording, call update_video. Title: one line, up to 120 characters; an empty title resets " +
      "it to the default. The description keeps line breaks. Returns the video like get_video, with the new title in " +
      "display. " +
      VIDEO_LINK_HINT,
    input: z.object({
      video_id: RecId.optional(),
      recording_id: RecId.optional().describe("Alias of video_id."),
      title: z.string().max(1000).optional().describe("New title, up to 120 characters; \"\" resets it to the default."),
      description: z.string().max(4000).optional().describe("New short description, up to 280 characters; \"\" clears it."),
    }),
    async run(a, c) {
      requireWritable(c.env);
      const id = a.video_id ?? a.recording_id;
      if (!id) throw new ToolError("INVALID_ARGUMENTS", "video_id is required.");
      let row;
      try {
        row = await setVideoMeta(c.env, c.principal!.accountId, id, { title: a.title, description: a.description });
      } catch (e) {
        if (e instanceof VideoMetaError) throw new ToolError("INVALID_ARGUMENTS", e.message);
        throw e;
      }
      if (!row) throw new ToolError("NOT_FOUND", "No such recording on this account.");
      return videoResult(c, await ownRecording(c, row.id));
    },
  }),

  list_comments: tool({
    auth: true,
    description:
      "List viewers' comments on one of the user's videos, newest first (owner only). since (ISO-8601) = only comments " +
      "created after that time. Each comment has author, is_owner (the user's own reply), body, t_seconds (the moment " +
      "in the video it refers to, or null), created_at (ISO), display (a Markdown link to the video) and id (for " +
      "delete_comment). " +
      COMMENTS_RULE +
      " " +
      VIDEO_LINK_HINT,
    input: z.object({
      video_id: RecId,
      since: z.iso.datetime({ offset: true }).optional().describe("ISO-8601 time of your last check; only newer comments."),
    }),
    async run(a, c) {
      const since = a.since === undefined ? undefined : Math.floor(Date.parse(a.since) / 1000);
      const rows = await commentDeps.listComments(c.env, c.principal!.accountId, a.video_id, since === undefined ? {} : { since });
      if (!rows) throw new ToolError("NOT_FOUND", "No such recording on this account.");
      const video = await linkFields(c, await ownRecording(c, a.video_id));
      // The watch page has no ?t= deep link, so every comment links to the video itself.
      const comments = rows.map((r) => ({
        id: r.id,
        author: r.author,
        is_owner: r.is_owner,
        body: r.body,
        t_seconds: r.t_seconds,
        created_at: new Date(r.created_at * 1000).toISOString(),
        display: videoLink(r.t_seconds === null ? r.author : `${r.author} at ${mss(r.t_seconds)}`, video.url),
      }));
      return { video: { id: a.video_id, ...video }, comments, count: comments.length };
    },
  }),

  delete_comment: tool({
    auth: true,
    description:
      "Delete one comment on one of the user's videos (owner only), e.g. spam or when the user asks. comment_id is the " +
      "id from list_comments. The comment disappears from the page at once; it cannot be restored.",
    input: z.object({
      recording_id: RecId.optional(),
      video_id: RecId.optional().describe("Alias of recording_id."),
      comment_id: z.string().regex(/^[A-Za-z0-9]{10,40}$/, "invalid comment_id"),
    }),
    async run(a, c) {
      requireWritable(c.env);
      const id = a.recording_id ?? a.video_id;
      if (!id) throw new ToolError("INVALID_ARGUMENTS", "recording_id is required.");
      const rec = await ownRecording(c, id);
      if (!(await ownerDeleteComment(c.env, rec.id, a.comment_id))) throw new ToolError("NOT_FOUND", "No such comment on this video.");
      return { recording_id: rec.id, comment_id: a.comment_id, deleted: true };
    },
  }),

  list_videos: tool({
    auth: true,
    description:
      "List this account's videos (recordings), newest first, each with its view stats. The first entry is the user's last " +
      "video: 'how many people watched my last video' -> list_videos{limit:1}, answer with unique_views (people) and views " +
      "(opens). Each video has title, url, display and owner_url. " + STATS_MEANING + " For a per-day breakdown call " +
      "get_video_stats. " + OWNER_URL_RULE + " " + VIDEO_LINK_HINT,
    input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    async run(a, c) {
      return listVideos(c, a.limit);
    },
  }),

  list: tool({
    auth: true,
    description:
      "Same as list_videos (kept for older clients): this account's recordings, newest first, with title, url, display, " +
      "owner_url and view stats. " + OWNER_URL_RULE + " " + VIDEO_LINK_HINT,
    input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    async run(a, c) {
      return listVideos(c, a.limit);
    },
  }),

  search_videos: tool({
    auth: true,
    description:
      "Search this account's videos by words in the title, description and transcript, case-insensitive ('the pricing " +
      "demo', 'video where I mention invoices'). Title matches first, then description matches, then transcript-only " +
      "matches; better matches first, then newest first. matched_in says where each video matched (title, description " +
      "or transcript). Videos that match nothing are left out. Each result has the same title, description, url, display, " +
      "owner_url and view stats as list_videos. " + STATS_MEANING + " " + OWNER_URL_RULE + " " + VIDEO_LINK_HINT,
    input: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    async run(a, c) {
      // Score the newest 200 (Workers Free: 50, config.ts searchScan) unexpired videos here (free videos last 7 days, so that is nearly always all of them).
      const rows = await c.env.DB.prepare(
        `SELECT ${VIDEO_COLS}, transcript FROM recordings WHERE account_id = ? AND ${unexpiredSql()} ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(c.principal!.accountId, now(), getConfig(c.env).workers.searchScan)
        .all<VideoRow & { transcript: string | null }>();
      const hits = rows.results
        .flatMap(({ transcript, ...r }) => {
          const hit = searchHit(a.query, { title: r.title, description: r.description, transcript: transcriptText(transcript) });
          return hit ? [{ ...asBool(r), ...hit }] : [];
        })
        .sort(searchOrder)
        .slice(0, a.limit)
        .map(({ score: _s, ...r }) => r);
      return { query: a.query, recordings: await withLinks(c, await withWatchPct(c.env, hits)) };
    },
  }),

  get_video_stats: tool({
    auth: true,
    description:
      "View stats for one video: totals plus a per-day breakdown (UTC dates, newest first, last 30 days, days without " +
      "views omitted), with the video's title, url and display. " + STATS_MEANING + " " + VIDEO_LINK_HINT,
    input: z.object({
      recording_id: RecId.optional(),
      video_id: RecId.optional().describe("Alias of recording_id."),
    }),
    async run(a, c) {
      const id = a.recording_id ?? a.video_id;
      if (!id) throw new ToolError("INVALID_ARGUMENTS", "recording_id is required.");
      const rec = await ownRecording(c, id);
      const [totals] = await withWatchPct(c.env, [
        { recording_id: rec.id, views: rec.views, unique_views: rec.unique_views, last_viewed_at: rec.last_viewed_at, previews: rec.previews },
      ]);
      return { ...totals, ...(await linkFields(c, rec)), status: rec.status, created_at: rec.created_at, daily: await dailyStats(c.env, rec.id) };
    },
  }),

  get_transcript: tool({
    auth: true,
    description: "Get a ready recording's transcript as timestamped text lines `[mm:ss] text` or WebVTT. Needs the mic on at start (the default; not with mic:false).",
    input: z.object({ recording_id: RecId, format: z.enum(["text", "vtt"]).default("text") }),
    async run(a, c) {
      const rec = await ownRecording(c, a.recording_id);
      if (await recordingRemoved(c.env, rec.id, c.principal!.accountId)) throw new ToolError("RECORDING_REMOVED", REMOVED_MESSAGE);
      if (rec.transcript_status !== "ready" || !rec.transcript) {
        throw new ToolError("TRANSCRIPT_UNAVAILABLE", `Transcript status: ${rec.transcript_status}.`);
      }
      const segments = (JSON.parse(rec.transcript) as { segments: Segment[] }).segments;
      const transcript = a.format === "vtt" ? toVtt(segments) : segments.map((s) => `[${mmss(s.start)}] ${s.text.trim()}`).join("\n");
      return { recording_id: rec.id, format: a.format, transcript };
    },
  }),

  share_recording: tool({
    auth: true,
    description: SHARE_DESCRIPTION,
    input: ShareInput,
    run: shareTool,
  }),

  share: tool({
    auth: true,
    description: "Same as share_recording (kept for older clients). " + SHARE_DESCRIPTION,
    input: ShareInput,
    run: shareTool,
  }),

  revoke_share: tool({
    auth: true,
    description:
      "Make a recording private again AND retire its URL: the video gets a new URL at once, so the old one stops working " +
      "for everyone who has it (page and playback, even a page already open). Returns the new URL, which is private: only " +
      "the user can open it (with the returned owner_url, or signed in on the website). Every owner_url handed out " +
      "before stops working too. Call share_recording later to make that new URL public. Owner only. " +
      OWNER_URL_RULE,
    input: z.object({ recording_id: RecId }),
    async run(a, c) {
      const rec = await ownRecording(c, a.recording_id);
      await revokeShare(c.env, c.base, rec.id, c.principal!.accountId);
      const { fields, home } = await videoLinks(c, rec);
      return { recording_id: rec.id, share_url: fields.url, owner_url: await ownerLink(c, home, rec.id), visibility: "private", note: NOTE_REVOKED };
    },
  }),

  set_username: tool({
    auth: true,
    description:
      `Change the account's username, the <username> in video URLs (${LINK_SHAPE}). 3-30 characters: ` +
      "lowercase letters, digits and single hyphens, starting and ending with a letter or digit. Some words are reserved. " +
      "Public videos opened at the old username redirect to the new one. Optionally set display_name, shown on video " +
      "pages as 'Recorded by <display_name>' (default: the username). Without username it returns the current one. " +
      "Errors: INVALID_USERNAME, USERNAME_RESERVED, USERNAME_TAKEN.",
    input: z.object({
      username: z.string().min(1).max(64).optional(),
      display_name: z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u, "invalid display_name").nullable().optional(),
    }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      let username = await assignUsername(c.env.DB, acct);
      if (a.username !== undefined && a.username.trim().toLowerCase() !== username) {
        const r = await setUsername(c.env.DB, acct, a.username.trim().toLowerCase());
        if (!r.ok) {
          const why = {
            INVALID_USERNAME: "Use 3-30 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.",
            USERNAME_RESERVED: "That word is reserved. Pick another username.",
            USERNAME_TAKEN: "Another account has that username. Pick another one.",
          }[r.error];
          throw new ToolError(r.error, why);
        }
        username = r.username;
      }
      if (a.display_name !== undefined) {
        await c.env.DB.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").bind(a.display_name, acct).run();
      }
      const row = await c.env.DB.prepare("SELECT display_name FROM accounts WHERE id = ?").bind(acct).first<{ display_name: string | null }>();
      return { username, display_name: row?.display_name ?? null };
    },
  }),

  delete: tool({
    auth: true,
    description: "Permanently delete a recording, its transcript, its view stats and its URL.",
    input: z.object({ recording_id: RecId }),
    async run(a, c) {
      const rec = await ownRecording(c, a.recording_id);
      if ((await heldRecordingIds(c.env, [rec.id])).size) {
        throw new ToolError("RECORDING_REMOVED", `${REMOVED_MESSAGE} It can't be deleted.`);
      }
      if (rec.status === "starting" || rec.status === "recording") {
        // Best effort: an offline or dropping device must not keep the recording from being deleted.
        await deviceHub(c.env, c.principal!.accountId)
          .sendCommand(c.principal!.accountId, { type: "stop", recording_id: rec.id }, rec.device_id)
          .catch((e) => log("warn", "stop before delete failed", { err: String(e) }));
      }
      await deleteRecordings(c.env, [rec.id]);
      return { recording_id: rec.id, deleted: true };
    },
  }),

  rotate_key: tool({
    auth: true,
    description: "Issue a new API key and revoke the one used for this call. The new key is shown ONCE.",
    input: z.object({}),
    async run(_a, c) {
      const api_key = await issueApiKey(c.env, c.principal!.accountId);
      await revokeApiKey(c.env, c.principal!.keyId);
      return { api_key, revoked_previous: true };
    },
  }),
};

/**
 * Deletes recordings with everything stored for them: media, keyframes, shares, views, comments, the row. In batches of
 * 100: D1 binds at most 100 parameters per statement (cleanup passes up to 500 ids), and 100 x 8 keys stays under R2's
 * 1000 keys per delete call.
 */
/** Deletes recordings and everything of them, except held ones (takedown-state.ts), which are skipped and logged. */
export async function deleteRecordings(env: Env, ids: string[]): Promise<void> {
  const held = await heldRecordingIds(env, ids);
  if (held.size) log("warn", "delete: held recordings skipped", { held: [...held] });
  const go = ids.filter((id) => !held.has(id));
  for (let i = 0; i < go.length; i += 100) await deleteBatch(env, go.slice(i, i + 100));
}

async function deleteBatch(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await abortMultipartUploads(env, `recording_id IN (${ids.map(() => "?").join(",")})`, ids);
  await env.MEDIA.delete(ids.flatMap((id) => [`v/${id}.mp4`, `a/${id}.wav`, ...keyframeKeys(id)]));
  const ph = ids.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM recording_keyframes WHERE recording_id IN (${ph})`).bind(...ids),
    env.DB.prepare(`DELETE FROM shares WHERE recording_id IN (${ph})`).bind(...ids),
    env.DB.prepare(`DELETE FROM video_views WHERE recording_id IN (${ph})`).bind(...ids),
    env.DB.prepare(`DELETE FROM comments WHERE video_id IN (${ph})`).bind(...ids),
    env.DB.prepare(`DELETE FROM recordings WHERE id IN (${ph})`).bind(...ids),
  ]);
}

const allTools = Object.entries(TOOLS).map(([name, t]) => {
  const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  return { name, description: t.description, inputSchema, ownerOnly: !!(t as Tool<z.ZodType>).ownerOnly };
});
const strip = (l: typeof allTools) => l.map(({ ownerOnly: _o, ...t }) => t);
/** tools/list, for operators and for everyone else: with billing, and (off) without the billing tools and any mention of plans. */
const listsOf = (l: typeof allTools) => ({ owner: strip(l), user: strip(l.filter((t) => !t.ownerOnly)) });
const billingLists = listsOf(allTools);
const plainLists = listsOf(allTools.filter((t) => !BILLING_ONLY_TOOLS.has(t.name)).map(plainTool));

/** The caller is an operator (env.ts isOperatorAccount). */
const isOperator = async (c: Ctx) => !!c.principal && isOperatorAccount(c.env, c.principal.accountId);

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const rpcResult = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** An image content block (MCP), base64 data. */
export type ImageContent = { type: "image"; data: string; mimeType: string };
export type ContentBlock = { type: "text"; text: string } | ImageContent;
/**
 * A tool result's extra content blocks (e.g. images), after the JSON text block. A symbol key: JSON leaves it out, so
 * the blocks are not repeated in the text or in structuredContent.
 */
export const EXTRA_CONTENT = Symbol("extra content");

function toolResult(data: Record<string, unknown>, isError = false) {
  const extra = (data as { [EXTRA_CONTENT]?: ContentBlock[] })[EXTRA_CONTENT] ?? [];
  return { content: [{ type: "text", text: JSON.stringify(data) }, ...extra], structuredContent: data, isError };
}

async function dispatch(msg: RpcReq, c: Ctx): Promise<unknown | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(null, -32600, "Invalid Request");
  if (msg.id === undefined) return null; // notification
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-recorder", version: SERVER_VERSION },
        instructions: mcpInstructions(getConfig(c.env)),
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: (billingConfigured(c.env) ? billingLists : plainLists)[(await isOperator(c)) ? "owner" : "user"] });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const t = Object.hasOwn(TOOLS, name) ? (TOOLS as Record<string, Tool<z.ZodType>>)[name] : undefined;
      if (!t || (t.ownerOnly && !(await isOperator(c)))) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      // Not listed without billing; a client that still has the old list is told why, with no link and no plan.
      if (BILLING_ONLY_TOOLS.has(name) && !billingConfigured(c.env)) {
        return rpcResult(msg.id, toolResult({ error: "BILLING_NOT_ENABLED", message: BILLING_NOT_ENABLED }, true));
      }
      // An OAuth session must not mint a permanent API key (it has no key of its own to rotate).
      if (name === "rotate_key" && c.principal?.oauth) {
        return rpcResult(msg.id, toolResult({ error: "NOT_SUPPORTED", message: "rotate_key only applies to API keys. OAuth sessions are revoked from the app." }, true));
      }
      const parsed = t.input.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) {
        return rpcResult(msg.id, toolResult({ error: "INVALID_ARGUMENTS", message: z.prettifyError(parsed.error) }, true));
      }
      try {
        return rpcResult(msg.id, toolResult(await t.run(parsed.data, c)));
      } catch (e) {
        if (e instanceof ToolError) return rpcResult(msg.id, toolResult({ error: e.code, message: e.message, ...e.extra }, true));
        log("error", "tool failed", { tool: name, err: String(e) });
        return rpcResult(msg.id, toolResult({ error: "INTERNAL", message: "Internal error." }, true));
      }
    }
    default:
      return rpcError(msg.id, -32601, "Method not found");
  }
}

const SIGN_IN = "Sign in by connecting Recitbot through the app's OAuth connector, or send Authorization: Bearer <api_key>.";

/** 401 with the RFC 9728 challenge, repeated in _meta for clients that only read the body. */
const unauthorized = (body: (meta: Record<string, unknown>) => unknown, challenge: string) =>
  json(body({ "mcp/www_authenticate": [challenge] }), 401, { "www-authenticate": challenge });

/** /mcp and (only when ALLOW_URL_KEY=true) /mcp/k/<key>. CORS is added by the router. */
export async function handleMcp(req: Request, env: Env, exec: ExecutionContext, urlKey: string | null): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  const ip = clientIp(req);
  const ipHash = await hmacHex(env.IP_HASH_KEY, `ip:${ip}`);
  const g = governor(env);
  const t = now();

  let principal: Principal | null = null;
  const key = urlKey ?? bearer(req);
  let body: unknown;
  let parseError = false;
  try {
    if (key) {
      if (!(await g.hit(`authfail:${ipHash}`, LIMITS.authFailuresPer10Min, 600, t, false)).ok) {
        return json({ error: "too many failed attempts" }, 429, { "retry-after": "600" });
      }
      const v = await verifyBearer(env, key, resourceFor(env, url));
      if (!v || v === "stale") {
        // An expired or revoked OAuth token is routine (the client refreshes); only unknown credentials count as failures.
        if (!v) await g.hit(`authfail:${ipHash}`, LIMITS.authFailuresPer10Min, 600, t);
        const error_description = "The access token or API key is invalid or expired.";
        return unauthorized((_meta) => ({ error: "invalid_token", error_description, _meta }), mcpChallenge(env, url, true));
      }
      principal = v;
    }
    try {
      body = await req.json();
    } catch {
      parseError = true;
    }
    // A JSON-RPC batch costs one call per message, all or none.
    const cost = Array.isArray(body) ? Math.max(body.length, 1) : 1;
    const rl = await g.hit(principal ? `mcp:${principal.keyId}` : `mcp-anon:${ipHash}`, LIMITS.mcpCallsPerMinute, 60, t, true, cost);
    if (!rl.ok) return json({ error: "rate limited" }, 429, { "retry-after": String(rl.retry_after) });
  } catch (e) {
    log("error", "governor unreachable", { err: String(e) });
    return json({ error: "service unavailable" }, 503);
  }

  if (parseError) return json(rpcError(null, -32700, "Parse error"), 400);
  // Discovery (initialize, tools/list, ping) is open; any tool call needs a credential.
  const call = (Array.isArray(body) ? body : [body]).find((m) => (m as RpcReq | null)?.method === "tools/call") as RpcReq | undefined;
  if (call && !principal) {
    const result = toolResult({ error: "UNAUTHORIZED", message: SIGN_IN }, true);
    return unauthorized((_meta) => rpcResult(call.id ?? null, { ...result, _meta }), mcpChallenge(env, url));
  }
  const c: Ctx = { env, exec, base: publicBase(env, url.origin), principal, ipHash };
  if (Array.isArray(body)) {
    if (body.length > 20) return json(rpcError(null, -32600, "Batch too large"), 400);
    const out = (await Promise.all(body.map((m) => dispatch(m as RpcReq, c)))).filter((r) => r !== null);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await dispatch(body as RpcReq, c);
  return out === null ? new Response(null, { status: 202 }) : json(out);
}
