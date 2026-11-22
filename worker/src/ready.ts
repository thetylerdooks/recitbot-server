// "Ready" push: once an upload is ready, the Worker sends the recorder that made it a signed frame with a link to the
// video, and the recorder opens it in the default browser (recorder config auto_open_link, start_recording open_link).
// The link is the owner link /v/<id>?ot=<token> (owner-link.ts): opening it makes that browser the owner of this one video
// and redirects to /<username>/v/<slug>, so the user can edit and moderate it without signing in on the web.
import { deviceHub } from "./device-hub";
import type { Env } from "./env";
import { LIMITS } from "./env";
import { ownerUrl } from "./owner-link";
import { recordingExpired, retentionHoldCol } from "./retention-hold";
import { log, now } from "./util";

/**
 * Only links to our own viewer on the public host are ever pushed: https on PUBLIC_BASE_URL's host (http only for a
 * loopback dev server), path /v/<id> for this recording (not /<username>/v/<slug>: shipped recorders only accept /v/<id>,
 * which redirects the owner), and a query of [A-Za-z0-9_=&.-] only (the owner token). The recorder applies the same
 * rule on its side (AgentRecorder.cs LinkPolicy).
 */
export function readyUrlAllowed(url: string, base: string, recordingId: string): boolean {
  let u: URL, b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    return false;
  }
  const loopback = b.hostname === "127.0.0.1" || b.hostname === "localhost";
  if (u.protocol !== "https:" && !(loopback && u.protocol === "http:")) return false;
  if (u.username || u.password || u.host !== b.host) return false;
  return u.pathname === `/v/${recordingId}` && !u.hash && /^(\?[A-Za-z0-9_=&.-]*)?$/.test(u.search);
}

type ReadyRow = {
  account_id: string;
  device_id: string;
  status: string;
  expires_at: number;
  retention_hold: number;
  open_link: number;
  ready_pushed_at: number | null;
  owner_version: number;
};

/** Sends the ready push at most once per recording. Returns why it did not when it did not (for logs and tests). */
export async function pushReady(env: Env, id: string, base: string): Promise<{ pushed: boolean; reason?: string }> {
  const rec = await env.DB.prepare(
    `SELECT account_id, device_id, status, expires_at, ${retentionHoldCol()}, open_link, ready_pushed_at, owner_version FROM recordings WHERE id = ?`,
  )
    .bind(id)
    .first<ReadyRow>();
  if (!rec) return { pushed: false, reason: "missing" };
  if (rec.status !== "ready" || recordingExpired(rec, now())) return { pushed: false, reason: "not ready" };
  if (!rec.open_link) return { pushed: false, reason: "open_link off" };
  // Claim first: whatever happens next, this recording is never pushed again (no retry, no replay on reconnect).
  const claim = await env.DB.prepare("UPDATE recordings SET ready_pushed_at = ? WHERE id = ? AND ready_pushed_at IS NULL").bind(now(), id).run();
  if (!claim.meta.changes) return { pushed: false, reason: "already pushed" };
  // The /v/<id> path (installed recorders open nothing else), with the owner token.
  const link = await ownerUrl(env, `${base}/v/${id}`, { id, account_id: rec.account_id, owner_version: rec.owner_version });
  if (!readyUrlAllowed(link, base, id)) return { pushed: false, reason: "url not allowed" };
  const r = await deviceHub(env, rec.account_id).pushReady(rec.account_id, rec.device_id, id, link);
  return r.ok ? { pushed: true } : { pushed: false, reason: r.reason };
}

/** Ready to watch, transcript still coming. */
const markPending = (env: Env, id: string) =>
  env.DB.prepare("UPDATE recordings SET status = 'ready', transcript_status = 'pending' WHERE id = ? AND status = 'transcribing'").bind(id).run();

async function push(env: Env, id: string, base: string): Promise<void> {
  try {
    const r = await pushReady(env, id, base);
    log("info", "ready push", { id, ...r });
  } catch (e) {
    log("error", "ready push failed", { id, err: String(e) });
  }
}

/**
 * Workers Free (config.ts readyBeforeTranscript): the video is ready, with its transcript pending, and the recorder is
 * told before transcription starts. Transcribing may take more CPU time than a Free invocation has: then only the
 * transcript is missing, and the hourly cleanup marks it unavailable.
 */
export async function readyThenTranscribe(env: Env, id: string, base: string, transcribe: () => Promise<void>): Promise<void> {
  await markPending(env, id);
  await push(env, id, base);
  await transcribe();
}

/**
 * After an upload completes: transcribe, mark ready, push. The push waits for the transcript only up to `waitMs`
 * (LIMITS.readyPushWaitMs); a slow transcription marks the video ready with transcript_status "pending" and finishes later.
 */
export async function finishRecording(
  env: Env,
  id: string,
  base: string,
  transcribing: Promise<void>,
  waitMs: number = LIMITS.readyPushWaitMs,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quick = await Promise.race([
    transcribing.then(() => true),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(false), waitMs))),
  ]);
  clearTimeout(timer);
  if (!quick) await markPending(env, id);
  await push(env, id, base);
  await transcribing;
}
