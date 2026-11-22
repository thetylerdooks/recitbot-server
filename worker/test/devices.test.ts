import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalCommand, deviceCommandKey, deviceHub } from "../src/device-hub";
import { matchAv, matchMonitor, matchWindow, type Monitor, type StoredInventory, type Window } from "../src/devices";
import type { Env } from "../src/env";
import worker from "../src/index";
import { hmacHex, now } from "../src/util";
import { homeEnv, PITCH } from "./home-fixture";
import { connectDevice, freshIp, mcp, seedAccount, seedReady, videoLinkOf, withEnv } from "./helpers";

// Same fixture as the recorder selftest (recorder/AgentRecorder.cs SelfTest): this PC's two monitors, one mic, two cameras.
const MONITORS: Monitor[] = [
  { id: "mon_377f60cd2c", index: 0, output_idx: 0, name: "\\\\.\\DISPLAY2", friendly_name: "G271CQP E2", primary: true, x: 0, y: 0, width: 2560, height: 1440, scale: 1, position: 0, label: "left" },
  { id: "mon_f7b81f0c95", index: 1, output_idx: 1, name: "\\\\.\\DISPLAY1", friendly_name: "HP P231", primary: false, x: 2560, y: 218, width: 1920, height: 1080, scale: 1, position: 1, label: "right" },
];
const REPORT = {
  type: "devices",
  request_id: "",
  monitors: MONITORS,
  mics: [
    { id: "mic_91175d8bea", name: "Microphone (HyperX Cloud Alpha Wireless)", default: true },
    { id: "mic_0000000001", name: "Microphone (Realtek(R) Audio)", default: false },
  ],
  cameras: [
    { id: "cam_45444c8634", name: "Full HD webcam" },
    { id: "cam_ecc99a519c", name: "OBS Virtual Camera" },
  ],
};

// Same window fixture as the recorder selftest: two Chrome windows, two Notepads, Zoom.
const win = (id: string, app: string, exe: string, title: string, monitor = "mon_377f60cd2c", minimized = false): Window => ({
  id,
  app,
  exe,
  title,
  monitor,
  minimized,
  x: 100,
  y: 100,
  width: 1280,
  height: 800,
});
const WINDOWS: Window[] = [
  win("win_00000000a1", "Google Chrome", "chrome.exe", "YouTube - Google Chrome"),
  win("win_00000000a2", "Google Chrome", "chrome.exe", "Inbox (3) - Gmail - Google Chrome", "mon_f7b81f0c95"),
  win("win_00000000b1", "Notepad", "Notepad.exe", "notes.txt - Notepad"),
  win("win_00000000b2", "Notepad", "Notepad.exe", "todo.txt - Notepad", "mon_f7b81f0c95", true),
  win("win_00000000c1", "Zoom Workplace", "Zoom.exe", "Zoom Meeting"),
];
const WINDOW_REPORT = { ...REPORT, windows: WINDOWS };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pairedWithReport(report: object = REPORT) {
  const acct = await seedAccount();
  const dev = await connectDevice(acct.deviceToken!);
  dev.ws.send(JSON.stringify(report));
  for (let i = 0; i < 50; i++) {
    const r = await mcp("list_devices", {}, acct.key);
    if (r.data?.monitors?.length) return { ...acct, ...dev };
    await sleep(20);
  }
  throw new Error("inventory never stored");
}

/** The fake recorder answers every live "devices" request with `report`. */
function answerDevices(ws: WebSocket, report: object) {
  ws.addEventListener("message", (ev) => {
    const f = JSON.parse(ev.data as string);
    if (f.type === "devices") ws.send(JSON.stringify({ ...report, request_id: f.recording_id }));
  });
}
const devicesAsked = (frames: any[]) => frames.filter((f) => f.type === "devices").length;

async function verifiedFrame(frames: any[], deviceId: string) {
  const f = frames.find((x) => x.type === "start");
  const { mac, ...rest } = f;
  expect(mac).toBe(await hmacHex(await deviceCommandKey(env, deviceId), canonicalCommand(rest)));
  return f;
}

