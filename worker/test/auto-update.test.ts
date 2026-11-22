// Silent recorder auto-update: the hub sends the signed update command on hello to self_update recorders that are
// behind, at most once per device and version per window, and stops after AUTO_UPDATE.maxFailures failures.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTO_UPDATE, type AutoUpdateStatus } from "../src/auto-update";
import { canonicalCommand, deviceCommandKey, deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import { INSTALL_PS1_SHA256, INSTALL_SH_SHA256, RECORDER_MAC_VERSION, RECORDER_VERSION } from "../src/generated";
import { LIMITS } from "../src/env";
import { verifyInstallerToken } from "../src/installer";
import { hmacHex, now } from "../src/util";
import { connectDevice, mcp, ORIGIN, seedAccount } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 0.6.1's features (no signed_update): the hash-pinned update path. Signed updates: signed-update.test.ts.
const ALL = RECORDER_FEATURES.filter((f) => f !== "signed_update");
const OLD = ALL.filter((f) => f !== "self_update");
const BEHIND = "0.0.1";

type Rec = { accountId: string; key: string; deviceId: string; deviceToken: string };

async function account(platform: string | null = "windows"): Promise<Rec> {
  const a = await seedAccount();
  if (platform !== "windows") await env.DB.prepare("UPDATE devices SET platform = ? WHERE id = ?").bind(platform, a.deviceId!).run();
  return a as Rec;
}

/** Connects (again) and says hello; waits until the hub has handled it (its auto-update included). */
async function hello(a: Rec, version: string, features: string[] = ALL) {
  const dev = await connectDevice(a.deviceToken);
  dev.ws.send(JSON.stringify({ type: "hello", version, features }));
  const hub = deviceHub(env, a.accountId);
  for (let i = 0; i < 50 && (await hub.recorderInfo(a.accountId, a.deviceId))?.version !== version; i++) await sleep(10);
  await sleep(100);
  return dev;
}

const updates = (frames: any[]) => frames.filter((f) => f.type === "update");
const status = (a: Rec) => deviceHub(env, a.accountId).autoUpdate(a.accountId, a.deviceId);
const linkExp = async (url: string) => {
  const v = await verifyInstallerToken(env, new URL(url).pathname.slice(3));
  if (!v.ok) throw new Error(`bad link ${v.status}`);
  return v.token.exp;
};

/** Rewrites the stored state (e.g. next_at: 0 lets the next hello push again, as if the window had passed). */
const patchState = (a: Rec, patch: (s: AutoUpdateStatus) => Partial<AutoUpdateStatus>) =>
  runInDurableObject(env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(a.accountId)), async (_i, state) => {
    const s = (await state.storage.get<AutoUpdateStatus>(`autoupdate:${a.deviceId}`))!;
    await state.storage.put(`autoupdate:${a.deviceId}`, { ...s, ...patch(s) });
  });
const expireWindow = (a: Rec) => patchState(a, () => ({ next_at: 0 }));

