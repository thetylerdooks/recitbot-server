// update_video: owner-set title and description (validateVideoMeta, setVideoMeta), description in every video listing,
// and search over title, description and transcript.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS, PLAYBOOK_TEXT } from "../src/playbook";
import { now } from "../src/util";
import { setVideoMeta, validateVideoMeta, VideoMetaError } from "../src/video-meta";
import { videoTitle } from "../src/video-url";
import { call, mcp, ORIGIN, seedAccount, seedReady, withEnv, videoLinkOf } from "./helpers";

const NAME_RULE =
  "Right after a recording is ready, call update_video to set a clear, specific title (and a short description if the " +
  "user gave one), then show the video as a Markdown link.";

const seg = (text: string) => ({ segments: [{ start: 0, end: 1, text }] });

async function tools(): Promise<{ name: string; description: string }[]> {
  const res = await call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return ((await res.json()) as any).result.tools;
}

describe("validateVideoMeta", () => {
  it("title: one line, up to 120 code points after stripping control characters and trimming; empty resets it (null)", () => {
    expect(validateVideoMeta({ title: "x".repeat(120) })).toEqual({ ok: true, title: "x".repeat(120) });
    expect(validateVideoMeta({ title: "x".repeat(121) }).ok).toBe(false);
    expect(validateVideoMeta({ title: "🎬".repeat(120) })).toEqual({ ok: true, title: "🎬".repeat(120) });
    expect(validateVideoMeta({ title: "🎬".repeat(121) }).ok).toBe(false);
    expect(validateVideoMeta({ title: `  ${"x".repeat(120)}\n` }).ok).toBe(true);
    expect(validateVideoMeta({ title: "" })).toEqual({ ok: true, title: null });
    expect(validateVideoMeta({ title: "   \t\n" })).toEqual({ ok: true, title: null });
    expect(validateVideoMeta({ title: "a\u0007b\n" })).toEqual({ ok: true, title: "ab" });
    expect(validateVideoMeta({ title: " Q3\tplan\r\n " })).toEqual({ ok: true, title: "Q3plan" });
  });

  it("description: 0-280 code points; empty or blank clears it (null)", () => {
    expect(validateVideoMeta({ description: "d".repeat(280) })).toEqual({ ok: true, description: "d".repeat(280) });
    expect(validateVideoMeta({ description: "d".repeat(281) }).ok).toBe(false);
    expect(validateVideoMeta({ description: "😀".repeat(280) }).ok).toBe(true);
    expect(validateVideoMeta({ description: "" })).toEqual({ ok: true, description: null });
    expect(validateVideoMeta({ description: "   " })).toEqual({ ok: true, description: null });
    expect(validateVideoMeta({ description: "line one\nline two" })).toEqual({ ok: true, description: "line one\nline two" });
  });

  it("description keeps line breaks: CRLF to LF, at most 2 blank lines in a row, other control characters removed", () => {
    expect(validateVideoMeta({ description: " a\r\nb\rc\u0007\td \n" })).toEqual({ ok: true, description: "a\nb\ncd" });
    expect(validateVideoMeta({ description: "a\n\nb\n\n\nc" })).toEqual({ ok: true, description: "a\n\nb\n\n\nc" });
    expect(validateVideoMeta({ description: "a\n\n\n\n\n\nb" })).toEqual({ ok: true, description: "a\n\n\nb" });
    expect(validateVideoMeta({ description: "a  \n \n \n \n \nb" })).toEqual({ ok: true, description: "a\n\n\nb" });
    expect(validateVideoMeta({ description: "\r\n\r\n" })).toEqual({ ok: true, description: null });
    // the length cap counts the kept newlines
    expect(validateVideoMeta({ description: "d\n".repeat(140) })).toEqual({ ok: true, description: "d\n".repeat(140).trim() });
    expect(validateVideoMeta({ description: "d\n".repeat(141).trim() }).ok).toBe(false);
    expect(validateVideoMeta({ title: "T", description: "D" })).toEqual({ ok: true, title: "T", description: "D" });
  });

  it("rejects non-strings and an empty request", () => {
    for (const bad of [1, null, true, ["x"], { a: 1 }]) {
      expect(validateVideoMeta({ title: bad }).ok, String(bad)).toBe(false);
      expect(validateVideoMeta({ description: bad }).ok, String(bad)).toBe(false);
    }
    const none = validateVideoMeta({});
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/title|description/);
  });
});

