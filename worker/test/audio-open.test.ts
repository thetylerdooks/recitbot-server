// Recorder 0.4: system audio, webcam shape / percent size, the hello capability check and the auto-open "ready" push.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalCommand, deviceCommandKey, deviceHub, fitCommand, RECORDER_FEATURES } from "../src/device-hub";
import type { Env } from "../src/env";
import { finishRecording, pushReady, readyUrlAllowed } from "../src/ready";
import { issueUploadToken } from "../src/upload";
import { hmacHex, now } from "../src/util";
import { call, connectDevice, mcp, MP4, seedAccount, withEnv } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL = [...RECORDER_FEATURES];

/** A paired, connected recorder that announced `features` (none = a recorder older than 0.4). */
async function recorder(features: string[] | null = ALL, e: Env = env) {
  const acct = await seedAccount();
  const dev = await connectDevice(acct.deviceToken!);
  if (features) {
    dev.ws.send(JSON.stringify({ type: "hello", version: "0.4.0", features }));
    for (let i = 0; i < 50; i++) {
      const info = await deviceHub(e, acct.accountId).recorderInfo(acct.accountId);
      if (info?.version) break;
      await sleep(10);
    }
  }
  return { ...acct, ...dev };
}

async function signed(frames: any[], deviceId: string, type = "start") {
  for (let i = 0; i < 100 && !frames.some((x) => x.type === type); i++) await sleep(10);
  const f = frames.find((x) => x.type === type);
  expect(f, `no ${type} frame`).toBeTruthy();
  const { mac, ...rest } = f;
  expect(mac).toBe(await hmacHex(await deviceCommandKey(env, deviceId), canonicalCommand(rest)));
  return f;
}

const base = {
  type: "start",
  recording_id: "AAAAAAAAAAAAAAAAAAAAAA",
  max_seconds: 30,
  mic: false,
  nonce: 1731650000000,
  exp: 1731650060,
  account_id: "BBBBBBBBBBBBBBBBBBBBBB",
  device_id: "CCCCCCCCCCCCCCCCCCCCCC",
  upload_token: "1731651800.tok",
};

describe("signing (shared vectors with the recorder selftest)", () => {
  it("system audio, shape and percent size are signed blocks, each only when present", async () => {
    const canon = canonicalCommand({ ...base, webcam_size: 25, system_audio: true, webcam_shape: "rect" });
    expect(canon.endsWith("|1731651800.tok|cam|||25|sa|1|shape|rect")).toBe(true);
    expect(await hmacHex("test-device-secret", canon)).toBe("8e45f1383fe538cc386058f75c74e978b26829b996f637d51f838e17eb8e3c05");
    expect(canonicalCommand({ ...base, system_audio: false }).endsWith("|sa|0")).toBe(true);
    expect(canonicalCommand(base)).not.toMatch(/\|sa\||\|shape\||\|url\|/);
    const forms = new Set([
      canonicalCommand(base),
      canonicalCommand({ ...base, system_audio: true }),
      canonicalCommand({ ...base, system_audio: false }),
      canonicalCommand({ ...base, webcam_shape: "circle" }),
      canonicalCommand({ ...base, webcam_shape: "rect" }),
    ]);
    expect(forms.size).toBe(5);
  });

  it("the chunked-upload part size is a signed trailing block", async () => {
    const canon = canonicalCommand({ ...base, system_audio: true, upload_part_bytes: 33554432 });
    expect(canon.endsWith("|1731651800.tok|sa|1|mp|33554432")).toBe(true);
    expect(await hmacHex("test-device-secret", canon)).toBe("42de4f6cf95fd36b4eb8fdf59766dcabacb6091155c448a6b767f4477005a7a4");
    expect(canonicalCommand(base)).not.toMatch(/\|mp\|/);
  });

  // Same canonical form as the recorder selftests; their vectors use another host, so the HMAC differs.
  it("the ready frame signs its url", async () => {
    const ready = {
      ...base,
      type: "ready",
      max_seconds: 0,
      upload_token: "",
      url: "https://example.com/v/AAAAAAAAAAAAAAAAAAAAAA?e=1731736400&s=sig&o=own",
    };
    const canon = canonicalCommand(ready);
    expect(canon).toBe(
      "v1|ready|AAAAAAAAAAAAAAAAAAAAAA|0|0|1731650000000|1731650060|BBBBBBBBBBBBBBBBBBBBBB|CCCCCCCCCCCCCCCCCCCCCC||url|https://example.com/v/AAAAAAAAAAAAAAAAAAAAAA?e=1731736400&s=sig&o=own",
    );
    expect(await hmacHex("test-device-secret", canon)).toBe("30915dfca2f6742d7f2f32dc82b6101eb9c4c1a3c127fc9a6c69850df898922b");
    expect(canonicalCommand({ ...ready, url: ready.url.replace("example.com", "evil.example") })).not.toBe(canon);
  });

  it("fitCommand keeps only what the recorder announced", () => {
    const cmd = { type: "start" as const, recording_id: "x", system_audio: true, webcam_shape: "rect" as const, webcam_size: 30 };
    expect(fitCommand(cmd, ALL)).toEqual({ cmd, dropped: [] });
    const old = fitCommand(cmd, []);
    expect(old.dropped).toEqual(["system_audio", "webcam_shape", "webcam_pct"]);
    expect(old.cmd).toEqual({ type: "start", recording_id: "x" });
    // Presets are understood by every recorder.
    expect(fitCommand({ ...cmd, webcam_size: "large" as const }, []).cmd.webcam_size).toBe("large");
  });
});

