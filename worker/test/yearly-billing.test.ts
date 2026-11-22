// Yearly billing next to monthly: Pro $100/yr and Teams $80/user/yr are other prices on the same products, so they map to
// the same plan (stripe.ts planPrice). upgrade takes billing monthly|yearly; the webhook stores accounts.billing_interval;
// monthly <-> yearly keeps the plan, custom domain and branding; the (monthly) storage add-on is refused on yearly plans.
// Stripe API stubbed (stripeDeps.fetch), nothing reaches Stripe.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_ADDON_MONTHLY_ONLY_TEXT } from "../src/billing-tools";
import { canUseCustomBranding } from "../src/entitlements";
import type { Env } from "../src/env";
import { MCP_INSTRUCTIONS, PLAYBOOK_TEXT, PLAYBOOK_VERSION } from "../src/playbook";
import { checkoutLineItem, planForPrice, planPrice, priceFor, signStripePayload, stripeDeps } from "../src/stripe";
import { now } from "../src/util";
import { call, mcp, seedAccount, withEnv } from "./helpers";

const SECRET = "PLACEHOLDER_STRIPE_WEBHOOK_SECRET";
const PRO = "price_PLACEHOLDER_PRO";
const PRO_YEARLY = "price_PLACEHOLDER_PRO_YEARLY";
const TEAMS = "price_PLACEHOLDER_TEAMS";
const TEAMS_YEARLY = "price_PLACEHOLDER_TEAMS_YEARLY";
const ADDON = "price_PLACEHOLDER_STORAGE";
const withAddon = (over: Partial<Env> = {}) => withEnv({ STRIPE_STORAGE_ADDON_PRICE_ID: ADDON, ...over });

type StripeCall = { method: string; path: string; params: URLSearchParams };
const realFetch = stripeDeps.fetch;
afterEach(() => {
  stripeDeps.fetch = realFetch;
});

