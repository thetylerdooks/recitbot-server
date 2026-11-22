import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cleanup } from "../src/index";
import { shareSig } from "../src/share";
import { relevance } from "../src/stats";
import { now } from "../src/util";
import * as sessionModule from "../src/oauth/web-session";
import { brokenGovernor, call, freshIp, mcp, ORIGIN, seedAccount, seedReady, withEnv } from "./helpers";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const DAY = 86400;

// Tests say who is signed in on the website by mocking oauth/web-session getWebSession.
// vi.mock can't reach it: the worker's main module (Durable Objects) is loaded before this file. Spy on the shared module.
const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});

/** Shares the video. share = its public URL; legacy = a signed /v/<id> link as handed out before /<username>/v/<slug>. */
async function links(key: string, id: string): Promise<{ share: string; legacy: string }> {
  const r = await mcp("share", { recording_id: id }, key);
  expect(r.isError).toBe(false);
  const version = (await env.DB.prepare("SELECT version FROM shares WHERE recording_id = ?").bind(id).first<{ version: number }>())!.version;
  const e = now() + 3600;
  return { share: r.data.share_url.slice(ORIGIN.length), legacy: `/v/${id}?e=${e}&s=${await shareSig(env, id, e, version)}` };
}

/** Opens the player page like a browser; returns the view token (null = this view can't be counted). */
async function open(path: string, headers: Record<string, string> = {}): Promise<{ res: Response; html: string; vt: string | null }> {
  const res = await call(path, { headers: { "user-agent": UA, ...headers } });
  const html = await res.text();
  return { res, html, vt: /data-vt="([^"]+)"/.exec(html)?.[1] ?? null };
}

function beacon(id: string, t: string, p: number, headers: Record<string, string> = {}, e: Env = env) {
  return call(
    `/v/${id}/b`,
    {
      method: "POST",
      body: new URLSearchParams({ t, p: String(p) }),
      headers: { "user-agent": UA, "sec-fetch-site": "same-origin", origin: ORIGIN, ...headers },
    },
    e,
  );
}

/** Page load + first beacon from one viewer (IP + UA). */
async function watch(path: string, id: string, ip: string, ua = UA, pct = 0): Promise<void> {
  const { vt } = await open(path, { "cf-connecting-ip": ip, "user-agent": ua });
  expect(vt).toBeTruthy();
  expect((await beacon(id, vt!, 0, { "cf-connecting-ip": ip, "user-agent": ua })).status).toBe(204);
  if (pct) expect((await beacon(id, vt!, pct, { "cf-connecting-ip": ip, "user-agent": ua })).status).toBe(204);
}

async function stats(key: string, id: string) {
  const r = await mcp("get_video_stats", { recording_id: id }, key);
  expect(r.isError).toBe(false);
  return r.data;
}