describe("start_recording: system_audio", () => {
  it("defaults to on and is carried in the signed start command", async () => {
    const r = await recorder();
    const res = await mcp("start_recording", { max_seconds: 10 }, r.key);
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ mic: true, system_audio: true });
    expect(res.data.notes).toBeUndefined();
    expect(await signed(r.frames, r.deviceId!)).toMatchObject({ mic: true, system_audio: true });
    const row = await env.DB.prepare("SELECT system_audio, open_link FROM recordings WHERE id = ?").bind(res.data.recording_id).first();
    expect(row).toEqual({ system_audio: 1, open_link: 1 });
    r.ws.close();
  });

  it("'just my voice' = system_audio:false; 'mute' = both off; 'no mic' = mic only", async () => {
    for (const [args, want] of [
      [{ system_audio: false }, { mic: true, system_audio: false }],
      [{ mic: false, system_audio: false }, { mic: false, system_audio: false }],
      [{ mic: false }, { mic: false, system_audio: true }],
    ] as const) {
      const r = await recorder();
      const res = await mcp("start_recording", { max_seconds: 10, ...args }, r.key);
      expect(res.data).toMatchObject(want);
      expect(await signed(r.frames, r.deviceId!)).toMatchObject(want);
      r.ws.close();
    }
  });

  it("an older recorder still records; the result says system audio isn't supported there", async () => {
    const r = await recorder(null);
    const res = await mcp("start_recording", { max_seconds: 10, webcam: true, webcam_shape: "rect", webcam_size: 30 }, r.key);
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ status: "recording", mic: true, system_audio: false, recorder_version: "older than 0.4" });
    expect(res.data.unsupported).toEqual(["system_audio", "webcam_shape", "webcam_pct"]);
    expect(res.data.notes.join(" ")).toMatch(/System audio isn't supported on this recorder version/);
    // The frame is the old v1 form, so the old recorder's HMAC check passes.
    const f = await signed(r.frames, r.deviceId!);
    for (const k of ["system_audio", "webcam_shape", "webcam_size"]) expect(Object.keys(f)).not.toContain(k);
    expect(f.webcam).toBe(true);
    const row = await env.DB.prepare("SELECT system_audio FROM recordings WHERE id = ?").bind(res.data.recording_id).first();
    expect(row).toEqual({ system_audio: 0 });
    r.ws.close();
  });

  it("a recorder with only some features gets those", async () => {
    const r = await recorder(["system_audio"]);
    const res = await mcp("start_recording", { max_seconds: 10, webcam: true, webcam_shape: "circle" }, r.key);
    expect(res.data).toMatchObject({ system_audio: true, unsupported: ["webcam_shape"], recorder_version: "0.4.0" });
    const f = await signed(r.frames, r.deviceId!);
    expect(f.system_audio).toBe(true);
    expect(Object.keys(f)).not.toContain("webcam_shape");
    r.ws.close();
  });

  it("the description teaches the phrasing, and the defaults", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await res.json()) as any).result.tools as any[];
    const t = tools.find((x) => x.name === "start_recording");
    for (const s of ["system audio", "are both ON by default", "'no mic' = mic:false only", "'just my voice' = system_audio:false only"]) {
      expect(t.description).toContain(s);
    }
    expect(t.description).toMatch(/'no system audio'\/'no computer sound'\/'mute desktop audio'\//);
    expect(t.description).toContain("'mute'/'muted'/'no audio'/'silent' = mic:false AND system_audio:false");
    expect(t.description).toContain("'record my screen muted' -> {mic:false, system_audio:false}");
    expect(t.description).toContain("'square cam'/'rectangle'/'box' = webcam_shape:'rect'; 'round'/'circle' = webcam_shape:'circle'");
    expect(t.inputSchema.properties.system_audio.type).toBe("boolean");
    expect(t.inputSchema.properties.webcam_shape.enum).toEqual(["circle", "rect"]);
    expect(t.inputSchema.properties.open_link.type).toBe("boolean");
    expect(JSON.stringify(t.inputSchema.properties.webcam_size)).toMatch(/"small".*"medium".*"large"/);
  });
});

