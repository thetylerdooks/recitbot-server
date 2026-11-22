// Operator-only MCP tool for the per-account retention hold (mcp.ts `ownerOnly`: OWNER_ACCOUNT_IDS only; to anyone else
// it doesn't exist): admin_retention_hold sets or clears accounts.retention_hold (retention-hold.ts). It writes that one
// column only: no plan, expires_at or Stripe change, and nothing is deleted here. Like admin-takedown-tools.ts, import
// this module through mcp.ts only (it imports mcp.ts back).
import { z } from "zod";
import { lookupAccount } from "./admin-tools";
import { NOTE_MAX } from "./domain-takedown";
import { tool } from "./mcp";
import { billingConfigured } from "./stripe";
import { heldSql } from "./takedown-state";
import { log, now } from "./util";

export const ADMIN_RETENTION_TOOLS = {
  admin_retention_hold: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Operator only. Set (hold: true) or clear (hold: false) one account's retention hold, by account_id or username " +
      "(exactly one). Set: pauses the Free auto-delete and 7-day expiry for that account until cleared; all its videos " +
      "not deleted yet stay watchable, listed and shareable, and expired ones open again. Clear: each video's stored " +
      "expires_at applies again, so videos past it stop playing at once and the next hourly cleanup deletes them for good " +
      "(recordings_past_expiry counts them; tell the operator before clearing). Changes nothing else (plan, expires_at, " +
      "billing). already: true = it was in that state. admin_lookup shows retention_hold. note goes to the server log only.",
    input: z
      .object({
        account_id: z.string().regex(/^[A-Za-z0-9]{10,40}$/, "invalid account_id").optional(),
        username: z.string().trim().min(1).max(64).optional().describe("The <username> in video URLs."),
        hold: z.boolean().describe("true = pause auto-delete and expiry, false = resume them."),
        note: z.string().trim().max(NOTE_MAX).optional().describe("Why, for the server log. Never shown to users or viewers."),
      })
      .refine((a) => (a.account_id === undefined) !== (a.username === undefined), "Pass exactly one of account_id, username."),
    async run(a, c) {
      const acct = await lookupAccount(c.env, { account_id: a.account_id, username: a.username });
      const hold = a.hold ? 1 : 0;
      const set = await c.env.DB.prepare("UPDATE accounts SET retention_hold = ? WHERE id = ? AND retention_hold <> ?").bind(hold, acct.id, hold).run();
      const already = set.meta.changes === 0;
      // What the stored expiry covers, hold or not (takedown-held ones are never deleted).
      const past = await c.env.DB.prepare(
        `SELECT count(*) AS n FROM recordings r WHERE r.account_id = ? AND r.expires_at < ? AND NOT ${heldSql("r.id", "r.account_id")}`,
      )
        .bind(acct.id, now())
        .first<{ n: number }>();
      const n = past?.n ?? 0;
      log("warn", "admin: retention hold", { by: c.principal!.accountId, account_id: acct.id, hold: a.hold, already, note: a.note || null });
      return {
        account_id: acct.id,
        username: acct.username,
        retention_hold: a.hold,
        already,
        recordings_past_expiry: n,
        message:
          `The retention hold ${already ? "was already" : "is now"} ${a.hold ? "on" : "off"} for this account. ` +
          (a.hold
            ? `${billingConfigured(c.env) ? "Free auto-delete" : "Auto-delete"} and the 7-day expiry are paused until it is cleared. `
            : "Each video's stored expires_at applies. ") +
          `${n} video${n === 1 ? " is" : "s are"} past expires_at${a.hold ? " and kept" : ""}.`,
      };
    },
  }),
};
