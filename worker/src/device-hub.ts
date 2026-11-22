// DeviceHub: one Durable Object per account. Holds the outbound WebSocket of each of the account's paired recorders
// (Hibernation API, one live socket per device) and signs every command it sends with that device's command key.
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { uninstallDevice } from "./auth";
import { autoUpdate, autoUpdateReport, autoUpdateStatus, forgetAutoUpdate, rememberOrigin, type AutoUpdateStatus } from "./auto-update";
import { DevicesReport, type StoredInventory } from "./devices";
import type { Env } from "./env";
import { LIMITS } from "./env";
import type { UpdateCommand } from "./recorder-update";
import { hmacHex, log, now, randomId } from "./util";

export type DeviceCommand = {
  /**
   * "devices" asks the recorder to send its inventory now (recording_id carries the request id). "ready" tells the
   * recorder that recorded it that the share link is ready (url = owner link; the recorder opens it in the browser).
   * "update" (recorder "self_update") tells the recorder to install `version` from `url`, whose SHA-256 is `sha256`.
   * "uninstall" tells the recorder to remove this account's pairing, or itself (`scope`; recording_id carries the
   * request id it acks with).
   */
  type: "start" | "stop" | "devices" | "ready" | "update" | "uninstall";
  recording_id: string;
  max_seconds?: number;
  mic?: boolean;
  upload_token?: string;
  /** Webcam bubble overrides. Omitted fields use the device's own config (webcam off unless enabled there). */
  webcam?: boolean;
  camera?: string;
  /** A preset name, or a number = percent of the monitor's short side (recorder 0.4+, "webcam_pct"). */
  webcam_size?: WebcamSize | number;
  /** Device choices (inventory ids or names). Omitted = primary monitor / Windows default mic. */
  monitor?: string;
  mic_device?: string;
  /** Window id from the inventory (instead of a monitor). The recorder resolves it against its own live window list. */
  window?: string;
  /** Record the default output device's sound (recorder 0.4+, "system_audio"). */
  system_audio?: boolean;
  /** Bubble shape (recorder 0.4+, "webcam_shape"). */
  webcam_shape?: WebcamShape;
  /** "ready": the link to open. "update": the signed install.ps1 download link. */
  url?: string;
  /** "update" only: the recorder version url installs and install.ps1's SHA-256 (uppercase hex). */
  version?: string;
  sha256?: string;
  /**
   * "update" only (recorder "signed_update"): the offline-signed release manifest and its Ed25519 signature, base64 as
   * the release made them. Not part of the HMAC canonical string (the signature covers them); left out for recorders
   * that did not announce signed_update.
   */
  manifest?: string;
  manifest_sig?: string;
  /**
   * Chunked upload (recorder "chunked_upload"): files larger than this go through /upload/:id/(video|audio)/mp in parts
   * of exactly this many bytes (the last one smaller). Absent = single PUT only.
   */
  upload_part_bytes?: number;
  /** "uninstall" only (recorder "multi_account"): what to remove. Older recorders always remove themselves completely. */
  scope?: UninstallScope;
};

/** "account": only this account's pairing (the install stays for its other accounts). "all": Recitbot completely. */
export type UninstallScope = "account" | "all";

export const WEBCAM_SIZES = ["small", "medium", "large"] as const;
export type WebcamSize = (typeof WEBCAM_SIZES)[number];
/** Bubble diameter (px at 100 % scale) for each webcam_size; the recorder maps the same names. */
export const WEBCAM_SIZE_PX: Record<WebcamSize, number> = { small: 160, medium: 240, large: 360 };
export const WEBCAM_SHAPES = ["circle", "rect"] as const;
export type WebcamShape = (typeof WEBCAM_SHAPES)[number];

/**
 * What a recorder can do beyond the original v1 command, from the "hello" frame it sends on connect (0.4+). Recorders
 * that never say hello are treated as having none of these: fields they cannot verify are left out of their commands
 * (an unknown signed block would fail their HMAC check and the whole recording would be refused).
 */
