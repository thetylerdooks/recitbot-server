// Operator takedowns of a recording, an account or a custom hostname, and their reversal, all logged in admin_actions
// (migration 0031, append-only by trigger). The state they create is read by takedown-state.ts; hostnames go through
// domain-takedown.ts (disableDomain / enableDomain, its own custom_domain_actions log), never around it. Tools:
// admin-takedown-tools.ts. Runbook: docs/operations.md "Custom domains: abuse runbook".
//
// Contract (all throw DomainError {code, message, extra}; nothing else is thrown on bad input):
//   takedown(env, { target, reason, note?, actor }) -> { action, target, already }
//     target: a recording id, an account id (both looked up; found in both = AMBIGUOUS_TARGET), or anything else as a
//     custom hostname (a pasted URL is fine; normalised like set_custom_domain). NOT_FOUND if none matches.
//     reason: one of REASON_CODES (else INVALID_REASON). Appends one 'takedown' row with a before_state snapshot.
//     Recording: removed at once. Account: suspended at once (and so every video of it removed). Hostname: disableDomain
//     (the 451 host gate), its action id kept in domain_action_id. already = the target was already taken down.
//     Nothing is deleted, ever: no media path is touched.
//   restore(env, { action_id, actor, note?, confirm? }) -> { action, restore_action, effect }
//     Reverses exactly that takedown: sets its reversed_at / reversed_by and appends a 'restore' row. NOT_FOUND,
//     NOT_A_TAKEDOWN (a restore row), ALREADY_RESTORED. A csam takedown needs confirm === true (CONFIRM_REQUIRED) and
//     its recordings stay held (takedown-state.ts) after it. A hostname is enabled again (enableDomain) only if no
//     other open takedown targets it and nothing but takedowns holds it down: the newest custom_domain_actions row no
//     takedown made isn't a disable or purge (before or after this takedown), or with no such row the host's first
//     takedown found it enabled. Overlapping takedowns restored in any order end enabled. effect says what changed.
//   listActions(env, { target?, limit? }) -> AdminAction[]   newest first; target matches target_id or account_id.
// actor: the operator's account id. note: <= NOTE_MAX characters, log only, never shown to users or viewers.
// Each call logs one warn line (target, reason, actor; never the note).
import { type CustomDomainRow, DomainError } from "./custom-domains";
import { cleanNote, disableDomain, enableDomain, hostKey, REASON_CODES, type ReasonCode } from "./domain-takedown";
import type { Env } from "./env";
import { accountSuspended, recordingRemoved } from "./takedown-state";
import { log, now, randomId } from "./util";

export type TargetType = "recording" | "account" | "hostname";

export type AdminAction = {
  id: string;
  action: "takedown" | "restore";
  target_type: TargetType;
  target_id: string;
  account_id: string | null;
  reason_code: ReasonCode;
  note: string | null;
  before_state: string;
  actor_account_id: string;
  domain_action_id: string | null;
  restores: string | null;
  created_at: number;
  reversed_at: number | null;
  reversed_by: string | null;
};

type Target = { type: TargetType; id: string; accountId: string | null; before: Record<string, unknown> };

const ID = /^[A-Za-z0-9]{10,40}$/;
const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());

function requireActor(actor: string): string {
  const a = String(actor ?? "").trim();
  if (!a) throw new DomainError("ACTOR_REQUIRED", "Say who is doing this (actor).");
  return a;
}

async function recordingSnapshot(env: Env, id: string): Promise<Target | null> {
  const r = await env.DB.prepare(
    "SELECT r.id, r.account_id, a.username, r.status, r.title, r.shared_at, r.created_at, r.expires_at, r.duration_s, r.bytes, " +
      "s.passcode_hash IS NOT NULL AS passcode FROM recordings r LEFT JOIN accounts a ON a.id = r.account_id " +
      "LEFT JOIN shares s ON s.recording_id = r.id WHERE r.id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      account_id: string;
      username: string | null;
      status: string;
      title: string | null;
      shared_at: number | null;
      created_at: number;
      expires_at: number;
      duration_s: number | null;
      bytes: number;
      passcode: number;
    }>();
  if (!r) return null;
  return {
    type: "recording",
    id: r.id,
    accountId: r.account_id,
    before: {
      recording_id: r.id,
      account_id: r.account_id,
      username: r.username,
      status: r.status,
      title: r.title,
      shared: r.shared_at !== null,
      passcode: !!r.passcode,
      created_at: iso(r.created_at),
      expires_at: iso(r.expires_at),
      duration_s: r.duration_s,
      bytes: r.bytes,
      removed: await recordingRemoved(env, r.id, r.account_id),
    },
  };
}