describe("setVideoMeta", () => {
  it("updates only the given columns of an owned recording and returns the row", async () => {
    const { accountId } = await seedAccount();
    const id = await seedReady(accountId);
    const a = await setVideoMeta(env, accountId, id, { description: "first" });
    expect(a).toMatchObject({ id, title: "Demo", description: "first" });
    const b = await setVideoMeta(env, accountId, id, { title: " New\u0000 name " });
    expect(b).toMatchObject({ id, title: "New name", description: "first" });
    const c = await setVideoMeta(env, accountId, id, { description: "" });
    expect(c).toMatchObject({ title: "New name", description: null });
  });

  it("returns null for another account's video and for an unknown id; throws on invalid input", async () => {
    const owner = await seedAccount();
    const other = await seedAccount();
    const id = await seedReady(owner.accountId);
    expect(await setVideoMeta(env, other.accountId, id, { title: "Hijack" })).toBeNull();
    expect(await setVideoMeta(env, owner.accountId, "A".repeat(22), { title: "Nope" })).toBeNull();
    await expect(setVideoMeta(env, owner.accountId, id, {})).rejects.toBeInstanceOf(VideoMetaError);
    await expect(setVideoMeta(env, owner.accountId, id, { title: 5 })).rejects.toBeInstanceOf(VideoMetaError);
    const row = await env.DB.prepare("SELECT title FROM recordings WHERE id = ?").bind(id).first<{ title: string }>();
    expect(row!.title).toBe("Demo");
  });
});

describe("update_video", () => {
  it("returns the video like get_video, with url and display using the new title", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const r = await mcp("update_video", { video_id: id, title: "Q3 [pricing] walkthrough", description: "For the sales team" }, key);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ recording_id: id, status: "ready", title: "Q3 [pricing] walkthrough", description: "For the sales team" });
    expect(r.data.url).toBe(await videoLinkOf(id));
    expect(r.data.display).toBe(`[Q3 \\[pricing\\] walkthrough](${r.data.url})`);
    const got = (await mcp("get_video", { recording_id: id }, key)).data;
    expect(Object.keys(r.data).sort()).toEqual(Object.keys(got).sort());
    expect(got).toMatchObject({ title: r.data.title, description: r.data.description, display: r.data.display });
    // recording_id is accepted as an alias
    expect((await mcp("update_video", { recording_id: id, description: "" }, key)).data.description).toBeNull();
  });

  it("validation errors are INVALID_ARGUMENTS", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    for (const args of [{ video_id: id }, { video_id: id, title: "x".repeat(121) }, { video_id: id, description: "d".repeat(281) }, { video_id: id, title: 7 }, { title: "x" }]) {
      const r = await mcp("update_video", args, key);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.data.error).toBe("INVALID_ARGUMENTS");
    }
  });

  it("an empty or blank title resets it to the default a new recording gets", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { created_at } = (await env.DB.prepare("SELECT created_at FROM recordings WHERE id = ?").bind(id).first<{ created_at: number }>())!;
    const untitled = videoTitle({ title: null, created_at });
    expect(untitled).toMatch(/^Recording \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    for (const title of ["", "  \n "]) {
      await mcp("update_video", { video_id: id, title: "Named" }, key);
      const r = await mcp("update_video", { video_id: id, title }, key);
      expect(r.isError, JSON.stringify(title)).toBe(false);
      expect(r.data.title).toBe(untitled);
      const row = await env.DB.prepare("SELECT title FROM recordings WHERE id = ?").bind(id).first<{ title: string | null }>();
      expect(row!.title).toBeNull();
    }
  });

  it("is owner-only: another account's video is not found, the same error as get_video", async () => {
    const owner = await seedAccount();
    const other = await seedAccount();
    const id = await seedReady(owner.accountId);
    const r = await mcp("update_video", { video_id: id, title: "Hijack" }, other.key);
    const g = await mcp("get_video", { recording_id: id }, other.key);
    expect(r.isError).toBe(true);
    expect(r.data).toEqual(g.data);
    expect(r.data.error).toBe("NOT_FOUND");
    expect((await mcp("get_video", { recording_id: id }, owner.key)).data.title).toBe("Demo");
  });

  it("READ_ONLY -> SERVICE_PAUSED (OFF -> 503), nothing written", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const ro = await mcp("update_video", { video_id: id, title: "Paused" }, key, withEnv({ SERVICE_MODE: "READ_ONLY" }));
    expect(ro.isError).toBe(true);
    expect(ro.data.error).toBe("SERVICE_PAUSED");
    // OFF is refused before any tool runs.
    expect((await mcp("update_video", { video_id: id, title: "Paused" }, key, withEnv({ SERVICE_MODE: "OFF" }))).status).toBe(503);
    expect((await mcp("get_video", { recording_id: id }, key)).data.title).toBe("Demo");
  });

  it("get_video, list_videos, list and search_videos return description: null by default, the value after update", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId, { transcript: seg("budget review") });
    const all = async () => [
      (await mcp("get_video", { recording_id: id }, key)).data,
      (await mcp("list_videos", {}, key)).data.recordings[0],
      (await mcp("list", {}, key)).data.recordings[0],
      (await mcp("search_videos", { query: "budget" }, key)).data.recordings[0],
    ];
    for (const v of await all()) {
      expect(v).toHaveProperty("description", null);
      expect(v.title).toBe("Demo");
    }
    await mcp("update_video", { video_id: id, title: "Budget review", description: "Numbers for Q4" }, key);
    for (const v of await all()) {
      expect(v).toMatchObject({ recording_id: id, title: "Budget review", description: "Numbers for Q4" });
      expect(v.display).toBe(`[Budget review](${v.url})`);
    }
  });
});

