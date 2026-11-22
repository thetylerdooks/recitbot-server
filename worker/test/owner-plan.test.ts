// Owner plan as a DB flag: accounts.plan = 'owner' is a permanent free admin plan. Never billed,
// never upsold, never touched by the Stripe webhook.
import { env } from "cloudflare:test";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import ownerMigration from "../migrations/0015_owner_plan.sql?raw";
import ownerAccountMigration from "../migrations/0026_owner_plan_account.sql?raw";
import { deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import { accountLimits, LIMITS } from "../src/env";
import { expiredRecordingIds, KEEP_FOREVER } from "../src/share";
import { signStripePayload, stripeDeps } from "../src/stripe";
import { now, randomId } from "../src/util";
import { call, connectDevice, mcp, seedAccount, seedDevice, seedReady, withEnv } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Let the DeviceHubs finish their close handling (and logging) before the file tears down.
afterAll(() => sleep(200));

const OWNER_LIMITS = {
  tier: "owner",
  maxSeconds: null,
  maxVideoBytes: 8 * 1024 * 1024 * 1024,
  maxAudioBytes: 480 * 1024 * 1024,
  maxDevices: null,
  keepForever: true,
  watermark: false,
  startsPerDay: 500,
  freeRecordings: null,
  transcribeMinPerDay: null,
  customDomain: true,
};

const setPlan = (id: string, plan: string) => env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, id).run();
const planOf = (id: string) =>
  env.DB.prepare("SELECT plan, plan_status, stripe_subscription_id, cancel_at_period_end FROM accounts WHERE id = ?")
    .bind(id)
    .first<{ plan: string; plan_status: string | null; stripe_subscription_id: string | null; cancel_at_period_end: number }>();

async function owner() {
  const a = await seedAccount(false);
  await setPlan(a.accountId, "owner");
  return a;
}

/** Fails the test on any Stripe call: owners must never reach Stripe. */
function noStripe(): string[] {
  const calls: string[] = [];
  stripeDeps.fetch = async (input) => {
    calls.push(input);
    throw new Error(`unexpected Stripe call: ${input}`);
  };
  return calls;
}
const realStripeFetch = stripeDeps.fetch;
afterEach(() => {
  stripeDeps.fetch = realStripeFetch;
});

