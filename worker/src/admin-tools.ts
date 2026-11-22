// Owner-only, read-only MCP tools: admin_overview, admin_billing, admin_usage, admin_devices, admin_errors, admin_lookup
// (mcp.ts `ownerOnly`: OWNER_ACCOUNT_IDS only; to every other caller they don't exist). Like billing-tools.ts, import this
// module through mcp.ts only (it imports mcp.ts back).
// Output: plain JSON, times in UTC ISO 8601, sizes in bytes. Never a key, token, signed URL, code or full email address.
import { z } from "zod";
import { actionView } from "./admin-takedown-tools";
import { getConfig } from "./config";
import { deviceHub } from "./device-hub";
import type { Env } from "./env";
import { accountLimits } from "./env";
import { compareVersions } from "./installer";
import { ToolError, tool } from "./mcp";
import { PLATFORM } from "./recorder-update";
import { storageStatus } from "./storage";
import { APP_TAG, StripeError, stripeApi } from "./stripe";
import { openActions } from "./takedown";
import { removedSql } from "./takedown-state";
import { log, now, redact } from "./util";

const DAY = 86400;
const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());
const isoDay = (t: number) => iso(t)!.slice(0, 10);
/** 00:00 UTC of the day t falls in. */
const dayStart = (t: number) => t - (t % DAY);

/** Recordings, and the bytes they keep in R2 (storage.ts: MP4 + transcription WAV while it exists). */
async function recordingTotals(env: Env) {
  const r = await env.DB.prepare(
    "SELECT count(*) AS recordings, count(DISTINCT account_id) AS accounts, coalesce(sum(bytes), 0) AS video_bytes, " +
      "coalesce(sum(audio_bytes), 0) AS audio_bytes FROM recordings",
  ).first<{ recordings: number; accounts: number; video_bytes: number; audio_bytes: number }>();
  const t = r ?? { recordings: 0, accounts: 0, video_bytes: 0, audio_bytes: 0 };
  return { ...t, storage_bytes: t.video_bytes + t.audio_bytes };
}

/** A custom domain that serves now (custom-host.ts: active and not taken down). `cd` is the custom_domains alias. */
const LIVE_DOMAIN = "cd.status = 'active' AND cd.disabled_at IS NULL";

/** Counts per key over `keys`, 0 where the query had none. */
const filled = (keys: string[], rows: { k: string; n: number }[]) => {
  const by = new Map(rows.map((r) => [r.k, r.n]));
  return keys.map((k) => ({ k, n: by.get(k) ?? 0 }));
};

/** "t***@domain.com": the first character and the domain only. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
}

/** Pages read per Stripe list (100 items each); past that the result says truncated. */
const STRIPE_PAGES = 10;

/** A Stripe list, page after page (GET only); truncated = Stripe had more than STRIPE_PAGES pages. */
async function stripeList<T extends { id: string }>(env: Env, path: string, params: Record<string, string>): Promise<{ data: T[]; truncated: boolean }> {
  const data: T[] = [];
  for (let page = 0; page < STRIPE_PAGES; page++) {
    const after = data.at(-1)?.id;
    const r = await stripeApi<{ data: T[]; has_more: boolean }>(env, "GET", path, { ...params, limit: "100", ...(after && { starting_after: after }) });
    data.push(...r.data);
    if (!r.has_more || !r.data.length) return { data, truncated: false };
  }
  return { data, truncated: true };
}

type StripePrice = {
  id: string;
  currency: string;
  unit_amount: number | null;
  recurring?: { interval: string; interval_count?: number; usage_type?: string } | null;
};
type StripeSub = { id: string; status: string; metadata?: Record<string, string> | null; items?: { data: { price: StripePrice; quantity?: number }[] } };
type StripeCharge = {
  id: string;
  status: string;
  customer: string | null;
  amount: number;
  currency: string;
  created: number;
  failure_code: string | null;
  failure_message: string | null;
  outcome?: { reason?: string | null; seller_message?: string | null } | null;
  billing_details?: { email?: string | null } | null;
  receipt_email?: string | null;
};
type StripeInvoice = {
  id: string;
  status: string;
  customer: string | null;
  customer_email: string | null;
  amount_due: number;
  currency: string;
  created: number;
  attempt_count: number;
  next_payment_attempt: number | null;
};

