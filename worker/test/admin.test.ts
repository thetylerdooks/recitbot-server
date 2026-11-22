// Owner-only admin tools (admin-tools.ts): only OWNER_ACCOUNT_IDS sees or can call them; to every other caller they don't
// exist (not listed, and a call gets exactly the unknown-tool error). Read-only, no secrets in any output.
import { env } from "cloudflare:test";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { maskEmail } from "../src/admin-tools";
import { deviceHub } from "../src/device-hub";
import type { Env } from "../src/env";
import { RECORDER_VERSION } from "../src/generated";
import { stripeDeps } from "../src/stripe";
import { now, randomId } from "../src/util";
import { call, connectDevice, mcp, seedAccount, seedDevice, withEnv } from "./helpers";

const ADMIN = ["admin_overview", "admin_billing", "admin_usage", "admin_devices", "admin_errors"];
const DAY = 86400;

/** A custom_domains row (migration 0027) for accountId; the admin tools only read it. */
async function seedDomain(accountId: string, o: { status?: string; disabledAt?: number | null } = {}) {
  const hostname = `v${randomId(40).toLowerCase().replace(/[^a-z0-9]/g, "")}.example.com`;
  const t = now();
  await env.DB.prepare(
    "INSERT INTO custom_domains (id, account_id, hostname, status, disabled_at, disabled_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(128), accountId, hostname, o.status ?? "active", o.disabledAt ?? null, o.disabledAt ? "phishing" : null, t, t)
    .run();
  return hostname;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Let the DeviceHubs finish their close handling before the file tears down.
afterAll(() => sleep(200));

const realStripeFetch = stripeDeps.fetch;
afterEach(() => {
  stripeDeps.fetch = realStripeFetch;
});

/** Stripe lists by path (and ?status= for subscriptions); records every call. Anything else is a 404. */
function stubStripe(lists: Record<string, (q: URLSearchParams) => { data: unknown[]; has_more?: boolean }>) {
  const calls: { method: string; url: string }[] = [];
  stripeDeps.fetch = async (input, init) => {
    calls.push({ method: init.method!, url: input });
    const u = new URL(input);
    const key = [`${u.pathname}?status=${u.searchParams.get("status")}`, u.pathname].find((k) => k in lists);
    if (!key) return Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
    const page = lists[key](u.searchParams);
    return Response.json({ object: "list", has_more: false, ...page });
  };
  return calls;
}

const EMPTY_STRIPE = { "/v1/subscriptions": () => ({ data: [] }), "/v1/charges": () => ({ data: [] }), "/v1/invoices": () => ({ data: [] }) };

const setPlan = (id: string, plan: string) => env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, id).run();

async function withPlan(plan: string) {
  const a = await seedAccount(false);
  await setPlan(a.accountId, plan);
  return a;
}

/** An operator: listed in OWNER_ACCOUNT_IDS (pass `e` to every call). */
async function owner() {
  const a = await seedAccount(false);
  return { ...a, e: withEnv({ OWNER_ACCOUNT_IDS: a.accountId }) };
}

async function rpc(body: unknown, key?: string, e: Env = env) {
  const res = await call(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    },
    e,
  );
  return { status: res.status, body: (await res.json()) as any };
}

const listNames = async (key?: string, e: Env = env) =>
  ((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key, e)).body.result.tools as { name: string }[]).map((t) => t.name);

const callTool = (name: string, key?: string, e: Env = env) =>
  rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } }, key, e);

/** The response with the tool's name taken out of the error text: what an unknown tool answers, name aside. */
const anonymised = (r: { status: number; body: any }, name: string) => JSON.parse(JSON.stringify(r).replaceAll(name, "<name>"));

