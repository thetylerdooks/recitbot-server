// Custom video domains and page branding come with Recitbot Pro, Teams and owner (entitlements.ts canUseCustomBranding):
// limits and entitlements, get_plan / upgrade / cancel text, the webhook's price -> plan mapping, and custom domains
// retired when the account leaves Pro or Teams. Stripe API stubbed (stripeDeps.fetch).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { retireAccountDomains } from "../src/domain-retire";
import { canUseCustomBranding } from "../src/entitlements";
import { accountLimits, tierLimits, type Env } from "../src/env";
import { storageStatus } from "../src/storage";
import { planForPrice, signStripePayload, stripeDeps } from "../src/stripe";
import { now } from "../src/util";
import wranglerConfig from "../wrangler.example.jsonc?raw";
import { call, mcp, seedAccount, withEnv } from "./helpers";

const SECRET = "PLACEHOLDER_STRIPE_WEBHOOK_SECRET";
const PRO = "price_PLACEHOLDER_PRO";
const TEAMS = "price_PLACEHOLDER_TEAMS";
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
    return Response.json(routes[key](params));
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
const evt = (type: string, object: object) => ({ id: `evt_pg_${Date.now()}_${evN++}`, type, data: { object } });

const item = (id: string, price: string, quantity = 1) => ({ id, quantity, price: { id: price }, current_period_end: 1_900_000_000 });
const sub = (acct: string, items: object[], extra: object = {}) => ({
  id: "sub_pg",
  object: "subscription",
  status: "active",
  customer: "cus_pg",
  cancel_at_period_end: false,
  metadata: { app: "recitbot", account_id: acct },
  items: { data: items },
  ...extra,
});

let custN = 0;
/** A paid account with a stored Stripe customer and subscription sub_pg. */
async function paidAccount(plan: string, status = "active") {
  const a = await seedAccount(false);
  const cust = `cus_pg_${Date.now()}_${custN++}`;
  await env.DB.prepare("UPDATE accounts SET plan = ?, plan_status = ?, current_period_end = 1900000000, stripe_customer_id = ?, stripe_subscription_id = 'sub_pg' WHERE id = ?")
    .bind(plan, status, cust, a.accountId)
    .run();
  return { ...a, cust };
}
const planOf = async (id: string) =>
  (await env.DB.prepare("SELECT plan, plan_status, storage_addons FROM accounts WHERE id = ?").bind(id).first<{ plan: string; plan_status: string; storage_addons: number }>())!;

let hostN = 0;
async function seedDomain(accountId: string, status: string, extra: { redirect_until?: number } = {}) {
  const id = `cd_${Date.now()}_${hostN++}`;
  await env.DB.prepare(
    "INSERT INTO custom_domains (id, account_id, hostname, status, redirect_to, redirect_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
  )
    .bind(id, accountId, `v${hostN}-${id.toLowerCase()}.example.com`, status, extra.redirect_until ? "new.example.com" : null, extra.redirect_until ?? null)
    .run();
  return id;
}
const domain = (id: string) =>
  env.DB.prepare("SELECT status, redirect_to, redirect_until, updated_at FROM custom_domains WHERE id = ?")
    .bind(id)
    .first<{ status: string; redirect_to: string | null; redirect_until: number | null; updated_at: number }>();