export const RECORDER_FEATURES = [
  "system_audio",
  "webcam_shape",
  "webcam_pct",
  "ready_push",
  "chunked_upload",
  "self_update",
  "multi_account",
  // 0.6.1: an update that arrives during a recording is held until it has uploaded ("deferred" report), and a failed
  // install is rolled back ("rolled_back" report on the next connect).
  "update_defer_rollback",
  // 0.6.1: PUTs up to 6 JPEG stills after the MP4 upload (/upload/<id>/keyframes/<n>). Nothing is sent or held for it.
  "keyframes",
  // An update is installed only with a release manifest signed by a release key compiled into the recorder
  // (manifest/manifest_sig in the update command); it refuses (failed) any other. No update is sent without one.
  "signed_update",
] as const;
export type RecorderFeature = (typeof RECORDER_FEATURES)[number];

const Hello = z.object({
  type: z.literal("hello"),
  version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  features: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(16),
});

/** connectedAt: unix ms the socket opened (picks the most recently seen device). messageAt: unix ms of its last message. */
type Attachment = {
  deviceId: string;
  accountId: string;
  connectedAt?: number;
  messageAt?: number;
  /**
   * Replaced by a newer socket of its device: the recorder reconnects only after its old connection failed, so this one
   * is abandoned. Never routed to again; its close or error (if one ever comes) does not count as a sighting.
   *
   * The hub does not close it, nor a stale one: a close frame (like any send) into a peer that no longer reads stays
   * pending until the runtime drops the socket, often minutes later, and a pending write keeps the hub from hibernating
   * (billed the whole time). The runtime drops dead sockets on its own; a hibernatable socket costs nothing meanwhile.
   */
  replaced?: boolean;
  /**
   * Silent past the heartbeat timeout (pruneStale): its last heartbeat was noted as the device's last sighting, and its
   * close or error does not count as another. Cleared if it pings again (a short sleep the connection survived).
   */
  stale?: boolean;
  version?: string;
  features?: string[];
};

/**
 * Unix ms of a device socket's last sign of life: its last "ping" (pongAt: when the auto-response answered it, which
 * neither wakes the hub nor touches devices.last_seen_at), its last message, or the connect.
 */
export function heartbeatOf(a: Pick<Attachment, "connectedAt" | "messageAt">, pongAt: number | null): number {
  return Math.max(a.connectedAt ?? 0, a.messageAt ?? 0, pongAt ?? 0);
}

/** A socket is online only while its heartbeat is at most LIMITS.deviceHeartbeatTimeoutSeconds old (at `at`, unix ms). */
export function isLive(heartbeat: number, at: number): boolean {
  return heartbeat >= at - LIMITS.deviceHeartbeatTimeoutSeconds * 1000;
}

/**
 * {"type":"update",...} from the recorder: it launched the installer for `version`, or could not (`error`). 0.6.1+
 * ("update_defer_rollback") also: "deferred" (held until the recording in progress has uploaded; not a failure) and
 * "rolled_back" (the installer put the previous version back; sent on the next connect).
 */
