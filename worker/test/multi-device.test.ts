// Several paired devices per account: Free up to 2 at once, owners unlimited; pairing keeps the other devices;
// list_devices / remove_device; commands go to one device (most recently connected online one, or `device`).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issuePairingCode, verifyDeviceToken } from "../src/auth";
import type { Env } from "../src/env";
import { hmacHex, sha256Hex } from "../src/util";
import { call, connectDevice, freshIp, mcp, seedAccount, seedDevice, withEnv } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enroll(code: string, o: { name?: string; ip?: string; device_token?: string; platform?: string } = {}, e: Env = env) {
  const { ip, ...body } = o;
  const res = await call(
    "/device/enroll",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) },
      body: JSON.stringify({ code, name: "pc", ...body }),
    },
    e,
  );
  return { status: res.status, body: (await res.json()) as any };
}

const code = async (key: string, e: Env = env) => (await mcp("get_installer", { platform: "windows" }, key, e)).data.pairing_code as string;

async function activeIds(accountId: string): Promise<string[]> {
  const r = await env.DB.prepare("SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY rowid").bind(accountId).all<{ id: string }>();
  return r.results.map((x) => x.id);
}

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("timed out");
}

describe("Free plan: up to 2 paired devices", () => {
  it("pairs device 1 and 2 and both stay valid", async () => {
    const { accountId, key } = await seedAccount(false);
    const d1 = await enroll(await code(key), { name: "Desk", platform: "windows" });
    const d2 = await enroll(await code(key), { name: "Laptop" });
    expect([d1.status, d2.status]).toEqual([200, 200]);
    expect(await activeIds(accountId)).toEqual([d1.body.device_id, d2.body.device_id]);
    expect(await verifyDeviceToken(env, d1.body.device_token)).toMatchObject({ deviceId: d1.body.device_id, accountId });
    expect(await verifyDeviceToken(env, d2.body.device_token)).toMatchObject({ deviceId: d2.body.device_id, accountId });
    // Both connect at the same time.
    const a = await connectDevice(d1.body.device_token);
    const b = await connectDevice(d2.body.device_token);
    const list = (await mcp("list_devices", {}, key)).data;
    expect(list.max_devices).toBe(2);
    expect(list.paired_devices).toHaveLength(2);
    expect(list.paired_devices.every((d: any) => d.online)).toBe(true);
    const desk = list.paired_devices.find((d: any) => d.id === d1.body.device_id);
    expect(desk).toMatchObject({ name: "Desk", platform: "windows", this_device: false });
    expect(desk.paired_at).toEqual(expect.any(Number));
    expect(desk.last_seen_at).toEqual(expect.any(Number));
    // Not reported by the recorder: the platform get_installer issued its pairing code for.
    expect(list.paired_devices.find((d: any) => d.id === d2.body.device_id).platform).toBe("windows");
    a.ws.close();
    b.ws.close();
  });

  it("a third pairing is refused with the message and changes nothing; after remove_device the same code pairs", async () => {
    const { accountId, key } = await seedAccount(false);
    const d1 = (await enroll(await code(key))).body;
    const d2 = (await enroll(await code(key))).body;
    const third = await code(key);
    // get_installer warns up front.
    const inst = (await mcp("get_installer", { platform: "windows" }, key)).data;
    expect(inst).toMatchObject({ paired_devices: 2, max_devices: 2 });
    expect(inst.device_limit).toMatch(/already has 2 paired devices/);

    const before = await env.DB.prepare("SELECT id, revoked_at, last_seen_at FROM devices WHERE account_id = ? ORDER BY id").bind(accountId).all();
    const refused = await enroll(third);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("device_limit");
    expect(refused.body.max_devices).toBe(2);
    expect(refused.body.message).toBe(
      "This account already has 2 paired devices, the most the Free plan allows. Remove one first (remove_device; list_devices shows them), then pair this PC again.",
    );
    expect(refused.body.device_token).toBeUndefined();
    const after = await env.DB.prepare("SELECT id, revoked_at, last_seen_at FROM devices WHERE account_id = ? ORDER BY id").bind(accountId).all();
    expect(after.results).toEqual(before.results);
    const pc = await env.DB.prepare("SELECT used_at, device_id FROM pairing_codes WHERE code_hash = ?").bind(await sha256Hex(third)).first();
    expect(pc).toEqual({ used_at: null, device_id: null });

    const rm = await mcp("remove_device", { device: d1.device_id }, key);
    expect(rm.isError).toBe(false);
    expect(rm.data.removed.id).toBe(d1.device_id);
    expect(rm.data.removed_this_device).toBe(false);
    expect(rm.data.paired_devices.map((d: any) => d.id)).toEqual([d2.device_id]);

    const ok = await enroll(third);
    expect(ok.status).toBe(200);
    expect(await activeIds(accountId)).toEqual([d2.device_id, ok.body.device_id]);
    expect((await enroll(third)).status).toBe(401); // still single use
  });

  it("a refused pairing does not count as a failed auth attempt", async () => {
    const { key } = await seedAccount(false);
    await enroll(await code(key));
    await enroll(await code(key));
    const ip = freshIp();
    for (let i = 0; i < 12; i++) expect((await enroll(await code(key), { ip })).status).toBe(409);
  });

  it("re-pairing a PC that is already paired replaces its own pairing, also at the limit", async () => {
    const { accountId, key } = await seedAccount(false);
    const d1 = (await enroll(await code(key), { name: "Desk" })).body;
    const ip = freshIp();
    const d2 = (await enroll(await code(key), { name: "Laptop" })).body;
    // With its current token (recorders that send it).
    const again = await enroll(await code(key), { name: "Desk", device_token: d1.device_token });
    expect(again.status).toBe(200);
    // Same platform (neither reported one, so both "windows"): the device row is reused with a new token.
    expect(again.body.device_id).toBe(d1.device_id);
    expect(await activeIds(accountId)).toEqual([d1.device_id, d2.device_id]);
    expect(await verifyDeviceToken(env, d1.device_token)).toBeNull();
    // Older recorders: same name, network and platform as an active device that is offline.
    const ipHash = await hmacHex(env.IP_HASH_KEY, `ip:${ip}`);
    await env.DB.prepare("UPDATE devices SET ip_hash = ? WHERE id = ?").bind(ipHash, d2.device_id).run();
    const re = await enroll(await code(key), { name: "Laptop", ip });
    expect(re.status).toBe(200);
    expect(await activeIds(accountId)).toEqual([again.body.device_id, re.body.device_id]);
    // Same name, other network: a different PC, refused at the limit.
    expect((await enroll(await code(key), { name: "Laptop", ip: freshIp() })).status).toBe(409);
    // A token from another account does not free a slot here.
    const other = await seedAccount();
    expect((await enroll(await code(key), { name: "x", device_token: other.deviceToken })).status).toBe(409);
  });

  it("owner accounts pair 5 devices", async () => {
    const { accountId, key } = await seedAccount(false);
    const owner = withEnv({ OWNER_ACCOUNT_IDS: accountId });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await enroll(await code(key, owner), { name: `pc${i}` }, owner);
      expect(r.status).toBe(200);
      ids.push(r.body.device_id);
    }
    expect(await activeIds(accountId)).toEqual(ids);
    const list = (await mcp("list_devices", {}, key, owner)).data;
    expect(list.max_devices).toBeNull();
    expect(list.paired_devices).toHaveLength(5);
    expect((await mcp("get_installer", { platform: "windows" }, key, owner)).data.device_limit).toBeUndefined();
  });

  // accountLimits is async (it reads accounts.plan): every caller must await it or max_devices is undefined and the
  // Free cap disappears. Enroll, get_installer, device_status and list_devices all follow the plan.
  for (const [plan, max] of [["free", 2], ["pro", null], ["owner", null]] as const) {
    it(`accounts.plan '${plan}': a third pairing is ${max === null ? "allowed" : "refused"}, every tool reports max_devices ${max}`, async () => {
      const { accountId, key } = await seedAccount(false);
      await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, accountId).run();
      expect((await enroll(await code(key), { name: "pc1" })).status).toBe(200);
      expect((await enroll(await code(key), { name: "pc2" })).status).toBe(200);
      const inst = (await mcp("get_installer", { platform: "windows" }, key)).data;
      expect(inst.max_devices).toBe(max);
      const third = await enroll(inst.pairing_code, { name: "pc3" });
      expect((await mcp("device_status", {}, key)).data.max_devices).toBe(max);
      if (max === null) {
        expect(inst.device_limit).toBeUndefined();
        expect(third.status).toBe(200);
        expect(await activeIds(accountId)).toHaveLength(3);
      } else {
        expect(inst.device_limit).toMatch(/already has 2 paired devices/);
        expect(third.status).toBe(409);
        expect(third.body).toMatchObject({ error: "device_limit", max_devices: 2 });
        expect(await activeIds(accountId)).toHaveLength(2);
      }
      const list = (await mcp("list_devices", {}, key)).data;
      expect(list.max_devices).toBe(max);
      expect(list.paired_devices).toHaveLength(max ?? 3);
    });
  }
});

