// Governor: single global Durable Object that enforces every cost guardrail and rate limit.
// Callers must treat any error reaching it as "refuse" (fail closed).
import { DurableObject } from "cloudflare:workers";
import { LIMITS, type Tier } from "./env";

export type StartDecision =
  | { ok: true }
  | { ok: false; code: "CAP_REACHED" | "DEVICE_NOT_PAIRED"; reason: string; resets_at?: number };

const DAY = 86400;
/** Unix seconds as "2026-01-02 00:00 UTC". */
const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export class Governor extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS starts (account_id TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS starts_acct ON starts(account_id, ts);
      CREATE TABLE IF NOT EXISTS daily (k TEXT NOT NULL, day INTEGER NOT NULL, n REAL NOT NULL, PRIMARY KEY (k, day));
      CREATE TABLE IF NOT EXISTS rl (k TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (k, win));
    `);
  }

  private daily(k: string, day: number): number {
    const row = this.sql.exec<{ n: number }>("SELECT n FROM daily WHERE k = ? AND day = ?", k, day).toArray()[0];
    return row?.n ?? 0;
  }

  private addDaily(k: string, day: number, by: number): void {
    this.sql.exec(
      "INSERT INTO daily (k, day, n) VALUES (?, ?, ?) ON CONFLICT (k, day) DO UPDATE SET n = n + excluded.n",
      k,
      day,
      by,
    );
  }

  /** Fixed-window counter. `consume=false` only checks. `cost` hits at once, all or none. */
  hit(key: string, limit: number, windowSec: number, now: number, consume = true, cost = 1): { ok: boolean; retry_after: number } {
    const win = Math.floor(now / windowSec);
    const row = this.sql.exec<{ n: number }>("SELECT n FROM rl WHERE k = ? AND win = ?", key, win).toArray()[0];
    const n = row?.n ?? 0;
    const retry_after = (win + 1) * windowSec - now;
    if (n + cost > limit) return { ok: false, retry_after };
    if (consume) {
      this.sql.exec(
        "INSERT INTO rl (k, win, n, exp) VALUES (?, ?, ?, ?) ON CONFLICT (k, win) DO UPDATE SET n = n + excluded.n",
        key,
        win,
        cost,
        (win + 1) * windowSec,
      );
    }
    return { ok: true, retry_after: 0 };
  }

  /**
   * Reserves one start: a `starts` row at (accountId, now) plus one global:videos for that day (and one
   * global:videos:free for a Free start). A caller whose start then fails must hand it back with
   * releaseStart(accountId, now, tier). Caps: the account's starts that UTC day (its `starts` rows, so a release hands
   * the slot back; null = none: Free's limit is its lifetime count, kept in D1 by the caller), then the global daily
   * ceiling, of which Free starts may use only LIMITS.freeShareOfGlobalVideos (the rest is kept for paid and owner
   * starts). Accounts have no per-hour, per-30-day or live-video limit.
   */
  checkStart(a: { accountId: string; paired: boolean; accountMaxPerDay: number | null; tier: Tier; globalMaxPerDay: number; now: number }): StartDecision {
    if (!a.paired) {
      return { ok: false, code: "DEVICE_NOT_PAIRED", reason: "Account has 0 recordings until a device is paired. Call get_installer." };
    }
    const day = Math.floor(a.now / DAY);
    if (a.accountMaxPerDay !== null) {
      const mine = this.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM starts WHERE account_id = ? AND ts >= ? AND ts < ?", a.accountId, day * DAY, (day + 1) * DAY)
        .one().n;
      if (mine >= a.accountMaxPerDay) {
        const resets_at = (day + 1) * DAY;
        return { ok: false, code: "CAP_REACHED", reason: `Daily recording limit reached (${a.accountMaxPerDay} per day). Try again after ${utc(resets_at)}.`, resets_at };
      }
    }
    const free = a.tier === "free";
    if (
      this.daily("global:videos", day) >= a.globalMaxPerDay ||
      (free && this.daily("global:videos:free", day) >= Math.floor(a.globalMaxPerDay * LIMITS.freeShareOfGlobalVideos))
    ) {
      return { ok: false, code: "CAP_REACHED", reason: "Global daily recording ceiling reached.", resets_at: (day + 1) * DAY };
    }
    this.sql.exec("INSERT INTO starts (account_id, ts) VALUES (?, ?)", a.accountId, a.now);
    this.addDaily("global:videos", day, 1);
    if (free) this.addDaily("global:videos:free", day, 1);
    return { ok: true };
  }

  /**
   * Hands back one reservation from checkStart: deletes ONE starts row for (accountId, ts) and takes one off that day's
   * global:videos (and global:videos:free for a Free start; never below 0). Returns false (and changes nothing) when
   * there is no such row, so a double release is a no-op.
   */
  releaseStart(accountId: string, ts: number, tier: Tier): boolean {
    const deleted = this.sql
      .exec("DELETE FROM starts WHERE rowid = (SELECT rowid FROM starts WHERE account_id = ? AND ts = ? LIMIT 1)", accountId, ts)
      .rowsWritten;
    if (!deleted) return false;
    const keys = tier === "free" ? ["global:videos", "global:videos:free"] : ["global:videos"];
    for (const k of keys) this.sql.exec("UPDATE daily SET n = MAX(n - 1, 0) WHERE k = ? AND day = ?", k, Math.floor(ts / DAY));
    return true;
  }

  /**
   * Reserves transcription minutes against the account's daily cap (null = none, owners) and the global daily budget:
   * both or neither. "account" = the account's cap refused it, "global" = the global budget did.
   */
  checkTranscribe(a: { accountId: string; minutes: number; accountMaxPerDay: number | null; globalMaxPerDay: number; now: number }):
    | { ok: true }
    | { ok: false; refused: "account" | "global" } {
    const day = Math.floor(a.now / DAY);
    const k = `transcribe_min:${a.accountId}`;
    if (a.accountMaxPerDay !== null && this.daily(k, day) + a.minutes > a.accountMaxPerDay) return { ok: false, refused: "account" };
    if (this.daily("global:transcribe_min", day) + a.minutes > a.globalMaxPerDay) return { ok: false, refused: "global" };
    this.addDaily(k, day, a.minutes);
    this.addDaily("global:transcribe_min", day, a.minutes);
    return { ok: true };
  }

  /**
   * One page load of a video by one viewer (viewerHash: a salted hash of the IP, never the IP). Both counters are checked
   * before either is counted, so a refused load uses up neither budget.
   */
  checkView(
    recordingId: string,
    viewerHash: string,
    now: number,
    perViewer: number = LIMITS.viewsPerViewerPerVideoPerDay,
    perVideo: number = LIMITS.viewsPerVideoPerDay,
  ): "ok" | "viewer" | "video" {
    const day = Math.floor(now / DAY);
    const k = `views:${recordingId}`;
    const kv = `${k}:${viewerHash}`;
    if (this.daily(kv, day) >= perViewer) return "viewer";
    if (this.daily(k, day) >= perVideo) return "video";
    this.addDaily(kv, day, 1);
    this.addDaily(k, day, 1);
    return "ok";
  }

  /** Reachability + size gate before accepting upload bytes. */
  checkUpload(bytes: number, maxBytes: number): boolean {
    return bytes > 0 && bytes <= maxBytes;
  }

  prune(now: number): void {
    this.sql.exec("DELETE FROM starts WHERE ts < ?", now - 2 * DAY);
    this.sql.exec("DELETE FROM daily WHERE day < ?", Math.floor(now / DAY) - 2);
    this.sql.exec("DELETE FROM rl WHERE exp < ?", now);
  }
}

export function governor(env: { GOVERNOR: DurableObjectNamespace<Governor> }): DurableObjectStub<Governor> {
  return env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
}