/** Stubs the Stripe API: routes by "METHOD /path" prefix (longest match wins), records every call. */
function stubStripe(routes: Record<string, (p: URLSearchParams) => unknown>): StripeCall[] {
  const calls: StripeCall[] = [];
  stripeDeps.fetch = async (input, init) => {
    const u = new URL(input);
    const params = new URLSearchParams(init.method === "POST" ? String(init.body ?? "") : u.search);
    calls.push({ method: init.method!, path: u.pathname, params });
    const key = Object.keys(routes)
      .filter((k) => `${init.method} ${u.pathname}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 404 });
    const out = routes[key](params);
    return out instanceof Response ? out : Response.json(out);
  };
  return calls;
}
const paths = (calls: StripeCall[]) => calls.map((c) => `${c.method} ${c.path}`);

async function webhook(event: object, e: Env = withAddon()) {
  const body = JSON.stringify(event);
  const sig = await signStripePayload(SECRET, body, now());
  return call("/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body }, e);
}
let evN = 0;
const evt = (type: string, object: object) => ({ id: `evt_yr_${Date.now()}_${evN++}`, type, data: { object } });

const item = (id: string, price: string, quantity = 1) => ({ id, quantity, price: { id: price }, current_period_end: 1_900_000_000 });
const sub = (acct: string, items: object[], extra: object = {}) => ({
  id: "sub_yr",
  object: "subscription",
  status: "active",
  customer: "cus_yr",
  cancel_at_period_end: false,
  metadata: { app: "recitbot", account_id: acct },
  items: { data: items },
  ...extra,
});

let custN = 0;
/** A paid account with a stored Stripe customer and subscription sub_yr. */
async function paidAccount(plan: string, billing: string | null = "monthly") {
  const a = await seedAccount(false);
  const cust = `cus_yr_${Date.now()}_${custN++}`;
  await env.DB.prepare(
    "UPDATE accounts SET plan = ?, plan_status = 'active', current_period_end = 1900000000, stripe_customer_id = ?, stripe_subscription_id = 'sub_yr', billing_interval = ? WHERE id = ?",
  )
    .bind(plan, cust, billing, a.accountId)
    .run();
  return { ...a, cust };
}
type Row = { plan: string; plan_status: string | null; billing_interval: string | null; storage_addons: number };
const rowOf = async (id: string) =>
  (await env.DB.prepare("SELECT plan, plan_status, billing_interval, storage_addons FROM accounts WHERE id = ?").bind(id).first<Row>())!;

let hostN = 0;
async function seedDomain(accountId: string) {
  const id = `cd_yr_${Date.now()}_${hostN++}`;
  await env.DB.prepare("INSERT INTO custom_domains (id, account_id, hostname, status, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, 1)")
    .bind(id, accountId, `y${hostN}-${id.toLowerCase().replace(/_/g, "-")}.example.com`)
    .run();
  return id;
}
const domainStatus = async (id: string) =>
  (await env.DB.prepare("SELECT status, redirect_until FROM custom_domains WHERE id = ?").bind(id).first<{ status: string; redirect_until: number | null }>())!;
const seedBranding = (accountId: string) =>
  env.DB.prepare("INSERT INTO branding (account_id, brand_name, accent, background, updated_at) VALUES (?, 'Acme', '#0b6e64', '#ffffff', ?)").bind(accountId, now()).run();
const brandName = async (accountId: string) =>
  (await env.DB.prepare("SELECT brand_name FROM branding WHERE account_id = ?").bind(accountId).first<{ brand_name: string }>())?.brand_name ?? null;

describe("price mapping (one function for every price id lookup)", () => {
  it("yearly prices map to the same plan as their monthly counterparts; add-on, unknown and unset ids map to nothing", () => {
    expect([PRO, PRO_YEARLY, TEAMS, TEAMS_YEARLY].map((p) => planPrice(env, p))).toEqual([
      { plan: "pro", billing: "monthly" },
      { plan: "pro", billing: "yearly" },
      { plan: "teams", billing: "monthly" },
      { plan: "teams", billing: "yearly" },
    ]);
    expect([PRO_YEARLY, TEAMS_YEARLY, ADDON, "price_other", "", undefined].map((p) => planForPrice(env, p))).toEqual(["pro", "teams", null, null, null, null]);
    // An unset yearly price never matches an empty id.
    expect(planPrice(withEnv({ STRIPE_PRO_YEARLY_PRICE_ID: "" }), "")).toBeNull();
    expect(planPrice(withEnv({ STRIPE_PRO_YEARLY_PRICE_ID: undefined }), PRO_YEARLY)).toBeNull();
  });

  it("checkout line items: the price for the interval; Pro quantity 1, Teams quantity = seats, monthly or yearly", () => {
    expect(priceFor(env, "pro", "monthly")).toBe(PRO);
    expect(priceFor(env, "pro", "yearly")).toBe(PRO_YEARLY);
    expect(checkoutLineItem(env, "pro", "yearly")).toEqual({ "line_items[0][price]": PRO_YEARLY, "line_items[0][quantity]": "1" });
    expect(checkoutLineItem(env, "pro", "yearly", 7)).toEqual({ "line_items[0][price]": PRO_YEARLY, "line_items[0][quantity]": "1" });
    expect(checkoutLineItem(env, "teams", "monthly", 5)).toEqual({ "line_items[0][price]": TEAMS, "line_items[0][quantity]": "5" });
    expect(checkoutLineItem(env, "teams", "yearly", 5)).toEqual({ "line_items[0][price]": TEAMS_YEARLY, "line_items[0][quantity]": "5" });
    expect(checkoutLineItem(env, "teams", "yearly", 0)).toEqual({ "line_items[0][price]": TEAMS_YEARLY, "line_items[0][quantity]": "1" });
    expect(checkoutLineItem(withEnv({ STRIPE_TEAMS_YEARLY_PRICE_ID: "" }), "teams", "yearly", 3)).toBeNull();
    expect(checkoutLineItem(withEnv({ STRIPE_PRO_YEARLY_PRICE_ID: undefined }), "pro", "yearly")).toBeNull();
  });
});

describe("upgrade: billing monthly | yearly", () => {
  const checkoutRoutes = (id = "cs_yr") => ({
    "POST /v1/customers": () => ({ id: `cus_new_yr_${custN++}` }),
    "POST /v1/checkout/sessions": () => ({ id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: 1_900_000_000 }),
  });
  const sessionCall = (calls: StripeCall[]) => Object.fromEntries(calls.find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")!.params);

  it("yearly: Checkout charges the Pro yearly price, quantity 1; the bot gets $100 a year and yearly renewal", async () => {
    const { accountId, key } = await seedAccount(false);
    const calls = stubStripe(checkoutRoutes());
    const r = await mcp("upgrade", { billing: "yearly" }, key);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      checkout_url: "https://checkout.stripe.com/c/pay/cs_yr",
      plan: "Pro",
      billing: "yearly",
      price: "$100 USD per year plus applicable tax",
      renews: "yearly from the day you pay",
    });
    expect(r.data.note).toMatch(/costs \$100 USD per year plus applicable tax and renews yearly from the day you pay/);
    const p = sessionCall(calls);
    expect(p).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": PRO_YEARLY,
      "line_items[0][quantity]": "1",
      "metadata[billing]": "yearly",
      "metadata[account_id]": accountId,
      "subscription_data[metadata][app]": "recitbot",
    });
    expect(Object.keys(p).filter((k) => k.startsWith("line_items[") && !k.startsWith("line_items[0]"))).toEqual([]);
  });

  it("monthly is the default and unchanged: the Pro monthly price, $10 a month", async () => {
    for (const input of [{}, { billing: "monthly" }, { plan: "pro" }]) {
      const { key } = await seedAccount(false);
      const calls = stubStripe(checkoutRoutes());
      const r = await mcp("upgrade", input, key);
      expect(r.data).toMatchObject({ plan: "Pro", billing: "monthly", price: "$10 USD per month plus applicable tax", renews: "monthly from the day you pay" });
      expect(sessionCall(calls)).toMatchObject({ "line_items[0][price]": PRO, "line_items[0][quantity]": "1", "metadata[billing]": "monthly" });
    }
  });

  it("input validation: billing must be monthly or yearly, plan only pro; refused before any Stripe call", async () => {
    const { key } = await seedAccount(false);
    const calls = stubStripe(checkoutRoutes());
    for (const input of [{ billing: "annual" }, { billing: "YEARLY" }, { billing: 12 }, { billing: null }, { plan: "teams", billing: "yearly" }]) {
      const r = await mcp("upgrade", input, key);
      expect(r.isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("yearly price not configured: BILLING_UNAVAILABLE for yearly, no Stripe call; monthly still works", async () => {
    const { key } = await seedAccount(false);
    const calls = stubStripe(checkoutRoutes());
    const e = withEnv({ STRIPE_PRO_YEARLY_PRICE_ID: "" });
    const r = await mcp("upgrade", { billing: "yearly" }, key, e);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: "BILLING_UNAVAILABLE" });
    expect(r.data.message).toMatch(/Yearly billing isn't available/);
    expect(calls).toEqual([]);
    expect((await mcp("upgrade", { billing: "monthly" }, key, e)).data.billing).toBe("monthly");
  });

  it("an open session is reused only at the same interval; one at the other interval is expired before a new one", async () => {
    const { accountId, key } = await seedAccount(false);
    const open = (billing?: string) => ({
      id: "cs_prev",
      url: "https://checkout.stripe.com/c/pay/cs_prev",
      status: "open",
      expires_at: now() + 3600,
      client_reference_id: accountId,
      metadata: { app: "recitbot", account_id: accountId, ...(billing ? { billing } : {}) },
    });
    const store = () =>
      env.DB.prepare("UPDATE accounts SET stripe_customer_id = 'cus_prev', checkout_session_id = 'cs_prev', checkout_session_created_at = ? WHERE id = ?").bind(now(), accountId).run();

    // Same interval: reused, nothing new (a session from before yearly existed has no billing metadata: monthly).
    for (const [prev, asked] of [["yearly", "yearly"], [undefined, "monthly"], ["monthly", "monthly"]] as const) {
      await store();
      const calls = stubStripe({ "GET /v1/checkout/sessions/cs_prev": () => open(prev) });
      const r = await mcp("upgrade", { billing: asked }, key);
      expect(r.data, `${prev} -> ${asked}`).toMatchObject({ checkout_url: "https://checkout.stripe.com/c/pay/cs_prev", reused: true, billing: asked });
      expect(paths(calls)).toEqual(["GET /v1/checkout/sessions/cs_prev"]);
    }

    // Other interval: the open one is expired (so only one can ever be paid), then a new session at the asked price.
    for (const [prev, asked, price] of [[undefined, "yearly", PRO_YEARLY], ["yearly", "monthly", PRO]] as const) {
      await store();
      const calls = stubStripe({
        "GET /v1/checkout/sessions/cs_prev": () => open(prev),
        "POST /v1/checkout/sessions/cs_prev/expire": () => ({ id: "cs_prev", status: "expired" }),
        "POST /v1/checkout/sessions": () => ({ id: "cs_next", url: "https://checkout.stripe.com/c/pay/cs_next" }),
      });
      const r = await mcp("upgrade", { billing: asked }, key);
      expect(r.data, `${prev} -> ${asked}`).toMatchObject({ checkout_url: "https://checkout.stripe.com/c/pay/cs_next", reused: false, billing: asked });
      expect(paths(calls)).toEqual(["GET /v1/checkout/sessions/cs_prev", "POST /v1/checkout/sessions/cs_prev/expire", "POST /v1/checkout/sessions"]);
      expect(calls[2].params.get("line_items[0][price]")).toBe(price);
      expect(await env.DB.prepare("SELECT checkout_session_id FROM accounts WHERE id = ?").bind(accountId).first("checkout_session_id")).toBe("cs_next");
    }

    // Expiring fails: BILLING_ERROR, and no second session is created.
    await store();
    const calls = stubStripe({
      "GET /v1/checkout/sessions/cs_prev": () => open("monthly"),
      "POST /v1/checkout/sessions/cs_prev/expire": () => Response.json({ error: { type: "api_error" } }, { status: 500 }),
      "POST /v1/checkout/sessions": () => ({ id: "cs_x", url: "u" }),
    });
    const r = await mcp("upgrade", { billing: "yearly" }, key);
    expect(r.data).toMatchObject({ error: "BILLING_ERROR" });
    expect(paths(calls)).toEqual(["GET /v1/checkout/sessions/cs_prev", "POST /v1/checkout/sessions/cs_prev/expire"]);
  });
});

describe("webhook: yearly prices", () => {
  const stripeHas = (s: object) => stubStripe({ "GET /v1/subscriptions/sub_yr": () => s });

  it("maps Pro yearly to pro and Teams yearly (with seats and an add-on item) to teams, storing billing_interval", async () => {
    const cases: [object[], string, string][] = [
      [[item("si_1", PRO_YEARLY)], "pro", "yearly"],
      [[item("si_1", TEAMS_YEARLY, 5)], "teams", "yearly"],
      [[item("si_a", ADDON, 2), item("si_1", TEAMS_YEARLY, 4)], "teams", "yearly"],
      [[item("si_1", PRO)], "pro", "monthly"],
      [[item("si_1", TEAMS, 3)], "teams", "monthly"],
    ];
    for (const [items, plan, billing] of cases) {
      const { accountId } = await paidAccount("free", null);
      const s = sub(accountId, items);
      stripeHas(s);
      expect((await webhook(evt("customer.subscription.updated", s))).status).toBe(200);
      expect(await rowOf(accountId), JSON.stringify(items)).toMatchObject({ plan, plan_status: "active", billing_interval: billing });
    }
  });

  it("a yearly Checkout completing turns the account Pro (yearly)", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas(sub(accountId, [item("si_1", PRO_YEARLY)]));
    const done = evt("checkout.session.completed", {
      id: "cs_yr_done",
      mode: "subscription",
      payment_status: "paid",
      client_reference_id: accountId,
      subscription: "sub_yr",
      metadata: { app: "recitbot", account_id: accountId, billing: "yearly" },
    });
    expect((await webhook(done)).status).toBe(200);
    expect(await rowOf(accountId)).toMatchObject({ plan: "pro", billing_interval: "yearly" });
  });

  it("monthly <-> yearly keeps the plan, the custom domain and the branding (nothing retired), for Pro and Teams", async () => {
    for (const [plan, monthly, yearly] of [["pro", PRO, PRO_YEARLY], ["teams", TEAMS, TEAMS_YEARLY]] as const) {
      const { accountId } = await paidAccount(plan, "monthly");
      const host = await seedDomain(accountId);
      await seedBranding(accountId);
      for (const [price, billing] of [[yearly, "yearly"], [monthly, "monthly"], [yearly, "yearly"]] as const) {
        const s = sub(accountId, [item("si_1", price, plan === "teams" ? 3 : 1)]);
        stripeHas(s);
        expect((await webhook(evt("customer.subscription.updated", s))).status).toBe(200);
        expect(await rowOf(accountId), `${plan} -> ${billing}`).toMatchObject({ plan, plan_status: "active", billing_interval: billing });
        expect(await domainStatus(host)).toEqual({ status: "active", redirect_until: null });
        expect(await brandName(accountId)).toBe("Acme");
        expect(canUseCustomBranding((await rowOf(accountId)).plan)).toBe(true);
      }
    }
  });

  it("a yearly plan that ends: Free, billing_interval cleared, and the custom domain is retired as for monthly", async () => {
    const { accountId } = await paidAccount("pro", "yearly");
    const host = await seedDomain(accountId);
    const s = sub(accountId, [item("si_1", PRO_YEARLY)], { status: "canceled" });
    stripeHas(s);
    expect((await webhook(evt("customer.subscription.deleted", s))).status).toBe(200);
    expect(await rowOf(accountId)).toMatchObject({ plan: "free", billing_interval: null });
    expect((await domainStatus(host)).status).not.toBe("active");
  });
});

describe("get_plan, account_info and cancel show the billing interval", () => {
  it("Pro yearly: billing yearly at $100 a year; account_info billing_interval yearly", async () => {
    const { key } = await paidAccount("pro", "yearly");
    const r = await mcp("get_plan", {}, key);
    expect(r.data).toMatchObject({ plan: "Pro", billing: "yearly", price: "$100 USD per year plus applicable tax", renews_on: "2030-03-17" });
    expect(r.data.note).toMatch(/Billed yearly: renews on 2030-03-17 at \$100 USD per year/);
    expect((await mcp("account_info", {}, key)).data).toMatchObject({ plan: "Pro", billing_interval: "yearly" });
  });

  it("Teams (coming soon): billing shown, no price quoted; Pro monthly unchanged; Free and owner have none", async () => {
    const t = await paidAccount("teams", "yearly");
    const ty = (await mcp("get_plan", {}, t.key)).data;
    expect(ty).toMatchObject({ plan: "Teams", billing: "yearly", price: null });
    expect(ty.note).toMatch(/Billed yearly: renews on 2030-03-17\./);
    expect(JSON.stringify(ty)).not.toMatch(/\$8|\$80|per user/);
    const tm = await paidAccount("teams", "monthly");
    expect((await mcp("get_plan", {}, tm.key)).data).toMatchObject({ plan: "Teams", billing: "monthly", price: null });
    // Stored before yearly existed (NULL): monthly.
    const p = await paidAccount("pro", null);
    expect((await mcp("get_plan", {}, p.key)).data).toMatchObject({ billing: "monthly", price: "$10 USD per month plus applicable tax" });
    expect((await mcp("account_info", {}, p.key)).data.billing_interval).toBe("monthly");
    const free = await seedAccount(false);
    expect((await mcp("get_plan", {}, free.key)).data).toMatchObject({ plan: "Free", billing: null });
    expect((await mcp("account_info", {}, free.key)).data.billing_interval).toBeNull();
    const owner = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(owner.accountId).run();
    expect((await mcp("account_info", {}, owner.key)).data.billing_interval).toBeNull();
  });

  it("cancel_subscription without a period end says it renews yearly on a yearly plan", async () => {
    const { accountId, key, cust } = await paidAccount("pro", "yearly");
    await env.DB.prepare("UPDATE accounts SET current_period_end = NULL WHERE id = ?").bind(accountId).run();
    stubStripe({
      "GET /v1/customers/": () => ({ id: cust, metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/yr" }),
    });
    expect((await mcp("cancel_subscription", {}, key)).data.renews_or_ends).toBe("renews yearly unless canceled");
  });
});

describe("storage add-on on yearly plans (the add-on price is monthly)", () => {
  it("add_storage on a yearly Pro or Teams plan: STORAGE_ADDON_MONTHLY_ONLY with a clear message, no Stripe call", async () => {
    for (const plan of ["pro", "teams"]) {
      const { key } = await paidAccount(plan, "yearly");
      const calls = stubStripe({});
      const r = await mcp("add_storage", {}, key, withAddon());
      expect(r.isError).toBe(true);
      expect(r.data).toEqual({ error: "STORAGE_ADDON_MONTHLY_ONLY", message: "The storage add-on is monthly; it's not available on yearly plans yet." });
      expect(STORAGE_ADDON_MONTHLY_ONLY_TEXT).toBe(r.data.message);
      expect(calls).toEqual([]);
    }
  });

  it("add_storage on a monthly plan still opens the add-on Checkout", async () => {
    const { accountId, key } = await paidAccount("pro", "monthly");
    stubStripe({
      "GET /v1/customers/": () => ({ id: "cus", metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/checkout/sessions": () => ({ id: "cs_add", url: "https://checkout.stripe.com/c/pay/cs_add" }),
    });
    expect((await mcp("add_storage", {}, key, withAddon())).data.checkout_url).toBe("https://checkout.stripe.com/c/pay/cs_add");
  });

  it("an add-on page completed after the plan went yearly: acknowledged, nothing added, no Stripe update, not claimed", async () => {
    const { accountId } = await paidAccount("pro", "monthly");
    const calls = stubStripe({ "GET /v1/subscriptions/sub_yr": () => sub(accountId, [item("si_1", PRO_YEARLY)]) });
    const done = evt("checkout.session.completed", {
      id: "cs_addon_yr",
      mode: "setup",
      status: "complete",
      client_reference_id: accountId,
      setup_intent: "seti_yr",
      metadata: { app: "recitbot", account_id: accountId, purpose: "storage_addon", subscription_id: "sub_yr" },
    });
    expect((await webhook(done)).status).toBe(200);
    expect(paths(calls)).toEqual(["GET /v1/subscriptions/sub_yr"]);
    expect((await rowOf(accountId)).storage_addons).toBe(0);
    expect(await env.DB.prepare("SELECT session_id FROM storage_addon_sessions WHERE session_id = 'cs_addon_yr'").first()).toBeNull();
  });
});

describe("bot-facing text", () => {
  it("upgrade's description and the playbook give both Pro prices and tell the bot to ask monthly or yearly", async () => {
    const { BILLING_TOOLS } = await import("../src/billing-tools");
    const desc = (BILLING_TOOLS.upgrade as unknown as { description: string }).description;
    expect(desc).toMatch(/\$10 USD per month or \$100 USD per year/);
    expect(desc).toMatch(/ask them before calling/);
    expect(PLAYBOOK_VERSION).toBe("2026.11.22-1");
    expect(PLAYBOOK_TEXT).toMatch(/Pro \$10\/mo or \$100\/yr\./);
    expect(PLAYBOOK_TEXT).toMatch(/ask\s+the user whether they want monthly or yearly/);
    expect(PLAYBOOK_TEXT).toMatch(/STORAGE_ADDON_MONTHLY_ONLY/);
    expect(MCP_INSTRUCTIONS).toMatch(/Pro is \$10\/mo or \$100\/yr:/);
  });

  it("Teams is coming soon: no bot text offers it or quotes a Teams price", async () => {
    const { BILLING_TOOLS } = await import("../src/billing-tools");
    const res = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    // Every tool's description and input schema (parameter descriptions included).
    const descs = ((await res.json()) as any).result.tools.map((t: unknown) => JSON.stringify(t)) as string[];
    expect(descs.length).toBeGreaterThan(10);
    const teamsPrice = /\$8\b|\$80\b|per user|\/user/;
    for (const text of [PLAYBOOK_TEXT, MCP_INSTRUCTIONS, ...descs]) {
      expect(text).not.toMatch(teamsPrice);
      // Teams appears only as "coming soon".
      for (const m of text.matchAll(/Teams[^.]*/g)) expect(m[0]).toMatch(/^Teams is coming soon/);
    }
    for (const t of [BILLING_TOOLS.upgrade, BILLING_TOOLS.get_plan] as unknown as { description: string }[]) {
      expect(t.description).toContain("Teams is coming soon");
    }
    expect(PLAYBOOK_TEXT).toContain("Teams is coming soon");
    expect(MCP_INSTRUCTIONS).toContain("Teams is coming soon");
  });

  it("get_plan on Free says Teams is coming soon, without a Teams price", async () => {
    const free = await seedAccount(false);
    const note = (await mcp("get_plan", {}, free.key)).data.note as string;
    expect(note).toContain("Teams is coming soon");
    expect(note).not.toMatch(/\$8\b|\$80\b|per user/);
  });
});