describe("search_videos over title, description and transcript", () => {
  it("ranks title > description > transcript-only, ties newest first, with matched_in", async () => {
    const { accountId, key } = await seedAccount();
    const t = now();
    const vid = async (title: string, createdAt: number, description: string | null, transcript?: string) => {
      const id = await seedReady(accountId, { createdAt, transcript: transcript ? seg(transcript) : undefined });
      await env.DB.prepare("UPDATE recordings SET title = ?, description = ? WHERE id = ?").bind(title, description, id).run();
      return id;
    };
    const transcriptNew = await vid("Weekly sync", t - 10, null, "the ROADMAP is due");
    const descOld = await vid("Planning", t - 500, "Roadmap for 2027", undefined);
    const descNew = await vid("Planning", t - 400, "Roadmap for 2027", undefined);
    const titleOld = await vid("Roadmap", t - 900, null);
    const titleNew = await vid("Roadmap", t - 800, null);
    await vid("Unrelated", t - 5, "nothing here", "nothing at all");
    const r = await mcp("search_videos", { query: "roadmap" }, key);
    expect(r.isError).toBe(false);
    expect(r.data.recordings.map((x: any) => x.recording_id)).toEqual([titleNew, titleOld, descNew, descOld, transcriptNew]);
    expect(r.data.recordings.map((x: any) => x.matched_in)).toEqual(["title", "title", "description", "description", "transcript"]);
    const last = r.data.recordings[4];
    expect(last).toMatchObject({ matched_in: "transcript", views: 0, unique_views: 0, description: null, title: "Weekly sync" });
    expect(last.display).toBe(`[Weekly sync](${last.url})`);
    expect(last).not.toHaveProperty("score");
  });

  it("is case-insensitive and finds description-only matches", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    await mcp("update_video", { video_id: id, description: "Onboarding for ACME Corp" }, key);
    const [hit] = (await mcp("search_videos", { query: "acme" }, key)).data.recordings;
    expect(hit).toMatchObject({ recording_id: id, matched_in: "description" });
  });

  it("wildcards match nothing: '%', '_' and '\\' are not patterns", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId, { transcript: seg("hello world") });
    await env.DB.prepare("UPDATE recordings SET description = 'some text' WHERE id = ?").bind(id).run();
    for (const query of ["%", "_", "%%", "\\", "%_%"]) {
      const r = await mcp("search_videos", { query }, key);
      expect(r.isError, query).toBe(false);
      expect(r.data.recordings, query).toEqual([]);
    }
  });
});

describe("naming guidance", () => {
  it("MCP_INSTRUCTIONS, the playbook and start/stop_recording/get_video carry the sentence", async () => {
    expect(MCP_INSTRUCTIONS).toContain(NAME_RULE);
    expect(PLAYBOOK_TEXT).toContain(NAME_RULE);
    expect(PLAYBOOK_TEXT).toContain("When the user names or describes a recording, call update_video.");
    const list = await tools();
    for (const name of ["start_recording", "stop_recording", "get_video"]) {
      expect(list.find((t) => t.name === name)!.description, name).toContain(NAME_RULE);
    }
    const uv = list.find((t) => t.name === "update_video")!.description;
    expect(uv).toContain(
      "Set or change a recording's title and/or short description (<=280 chars; empty string clears it). When the user names or describes a recording, call update_video.",
    );
    expect(uv).toContain("Markdown link");
  });
});
