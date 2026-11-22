// Silent recorder auto-update: when a recorder that can update itself ("self_update") says hello with a version older
// than this server's latest for its platform, DeviceHub sends it the same signed update command update_recorder sends.
// Only while the device is idle: a recording of this account on it (starting, recording or uploading) holds the push
// until the recording has uploaded (DeviceHub.recordingEnded) or a later hello. One push per device and target version
// per window, none after maxFailures failed attempts at that version; state in the hub's storage under
// autoupdate:<device id>. update_recorder still pushes whenever it is called.
// Recorders that announce "signed_update" get a push only when the platform's release has a signed manifest, and their
// refusal of one (a release-manifest check, PROTOCOL.md 5.1) ends the pushes of that version at once.
import type { Env } from "./env";
import { publicBase, uploadGrace } from "./env";
import { compareVersions, type Platform } from "./installer";
import { hasRecorder, PLATFORM, updatable, updateCommand, type UpdateCommand } from "./recorder-update";
import { log, now } from "./util";

export const AUTO_UPDATE = {
  /** At most one push per device and version in this long (longer than the recorder's own 10-minute cooldown). */
  windowSeconds: 15 * 60,
  /** The recorder was recording: a later hello may try again after this long. */
  busyRetrySeconds: 2 * 60,
  /**
   * A deferred update (0.6.1+ "update_defer_rollback": the recorder holds it until its recording has uploaded) is not
   * pushed again while it waits, but at most this long: then one new push is allowed.
   */
  deferMaxSeconds: 6 * 3600,
  /**
   * The automatic push's download link works this long, so an update the recorder deferred can still be downloaded
   * after the recording. update_recorder's links keep LIMITS.pairingCodeSeconds.
   */
  linkSeconds: 3600,
  /** Failed attempts at one version after which that version is no longer pushed to the device. */
  maxFailures: 3,
};

/**
 * The last automatic push to a device. result: "sent" (no report yet), "installing" (the recorder started the
 * installer), "busy" (it was recording or already updating; not a failure), "waiting" (not sent: the device is recording;
 * sent once it is idle), "deferred" (the recorder holds it until its recording has uploaded; not a failure), "failed"
 * (its report said so, or it came back on the old version after "sent"/"installing"), "rolled_back" (the installer put
 * the previous version back: its report, or after "installing" a hello on the old version from a recorder that can't
 * report it, 0.6.0; a failure), "gave_up" (maxFailures reached, or the recorder refused the release manifest: no more pushes of `version`), "updated" (it said
 * hello on `version` or newer).
 */
export type AutoUpdateStatus = {
  version: string;
  at: number;
  result: "sent" | "installing" | "busy" | "waiting" | "deferred" | "failed" | "rolled_back" | "gave_up" | "updated";
  attempts: number;
  failures: number;
  /** Unix seconds before which no push of `version` is sent. */
  next_at: number;
  error?: string;
  /** When the recorder first reported the update deferred (cleared once it installs). */
  deferred_at?: number;
  /** connectedAt of the socket whose hello counted the last attempt as failed (its rolled_back report is not counted twice). */
  inferred_on?: number;
};

/** What the hub knows about a connected recorder: its hello, and when its socket opened. */
export type AutoUpdateDevice = { accountId: string; deviceId: string; version: string; features: readonly string[]; connectedAt?: number };

const KEY = (deviceId: string) => `autoupdate:${deviceId}`;
/** The device socket's request origin (index.ts deviceSocket), for links when PUBLIC_BASE_URL is not set. */
const ORIGIN_KEY = "origin";
/** Report errors that mean "not now" rather than "this update does not work" (recorder SelfUpdater). */
const RECORDING = "recording in progress";
const UPDATING = "an update is already in progress";
/** 0.6.1+: a deferred update whose link expired before the recording uploaded ("... (send the update again)"). */
const EXPIRED = "update link expired while deferred";
/** "signed_update" refusals with a fixed text (recorder UpdateTrust / SelfUpdater, PROTOCOL.md 5.1). */
const SIGNATURE_REFUSALS = [
  "update not signed (no release manifest)",
  "update signature malformed",
  "update signature invalid (not signed by a release key)",
  "update not newer than this recorder (downgrade refused)",
  "installer size does not match the release manifest",
  "installer sha256 does not match the release manifest",
];

/**
 * Whether an update report's error is the recorder refusing the release manifest (PROTOCOL.md 5.1). The same manifest is
 * refused the same way every time, so it is final for that version: no maxFailures retries.
 */
export function signatureRefusal(error: string | undefined): boolean {
  if (!error) return false;
  return SIGNATURE_REFUSALS.includes(error) || error.startsWith("update manifest ") || /^update needs \d{1,3}\.\d{1,3}\.\d{1,3} or newer installed first$/.test(error);
}

