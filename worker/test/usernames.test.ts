// Video URLs (/<username>/v/<slug>, private by default), share/revoke, legacy /v/<id> links and owner-tier retention.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "../src/index";
import { KEEP_FOREVER, retentionExpiry, shareSig, videoUrl } from "../src/share";
import { assignUsername, RESERVED_USERNAMES, usernameBase, usernameProblem } from "../src/username";
import { now, randomId } from "../src/util";
import * as sessionModule from "../src/oauth/web-session";
import { call, connectDevice, mcp, ORIGIN, seedAccount, seedReady, withEnv } from "./helpers";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";

// Website sign-in: whichever account the test says is signed in (mocked oauth/web-session getWebSession).
// vi.mock can't reach it: the worker's main module (Durable Objects) is loaded before this file. Spy on the shared module.
const session = { account: null as string | null };
vi.spyOn(sessionModule, "getWebSession").mockImplementation(async () => session.account ?? null);
afterEach(() => {
  session.account = null;
});
async function asOwner<T>(accountId: string, f: () => Promise<T>): Promise<T> {
  session.account = accountId;
  try {
    return await f();
  } finally {
    session.account = null;
  }
}

async function account(email: string | null = null, botName: string | null = null): Promise<string> {
  const id = randomId(128);
  await env.DB.prepare("INSERT INTO accounts (id, email, bot_name, created_at) VALUES (?, ?, ?, ?)").bind(id, email, botName, now()).run();
  return id;
}

async function share(key: string, id: string, extra: Record<string, unknown> = {}) {
  const r = await mcp("share_recording", { recording_id: id, ...extra }, key);
  expect(r.isError).toBe(false);
  return { path: r.data.share_url.slice(ORIGIN.length) as string, url: r.data.share_url as string, data: r.data };
}

/** The account's username (assigned on first use, like every tool that builds a URL does). */
const username = (accountId: string) => assignUsername(env.DB, accountId);