describe("token-less re-pair (same name + public IP)", () => {
  // Owner account: no device limit, so "add a new device" is never refused.
  async function setup(first: { platform?: string } = {}) {
    const { accountId, key } = await seedAccount(false);
    const owner = withEnv({ OWNER_ACCOUNT_IDS: accountId });
    const ip = freshIp();
    const old = (await enroll(await code(key, owner), { name: "DESKTOP-EXAMPLE", ...first }, owner)).body;
    // Connecting records the socket's IP, so the old device's public IP is pinned right before re-pairing.
    const repair = async (o: { platform?: string } = {}) => {
      await env.DB.prepare("UPDATE devices SET ip_hash = ? WHERE id = ?").bind(await hmacHex(env.IP_HASH_KEY, `ip:${ip}`), old.device_id).run();
      return (await enroll(await code(key, owner), { name: "DESKTOP-EXAMPLE", ip, ...o }, owner)).body;
    };
    return { accountId, key, owner, ip, old, repair };
  }

  it("does not revoke a connected device: a new device is added", async () => {
    const { accountId, key, owner, old, repair } = await setup();
    const live = await connectDevice(old.device_token);
    let closed = false;
    live.ws.addEventListener("close", () => (closed = true));
    const re = await repair();
    expect(re.device_id).not.toBe(old.device_id);
    expect(await activeIds(accountId)).toEqual([old.device_id, re.device_id]);
    expect(await verifyDeviceToken(env, old.device_token)).not.toBeNull();
    await sleep(20);
    expect(closed).toBe(false);
    live.ws.close();
    await waitFor(async () => !(await mcp("device_status", { device: old.device_id }, key, owner)).data.online);
  });

  it("does not revoke a device of another platform, even offline", async () => {
    const { accountId, old, repair } = await setup({ platform: "macos" });
    const re = await repair({ platform: "windows" });
    expect(await activeIds(accountId)).toEqual([old.device_id, re.device_id]);
    expect(await verifyDeviceToken(env, old.device_token)).not.toBeNull();
  });

  it("replaces an offline device with the same name, IP and platform", async () => {
    const { accountId, old, repair } = await setup({ platform: "windows" });
    const re = await repair();
    expect(re.device_id).not.toBe(old.device_id);
    expect(await activeIds(accountId)).toEqual([re.device_id]);
    expect(await verifyDeviceToken(env, old.device_token)).toBeNull();
  });

  it("the Mac recorder reports no platform: the pairing code's (macos) is compared, so a Mac replaces its offline twin", async () => {
    const { accountId, ip, old, repair } = await setup({ platform: "macos" });
    const ipHash = await hmacHex(env.IP_HASH_KEY, `ip:${ip}`);
    await env.DB.prepare("UPDATE devices SET ip_hash = ? WHERE id = ?").bind(ipHash, old.device_id).run();
    const mac = await issuePairingCode(env, accountId, 600, "macos");
    const re = (await enroll(mac.code, { name: "DESKTOP-EXAMPLE", ip })).body;
    expect(re.device_id).not.toBe(old.device_id);
    expect(await activeIds(accountId)).toEqual([re.device_id]);
    expect(await verifyDeviceToken(env, old.device_token)).toBeNull();
    expect((await env.DB.prepare("SELECT platform FROM devices WHERE id = ?").bind(re.device_id).first<{ platform: string }>())!.platform).toBe("macos");
    // A Windows code with no reported platform does not replace that Mac.
    await env.DB.prepare("UPDATE devices SET ip_hash = ? WHERE id = ?").bind(ipHash, re.device_id).run();
    const w = await repair();
    expect(await activeIds(accountId)).toEqual([re.device_id, w.device_id]);
  });
});

