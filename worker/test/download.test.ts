// Watch page Download (Pro, Teams and Owner-tier owners only) and GET /<username>/v/<slug>/download.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionModule from "../src/oauth/web-session";
import { downloadDisposition } from "../src/share";
import { call, mcp, ORIGIN, seedAccount, seedReady } from "./helpers";

const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const COOKIE = /(__Host-rb_owner=[^;]+)/;
const DL_BTN = /<a class="shr dlb" id="dlb" href="([^"]+)" download>/;

async function video(plan: "free" | "pro" | "teams" | "owner", opts: { shared?: boolean; title?: string } = {}) {
  const a = await seedAccount();
  await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, a.accountId).run();
  const id = await seedReady(a.accountId);
  if (opts.title !== undefined) await env.DB.prepare("UPDATE recordings SET title = ? WHERE id = ?").bind(opts.title, id).run();
  if (opts.shared) expect((await mcp("share", { recording_id: id }, a.key)).isError).toBe(false);
  const g = await mcp("get_video", { recording_id: id }, a.key);
  const path = (g.data.url as string).slice(ORIGIN.length);
  return { ...a, id, path, ownerUrl: g.data.owner_url as string };
}

const get = (path: string, headers: Record<string, string> = {}) => call(path.replace(ORIGIN, ""), { headers: { "user-agent": UA, ...headers } });