// State reads and writes use the synchronous storage.kv (same keys as storage.get/put), so DeviceHub's socket events
// can fold reports in without awaiting I/O; only autoUpdate itself (D1, signing) awaits, and the hub runs it in waitUntil.

/** Keeps the origin the recorders connect to (x-ar-origin from deviceSocket); written only when it changed. */
export function rememberOrigin(storage: DurableObjectStorage, req: Request): void {
  const origin = req.headers.get("x-ar-origin");
  if (origin && storage.kv.get<string>(ORIGIN_KEY) !== origin) storage.kv.put(ORIGIN_KEY, origin);
}

export function autoUpdateStatus(storage: DurableObjectStorage, deviceId: string): AutoUpdateStatus | null {
  return storage.kv.get<AutoUpdateStatus>(KEY(deviceId)) ?? null;
}

/**
 * Whether this account has a recording on the device that is not done uploading (and not stuck: past the point the
 * cleanup cron times it out). Recordings of other accounts on the same install are not visible here; the recorder
 * itself refuses (or, 0.6.1+, defers) an update during any recording.
 */
async function recording(env: Env, accountId: string, deviceId: string, t: number): Promise<boolean> {
  const rows = await env.DB.prepare(
    "SELECT max_seconds, created_at FROM recordings WHERE account_id = ? AND device_id = ? AND status IN ('starting','recording','uploading')",
  )
    .bind(accountId, deviceId)
    .all<{ max_seconds: number; created_at: number }>();
  return rows.results.some((r) => r.created_at + r.max_seconds + uploadGrace(r.max_seconds) >= t);
}

/**
 * Called on an accepted hello and when the device is idle again (a recording uploaded or failed). Pushes the latest
 * recorder for the device's platform with `push` (hub.pushUpdate) when the recorder announced self_update, reported a
 * version older than the latest, is not recording and the rate limit allows it.
 */