async function accountSnapshot(env: Env, id: string): Promise<Target | null> {
  const a = await env.DB.prepare("SELECT id, username, plan, plan_status, created_at FROM accounts WHERE id = ?")
    .bind(id)
    .first<{ id: string; username: string | null; plan: string; plan_status: string | null; created_at: number }>();
  if (!a) return null;
  const [counts, domains] = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS recordings, coalesce(sum(shared_at IS NOT NULL), 0) AS shared FROM recordings WHERE account_id = ?").bind(id),
    env.DB.prepare("SELECT hostname, status, disabled_at IS NOT NULL AS disabled FROM custom_domains WHERE account_id = ? ORDER BY created_at LIMIT 20").bind(id),
  ]);
  const c = counts.results[0] as { recordings: number; shared: number };
  return {
    type: "account",
    id: a.id,
    accountId: a.id,
    before: {
      account_id: a.id,
      username: a.username,
      plan: a.plan,
      plan_status: a.plan_status,
      created_at: iso(a.created_at),
      recordings: c.recordings,
      shared_recordings: c.shared,
      custom_domains: (domains.results as { hostname: string; status: string; disabled: number }[]).map((d) => ({ ...d, disabled: !!d.disabled })),
      suspended: await accountSuspended(env, a.id),
    },
  };
}

function domainSnapshot(d: CustomDomainRow): Target {
  return {
    type: "hostname",
    id: d.hostname,
    accountId: d.account_id,
    before: {
      hostname: d.hostname,
      account_id: d.account_id,
      status: d.status,
      disabled: d.disabled_at !== null,
      disabled_reason: d.disabled_reason,
      on_cloudflare: d.cf_id !== null,
      live_since: iso(d.live_at),
    },
  };
}

async function resolveTarget(env: Env, raw: string): Promise<Target> {
  const s = String(raw ?? "").trim();
  if (!s) throw new DomainError("TARGET_REQUIRED", "Say what to take down: a recording id, an account id or a custom hostname.");
  if (ID.test(s)) {
    const [rec, acct] = [await recordingSnapshot(env, s), await accountSnapshot(env, s)];
    if (rec && acct) throw new DomainError("AMBIGUOUS_TARGET", `${s} is both a recording id and an account id.`);
    const t = rec ?? acct;
    if (t) return t;
  }
  const hostname = hostKey(s);
  const d = await env.DB.prepare("SELECT * FROM custom_domains WHERE hostname = ?").bind(hostname).first<CustomDomainRow>();
  if (!d) throw new DomainError("NOT_FOUND", `No recording, account or custom domain matches ${s}.`);
  return domainSnapshot(d);
}

/** The target of an admin_actions row as it is now (the restore row's before_state). */
async function snapshotOf(env: Env, type: TargetType, id: string): Promise<Record<string, unknown>> {
  if (type === "hostname") {
    const d = await env.DB.prepare("SELECT * FROM custom_domains WHERE hostname = ?").bind(id).first<CustomDomainRow>();
    return d ? domainSnapshot(d).before : { hostname: id, missing: true };
  }
  const t = type === "recording" ? await recordingSnapshot(env, id) : await accountSnapshot(env, id);
  return t ? t.before : { [`${type}_id`]: id, missing: true };
}

