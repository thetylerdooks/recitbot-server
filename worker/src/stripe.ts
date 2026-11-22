// Stripe billing (Recitbot Pro): REST calls (form-encoded fetch, no SDK) and the webhook that sets accounts.plan.
// The Stripe account is shared with other products: only objects with metadata app=recitbot are ours, and only
// customers Recitbot created (stripe_customer_id, stored by upgrade, never taken from a webhook) get a billing portal.
// Accounts on plan 'owner' are never touched: every event for one is acknowledged and changes nothing (also guarded in SQL).
// Storage add-ons (add_storage, billing-tools.ts) are an item on the same subscription: the webhook keeps
// accounts.storage_addons equal to its quantity, and applies a completed add-on Checkout Session (applyStorageCheckout).
// Plans by price (planPrice, the one mapping): STRIPE_PRO_PRICE_ID and STRIPE_PRO_YEARLY_PRICE_ID -> pro,
// STRIPE_TEAMS_PRICE_ID and STRIPE_TEAMS_YEARLY_PRICE_ID -> teams; accounts.billing_interval keeps which interval. A plan
// change that loses the custom domain (Pro or Teams -> Free) retires the account's domains (domain-retire.ts); monthly
// <-> yearly keeps the plan, so it never does. The storage add-on price is monthly: it is only added to monthly plans.
// No card data ever passes through here.
import { getConfig } from "./config";
import { retireAccountDomains } from "./domain-retire";
import { canUseCustomBranding } from "./entitlements";
import { isOwnerAccount, LIMITS, type Env, type Plan } from "./env";
import { KEEP_FOREVER } from "./share";
import { json, log, now } from "./util";

export const STRIPE_API = "https://api.stripe.com/v1";
export const APP_TAG = "recitbot";
/** Webhook signatures older (or newer) than this are refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Test seam: tests replace fetch to stand in for the Stripe API. */
export const stripeDeps = { fetch: (input: string, init: RequestInit) => fetch(input, init) };

export class StripeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Billing is on (config.ts): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRO_PRICE_ID are all set. */
export const billingConfigured = (env: Env) => getConfig(env).billing.enabled;
/** What every billing entry point answers while billing is off. */
export const BILLING_NOT_ENABLED = "Billing is not enabled on this server.";

/** Stripe REST call. params are already flattened to Stripe's bracket keys (line_items[0][price]). */
export async function stripeApi<T = Record<string, any>>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> = {},
  idempotencyKey?: string,
): Promise<T> {
  if (!billingConfigured(env) || !env.STRIPE_SECRET_KEY) throw new StripeError(503, "billing not configured");
  const body = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const url = `${STRIPE_API}${path}${method === "GET" && body ? `?${body}` : ""}`;
  const res = await stripeDeps.fetch(url, { method, headers, body: method === "POST" ? body : undefined });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    // Only Stripe's error type/code: never the request (it names the customer) or the key.
    log("warn", "stripe api error", { path: path.split("/").slice(0, 3).join("/"), status: res.status, type: data?.error?.type, code: data?.error?.code });
    throw new StripeError(res.status, String(data?.error?.code ?? data?.error?.type ?? "stripe_error"));
  }
  return data as T;
}

// ---------- webhook signature ----------

const enc = new TextEncoder();

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stripe-Signature check: t=<unix>,v1=<hex>[,v1=...]; HMAC-SHA256 of "<t>.<raw body>", within the tolerance. */
export async function verifyStripeSignature(secret: string, header: string | null, body: string, t = now()): Promise<boolean> {
  if (!header) return false;
  let ts: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) ts = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (ts === null || !v1.length || Math.abs(t - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = await hmacSha256Hex(secret, `${ts}.${body}`);
  let ok = false;
  for (const s of v1) ok = timingSafeEqualHex(expected, s) || ok;
  return ok;
}

/** Test helper and docs: the header Stripe would send for body at t. */
export async function signStripePayload(secret: string, body: string, t = now()): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

// ---------- plan state ----------

/** Subscription statuses that grant the paid plan. past_due keeps it while Stripe retries the card. */
export const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);
/** Statuses that end it (incomplete changes nothing: the first payment hasn't happened yet). */
const ENDED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