describe("owner plan (accounts.plan = 'owner')", () => {
  it("accountLimits returns the owner tier: every feature, no watermark, unlimited devices, kept forever", async () => {
    const { accountId } = await owner();
    expect(await accountLimits(env, accountId)).toEqual(OWNER_LIMITS);
    // The env path (OWNER_ACCOUNT_IDS) still works on a free-plan account.
    const free = await seedAccount(false);
    expect((await accountLimits(env, free.accountId)).tier).toBe("free");
    expect(await accountLimits(withEnv({ OWNER_ACCOUNT_IDS: free.accountId }), free.accountId)).toEqual(OWNER_LIMITS);
  });

  it("upgrade, billing, cancel_subscription and get_plan: 'nothing to buy', no checkout link, no Stripe call, no upsell", async () => {
    const { accountId, key } = await owner();
    // Even with a Stripe customer and subscription on file.
    await env.DB.prepare("UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = 'sub_x', plan_status = 'active' WHERE id = ?")
      .bind(`cus_${randomId(64)}`, accountId)
      .run();
    const calls = noStripe();
    for (const name of ["upgrade", "billing", "cancel_subscription", "get_plan"]) {
      const r = await mcp(name, {}, key);
      expect(r.isError, name).toBe(false);
      expect(r.data.plan, name).toBe("Owner");
      expect(r.data.note, name).toMatch(/Owner plan, nothing to buy/);
      const out = JSON.stringify(r.data);
      expect(out, name).not.toMatch(/https?:\/\//);
      expect(out, name).not.toMatch(/\$|per month|call upgrade|Recitbot Pro/i);
      expect(r.data.checkout_url ?? null, name).toBeNull();
      expect(r.data.portal_url ?? null, name).toBeNull();
      expect(r.data.cancel_url ?? null, name).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("the Stripe webhook never downgrades or overwrites plan 'owner'", async () => {
    const { accountId } = await owner();
    const stripeCalls = noStripe();
    let n = 0;
    const send = async (type: string, object: object) => {
      const body = JSON.stringify({ id: `evt_owner_${Date.now()}_${n++}`, type, data: { object } });
      const res = await call("/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": await signStripePayload("PLACEHOLDER_STRIPE_WEBHOOK_SECRET", body), "content-type": "application/json" },
        body,
      });
      expect(res.status, type).toBe(200);
    };
    const md = { app: "recitbot", account_id: accountId };
    const sub = (status: string) => ({ id: "sub_owner", object: "subscription", status, metadata: md, cancel_at_period_end: true, items: { data: [{ price: { id: "price_PLACEHOLDER_PRO" }, current_period_end: now() + 99 }] } });
    await send("checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: accountId, subscription: "sub_owner", metadata: md });
    await send("customer.subscription.created", sub("active"));
    await send("customer.subscription.updated", sub("past_due"));
    await send("customer.subscription.deleted", sub("canceled"));
    await send("customer.subscription.updated", sub("unpaid"));
    await send("invoice.payment_failed", { parent: { subscription_details: { metadata: md, subscription: "sub_owner" } } });
    await send("invoice.paid", { parent: { subscription_details: { metadata: md, subscription: "sub_owner" } }, lines: { data: [{ period: { end: now() + 99 } }] } });
    expect(await planOf(accountId)).toEqual({ plan: "owner", plan_status: null, stripe_subscription_id: null, cancel_at_period_end: 0 });
    expect((await accountLimits(env, accountId)).tier).toBe("owner");
    expect(stripeCalls).toEqual([]);
  });

  it("recordings are kept forever: new ones get KEEP_FOREVER, older 7-day ones are rescued by the cleanup", async () => {
    const { accountId } = await owner();
    const t = now();
    const old = await seedReady(accountId, { createdAt: t - 8 * 86400, expiresAt: t - 3600 });
    const free = await seedAccount(false);
    const gone = await seedReady(free.accountId, { createdAt: t - 8 * 86400, expiresAt: t - 3600 });
    const ids = await expiredRecordingIds(env, t);
    expect(ids).toContain(gone);
    expect(ids).not.toContain(old);
    const row = await env.DB.prepare("SELECT expires_at FROM recordings WHERE id = ?").bind(old).first<{ expires_at: number }>();
    expect(row!.expires_at).toBe(KEEP_FOREVER);
  });

  it("start_recording: no plan time limit (the default is the ceiling), kept until deleted, no device limit on pairing", async () => {
    const acct = await seedAccount();
    await setPlan(acct.accountId, "owner");
    await seedDevice(acct.accountId, "pc 2");
    await seedDevice(acct.accountId, "pc 3");
    const dev = await connectDevice(acct.deviceToken!);
    dev.ws.send(JSON.stringify({ type: "hello", version: "0.5.3", features: [...RECORDER_FEATURES] }));
    for (let i = 0; i < 50; i++) {
      if ((await deviceHub(env, acct.accountId).recorderInfo(acct.accountId))?.version) break;
      await sleep(10);
    }
    const s = await mcp("start_recording", { device: acct.deviceId }, acct.key);
    expect(s.isError, JSON.stringify(s.data)).toBe(false);
    const rec = await env.DB.prepare("SELECT max_seconds, expires_at FROM recordings WHERE id = ?")
      .bind(s.data.recording_id)
      .first<{ max_seconds: number; expires_at: number }>();
    expect(rec).toEqual({ max_seconds: LIMITS.recordingCeilingSeconds, expires_at: KEEP_FOREVER });
    expect((await mcp("device_status", {}, acct.key)).data.max_devices).toBeNull();
    dev.ws.close();
  });
});

describe("migrations 0015_owner_plan and 0026_owner_plan_account", () => {
  const run = async (migration: string) => {
    const sql = migration
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
  };

  it("0015 keeps an owner's older recordings forever, leaves everyone else's alone, and is idempotent", async () => {
    const own = await owner();
    const free = await seedAccount(false);
    const ownRec = await seedReady(own.accountId);
    const freeRec = await seedReady(free.accountId);
    const expiry = async (id: string) =>
      (await env.DB.prepare("SELECT expires_at FROM recordings WHERE id = ?").bind(id).first<{ expires_at: number }>())!.expires_at;
    const before = await expiry(freeRec);
    for (let i = 0; i < 2; i++) {
      await run(ownerMigration);
      expect(await expiry(ownRec)).toBe(KEEP_FOREVER);
      expect(await expiry(freeRec)).toBe(before);
    }
  });

  it("neither names an account or device, or makes anyone an owner", async () => {
    const a = await seedAccount();
    const count = () => env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan = 'owner'").first("n");
    const before = await count();
    for (const m of [ownerMigration, ownerAccountMigration]) {
      expect(m).not.toMatch(/'[A-Za-z0-9_-]{20,}'/);
      await run(m);
    }
    expect(await count()).toBe(before);
    expect((await planOf(a.accountId))!.plan).toBe("free");
  });
});
