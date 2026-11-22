// Canonical video links: every video a tool returns carries title, url (<origin>/<username>/v/<slug>) and display.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PLAYBOOK_TEXT } from "../src/playbook";
import { videoUrl } from "../src/share";
import { videoLink, videoTitle } from "../src/video-url";
import { call, mcp, ORIGIN, seedAccount, seedReady, withEnv } from "./helpers";

const RULE =
  "Always show each video as a clickable Markdown link using its title, e.g. [Q3 walkthrough](https://videos.example.com/alex/v/k7Qm2xR4). " +
  "Never show a bare video id or a bare URL.";
const VIDEO_TOOLS = ["get_video", "list_videos", "list", "search_videos", "get_video_stats", "share", "start_recording", "stop_recording"];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Checks one video object against the canonical form: the video's one URL, <origin>/<username>/v/<slug>. */
async function expectLinked(v: any, accountId: string, id: string, title: string, origin = ORIGIN) {
  expect(v.url).toMatch(new RegExp(`^${esc(origin)}/[a-z0-9-]+/v/[A-Za-z0-9]{14}$`));
  expect(v.url).toBe(await videoUrl(env, origin, id, accountId));
  expect(v.title).toBe(title);
  expect(v.display).toBe(`[${v.title}](${v.url})`);
  if ("share_url" in v) expect(v.share_url).toBe(v.url);
}

async function rpc(method: string) {
  const res = await call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { protocolVersion: "2025-06-18" } }),
  });
  return ((await res.json()) as any).result;
}

describe("video links in tool results", () => {
  it("get_video, list_videos, list, search_videos, get_video_stats, share and stop_recording all return the link", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId, { transcript: { segments: [{ start: 0, end: 1, text: "pricing demo" }] } });

    const got = (await mcp("get_video", { recording_id: id }, key)).data;
    expect(got.status).toBe("ready");
    await expectLinked(got, accountId, id, "Demo");
    expect(got.share_url).toBe(got.url);
    expect(got.visibility).toBe("private");
    expect(got.expires_at).toBeGreaterThan(0);

    for (const tool of ["list_videos", "list"]) {
      const [v] = (await mcp(tool, {}, key)).data.recordings;
      expect(v.recording_id).toBe(id);
      await expectLinked(v, accountId, id, "Demo");
    }
    const [hit] = (await mcp("search_videos", { query: "pricing" }, key)).data.recordings;
    await expectLinked(hit, accountId, id, "Demo");
    await expectLinked((await mcp("get_video_stats", { recording_id: id }, key)).data, accountId, id, "Demo");

    const shared = (await mcp("share", { recording_id: id }, key)).data;
    await expectLinked(shared, accountId, id, "Demo");
    expect(shared.share_url).toBe(shared.url);
    expect(shared.visibility).toBe("public");

    const stopped = (await mcp("stop_recording", { recording_id: id }, key)).data;
    expect(stopped.status).toBe("ready");
    await expectLinked(stopped, accountId, id, "Demo");
  });

  it("uses PUBLIC_BASE_URL for the origin", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const v = (await mcp("get_video", { recording_id: id }, key, withEnv({ PUBLIC_BASE_URL: "https://example.test" }))).data;
    await expectLinked(v, accountId, id, "Demo", "https://example.test");
  });

  it("untitled videos are called Recording <date>; titles are escaped in display", async () => {
    const { accountId, key } = await seedAccount();
    const untitled = await seedReady(accountId);
    await env.DB.prepare("UPDATE recordings SET title = NULL, created_at = ? WHERE id = ?").bind(Date.UTC(2026, 10, 15, 9, 5) / 1000, untitled).run();
    const tricky = await seedReady(accountId);
    await env.DB.prepare("UPDATE recordings SET title = ? WHERE id = ?").bind("  a]b(c) [x]\\y\nz  ", tricky).run();

    const u = (await mcp("get_video", { recording_id: untitled }, key)).data;
    expect(u.title).toBe("Recording 2026-11-15 09:05 UTC");
    expect(u.display).toBe(`[Recording 2026-11-15 09:05 UTC](${u.url})`);

    const t = (await mcp("get_video_stats", { recording_id: tricky }, key)).data;
    expect(t.title).toBe("a]b(c) [x]\\y\nz");
    expect(t.display).toBe(`[a\\]b\\(c\\) \\[x\\]\\\\y z](${t.url})`);
  });

  it("videoTitle and videoLink", () => {
    expect(videoTitle({ title: "   ", created_at: 0 })).toBe("Recording 1970-01-01 00:00 UTC");
    expect(videoTitle({ title: " Q3 walkthrough ", created_at: 0 })).toBe("Q3 walkthrough");
    expect(videoLink("a]b(c)", "https://x/u/v/s")).toBe("[a\\]b\\(c\\)](https://x/u/v/s)");
    expect(videoLink("one\r\ntwo", "https://x/u/v/s")).toBe("[one two](https://x/u/v/s)");
  });
});

describe("the display rule reaches the bot", () => {
  it("initialize instructions carry the rule verbatim", async () => {
    expect((await rpc("initialize")).instructions).toContain(RULE);
  });

  it("every video tool description asks for the Markdown link", async () => {
    const tools = (await rpc("tools/list")).tools as { name: string; description: string }[];
    for (const name of VIDEO_TOOLS) expect(tools.find((t) => t.name === name)!.description, name).toContain("Markdown link");
  });

  it("get_latest returns playbook 2026.11.22-1 with the rule", async () => {
    const { key } = await seedAccount(false);
    const p = (await mcp("get_latest", {}, key)).data.playbook;
    expect(p.version).toBe("2026.11.22-1");
    expect(p.text).toContain(RULE);
    expect(PLAYBOOK_TEXT).toContain("`display`");
  });
});
