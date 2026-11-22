// Custom video domains (Pro, Teams, owner): one hostname per account, any subdomain of a domain the customer owns
// (videos.example.com), served through Cloudflare for SaaS on the operator's zone (cf-saas.ts). Table custom_domains
// (migration 0027). Everything here is driven by the MCP tools (domain-tools.ts) and the hourly cron; there is no
// dashboard. Lifecycle: pending (waiting for the customer's CNAME and the certificate) -> active; a change or removal
// moves the old row to redirecting (301 to the new host, or back to our own host, for 30 days), then the cron deletes
// it from Cloudflare and D1. Pending rows that never verify fail after 7 days.
import { parse } from "tldts";
import { contactLine, getConfig } from "./config";
import {
  createCustomHostname,
  customDomainsEnabled,
  type CfResult,
  type CustomHostname,
  deleteCustomHostname,
  findCustomHostname,
  getCustomHostname,
  sanitizeCfMessage,
} from "./cf-saas";
import { hostnameBlockedReason } from "./domain-blocklist";
import { canUseCustomBranding } from "./entitlements";
import { accountLimits, type Env } from "./env";
import { governor } from "./governor";
import { DOMAINS_OWNER_ONLY, OWNER_ONLY } from "./selfhost-text";
import { log, now, randomId } from "./util";

const DAY = 86400;

export const DOMAIN_LIMITS = {
  /** set_custom_domain calls that reach Cloudflare, per account and in all, per UTC day (Governor). */
  setsPerAccountPerDay: 3,
  setsPerDay: 200,
  /** ...and in all per hour: every set that reaches Cloudflare may create one custom hostname (abuse brake). */
  setsPerHour: 60,
  /** A replaced or removed hostname redirects this long, then the cron deletes it. */
  redirectSeconds: 30 * DAY,
  /** Pending this long (never verified) = failed, and deleted from Cloudflare. */
  pendingMaxSeconds: 7 * DAY,
  /** A failed row stays this long (so get_custom_domain_status can say why), then the cron deletes it. */
  failedKeepSeconds: DAY,
  /** Cron: pending rows re-checked, and rows purged, per run. */
  refreshPerRun: 20,
  purgePerRun: 20,
  dohTimeoutMs: 5000,
} as const;

/**
 * redirect_to for a removed hostname: back to the normal <our host>/<user>/v/<slug> links. It is the canonical host
 * (config.ts canonicalHost), the value rows written before the config split already hold.
 */
export const homeHost = (env: Env): string => getConfig(env).site.canonicalHost ?? "";

/** What customers point their CNAME at (CUSTOM_DOMAIN_CNAME_TARGET). */
export function cnameTarget(env: Env): string {
  return getConfig(env).customDomains.cnameTarget ?? "";
}

export type CustomDomainStatus = "pending" | "active" | "redirecting" | "failed";
export type CustomDomainRow = {
  id: string;
  account_id: string;
  hostname: string;
  cf_id: string | null;
  status: CustomDomainStatus;
  cf_status: string | null;
  ssl_status: string | null;
  verification_errors: string | null;
  redirect_to: string | null;
  redirect_until: number | null;
  disabled_at: number | null;
  disabled_reason: string | null;
  live_at: number | null;
  checked_at: number | null;
  created_at: number;
  updated_at: number;
};

/** A refusal the tools pass on as-is (code + plain-English message for the user). */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const OFF = () => new DomainError("CUSTOM_DOMAINS_OFF", "Custom domains aren't switched on yet.");
const UPGRADE = (env: Env) =>
  getConfig(env).billing.enabled
    ? new DomainError("UPGRADE_REQUIRED", "Custom domains are part of Recitbot Pro ($10/mo or $100/yr). Ask me to upgrade to Pro.")
    : new DomainError(OWNER_ONLY, DOMAINS_OWNER_ONLY);
const DISABLED = (env: Env) =>
  new DomainError("DOMAIN_DISABLED", `Recitbot turned off the custom domain on this account, so it can't be changed here. ${contactLine(getConfig(env))}.`);