describe("start_recording: webcam shape and size", () => {
  it("shape and a percent size are signed; presets still work; webcam:false drops both", async () => {
    const r = await recorder();
    expect((await mcp("start_recording", { max_seconds: 10, webcam: true, webcam_shape: "rect", webcam_size: 25 }, r.key)).isError).toBe(false);
    expect(await signed(r.frames, r.deviceId!)).toMatchObject({ webcam: true, webcam_shape: "rect", webcam_size: 25 });
    r.ws.close();

    const b = await recorder();
    await mcp("start_recording", { max_seconds: 10, webcam: false, webcam_shape: "rect", webcam_size: "large" }, b.key);
    const f = await signed(b.frames, b.deviceId!);
    expect(Object.keys(f)).not.toContain("webcam_shape");
    expect(Object.keys(f)).not.toContain("webcam_size");
    b.ws.close();
  });

  it("rejects bad shapes and sizes", async () => {
    const { key } = await seedAccount();
    for (const bad of [{ webcam_shape: "square" }, { webcam_size: 0 }, { webcam_size: 101 }, { webcam_size: 12.5 }, { webcam_size: "huge" }]) {
      expect((await mcp("start_recording", bad, key)).data.error).toBe("INVALID_ARGUMENTS");
    }
  });
});

describe("hello frame", () => {
  it("stores version and features per connection; malformed hellos are ignored", async () => {
    const r = await recorder(["system_audio", "ready_push"]);
    expect(await deviceHub(env, r.accountId).recorderInfo(r.accountId)).toEqual({
      device_id: r.deviceId,
      version: "0.4.0",
      features: ["system_audio", "ready_push"],
    });
    r.ws.send(JSON.stringify({ type: "hello", version: "0.4.0 evil", features: [] }));
    r.ws.send(JSON.stringify({ type: "hello", version: "0.5.0", features: ["Bad Feature"] }));
    await sleep(50);
    expect((await deviceHub(env, r.accountId).recorderInfo(r.accountId))?.version).toBe("0.4.0");
    r.ws.close();
  });
});

// ---------------------------------------------------------------- ready push (auto-open)

const WAV = () => {
  const b = new Uint8Array(1044);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};