describe("device parameters are signed", () => {
  const base = {
    type: "start",
    recording_id: "AAAAAAAAAAAAAAAAAAAAAA",
    max_seconds: 30,
    mic: false,
    nonce: 1731650000000,
    exp: 1731650060,
    account_id: "BBBBBBBBBBBBBBBBBBBBBB",
    device_id: "CCCCCCCCCCCCCCCCCCCCCC",
    upload_token: "1731651800.tok",
  };

  it("canonical form + HMAC match the recorder's selftest vector", async () => {
    const canon = canonicalCommand({
      ...base,
      webcam: true,
      camera: "Full HD webcam",
      webcam_size: "large",
      monitor: "mon_0123456789",
      mic_device: "Microphone (HyperX Cloud Alpha Wireless)",
    });
    expect(canon.endsWith("|cam|1|Full HD webcam|large|dev|mon_0123456789|Microphone (HyperX Cloud Alpha Wireless)")).toBe(true);
    expect(await hmacHex("test-device-secret", canon)).toBe("7973edc38381ad4e225e490d13e4cfd498e6ec3ebd84ed027f3c603aabbe2d73");
  });

  it("the device block is absent unless a device is chosen, and each field changes the signature", () => {
    expect(canonicalCommand(base)).not.toContain("|dev|");
    expect(canonicalCommand({ ...base, monitor: "1" }).endsWith("|1731651800.tok|dev|1|")).toBe(true);
    const forms = new Set([
      canonicalCommand(base),
      canonicalCommand({ ...base, monitor: "0" }),
      canonicalCommand({ ...base, monitor: "1" }),
      canonicalCommand({ ...base, mic_device: "x" }),
      canonicalCommand({ ...base, monitor: "1", mic_device: "x" }),
    ]);
    expect(forms.size).toBe(5);
  });

  it("start_recording signs monitor/mic_device; omitted device params keep the old frame (older recorders)", async () => {
    const acct = await seedAccount();
    const { ws, frames } = await connectDevice(acct.deviceToken!);
    expect((await mcp("start_recording", { max_seconds: 10, monitor: 1, mic_device: "HyperX" }, acct.key)).isError).toBe(false);
    const f = await verifiedFrame(frames, acct.deviceId!);
    // No inventory reported yet: the raw values go to the recorder, which only uses entries from its own inventory.
    expect(f).toMatchObject({ monitor: "1", mic_device: "HyperX", mic: true });
    ws.close();

    const b = await seedAccount();
    const d2 = await connectDevice(b.deviceToken!);
    expect((await mcp("start_recording", { max_seconds: 10 }, b.key)).isError).toBe(false);
    const plain = await verifiedFrame(d2.frames, b.deviceId!);
    expect(Object.keys(plain)).not.toContain("monitor");
    expect(Object.keys(plain)).not.toContain("mic_device");
    expect(plain.mic).toBe(true);
    d2.ws.close();
  });

  it("mic defaults to on (Windows default mic); mic:false turns it off; mic_device picks the device", async () => {
    const acct = await seedAccount();
    const { ws, frames } = await connectDevice(acct.deviceToken!);
    // 'rec my 2nd monitor with webcam on': no mic arg -> mic on, no mic_device (the recorder uses the Windows default).
    const on = await mcp("start_recording", { max_seconds: 10, webcam: true }, acct.key);
    expect(on.data.mic).toBe(true);
    const f1 = await verifiedFrame(frames, acct.deviceId!);
    expect(f1.mic).toBe(true);
    expect(Object.keys(f1)).not.toContain("mic_device");
    const row = await env.DB.prepare("SELECT mic FROM recordings WHERE id = ?").bind(on.data.recording_id).first<{ mic: number }>();
    expect(row?.mic).toBe(1);
    ws.close();

    // 'record my screen muted' -> mic:false.
    const b = await seedAccount();
    const d2 = await connectDevice(b.deviceToken!);
    const off = await mcp("start_recording", { max_seconds: 10, mic: false }, b.key);
    expect(off.data.mic).toBe(false);
    expect((await verifiedFrame(d2.frames, b.deviceId!)).mic).toBe(false);
    d2.ws.close();

    // mic_device with no mic arg -> mic on with that device.
    const c = await seedAccount();
    const d3 = await connectDevice(c.deviceToken!);
    expect((await mcp("start_recording", { max_seconds: 10, mic_device: "HyperX" }, c.key)).data.mic).toBe(true);
    expect(await verifiedFrame(d3.frames, c.deviceId!)).toMatchObject({ mic: true, mic_device: "HyperX" });
    d3.ws.close();
  });

  it("mute wins: mic:false drops mic_device; webcam:false drops camera", async () => {
    const acct = await seedAccount();
    const { ws, frames } = await connectDevice(acct.deviceToken!);
    const r = await mcp("start_recording", { max_seconds: 10, mic: false, mic_device: "HyperX", webcam: false, camera: "Full HD webcam" }, acct.key);
    expect(r.isError).toBe(false);
    const f = await verifiedFrame(frames, acct.deviceId!);
    expect(f.mic).toBe(false);
    expect(f.webcam).toBe(false);
    expect(Object.keys(f)).not.toContain("mic_device");
    expect(Object.keys(f)).not.toContain("camera");
    ws.close();
  });

  it("rejects device strings that could break the signed form or a command line", async () => {
    const { key } = await seedAccount();
    for (const bad of ['a|b', 'x" -i "y', "c:\\evil", "line\nbreak", ""]) {
      expect((await mcp("start_recording", { monitor: bad }, key)).data.error).toBe("INVALID_ARGUMENTS");
      expect((await mcp("start_recording", { mic_device: bad }, key)).data.error).toBe("INVALID_ARGUMENTS");
    }
  });
});

