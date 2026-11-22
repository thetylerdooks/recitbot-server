import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountLimits, freeLimitMessage, LIMITS, startsPerDay, type Env, type Tier } from "../src/env";
import { governor } from "../src/governor";
import { cleanup } from "../src/index";
import { now, randomId } from "../src/util";
import { call, connectDevice, mcp, seedAccount, withEnv } from "./helpers";

const DAY = 86400;
const g = () => governor(env);
const start = (accountId: string, t: number, tier: Tier = "free", globalMaxPerDay = 3500) =>
  g().checkStart({ accountId, paired: true, accountMaxPerDay: startsPerDay(tier), tier, globalMaxPerDay, now: t });
const used = async (id: string) =>
  (await env.DB.prepare("SELECT free_recordings_used AS n FROM accounts WHERE id = ?").bind(id).first<{ n: number }>())!.n;
const setUsed = (id: string, n: number) => env.DB.prepare("UPDATE accounts SET free_recordings_used = ? WHERE id = ?").bind(n, id).run();
const setPlan = (id: string, plan: string) => env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, id).run();
const rec = (key: string, e: Env = env) => mcp("start_recording", { max_seconds: 10 }, key, e);
const settle = () => new Promise((res) => setTimeout(res, 100));
const startFrames = (frames: any[]) => frames.filter((f) => f.type === "start").length;

function expectFreeLimit(r: { isError: boolean; data: any }) {
  expect(r.isError).toBe(true);
  expect(r.data).toMatchObject({ error: "free_limit_reached", limit: 25, used: 25, message: freeLimitMessage(25) });
  expect(r.data.message).toBe(
    "You've used all 25 recordings on the Recitbot Free plan (25 in total; deleting videos doesn't give any back). " +
      "Upgrade to Recitbot Pro to remove the limit and keep recording: just ask me to upgrade.",
  );
  // The way to Pro is the existing upgrade tool.
  expect(r.data.upgrade).toMatch(/^Call upgrade /);
}

