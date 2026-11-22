import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { shareSig } from "../src/share";
import { now } from "../src/util";
import { call, mcp, ORIGIN, seedAccount, seedReady, videoLinkOf } from "./helpers";

async function link(key: string, id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await mcp("share", { recording_id: id, ...extra }, key);
  expect(r.isError).toBe(false);
  return (await videoLinkOf(id)).slice(ORIGIN.length);
}

const slugOf = (path: string) => path.split("/").pop()!;
const mediaCookie = (res: Response) => /mt=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![0];

describe("share link HMAC", () => {
  it("valid link renders with noindex + security headers", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const res = await call(await link(key, id));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict; Secure/);
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    expect(html.replace(/<a class="wm"[^]*?<\/a>/, "")).not.toMatch(/<a\b|reaction|\blikes?\b/i); // video, transcript and comments only (comments.test.ts)
  });

  it("expired, tampered and too-long legacy links and rotated video URLs are rejected", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const good = await link(key, id);
    const past = now() - 10;
    expect((await call(`/v/${id}?e=${past}&s=${await shareSig(env, id, past, 1)}`)).status).toBe(404);
    const far = now() + 2 * 86400;
    expect((await call(`/v/${id}?e=${far}&s=${await shareSig(env, id, far, 1)}`)).status).toBe(404);
    const ok = now() + 3600;
    expect((await call(`/v/${id}?e=${ok}&s=X${(await shareSig(env, id, ok, 1)).slice(1)}`)).status).toBe(404);
    expect((await call(`/v/${id}?e=${ok}&s=${await shareSig(env, id, ok, 1)}`)).status).toBe(301);
    const rotated = await link(key, id, { rotate: true });
    expect((await call(good)).status).toBe(404);
    expect((await call(rotated)).status).toBe(200);
  });

  it("rotating SHARE_HMAC_KEY kills legacy links and media cookies (not the video URL)", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const url = await link(key, id);
    const rotatedEnv = { ...env, SHARE_HMAC_KEY: "rotated" };
    const exp = now() + 3600;
    expect((await call(`/v/${id}?e=${exp}&s=${await shareSig(env, id, exp, 1)}`, {}, rotatedEnv)).status).toBe(404);
    const c = mediaCookie(await call(url));
    expect((await call(`/m/${slugOf(url)}`, { headers: { cookie: c } }, rotatedEnv)).status).toBe(403);
    expect((await call(url, {}, rotatedEnv)).status).toBe(200);
  });

  it("viewer shows the timestamped transcript as seekable lines", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId, {
      transcript: { segments: [{ start: 0, end: 2, text: "hello" }, { start: 65.4, end: 67, text: "<b>bye</b>" }] },
    });
    const html = await (await call(await link(key, id))).text();
    expect(html).toContain('data-t="65.4"><span class="t">01:05</span><span>&lt;b&gt;bye&lt;/b&gt;</span>');
    expect(html).toContain('data-t="0"><span class="t">00:00</span><span>hello</span>');
    expect(await (await mcp("get_transcript", { recording_id: id }, key)).data.transcript).toBe("[00:00] hello\n[01:05] <b>bye</b>");
  });
});

describe("media streaming", () => {
  it("serves Range requests with 206 and needs the per-view cookie", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const path = await link(key, id);
    const view = await call(path);
    const c = mediaCookie(view);
    const m = `/m/${slugOf(path)}`;
    expect((await call(m)).status).toBe(403);
    const r = await call(m, { headers: { cookie: c, range: "bytes=0-99", "sec-fetch-site": "same-origin" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-99/4096");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect((await r.arrayBuffer()).byteLength).toBe(100);
    const full = await call(m, { headers: { cookie: c } });
    expect(full.status).toBe(200);
    expect((await full.arrayBuffer()).byteLength).toBe(4096);
    expect((await call(m, { headers: { cookie: c, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await call(m, { headers: { cookie: c, origin: "https://evil.example" } })).status).toBe(403);
  });

  it("a media token for one video does not open another", async () => {
    const { accountId, key } = await seedAccount();
    const a = await seedReady(accountId);
    const b = await seedReady(accountId);
    const c = mediaCookie(await call(await link(key, a)));
    const other = slugOf(await link(key, b));
    expect((await call(`/m/${other}`, { headers: { cookie: c } })).status).toBe(403);
  });
});

describe("passcode", () => {
  it("locks out after 5 wrong passcodes, even for the right one", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const url = await link(key, id, { passcode: "open-sesame" });
    expect((await call(url)).status).toBe(200); // form
    expect((await call(url)).headers.get("set-cookie")).toBeNull();
    const post = (p: string) => {
      const fd = new FormData();
      fd.set("passcode", p);
      return call(url, { method: "POST", body: fd });
    };
    for (let i = 0; i < 4; i++) expect((await post("wrong")).status).toBe(401);
    expect((await post("wrong")).status).toBe(429);
    expect((await post("open-sesame")).status).toBe(429);
    await env.DB.prepare("UPDATE shares SET locked_until = 0 WHERE recording_id = ?").bind(id).run();
    const ok = await post("open-sesame");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^mt=/);
  });
});

describe("view accounting", () => {
  const views = (id: string) =>
    runInDurableObject(env.GOVERNOR.get(env.GOVERNOR.idFromName("global")), (_i, state) => {
      const r = state.storage.sql.exec<{ n: number }>("SELECT n FROM daily WHERE k = ?", `views:${id}`).toArray()[0];
      return r?.n ?? 0;
    });

  it("link-preview bots get title-only HTML, no cookie, no view counted", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const url = await link(key, id);
    const res = await call(url, { headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).not.toContain("<video");
    expect(await views(id)).toBe(0);
    await call(url);
    expect(await views(id)).toBe(1);
  });
  // View caps (owner exempt, per viewer, per video): view-cap.test.ts.
});