describe("matching casual requests (same rules as the recorder)", () => {
  it("monitors", () => {
    const id = (q: string | number | undefined) => {
      const m = matchMonitor(MONITORS, q);
      return "item" in m ? m.item.index : m.error;
    };
    expect([id(undefined), id("primary"), id("Main"), id("0"), id(1)]).toEqual([0, 0, 0, 0, 1]);
    expect([id("right"), id("LEFT"), id("second"), id("2nd"), id("other")]).toEqual([1, 0, 1, 1, 1]);
    expect([id("mon_f7b81f0c95"), id("display1"), id("\\\\.\\DISPLAY2"), id("hp"), id("g271")]).toEqual([1, 1, 0, 1, 0]);
    expect([id("7"), id("samsung"), id("center")]).toEqual(["DEVICE_NOT_FOUND", "DEVICE_NOT_FOUND", "DEVICE_NOT_FOUND"]);
    const three: Monitor[] = [
      { ...MONITORS[0], label: "center", position: 1 },
      { ...MONITORS[1], id: "mon_aaaaaaaaaa", label: "left", position: 0 },
      { ...MONITORS[1], id: "mon_bbbbbbbbbb", index: 2, label: "right", position: 2 },
    ];
    const amb = matchMonitor(three, "second");
    expect("error" in amb && amb.error).toBe("DEVICE_AMBIGUOUS");
    expect("error" in amb && amb.candidates.length).toBe(2);
  });

  it("mics and cameras", () => {
    const pick = <T extends { id: string; name: string }>(l: T[], q: string) => {
      const m = matchAv(l, q);
      return "item" in m ? m.item.id : m.error;
    };
    expect(pick(REPORT.mics, "hyperx")).toBe("mic_91175d8bea");
    expect(pick(REPORT.mics, "HyperX Cloud")).toBe("mic_91175d8bea");
    expect(pick(REPORT.mics, "default")).toBe("mic_91175d8bea");
    expect(pick(REPORT.mics, "microphone")).toBe("DEVICE_AMBIGUOUS");
    expect(pick(REPORT.mics, "blue yeti")).toBe("DEVICE_NOT_FOUND");
    expect(pick(REPORT.cameras, "full hd")).toBe("cam_45444c8634");
    expect(pick(REPORT.cameras, "obs")).toBe("cam_ecc99a519c");
  });
});