export type PaidPlan = Exclude<Plan, "free">;
/** How often a plan price bills. Same plan either way: switching between them keeps the plan and its custom domain. */
export type Billing = "monthly" | "yearly";

type BillingConfig = ReturnType<typeof getConfig>["billing"];
/** Every plan price, by config field (STRIPE_*_PRICE_ID): the one list price id <-> (plan, billing) lookups go through. */
const PLAN_PRICES: readonly { key: keyof BillingConfig & `${string}PriceId`; plan: PaidPlan; billing: Billing }[] = [
  { key: "proPriceId", plan: "pro", billing: "monthly" },
  { key: "proYearlyPriceId", plan: "pro", billing: "yearly" },
  { key: "teamsPriceId", plan: "teams", billing: "monthly" },
  { key: "teamsYearlyPriceId", plan: "teams", billing: "yearly" },
];

/** The plan and billing interval a price sells; null = not one of our plan prices (unset ids never match). */
export function planPrice(env: Env, priceId: string | undefined): { plan: PaidPlan; billing: Billing } | null {
  if (!priceId) return null;
  const b = getConfig(env).billing;
  const p = PLAN_PRICES.find((p) => b[p.key] === priceId);
  return p ? { plan: p.plan, billing: p.billing } : null;
}

/** The paid plan a price sells (yearly and monthly prices of a plan alike); null = not one of our plan prices. */
export const planForPrice = (env: Env, priceId: string | undefined): PaidPlan | null => planPrice(env, priceId)?.plan ?? null;

/** The configured price id for a plan at a billing interval; undefined when that price isn't configured. */
export function priceFor(env: Env, plan: PaidPlan, billing: Billing): string | undefined {
  return getConfig(env).billing[PLAN_PRICES.find((p) => p.plan === plan && p.billing === billing)!.key] ?? undefined;
}

/**
 * Checkout line item for a plan: its price at that interval, quantity 1 for Pro and the seat count for Teams (per user).
 * null when the price isn't configured.
 */
export function checkoutLineItem(env: Env, plan: PaidPlan, billing: Billing, seats = 1): Record<string, string> | null {
  const price = priceFor(env, plan, billing);
  if (!price) return null;
  const quantity = plan === "teams" ? Math.max(1, Math.floor(seats)) : 1;
  return { "line_items[0][price]": price, "line_items[0][quantity]": String(quantity) };
}

export type SubItem = { id?: string; quantity?: number; price?: { id?: string } };
export const subItems = (sub: Record<string, any>): SubItem[] => (Array.isArray(sub?.items?.data) ? sub.items.data : []);
/** The storage add-on price (STRIPE_STORAGE_ADDON_PRICE_ID), null when unset or billing is off. */
export const addonPriceId = (env: Env): string | null => getConfig(env).billing.storageAddonPriceId;
const isAddonItem = (env: Env, i: SubItem) => !!addonPriceId(env) && i.price?.id === addonPriceId(env);

/**
 * The plan's item: the first item on a known plan price (Pro, Teams), else the first that is not a storage
 * add-on (its price then maps to no plan).
 */
export const planItem = (env: Env, sub: Record<string, any>): SubItem | undefined =>
  subItems(sub).find((i) => planForPrice(env, i.price?.id) !== null) ?? subItems(sub).find((i) => !isAddonItem(env, i));

/** Storage add-ons on the subscription (quantity of the add-on price); null when that price isn't configured. */
export function addonQuantity(env: Env, sub: Record<string, any>): number | null {
  if (!addonPriceId(env)) return null;
  return subItems(sub)
    .filter((i) => isAddonItem(env, i))
    .reduce((n, i) => n + Math.max(0, Math.floor(Number(i.quantity ?? 1)) || 0), 0);
}

type Metadata = Record<string, string> | null | undefined;
const ours = (m: Metadata) => m?.app === APP_TAG;

/** Invoices carry their subscription's metadata (newer API: parent.subscription_details; older: subscription_details). */
const invoiceMetadata = (inv: Record<string, any>): Metadata => inv?.parent?.subscription_details?.metadata ?? inv?.subscription_details?.metadata;
const invoiceSubscription = (inv: Record<string, any>): string | null => {
  const s = inv?.parent?.subscription_details?.subscription ?? inv?.subscription;
  return typeof s === "string" ? s : (s?.id ?? null);
};
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : ((v as { id?: string } | null)?.id ?? null));

