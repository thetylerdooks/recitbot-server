// Custom domain takedowns: the one place that disables, enables and purges a customer's custom video hostname, and the
// append-only action log (custom_domain_actions, migration 0029). The operator MCP tools (admin-domain-tools.ts) call
// these; automated owner tools may call them too.
//
// Rule: every takedown is reversible by the owner with no customer action, except purge, which is the one explicit,
// irreversible step.
//
// Contract (all throw DomainError {code, message}; nothing else is thrown on bad input):
//   disableDomain(env, { hostname, reason, note?, actor, evidence? }) -> { domain, already, action_id }
//     Sets disabled_at (kept if already set) and disabled_reason = reason, clears this isolate's host cache, appends a
//     'disable' action. Cloudflare is NOT touched: the custom hostname and certificate stay, so enable is instant.
//     The host gate answers the neutral 451 on every path at once here, within 30 s (cache TTL) on other isolates.
//     reason: one of REASON_CODES (else INVALID_REASON). Disabling again appends another action and updates the code.
//     also(action_id): more statements to commit in the same batch (takedown.ts: its admin_actions row), all or nothing.
//     keepReason: an already-disabled domain keeps its first disabled_reason (takedown.ts; the new code is in the log).
//   enableDomain(env, { hostname, actor, note? }) -> { domain, changed, action_id }
//     Clears disabled_at / disabled_reason, clears the host cache, appends an 'enable' action. The row keeps the status
//     it had (an active host serves again at once). Not disabled: { changed: false, action_id: null }, nothing logged.
//   purgeDomain(env, { hostname, actor, note?, confirm: true }) -> { domain, action_id }
//     IRREVERSIBLE. Only for a disabled domain (NOT_DISABLED) and only with confirm === true (CONFIRM_REQUIRED).
//     Deletes the Cloudflare custom hostname (CLOUDFLARE_ERROR / CUSTOM_DOMAINS_OFF if it can't, nothing changed), then
//     sets cf_id NULL and status 'failed' (row kept, still disabled: the gate keeps the 451 and the cron leaves it),
//     appends a 'purge' action. Undoing it needs the customer to set the domain up again.
//   listDomainActions(env, { hostname?, limit? }) -> DomainAction[]   newest first; limit 1..500, default 100.
// hostname: anything a person would paste (URL, IDN, any case, trailing dot); it's normalised like set_custom_domain.
// actor: the account id doing it (logged and stored). note: <= NOTE_MAX chars, stored in the log only, never rendered.
// evidence: any JSON-serialisable value, stored as JSON text (<= EVIDENCE_MAX chars, else EVIDENCE_TOO_LARGE).
// Each call logs one warn line (hostname, account, action, reason, actor; never the note's or evidence's content).
import { customDomainsEnabled, deleteCustomHostname } from "./cf-saas";
import { type CustomDomainRow, DomainError, validateHostname } from "./custom-domains";
import { clearCustomHostCache } from "./custom-host";
import type { Env } from "./env";
import { normalizeHost } from "./hosts";
import { log, now, randomId } from "./util";