describe("custom domain and branding entitlement", () => {
  it("Pro, Teams and owner get the custom domain with their limits; Free doesn't", () => {
    const { tier: _a, customDomain: proDomain, ...pro } = tierLimits("pro");
    const { tier: _b, customDomain: teamsDomain, ...teams } = tierLimits("teams");
    expect(teams).toEqual(pro);
    expect(pro).toMatchObject({ watermark: false, keepForever: true, maxDevices: null, freeRecordings: null, transcribeMinPerDay: 600 });
    expect([proDomain, teamsDomain]).toEqual([true, true]);
    expect(Object.fromEntries((["free", "pro", "teams", "owner"] as const).map((t) => [t, tierLimits(t).customDomain]))).toEqual({
      free: false,
      pro: true,
      teams: true,
      owner: true,
    });
    expect(["pro", "teams", "owner", "free", "PRO", "Pro", "canceled", ""].map(canUseCustomBranding)).toEqual([true, true, true, false, false, false, false, false]);
  });

  it("an unknown accounts.plan value is read as Free: no custom domain, no storage cap", async () => {
    const { accountId } = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'business', storage_addons = 1 WHERE id = ?").bind(accountId).run();
    const limits = await accountLimits(env, accountId);
    expect(limits).toMatchObject({ tier: "free", customDomain: false, watermark: true });
    expect((await storageStatus(env, accountId, limits)).limit).toBeNull();
  });

  it("price -> plan: Pro and Teams prices; unknown and unset ids map to nothing", () => {
    expect([PRO, TEAMS, ADDON, "price_other", "", undefined].map((p) => planForPrice(env, p))).toEqual(["pro", "teams", null, null, null, null]);
    expect(planForPrice(withEnv({ STRIPE_TEAMS_PRICE_ID: "" }), "")).toBeNull();
  });

  it("the self-host template documents exactly the Pro, Teams and storage add-on plan prices (placeholders only)", () => {
    expect(wranglerConfig.match(/"STRIPE_[A-Z_]*PRICE_ID"/g)).toEqual([
      '"STRIPE_PRO_PRICE_ID"',
      '"STRIPE_PRO_YEARLY_PRICE_ID"',
      '"STRIPE_TEAMS_PRICE_ID"',
      '"STRIPE_TEAMS_YEARLY_PRICE_ID"',
      '"STRIPE_STORAGE_ADDON_PRICE_ID"',
    ]);
    for (const m of wranglerConfig.matchAll(/"STRIPE_[A-Z_]*PRICE_ID": "([^"]*)"/g)) expect(m[1]).toMatch(/^price_PLACEHOLDER_[A-Z_]+$/);
  });
});

describe("get_plan and account_info for Pro", () => {
  it("Pro: $10, custom_domain, and the note says so", async () => {
    const { key } = await paidAccount("pro");
    const r = await mcp("get_plan", {}, key);
    expect(r.data).toMatchObject({ plan: "Pro", status: "active", renews_on: "2030-03-17", price: "$10 USD per month plus applicable tax", limits: { custom_domain: true, watermark: false } });
    expect(r.data.note).toMatch(/one custom video domain and page branding/);
    expect((await mcp("account_info", {}, key)).data).toMatchObject({ plan: "Pro", limits: { custom_domain: true }, storage_limit_bytes: 100e9 });
  });

  it("Pro canceled at period end: the note says the custom domain then redirects", async () => {
    const { accountId, key } = await paidAccount("pro");
    await env.DB.prepare("UPDATE accounts SET cancel_at_period_end = 1 WHERE id = ?").bind(accountId).run();
    const r = await mcp("get_plan", {}, key);
    expect(r.data).toMatchObject({ plan: "Pro", renews_on: null, ends_on: "2030-03-17" });
    expect(r.data.note).toMatch(/goes back to Free; the custom video domain then redirects to example\.test for 30 days/);
  });

  it("Free: no custom domain; the Pro upsell names the custom domain and branding", async () => {
    const { key } = await seedAccount(false);
    const r = await mcp("get_plan", {}, key);
    expect(r.data).toMatchObject({ plan: "Free", limits: { custom_domain: false } });
    expect(r.data.note).toMatch(/Recitbot Pro \(\$10 USD per month or \$100 USD per year, plus applicable tax\) .*adds one custom video domain and page branding: call upgrade/);
  });
});