/** A recording of this account on the device, in `status`, created `age` seconds ago. */
async function recordingOn(a: Rec, status: string, age = 0, maxSeconds = 60): Promise<string> {
  const id = `rec${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 30);
  await env.DB.prepare("INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, a.accountId, a.deviceId, status, maxSeconds, now() - age, now() + 86400)
    .run();
  return id;
}
const waitFor = async (dev: { frames: any[] }, n: number) => {
  for (let i = 0; i < 50 && updates(dev.frames).length < n; i++) await sleep(10);
  await sleep(50);
};

async function report(dev: { ws: WebSocket }, a: Rec, r: object, until: (s: AutoUpdateStatus | null) => boolean) {
  dev.ws.send(JSON.stringify({ type: "update", version: RECORDER_VERSION, ...r }));
  for (let i = 0; i < 50 && !until(await status(a)); i++) await sleep(10);
}

describe("auto-update on hello", () => {
  it("an old self_update recorder gets one signed update command, the same one update_recorder sends", async () => {
    const a = await account();
    const t = now();
    const dev = await hello(a, BEHIND);
    const sent = updates(dev.frames);
    expect(sent).toHaveLength(1);
    const { mac, ...rest } = sent[0];
    expect(mac).toBe(await hmacHex(await deviceCommandKey(env, a.deviceId), canonicalCommand(rest)));
    expect(rest).toMatchObject({ account_id: a.accountId, device_id: a.deviceId, version: RECORDER_VERSION, sha256: INSTALL_PS1_SHA256 });
    expect(rest.url.startsWith(`${ORIGIN}/i/`)).toBe(true);
    const token = await verifyInstallerToken(env, new URL(rest.url).pathname.slice(3));
    expect(token).toMatchObject({ ok: true, token: { purpose: "update", accountId: a.accountId, code: null } });
    const s = await status(a);
    expect(s).toMatchObject({ version: RECORDER_VERSION, result: "sent", attempts: 1, failures: 0 });
    expect(s!.next_at).toBeGreaterThanOrEqual(t + AUTO_UPDATE.windowSeconds);
  });

  it("a second hello within the window gets none", async () => {
    const a = await account();
    expect(updates((await hello(a, BEHIND)).frames)).toHaveLength(1);
    expect(updates((await hello(a, BEHIND)).frames)).toHaveLength(0);
    expect(await status(a)).toMatchObject({ attempts: 1 });
  });

  it("none on the latest version, without self_update, or on an unknown platform", async () => {
    const latest = await account();
    expect(updates((await hello(latest, RECORDER_VERSION)).frames)).toHaveLength(0);
    const old = await account();
    expect(updates((await hello(old, BEHIND, OLD)).frames)).toHaveLength(0);
    const unknown = await account(null);
    expect(updates((await hello(unknown, BEHIND)).frames)).toHaveLength(0);
    for (const x of [latest, old, unknown]) expect(await status(x)).toBeNull();
  });

  it("none without a hello (unknown version)", async () => {
    const a = await account();
    const dev = await connectDevice(a.deviceToken);
    await sleep(150);
    expect(updates(dev.frames)).toHaveLength(0);
  });

  it("a Mac gets install.sh's version and hash", async () => {
    if (!RECORDER_MAC_VERSION) return;
    const a = await account("macos");
    const sent = updates((await hello(a, BEHIND)).frames);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ version: RECORDER_MAC_VERSION, sha256: INSTALL_SH_SHA256 });
    const token = await verifyInstallerToken(env, new URL(sent[0].url).pathname.slice(3));
    expect(token).toMatchObject({ ok: true, token: { purpose: "mac_update", accountId: a.accountId } });
  });

  it("stops after 3 failed attempts; manual update_recorder still works and shows auto_update", async () => {
    const a = await account();
    // 1: a failure report.
    let dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(1);
    await report(dev, a, { status: "failed", error: "sha256 mismatch" }, (s) => s?.failures === 1);
    expect(await status(a)).toMatchObject({ result: "failed", failures: 1, error: "sha256 mismatch" });
    // 2: installing, then back on the old version: that attempt failed too.
    await expireWindow(a);
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(1);
    await report(dev, a, { status: "installing" }, (s) => s?.result === "installing");
    await expireWindow(a);
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(1);
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 3, failures: 1 + 1 });
    // 3: a third failure report: gave up on this version.
    await report(dev, a, { status: "failed", error: "download failed: WebException" }, (s) => s?.failures === 3);
    expect(await status(a)).toMatchObject({ result: "gave_up", failures: 3 });
    await expireWindow(a);
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(0);

    const r = (await mcp("update_recorder", {}, a.key)).data;
    expect(r).toMatchObject({ action: "update_sent", auto_update: { version: RECORDER_VERSION, result: "gave_up", failures: 3 } });
    for (let i = 0; i < 50 && !updates(dev.frames).length; i++) await sleep(10);
    expect(updates(dev.frames)).toHaveLength(1);
  });

  it("busy (recording) is not a failure and may retry on a later hello; an update in progress waits the window", async () => {
    const a = await account();
    let dev = await hello(a, BEHIND);
    await report(dev, a, { status: "failed", error: "recording in progress" }, (s) => s?.result === "busy");
    const s = (await status(a))!;
    expect(s).toMatchObject({ result: "busy", failures: 0 });
    expect(s.next_at).toBeLessThanOrEqual(now() + AUTO_UPDATE.busyRetrySeconds);
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(0); // not yet: busyRetrySeconds
    await expireWindow(a);
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(1);
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 2, failures: 0 });

    const b = await account();
    dev = await hello(b, BEHIND);
    await report(dev, b, { status: "failed", error: "an update is already in progress" }, (x) => x?.result === "busy");
    const sb = (await status(b))!;
    expect(sb).toMatchObject({ result: "busy", failures: 0 });
    expect(sb.next_at).toBeGreaterThanOrEqual(now() + AUTO_UPDATE.windowSeconds - 5);
  });

  it("a hello on the new version marks it updated", async () => {
    const a = await account();
    const dev = await hello(a, BEHIND);
    await report(dev, a, { status: "installing" }, (s) => s?.result === "installing");
    expect(updates((await hello(a, RECORDER_VERSION)).frames)).toHaveLength(0);
    expect(await status(a)).toMatchObject({ result: "updated", attempts: 1, failures: 0 });
  });

  it("the automatic push's link works AUTO_UPDATE.linkSeconds (deferrable); update_recorder's keeps pairingCodeSeconds", async () => {
    const a = await account();
    const t = now();
    const dev = await hello(a, BEHIND);
    const exp = await linkExp(updates(dev.frames)[0].url);
    expect(exp).toBeGreaterThanOrEqual(t + AUTO_UPDATE.linkSeconds);
    expect(exp).toBeLessThanOrEqual(now() + AUTO_UPDATE.linkSeconds);
    expect((await mcp("update_recorder", {}, a.key)).data.action).toBe("update_sent");
    await waitFor(dev, 2);
    expect(await linkExp(updates(dev.frames)[1].url)).toBeLessThanOrEqual(now() + LIMITS.pairingCodeSeconds);
  });

  it("remove_device forgets the state", async () => {
    const a = await account();
    await hello(a, BEHIND);
    expect(await status(a)).not.toBeNull();
    await deviceHub(env, a.accountId).disconnect(a.deviceId);
    expect(await status(a)).toBeNull();
  });
});

describe("auto-update: deferred and rolled back (recorder 0.6.1, update_defer_rollback)", () => {
  it("the hello feature is known", () => {
    expect(RECORDER_FEATURES).toContain("update_defer_rollback");
  });

  it("deferred is not a failure and blocks new pushes until the recorder reports or deferMaxSeconds pass", async () => {
    const a = await account();
    let dev = await hello(a, BEHIND);
    const t = now();
    await report(dev, a, { status: "deferred" }, (s) => s?.result === "deferred");
    const s = (await status(a))!;
    expect(s).toMatchObject({ result: "deferred", failures: 0, attempts: 1 });
    expect(s.deferred_at).toBeGreaterThanOrEqual(t);
    expect(s.next_at).toBe(s.deferred_at! + AUTO_UPDATE.deferMaxSeconds);
    // Past the normal window, still deferred: no push on a reconnect (the old version is not counted as a failure).
    await patchState(a, (x) => ({ deferred_at: x.deferred_at! - AUTO_UPDATE.windowSeconds * 2, next_at: x.next_at - AUTO_UPDATE.windowSeconds * 2 }));
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(0);
    // A second deferred report keeps the first deferred_at (the cap does not slide).
    const before = (await status(a))!.deferred_at!;
    await report(dev, a, { status: "deferred" }, () => true);
    await sleep(50);
    expect((await status(a))!.deferred_at).toBe(before);
    // Deferred longer than the cap: one new push, still no failure.
    await patchState(a, () => ({ deferred_at: now() - AUTO_UPDATE.deferMaxSeconds - 1, next_at: now() - 1 }));
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(1);
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 2, failures: 0 });
    expect((await status(a))!.deferred_at).toBeUndefined();
  });

  it("deferred then installing: the install gets its window from when it started", async () => {
    const a = await account();
    const dev = await hello(a, BEHIND);
    await report(dev, a, { status: "deferred" }, (s) => s?.result === "deferred");
    await patchState(a, () => ({ next_at: now() + 5 }));
    const t = now();
    await report(dev, a, { status: "installing" }, (s) => s?.result === "installing");
    const s = (await status(a))!;
    expect(s.next_at).toBeGreaterThanOrEqual(t + AUTO_UPDATE.windowSeconds);
    expect(s.deferred_at).toBeUndefined();
  });

  it("a deferred update whose link expired is not a failure and is sent again at once", async () => {
    const a = await account();
    const dev = await hello(a, BEHIND);
    await report(dev, a, { status: "deferred" }, (s) => s?.result === "deferred");
    await report(dev, a, { status: "failed", error: "update link expired while deferred (send the update again)" }, (s) => s?.attempts === 2);
    await waitFor(dev, 2);
    expect(updates(dev.frames)).toHaveLength(2);
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 2, failures: 0 });
  });

  it("rolled_back counts as a failure; three of them give up on that version", async () => {
    const a = await account();
    for (let i = 1; i <= 3; i++) {
      if (i > 1) await expireWindow(a);
      const dev = await hello(a, BEHIND);
      expect(updates(dev.frames)).toHaveLength(1);
      await report(dev, a, { status: "rolled_back" }, (s) => s?.failures === i);
      expect(await status(a)).toMatchObject({ failures: i, result: i < 3 ? "rolled_back" : "gave_up", error: "rolled back" });
    }
    await expireWindow(a);
    expect(updates((await hello(a, BEHIND)).frames)).toHaveLength(0);
  });

  it("rolled_back after the hello already counted that attempt (same connection) is not counted twice", async () => {
    const a = await account();
    let dev = await hello(a, BEHIND);
    await report(dev, a, { status: "installing" }, (s) => s?.result === "installing");
    await expireWindow(a);
    dev = await hello(a, BEHIND); // back on the old version: failure 1 inferred, pushed again
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 2, failures: 1 });
    dev.ws.send(JSON.stringify({ type: "update", status: "rolled_back", version: RECORDER_VERSION }));
    await sleep(150);
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 2, failures: 1 });
    // On a later connection the same report counts.
    dev = await hello(a, BEHIND);
    await report(dev, a, { status: "rolled_back" }, (s) => s?.failures === 2);
    expect(await status(a)).toMatchObject({ result: "rolled_back", failures: 2 });
  });

  it("0.6.0 -> 0.6.1 rolled back to 0.6.0: installing, then a hello on the old version without update_defer_rollback is a rolled-back attempt at once; no tight resend", async () => {
    const a = await account();
    // The restored recorder (BEHIND here: this tree pins 0.6.0 as the latest) without the 0.6.1 features.
    const OLD_060 = ALL.filter((f) => f !== "update_defer_rollback" && f !== "keyframes");
    let dev = await hello(a, BEHIND, OLD_060);
    expect(updates(dev.frames)).toHaveLength(1);
    await report(dev, a, { status: "installing" }, (s) => s?.result === "installing");
    // ~90 s later the installer restores 0.6.0, which says hello and can't send rolled_back: well inside the window.
    await patchState(a, (s) => ({ at: s.at - 90 }));
    dev = await hello(a, BEHIND, OLD_060);
    expect(await status(a)).toMatchObject({ result: "rolled_back", failures: 1, attempts: 1, error: `still on ${BEHIND}` });
    expect(updates(dev.frames)).toHaveLength(0);
    // Another reconnect in the window: not counted again, nothing sent.
    dev = await hello(a, BEHIND, OLD_060);
    expect(await status(a)).toMatchObject({ result: "rolled_back", failures: 1 });
    expect(updates(dev.frames)).toHaveLength(0);
    // After the window: sent again (attempt 2).
    await expireWindow(a);
    dev = await hello(a, BEHIND, OLD_060);
    expect(updates(dev.frames)).toHaveLength(1);
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 2, failures: 1 });
  });

  it("0.6.1+ rolled back: the hello on the old version counts it at once, its rolled_back report on that connection does not count again", async () => {
    const a = await account();
    let dev = await hello(a, BEHIND);
    await report(dev, a, { status: "installing" }, (s) => s?.result === "installing");
    await patchState(a, (s) => ({ at: s.at - 90 })); // the push went out 90 s ago
    dev = await hello(a, BEHIND); // inside the window
    expect(await status(a)).toMatchObject({ result: "failed", failures: 1, error: `still on ${BEHIND}` });
    expect(updates(dev.frames)).toHaveLength(0);
    await report(dev, a, { status: "rolled_back" }, (s) => s?.result === "rolled_back");
    expect(await status(a)).toMatchObject({ result: "rolled_back", failures: 1 });
  });

  it("installing, then idle again on the socket that reported it (recordingEnded): not a failure inside the window", async () => {
    const a = await account();
    const dev = await hello(a, BEHIND);
    await report(dev, a, { status: "installing" }, (s) => s?.result === "installing");
    await deviceHub(env, a.accountId).recordingEnded(a.accountId, a.deviceId);
    expect(await status(a)).toMatchObject({ result: "installing", failures: 0 });
  });

  it("rolled_back after the new version's hello (it crashed after connecting) is still a failure", async () => {
    const a = await account();
    let dev = await hello(a, BEHIND);
    await hello(a, RECORDER_VERSION);
    expect(await status(a)).toMatchObject({ result: "updated" });
    dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(0); // within the window
    await report(dev, a, { status: "rolled_back" }, (s) => s?.failures === 1);
    expect(await status(a)).toMatchObject({ result: "rolled_back", failures: 1 });
  });
});

describe("auto-update: only while the device is idle", () => {
  it("a recording on the device holds the push; it goes once the recording has uploaded (recordingEnded)", async () => {
    const a = await account();
    const id = await recordingOn(a, "recording");
    const dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(0);
    expect(await status(a)).toMatchObject({ result: "waiting", attempts: 0, failures: 0 });
    // Still uploading: still held.
    await env.DB.prepare("UPDATE recordings SET status = 'uploading' WHERE id = ?").bind(id).run();
    await deviceHub(env, a.accountId).recordingEnded(a.accountId, a.deviceId);
    expect(updates(dev.frames)).toHaveLength(0);
    await env.DB.prepare("UPDATE recordings SET status = 'transcribing' WHERE id = ?").bind(id).run();
    await deviceHub(env, a.accountId).recordingEnded(a.accountId, a.deviceId);
    await waitFor(dev, 1);
    expect(updates(dev.frames)).toHaveLength(1);
    expect(await status(a)).toMatchObject({ result: "sent", attempts: 1, failures: 0 });
  });

  it("starting counts as recording; a later hello sends it once idle", async () => {
    const a = await account();
    const id = await recordingOn(a, "starting");
    expect(updates((await hello(a, BEHIND)).frames)).toHaveLength(0);
    await env.DB.prepare("UPDATE recordings SET status = 'ready' WHERE id = ?").bind(id).run();
    expect(updates((await hello(a, BEHIND)).frames)).toHaveLength(1);
  });

  it("a recording that fails on the device (its failed event) frees it", async () => {
    const a = await account();
    const id = await recordingOn(a, "recording");
    const dev = await hello(a, BEHIND);
    expect(updates(dev.frames)).toHaveLength(0);
    dev.ws.send(JSON.stringify({ type: "status", recording_id: id, status: "failed", error: "capture failed" }));
    await waitFor(dev, 1);
    expect(updates(dev.frames)).toHaveLength(1);
  });

  it("a stuck recording (past the cleanup timeout) and other devices' recordings do not hold it", async () => {
    const a = await account();
    await recordingOn(a, "recording", 60 + LIMITS.uploadGraceSeconds + 5);
    await env.DB.prepare("INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at) VALUES (?, ?, 'otherdevice', 'recording', 60, ?, ?)")
      .bind(`oth${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 30), a.accountId, now(), now() + 86400)
      .run();
    expect(updates((await hello(a, BEHIND)).frames)).toHaveLength(1);
  });

  it("recordingEnded does nothing for an up-to-date, offline or other account's device", async () => {
    const a = await account();
    const dev = await hello(a, RECORDER_VERSION);
    await deviceHub(env, a.accountId).recordingEnded(a.accountId, a.deviceId);
    await deviceHub(env, a.accountId).recordingEnded("someoneelse", a.deviceId);
    await deviceHub(env, a.accountId).recordingEnded(a.accountId, "nosuchdevice");
    await sleep(50);
    expect(updates(dev.frames)).toHaveLength(0);
    expect(await status(a)).toBeNull();
  });
});
