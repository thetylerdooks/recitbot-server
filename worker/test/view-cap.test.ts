// Watch-page view caps (governor.ts checkView): the owner is never capped; each viewer (salted IP hash, never the raw IP)
// gets LIMITS.viewsPerViewerPerVideoPerDay loads per video per UTC day; the video gets LIMITS.viewsPerVideoPerDay in total.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/env";
import { Governor } from "../src/governor";
import * as sessionModule from "../src/oauth/web-session";
import { hmacHex, now } from "../src/util";
import { call, freshIp, mcp, ORIGIN, seedAccount, seedReady } from "./helpers";

const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});

const DAY = 86400;
const OWNER_COOKIE = /(__Host-rb_owner=[^;]+)/;
const stub = () => env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
const viewerHash = async (ip: string) => (await hmacHex(env.IP_HASH_KEY, `ip:${ip}`)).slice(0, 32);

async function video() {
  const a = await seedAccount();
  const id = await seedReady(a.accountId);
  expect((await mcp("share", { recording_id: id }, a.key)).isError).toBe(false);
  const g = await mcp("get_video", { recording_id: id }, a.key);
  return { ...a, id, path: (g.data.url as string).slice(ORIGIN.length), ownerUrl: g.data.owner_url as string };
}

async function load(path: string, ip: string, headers: Record<string, string> = {}) {
  const res = await call(path, { headers: { "cf-connecting-ip": ip, ...headers } });
  return { status: res.status, html: await res.text() };
}

/** Sets today's Governor counters directly (cheaper than thousands of page loads). */
async function setCount(key: string, n: number) {
  await runInDurableObject(stub(), (_i, s) => {
    s.storage.sql.exec(
      "INSERT INTO daily (k, day, n) VALUES (?, ?, ?) ON CONFLICT (k, day) DO UPDATE SET n = excluded.n",
      key,
      Math.floor(now() / DAY),
      n,
    );
  });
}

const plays = (r: { status: number; html: string }) => r.status === 200 && r.html.includes("<video");