/** Months in one billing interval unit. */
const MONTHS: Record<string, number> = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 };
/** Stripe's zero-decimal currencies: their amounts are already whole units. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const major = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency) ? minor : minor / 100);
const MRR_STATUSES = new Set(["active", "past_due"]);

/** Which Recitbot plan a price is (the Worker's configured price ids). */
function priceRole(env: Env, priceId: string): string {
  const b = getConfig(env).billing;
  if (priceId === b.proPriceId) return "pro";
  if (priceId === b.teamsPriceId) return "teams";
  if (priceId === b.storageAddonPriceId) return "storage_addon";
  return "other";
}

/**
 * Stripe's half of admin_billing. The Stripe account is shared with other products: subscriptions count only with
 * metadata app=recitbot (stripe.ts), charges and invoices only for customers Recitbot created (accounts.stripe_customer_id).
 */
async function stripeBilling(env: Env, customers: Map<string, string | null>, since: number) {
  const subLists = await Promise.all(["active", "past_due", "unpaid"].map((status) => stripeList<StripeSub>(env, "/subscriptions", { status })));
  const [charges, invoices] = await Promise.all([
    stripeList<StripeCharge>(env, "/charges", { "created[gte]": String(since) }),
    stripeList<StripeInvoice>(env, "/invoices", { "created[gte]": String(since) }),
  ]);
  const subs = subLists.flatMap((l) => l.data).filter((s) => s.metadata?.app === APP_TAG);

  const mrr = new Map<string, number>();
  const prices = new Map<string, { price_id: string; plan: string; active: number; past_due: number; unpaid: number; quantity: number }>();
  const byStatus: Record<string, number> = { active: 0, past_due: 0, unpaid: 0 };
  let unpriced = 0;
  for (const s of subs) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    for (const item of s.items?.data ?? []) {
      const p = item.price;
      const qty = item.quantity ?? 1;
      const row = prices.get(p.id) ?? { price_id: p.id, plan: priceRole(env, p.id), active: 0, past_due: 0, unpaid: 0, quantity: 0 };
      row[s.status as "active" | "past_due" | "unpaid"]++;
      if (MRR_STATUSES.has(s.status)) row.quantity += qty;
      prices.set(p.id, row);
      if (!MRR_STATUSES.has(s.status)) continue;
      const per = p.recurring ? MONTHS[p.recurring.interval] : undefined;
      if (p.unit_amount === null || !per || p.recurring?.usage_type === "metered") {
        unpriced++;
        continue;
      }
      const monthly = (p.unit_amount * qty) / (per * (p.recurring!.interval_count ?? 1));
      mrr.set(p.currency, (mrr.get(p.currency) ?? 0) + monthly);
    }
  }

  const user = (customer: string | null) => (customer ? customers.get(customer) ?? null : null);
  const ourCustomer = (customer: string | null) => !!customer && customers.has(customer);
  return {
    mrr: [...mrr].map(([currency, minor]) => ({
      currency,
      monthly_amount: Math.round(major(minor, currency) * 100) / 100,
      monthly_amount_minor: Math.round(minor),
    })),
    unpriced_items: unpriced,
    subscriptions_by_status: byStatus,
    subscriptions_by_price: [...prices.values()].sort((a, b) => b.active - a.active),
    failed_charges: charges.data
      .filter((ch) => ch.status === "failed" && ourCustomer(ch.customer))
      .map((ch) => ({
        date: iso(ch.created),
        username: user(ch.customer),
        customer_email: maskEmail(ch.billing_details?.email ?? ch.receipt_email),
        amount: major(ch.amount, ch.currency),
        currency: ch.currency,
        reason: ch.failure_message ?? ch.failure_code ?? ch.outcome?.seller_message ?? ch.outcome?.reason ?? null,
      })),
    unpaid_invoices: invoices.data
      .filter((inv) => ourCustomer(inv.customer) && ((inv.status === "open" && inv.attempt_count > 0) || inv.status === "uncollectible"))
      .map((inv) => ({
        date: iso(inv.created),
        username: user(inv.customer),
        customer_email: maskEmail(inv.customer_email),
        amount: major(inv.amount_due, inv.currency),
        currency: inv.currency,
        status: inv.status,
        attempts: inv.attempt_count,
        next_attempt_at: iso(inv.next_payment_attempt),
        reason: inv.status === "uncollectible" ? "marked uncollectible" : `payment failed (${inv.attempt_count} attempt${inv.attempt_count === 1 ? "" : "s"})`,
      })),
    truncated: [...subLists, charges, invoices].some((l) => l.truncated),
  };
}

const BILLING_DAYS = 30;

type RecentDevice = {
  device_id: string;
  account_id: string;
  username: string | null;
  name: string | null;
  platform: string | null;
  platform_reported: number | null;
  last_seen_at: number;
};