/** Every URL anywhere in a tool result. */
const urlsIn = (data: unknown) => JSON.stringify(data).match(/https?:\/\/[^\s"')]+/g) ?? [];
const GENERIC_404 = "This video is private or doesn&#39;t exist";
const pathOf = (url: string) => url.slice(ORIGIN.length);
const slugOf = (url: string) => url.split("/").pop()!;
const mediaCookie = (res: Response) => /mt=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![0];

describe("username rules", () => {
  it("accepts 3-30 lowercase letters, digits and single inner hyphens", () => {
    for (const ok of ["abc", "alex", "alex-smith", "a1b", "123", "a".repeat(30), "x-y-z"]) expect(usernameProblem(ok), ok).toBeNull();
  });

  it("rejects bad shapes", () => {
    for (const bad of ["ab", "a".repeat(31), "Alex", "al ex", "al_ex", "al.ex", "-alex", "alex-", "al--ex", "aléx", ""]) {
      expect(usernameProblem(bad), bad).toBe("INVALID_USERNAME");
    }
  });

  it("blocks every reserved word", () => {
    const listed = ["v", "mcp", "api", "oauth", "well-known", "upload", "admin", "login", "signup", "settings", "pricing", "faq", "about", "www", "static", "assets", "recitbot"];
    for (const w of listed) expect(RESERVED_USERNAMES.has(w), w).toBe(true);
    for (const w of listed.filter((x) => x.length >= 3)) expect(usernameProblem(w), w).toBe("USERNAME_RESERVED");
  });

  it("derives a slug from an email or a name", () => {
    expect(usernameBase("Alex.Smith+rec@Example.com")).toBe("alex-smith-rec");
    expect(usernameBase("José Núñez")).toBe("jose-nunez");
    expect(usernameBase("  --Bot__Name--  ")).toBe("bot-name");
    expect(usernameBase("x".repeat(40))).toHaveLength(24);
    expect(usernameBase(null)).toBe("");
  });
});

describe("assignUsername", () => {
  it("uses the email local part, else the bot name, and is idempotent", async () => {
    const tag = randomId(40).toLowerCase();
    const a = await account(`mail${tag}@example.com`);
    expect(await assignUsername(env.DB, a)).toBe(`mail${tag}`);
    expect(await assignUsername(env.DB, a, "something-else")).toBe(`mail${tag}`);
    expect(await username(a)).toBe(`mail${tag}`);
    const b = await account(null, `Bot ${tag}`);
    expect(await assignUsername(env.DB, b)).toBe(`bot-${tag}`);
  });

  it("dedupes with a short suffix", async () => {
    const tag = `dup${randomId(30).toLowerCase()}`;
    const first = await assignUsername(env.DB, await account(), tag);
    const second = await assignUsername(env.DB, await account(), tag);
    const third = await assignUsername(env.DB, await account(), `${tag}@other.example`);
    expect(first).toBe(tag);
    expect(second).toMatch(new RegExp(`^${tag}-[a-z0-9]{4}$`));
    expect(third).toMatch(new RegExp(`^${tag}-[a-z0-9]{4}$`));
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("never hands out a reserved, too short or empty name", async () => {
    expect(await assignUsername(env.DB, await account(), "admin")).toMatch(/^admin-[a-z0-9]{4}$/);
    expect(await assignUsername(env.DB, await account(), "Recitbot")).toMatch(/^recitbot-[a-z0-9]{4}$/);
    expect(await assignUsername(env.DB, await account(), "jo")).toMatch(/^jo-[a-z0-9]{4}$/);
    expect(await assignUsername(env.DB, await account(), "!!!")).toMatch(/^user(-[a-z0-9]{4})?$/);
  });
});

describe("set_username", () => {
  it("changes it, and refuses reserved, invalid and taken names", async () => {
    const tag = `set${randomId(30).toLowerCase()}`;
    const a = await seedAccount();
    const b = await seedAccount();
    const ok = await mcp("set_username", { username: tag }, a.key);
    expect(ok.data).toEqual({ username: tag, display_name: null });
    expect((await mcp("set_username", { username: "pricing" }, b.key)).data.error).toBe("USERNAME_RESERVED");
    expect((await mcp("set_username", { username: "no--way" }, b.key)).data.error).toBe("INVALID_USERNAME");
    expect((await mcp("set_username", { username: tag }, b.key)).data.error).toBe("USERNAME_TAKEN");
    expect((await mcp("set_username", { username: tag.toUpperCase() }, a.key)).data.username).toBe(tag);
  });
});

describe("private by default", () => {
  it("get_video gives the one URL; anonymous visitors get the generic 404, the signed-in owner the page", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const v = await mcp("get_video", { recording_id: id }, key);
    const u = await username(accountId);
    expect(v.data.share_url).toMatch(new RegExp(`^${ORIGIN}/${u}/v/[A-Za-z0-9]{14}$`));
    expect(v.data.visibility).toBe("private");
    const path = pathOf(v.data.share_url);

    const anon = await call(path, { headers: { "user-agent": UA } });
    expect(anon.status).toBe(404);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain(GENERIC_404);
    expect(anonHtml).not.toContain("Demo");
    // Same answer as a URL that never existed: private and nonexistent can't be told apart.
    const missing = await call(`/${u}/v/${"Z".repeat(14)}`, { headers: { "user-agent": UA } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(anonHtml);
    // Not even to link-preview bots.
    expect((await call(path, { headers: { "user-agent": "Slackbot-LinkExpanding 1.0" } })).status).toBe(404);

    const own = await asOwner(accountId, () => call(path, { headers: { "user-agent": UA } }));
    expect(own.status).toBe(200);
    const html = await own.text();
    expect(html).toContain(`Recorded by ${u}`);
    expect(html).toContain("Private: only you can see this video");
    expect(html).not.toContain(id); // the page never shows the internal id, media included
    // Media follows the same rule: the owner plays it; the same cookie without the session gets 404.
    const mt = mediaCookie(own);
    const slug = slugOf(path);
    expect((await asOwner(accountId, () => call(`/m/${slug}`, { headers: { cookie: mt } }))).status).toBe(200);
    expect((await call(`/m/${slug}`, { headers: { cookie: mt } })).status).toBe(404);
    // Another signed-in account is as good as anonymous.
    const other = await seedAccount();
    expect((await asOwner(other.accountId, () => call(path))).status).toBe(404);
  });

  it("every recording has its own random slug", async () => {
    const { accountId } = await seedAccount();
    const ids = [await seedReady(accountId), await seedReady(accountId)];
    const urls = await Promise.all(ids.map((id) => videoUrl(env, ORIGIN, id, accountId)));
    expect(new Set(urls).size).toBe(2);
    const row = await env.DB.prepare("SELECT slug FROM recordings WHERE id = ?").bind(ids[0]).first<{ slug: string }>();
    expect(urls[0].endsWith(`/v/${row!.slug}`)).toBe(true);
    expect(await videoUrl(env, ORIGIN, ids[0], accountId)).toBe(urls[0]);
  });
});

describe("share_recording", () => {
  it("makes the same URL public; sharing again keeps it", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const before = (await mcp("get_video", { recording_id: id }, key)).data.share_url;
    const s = await share(key, id);
    expect(s.url).toBe(before);
    expect(s.data).toMatchObject({ visibility: "public", passcode_required: false });
    const res = await call(s.path, { headers: { "user-agent": UA } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`Recorded by ${await username(accountId)}`);
    expect(html).not.toContain("Private: only you");
    expect((await call(`/m/${slugOf(s.path)}`, { headers: { cookie: mediaCookie(res) } })).status).toBe(200);
    expect((await mcp("get_video", { recording_id: id }, key)).data).toMatchObject({ share_url: before, visibility: "public" });
    expect((await share(key, id)).url).toBe(before);
    // The older tool name does the same.
    expect((await mcp("share", { recording_id: id }, key)).data.share_url).toBe(before);

    await mcp("set_username", { display_name: "Alex <S>" }, key);
    expect(await (await call(s.path)).text()).toContain("Recorded by Alex &lt;S&gt;");
  });

  it("view beacons work on the video URL", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const { path } = await share(key, id);
    const html = await (await call(path, { headers: { "user-agent": UA } })).text();
    const vt = /data-vt="([^"]+)"/.exec(html)![1];
    const b = await call(`${path}/b`, {
      method: "POST",
      body: new URLSearchParams({ t: vt, p: "10" }),
      headers: { "user-agent": UA, "sec-fetch-site": "same-origin", origin: ORIGIN },
    });
    expect(b.status).toBe(204);
    expect((await env.DB.prepare("SELECT views FROM recordings WHERE id = ?").bind(id).first<{ views: number }>())!.views).toBe(1);
  });
});

describe("revoke_share", () => {
  it("rotates the slug: the old URL 404s at once, the new one is private until shared again", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const before = await share(key, id);
    const page = await call(before.path);
    expect(page.status).toBe(200);
    const mt = mediaCookie(page);
    expect((await call(`/m/${slugOf(before.path)}`, { headers: { cookie: mt } })).status).toBe(200);

    const r = await mcp("revoke_share", { recording_id: id }, key);
    expect(r.data).toMatchObject({ recording_id: id, visibility: "private" });
    const after = r.data.share_url as string;
    expect(after).not.toBe(before.url);
    expect(after).toMatch(new RegExp(`^${ORIGIN}/${await username(accountId)}/v/[A-Za-z0-9]{14}$`));

    // Old URL: gone for everyone, owner included (that slug no longer exists), page and media.
    for (const who of [null, accountId]) {
      session.account = who;
      const gone = await call(before.path);
      expect(gone.status).toBe(404);
      expect(await gone.text()).toContain(GENERIC_404);
      expect((await call(`/m/${slugOf(before.path)}`, { headers: { cookie: mt } })).status).toBe(404);
    }
    session.account = null;
    // New URL: private.
    expect((await call(pathOf(after))).status).toBe(404);
    expect((await asOwner(accountId, () => call(pathOf(after)))).status).toBe(200);
    expect((await mcp("get_video", { recording_id: id }, key)).data).toMatchObject({ share_url: after, visibility: "private" });

    // Re-share: the new URL (never the old one) goes public; the old media cookie stays dead.
    const again = await share(key, id);
    expect(again.url).toBe(after);
    const fresh = await call(again.path);
    expect(fresh.status).toBe(200);
    expect((await call(`/m/${slugOf(again.path)}`, { headers: { cookie: mediaCookie(fresh) } })).status).toBe(200);
    expect((await call(`/m/${slugOf(again.path)}`, { headers: { cookie: mt } })).status).toBe(403);
    expect((await call(before.path)).status).toBe(404);
  });

  it("share_recording rotate=true = revoke, then share: a new public URL", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const first = await share(key, id);
    const second = await share(key, id, { rotate: true });
    expect(second.url).not.toBe(first.url);
    expect((await call(first.path)).status).toBe(404);
    expect((await call(second.path)).status).toBe(200);
  });

  it("only the owner can revoke or share", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const id = await seedReady(a.accountId);
    const { path } = await share(a.key, id);
    expect((await mcp("revoke_share", { recording_id: id }, b.key)).data.error).toBe("NOT_FOUND");
    expect((await mcp("share_recording", { recording_id: id }, b.key)).data.error).toBe("NOT_FOUND");
    expect((await call(path)).status).toBe(200);
  });
});

