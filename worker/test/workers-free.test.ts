// WORKERS_PLAN="free" (config.ts workers, docs/workers-free-plan.md): what changes on it, and that nothing does without it.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import { type Env, LIMITS } from "../src/env";
import { cleanup } from "../src/index";
import { readyThenTranscribe } from "../src/ready";
import { setPasscode } from "../src/share";
import { issueUploadToken } from "../src/upload";
import { now, pbkdf2, passcodeSalt, randomId } from "../src/util";
import { call, mcp, MP4, seedAccount, seedReady, withEnv } from "./helpers";

const FREE = withEnv({ WORKERS_PLAN: "free" });
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36" };
const statuses = async (ids: string[]) =>
  Promise.all(ids.map((id) => env.DB.prepare("SELECT status, transcript_status FROM recordings WHERE id = ?").bind(id).first<{ status: string; transcript_status: string }>()));

/** env whose D1 counts statements (each one in a batch too). */
function counting(e: Env): { e: Env; n: () => number } {
  let n = 0;
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          n++;
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { e: { ...e, DB } as Env, n: () => n };
}

describe("config", () => {
  it("unset or paid: the standard settings; free: the cheaper ones; anything else is an error", () => {
    const standard = { free: false, cleanupBatch: null, cleanupRecordings: 500, passcodeIterations: 100_000, searchScan: 200, readyBeforeTranscript: false };
    expect(getConfig(env).workers).toEqual(standard);
    expect(getConfig(withEnv({ WORKERS_PLAN: "paid" })).workers).toEqual(standard);
    expect(getConfig(withEnv({ WORKERS_PLAN: " Free " })).workers).toMatchObject({ free: true, readyBeforeTranscript: true });
    expect(getConfig(withEnv({ WORKERS_PLAN: "hobby" })).errors).toEqual(['WORKERS_PLAN must be "free" or "paid" (or unset).']);
  });
});

describe("queries per invocation", () => {
  it("list_videos and search_videos: the same queries for one video as for twenty", async () => {
    const { accountId, key } = await seedAccount();
    const ids = [await seedReady(accountId, { transcript: { segments: [{ start: 0, end: 1, text: "demo words" }] } })];
    const count = async (tool: string, args: Record<string, unknown>) => {
      const c = counting(FREE);
      const r = await mcp(tool, args, key, c.e);
      expect(r.isError).toBe(false);
      return { n: c.n(), rows: r.data.recordings as any[] };
    };
    await count("list_videos", {}); // the username and slug are assigned on first use
    const one = [await count("list_videos", { limit: 50 }), await count("search_videos", { query: "demo", limit: 50 })];
    for (let i = 1; i < 20; i++) ids.push(await seedReady(accountId, { transcript: { segments: [{ start: 0, end: 1, text: "demo words" }] } }));
    await count("list_videos", { limit: 50 });
    const many = [await count("list_videos", { limit: 50 }), await count("search_videos", { query: "demo", limit: 50 })];
    expect(many.map((m) => m.rows.length)).toEqual([20, 20]);
    expect(many.map((m) => m.n)).toEqual(one.map((m) => m.n));
    expect(Math.max(...many.map((m) => m.n))).toBeLessThan(15);
    // The same links as one video on its own.
    const single = (await mcp("get_video", { recording_id: ids[3] }, key)).data;
    const listed = many[0].rows.find((r) => r.recording_id === ids[3]);
    expect(listed).toMatchObject({ title: single.title, url: single.url, display: single.display });
    expect(new URL(listed.owner_url).pathname).toBe(new URL(single.owner_url).pathname);
  });

  it("a watch page, a listing and an idle cleanup stay under 50", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    await mcp("share", { recording_id: id }, key);
    const url = (await mcp("get_video", { recording_id: id }, key)).data.url as string;
    const page = counting(FREE);
    expect((await call(new URL(url).pathname, { headers: UA }, page.e)).status).toBe(200);
    expect(page.n()).toBeLessThan(30);
    const c = counting(FREE);
    await cleanup(c.e);
    expect(c.n()).toBeLessThan(50);
  });

  it("cleanup with more to do than fits: bounded per run, finished over the next runs", async () => {
    const { accountId } = await seedAccount();
    const t = now();
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push(await seedReady(accountId, { createdAt: t - 100_000, expiresAt: t - 10 }));
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare("INSERT INTO multipart_uploads (recording_id, kind, upload_id, created_at) VALUES (?, 'video', 'gone', ?)").bind(randomId(128), t - 90_000).run();
    }
    const left = async () => ({
      recs: (await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE account_id = ?").bind(accountId).first<{ n: number }>())!.n,
      mps: (await env.DB.prepare("SELECT count(*) AS n FROM multipart_uploads WHERE upload_id = 'gone'").first<{ n: number }>())!.n,
    });
    const c = counting(FREE);
    await cleanup(c.e, t);
    expect(c.n()).toBeLessThan(50);
    expect(await left()).toEqual({ recs: 5, mps: 5 });
    await cleanup(FREE, t);
    await cleanup(FREE, t);
    expect(await left()).toEqual({ recs: 0, mps: 0 });
  });

  it("without WORKERS_PLAN a run still does everything at once", async () => {
    const { accountId } = await seedAccount();
    const t = now();
    for (let i = 0; i < 120; i++) await seedReady(accountId, { createdAt: t - 100_000, expiresAt: t - 10 });
    expect((await cleanup(env, t)).deleted).toBe(120);
  });
});