describe("Free plan: 25 recordings in total", () => {
  it("the 25th start works, the 26th is refused before anything reaches the PC; deleting gives none back", async () => {
    expect(LIMITS.freeRecordings).toBe(25);
    const me = await seedAccount();
    const { ws, frames } = await connectDevice(me.deviceToken!);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await rec(me.key);
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      ids.push(r.data.recording_id);
    }
    expect(await used(me.accountId)).toBe(25);
    await settle();
    const sent = startFrames(frames);
    expect(sent).toBe(25);

    expectFreeLimit(await rec(me.key));
    await settle();
    expect(startFrames(frames)).toBe(sent);
    expect(await used(me.accountId)).toBe(25);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE account_id = ?").bind(me.accountId).first<{ n: number }>();
    expect(rows!.n).toBe(25);

    // Deleting recordings never gives one back.
    for (const id of ids.slice(0, 3)) expect((await mcp("delete", { recording_id: id }, me.key)).data).toMatchObject({ deleted: true });
    expect(await used(me.accountId)).toBe(25);
    expectFreeLimit(await rec(me.key));
    // account_info shows the count.
    const info = await mcp("account_info", {}, me.key);
    expect(info.data).toMatchObject({ recordings_used: 25, limits: { max_recordings_total: 25 } });
    ws.close();
    await settle();
  });

  it("refused even with the PC offline (checked before the device)", async () => {
    const me = await seedAccount();
    await setUsed(me.accountId, 25);
    expectFreeLimit(await rec(me.key));
  });

  it("never resets: a month later, after cleanup removed every video, still refused", async () => {
    const me = await seedAccount();
    const { ws } = await connectDevice(me.deviceToken!);
    await setUsed(me.accountId, 24);
    expect((await rec(me.key)).isError).toBe(false);
    expectFreeLimit(await rec(me.key));
    // Cleanup 40 days on deletes the expired recording and prunes the Governor's daily counters; the count stays.
    await cleanup(env, now() + 40 * DAY);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE account_id = ?").bind(me.accountId).first<{ n: number }>();
    expect(rows!.n).toBe(0);
    expect(await used(me.accountId)).toBe(25);
    expectFreeLimit(await rec(me.key));
    ws.close();
    await settle();
  });

  it("no daily cap on Free any more: 25 starts in one UTC day all go through the Governor", async () => {
    expect(startsPerDay("free")).toBeNull();
    expect(LIMITS.ownerStartsPerDay).toBe(500);
    const acct = randomId(128);
    const t = now() - 50 * DAY; // its own day, away from other tests
    for (let i = 0; i < 30; i++) expect(await start(acct, t + i)).toEqual({ ok: true });
  });

  it("a failed start gives the Free recording back", async () => {
    const me = await seedAccount();
    await setUsed(me.accountId, 24);
    // Offline PC: refused before the count is taken.
    expect((await rec(me.key)).data.error).toBe("DEVICE_OFFLINE");
    expect(await used(me.accountId)).toBe(24);
    // Governor refuses (global ceiling 0): taken, then handed back.
    const { ws } = await connectDevice(me.deviceToken!);
    expect((await rec(me.key, withEnv({ GLOBAL_MAX_VIDEOS_PER_DAY: "0" }))).data.error).toBe("CAP_REACHED");
    expect(await used(me.accountId)).toBe(24);
    expect((await rec(me.key)).isError).toBe(false);
    expect(await used(me.accountId)).toBe(25);
    ws.close();
    await settle();
  });

  it("Pro, Teams and owners are exempt, and their recordings don't use up the Free allowance", async () => {
    const pro = await seedAccount();
    const teams = await seedAccount();
    const planOwner = await seedAccount();
    const envOwner = await seedAccount();
    await setPlan(pro.accountId, "pro");
    await setPlan(teams.accountId, "teams");
    await setPlan(planOwner.accountId, "owner");
    for (const a of [pro, teams, planOwner, envOwner]) await setUsed(a.accountId, 25);
    const e = withEnv({ OWNER_ACCOUNT_IDS: envOwner.accountId });
    for (const a of [pro, teams, planOwner, envOwner]) {
      expect((await accountLimits(e, a.accountId)).freeRecordings).toBeNull();
      const { ws } = await connectDevice(a.deviceToken!);
      for (let i = 0; i < 2; i++) {
        const r = await rec(a.key, e);
        expect(r.isError, JSON.stringify(r.data)).toBe(false);
      }
      expect(await used(a.accountId)).toBe(25);
      ws.close();
    }
    await settle();

    // Pro-era recordings don't count: 3 on Pro, back to Free, the count is still where Free left it.
    const p = await seedAccount();
    await setUsed(p.accountId, 23);
    await setPlan(p.accountId, "pro");
    const { ws } = await connectDevice(p.deviceToken!);
    for (let i = 0; i < 3; i++) expect((await rec(p.key)).isError).toBe(false);
    expect(await used(p.accountId)).toBe(23);
    await setPlan(p.accountId, "free");
    expect((await rec(p.key)).isError).toBe(false);
    expect((await rec(p.key)).isError).toBe(false);
    expectFreeLimit(await rec(p.key));
    expect((await mcp("account_info", {}, p.key)).data).toMatchObject({ recordings_used: 25 });
    ws.close();
    await settle();
  });

  it("per account: two accounts paired on one computer count separately", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await setUsed(a.accountId, 25);
    await setUsed(b.accountId, 24);
    const sa = await connectDevice(a.deviceToken!);
    const sb = await connectDevice(b.deviceToken!);
    expectFreeLimit(await rec(a.key));
    expect((await rec(b.key)).isError).toBe(false);
    expectFreeLimit(await rec(b.key));
    expect(await used(a.accountId)).toBe(25);
    expect(await used(b.accountId)).toBe(25);
    await settle();
    expect(startFrames(sa.frames)).toBe(0);
    expect(startFrames(sb.frames)).toBe(1);
    sa.ws.close();
    sb.ws.close();
    await settle();
  });
});