/** No secret-shaped value anywhere in a tool's output. */
function expectNoSecrets(out: unknown) {
  const s = JSON.stringify(out);
  expect(s).not.toMatch(/\bark_[A-Za-z0-9]+_[A-Za-z0-9]+/);
  expect(s).not.toMatch(/\bardt_[A-Za-z0-9]+_[A-Za-z0-9]+/);
  expect(s).not.toMatch(/https?:\/\//);
  expect(s).not.toMatch(/\b(sk|rk|whsec)_[A-Za-z0-9_]+/);
  expect(s).not.toMatch(/PLACEHOLDER_STRIPE/); // vitest.config.ts's stand-ins for the Stripe secrets
  expect(s).not.toMatch(/[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  expect(s).not.toMatch(/token_hash|key_hash|code_hash|passcode/);
}

async function seedRecording(accountId: string, o: { bytes?: number; audio?: number; status?: string; error?: string | null; createdAt?: number } = {}) {
  const id = randomId(128);
  const t = o.createdAt ?? now();
  await env.DB.prepare(
    "INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at, bytes, audio_bytes, error) VALUES (?, ?, 'dev', ?, 60, ?, ?, ?, ?, ?)",
  )
    .bind(id, accountId, o.status ?? "ready", t, t + DAY, o.bytes ?? 0, o.audio ?? 0, o.error ?? null)
    .run();
  return id;
}

describe("admin tools: who can see and call them", () => {
  it("an operator (OWNER_ACCOUNT_IDS) sees every admin tool in tools/list and can call each", async () => {
    stubStripe(EMPTY_STRIPE);
    const { key, e } = await owner();
    const names = await listNames(key, e);
    for (const n of ADMIN) expect(names, n).toContain(n);
    for (const n of ADMIN) {
      const r = await mcp(n, {}, key, e);
      expect(r.isError, n).toBe(false);
      expectNoSecrets(r.data);
    }
  });

  it("accounts.plan 'owner' alone is not enough: only OWNER_ACCOUNT_IDS opens them (mcp.ts isOperator)", async () => {
    const { accountId, key } = await withPlan("owner");
    expect(await listNames(key)).not.toContain("admin_overview");
    expect((await callTool("admin_overview", key)).body.error).toEqual({ code: -32602, message: "Unknown tool: admin_overview" });
    expect(await listNames(key, withEnv({ OWNER_ACCOUNT_IDS: accountId }))).toEqual(expect.arrayContaining(ADMIN));
  });

  for (const plan of ["free", "pro", "teams"]) {
    it(`a ${plan} account sees none of them, and calling one is the unknown-tool error`, async () => {
      const stripeCalls = stubStripe(EMPTY_STRIPE);
      const { key } = await withPlan(plan);
      const names = await listNames(key);
      for (const n of ADMIN) expect(names, n).not.toContain(n);
      expect(names.some((n) => n.startsWith("admin"))).toBe(false);
      const unknown = anonymised(await callTool("admin_nonexistent_tool", key), "admin_nonexistent_tool");
      expect(unknown.body.error).toEqual({ code: -32602, message: "Unknown tool: <name>" });
      for (const n of ADMIN) expect(anonymised(await callTool(n, key), n), n).toEqual(unknown);
      expect(stripeCalls).toEqual([]);
    });
  }

  it("unauthenticated: not listed; a call is the same 401 an unknown tool gets", async () => {
    const names = await listNames();
    for (const n of ADMIN) expect(names, n).not.toContain(n);
    const unknown = anonymised(await callTool("admin_nonexistent_tool"), "admin_nonexistent_tool");
    expect(unknown.status).toBe(401);
    for (const n of ADMIN) expect(anonymised(await callTool(n), n), n).toEqual(unknown);
  });

  it("a bad or revoked token: the same 401 as for an unknown tool, nothing listed", async () => {
    const bad = `ark_${randomId(64)}_${randomId(256)}`;
    const unknown = anonymised(await callTool("admin_nonexistent_tool", bad), "admin_nonexistent_tool");
    expect(unknown.status).toBe(401);
    for (const n of ADMIN) expect(anonymised(await callTool(n, bad), n), n).toEqual(unknown);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bad)).status).toBe(401);
  });

  it("the check is made at call time: an account taken out of OWNER_ACCOUNT_IDS loses them at once", async () => {
    const { key, e } = await owner();
    expect((await mcp("admin_usage", {}, key, e)).isError).toBe(false);
    const r = await callTool("admin_usage", key);
    expect(r.body.error).toEqual({ code: -32602, message: "Unknown tool: admin_usage" });
    expect(await listNames(key)).not.toContain("admin_usage");
  });

  it("in a JSON-RPC batch, each message is checked: a free caller's batch never reaches an admin tool", async () => {
    const { key } = await withPlan("free");
    const r = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "admin_overview", arguments: {} } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      key,
    );
    expect(r.body[0].error).toEqual({ code: -32602, message: "Unknown tool: admin_overview" });
    expect((r.body[1].result.tools as { name: string }[]).some((t) => t.name.startsWith("admin"))).toBe(false);
  });

  it("names on Object.prototype are unknown tools too, for everyone", async () => {
    const { key, e } = await owner();
    for (const n of ["constructor", "toString", "__proto__"]) {
      expect((await callTool(n, key, e)).body.error, n).toEqual({ code: -32602, message: `Unknown tool: ${n}` });
    }
  });
});

