// The per-account retention hold (accounts.retention_hold, migration 0032; retention-hold.ts, admin-retention-tools.ts):
// an operator pauses the Free auto-delete and 7-day expiry for one account, reversibly. Stored expires_at never changes.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCustomHostCache } from "../src/custom-host";
import type { Env } from "../src/env";
import { LIMITS } from "../src/env";
import worker, { cleanup } from "../src/index";
import * as sessionModule from "../src/oauth/web-session";
import { pushReady } from "../src/ready";
import { expiredRecordingIds, KEEP_FOREVER, videoFileUrl } from "../src/share";
import { now, randomId } from "../src/util";
import { call, connectDevice, freshIp, mcp, ORIGIN, seedAccount, seedReady, withEnv } from "./helpers";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const TOOL = "admin_retention_hold";

const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
beforeEach(() => clearCustomHostCache());
afterEach(() => {
  session.account = null;
});

const setHold = (accountId: string, hold: 0 | 1) => env.DB.prepare("UPDATE accounts SET retention_hold = ? WHERE id = ?").bind(hold, accountId).run();
const holdOf = (accountId: string) => env.DB.prepare("SELECT retention_hold FROM accounts WHERE id = ?").bind(accountId).first<number>("retention_hold");
const expiryOf = (id: string) => env.DB.prepare("SELECT expires_at FROM recordings WHERE id = ?").bind(id).first<number>("expires_at");
const expire = (id: string) => env.DB.prepare("UPDATE recordings SET expires_at = ? WHERE id = ?").bind(now() - 100, id).run();

/** A Free account with one shared video past its expires_at: its id, key, the video's id, page path and slug. */
async function expiredVideo() {
  const a = await seedAccount();
  const id = await seedReady(a.accountId, { transcript: { segments: [{ start: 0, end: 1, text: "quarterly budget" }] } });
  const r = await mcp("share", { recording_id: id }, a.key);
  expect(r.isError).toBe(false);
  const path = (r.data.share_url as string).slice(ORIGIN.length);
  await expire(id);
  return { ...a, id, path, slug: path.split("/").pop()! };
}

const page = (path: string) => call(path, { headers: { "user-agent": UA } });
const listed = async (key: string) => ((await mcp("list_videos", {}, key)).data.recordings as any[]).map((r) => r.recording_id);

async function operator() {
  const admin = await seedAccount(false);
  return { admin, E: withEnv({ OWNER_ACCOUNT_IDS: admin.accountId }) };
}

async function rpc(body: unknown, key: string, e: Env) {
  const res = await call("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, e);
  return (await res.json()) as any;
}
const toolNames = async (key: string, e: Env) => ((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key, e)).result.tools as { name: string }[]).map((t) => t.name);

describe("cleanup", () => {
  it("off by default: a Free account's videos past expires_at are deleted as before", async () => {
    const v = await expiredVideo();
    expect(await holdOf(v.accountId)).toBe(0);
    expect(await expiredRecordingIds(env, now())).toContain(v.id);
    await cleanup(env);
    expect(await expiryOf(v.id)).toBeNull();
    expect(await env.MEDIA.head(`v/${v.id}.mp4`)).toBeNull();
  });

  it("skips a held account's videos (nobody else's), and takes them again once the hold is cleared", async () => {
    const held = await expiredVideo();
    const other = await expiredVideo();
    const before = await expiryOf(held.id);
    await setHold(held.accountId, 1);
    const ids = await expiredRecordingIds(env, now());
    expect(ids).not.toContain(held.id);
    expect(ids).toContain(other.id);
    await cleanup(env);
    expect(await expiryOf(held.id)).toBe(before);
    expect(await env.MEDIA.head(`v/${held.id}.mp4`)).not.toBeNull();
    expect(await expiryOf(other.id)).toBeNull();

    await setHold(held.accountId, 0);
    expect(await expiredRecordingIds(env, now())).toContain(held.id);
    await cleanup(env);
    expect(await expiryOf(held.id)).toBeNull();
    expect(await env.MEDIA.head(`v/${held.id}.mp4`)).toBeNull();
  });

  it("owner-tier rows still move to KEEP_FOREVER; the account's owner can still delete a held video", async () => {
    const o = await expiredVideo();
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(o.accountId).run();
    expect(await expiredRecordingIds(env, now())).not.toContain(o.id);
    expect(await expiryOf(o.id)).toBe(KEEP_FOREVER);

    const v = await expiredVideo();
    await setHold(v.accountId, 1);
    expect((await mcp("delete", { recording_id: v.id }, v.key)).data.deleted).toBe(true);
    expect(await expiryOf(v.id)).toBeNull();
  });

  it("a new Free recording of a held account still stores the normal +7 days", async () => {
    const a = await seedAccount();
    await setHold(a.accountId, 1);
    const dev = await connectDevice(a.deviceToken!);
    expect((await mcp("start_recording", { max_seconds: 10 }, a.key)).isError).toBe(false);
    dev.ws.close();
    const row = await env.DB.prepare("SELECT created_at, expires_at FROM recordings WHERE account_id = ?").bind(a.accountId).first<{ created_at: number; expires_at: number }>();
    expect(row!.expires_at - row!.created_at).toBe(LIMITS.retentionSeconds);
  });
});