describe("migration 0023 backfill", () => {
  it("counts the surviving recordings started on Free; Pro-era rows and handed-back starts don't count", async () => {
    const q = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0023"))!.queries.find((s) => s.trimStart().startsWith("UPDATE"))!;
    const t = now() - 2 * DAY;
    const free = await seedAccount(false);
    const wasPro = await seedAccount(false);
    const owner = await seedAccount(false);
    await setPlan(owner.accountId, "owner");
    const row = (acct: string, created: number, expires: number, status = "ready", error: string | null = null) =>
      env.DB.prepare("INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at, error) VALUES (?, ?, 'd', ?, 60, ?, ?, ?)")
        .bind(randomId(128), acct, status, created, expires, error)
        .run();
    await row(free.accountId, t, t + 7 * DAY);
    await row(free.accountId, t + 1, t + 1 + DAY); // older 24 h retention
    await row(free.accountId, t + 2, t + 2 + 7 * DAY, "failed", "DEVICE_OFFLINE"); // handed back
    await row(free.accountId, t + 3, t + 3 + 7 * DAY, "failed", "TIMEOUT"); // started, then failed: counts
    await row(wasPro.accountId, t, 253402300799); // made on Pro
    await row(wasPro.accountId, t, t + 9 * DAY); // made on Pro, moved to Free retention by a downgrade
    await row(wasPro.accountId, t + 5, t + 5 + 7 * DAY); // made on Free
    await row(owner.accountId, t, t + 7 * DAY);
    await env.DB.prepare(q).run();
    expect(await used(free.accountId)).toBe(3);
    expect(await used(wasPro.accountId)).toBe(1);
    expect(await used(owner.accountId)).toBe(0);
  });
});

describe("global daily ceiling: Free gets a share, paid keeps its own room", () => {
  it("Free stops at its share; Pro and owners still start up to the full ceiling", async () => {
    expect(LIMITS.freeShareOfGlobalVideos).toBe(0.8);
    const t = now() - 53 * DAY; // its own day
    const max = 10; // Free share: 8
    for (let i = 0; i < 8; i++) expect(await start(randomId(128), t + i, "free", max)).toEqual({ ok: true });
    expect(await start(randomId(128), t + 8, "free", max)).toMatchObject({ ok: false, code: "CAP_REACHED", reason: "Global daily recording ceiling reached." });
    expect(await start(randomId(128), t + 9, "pro", max)).toEqual({ ok: true });
    expect(await start(randomId(128), t + 10, "owner", max)).toEqual({ ok: true });
    // The full ceiling stops everyone.
    expect(await start(randomId(128), t + 11, "pro", max)).toMatchObject({ ok: false, code: "CAP_REACHED" });
  });

  it("a released Free start hands back its Free share too", async () => {
    const t = now() - 54 * DAY;
    const max = 5; // Free share: 4
    const accts = Array.from({ length: 4 }, () => randomId(128));
    for (const [i, a] of accts.entries()) expect(await start(a, t + i, "free", max)).toEqual({ ok: true });
    expect((await start(randomId(128), t + 4, "free", max)).ok).toBe(false);
    expect(await g().releaseStart(accts[0], t, "free")).toBe(true);
    expect(await start(randomId(128), t + 5, "free", max)).toEqual({ ok: true });
    const free = await runInDurableObject(env.GOVERNOR.get(env.GOVERNOR.idFromName("global")), (_i, s) =>
      Number(s.storage.sql.exec<{ n: number }>("SELECT n FROM daily WHERE k = 'global:videos:free' AND day = ?", Math.floor(t / DAY)).one().n),
    );
    expect(free).toBe(4);
  });
});

