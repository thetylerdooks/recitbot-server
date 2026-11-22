// Takedown state of recordings and accounts, read from the admin_actions evidence log (migration 0031): the log is the
// state, so there is nothing to drift. Read-only and import-light on purpose (share.ts, custom-host.ts and mcp.ts use it;
// the actions themselves are in takedown.ts).
//
//   removed (a recording): an open (not reversed) takedown targets it or its account. Its page answers 451 "removed for
//     a policy violation", its media, download, file link, comments and sharing are refused.
//   suspended (an account): an open takedown targets it. It can't start recordings, share, set a custom domain or
//     branding, or pair or update recorders, and all its videos are removed (above). Its brand images (/b/<hash>,
//     custom-host /favicon.ico) answer 404, and an upload that finishes now isn't transcribed.
//   held (a recording): removed, or ever taken down for csam (itself or its account), even after a restore. Its files and
//     row are never deleted: not by the owner, not by expiry cleanup, not by deleteRecordings.
import type { Env } from "./env";

/**
 * admin_actions rows (alias x) that are takedowns of the recording `rec` or of the account `acct` (SQL expressions).
 * These helpers interpolate their arguments into SQL: callers pass identifiers only (column names like "r.id", or "?"
 * with the value bound), never a user value.
 */
const takedownOf = (rec: string, acct: string) =>
  `x.action = 'takedown' AND ((x.target_type = 'recording' AND x.target_id = ${rec}) OR (x.target_type = 'account' AND x.target_id = ${acct}))`;

/** SQL: the recording (id expression `rec`, account id expression `acct`) is removed. */
export const removedSql = (rec: string, acct: string) => `EXISTS (SELECT 1 FROM admin_actions x WHERE ${takedownOf(rec, acct)} AND x.reversed_at IS NULL)`;

/** SQL: the recording is held (never deleted). */
export const heldSql = (rec: string, acct: string) =>
  `EXISTS (SELECT 1 FROM admin_actions x WHERE ${takedownOf(rec, acct)} AND (x.reversed_at IS NULL OR x.reason_code = 'csam'))`;

/** SQL: the account (id expression `acct`: a column name or "?", never a value) is suspended. */
export const suspendedSql = (acct: string) =>
  `EXISTS (SELECT 1 FROM admin_actions x WHERE x.action = 'takedown' AND x.target_type = 'account' AND x.target_id = ${acct} AND x.reversed_at IS NULL)`;

export async function recordingRemoved(env: Env, id: string, accountId: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT ${removedSql("?", "?")} AS r`).bind(id, accountId).first<{ r: number }>())?.r;
}

export async function accountSuspended(env: Env, accountId: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT ${suspendedSql("?")} AS r`).bind(accountId).first<{ r: number }>())?.r;
}

/** Why this account may not share this recording now (shareTool, the page's Share button), or null. */
export async function sharingBlocked(env: Env, id: string, accountId: string): Promise<"ACCOUNT_SUSPENDED" | "RECORDING_REMOVED" | null> {
  if (await accountSuspended(env, accountId)) return "ACCOUNT_SUSPENDED";
  return (await recordingRemoved(env, id, accountId)) ? "RECORDING_REMOVED" : null;
}

/** Which of these recordings are held (see above). Unknown ids are not. */
export async function heldRecordingIds(env: Env, ids: string[]): Promise<Set<string>> {
  const held = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT r.id FROM recordings r WHERE r.id IN (${part.map(() => "?").join(",")}) AND ${heldSql("r.id", "r.account_id")}`,
    )
      .bind(...part)
      .all<{ id: string }>();
    for (const r of rows.results) held.add(r.id);
  }
  return held;
}

export const SUSPENDED_MESSAGE = "This account is suspended for a policy violation: recording and sharing are off.";
export const REMOVED_MESSAGE = "This recording was removed for a policy violation.";
