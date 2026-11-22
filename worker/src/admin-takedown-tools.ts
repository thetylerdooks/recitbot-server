// Operator-only MCP tools for takedowns of a recording, an account or a custom hostname (mcp.ts `ownerOnly`:
// OWNER_ACCOUNT_IDS only; to anyone else they don't exist): admin_takedown, admin_restore, admin_actions. The logic and
// the append-only evidence log (admin_actions, migration 0031) are in takedown.ts; hostnames go through
// domain-takedown.ts. Nothing here deletes media: purging a hostname stays admin_purge_custom_domain. Like
// admin-domain-tools.ts, import this module through mcp.ts only (it imports mcp.ts back).
import { z } from "zod";
import { takedownCall } from "./admin-domain-tools";
import { NOTE_MAX, REASON_CODES } from "./domain-takedown";
import { tool } from "./mcp";
import { type AdminAction, listActions, restore, takedown } from "./takedown";
import { log } from "./util";

const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());

/** An admin_actions row as the tools show it: times in ISO 8601, before_state parsed. */
export function actionView(r: AdminAction) {
  return {
    action_id: r.id,
    action: r.action,
    target_type: r.target_type,
    target: r.target_id,
    account_id: r.account_id,
    reason_code: r.reason_code,
    note: r.note,
    before_state: JSON.parse(r.before_state) as unknown,
    by: r.actor_account_id,
    at: iso(r.created_at),
    ...(r.action === "takedown" ? { reversed_at: iso(r.reversed_at), reversed_by: r.reversed_by } : { restores: r.restores }),
    ...(r.domain_action_id && { domain_action_id: r.domain_action_id }),
  };
}

const noteArg = z.string().max(NOTE_MAX).optional().describe("Operator note for the evidence log. Never shown to users or viewers.");

const EFFECT = {
  recording: "The video's page answers 451 \"removed for a policy violation\"; its media, download, file link and comments are refused and it can't be shared or deleted.",
  account: "The account is suspended: it can't start recordings or share, and every video of it answers the 451 removal page.",
  hostname: "The custom hostname answers a neutral 451 on every path (disableDomain).",
} as const;

export const ADMIN_TAKEDOWN_TOOLS = {
  admin_takedown: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Operator only. Take down a recording (id), an account (id, = suspend) or a custom hostname. reason_code is required: " +
      "csam, phishing, malware, impersonation or other. Recording: its page answers 451 \"removed for a policy violation\", " +
      "media/download/comments refused, can't be shared or deleted. Account: suspended (can't record or share; all its " +
      "videos removed). Hostname: disabled (neutral 451). Takes effect at once (hostnames: ~30 s on other servers). " +
      "Nothing is deleted; every takedown is logged with a before-state snapshot and reversible with admin_restore " +
      "{action_id}. csam also holds the files for good (never deleted, even after a restore). note goes to the log only.",
    input: z.object({
      target: z.string().trim().min(1).max(300).describe("A recording id, an account id, or a custom hostname (a pasted URL is fine)."),
      reason_code: z.enum(REASON_CODES).describe("Required: csam | phishing | malware | impersonation | other"),
      note: noteArg,
      mode: z.literal("disable").default("disable").describe("Only 'disable' (reversible). Purging a hostname is admin_purge_custom_domain."),
    }),
    async run(a, c) {
      return takedownCall(async () => {
        const r = await takedown(c.env, { target: a.target, reason: a.reason_code, note: a.note, actor: c.principal!.accountId });
        return {
          action: actionView(r.action),
          already: r.already,
          message:
            `Took down ${r.action.target_type} ${r.action.target_id} (${r.action.reason_code}). ${EFFECT[r.action.target_type]} ` +
            (r.already ? "It was already taken down; this is logged as another action. " : "") +
            `Undo with admin_restore {action_id: "${r.action.id}"}.`,
        };
      });
    },
  }),

  admin_restore: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Operator only. Reverse exactly one admin_takedown (action_id from its result or admin_actions). The takedown is " +
      "marked reversed (who, when) and a restore row is logged; the target comes back unless another open takedown still " +
      "covers it (effect says). A hostname is enabled again only if it wasn't disabled before that takedown (other than by " +
      "another takedown) and wasn't disabled or purged again (admin_disable_custom_domain, admin_purge_custom_domain) after it. csam " +
      "takedowns need confirm: true, and their files stay held (never deleted).",
    input: z.object({
      action_id: z.string().regex(/^[A-Za-z0-9]{10,40}$/, "invalid action_id").describe("The takedown's action_id."),
      confirm: z.boolean().optional().describe("Required (true) to restore a csam takedown."),
      note: noteArg,
    }),
    async run(a, c) {
      return takedownCall(async () => {
        const r = await restore(c.env, { action_id: a.action_id, actor: c.principal!.accountId, note: a.note, confirm: a.confirm });
        return {
          action: actionView(r.action),
          restore_action: actionView(r.restore_action),
          effect: r.effect,
          message: `Restored ${r.action.target_type} ${r.action.target_id} (takedown ${r.action.id}).`,
        };
      });
    },
  }),

  admin_actions: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Operator only, read-only. The append-only takedown evidence log, newest first: takedowns and restores of recordings, " +
      "accounts and custom hostnames, with who (operator account id), when, target, reason_code, note, the before-state " +
      "snapshot and, for takedowns, reversed_by / reversed_at (null = still in force). target: only rows for that " +
      "recording id, account id (also its recordings and hostnames) or hostname.",
    input: z.object({
      target: z.string().trim().min(1).max(300).optional().describe("A recording id, account id or custom hostname."),
      limit: z.number().int().min(1).max(500).optional().describe("At most this many (default 100)."),
    }),
    async run(a, c) {
      const rows = await listActions(c.env, a);
      log("warn", "admin: takedown actions listed", { by: c.principal!.accountId, target: a.target ?? "all", count: rows.length });
      return {
        actions: rows.map(actionView),
        count: rows.length,
        open_takedowns: rows.filter((r) => r.action === "takedown" && r.reversed_at === null).length,
        message: rows.length ? `${rows.length} action${rows.length === 1 ? "" : "s"}.` : "No actions logged.",
      };
    },
  }),
};
