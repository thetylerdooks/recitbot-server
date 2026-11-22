// get_recording_for_skill: own recordings by id or url, shared videos by url only, the watch page's privacy rules, and
// the include_video signed /m/<slug>/file link (the owner of a paid-tier video only).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { videoFileUrl } from "../src/share";
import { issueUploadToken, keyframeKey } from "../src/upload";
import { now } from "../src/util";
import { call, JPEG, mcp, ORIGIN, seedAccount, seedReady } from "./helpers";

const TRANSCRIPT = {
  segments: [
    { start: 0, end: 4.2, text: " Open the billing page. " },
    { start: 4.2, end: 9.876, text: "Click Export and pick CSV." },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function video(opts: { shared?: boolean; plan?: "pro" | "teams" | "owner" } = {}) {
  const a = await seedAccount();
  if (opts.plan) await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(opts.plan, a.accountId).run();
  const id = await seedReady(a.accountId, { transcript: TRANSCRIPT });
  await env.DB.prepare("UPDATE recordings SET title = 'Export invoices', description = 'Monthly export', duration_s = 10 WHERE id = ?").bind(id).run();
  if (opts.shared) expect((await mcp("share_recording", { recording_id: id }, a.key)).isError).toBe(false);
  const url = (await mcp("get_video", { recording_id: id }, a.key)).data.url as string;
  return { ...a, id, url };
}

const learn = (key: string, args: Record<string, unknown>) => mcp("get_recording_for_skill", args, key);

describe("get_recording_for_skill access", () => {
  it("the owner by recording_id: metadata, the full timestamped transcript, empty keyframes with a note, the instruction, no video URL", async () => {
    const v = await video();
    const r = await learn(v.key, { recording_id: v.id });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      source: "own",
      recording_id: v.id,
      title: "Export invoices",
      url: v.url,
      display: `[Export invoices](${v.url})`,
      description: "Monthly export",
      duration_s: 10,
      transcript_status: "ready",
      transcript: [
        { start: 0, end: 4.2, text: "Open the billing page." },
        { start: 4.2, end: 9.88, text: "Click Export and pick CSV." },
      ],
      keyframes: [],
    });
    expect(r.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.data.keyframes_note).toContain("no still frames");
    expect(r.data.instructions).toContain("reusable skill");
    expect(r.data.video).toBeUndefined();
    expect(JSON.stringify(r.data)).not.toContain("/file");
  });

  it("the owner by url, even while the video is private", async () => {
    const v = await video();
    const r = await learn(v.key, { url: v.url });
    expect(r.isError).toBe(false);
    expect(r.data.source).toBe("own");
  });

  it("another account by a shared url: allowed, without the recording_id", async () => {
    const v = await video({ shared: true });
    const other = await seedAccount(false);
    const r = await learn(other.key, { url: v.url });
    expect(r.isError).toBe(false);
    expect(r.data.source).toBe("shared_link");
    expect(r.data.recording_id).toBeUndefined();
    expect(r.data.title).toBe("Export invoices");
    expect(r.data.url).toBe(v.url);
    expect(r.data.transcript).toHaveLength(2);
  });

  it("another account's private video: NOT_FOUND by url, and by recording_id even once shared", async () => {
    const v = await video();
    const other = await seedAccount(false);
    const byUrl = await learn(other.key, { url: v.url });
    expect(byUrl.isError).toBe(true);
    expect(byUrl.data.error).toBe("NOT_FOUND");
    expect(byUrl.data.title).toBeUndefined();
    expect((await mcp("share_recording", { recording_id: v.id }, v.key)).isError).toBe(false);
    expect((await learn(other.key, { recording_id: v.id })).data.error).toBe("NOT_FOUND");
  });

  it("a revoked link: NOT_FOUND for others, and the new private link too", async () => {
    const v = await video({ shared: true });
    const other = await seedAccount(false);
    expect((await learn(other.key, { url: v.url })).isError).toBe(false);
    const revoked = await mcp("revoke_share", { recording_id: v.id }, v.key);
    expect(revoked.isError).toBe(false);
    expect((await learn(other.key, { url: v.url })).data.error).toBe("NOT_FOUND");
    expect((await learn(other.key, { url: revoked.data.share_url })).data.error).toBe("NOT_FOUND");
  });

  it("a shared video with a passcode: PASSCODE_PROTECTED for others, fine for the owner", async () => {
    const a = await seedAccount();
    const id = await seedReady(a.accountId, { transcript: TRANSCRIPT });
    const s = await mcp("share_recording", { recording_id: id, passcode: "s3cret" }, a.key);
    const other = await seedAccount(false);
    expect((await learn(other.key, { url: s.data.url })).data.error).toBe("PASSCODE_PROTECTED");
    expect((await learn(a.key, { url: s.data.url })).isError).toBe(false);
  });

  it("bad input: both or neither of recording_id and url, or a url that is not a video link", async () => {
    const v = await video();
    expect((await learn(v.key, {})).data.error).toBe("INVALID_ARGUMENTS");
    expect((await learn(v.key, { recording_id: v.id, url: v.url })).data.error).toBe("INVALID_ARGUMENTS");
    expect((await learn(v.key, { url: "https://example.com/hello" })).data.error).toBe("INVALID_ARGUMENTS");
    expect((await learn(v.key, { recording_id: v.id, max_keyframes: 13 })).data.error).toBe("INVALID_ARGUMENTS");
  });

  it("is listed with its schema", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const t = ((await res.json()) as any).result.tools.find((x: any) => x.name === "get_recording_for_skill");
    expect(t.description).toContain("learn this skill");
    expect(Object.keys(t.inputSchema.properties)).toEqual(["recording_id", "url", "include_video", "max_keyframes"]);
    expect(t.inputSchema.properties.max_keyframes).toMatchObject({ default: 6, minimum: 0, maximum: 12 });
    expect(t.inputSchema.properties.include_video).toMatchObject({ default: false });
  });
});

