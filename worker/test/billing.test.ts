// Recitbot Pro: get_plan / upgrade / billing tools (Stripe API stubbed), the Stripe webhook, plan enforcement.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { pairDevice, issuePairingCode } from "../src/auth";
import { accountLimits, LIMITS } from "../src/env";
import { expiredRecordingIds, KEEP_FOREVER } from "../src/share";
import { signStripePayload, stripeDeps, verifyStripeSignature } from "../src/stripe";
import { now } from "../src/util";
import { call, mcp, seedAccount, seedDevice, seedReady, withEnv } from "./helpers";
// The config template that names the Stripe price.
import wranglerConfig from "../wrangler.example.jsonc?raw";

const SECRET = "PLACEHOLDER_STRIPE_WEBHOOK_SECRET";

type StripeCall = { method: string; url: string; params: URLSearchParams; headers: Record<string, string> };
const realFetch = stripeDeps.fetch;
afterEach(() => {
  stripeDeps.fetch = realFetch;
});

/** Stubs the Stripe API: routes by "METHOD /path" prefix, records every call. */
function stubStripe(routes: Record<string, (p: URLSearchParams) => unknown>): StripeCall[] {
  const calls: StripeCall[] = [];
  stripeDeps.fetch = async (input, init) => {
    const u = new URL(input);
    const params = new URLSearchParams(init.method === "POST" ? String(init.body ?? "") : u.search);
    calls.push({ method: init.method!, url: input, params, headers: init.headers as Record<string, string> });
    const key = Object.keys(routes).find((k) => `${init.method} ${u.pathname}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 404 });
    return Response.json(routes[key](params));
  };
  return calls;
}

async function webhook(event: object, opts: { t?: number; secret?: string; header?: string } = {}) {
  const body = JSON.stringify(event);
  const sig = opts.header ?? (await signStripePayload(opts.secret ?? SECRET, body, opts.t ?? now()));
  return call("/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body });
}

let evN = 0;
const evt = (type: string, object: object) => ({ id: `evt_test_${Date.now()}_${evN++}`, type, data: { object } });
const planOf = (id: string) =>
  env.DB.prepare("SELECT plan, plan_status, current_period_end, stripe_subscription_id, stripe_customer_id, cancel_at_period_end FROM accounts WHERE id = ?")
    .bind(id)
    .first<{ plan: string; plan_status: string | null; current_period_end: number | null; stripe_subscription_id: string | null; stripe_customer_id: string | null; cancel_at_period_end: number }>();

const completed = (acct: string, extra: object = {}) =>
  evt("checkout.session.completed", {
    id: "cs_test_1",
    object: "checkout.session",
    mode: "subscription",
    payment_status: "paid",
    client_reference_id: acct,
    customer: "cus_test_1",
    subscription: "sub_test_1",
    metadata: { app: "recitbot", account_id: acct },
    ...extra,
  });
const subscription = (acct: string, status: string, extra: object = {}) => ({
  id: "sub_test_1",
  object: "subscription",
  status,
  customer: "cus_test_1",
  cancel_at_period_end: false,
  metadata: { app: "recitbot", account_id: acct },
  items: { data: [{ price: { id: "price_PLACEHOLDER_PRO" }, current_period_end: 1_900_000_000 }] },
  ...extra,
});

describe("webhook signature", () => {
  it("accepts a good signature, refuses bad and stale ones", async () => {
    const body = '{"id":"evt_x"}';
    const t = now();
    expect(await verifyStripeSignature(SECRET, await signStripePayload(SECRET, body, t), body, t)).toBe(true);
    expect(await verifyStripeSignature(SECRET, await signStripePayload("PLACEHOLDER_OTHER_WEBHOOK_SECRET", body, t), body, t)).toBe(false);
    expect(await verifyStripeSignature(SECRET, await signStripePayload(SECRET, body, t), body + " ", t)).toBe(false);
    expect(await verifyStripeSignature(SECRET, await signStripePayload(SECRET, body, t - 301), body, t)).toBe(false);
    expect(await verifyStripeSignature(SECRET, await signStripePayload(SECRET, body, t - 299), body, t)).toBe(true);
    expect(await verifyStripeSignature(SECRET, null, body, t)).toBe(false);
    expect(await verifyStripeSignature(SECRET, `t=${t}`, body, t)).toBe(false);
  });

  it("endpoint: 400 on bad or stale signature, nothing changes", async () => {
    const { accountId } = await seedAccount(false);
    expect((await webhook(completed(accountId), { secret: "PLACEHOLDER_WRONG_WEBHOOK_SECRET" })).status).toBe(400);
    expect((await webhook(completed(accountId), { t: now() - 600 })).status).toBe(400);
    expect((await webhook(completed(accountId), { header: "garbage" })).status).toBe(400);
    expect((await planOf(accountId))!.plan).toBe("free");
  });

  it("endpoint: 404 without a webhook secret (billing is off, the route doesn't exist)", async () => {
    const body = "{}";
    const res = await call(
      "/api/stripe/webhook",
      { method: "POST", headers: { "stripe-signature": await signStripePayload(SECRET, body) }, body },
      withEnv({ STRIPE_WEBHOOK_SECRET: undefined }),
    );
    expect(res.status).toBe(404);
  });
});

describe("webhook events", () => {
  /** Stripe's current subscriptions by id (what GET /v1/subscriptions/<id> answers); missing = 404. */
  function stripeHas(subs: Record<string, object>) {
    return stubStripe(Object.fromEntries(Object.entries(subs).map(([id, sub]) => [`GET /v1/subscriptions/${id}`, () => sub])));
  }

  it("checkout.session.completed -> pro, from the subscription Stripe returns", async () => {
    const { accountId } = await seedAccount(false);
    const calls = stripeHas({ sub_test_1: subscription(accountId, "active") });
    const r = await webhook(completed(accountId));
    expect(r.status).toBe(200);
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", plan_status: "active", stripe_subscription_id: "sub_test_1", current_period_end: 1_900_000_000 });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /v1/subscriptions/sub_test_1"]);
  });

  it("is idempotent per event id", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(accountId, "active") });
    const e = completed(accountId);
    expect(await (await webhook(e)).json()).toEqual({ received: true });
    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(accountId).run();
    expect(await (await webhook(e)).json()).toEqual({ received: true, duplicate: true });
    expect((await planOf(accountId))!.plan).toBe("free");
  });

  it("ignores foreign (non-recitbot) objects, also when the payload claims recitbot but Stripe's subscription doesn't", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(accountId, "active", { metadata: { app: "otherapp", account_id: accountId } }) });
    for (const e of [
      completed(accountId, { metadata: { account_id: accountId } }),
      completed(accountId, { metadata: { app: "otherapp", account_id: accountId } }),
      evt("customer.subscription.updated", subscription(accountId, "active", { metadata: { account_id: accountId } })),
      evt("invoice.paid", { id: "in_1", subscription: "sub_x", lines: { data: [{ period: { end: 1_900_000_000 } }] } }),
      completed(accountId),
      evt("customer.subscription.updated", subscription(accountId, "active")),
    ]) {
      expect((await webhook(e)).status).toBe(200);
    }
    expect(await planOf(accountId)).toMatchObject({ plan: "free", stripe_subscription_id: null });
  });

  it("the plan follows Stripe's current status, not the event's: late and out-of-order events can't move it backwards", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(accountId, "active", { cancel_at_period_end: true }) });
    await webhook(completed(accountId));
    // An old "incomplete" created event and a stale "canceled" payload arrive late: Stripe says active.
    await webhook(evt("customer.subscription.created", subscription(accountId, "incomplete")));
    await webhook(evt("customer.subscription.updated", subscription(accountId, "canceled")));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", plan_status: "active", current_period_end: 1_900_000_000, cancel_at_period_end: 1 });
    // Now Stripe has it canceled: any event about it (even an "active" payload) sets free.
    stripeHas({ sub_test_1: subscription(accountId, "canceled") });
    await webhook(evt("customer.subscription.updated", subscription(accountId, "active")));
    expect(await planOf(accountId)).toMatchObject({ plan: "free", plan_status: "canceled" });
  });

  it("deleted -> free, also when Stripe no longer returns the subscription", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(accountId, "active") });
    await webhook(completed(accountId));
    stripeHas({});
    await webhook(evt("customer.subscription.deleted", subscription(accountId, "active")));
    expect(await planOf(accountId)).toMatchObject({ plan: "free", plan_status: "canceled" });
  });

  it("unpaid -> free; invoice.payment_failed -> past_due (still pro); invoice.paid (new API shape) -> active", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(accountId, "active") });
    await webhook(completed(accountId));
    const md = { app: "recitbot", account_id: accountId };
    stripeHas({ sub_test_1: subscription(accountId, "past_due") });
    await webhook(evt("invoice.payment_failed", { id: "in_1", parent: { subscription_details: { subscription: "sub_test_1", metadata: md } } }));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", plan_status: "past_due" });
    stripeHas({ sub_test_1: subscription(accountId, "active", { items: { data: [{ price: { id: "price_PLACEHOLDER_PRO" }, current_period_end: 1_950_000_000 }] } }) });
    await webhook(evt("invoice.paid", { id: "in_2", parent: { subscription_details: { subscription: "sub_test_1", metadata: md } } }));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", plan_status: "active", current_period_end: 1_950_000_000 });
    stripeHas({ sub_test_1: subscription(accountId, "unpaid") });
    await webhook(evt("customer.subscription.updated", subscription(accountId, "unpaid")));
    expect((await planOf(accountId))!.plan).toBe("free");
  });

  it("events for a subscription other than the account's stored one are ignored, whatever their status", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_new: subscription(accountId, "active", { id: "sub_new" }), sub_old: subscription(accountId, "canceled", { id: "sub_old" }) });
    await webhook(completed(accountId, { subscription: "sub_new" }));
    await webhook(evt("customer.subscription.deleted", subscription(accountId, "canceled", { id: "sub_old" })));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", stripe_subscription_id: "sub_new" });
    // A stray active subscription of the same account doesn't take over either.
    stripeHas({ sub_new: subscription(accountId, "canceled", { id: "sub_new" }), sub_other: subscription(accountId, "active", { id: "sub_other" }) });
    await webhook(evt("customer.subscription.updated", subscription(accountId, "active", { id: "sub_other" })));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", stripe_subscription_id: "sub_new" });
    await webhook(evt("invoice.paid", { id: "in_3", parent: { subscription_details: { subscription: "sub_other", metadata: { app: "recitbot", account_id: accountId } } } }));
    expect(await planOf(accountId)).toMatchObject({ stripe_subscription_id: "sub_new" });
  });

  it("an account with no stored subscription takes the first one; a paid checkout of the account replaces an ended one", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_a: subscription(accountId, "active", { id: "sub_a" }) });
    await webhook(evt("customer.subscription.created", subscription(accountId, "active", { id: "sub_a" })));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", stripe_subscription_id: "sub_a" });
    stripeHas({ sub_a: subscription(accountId, "canceled", { id: "sub_a" }), sub_b: subscription(accountId, "active", { id: "sub_b" }) });
    await webhook(evt("customer.subscription.deleted", subscription(accountId, "canceled", { id: "sub_a" })));
    expect(await planOf(accountId)).toMatchObject({ plan: "free", stripe_subscription_id: "sub_a" });
    // sub_b's own events before its checkout completes: ignored (sub_a is stored).
    await webhook(evt("customer.subscription.created", subscription(accountId, "active", { id: "sub_b" })));
    expect((await planOf(accountId))!.plan).toBe("free");
    await webhook(completed(accountId, { id: "cs_b", subscription: "sub_b" }));
    expect(await planOf(accountId)).toMatchObject({ plan: "pro", stripe_subscription_id: "sub_b" });
  });

  it("an event naming one account for another account's subscription changes nothing", async () => {
    const mine = await seedAccount(false);
    const theirs = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(theirs.accountId, "active") });
    await webhook(completed(mine.accountId));
    await webhook(evt("invoice.paid", { id: "in_4", parent: { subscription_details: { subscription: "sub_test_1", metadata: { app: "recitbot", account_id: mine.accountId } } } }));
    expect(await planOf(mine.accountId)).toMatchObject({ plan: "free", stripe_subscription_id: null });
    expect((await planOf(theirs.accountId))!.plan).toBe("free");
  });

  it("downgrade to Free: Pro's keep-forever recordings get Free retention from the downgrade time, not deleted on the spot", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(accountId, "active") });
    await webhook(completed(accountId));
    const forever = [await seedReady(accountId, { expiresAt: KEEP_FOREVER }), await seedReady(accountId, { expiresAt: KEEP_FOREVER })];
    const freeEra = await seedReady(accountId, { expiresAt: now() + 3 * 86400 });
    const other = await seedAccount(false);
    const otherForever = await seedReady(other.accountId, { expiresAt: KEEP_FOREVER });
    const expiry = (id: string) => env.DB.prepare("SELECT expires_at FROM recordings WHERE id = ?").bind(id).first<number>("expires_at");

    // Canceled at period end, then past_due: still paid, nothing moves.
    stripeHas({ sub_test_1: subscription(accountId, "active", { cancel_at_period_end: true }) });
    await webhook(evt("customer.subscription.updated", subscription(accountId, "active")));
    stripeHas({ sub_test_1: subscription(accountId, "past_due") });
    await webhook(evt("customer.subscription.updated", subscription(accountId, "past_due")));
    for (const id of forever) expect(await expiry(id)).toBe(KEEP_FOREVER);

    const before = now();
    stripeHas({ sub_test_1: subscription(accountId, "canceled") });
    await webhook(evt("customer.subscription.deleted", subscription(accountId, "canceled")));
    const after = now();
    expect((await planOf(accountId))!.plan).toBe("free");
    for (const id of forever) {
      const e = (await expiry(id))!;
      expect(e).toBeGreaterThanOrEqual(before + LIMITS.retentionSeconds);
      expect(e).toBeLessThanOrEqual(after + LIMITS.retentionSeconds);
    }
    expect(await expiry(freeEra)).toBeLessThan(before + 4 * 86400); // its own expiry, unchanged
    expect(await expiry(otherForever)).toBe(KEEP_FOREVER); // other accounts untouched
    // Not deleted now; due for the cleanup only once Free retention has run out.
    expect(await expiredRecordingIds(env, after)).not.toEqual(expect.arrayContaining([forever[0]]));
    expect(await expiredRecordingIds(env, after + LIMITS.retentionSeconds + 1)).toEqual(expect.arrayContaining(forever));

    // A repeat of the downgrade event (already free) changes nothing more.
    const once = await expiry(forever[0]);
    await webhook(evt("customer.subscription.updated", subscription(accountId, "canceled")));
    expect(await expiry(forever[0])).toBe(once);
  });

  it("downgrade of an OWNER_ACCOUNT_IDS account with a subscription: nothing changes, recordings stay forever", async () => {
    const { accountId } = await seedAccount(false);
    stripeHas({ sub_test_1: subscription(accountId, "active") });
    await webhook(completed(accountId));
    const kept = await seedReady(accountId, { expiresAt: KEEP_FOREVER });
    stripeHas({ sub_test_1: subscription(accountId, "canceled") });
    const body = JSON.stringify(evt("customer.subscription.deleted", subscription(accountId, "canceled")));
    const res = await call(
      "/api/stripe/webhook",
      { method: "POST", headers: { "stripe-signature": await signStripePayload(SECRET, body), "content-type": "application/json" }, body },
      withEnv({ OWNER_ACCOUNT_IDS: accountId }),
    );
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT expires_at FROM recordings WHERE id = ?").bind(kept).first("expires_at")).toBe(KEEP_FOREVER);
  });

  it("Stripe unreachable: 500 and the event is released for Stripe's retry", async () => {
    const { accountId } = await seedAccount(false);
    stubStripe({ "GET /v1/subscriptions/": () => { throw new Error("network down"); } });
    const e = completed(accountId);
    expect((await webhook(e)).status).toBe(500);
    stripeHas({ sub_test_1: subscription(accountId, "active") });
    expect(await (await webhook(e)).json()).toEqual({ received: true });
    expect((await planOf(accountId))!.plan).toBe("pro");
  });
});

describe("upgrade", () => {
  it("creates a customer and a Checkout Session; returns the bot-facing shape", async () => {
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(`u-${accountId}@example.com`, accountId, now()).run();
    const calls = stubStripe({
      "POST /v1/customers": () => ({ id: "cus_new_1" }),
      "POST /v1/checkout/sessions": () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", expires_at: 1_900_000_000 }),
    });
    const r = await mcp("upgrade", { plan: "pro" }, key);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      checkout_url: "https://checkout.stripe.com/c/pay/cs_1",
      plan: "Pro",
      price: "$10 USD per month plus applicable tax",
      renews: "monthly from the day you pay",
    });
    expect(r.data.note).toMatch(/explicit yes/);
    expect(r.data.note).toMatch(/No card data is ever sent to Recitbot/);

    const [cust, sess] = calls;
    expect(cust.params.get("email")).toBe(`u-${accountId}@example.com`);
    expect(cust.params.get("metadata[app]")).toBe("recitbot");
    expect(cust.params.get("metadata[account_id]")).toBe(accountId);
    expect(cust.headers.authorization).toBe("Bearer PLACEHOLDER_STRIPE_SECRET_KEY");
    const p = Object.fromEntries(sess.params);
    expect(p).toMatchObject({
      mode: "subscription",
      customer: "cus_new_1",
      "line_items[0][price]": "price_PLACEHOLDER_PRO",
      "line_items[0][quantity]": "1",
      "automatic_tax[enabled]": "true",
      "customer_update[address]": "auto",
      allow_promotion_codes: "true",
      client_reference_id: accountId,
      "metadata[app]": "recitbot",
      "metadata[account_id]": accountId,
      "subscription_data[metadata][app]": "recitbot",
      "subscription_data[metadata][account_id]": accountId,
    });
    expect(p.success_url).toMatch(/\/billing\/success$/);
    expect(p.cancel_url).toMatch(/\/billing\/cancel$/);
    // No card fields anywhere: not in what we send, not in what the bot gets.
    for (const c of calls) expect([...c.params.keys()].join(" ")).not.toMatch(/card|cvc|exp_|number|payment_method/i);
    expect(JSON.stringify(r.data)).not.toMatch(/"(card|cvc|card_number|payment_method)"/i);
    expect((await planOf(accountId))!.stripe_customer_id).toBe("cus_new_1");

    expect(await env.DB.prepare("SELECT checkout_session_id FROM accounts WHERE id = ?").bind(accountId).first("checkout_session_id")).toBe("cs_1");

    // A second upgrade (the stored session is gone at Stripe) reuses the stored customer and stores the new session.
    const again = stubStripe({ "POST /v1/checkout/sessions": () => ({ id: "cs_2", url: "https://checkout.stripe.com/c/pay/cs_2" }) });
    await mcp("upgrade", {}, key);
    expect(again.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /v1/checkout/sessions/cs_1", "POST /v1/checkout/sessions"]);
    expect(again[1].params.get("customer")).toBe("cus_new_1");
    expect(await env.DB.prepare("SELECT checkout_session_id FROM accounts WHERE id = ?").bind(accountId).first("checkout_session_id")).toBe("cs_2");
  });

  const session = (acct: string, extra: object = {}) => ({
    id: "cs_open",
    url: "https://checkout.stripe.com/c/pay/cs_open",
    status: "open",
    expires_at: now() + 3600,
    client_reference_id: acct,
    metadata: { app: "recitbot", account_id: acct },
    ...extra,
  });
  const storeSession = (acct: string, id: string, at: number) =>
    env.DB.prepare("UPDATE accounts SET stripe_customer_id = ?, checkout_session_id = ?, checkout_session_created_at = ? WHERE id = ?").bind(`cus_${acct}`, id, at, acct).run();

  it("an open Checkout Session from the last 24 h is returned again; nothing new is created", async () => {
    const { accountId, key } = await seedAccount(false);
    await storeSession(accountId, "cs_open", now() - 3600);
    const calls = stubStripe({ "GET /v1/checkout/sessions/cs_open": () => session(accountId) });
    const r = await mcp("upgrade", {}, key);
    expect(r.data).toMatchObject({ checkout_url: "https://checkout.stripe.com/c/pay/cs_open", plan: "Pro", reused: true });
    expect(r.data.note).toMatch(/explicit yes/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a completed stored session: already paid, nothing created; expired, foreign or older than 24 h: a new one", async () => {
    const { accountId, key } = await seedAccount(false);
    await storeSession(accountId, "cs_open", now() - 60);
    let calls = stubStripe({ "GET /v1/checkout/sessions/cs_open": () => session(accountId, { status: "complete", url: null }) });
    const paid = await mcp("upgrade", {}, key);
    expect(paid.data).toMatchObject({ already: true, checkout_url: null });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);

    const fresh = { "POST /v1/checkout/sessions": () => ({ id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" }) };
    for (const prev of [session(accountId, { status: "expired" }), session("someone-else"), session(accountId, { metadata: { app: "otherapp", account_id: accountId } })]) {
      await storeSession(accountId, "cs_open", now() - 60);
      calls = stubStripe({ "GET /v1/checkout/sessions/cs_open": () => prev, ...fresh });
      expect((await mcp("upgrade", {}, key)).data).toMatchObject({ checkout_url: "https://checkout.stripe.com/c/pay/cs_new", reused: false });
      expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    }
    // Older than 24 h: not even looked up.
    await storeSession(accountId, "cs_open", now() - 24 * 3600 - 1);
    calls = stubStripe({ "GET /v1/checkout/sessions/cs_open": () => session(accountId), ...fresh });
    expect((await mcp("upgrade", {}, key)).data.reused).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("a stored subscription that is active, trialing or past_due: already Pro with the billing link, no Checkout", async () => {
    for (const status of ["active", "trialing", "past_due"]) {
      const { accountId, key } = await seedAccount(false);
      // plan still 'free' (say the webhook hasn't landed): the subscription alone is enough.
      await env.DB.prepare("UPDATE accounts SET plan_status = ?, stripe_subscription_id = 'sub_live', stripe_customer_id = ? WHERE id = ?")
        .bind(status, `cus_${accountId}`, accountId)
        .run();
      const calls = stubStripe({
        "GET /v1/customers/": () => ({ id: `cus_${accountId}`, metadata: { app: "recitbot", account_id: accountId } }),
        "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/x" }),
      });
      const r = await mcp("upgrade", {}, key);
      expect(r.data, status).toMatchObject({ already: true, billing_url: "https://billing.stripe.com/p/session/x" });
      expect(r.data.checkout_url).toBeUndefined();
      expect(calls.some((c) => c.url.includes("/checkout/sessions"))).toBe(false);
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/customers"))).toBe(false);
    }
    // canceled: a new Checkout is fine.
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan_status = 'canceled', stripe_subscription_id = 'sub_old', stripe_customer_id = ? WHERE id = ?").bind(`cus_${accountId}`, accountId).run();
    stubStripe({ "POST /v1/checkout/sessions": () => ({ id: "cs_back", url: "https://checkout.stripe.com/c/pay/cs_back" }) });
    expect((await mcp("upgrade", {}, key)).data.checkout_url).toBe("https://checkout.stripe.com/c/pay/cs_back");
  });

  it("already Pro: says so, no session", async () => {
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro', plan_status = 'active' WHERE id = ?").bind(accountId).run();
    const calls = stubStripe({});
    const r = await mcp("upgrade", {}, key);
    expect(r.data).toMatchObject({ plan: "Pro", already: true, billing_url: null });
    expect(r.data.checkout_url).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("billing", () => {
  it("no customer: plain no-billing message", async () => {
    const { key } = await seedAccount(false);
    const calls = stubStripe({});
    const r = await mcp("billing", {}, key);
    expect(r.data.portal_url).toBeNull();
    expect(r.data.note).toMatch(/upgrade/);
    expect(calls).toHaveLength(0);
  });

  it("refuses customers Recitbot didn't create", async () => {
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET stripe_customer_id = 'cus_foreign' WHERE id = ?").bind(accountId).run();
    const calls = stubStripe({
      "GET /v1/customers/": () => ({ id: "cus_foreign", metadata: { app: "otherapp" } }),
      "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/x" }),
    });
    const r = await mcp("billing", {}, key);
    expect(r.data.portal_url).toBeNull();
    expect(calls.some((c) => c.url.includes("billing_portal"))).toBe(false);
  });

  it("recitbot customer: portal session with the configuration and return url", async () => {
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ours' WHERE id = ?").bind(accountId).run();
    const calls = stubStripe({
      "GET /v1/customers/": () => ({ id: "cus_ours", metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/y" }),
    });
    const r = await mcp("billing", {}, key);
    expect(r.data.portal_url).toBe("https://billing.stripe.com/p/session/y");
    const portal = calls.find((c) => c.url.includes("billing_portal"))!;
    expect(Object.fromEntries(portal.params)).toMatchObject({ customer: "cus_ours", configuration: "bpc_PLACEHOLDER" });
    expect(portal.params.get("return_url")).toMatch(/\/billing\/return$/);
  });
});

describe("cancel_subscription", () => {
  const proWith = (acct: string, cols: string) =>
    env.DB.prepare(`UPDATE accounts SET plan = 'pro', plan_status = 'active', current_period_end = 1900000000, ${cols} WHERE id = ?`).bind(acct).run();

  it("no subscription: says plainly there's nothing to cancel, no Stripe calls", async () => {
    const { accountId, key } = await seedAccount(false);
    const calls = stubStripe({});
    let r = await mcp("cancel_subscription", {}, key);
    expect(r.isError).toBe(false);
    expect(r.data.cancel_url).toBeNull();
    expect(r.data.note).toMatch(/^Nothing to cancel/);
    // A customer but no subscription (never finished checkout) is still nothing to cancel.
    await env.DB.prepare("UPDATE accounts SET stripe_customer_id = 'cus_cancel_0' WHERE id = ?").bind(accountId).run();
    r = await mcp("cancel_subscription", {}, key);
    expect(r.data.cancel_url).toBeNull();
    expect(r.data.note).toMatch(/^Nothing to cancel/);
    expect(calls).toHaveLength(0);
  });

  it("refuses customers Recitbot didn't create", async () => {
    const { accountId, key } = await seedAccount(false);
    await proWith(accountId, "stripe_customer_id = 'cus_foreign_cancel_1', stripe_subscription_id = 'sub_foreign'");
    const calls = stubStripe({
      "GET /v1/customers/": () => ({ id: "cus_foreign_cancel_1", metadata: { app: "otherapp", account_id: accountId } }),
      "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/x" }),
    });
    const r = await mcp("cancel_subscription", {}, key);
    expect(r.data.cancel_url).toBeNull();
    expect(r.data.note).toMatch(/^Nothing to cancel/);
    expect(calls.some((c) => c.url.includes("billing_portal"))).toBe(false);
  });

  it("active subscription: portal session with the cancel flow", async () => {
    const { accountId, key } = await seedAccount(false);
    await proWith(accountId, "stripe_customer_id = 'cus_cancel_2', stripe_subscription_id = 'sub_live_1'");
    const calls = stubStripe({
      "GET /v1/customers/": () => ({ id: "cus_cancel_2", metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/cancel" }),
    });
    const r = await mcp("cancel_subscription", {}, key, withEnv({ PUBLIC_BASE_URL: "https://example.test" }));
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ cancel_url: "https://billing.stripe.com/p/session/cancel", plan: "Pro", renews_or_ends: "renews 2030-03-17 unless canceled" });
    expect(r.data.note).toMatch(/confirms the cancellation on Stripe's page/);
    expect(r.data.note).toMatch(/Pro stays active until the end of the paid period/);
    const portal = calls.find((c) => c.url.includes("billing_portal"))!;
    expect(Object.fromEntries(portal.params)).toEqual({
      customer: "cus_cancel_2",
      configuration: "bpc_PLACEHOLDER",
      return_url: "https://example.test/billing/return",
      "flow_data[type]": "subscription_cancel",
      "flow_data[subscription_cancel][subscription]": "sub_live_1",
      "flow_data[after_completion][type]": "redirect",
      "flow_data[after_completion][redirect][return_url]": "https://example.test/billing/return",
    });
  });

  it("already set to cancel at period end: says so, no new session", async () => {
    const { accountId, key } = await seedAccount(false);
    await proWith(accountId, "stripe_customer_id = 'cus_cancel_3', stripe_subscription_id = 'sub_live_1', cancel_at_period_end = 1");
    const calls = stubStripe({});
    const r = await mcp("cancel_subscription", {}, key);
    expect(r.data).toMatchObject({ cancel_url: null, plan: "Pro", renews_or_ends: "ends 2030-03-17" });
    expect(r.data.note).toMatch(/Already canceled/);
    expect(calls).toHaveLength(0);
  });
});

describe("get_plan and enforcement", () => {
  it("free plan output", async () => {
    const { key } = await seedAccount(false);
    const r = await mcp("get_plan", {}, key);
    expect(r.data).toMatchObject({ plan: "Free", status: "active", limits: { max_recording_minutes: 5, max_recordings_total: 25, auto_delete_days: 7, max_devices: 2, watermark: true } });
  });

  it("pro plan output with renewal date and cancel state", async () => {
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro', plan_status = 'active', current_period_end = 1900000000 WHERE id = ?").bind(accountId).run();
    let r = await mcp("get_plan", {}, key);
    expect(r.data).toMatchObject({
      plan: "Pro",
      status: "active",
      renews_on: "2030-03-17",
      price: "$10 USD per month plus applicable tax",
      limits: { max_recording_minutes: 240, max_recordings_total: null, auto_delete_days: null, max_devices: null, watermark: false },
    });
    await env.DB.prepare("UPDATE accounts SET cancel_at_period_end = 1 WHERE id = ?").bind(accountId).run();
    r = await mcp("get_plan", {}, key);
    expect(r.data).toMatchObject({ plan: "Pro", renews_on: null, ends_on: "2030-03-17" });
  });

  it("plan module: watermark only on free; pro lifts the device limit", async () => {
    const { accountId } = await seedAccount(false);
    expect(await accountLimits(env, accountId)).toMatchObject({ tier: "free", maxDevices: 2, watermark: true });
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(accountId).run();
    expect(await accountLimits(env, accountId)).toMatchObject({ tier: "pro", maxDevices: null, watermark: false, keepForever: true });
  });

  it("pairing a third device works on pro, refused on free", async () => {
    const { accountId } = await seedAccount(false);
    await seedDevice(accountId, "pc1");
    await seedDevice(accountId, "pc2");
    const pair = async (name: string) => {
      const { code } = await issuePairingCode(env, accountId, 600);
      return pairDevice(env, code, { name, platform: "windows", ipHash: `ip-${name}` });
    };
    expect(await pair("pc3")).toMatchObject({ ok: false, error: "device_limit" });
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(accountId).run();
    expect(await pair("pc3")).toMatchObject({ ok: true });
  });

  it("billing return pages are plain static pages", async () => {
    for (const p of ["/billing/success", "/billing/cancel", "/billing/return"]) {
      const r = await call(p);
      expect(r.status).toBe(200);
      expect(await r.text()).toMatch(/go back to your bot/i);
    }
  });
});

// Launch checks for the Pro plan: the price the bot quotes, what Checkout charges, the statement descriptor, the cancel
// deep link. The Stripe-side objects (price amount, product statement descriptor) live in the Stripe dashboard; these
// pin everything the Worker controls.
describe("launch: price, descriptor, cancel link", () => {
  it("Pro is $10 USD a month: the bot quotes it and Checkout charges exactly one Pro price (the configured one)", async () => {
    const { key } = await seedAccount(false);
    const calls = stubStripe({
      "POST /v1/customers": () => ({ id: "cus_price" }),
      "POST /v1/checkout/sessions": () => ({ id: "cs_p", url: "https://checkout.stripe.com/c/pay/cs_p" }),
    });
    const r = await mcp("upgrade", {}, key, withEnv({ STRIPE_PRO_PRICE_ID: "price_PLACEHOLDER_LAUNCH" }));
    expect(r.data.price).toBe("$10 USD per month plus applicable tax");
    expect(r.data.note).toMatch(/\$10 USD per month/);
    const sess = calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!;
    expect(sess.params.get("mode")).toBe("subscription");
    expect(sess.params.get("line_items[0][price]")).toBe("price_PLACEHOLDER_LAUNCH");
    expect(sess.params.get("line_items[0][quantity]")).toBe("1");
    expect([...sess.params.keys()].filter((k) => k.startsWith("line_items[") && !k.startsWith("line_items[0]"))).toEqual([]);
    // No ad-hoc amount: the charge is the Stripe price object, never a price_data built here.
    expect([...sess.params.keys()].join(" ")).not.toMatch(/price_data|unit_amount|amount/);
    // A deployment points at one Pro price ID: the self-host template documents it (a placeholder, never a real id).
    expect(wranglerConfig).toMatch(/"STRIPE_PRO_PRICE_ID": "price_PLACEHOLDER_PRO"/);
  });

  it("statement descriptor: never overridden per call (it is the Recitbot product's own)", async () => {
    const { accountId, key } = await seedAccount(false);
    const calls = stubStripe({
      "POST /v1/customers": () => ({ id: "cus_desc_1" }),
      "POST /v1/checkout/sessions": () => ({ id: "cs_d", url: "https://checkout.stripe.com/c/pay/cs_d" }),
      "GET /v1/customers/": () => ({ id: "cus_desc_1", metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/d" }),
    });
    await mcp("upgrade", {}, key);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro', plan_status = 'active', stripe_subscription_id = 'sub_d' WHERE id = ?").bind(accountId).run();
    await mcp("billing", {}, key);
    await mcp("cancel_subscription", {}, key);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v1/customers",
      "POST /v1/checkout/sessions",
      "GET /v1/customers/cus_desc_1",
      "POST /v1/billing_portal/sessions",
      "GET /v1/customers/cus_desc_1",
      "POST /v1/billing_portal/sessions",
    ]);
    // Nothing here sets a descriptor, business name or product: a Stripe account's other products are never
    // touched, and Recitbot charges carry only what the Recitbot price's product says.
    for (const c of calls) {
      expect([...c.params.keys()].join(" ")).not.toMatch(/statement_descriptor|business|product|payment_intent_data|on_behalf_of/);
    }
  });

  it("cancel_subscription is the cancel deep link: a Billing Portal subscription_cancel flow for the stored subscription; billing and get_plan point there", async () => {
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare(
      "UPDATE accounts SET plan = 'pro', plan_status = 'active', current_period_end = 1900000000, stripe_customer_id = 'cus_deep_1', stripe_subscription_id = 'sub_deep_1' WHERE id = ?",
    )
      .bind(accountId)
      .run();
    const calls = stubStripe({
      "GET /v1/customers/": () => ({ id: "cus_deep_1", metadata: { app: "recitbot", account_id: accountId } }),
      "POST /v1/billing_portal/sessions": () => ({ url: "https://billing.stripe.com/p/session/deep" }),
    });
    const r = await mcp("cancel_subscription", {}, key);
    expect(r.data.cancel_url).toBe("https://billing.stripe.com/p/session/deep");
    const portal = calls.find((c) => c.url.endsWith("/v1/billing_portal/sessions"))!;
    expect(portal.params.get("flow_data[type]")).toBe("subscription_cancel");
    expect(portal.params.get("flow_data[subscription_cancel][subscription]")).toBe("sub_deep_1");
    expect(portal.params.get("customer")).toBe("cus_deep_1");
    expect(portal.params.get("configuration")).toBe("bpc_PLACEHOLDER");
    expect(portal.params.get("flow_data[after_completion][redirect][return_url]")).toMatch(/\/billing\/return$/);
    // The other tools send cancels here.
    const plan = await mcp("get_plan", {}, key);
    expect(plan.data.note).toMatch(/cancel_subscription cancels/);
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string }[];
    expect(tools.find((t) => t.name === "billing")!.description).toMatch(/To cancel Pro or stop paying, call cancel_subscription/);
    expect(tools.find((t) => t.name === "cancel_subscription")!.description).toMatch(/cancel my subscription/);
  });
});