export async function autoUpdate(
  env: Env,
  storage: DurableObjectStorage,
  d: AutoUpdateDevice,
  push: (u: UpdateCommand) => Promise<{ ok: boolean; reason?: string }>,
): Promise<void> {
  const prev = autoUpdateStatus(storage, d.deviceId);
  if (prev && prev.result !== "updated" && compareVersions(d.version, prev.version) >= 0) {
    storage.kv.put(KEY(d.deviceId), { ...prev, result: "updated" } satisfies AutoUpdateStatus);
  }
  if (!d.features.includes("self_update")) return;
  // Cheap check first: newer than or equal to every platform's latest = nothing to do, no D1 read.
  const behind = (["windows", "macos"] as const).some((p) => hasRecorder(p) && compareVersions(d.version, PLATFORM[p].latest) < 0);
  if (!behind) return;
  const row = await env.DB.prepare("SELECT platform FROM devices WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
    .bind(d.deviceId, d.accountId)
    .first<{ platform: string | null }>();
  const platform: Platform | null = row?.platform === "windows" || row?.platform === "macos" ? row.platform : null;
  if (!platform || !hasRecorder(platform)) return;
  // A signed_update recorder refuses an update without a signed release manifest: nothing to send it.
  if (!updatable(platform, d.features)) return;
  const target = PLATFORM[platform].latest;
  if (compareVersions(d.version, target) >= 0) return;

  // Read again: the D1 read let other events run.
  const cur = autoUpdateStatus(storage, d.deviceId);
  const t = now();
  const s: AutoUpdateStatus =
    cur && cur.version === target ? { ...cur } : { version: target, at: 0, result: "sent", attempts: 0, failures: 0, next_at: 0 };
  if (s.result === "gave_up") return;
  // Pushed before and back on the old version without a failure report: that attempt failed (installer died, rollback).
  // After "installing" this counts at once on a connection opened since the push: the installer's rollback restarts the
  // old recorder within ~90 s, well inside the window, and 0.6.0 (no update_defer_rollback) can't report rolled_back,
  // so its hello is the only sign. Otherwise only once the window has passed.
  // Whole seconds (at is): the socket the push went out on may have opened in the same second.
  const reconnected = d.connectedAt !== undefined && Math.floor(d.connectedAt / 1000) > s.at;
  const inferred =
    s.attempts > 0 && (s.result === "sent" || s.result === "installing") && (t >= s.next_at || (s.result === "installing" && reconnected));
  if (inferred) {
    s.failures++;
    s.result = s.result === "installing" && !d.features.includes("update_defer_rollback") ? "rolled_back" : "failed";
    s.error = `still on ${d.version}`;
    s.inferred_on = d.connectedAt;
  }
  if (s.failures >= AUTO_UPDATE.maxFailures) {
    storage.kv.put(KEY(d.deviceId), { ...s, result: "gave_up" } satisfies AutoUpdateStatus);
    log("warn", "recorder auto-update gave up", { version: target, failures: s.failures });
    return;
  }
  // A deferred update waits for the recorder (its installing, failed or rolled_back report, or a hello on the new
  // version); next_at caps that wait at deferMaxSeconds. A failure counted above waits too: no resend in a tight loop.
  if (t < s.next_at) {
    if (inferred) storage.kv.put(KEY(d.deviceId), s);
    return;
  }
  // Idle only: a recording on the device holds the push (recordingEnded or a later hello sends it).
  if (await recording(env, d.accountId, d.deviceId, t)) {
    storage.kv.put(KEY(d.deviceId), { ...s, result: "waiting" } satisfies AutoUpdateStatus);
    log("info", "recorder auto-update waits for the recording", { from: d.version, version: target });
    return;
  }
  const origin = publicBase(env, storage.kv.get<string>(ORIGIN_KEY) ?? "");
  if (!origin) return log("warn", "recorder auto-update: no origin");
  const { error: _e, deferred_at: _d, ...rest } = s;
  // Claimed before sending, so a second hello right behind this one sends nothing.
  storage.kv.put(KEY(d.deviceId), { ...rest, at: t, result: "sent", attempts: s.attempts + 1, next_at: t + AUTO_UPDATE.windowSeconds } satisfies AutoUpdateStatus);
  const sent = await push(await updateCommand(env, origin, d.accountId, platform, AUTO_UPDATE.linkSeconds));
  log("info", "recorder auto-update", { from: d.version, version: target, sent: sent.ok, reason: sent.reason });
  // Not delivered (socket gone): not an attempt; the next hello may try again.
  if (!sent.ok) {
    if (cur) storage.kv.put(KEY(d.deviceId), cur);
    else storage.kv.delete(KEY(d.deviceId));
  }
}

/**
 * Folds the recorder's update report into the automatic push's status (only for the version that was pushed).
 * connectedAt: the reporting socket's. true = the device is idle and the update should be sent again now (a deferred
 * update whose link expired while it waited).
 */
export function autoUpdateReport(
  storage: DurableObjectStorage,
  deviceId: string,
  r: { status: "installing" | "failed" | "deferred" | "rolled_back"; version: string; error?: string },
  connectedAt?: number,
): boolean {
  const s = autoUpdateStatus(storage, deviceId);
  // A rollback can follow the new version's hello ("updated"): it still failed.
  if (!s || s.version !== r.version || s.result === "gave_up" || (s.result === "updated" && r.status !== "rolled_back")) return false;
  const t = now();
  const fail = (error: string): AutoUpdateStatus => {
    const failures = s.failures + 1;
    return { ...s, result: failures >= AUTO_UPDATE.maxFailures ? "gave_up" : r.status === "rolled_back" ? "rolled_back" : "failed", failures, error };
  };
  let next: AutoUpdateStatus;
  let retry = false;
  if (r.status === "installing") {
    // A deferred update may start hours after the push: give the install its window from now.
    const { deferred_at: _d, ...rest } = s;
    next = { ...rest, result: "installing", next_at: Math.max(s.next_at, t + AUTO_UPDATE.windowSeconds) };
  } else if (r.status === "deferred") {
    const since = s.result === "deferred" && s.deferred_at ? s.deferred_at : t;
    next = { ...s, result: "deferred", deferred_at: since, next_at: since + AUTO_UPDATE.deferMaxSeconds };
  } else if (r.status === "rolled_back") {
    // The hello on this same connection already counted this attempt as failed (back on the old version).
    if (connectedAt !== undefined && s.inferred_on === connectedAt) {
      if (s.result !== "failed") return false;
      next = { ...s, result: "rolled_back", error: "rolled back" };
    } else next = fail("rolled back");
  } else if (r.error === RECORDING) next = { ...s, result: "busy", error: r.error, next_at: Math.min(s.next_at, t + AUTO_UPDATE.busyRetrySeconds) };
  else if (r.error === UPDATING) next = { ...s, result: "busy", error: r.error };
  else if (r.error?.startsWith(EXPIRED)) {
    // Not the update's fault: the recorder is idle now (it was waiting for its upload), so send a fresh link.
    next = { ...s, result: "busy", error: r.error, next_at: t };
    retry = true;
  } else if (signatureRefusal(r.error)) {
    // Final for this version (the same manifest is refused every time); logged here once, later reports return above.
    next = { ...s, result: "gave_up", failures: s.failures + 1, error: r.error };
    log("warn", "recorder refused the signed update; not pushed again", { version: r.version, error: r.error });
  } else next = fail(r.error ?? "failed");
  storage.kv.put(KEY(deviceId), next);
  return retry;
}

/** Forgets a removed device's auto-update state. */
export function forgetAutoUpdate(storage: DurableObjectStorage, deviceId: string): void {
  storage.kv.delete(KEY(deviceId));
}