/** current_period_end moved onto subscription items in newer API versions; read either. */
function periodEnd(sub: Record<string, any>): number | null {
  const v = sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;
  return typeof v === "number" ? v : null;
}

type AccountBilling = { id: string; plan: string; stripe_customer_id: string | null; stripe_subscription_id: string | null };

async function billingRow(env: Env, accountId: string | undefined | null): Promise<AccountBilling | null> {
  if (!accountId) return null;
  return env.DB.prepare("SELECT id, plan, stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<AccountBilling>();
}

/** The subscription as Stripe has it now; null when Stripe has no such subscription. Other failures throw (Stripe retries). */
async function currentSubscription(env: Env, id: string): Promise<Record<string, any> | null> {
  try {
    return await stripeApi(env, "GET", `/subscriptions/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Sets the account's plan from subscription `subId` as Stripe has it NOW (re-fetched), so events arriving late or out
 * of order can't move the plan backwards. Only Recitbot subscriptions (metadata app) of the account they name; when the
 * event names an account too, both must agree. A subscription other than the account's stored one is ignored unless
 * the account has none, or `adopt` (checkout.session.completed of that account: a new paid subscription replaces an
 * ended one). Going from a paid plan to free moves the account's keep-forever recordings onto Free retention counted
 * from now (deleted by the hourly cleanup 7 days later, never on the spot); owners never get here.
 */
async function applySubscription(env: Env, subId: string, opts: { accountId?: string | null; adopt?: boolean; deleted?: Record<string, any> } = {}): Promise<string> {
  // An owner named by the (signed) event is never touched, and costs no Stripe call.
  const named = await billingRow(env, opts.accountId);
  if (named && (named.plan === "owner" || isOwnerAccount(env, named.id))) return "owner";
  // A deleted subscription Stripe no longer returns is canceled.
  const sub = (await currentSubscription(env, subId)) ?? (opts.deleted ? { ...opts.deleted, status: "canceled" } : null);
  if (!sub) return "missing";
  if (!ours(sub.metadata)) return "ignored";
  const accountId: string | undefined = sub.metadata?.account_id;
  if (opts.accountId && opts.accountId !== accountId) return "mismatch";
  const acct = await billingRow(env, accountId);
  if (!acct) return "no_account";
  if (acct.plan === "owner" || isOwnerAccount(env, acct.id)) return "owner";
  const status = String(sub.status ?? "");
  const paid = PAID_STATUSES.has(status);
  const adopt = !!opts.adopt && paid;
  if (acct.stripe_subscription_id && acct.stripe_subscription_id !== sub.id && !adopt) return "stale";
  const ended = ENDED_STATUSES.has(status);
  let plan: Plan | null = ended ? "free" : null;
  let billing: Billing | null = null;
  if (paid) {
    const price = planItem(env, sub)?.price?.id;
    const known = planPrice(env, price);
    plan = known?.plan ?? null;
    billing = known?.billing ?? null;
    // A price that sells no plan we know (misconfigured ids): the plan stays as it is, status and add-ons still sync.
    if (!plan) log("error", "stripe subscription on an unknown plan price, plan unchanged", { subscription: sub.id, price: price ?? null });
  }
  // Storage add-ons: the add-on item's quantity while paid, none once ended (unchanged while incomplete, or when the
  // add-on price isn't configured and can't be recognized).
  const addons = paid ? addonQuantity(env, sub) : ENDED_STATUSES.has(status) ? 0 : null;
  const t = now();
  // Same conditions in SQL: a concurrent event that stored another subscription meanwhile wins over this one.
  const guard = "id = ? AND plan <> 'owner' AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ? OR ?)";
  const res = await env.DB.batch([
    env.DB.prepare(
      "UPDATE accounts SET plan = coalesce(?, plan), plan_status = ?, current_period_end = coalesce(?, current_period_end), " +
        "stripe_subscription_id = ?, cancel_at_period_end = ?, storage_addons = coalesce(?, storage_addons), " +
        `billing_interval = CASE WHEN ? THEN NULL ELSE coalesce(?, billing_interval) END WHERE ${guard}`,
    ).bind(plan, status, periodEnd(sub), sub.id, sub.cancel_at_period_end ? 1 : 0, addons, ended ? 1 : 0, billing, acct.id, sub.id, adopt ? 1 : 0),
    // Paid -> free: keep-forever recordings get Free retention counted from now (the hourly cleanup deletes them later).
    env.DB.prepare(
      "UPDATE recordings SET expires_at = ? WHERE account_id = ? AND expires_at >= ? AND ? IN ('pro', 'teams') AND " +
        "EXISTS (SELECT 1 FROM accounts WHERE id = ? AND plan = 'free' AND stripe_subscription_id = ?)",
    ).bind(t + LIMITS.retentionSeconds, acct.id, KEEP_FOREVER, acct.plan, acct.id, sub.id),
  ]);
  if (res[0].meta.changes !== 1) return "stale";
  // Custom domains go with the plan: whenever the account's plan (as now stored) has none, its live hostnames redirect
  // to our own links. A no-op without any; run on every such event, so Stripe's retry after a failure here still does it.
  if (!canUseCustomBranding(plan ?? acct.plan)) {
    const n = await retireAccountDomains(env, acct.id, t);
    if (n) log("info", "custom domains retired on plan change", { account: acct.id, from: acct.plan, to: plan ?? acct.plan, domains: n });
  }
  return plan ?? "unchanged";
}

/** metadata.purpose of add_storage's Checkout Sessions (mode setup). */
export const STORAGE_ADDON_PURPOSE = "storage_addon";
/** Subscription statuses add_storage may add to (not past_due: the card on file is already failing). */
export const ADDON_STATUSES = new Set(["active", "trialing"]);

/**
 * add_storage's Checkout Session completed (mode setup: the user confirmed the add-on and its price on Stripe's page and
 * gave a card). Adds one add-on to the subscription the session was made for: the add-on item's quantity + 1, or the
 * item itself at quantity 1, prorated and invoiced at once, charged to the card just given (it becomes the
 * subscription's default). Applied at most once per session (storage_addon_sessions, claimed before the Stripe call
 * and released only when that call fails, so Stripe's retry can't add a second one). The account's add-on count is then
 * synced from the subscription as Stripe returns it (applySubscription).
 */
async function applyStorageCheckout(env: Env, obj: Record<string, any>): Promise<string> {
  const accountId: string | undefined = obj.metadata?.account_id;
  if (!accountId || obj.client_reference_id !== accountId) return "mismatch";
  if (obj.status !== "complete") return "incomplete";
  const price = addonPriceId(env);
  if (!price) {
    log("error", "storage add-on checkout completed but STRIPE_STORAGE_ADDON_PRICE_ID is unset", { session: obj.id });
    return "addon_unconfigured";
  }
  const acct = await billingRow(env, accountId);
  if (!acct) return "no_account";
  if (acct.plan === "owner" || isOwnerAccount(env, acct.id)) return "owner";
  const subId: string | undefined = obj.metadata?.subscription_id;
  if (!subId || acct.stripe_subscription_id !== subId) return "stale";
  const sub = await currentSubscription(env, subId);
  if (!sub || !ours(sub.metadata) || sub.metadata?.account_id !== accountId) return "mismatch";
  if (!ADDON_STATUSES.has(String(sub.status ?? ""))) return "not_active";
  // The add-on price is monthly and a subscription's items bill on one interval: never put it on a yearly plan (Stripe
  // would refuse, and its retries would fail the same way). add_storage refuses yearly plans up front; this covers a
  // plan switched to yearly after the add-on page was opened. Nothing was charged (the session is setup mode).
  if (planPrice(env, planItem(env, sub)?.price?.id)?.billing === "yearly") {
    log("warn", "storage add-on checkout on a yearly plan, not added", { session: obj.id, subscription: subId });
    return "addon_monthly_only";
  }

  const claim = await env.DB.prepare("INSERT OR IGNORE INTO storage_addon_sessions (session_id, account_id, subscription_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(String(obj.id), accountId, subId, now())
    .run();
  if (claim.meta.changes !== 1) return `already_applied:${await applySubscription(env, subId, { accountId })}`;
  // The update also stamps the session on the subscription: a retry after an update whose answer was lost sees it there.
  if (sub.metadata?.storage_addon_session === obj.id) return `already_applied:${await applySubscription(env, subId, { accountId })}`;
  try {
    const item = subItems(sub).find((i) => i.price?.id === price);
    const params: Record<string, string> = item?.id
      ? { "items[0][id]": item.id, "items[0][quantity]": String(Math.max(0, Number(item.quantity ?? 1)) + 1) }
      : { "items[0][price]": price, "items[0][quantity]": "1" };
    params.proration_behavior = "always_invoice";
    params["metadata[storage_addon_session]"] = String(obj.id);
    const setupIntent = idOf(obj.setup_intent);
    if (setupIntent) {
      const si = await stripeApi(env, "GET", `/setup_intents/${encodeURIComponent(setupIntent)}`);
      const pm = idOf(si.payment_method);
      if (pm) params.default_payment_method = pm;
    }
    await stripeApi(env, "POST", `/subscriptions/${encodeURIComponent(subId)}`, params, `recitbot-storage-addon-${obj.id}`);
  } catch (e) {
    await env.DB.prepare("DELETE FROM storage_addon_sessions WHERE session_id = ?").bind(String(obj.id)).run();
    throw e;
  }
  const r = await applySubscription(env, subId, { accountId });
  return `storage_addon_added:${r}`;
}

/** Handles one verified event. Returns what happened (for the log; never the payload). */
async function applyEvent(env: Env, event: Record<string, any>): Promise<string> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed": {
      if (ours(obj.metadata) && obj.mode === "setup" && obj.metadata?.purpose === STORAGE_ADDON_PURPOSE) return applyStorageCheckout(env, obj);
      if (!ours(obj.metadata) || obj.mode !== "subscription") return "ignored";
      if (obj.payment_status !== "paid" && obj.payment_status !== "no_payment_required") return "unpaid";
      const accountId = obj.metadata?.account_id ?? obj.client_reference_id;
      if (obj.client_reference_id && obj.client_reference_id !== accountId) return "mismatch";
      const subId = idOf(obj.subscription);
      if (!subId) return "no_subscription";
      const r = await applySubscription(env, subId, { accountId, adopt: true });
      await env.DB.prepare("UPDATE accounts SET checkout_session_id = NULL WHERE id = ? AND checkout_session_id = ?").bind(accountId, obj.id ?? "").run();
      return r;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      if (!ours(obj.metadata) || typeof obj.id !== "string") return "ignored";
      return applySubscription(env, obj.id, {
        accountId: obj.metadata?.account_id,
        deleted: event.type === "customer.subscription.deleted" ? obj : undefined,
      });
    case "invoice.paid":
    case "invoice.payment_failed": {
      const md = invoiceMetadata(obj);
      if (!ours(md)) return "ignored";
      const subId = invoiceSubscription(obj);
      if (!subId) return "no_subscription";
      return applySubscription(env, subId, { accountId: md?.account_id });
    }
    default:
      return "ignored";
  }
}

/** POST /api/stripe/webhook. Verified, idempotent per event id, foreign (non-recitbot) objects acknowledged and ignored. */
export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  // Billing off: the route doesn't exist on this server.
  if (!billingConfigured(env) || !env.STRIPE_WEBHOOK_SECRET) return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await req.text();
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, req.headers.get("stripe-signature"), body))) {
    return json({ error: "bad signature" }, 400);
  }
  let event: Record<string, any>;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: "bad payload" }, 400);
  }
  if (typeof event?.id !== "string" || typeof event?.type !== "string") return json({ error: "bad payload" }, 400);
  const claimed = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)")
    .bind(event.id, event.type, now())
    .run();
  if (claimed.meta.changes !== 1) return json({ received: true, duplicate: true });
  let result: string;
  try {
    result = await applyEvent(env, event);
  } catch (e) {
    // Release the claim so Stripe's retry processes it.
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
    log("error", "stripe webhook failed", { event: event.id, type: event.type, err: String(e) });
    return json({ error: "processing failed" }, 500);
  }
  log("info", "stripe webhook", { event: event.id, type: event.type, result });
  return json({ received: true });
}