describe("legacy /v/<id> links", () => {
  const legacy = async (id: string, version = 1) => {
    const exp = now() + 3600;
    return `/v/${id}?e=${exp}&s=${await shareSig(env, id, exp, version)}`;
  };

  it("a valid old link to a shared video 301s to its URL; private or revoked = the generic 404", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const old = await legacy(id);
    const priv = await call(old);
    expect(priv.status).toBe(404);
    expect(await priv.text()).toContain(GENERIC_404);

    const { path } = await share(key, id);
    const r = await call(old);
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(path);
    expect((await call(r.headers.get("location")!)).status).toBe(200);
    // No token, a bad one or an expired one: nothing (the recording id alone is not a link).
    expect((await call(`/v/${id}`)).status).toBe(404);
    expect((await call(old.replace(/s=(.)/, (_m, c) => (c === "X" ? "s=Y" : "s=X")))).status).toBe(404);
    const past = now() - 10;
    expect((await call(`/v/${id}?e=${past}&s=${await shareSig(env, id, past, 1)}`)).status).toBe(404);

    // Revoked, then shared again: the old link stays dead (revoking bumped the version it was signed for).
    await mcp("revoke_share", { recording_id: id }, key);
    expect((await call(old)).status).toBe(404);
    await share(key, id);
    expect((await call(old)).status).toBe(404);
  });

  it("the signed-in owner is redirected from the bare /v/<id> (what the recorder opens), private or not", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const url = (await mcp("get_video", { recording_id: id }, key)).data.share_url;
    const r = await asOwner(accountId, () => call(`/v/${id}`));
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(pathOf(url));
    expect((await call(`/v/${id}`)).status).toBe(404);
  });
});