async function uploaded(r: Awaited<ReturnType<typeof recorder>>, args: Record<string, unknown> = {}, e: Env = env, body: object = { duration_s: 8 }) {
  const res = await mcp("start_recording", { max_seconds: 30, ...args }, r.key, e);
  expect(res.isError).toBe(false);
  const id: string = res.data.recording_id;
  const token = await issueUploadToken(env, id, r.deviceId!, now() + 600);
  const auth = { authorization: `Bearer ${token}` };
  const put = (part: string, b: Uint8Array, type: string) =>
    call(`/upload/${id}/${part}`, { method: "PUT", body: b, headers: { ...auth, "content-type": type, "content-length": String(b.length) } }, e);
  expect((await put("video", MP4(), "video/mp4")).status).toBe(200);
  expect((await put("audio", WAV(), "audio/wav")).status).toBe(200);
  expect((await call(`/upload/${id}/complete`, { method: "POST", body: JSON.stringify(body), headers: auth }, e)).status).toBe(200);
  return id;
}

describe("ready push", () => {
  it("once ready, the recorder that made it gets one signed ready frame with the video's /v/<id> link", async () => {
    const r = await recorder();
    const id = await uploaded(r, {}, env, { duration_s: 8, has_system_audio: true });
    const f = await signed(r.frames, r.deviceId!, "ready");
    expect(f.recording_id).toBe(id);
    const u = new URL(f.url);
    expect(u.origin).toBe("https://rec.example");
    // /v/<id> (shipped recorders open nothing else) with the owner token: the owner_url that makes this browser the
    // video's owner (owner-link.test.ts), and it passes the allowlist the recorder applies too.
    expect(u.pathname).toBe(`/v/${id}`);
    expect(u.search).toMatch(/^\?ot=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(readyUrlAllowed(f.url, "https://rec.example", id)).toBe(true);
    const v = await mcp("get_video", { recording_id: id }, r.key);
    expect(v.data).toMatchObject({ status: "ready", has_system_audio: true });
    // Never twice, whatever calls it again.
    expect(await pushReady(env, id, "https://rec.example")).toEqual({ pushed: false, reason: "already pushed" });
    await sleep(50);
    expect(r.frames.filter((x) => x.type === "ready")).toHaveLength(1);
    // list shows has_system_audio too.
    expect((await mcp("list_videos", { limit: 1 }, r.key)).data.recordings[0]).toMatchObject({ recording_id: id, has_system_audio: true });
    r.ws.close();
  });

  it("uses PUBLIC_BASE_URL's host for the link", async () => {
    const e = withEnv({ PUBLIC_BASE_URL: "https://example.test" });
    const r = await recorder(ALL, e);
    const id = await uploaded(r, {}, e);
    const f = await signed(r.frames, r.deviceId!, "ready");
    expect(new URL(f.url).host).toBe("example.test");
    expect(readyUrlAllowed(f.url, "https://example.test", id)).toBe(true);
    r.ws.close();
  });

  it("open_link:false, an older recorder, or a failed/expired recording: nothing is pushed", async () => {
    const off = await recorder();
    const id1 = await uploaded(off, { open_link: false });
    await sleep(100);
    expect(off.frames.some((x) => x.type === "ready")).toBe(false);
    expect(await pushReady(env, id1, "https://rec.example")).toEqual({ pushed: false, reason: "open_link off" });
    off.ws.close();

    const old = await recorder(["system_audio"]);
    const id2 = await uploaded(old);
    await sleep(100);
    expect(old.frames.some((x) => x.type === "ready")).toBe(false);
    expect((await mcp("get_video", { recording_id: id2 }, old.key)).data.status).toBe("ready");
    old.ws.close();

    const f = await recorder();
    const res = await mcp("start_recording", { max_seconds: 10 }, f.key);
    const failed = res.data.recording_id;
    await env.DB.prepare("UPDATE recordings SET status = 'failed' WHERE id = ?").bind(failed).run();
    expect(await pushReady(env, failed, "https://rec.example")).toEqual({ pushed: false, reason: "not ready" });
    const exp = await mcp("start_recording", { max_seconds: 10 }, f.key);
    await env.DB.prepare("UPDATE recordings SET status = 'ready', expires_at = ? WHERE id = ?").bind(now() - 1, exp.data.recording_id).run();
    expect(await pushReady(env, exp.data.recording_id, "https://rec.example")).toEqual({ pushed: false, reason: "not ready" });
    await sleep(50);
    expect(f.frames.some((x) => x.type === "ready")).toBe(false);
    f.ws.close();
  });

  it("goes only to the device that recorded it, never replayed after a reconnect", async () => {
    const r = await recorder();
    const res = await mcp("start_recording", { max_seconds: 10 }, r.key);
    const id = res.data.recording_id;
    await env.DB.prepare("UPDATE recordings SET status = 'ready', device_id = 'someotherdevice' WHERE id = ?").bind(id).run();
    expect(await pushReady(env, id, "https://rec.example")).toEqual({ pushed: false, reason: "offline" });
    // Claimed even though it could not be delivered: a later reconnect of any device never gets it.
    await env.DB.prepare("UPDATE recordings SET device_id = ? WHERE id = ?").bind(r.deviceId, id).run();
    expect(await pushReady(env, id, "https://rec.example")).toEqual({ pushed: false, reason: "already pushed" });
    r.ws.close();
    const again = await connectDevice(r.deviceToken!);
    again.ws.send(JSON.stringify({ type: "hello", version: "0.4.0", features: ALL }));
    await sleep(100);
    expect(again.frames.some((x) => x.type === "ready")).toBe(false);
    again.ws.close();
  });

  it("a slow transcript does not hold the push: ready (transcript pending) after the wait, transcript later", async () => {
    const r = await recorder();
    const res = await mcp("start_recording", { max_seconds: 10 }, r.key);
    const id = res.data.recording_id;
    await env.DB.prepare("UPDATE recordings SET status = 'transcribing' WHERE id = ?").bind(id).run();
    let finish!: () => void;
    const slow = new Promise<void>((done) => (finish = done)).then(async () => {
      await env.DB.prepare("UPDATE recordings SET status = 'ready', transcript_status = 'ready' WHERE id = ?").bind(id).run();
    });
    const run = finishRecording(env, id, "https://rec.example", slow, 30);
    const f = await signed(r.frames, r.deviceId!, "ready");
    expect(f.recording_id).toBe(id);
    expect((await mcp("get_video", { recording_id: id }, r.key)).data).toMatchObject({ status: "ready", transcript_status: "pending" });
    finish();
    await run;
    expect((await mcp("get_video", { recording_id: id }, r.key)).data.transcript_status).toBe("ready");
    r.ws.close();
  });
});

describe("ready link allowlist", () => {
  const id = "AAAAAAAAAAAAAAAAAAAAAA";
  it("only https on the public host, viewer path of this recording", () => {
    const ok = `https://example.test/v/${id}?e=1&s=a&o=b`;
    expect(readyUrlAllowed(ok, "https://example.test", id)).toBe(true);
    expect(readyUrlAllowed(`https://my-recorder.example.workers.dev/v/${id}?e=1`, "https://my-recorder.example.workers.dev", id)).toBe(true);
    for (const bad of [
      `http://example.test/v/${id}?e=1`,
      `https://evil.example/v/${id}?e=1`,
      `https://example.test.evil.example/v/${id}`,
      `https://user:pw@example.test/v/${id}`,
      `https://example.test:8443/v/${id}`,
      `https://example.test/v/BBBBBBBBBBBBBBBBBBBBBB`,
      `https://example.test/m/${id}`,
      `https://example.test/v/${id}?ot=a b`,
      `https://example.test/v/${id}?ot=a%2Fb`,
      `https://example.test/v/${id}?ot=ab#x`,
      `javascript:alert(1)`,
      `file:///C:/Windows/System32/calc.exe`,
      "not a url",
    ]) {
      expect(readyUrlAllowed(bad, "https://example.test", id), bad).toBe(false);
    }
    // http only for a loopback dev server.
    expect(readyUrlAllowed(`http://127.0.0.1:8787/v/${id}`, "http://127.0.0.1:8787", id)).toBe(true);
  });
});