describe("admin_overview", () => {
  it("counts accounts, signups per day and week, plans, conversions, recordings and storage", async () => {
    const { key, e } = await owner();
    const before = (await mcp("admin_overview", {}, key, e)).data;

    const t = now();
    const day = (ago: number) => new Date((t - ago * DAY) * 1000).toISOString().slice(0, 10);
    const make = async (plan: string, agoDays: number, sub: string | null = null, freeUsed = 0) => {
      const id = randomId(128);
      await env.DB.prepare("INSERT INTO accounts (id, created_at, plan, stripe_subscription_id, free_recordings_used) VALUES (?, ?, ?, ?, ?)")
        .bind(id, t - agoDays * DAY, plan, sub, freeUsed)
        .run();
      return id;
    };
    await make("free", 2);
    await make("free", 2);
    await make("free", 40);
    const pro = await make("pro", 2, "sub_a", 3);
    await make("teams", 2, "sub_b");
    await make("free", 2, "sub_c");
    await seedRecording(pro, { bytes: 1000, audio: 200 });
    await seedRecording(pro, { bytes: 50 });

    const after = (await mcp("admin_overview", {}, key, e)).data;
    expect(after.accounts_total - before.accounts_total).toBe(6);
    const perDay = (o: any, d: string) => o.signups_per_day.find((x: any) => x.day === d)?.signups;
    expect(after.signups_per_day).toHaveLength(30);
    expect(after.signups_per_day.at(-1).day).toBe(day(0));
    expect(perDay(after, day(2)) - perDay(before, day(2))).toBe(5);
    // 40 days ago is outside the daily window.
    expect(perDay(after, day(40))).toBeUndefined();
    expect(after.signups_per_week).toHaveLength(12);
    expect(new Date(after.signups_per_week[0].week_starting).getUTCDay()).toBe(1);
    const weekSum = (o: any) => o.signups_per_week.reduce((s: number, w: any) => s + w.signups, 0);
    expect(weekSum(after) - weekSum(before)).toBe(6);

    const plan = (k: string) => (after.accounts_by_plan[k] ?? 0) - (before.accounts_by_plan[k] ?? 0);
    expect([plan("free"), plan("pro"), plan("teams"), plan("owner")]).toEqual([4, 1, 1, 0]);
    expect(after.accounts_by_plan).toMatchObject({ free: expect.any(Number), pro: expect.any(Number), teams: expect.any(Number), owner: expect.any(Number) });

    const conv = (k: string) => after.conversions[k] - before.conversions[k];
    expect(conv("paid_now")).toBe(2);
    expect(conv("paid_now_used_free_recordings")).toBe(1);
    expect(conv("ever_subscribed")).toBe(3);
    expect(conv("subscribed_then_back_to_free")).toBe(1);
    expect(conv("non_owner_accounts")).toBe(6);
    expect(after.conversions.meaning).toMatch(/starts on Free/);

    expect(after.recordings_total - before.recordings_total).toBe(2);
    expect(after.video_bytes - before.video_bytes).toBe(1050);
    expect(after.audio_bytes - before.audio_bytes).toBe(200);
    expect(after.storage_bytes - before.storage_bytes).toBe(1250);
  });

  it("lists the deployment's configuration warnings", async () => {
    const { key, e } = await owner();
    // The test config names a CNAME target without the rest of the custom domain settings.
    expect((await mcp("admin_overview", {}, key, e)).data.config_warnings).toEqual([expect.stringMatching(/^Custom domains are off/)]);
  });

  it("counts custom domains: live = active and not taken down", async () => {
    const { key, e } = await owner();
    const before = (await mcp("admin_overview", {}, key, e)).data.custom_domains;
    const acct = async () => (await seedAccount(false)).accountId;
    await seedDomain(await acct());
    await seedDomain(await acct());
    await seedDomain(await acct(), { status: "pending" });
    await seedDomain(await acct(), { status: "redirecting" });
    await seedDomain(await acct(), { disabledAt: now() });
    const after = (await mcp("admin_overview", {}, key, e)).data.custom_domains;
    const d = (k: string) => after[k] - before[k];
    expect([d("live"), d("pending"), d("redirecting"), d("taken_down"), d("total")]).toEqual([2, 1, 1, 1, 5]);
  });
});