const insert = (env: Env, a: Omit<AdminAction, "reversed_at" | "reversed_by">) =>
  env.DB.prepare(
    "INSERT INTO admin_actions (id, action, target_type, target_id, account_id, reason_code, note, before_state, actor_account_id, " +
      "domain_action_id, restores, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(a.id, a.action, a.target_type, a.target_id, a.account_id, a.reason_code, a.note, a.before_state, a.actor_account_id, a.domain_action_id, a.restores, a.created_at);

const byId = async (env: Env, id: string) => env.DB.prepare("SELECT * FROM admin_actions WHERE id = ?").bind(id).first<AdminAction>();

export async function takedown(
  env: Env,
  a: { target: string; reason: string; note?: string; actor: string },
): Promise<{ action: AdminAction; target: Record<string, unknown>; already: boolean }> {
  if (!(REASON_CODES as readonly string[]).includes(a.reason)) {
    throw new DomainError("INVALID_REASON", `The reason must be one of: ${REASON_CODES.join(", ")}.`);
  }
  const reason = a.reason as ReasonCode;
  const actor = requireActor(a.actor);
  const note = cleanNote(a.note);
  const t = await resolveTarget(env, a.target);
  const id = randomId(128);
  const already = t.type === "recording" ? !!t.before.removed : t.type === "account" ? !!t.before.suspended : !!t.before.disabled;
  const rowWith = (domainActionId: string | null) => ({
    id,
    action: "takedown" as const,
    target_type: t.type,
    target_id: t.id,
    account_id: t.accountId,
    reason_code: reason,
    note,
    before_state: JSON.stringify(t.before),
    actor_account_id: actor,
    domain_action_id: domainActionId,
    restores: null,
    created_at: now(),
  });
  let row = rowWith(null);
  if (t.type === "hostname") {
    // One batch: the domain disabled, its custom_domain_actions row and this admin_actions row commit together, so the
    // evidence pointer (admin_action_id) never leads nowhere and admin_restore can always undo it.
    await disableDomain(env, {
      hostname: t.id,
      reason,
      note: note ?? undefined,
      actor,
      evidence: { admin_action_id: id },
      keepReason: true,
      also: (domainActionId) => [insert(env, (row = rowWith(domainActionId)))],
    });
  } else {
    await insert(env, row).run();
  }
  log("warn", "takedown: done", { target_type: t.type, target: t.id, account_id: t.accountId, reason, actor, already });
  return { action: { ...row, reversed_at: null, reversed_by: null }, target: t.before, already };
}

export async function restore(
  env: Env,
  a: { action_id: string; actor: string; note?: string; confirm?: boolean },
): Promise<{ action: AdminAction; restore_action: AdminAction; effect: Record<string, unknown> }> {
  const actor = requireActor(a.actor);
  const note = cleanNote(a.note);
  const orig = await byId(env, String(a.action_id ?? "").trim());
  if (!orig) throw new DomainError("NOT_FOUND", `No admin action ${a.action_id}.`);
  if (orig.action !== "takedown") throw new DomainError("NOT_A_TAKEDOWN", `${orig.id} is a restore; restore its takedown (${orig.restores}) instead.`);
  if (orig.reversed_at !== null) {
    throw new DomainError("ALREADY_RESTORED", `${orig.id} was restored already.`, { reversed_at: iso(orig.reversed_at), reversed_by: orig.reversed_by });
  }
  if (orig.reason_code === "csam" && a.confirm !== true) {
    throw new DomainError(
      "CONFIRM_REQUIRED",
      "This is a csam takedown. Restoring makes it visible again (its files stay held and are never deleted). Call again with confirm: true.",
    );
  }
  const t = now();
  const rid = randomId(128);
  const row = {
    id: rid,
    action: "restore" as const,
    target_type: orig.target_type,
    target_id: orig.target_id,
    account_id: orig.account_id,
    reason_code: orig.reason_code,
    note,
    before_state: JSON.stringify(await snapshotOf(env, orig.target_type, orig.target_id)),
    actor_account_id: actor,
    domain_action_id: null as string | null,
    restores: orig.id,
    created_at: t,
  };
  // One transaction: the restore row only if the takedown is still open, then the takedown marked reversed.
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO admin_actions (id, action, target_type, target_id, account_id, reason_code, note, before_state, actor_account_id, " +
        "domain_action_id, restores, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE EXISTS " +
        "(SELECT 1 FROM admin_actions WHERE id = ? AND reversed_at IS NULL)",
    ).bind(rid, row.action, row.target_type, row.target_id, row.account_id, row.reason_code, row.note, row.before_state, actor, orig.id, t, orig.id),
    env.DB.prepare("UPDATE admin_actions SET reversed_at = ?, reversed_by = ? WHERE id = ? AND reversed_at IS NULL").bind(t, actor, orig.id),
  ]);
  if (!ins.meta.changes) throw new DomainError("ALREADY_RESTORED", `${orig.id} was restored already.`);

  const effect: Record<string, unknown> = {};
  if (orig.target_type === "hostname") {
    const others = await env.DB.prepare(
      "SELECT id FROM admin_actions WHERE action = 'takedown' AND target_type = 'hostname' AND target_id = ? AND reversed_at IS NULL",
    )
      .bind(orig.target_id)
      .all<{ id: string }>();
    // With no takedown of this host open, the newest domain action that no admin_takedown made decides: a disable or
    // purge (admin-domain-tools, before or after this takedown) is an independent decision and is left alone; an enable
    // means nothing else holds it down. Takedowns' own disables never count, so overlapping takedowns restored in any
    // order end enabled (a later takedown's before_state says disabled only because of an earlier one). Both logs are
    // append-only, so rowid is their order.
    const last = await env.DB.prepare(
      "SELECT c.id, c.action, c.rowid > (SELECT rowid FROM custom_domain_actions WHERE id = ?) AS after FROM custom_domain_actions c " +
        "WHERE c.hostname = ? AND NOT EXISTS (SELECT 1 FROM admin_actions x WHERE x.action = 'takedown' AND x.target_type = 'hostname' " +
        "AND x.target_id = c.hostname AND x.domain_action_id = c.id) ORDER BY c.rowid DESC LIMIT 1",
    )
      .bind(orig.domain_action_id, orig.target_id)
      .first<{ id: string; action: string; after: number | null }>();
    // No such action at all: the host was disabled before the log existed only if the first takedown of it says so.
    const first = last
      ? null
      : await env.DB.prepare("SELECT before_state FROM admin_actions WHERE action = 'takedown' AND target_type = 'hostname' AND target_id = ? ORDER BY rowid LIMIT 1")
          .bind(orig.target_id)
          .first<{ before_state: string }>();
    const unlogged = !!first && !!(JSON.parse(first.before_state) as { disabled?: boolean }).disabled;
    const held = last && (last.action === "disable" || last.action === "purge");
    if (others.results.length) effect.hostname = `left disabled: still taken down by ${others.results.map((r) => r.id).join(", ")}`;
    else if (held && last.after) effect.hostname = `left disabled: ${last.action === "purge" ? "purged" : "disabled again"} by ${last.id} after this takedown`;
    else if (held || unlogged) effect.hostname = "left disabled: it was already disabled before this takedown";
    else {
      const e = await enableDomain(env, { hostname: orig.target_id, actor, note: `admin_restore of ${orig.id}` });
      effect.hostname = e.changed ? "enabled" : "already enabled";
      effect.domain_action_id = e.action_id;
    }
  } else if (orig.target_type === "recording") {
    effect.still_removed = await recordingRemoved(env, orig.target_id, orig.account_id ?? "");
  } else {
    effect.still_suspended = await accountSuspended(env, orig.target_id);
  }
  if (orig.reason_code === "csam") effect.files = "held: never deleted";
  log("warn", "takedown: restored", { action_id: orig.id, target_type: orig.target_type, target: orig.target_id, reason: orig.reason_code, actor });
  return { action: (await byId(env, orig.id))!, restore_action: (await byId(env, rid))!, effect };
}

export async function listActions(env: Env, a: { target?: string; limit?: number } = {}): Promise<AdminAction[]> {
  const limit = Math.min(Math.max(Math.floor(a.limit ?? 100), 1), 500);
  const raw = String(a.target ?? "").trim();
  if (!raw) return (await env.DB.prepare("SELECT * FROM admin_actions ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(limit).all<AdminAction>()).results;
  const key = ID.test(raw) ? raw : hostKey(raw);
  return (
    await env.DB.prepare("SELECT * FROM admin_actions WHERE target_id = ? OR account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .bind(key, key, limit)
      .all<AdminAction>()
  ).results;
}

/** Open (not reversed) takedowns of the account or anything of it, newest first (admin_lookup). */
export async function openActions(env: Env, accountId: string): Promise<AdminAction[]> {
  return (
    await env.DB.prepare(
      "SELECT * FROM admin_actions WHERE action = 'takedown' AND reversed_at IS NULL AND (account_id = ? OR target_id = ?) ORDER BY created_at DESC LIMIT 100",
    )
      .bind(accountId, accountId)
      .all<AdminAction>()
  ).results;
}
