// MCP tools for the plan and billing: get_plan, upgrade (Stripe Checkout), add_storage (Stripe Checkout, setup mode:
// the webhook then adds the storage add-on item to the existing subscription, stripe.ts), billing (Stripe Customer
// Portal), cancel_subscription (Customer Portal cancel flow). Spread into
// mcp.ts TOOLS; like installer-tools.ts, import this module through mcp.ts only (it imports mcp.ts back).
import { z } from "zod";
import { contactLine, getConfig } from "./config";
import { homeHost } from "./custom-domains";
import { canUseCustomBranding } from "./entitlements";
import { accountLimits, LIMITS, type AccountLimits, type Env, type Tier } from "./env";
import { ToolError, tool } from "./mcp";
import { storageStatus } from "./storage";
import {
  ADDON_STATUSES,
  addonPriceId,
  APP_TAG,
  BILLING_NOT_ENABLED,
  billingConfigured,
  checkoutLineItem,
  PAID_STATUSES,
  STORAGE_ADDON_PURPOSE,
  StripeError,
  stripeApi,
  type Billing,
  type PaidPlan,
} from "./stripe";
import { now } from "./util";

export const PRO_PRICE_TEXT = "$10 USD per month plus applicable tax";
export const PRO_YEARLY_PRICE_TEXT = "$100 USD per year plus applicable tax";
/**
 * What a plan costs at a billing interval (the Stripe prices, stripe.ts planPrice). Teams is coming soon and not sold:
 * null, so no Teams price is ever quoted to a customer (an account on Teams sees its price on the Stripe billing page).
 */
export const planPriceText = (plan: PaidPlan, billing: Billing): string | null =>
  plan === "teams" ? null : billing === "yearly" ? PRO_YEARLY_PRICE_TEXT : PRO_PRICE_TEXT;
/** Both prices of a plan, for the bot to offer the choice. */
export const PRO_PRICES_TEXT = "$10 USD per month or $100 USD per year, plus applicable tax";
/** What the bot says about Teams: coming soon, not sold, no price. */
export const TEAMS_COMING_SOON_TEXT = "Teams is coming soon: it isn't sold yet and has no price to quote; offer Pro.";
const renewsText = (billing: Billing) => `${billing} from the day you pay`;
/** accounts.billing_interval (or a Checkout Session's metadata.billing) as a Billing; unset = monthly (all there was before yearly). */
export const billingOfRow = (v: string | null | undefined): Billing => (v === "yearly" ? "yearly" : "monthly");
/** What a plan change that drops the custom domain does to it (domain-retire.ts): back to our own host (config.ts). */
const domainRetireText = (env: Env) => {
  const home = homeHost(env) || "this server's own address";
  return `the custom video domain then redirects to ${home} for 30 days and is removed (${home} links keep working)`;
};

export const PLAN_NAME: Record<Tier, string> = { free: "Free", pro: "Pro", teams: "Teams", owner: "Owner" };
const planName = (plan: string) => PLAN_NAME[plan as Tier] ?? "Pro";
export const STORAGE_ADDON_PRICE_TEXT = "$3 USD per month plus applicable tax";
export const STORAGE_ADDON_MONTHLY_ONLY_TEXT = "The storage add-on is monthly; it's not available on yearly plans yet.";
/** Shown above the button on add_storage's Stripe page (the user's consent to the add-on and its price). */
export const STORAGE_ADDON_CHECKOUT_TEXT =
  "This adds 100 GB of storage to your Recitbot subscription for $3 USD a month plus applicable tax. Today you pay only " +
  "for what's left of this billing period. After that it renews with your plan.";

type BillingRow = {
  plan: string;
  plan_status: string | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  checkout_session_id: string | null;
  checkout_session_created_at: number | null;
  billing_interval: string | null;
};