describe("admin_billing", () => {
  const price = (id: string, unit_amount: number, currency = "usd", interval = "month", interval_count = 1) => ({
    id,
    currency,
    unit_amount,
    recurring: { interval, interval_count, usage_type: "licensed" },
  });
  const sub = (id: string, status: string, items: { price: unknown; quantity?: number }[], app = "recitbot") => ({
    id,
    status,
    metadata: { app, account_id: "x" },
    items: { data: items },
  });

  async function payer(username: string) {
    const a = await withPlan("pro");
    const customer = `cus_${randomId(64)}`;
    await env.DB.prepare("UPDATE accounts SET username = ?, stripe_customer_id = ?, stripe_subscription_id = ?, plan_status = 'past_due', storage_addons = 2 WHERE id = ?")
      .bind(username, customer, `sub_${randomId(64)}`, a.accountId)
      .run();
    return customer;
  }

  it("MRR per currency, subscriptions per price, failed charges and unpaid invoices (ours only, emails masked)", async () => {
    const { key, e } = await owner();
    const ours = await payer("payer");
    const foreign = `cus_${randomId(64)}`;
    const t = now();
    const calls = stubStripe({
      "/v1/subscriptions?status=active": (q) =>
        q.get("starting_after")
          ? { data: [sub("sub_eur", "active", [{ price: price("price_year_eur", 12000, "eur", "year") }])] }
          : {
              data: [
                sub("sub_1", "active", [{ price: price("price_PLACEHOLDER_PRO", 1000) }, { price: price("price_addon", 300), quantity: 2 }]),
                sub("sub_other_product", "active", [{ price: price("price_other", 99999) }], "someone-else"),
              ],
              has_more: true,
            },
      "/v1/subscriptions?status=past_due": () => ({ data: [sub("sub_2", "past_due", [{ price: price("price_PLACEHOLDER_TEAMS", 1500), quantity: 3 }])] }),
      "/v1/subscriptions?status=unpaid": () => ({ data: [sub("sub_3", "unpaid", [{ price: price("price_PLACEHOLDER_PRO", 1000) }])] }),
      "/v1/charges": () => ({
        data: [
          {
            id: "ch_1",
            status: "failed",
            customer: ours,
            amount: 1000,
            currency: "usd",
            created: t - 3600,
            failure_code: "card_declined",
            failure_message: "Your card was declined.",
            billing_details: { email: "taylor@example.com" },
            receipt_url: "https://pay.stripe.com/receipts/secret",
          },
          { id: "ch_2", status: "failed", customer: foreign, amount: 5, currency: "usd", created: t, failure_code: "x", failure_message: "x" },
          { id: "ch_3", status: "succeeded", customer: ours, amount: 1000, currency: "usd", created: t, failure_code: null, failure_message: null },
        ],
      }),
      "/v1/invoices": () => ({
        data: [
          {
            id: "in_1",
            status: "open",
            customer: ours,
            customer_email: "taylor@example.com",
            amount_due: 1000,
            currency: "usd",
            created: t - 7200,
            attempt_count: 2,
            next_payment_attempt: t + DAY,
            hosted_invoice_url: "https://invoice.stripe.com/i/secret",
          },
          { id: "in_2", status: "open", customer: ours, customer_email: "a@b.co", amount_due: 1, currency: "usd", created: t, attempt_count: 0, next_payment_attempt: null },
          { id: "in_3", status: "uncollectible", customer: ours, customer_email: "z@b.co", amount_due: 300, currency: "usd", created: t, attempt_count: 4, next_payment_attempt: null },
          { id: "in_4", status: "paid", customer: ours, customer_email: "a@b.co", amount_due: 1000, currency: "usd", created: t, attempt_count: 1, next_payment_attempt: null },
          { id: "in_5", status: "open", customer: foreign, customer_email: "a@b.co", amount_due: 9, currency: "usd", created: t, attempt_count: 3, next_payment_attempt: null },
        ],
      }),
    });

    const r = await mcp("admin_billing", {}, key, { ...e, STRIPE_STORAGE_ADDON_PRICE_ID: "price_addon" } as Env);
    expect(r.isError).toBe(false);
    expect(r.data.stripe_error).toBeNull();
    const s = r.data.stripe;
    // usd: 1000 + 2 x 300 (active) + 3 x 1500 (past_due) = 6100 cents; eur: 12000 a year = 1000 a month. unpaid: none.
    expect(s.mrr).toEqual(
      expect.arrayContaining([
        { currency: "usd", monthly_amount: 61, monthly_amount_minor: 6100 },
        { currency: "eur", monthly_amount: 10, monthly_amount_minor: 1000 },
      ]),
    );
    expect(s.mrr).toHaveLength(2);
    expect(s.subscriptions_by_status).toEqual({ active: 2, past_due: 1, unpaid: 1 });
    const byPrice = (id: string) => s.subscriptions_by_price.find((p: any) => p.price_id === id);
    expect(byPrice("price_PLACEHOLDER_PRO")).toEqual({ price_id: "price_PLACEHOLDER_PRO", plan: "pro", active: 1, past_due: 0, unpaid: 1, quantity: 1 });
    expect(byPrice("price_PLACEHOLDER_TEAMS")).toEqual({ price_id: "price_PLACEHOLDER_TEAMS", plan: "teams", active: 0, past_due: 1, unpaid: 0, quantity: 3 });
    expect(byPrice("price_addon")).toMatchObject({ plan: "storage_addon", active: 1, quantity: 2 });
    expect(byPrice("price_other")).toBeUndefined();
    expect(s.failed_charges).toEqual([
      { date: new Date((t - 3600) * 1000).toISOString(), username: "payer", customer_email: "t***@example.com", amount: 10, currency: "usd", reason: "Your card was declined." },
    ]);
    expect(s.unpaid_invoices).toEqual([
      {
        date: new Date((t - 7200) * 1000).toISOString(),
        username: "payer",
        customer_email: "t***@example.com",
        amount: 10,
        currency: "usd",
        status: "open",
        attempts: 2,
        next_attempt_at: new Date((t + DAY) * 1000).toISOString(),
        reason: "payment failed (2 attempts)",
      },
      expect.objectContaining({ customer_email: "z***@b.co", status: "uncollectible", amount: 3, reason: "marked uncollectible" }),
    ]);
    expect(s.truncated).toBe(false);

    expect(r.data.d1.past_due_or_unpaid_accounts).toContainEqual({ username: "payer", plan: "pro", plan_status: "past_due", current_period_end: null });
    expect(r.data.d1.subscribed_accounts).toContainEqual(expect.objectContaining({ plan: "pro", plan_status: "past_due" }));
    expect(r.data.d1.storage_addons).toBeGreaterThanOrEqual(2);

    // Read-only: GETs only, the second page asked with starting_after, charges and invoices from 30 days back.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => new URL(c.url).searchParams.get("starting_after") === "sub_other_product")).toBe(true);
    const since = Number(new URL(calls.find((c) => c.url.includes("/v1/charges"))!.url).searchParams.get("created[gte]"));
    expect(Math.abs(since - (t - 30 * DAY))).toBeLessThan(5);
    expectNoSecrets(r.data);
  });

  it("Stripe failing: the D1 half still comes back, with stripe_error", async () => {
    const { key, e } = await owner();
    await payer("failing");
    stripeDeps.fetch = async () => Response.json({ error: { type: "api_error", code: "boom" } }, { status: 500 });
    const r = await mcp("admin_billing", {}, key, e);
    expect(r.isError).toBe(false);
    expect(r.data.stripe).toBeNull();
    expect(r.data.stripe_error).toBe("Stripe error 500: boom");
    expect(r.data.d1.past_due_or_unpaid_accounts).toContainEqual(expect.objectContaining({ username: "failing" }));
    expectNoSecrets(r.data);

    stripeDeps.fetch = async () => {
      throw new TypeError("network down");
    };
    const r2 = await mcp("admin_billing", {}, key, e);
    expect(r2.data).toMatchObject({ stripe: null, stripe_error: "Stripe could not be reached." });
    expect(r2.data.d1.past_due_or_unpaid_accounts).toContainEqual(expect.objectContaining({ username: "failing" }));
  });

  it("without a Stripe secret (billing off): BILLING_NOT_ENABLED, no call made", async () => {
    const { key, e } = await owner();
    const calls = stubStripe(EMPTY_STRIPE);
    const r = await mcp("admin_billing", {}, key, { ...e, STRIPE_SECRET_KEY: undefined } as Env);
    expect(r.data).toEqual({ error: "BILLING_NOT_ENABLED", message: "Billing is not enabled on this server." });
    expect(calls).toEqual([]);
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain only", () => {
    expect(maskEmail("taylor@example.com")).toBe("t***@example.com");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("weird@at@sign.com")).toBe("w***@sign.com");
    expect(maskEmail("@nolocal.com")).toBe("***");
    expect(maskEmail("nodomain")).toBe("***");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
  });
});

