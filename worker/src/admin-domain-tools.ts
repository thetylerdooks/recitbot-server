// Operator-only MCP tools for custom-domain abuse (mcp.ts `ownerOnly`: OWNER_ACCOUNT_IDS only; to anyone else they don't
// exist): admin_disable_custom_domain, admin_enable_custom_domain, admin_purge_custom_domain, admin_list_custom_domains,
// admin_domain_actions. The logic and the action log are in domain-takedown.ts. Runbook: docs/operations.md "Custom domains: abuse
// runbook". Like domain-tools.ts, import this module through mcp.ts only (it imports mcp.ts back).
//
// Disable / enable only flip disabled_at in D1 (the Cloudflare hostname is kept), so the owner can always undo a
// takedown with no customer action. Purge is the one irreversible step.
import { z } from "zod";
import { type CustomDomainRow, DomainError } from "./custom-domains";
import { disableDomain, enableDomain, hostKey, listDomainActions, NOTE_MAX, purgeDomain, REASON_CODES } from "./domain-takedown";
import type { Env } from "./env";
import { ToolError, tool } from "./mcp";
import { log } from "./util";

const STATUSES = ["pending", "active", "redirecting", "failed", "disabled"] as const;

const isoTime = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 19) + "Z" : null);

function adminView(r: CustomDomainRow) {
  return {
    hostname: r.hostname,
    account_id: r.account_id,
    status: r.status,
    disabled: r.disabled_at !== null,
    disabled_at: isoTime(r.disabled_at),
    reason: r.disabled_reason,
    on_cloudflare: r.cf_id !== null,
    redirect_to: r.redirect_to,
    redirect_until: isoTime(r.redirect_until),
    live_since: isoTime(r.live_at),
    created_at: isoTime(r.created_at),
  };
}

export async function takedownCall(f: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof DomainError) throw new ToolError(e.code, e.message, e.extra);
    throw e;
  }
}

/** Open (not reversed) admin_takedown rows of this hostname (takedown.ts), oldest first. */
async function openHostTakedowns(env: Env, hostname: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM admin_actions WHERE action = 'takedown' AND target_type = 'hostname' AND target_id = ? AND reversed_at IS NULL ORDER BY created_at, rowid",
  )
    .bind(hostKey(hostname))
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

/** The account's other custom hostnames that aren't disabled yet (suspend_account). */
async function otherLiveHosts(env: Env, accountId: string, except: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT hostname FROM custom_domains WHERE account_id = ? AND hostname != ? AND disabled_at IS NULL ORDER BY hostname")
    .bind(accountId, except)
    .all<{ hostname: string }>();
  return rows.results.map((r) => r.hostname);
}

async function adminList(env: Env, adminId: string, a: { status?: (typeof STATUSES)[number]; limit?: number }): Promise<Record<string, unknown>> {
  const limit = a.limit ?? 50;
  const where = !a.status ? "" : a.status === "disabled" ? "WHERE disabled_at IS NOT NULL" : "WHERE status = ?";
  const stmt = env.DB.prepare(`SELECT * FROM custom_domains ${where} ORDER BY created_at DESC, hostname LIMIT ?`);
  const rows = (await (a.status && a.status !== "disabled" ? stmt.bind(a.status, limit) : stmt.bind(limit)).all<CustomDomainRow>()).results;
  log("warn", "admin: custom domains listed", { by: adminId, status: a.status ?? "all", count: rows.length });
  return {
    domains: rows.map(adminView),
    count: rows.length,
    message: rows.length ? `${rows.length} custom domain${rows.length === 1 ? "" : "s"}${rows.length === limit ? " (more may exist: raise limit)" : ""}.` : "No custom domains match.",
  };
}

const hostnameArg = z.string().trim().min(1).max(300).describe("The custom hostname, e.g. videos.example.com (a pasted URL is fine).");
const noteArg = z.string().max(NOTE_MAX).optional().describe("Operator note for the action log. Never shown to visitors.");

