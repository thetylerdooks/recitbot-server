// Operator takedowns (takedown.ts, admin-takedown-tools.ts): admin_takedown, admin_restore, admin_actions. Owner-only
// like every admin_* tool; reason_code required; every takedown reversible and logged in the append-only admin_actions.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CustomDomainRow } from "../src/custom-domains";
import { clearCustomHostCache } from "../src/custom-host";
import type { Env } from "../src/env";
import worker, { cleanup } from "../src/index";
import { now, randomId } from "../src/util";
import { call, freshIp, mcp, seedAccount, seedReady, videoLinkOf, withEnv } from "./helpers";

const TOOLS = ["admin_takedown", "admin_restore", "admin_actions"];

beforeEach(() => clearCustomHostCache());

async function setup() {
  const admin = await seedAccount(false);
  const user = await seedAccount();
  const E = withEnv({ OWNER_ACCOUNT_IDS: `someone,${admin.accountId}` });
  return { admin, user, E };
}

async function rpc(body: unknown, key: string | undefined, e: Env) {
  const res = await call(
    "/mcp",
    { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) },
    e,
  );
  return { status: res.status, body: (await res.json()) as any };
}
const names = async (key: string | undefined, e: Env) =>
  ((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key, e)).body.result.tools as { name: string }[]).map((t) => t.name);
const rawCall = (name: string, args: Record<string, unknown>, key: string | undefined, e: Env) =>
  rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, key, e);
const anonymised = (r: unknown, name: string) => JSON.parse(JSON.stringify(r).replaceAll(name, "<name>"));

/** A shared, ready recording of `accountId` and its page path (/<username>/v/<slug>). */
async function sharedVideo(accountId: string, key: string, e: Env) {
  const id = await seedReady(accountId, { transcript: { segments: [{ start: 0, end: 1, text: "hello" }] } });
  expect((await mcp("share_recording", { recording_id: id }, key, e)).isError).toBe(false);
  return { id, path: new URL(await videoLinkOf(id)).pathname };
}

const page = (path: string, e: Env) => call(path, { headers: { "user-agent": "Mozilla/5.0 Chrome/140.0" } }, e);
const rows = async () => (await env.DB.prepare("SELECT * FROM admin_actions ORDER BY created_at, rowid").all<any>()).results;
const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM admin_actions").first<{ n: number }>())!.n;

async function insertDomain(accountId: string, hostname: string, over: Partial<CustomDomainRow> = {}) {
  const t = now();
  const row = { id: randomId(128), account_id: accountId, hostname, status: "active", live_at: t, created_at: t, updated_at: t, ...over };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO custom_domains (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => (row as Record<string, unknown>)[c]))
    .run();
}
const dom = () => `v${randomId(40).toLowerCase().replace(/[^a-z0-9]/g, "")}.example.com`;