/** set_custom_domain's answer for a hostname domain-blocklist.ts flags. */
export const needsReviewMessage = (env: Env) => {
  const abuse = getConfig(env).site.abuseEmail;
  return `That name looks like it could be mistaken for another company, so it needs a manual review. ${abuse ? `Email ${abuse}` : "Contact the operator of this server"} or pick a different subdomain.`;
};
const TRY_AGAIN = () => new DomainError("TRY_AGAIN", "Custom domains can't be changed right now. Try again in a few minutes.");
const taken = (h: string) =>
  new DomainError("HOSTNAME_TAKEN", `${h} is already connected to another account or service. Pick a different name, like another subdomain of your domain.`);

// ---------- hostname validation (before any network call) ----------

export type ValidHostname = {
  /** Lowercase ASCII (IDN as punycode), no trailing dot. */
  hostname: string;
  /** The registrable domain (example.com, brand.co.uk). */
  domain: string;
  /** The labels left of it ("videos", "watch.team"): the CNAME record's Name at most DNS hosts. */
  sub: string;
};

/** Hosts under these are never a customer's: our own zone and hosts (config.ts) and Workers' (the PSL also lists workers.dev). */
export function reservedDomains(env: Env): string[] {
  const { site } = getConfig(env);
  return [...new Set([...(site.zone ? [site.zone] : []), ...site.hostnames, "workers.dev"])];
}
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The customer's hostname, normalised, or a DomainError: INVALID_HOSTNAME (not a usable DNS name, URL parts beyond
 * the host, IP, wildcard, unknown TLD), APEX_NOT_SUPPORTED (a bare registrable domain), RESERVED_HOSTNAME (`reserved`:
 * our own zone and hosts, workers.dev), PLATFORM_DOMAIN (under a Public Suffix List private suffix: vercel.app, github.io, pages.dev, ...).
 * A pasted URL is fine ("https://videos.example.com/"): only its host is kept.
 */
export function validateHostname(input: string, reserved: readonly string[] = ["workers.dev"]): ValidHostname {
  const bad = (why: string) => new DomainError("INVALID_HOSTNAME", `${why} Send just the name, like videos.yourdomain.com.`);
  const s = String(input ?? "").trim();
  if (!s) throw bad("That's empty.");
  if (s.length > 300) throw bad("That name is too long.");
  if (s.includes("*")) throw bad("Wildcards (*) can't be used: pick one name.");
  if (/\s/.test(s)) throw bad("A domain name can't contain spaces.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme && !/^https?$/i.test(scheme[1])) throw bad("That isn't a web address.");
  let u: URL;
  try {
    u = new URL(scheme ? s : `https://${s}`);
  } catch {
    throw bad("That isn't a valid domain name.");
  }
  if (u.username || u.password) throw bad("Leave out the part before @.");
  if (u.port) throw bad("Leave out the port: custom domains use the normal HTTPS port.");
  if (u.pathname !== "/" || u.search || u.hash) throw bad("Leave out the path: only the domain name is needed.");
  // URL has already lowercased it and turned an IDN into punycode.
  let h = u.hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") || /^[0-9.]+$/.test(h) || parse(h, { extractHostname: false }).isIp) {
    throw bad("IP addresses can't be used: pick a domain name.");
  }
  if (h.length > 253) throw bad("That name is too long (253 characters at most).");
  const labels = h.split(".");
  if (labels.some((l) => !LABEL.test(l))) {
    throw bad("Each part of the name may use only letters, digits and hyphens (not first or last), up to 63 characters.");
  }
  for (const d of reserved) {
    if (h === d || h.endsWith(`.${d}`)) {
      throw new DomainError("RESERVED_HOSTNAME", `${d} names can't be used as a custom domain. Use a subdomain of a domain you own, like videos.yourdomain.com.`);
    }
  }
  const priv = parse(h, { allowPrivateDomains: true, extractHostname: false });
  if (priv.isPrivate) {
    throw new DomainError(
      "PLATFORM_DOMAIN",
      `${priv.publicSuffix} belongs to a hosting platform, so its names can't be used here. Use a subdomain of a domain you own, like videos.yourdomain.com.`,
    );
  }
  const p = parse(h, { extractHostname: false });
  if (!p.isIcann || !p.publicSuffix) throw bad(`".${labels[labels.length - 1]}" isn't a domain ending I recognise.`);
  if (!p.domain) throw bad(`${h} is a domain ending, not a domain someone owns.`);
  if (h === p.domain) throw new DomainError("APEX_NOT_SUPPORTED", `${h} is a bare domain, and those can't be used. Pick a subdomain like videos.${h}.`);
  if (labels.length < 3 || !p.subdomain) throw bad("That name needs a subdomain.");
  return { hostname: h, domain: p.domain, sub: p.subdomain };
}