describe("a Free video past expires_at", () => {
  it("opens, plays, counts views and lists while held; expired before and after", async () => {
    const v = await expiredVideo();
    const before = await expiryOf(v.id);
    const gone = async () => {
      expect((await page(v.path)).status).toBe(404);
      expect((await call(`/v/${v.id}?ot=x`, { headers: { "user-agent": UA } })).status).toBe(303);
      expect(await listed(v.key)).toEqual([]);
      expect((await mcp("search_videos", { query: "budget" }, v.key)).data.recordings).toEqual([]);
      const g = await mcp("get_video", { recording_id: v.id }, v.key);
      expect(g.data.status).toBe("expired");
      expect(g.data.auto_delete_paused).toBeUndefined();
      expect((await mcp("share", { recording_id: v.id }, v.key)).data.error).toBe("NOT_READY");
      expect((await mcp("get_recording_for_skill", { recording_id: v.id }, v.key)).data.error).toBe("NOT_READY");
    };
    await gone();

    await setHold(v.accountId, 1);
    const res = await page(v.path);
    expect(res.status).toBe(200);
    const mt = /(mt=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
    const vt = /data-vt="([^"]+)"/.exec(await res.text())![1];
    expect((await call(`/m/${v.slug}`, { headers: { cookie: mt } })).status).toBe(200);
    const beacon = await call(`${v.path}/b`, { method: "POST", body: new URLSearchParams({ t: vt, p: "0" }), headers: { "user-agent": UA, origin: ORIGIN, "sec-fetch-site": "same-origin" } });
    expect(beacon.status).toBe(204);
    expect((await mcp("get_video_stats", { recording_id: v.id }, v.key)).data).toMatchObject({ views: 1, status: "ready" });

    expect(await listed(v.key)).toEqual([v.id]);
    const row = (await mcp("list_videos", {}, v.key)).data.recordings[0];
    expect(row).toMatchObject({ expires_at: before, auto_delete_paused: true });
    expect(row.retention_hold).toBeUndefined();
    expect((await mcp("search_videos", { query: "budget" }, v.key)).data.recordings.map((r: any) => r.recording_id)).toEqual([v.id]);
    expect((await mcp("get_video", { recording_id: v.id }, v.key)).data).toMatchObject({ status: "ready", expires_at: before, auto_delete_paused: true });
    expect((await mcp("share", { recording_id: v.id }, v.key)).isError).toBe(false);
    expect((await mcp("get_recording_for_skill", { recording_id: v.id }, v.key)).isError).toBe(false);
    // Another account, by the shared URL.
    const other = await seedAccount(false);
    expect((await mcp("get_recording_for_skill", { url: ORIGIN + v.path }, other.key)).data.source).toBe("shared_link");

    await setHold(v.accountId, 0);
    expect(await expiryOf(v.id)).toBe(before);
    await gone();
    expect((await call(`/m/${v.slug}`, { headers: { cookie: mt } })).status).not.toBe(200);
    expect((await mcp("get_recording_for_skill", { url: ORIGIN + v.path }, other.key)).data.error).toBe("NOT_FOUND");
  });

  it("the owner's page Share button, owner link, download and file link follow the hold", async () => {
    const v = await expiredVideo();
    // Download needs a paid plan, whatever the hold.
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(v.accountId).run();
    session.account = v.accountId;
    const share = () => call(`${v.path}/share`, { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } });
    const ownerUrl = ((await mcp("get_video", { recording_id: v.id }, v.key)).data.owner_url as string).slice(ORIGIN.length);
    const file = (await videoFileUrl(env, ORIGIN, v.id)).url.slice(ORIGIN.length);
    const statuses = async () => [
      (await share()).status,
      (await call(`${v.path}/download`, { headers: { "user-agent": UA } })).status,
      (await call(file)).status,
      (await call(ownerUrl, { headers: { "user-agent": UA } })).headers.has("set-cookie"),
    ];
    expect(await statuses()).toEqual([404, 404, 404, false]);
    await setHold(v.accountId, 1);
    expect(await statuses()).toEqual([200, 200, 200, true]);
    await setHold(v.accountId, 0);
    expect(await statuses()).toEqual([404, 404, 404, false]);
  });

  it("plays on the account's custom host while held, else goes to our own host", async () => {
    const v = await expiredVideo();
    const host = `videos-${randomId(30).toLowerCase()}.example.com`;
    const t = now();
    await env.DB.prepare("INSERT INTO custom_domains (id, account_id, hostname, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .bind(randomId(), v.accountId, host, t, t)
      .run();
    const open = async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://${host}/${v.slug}`, { headers: { "cf-connecting-ip": freshIp(), "user-agent": UA }, redirect: "manual" }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    expect(await open()).toBe(302);
    await setHold(v.accountId, 1);
    expect(await open()).toBe(200);
    await setHold(v.accountId, 0);
    expect(await open()).toBe(302);
  });

  it("the ready push follows the hold", async () => {
    const v = await expiredVideo();
    expect(await pushReady(env, v.id, "https://rec.example")).toEqual({ pushed: false, reason: "not ready" });
    await setHold(v.accountId, 1);
    // Past the expiry check: no recorder is connected.
    expect((await pushReady(env, v.id, "https://rec.example")).reason).not.toBe("not ready");
  });
});