async function onHost(url: string, e: Env) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { headers: { "cf-connecting-ip": freshIp(), "user-agent": "Mozilla/5.0 Chrome/140.0" } }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("who can see and call the takedown tools", () => {
  it("an operator (OWNER_ACCOUNT_IDS) sees all three", async () => {
    const { admin, E } = await setup();
    expect(await names(admin.key, E)).toEqual(expect.arrayContaining(TOOLS));
  });

  it("every admin_* tool is the operator's only: all of them hidden and unknown for anyone else", async () => {
    const { admin, user, E } = await setup();
    const all = (await names(admin.key, E)).filter((n) => n.startsWith("admin_"));
    expect(all).toEqual(
      expect.arrayContaining([...TOOLS, "admin_lookup", "admin_overview", "admin_billing", "admin_usage", "admin_devices", "admin_errors", "admin_disable_custom_domain", "admin_retention_hold"]),
    );
    expect(all).toHaveLength(15);
    expect((await names(user.key, E)).filter((n) => n.startsWith("admin"))).toEqual([]);
    const unknown = anonymised(await rawCall("admin_nonexistent", {}, user.key, E), "admin_nonexistent");
    for (const n of all) expect(anonymised(await rawCall(n, {}, user.key, E), n), n).toEqual(unknown);
  });

  for (const plan of ["free", "pro", "teams", "owner"]) {
    it(`a ${plan} account (not in OWNER_ACCOUNT_IDS) gets exactly the unknown-tool answer`, async () => {
      const { user, E } = await setup();
      const before = await count();
      await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, user.accountId).run();
      expect((await names(user.key, E)).some((n) => n.startsWith("admin"))).toBe(false);
      const unknown = anonymised(await rawCall("admin_nonexistent", {}, user.key, E), "admin_nonexistent");
      expect(unknown.body.error).toEqual({ code: -32602, message: "Unknown tool: <name>" });
      const args = { target: user.accountId, reason_code: "other", action_id: "x".repeat(22) };
      for (const n of TOOLS) expect(anonymised(await rawCall(n, args, user.key, E), n), n).toEqual(unknown);
      // Nothing happened to the account it named.
      expect(await count()).toBe(before);
      expect((await mcp("share_recording", { recording_id: await seedReady(user.accountId) }, user.key, E)).isError).toBe(false);
    });
  }

  it("unauthenticated: the same 401 as an unknown tool", async () => {
    const { E } = await setup();
    const unknown = anonymised(await rawCall("admin_nonexistent", {}, undefined, E), "admin_nonexistent");
    expect(unknown.status).toBe(401);
    for (const n of TOOLS) expect(anonymised(await rawCall(n, {}, undefined, E), n)).toEqual(unknown);
  });
});

describe("admin_takedown input", () => {
  it("reason_code is required and must be one of the five codes; nothing is logged otherwise", async () => {
    const { admin, user, E } = await setup();
    const before = await count();
    for (const args of [{ target: user.accountId }, { target: user.accountId, reason_code: "spam" }, { target: user.accountId, reason_code: "" }, { target: user.accountId, reason_code: null }]) {
      const r = await mcp("admin_takedown", args, admin.key, E);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.data.error).toBe("INVALID_ARGUMENTS");
    }
    expect(await count()).toBe(before);
    expect((await mcp("start_recording", {}, user.key, E)).data?.error).not.toBe("ACCOUNT_SUSPENDED");
  });

  it("mode is only 'disable'; target must exist", async () => {
    const { admin, user, E } = await setup();
    const before = await count();
    expect((await mcp("admin_takedown", { target: user.accountId, reason_code: "other", mode: "purge" }, admin.key, E)).data.error).toBe("INVALID_ARGUMENTS");
    expect((await mcp("admin_takedown", { target: "nosuchthing1234567890", reason_code: "other" }, admin.key, E)).data.error).toBe("NOT_FOUND");
    expect((await mcp("admin_takedown", { target: "nothing.example.com", reason_code: "other" }, admin.key, E)).data.error).toBe("NOT_FOUND");
    expect(await count()).toBe(before);
  });
});