describe("admin_usage", () => {
  it("top 25 accounts by stored bytes with username, plan, created_at, and totals", async () => {
    const { key, e } = await owner();
    const before = (await mcp("admin_usage", {}, key, e)).data;
    const big = await withPlan("pro");
    await env.DB.prepare("UPDATE accounts SET username = 'bigfile' WHERE id = ?").bind(big.accountId).run();
    await seedRecording(big.accountId, { bytes: 9e12, audio: 1e9 });
    await seedRecording(big.accountId, { bytes: 1e12 });
    const host = await seedDomain(big.accountId);
    const small = await withPlan("free");
    await seedRecording(small.accountId, { bytes: 10 });

    const r = await mcp("admin_usage", {}, key, e);
    expect(r.isError).toBe(false);
    const top = r.data.top_accounts_by_storage;
    expect(top.length).toBeLessThanOrEqual(25);
    expect(top[0]).toEqual({
      account_id: big.accountId,
      username: "bigfile",
      plan: "pro",
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      recordings: 2,
      video_bytes: 1e13,
      audio_bytes: 1e9,
      storage_bytes: 1e13 + 1e9,
      custom_domain: host,
    });
    for (let i = 1; i < top.length; i++) expect(top[i - 1].storage_bytes).toBeGreaterThanOrEqual(top[i].storage_bytes);
    const d = (k: string) => r.data.totals[k] - before.totals[k];
    expect([d("recordings"), d("accounts_with_recordings"), d("video_bytes"), d("audio_bytes"), d("storage_bytes")]).toEqual([3, 2, 1e13 + 10, 1e9, 1e13 + 1e9 + 10]);
  });

  it("lists at most 25 accounts", async () => {
    const { key, e } = await owner();
    for (let i = 0; i < 27; i++) await seedRecording((await seedAccount(false)).accountId, { bytes: 1 });
    expect((await mcp("admin_usage", {}, key, e)).data.top_accounts_by_storage).toHaveLength(25);
  });
});