/**
 * Whether the device is connected now, and the version its recorder announced on that connection (DeviceHub; null
 * when it isn't connected, or is a recorder older than 0.4 that announces none).
 */
async function liveRecorder(env: Env, d: RecentDevice): Promise<{ online: boolean; version: string | null }> {
  const info = await deviceHub(env, d.account_id)
    .recorderInfo(d.account_id, d.device_id)
    .catch(() => null);
  return info?.device_id === d.device_id ? { online: true, version: info.version } : { online: false, version: null };
}

/** DeviceHub calls in flight at once (admin_devices asks up to DEVICES_LISTED devices, admin_lookup up to 50). */
const HUB_CONCURRENCY = 10;

/** f over items, at most `limit` at a time, results in order. */
async function mapLimited<T, R>(items: T[], limit: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The latest recorder this server hands out for the platform; null when it has none (no Mac recorder pinned). */
const latestFor = (p: string | null): string | null => (p === "windows" || p === "macos" ? PLATFORM[p].latest || null : null);

const DEVICES_DAYS = 14;
const DEVICES_LISTED = 100;
const ERRORS_DAYS = 7;
const ERRORS_LISTED = 100;
const ERROR_TEXT_MAX = 300;
const USAGE_TOP = 25;
const LOOKUP_RECORDINGS = 20;
const LOOKUP_ERRORS = 20;

/** A stored error as the tools show it: redacted in full first, then trimmed (a secret cut at the edge still matches). */
const errorText = (e: string | null) => (e === null ? null : redact(e).slice(0, ERROR_TEXT_MAX));
/** recordings rows that failed or carry an error (alias r). */
const FAILED = "(r.status IN ('failed', 'error') OR r.error IS NOT NULL)";

type LookupAccount = {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  plan: string;
  plan_status: string | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  free_recordings_used: number;
  retention_hold: number;
  created_at: number;
  paired_at: number | null;
};
const LOOKUP_COLS =
  "a.id, a.username, a.display_name, a.email, a.plan, a.plan_status, a.current_period_end, a.cancel_at_period_end, " +
  "a.stripe_customer_id, a.stripe_subscription_id, a.free_recordings_used, a.retention_hold, a.created_at, a.paired_at";

/**
 * The one account admin_lookup (or admin_retention_hold) names. Email: the verified sign-in email (oauth_identities) first, else accounts.email
 * (unverified at signup); both case-insensitive. Several accounts with that email (sign-in addresses differing only in
 * case, or a shared signup email): AMBIGUOUS with candidates, never a silent pick.
 */
export async function lookupAccount(env: Env, a: { email?: string; username?: string; account_id?: string }): Promise<LookupAccount> {
  const db = env.DB;
  let rows: LookupAccount[];
  let verified = false;
  if (a.account_id !== undefined) {
    rows = (await db.prepare(`SELECT ${LOOKUP_COLS} FROM accounts a WHERE a.id = ?`).bind(a.account_id).all<LookupAccount>()).results;
  } else if (a.username !== undefined) {
    rows = (await db.prepare(`SELECT ${LOOKUP_COLS} FROM accounts a WHERE a.username = ?`).bind(a.username.toLowerCase()).all<LookupAccount>()).results;
  } else {
    const email = a.email!.toLowerCase();
    rows = (
      await db
        .prepare(
          `SELECT DISTINCT ${LOOKUP_COLS} FROM oauth_identities i JOIN accounts a ON a.id = i.account_id WHERE lower(i.email) = ? ` +
            "ORDER BY a.created_at, a.id LIMIT 10",
        )
        .bind(email)
        .all<LookupAccount>()
    ).results;
    verified = rows.length > 0;
    if (!rows.length) {
      rows = (await db.prepare(`SELECT ${LOOKUP_COLS} FROM accounts a WHERE lower(a.email) = ? ORDER BY a.created_at, a.id LIMIT 10`).bind(email).all<LookupAccount>()).results;
    }
  }
  if (!rows.length) throw new ToolError("NOT_FOUND", "No account matches.");
  if (rows.length > 1) {
    throw new ToolError("AMBIGUOUS", `${rows.length} accounts have that email (${verified ? "verified sign-in" : "unverified"}). Look one up by account_id.`, {
      candidates: rows.map((r) => ({ account_id: r.id, username: r.username, created_at: iso(r.created_at) })),
    });
  }
  return rows[0];
}

export const ADMIN_TOOLS = {
  admin_overview: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Owner only, read-only. Recitbot at a glance: accounts total; signups per UTC day (last 30 days) and per week (last " +
      "12 weeks, weeks start Monday); accounts per plan (accounts.plan as stored); Free-to-paid conversions; recordings " +
      "total and storage bytes (video + audio); custom domains (live = active and not taken down, pending, redirecting, " +
      "taken down, total); config_warnings (settings that leave a feature off: names, never values).",
    input: z.object({}),
    async run(_a, c) {
      const t = now();
      const today = dayStart(t);
      const daysSince = today - 29 * DAY;
      const thisWeek = today - ((new Date(today * 1000).getUTCDay() + 6) % 7) * DAY;
      const weeksSince = thisWeek - 11 * 7 * DAY;
      const db = c.env.DB;
      const [total, days, weeks, plans, conv, domains] = await db.batch([
        db.prepare("SELECT count(*) AS n FROM accounts"),
        db.prepare("SELECT date(created_at, 'unixepoch') AS k, count(*) AS n FROM accounts WHERE created_at >= ? GROUP BY k LIMIT 31").bind(daysSince),
        db
          .prepare("SELECT date(created_at, 'unixepoch', 'weekday 0', '-6 days') AS k, count(*) AS n FROM accounts WHERE created_at >= ? GROUP BY k LIMIT 13")
          .bind(weeksSince),
        db.prepare("SELECT plan AS k, count(*) AS n FROM accounts GROUP BY plan ORDER BY n DESC LIMIT 50"),
        db.prepare(
          "SELECT coalesce(sum(plan NOT IN ('free', 'owner')), 0) AS paid_now, " +
            "coalesce(sum(plan NOT IN ('free', 'owner') AND free_recordings_used > 0), 0) AS paid_now_used_free_recordings, " +
            "coalesce(sum(plan <> 'owner' AND stripe_subscription_id IS NOT NULL), 0) AS ever_subscribed, " +
            "coalesce(sum(plan = 'free' AND stripe_subscription_id IS NOT NULL), 0) AS subscribed_then_back_to_free, " +
            "coalesce(sum(plan <> 'owner'), 0) AS non_owner_accounts FROM accounts",
        ),
        db.prepare(
          `SELECT coalesce(sum(${LIVE_DOMAIN}), 0) AS live, coalesce(sum(cd.status = 'pending' AND cd.disabled_at IS NULL), 0) AS pending, ` +
            "coalesce(sum(cd.status = 'redirecting' AND cd.disabled_at IS NULL), 0) AS redirecting, " +
            "coalesce(sum(cd.disabled_at IS NOT NULL), 0) AS taken_down, count(*) AS total FROM custom_domains cd",
        ),
      ]);
      const n = (r: D1Result) => (r.results[0] as { n: number } | undefined)?.n ?? 0;
      const rows = (r: D1Result) => r.results as { k: string; n: number }[];
      const dayKeys = Array.from({ length: 30 }, (_, i) => isoDay(daysSince + i * DAY));
      const weekKeys = Array.from({ length: 12 }, (_, i) => isoDay(weeksSince + i * 7 * DAY));
      const cv = conv.results[0] as {
        paid_now: number;
        paid_now_used_free_recordings: number;
        ever_subscribed: number;
        subscribed_then_back_to_free: number;
        non_owner_accounts: number;
      };
      const plan: Record<string, number> = { free: 0, pro: 0, teams: 0, owner: 0 };
      for (const r of rows(plans)) plan[r.k] = r.n;
      const rec = await recordingTotals(c.env);
      return {
        accounts_total: n(total),
        signups_per_day: filled(dayKeys, rows(days)).map((r) => ({ day: r.k, signups: r.n })),
        signups_per_week: filled(weekKeys, rows(weeks)).map((r) => ({ week_starting: r.k, signups: r.n })),
        ...(getConfig(c.env).billing.enabled && {
          accounts_by_plan: plan,
          conversions: {
            ...cv,
            ever_subscribed_rate: cv.non_owner_accounts ? Math.round((cv.ever_subscribed / cv.non_owner_accounts) * 10000) / 10000 : 0,
            meaning:
              "Every account starts on Free (accounts.plan defaults to 'free'; there is no paid signup), so a conversion is " +
              "an account that took a paid plan later. paid_now = accounts on any plan other than free and owner today; " +
              "paid_now_used_free_recordings = of those, the ones that had started at least one Free recording first; " +
              "ever_subscribed = non-owner accounts that ever got a Stripe subscription (still paying or not); " +
              "subscribed_then_back_to_free = subscribed once and are on Free again; ever_subscribed_rate = " +
              "ever_subscribed / non_owner_accounts.",
          },
        }),
        recordings_total: rec.recordings,
        storage_bytes: rec.storage_bytes,
        video_bytes: rec.video_bytes,
        audio_bytes: rec.audio_bytes,
        custom_domains: domains.results[0] as { live: number; pending: number; redirecting: number; taken_down: number; total: number },
        config_warnings: getConfig(c.env).warnings,
      };
    },
  }),

  admin_billing: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Owner only, read-only. Recitbot billing. From Stripe (Recitbot's subscriptions and customers only; the Stripe " +
      "account is shared): MRR per currency (active + past_due subscriptions at list price, before discounts and tax, " +
      "normalised to one month), subscriptions per price and status, and the last " +
      `${BILLING_DAYS} days' failed charges and unpaid invoices (date, username, masked email, amount, reason). From D1: ` +
      "subscribed accounts per plan and status, past_due/unpaid accounts, storage add-ons. If Stripe fails, the D1 part " +
      "still comes back with stripe_error set.",
    input: z.object({}),
    async run(_a, c) {
      const db = c.env.DB;
      const [statuses, overdue, addons, customerRows] = await db.batch([
        db.prepare("SELECT plan, plan_status, count(*) AS accounts FROM accounts WHERE stripe_subscription_id IS NOT NULL GROUP BY plan, plan_status ORDER BY accounts DESC LIMIT 100"),
        db.prepare(
          "SELECT username, plan, plan_status, current_period_end FROM accounts WHERE plan_status IN ('past_due', 'unpaid') ORDER BY current_period_end DESC LIMIT 50",
        ),
        db.prepare("SELECT coalesce(sum(storage_addons), 0) AS n FROM accounts"),
        db.prepare("SELECT stripe_customer_id AS customer, username FROM accounts WHERE stripe_customer_id IS NOT NULL LIMIT 10000"),
      ]);
      const d1 = {
        subscribed_accounts: statuses.results,
        past_due_or_unpaid_accounts: (overdue.results as { username: string | null; plan: string; plan_status: string; current_period_end: number | null }[]).map((r) => ({
          ...r,
          current_period_end: iso(r.current_period_end),
        })),
        storage_addons: (addons.results[0] as { n: number }).n,
      };
      const customers = new Map((customerRows.results as { customer: string; username: string | null }[]).map((r) => [r.customer, r.username]));
      try {
        return { d1, stripe: await stripeBilling(c.env, customers, now() - BILLING_DAYS * DAY), stripe_error: null };
      } catch (e) {
        if (!(e instanceof StripeError)) log("error", "admin_billing: stripe failed", { err: String(e) });
        const stripe_error = e instanceof StripeError ? `Stripe error ${e.status}: ${e.message}` : "Stripe could not be reached.";
        return { d1, stripe: null, stripe_error };
      }
    },
  }),

  admin_usage: tool({
    auth: true,
    ownerOnly: true,
    description:
      `Owner only, read-only. Storage and recordings per account: the top ${USAGE_TOP} accounts by stored bytes (video + ` +
      "audio) with username, plan, created_at and live custom domain (or null), plus totals across all accounts.",
    input: z.object({}),
    async run(_a, c) {
      const top = await c.env.DB.prepare(
        "SELECT a.id AS account_id, a.username, a.plan, a.created_at, count(*) AS recordings, sum(r.bytes) AS video_bytes, " +
          "sum(r.audio_bytes) AS audio_bytes, sum(r.bytes + r.audio_bytes) AS storage_bytes, " +
          `(SELECT cd.hostname FROM custom_domains cd WHERE cd.account_id = a.id AND ${LIVE_DOMAIN} LIMIT 1) AS custom_domain FROM recordings r ` +
          "JOIN accounts a ON a.id = r.account_id GROUP BY a.id ORDER BY storage_bytes DESC, recordings DESC LIMIT ?",
      )
        .bind(USAGE_TOP)
        .all<{
          account_id: string;
          username: string | null;
          plan: string;
          created_at: number;
          recordings: number;
          video_bytes: number;
          audio_bytes: number;
          storage_bytes: number;
          custom_domain: string | null;
        }>();
      const totals = await recordingTotals(c.env);
      return {
        top_accounts_by_storage: top.results.map(({ plan, ...r }) => ({
          ...r,
          ...(getConfig(c.env).billing.enabled && { plan }),
          created_at: iso(r.created_at),
        })),
        totals: {
          recordings: totals.recordings,
          accounts_with_recordings: totals.accounts,
          storage_bytes: totals.storage_bytes,
          video_bytes: totals.video_bytes,
          audio_bytes: totals.audio_bytes,
        },
      };
    },
  }),

  admin_devices: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Owner only, read-only. Paired recorders: counts per platform; the devices seen in the last " +
      `${DEVICES_DAYS} days (newest ${DEVICES_LISTED}) with username, platform and the recorder version each reports; ` +
      "counts per platform and version; and the stuck ones: seen in that window, running an older recorder than this " +
      "server's latest for its platform. Versions are known only for devices connected now (see version_source).",
    input: z.object({}),
    async run(_a, c) {
      const t = now();
      const since = t - DEVICES_DAYS * DAY;
      const db = c.env.DB;
      const [platforms, neverSeen, recentCount, recentRows] = await db.batch([
        db.prepare("SELECT platform AS k, count(*) AS n FROM devices WHERE revoked_at IS NULL GROUP BY platform ORDER BY n DESC LIMIT 20"),
        db.prepare("SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL AND last_seen_at IS NULL"),
        db.prepare("SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL AND last_seen_at >= ?").bind(since),
        db
          .prepare(
            "SELECT d.id AS device_id, d.account_id, a.username, d.name, d.platform, d.platform_reported, d.last_seen_at " +
              "FROM devices d LEFT JOIN accounts a ON a.id = d.account_id WHERE d.revoked_at IS NULL AND d.last_seen_at >= ? " +
              "ORDER BY d.last_seen_at DESC LIMIT ?",
          )
          .bind(since, DEVICES_LISTED),
      ]);
      const n = (r: D1Result) => (r.results[0] as { n: number }).n;
      const recent = recentRows.results as RecentDevice[];
      const live = await mapLimited(recent, HUB_CONCURRENCY, (d) => liveRecorder(c.env, d));
      const devices = recent.map((d, i) => {
        const { online, version } = live[i];
        const latest = latestFor(d.platform);
        return {
          device_id: d.device_id,
          username: d.username,
          name: d.name,
          platform: d.platform,
          platform_reported: d.platform_reported === 1,
          version,
          latest,
          online,
          outdated: version !== null && latest !== null && compareVersions(version, latest) < 0,
          last_seen_at: iso(d.last_seen_at),
        };
      });
      const byVersion = new Map<string, { platform: string | null; version: string; devices: number }>();
      for (const d of devices) {
        const k = `${d.platform}|${d.version ?? "unknown"}`;
        const v = byVersion.get(k) ?? { platform: d.platform, version: d.version ?? "unknown", devices: 0 };
        v.devices++;
        byVersion.set(k, v);
      }
      return {
        paired_devices: (platforms.results as { k: string | null; n: number }[]).reduce((s, r) => s + r.n, 0),
        by_platform: Object.fromEntries((platforms.results as { k: string | null; n: number }[]).map((r) => [r.k ?? "unknown", r.n])),
        never_seen: n(neverSeen),
        latest: { windows: latestFor("windows"), macos: latestFor("macos") },
        seen_since: iso(since),
        seen_in_window: n(recentCount),
        listed: devices.length,
        online_now: devices.filter((d) => d.online).length,
        by_version: [...byVersion.values()].sort((a, b) => b.devices - a.devices),
        stuck: devices.filter((d) => d.outdated).map(({ device_id, username, name, platform, version, latest, last_seen_at }) => ({
          device_id,
          username,
          name,
          platform,
          version,
          latest,
          last_seen_at,
        })),
        devices,
        version_source:
          "The devices table stores no recorder version. version is what the recorder announced on its live connection " +
          "(its account's DeviceHub), so only devices connected now have one; the rest are 'unknown' in by_version and " +
          "can't be judged stuck until they reconnect.",
        last_seen_source:
          "devices.last_seen_at: written when the recorder connects or disconnects (not on every heartbeat), so a device " +
          "connected for a long time shows its connect time. never_seen = paired but no connection recorded.",
      };
    },
  }),

  admin_errors: tool({
    auth: true,
    ownerOnly: true,
    description:
      `Owner only, read-only. Recording failures in the last ${ERRORS_DAYS} days: the newest ${ERRORS_LISTED} recordings ` +
      `with status failed/error or an error set (recording_id, username, status, error trimmed to ${ERROR_TEXT_MAX} ` +
      "characters, created_at), counts per error, and how many recordings got no transcript (transcription failed or " +
      "was refused by a cap).",
    input: z.object({}),
    async run(_a, c) {
      const since = now() - ERRORS_DAYS * DAY;
      const failed = `r.created_at >= ? AND ${FAILED}`;
      const db = c.env.DB;
      const [list, counts, total, untranscribed] = await db.batch([
        db
          .prepare(
            "SELECT r.id AS recording_id, a.username, r.status, r.error, r.created_at " +
              `FROM recordings r LEFT JOIN accounts a ON a.id = r.account_id WHERE ${failed} ORDER BY r.created_at DESC LIMIT ?`,
          )
          .bind(since, ERRORS_LISTED),
        db
          .prepare(`SELECT r.error, count(*) AS n FROM recordings r WHERE ${failed} GROUP BY r.error ORDER BY n DESC LIMIT 200`)
          .bind(since),
        db.prepare(`SELECT count(*) AS n FROM recordings r WHERE ${failed}`).bind(since),
        db.prepare("SELECT count(*) AS n FROM recordings WHERE created_at >= ? AND transcript_status = 'unavailable'").bind(since),
      ]);
      const n = (r: D1Result) => (r.results[0] as { n: number }).n;
      // Redacted in full, then trimmed (errorText); errors that read the same after that count as one.
      const byError = new Map<string | null, number>();
      for (const r of counts.results as { error: string | null; n: number }[]) byError.set(errorText(r.error), (byError.get(errorText(r.error)) ?? 0) + r.n);
      return {
        since: iso(since),
        failed_recordings: n(total),
        recent: (list.results as { recording_id: string; username: string | null; status: string; error: string | null; created_at: number }[]).map(
          (r) => ({ ...r, error: errorText(r.error), created_at: iso(r.created_at) }),
        ),
        counts_by_error: [...byError]
          .map(([error, recordings]) => ({ error, recordings }))
          .sort((a, b) => b.recordings - a.recordings)
          .slice(0, 50),
        transcription_unavailable: n(untranscribed),
        other_error_logs:
          "None: D1 holds no other error log (Worker errors go to Cloudflare Workers logs, not the database).",
      };
    },
  }),
  admin_lookup: tool({
    auth: true,
    ownerOnly: true,
    description:
      "Owner only, read-only. One account by email, username or account_id (exactly one): plan, status (active or " +
      "suspended), retention_hold (Free auto-delete and expiry paused), Stripe customer and subscription ids (ids only), usage (recordings, storage, Free recordings used), " +
      "devices (each with online now, the recorder version it announced while connected, last seen and its last " +
      `recording), last_recording_at, the newest ${LOOKUP_ERRORS} failed recordings since signup (recent_errors, error ` +
      `redacted and trimmed to ${ERROR_TEXT_MAX} characters), the newest ${LOOKUP_RECORDINGS} recordings (id, title, ` +
      "status, created_at, shared, removed), custom domains and open admin takedowns. Email is matched against the " +
      "verified sign-in email first, then the signup email, and shown masked. Never a key, token, signed URL or transcript.",
    input: z
      .object({
        email: z.string().trim().min(3).max(320).optional().describe("Sign-in or signup email."),
        username: z.string().trim().min(1).max(64).optional().describe("The <username> in video URLs."),
        account_id: z.string().regex(/^[A-Za-z0-9]{10,40}$/, "invalid account_id").optional(),
      })
      .refine((a) => [a.email, a.username, a.account_id].filter((x) => x !== undefined).length === 1, "Pass exactly one of email, username, account_id."),
    async run(a, c) {
      const acct = await lookupAccount(c.env, a);
      const db = c.env.DB;
      const [devices, recent, totals, domains, perDevice, errors, errorCount] = await db.batch([
        db
          .prepare(
            "SELECT id AS device_id, name, platform, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? " +
              "ORDER BY revoked_at IS NOT NULL, coalesce(last_seen_at, created_at) DESC LIMIT 50",
          )
          .bind(acct.id),
        db
          .prepare(
            `SELECT r.id AS recording_id, r.title, r.status, r.created_at, r.shared_at IS NOT NULL AS shared, ${removedSql("r.id", "r.account_id")} AS removed ` +
              "FROM recordings r WHERE r.account_id = ? ORDER BY r.created_at DESC LIMIT ?",
          )
          .bind(acct.id, LOOKUP_RECORDINGS),
        db.prepare("SELECT count(*) AS recordings, coalesce(sum(shared_at IS NOT NULL), 0) AS shared FROM recordings WHERE account_id = ?").bind(acct.id),
        db
          .prepare("SELECT hostname, status, disabled_at, disabled_reason, live_at, created_at FROM custom_domains WHERE account_id = ? ORDER BY created_at DESC LIMIT 20")
          .bind(acct.id),
        db.prepare("SELECT device_id, max(created_at) AS last FROM recordings WHERE account_id = ? GROUP BY device_id LIMIT 500").bind(acct.id),
        db
          .prepare(
            "SELECT r.id AS recording_id, r.device_id, r.status, r.error, r.transcript_status, r.created_at FROM recordings r " +
              `WHERE r.account_id = ? AND ${FAILED} ORDER BY r.created_at DESC LIMIT ?`,
          )
          .bind(acct.id, LOOKUP_ERRORS),
        db.prepare(`SELECT count(*) AS n FROM recordings r WHERE r.account_id = ? AND ${FAILED}`).bind(acct.id),
      ]);
      const limits = await accountLimits(c.env, acct.id);
      const billing = getConfig(c.env).billing.enabled;
      const storage = await storageStatus(c.env, acct.id, limits);
      const open = await openActions(c.env, acct.id);
      const t = totals.results[0] as { recordings: number; shared: number };
      const field = a.account_id !== undefined ? "account_id" : a.username !== undefined ? "username" : "email";
      log("warn", "admin: account looked up", { by: c.principal!.accountId, account_id: acct.id, field });
      type Dev = { device_id: string; name: string | null; platform: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null };
      type Err = { recording_id: string; device_id: string; status: string; error: string | null; transcript_status: string; created_at: number };
      const lastByDevice = new Map((perDevice.results as { device_id: string; last: number }[]).map((r) => [r.device_id, r.last]));
      const lastRecording = Math.max(0, ...lastByDevice.values()) || null;
      const devs = devices.results as Dev[];
      // Revoked devices can't be connected: no DeviceHub call for them.
      const live = await mapLimited(devs, HUB_CONCURRENCY, async (d) =>
        d.revoked_at === null
          ? liveRecorder(c.env, { ...d, account_id: acct.id, username: acct.username, platform_reported: null, last_seen_at: d.last_seen_at ?? 0 })
          : { online: false, version: null },
      );
      type Rec = { recording_id: string; title: string | null; status: string; created_at: number; shared: number; removed: number };
      type Dom = { hostname: string; status: string; disabled_at: number | null; disabled_reason: string | null; live_at: number | null; created_at: number };
      return {
        account: {
          account_id: acct.id,
          username: acct.username,
          display_name: acct.display_name,
          email: maskEmail(acct.email),
          created_at: iso(acct.created_at),
          paired_at: iso(acct.paired_at),
        },
        ...(billing
          ? {
              plan: {
                plan: acct.plan,
                tier: limits.tier,
                plan_status: acct.plan_status,
                current_period_end: iso(acct.current_period_end),
                cancel_at_period_end: !!acct.cancel_at_period_end,
              },
            }
          : { owner: limits.tier === "owner" }),
        status: open.some((x) => x.target_type === "account" && x.target_id === acct.id) ? "suspended" : "active",
        retention_hold: acct.retention_hold === 1,
        ...(billing && { stripe: { customer_id: acct.stripe_customer_id, subscription_id: acct.stripe_subscription_id } }),
        usage: {
          recordings: t.recordings,
          shared_recordings: t.shared,
          storage_used_bytes: storage.used,
          storage_limit_bytes: storage.limit,
          ...(billing && { storage_addons: storage.addons }),
          free_recordings_used: acct.free_recordings_used,
          free_recordings_limit: limits.freeRecordings,
        },
        devices: devs.map((d, i) => ({
          ...d,
          created_at: iso(d.created_at),
          last_seen_at: iso(d.last_seen_at),
          revoked_at: iso(d.revoked_at),
          online: live[i].online,
          version: live[i].version,
          last_recording_at: iso(lastByDevice.get(d.device_id) ?? null),
        })),
        version_source:
          "The devices table stores no recorder version. version is what the recorder announced on its live connection, so " +
          "it is null for a device that isn't connected now (or a recorder older than 0.4). last_seen_at is written on " +
          "connect and disconnect, not on every heartbeat.",
        last_recording_at: iso(lastRecording),
        failed_recordings: (errorCount.results[0] as { n: number }).n,
        recent_errors: (errors.results as Err[]).map((r) => ({ ...r, error: errorText(r.error), created_at: iso(r.created_at) })),
        recent_recordings: (recent.results as Rec[]).map((r) => ({ ...r, created_at: iso(r.created_at), shared: !!r.shared, removed: !!r.removed })),
        custom_domains: (domains.results as Dom[]).map((d) => ({
          hostname: d.hostname,
          status: d.status,
          live: d.status === "active" && d.disabled_at === null,
          disabled_at: iso(d.disabled_at),
          disabled_reason: d.disabled_reason,
          live_since: iso(d.live_at),
          created_at: iso(d.created_at),
        })),
        open_admin_actions: open.map(actionView),
      };
    },
  }),
};