describe("recording takedown", () => {
  it("removes the video (451 page, media refused, no share/transcript/delete), logs it, and restore round-trips", async () => {
    const { admin, user, E } = await setup();
    const { id, path } = await sharedVideo(user.accountId, user.key, E);
    expect((await page(path, E)).status).toBe(200);

    const t = await mcp("admin_takedown", { target: id, reason_code: "phishing", note: "report #12" }, admin.key, E);
    expect(t.isError).toBe(false);
    const a = t.data.action;
    expect(a).toMatchObject({ action: "takedown", target_type: "recording", target: id, account_id: user.accountId, reason_code: "phishing", note: "report #12", by: admin.accountId, reversed_at: null, reversed_by: null });
    expect(a.before_state).toMatchObject({ recording_id: id, status: "ready", shared: true, removed: false, title: "Demo" });
    expect(JSON.stringify(a.before_state)).not.toMatch(/hello|transcript|https?:/);
    expect(t.data.message).toContain(a.action_id);

    const res = await page(path, E);
    expect(res.status).toBe(451);
    const html = await res.text();
    expect(html).toContain("removed for a policy violation");
    expect(html).not.toContain("Demo");
    expect((await page(`/v/${id}`, E)).status).toBe(451);
    const slug = path.split("/").pop();
    expect((await call(`/m/${slug}`, {}, E)).status).toBe(404);
    expect((await call(`${path}/comments`, {}, E)).status).toBe(404);

    for (const [tool, args] of [
      ["share_recording", { recording_id: id }],
      ["get_transcript", { recording_id: id }],
      ["delete", { recording_id: id }],
      ["get_recording_for_skill", { recording_id: id }],
    ] as const) {
      const r = await mcp(tool, args, user.key, E);
      expect(r.data.error, tool).toBe("RECORDING_REMOVED");
    }
    expect(await env.MEDIA.head(`v/${id}.mp4`)).not.toBeNull();
    // The owner's other videos are untouched.
    const other = await sharedVideo(user.accountId, user.key, E);
    expect((await page(other.path, E)).status).toBe(200);

    const r = await mcp("admin_restore", { action_id: a.action_id }, admin.key, E);
    expect(r.isError).toBe(false);
    expect(r.data.effect).toEqual({ still_removed: false });
    expect(r.data.action).toMatchObject({ action_id: a.action_id, reversed_by: admin.accountId, reversed_at: expect.stringMatching(/^\d{4}-/) });
    expect(r.data.restore_action).toMatchObject({ action: "restore", restores: a.action_id, target: id, reason_code: "phishing", by: admin.accountId });
    expect((await page(path, E)).status).toBe(200);
    expect((await mcp("get_transcript", { recording_id: id }, user.key, E)).isError).toBe(false);

    const again = await mcp("admin_restore", { action_id: a.action_id }, admin.key, E);
    expect(again.data.error).toBe("ALREADY_RESTORED");
    expect((await mcp("admin_restore", { action_id: r.data.restore_action.action_id }, admin.key, E)).data.error).toBe("NOT_A_TAKEDOWN");
    expect((await mcp("admin_restore", { action_id: randomId(128) }, admin.key, E)).data.error).toBe("NOT_FOUND");

    // Not held any more (not csam): the owner can delete it.
    expect((await mcp("delete", { recording_id: id }, user.key, E)).isError).toBe(false);
  });

  it("two takedowns of one recording: restoring one leaves it removed until the other is restored", async () => {
    const { admin, user, E } = await setup();
    const { id, path } = await sharedVideo(user.accountId, user.key, E);
    const a1 = (await mcp("admin_takedown", { target: id, reason_code: "other" }, admin.key, E)).data;
    const a2 = (await mcp("admin_takedown", { target: id, reason_code: "malware" }, admin.key, E)).data;
    expect(a2.already).toBe(true);
    expect(a2.action.before_state.removed).toBe(true);
    expect((await mcp("admin_restore", { action_id: a1.action.action_id }, admin.key, E)).data.effect).toEqual({ still_removed: true });
    expect((await page(path, E)).status).toBe(451);
    expect((await mcp("admin_restore", { action_id: a2.action.action_id }, admin.key, E)).data.effect).toEqual({ still_removed: false });
    expect((await page(path, E)).status).toBe(200);
  });

  it("on the account's custom domain the video answers the 451 removal page", async () => {
    const { admin, user, E } = await setup();
    await env.DB.prepare("UPDATE accounts SET plan = 'teams' WHERE id = ?").bind(user.accountId).run();
    const h = dom();
    await insertDomain(user.accountId, h);
    const { id, path } = await sharedVideo(user.accountId, user.key, E);
    const slug = path.split("/").pop();
    expect((await onHost(`https://${h}/${slug}`, E)).status).toBe(200);
    await mcp("admin_takedown", { target: id, reason_code: "impersonation" }, admin.key, E);
    const res = await onHost(`https://${h}/${slug}`, E);
    expect(res.status).toBe(451);
    expect(await res.text()).toContain("removed for a policy violation");
    expect((await onHost(`https://${h}/m/${slug}`, E)).status).toBe(404);
  });

  it("the expiry cleanup never deletes a taken-down recording; after a (non-csam) restore it does", async () => {
    const { admin, user, E } = await setup();
    const id = await seedReady(user.accountId, { expiresAt: now() - 10 });
    const a = (await mcp("admin_takedown", { target: id, reason_code: "other" }, admin.key, E)).data.action;
    await cleanup(E);
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(id).first()).not.toBeNull();
    expect(await env.MEDIA.head(`v/${id}.mp4`)).not.toBeNull();
    await mcp("admin_restore", { action_id: a.action_id }, admin.key, E);
    await cleanup(E);
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(id).first()).toBeNull();
  });
});