/** The CNAME record's Name for a stored (already valid) hostname. */
function subOf(hostname: string): string {
  return parse(hostname, { extractHostname: false }).subdomain || hostname;
}

// ---------- DNS precheck (DNS over HTTPS) ----------

/** Test seam: tests replace fetch to stand in for the DoH resolver. */
export const dnsDeps = { fetch: (input: string, init: RequestInit) => fetch(input, init) };

/**
 * The hostname's CNAME target (lowercase, no trailing dot) as public DNS sees it now, or null: no CNAME, or the lookup
 * failed. A proxied (orange-cloud) record on Cloudflare DNS shows no CNAME here even when it's right.
 */
export async function dnsCnameTarget(hostname: string): Promise<string | null> {
  try {
    const res = await dnsDeps.fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOMAIN_LIMITS.dohTimeoutMs),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { Answer?: { type?: number; data?: unknown }[] };
    const a = (d.Answer ?? []).find((x) => x.type === 5 && typeof x.data === "string");
    return a ? String(a.data).trim().toLowerCase().replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

// ---------- rows ----------

async function accountRows(env: Env, accountId: string): Promise<CustomDomainRow[]> {
  return (await env.DB.prepare("SELECT * FROM custom_domains WHERE account_id = ? ORDER BY created_at DESC, id").bind(accountId).all<CustomDomainRow>())
    .results;
}

const rowByHost = (env: Env, hostname: string) =>
  env.DB.prepare("SELECT * FROM custom_domains WHERE hostname = ?").bind(hostname).first<CustomDomainRow>();

const isLive = (r: CustomDomainRow) => r.status === "pending" || r.status === "active";

/** The account's live custom domain (status active, not disabled), or null. Share links use it once PR3 lands. */
export async function liveCustomDomain(env: Env, accountId: string): Promise<CustomDomainRow | null> {
  return env.DB.prepare("SELECT * FROM custom_domains WHERE account_id = ? AND status = 'active' AND disabled_at IS NULL LIMIT 1")
    .bind(accountId)
    .first<CustomDomainRow>();
}

/**
 * Downgrade / takedown: the account's pending or active hostname redirects back to our own host for 30 days (then the
 * cron deletes it), and its older redirecting hostnames that pointed at it now point at our own host too.
 * Returns how many pending/active rows it retired (0 or 1).
 */
export async function retireAccountDomains(env: Env, accountId: string, t = now()): Promise<number> {
  const home = homeHost(env);
  const [, retired] = await env.DB.batch([
    env.DB.prepare("UPDATE custom_domains SET redirect_to = ?, updated_at = ? WHERE account_id = ? AND status = 'redirecting' AND redirect_to != ?").bind(
      home,
      t,
      accountId,
      home,
    ),
    env.DB.prepare(
      "UPDATE custom_domains SET status = 'redirecting', redirect_to = ?, redirect_until = ?, updated_at = ? WHERE account_id = ? AND status IN ('pending', 'active')",
    ).bind(home, t + DOMAIN_LIMITS.redirectSeconds, t, accountId),
  ]);
  return retired.meta.changes ?? 0;
}

// ---------- Cloudflare state ----------

const CF_ERROR_STATUSES = new Set(["blocked", "moved", "deleted", "test_blocked", "test_failed"]);
const SSL_ERROR_STATUSES = new Set(["validation_timed_out", "issuance_timed_out", "deleted", "expired", "timing_out"]);
const SSL_ISSUING = new Set(["pending_issuance", "pending_deployment"]);

/** Cloudflare's verification_errors and ssl.validation_errors as sanitised strings (at most 5), or null. */
function errorsOf(h: CustomHostname): string[] | null {
  const list = [...(h.verification_errors ?? []), ...(h.ssl?.validation_errors ?? []).map((e) => e?.message ?? "")]
    .map(sanitizeCfMessage)
    .filter(Boolean);
  return list.length ? [...new Set(list)].slice(0, 5) : null;
}

const parseErrors = (s: string | null): string[] => {
  try {
    const v = s ? JSON.parse(s) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const cfLive = (h: CustomHostname) => h.status === "active" && h.ssl?.status === "active";

/** The user-facing refusal for a Cloudflare failure. Config problems are ours: logged, and the feature reads as off. */
function cfFailure(r: Extract<CfResult<unknown>, { ok: false }>, hostname: string): DomainError {
  if (r.kind === "taken_elsewhere") {
    return new DomainError(
      "HOSTNAME_TAKEN",
      `${hostname} is already connected to another service on Cloudflare. If it's yours, remove it there first, or pick a different subdomain.`,
    );
  }
  if (r.kind === "config") {
    log("error", "custom domains: cloudflare refused our credentials", { status: r.status, codes: r.codes });
    return OFF();
  }
  return new DomainError("CLOUDFLARE_ERROR", `Cloudflare couldn't set up ${hostname} right now (${r.message}). Try again in a few minutes.`);
}

/** Re-reads a pending row from Cloudflare and stores what it says; promotes it to active once hostname + SSL are. */
async function refreshPending(env: Env, row: CustomDomainRow, t: number): Promise<{ row: CustomDomainRow; error?: string }> {
  const r = row.cf_id ? await getCustomHostname(env, row.cf_id) : null;
  if (!r || (!r.ok && r.kind === "not_found")) {
    const errs = JSON.stringify(["Cloudflare no longer has this hostname."]);
    await env.DB.prepare(
      "UPDATE custom_domains SET status = 'failed', cf_status = 'deleted', verification_errors = ?, checked_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    )
      .bind(errs, t, t, row.id)
      .run();
    return { row: { ...row, status: "failed", cf_status: "deleted", verification_errors: errs, checked_at: t, updated_at: t } };
  }
  if (!r.ok) return { row, error: r.kind === "config" ? "Custom domains aren't working right now." : r.message };
  const h = r.result;
  const live = cfLive(h);
  const errs = errorsOf(h);
  const next: CustomDomainRow = {
    ...row,
    status: live ? "active" : row.status,
    cf_status: h.status ?? null,
    ssl_status: h.ssl?.status ?? null,
    verification_errors: errs ? JSON.stringify(errs) : null,
    live_at: live ? (row.live_at ?? t) : row.live_at,
    checked_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    "UPDATE custom_domains SET status = ?, cf_status = ?, ssl_status = ?, verification_errors = ?, live_at = ?, checked_at = ?, updated_at = ? " +
      "WHERE id = ? AND status = 'pending'",
  )
    .bind(next.status, next.cf_status, next.ssl_status, next.verification_errors, next.live_at, t, t, row.id)
    .run();
  return { row: next };
}

// ---------- user-facing shapes ----------

const isoDate = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);

function dnsRecord(env: Env, hostname: string) {
  return { type: "CNAME", name: subOf(hostname), full_name: hostname, target: cnameTarget(env), ttl: "Auto" };
}

/** "<sub> CNAME <target>" first, then where to put it at the common DNS hosts. */
function instructions(env: Env, hostname: string): string {
  const sub = subOf(hostname);
  const target = cnameTarget(env);
  return [
    `${sub} CNAME ${target}`,
    `Cloudflare DNS: add a CNAME record, Name ${sub}, Target ${target}. DNS only (grey cloud) is simplest; proxied (orange cloud) works too.`,
    `GoDaddy, Namecheap, Squarespace and most others: Type CNAME, Host/Name ${sub}, Value/Points to ${target}, TTL Automatic.`,
    `Route 53: Record name ${hostname} (the full name), Type CNAME, Value ${target}.`,
    "Keep the record in place for as long as you use the domain. No TXT record is needed.",
  ].join("\n");
}

type Phase = "waiting_for_dns" | "wrong_target" | "verifying" | "issuing_certificate" | "live" | "error" | "failed";

function phaseOf(row: CustomDomainRow, cname: string | null | undefined, target: string): Phase {
  if (row.status === "active") return "live";
  if (row.status === "failed") return "failed";
  if (CF_ERROR_STATUSES.has(row.cf_status ?? "") || SSL_ERROR_STATUSES.has(row.ssl_status ?? "")) return "error";
  if (row.cf_status === "active" || SSL_ISSUING.has(row.ssl_status ?? "")) return "issuing_certificate";
  if (cname && cname !== target) return "wrong_target";
  if (cname === target) return "verifying";
  return "waiting_for_dns";
}

function phaseMessage(env: Env, row: CustomDomainRow, phase: Phase, cname: string | null | undefined): string {
  const h = row.hostname;
  const target = cnameTarget(env);
  const record = `${subOf(h)} CNAME ${target}`;
  const errs = parseErrors(row.verification_errors);
  switch (phase) {
    case "live":
      return `Live at https://${h}.`;
    case "failed":
      return `${h} didn't go live${errs.length ? ` (${errs.join("; ")})` : ""}. Call set_custom_domain with it again to retry.`;
    case "error":
      return `Cloudflare reported a problem with ${h}${errs.length ? `: ${errs.join("; ")}` : ""}. Check the record (${record}), then check again.`;
    case "issuing_certificate":
      return `DNS verified. Issuing the HTTPS certificate for ${h}; this usually takes a few minutes.`;
    case "verifying":
      return `DNS found, verifying ${h} with Cloudflare; this usually takes a few minutes.`;
    case "wrong_target":
      return `${h} points to ${cname}; it should point to ${target}. Change the CNAME record's target to ${target}.`;
    default:
      return (
        `Waiting for your DNS record: I don't see the CNAME for ${h} yet. Add ${record} at your DNS provider. New records ` +
        "usually show up within minutes, sometimes a few hours. (With Cloudflare DNS and the proxy on, I can't see the CNAME, but it still works.)"
      );
  }
}

function redirectsOf(rows: CustomDomainRow[]) {
  return rows
    .filter((r) => r.status === "redirecting")
    .map((r) => ({ hostname: r.hostname, redirect_to: r.redirect_to, until: isoDate(r.redirect_until) }));
}

const redirectsText = (list: ReturnType<typeof redirectsOf>) =>
  list.map((r) => ` ${r.hostname} redirects to ${r.redirect_to}${r.until ? ` until ${r.until}` : ""}.`).join("");

// ---------- tools' logic ----------

/** Fails closed: a Governor error means no slot. */
async function takeSetSlot(env: Env, accountId: string, t: number): Promise<void> {
  const g = governor(env);
  const hitMine = (consume: boolean) => g.hit(`cdset:${accountId}`, DOMAIN_LIMITS.setsPerAccountPerDay, DAY, t, consume);
  const hitAll = (consume: boolean) => g.hit("cdset:global", DOMAIN_LIMITS.setsPerDay, DAY, t, consume);
  const hitHour = (consume: boolean) => g.hit("cdset:global:hour", DOMAIN_LIMITS.setsPerHour, 3600, t, consume);
  let mine: { ok: boolean; retry_after: number };
  let all: { ok: boolean; retry_after: number };
  let hour: { ok: boolean; retry_after: number };
  try {
    // Check all three, then count all three: a refusal by one never uses up the others.
    [mine, all, hour] = [await hitMine(false), await hitAll(false), await hitHour(false)];
    if (mine.ok && all.ok && hour.ok) [mine, all, hour] = [await hitMine(true), await hitAll(true), await hitHour(true)];
  } catch (e) {
    log("error", "governor unreachable", { err: String(e) });
    throw TRY_AGAIN();
  }
  const resets = new Date((Math.floor(t / DAY) + 1) * DAY * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  if (!mine.ok) {
    throw new DomainError(
      "RATE_LIMITED",
      `The custom domain can be set or changed ${DOMAIN_LIMITS.setsPerAccountPerDay} times per day, and that's used up. Try again after ${resets}.`,
      { retry_after: mine.retry_after },
    );
  }
  if (!all.ok) throw new DomainError("RATE_LIMITED", `Too many custom domains were set up today. Try again after ${resets}.`, { retry_after: all.retry_after });
  if (!hour.ok) {
    const mins = Math.max(1, Math.ceil(hour.retry_after / 60));
    throw new DomainError("RATE_LIMITED", `Too many custom domains are being set up right now. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, {
      retry_after: hour.retry_after,
    });
  }
}

/** Creates the Cloudflare hostname; one that already exists on our own zone with no D1 row (a half-finished earlier call) is adopted. */
async function createOrAdopt(env: Env, hostname: string): Promise<{ cf: CustomHostname; created: boolean }> {
  const r = await createCustomHostname(env, hostname);
  if (r.ok) return { cf: r.result, created: true };
  if (r.kind === "taken_elsewhere") {
    const f = await findCustomHostname(env, hostname);
    if (f.ok && f.result) return { cf: f.result, created: false };
  }
  throw cfFailure(r, hostname);
}

/**
 * set_custom_domain: validate, check plan / uniqueness / rate limit, create the Cloudflare hostname, then store it.
 * Same hostname again = its current status (idempotent, no Cloudflare call). A different one replaces the account's
 * current hostname, which redirects to the new one for 30 days. Cloudflare refusing changes nothing in D1.
 */
export async function setCustomDomain(env: Env, accountId: string, input: string, t = now()): Promise<Record<string, unknown>> {
  if (!customDomainsEnabled(env)) throw OFF();
  if (!canUseCustomBranding((await accountLimits(env, accountId)).tier)) throw UPGRADE(env);
  const v = validateHostname(input, reservedDomains(env));
  const blocked = hostnameBlockedReason(v.hostname);
  if (blocked) {
    log("warn", "custom domain needs review", { hostname: v.hostname, reason: blocked });
    throw new DomainError("HOSTNAME_NEEDS_REVIEW", needsReviewMessage(env), { reason: blocked });
  }

  const rows = await accountRows(env, accountId);
  if (rows.some((r) => r.disabled_at !== null)) throw DISABLED(env);
  const existing = await rowByHost(env, v.hostname);
  if (existing && existing.account_id !== accountId) throw taken(v.hostname);
  if (existing && isLive(existing)) {
    const out = describe(env, existing, undefined);
    return { ...out, already: true, message: `${v.hostname} is already this account's custom domain. ${out.message}` };
  }
  const current = rows.find(isLive) ?? null;

  await takeSetSlot(env, accountId, t);

  // Cloudflare first: if it refuses, nothing below runs.
  let cf: CustomHostname;
  let created = false;
  if (existing?.status === "redirecting" && existing.cf_id) {
    // Switching back to a hostname still redirecting: its Cloudflare hostname (and certificate) is still there.
    const g = await getCustomHostname(env, existing.cf_id);
    if (g.ok) cf = g.result;
    else if (g.kind === "not_found") ({ cf, created } = await createOrAdopt(env, v.hostname));
    else throw cfFailure(g, v.hostname);
  } else {
    if (existing?.cf_id) {
      // A failed row of this account: clear its Cloudflare hostname before starting over.
      const d = await deleteCustomHostname(env, existing.cf_id);
      if (!d.ok) throw cfFailure(d, v.hostname);
    }
    ({ cf, created } = await createOrAdopt(env, v.hostname));
  }

  const live = cfLive(cf);
  const errs = errorsOf(cf);
  const id = existing?.id ?? randomId(128);
  const until = t + DOMAIN_LIMITS.redirectSeconds;
  const stmts: D1PreparedStatement[] = [];
  if (current) {
    stmts.push(
      env.DB.prepare("UPDATE custom_domains SET status = 'redirecting', redirect_to = ?, redirect_until = ?, updated_at = ? WHERE id = ?").bind(
        v.hostname,
        until,
        t,
        current.id,
      ),
    );
  }
  // Older hostnames redirecting to a custom host now go straight to the new one (no chains).
  stmts.push(
    env.DB.prepare(
      "UPDATE custom_domains SET redirect_to = ?, updated_at = ? WHERE account_id = ? AND status = 'redirecting' AND redirect_to != ? AND hostname != ?",
    ).bind(v.hostname, t, accountId, homeHost(env), v.hostname),
  );
  const fields = [cf.id, live ? "active" : "pending", cf.status ?? null, cf.ssl?.status ?? null, errs ? JSON.stringify(errs) : null, live ? t : null, t, t, t];
  if (existing) stmts.push(env.DB.prepare("DELETE FROM custom_domains WHERE id = ?").bind(existing.id));
  stmts.push(
    env.DB.prepare(
      "INSERT INTO custom_domains (cf_id, status, cf_status, ssl_status, verification_errors, live_at, checked_at, created_at, updated_at, id, account_id, hostname) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(...fields, id, accountId, v.hostname),
  );
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // Lost a race (another account took the name, or a concurrent change): undo our Cloudflare hostname, change nothing.
    log("warn", "custom domain insert failed", { err: String(e) });
    if (created) await deleteCustomHostname(env, cf.id).catch(() => null);
    const now2 = await rowByHost(env, v.hostname);
    if (now2 && now2.account_id !== accountId) throw taken(v.hostname);
    throw TRY_AGAIN();
  }

  const row = (await rowByHost(env, v.hostname))!;
  const out = describe(env, row, undefined);
  const replaced = current ? { hostname: current.hostname, redirect_to: v.hostname, until: isoDate(until) } : null;
  const steps =
    row.status === "active"
      ? out.message
      : `Add this DNS record at the DNS provider for ${v.domain}: ${v.sub} CNAME ${cnameTarget(env)}. Once it's in, it usually goes live within minutes; check with get_custom_domain_status.`;
  return {
    ...out,
    replaced,
    message: steps + (replaced ? ` ${replaced.hostname} now redirects to ${v.hostname} for 30 days (until ${replaced.until}).` : ""),
  };
}

/** One row as the tools show it. cname: the DoH answer (undefined = not looked up). */
function describe(env: Env, row: CustomDomainRow, cname: string | null | undefined) {
  const target = cnameTarget(env);
  const phase = phaseOf(row, cname, target);
  return {
    hostname: row.hostname,
    status: row.status,
    phase,
    live_url: row.status === "active" ? `https://${row.hostname}` : null,
    live_since: isoDate(row.live_at),
    dns: dnsRecord(env, row.hostname),
    instructions: instructions(env, row.hostname),
    ...(cname !== undefined && { cname_seen: cname }),
    errors: parseErrors(row.verification_errors),
    checked_at: row.checked_at,
    message: phaseMessage(env, row, phase, cname),
  };
}

/** get_custom_domain_status: the account's hostname (pending ones re-checked with Cloudflare and DNS) and its redirects. */
export async function getCustomDomainStatus(env: Env, accountId: string, t = now()): Promise<Record<string, unknown>> {
  const on = customDomainsEnabled(env);
  let rows = await accountRows(env, accountId);
  if (!rows.length && !on) throw OFF();
  let row = rows.find(isLive) ?? rows.find((r) => r.status === "failed") ?? null;
  let cname: string | null | undefined;
  let problem: string | undefined;
  if (row && row.status === "pending" && on) {
    const [r, c] = await Promise.all([refreshPending(env, row, t), dnsCnameTarget(row.hostname)]);
    row = r.row;
    problem = r.error;
    cname = c;
    rows = rows.map((x) => (x.id === row!.id ? row! : x));
  }
  const redirecting = redirectsOf(rows);
  if (!row) {
    return {
      custom_domain: null,
      redirecting,
      message:
        "No custom domain is set up on this account. To add one, ask which subdomain of their own domain the user wants (like videos.theirdomain.com) and call set_custom_domain." +
        redirectsText(redirecting),
    };
  }
  const d = describe(env, row, cname);
  return {
    custom_domain: d,
    redirecting,
    message: d.message + (problem ? ` (Couldn't reach Cloudflare just now: ${problem}. Showing the last known state.)` : "") + redirectsText(redirecting),
  };
}

/**
 * remove_custom_domain: a hostname that went live redirects back to our own host for 30 days; one that never went live
 * is deleted from Cloudflare and D1 right away (if Cloudflare fails, it's marked failed and the cron finishes it).
 * Nothing set up = nothing to do (idempotent).
 */
export async function removeCustomDomain(env: Env, accountId: string, t = now()): Promise<Record<string, unknown>> {
  const rows = await accountRows(env, accountId);
  if (rows.some((r) => r.disabled_at !== null)) throw DISABLED(env);
  const row = rows.find(isLive);
  if (!row) {
    const redirecting = redirectsOf(rows);
    return { removed: null, redirecting, message: "No custom domain is set up on this account, so there's nothing to remove." + redirectsText(redirecting) };
  }
  if (row.status === "pending" && row.live_at === null) {
    const d = row.cf_id ? await deleteCustomHostname(env, row.cf_id) : ({ ok: true } as const);
    await env.DB.batch([
      d.ok
        ? env.DB.prepare("DELETE FROM custom_domains WHERE id = ?").bind(row.id)
        : env.DB.prepare("UPDATE custom_domains SET status = 'failed', updated_at = ? WHERE id = ?").bind(t, row.id),
      // Older hostnames that redirected to it go back to our own host.
      env.DB.prepare("UPDATE custom_domains SET redirect_to = ?, updated_at = ? WHERE account_id = ? AND status = 'redirecting' AND redirect_to != ?").bind(
        homeHost(env),
        t,
        accountId,
        homeHost(env),
      ),
    ]);
    const redirecting = redirectsOf(await accountRows(env, accountId));
    return {
      removed: { hostname: row.hostname, redirect_to: null, until: null },
      redirecting,
      message: `Removed ${row.hostname}. It never went live, so nothing redirects; the user can delete its CNAME record.` + redirectsText(redirecting),
    };
  }
  await retireAccountDomains(env, accountId, t);
  const until = isoDate(t + DOMAIN_LIMITS.redirectSeconds);
  const redirecting = redirectsOf(await accountRows(env, accountId)).filter((r) => r.hostname !== row.hostname);
  return {
    removed: { hostname: row.hostname, redirect_to: homeHost(env), until },
    redirecting,
    message:
      `Removed ${row.hostname}. Until ${until} its links redirect to the same videos on ${homeHost(env)}; after that the domain ` +
      `stops working and the user can delete its CNAME record. New links use ${homeHost(env)}.` +
      redirectsText(redirecting),
  };
}

// ---------- cron ----------

/**
 * Hourly (index.ts cleanup): pending rows older than 7 days fail (and leave Cloudflare); up to refreshPerRun pending
 * rows are re-checked, least recently checked first; redirecting rows past redirect_until and failed rows past
 * failedKeepSeconds are deleted from Cloudflare, then from D1 (a Cloudflare failure keeps the row for the next run).
 * Disabled rows (admin takedown, admin-domain-tools.ts) are never touched: they keep answering 451 until enabled.
 */
export async function refreshCustomDomains(env: Env, t = now(), batch?: number) {
  if (!customDomainsEnabled(env)) return { skipped: true };
  const L = batch === undefined ? DOMAIN_LIMITS : { ...DOMAIN_LIMITS, refreshPerRun: batch, purgePerRun: batch };
  let failed = 0;
  let refreshed = 0;
  let live = 0;
  let purged = 0;

  const stale = (
    await env.DB.prepare("SELECT * FROM custom_domains WHERE status = 'pending' AND disabled_at IS NULL AND created_at < ? ORDER BY created_at LIMIT ?")
      .bind(t - L.pendingMaxSeconds, L.purgePerRun)
      .all<CustomDomainRow>()
  ).results;
  for (const r of stale) {
    if (r.cf_id) await deleteCustomHostname(env, r.cf_id);
    const errs = JSON.stringify([...parseErrors(r.verification_errors), "Not verified within 7 days: the CNAME record was never found."].slice(-5));
    await env.DB.prepare("UPDATE custom_domains SET status = 'failed', verification_errors = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(errs, t, r.id)
      .run();
    failed++;
  }

  const pending = (
    await env.DB.prepare("SELECT * FROM custom_domains WHERE status = 'pending' AND disabled_at IS NULL ORDER BY coalesce(checked_at, 0), created_at LIMIT ?")
      .bind(L.refreshPerRun)
      .all<CustomDomainRow>()
  ).results;
  for (const r of pending) {
    const { row } = await refreshPending(env, r, t);
    refreshed++;
    if (row.status === "active") live++;
  }

  const done = (
    await env.DB.prepare(
      "SELECT * FROM custom_domains WHERE disabled_at IS NULL AND ((status = 'redirecting' AND redirect_until < ?) OR (status = 'failed' AND updated_at < ?)) " +
        "ORDER BY updated_at LIMIT ?",
    )
      .bind(t, t - L.failedKeepSeconds, L.purgePerRun)
      .all<CustomDomainRow>()
  ).results;
  for (const r of done) {
    if (r.cf_id && !(await deleteCustomHostname(env, r.cf_id)).ok) continue;
    await env.DB.prepare("DELETE FROM custom_domains WHERE id = ? AND status = ?").bind(r.id, r.status).run();
    purged++;
  }
  return { failed, refreshed, live, purged };
}