/** Connects the device's recorder and has it announce `version` (no self_update: no automatic update push). */
async function connectAs(accountId: string, token: string, version: string) {
  const dev = await connectDevice(token);
  dev.ws.send(JSON.stringify({ type: "hello", version, features: [] }));
  for (let i = 0; i < 50 && !(await deviceHub(env, accountId).recorderInfo(accountId))?.version; i++) await sleep(10);
  return dev;
}

describe("admin_devices", () => {
  it("platform counts, live versions, and stuck = seen in 14 days on an older recorder than the latest", async () => {
    const { key, e } = await owner();
    const before = (await mcp("admin_devices", {}, key, e)).data;
    const t = now();

    const old = await seedAccount();
    await env.DB.prepare("UPDATE accounts SET username = 'stuckuser' WHERE id = ?").bind(old.accountId).run();
    const oldWs = await connectAs(old.accountId, old.deviceToken!, "0.0.1");
    const cur = await seedAccount();
    const curWs = await connectAs(cur.accountId, cur.deviceToken!, RECORDER_VERSION);
    // Seen 3 days ago, offline now: no version known. Seen 20 days ago: outside the window. Never connected.
    const offline = await seedAccount();
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(t - 3 * DAY, offline.deviceId).run();
    const gone = await seedAccount();
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?, platform = 'macos' WHERE id = ?").bind(t - 20 * DAY, gone.deviceId).run();
    await seedAccount();
    // A revoked device counts nowhere.
    const revoked = await seedDevice(old.accountId, "old pc");
    await env.DB.prepare("UPDATE devices SET revoked_at = ?, last_seen_at = ? WHERE id = ?").bind(t, t, revoked.deviceId).run();

    const r = await mcp("admin_devices", {}, key, e);
    expect(r.isError).toBe(false);
    const d = r.data;
    expect(d.paired_devices - before.paired_devices).toBe(5);
    expect(d.by_platform.windows - (before.by_platform.windows ?? 0)).toBe(4);
    expect(d.by_platform.macos - (before.by_platform.macos ?? 0)).toBe(1);
    expect(d.never_seen - before.never_seen).toBe(1);
    expect(d.seen_in_window - before.seen_in_window).toBe(3);
    expect(d.latest.windows).toBe(RECORDER_VERSION);

    const dev = (id: string) => d.devices.find((x: any) => x.device_id === id);
    expect(dev(old.deviceId!)).toMatchObject({ username: "stuckuser", platform: "windows", version: "0.0.1", online: true, outdated: true });
    expect(dev(old.deviceId!).last_seen_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(dev(cur.deviceId!)).toMatchObject({ version: RECORDER_VERSION, online: true, outdated: false });
    expect(dev(offline.deviceId!)).toMatchObject({ version: null, online: false, outdated: false });
    expect(dev(gone.deviceId!)).toBeUndefined();
    expect(dev(revoked.deviceId)).toBeUndefined();

    expect(d.stuck).toContainEqual({
      device_id: old.deviceId,
      username: "stuckuser",
      name: "test pc",
      platform: "windows",
      version: "0.0.1",
      latest: RECORDER_VERSION,
      last_seen_at: dev(old.deviceId!).last_seen_at,
    });
    expect(d.stuck.map((s: any) => s.device_id)).not.toContain(cur.deviceId);
    const ver = (o: any, v: string) => o.by_version.find((x: any) => x.platform === "windows" && x.version === v)?.devices ?? 0;
    expect(ver(d, "0.0.1") - ver(before, "0.0.1")).toBe(1);
    expect(ver(d, "unknown") - ver(before, "unknown")).toBe(1);
    expect(d.version_source).toMatch(/stores no recorder version/);
    expectNoSecrets(d);
    oldWs.ws.close();
    curWs.ws.close();
  });
});

describe("admin_errors", () => {
  it("lists the last 7 days' failed recordings with username and trimmed error, and counts per error", async () => {
    const { key, e } = await owner();
    const before = (await mcp("admin_errors", {}, key, e)).data;
    const a = await withPlan("free");
    await env.DB.prepare("UPDATE accounts SET username = 'oops' WHERE id = ?").bind(a.accountId).run();
    const long = "E".repeat(500);
    const t = now();
    const r1 = await seedRecording(a.accountId, { status: "failed", error: "TIMEOUT", createdAt: t - 60 });
    await seedRecording(a.accountId, { status: "failed", error: "TIMEOUT", createdAt: t - 120 });
    const r3 = await seedRecording(a.accountId, { status: "failed", error: long, createdAt: t - 30 });
    // An error with a secret-shaped value in it is redacted.
    await seedRecording(a.accountId, { status: "failed", error: `upload failed ardt_${randomId(64)}_${randomId(128)}`, createdAt: t - 10 });
    // One that straddles the 300-character edge: redacted before trimming, so no part of it survives.
    const edge = await seedRecording(a.accountId, { status: "failed", error: `${"x".repeat(280)} ark_${"A".repeat(20)}_${"B".repeat(30)}`, createdAt: t - 5 });
    await seedRecording(a.accountId, { status: "ready" });
    await seedRecording(a.accountId, { status: "failed", error: "TIMEOUT", createdAt: t - 8 * DAY });
    await env.DB.prepare("INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at, transcript_status) VALUES (?, ?, 'dev', 'ready', 60, ?, ?, 'unavailable')")
      .bind(randomId(128), a.accountId, t, t + DAY)
      .run();

    const r = await mcp("admin_errors", {}, key, e);
    expect(r.isError).toBe(false);
    expect(r.data.failed_recordings - before.failed_recordings).toBe(5);
    expect(r.data.transcription_unavailable - before.transcription_unavailable).toBe(1);
    const mine = r.data.recent.filter((x: any) => x.username === "oops");
    expect(mine).toHaveLength(5);
    expect(mine.find((x: any) => x.recording_id === edge).error).toBe(`${"x".repeat(280)} ark_[REDACTED]`);
    expect(JSON.stringify(r.data)).not.toMatch(/AAAA|BBBB/);
    expect(mine.find((x: any) => x.recording_id === r1)).toEqual({ recording_id: r1, username: "oops", status: "failed", error: "TIMEOUT", created_at: new Date((t - 60) * 1000).toISOString() });
    expect(mine.find((x: any) => x.recording_id === r3).error).toHaveLength(300);
    const count = (o: any, e: string) => o.counts_by_error.find((x: any) => x.error === e)?.recordings ?? 0;
    expect(count(r.data, "TIMEOUT") - count(before, "TIMEOUT")).toBe(2);
    expect(r.data.other_error_logs).toMatch(/None/);
    expectNoSecrets(r.data);
    expect(JSON.stringify(r.data)).toContain("ardt_[REDACTED]");
  });
});