describe("csam", () => {
  it("restore needs confirm: true, is logged, and the files stay held for good", async () => {
    const { admin, user, E } = await setup();
    const { id, path } = await sharedVideo(user.accountId, user.key, E);
    const a = (await mcp("admin_takedown", { target: id, reason_code: "csam" }, admin.key, E)).data.action;
    expect(a.reason_code).toBe("csam");

    for (const args of [{ action_id: a.action_id }, { action_id: a.action_id, confirm: false }]) {
      const r = await mcp("admin_restore", args, admin.key, E);
      expect(r.data.error).toBe("CONFIRM_REQUIRED");
    }
    expect((await page(path, E)).status).toBe(451);
    expect((await rows()).filter((r) => r.restores === a.action_id)).toHaveLength(0);

    const r = await mcp("admin_restore", { action_id: a.action_id, confirm: true, note: "cleared by review" }, admin.key, E);
    expect(r.isError).toBe(false);
    expect(r.data.effect).toEqual({ still_removed: false, files: "held: never deleted" });
    expect(r.data.restore_action).toMatchObject({ action: "restore", reason_code: "csam", note: "cleared by review", by: admin.accountId });
    expect((await page(path, E)).status).toBe(200);

    // Held: the owner can't delete it, nor can expiry.
    expect((await mcp("delete", { recording_id: id }, user.key, E)).data.error).toBe("RECORDING_REMOVED");
    await env.DB.prepare("UPDATE recordings SET expires_at = ? WHERE id = ?").bind(now() - 10, id).run();
    await cleanup(E);
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(id).first()).not.toBeNull();
    expect(await env.MEDIA.head(`v/${id}.mp4`)).not.toBeNull();
  });

  it("an account taken down for csam holds every recording of it", async () => {
    const { admin, user, E } = await setup();
    const id = await seedReady(user.accountId, { expiresAt: now() - 10 });
    const a = (await mcp("admin_takedown", { target: user.accountId, reason_code: "csam" }, admin.key, E)).data.action;
    expect((await mcp("admin_restore", { action_id: a.action_id }, admin.key, E)).data.error).toBe("CONFIRM_REQUIRED");
    expect((await mcp("admin_restore", { action_id: a.action_id, confirm: true }, admin.key, E)).isError).toBe(false);
    await cleanup(E);
    expect(await env.MEDIA.head(`v/${id}.mp4`)).not.toBeNull();
  });
});