describe("per-account daily start cap (owner only; Pro and Teams have none)", () => {
  it("released start gives the per-account slot back", async () => {
    const acct = randomId(128);
    const t = now() - 51 * DAY;
    for (let i = 0; i < 500; i++) expect(await start(acct, t + i, "owner")).toEqual({ ok: true });
    expect(await start(acct, t + 500, "owner")).toMatchObject({ ok: false, code: "CAP_REACHED" });
    expect(await g().releaseStart(acct, t + 5, "owner")).toBe(true);
    expect(await start(acct, t + 501, "owner")).toEqual({ ok: true });
    expect(await start(acct, t + 502, "owner")).toMatchObject({ ok: false, code: "CAP_REACHED" });
    // The next UTC day starts from 0.
    expect(await start(acct, (Math.floor(t / DAY) + 1) * DAY, "owner")).toEqual({ ok: true });
  });

  it("owner cap is 500 with no upgrade text; Pro and Teams have no daily count", async () => {
    expect(startsPerDay("owner")).toBe(500);
    const acct = randomId(128);
    const t = now() - 55 * DAY;
    for (let i = 0; i < 500; i++) expect((await start(acct, t + i, "owner")).ok).toBe(true);
    const refused = await start(acct, t + 500, "owner");
    expect(refused).toMatchObject({ ok: false, code: "CAP_REACHED", resets_at: (Math.floor(t / DAY) + 1) * DAY });
    expect(refused.ok === false && refused.reason).toMatch(/^Daily recording limit reached \(500 per day\)\. Try again after \d{4}-\d{2}-\d{2} 00:00 UTC\.$/);

    expect(refused.ok === false && refused.reason).not.toContain("Upgrade");

    expect(startsPerDay("pro")).toBeNull();
    expect(startsPerDay("teams")).toBeNull();
    for (const tier of ["pro", "teams"] as const) {
      const p = randomId(128);
      const tp = now() - (tier === "pro" ? 57 : 58) * DAY;
      // Past the old 200 a day: only the global ceiling applies.
      for (let i = 0; i < 300; i++) expect((await start(p, tp + i, tier)).ok).toBe(true);
    }
  });

  it("the cap follows accounts.plan through accountLimits: plan owner 500, pro and free none", async () => {
    const pro = await seedAccount();
    const owner = await seedAccount();
    const free = await seedAccount();
    await setPlan(pro.accountId, "pro");
    await setPlan(owner.accountId, "owner");
    expect((await accountLimits(env, pro.accountId)).startsPerDay).toBeNull();
    expect((await accountLimits(env, owner.accountId)).startsPerDay).toBe(500);
    expect((await accountLimits(env, free.accountId)).startsPerDay).toBeNull();
    expect((await accountLimits(env, free.accountId)).freeRecordings).toBe(25);
    expect((await accountLimits(withEnv({ OWNER_ACCOUNT_IDS: free.accountId }), free.accountId)).startsPerDay).toBe(500);
  });

  it("the global ceiling keeps its own message", async () => {
    const r = await g().checkStart({ accountId: randomId(128), paired: true, accountMaxPerDay: null, tier: "free", globalMaxPerDay: 0, now: now() });
    expect(r).toMatchObject({ ok: false, code: "CAP_REACHED", reason: "Global daily recording ceiling reached." });
  });
});

describe("JSON-RPC batches and the MCP rate limit", () => {
  const post = (key: string, body: unknown) =>
    call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  const pings = (n: number) => Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "ping" }));
  /** Keeps the whole test inside one 60 s rate-limit window. */
  const freshWindow = async () => {
    const left = 60 - (now() % 60);
    if (left < 15) await new Promise((res) => setTimeout(res, left * 1000 + 100));
  };

  it("a 20-message JSON-RPC batch counts as 20 against the per-minute limiter", async () => {
    await freshWindow();
    const { key } = await seedAccount();
    const batch = await post(key, pings(20));
    expect(batch.status).toBe(200);
    expect(((await batch.json()) as unknown[]).length).toBe(20);
    for (let i = 0; i < 40; i++) expect((await mcp("list", {}, key)).status).toBe(200);
    expect((await mcp("list", {}, key)).status).toBe(429);
  }, 30_000);

  it("a batch bigger than the remaining budget is refused whole", async () => {
    await freshWindow();
    const { key } = await seedAccount();
    expect((await post(key, pings(61))).status).toBe(429);
    // Nothing was consumed: 50 singles still fit, then a 20-message batch does not (10 left).
    for (let i = 0; i < 50; i++) expect((await mcp("list", {}, key)).status).toBe(200);
    expect((await post(key, pings(20))).status).toBe(429);
    expect((await post(key, pings(10))).status).toBe(200);
    expect((await mcp("list", {}, key)).status).toBe(429);
  }, 30_000);
});