async function billingOf(env: Env, accountId: string): Promise<BillingRow> {
  const r = await env.DB.prepare(
    "SELECT plan, plan_status, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id, " +
      "checkout_session_id, checkout_session_created_at, billing_interval FROM accounts WHERE id = ?",
  )
    .bind(accountId)
    .first<BillingRow>();
  return (
    r ?? {
      plan: "free",
      plan_status: null,
      current_period_end: null,
      cancel_at_period_end: 0,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      checkout_session_id: null,
      checkout_session_created_at: null,
      billing_interval: null,
    }
  );
}

/** upgrade reuses the account's Checkout Session this long after creating it, while Stripe still has it open. */
const CHECKOUT_REUSE_SECONDS = 24 * 3600;

/** True when the stored customer is one Recitbot created for this very account (the Stripe account is shared with other products). */
async function isOurCustomer(env: Env, accountId: string, customerId: string): Promise<boolean> {
  const cust = await stripeApi<{ deleted?: boolean; metadata?: Record<string, string> }>(env, "GET", `/customers/${encodeURIComponent(customerId)}`);
  return !cust.deleted && cust.metadata?.app === APP_TAG && cust.metadata?.account_id === accountId;
}

/** Owner tier (OWNER_ACCOUNT_IDS or accounts.plan 'owner'): never billed, never offered anything. */
const OWNER_NOTE = "Owner plan, nothing to buy: this account is never billed and already has every feature.";

const isoDate = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);

export function limitsOut(l: AccountLimits) {
  return {
    /** null = no plan time limit per recording (owner). */
    max_recording_minutes: l.maxSeconds === null ? null : l.maxSeconds / 60,
    /** Free: recordings in total, lifetime (never resets); null = no such limit. */
    max_recordings_total: l.freeRecordings,
    auto_delete_days: l.keepForever ? null : LIMITS.retentionSeconds / 86400,
    max_devices: l.maxDevices,
    watermark: l.watermark,
    /** One custom video domain and page branding (Pro, Owner; also Teams, coming soon). */
    custom_domain: l.customDomain,
  };
}