describe("account takedown (suspend)", () => {
  it("can't record or share, every video is removed; restore round-trips", async () => {
    const { admin, user, E } = await setup();
    const { id, path } = await sharedVideo(user.accountId, user.key, E);
    const other = await seedReady(user.accountId);
    const t = await mcp("admin_takedown", { target: user.accountId, reason_code: "phishing" }, admin.key, E);
    expect(t.isError).toBe(false);
    expect(t.data.action).toMatchObject({ target_type: "account", target: user.accountId, account_id: user.accountId });
    expect(t.data.action.before_state).toMatchObject({ account_id: user.accountId, plan: "free", recordings: 2, shared_recordings: 1, suspended: false });

    expect((await mcp("start_recording", {}, user.key, E)).data.error).toBe("ACCOUNT_SUSPENDED");
    expect((await mcp("share_recording", { recording_id: other }, user.key, E)).data.error).toBe("ACCOUNT_SUSPENDED");
    expect((await page(path, E)).status).toBe(451);

    const r = await mcp("admin_restore", { action_id: t.data.action.action_id }, admin.key, E);
    expect(r.data.effect).toEqual({ still_suspended: false });
    expect((await page(path, E)).status).toBe(200);
    expect((await mcp("share_recording", { recording_id: other }, user.key, E)).isError).toBe(false);
    expect((await mcp("start_recording", {}, user.key, E)).data?.error).not.toBe("ACCOUNT_SUSPENDED");
    expect(id).toBeTruthy();
  });

  it("get_video tells the owner's bot the video is removed (and the account suspended) while it is", async () => {
    const { admin, user, E } = await setup();
    const { id } = await sharedVideo(user.accountId, user.key, E);
    const get = async () => (await mcp("get_video", { recording_id: id }, user.key, E)).data;
    expect((await get()).removed).toBeUndefined();
    const rt = (await mcp("admin_takedown", { target: id, reason_code: "other" }, admin.key, E)).data.action;
    expect(await get()).toMatchObject({ removed: true, note: expect.stringMatching(/removed for a policy violation.*451/) });
    expect((await get()).suspended).toBeUndefined();
    await mcp("admin_restore", { action_id: rt.action_id }, admin.key, E);
    const at = (await mcp("admin_takedown", { target: user.accountId, reason_code: "other" }, admin.key, E)).data.action;
    expect(await get()).toMatchObject({ removed: true, suspended: true, note: expect.stringMatching(/suspended/) });
    await mcp("admin_restore", { action_id: at.action_id }, admin.key, E);
    const after = await get();
    expect(after.removed).toBeUndefined();
    expect(after.visibility).toBe("public");
  });

  it("the page's own Share button (the owner, by owner link) answers 451 while suspended", async () => {
    const { admin, user, E } = await setup();
    const id = await seedReady(user.accountId);
    const ownerUrl = new URL((await mcp("get_video", { recording_id: id }, user.key, E)).data.owner_url);
    const open = await call(ownerUrl.pathname + ownerUrl.search, { headers: { "user-agent": "Mozilla/5.0 Chrome/140.0" } }, E);
    expect(open.status).toBe(303);
    const cookie = open.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const share = () =>
      call(`${ownerUrl.pathname}/share`, { method: "POST", headers: { origin: "https://rec.example", "sec-fetch-site": "same-origin", cookie } }, E);
    await mcp("admin_takedown", { target: user.accountId, reason_code: "other" }, admin.key, E);
    const res = await share();
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ error: "ACCOUNT_SUSPENDED" });
    expect((await env.DB.prepare("SELECT shared_at FROM recordings WHERE id = ?").bind(id).first<any>()).shared_at).toBeNull();
  });
});