describe("view counting", () => {
  it("a page load alone counts nothing; the first beacon counts one view", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { share } = await links(key, id);
    const { res, vt } = await open(share);
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(vt).toMatch(/^[A-Za-z0-9]+\.\d+\.[\w-]+$/);
    expect((await stats(key, id)).views).toBe(0);
    expect((await beacon(id, vt!, 0)).status).toBe(204);
    const s = await stats(key, id);
    expect(s).toMatchObject({ views: 1, unique_views: 1, avg_watch_pct: 0, previews: 0 });
    expect(s.last_viewed_at).toBeGreaterThanOrEqual(now() - 5);
  });

  it("is idempotent per view id; progress only raises the furthest point", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { share } = await links(key, id);
    const ip = freshIp();
    const { vt } = await open(share, { "cf-connecting-ip": ip });
    for (const p of [0, 25, 50, 25, 0]) expect((await beacon(id, vt!, p, { "cf-connecting-ip": ip })).status).toBe(204);
    const s = await stats(key, id);
    expect(s).toMatchObject({ views: 1, unique_views: 1, avg_watch_pct: 50 });
    const rows = await env.DB.prepare("SELECT max_pct FROM video_views WHERE recording_id = ?").bind(id).all<{ max_pct: number }>();
    expect(rows.results).toEqual([{ max_pct: 50 }]);
  });

  it("a progress beacon whose load beacon was lost still counts the view once", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { vt } = await open((await links(key, id)).share);
    expect((await beacon(id, vt!, 75)).status).toBe(204);
    expect((await beacon(id, vt!, 100)).status).toBe(204);
    expect(await stats(key, id)).toMatchObject({ views: 1, avg_watch_pct: 100 });
  });

  it("unique viewers dedupe on IP + user agent; avg_watch_pct averages views", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { share } = await links(key, id);
    const a = freshIp();
    const b = freshIp();
    await watch(share, id, a, UA, 100);
    await watch(share, id, a, UA, 50); // same person reopens
    await watch(share, id, b, UA); // another person, loads only
    await watch(share, id, a, "Mozilla/5.0 (iPhone) Safari/604.1"); // same network, other device
    expect(await stats(key, id)).toMatchObject({ views: 4, unique_views: 3, avg_watch_pct: 38 });
  });

  it("stores no raw IP or user agent", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const ip = "203.0.113.77";
    await watch((await links(key, id)).share, id, ip);
    const row = await env.DB.prepare("SELECT * FROM video_views WHERE recording_id = ?").bind(id).first<Record<string, unknown>>();
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(ip);
    expect(dump).not.toContain("Chrome");
    expect(row!.viewer_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("view tokens are bound to their video and expire; bad input is rejected", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const other = await seedReady(accountId);
    const { vt } = await open((await links(key, id)).share);
    expect((await beacon(other, vt!, 0)).status).toBe(403);
    expect((await beacon(id, vt!.replace(/\.[^.]+$/, ".AAAA"), 0)).status).toBe(403);
    expect((await beacon(id, "x.1.y", 0)).status).toBe(403);
    expect((await beacon(id, vt!, 101)).status).toBe(400);
    expect((await beacon(id, vt!, 0, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await beacon(id, vt!, 0, { origin: "https://evil.example" })).status).toBe(403);
    const big = await call(`/v/${id}/b`, { method: "POST", body: `t=${vt}&p=0&pad=${"x".repeat(400)}`, headers: { "sec-fetch-site": "same-origin" } });
    expect(big.status).toBe(413);
    expect((await stats(key, id)).views).toBe(0);
    expect((await stats(key, other)).views).toBe(0);
  });

  it("rate-limits beacons per view and fails closed when the governor is down", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { vt } = await open((await links(key, id)).share);
    expect((await beacon(id, vt!, 0, {}, withEnv({ GOVERNOR: brokenGovernor }))).status).toBe(503);
    expect((await stats(key, id)).views).toBe(0);
    for (let i = 0; i < 20; i++) expect((await beacon(id, vt!, i)).status).toBe(204);
    expect((await beacon(id, vt!, 99)).status).toBe(429);
    expect(await stats(key, id)).toMatchObject({ views: 1, avg_watch_pct: 19 });
  });

  it("READ_ONLY records nothing; deleted videos take their views with them", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { vt } = await open((await links(key, id)).share);
    expect((await beacon(id, vt!, 0, {}, withEnv({ SERVICE_MODE: "READ_ONLY" }))).status).toBe(204);
    expect((await stats(key, id)).views).toBe(0);
    expect((await beacon(id, vt!, 0)).status).toBe(204);
    expect((await mcp("delete", { recording_id: id }, key)).isError).toBe(false);
    expect((await beacon(id, vt!, 50)).status).toBe(204); // late pagehide beacon: nothing to attach it to
    const left = await env.DB.prepare("SELECT count(*) AS n FROM video_views WHERE recording_id = ?").bind(id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

describe("owner exclusion", () => {
  it("the signed-in owner sees the video without a view token", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { share } = await links(key, id);
    session.account = accountId;
    const o = await open(share);
    expect(o.res.status).toBe(200);
    expect(o.html).toContain("Owner view: not counted");
    expect(o.vt).toBeNull();
    session.account = (await seedAccount()).accountId; // someone else signed in: a normal view
    expect((await open(share)).vt).toBeTruthy();
  });

  it("an old signed /v/<id> link (with or without the retired o= marker) 301s, sets nothing, and its viewer counts", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { share, legacy } = await links(key, id);
    for (const path of [legacy, `${legacy}&o=anything`]) {
      const r = await call(path, { headers: { "user-agent": UA } });
      expect(r.status).toBe(301);
      expect(r.headers.get("location")).toBe(share);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    // A leftover `ro` cookie from before means nothing either.
    const ip = freshIp();
    const { vt } = await open(share, { cookie: "ro=1.x.y", "cf-connecting-ip": ip });
    expect(vt).toBeTruthy();
    expect((await beacon(id, vt!, 0, { "cf-connecting-ip": ip })).status).toBe(204);
    expect((await stats(key, id)).views).toBe(1);
  });

  it("a viewer on the paired PC's network (same public IP: office, home Wi-Fi, carrier NAT) is counted", async () => {
    const { accountId, key, deviceToken } = await seedAccount();
    const id = await seedReady(accountId);
    const pcIp = freshIp();
    const ws = (await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${deviceToken}`, "cf-connecting-ip": pcIp } }))
      .webSocket!;
    ws.accept();
    ws.close();
    const { share } = await links(key, id);
    const page = await open(share, { "cf-connecting-ip": pcIp });
    expect(page.vt).toBeTruthy();
    // The beacon goes where player.js sends it: the page's own path + /b.
    const b = await call(`${share}/b`, {
      method: "POST",
      body: new URLSearchParams({ t: page.vt!, p: "0" }),
      headers: { "user-agent": UA, "sec-fetch-site": "same-origin", origin: ORIGIN, "cf-connecting-ip": pcIp },
    });
    expect(b.status).toBe(204);
    expect(await stats(key, id)).toMatchObject({ views: 1, unique_views: 1 });
    // The owner on that same network is still not counted: they are signed in (or hold the owner link's cookie).
    session.account = accountId;
    expect((await open(share, { "cf-connecting-ip": pcIp })).vt).toBeNull();
  });
});

describe("bots and prefetch", () => {
  it("link-preview bots are counted as previews, never as views", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { share } = await links(key, id);
    for (const ua of ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "Twitterbot/1.0", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; Discordbot/2.0)"]) {
      const r = await open(share, { "user-agent": ua });
      expect(r.res.status).toBe(200);
      expect(r.vt).toBeNull();
      expect(r.html).not.toContain("<video");
    }
    expect(await stats(key, id)).toMatchObject({ views: 0, previews: 4 });
  });

  it("a beacon with a bot user agent is ignored", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { vt } = await open((await links(key, id)).share);
    expect((await beacon(id, vt!, 0, { "user-agent": "Discordbot/2.0" })).status).toBe(204);
    expect((await stats(key, id)).views).toBe(0);
  });

  it("HEAD, media Range requests and GET on the beacon URL never count", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { share } = await links(key, id);
    const m = `/m/${share.split("/").pop()}`;
    expect((await call(share, { method: "HEAD" })).status).toBe(404);
    expect((await call(m, { headers: { range: "bytes=0-99" } })).status).toBe(403);
    expect((await call(`/v/${id}/b`)).status).toBe(404);
    expect((await call(`${share}/b`)).status).toBe(404);
    const page = await open(share); // a media fetch with a real cookie is still not a view
    const mt = /mt=[^;]+/.exec(page.res.headers.get("set-cookie")!)![0];
    expect((await call(m, { headers: { cookie: mt, range: "bytes=0-99" } })).status).toBe(206);
    expect(await stats(key, id)).toMatchObject({ views: 0, previews: 0 });
  });
});

describe("MCP stats tools", () => {
  it("list_videos (and list) are newest first with stats per video", async () => {
    const { accountId, key } = await seedAccount();
    const t = now();
    const old = await seedReady(accountId, { createdAt: t - 300 });
    const mid = await seedReady(accountId, { createdAt: t - 200 });
    const neu = await seedReady(accountId, { createdAt: t - 100 });
    await watch((await links(key, mid)).share, mid, freshIp(), UA, 50);
    const r = await mcp("list_videos", {}, key);
    expect(r.data.recordings.map((x: any) => x.recording_id)).toEqual([neu, mid, old]);
    expect(r.data.recordings[1]).toMatchObject({ views: 1, unique_views: 1, avg_watch_pct: 50, previews: 0 });
    expect(r.data.recordings[0]).toMatchObject({ views: 0, unique_views: 0, last_viewed_at: null, avg_watch_pct: null });
    expect((await mcp("list", { limit: 1 }, key)).data.recordings.map((x: any) => x.recording_id)).toEqual([neu]);
  });

  it("search_videos ranks by relevance, ties newest first, and leaves out non-matches", async () => {
    const { accountId, key } = await seedAccount();
    const t = now();
    const seg = (text: string) => ({ segments: [{ start: 0, end: 1, text }] });
    const titled = async (title: string, createdAt: number, transcript?: unknown) => {
      const id = await seedReady(accountId, { createdAt, transcript });
      await env.DB.prepare("UPDATE recordings SET title = ? WHERE id = ?").bind(title, id).run();
      return id;
    };
    const transcriptOnly = await titled("Weekly sync", t - 50, seg("we talked about the pricing page"));
    const olderTitle = await titled("Pricing demo", t - 400);
    const newerTitle = await titled("Pricing demo", t - 300);
    await titled("Invoices", t - 10);
    const r = await mcp("search_videos", { query: "pricing demo" }, key);
    expect(r.isError).toBe(false);
    expect(r.data.recordings.map((x: any) => x.recording_id)).toEqual([newerTitle, olderTitle, transcriptOnly]);
    expect(r.data.recordings[0]).toHaveProperty("unique_views", 0);
    expect((await mcp("search_videos", { query: "zebra" }, key)).data.recordings).toEqual([]);
  });

  it("relevance: title beats transcript, whole query beats scattered words", () => {
    expect(relevance("pricing", "Pricing demo", "")).toBeGreaterThan(relevance("pricing", "Demo", "pricing pricing"));
    expect(relevance("pricing demo", "Pricing demo", "")).toBeGreaterThan(relevance("pricing demo", "Demo of pricing", ""));
    expect(relevance("  ", "anything", "anything")).toBe(0);
  });

  it("get_video_stats: totals plus per-day breakdown for the last 30 days; account-scoped", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    await watch((await links(key, id)).share, id, freshIp(), UA, 100);
    const t = now();
    const ins = env.DB.prepare("INSERT INTO video_views (id, recording_id, viewer_hash, created_at, max_pct) VALUES (?, ?, ?, ?, ?)");
    await env.DB.batch([
      ins.bind("old1aaaaaaaaaaaa", id, "h1", t - DAY, 20),
      ins.bind("old2aaaaaaaaaaaa", id, "h1", t - DAY, 40),
      ins.bind("old3aaaaaaaaaaaa", id, "h2", t - 40 * DAY, 0),
    ]);
    const s = await stats(key, id);
    expect(s.daily).toHaveLength(2);
    expect(s.daily[0]).toEqual({ date: new Date(t * 1000).toISOString().slice(0, 10), views: 1, unique_views: 1, avg_watch_pct: 100 });
    expect(s.daily[1]).toEqual({ date: new Date((t - DAY) * 1000).toISOString().slice(0, 10), views: 2, unique_views: 1, avg_watch_pct: 30 });
    expect((await mcp("get_video_stats", { video_id: id }, key)).data.views).toBe(1);
    expect((await mcp("get_video_stats", {}, key)).data.error).toBe("INVALID_ARGUMENTS");
    const stranger = await seedAccount();
    expect((await mcp("get_video_stats", { recording_id: id }, stranger.key)).data.error).toBe("NOT_FOUND");
  });

  it("describes how to answer 'how many people watched my last video'", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string }[];
    const d = tools.find((x) => x.name === "list_videos")!.description;
    expect(d).toMatch(/newest first/);
    expect(d).toMatch(/how many people watched my last video/);
    expect(d).toMatch(/unique_views/);
    // owner_url is back (owner-link.ts), with the rule never to hand it to anyone but the user.
    expect(tools.find((x) => x.name === "get_video")!.description).toContain("NEVER post owner_url anywhere public");
  });
});

describe("daily salt", () => {
  it("the cron drops salts older than yesterday", async () => {
    const today = Math.floor(now() / DAY);
    await env.DB.prepare("INSERT INTO view_salts (day, salt) VALUES (?, 'old'), (?, 'y') ON CONFLICT DO NOTHING").bind(today - 5, today - 1).run();
    await cleanup(env);
    const days = (await env.DB.prepare("SELECT day FROM view_salts").all<{ day: number }>()).results.map((r) => r.day);
    expect(days).not.toContain(today - 5);
    expect(days).toContain(today - 1);
  });
});