export const ADMIN_DOMAIN_TOOLS = {
  admin_disable_custom_domain: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Operator only. Take a customer's custom video domain down: every path on it answers a neutral 451 \"unavailable\" " +
      "page at once (up to ~30 s on other servers), and the account can't set or remove a custom domain meanwhile. " +
      "Reversible: admin_enable_custom_domain brings it back exactly as it was (the Cloudflare hostname is kept). " +
      "reason: csam, phishing, malware, impersonation or other; note goes to the action log only. suspend_account also " +
      "disables the account's other custom hostnames (each reversible the same way). Works while the service is paused.",
    input: z.object({
      hostname: hostnameArg,
      reason: z.enum(REASON_CODES).describe("csam | phishing | malware | impersonation | other"),
      note: noteArg,
      suspend_account: z.boolean().optional().describe("Also disable every other custom hostname of the account."),
    }),
    async run(a, c) {
      return takedownCall(async () => {
        const actor = c.principal!.accountId;
        const r = await disableDomain(c.env, { hostname: a.hostname, reason: a.reason, note: a.note, actor });
        const also: string[] = [];
        if (a.suspend_account) {
          for (const h of await otherLiveHosts(c.env, r.domain.account_id, r.domain.hostname)) {
            await disableDomain(c.env, { hostname: h, reason: a.reason, note: a.note, actor });
            also.push(h);
          }
        }
        return {
          domain: adminView(r.domain),
          already: r.already,
          also_disabled: also,
          action_id: r.action_id,
          message:
            `Disabled ${r.domain.hostname} (${a.reason}): it answers 451 now here and within about 30 seconds everywhere. ` +
            (also.length ? `Also disabled: ${also.join(", ")}. ` : "") +
            "Undo with admin_enable_custom_domain; nothing was deleted.",
        };
      });
    },
  }),

  admin_enable_custom_domain: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Operator only. Undo admin_disable_custom_domain: the domain serves again exactly as before (an active one at once, " +
      "up to ~30 s on other servers). No customer action needed. A purged domain stays down (the customer must set it up again). " +
      "While an admin_takedown of the hostname is open it refuses with OPEN_TAKEDOWN (action_ids listed): reverse those " +
      "with admin_restore instead, or pass force: true to enable it anyway (the takedowns stay open in the log).",
    input: z.object({
      hostname: hostnameArg,
      note: noteArg,
      force: z.boolean().optional().describe("Enable even while an admin_takedown of this hostname is open."),
    }),
    async run(a, c) {
      return takedownCall(async () => {
        const open = await openHostTakedowns(c.env, a.hostname);
        if (open.length && a.force !== true) {
          throw new ToolError(
            "OPEN_TAKEDOWN",
            `${hostKey(a.hostname)} is taken down by admin_takedown ${open.join(", ")}. Reverse it with admin_restore {action_id}, ` +
              "or call this again with force: true to enable it anyway (the takedown stays open in the log).",
            { action_ids: open },
          );
        }
        if (open.length) log("warn", "admin: custom domain enabled over open takedowns", { by: c.principal!.accountId, hostname: hostKey(a.hostname), action_ids: open });
        const r = await enableDomain(c.env, { hostname: a.hostname, note: a.note, actor: c.principal!.accountId });
        const purged = r.domain.status === "failed" && r.domain.cf_id === null;
        return {
          domain: adminView(r.domain),
          changed: r.changed,
          action_id: r.action_id,
          message: !r.changed
            ? `${r.domain.hostname} isn't disabled. Nothing changed.`
            : purged
              ? `Enabled ${r.domain.hostname}, but it was purged, so it stays offline until the customer sets it up again.`
              : `Enabled ${r.domain.hostname}. It serves as before (${r.domain.status}).`,
        };
      });
    },
  }),

  admin_purge_custom_domain: tool({
    auth: true,
    ownerOnly: true,
    description:
      "IRREVERSIBLE: deletes a disabled custom domain's Cloudflare hostname and certificate. The domain must be disabled " +
      "first (admin_disable_custom_domain) and confirm must be true. The record stays (still disabled, status failed) and " +
      "the action is logged; enabling afterwards can't bring it back: the customer would have to set it up again. Use " +
      "only when a takedown is final.",
    input: z.object({
      hostname: hostnameArg,
      confirm: z.literal(true).describe("Must be true: this can't be undone."),
      note: noteArg,
    }),
    async run(a, c) {
      return takedownCall(async () => {
        const r = await purgeDomain(c.env, { hostname: a.hostname, note: a.note, actor: c.principal!.accountId, confirm: a.confirm });
        return {
          domain: adminView(r.domain),
          action_id: r.action_id,
          message: `Purged ${r.domain.hostname}: its Cloudflare hostname is deleted. It stays disabled (451).`,
        };
      });
    },
  }),

  admin_list_custom_domains: tool({
    auth: true,
    ownerOnly: true,
    description: "Operator only. Custom domains on record, newest first, with their account, status and takedown state.",
    input: z.object({
      status: z.enum(STATUSES).optional().describe("Only this status; 'disabled' = taken down (any status)."),
      limit: z.number().int().min(1).max(200).optional().describe("At most this many (default 50)."),
    }),
    async run(a, c) {
      return adminList(c.env, c.principal!.accountId, a);
    },
  }),

  admin_domain_actions: tool({
    auth: true,
    ownerOnly: true,
    description: "Operator only. The takedown log (disable / enable / purge, who, when, reason, note), newest first; for one hostname or all.",
    input: z.object({
      hostname: hostnameArg.optional(),
      limit: z.number().int().min(1).max(500).optional().describe("At most this many (default 100)."),
    }),
    async run(a, c) {
      const rows = await listDomainActions(c.env, a);
      log("warn", "admin: custom domain actions listed", { by: c.principal!.accountId, hostname: a.hostname ?? "all", count: rows.length });
      return {
        actions: rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null, created_at: isoTime(r.created_at) })),
        count: rows.length,
        message: rows.length ? `${rows.length} action${rows.length === 1 ? "" : "s"}.` : "No actions logged.",
      };
    },
  }),
};