describe("admin_retention_hold", () => {
  it("is the operator's only: unlisted and unknown for everyone else, whatever their plan", async () => {
    const { admin, E } = await operator();
    const user = await seedAccount();
    expect(await toolNames(admin.key, E)).toContain(TOOL);
    for (const plan of ["free", "pro", "owner"]) {
      await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, user.accountId).run();
      expect(await toolNames(user.key, E)).not.toContain(TOOL);
      const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: TOOL, arguments: { account_id: user.accountId, hold: true } } }, user.key, E);
      expect(r.error).toEqual({ code: -32602, message: `Unknown tool: ${TOOL}` });
    }
    expect(await holdOf(user.accountId)).toBe(0);
  });

  it("sets and clears by account_id or username, idempotently, changing nothing else; admin_lookup shows it", async () => {
    const { admin, E } = await operator();
    const v = await expiredVideo();
    const bystander = await seedAccount(false);
    const name = `h${randomId(60).toLowerCase()}`.slice(0, 20);
    await env.DB.prepare("UPDATE accounts SET username = ? WHERE id = ?").bind(name, v.accountId).run();
    const snapshot = async () => {
      const { retention_hold: _h, ...acct } = (await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(v.accountId).first<any>())!;
      return { acct, rec: await env.DB.prepare("SELECT * FROM recordings WHERE id = ?").bind(v.id).first() };
    };
    const before = await snapshot();
    const flag = async () => (await mcp("admin_lookup", { account_id: v.accountId }, admin.key, E)).data.retention_hold;
    expect(await flag()).toBe(false);

    const on = await mcp(TOOL, { username: name.toUpperCase(), hold: true, note: "keep during migration" }, admin.key, E);
    expect(on.isError).toBe(false);
    expect(on.data).toMatchObject({ account_id: v.accountId, username: name, retention_hold: true, already: false, recordings_past_expiry: 1 });
    expect(on.data.message).toContain("is now on");
    expect(await holdOf(v.accountId)).toBe(1);
    expect(await flag()).toBe(true);
    const again = await mcp(TOOL, { account_id: v.accountId, hold: true }, admin.key, E);
    expect(again.data).toMatchObject({ retention_hold: true, already: true });
    expect(again.data.message).toContain("was already on");
    await cleanup(E);
    expect(await snapshot()).toEqual(before);

    const off = await mcp(TOOL, { account_id: v.accountId, hold: false }, admin.key, E);
    expect(off.data).toMatchObject({ retention_hold: false, already: false, recordings_past_expiry: 1 });
    expect(await flag()).toBe(false);
    const offAgain = await mcp(TOOL, { account_id: v.accountId, hold: false }, admin.key, E);
    expect(offAgain.data).toMatchObject({ retention_hold: false, already: true });
    expect(offAgain.data.message).toContain("was already off");
    // The tool itself deletes nothing: that is the next cleanup.
    expect(await snapshot()).toEqual(before);
    expect(await holdOf(bystander.accountId)).toBe(0);
  });

  it("an unknown account is NOT_FOUND; not exactly one account argument, or no hold, is INVALID_ARGUMENTS", async () => {
    const { admin, E } = await operator();
    const user = await seedAccount(false);
    expect((await mcp(TOOL, { account_id: randomId(128), hold: true }, admin.key, E)).data).toMatchObject({ error: "NOT_FOUND", message: "No account matches." });
    expect((await mcp(TOOL, { username: "nobody-here-xyz", hold: false }, admin.key, E)).data.error).toBe("NOT_FOUND");
    for (const args of [{ hold: true }, { account_id: user.accountId, username: "x", hold: true }, { account_id: user.accountId }, { account_id: user.accountId, hold: "yes" }]) {
      expect((await mcp(TOOL, args, admin.key, E)).data.error).toBe("INVALID_ARGUMENTS");
    }
    expect(await holdOf(user.accountId)).toBe(0);
  });
});