describe("view caps", () => {
  it("owner is never view-capped", async () => {
    const v = await video();
    const ip = freshIp();
    await setCount(`views:${v.id}`, LIMITS.viewsPerVideoPerDay);
    await setCount(`views:${v.id}:${await viewerHash(ip)}`, LIMITS.viewsPerViewerPerVideoPerDay);
    // Anyone else, from the owner's IP or another one, is refused.
    expect((await load(v.path, ip)).html).toContain("Too many reloads");
    expect((await load(v.path, freshIp())).html).toContain("Daily view limit reached");
    // Web session.
    session.account = v.accountId;
    for (let i = 0; i < 3; i++) expect(plays(await load(v.path, ip))).toBe(true);
    session.account = null;
    // ?ot= owner link (its owner cookie).
    const claim = await call(v.ownerUrl.slice(ORIGIN.length), { headers: { "cf-connecting-ip": ip } });
    const cookie = OWNER_COOKIE.exec(claim.headers.get("set-cookie") ?? "")![1];
    for (let i = 0; i < 3; i++) expect(plays(await load(v.path, ip, { cookie }))).toBe(true);
    // Owner loads count nothing.
    const counts = await runInDurableObject(stub(), (_i, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT n FROM daily WHERE k = ?", `views:${v.id}`).toArray(),
    );
    expect(counts[0].n).toBe(LIMITS.viewsPerVideoPerDay);
  });

  it("one IP reloading is capped at 300 while other IPs still play", async () => {
    expect(LIMITS.viewsPerViewerPerVideoPerDay).toBe(300);
    const v = await video();
    const ip = freshIp();
    await setCount(`views:${v.id}:${await viewerHash(ip)}`, LIMITS.viewsPerViewerPerVideoPerDay - 2);
    expect(plays(await load(v.path, ip))).toBe(true); // 299th
    expect(plays(await load(v.path, ip))).toBe(true); // 300th
    const refused = await load(v.path, ip);
    expect(refused.status).toBe(429);
    expect(refused.html).toContain("Too many reloads");
    expect(refused.html).toContain("You've opened this video too many times today. Try again tomorrow.");
    expect(refused.html).not.toContain("<video");
    expect(plays(await load(v.path, freshIp()))).toBe(true);
    // The refused load used none of the video's budget: 2 counted loads + 1 from the other IP.
    const n = await runInDurableObject(stub(), (_i, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT n FROM daily WHERE k = ?", `views:${v.id}`).one().n,
    );
    expect(n).toBe(3);
  });

  it("one IP reloading for real is refused on load 301", async () => {
    const v = await video();
    const ip = freshIp();
    for (let i = 0; i < LIMITS.viewsPerViewerPerVideoPerDay; i++) {
      const res = await call(v.path, { headers: { "cf-connecting-ip": ip } });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    expect((await load(v.path, ip)).status).toBe(429);
    expect(plays(await load(v.path, freshIp()))).toBe(true);
  }, 60_000);

  it("51+ distinct viewers all play", async () => {
    expect(LIMITS.viewsPerVideoPerDay).toBe(20000);
    const v = await video();
    for (let i = 0; i < 60; i++) expect(plays(await load(v.path, freshIp())), `viewer ${i}`).toBe(true);
  }, 30_000);

  it("per-video ceiling still applies", async () => {
    const v = await video();
    await setCount(`views:${v.id}`, LIMITS.viewsPerVideoPerDay);
    const r = await load(v.path, freshIp());
    expect(r.status).toBe(429);
    expect(r.html).toContain("Daily view limit reached");
    // Governor unit: small injected limits; neither refusal consumes the other budget.
    const t = now();
    const res = await runInDurableObject(stub(), (g: Governor, s) => {
      const out = [
        g.checkView("cap-unit", "a", t, 2, 3),
        g.checkView("cap-unit", "a", t, 2, 3),
        g.checkView("cap-unit", "a", t, 2, 3), // viewer refused, video stays at 2
        g.checkView("cap-unit", "b", t, 2, 3),
        g.checkView("cap-unit", "c", t, 2, 3), // video refused, c stays at 0
        g.checkView("cap-unit", "c", t + DAY, 2, 3), // next UTC day: fresh budgets
      ];
      const rows = s.storage.sql
        .exec<{ k: string; day: number; n: number }>("SELECT k, day, n FROM daily WHERE k LIKE 'views:cap-unit%' ORDER BY day, k")
        .toArray();
      return { out, rows };
    });
    expect(res.out).toEqual(["ok", "ok", "viewer", "ok", "video", "ok"]);
    const today = Math.floor(t / DAY);
    expect(res.rows).toEqual([
      { k: "views:cap-unit", day: today, n: 3 },
      { k: "views:cap-unit:a", day: today, n: 2 },
      { k: "views:cap-unit:b", day: today, n: 1 },
      { k: "views:cap-unit", day: today + 1, n: 1 },
      { k: "views:cap-unit:c", day: today + 1, n: 1 },
    ]);
    // prune drops the per-viewer rows with the rest of the daily table.
    const left = await runInDurableObject(stub(), (g: Governor, s) => {
      g.prune(t + 4 * DAY);
      return s.storage.sql.exec("SELECT count(*) AS n FROM daily WHERE k LIKE 'views:cap-unit%'").one().n;
    });
    expect(left).toBe(0);
  });

  it("an Owner-tier account's video (accounts.plan owner) has no per-video ceiling; its viewers keep the per-viewer cap; pro does not", async () => {
    const v = await video();
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(v.accountId).run();
    await setCount(`views:${v.id}`, LIMITS.viewsPerVideoPerDay);
    expect(plays(await load(v.path, freshIp()))).toBe(true);
    const ip = freshIp();
    await setCount(`views:${v.id}:${await viewerHash(ip)}`, LIMITS.viewsPerViewerPerVideoPerDay);
    expect((await load(v.path, ip)).html).toContain("Too many reloads");
    // Pro is not exempt.
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(v.accountId).run();
    expect((await load(v.path, freshIp())).html).toContain("Daily view limit reached");
  });

  it("no raw IP reaches Governor storage: only a 32-hex salted hash", async () => {
    const v = await video();
    const ip = "203.0.113.77";
    expect(plays(await load(v.path, ip))).toBe(true);
    const dump = await runInDurableObject(stub(), (_i, s) => ({
      views: s.storage.sql.exec<{ k: string }>("SELECT k FROM daily WHERE k LIKE ?", `views:${v.id}%`).toArray().map((r) => r.k),
      all: JSON.stringify([
        ...s.storage.sql.exec("SELECT * FROM daily").toArray(),
        ...s.storage.sql.exec("SELECT * FROM rl").toArray(),
        ...s.storage.sql.exec("SELECT * FROM starts").toArray(),
      ]),
    }));
    expect(dump.views.sort()).toEqual([`views:${v.id}`, `views:${v.id}:${await viewerHash(ip)}`].sort());
    for (const k of dump.views.filter((k) => k !== `views:${v.id}`)) expect(k).toMatch(new RegExp(`^views:${v.id}:[0-9a-f]{32}$`));
    expect(dump.all).not.toContain(ip);
  });
});