describe("hostname takedown", () => {
  it("disables through disableDomain (451 host, linked domain action) and restore enables it", async () => {
    const { admin, user, E } = await setup();
    const h = dom();
    await insertDomain(user.accountId, h);
    const t = await mcp("admin_takedown", { target: `https://${h.toUpperCase()}/x`, reason_code: "malware" }, admin.key, E);
    expect(t.data.error ?? null, JSON.stringify(t.data)).toBeNull();
    const a = t.data.action;
    expect(a).toMatchObject({ target_type: "hostname", target: h, account_id: user.accountId, domain_action_id: expect.any(String) });
    expect(a.before_state).toMatchObject({ hostname: h, status: "active", disabled: false });
    const d = await env.DB.prepare("SELECT * FROM custom_domain_actions WHERE id = ?").bind(a.domain_action_id).first<any>();
    expect(d).toMatchObject({ hostname: h, action: "disable", reason_code: "malware", actor_account_id: admin.accountId });
    expect(JSON.parse(d.evidence)).toEqual({ admin_action_id: a.action_id });
    expect((await onHost(`https://${h}/anything`, E)).status).toBe(451);

    const r = await mcp("admin_restore", { action_id: a.action_id }, admin.key, E);
    expect(r.data.effect).toMatchObject({ hostname: "enabled", domain_action_id: expect.any(String) });
    expect((await env.DB.prepare("SELECT disabled_at FROM custom_domains WHERE hostname = ?").bind(h).first<any>()).disabled_at).toBeNull();
  });

  it("a hostname that was already disabled stays disabled after restoring this takedown", async () => {
    const { admin, user, E } = await setup();
    const h = dom();
    await insertDomain(user.accountId, h, { disabled_at: now(), disabled_reason: "other" } as Partial<CustomDomainRow>);
    const a = (await mcp("admin_takedown", { target: h, reason_code: "phishing" }, admin.key, E)).data;
    expect(a.already).toBe(true);
    // The first reason stays on the row; the new one is in both logs.
    expect((await env.DB.prepare("SELECT disabled_reason FROM custom_domains WHERE hostname = ?").bind(h).first<any>()).disabled_reason).toBe("other");
    expect((await env.DB.prepare("SELECT reason_code FROM custom_domain_actions WHERE id = ?").bind(a.action.domain_action_id).first<any>()).reason_code).toBe("phishing");
    const r = await mcp("admin_restore", { action_id: a.action.action_id }, admin.key, E);
    expect(r.data.effect.hostname).toMatch(/already disabled before/);
    expect((await env.DB.prepare("SELECT disabled_at FROM custom_domains WHERE hostname = ?").bind(h).first<any>()).disabled_at).not.toBeNull();
  });

  it("a hostname disabled again by admin_disable_custom_domain after the takedown stays disabled after restoring it", async () => {
    const { admin, user, E } = await setup();
    const h = dom();
    await insertDomain(user.accountId, h);
    const a = (await mcp("admin_takedown", { target: h, reason_code: "phishing" }, admin.key, E)).data.action;
    const d = await mcp("admin_disable_custom_domain", { hostname: h, reason: "malware" }, admin.key, E);
    expect(d.isError).toBe(false);
    const r = await mcp("admin_restore", { action_id: a.action_id }, admin.key, E);
    expect(r.isError).toBe(false);
    expect(r.data.effect).toEqual({ hostname: `left disabled: disabled again by ${d.data.action_id} after this takedown` });
    expect((await env.DB.prepare("SELECT disabled_at FROM custom_domains WHERE hostname = ?").bind(h).first<any>()).disabled_at).not.toBeNull();
    clearCustomHostCache();
    expect((await onHost(`https://${h}/anything`, E)).status).toBe(451);
    // No enable was logged for it.
    expect((await env.DB.prepare("SELECT count(*) AS n FROM custom_domain_actions WHERE hostname = ? AND action = 'enable'").bind(h).first<any>()).n).toBe(0);
  });

  it("is atomic: when the admin_actions row can't be written, the domain isn't disabled and no domain action is logged", async () => {
    const { admin, user, E } = await setup();
    const h = dom();
    await insertDomain(user.accountId, h);
    await env.DB.prepare("CREATE TRIGGER test_fail_admin_insert BEFORE INSERT ON admin_actions BEGIN SELECT RAISE(ABORT, 'test: insert failed'); END").run();
    try {
      const r = await mcp("admin_takedown", { target: h, reason_code: "phishing" }, admin.key, E);
      expect(r.isError).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_fail_admin_insert").run();
    }
    expect((await env.DB.prepare("SELECT disabled_at FROM custom_domains WHERE hostname = ?").bind(h).first<any>()).disabled_at).toBeNull();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM custom_domain_actions WHERE hostname = ?").bind(h).first<any>()).n).toBe(0);
  });

  it("admin_enable_custom_domain refuses (OPEN_TAKEDOWN) while a takedown is open, unless force: true", async () => {
    const { admin, user, E } = await setup();
    const h = dom();
    await insertDomain(user.accountId, h);
    const a = (await mcp("admin_takedown", { target: h, reason_code: "phishing" }, admin.key, E)).data.action;
    const e = await mcp("admin_enable_custom_domain", { hostname: `https://${h}/` }, admin.key, E);
    expect(e.isError).toBe(true);
    expect(e.data.error).toBe("OPEN_TAKEDOWN");
    expect(e.data.action_ids).toEqual([a.action_id]);
    expect(e.data.message).toMatch(/admin_restore/);
    clearCustomHostCache();
    expect((await onHost(`https://${h}/anything`, E)).status).toBe(451);
    const f = await mcp("admin_enable_custom_domain", { hostname: h, force: true }, admin.key, E);
    expect(f.isError).toBe(false);
    expect(f.data.changed).toBe(true);
    clearCustomHostCache();
    expect((await onHost(`https://${h}/anything`, E)).status).toBe(404);
    // After a restore there is nothing open: enabling needs no force.
    await mcp("admin_restore", { action_id: a.action_id }, admin.key, E);
    await mcp("admin_disable_custom_domain", { hostname: h, reason: "other" }, admin.key, E);
    expect((await mcp("admin_enable_custom_domain", { hostname: h }, admin.key, E)).isError).toBe(false);
  });

  for (const order of ["newest first", "oldest first"] as const) {
    it(`two takedowns of one hostname, restored ${order}: the first restore leaves it down, the second enables it`, async () => {
      const { admin, user, E } = await setup();
      const h = dom();
      await insertDomain(user.accountId, h);
      const a1 = (await mcp("admin_takedown", { target: h, reason_code: "phishing" }, admin.key, E)).data.action;
      const a2 = (await mcp("admin_takedown", { target: h, reason_code: "malware" }, admin.key, E)).data.action;
      // The second one's before-state says disabled, but only because of the first takedown.
      expect(a2.before_state).toMatchObject({ disabled: true });
      const [first, second] = order === "newest first" ? [a2, a1] : [a1, a2];
      const f = await mcp("admin_restore", { action_id: first.action_id }, admin.key, E);
      expect(f.data.effect).toEqual({ hostname: `left disabled: still taken down by ${second.action_id}` });
      clearCustomHostCache();
      expect((await onHost(`https://${h}/anything`, E)).status).toBe(451);
      const r = await mcp("admin_restore", { action_id: second.action_id }, admin.key, E);
      expect(r.data.effect).toMatchObject({ hostname: "enabled" });
      clearCustomHostCache();
      expect((await onHost(`https://${h}/anything`, E)).status).toBe(404);
    });
  }

  it("a hostname disabled by admin_disable_custom_domain between two takedowns stays disabled after restoring both", async () => {
    const { admin, user, E } = await setup();
    const h = dom();
    await insertDomain(user.accountId, h);
    const a1 = (await mcp("admin_takedown", { target: h, reason_code: "phishing" }, admin.key, E)).data.action;
    expect((await mcp("admin_disable_custom_domain", { hostname: h, reason: "malware" }, admin.key, E)).isError).toBe(false);
    const a2 = (await mcp("admin_takedown", { target: h, reason_code: "malware" }, admin.key, E)).data.action;
    expect((await mcp("admin_restore", { action_id: a1.action_id }, admin.key, E)).data.effect.hostname).toMatch(/^left disabled/);
    expect((await mcp("admin_restore", { action_id: a2.action_id }, admin.key, E)).data.effect.hostname).toMatch(/^left disabled/);
    clearCustomHostCache();
    expect((await onHost(`https://${h}/anything`, E)).status).toBe(451);
  });
});

