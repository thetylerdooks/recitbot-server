import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isOwnerAccount } from "../src/env";
import { governor } from "../src/governor";
import { now, randomId } from "../src/util";
import { connectDevice, mcp, seedAccount, withEnv } from "./helpers";

const DAY = 86400;
const g = () => governor(env);
const stub = () => env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
const start = (accountId: string, t: number) => g().checkStart({ accountId, paired: true, accountMaxPerDay: null, tier: "free", globalMaxPerDay: 3500, now: t });

const dailyVideos = (day: number) =>
  runInDurableObject(stub(), (_i, s) =>
    Number(s.storage.sql.exec<{ n: number }>("SELECT n FROM daily WHERE k = 'global:videos' AND day = ?", day).toArray()[0]?.n ?? 0),
  );
const startsOf = (accountId: string) =>
  runInDurableObject(stub(), (_i, s) =>
    Number(s.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM starts WHERE account_id = ?", accountId).one().n),
  );

const freeUsed = async (id: string) =>
  (await env.DB.prepare("SELECT free_recordings_used AS n FROM accounts WHERE id = ?").bind(id).first<{ n: number }>())!.n;

/** env.DB whose INSERT INTO recordings fails, like prod without migration 0003. */
const dbWithoutMigration = new Proxy(env.DB, {
  get(target, p) {
    if (p === "prepare") {
      return (q: string) => {
        if (q.startsWith("INSERT INTO recordings")) {
          const fail = { bind: () => fail, run: () => Promise.reject(new Error("D1_ERROR: table recordings has no column named open_link")) };
          return fail;
        }
        return target.prepare(q);
      };
    }
    const v = Reflect.get(target, p);
    return typeof v === "function" ? v.bind(target) : v;
  },
});

describe("failed starts are refunded", () => {
  it("4 starts whose INSERT fails do not consume a slot; the next good start succeeds", async () => {
    const { accountId, key, deviceToken } = await seedAccount();
    const { ws } = await connectDevice(deviceToken!);
    const day = Math.floor(now() / DAY);
    const before = await dailyVideos(day);
    const broken = withEnv({ DB: dbWithoutMigration });
    for (let i = 0; i < 4; i++) {
      const r = await mcp("start_recording", { max_seconds: 10 }, key, broken);
      expect(r.isError).toBe(true);
      expect(r.data.error).toBe("INTERNAL");
    }
    expect(await startsOf(accountId)).toBe(0);
    expect(await dailyVideos(day)).toBe(before);
    expect(await freeUsed(accountId)).toBe(0);

    const ok = await mcp("start_recording", { max_seconds: 10 }, key);
    expect(ok.isError).toBe(false);
    expect(ok.data.recording_id).toBeTruthy();
    expect(await startsOf(accountId)).toBe(1);
    expect(await freeUsed(accountId)).toBe(1);
    ws.close();
  });

  it("releaseStart removes exactly one reservation", async () => {
    const acct = randomId(128);
    const t = now() - 40 * DAY; // its own day, away from other tests
    const day = Math.floor(t / DAY);
    for (let i = 0; i < 3; i++) expect((await start(acct, t)).ok).toBe(true);
    expect(await g().releaseStart(acct, t, "free")).toBe(true);
    expect(await startsOf(acct)).toBe(2);
    expect(await dailyVideos(day)).toBe(2);
    expect((await start(acct, t + 2)).ok).toBe(true);
    // Another account's or another time's reservation is not touched.
    expect(await g().releaseStart(randomId(128), t, "free")).toBe(false);
    expect(await g().releaseStart(acct, t + 999, "free")).toBe(false);
    expect(await startsOf(acct)).toBe(3);
  });

  it("releaseStart never drives the daily counter below 0", async () => {
    const acct = randomId(128);
    const t = now() - 45 * DAY;
    const day = Math.floor(t / DAY);
    // No reservation: nothing changes, no negative row appears.
    expect(await g().releaseStart(acct, t, "free")).toBe(false);
    expect(await dailyVideos(day)).toBe(0);
    // Double release: second is a no-op.
    expect((await start(acct, t)).ok).toBe(true);
    expect(await dailyVideos(day)).toBe(1);
    expect(await g().releaseStart(acct, t, "free")).toBe(true);
    expect(await g().releaseStart(acct, t, "free")).toBe(false);
    expect(await dailyVideos(day)).toBe(0);
    // Counter already at 0 (e.g. reset) while a starts row still exists: clamps at 0.
    expect((await start(acct, t)).ok).toBe(true);
    await runInDurableObject(stub(), (_i, s) => {
      s.storage.sql.exec("UPDATE daily SET n = 0 WHERE k = 'global:videos' AND day = ?", day);
    });
    expect(await g().releaseStart(acct, t, "free")).toBe(true);
    expect(await dailyVideos(day)).toBe(0);
  });
});

describe("owner accounts", () => {
  it("isOwnerAccount: empty and the deploy placeholder mean no owners", () => {
    const e = (v: string | undefined) => withEnv({ OWNER_ACCOUNT_IDS: v });
    expect(isOwnerAccount(e(undefined), "a")).toBe(false);
    expect(isOwnerAccount(e(""), "")).toBe(false);
    expect(isOwnerAccount(e("__SET_BY_DEPLOY__"), "__SET_BY_DEPLOY__")).toBe(false);
    expect(isOwnerAccount(e(" a , b "), "b")).toBe(true);
    expect(isOwnerAccount(e("a,b"), "c")).toBe(false);
    expect(isOwnerAccount(e("a,,b"), "")).toBe(false);
  });

  it("everyone still gets the global daily ceiling", async () => {
    expect(await g().checkStart({ accountId: randomId(128), paired: true, accountMaxPerDay: 500, tier: "owner", globalMaxPerDay: 0, now: now() })).toMatchObject({
      ok: false,
      code: "CAP_REACHED",
    });
  });

  it("start_recording: a free account and an owner both start 20 times in a row without hitting a limit", async () => {
    const me = await seedAccount();
    const other = await seedAccount();
    const e = withEnv({ OWNER_ACCOUNT_IDS: `someone-else,${me.accountId}` });
    const a = await connectDevice(me.deviceToken!);
    const b = await connectDevice(other.deviceToken!);
    for (let i = 0; i < 20; i++) {
      const owner = await mcp("start_recording", { max_seconds: 10 }, me.key, e);
      expect(owner.isError, JSON.stringify(owner.data)).toBe(false);
      const free = await mcp("start_recording", { max_seconds: 10 }, other.key, e);
      expect(free.isError, JSON.stringify(free.data)).toBe(false);
    }
    expect(await startsOf(other.accountId)).toBe(20);
    a.ws.close();
    b.ws.close();
    // Let the DeviceHub finish its close handling (and logging) before the file tears down.
    await new Promise((res) => setTimeout(res, 100));
  });
});
