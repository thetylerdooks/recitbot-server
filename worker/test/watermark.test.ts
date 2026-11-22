// Free-plan watermark: a player overlay on the watch page, decided per page load from the owner account's plan
// (accountLimits(...).watermark, the same flag get_plan and account_info report). The media
// file (what /m/<slug> streams, and what any download gets) is never stamped, and link-preview meta never mentions it.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountLimits, tierLimits, type Env } from "../src/env";
import { call, mcp, MP4, ORIGIN, seedAccount, seedReady, withEnv } from "./helpers";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
const WM = 'class="wm" id="wm" href="https://example.test" target="_blank"';

async function sharedVideo() {
  const a = await seedAccount();
  const id = await seedReady(a.accountId);
  expect((await mcp("share", { recording_id: id }, a.key)).isError).toBe(false);
  const url = (await mcp("get_video", { recording_id: id }, a.key)).data.url as string;
  const path = url.slice(ORIGIN.length);
  return { ...a, id, path, slug: path.split("/").pop()! };
}

const get = (path: string, e: Env = env, headers: Record<string, string> = {}) =>
  call(path, { headers: { "user-agent": UA, ...headers } }, e);

const setPlan = (id: string, plan: string) => env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, id).run();

describe("watermark flag (tierLimits, one source of truth)", () => {
  it("free yes; pro, teams and owner no", () => {
    expect(tierLimits("free").watermark).toBe(true);
    expect(tierLimits("pro").watermark).toBe(false);
    expect(tierLimits("teams").watermark).toBe(false);
    expect(tierLimits("owner").watermark).toBe(false);
  });
});

describe("watch page watermark", () => {
  it("free owner's video: the pill sits inside the player, before the controls", async () => {
    const v = await sharedVideo();
    const html = await (await get(v.path)).text();
    expect(html.split(WM).length - 1).toBe(1);
    const player = html.slice(html.indexOf('<figure class="player"'), html.indexOf("</figure>"));
    expect(player).toContain(WM);
    expect(player).toContain("<span>Recitbot</span>");
    expect(player).not.toMatch(/<img|src="http/); // inline SVG, no extra request
  });

  it("Pro account's video: no watermark, on the next load after the upgrade, and back after a downgrade", async () => {
    const v = await sharedVideo();
    expect(await (await get(v.path)).text()).toContain(WM);
    await setPlan(v.accountId, "pro");
    expect((await accountLimits(env, v.accountId)).watermark).toBe(false);
    const html = await (await get(v.path)).text();
    expect(html).toContain('<figure class="player"');
    expect(html).not.toContain('class="wm"');
    await setPlan(v.accountId, "free");
    expect(await (await get(v.path)).text()).toContain(WM);
  });

  it("Owner plan (accounts.plan = 'owner' or OWNER_ACCOUNT_IDS): never a watermark", async () => {
    const v = await sharedVideo();
    await setPlan(v.accountId, "owner");
    const html = await (await get(v.path)).text();
    expect(html).toContain('<figure class="player"');
    expect(html).not.toContain('class="wm"');

    const w = await sharedVideo();
    const byEnv = await (await get(w.path, withEnv({ OWNER_ACCOUNT_IDS: w.accountId }))).text();
    expect(byEnv).toContain('<figure class="player"');
    expect(byEnv).not.toContain('class="wm"');
  });

  it("not in link-preview meta or bot pages", async () => {
    const v = await sharedVideo();
    const html = await (await get(v.path, env, { "user-agent": "Twitterbot/1.0" })).text();
    expect(html).not.toContain('class="wm"');
    const page = await (await get(v.path)).text();
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).not.toMatch(/watermark|class="wm"/);
    expect(head).toContain('property="og:image"');
  });

  it("free video's media is unchanged: /m/<slug> streams the stored file byte for byte", async () => {
    const v = await sharedVideo();
    const res = await get(v.path);
    const mt = /(mt=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
    await res.text();
    const media = await get(`/m/${v.slug}`, env, { cookie: mt });
    expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(MP4());
  });
});
