// Storage add-on: add_storage (Stripe Checkout in setup mode, Stripe API stubbed) and the webhook that adds the add-on
// item to the account's existing subscription and keeps accounts.storage_addons equal to its quantity.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_ADDON_CHECKOUT_TEXT } from "../src/billing-tools";
import { signStripePayload, stripeDeps } from "../src/stripe";
import { now } from "../src/util";
import wranglerConfig from "../wrangler.example.jsonc?raw";
import { call, mcp, seedAccount, withEnv } from "./helpers";

const SECRET = "PLACEHOLDER_STRIPE_WEBHOOK_SECRET";
const ADDON = "price_PLACEHOLDER_STORAGE";
const withAddon = (over = {}) => withEnv({ STRIPE_STORAGE_ADDON_PRICE_ID: ADDON, ...over });

type StripeCall = { method: string; path: string; params: URLSearchParams; headers: Record<string, string> };
const realFetch = stripeDeps.fetch;
afterEach(() => {
  stripeDeps.fetch = realFetch;
});

/** Stubs the Stripe API: routes by "METHOD /path" prefix (a function of the call), records every call. */
function stubStripe(routes: Record<string, (p: URLSearchParams) => unknown>): StripeCall[] {
  const calls: StripeCall[] = [];
  stripeDeps.fetch = async (input, init) => {
    const u = new URL(input);
    const params = new URLSearchParams(init.method === "POST" ? String(init.body ?? "") : u.search);
    calls.push({ method: init.method!, path: u.pathname, params, headers: init.headers as Record<string, string> });
    const key = Object.keys(routes).find((k) => `${init.method} ${u.pathname}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 404 });
    const out = routes[key](params);
    return out instanceof Response ? out : Response.json(out);
  };
  return calls;
}
const paths = (calls: StripeCall[]) => calls.map((c) => `${c.method} ${c.path}`);

/** The webhook endpoint, with the env the test runs under (the add-on price is configured there). */
async function webhook(event: object, e = withAddon()) {
  const body = JSON.stringify(event);
  const sig = await signStripePayload(SECRET, body, now());
  return call("/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body }, e);
}
let evN = 0;
const evt = (type: string, object: object) => ({ id: `evt_storage_${Date.now()}_${evN++}`, type, data: { object } });

let custN = 0;
async function proAccount(sub = "sub_s1", cust = `cus_s${Date.now()}_${custN++}`) {
  const a = await seedAccount(false);
  await env.DB.prepare(
    "UPDATE accounts SET plan = 'pro', plan_status = 'active', stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?",
  )
    .bind(cust, sub, a.accountId)
    .run();
  return { ...a, cust };
}
const addonsOf = async (id: string) =>
  (await env.DB.prepare("SELECT storage_addons AS n FROM accounts WHERE id = ?").bind(id).first<{ n: number }>())!.n;
const setAddons = (id: string, n: number) => env.DB.prepare("UPDATE accounts SET storage_addons = ? WHERE id = ?").bind(n, id).run();

const subscription = (acct: string, items: object[], extra: object = {}) => ({
  id: "sub_s1",
  object: "subscription",
  status: "active",
  customer: "cus_s1",
  cancel_at_period_end: false,
  metadata: { app: "recitbot", account_id: acct },
  items: { data: items },
  ...extra,
});
const proItem = { id: "si_pro", quantity: 1, price: { id: "price_PLACEHOLDER_PRO" }, current_period_end: 1_900_000_000 };
const addonItem = (quantity: number) => ({ id: "si_addon", quantity, price: { id: ADDON }, current_period_end: 1_900_000_000 });

const setupCompleted = (acct: string, extra: object = {}) =>
  evt("checkout.session.completed", {
    id: `cs_storage_${evN}`,
    object: "checkout.session",
    mode: "setup",
    status: "complete",
    client_reference_id: acct,
    customer: "cus_s1",
    setup_intent: "seti_1",
    metadata: { app: "recitbot", account_id: acct, purpose: "storage_addon", subscription_id: "sub_s1" },
    ...extra,
  });

describe("add_storage", () => {
  it("Pro: a Stripe-hosted Checkout Session in setup mode for the account's own customer and subscription; the bot gets the price", async () => {
    const { accountId, key, cust } = await proAccount();
    const calls = stubStripe({
      "GET /v1/customers/": () => ({ id: cust, metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/checkout/sessions": () => ({ id: "cs_add_1", url: "https://checkout.stripe.com/c/pay/cs_add_1", expires_at: 1_900_000_000 }),
    });
    const r = await mcp("add_storage", {}, key, withAddon());
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data).toMatchObject({
      checkout_url: "https://checkout.stripe.com/c/pay/cs_add_1",
      adds_gb: 100,
      price: "$3 USD per month plus applicable tax",
      storage_limit_bytes: 100e9,
      storage_addons: 0,
    });
    expect(r.data.note).toMatch(/\$3 USD per month/);
    expect(r.data.note).toMatch(/explicit yes/);
    expect(paths(calls)).toEqual([`GET /v1/customers/${cust}`, "POST /v1/checkout/sessions"]);
    const p = calls[1].params;
    expect(Object.fromEntries(p)).toMatchObject({
      mode: "setup",
      customer: cust,
      currency: "usd",
      client_reference_id: accountId,
      "metadata[app]": "recitbot",
      "metadata[account_id]": accountId,
      "metadata[purpose]": "storage_addon",
      "metadata[subscription_id]": "sub_s1",
      "custom_text[submit][message]": STORAGE_ADDON_CHECKOUT_TEXT,
      success_url: "https://rec.example/billing/storage",
      cancel_url: "https://rec.example/billing/cancel",
    });
    expect(STORAGE_ADDON_CHECKOUT_TEXT).toMatch(/100 GB/);
    expect(STORAGE_ADDON_CHECKOUT_TEXT).toMatch(/\$3 USD a month/);
    // Not the billing portal, no ad-hoc amounts, and the statement descriptor is never set per call (same as Pro's
    // Checkout: charges carry what the Recitbot product says).
    expect(paths(calls).join(" ")).not.toMatch(/billing_portal/);
    expect([...p.keys()].join(" ")).not.toMatch(/statement_descriptor|business|product|payment_intent_data|on_behalf_of|price_data|amount/);
  });

  it("Teams can add storage too", async () => {
    const { accountId, key } = await proAccount();
    await env.DB.prepare("UPDATE accounts SET plan = 'teams' WHERE id = ?").bind(accountId).run();
    stubStripe({
      "GET /v1/customers/": () => ({ id: "cus_s1", metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/checkout/sessions": () => ({ id: "cs_add_t", url: "https://checkout.stripe.com/c/pay/cs_add_t" }),
    });
    expect((await mcp("add_storage", {}, key, withAddon())).data.checkout_url).toBe("https://checkout.stripe.com/c/pay/cs_add_t");
  });

  it("STRIPE_STORAGE_ADDON_PRICE_ID unset or empty: fails clearly, no Stripe call", async () => {
    const { key } = await proAccount();
    const calls = stubStripe({});
    for (const e of [withEnv({ STRIPE_STORAGE_ADDON_PRICE_ID: undefined }), withEnv({ STRIPE_STORAGE_ADDON_PRICE_ID: "" })]) {
      const r = await mcp("add_storage", {}, key, e);
      expect(r.isError).toBe(true);
      expect(r.data).toMatchObject({ error: "STORAGE_ADDON_UNAVAILABLE" });
      expect(r.data.message).toMatch(/isn't available right now/);
    }
    expect(calls).toEqual([]);
    // The self-host template documents the add-on price (a placeholder).
    expect(wranglerConfig).toMatch(/"STRIPE_STORAGE_ADDON_PRICE_ID": "price_PLACEHOLDER_STORAGE_ADDON"/);
  });

  it("owners and Free: nothing to buy, no Stripe call", async () => {
    const calls = stubStripe({});
    const owner = await proAccount();
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(owner.accountId).run();
    const envOwner = await proAccount();
    const free = await seedAccount(false);
    for (const [a, plan] of [
      [owner, "Owner"],
      [envOwner, "Owner"],
      [free, "Free"],
    ] as const) {
      const r = await mcp("add_storage", {}, a.key, withAddon({ OWNER_ACCOUNT_IDS: envOwner.accountId }));
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ checkout_url: null, plan });
    }
    expect(calls).toEqual([]);
  });

  it("no active Stripe subscription (past_due, or Pro set without Stripe): no checkout", async () => {
    const calls = stubStripe({});
    const pastDue = await proAccount();
    await env.DB.prepare("UPDATE accounts SET plan_status = 'past_due' WHERE id = ?").bind(pastDue.accountId).run();
    const r = await mcp("add_storage", {}, pastDue.key, withAddon());
    expect(r.data.checkout_url).toBeNull();
    expect(r.data.note).toMatch(/billing/);
    const handSet = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(handSet.accountId).run();
    expect((await mcp("add_storage", {}, handSet.key, withAddon())).data.checkout_url).toBeNull();
    expect(calls).toEqual([]);
  });

  it("refuses customers Recitbot didn't create", async () => {
    const { key, cust } = await proAccount();
    const calls = stubStripe({ "GET /v1/customers/": () => ({ id: cust, metadata: { app: "otherapp" } }) });
    expect((await mcp("add_storage", {}, key, withAddon())).data.checkout_url).toBeNull();
    expect(paths(calls)).toEqual([`GET /v1/customers/${cust}`]);
  });

  it("Stripe failing: BILLING_ERROR", async () => {
    const { accountId, key } = await proAccount();
    stubStripe({
      "GET /v1/customers/": () => ({ id: "cus_s1", metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/checkout/sessions": () => new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500 }),
    });
    expect((await mcp("add_storage", {}, key, withAddon())).data.error).toBe("BILLING_ERROR");
  });

  it("the storage success page is a plain static page", async () => {
    const res = await call("/billing/storage");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/100 GB/);
  });
});

describe("webhook: completed add-on checkout adds the item to the existing subscription", () => {
  it("no add-on yet: adds the add-on price at quantity 1, prorated and invoiced now, on the card just given; storage_addons = 1", async () => {
    const { accountId } = await proAccount();
    let sub = subscription(accountId, [proItem]);
    const calls = stubStripe({
      "GET /v1/subscriptions/sub_s1": () => sub,
      "GET /v1/setup_intents/seti_1": () => ({ id: "seti_1", payment_method: "pm_new" }),
      "POST /v1/subscriptions/sub_s1": () => {
        sub = subscription(accountId, [proItem, addonItem(1)]);
        return sub;
      },
    });
    const e = setupCompleted(accountId);
    expect((await webhook(e)).status).toBe(200);
    expect(paths(calls)).toEqual([
      "GET /v1/subscriptions/sub_s1",
      "GET /v1/setup_intents/seti_1",
      "POST /v1/subscriptions/sub_s1",
      "GET /v1/subscriptions/sub_s1",
    ]);
    const upd = calls[2];
    expect(Object.fromEntries(upd.params)).toEqual({
      "items[0][price]": ADDON,
      "items[0][quantity]": "1",
      proration_behavior: "always_invoice",
      "metadata[storage_addon_session]": (e.data.object as { id: string }).id,
      default_payment_method: "pm_new",
    });
    expect(upd.headers["idempotency-key"]).toBe(`recitbot-storage-addon-${(e.data.object as { id: string }).id}`);
    expect(await addonsOf(accountId)).toBe(1);
    // The plan is still Pro: the add-on item is never read as the plan.
    expect((await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string }>())!.plan).toBe("pro");
  });

  it("an add-on already there: its quantity goes up by one", async () => {
    const { accountId } = await proAccount();
    await setAddons(accountId, 2);
    let sub = subscription(accountId, [addonItem(2), proItem]);
    const calls = stubStripe({
      "GET /v1/subscriptions/sub_s1": () => sub,
      "GET /v1/setup_intents/": () => ({ id: "seti_1", payment_method: "pm_new" }),
      "POST /v1/subscriptions/sub_s1": () => {
        sub = subscription(accountId, [addonItem(3), proItem]);
        return sub;
      },
    });
    expect((await webhook(setupCompleted(accountId))).status).toBe(200);
    const upd = calls.find((c) => c.method === "POST")!;
    expect(upd.params.get("items[0][id]")).toBe("si_addon");
    expect(upd.params.get("items[0][quantity]")).toBe("3");
    expect(upd.params.get("items[0][price]")).toBeNull();
    expect(await addonsOf(accountId)).toBe(3);
    // The add-on listed first doesn't make the plan anything but Pro.
    expect((await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string }>())!.plan).toBe("pro");
  });

  it("applied once per session: a replay of the session (new event id) adds nothing", async () => {
    const { accountId } = await proAccount();
    let sub = subscription(accountId, [proItem]);
    const calls = stubStripe({
      "GET /v1/subscriptions/sub_s1": () => sub,
      "GET /v1/setup_intents/": () => ({ id: "seti_1", payment_method: "pm_new" }),
      "POST /v1/subscriptions/sub_s1": () => {
        sub = subscription(accountId, [proItem, addonItem(1)]);
        return sub;
      },
    });
    const first = setupCompleted(accountId);
    expect((await webhook(first)).status).toBe(200);
    const again = { ...first, id: `${first.id}_replay` };
    expect((await webhook(again)).status).toBe(200);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await addonsOf(accountId)).toBe(1);
  });

  it("Stripe refusing the update: 500, the session is released, and Stripe's retry adds it", async () => {
    const { accountId } = await proAccount();
    let fail = true;
    let sub = subscription(accountId, [proItem]);
    stubStripe({
      "GET /v1/subscriptions/sub_s1": () => sub,
      "GET /v1/setup_intents/": () => ({ id: "seti_1", payment_method: "pm_new" }),
      "POST /v1/subscriptions/sub_s1": () => {
        if (fail) return new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500 });
        sub = subscription(accountId, [proItem, addonItem(1)]);
        return sub;
      },
    });
    const e = setupCompleted(accountId);
    expect((await webhook(e)).status).toBe(500);
    expect(await addonsOf(accountId)).toBe(0);
    fail = false;
    expect((await webhook(e)).status).toBe(200);
    expect(await addonsOf(accountId)).toBe(1);
  });

  it("a retry after an update whose answer was lost: the session stamped on the subscription means already applied", async () => {
    const { accountId } = await proAccount();
    const e = setupCompleted(accountId);
    const sid = (e.data.object as { id: string }).id;
    const calls = stubStripe({
      "GET /v1/subscriptions/sub_s1": () => subscription(accountId, [proItem, addonItem(1)], { metadata: { app: "recitbot", account_id: accountId, storage_addon_session: sid } }),
    });
    expect((await webhook(e)).status).toBe(200);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(await addonsOf(accountId)).toBe(1);
  });

  it("changes nothing for owners, foreign or mismatched sessions, another subscription, or an unconfigured price", async () => {
    const { accountId } = await proAccount();
    const other = await proAccount("sub_other");
    const calls = stubStripe({ "GET /v1/subscriptions/sub_s1": () => subscription(accountId, [proItem]) });
    for (const ev of [
      setupCompleted(accountId, { metadata: { app: "otherapp", account_id: accountId, purpose: "storage_addon", subscription_id: "sub_s1" } }),
      setupCompleted(accountId, { client_reference_id: other.accountId }),
      setupCompleted(accountId, { status: "open" }),
      setupCompleted(other.accountId, { client_reference_id: other.accountId }), // made for sub_s1, other's is sub_other
    ]) {
      expect((await webhook(ev)).status).toBe(200);
    }
    // Owner by plan, and by OWNER_ACCOUNT_IDS.
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(other.accountId).run();
    expect((await webhook(setupCompleted(other.accountId, { metadata: { app: "recitbot", account_id: other.accountId, purpose: "storage_addon", subscription_id: "sub_other" }, client_reference_id: other.accountId }))).status).toBe(200);
    expect((await webhook(setupCompleted(accountId), withAddon({ OWNER_ACCOUNT_IDS: accountId }))).status).toBe(200);
    // Price not configured: acknowledged, nothing added.
    expect((await webhook(setupCompleted(accountId), withEnv({ STRIPE_STORAGE_ADDON_PRICE_ID: "" }))).status).toBe(200);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(await addonsOf(accountId)).toBe(0);
    expect(await addonsOf(other.accountId)).toBe(0);
  });
});

describe("webhook: subscription events keep storage_addons in sync", () => {
  it("updated sets the add-on quantity (e.g. changed in Stripe); removing the item sets 0; deleted sets 0", async () => {
    const { accountId } = await proAccount();
    let sub: Record<string, unknown> = subscription(accountId, [proItem, addonItem(2)]);
    stubStripe({ "GET /v1/subscriptions/sub_s1": () => sub });
    expect((await webhook(evt("customer.subscription.updated", sub))).status).toBe(200);
    expect(await addonsOf(accountId)).toBe(2);
    sub = subscription(accountId, [proItem]);
    expect((await webhook(evt("customer.subscription.updated", sub))).status).toBe(200);
    expect(await addonsOf(accountId)).toBe(0);
    sub = subscription(accountId, [proItem, addonItem(1)]);
    await webhook(evt("customer.subscription.updated", sub));
    expect(await addonsOf(accountId)).toBe(1);
    sub = subscription(accountId, [proItem, addonItem(1)], { status: "canceled" });
    expect((await webhook(evt("customer.subscription.deleted", sub))).status).toBe(200);
    expect(await addonsOf(accountId)).toBe(0);
    expect((await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string }>())!.plan).toBe("free");
  });

  it("Pro checkout completion syncs it too (a new subscription has none)", async () => {
    const { accountId } = await proAccount();
    await setAddons(accountId, 4);
    stubStripe({ "GET /v1/subscriptions/sub_s1": () => subscription(accountId, [proItem]) });
    const done = evt("checkout.session.completed", {
      id: "cs_pro_x",
      object: "checkout.session",
      mode: "subscription",
      payment_status: "paid",
      client_reference_id: accountId,
      subscription: "sub_s1",
      metadata: { app: "recitbot", account_id: accountId },
    });
    expect((await webhook(done)).status).toBe(200);
    expect(await addonsOf(accountId)).toBe(0);
  });

  it("add-on price not configured: the count is left alone (the item can't be recognized)", async () => {
    const { accountId } = await proAccount();
    await setAddons(accountId, 2);
    const sub = subscription(accountId, [proItem, addonItem(5)]);
    stubStripe({ "GET /v1/subscriptions/sub_s1": () => sub });
    expect((await webhook(evt("customer.subscription.updated", sub), withEnv({ STRIPE_STORAGE_ADDON_PRICE_ID: "" }))).status).toBe(200);
    expect(await addonsOf(accountId)).toBe(2);
  });

  it("owners are never touched", async () => {
    const { accountId } = await proAccount();
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(accountId).run();
    const sub = subscription(accountId, [proItem, addonItem(3)]);
    stubStripe({ "GET /v1/subscriptions/sub_s1": () => sub });
    expect((await webhook(evt("customer.subscription.updated", sub))).status).toBe(200);
    expect(await addonsOf(accountId)).toBe(0);
  });
});

describe("playbook", () => {
  it("describes storage_limit_reached with its exact message, the 90% warning and add_storage", async () => {
    const { PLAYBOOK_TEXT, PLAYBOOK_VERSION, MCP_INSTRUCTIONS } = await import("../src/playbook");
    expect(PLAYBOOK_VERSION).toBe("2026.11.22-1");
    expect(PLAYBOOK_TEXT).toContain(
      "You've used your 100 GB of Recitbot storage. Delete old videos to free space, or add 100 GB more for $3/mo: just ask me to add storage.",
    );
    expect(PLAYBOOK_TEXT).toContain("storage_limit_reached");
    expect(PLAYBOOK_TEXT).toContain("storage_warning");
    expect(PLAYBOOK_TEXT).toContain("You've used 92.3 GB of your 100 GB of Recitbot storage.");
    expect(PLAYBOOK_TEXT).toMatch(/add_storage: 100 GB more for \$3 USD per month/);
    expect(MCP_INSTRUCTIONS).toMatch(/storage_limit_reached/);
    expect(MCP_INSTRUCTIONS).toMatch(/add_storage/);
  });
});