describe("wrong username", () => {
  it("301s to the right one only when the video is public; otherwise the generic 404", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const u = await username(accountId);
    const slug = slugOf((await mcp("get_video", { recording_id: id }, key)).data.share_url);
    for (const wrong of ["somebody-else", u.toUpperCase()]) {
      expect((await call(`/${wrong}/v/${slug}`)).status, wrong).toBe(404);
      expect((await asOwner(accountId, () => call(`/${wrong}/v/${slug}`))).status, wrong).toBe(404);
    }
    await share(key, id);
    for (const wrong of ["somebody-else", u.toUpperCase()]) {
      const r = await call(`/${wrong}/v/${slug}`);
      expect(r.status, wrong).toBe(301);
      expect(r.headers.get("location")).toBe(`/${u}/v/${slug}`);
    }
    // After a rename the old username redirects too (the slug decides).
    const renamed = `ren${randomId(30).toLowerCase()}`;
    await mcp("set_username", { username: renamed }, key);
    const r = await call(`/${u}/v/${slug}`);
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`/${renamed}/v/${slug}`);
    expect((await call(`/somebody-else/v/${"Q".repeat(14)}`)).status).toBe(404);
  });
});

describe("MCP outputs", () => {
  it("contain exactly one URL, always /<username>/v/<slug>", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const shape = new RegExp(`^${ORIGIN}/${await username(accountId)}/v/[A-Za-z0-9]{14}$`);
    const outputs = [
      (await mcp("get_video", { recording_id: id }, key)).data,
      (await mcp("share_recording", { recording_id: id }, key)).data,
      (await mcp("get_video", { recording_id: id }, key)).data,
      (await mcp("share", { recording_id: id }, key)).data,
      (await mcp("revoke_share", { recording_id: id }, key)).data,
      (await mcp("share_recording", { recording_id: id, rotate: true }, key)).data,
    ];
    // owner_url is that same URL + ?ot=<token> (owner-link.test.ts); it is the only other URL in an output.
    const withoutOwnerUrl = (o: any) => ({ ...o, owner_url: undefined });
    for (const out of outputs) {
      // url, display and share_url all carry the same one URL
      const urls = [...new Set(urlsIn(withoutOwnerUrl(out)))];
      expect(urls, JSON.stringify(out)).toHaveLength(1);
      expect(urls[0]).toMatch(shape);
      expect(out.owner_url).toMatch(new RegExp(`^${urls[0]}\\?ot=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
    }
    expect(urlsIn((await mcp("set_username", {}, key)).data)).toHaveLength(0);
    const listed = (await mcp("list_videos", {}, key)).data;
    expect([...new Set(urlsIn(listed.recordings.map(withoutOwnerUrl)))], JSON.stringify(listed)).toEqual([
      (await mcp("get_video", { recording_id: id }, key)).data.url,
    ]);
  });

  it("tool descriptions show no other link form", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const text = JSON.stringify(await res.json());
    expect(text).toContain("/<username>/v/<slug>");
    expect(text).not.toMatch(/\/v\/<id>|\?s=|\?e=|share_expires_at/);
  });
});

describe("retention", () => {
  it("owner-tier recordings survive the 24 h cleanup; free ones are still deleted", async () => {
    const owner = await seedAccount();
    const free = await seedAccount();
    const e = withEnv({ OWNER_ACCOUNT_IDS: owner.accountId });
    const old = now() - 25 * 3600;
    const ownerOld = await seedReady(owner.accountId, { createdAt: old }); // expires_at = created + 24 h (pre-change row)
    const freeOld = await seedReady(free.accountId, { createdAt: old });
    await cleanup(e);
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(freeOld).first()).toBeNull();
    expect(await env.MEDIA.head(`v/${freeOld}.mp4`)).toBeNull();
    const kept = await env.DB.prepare("SELECT expires_at FROM recordings WHERE id = ?").bind(ownerOld).first<{ expires_at: number }>();
    expect(kept?.expires_at).toBe(KEEP_FOREVER);
    expect(await env.MEDIA.head(`v/${ownerOld}.mp4`)).not.toBeNull();

    // A month later it is still there and, once shared, plays.
    await cleanup(e, now() + 30 * 86400);
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(ownerOld).first()).not.toBeNull();
    const s = await mcp("share_recording", { recording_id: ownerOld }, owner.key, e);
    expect((await call(s.data.share_url.slice(ORIGIN.length), {}, e)).status).toBe(200);
    expect((await mcp("get_video", { recording_id: ownerOld }, owner.key, e)).data.expires_at).toBeNull();
  });

  it("new recordings: owner tier never expires, free tier 7 days", () => {
    const t = now();
    const e = withEnv({ OWNER_ACCOUNT_IDS: "ownerAcct" });
    expect(retentionExpiry(e, "ownerAcct", t)).toBe(KEEP_FOREVER);
    expect(retentionExpiry(e, "someoneElse", t)).toBe(t + 7 * 86400);
  });

  it("start_recording stores +7 days for a free video and KEEP_FOREVER for an owner's", async () => {
    const free = await seedAccount();
    const owner = await seedAccount();
    const e = withEnv({ OWNER_ACCOUNT_IDS: owner.accountId });
    const a = await connectDevice(free.deviceToken!);
    const b = await connectDevice(owner.deviceToken!);
    const f = await mcp("start_recording", { max_seconds: 10 }, free.key, e);
    const o = await mcp("start_recording", { max_seconds: 10 }, owner.key, e);
    const row = (id: string) =>
      env.DB.prepare("SELECT created_at, expires_at FROM recordings WHERE id = ?").bind(id).first<{ created_at: number; expires_at: number }>();
    const fr = await row(f.data.recording_id);
    expect(fr!.expires_at - fr!.created_at).toBe(7 * 86400);
    expect((await row(o.data.recording_id))!.expires_at).toBe(KEEP_FOREVER);
    a.ws.close();
    b.ws.close();
    await new Promise((res) => setTimeout(res, 100));
  });

  it("cleanup goes by each row's stored expiry: an old 24 h row is deleted, a new 7-day row lives 7 days", async () => {
    const free = await seedAccount();
    const t = now();
    // Pre-change row: created 25 h ago with the old 24 h expiry. New row: created 25 h ago with a 7-day expiry.
    const created = t - 25 * 3600;
    const oldRow = await seedReady(free.accountId, { createdAt: created });
    const newRow = await seedReady(free.accountId, { createdAt: created, expiresAt: created + 7 * 86400 });
    const exists = async (id: string) => (await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(id).first()) !== null;
    await cleanup(env, t);
    expect(await exists(oldRow)).toBe(false);
    expect(await env.MEDIA.head(`v/${oldRow}.mp4`)).toBeNull();
    expect(await exists(newRow)).toBe(true);
    expect(await env.MEDIA.head(`v/${newRow}.mp4`)).not.toBeNull();
    // Just before its own expiry it is still there; just after, it is gone.
    await cleanup(env, created + 7 * 86400 - 1);
    expect(await exists(newRow)).toBe(true);
    await cleanup(env, created + 7 * 86400 + 1);
    expect(await exists(newRow)).toBe(false);
    expect(await env.MEDIA.head(`v/${newRow}.mp4`)).toBeNull();
  });
});