describe("device_status: revoked devices", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it("an active device has revoked_at and revoke_reason null", async () => {
    const acct = await seedAccount();
    const s = (await mcp("device_status", { device: acct.deviceId }, acct.key)).data;
    expect(s.revoked).toBeUndefined();
    expect(s.device).toMatchObject({ id: acct.deviceId, revoked_at: null, revoke_reason: null });
  });

  it("remove_device: user_revoked, by id or name; with no device paired it is the one reported", async () => {
    const acct = await seedAccount();
    await mcp("remove_device", { device: acct.deviceId! }, acct.key);
    const s = (await mcp("device_status", { device: acct.deviceId }, acct.key)).data;
    expect(s).toMatchObject({ paired: false, online: false, revoked: true, paired_devices: 0 });
    expect(s.device).toMatchObject({ id: acct.deviceId, name: "test pc", platform: "windows", revoke_reason: "user_revoked" });
    expect(s.device.revoked_at).toMatch(ISO);
    expect(s.note).toMatch(/get_installer/);
    expect((await mcp("device_status", { device: "TEST PC" }, acct.key)).data.device.id).toBe(acct.deviceId);
    expect((await mcp("device_status", {}, acct.key)).data.device).toMatchObject({ id: acct.deviceId, revoke_reason: "user_revoked" });
  });

  it("a token-less re-pair: replaced_by_repair, while the account still has the new device paired", async () => {
    const { accountId, key } = await seedAccount(false);
    const ip = freshIp();
    const old = (await enroll(await code(key), { name: "Desk" })).body;
    await env.DB.prepare("UPDATE devices SET ip_hash = ? WHERE id = ?").bind(await hmacHex(env.IP_HASH_KEY, `ip:${ip}`), old.device_id).run();
    const re = (await enroll(await code(key), { name: "Desk", ip })).body;
    expect(await activeIds(accountId)).toEqual([re.device_id]);
    const s = (await mcp("device_status", { device: old.device_id }, key)).data;
    expect(s).toMatchObject({ paired: true, revoked: true, paired_devices: 1 });
    expect(s.device).toMatchObject({ id: old.device_id, revoke_reason: "replaced_by_repair" });
    // By name the paired device wins.
    expect((await mcp("device_status", { device: "Desk" }, key)).data.device).toMatchObject({ id: re.device_id, revoke_reason: null });
  });

  it("uninstall_recorder: uninstalled; another account's revoked device is not found", async () => {
    const acct = await seedAccount();
    await mcp("uninstall_recorder", { device_id: acct.deviceId! }, acct.key);
    const s = (await mcp("device_status", { device: acct.deviceId }, acct.key)).data;
    expect(s.device).toMatchObject({ id: acct.deviceId, name: "test pc", platform: "windows", revoke_reason: "uninstalled" });
    expect(s.device.revoked_at).toMatch(ISO);
    const other = await seedAccount();
    expect((await mcp("device_status", { device: acct.deviceId }, other.key)).data.error).toBe("DEVICE_NOT_FOUND");
    expect((await mcp("device_status", { device: "nope" }, acct.key)).data).toMatchObject({ paired: false, device: null });
  });
});

