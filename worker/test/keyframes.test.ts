// Recording keyframes (recorder 0.6.1, "keyframes"): PUT /upload/<id>/keyframes/<n>?t=<ms>, stored in R2 and D1, and
// deleted with the recording.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import type { Env } from "../src/env";
import { LIMITS } from "../src/env";
import worker from "../src/index";
import { deleteRecordings } from "../src/mcp";
import { issueUploadToken, keyframeKey } from "../src/upload";
import { now, randomId } from "../src/util";
import { brokenGovernor, call, connectDevice, JPEG, mcp, seedAccount, seedReady, withEnv } from "./helpers";

async function recording(status = "transcribing") {
  const acct = await seedAccount();
  const id = randomId(128);
  await env.DB.prepare("INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at) VALUES (?, ?, ?, ?, 60, ?, ?)")
    .bind(id, acct.accountId, acct.deviceId!, status, now(), now() + 86400)
    .run();
  const token = await issueUploadToken(env, id, acct.deviceId!, now() + 600);
  return { ...acct, id, token };
}

function put(id: string, n: number | string, t: string | null, body: Uint8Array, token: string, opts: { type?: string; e?: Env; method?: string } = {}) {
  return call(
    `/upload/${id}/keyframes/${n}${t === null ? "" : `?t=${t}`}`,
    {
      method: opts.method ?? "PUT",
      body,
      headers: { authorization: `Bearer ${token}`, "content-type": opts.type ?? "image/jpeg", "content-length": String(body.length) },
    },
    opts.e,
  );
}

const rows = (id: string) =>
  env.DB.prepare("SELECT n, t_ms, bytes FROM recording_keyframes WHERE recording_id = ? ORDER BY n").bind(id).all<{ n: number; t_ms: number; bytes: number }>();

describe("PUT /upload/<id>/keyframes/<n>", () => {
  it("stores the JPEG at k/<id>/<n>.jpg and n, t in D1; a re-PUT of the same n replaces it", async () => {
    const r = await recording();
    const res = await put(r.id, 1, "5000", JPEG(2048), r.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 1, t_ms: 5000, bytes: 2048 });
    const obj = await env.MEDIA.get(keyframeKey(r.id, 1));
    expect(obj!.httpMetadata!.contentType).toBe("image/jpeg");
    expect(obj!.customMetadata).toEqual({ t_ms: "5000" });
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(JPEG(2048));
    expect((await rows(r.id)).results).toEqual([{ n: 1, t_ms: 5000, bytes: 2048 }]);

    expect((await put(r.id, 1, "6000", JPEG(1000, 9), r.token)).status).toBe(200);
    expect((await rows(r.id)).results).toEqual([{ n: 1, t_ms: 6000, bytes: 1000 }]);
    expect(new Uint8Array(await (await env.MEDIA.get(keyframeKey(r.id, 1)))!.arrayBuffer())).toEqual(JPEG(1000, 9));
  });

  it("accepted while uploading, transcribing or ready; 409 when starting, recording or failed", async () => {
    for (const s of ["uploading", "transcribing", "ready"]) {
      const r = await recording(s);
      expect((await put(r.id, 6, "0", JPEG(), r.token)).status).toBe(200);
    }
    for (const s of ["starting", "recording", "failed"]) {
      const r = await recording(s);
      const res = await put(r.id, 1, "1", JPEG(), r.token);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "BAD_STATE" });
      expect(await env.MEDIA.head(keyframeKey(r.id, 1))).toBeNull();
    }
  });

  it("401 for a missing, wrong, expired or other recording's token, and for an unknown recording", async () => {
    const r = await recording();
    const other = await recording();
    expect((await put(r.id, 1, "1", JPEG(), "")).status).toBe(401);
    expect((await put(r.id, 1, "1", JPEG(), other.token)).status).toBe(401);
    expect((await put(r.id, 1, "1", JPEG(), await issueUploadToken(env, r.id, "otherdevice", now() + 600))).status).toBe(401);
    expect((await put(r.id, 1, "1", JPEG(), await issueUploadToken(env, r.id, r.deviceId!, now() - 1))).status).toBe(401);
    expect((await put(randomId(128), 1, "1", JPEG(), r.token)).status).toBe(401);
    expect((await rows(r.id)).results).toEqual([]);
  });

  it("n: 1-6 (7 and up 413, 0 400; not a number: no route); t: a non-negative whole number of ms, else 400", async () => {
    const r = await recording();
    expect((await put(r.id, 7, "1", JPEG(), r.token)).status).toBe(413);
    expect((await put(r.id, 12, "1", JPEG(), r.token)).status).toBe(413);
    expect((await put(r.id, 0, "1", JPEG(), r.token)).status).toBe(400);
    expect((await put(r.id, "x", "1", JPEG(), r.token)).status).toBe(404);
    for (const t of [null, "", "-1", "1.5", "abc", "123456789"]) expect((await put(r.id, 2, t, JPEG(), r.token)).status).toBe(400);
    expect((await put(r.id, 2, "0", JPEG(), r.token)).status).toBe(200);
    expect((await put(r.id, 3, "99999999", JPEG(), r.token)).status).toBe(200);
  });

  it("415 for another content type or a body that is not a JPEG (magic FF D8 FF)", async () => {
    const r = await recording();
    expect((await put(r.id, 1, "1", JPEG(), r.token, { type: "image/png" })).status).toBe(415);
    const png = new Uint8Array(100).fill(1);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    const res = await put(r.id, 1, "1", png, r.token);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "BAD_MAGIC" });
    expect((await put(r.id, 1, "1", new Uint8Array([0xff, 0xd8]), r.token)).status).toBe(415);
    expect(await env.MEDIA.head(keyframeKey(r.id, 1))).toBeNull();
    expect((await rows(r.id)).results).toEqual([]);
  });

  it("at most 1 MiB: exactly 1 MiB is stored, one byte more is 413", async () => {
    const r = await recording();
    expect((await put(r.id, 1, "1", JPEG(LIMITS.keyframeMaxBytes), r.token)).status).toBe(200);
    expect((await put(r.id, 2, "1", JPEG(LIMITS.keyframeMaxBytes + 1), r.token)).status).toBe(413);
    expect(await env.MEDIA.head(keyframeKey(r.id, 2))).toBeNull();
  });

  it("governor down: 503 and nothing stored; paused service: 503; other methods: 404", async () => {
    const r = await recording();
    expect((await put(r.id, 1, "1", JPEG(), r.token, { e: withEnv({ GOVERNOR: brokenGovernor }) })).status).toBe(503);
    expect((await put(r.id, 1, "1", JPEG(), r.token, { e: withEnv({ SERVICE_MODE: "READ_ONLY" }) })).status).toBe(503);
    expect(await env.MEDIA.head(keyframeKey(r.id, 1))).toBeNull();
    const get = await call(`/upload/${r.id}/keyframes/1?t=1`, { headers: { authorization: `Bearer ${r.token}` } });
    expect(get.status).toBe(404);
  });

  it("a hello announcing keyframes (all 0.6.1 features) is accepted", async () => {
    expect(RECORDER_FEATURES).toContain("keyframes");
    const a = await seedAccount();
    const dev = await connectDevice(a.deviceToken!);
    dev.ws.send(JSON.stringify({ type: "hello", version: "0.6.1", features: [...RECORDER_FEATURES] }));
    let info = null;
    for (let i = 0; i < 50 && !info?.version; i++) {
      info = await deviceHub(env, a.accountId).recorderInfo(a.accountId);
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(info).toMatchObject({ version: "0.6.1" });
    expect(info!.features).toContain("keyframes");
    dev.ws.close();
  });
});