export const REASON_CODES = ["csam", "phishing", "malware", "impersonation", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const NOTE_MAX = 1000;
export const EVIDENCE_MAX = 16_000;

export type DomainAction = {
  id: string;
  hostname: string;
  account_id: string | null;
  action: "disable" | "enable" | "purge";
  reason_code: string | null;
  note: string | null;
  actor_account_id: string;
  evidence: string | null;
  created_at: number;
};

/** Whatever was pasted (a URL, also with a path, an IDN, a trailing dot) in custom_domains.hostname form. */
export function hostKey(input: string): string {
  try {
    return validateHostname(input).hostname;
  } catch {
    const s = String(input ?? "").trim();
    // A page URL (https://host/slug) isn't a valid hostname to set, but names one to look up.
    if (/^https?:\/\//i.test(s)) {
      try {
        return hostKey(new URL(s).hostname);
      } catch {
        // fall through
      }
    }
    return normalizeHost(s);
  }
}

async function rowFor(env: Env, input: string): Promise<CustomDomainRow> {
  const hostname = hostKey(input);
  const row = await env.DB.prepare("SELECT * FROM custom_domains WHERE hostname = ?").bind(hostname).first<CustomDomainRow>();
  if (!row) throw new DomainError("NOT_FOUND", `No custom domain ${hostname} is on record.`);
  return row;
}

const reread = async (env: Env, id: string) => (await env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?").bind(id).first<CustomDomainRow>())!;

export function cleanNote(note: string | undefined): string | null {
  const n = (note ?? "").trim();
  if (!n) return null;
  if (n.length > NOTE_MAX) throw new DomainError("NOTE_TOO_LONG", `The note can be ${NOTE_MAX} characters at most.`);
  return n;
}

function evidenceText(evidence: unknown): string | null {
  if (evidence === undefined || evidence === null) return null;
  let s: string;
  try {
    s = JSON.stringify(evidence);
  } catch {
    throw new DomainError("INVALID_EVIDENCE", "Evidence must be JSON.");
  }
  if (s.length > EVIDENCE_MAX) throw new DomainError("EVIDENCE_TOO_LARGE", `Evidence can be ${EVIDENCE_MAX} characters of JSON at most.`);
  return s;
}

function actionStmt(
  env: Env,
  row: CustomDomainRow,
  a: { action: DomainAction["action"]; reason: string | null; note: string | null; actor: string; evidence: string | null; t: number },
): { id: string; stmt: D1PreparedStatement } {
  const id = randomId(128);
  const stmt = env.DB.prepare(
    "INSERT INTO custom_domain_actions (id, hostname, account_id, action, reason_code, note, actor_account_id, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, row.hostname, row.account_id, a.action, a.reason, a.note, a.actor, a.evidence, a.t);
  return { id, stmt };
}

function requireActor(actor: string): string {
  const a = String(actor ?? "").trim();
  if (!a) throw new DomainError("ACTOR_REQUIRED", "Say who is doing this (actor).");
  return a;
}

export async function disableDomain(
  env: Env,
  a: { hostname: string; reason: string; note?: string; actor: string; evidence?: unknown; also?: (actionId: string) => D1PreparedStatement[]; keepReason?: boolean },
): Promise<{ domain: CustomDomainRow; already: boolean; action_id: string }> {
  if (!(REASON_CODES as readonly string[]).includes(a.reason)) {
    throw new DomainError("INVALID_REASON", `The reason must be one of: ${REASON_CODES.join(", ")}.`);
  }
  const actor = requireActor(a.actor);
  const note = cleanNote(a.note);
  const evidence = evidenceText(a.evidence);
  const row = await rowFor(env, a.hostname);
  const t = now();
  const act = actionStmt(env, row, { action: "disable", reason: a.reason, note, actor, evidence, t });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE custom_domains SET disabled_at = coalesce(disabled_at, ?), disabled_reason = ${a.keepReason ? "CASE WHEN disabled_at IS NULL THEN ? ELSE coalesce(disabled_reason, ?) END" : "?"}, ` +
        "updated_at = ? WHERE id = ?",
    ).bind(t, ...(a.keepReason ? [a.reason, a.reason] : [a.reason]), t, row.id),
    act.stmt,
    ...(a.also?.(act.id) ?? []),
  ]);
  clearCustomHostCache();
  log("warn", "takedown: custom domain disabled", { hostname: row.hostname, account_id: row.account_id, reason: a.reason, actor, already: row.disabled_at !== null });
  return { domain: await reread(env, row.id), already: row.disabled_at !== null, action_id: act.id };
}

export async function enableDomain(
  env: Env,
  a: { hostname: string; actor: string; note?: string },
): Promise<{ domain: CustomDomainRow; changed: boolean; action_id: string | null }> {
  const actor = requireActor(a.actor);
  const note = cleanNote(a.note);
  const row = await rowFor(env, a.hostname);
  if (row.disabled_at === null) return { domain: row, changed: false, action_id: null };
  const t = now();
  const act = actionStmt(env, row, { action: "enable", reason: null, note, actor, evidence: null, t });
  await env.DB.batch([
    env.DB.prepare("UPDATE custom_domains SET disabled_at = NULL, disabled_reason = NULL, updated_at = ? WHERE id = ?").bind(t, row.id),
    act.stmt,
  ]);
  clearCustomHostCache();
  log("warn", "takedown: custom domain enabled", { hostname: row.hostname, account_id: row.account_id, status: row.status, actor });
  return { domain: await reread(env, row.id), changed: true, action_id: act.id };
}

export async function purgeDomain(
  env: Env,
  a: { hostname: string; actor: string; note?: string; confirm: boolean },
): Promise<{ domain: CustomDomainRow; action_id: string }> {
  if (a.confirm !== true) throw new DomainError("CONFIRM_REQUIRED", "Purging can't be undone. Call it again with confirm: true.");
  const actor = requireActor(a.actor);
  const note = cleanNote(a.note);
  const row = await rowFor(env, a.hostname);
  if (row.disabled_at === null) throw new DomainError("NOT_DISABLED", `Disable ${row.hostname} first; only a disabled domain can be purged.`);
  if (row.cf_id) {
    if (!customDomainsEnabled(env)) throw new DomainError("CUSTOM_DOMAINS_OFF", "Custom domains are off here, so Cloudflare can't be reached. Nothing changed.");
    const d = await deleteCustomHostname(env, row.cf_id);
    if (!d.ok) {
      log("warn", "takedown: cloudflare delete failed", { hostname: row.hostname, kind: d.kind, status: d.status });
      throw new DomainError("CLOUDFLARE_ERROR", `Cloudflare couldn't delete ${row.hostname} (${d.message}). Nothing changed; try again.`);
    }
  }
  const t = now();
  const act = actionStmt(env, row, { action: "purge", reason: row.disabled_reason, note, actor, evidence: null, t });
  await env.DB.batch([
    env.DB.prepare("UPDATE custom_domains SET cf_id = NULL, status = 'failed', cf_status = 'deleted', ssl_status = NULL, updated_at = ? WHERE id = ?").bind(
      t,
      row.id,
    ),
    act.stmt,
  ]);
  clearCustomHostCache();
  log("warn", "takedown: custom domain purged", { hostname: row.hostname, account_id: row.account_id, had_cloudflare: row.cf_id !== null, actor });
  return { domain: await reread(env, row.id), action_id: act.id };
}

export async function listDomainActions(env: Env, a: { hostname?: string; limit?: number } = {}): Promise<DomainAction[]> {
  const limit = Math.min(Math.max(Math.floor(a.limit ?? 100), 1), 500);
  const stmt = a.hostname
    ? env.DB.prepare("SELECT * FROM custom_domain_actions WHERE hostname = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(hostKey(a.hostname), limit)
    : env.DB.prepare("SELECT * FROM custom_domain_actions ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(limit);
  return (await stmt.all<DomainAction>()).results;
}