describe("remove_device", () => {
  it("revokes the device's key at once and disconnects it; the other device keeps working", async () => {
    const acct = await seedAccount();
    const other = await seedDevice(acct.accountId, "Laptop");
    const a = await connectDevice(acct.deviceToken!);
    const b = await connectDevice(other.token);
    const closed = new Promise<number>((r) => a.ws.addEventListener("close", (ev) => r(ev.code)));
    const rm = await mcp("remove_device", { device: "test pc" }, acct.key);
    expect(rm.data.removed).toMatchObject({ id: acct.deviceId, name: "test pc" });
    expect(await closed).toBe(4001);
    expect(await verifyDeviceToken(env, acct.deviceToken!)).toBeNull();
    const ws = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${acct.deviceToken}` } });
    expect(ws.status).toBe(401);
    expect(await verifyDeviceToken(env, other.token)).not.toBeNull();
    const r = await mcp("start_recording", { max_seconds: 10 }, acct.key);
    expect(r.isError).toBe(false);
    expect(r.data.device).toBe(other.deviceId);
    // Removing it again: not a paired device any more.
    expect((await mcp("remove_device", { device: acct.deviceId! }, acct.key)).data.error).toBe("DEVICE_NOT_FOUND");
    b.ws.close();
  });

  it("fails a recording in progress on the removed device", async () => {
    const acct = await seedAccount();
    const a = await connectDevice(acct.deviceToken!);
    const rec = (await mcp("start_recording", { max_seconds: 10 }, acct.key)).data;
    await mcp("remove_device", { device: acct.deviceId! }, acct.key);
    const row = await env.DB.prepare("SELECT status, error FROM recordings WHERE id = ?").bind(rec.recording_id).first();
    expect(row).toEqual({ status: "failed", error: "DEVICE_REMOVED" });
    a.ws.close();
  });

  it("removing the device the call comes from works and says so", async () => {
    const acct = await seedAccount();
    await seedDevice(acct.accountId, "Laptop");
    const ip = freshIp();
    await env.DB.prepare("UPDATE devices SET ip_hash = ? WHERE id = ?").bind(await hmacHex(env.IP_HASH_KEY, `ip:${ip}`), acct.deviceId).run();
    const hdr = { "cf-connecting-ip": ip };
    const list = (await mcp("list_devices", {}, acct.key, env, hdr)).data;
    expect(list.paired_devices.find((d: any) => d.this_device).id).toBe(acct.deviceId);
    const rm = await mcp("remove_device", { device: acct.deviceId! }, acct.key, env, hdr);
    expect(rm.isError).toBe(false);
    expect(rm.data.removed_this_device).toBe(true);
    expect(rm.data.note).toMatch(/the device this call came from/);
    expect(await verifyDeviceToken(env, acct.deviceToken!)).toBeNull();
  });

  it("unknown or ambiguous names list the candidates", async () => {
    const acct = await seedAccount();
    await seedDevice(acct.accountId, "test laptop");
    const amb = await mcp("remove_device", { device: "test" }, acct.key);
    expect(amb.data).toMatchObject({ error: "DEVICE_AMBIGUOUS", field: "device" });
    expect(amb.data.candidates).toHaveLength(2);
    expect((await mcp("remove_device", { device: "mac" }, acct.key)).data.error).toBe("DEVICE_NOT_FOUND");
    expect(await activeIds(acct.accountId)).toHaveLength(2);
  });
});

describe("commands with several devices", () => {
  it("go to the most recently connected online device unless `device` names one", async () => {
    const acct = await seedAccount();
    const laptop = await seedDevice(acct.accountId, "Laptop");
    const desk = await connectDevice(acct.deviceToken!);
    await sleep(20);
    const lap = await connectDevice(laptop.token);

    const r1 = await mcp("start_recording", { max_seconds: 10 }, acct.key);
    expect(r1.data).toMatchObject({ device: laptop.deviceId, device_name: "Laptop" });
    await waitFor(async () => lap.frames.some((f) => f.type === "start"));
    expect(lap.frames.find((f) => f.type === "start")).toMatchObject({ recording_id: r1.data.recording_id, device_id: laptop.deviceId });
    expect(desk.frames.some((f) => f.type === "start")).toBe(false);
    expect((await mcp("device_status", {}, acct.key)).data.device.id).toBe(laptop.deviceId);
    expect((await mcp("list_devices", {}, acct.key)).data.paired_devices[0].id).toBe(laptop.deviceId);

    const r2 = await mcp("start_recording", { max_seconds: 10, device: acct.deviceId }, acct.key);
    expect(r2.data.device).toBe(acct.deviceId);
    await waitFor(async () => desk.frames.some((f) => f.type === "start"));
    expect(desk.frames.find((f) => f.type === "start").recording_id).toBe(r2.data.recording_id);

    const r3 = await mcp("start_recording", { max_seconds: 10, device: "test pc" }, acct.key);
    expect(r3.data.device).toBe(acct.deviceId);

    // stop goes to the device that is recording it.
    await mcp("stop_recording", { recording_id: r1.data.recording_id }, acct.key);
    await waitFor(async () => lap.frames.some((f) => f.type === "stop"));
    expect(desk.frames.some((f) => f.type === "stop")).toBe(false);

    // Offline: the named device is reported, the other one offered.
    lap.ws.close();
    await waitFor(async () => !(await mcp("device_status", { device: laptop.deviceId }, acct.key)).data.online);
    const off = await mcp("start_recording", { max_seconds: 10, device: laptop.deviceId }, acct.key);
    expect(off.data).toMatchObject({ error: "DEVICE_OFFLINE", device: laptop.deviceId });
    expect(off.data.message).toContain(acct.deviceId);
    // The default falls back to the device that is still online.
    expect((await mcp("start_recording", { max_seconds: 10 }, acct.key)).data.device).toBe(acct.deviceId);
    expect((await mcp("start_recording", { device: "nope" }, acct.key)).data).toMatchObject({ error: "DEVICE_NOT_FOUND", field: "device" });
    desk.ws.close();
  });

  it("last_seen_at is set when a device connects", async () => {
    const acct = await seedAccount();
    const d = await connectDevice(acct.deviceToken!);
    const row = await env.DB.prepare("SELECT last_seen_at FROM devices WHERE id = ?").bind(acct.deviceId).first<{ last_seen_at: number | null }>();
    expect(row!.last_seen_at).toEqual(expect.any(Number));
    d.ws.close();
  });
});