describe("list_devices", () => {
  it("is listed with start_recording's device params, and the descriptions teach casual phrasing", async () => {
    const res = await worker.fetch(
      new Request("https://rec.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      createExecutionContext(),
    );
    const tools = ((await res.json()) as any).result.tools as any[];
    const start = tools.find((t) => t.name === "start_recording");
    const list = tools.find((t) => t.name === "list_devices");
    expect(Object.keys(start.inputSchema.properties)).toEqual(
      expect.arrayContaining(["monitor", "mic", "mic_device", "webcam", "camera", "webcam_size"]),
    );
    for (const word of ["2nd", "webcame", "HyperX", "no cam", "mute", "list_devices", "ambiguous"]) expect(start.description).toContain(word);
    for (const word of ["BEFORE start_recording", "left/center/right", "2nd mon"]) expect(list.description).toContain(word);
  });

  it("returns the recorder's report for the paired device", async () => {
    const r = await pairedWithReport();
    const out = await mcp("list_devices", {}, r.key);
    expect(out.isError).toBe(false);
    expect(out.data.online).toBe(true);
    expect(out.data.monitors).toEqual([
      expect.objectContaining({ id: "mon_377f60cd2c", index: 0, label: "left", primary: true, resolution: "2560x1440", model: "G271CQP E2" }),
      expect.objectContaining({ id: "mon_f7b81f0c95", index: 1, label: "right", primary: false, resolution: "1920x1080", model: "HP P231" }),
    ]);
    expect(out.data.mics[0]).toEqual({ id: "mic_91175d8bea", name: "Microphone (HyperX Cloud Alpha Wireless)", default: true });
    expect(out.data.cameras).toHaveLength(2);
    expect(now() - out.data.reported_at).toBeLessThan(10);
    r.ws.close();
  });

  it("refresh asks the recorder live with a signed devices command", async () => {
    const acct = await seedAccount();
    const { ws, frames } = await connectDevice(acct.deviceToken!);
    ws.addEventListener("message", (ev) => {
      const f = JSON.parse(ev.data as string);
      if (f.type === "devices") ws.send(JSON.stringify({ ...REPORT, request_id: f.recording_id, cameras: [] }));
    });
    const out = await mcp("list_devices", { refresh: true }, acct.key);
    expect(out.data.monitors).toHaveLength(2);
    expect(out.data.cameras).toEqual([]);
    const ask = frames.find((f) => f.type === "devices");
    const { mac, ...rest } = ask;
    expect(mac).toBe(await hmacHex(await deviceCommandKey(env, acct.deviceId!), canonicalCommand(rest)));
    ws.close();
  });

  it("an older recorder that never answers gets a clear note after the timeout", async () => {
    const acct = await seedAccount();
    const { ws } = await connectDevice(acct.deviceToken!);
    const t = Date.now();
    const out = await mcp("list_devices", {}, acct.key);
    expect(Date.now() - t).toBeGreaterThanOrEqual(3500);
    expect(out.data).toMatchObject({ online: true, monitors: [] });
    expect(out.data.note).toMatch(/older version/);
    ws.close();
  }, 15000);

  it("offline: last report with a note; nothing reported -> the paired devices and a note; unpaired -> DEVICE_NOT_PAIRED", async () => {
    const r = await pairedWithReport();
    r.ws.close();
    for (let i = 0; i < 50 && (await mcp("device_status", {}, r.key)).data.online; i++) await sleep(20);
    const off = await mcp("list_devices", {}, r.key);
    expect(off.data).toMatchObject({ online: false });
    expect(off.data.monitors).toHaveLength(2);
    const fresh = await seedAccount();
    const none = await mcp("list_devices", {}, fresh.key);
    expect(none.isError).toBe(false);
    expect(none.data).toMatchObject({ online: false, monitors: [], device: fresh.deviceId });
    expect(none.data.paired_devices).toEqual([expect.objectContaining({ id: fresh.deviceId, online: false })]);
    expect(none.data.note).toMatch(/offline/);
    const unpaired = await seedAccount(false);
    expect((await mcp("list_devices", {}, unpaired.key)).data.error).toBe("DEVICE_NOT_PAIRED");
  });

  it("rejects malformed inventory frames", async () => {
    const acct = await seedAccount();
    const { ws } = await connectDevice(acct.deviceToken!);
    ws.send(JSON.stringify({ ...REPORT, monitors: [{ ...MONITORS[0], id: "../../etc" }] }));
    await sleep(50);
    const out = await mcp("list_devices", {}, acct.key); // falls back to a live ask that the fake never answers
    expect(out.data.monitors).toEqual([]);
    ws.close();
  }, 15000);
});

describe("start_recording resolves devices against the inventory", () => {
  it("'rec my 2nd mon with HyperX mic and webcam' -> ids in the signed command", async () => {
    const r = await pairedWithReport();
    const out = await mcp("start_recording", { max_seconds: 10, monitor: "second", mic_device: "hyperx", webcam: true, camera: "full hd" }, r.key);
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({ monitor: "mon_f7b81f0c95", mic_device: "mic_91175d8bea", camera: "cam_45444c8634", mic: true });
    const f = await verifiedFrame(r.frames, r.deviceId!);
    expect(f).toMatchObject({ monitor: "mon_f7b81f0c95", mic_device: "mic_91175d8bea", camera: "cam_45444c8634", webcam: true, mic: true });
    r.ws.close();
  });

  it("unknown or ambiguous devices fail before any quota is spent, with candidates", async () => {
    const r = await pairedWithReport();
    const nf = await mcp("start_recording", { monitor: "samsung" }, r.key);
    expect(nf.data).toMatchObject({ error: "DEVICE_NOT_FOUND", field: "monitor" });
    expect(nf.data.candidates.map((c: any) => c.id)).toEqual(["mon_377f60cd2c", "mon_f7b81f0c95"]);
    const amb = await mcp("start_recording", { mic_device: "microphone" }, r.key);
    expect(amb.data).toMatchObject({ error: "DEVICE_AMBIGUOUS", field: "mic_device" });
    expect(amb.data.message).toMatch(/Ask the user/);
    expect(r.frames.filter((f) => f.type === "start")).toHaveLength(0);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE account_id = ?").bind(r.accountId).first<{ n: number }>();
    expect(n!.n).toBe(0);
    r.ws.close();
  });
});

describe("matching windows (same rules as the recorder)", () => {
  const pick = (q: string) => {
    const m = matchWindow(WINDOWS, q);
    return "item" in m ? m.item.id : m.error;
  };

  it("token match: every word must appear in app, exe or title", () => {
    expect(pick("chrome youtube")).toBe("win_00000000a1");
    expect(pick("the youtube window")).toBe("win_00000000a1");
    expect(pick("YouTube")).toBe("win_00000000a1");
    expect(pick("notepad todo")).toBe("win_00000000b2");
    expect(pick("Zoom")).toBe("win_00000000c1");
    expect(pick("record zoom")).toBe("WINDOW_NOT_FOUND"); // "record" is not filler: the model passes the app, not the sentence
    expect(pick("Chrome.EXE gmail")).toBe("win_00000000a2");
    expect(pick("win_00000000b1")).toBe("win_00000000b1");
    expect(pick("NOTES.TXT - NOTEPAD")).toBe("win_00000000b1");
  });

  it("ambiguous: several windows fit, all of them are candidates", () => {
    for (const q of ["chrome", "that notepad", "google"]) {
      const m = matchWindow(WINDOWS, q);
      expect("error" in m && m.error).toBe("WINDOW_AMBIGUOUS");
      expect("error" in m && m.candidates.length).toBe(2);
    }
  });

  it("not found: candidates are the closest windows (most words matched first)", () => {
    const m = matchWindow(WINDOWS, "chrome slack");
    expect("error" in m && m.error).toBe("WINDOW_NOT_FOUND");
    expect("error" in m && m.candidates.map((w) => w.id)).toEqual(["win_00000000a1", "win_00000000a2"]);
    const none = matchWindow(WINDOWS, "photoshop");
    expect("error" in none && none.candidates).toHaveLength(5);
    for (const q of ["", "the window"]) expect(pick(q)).toBe("WINDOW_NOT_FOUND");
  });
});

describe("window recording", () => {
  const base = {
    type: "start",
    recording_id: "AAAAAAAAAAAAAAAAAAAAAA",
    max_seconds: 30,
    mic: false,
    nonce: 1731650000000,
    exp: 1731650060,
    account_id: "BBBBBBBBBBBBBBBBBBBBBB",
    device_id: "CCCCCCCCCCCCCCCCCCCCCC",
    upload_token: "1731651800.tok",
  };

  it("the window block is signed only when present and matches the recorder's selftest vector", async () => {
    const canon = canonicalCommand({ ...base, webcam: true, window: "win_0123456789" });
    expect(canon.endsWith("|1731651800.tok|cam|1|||win|win_0123456789")).toBe(true);
    expect(await hmacHex("test-device-secret", canon)).toBe("19642c756a0de3d60eb9372be9fd332f66affe9ec189c7d198d64e4f773770fa");
    expect(canonicalCommand(base)).not.toContain("|win|");
    expect(canonicalCommand({ ...base, window: "win_0123456789" })).not.toBe(canonicalCommand({ ...base, window: "win_9876543210" }));
  });

  it("list_devices returns the windows with their monitor label", async () => {
    const r = await pairedWithReport(WINDOW_REPORT);
    const out = await mcp("list_devices", {}, r.key);
    expect(out.data.windows).toHaveLength(5);
    expect(out.data.windows[0]).toEqual({
      id: "win_00000000a1",
      app: "Google Chrome",
      exe: "chrome.exe",
      title: "YouTube - Google Chrome",
      monitor: "mon_377f60cd2c",
      monitor_label: "left",
      minimized: false,
      size: "1280x800",
    });
    expect(out.data.windows[3]).toMatchObject({ monitor_label: "right", minimized: true });
    r.ws.close();
  });

  it("'rec my chrome with youtube open with webcam' -> the window id is signed into the start command", async () => {
    const r = await pairedWithReport(WINDOW_REPORT);
    const out = await mcp("start_recording", { max_seconds: 10, window: "chrome youtube", webcam: true }, r.key);
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({ window: "win_00000000a1", window_app: "Google Chrome", window_title: "YouTube - Google Chrome" });
    const f = await verifiedFrame(r.frames, r.deviceId!);
    expect(f).toMatchObject({ window: "win_00000000a1", webcam: true });
    expect(Object.keys(f)).not.toContain("monitor");
    r.ws.close();
  });

  it("WINDOW_AMBIGUOUS / WINDOW_NOT_FOUND fail before any quota is used, with candidates", async () => {
    const r = await pairedWithReport(WINDOW_REPORT);
    r.frames.length = 0;
    const amb = await mcp("start_recording", { window: "notepad" }, r.key);
    expect(amb.data).toMatchObject({ error: "WINDOW_AMBIGUOUS", field: "window" });
    expect(amb.data.message).toMatch(/Ask the user/);
    expect(amb.data.candidates).toEqual([
      { id: "win_00000000b1", app: "Notepad", title: "notes.txt - Notepad", monitor: "left", monitor_id: "mon_377f60cd2c", minimized: false },
      { id: "win_00000000b2", app: "Notepad", title: "todo.txt - Notepad", monitor: "right", monitor_id: "mon_f7b81f0c95", minimized: true },
    ]);
    expect(devicesAsked(r.frames)).toBe(0);
    answerDevices(r.ws, WINDOW_REPORT);
    const nf = await mcp("start_recording", { window: "slack" }, r.key);
    expect(nf.data).toMatchObject({ error: "WINDOW_NOT_FOUND", field: "window" });
    expect(nf.data.candidates).toHaveLength(5);
    expect(r.frames.filter((f) => f.type === "start")).toHaveLength(0);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE account_id = ?").bind(r.accountId).first<{ n: number }>();
    expect(n!.n).toBe(0);
    r.ws.close();
  });

  it("window and monitor are mutually exclusive; bad window strings are rejected", async () => {
    const r = await pairedWithReport(WINDOW_REPORT);
    const both = await mcp("start_recording", { window: "zoom", monitor: "primary" }, r.key);
    expect(both.data.error).toBe("INVALID_ARGUMENTS");
    for (const bad of ['a|b', 'x" -i "y', "line\nbreak", ""]) {
      expect((await mcp("start_recording", { window: bad }, r.key)).data.error).toBe("INVALID_ARGUMENTS");
    }
    expect(r.frames.filter((f) => f.type === "start")).toHaveLength(0);
    r.ws.close();
  });

  it("a report without windows triggers a live refresh; the fresh list is used", async () => {
    const r = await pairedWithReport(REPORT); // connect-time report from before the window opened
    r.ws.addEventListener("message", (ev) => {
      const f = JSON.parse(ev.data as string);
      if (f.type === "devices") r.ws.send(JSON.stringify({ ...WINDOW_REPORT, request_id: f.recording_id }));
    });
    const out = await mcp("start_recording", { max_seconds: 10, window: "zoom" }, r.key);
    expect(out.isError).toBe(false);
    expect(out.data.window).toBe("win_00000000c1");
    expect(r.frames.some((f) => f.type === "devices")).toBe(true);
    r.ws.close();
  });

  it("window cache hit: a list under 60 s old that has the window is used without asking the PC", async () => {
    const r = await pairedWithReport(WINDOW_REPORT);
    r.frames.length = 0;
    const out = await mcp("start_recording", { max_seconds: 10, window: "zoom" }, r.key);
    expect(out.data.window).toBe("win_00000000c1");
    expect(devicesAsked(r.frames)).toBe(0);
    r.ws.close();
  });

  it("window cache stale: a list 60 s or older is refreshed from the PC first", async () => {
    const r = await pairedWithReport(WINDOW_REPORT);
    const key = `devices:${r.deviceId}`;
    await runInDurableObject(deviceHub(env, r.accountId), async (_, state) => {
      const inv = (await state.storage.get<StoredInventory>(key))!;
      await state.storage.put(key, { ...inv, at: now() - 60 });
    });
    r.frames.length = 0;
    // Zoom was closed and reopened since: only the live list has its current id.
    answerDevices(r.ws, { ...WINDOW_REPORT, windows: [win("win_00000000c9", "Zoom Workplace", "Zoom.exe", "Zoom Meeting")] });
    const out = await mcp("start_recording", { max_seconds: 10, window: "zoom" }, r.key);
    expect(out.data.window).toBe("win_00000000c9");
    expect(devicesAsked(r.frames)).toBe(1);
    r.ws.close();
  });

  it("window cache miss: a recent list without the window is refreshed from the PC first", async () => {
    const r = await pairedWithReport(WINDOW_REPORT);
    r.frames.length = 0;
    answerDevices(r.ws, { ...WINDOW_REPORT, windows: [...WINDOWS, win("win_00000000d1", "Slack", "slack.exe", "general - Slack")] });
    const out = await mcp("start_recording", { max_seconds: 10, window: "slack" }, r.key);
    expect(out.data.window).toBe("win_00000000d1");
    expect(devicesAsked(r.frames)).toBe(1);
    r.ws.close();
  });

  it("an older recorder (no window support) gets RECORDER_UPDATE_REQUIRED, and list_devices says so", async () => {
    const r = await pairedWithReport(REPORT);
    r.ws.addEventListener("message", (ev) => {
      const f = JSON.parse(ev.data as string);
      if (f.type === "devices") r.ws.send(JSON.stringify({ ...REPORT, request_id: f.recording_id }));
    });
    const out = await mcp("start_recording", { window: "zoom" }, r.key);
    expect(out.data.error).toBe("RECORDER_UPDATE_REQUIRED");
    expect(r.frames.filter((f) => f.type === "start")).toHaveLength(0);
    const list = await mcp("list_devices", {}, r.key);
    expect(list.data.windows).toEqual([]);
    expect(list.data.windows_note).toMatch(/get_installer/);
    r.ws.close();
  });

  it("rejects malformed window entries", async () => {
    const acct = await seedAccount();
    const { ws } = await connectDevice(acct.deviceToken!);
    ws.send(JSON.stringify({ ...WINDOW_REPORT, windows: [{ ...WINDOWS[0], id: "win_../../x" }] }));
    ws.send(JSON.stringify({ ...WINDOW_REPORT, windows: Array.from({ length: 41 }, (_, i) => ({ ...WINDOWS[0], id: `win_${String(i).padStart(10, "0")}` })) }));
    await sleep(50);
    const out = await mcp("list_devices", {}, acct.key); // nothing stored: falls back to a live ask the fake never answers
    expect(out.data.monitors).toEqual([]);
    ws.close();
  }, 15000);

  it("the tool descriptions map casual window requests to `window` and tell bots not to refresh before a start", async () => {
    const res = await worker.fetch(
      new Request("https://rec.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      createExecutionContext(),
    );
    const tools = ((await res.json()) as any).result.tools as any[];
    const start = tools.find((t) => t.name === "start_recording");
    const list = tools.find((t) => t.name === "list_devices");
    expect(Object.keys(start.inputSchema.properties)).toContain("window");
    for (const word of ["rec my chrome", "the youtube window", "record zoom", "that notepad", "WINDOW_AMBIGUOUS", "mutually exclusive"]) {
      expect(start.description).toContain(word);
    }
    expect(start.description.match(/Window examples:/g)).toHaveLength(1);
    for (const word of ["open windows", "my chrome", "the youtube window"]) expect(list.description).toContain(word);
    for (const d of [start.description, list.description]) expect(d).toMatch(/do NOT call list_devices\(refresh:true\)/i);
    expect(start.description).not.toContain("ALWAYS call list_devices with refresh:true");
  });
});

describe("PUBLIC_BASE_URL", () => {
  const recit = withEnv({ PUBLIC_BASE_URL: "https://example.test" });

  async function at(origin: string, path: string, e: Env, init: RequestInit = {}) {
    const ctx = createExecutionContext();
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", freshIp());
    const res = await worker.fetch(new Request(origin + path, { ...init, headers }), e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("video URLs use it, and the URL works on every host", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    const shared = (await mcp("share", { recording_id: id }, key, recit)).data;
    expect(shared.share_url).toBe(shared.url);
    const url = new URL(shared.url);
    expect(url.origin).toBe("https://example.test");
    const pathAndQuery = url.pathname + url.search;
    for (const host of ["https://example.test", "https://mcp.example.test", "https://my-recorder.example.workers.dev"]) {
      expect((await at(host, pathAndQuery, recit)).status).toBe(200);
      expect((await at(host, pathAndQuery, env)).status).toBe(200);
    }
    const ready = await mcp("get_video", { recording_id: id }, key, recit);
    expect(ready.data.share_url).toBe(url.href);
  });

  it("the installer one-liner points new installs at it", async () => {
    const { key } = await seedAccount(false);
    const r = await mcp("get_installer", { platform: "windows" }, key, recit);
    expect(r.data.powershell).toContain("-Uri 'https://example.test/install.ps1'");
    expect(r.data.powershell).toContain("-Server 'https://example.test'");
    expect(r.data.uninstall).toContain("https://example.test/uninstall.ps1");
  });

  it("falls back to the request origin when unset; an invalid one is a configuration error, never used", async () => {
    const { key } = await seedAccount(false);
    expect((await mcp("get_installer", { platform: "windows" }, key)).data.powershell).toContain("-Server 'https://rec.example'");
    for (const v of ["javascript:alert(1)", "http://example.test"]) {
      const r = await mcp("get_installer", { platform: "windows" }, key, withEnv({ PUBLIC_BASE_URL: v }));
      expect(r.status, v).toBe(500);
      expect(r.data, v).toContain("PUBLIC_BASE_URL must be an https:// URL");
      expect(r.data, v).not.toContain(v);
    }
  });

  it("MCP answers on both hosts; the root page is the homepage on example.test only", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const host of ["https://example.test", "https://mcp.example.test"]) {
      const res = await at(host, "/mcp", recit, { method: "POST", headers: { "content-type": "application/json", origin: host }, body });
      expect(res.status).toBe(200);
    }
    const withHome = homeEnv({ PUBLIC_BASE_URL: "https://example.test" });
    const home = await at("https://example.test", "/", withHome);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toMatch(/text\/html/);
    expect(await home.text()).toContain(PITCH);
    expect((await at("https://mcp.example.test", "/", withHome)).status).toBe(404);
  });

  it("link-preview unfurls carry the title and site name; the only URL is the static card on the asked host", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    expect((await mcp("share", { recording_id: id }, key, recit)).isError).toBe(false);
    const url = new URL(await videoLinkOf(id, "https://example.test", recit));
    const res = await at("https://example.test", url.pathname + url.search, recit, { headers: { "user-agent": "Slackbot-LinkExpanding 1.0" } });
    const html = await res.text();
    expect(html).toContain('<meta property="og:site_name" content="Recitbot">');
    expect(html).toContain('<meta property="og:title" content="Demo">');
    expect(html.match(/https?:\/\/[^"\s<]+/g)).toEqual([
      expect.stringMatching(/^https:\/\/example\.test\/s\/og-card\.png\?v=\w+$/),
      expect.stringMatching(/^https:\/\/example\.test\/s\/og-card\.png\?v=\w+$/),
    ]);
    expect(html).not.toContain("/m/");
  });
});