describe("the evidence log", () => {
  it("admin_actions lists who, when, target, reason, note, before-state and reversal; target filters by account too", async () => {
    const { admin, user, E } = await setup();
    const id = await seedReady(user.accountId);
    const a = (await mcp("admin_takedown", { target: id, reason_code: "other", note: "n1" }, admin.key, E)).data.action;
    await mcp("admin_restore", { action_id: a.action_id, note: "n2" }, admin.key, E);
    const l = await mcp("admin_actions", { target: user.accountId }, admin.key, E);
    expect(l.isError).toBe(false);
    expect(l.data.count).toBe(2);
    expect(l.data.open_takedowns).toBe(0);
    const [restoreRow, takedownRow] = l.data.actions;
    expect(restoreRow).toMatchObject({ action: "restore", restores: a.action_id, note: "n2", by: admin.accountId, at: expect.any(String), before_state: expect.objectContaining({ recording_id: id, removed: true }) });
    expect(takedownRow).toMatchObject({ action_id: a.action_id, note: "n1", reversed_by: admin.accountId, reversed_at: expect.any(String), before_state: expect.objectContaining({ removed: false }) });
    expect((await mcp("admin_actions", { target: id }, admin.key, E)).data.count).toBe(2);
    expect((await mcp("admin_actions", { limit: 1 }, admin.key, E)).data.count).toBe(1);
  });

  it("migration 0031 can run again on a database that already has admin_actions (the pre-rename 0030)", async () => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0031_"));
    expect(m?.name).toBe("0031_admin_actions.sql");
    const before = await count();
    await env.DB.batch(m!.queries.map((q) => env.DB.prepare(q)));
    expect(await count()).toBe(before);
    // The triggers are still the ones in force.
    await expect(env.DB.prepare("DELETE FROM admin_actions").run()).rejects.toThrow(/append-only/);
  });

  it("is append-only: no delete, no edit, no replace, a reversal only once", async () => {
    const { admin, user, E } = await setup();
    const a = (await mcp("admin_takedown", { target: user.accountId, reason_code: "other", note: "keep" }, admin.key, E)).data.action;
    const n = await count();
    await expect(env.DB.prepare("DELETE FROM admin_actions WHERE id = ?").bind(a.action_id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE admin_actions SET note = 'changed' WHERE id = ?").bind(a.action_id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE admin_actions SET reason_code = 'csam' WHERE id = ?").bind(a.action_id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE admin_actions SET reversed_at = 1 WHERE id = ?").bind(a.action_id).run()).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO admin_actions (id, action, target_type, target_id, reason_code, before_state, actor_account_id, created_at) VALUES (?, 'takedown', 'account', 'x', 'other', '{}', 'x', 1)",
      )
        .bind(a.action_id)
        .run(),
    ).rejects.toThrow(/append-only/);
    expect(await count()).toBe(n);
    await mcp("admin_restore", { action_id: a.action_id }, admin.key, E);
    await expect(env.DB.prepare("UPDATE admin_actions SET reversed_at = 1, reversed_by = 'x' WHERE id = ?").bind(a.action_id).run()).rejects.toThrow(/append-only/);
    const restoreRow = (await rows()).find((r) => r.restores === a.action_id);
    await expect(env.DB.prepare("UPDATE admin_actions SET reversed_at = 1, reversed_by = 'x' WHERE id = ?").bind(restoreRow.id).run()).rejects.toThrow(/append-only/);
    expect((await rows()).find((r) => r.id === a.action_id)).toMatchObject({ note: "keep", reason_code: "other", reversed_by: admin.accountId });
  });
});
