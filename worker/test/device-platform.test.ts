// A device's platform: what the recorder reports is stored and kept; an inferred one (the pairing code's, or 0017's
// backfill of null rows to "windows", which also caught Macs) is corrected on a token re-pair instead of leaving a stale
// "windows" row next to a new Mac row; a platform nobody knows stays null and is never shown or used as "windows".
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issuePairingCode } from "../src/auth";
import { randomId, sha256Hex } from "../src/util";
import { call, mcp, seedAccount } from "./helpers";

async function enroll(code: string, body: Record<string, unknown> = {}) {
  const res = await call("/device/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "Office Mac", ...body }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const row = (id: string) =>
  env.DB.prepare("SELECT platform, platform_reported FROM devices WHERE id = ?").bind(id).first<{ platform: string | null; platform_reported: number | null }>();
const active = async (accountId: string) =>
  (await env.DB.prepare("SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL").bind(accountId).all<{ id: string }>()).results.map((r) => r.id);

/** A pairing code with no platform (as before 0014): nothing says what will enroll with it. */
async function codeWithoutPlatform(accountId: string): Promise<string> {
  const code = randomId(96);
  await env.DB.prepare("INSERT INTO pairing_codes (code_hash, account_id, expires_at, platform) VALUES (?, ?, ?, NULL)")
    .bind(await sha256Hex(code), accountId, Math.floor(Date.now() / 1000) + 600)
    .run();
  return code;
}

describe("device platform", () => {
  it("the recorder's own platform is stored as reported", async () => {
    const { accountId, key } = await seedAccount(false);
    const win = await issuePairingCode(env, accountId, 600, "windows");
    const m = (await enroll(win.code, { platform: "macos" })).body;
    expect(await row(m.device_id)).toEqual({ platform: "macos", platform_reported: 1 });
    const list = (await mcp("list_devices", {}, key)).data;
    expect(list.paired_devices.find((d: any) => d.id === m.device_id).platform).toBe("macos");
  });

  it("a Mac recorded as windows (0017 backfill) re-pairs with its token: same device, now macos, no stale windows row", async () => {
    const { accountId, key } = await seedAccount(false);
    const first = (await enroll((await issuePairingCode(env, accountId, 600, "macos")).code)).body;
    // What production has: the row says windows and nothing says the recorder reported it.
    await env.DB.prepare("UPDATE devices SET platform = 'windows', platform_reported = NULL WHERE id = ?").bind(first.device_id).run();
    expect((await mcp("list_devices", {}, key)).data.paired_devices[0].platform).toBe("windows");

    const again = await enroll((await issuePairingCode(env, accountId, 600, "macos")).code, { platform: "macos", device_token: first.device_token });
    expect(again.status).toBe(200);
    expect(again.body.device_id).toBe(first.device_id);
    expect(await active(accountId)).toEqual([first.device_id]);
    expect(await row(first.device_id)).toEqual({ platform: "macos", platform_reported: 1 });
    const list = (await mcp("list_devices", {}, key)).data;
    expect(list.paired_devices).toHaveLength(1);
    expect(list.paired_devices[0]).toMatchObject({ id: first.device_id, platform: "macos" });
  });

  it("an older Mac recorder (reports none) re-pairing with its token and a macos code also fixes an inferred windows row", async () => {
    const { accountId } = await seedAccount(false);
    const first = (await enroll((await issuePairingCode(env, accountId, 600, "windows")).code)).body;
    expect(await row(first.device_id)).toEqual({ platform: "windows", platform_reported: null });
    const again = (await enroll((await issuePairingCode(env, accountId, 600, "macos")).code, { device_token: first.device_token })).body;
    expect(again.device_id).toBe(first.device_id);
    expect(await row(first.device_id)).toEqual({ platform: "macos", platform_reported: null });
  });

  it("a reported platform is kept: a later re-pair that reports none leaves it, another reported platform is a new device", async () => {
    const { accountId } = await seedAccount(false);
    const m = (await enroll((await issuePairingCode(env, accountId, 600, "macos")).code, { platform: "macos" })).body;
    const same = (await enroll((await issuePairingCode(env, accountId, 600, "macos")).code, { device_token: m.device_token })).body;
    expect(same.device_id).toBe(m.device_id);
    expect(await row(m.device_id)).toEqual({ platform: "macos", platform_reported: 1 });
    const other = (await enroll((await issuePairingCode(env, accountId, 600, "windows")).code, { device_token: same.device_token })).body;
    expect(other.device_id).not.toBe(m.device_id);
    expect(await row(m.device_id)).toEqual({ platform: "macos", platform_reported: 1 });
  });

  it("nothing says the platform: stored and listed as null (not windows); get_installer asks; update_recorder says PLATFORM_UNKNOWN", async () => {
    const { accountId, key } = await seedAccount(false);
    const d = (await enroll(await codeWithoutPlatform(accountId))).body;
    expect(await row(d.device_id)).toEqual({ platform: null, platform_reported: null });

    const list = (await mcp("list_devices", {}, key)).data;
    expect(list.paired_devices[0]).toMatchObject({ id: d.device_id, platform: null });
    expect((await mcp("device_status", {}, key)).data.device.platform).toBeNull();

    const inst = await mcp("get_installer", {}, key);
    expect(inst.data).toMatchObject({ needs_choice: true, devices: [{ device_id: d.device_id, name: "Office Mac", platform: null }] });
    expect(inst.data.note).toContain("A paired device's platform is unknown.");
    expect(inst.data).not.toHaveProperty("command");

    const up = await mcp("update_recorder", {}, key);
    expect(up.isError).toBe(true);
    expect(up.data).toMatchObject({ error: "PLATFORM_UNKNOWN", device: d.device_id, platform: null });
    expect(up.data.message).toMatch(/Windows PC or a Mac/);

    // Re-pairing it with a reported platform fills it in on the same row.
    const again = (await enroll((await issuePairingCode(env, accountId, 600, "macos")).code, { platform: "macos", device_token: d.device_token })).body;
    expect(again.device_id).toBe(d.device_id);
    expect((await mcp("list_devices", {}, key)).data.paired_devices[0].platform).toBe("macos");
  });
});
