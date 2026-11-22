// Billing off (no Stripe config, config.ts billing.enabled false): nothing the model reads mentions plans, prices or
// anything to buy (src/selfhost-text.ts, playbook.ts), the billing tools are not listed and answer plainly, nothing
// reaches Stripe, no link points anywhere, and the webhook route doesn't exist. Billing on: golden.test.ts.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import { limitError, type Env } from "../src/env";
import { mcpInstructions, playbook, PLAYBOOK_TEXT, PLAYBOOK_VERSION } from "../src/playbook";
import { BILLING_ONLY_TOOLS, PLAIN_TOOL_TEXT } from "../src/selfhost-text";
import { stripeDeps } from "../src/stripe";
import { call, mcp, MP4, seedAccount, seedDevice, seedReady, withEnv } from "./helpers";

const OFF = withEnv({
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  STRIPE_PRO_PRICE_ID: undefined,
  STRIPE_PRO_YEARLY_PRICE_ID: undefined,
  STRIPE_TEAMS_PRICE_ID: undefined,
  STRIPE_TEAMS_YEARLY_PRICE_ID: undefined,
  STRIPE_PORTAL_CONFIG_ID: undefined,
  STRIPE_STORAGE_ADDON_PRICE_ID: undefined,
});

/** Nothing to buy, and no plans either. */
const FORBIDDEN = /\$\d|USD|\bPro\b|upgrade|Teams|add-on|add_storage|per month|per year|pric/i;
const PLANS = /\bplans?\b|Free[- ](?:plan|account|tier|user)|\bon Free\b|\bStripe\b|checkout|subscription/i;
function clean(text: string, what: string): void {
  for (const re of [FORBIDDEN, PLANS]) {
    const m = re.exec(text);
    expect(m ? `${what}: ...${text.slice(Math.max(0, m.index - 60), m.index + 60)}...` : null).toBeNull();
  }
}

const realFetch = stripeDeps.fetch;
let stripeCalls = 0;
stripeDeps.fetch = async (input, init) => {
  stripeCalls++;
  return realFetch(input, init);
};
afterEach(() => {
  expect(stripeCalls).toBe(0);
});

async function rpc(method: string, e: Env, key?: string): Promise<any> {
  const res = await call(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
    },
    e,
  );
  return ((await res.json()) as any).result;
}
type Listed = { name: string; description: string; inputSchema: unknown };
const tools = async (e: Env, key?: string): Promise<Listed[]> => (await rpc("tools/list", e, key)).tools;