describe("get_recording_for_skill include_video", () => {
  const fileOf = async (key: string, args: Record<string, unknown>) => {
    const r = await learn(key, { ...args, include_video: true });
    expect(r.isError).toBe(false);
    return r.data.video as { url: string; expires_at: string; size_bytes: number; mime_type: string };
  };
  const fetchFile = (url: string, headers: Record<string, string> = {}) => call(url.slice(ORIGIN.length), { headers });
  const head = (url: string, headers: Record<string, string> = {}) => call(url.slice(ORIGIN.length), { method: "HEAD", headers });

  it("the owner on Pro, Teams or Owner: a 15-minute signed MP4 link that works without cookies (GET 200, Range 206)", async () => {
    for (const plan of ["pro", "teams", "owner"] as const) {
      const v = await video({ plan });
      const stored = new Uint8Array(await (await env.MEDIA.get(`v/${v.id}.mp4`))!.arrayBuffer());
      for (const args of [{ recording_id: v.id }, { url: v.url }]) {
        const f = await fileOf(v.key, args);
        expect(f.url).toMatch(new RegExp(`^${ORIGIN}/m/[A-Za-z0-9]+/file\\?e=\\d+&s=[A-Za-z0-9_-]+$`));
        expect(f.mime_type).toBe("video/mp4");
        expect(f.size_bytes).toBe(stored.length);
        const left = Date.parse(f.expires_at) / 1000 - Date.now() / 1000;
        expect(left).toBeGreaterThan(895);
        expect(left).toBeLessThanOrEqual(901);
        const res = await fetchFile(f.url);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(stored);
        const part = await fetchFile(f.url, { range: "bytes=0-9" });
        expect(part.status).toBe(206);
        expect((await part.arrayBuffer()).byteLength).toBe(10);
      }
    }
  });

  it("the owner on Free: video is UPGRADE_REQUIRED and no link anywhere; transcript and keyframes still come", async () => {
    for (const shared of [false, true]) {
      const v = await video({ shared });
      for (const args of [{ recording_id: v.id }, { url: v.url }]) {
        const r = await learn(v.key, { ...args, include_video: true });
        expect(r.isError).toBe(false);
        expect(r.data.video).toEqual({
          error: "UPGRADE_REQUIRED",
          message: "Downloading the video file is part of Recitbot Pro ($10/mo or $100/yr). Upgrade to Pro to download your videos; you can still watch it on its page.",
        });
        expect(r.data.transcript).toHaveLength(2);
        expect(r.data.keyframes).toEqual([]);
        expect(r.data.instructions).toContain("reusable skill");
        expect(JSON.stringify(r.data)).not.toContain("/m/");
      }
    }
  });

  it("another account's shared video, whatever either plan: VIDEO_FILE_NOT_SHARED, no link, no upgrade pitch", async () => {
    for (const plan of [undefined, "pro"] as const) {
      const v = await video({ shared: true, plan });
      for (const callerPlan of [null, "pro", "owner"]) {
        const other = await seedAccount(false);
        if (callerPlan) await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(callerPlan, other.accountId).run();
        const r = await learn(other.key, { url: v.url, include_video: true });
        expect(r.isError).toBe(false);
        expect(r.data.source).toBe("shared_link");
        expect(r.data.video).toEqual({
          error: "VIDEO_FILE_NOT_SHARED",
          message: "This video's file isn't available to share: only its owner can download it. You can still watch it on its page.",
        });
        expect(r.data.video.message).not.toMatch(/upgrade|pro\b/i);
        expect(r.data.transcript).toHaveLength(2);
        expect(JSON.stringify(r.data)).not.toContain("/m/");
      }
    }
  });

  it("a link to a Free video's file (minted directly, or before a downgrade): 403 on GET and HEAD, like a bad signature", async () => {
    const free = await video();
    const minted = await videoFileUrl(env, ORIGIN, free.id);
    for (const r of [await fetchFile(minted.url), await fetchFile(minted.url, { range: "bytes=0-9" }), await head(minted.url)]) {
      expect(r.status).toBe(403);
      expect(r.headers.get("content-type")).not.toBe("video/mp4");
      await r.arrayBuffer();
    }

    const pro = await video({ plan: "pro" });
    const f = await fileOf(pro.key, { recording_id: pro.id });
    expect((await head(f.url)).status).toBe(200);
    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(pro.accountId).run();
    expect((await fetchFile(f.url)).status).toBe(403);
    expect((await head(f.url)).status).toBe(403);
  });

  it("HEAD answers like GET without a body: 200 with the length, 206 for a Range, the same signature checks", async () => {
    const v = await video({ plan: "pro" });
    const stored = new Uint8Array(await (await env.MEDIA.get(`v/${v.id}.mp4`))!.arrayBuffer());
    const f = await fileOf(v.key, { recording_id: v.id });
    const pick = (r: Response) =>
      ["content-type", "content-length", "accept-ranges", "content-range", "content-disposition", "cache-control"].map((h) => r.headers.get(h));

    const full = await head(f.url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe(String(stored.length));
    expect(full.body).toBeNull();
    const got = await fetchFile(f.url);
    expect(pick(full)).toEqual(pick(got));
    await got.arrayBuffer();

    const part = await head(f.url, { range: "bytes=0-9" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-length")).toBe("10");
    expect(part.headers.get("content-range")).toBe(`bytes 0-9/${stored.length}`);
    expect(part.body).toBeNull();
    const gotPart = await fetchFile(f.url, { range: "bytes=0-9" });
    expect(pick(part)).toEqual(pick(gotPart));
    await gotPart.arrayBuffer();

    expect((await head(f.url.replace(/s=[^&]+/, "s=AAAA"))).status).toBe(403);
    expect((await head(f.url.replace(/[?].*$/, ""))).status).toBe(403);
    const real = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => real + 901_000);
    expect((await head(f.url)).status).toBe(403);
    vi.restoreAllMocks();
    expect((await mcp("revoke_share", { recording_id: v.id }, v.key)).isError).toBe(false);
    expect((await head(f.url)).status).toBe(404);
  });

  it("stops working after expiry", async () => {
    const v = await video({ plan: "pro" });
    const f = await fileOf(v.key, { recording_id: v.id });
    expect((await fetchFile(f.url)).status).toBe(200);
    const real = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => real + 901_000);
    expect((await fetchFile(f.url)).status).toBe(403);
  });

  it("never fits another recording, a changed expiry or signature, or a revoked video", async () => {
    const a = await video({ plan: "pro" });
    const b = await video({ plan: "pro" });
    const fa = await fileOf(a.key, { recording_id: a.id });
    const fb = await fileOf(b.key, { recording_id: b.id });
    const slugB = /\/m\/([A-Za-z0-9]+)\/file/.exec(fb.url)![1];
    expect((await fetchFile(fa.url.replace(/\/m\/[A-Za-z0-9]+\/file/, `/m/${slugB}/file`))).status).toBe(403);
    const e = Number(/e=(\d+)/.exec(fa.url)![1]);
    expect((await fetchFile(fa.url.replace(`e=${e}`, `e=${e - 1}`))).status).toBe(403);
    expect((await fetchFile(fa.url.replace(/s=[^&]+/, "s=AAAA"))).status).toBe(403);
    expect((await fetchFile(fa.url.replace(/[?].*$/, ""))).status).toBe(403);
    expect((await mcp("revoke_share", { recording_id: a.id }, a.key)).isError).toBe(false);
    expect((await fetchFile(fa.url)).status).toBe(404);
  });
});

describe("get_recording_for_skill keyframes", () => {
  /** The full tools/call result: structuredContent and the content blocks (images included). */
  async function learnRaw(key: string, args: Record<string, unknown>) {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_recording_for_skill", arguments: args } }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).result as { content: any[]; structuredContent: any; isError: boolean };
  }
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

  /** Stores frames the way the PUT route does (its own tests are keyframes.test.ts). */
  async function withFrames(v: { id: string }, frames: { n: number; t: number; fill: number }[]) {
    const token = await issueUploadToken(env, v.id, "dev", now() + 600);
    for (const f of frames) {
      const body = JPEG(300 + f.n, f.fill);
      const res = await call(`/upload/${v.id}/keyframes/${f.n}?t=${f.t}`, {
        method: "PUT",
        body,
        headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg", "content-length": String(body.length) },
      });
      expect(res.status).toBe(200);
    }
  }

  it("returns the stored frames in time order as base64 JPEG image content with their times; no note", async () => {
    const v = await video();
    // Sent out of time order and with a gap (slot 2 missing), as the recorder may.
    await withFrames(v, [
      { n: 3, t: 7500, fill: 3 },
      { n: 1, t: 833, fill: 1 },
      { n: 4, t: 65_000, fill: 4 },
    ]);
    const r = await learnRaw(v.key, { recording_id: v.id });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.keyframes).toEqual([
      { n: 1, t_ms: 833, at: "00:00" },
      { n: 3, t_ms: 7500, at: "00:07" },
      { n: 4, t_ms: 65000, at: "01:05" },
    ]);
    expect(r.structuredContent.keyframes_note).toBeUndefined();
    expect(r.content[0].type).toBe("text");
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    // No image data in the JSON: only in the image blocks.
    expect(r.content[0].text).not.toContain(b64(JPEG(301, 1)).slice(0, 40));
    expect(r.content.slice(1)).toEqual([
      { type: "text", text: "Keyframe 1 at 00:00 (t_ms 833)" },
      { type: "image", data: b64(JPEG(301, 1)), mimeType: "image/jpeg" },
      { type: "text", text: "Keyframe 3 at 00:07 (t_ms 7500)" },
      { type: "image", data: b64(JPEG(303, 3)), mimeType: "image/jpeg" },
      { type: "text", text: "Keyframe 4 at 01:05 (t_ms 65000)" },
      { type: "image", data: b64(JPEG(304, 4)), mimeType: "image/jpeg" },
    ]);
  });

  it("max_keyframes: at most that many, spread over the video (first and last kept); 0 = none and no note", async () => {
    const v = await video();
    await withFrames(v, [1, 2, 3, 4, 5, 6].map((n) => ({ n, t: n * 10_000, fill: n })));
    const pick = async (max: number) => (await learnRaw(v.key, { recording_id: v.id, max_keyframes: max })).structuredContent.keyframes.map((k: any) => k.n);
    expect(await pick(12)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await pick(6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await pick(3)).toEqual([1, 4, 6]);
    expect(await pick(2)).toEqual([1, 6]);
    expect(await pick(1)).toEqual([1]);
    const none = await learnRaw(v.key, { recording_id: v.id, max_keyframes: 0 });
    expect(none.structuredContent.keyframes).toEqual([]);
    expect(none.structuredContent.keyframes_note).toBeUndefined();
    expect(none.content).toHaveLength(1);
    expect((await learnRaw(v.key, { recording_id: v.id, max_keyframes: 3 })).content.filter((b) => b.type === "image")).toHaveLength(3);
  });

  it("a frame whose image is missing in R2 is left out; with none left the note is back", async () => {
    const v = await video();
    await withFrames(v, [{ n: 2, t: 1000, fill: 2 }]);
    await env.MEDIA.delete(keyframeKey(v.id, 2));
    const r = await learnRaw(v.key, { recording_id: v.id });
    expect(r.structuredContent.keyframes).toEqual([]);
    expect(r.structuredContent.keyframes_note).toContain("no still frames");
    expect(r.content).toHaveLength(1);
  });

  it("on every plan, for shared-link callers too; the access checks still come first", async () => {
    for (const plan of [null, "pro", "teams", "owner"]) {
      const v = await video({ shared: true });
      if (plan) await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, v.accountId).run();
      await withFrames(v, [{ n: 1, t: 500, fill: 9 }]);
      const other = await seedAccount(false);
      for (const [key, args] of [
        [v.key, { recording_id: v.id }],
        [other.key, { url: v.url }],
      ] as const) {
        const r = await learnRaw(key, args);
        expect(r.isError).toBe(false);
        expect(r.content.filter((b) => b.type === "image")).toHaveLength(1);
      }
      // Private again: another account gets NOT_FOUND and no image.
      expect((await mcp("revoke_share", { recording_id: v.id }, v.key)).isError).toBe(false);
      const newUrl = (await mcp("get_video", { recording_id: v.id }, v.key)).data.url as string;
      const denied = await learnRaw(other.key, { url: newUrl });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent.error).toBe("NOT_FOUND");
      expect(denied.content).toHaveLength(1);
    }
  });

  it("not ready: NOT_READY before any frame is read", async () => {
    const v = await video();
    await withFrames(v, [{ n: 1, t: 500, fill: 1 }]);
    await env.DB.prepare("UPDATE recordings SET status = 'transcribing' WHERE id = ?").bind(v.id).run();
    const r = await learnRaw(v.key, { recording_id: v.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toBe("NOT_READY");
    expect(r.content).toHaveLength(1);
  });
});