describe("watch page Download button", () => {
  it("the owner of a Pro, Teams or Owner-tier video gets Download next to Share, pointing at ./download", async () => {
    for (const plan of ["pro", "teams", "owner"] as const) {
      const v = await video(plan);
      session.account = v.accountId;
      const html = await (await get(v.path)).text();
      expect(DL_BTN.exec(html)?.[1]).toBe(`${v.path}/download`);
      // Download sits right before the Share pill in the title row.
      expect(html).toMatch(/<a class="shr dlb"[^>]*>[\s\S]*?Download<\/a><div class="shr-w">/);
    }
  });

  it("a Free owner never sees it", async () => {
    const v = await video("free");
    session.account = v.accountId;
    const html = await (await get(v.path)).text();
    expect(html).toContain('id="shr"');
    expect(html).not.toContain('id="dlb"');
    expect(html).not.toContain("/download");
  });

  it("viewers of a Pro owner's shared video (signed out or another account) never see it", async () => {
    const v = await video("pro", { shared: true });
    const other = await seedAccount();
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(other.accountId).run();
    for (const who of [null, other.accountId]) {
      session.account = who;
      const res = await get(v.path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('id="dlb"');
      expect(html).not.toContain("/download");
    }
  });
});

describe("GET /<username>/v/<slug>/download", () => {
  it("owner on Pro (web session): 200, the MP4 as an attachment named after the title", async () => {
    const v = await video("pro", { title: "Q3 walkthrough" });
    session.account = v.accountId;
    const res = await get(`${v.path}/download`, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Q3 walkthrough.mp4"; filename*=UTF-8''Q3%20walkthrough.mp4`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    const stored = await env.MEDIA.get(`v/${v.id}.mp4`);
    expect(body).toEqual(new Uint8Array(await stored!.arrayBuffer()));
    expect(res.headers.get("content-length")).toBe(String(body.length));
  });

  it("HEAD: the GET's status and headers without a body, with the same owner and plan checks", async () => {
    const v = await video("pro", { title: "Q3 walkthrough" });
    const size = (await env.MEDIA.head(`v/${v.id}.mp4`))!.size;
    const head = (path: string, headers: Record<string, string> = {}) =>
      call(path, { method: "HEAD", headers: { "user-agent": UA, ...headers } });
    session.account = v.accountId;
    const res = await head(`${v.path}/download`, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(size));
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Q3 walkthrough.mp4"; filename*=UTF-8''Q3%20walkthrough.mp4`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect((await head(`${v.path}/download`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.account = null;
    expect((await head(`${v.path}/download`)).status).toBe(404);
    const free = await video("free", { shared: true });
    session.account = free.accountId;
    expect((await head(`${free.path}/download`)).status).toBe(403);
  });

  it("owner on Pro via the owner link's cookie (no sign-in): 200", async () => {
    const v = await video("teams");
    const claim = await get(v.ownerUrl);
    expect(claim.status).toBe(303);
    const cookie = COOKIE.exec(claim.headers.get("set-cookie") ?? "")?.[1];
    expect(cookie).toBeTruthy();
    const res = await get(`${v.path}/download`, { cookie: cookie! });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Demo\.mp4"/);
  });

  it("owner on Free: 403, nothing streamed", async () => {
    const v = await video("free", { shared: true });
    session.account = v.accountId;
    const res = await get(`${v.path}/download`);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("not the owner: 403 on a shared video, 404 on a private one", async () => {
    const shared = await video("pro", { shared: true });
    const priv = await video("pro");
    const other = await seedAccount();
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(other.accountId).run();
    for (const who of [null, other.accountId]) {
      session.account = who;
      expect((await get(`${shared.path}/download`)).status).toBe(403);
      expect((await get(`${priv.path}/download`)).status).toBe(404);
    }
  });

  it("cross-site or foreign-origin requests: 403 even for the owner; a wrong username: 404", async () => {
    const v = await video("pro");
    session.account = v.accountId;
    expect((await get(`${v.path}/download`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(`${v.path}/download`, { origin: "https://evil.example" })).status).toBe(403);
    expect((await get(`${v.path.replace(/^\/[^/]+/, "/someone-else")}/download`)).status).toBe(404);
    expect((await call(`${v.path}/download`, { method: "POST" })).status).toBe(404);
  });

  it("revoked: the old download URL dies with the old slug", async () => {
    const v = await video("pro", { shared: true });
    expect((await mcp("revoke_share", { recording_id: v.id }, v.key)).isError).toBe(false);
    session.account = v.accountId;
    expect((await get(`${v.path}/download`)).status).toBe(404);
  });
});

describe("GET /m/<slug> (the page's <video> source) is not a download link", () => {
  /** Opens the watch page the way a browser does and returns a fetch for its media URL with the page's media cookie. */
  async function media(path: string) {
    const page = await get(path);
    expect(page.status).toBe(200);
    await page.text();
    const mt = /(mt=[^;]+)/.exec(page.headers.get("set-cookie") ?? "")![1];
    const src = `/m/${path.split("/").pop()}`;
    return (headers: Record<string, string> = {}) => get(src, { cookie: mt, "sec-fetch-site": "same-origin", ...headers });
  }

  it("a Free video plays for <video> (Sec-Fetch-Dest video, or none as on Safari), Range 206 too; opened as a document: 403", async () => {
    const v = await video("free", { shared: true });
    const size = (await env.MEDIA.head(`v/${v.id}.mp4`))!.size;
    for (const who of [v.accountId, null]) {
      session.account = who;
      const m = await media(v.path);
      for (const dest of [{ "sec-fetch-dest": "video" }, {}] as Record<string, string>[]) {
        const full = await m(dest);
        expect(full.status).toBe(200);
        expect(full.headers.get("content-disposition")).toBe("inline");
        expect((await full.arrayBuffer()).byteLength).toBe(size);
        const part = await m({ ...dest, range: "bytes=0-9" });
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe(`bytes 0-9/${size}`);
        expect((await part.arrayBuffer()).byteLength).toBe(10);
      }
      const doc = await m({ "sec-fetch-dest": "document", "sec-fetch-site": "none" });
      expect(doc.status).toBe(403);
      expect(doc.headers.get("content-type")).not.toBe("video/mp4");
      await doc.arrayBuffer();
    }
  });

  it("the owner of a Pro video may open it as a document; it still comes inline", async () => {
    const v = await video("pro");
    session.account = v.accountId;
    const m = await media(v.path);
    const doc = await m({ "sec-fetch-dest": "document", "sec-fetch-site": "none" });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("content-disposition")).toBe("inline");
    await doc.arrayBuffer();
    const part = await m({ "sec-fetch-dest": "video", range: "bytes=0-9" });
    expect(part.status).toBe(206);
    await part.arrayBuffer();
  });
});

describe("downloadDisposition", () => {
  it("keeps a safe ASCII filename and the UTF-8 title, drops path, quote and control characters", () => {
    expect(downloadDisposition('../../etc/"pass\r\nwd"')).toBe(
      `attachment; filename="etc pass wd.mp4"; filename*=UTF-8''etc%20pass%20wd.mp4`,
    );
    expect(downloadDisposition("Café demo (v2)")).toBe(`attachment; filename="Cafe demo v2.mp4"; filename*=UTF-8''Caf%C3%A9%20demo%20%28v2%29.mp4`);
    expect(downloadDisposition("日本語")).toBe(`attachment; filename="recitbot-recording.mp4"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.mp4`);
    expect(downloadDisposition(null)).toBe(`attachment; filename="recitbot-recording.mp4"; filename*=UTF-8''recitbot-recording.mp4`);
  });
});