describe("text the model reads", () => {
  it("tools/list: no plans or prices in any tool, for users and operators; the billing tools are not listed", async () => {
    const { accountId, key } = await seedAccount(false);
    const ops = { ...OFF, OWNER_ACCOUNT_IDS: accountId } as Env;
    const user = await tools(OFF, key);
    const owner = await tools(ops, key);
    expect(owner.length).toBeGreaterThan(user.length);
    expect(await tools(OFF)).toEqual(user);
    for (const t of owner) clean(JSON.stringify(t), t.name);
    for (const t of user) expect(owner).toContainEqual(t);
    const names = new Set(owner.map((t) => t.name));
    for (const n of BILLING_ONLY_TOOLS) expect(names.has(n), n).toBe(false);
    // Nothing else went missing, and no schema changed but its text.
    const on = { ...env, OWNER_ACCOUNT_IDS: accountId } as Env;
    const standard = await tools(on, key);
    expect(standard.map((t) => t.name).filter((n) => !BILLING_ONLY_TOOLS.has(n))).toEqual(owner.map((t) => t.name));
    const shape = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "description" && typeof x === "string" ? "" : shape(x)])) : v;
    for (const t of owner) expect(shape(t.inputSchema), t.name).toEqual(shape(standard.find((s) => s.name === t.name)!.inputSchema));
  });

  it("every replaced phrase still exists in the standard text (so none is silently left out)", async () => {
    const { accountId, key } = await seedAccount(false);
    const standard = await tools({ ...env, OWNER_ACCOUNT_IDS: accountId } as Env, key);
    for (const [name, text] of Object.entries(PLAIN_TOOL_TEXT)) {
      const t = standard.find((s) => s.name === name);
      expect(t, name).toBeDefined();
      if (typeof text === "string") continue;
      const all: string[] = [];
      const strings = (v: unknown): void => {
        if (typeof v === "string") all.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(strings);
      };
      strings(t);
      for (const [from] of text) expect(all.some((s) => s.includes(from)), `${name}: ${from}`).toBe(true);
    }
  });

  it("initialize and the playbook: their own text and version, once per config", async () => {
    const { key } = await seedAccount(false);
    const instructions = (await rpc("initialize", OFF)).instructions as string;
    clean(instructions, "instructions");
    expect(instructions).toBe(mcpInstructions(getConfig(OFF)));
    expect(instructions).toContain("owner accounts have none");
    const latest = (await mcp("get_latest", {}, key, OFF)).data.playbook as { version: string; text: string };
    expect(latest).toEqual(playbook(getConfig(OFF)));
    clean(latest.text, "playbook");
    expect(latest.version).toBe(`${PLAYBOOK_VERSION}-selfhost`);
    expect(latest.text).toContain(`# Recitbot playbook (${latest.version})`);
    for (const s of ["## First run", "## Several PCs", "## Recording", "## Limits\n", "## Branding (owner accounts)", "## Custom domain (owner accounts)", "## Staying up to date", "25 videos total"]) {
      expect(latest.text).toContain(s);
    }
    expect(latest.text).not.toMatch(/undefined|@@/);
    expect(playbook(getConfig(OFF))).toBe(playbook(getConfig(OFF)));
    // Billing on: the standard one.
    expect((await mcp("get_latest", {}, key)).data.playbook).toEqual({ version: PLAYBOOK_VERSION, text: PLAYBOOK_TEXT });
  });

  it("messages: limits, devices, branding, custom domains, video file, account and operator tools", async () => {
    const free = await seedAccount(true);
    const check = async (tool: string, args: Record<string, unknown>, key: string, e: Env = OFF) => {
      const r = await mcp(tool, args, key, e);
      clean(JSON.stringify(r.data), tool);
      return r;
    };
    expect((await check("set_branding", { brand_name: "Acme" }, free.key)).data).toMatchObject({ error: "OWNER_ONLY" });
    expect((await check("get_branding", {}, free.key)).data.message).toMatch(/owner accounts/);
    const domains = { ...OFF, CF_SAAS_API_TOKEN: "PLACEHOLDER_TOKEN", CF_ZONE_ID: "PLACEHOLDER_ZONE" } as Env;
    expect((await check("set_custom_domain", { hostname: "videos.example.com" }, free.key, domains)).data).toMatchObject({ error: "OWNER_ONLY" });
    const rec = await seedReady(free.accountId, { transcript: { segments: [] } });
    await env.MEDIA.put(`v/${rec}.mp4`, MP4());
    expect((await check("get_recording_for_skill", { recording_id: rec, include_video: true }, free.key)).data.video).toMatchObject({ error: "OWNER_ONLY" });
    expect((await check("start_recording", { max_seconds: 900 }, free.key)).data).toMatchObject({ error: "LIMIT_EXCEEDED", max: 300 });
    clean(limitError("video_bytes", 1, 2, "free").message, "limitError");
    await check("get_video", { recording_id: rec }, free.key);
    await check("list_videos", {}, free.key);

    const info = (await check("account_info", {}, free.key)).data;
    expect(info).toMatchObject({ account_id: free.accountId, owner: false, recordings_used: 0, limits: { max_recordings_total: 25, max_devices: 2 } });
    expect(info).not.toHaveProperty("plan");
    const ops = { ...OFF, OWNER_ACCOUNT_IDS: free.accountId } as Env;
    expect((await check("account_info", {}, free.key, ops)).data).toMatchObject({ owner: true, limits: { max_recordings_total: null, max_devices: null } });
    for (const t of ["admin_overview", "admin_usage"]) expect((await check(t, {}, free.key, ops)).isError, t).toBe(false);
    expect((await check("admin_lookup", { account_id: free.accountId }, free.key, ops)).data).toMatchObject({ owner: true });
    expect((await mcp("admin_billing", {}, free.key, ops)).data).toMatchObject({ error: "BILLING_NOT_ENABLED" });

    await seedDevice(free.accountId, "second pc");
    const inst = (await check("get_installer", { platform: "windows" }, free.key)).data;
    expect(inst.device_limit).toMatch(/the most this server allows per account/);
    const enroll = await call("/device/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: inst.pairing_code }) }, OFF);
    expect(enroll.status).toBe(409);
    clean(await enroll.text(), "enroll");

    await env.DB.prepare("UPDATE accounts SET free_recordings_used = 1000 WHERE id = ?").bind(free.accountId).run();
    const full = await check("start_recording", {}, free.key);
    expect(full.data).toMatchObject({ error: "free_limit_reached", limit: 25 });
    expect(full.data.message).toMatch(/Ask the operator of this server/);
    expect(full.data).not.toHaveProperty("upgrade");

    // A paid row left from when billing was on: its storage cap still holds, said without anything to buy.
    const pro = await seedAccount(true);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(pro.accountId).run();
    const big = await seedReady(pro.accountId);
    await env.DB.prepare("UPDATE recordings SET bytes = ? WHERE id = ?").bind(100e9, big).run();
    expect((await check("start_recording", {}, pro.key)).data).toMatchObject({ error: "storage_limit_reached" });
    await check("account_info", {}, pro.key);
  });
});

describe("billing not enabled on this server", () => {
  it("the billing tools answer BILLING_NOT_ENABLED with no link and no Stripe call, for every account", async () => {
    const { accountId, key } = await seedAccount(false);
    const refused = async (e: Env) => {
      for (const tool of ["get_plan", "upgrade", "add_storage", "billing", "cancel_subscription"]) {
        const r = await mcp(tool, {}, key, e);
        expect(r.isError, tool).toBe(true);
        expect(r.data, tool).toEqual({ error: "BILLING_NOT_ENABLED", message: "Billing is not enabled on this server." });
      }
    };
    await refused(OFF);
    // A paid account too (its plan row says pro, but there is no billing here to manage it), and an owner.
    await env.DB.prepare("UPDATE accounts SET plan = 'pro', stripe_customer_id = 'cus_x', stripe_subscription_id = 'sub_x', plan_status = 'active' WHERE id = ?")
      .bind(accountId)
      .run();
    await refused(OFF);
    await refused({ ...OFF, OWNER_ACCOUNT_IDS: accountId } as Env);
    // admin_billing doesn't exist for anyone who isn't an operator, billing or not.
    expect((await mcp("admin_billing", {}, key, OFF)).data).toBeUndefined();
  });

  it("the Stripe webhook route and the pages Stripe returns to are 404", async () => {
    const init = { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" };
    expect((await call("/api/stripe/webhook", init, OFF)).status).toBe(404);
    expect((await call("/billing/success", {}, OFF)).status).toBe(404);
    // Billing on: the route exists (a bad signature is a 400, not a 404).
    expect((await call("/api/stripe/webhook", init)).status).toBe(400);
    expect((await call("/billing/success")).status).toBe(200);
  });
});