const UpdateReport = z.object({
  type: z.literal("update"),
  status: z.enum(["installing", "failed", "deferred", "rolled_back"]),
  version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  error: z.string().regex(/^[\w .:,()'/-]{1,200}$/).optional(),
});
/**
 * {"type":"uninstall_ack","request_id":...,"accounts_remaining":n}: the recorder got the uninstall command and is
 * removing what it asked for; accounts_remaining = accounts still paired on that install afterwards (absent: older
 * recorders, which remove themselves completely). Without a request this socket is waiting on (no request_id, or an
 * unknown one) and with accounts_remaining 0, it says the install is removing itself (a full removal that came in
 * through another account): see webSocketMessage.
 */
const UninstallAck = z.object({
  type: z.literal("uninstall_ack"),
  request_id: z.string().max(64).optional(),
  accounts_remaining: z.number().int().min(0).max(1000).optional(),
});

export type UpdateStatus = Omit<z.infer<typeof UpdateReport>, "type"> & { device_id: string; at: number };

/** A start command fitted to what the recorder supports: unsupported fields removed and named in `dropped`. */
export function fitCommand(cmd: DeviceCommand, features: readonly string[]): { cmd: DeviceCommand; dropped: RecorderFeature[] } {
  const out = { ...cmd };
  const dropped: RecorderFeature[] = [];
  if (out.system_audio !== undefined && !features.includes("system_audio")) {
    delete out.system_audio;
    dropped.push("system_audio");
  }
  if (out.webcam_shape !== undefined && !features.includes("webcam_shape")) {
    delete out.webcam_shape;
    dropped.push("webcam_shape");
  }
  if (typeof out.webcam_size === "number" && !features.includes("webcam_pct")) {
    delete out.webcam_size;
    dropped.push("webcam_pct");
  }
  // Not a user option: start_recording only sets it for recorders that announced it (and shortens max_seconds otherwise).
  if (out.upload_part_bytes !== undefined && !features.includes("chunked_upload")) delete out.upload_part_bytes;
  if (out.scope !== undefined && !features.includes("multi_account")) delete out.scope;
  // Unsigned extras, ignored by older recorders anyway: their path stays exactly the hash-pinned one.
  if (!features.includes("signed_update")) {
    delete out.manifest;
    delete out.manifest_sig;
  }
  return { cmd: out, dropped };
}

/** Per-device HMAC key for commands. Derived from a Worker secret, never stored. */
export function deviceCommandKey(env: Env, deviceId: string): Promise<string> {
  return hmacHex(env.DEVICE_CMD_KEY, `device-cmd:${deviceId}`);
}

/** Canonical string the recorder verifies. Keep in sync with recorder/AgentRecorder.cs `Canonical`. */
export function canonicalCommand(f: {
  type: string;
  recording_id: string;
  max_seconds: number;
  mic: boolean;
  nonce: number;
  exp: number;
  account_id: string;
  device_id: string;
  upload_token: string;
  webcam?: boolean;
  camera?: string;
  webcam_size?: string | number;
  monitor?: string;
  mic_device?: string;
  window?: string;
  system_audio?: boolean;
  webcam_shape?: string;
  url?: string;
  upload_part_bytes?: number;
  version?: string;
  sha256?: string;
  scope?: string;
}): string {
  const parts: (string | number)[] = [
    "v1",
    f.type,
    f.recording_id,
    f.max_seconds,
    f.mic ? 1 : 0,
    f.nonce,
    f.exp,
    f.account_id,
    f.device_id,
    f.upload_token,
  ];
  // Webcam fields are signed only when present, so commands without them keep the original v1 form
  // (older recorders keep working unless a webcam option is actually requested).
  if (f.webcam !== undefined || f.camera !== undefined || f.webcam_size !== undefined) {
    parts.push("cam", f.webcam === undefined ? "" : f.webcam ? 1 : 0, f.camera ?? "", f.webcam_size ?? "");
  }
  // Same for the device block (recorders older than 0.2 reject it, so it is only sent when a device was chosen).
  if (f.monitor !== undefined || f.mic_device !== undefined) {
    parts.push("dev", f.monitor ?? "", f.mic_device ?? "");
  }
  // Window block (recorder 0.3+), only when a window is recorded.
  if (f.window !== undefined) parts.push("win", f.window);
  // Recorder 0.4 blocks, each only when present (fitCommand leaves them out for older recorders).
  if (f.system_audio !== undefined) parts.push("sa", f.system_audio ? 1 : 0);
  if (f.webcam_shape !== undefined) parts.push("shape", f.webcam_shape);
  if (f.url !== undefined) parts.push("url", f.url);
  // Chunked upload block (recorder "chunked_upload"), only when present.
  if (f.upload_part_bytes !== undefined) parts.push("mp", f.upload_part_bytes);
  // Self-update block (recorder "self_update"), only on "update" commands; the download link is the url block.
  if (f.version !== undefined || f.sha256 !== undefined) parts.push("upd", f.version ?? "", f.sha256 ?? "");
  // Uninstall scope block (recorder "multi_account"), only on "uninstall" commands to recorders that announced it.
  if (f.scope !== undefined) parts.push("scope", f.scope);
  return parts.join("|");
}

const DeviceEvent = z.object({
  type: z.literal("status"),
  recording_id: z.string().regex(/^[A-Za-z0-9]{10,40}$/),
  status: z.enum(["recording", "uploading", "failed"]),
  error: z.string().max(200).optional(),
});

export class DeviceHub extends DurableObject<Env> {
  /** In-flight live inventory / uninstall requests (request id -> resolver). Lives only while a tool call waits. */
  private waiters = new Map<string, (ack?: z.infer<typeof UninstallAck>) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object: keeps idle cost near zero.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * WebSocket upgrade. The Worker has already authenticated the device token, set these headers and written the
   * connect to devices.last_seen_at. No awaited I/O and no writes to other sockets here (see Attachment.replaced).
   */
  async fetch(req: Request): Promise<Response> {
    const accountId = req.headers.get("x-ar-account");
    const deviceId = req.headers.get("x-ar-device");
    if (!accountId || !deviceId || req.headers.get("upgrade") !== "websocket") {
      return new Response("bad request", { status: 400 });
    }
    const bound = this.ctx.storage.kv.get<string>("account");
    if (bound && bound !== accountId) return new Response("forbidden", { status: 403 });
    if (!bound) this.ctx.storage.kv.put("account", accountId);
    rememberOrigin(this.ctx.storage, req);

    // One live connection per device. The recorder only reconnects after its old connection failed, so the old socket
    // is abandoned: marked replaced (never routed to again), not closed.
    for (const ws of this.ctx.getWebSockets(deviceId)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && !a.replaced) ws.serializeAttachment({ ...a, replaced: true } satisfies Attachment);
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [deviceId]);
    pair[1].serializeAttachment({ deviceId, accountId, connectedAt: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Notes that `deviceId` was last seen at `seconds` (unix). Synchronous (DO SQLite), so socket events never wait on
   * I/O; flushSeen moves it to devices.last_seen_at on the next request that reads it.
   */
  private noteSeen(deviceId: string, seconds: number): void {
    const key = `seen:${deviceId}`;
    if ((this.ctx.storage.kv.get<number>(key) ?? 0) < seconds) this.ctx.storage.kv.put(key, seconds);
  }

  /** Writes the sightings noteSeen recorded to devices.last_seen_at (never moving it back) and forgets them. */
  private async flushSeen(): Promise<void> {
    const seen = [...this.ctx.storage.kv.list<number>({ prefix: "seen:" })];
    if (!seen.length) return;
    await this.env.DB.batch(
      seen.map(([key, at]) =>
        this.env.DB.prepare("UPDATE devices SET last_seen_at = max(coalesce(last_seen_at, 0), ?) WHERE id = ?").bind(at, key.slice("seen:".length)),
      ),
    );
    for (const [key, at] of seen) if (this.ctx.storage.kv.get<number>(key) === at) this.ctx.storage.kv.delete(key);
  }

  /** heartbeatOf the socket. */
  private heartbeat(ws: WebSocket): number {
    return heartbeatOf(ws.deserializeAttachment() as Attachment, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null);
  }

  /** Sockets that are isLive and not replaced (all devices, or one). */
  private liveSockets(deviceId?: string): WebSocket[] {
    const at = Date.now();
    return this.ctx.getWebSockets(deviceId).filter((ws) => !(ws.deserializeAttachment() as Attachment).replaced && isLive(this.heartbeat(ws), at));
  }

  /**
   * Gives up on sockets that stopped pinging (the peer is gone but no close arrived: a sleeping Mac, a dropped network):
   * marks them stale (not closed, see Attachment.replaced) and notes their last heartbeat as the device's last sighting.
   * A recorder whose connection broke notices on its own next ping and reconnects. A stale socket that pings again is
   * live again.
   */
  private pruneStale(): void {
    const at = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      const seen = this.heartbeat(ws);
      if (isLive(seen, at)) {
        if (a.stale) ws.serializeAttachment({ ...a, stale: false } satisfies Attachment);
        continue;
      }
      if (a.stale || a.replaced) continue;
      ws.serializeAttachment({ ...a, stale: true } satisfies Attachment);
      log("info", "device heartbeat timeout", { idle_s: Math.round((at - seen) / 1000) });
      this.noteSeen(a.deviceId, Math.floor(seen / 1000));
    }
  }

  /** The live socket of `deviceId`, or (no id) of the most recently connected live device. */
  private socket(deviceId?: string): WebSocket | undefined {
    if (deviceId) return this.liveSockets(deviceId).at(-1);
    let best: WebSocket | undefined;
    let at = -1;
    for (const ws of this.liveSockets()) {
      const c = (ws.deserializeAttachment() as Attachment).connectedAt ?? 0;
      if (c >= at) [best, at] = [ws, c];
    }
    return best;
  }

  /** Any device connected (no id), or that one. */
  async isOnline(accountId: string, deviceId?: string): Promise<boolean> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return false;
    return !!this.socket(deviceId);
  }

  /** Ids of the connected devices (live heartbeat), most recently connected first. */
  async online(accountId: string): Promise<string[]> {
    return (await this.presence(accountId)).map((p) => p.id);
  }

  /**
   * The connected devices with a live heartbeat, most recently connected first, and when each was last heard from
   * (unix seconds). Sockets without a heartbeat in LIMITS.deviceHeartbeatTimeoutSeconds are given up on (pruneStale)
   * and left out. Also writes pending sightings (noteSeen) to devices.last_seen_at, so callers read it current.
   */
  async presence(accountId: string): Promise<{ id: string; seen: number }[]> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return [];
    this.pruneStale();
    await this.flushSeen();
    // Newest socket first on equal times, like socket().
    return this.liveSockets()
      .reverse()
      .map((ws) => ({ a: ws.deserializeAttachment() as Attachment, seen: Math.floor(this.heartbeat(ws) / 1000) }))
      .sort((x, y) => (y.a.connectedAt ?? 0) - (x.a.connectedAt ?? 0))
      .filter((x, i, all) => all.findIndex((o) => o.a.deviceId === x.a.deviceId) === i)
      .map((x) => ({ id: x.a.deviceId, seen: x.seen }));
  }

  /**
   * Closes a removed (or re-paired) device's socket and drops what it reported. The other devices stay connected. The
   * one deliberate close: a revoked recorder that is still connected must hear it (4001).
   */
  async disconnect(deviceId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(4001, "device revoked");
    this.ctx.storage.kv.delete(`devices:${deviceId}`);
    this.ctx.storage.kv.delete(`update:${deviceId}`);
    forgetAutoUpdate(this.ctx.storage, deviceId);
  }

  /** Version and features a connected recorder announced (empty for recorders older than 0.4). No id = most recent. */
  async recorderInfo(accountId: string, deviceId?: string): Promise<{ device_id: string; version: string | null; features: string[] } | null> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return null;
    const ws = this.socket(deviceId);
    if (!ws) return null;
    const a = ws.deserializeAttachment() as Attachment;
    return { device_id: a.deviceId, version: a.version ?? null, features: a.features ?? [] };
  }

  /**
   * Sends a signed command to one connected device (no id = the most recently connected one). Verifies the account
   * binding first. Fields the recorder did not announce support for are left out (see fitCommand) and listed in `dropped`.
   */
  async sendCommand(
    accountId: string,
    command: DeviceCommand,
    deviceId?: string,
  ): Promise<{ ok: true; device_id: string; dropped: RecorderFeature[] } | { ok: false }> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return { ok: false };
    const ws = this.socket(deviceId);
    if (!ws) return { ok: false };
    const a = ws.deserializeAttachment() as Attachment;
    if (a.accountId !== accountId) return { ok: false };
    const { cmd, dropped } = fitCommand(command, a.features ?? []);
    // send() throws on a socket that closed after socket() found it: the device is gone.
    if (!(await this.trySend(ws, a, cmd))) return { ok: false };
    return { ok: true, device_id: a.deviceId, dropped };
  }

  /**
   * The "ready" push: tells the device that made a recording that its link is ready. Only to that device, only when it
   * announced ready_push, and only over its current socket (no queueing: a reconnect never replays it).
   */
  async pushReady(accountId: string, deviceId: string, recordingId: string, url: string): Promise<{ ok: boolean; reason?: string }> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return { ok: false, reason: "account" };
    const ws = this.socket(deviceId);
    if (!ws) return { ok: false, reason: "offline" };
    const a = ws.deserializeAttachment() as Attachment;
    if (a.accountId !== accountId || a.deviceId !== deviceId) return { ok: false, reason: "device" };
    if (!(a.features ?? []).includes("ready_push")) return { ok: false, reason: "unsupported" };
    await this.signAndSend(ws, a, { type: "ready", recording_id: recordingId, url });
    return { ok: true };
  }

  /**
   * The signed "update" command: only to the paired device, only when it announced self_update, only over its current
   * socket. The recorder checks the version and the SHA-256 itself (and, "signed_update", the release manifest) and
   * answers with an update report. A recorder that announced signed_update gets nothing without a manifest
   * ("unsigned": it would refuse the update).
   */
  async pushUpdate(
    accountId: string,
    deviceId: string,
    u: UpdateCommand,
  ): Promise<{ ok: boolean; reason?: "account" | "offline" | "unsupported" | "unsigned" }> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return { ok: false, reason: "account" };
    const ws = this.socket(deviceId);
    if (!ws) return { ok: false, reason: "offline" };
    const a = ws.deserializeAttachment() as Attachment;
    if (a.accountId !== accountId) return { ok: false, reason: "account" };
    if (!(a.features ?? []).includes("self_update")) return { ok: false, reason: "unsupported" };
    if ((a.features ?? []).includes("signed_update") && !(u.manifest && u.manifest_sig)) return { ok: false, reason: "unsigned" };
    const { cmd } = fitCommand({ type: "update", recording_id: randomId(64), ...u }, a.features ?? []);
    if (!(await this.trySend(ws, a, cmd))) return { ok: false, reason: "offline" };
    return { ok: true };
  }

  /**
   * Sends the signed "uninstall" command (with `scope` when the recorder announced multi_account) to a connected device
   * and waits up to `timeoutMs` for its uninstall_ack. online:false = no socket (nothing sent); acked:false = sent but no
   * ack in time. accounts_remaining: from the ack (null without one, or from a recorder that does not report it).
   */
  async uninstall(
    accountId: string,
    deviceId: string,
    scope: UninstallScope,
    timeoutMs: number,
  ): Promise<{ online: boolean; acked: boolean; accounts_remaining: number | null }> {
    const none = { online: false, acked: false, accounts_remaining: null };
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return none;
    const ws = this.socket(deviceId);
    if (!ws) return none;
    const a = ws.deserializeAttachment() as Attachment;
    if (a.accountId !== accountId || a.deviceId !== deviceId) return none;
    const requestId = randomId(64);
    let acked = false;
    let remaining: number | null = null;
    const answered = new Promise<void>((resolve) =>
      this.waiters.set(`${deviceId}:${requestId}`, (ack) => {
        acked = true;
        remaining = ack?.accounts_remaining ?? null;
        resolve();
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.signAndSend(ws, a, fitCommand({ type: "uninstall", recording_id: requestId, scope }, a.features ?? []).cmd);
      await Promise.race([answered, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    } catch {
      // Socket gone mid-send: treat as no ack.
    } finally {
      clearTimeout(timer);
      this.waiters.delete(`${deviceId}:${requestId}`);
    }
    return { online: true, acked, accounts_remaining: remaining };
  }

  /** The last update report from one of this account's devices (null when it sent none). */
  async lastUpdate(accountId: string, deviceId: string): Promise<UpdateStatus | null> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return null;
    return (await this.ctx.storage.get<UpdateStatus>(`update:${deviceId}`)) ?? null;
  }

  /**
   * The device finished a recording (uploaded): an automatic update held while it was recording can go now. Called by
   * the upload handler; a failed recording is seen here directly (its "failed" event).
   */
  async recordingEnded(accountId: string, deviceId: string): Promise<void> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return;
    const ws = this.socket(deviceId);
    if (ws) await this.runAutoUpdate(ws.deserializeAttachment() as Attachment);
  }

  /** autoUpdate for a connected recorder that said hello (version and features known). */
  private async runAutoUpdate(a: Attachment): Promise<void> {
    if (!a.version || !a.features) return;
    await autoUpdate(
      this.env,
      this.ctx.storage,
      { accountId: a.accountId, deviceId: a.deviceId, version: a.version, features: a.features, connectedAt: a.connectedAt },
      (u) => this.pushUpdate(a.accountId, a.deviceId, u),
    );
  }

  /** The hub's last automatic update push to one of this account's devices (null when there was none). */
  async autoUpdate(accountId: string, deviceId: string): Promise<AutoUpdateStatus | null> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return null;
    return autoUpdateStatus(this.ctx.storage, deviceId);
  }

  /** signAndSend; false when the socket closed in the meantime (send() throws). */
  private async trySend(ws: WebSocket, a: Attachment, cmd: DeviceCommand): Promise<boolean> {
    try {
      await this.signAndSend(ws, a, cmd);
      return true;
    } catch (e) {
      if (ws.readyState === 1) throw e; // still open: a real failure (signing), not a disconnect
      return false;
    }
  }

  private async signAndSend(ws: WebSocket, a: Attachment, cmd: DeviceCommand): Promise<void> {
    const accountId = a.accountId;
    const prev = (await this.ctx.storage.get<number>("nonce")) ?? 0;
    const nonce = Math.max(prev + 1, Date.now());
    await this.ctx.storage.put("nonce", nonce);

    const frame = {
      type: cmd.type,
      recording_id: cmd.recording_id,
      max_seconds: cmd.max_seconds ?? 0,
      mic: cmd.mic ?? false,
      nonce,
      exp: now() + 60,
      account_id: accountId,
      device_id: a.deviceId,
      upload_token: cmd.upload_token ?? "",
      ...(cmd.webcam !== undefined && { webcam: cmd.webcam }),
      ...(cmd.camera !== undefined && { camera: cmd.camera }),
      ...(cmd.webcam_size !== undefined && { webcam_size: cmd.webcam_size }),
      ...(cmd.monitor !== undefined && { monitor: cmd.monitor }),
      ...(cmd.mic_device !== undefined && { mic_device: cmd.mic_device }),
      ...(cmd.window !== undefined && { window: cmd.window }),
      ...(cmd.system_audio !== undefined && { system_audio: cmd.system_audio }),
      ...(cmd.webcam_shape !== undefined && { webcam_shape: cmd.webcam_shape }),
      ...(cmd.url !== undefined && { url: cmd.url }),
      ...(cmd.upload_part_bytes !== undefined && { upload_part_bytes: cmd.upload_part_bytes }),
      ...(cmd.version !== undefined && { version: cmd.version }),
      ...(cmd.sha256 !== undefined && { sha256: cmd.sha256 }),
      ...(cmd.scope !== undefined && { scope: cmd.scope }),
    };
    const mac = await hmacHex(await deviceCommandKey(this.env, a.deviceId), canonicalCommand(frame));
    // Outside the HMAC (PROTOCOL.md 5): the release's Ed25519 signature covers the manifest, which the recorder checks.
    const unsigned = {
      ...(cmd.manifest !== undefined && { manifest: cmd.manifest }),
      ...(cmd.manifest_sig !== undefined && { manifest_sig: cmd.manifest_sig }),
    };
    ws.send(JSON.stringify({ ...frame, ...unsigned, mac }));
  }

  /**
   * One device's inventory (monitors, mics, cameras, windows). Uses its last report when it is recent
   * (LIMITS.deviceReportMaxAgeSeconds) unless `refresh`; otherwise asks the recorder with a signed "devices" command and
   * waits up to LIMITS.deviceReportTimeoutMs. When the device is offline, returns its last report.
   */
  async devices(accountId: string, deviceId: string, refresh = false): Promise<{ online: boolean; inventory: StoredInventory | null }> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return { online: false, inventory: null };
    const key = `devices:${deviceId}`;
    let stored = (await this.ctx.storage.get<StoredInventory>(key)) ?? null;
    if (!this.socket(deviceId)) return { online: false, inventory: stored };
    const fresh = stored && now() - stored.at <= LIMITS.deviceReportMaxAgeSeconds;
    if (refresh || !fresh) {
      const requestId = randomId(64);
      const answered = new Promise<void>((resolve) => this.waiters.set(requestId, () => resolve()));
      const sent = await this.sendCommand(accountId, { type: "devices", recording_id: requestId }, deviceId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (sent.ok) {
        await Promise.race([answered, new Promise<void>((r) => (timer = setTimeout(r, LIMITS.deviceReportTimeoutMs)))]);
      }
      clearTimeout(timer);
      this.waiters.delete(requestId);
      stored = (await this.ctx.storage.get<StoredInventory>(key)) ?? null;
    }
    return { online: true, inventory: stored };
  }

  /** Last stored inventory for a device id, without contacting the recorder (used to validate start_recording). */
  async lastDevices(accountId: string, deviceId: string): Promise<StoredInventory | null> {
    if ((await this.ctx.storage.get<string>("account")) !== accountId) return null;
    return (await this.ctx.storage.get<StoredInventory>(`devices:${deviceId}`)) ?? null;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 32768) return;
    let body: unknown;
    try {
      body = JSON.parse(message);
    } catch {
      return;
    }
    const a = { ...(ws.deserializeAttachment() as Attachment), messageAt: Date.now() };
    ws.serializeAttachment(a satisfies Attachment);
    if ((body as { type?: unknown })?.type === "hello") {
      const h = Hello.safeParse(body);
      if (!h.success) return;
      const hello = { ...a, version: h.data.version, features: h.data.features } satisfies Attachment;
      ws.serializeAttachment(hello);
      // After the event returns: the auto-update reads D1 and signs (socket events never await I/O).
      this.later("auto-update after hello failed", () => this.runAutoUpdate(hello));
      return;
    }
    if ((body as { type?: unknown })?.type === "update") {
      const u = UpdateReport.safeParse(body);
      if (!u.success) return;
      const { type: _t, ...report } = u.data;
      this.ctx.storage.kv.put(`update:${a.deviceId}`, { ...report, device_id: a.deviceId, at: now() } satisfies UpdateStatus);
      const again = autoUpdateReport(this.ctx.storage, a.deviceId, report, a.connectedAt);
      log("info", "recorder update report", { status: report.status, version: report.version });
      if (again) this.later("auto-update after report failed", () => this.runAutoUpdate(a));
      return;
    }
    if ((body as { type?: unknown })?.type === "uninstall_ack") {
      const u = UninstallAck.safeParse(body);
      if (!u.success) return;
      // Keyed by device too: only the device that got the command can ack it.
      const waiter = u.data.request_id === undefined ? undefined : this.waiters.get(`${a.deviceId}:${u.data.request_id}`);
      if (waiter) return waiter(u.data);
      // Unsolicited with nothing left: the install removed itself. Only this socket's own device row on this account
      // goes (scope all: its token then gets 410 "all"); no other row is touched.
      if (u.data.accounts_remaining === 0) {
        this.later("self-removal failed", async () => {
          await uninstallDevice(this.env, a.accountId, a.deviceId, "all");
          await this.disconnect(a.deviceId);
          log("info", "device removed itself");
        });
      }
      return;
    }
    if ((body as { type?: unknown })?.type === "devices") {
      const r = DevicesReport.safeParse(body);
      if (!r.success) {
        log("warn", "bad device inventory", { issues: r.error.issues.length });
        return;
      }
      const { monitors, mics, cameras, windows, request_id } = r.data;
      this.ctx.storage.kv.put(`devices:${a.deviceId}`, {
        device_id: a.deviceId,
        at: now(),
        monitors,
        mics,
        cameras,
        ...(windows && { windows }),
      } satisfies StoredInventory);
      this.waiters.get(request_id)?.();
      return;
    }
    const ev = DeviceEvent.safeParse(body);
    if (!ev.success || message.length > 2048) return;
    const parsed = ev.data;
    const from = parsed.status === "recording" ? ["starting"] : ["starting", "recording", "uploading"];
    // The status guard only moves a recording forward, so writes that land out of order cannot move it back.
    this.later("recording status update failed", async () => {
      await this.env.DB.prepare(
        `UPDATE recordings SET status = ?, error = ? WHERE id = ? AND account_id = ? AND device_id = ?
         AND status IN (${from.map(() => "?").join(",")})`,
      )
        .bind(parsed.status, parsed.error ?? null, parsed.recording_id, a.accountId, a.deviceId, ...from)
        .run();
      // The recording ended without an upload: the device is idle again.
      if (parsed.status === "failed") await this.runAutoUpdate(a);
    });
  }

  /** Runs `work` after the socket event returns (socket events never await I/O); a failure is logged as `what`. */
  private later(what: string, work: () => Promise<unknown>): void {
    this.ctx.waitUntil(work().catch((e) => log("warn", what, { err: String(e) })));
  }

  /** Whether this socket's close or error is a sighting: not replaced, and not stale unless it pinged again since. */
  private counts(ws: WebSocket, a: Attachment): boolean {
    return !a.replaced && (!a.stale || isLive(this.heartbeat(ws), Date.now()));
  }

  /** The device was last seen now (noteSeen: no awaited I/O; flushed to D1 by presence). */
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    log("info", "device disconnected", { code });
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a?.deviceId && this.counts(ws, a)) this.noteSeen(a.deviceId, now());
  }

  /** A socket that failed (no clean close follows): the device was last seen at its last heartbeat. */
  async webSocketError(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a?.deviceId || !this.counts(ws, a)) return;
    this.noteSeen(a.deviceId, Math.floor(this.heartbeat(ws) / 1000));
  }
}

export function deviceHub(env: Env, accountId: string): DurableObjectStub<DeviceHub> {
  return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(accountId));
}
