// admin_lookup (admin-tools.ts): one account by email, username or account id. Owner-only, read-only, no secrets.
import { env } from "cloudflare:test";
import { deviceHub } from "../src/device-hub";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { now, randomId } from "../src/util";
import { call, connectDevice, mcp, seedAccount, seedDevice, seedReady, withEnv } from "./helpers";

async function setup() {
  const admin = await seedAccount(false);
  const user = await seedAccount();
  const name = `u${randomId(40).toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 20);
  const email = `${name}@Example.com`;
  await env.DB.prepare(
    "UPDATE accounts SET username = ?, email = ?, plan = 'pro', plan_status = 'active', stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?",
  )
    .bind(name, email, `cus_${name}`, `sub_${name}`, user.accountId)
    .run();
  const E = withEnv({ OWNER_ACCOUNT_IDS: admin.accountId });
  return { admin, user, name, email, E };
}

async function rawCall(name: string, args: Record<string, unknown>, key: string, e: Env) {
  const res = await call(
    "/mcp",
    { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }) },
    e,
  );
  return (await res.json()) as any;
}

describe("admin_lookup", () => {
  it("is the operator's only: listed for them, the unknown-tool error for anyone else", async () => {
    const { admin, user, E } = await setup();
    const list = async (key: string) =>
      (
        (await (
          await call("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, E)
        ).json()) as any
      ).result.tools.map((t: { name: string }) => t.name);
    expect(await list(admin.key)).toContain("admin_lookup");
    expect(await list(user.key)).not.toContain("admin_lookup");
    const r = await rawCall("admin_lookup", { account_id: user.accountId }, user.key, E);
    const unknown = await rawCall("admin_nonexistent", {}, user.key, E);
    expect(r.error).toEqual({ code: -32602, message: "Unknown tool: admin_lookup" });
    expect(JSON.stringify(r).replace("admin_lookup", "X")).toBe(JSON.stringify(unknown).replace("admin_nonexistent", "X"));
  });

  it("finds the same account by account_id, username, signup email and verified email (any case)", async () => {
    const { admin, user, name, email, E } = await setup();
    const by = async (args: Record<string, unknown>) => (await mcp("admin_lookup", args, admin.key, E)).data.account?.account_id;
    expect(await by({ account_id: user.accountId })).toBe(user.accountId);
    expect(await by({ username: name.toUpperCase() })).toBe(user.accountId);
    expect(await by({ email: email.toUpperCase() })).toBe(user.accountId);
    // The verified sign-in email wins over another account's unverified signup email.
    const other = await seedAccount(false);
    const verified = `v${name}@example.org`;
    await env.DB.prepare("UPDATE accounts SET email = ? WHERE id = ?").bind(verified, other.accountId).run();
    await env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(verified, user.accountId, now()).run();
    expect(await by({ email: verified })).toBe(user.accountId);
  });

  it("exactly one of email, username, account_id; unknown = NOT_FOUND; shared unverified email = AMBIGUOUS", async () => {
    const { admin, user, name, email, E } = await setup();
    for (const args of [{}, { username: name, account_id: user.accountId }]) {
      expect((await mcp("admin_lookup", args, admin.key, E)).data.error).toBe("INVALID_ARGUMENTS");
    }
    expect((await mcp("admin_lookup", { username: "nobody-here-xyz" }, admin.key, E)).data.error).toBe("NOT_FOUND");
    const twin = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET email = ? WHERE id = ?").bind(email.toLowerCase(), twin.accountId).run();
    const r = await mcp("admin_lookup", { email }, admin.key, E);
    expect(r.data.error).toBe("AMBIGUOUS");
    expect(r.data.candidates.map((c: any) => c.account_id).sort()).toEqual([user.accountId, twin.accountId].sort());
  });

  it("two accounts with the same verified sign-in email (differing in case): AMBIGUOUS, not a silent pick", async () => {
    const { admin, user, name, E } = await setup();
    const other = await seedAccount(false);
    const v = `s${name}@example.org`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(v, user.accountId, now()),
      env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(v.toUpperCase(), other.accountId, now()),
    ]);
    const r = await mcp("admin_lookup", { email: v }, admin.key, E);
    expect(r.data.error).toBe("AMBIGUOUS");
    expect(r.data.message).toMatch(/verified sign-in/);
    expect(r.data.candidates.map((c: any) => c.account_id).sort()).toEqual([user.accountId, other.accountId].sort());
  });

  it("plan, status, stripe ids, usage, devices, recordings, custom domain and open actions; no secrets", async () => {
    const { admin, user, name, E } = await setup();
    const a = await seedReady(user.accountId, { transcript: { segments: [{ start: 0, end: 1, text: "secret words said" }] } });
    const b = await seedReady(user.accountId, { createdAt: now() + 5 });
    await env.DB.prepare("UPDATE recordings SET bytes = 1000, audio_bytes = 24 WHERE id = ?").bind(a).run();
    expect((await mcp("share_recording", { recording_id: a }, user.key, E)).isError).toBe(false);
    const t = now();
    await env.DB.prepare("INSERT INTO custom_domains (id, account_id, hostname, status, live_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
      .bind(randomId(128), user.accountId, `${name}.example.net`, t, t, t)
      .run();
    const td = (await mcp("admin_takedown", { target: b, reason_code: "other", note: "look" }, admin.key, E)).data.action;

    const r = await mcp("admin_lookup", { account_id: user.accountId }, admin.key, E);
    expect(r.isError).toBe(false);
    const d = r.data;
    expect(d.account).toMatchObject({ account_id: user.accountId, username: name, email: `${name[0]}***@Example.com` });
    expect(d.plan).toMatchObject({ plan: "pro", tier: "pro", plan_status: "active" });
    expect(d.status).toBe("active");
    expect(d.retention_hold).toBe(false);
    expect(d.stripe).toEqual({ customer_id: `cus_${name}`, subscription_id: `sub_${name}` });
    expect(d.usage).toMatchObject({ recordings: 2, shared_recordings: 1, storage_used_bytes: 1024 });
    expect(d.devices).toHaveLength(1);
    expect(d.devices[0]).toEqual({
      device_id: user.deviceId,
      name: "test pc",
      platform: "windows",
      created_at: expect.any(String),
      last_seen_at: null,
      revoked_at: null,
      online: false,
      version: null,
      last_recording_at: null,
    });
    expect(d.version_source).toMatch(/stores no recorder version/);
    const newest = (await env.DB.prepare("SELECT max(created_at) AS t FROM recordings WHERE account_id = ?").bind(user.accountId).first<{ t: number }>())!.t;
    expect(d.last_recording_at).toBe(new Date(newest * 1000).toISOString());
    expect(d.failed_recordings).toBe(0);
    expect(d.recent_errors).toEqual([]);
    expect(d.recent_recordings.map((x: any) => x.recording_id)).toEqual([b, a]);
    expect(d.recent_recordings[0]).toEqual({ recording_id: b, title: "Demo", status: "ready", created_at: expect.any(String), shared: false, removed: true });
    expect(d.recent_recordings[1]).toMatchObject({ recording_id: a, shared: true, removed: false });
    expect(d.custom_domains).toEqual([expect.objectContaining({ hostname: `${name}.example.net`, status: "active", live: true })]);
    expect(d.open_admin_actions).toEqual([expect.objectContaining({ action_id: td.action_id, target: b, reason_code: "other", reversed_at: null })]);

    const s = JSON.stringify(d);
    expect(s).not.toMatch(/\bark_|\bardt_|https?:\/\/|token|key_hash|passcode_hash|secret words|segments/);
    expect(s).not.toContain(`${name}@`);

    await mcp("admin_takedown", { target: user.accountId, reason_code: "phishing" }, admin.key, E);
    expect((await mcp("admin_lookup", { username: name }, admin.key, E)).data.status).toBe("suspended");
  });

  it("per device: online and the version it announced, last seen, last recording; recent errors redacted then trimmed", async () => {
    const { admin, user, E } = await setup();
    const second = await seedDevice(user.accountId, "laptop");
    const dev = await connectDevice(user.deviceToken!);
    dev.ws.send(JSON.stringify({ type: "hello", version: "0.9.1", features: [] }));
    for (let i = 0; i < 50 && !(await deviceHub(env, user.accountId).recorderInfo(user.accountId, user.deviceId))?.version; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const t = now();
    const rec = (id: string, device: string, created: number, status: string, error: string | null) =>
      env.DB.prepare(
        "INSERT INTO recordings (id, account_id, device_id, title, status, max_seconds, created_at, expires_at, error) VALUES (?, ?, ?, 'x', ?, 60, ?, ?, ?)",
      )
        .bind(id, user.accountId, device, status, created, created + 86400, error)
        .run();
    // A secret that straddles the 300-character edge: redacting first still removes all of it.
    const secret = `ark_${"A".repeat(20)}_${"B".repeat(30)}`;
    const long = `${"x".repeat(280)} ${secret} tail`;
    const failed = randomId(128);
    await rec(randomId(128), user.deviceId!, t - 100, "ready", null);
    await rec(failed, user.deviceId!, t - 50, "failed", long);
    await rec(randomId(128), second.deviceId, t - 200, "ready", null);

    const d = (await mcp("admin_lookup", { account_id: user.accountId }, admin.key, E)).data;
    const byId = (id: string) => d.devices.find((x: any) => x.device_id === id);
    expect(byId(user.deviceId!)).toMatchObject({ online: true, version: "0.9.1", last_seen_at: expect.any(String), last_recording_at: new Date((t - 50) * 1000).toISOString() });
    expect(byId(second.deviceId)).toMatchObject({ online: false, version: null, last_seen_at: null, last_recording_at: new Date((t - 200) * 1000).toISOString() });
    expect(d.last_recording_at).toBe(new Date((t - 50) * 1000).toISOString());
    expect(d.failed_recordings).toBe(1);
    expect(d.recent_errors).toEqual([
      { recording_id: failed, device_id: user.deviceId, status: "failed", error: expect.any(String), transcript_status: expect.any(String), created_at: new Date((t - 50) * 1000).toISOString() },
    ]);
    expect(d.recent_errors[0].error.length).toBeLessThanOrEqual(300);
    expect(d.recent_errors[0].error).toContain("ark_[REDACTED]");
    expect(d.recent_errors[0].error).not.toMatch(/AAAA|BBBB/);
    dev.ws.close();
  });
});