/** "5 minutes", "4 hours". */
const lengthText = (s: number) => (s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? "" : "s"}` : `${s / 60} minutes`);

function limitsText(l: AccountLimits): string {
  return (
    (l.freeRecordings === null ? "unlimited recordings, " : `${l.freeRecordings} recordings in total (never resets), `) +
    (l.maxSeconds === null ? "no time limit per recording, " : `recordings up to ${lengthText(l.maxSeconds)}, `) +
    (l.keepForever ? "videos kept until you delete them, " : `videos auto-delete ${LIMITS.retentionSeconds / 86400} days after recording, `) +
    (l.maxDevices === null ? "unlimited paired devices, " : `up to ${l.maxDevices} paired devices, `) +
    (l.watermark ? "Recitbot watermark on videos" : "no watermark") +
    (l.customDomain ? ", one custom video domain and page branding" : "")
  );
}

/** The account's verified sign-in email (oauth_identities), never the unverified accounts.email. */
async function verifiedEmail(env: Env, accountId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT email FROM oauth_identities WHERE account_id = ? ORDER BY created_at LIMIT 1")
    .bind(accountId)
    .first<{ email: string }>();
  return r?.email ?? null;
}

/** A billing portal link for an account with a Recitbot-created customer; null when there is none or Stripe fails. */
async function portalUrl(env: Env, accountId: string, customerId: string | null, base: string): Promise<string | null> {
  if (!customerId || !billingConfigured(env)) return null;
  try {
    if (!(await isOurCustomer(env, accountId, customerId))) return null;
    const params: Record<string, string> = { customer: customerId, return_url: `${base}/billing/return` };
    const portalConfig = getConfig(env).billing.portalConfigId;
    if (portalConfig) params.configuration = portalConfig;
    return (await stripeApi<{ url: string }>(env, "POST", "/billing_portal/sessions", params)).url;
  } catch (e) {
    if (e instanceof StripeError) return null;
    throw e;
  }
}

const stripeFailed = (e: unknown): never => {
  if (e instanceof StripeError) throw new ToolError("BILLING_ERROR", "The payment provider didn't respond as expected. Try again in a minute.");
  throw e;
};

function requireBilling(env: Env): void {
  if (!billingConfigured(env)) throw billingNotEnabled();
}

/** Billing is off on this server (config.ts billing.enabled): mcp.ts answers this before any of these tools runs; checked again here. */
const billingNotEnabled = () => new ToolError("BILLING_NOT_ENABLED", BILLING_NOT_ENABLED);

/** Reuses the account's Recitbot-created Stripe customer, or creates one (metadata app=recitbot, account_id). */
async function stripeCustomer(env: Env, accountId: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  const email = await verifiedEmail(env, accountId);
  const params: Record<string, string> = { "metadata[app]": APP_TAG, "metadata[account_id]": accountId };
  if (email) params.email = email;
  const cust = await stripeApi<{ id: string }>(env, "POST", "/customers", params, `recitbot-customer-${accountId}`);
  await env.DB.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(cust.id, accountId).run();
  // A concurrent upgrade may have stored one first: use whatever is stored.
  return (await billingOf(env, accountId)).stripe_customer_id ?? cust.id;
}

export const BILLING_TOOLS = {
  get_plan: tool({
    auth: true,
    description:
      "Show the user's Recitbot plan with its billing: plan name (Free, Pro or Owner), status, renewal date, " +
      "billing interval (billing: monthly or yearly), price and what the plan allows (recording length, how long videos are kept, paired devices, watermark, custom video " +
      "domain). Use it when the user asks about their billing date, renewal, price, or whether they are on Pro. For " +
      "\"what plan am I on\", \"my account\" or \"my limits\" call account_info. To move to Pro call upgrade; to " +
      `cancel call cancel_subscription; to change card or get invoices call billing. ${TEAMS_COMING_SOON_TEXT}`,
    input: z.object({}),
    async run(_a, c) {
      const acct = c.principal!.accountId;
      const limits = await accountLimits(c.env, acct);
      const b = await billingOf(c.env, acct);
      const lim = limitsOut(limits);
      if (limits.tier === "owner") {
        return { plan: "Owner", status: "active", renews_on: null, billing: null, price: null, limits: lim, note: `${OWNER_NOTE} ${limitsText(limits)}.` };
      }
      if (limits.tier === "free") {
        const ended = b.plan_status === "canceled" || b.plan_status === "unpaid" || b.plan_status === "incomplete_expired";
        return {
          plan: "Free",
          status: ended ? b.plan_status : "active",
          renews_on: null,
          billing: null,
          price: "free",
          limits: lim,
          note:
            `Free plan: ${limitsText(limits)}.` +
            (ended ? " The paid subscription has ended." : "") +
            ` Recitbot Pro (${PRO_PRICES_TEXT}) removes the ${LIMITS.freeRecordings}-recording limit, lifts the device limit, removes the watermark ` +
            `and adds one custom video domain and page branding: call upgrade if the user wants it. ${TEAMS_COMING_SOON_TEXT}`,
        };
      }
      const date = isoDate(b.current_period_end);
      const ending = b.cancel_at_period_end === 1;
      const name = PLAN_NAME[limits.tier];
      const billing = billingOfRow(b.billing_interval);
      const price = planPriceText(limits.tier, billing);
      return {
        plan: name,
        status: b.plan_status ?? "active",
        renews_on: ending ? null : date,
        ends_on: ending ? date : null,
        billing,
        price,
        limits: lim,
        note:
          `Recitbot ${name}: ${limitsText(limits)}. ` +
          (ending
            ? `Canceled: stays on ${name} until ${date ?? "the end of the paid period"}, then goes back to Free` +
              (limits.customDomain ? `; ${domainRetireText(c.env)}.` : ".")
            : `Billed ${billing}: renews ${date ? `on ${date}` : billing}${price ? ` at ${price}` : ""}.`) +
          (b.plan_status === "past_due" ? " The last payment failed: call billing so the user can update their card." : "") +
          " billing opens the page to change card or see invoices; cancel_subscription cancels.",
      };
    },
  }),

  upgrade: tool({
    auth: true,
    description:
      `Upgrade the user to Recitbot Pro (${PRO_PRICES_TEXT}): no ${LIMITS.freeRecordings}-recording limit, unlimited paired devices, no watermark, ` +
      'longer recordings kept until deleted, one custom video domain and page branding. billing: "monthly" (the default, ' +
      '$10/mo) or "yearly" ($100/yr), the same Pro either way. If the user hasn\'t said which, ask them before calling; if ' +
      `they did, pass it. ${TEAMS_COMING_SOON_TEXT} Returns checkout_url, a Stripe ` +
      "payment page. BEFORE sharing or opening it, tell the user the price and how often it renews (monthly or yearly), and get their " +
      "explicit yes. The user can pay on that page themselves, or, if you have a browser and the user approves a card from " +
      "their vault, you can complete it for them. Card details go only to Stripe, never to Recitbot. When payment is done " +
      "the plan switches to Pro within seconds (check with get_plan). Already on a paid plan (or a subscription is active, " +
      "trialing or past due): says so with billing_url and creates nothing. Called again within 24 hours, it returns the " +
      "same open checkout page instead of a new one.",
    input: z.object({
      plan: z.enum(["pro"]).default("pro").describe('The plan to move to. Only "pro" today.'),
      billing: z
        .enum(["monthly", "yearly"])
        .default("monthly")
        .describe('"monthly" ($10 USD a month, the default) or "yearly" ($100 USD a year). Ask the user which unless they said.'),
    }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      const limits = await accountLimits(c.env, acct);
      if (limits.tier === "owner") {
        return { plan: "Owner", already: true, checkout_url: null, note: OWNER_NOTE };
      }
      requireBilling(c.env);
      const b = await billingOf(c.env, acct);
      // Already paying (or Stripe still retrying the card): never a second subscription.
      if (limits.tier !== "free" || (b.stripe_subscription_id && PAID_STATUSES.has(b.plan_status ?? ""))) {
        const billing_url = await portalUrl(c.env, acct, b.stripe_customer_id, c.base);
        const plan = limits.tier === "teams" ? "Teams" : "Pro";
        return {
          plan,
          already: true,
          billing_url,
          note:
            `The user is already on Recitbot ${plan}; there is nothing to buy. get_plan shows the renewal date. ` +
            (billing_url ? "billing_url opens the Stripe billing page (card, invoices); it works for a short time." : "Call billing for the card and invoices page."),
        };
      }
      requireBilling(c.env);
      const billing: Billing = a.billing;
      const lineItem = checkoutLineItem(c.env, a.plan, billing);
      if (!lineItem) {
        throw new ToolError("BILLING_UNAVAILABLE", `${billing === "yearly" ? "Yearly" : "Monthly"} billing isn't available right now. Try the other one, or try again later.`);
      }
      const name = PLAN_NAME[a.plan];
      const price = planPriceText(a.plan, billing);
      const renews = renewsText(billing);
      const t = now();
      const offer = (url: string, expires_at: number | null, reused: boolean) => ({
        checkout_url: url,
        plan: name,
        billing,
        price,
        renews,
        expires_at,
        reused,
        note:
          `Before paying, tell the user: Recitbot ${name} costs ${price} and renews ${renews} until canceled. ` +
          "Get their explicit yes first. Then give them checkout_url, or, if you have a browser and the user approves a card " +
          "from their vault, complete the Stripe page yourself with that card. No card data is ever sent to Recitbot: it " +
          `goes only to Stripe. After payment, call get_plan to confirm ${name}. Cancel any time with cancel_subscription; change card with billing.`,
      });
      try {
        // The account's own Checkout Session from the last 24 h: reused while open at the same billing interval (one open
        // at the other interval is expired first, so only one of them can be paid); already paid = nothing more to buy.
        if (b.checkout_session_id && b.checkout_session_created_at !== null && t - b.checkout_session_created_at < CHECKOUT_REUSE_SECONDS) {
          type Session = { url: string | null; status?: string; expires_at?: number; client_reference_id?: string | null; metadata?: Record<string, string> };
          const prev = await stripeApi<Session>(c.env, "GET", `/checkout/sessions/${encodeURIComponent(b.checkout_session_id)}`).catch((e) => {
            if (e instanceof StripeError && e.status === 404) return null;
            throw e;
          });
          const mine = !!prev && prev.metadata?.app === APP_TAG && prev.metadata?.account_id === acct && prev.client_reference_id === acct;
          if (mine && prev.status === "open" && prev.url && (prev.expires_at ?? Infinity) > t && billingOfRow(prev.metadata?.billing) === billing) {
            return offer(prev.url, prev.expires_at ?? null, true);
          }
          if (mine && prev.status === "open") await stripeApi(c.env, "POST", `/checkout/sessions/${encodeURIComponent(b.checkout_session_id)}/expire`);
          if (mine && prev.status === "complete") {
            return {
              plan: name,
              already: true,
              checkout_url: null,
              note: "The user already paid on the checkout page; the plan switches on within seconds. Call get_plan to confirm. Nothing new was created.",
            };
          }
        }
        const customer = await stripeCustomer(c.env, acct, b.stripe_customer_id);
        const session = await stripeApi<{ id: string; url: string; expires_at?: number }>(c.env, "POST", "/checkout/sessions", {
          mode: "subscription",
          customer,
          ...lineItem,
          "automatic_tax[enabled]": "true",
          "customer_update[address]": "auto",
          allow_promotion_codes: "true",
          success_url: `${c.base}/billing/success`,
          cancel_url: `${c.base}/billing/cancel`,
          client_reference_id: acct,
          "metadata[app]": APP_TAG,
          "metadata[account_id]": acct,
          "metadata[billing]": billing,
          "subscription_data[metadata][app]": APP_TAG,
          "subscription_data[metadata][account_id]": acct,
        });
        await c.env.DB.prepare("UPDATE accounts SET checkout_session_id = ?, checkout_session_created_at = ? WHERE id = ?").bind(session.id, t, acct).run();
        return offer(session.url, session.expires_at ?? null, false);
      } catch (e) {
        return stripeFailed(e);
      }
    },
  }),

  add_storage: tool({
    auth: true,
    description:
      `Add 100 GB of Recitbot storage (${STORAGE_ADDON_PRICE_TEXT}, renews monthly with the plan) to the user's Pro ` +
      "subscription. Use it when the user asks for more storage, or after storage_limit_reached / storage_warning when the " +
      "user wants more room. Returns checkout_url, a Stripe page where the user confirms the add-on and its price and gives " +
      "a card; it is charged a prorated amount for the rest of the current period right away, then monthly. BEFORE sharing " +
      "or opening it, tell the user the price and get their explicit yes. Each completed page adds one 100 GB add-on; " +
      "account_info shows storage_limit_bytes and storage_addons once it's done (within seconds). Free plan: no storage " +
      "cap, nothing to add (offer upgrade only if they want Pro). The add-on is monthly: on a yearly plan it fails with " +
      "STORAGE_ADDON_MONTHLY_ONLY; tell the user the message. Errors: STORAGE_ADDON_UNAVAILABLE, STORAGE_ADDON_MONTHLY_ONLY, BILLING_ERROR.",
    input: z.object({}),
    async run(_a, c) {
      const acct = c.principal!.accountId;
      const limits = await accountLimits(c.env, acct);
      if (limits.tier === "owner") return { checkout_url: null, plan: "Owner", note: `${OWNER_NOTE} Owner accounts have no storage cap.` };
      requireBilling(c.env);
      if (limits.tier === "free") {
        return {
          checkout_url: null,
          plan: "Free",
          note: `Storage add-ons are for Recitbot Pro. The Free plan has no storage cap (its limit is ${LIMITS.freeRecordings} videos in total). Call upgrade if the user wants Pro.`,
        };
      }
      const b = await billingOf(c.env, acct);
      // The add-on price bills monthly and a Stripe subscription's items bill on one interval, so it can't go on a
      // yearly plan (the webhook refuses it too: stripe.ts applyStorageCheckout).
      if (billingOfRow(b.billing_interval) === "yearly") throw new ToolError("STORAGE_ADDON_MONTHLY_ONLY", STORAGE_ADDON_MONTHLY_ONLY_TEXT);
      if (!addonPriceId(c.env)) {
        throw new ToolError("STORAGE_ADDON_UNAVAILABLE", "Adding storage isn't available right now. Try again later, or delete old videos to free space.");
      }
      const storage = await storageStatus(c.env, acct, limits);
      if (!b.stripe_customer_id || !b.stripe_subscription_id || !ADDON_STATUSES.has(b.plan_status ?? "")) {
        return {
          checkout_url: null,
          note:
            "Storage can only be added to an active Recitbot subscription paid through Stripe" +
            (b.plan_status === "past_due" ? ": the last payment failed. Call billing so the user can update their card first." : `. ${contactLine(getConfig(c.env))}.`),
        };
      }
      try {
        if (!(await isOurCustomer(c.env, acct, b.stripe_customer_id))) {
          return { checkout_url: null, note: `This account has no Recitbot billing to add storage to. ${contactLine(getConfig(c.env))}.` };
        }
        const session = await stripeApi<{ id: string; url: string; expires_at?: number }>(c.env, "POST", "/checkout/sessions", {
          mode: "setup",
          customer: b.stripe_customer_id,
          currency: "usd",
          success_url: `${c.base}/billing/storage`,
          cancel_url: `${c.base}/billing/cancel`,
          client_reference_id: acct,
          "custom_text[submit][message]": STORAGE_ADDON_CHECKOUT_TEXT,
          "metadata[app]": APP_TAG,
          "metadata[account_id]": acct,
          "metadata[purpose]": STORAGE_ADDON_PURPOSE,
          "metadata[subscription_id]": b.stripe_subscription_id,
          "setup_intent_data[metadata][app]": APP_TAG,
          "setup_intent_data[metadata][account_id]": acct,
          "setup_intent_data[metadata][purpose]": STORAGE_ADDON_PURPOSE,
        });
        return {
          checkout_url: session.url,
          adds_gb: LIMITS.storageAddonBytes / 1e9,
          price: STORAGE_ADDON_PRICE_TEXT,
          renews: "monthly with the plan",
          expires_at: session.expires_at ?? null,
          storage_used_bytes: storage.used,
          storage_limit_bytes: storage.limit,
          storage_addons: storage.addons,
          note:
            `Before paying, tell the user: 100 GB more Recitbot storage costs ${STORAGE_ADDON_PRICE_TEXT}, added to their ` +
            "subscription and renewing with it; today they pay a prorated amount for the rest of the current period. Get " +
            "their explicit yes first. Then give them checkout_url, or, if you have a browser and the user approves a card " +
            "from their vault, complete the Stripe page yourself with that card. No card data is ever sent to Recitbot. " +
            "After it's done, call account_info to confirm the new storage_limit_bytes.",
        };
      } catch (e) {
        return stripeFailed(e);
      }
    },
  }),

  billing: tool({
    auth: true,
    description:
      "Open the user's Stripe billing page (portal_url) to change their card or see and download invoices. " +
      "To cancel Pro or stop paying, call cancel_subscription instead. " +
      "Only for accounts that have paid through upgrade; otherwise it says there is no billing yet. Give the user the link " +
      "(or open it in your browser if they ask you to make the change and approve it).",
    input: z.object({}),
    async run(_a, c) {
      const acct = c.principal!.accountId;
      if ((await accountLimits(c.env, acct)).tier === "owner") return { portal_url: null, plan: "Owner", note: OWNER_NOTE };
      requireBilling(c.env);
      const noBilling = { portal_url: null, note: "No billing yet: this account has never paid for Recitbot. To start Pro, call upgrade." };
      const b = await billingOf(c.env, acct);
      if (!b.stripe_customer_id) return noBilling;
      requireBilling(c.env);
      try {
        if (!(await isOurCustomer(c.env, acct, b.stripe_customer_id))) return noBilling;
        const params: Record<string, string> = { customer: b.stripe_customer_id, return_url: `${c.base}/billing/return` };
        const portalConfig = getConfig(c.env).billing.portalConfigId;
        if (portalConfig) params.configuration = portalConfig;
        const portal = await stripeApi<{ url: string }>(c.env, "POST", "/billing_portal/sessions", params);
        return {
          portal_url: portal.url,
          note: "Stripe billing page: change card, cancel the plan (it stays active until the paid period ends), see and download invoices. The link works for a short time; call billing again for a new one.",
        };
      } catch (e) {
        return stripeFailed(e);
      }
    },
  }),

  cancel_subscription: tool({
    auth: true,
    description:
      'Cancel the user\'s Recitbot subscription. Use it when the user says "cancel my subscription", "cancel my plan", ' +
      '"cancel Pro", "stop paying for Recitbot" or similar. Returns cancel_url, a Stripe page where the user confirms the ' +
      "cancellation. The plan stays active until the end of the paid period, then the account goes back to Free (a custom " +
      "video domain then redirects to the server's own video links for 30 days and is removed). If there is no " +
      "active subscription it says there is nothing to cancel.",
    input: z.object({}),
    async run(_a, c) {
      const acct = c.principal!.accountId;
      const nothing = (why: string) => ({ cancel_url: null, plan: "Free", renews_or_ends: null, note: `Nothing to cancel: ${why}` });
      if ((await accountLimits(c.env, acct)).tier === "owner") {
        return { cancel_url: null, plan: "Owner", renews_or_ends: null, note: `Nothing to cancel. ${OWNER_NOTE}` };
      }
      requireBilling(c.env);
      const b = await billingOf(c.env, acct);
      const active = b.plan !== "free" && !!b.stripe_subscription_id && !["canceled", "unpaid", "incomplete_expired"].includes(b.plan_status ?? "");
      if (!b.stripe_customer_id || !active) return nothing("this account has no active Recitbot Pro subscription, so nothing is being charged.");
      const date = isoDate(b.current_period_end);
      const name = planName(b.plan);
      const domainNote = canUseCustomBranding(b.plan) ? ` When it ends, ${domainRetireText(c.env)}.` : "";
      if (b.cancel_at_period_end === 1) {
        return {
          cancel_url: null,
          plan: name,
          renews_or_ends: `ends ${date ?? "at the end of the paid period"}`,
          note: `Already canceled: ${name} stays active until ${date ?? "the end of the paid period"}, then the account goes back to Free.${domainNote} Nothing more to do.`,
        };
      }
      requireBilling(c.env);
      try {
        if (!(await isOurCustomer(c.env, acct, b.stripe_customer_id))) return nothing("this account has no Recitbot billing.");
        const returnUrl = `${c.base}/billing/return`;
        const params: Record<string, string> = {
          customer: b.stripe_customer_id,
          return_url: returnUrl,
          "flow_data[type]": "subscription_cancel",
          "flow_data[subscription_cancel][subscription]": b.stripe_subscription_id!,
          "flow_data[after_completion][type]": "redirect",
          "flow_data[after_completion][redirect][return_url]": returnUrl,
        };
        const portalConfig = getConfig(c.env).billing.portalConfigId;
        if (portalConfig) params.configuration = portalConfig;
        const portal = await stripeApi<{ url: string }>(c.env, "POST", "/billing_portal/sessions", params);
        return {
          cancel_url: portal.url,
          plan: name,
          renews_or_ends: date ? `renews ${date} unless canceled` : `renews ${billingOfRow(b.billing_interval)} unless canceled`,
          note:
            "Open cancel_url in your browser or send it to the user. The user confirms the cancellation on Stripe's page; " +
            `nothing is canceled until they do. After canceling, ${name} stays active until the end of the paid period` +
            (date ? ` (${date})` : "") +
            `, then the account goes back to Free.${domainNote} The link works for a short time; call cancel_subscription again for a new one. ` +
            "get_plan shows the end date once it's done.",
        };
      } catch (e) {
        return stripeFailed(e);
      }
    },
  }),
};
