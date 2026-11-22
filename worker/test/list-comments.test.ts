// list_comments: owner-only comments on a shared video, with Markdown links. The rows are mocked through mcp.ts
// commentDeps; the real comments.ts listComments decides ownership (comments.test.ts covers its rows).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommentRow, listComments } from "../src/comments";
import { commentDeps } from "../src/mcp";
import { COMMENTS_RULE, MCP_INSTRUCTIONS, PLAYBOOK_TEXT } from "../src/playbook";
import { call, mcp, ORIGIN, seedAccount, seedReady, withEnv, videoLinkOf } from "./helpers";

const store = { rows: [] as CommentRow[], calls: [] as unknown[][] };

// The real listComments decides ownership; the mock then serves store.rows, filtered by since.
const real = commentDeps.listComments;
const fake = async (...args: Parameters<typeof real>) => {
  store.calls.push(args);
  const owned = await real(...args);
  if (!owned) return owned;
  const since = args[3]?.since;
  return store.rows.filter((r) => since === undefined || r.created_at > since);
};

const T0 = 1_790_000_000; // 2026-09-21T14:13:20Z
const rows = (): CommentRow[] => [
  { id: "c3", author: "Sam [QA]", is_owner: false, body: "Newest", t_seconds: 75, created_at: T0 + 300 },
  { id: "c2", author: "Alex", is_owner: true, body: "Owner reply", t_seconds: null, created_at: T0 + 200 },
  { id: "c1", author: "Jo", is_owner: false, body: "Oldest", t_seconds: 5, created_at: T0 + 100 },
];

beforeEach(() => {
  store.rows = rows();
  store.calls = [];
  vi.spyOn(commentDeps, "listComments").mockImplementation(fake);
});

afterEach(() => vi.restoreAllMocks());

describe("list_comments", () => {
  it("owner sees comments newest first with video and per-comment display links (plain url, no ?t=)", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const url = await videoLinkOf(id);
    const r = await mcp("list_comments", { video_id: id }, key);
    expect(r.isError).toBe(false);
    expect(r.data.video).toEqual({ id, title: "Demo", url, display: `[Demo](${url})` });
    expect(r.data.count).toBe(3);
    expect(r.data.comments.map((x: any) => x.id)).toEqual(["c3", "c2", "c1"]);
    expect(r.data.comments[0]).toEqual({
      id: "c3",
      author: "Sam [QA]",
      is_owner: false,
      body: "Newest",
      t_seconds: 75,
      created_at: new Date((T0 + 300) * 1000).toISOString(),
      display: `[Sam \\[QA\\] at 1:15](${url})`,
    });
    expect(r.data.comments[1].display).toBe(`[Alex](${url})`);
    expect(r.data.comments[1].is_owner).toBe(true);
    expect(r.data.comments[2].display).toBe(`[Jo at 0:05](${url})`);
    for (const c of r.data.comments) expect(c.display).not.toContain("?t=");
    expect(store.calls[0].slice(1)).toEqual([accountId, id, {}]);
  });

  it("since (ISO-8601) is passed as unix seconds and only newer comments come back", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const since = new Date((T0 + 150) * 1000).toISOString();
    const r = await mcp("list_comments", { video_id: id, since }, key);
    expect(store.calls[0][3]).toEqual({ since: T0 + 150 });
    expect(r.data.comments.map((x: any) => x.id)).toEqual(["c3", "c2"]);
    expect(r.data.count).toBe(2);

    const off = await mcp("list_comments", { video_id: id, since: "2026-09-21T16:16:00+02:00" }, key); // = T0 + 160
    expect(store.calls[1][3]).toEqual({ since: T0 + 160 });
    expect(off.data.count).toBe(2);

    const none = await mcp("list_comments", { video_id: id, since: new Date((T0 + 300) * 1000).toISOString() }, key);
    expect(none.data).toMatchObject({ comments: [], count: 0 });

    for (const bad of ["yesterday", "1790000000", "2026-13-01T00:00:00Z"]) {
      const e = await mcp("list_comments", { video_id: id, since: bad }, key);
      expect(e.data.error, bad).toBe("INVALID_ARGUMENTS");
    }
  });

  it("another account's or an unknown video is NOT_FOUND, like get_video", async () => {
    const owner = await seedAccount();
    const other = await seedAccount();
    const id = await seedReady(owner.accountId);
    const theirs = await mcp("list_comments", { video_id: id }, other.key);
    const getVideo = await mcp("get_video", { recording_id: id }, other.key);
    expect(theirs.isError).toBe(true);
    expect(theirs.data).toEqual(getVideo.data);
    expect(theirs.data.error).toBe("NOT_FOUND");
    expect((await mcp("list_comments", { video_id: "x".repeat(24) }, owner.key)).data.error).toBe("NOT_FOUND");
    expect((await mcp("list_comments", { video_id: id })).status).toBe(401);
  });

  it("works while SERVICE_MODE is READ_ONLY", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const ro = withEnv({ SERVICE_MODE: "READ_ONLY" });
    const r = await mcp("list_comments", { video_id: id }, key, ro);
    expect(r.isError).toBe(false);
    expect(r.data.count).toBe(3);
    expect((await mcp("update_video", { video_id: id, title: "x" }, key, ro)).data.error).toBe("SERVICE_PAUSED");
  });

  it("real listComments: [] for the owner of a video without comments, null otherwise", async () => {
    vi.restoreAllMocks();
    const { accountId, key } = await seedAccount();
    const other = await seedAccount();
    const id = await seedReady(accountId);
    expect(await listComments(env, accountId, id)).toEqual([]);
    expect(await listComments(env, accountId, id, { since: T0 })).toEqual([]);
    expect(await listComments(env, other.accountId, id)).toBeNull();
    expect(await listComments(env, accountId, "y".repeat(24))).toBeNull();
    expect((await mcp("list_comments", { video_id: id }, key)).data).toMatchObject({ comments: [], count: 0 });
  });

  it("is in tools/list with the rule; the rule is in the instructions and the playbook", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const t = ((await res.json()) as any).result.tools.find((x: any) => x.name === "list_comments");
    expect(t).toBeTruthy();
    expect(t.description).toContain(COMMENTS_RULE);
    expect(t.inputSchema.required).toEqual(["video_id"]);
    expect(MCP_INSTRUCTIONS).toContain(COMMENTS_RULE);
    expect(PLAYBOOK_TEXT).toContain(COMMENTS_RULE);
    for (const s of ["clickable Markdown link", "author", "since", "revoking access or deleting the video removes them", "delete_comment"]) {
      expect(COMMENTS_RULE).toContain(s);
    }
  });
});