describe("keyframes are deleted with their recording", () => {
  async function withFrames() {
    const acct = await seedAccount();
    const id = await seedReady(acct.accountId);
    const token = await issueUploadToken(env, id, "dev", now() + 600);
    for (const n of [1, 3, 6]) expect((await put(id, n, String(n * 1000), JPEG(), token)).status).toBe(200);
    expect((await rows(id)).results).toHaveLength(3);
    return { ...acct, id };
  }
  const gone = async (id: string) => {
    for (let n = 1; n <= LIMITS.maxKeyframes; n++) expect(await env.MEDIA.head(keyframeKey(id, n))).toBeNull();
    expect((await rows(id)).results).toEqual([]);
  };

  it("by the delete tool", async () => {
    const r = await withFrames();
    expect((await mcp("delete", { recording_id: r.id }, r.key)).data).toEqual({ recording_id: r.id, deleted: true });
    await gone(r.id);
  });

  it("by the hourly cleanup of expired Free recordings", async () => {
    const r = await withFrames();
    await env.DB.prepare("UPDATE recordings SET expires_at = ? WHERE id = ?").bind(now() - 1, r.id).run();
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    await gone(r.id);
  });

  it("a batch past D1's 100 bound parameters and R2's 1000 keys per delete removes everything", async () => {
    const acct = await seedAccount();
    const ids: string[] = [];
    for (let i = 0; i < 130; i++) ids.push(await seedReady(acct.accountId)); // 130 ids, 130 x 8 keys = 1040
    const last = ids[ids.length - 1];
    const token = await issueUploadToken(env, last, "dev", now() + 600);
    expect((await put(last, 6, "1", JPEG(), token)).status).toBe(200);
    await deleteRecordings(env, ids);
    expect(await env.MEDIA.head(`v/${ids[0]}.mp4`)).toBeNull();
    expect(await env.MEDIA.head(`v/${last}.mp4`)).toBeNull();
    const left = await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE account_id = ?").bind(acct.accountId).first<{ n: number }>();
    expect(left!.n).toBe(0);
    await gone(last);
  });

  it("a still that lands after its recording was deleted is not kept", async () => {
    const acct = await seedAccount();
    const id = await seedReady(acct.accountId);
    const token = await issueUploadToken(env, id, "dev", now() + 600);
    // The recording disappears between the state check and the store (as if delete ran while the body streamed in).
    const real = env.DB.prepare.bind(env.DB);
    let inserted = false;
    const e = withEnv({
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop !== "prepare") return Reflect.get(target, prop);
          return (sql: string) => {
            if (sql.startsWith("INSERT INTO recording_keyframes")) inserted = true;
            else if (inserted && sql.startsWith("SELECT status FROM recordings")) {
              return real("SELECT status FROM recordings WHERE id = ? AND 0");
            }
            return real(sql);
          };
        },
      }) as D1Database,
    });
    const res = await put(id, 2, "1", JPEG(), token, { e });
    expect(res.status).toBe(409);
    await gone(id);
  });
});