describe("video passcodes", () => {
  it("each keeps the rounds it was made with: standard, free, and after a switch either way", async () => {
    const { accountId } = await seedAccount();
    const salts: string[] = [];
    for (const e of [env, FREE]) {
      const id = await seedReady(accountId);
      await env.DB.prepare("INSERT INTO shares (recording_id) VALUES (?)").bind(id).run();
      await setPasscode(e, id, "open sesame");
      const s = (await env.DB.prepare("SELECT passcode_salt AS salt, passcode_hash AS hash FROM shares WHERE recording_id = ?").bind(id).first<{ salt: string; hash: string }>())!;
      salts.push(s.salt);
      expect(await pbkdf2("open sesame", s.salt)).toBe(s.hash);
      expect(await pbkdf2("wrong", s.salt)).not.toBe(s.hash);
      await env.DB.prepare("UPDATE recordings SET shared_at = 1 WHERE id = ?").bind(id).run();
      const path = new URL((await mcp("get_video", { recording_id: id }, (await keyOf(accountId)))).data.url).pathname;
      for (const reader of [env, FREE]) {
        const post = (passcode: string) =>
          call(path, { method: "POST", headers: { ...UA, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ passcode }).toString() }, reader);
        expect((await post("open sesame")).status).toBe(200);
        expect((await post("nope")).status).toBe(401);
      }
    }
    expect(salts[0]).toMatch(/^[A-Za-z0-9]+$/);
    expect(salts[1]).toMatch(/^i10000\.[A-Za-z0-9]+$/);
    expect(passcodeSalt(100_000)).toMatch(/^[A-Za-z0-9]{22}$/);
  });
});

async function keyOf(accountId: string): Promise<string> {
  const { issueApiKey } = await import("../src/auth");
  return issueApiKey(env, accountId);
}

describe("ready before the transcript", () => {
  async function uploading() {
    const a = await seedAccount();
    const id = randomId(128);
    const t = now();
    await env.DB.prepare(
      "INSERT INTO recordings (id, account_id, device_id, title, status, max_seconds, created_at, expires_at, has_audio, transcript_status) VALUES (?, ?, ?, 'x', 'transcribing', 60, ?, ?, 1, 'none')",
    )
      .bind(id, a.accountId, a.deviceId, t, t + 86400)
      .run();
    return { ...a, id, t };
  }

  it("the video is watchable (transcript pending) before transcription starts, even if that never finishes", async () => {
    const { id } = await uploading();
    let seen: unknown;
    await expect(
      readyThenTranscribe(FREE, id, "https://example.test", async () => {
        seen = (await statuses([id]))[0];
        throw new Error("exceeded CPU");
      }),
    ).rejects.toThrow("exceeded CPU");
    expect(seen).toEqual({ status: "ready", transcript_status: "pending" });
    // Cleanup, once the recording's time is long past: the transcript isn't coming. Only with WORKERS_PLAN=free.
    const later = now() + 60 + LIMITS.uploadGraceSeconds + 10;
    await cleanup(env, later);
    expect((await statuses([id]))[0]).toEqual({ status: "ready", transcript_status: "pending" });
    await cleanup(FREE, later);
    expect((await statuses([id]))[0]).toEqual({ status: "ready", transcript_status: "unavailable" });
  });

  it("a whole upload on it ends ready with its transcript", async () => {
    const { accountId, id, deviceId, t } = await uploading();
    await env.DB.prepare("UPDATE recordings SET status = 'recording', has_audio = 0 WHERE id = ?").bind(id).run();
    const token = await issueUploadToken(env, id, deviceId!, t + 600);
    const auth = { authorization: `Bearer ${token}` };
    // Well over the first chunk, so the native pipe carries the rest; stored byte for byte.
    const body = MP4(3 * 1024 * 1024 + 17);
    const put = await call(`/upload/${id}/video`, { method: "PUT", headers: { ...auth, "content-type": "video/mp4", "content-length": String(body.length) }, body }, FREE);
    expect(put.status).toBe(200);
    const stored = new Uint8Array(await (await env.MEDIA.get(`v/${id}.mp4`))!.arrayBuffer());
    expect(stored.length).toBe(body.length);
    expect(stored.every((b, i) => b === body[i])).toBe(true);
    const done = await call(`/upload/${id}/complete`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ duration_s: 1 }) }, FREE);
    expect(done.status).toBe(200);
    expect((await statuses([id]))[0]).toEqual({ status: "ready", transcript_status: "none" });
    expect(accountId).toBeTruthy();
  });
});