describe("upgrade", () => {
  it("Pro and Teams: nothing to buy, nothing created; owner: nothing to buy", async () => {
    for (const plan of ["pro", "teams"]) {
      const a = await paidAccount(plan);
      const calls = stubStripe({
        "GET /v1/customers/": () => ({ id: a.cust, metadata: { app: "recitbot", account_id: a.accountId } }),
        "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/pg" }),
      });
      const r = await mcp("upgrade", {}, a.key);
      const name = plan === "pro" ? "Pro" : "Teams";
      expect(r.data).toMatchObject({ plan: name, already: true, billing_url: "https://billing.stripe.com/p/session/pg" });
      expect(r.data.note).toMatch(new RegExp(`already on Recitbot ${name}; there is nothing to buy`));
      expect(paths(calls).some((p) => p.includes("/subscriptions") || p.includes("/checkout"))).toBe(false);
      expect((await planOf(a.accountId)).plan).toBe(plan);
    }
    const owner = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(owner.accountId).run();
    expect((await mcp("upgrade", {}, owner.key)).data).toMatchObject({ plan: "Owner", already: true, checkout_url: null });
  });

  it("only plan pro can be asked for", async () => {
    const { key } = await seedAccount(false);
    const calls = stubStripe({});
    const r = await mcp("upgrade", { plan: "teams" }, key);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("webhook: price -> plan", () => {
  function stripeHas(s: object) {
    return stubStripe({ "GET /v1/subscriptions/sub_pg": () => s });
  }

  it("maps both plan prices, wherever the add-on item sits, and keeps the add-on count", async () => {
    const cases: [object[], string, number][] = [
      [[item("si_1", PRO)], "pro", 0],
      [[item("si_a", ADDON, 3), item("si_1", PRO)], "pro", 3],
      [[item("si_1", PRO), item("si_a", ADDON, 1)], "pro", 1],
      [[item("si_1", TEAMS)], "teams", 0],
      [[item("si_a", ADDON, 2), item("si_1", TEAMS)], "teams", 2],
    ];
    for (const [items, plan, addons] of cases) {
      const { accountId } = await paidAccount("free", "incomplete");
      const s = sub(accountId, items);
      stripeHas(s);
      expect((await webhook(evt("customer.subscription.updated", s))).status).toBe(200);
      expect(await planOf(accountId), JSON.stringify(items)).toMatchObject({ plan, plan_status: "active", storage_addons: addons });
    }
  });

  it("an unknown plan price leaves the plan and the custom domain as they are (status still syncs)", async () => {
    const { accountId } = await paidAccount("pro");
    const live = await seedDomain(accountId, "active");
    const s = sub(accountId, [item("si_1", "price_mystery")], { status: "trialing" });
    stripeHas(s);
    expect((await webhook(evt("customer.subscription.updated", s))).status).toBe(200);
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", plan_status: "trialing" });
    expect((await domain(live))!.status).toBe("active");
  });
});

describe("leaving Pro or Teams retires custom domains", () => {
  function stripeHas(s: object) {
    return stubStripe({ "GET /v1/subscriptions/sub_pg": () => s });
  }
  /** One active hostname, an older redirecting one, a failed one, and another account's active one. */
  async function domains(accountId: string) {
    const other = await paidAccount("pro");
    return {
      live: await seedDomain(accountId, "active"),
      old: await seedDomain(accountId, "redirecting", { redirect_until: 2_000_000_000 }),
      failed: await seedDomain(accountId, "failed"),
      others: await seedDomain(other.accountId, "active"),
    };
  }
  async function expectRetired(d: Awaited<ReturnType<typeof domains>>) {
    expect(await domain(d.live)).toMatchObject({ status: "redirecting", redirect_to: "example.test" });
    expect(await domain(d.old)).toMatchObject({ status: "redirecting", redirect_to: "example.test", redirect_until: 2_000_000_000, updated_at: (await domain(d.live))!.updated_at });
    expect(await domain(d.failed)).toMatchObject({ status: "failed", redirect_to: null, updated_at: 1 });
    expect(await domain(d.others)).toMatchObject({ status: "active", updated_at: 1 });
  }
  async function expectKept(d: Awaited<ReturnType<typeof domains>>) {
    expect(await domain(d.live)).toMatchObject({ status: "active", redirect_to: null, updated_at: 1 });
    expect(await domain(d.old)).toMatchObject({ status: "redirecting", redirect_to: "new.example.com", updated_at: 1 });
    expect(await domain(d.others)).toMatchObject({ status: "active", updated_at: 1 });
  }

  it("Pro canceled -> Free: the live hostname redirects to example.test for 30 days; other rows and accounts untouched", async () => {
    const { accountId } = await paidAccount("pro");
    const d = await domains(accountId);
    // Canceled at period end and past_due: still Pro, nothing moves.
    stripeHas(sub(accountId, [item("si_1", PRO)], { cancel_at_period_end: true }));
    await webhook(evt("customer.subscription.updated", sub(accountId, [])));
    stripeHas(sub(accountId, [item("si_1", PRO)], { status: "past_due" }));
    await webhook(evt("invoice.payment_failed", { id: "in_pg", parent: { subscription_details: { subscription: "sub_pg", metadata: { app: "recitbot", account_id: accountId } } } }));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", plan_status: "past_due" });
    await expectKept(d);

    stripeHas(sub(accountId, [item("si_1", PRO)], { status: "canceled" }));
    const t = now();
    await webhook(evt("customer.subscription.deleted", sub(accountId, [])));
    expect((await planOf(accountId)).plan).toBe("free");
    await expectRetired(d);
    const live = (await domain(d.live))!;
    expect(live.updated_at).toBeGreaterThanOrEqual(t);
    expect(live.redirect_until).toBe(live.updated_at + 30 * 86400);
  });

  it("unpaid Pro and canceled Teams -> Free retire too; Pro -> Teams, Teams -> Pro and Pro renewals don't", async () => {
    const unpaid = await paidAccount("pro");
    const d = await domains(unpaid.accountId);
    stripeHas(sub(unpaid.accountId, [item("si_1", PRO)], { status: "unpaid" }));
    await webhook(evt("customer.subscription.updated", sub(unpaid.accountId, [])));
    expect((await planOf(unpaid.accountId)).plan).toBe("free");
    await expectRetired(d);

    const teams = await paidAccount("teams");
    const t = await domains(teams.accountId);
    stripeHas(sub(teams.accountId, [item("si_1", TEAMS)], { status: "canceled" }));
    await webhook(evt("customer.subscription.deleted", sub(teams.accountId, [])));
    expect((await planOf(teams.accountId)).plan).toBe("free");
    await expectRetired(t);

    const up = await paidAccount("pro");
    const kept = await domains(up.accountId);
    stripeHas(sub(up.accountId, [item("si_1", TEAMS)]));
    await webhook(evt("customer.subscription.updated", sub(up.accountId, [])));
    expect((await planOf(up.accountId)).plan).toBe("teams");
    stripeHas(sub(up.accountId, [item("si_1", PRO)]));
    await webhook(evt("customer.subscription.updated", sub(up.accountId, [])));
    expect((await planOf(up.accountId)).plan).toBe("pro");
    await webhook(evt("invoice.paid", { id: "in_pg2", parent: { subscription_details: { subscription: "sub_pg", metadata: { app: "recitbot", account_id: up.accountId } } } }));
    expect((await planOf(up.accountId)).plan).toBe("pro");
    await expectKept(kept);
  });

  it("owner accounts are never touched, Teams renewals keep the domain", async () => {
    const owner = await paidAccount("owner");
    const ownerDomain = await seedDomain(owner.accountId, "active");
    stripeHas(sub(owner.accountId, [item("si_1", PRO)], { status: "canceled" }));
    await webhook(evt("customer.subscription.deleted", sub(owner.accountId, [])));
    expect((await planOf(owner.accountId)).plan).toBe("owner");
    expect((await domain(ownerDomain))!.status).toBe("active");

    const teams = await paidAccount("teams");
    const teamsDomain = await seedDomain(teams.accountId, "active");
    stripeHas(sub(teams.accountId, [item("si_1", TEAMS)]));
    await webhook(evt("invoice.paid", { id: "in_pg3", parent: { subscription_details: { subscription: "sub_pg", metadata: { app: "recitbot", account_id: teams.accountId } } } }));
    expect((await planOf(teams.accountId)).plan).toBe("teams");
    expect((await domain(teamsDomain))!.status).toBe("active");
  });

  it("retireAccountDomains: moves only pending and active rows of that account, returns how many", async () => {
    const a = await seedAccount(false);
    const pending = await seedDomain(a.accountId, "pending");
    const other = await seedAccount(false);
    const theirs = await seedDomain(other.accountId, "pending");
    expect(await retireAccountDomains(env, a.accountId, 1_800_000_000)).toBe(1);
    expect(await domain(pending)).toEqual({ status: "redirecting", redirect_to: "example.test", redirect_until: 1_800_000_000 + 30 * 86400, updated_at: 1_800_000_000 });
    expect((await domain(theirs))!.status).toBe("pending");
    expect(await retireAccountDomains(env, a.accountId, 1_800_000_100)).toBe(0);
  });

  it("cancel_subscription on Pro and Teams names the plan and says what happens to the domain", async () => {
    for (const [plan, name] of [["pro", "Pro"], ["teams", "Teams"]]) {
      const { accountId, key, cust } = await paidAccount(plan);
      stubStripe({
        "GET /v1/customers/": () => ({ id: cust, metadata: { app: "recitbot", account_id: accountId } }),
        "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/pgc" }),
      });
      const r = await mcp("cancel_subscription", {}, key);
      expect(r.data).toMatchObject({ cancel_url: "https://billing.stripe.com/p/session/pgc", plan: name });
      expect(r.data.note).toMatch(new RegExp(`${name} stays active until the end of the paid period`));
      expect(r.data.note).toMatch(/redirects to example\.test for 30 days/);
    }
  });
});
