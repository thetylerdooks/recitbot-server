// Local end-to-end: wrangler dev (Miniflare) + the real installer one-liner + the native agent.
// signup -> get_installer -> run one-liner -> device online -> idle sample -> list_devices -> start_recording -> drag the
// control pill by its body (moves, keeps recording) and from Stop (neither moves nor stops) -> stop -> get_video ready ->
// viewer + Range 206 -> frame checks (pill and
// webcam controls absent, bubble ring stable) -> local Stop click -> uninstall + stop everything.
// Env: E2E_WEBCAM=1 (needs a camera: bubble + control strip), E2E_MONITOR=<id|index|second|...> (default primary),
// E2E_MIC=<mic name part> (also record that mic), E2E_IDLE_SECONDS (default 60).
// E2E_WINDOW=1: record a window instead: opens the test's own Chrome on YouTube (scripts/test-windows.mjs), finds it with
// list_devices(refresh:true), checks WINDOW_NOT_FOUND (and WINDOW_AMBIGUOUS when another YouTube Chrome window is open),
// then records it by id. E2E_NO_MOUSE=1 skips every step that injects real mouse input (pill drag, bubble controls,
// local Stop click), for runs while someone is using the PC. E2E_SHAPE=rect: the webcam bubble as a rounded rectangle.
// The agent's link opener is stubbed (AGENT_RECORDER_OPEN_LOG): the auto-open of the share link is checked from that
// log, and no browser tab ever opens. System audio is on (the default), so the video always has an audio track.
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, connect } from "./mcp-smoke.mjs";
import { ringStability } from "./ring-metric.mjs";
import { closeTestWindows, Helper, openTestWindow, testWindow, windowId } from "./test-windows.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E2E = join(root, ".e2e");
const SHOTS = join(root, "shots");
const INSTALL = join(E2E, "install");
// E2E_PORT: run wrangler dev on another port (e.g. when another checkout's dev server holds 8787).
const PORT = process.env.E2E_PORT || "8787";
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_SECONDS = Number(process.env.E2E_IDLE_SECONDS ?? 60);
const RECORD_SECONDS = 14;
const WEBCAM = process.env.E2E_WEBCAM === "1"; // opt-in: needs a real camera; first recording shows the bubble
const MONITOR = process.env.E2E_MONITOR || undefined;
const MIC = process.env.E2E_MIC || undefined;
const WINDOW = process.env.E2E_WINDOW === "1";
const NO_MOUSE = process.env.E2E_NO_MOUSE === "1";
const SHAPE = process.env.E2E_SHAPE || undefined;
const OPEN_LOG = join(E2E, "opened-links.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started_at: new Date().toISOString(), steps: [] };
const step = (name, data = {}) => {
  report.steps.push({ name, ...data });
  console.log(`[e2e] ${name}${Object.keys(data).length ? " " + JSON.stringify(data) : ""}`);
};
const readJson = (f) => JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""));

function ps(script, args = [], env = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** Real mouse click (x,y) or drag (x,y)->(tx,ty) in physical screen pixels. */
function mouse(x, y, tx, ty) {
  const args = ["-X", String(Math.round(x)), "-Y", String(Math.round(y))];
  if (tx !== undefined) args.push("-ToX", String(Math.round(tx)), "-ToY", String(Math.round(ty)));
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "mouse.ps1"), ...args], { encoding: "utf8" });
  if (r.stdout.trim() !== "ok") throw new Error(`mouse.ps1: ${r.stdout}${r.stderr}`);
}

/** Visibility and rect of a top-level window by title. (Screenshots cannot prove a capture-excluded window is on screen:
 *  CopyFromScreen/BitBlt honour WDA_EXCLUDEFROMCAPTURE too.) */
function windowState(title) {
  const out = ps(
    `Add-Type 'using System;using System.Runtime.InteropServices; public class W { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); public struct R { public int L, T, Rt, B; } }';` +
      `[W]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null; $h=[W]::FindWindow([NullString]::Value, '${title}'); $r=New-Object W+R; [W]::GetWindowRect($h, [ref]$r) | Out-Null;` +
      `@{ found = ($h -ne [IntPtr]::Zero); visible = [W]::IsWindowVisible($h); foreground = ([W]::GetForegroundWindow() -eq $h); x = $r.L; y = $r.T; w = $r.Rt - $r.L; h = $r.B - $r.T } | ConvertTo-Json -Compress`,
  );
  return JSON.parse(out.trim());
}

/** Screenshot of one monitor (physical pixels, per-monitor DPI aware). */
function screenshot(mon, file) {
  ps(
    `Add-Type -AssemblyName System.Drawing; Add-Type 'using System;using System.Runtime.InteropServices; public class D { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }'; [D]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null;` +
      `$bmp=New-Object System.Drawing.Bitmap ${mon.w},${mon.h}; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${mon.x},${mon.y},0,0,$bmp.Size); $bmp.Save('${file}')`,
  );
}

function ffmpegRaw(input, filters, extra = []) {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...extra, "-i", input, "-frames:v", "1", "-vf", filters, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Every frame (sampled at `fps`) of a region of a video, as rgb24 buffers. */
function regionFrames(video, crop, fps = 4) {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", video, "-vf", `fps=${fps},${crop}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const [, w, h] = /crop=(\d+):(\d+)/.exec(crop).map(Number);
  const n = w * h * 3;
  const out = [];
  for (let o = 0; o + n <= raw.length; o += n) out.push(raw.subarray(o, o + n));
  return out;
}

/** Fraction of pixels matching a predicate in an RGB buffer. */
function fraction(buf, pred) {
  let hit = 0;
  for (let i = 0; i < buf.length; i += 3) if (pred(buf[i], buf[i + 1], buf[i + 2])) hit++;
  return hit / (buf.length / 3);
}
const isRed = (r, g, b) => r > 180 && g < 110 && b < 110 && r - g > 100; // pill dot / Stop button
const isAccent = (r, g, b) => r < 110 && g > 95 && g < 175 && b > 200 && b - r > 120; // control-strip slider + toggle blue
const redFraction = (buf) => fraction(buf, isRed);
const blueFraction = (buf) => fraction(buf, isAccent);
const r4 = (v) => +v.toFixed(4);

/** sha256 of config.dat's secret lines (never printed): they must survive every UI preference write byte-for-byte. */
function secretLinesHash() {
  const lines = readFileSync(join(INSTALL, "config.dat"), "utf8").split(/\r?\n/).filter((l) => /^device_(token|secret)=/.test(l));
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

let wrangler;
let agentPid;
let winHelper;
async function main() {
  mkdirSync(E2E, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  rmSync(INSTALL, { recursive: true, force: true });
  rmSync(OPEN_LOG, { force: true });
  for (const f of ["pill.png", "pill-rect.json", "bubble-rect.json", "controls-rect.json", "controls.png", "frame.png", "desktop-during-recording.png", "desktop-with-controls.png", "gdigrab-frame.png", "window-capture.json"]) {
    rmSync(join(SHOTS, f), { force: true });
  }

  const npmEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  execFileSync("node", [join(root, "scripts", "build-recorder-zip.mjs")], { stdio: "inherit" });
  execFileSync("node", [join(root, "scripts", "gen-dev-vars.mjs")], { stdio: "inherit" });
  rmSync(join(root, "worker", ".wrangler"), { recursive: true, force: true });
  const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  execFileSync("node", [wranglerJs, "d1", "migrations", "apply", "DB", "--local", "-c", "worker/wrangler.test.jsonc"], {
    cwd: root,
    env: { ...npmEnv, CI: "1" },
    stdio: "ignore",
  });
  step("d1 migrations applied (local)");

  wrangler = spawn("node", [wranglerJs, "dev", "-c", "worker/wrangler.test.jsonc", "--ip", "127.0.0.1", "--port", PORT, ...(PORT !== "8787" ? ["--inspector-port", String(Number(PORT) + 1000)] : []), "--log-level", "warn"], {
    cwd: root,
    env: npmEnv,
    stdio: ["ignore", openSync(join(E2E, "wrangler.log"), "w"), openSync(join(E2E, "wrangler.err.log"), "w")],
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) break;
    } catch {}
    if (i > 120) throw new Error("wrangler dev did not start");
    await sleep(500);
  }
  step("wrangler dev up", { pid: wrangler.pid });

  // --- bot flow over MCP ---
  const anon = await connect(BASE);
  const { api_key } = await callTool(anon, "signup", { bot_name: "e2e-bot" });
  let bot = await connect(BASE, api_key);
  step("signup ok (key not printed)");
  try {
    await callTool(bot, "start_recording", {});
    throw new Error("unpaired account was allowed to record");
  } catch (e) {
    if (e.data?.error !== "DEVICE_NOT_PAIRED") throw e;
    step("unpaired start refused", { error: e.data.error });
  }

  const inst = await callTool(bot, "get_installer");
  const served = await (await fetch(BASE + "/install.ps1")).arrayBuffer();
  const servedHash = createHash("sha256").update(Buffer.from(served)).digest("hex").toUpperCase();
  if (servedHash !== inst.install_ps1_sha256 || !inst.powershell.includes(servedHash)) throw new Error("installer hash mismatch");
  step("get_installer ok; one-liner pins served install.ps1 hash");

  const out = ps(inst.powershell, [], {
    AGENT_RECORDER_INSTALL_DIR: INSTALL,
    AGENT_RECORDER_USE_SYSTEM_TOOLS: "1",
    AGENT_RECORDER_NO_AUTOSTART: "1",
    AGENT_RECORDER_E2E_DIR: SHOTS,
    AGENT_RECORDER_OPEN_LOG: OPEN_LOG,
  });
  step("installer one-liner ran", { output: out.trim().split("\n").pop() });

  // Tampered installer is refused by the one-liner (hash check before execution).
  const tampered = inst.powershell.replace(inst.install_ps1_sha256, "0".repeat(64));
  const t = spawnSync("powershell.exe", ["-NoProfile", "-Command", tampered], {
    encoding: "utf8",
    env: { ...process.env, AGENT_RECORDER_INSTALL_DIR: join(E2E, "tampered"), AGENT_RECORDER_NO_AUTOSTART: "1" },
  });
  if (t.status === 0 || !/mismatch/i.test(t.stderr + t.stdout)) throw new Error("tampered hash was not rejected");
  step("one-liner aborts on hash mismatch");

  for (let i = 0; ; i++) {
    const s = await callTool(bot, "device_status");
    if (s.online) break;
    if (i > 40) throw new Error("device never came online; see .e2e/install/agent.log");
    await sleep(500);
  }
  agentPid = Number(readFileSync(join(INSTALL, "agent.pid"), "utf8"));
  step("device online", { agent_pid: agentPid });

  // --- idle resource sample ---
  await sleep(3000);
  const idleOut = join(E2E, "idle.json");
  await sample(agentPid, IDLE_SECONDS, idleOut); // async: a blocked event loop would break keep-alive sockets
  report.idle = summarize(readJson(idleOut));
  step("idle sample", report.idle);
  // Fresh MCP connection (the client's keep-alive socket may have been closed while idle).
  await bot.close().catch(() => {});
  bot = await connect(BASE, api_key);
  const afterIdle = await callTool(bot, "device_status");
  if (!afterIdle.online) throw new Error("device dropped offline while idle");
  step("device still online after idle", { online: afterIdle.online });

  // --- device inventory: on-connect report, then a live refresh over the signed devices command ---
  const cached = await callTool(bot, "list_devices");
  const devices = await callTool(bot, "list_devices", { refresh: true });
  if (!devices.monitors.length) throw new Error(`list_devices returned no monitors: ${devices.note}`);
  report.devices = {
    reported_on_connect: cached.monitors.length > 0,
    monitors: devices.monitors.map((m) => `${m.index}${m.primary ? "*" : ""} ${m.label} ${m.resolution} ${m.model ?? ""} (${m.id})`),
    mics: devices.mics.map((m) => `${m.name}${m.default ? " [default]" : ""}`),
    cameras: devices.cameras.map((c) => c.name),
  };
  step("list_devices", report.devices);

  // --- window: our own Chrome on YouTube, found through list_devices(refresh:true) like a bot would ---
  let winEntry, testHwnd;
  if (WINDOW) {
    const P = devices.monitors.find((m) => m.primary);
    winHelper = new Helper();
    const w = await openTestWindow(winHelper, "https://www.youtube.com/", { x: P.x + 200, y: P.y + 150, w: 1280, h: 800 });
    testHwnd = w.hwnd;
    await sleep(6000); // YouTube (or its consent page) renders
    const id = windowId(w.hwnd, w.pid, "chrome.exe");
    const fresh = await callTool(bot, "list_devices", { refresh: true });
    winEntry = fresh.windows.find((x) => x.id === id);
    if (!winEntry) throw new Error(`test window ${id} not in list_devices(refresh:true)`);
    // Only counts are printed: the other windows are the user's.
    const youtubeChromes = fresh.windows.filter((x) => /chrome/i.test(x.app + x.exe) && /youtube/i.test(x.title));
    report.window = { listed: winEntry, windows_listed: fresh.windows.length, youtube_chrome_windows: youtubeChromes.length };
    try {
      await callTool(bot, "start_recording", { window: "no such window zzq" });
      throw new Error("unknown window was accepted");
    } catch (e) {
      if (e.data?.error !== "WINDOW_NOT_FOUND") throw e;
      report.window.not_found = { error: e.data.error, candidates: e.data.candidates.length };
    }
    if (youtubeChromes.length > 1) {
      try {
        await callTool(bot, "start_recording", { window: "chrome youtube" });
        throw new Error("two YouTube Chrome windows did not give WINDOW_AMBIGUOUS");
      } catch (e) {
        if (e.data?.error !== "WINDOW_AMBIGUOUS") throw e;
        report.window.ambiguous = { error: e.data.error, candidates: e.data.candidates.length, ours_among_them: e.data.candidates.some((c) => c.id === id) };
      }
    }
    step("window listed; not-found/ambiguous refused before any quota", report.window);
    if (report.window.ambiguous && !report.window.ambiguous.ours_among_them) throw new Error("our window missing from the ambiguous candidates");
  }

  // --- record ---
  const secretsBefore = secretLinesHash();
  const recOut = join(E2E, "recording.json");
  const sampler = sample(agentPid, RECORD_SECONDS + 4, recOut);
  const start = await callTool(bot, "start_recording", {
    title: "E2E demo",
    max_seconds: 60,
    ...(WINDOW ? { window: winEntry.id } : MONITOR && { monitor: /^\d+$/.test(MONITOR) ? Number(MONITOR) : MONITOR }),
    ...(WEBCAM && { webcam: true, webcam_size: "medium", ...(SHAPE && { webcam_shape: SHAPE }) }),
    ...(MIC && { mic_device: MIC }),
  });
  const recId = start.recording_id;
  const monEntry = devices.monitors.find((m) => (WINDOW ? m.id === winEntry.monitor : start.monitor ? m.id === start.monitor : m.primary));
  const [mw, mh] = monEntry.resolution.split("x").map(Number);
  const mon = { x: monEntry.x, y: monEntry.y, w: mw, h: mh, index: monEntry.index, label: monEntry.label };
  report.recorded_monitor = { ...mon, id: monEntry.id, model: monEntry.model };
  step("start_recording", {
    status: start.status,
    ...(WINDOW ? { window: start.window, window_app: start.window_app } : { monitor: start.monitor ?? "primary (default)" }),
    mic: start.mic,
    mic_device: start.mic_device,
  });
  await sleep(4000);
  // Screen -> video pixels. Monitor recordings scale the monitor; window recordings crop the window's visible part
  // (window-capture.json, written by the recorder) and scale it to the fixed output size.
  for (let i = 0; WINDOW && i < 150 && !existsSync(join(SHOTS, "window-capture.json")); i++) await sleep(100);
  const cap = WINDOW ? readJson(join(SHOTS, "window-capture.json")) : null;
  const region = WINDOW ? { x: mon.x + cap.crop_x, y: mon.y + cap.crop_y, w: cap.crop_w, h: cap.crop_h } : { x: mon.x, y: mon.y, w: mon.w, h: mon.h };
  if (WINDOW) {
    report.window.capture = cap;
    report.window.brought_to_front = (await winHelper.cmd({ op: "foreground" })).hwnd === testHwnd;
    report.window.rect_now = (await testWindow(winHelper, testHwnd))?.rect;
  }
  screenshot(mon, join(SHOTS, "desktop-during-recording.png"));
  // gdigrab (the fallback capture path, on this monitor's offsets) must not see the pill either.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "gdigrab", "-offset_x", String(mon.x), "-offset_y", String(mon.y), "-video_size", `${mon.w}x${mon.h}`, "-i", "desktop", "-frames:v", "1", join(SHOTS, "gdigrab-frame.png")]);
  const status = await callTool(bot, "get_video", { recording_id: recId });
  step("mid-recording status", { status: status.status });
  const pillBefore = readJson(join(SHOTS, "pill-rect.json"));
  const inside = (r, w, h, a = mon) => r.x >= a.x && r.y >= a.y && r.x + w <= a.x + a.w && r.y + h <= a.y + a.h;
  report.ui_on_recorded_monitor = {
    pill: inside(pillBefore, pillBefore.w, pillBefore.h),
    // Window recordings: the bubble starts inside the window (bottom-left), so it is in the video.
    ...(WEBCAM && { bubble: ((b) => inside(b, b.w ?? b.side, b.h ?? b.side, region))(readJson(join(SHOTS, "bubble-rect.json"))) }),
  };
  step("pill/bubble opened on the recorded monitor", report.ui_on_recorded_monitor);
  if (Object.values(report.ui_on_recorded_monitor).includes(false)) throw new Error("UI opened on another monitor");

  // Webcam: click the bubble (no movement) -> the size/mirror control strip opens next to it.
  let bubble;
  if (WEBCAM) bubble = readJson(join(SHOTS, "bubble-rect.json"));
  if (WEBCAM && !NO_MOUSE) {
    mouse(bubble.x + bubble.side / 2, bubble.y + bubble.side / 2);
    for (let i = 0; i < 20 && !existsSync(join(SHOTS, "controls-rect.json")); i++) await sleep(100);
    if (!existsSync(join(SHOTS, "controls-rect.json"))) throw new Error("click on the bubble did not open the controls");
    await sleep(1500); // controls on screen for a while: every sampled video frame in this window must not show them
    const ctlWin = windowState("Agent Recorder webcam controls");
    report.controls_window = { open: ctlWin, rect: readJson(join(SHOTS, "controls-rect.json")), took_focus: ctlWin.foreground };
    step("bubble click opened the controls", report.controls_window);
    if (!ctlWin.visible || ctlWin.foreground) throw new Error("controls not visible after clicking the bubble (or they stole the focus)");
    // Clicking anywhere else hides them (a throwaway test window, so no real app is clicked).
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "click-away.ps1"), "-X", String(mon.x + 40), "-Y", String(mon.y + 40)], { encoding: "utf8" });
    if (r.stdout.trim() !== "ok") throw new Error(`click-away.ps1: ${r.stdout}${r.stderr}`);
    await sleep(300);
    report.controls_window.hidden_after_click_elsewhere = !windowState("Agent Recorder webcam controls").visible;
    step("click elsewhere hides the controls", { hidden: report.controls_window.hidden_after_click_elsewhere });
    if (!report.controls_window.hidden_after_click_elsewhere) throw new Error("controls stayed open after clicking elsewhere");
  }

  // The pill drags by its body only: a drag starting on Stop neither moves it nor stops the recording; a drag from the
  // body (the timer) moves it (down-right: it starts at the top edge) and the recording keeps going.
  let pillAfter = pillBefore;
  if (!NO_MOUSE) {
    const sx = pillBefore.stop_x + pillBefore.stop_w / 2;
    const sy = pillBefore.stop_y + pillBefore.stop_h / 2;
    mouse(sx, sy, sx + 90, sy + 50);
    await sleep(1000);
    const fromStop = readJson(join(SHOTS, "pill-rect.json"));
    const afterStopDrag = await callTool(bot, "get_video", { recording_id: recId });
    mouse(pillBefore.body_x, pillBefore.body_y, pillBefore.body_x + 90, pillBefore.body_y + 50);
    await sleep(1500);
    pillAfter = readJson(join(SHOTS, "pill-rect.json"));
    const afterDrag = await callTool(bot, "get_video", { recording_id: recId });
    // Exact delta is +90,+50 on an idle machine; someone using the mouse at the same time adds to it.
    report.pill_drag = {
      from: [pillBefore.x, pillBefore.y],
      to: [pillAfter.x, pillAfter.y],
      requested_delta: [90, 50],
      actual_delta: [pillAfter.x - pillBefore.x, pillAfter.y - pillBefore.y],
      moved: pillAfter.x >= pillBefore.x + 45 && pillAfter.y >= pillBefore.y + 25,
      stop_drag_ignored: fromStop.x === pillBefore.x && fromStop.y === pillBefore.y && afterStopDrag.status === "recording",
      status_after_drag: afterDrag.status,
      persisted: /^pill_at_/m.test(readFileSync(join(INSTALL, "config.dat"), "utf8")),
    };
    step("dragged the pill by its body (not from Stop)", report.pill_drag);
    if (!report.pill_drag.moved || !report.pill_drag.stop_drag_ignored || afterDrag.status !== "recording" || !report.pill_drag.persisted)
      throw new Error("pill drag failed, moved from Stop, or stopped the recording");
  } else step("E2E_NO_MOUSE: skipped pill drag, bubble controls and local Stop click (they inject real mouse input)");

  await sleep(Math.max(0, RECORD_SECONDS - 7) * 1000);
  await callTool(bot, "stop_recording", { recording_id: recId });
  step("stop_recording sent", { after_s: RECORD_SECONDS });

  let video;
  for (let i = 0; i < 6; i++) {
    video = await callTool(bot, "get_video", { recording_id: recId, wait_seconds: 25 });
    if (["ready", "failed"].includes(video.status)) break;
  }
  if (video.status !== "ready" || !video.share_url) throw new Error(`video not ready: ${JSON.stringify({ status: video.status, error: video.error })}`);
  step("get_video ready", { duration_s: video.duration_s, has_share_url: true, transcript_status: video.transcript_status, has_system_audio: video.has_system_audio });
  // Auto-open: the Worker pushes the owner link once; the agent "opens" it into the stub log (no browser tab).
  let opened = [];
  for (let i = 0; i < 50 && !opened.length; i++) {
    if (existsSync(OPEN_LOG)) opened = readFileSync(OPEN_LOG, "utf8").split(/\r?\n/).filter(Boolean);
    if (!opened.length) await sleep(100);
  }
  await sleep(1500); // a duplicate push would land by now
  opened = existsSync(OPEN_LOG) ? readFileSync(OPEN_LOG, "utf8").split(/\r?\n/).filter(Boolean) : [];
  report.auto_open = { opened: opened.length, is_owner_url: opened[0] === video.owner_url, system_audio_requested: start.system_audio };
  step("auto-open (stubbed opener)", report.auto_open);
  if (opened.length !== 1 || !report.auto_open.is_owner_url) throw new Error(`auto-open expected exactly one owner_url, got ${JSON.stringify(opened)}`);
  if (start.system_audio !== true || video.has_system_audio !== true) throw new Error("system audio should be on by default");
  await sampler;
  report.recording = summarize(readJson(recOut));
  step("recording sample", report.recording);
  report.secret_lines_unchanged = secretLinesHash() === secretsBefore;
  step("config.dat secret lines unchanged by UI prefs", { unchanged: report.secret_lines_unchanged });
  if (!report.secret_lines_unchanged) throw new Error("config.dat secret lines changed");

  // --- viewer + media ---
  const view = await fetch(video.share_url);
  const html = await view.text();
  const cookie = /mt=[^;]+/.exec(view.headers.get("set-cookie") ?? "")?.[0];
  if (view.status !== 200 || !html.includes("<video") || view.headers.get("x-robots-tag") !== "noindex, nofollow, noarchive" || !cookie) {
    throw new Error(`viewer failed: ${view.status}`);
  }
  step("viewer 200 with noindex + media cookie");
  const mediaUrl = `${BASE}/m/${recId}`;
  const range = await fetch(mediaUrl, { headers: { cookie, range: "bytes=0-1023" } });
  if (range.status !== 206) throw new Error(`range status ${range.status}`);
  step("range request", { status: range.status, content_range: range.headers.get("content-range") });
  const full = Buffer.from(await (await fetch(mediaUrl, { headers: { cookie } })).arrayBuffer());
  const mp4 = join(E2E, "recording.mp4");
  writeFileSync(mp4, full);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration", "-of", "json", mp4], { encoding: "utf8" }));
  const vs = probe.streams.find((s) => s.codec_type === "video");
  report.video = { bytes: full.length, ...vs, audio: probe.streams.some((s) => s.codec_type === "audio"), duration: Number(probe.format.duration) };
  step("downloaded mp4", report.video);
  const expectW = WINDOW ? cap.out_w : Math.min(mon.w, Math.round((mon.w * Math.min(1920 / mon.w, 1080 / mon.h, 1)) / 2) * 2);
  if (Math.abs(vs.width - expectW) > 2) throw new Error(`video is ${vs.width}x${vs.height}, expected ~${expectW} wide for ${WINDOW ? "the window" : `monitor ${mon.w}x${mon.h}`}`);
  if (!report.video.audio) throw new Error("the video has no audio track (mic and system audio are on by default)");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "3", "-i", mp4, "-frames:v", "1", join(SHOTS, "frame.png")]);
  step("frame extracted", { path: "shots/frame.png" });

  // --- the pill must not appear in the recording (both positions, every sampled frame) ---
  const kx = vs.width / region.w, ky = vs.height / region.h;
  /** ffmpeg crop of a screen rectangle in the video (clipped), or null when it is not in the recorded region. */
  const crop = (x, y, w, h) => {
    const X = Math.max(0, Math.round((x - region.x) * kx)), Y = Math.max(0, Math.round((y - region.y) * ky));
    const W = Math.min(vs.width, Math.round((x + w - region.x) * kx)) - X, H = Math.min(vs.height, Math.round((y + h - region.y) * ky)) - Y;
    return W >= 8 && H >= 8 ? `crop=${W}:${H}:${X}:${Y}` : null;
  };
  const pillSelf = ffmpegRaw(join(SHOTS, "pill.png"), "null");
  const desktopRegion = ffmpegRaw(join(SHOTS, "desktop-during-recording.png"), `crop=${pillBefore.w}:${pillBefore.h}:${pillBefore.x - mon.x}:${pillBefore.y - mon.y}`);
  const gdiRegion = ffmpegRaw(join(SHOTS, "gdigrab-frame.png"), `crop=${pillBefore.w}:${pillBefore.h}:${pillBefore.x - mon.x}:${pillBefore.y - mon.y}`);
  const pillCrops = [pillBefore, pillAfter].map((r) => crop(r.x, r.y, r.w, r.h)).filter(Boolean);
  const pillFrames = pillCrops.flatMap((c) => regionFrames(mp4, c));
  report.pill = {
    rect: pillBefore,
    capture_excluded_flag: pillBefore.capture_excluded,
    red_fraction_pill_render: r4(redFraction(pillSelf)),
    red_fraction_in_desktop_screenshot: r4(redFraction(desktopRegion)),
    red_fraction_in_gdigrab_frame: r4(redFraction(gdiRegion)),
    over_recorded_region: pillCrops.length > 0,
    frames_checked: pillFrames.length,
    red_fraction_in_video_max: pillFrames.length ? r4(Math.max(...pillFrames.map(redFraction))) : 0,
  };
  report.pill.absent_from_recording =
    report.pill.red_fraction_pill_render > 0.05 && report.pill.red_fraction_in_video_max < 0.01 && report.pill.red_fraction_in_gdigrab_frame < 0.01;
  step("pill exclusion check", report.pill);
  if (!report.pill.absent_from_recording) throw new Error("the pill appears in the recording");

  if (WEBCAM) {
    const agentLog = readFileSync(join(INSTALL, "agent.log"), "utf8");
    // Bubble present + ring stable across the recording (the cursor never crosses the ring). The capture no longer waits
    // for the camera, so frames are checked from 0.5 s after the bubble appeared (start timing), and at least from 1 s on.
    const timing = [...agentLog.matchAll(/start timing .*?t_first_frame=(\d+) .*?t_bubble=(\d+)/g)].pop();
    const bubbleAt = timing ? (Number(timing[2]) - Number(timing[1])) / 1000 : null;
    const ringFrom = Math.max(1, bubbleAt === null ? 1 : bubbleAt + 0.5);
    const bw = bubble.w ?? bubble.side, bh = bubble.h ?? bubble.side;
    const ringRect = { x: (bubble.x - region.x) * kx, y: (bubble.y - region.y) * ky, w: bw * kx, h: bh * ky, side: bw * kx, shape: bubble.shape, radius: (bubble.radius ?? bw / 2) * ky };
    const ring = ringStability(mp4, ringRect, bubble.ring_width * kx, ["-ss", ringFrom.toFixed(2)]);
    report.webcam = { bubble_shown: agentLog.includes("webcam bubble shown"), bubble_rect: bubble, bubble_after_first_frame_s: bubbleAt, ring, frame: "shots/frame.png" };
    if (!NO_MOUSE) {
      // Controls strip: on screen while open, never in the video.
      const ctl = readJson(join(SHOTS, "controls-rect.json"));
      const ctlSelf = ffmpegRaw(join(SHOTS, "controls.png"), "null");
      const ctlCrop = crop(ctl.x, ctl.y, ctl.w, ctl.h);
      const ctlFrames = ctlCrop ? regionFrames(mp4, ctlCrop) : [];
      report.webcam.controls = {
        rect: ctl,
        visible_on_screen: report.controls_window.open.visible,
        accent_fraction_render: r4(blueFraction(ctlSelf)),
        frames_checked: ctlFrames.length,
        accent_fraction_in_video_max: ctlFrames.length ? r4(Math.max(...ctlFrames.map(blueFraction))) : 0,
      };
      const c = report.webcam.controls;
      c.absent_from_recording = c.visible_on_screen && c.accent_fraction_render > 0.02 && c.accent_fraction_in_video_max < c.accent_fraction_render * 0.1;
    }
    step("webcam bubble", report.webcam);
    if (!report.webcam.bubble_shown) throw new Error("webcam bubble was not shown; see .e2e/agent.log");
    if (!ring.stable || ring.ring_luma_mean < (WINDOW ? 150 : 220)) throw new Error("bubble ring missing or unstable in the recording"); // dark window content dims the encoded 3 px ring
    if (report.webcam.controls && !report.webcam.controls.absent_from_recording) throw new Error("webcam controls appear in the recording (or never showed on screen)");
  }

  // --- local Stop button on the pill (a real click) stops + uploads ---
  if (NO_MOUSE) {
    report.result = "PASS";
    return;
  }
  rmSync(join(SHOTS, "pill-rect.json"), { force: true });
  const second = await callTool(bot, "start_recording", { title: "E2E local stop", max_seconds: 60 });
  for (let i = 0; i < 50 && !existsSync(join(SHOTS, "pill-rect.json")); i++) await sleep(100);
  await sleep(3000);
  const p2 = readJson(join(SHOTS, "pill-rect.json"));
  mouse(p2.stop_x + p2.stop_w / 2, p2.stop_y + p2.stop_h / 2);
  let v2;
  for (let i = 0; i < 6; i++) {
    v2 = await callTool(bot, "get_video", { recording_id: second.recording_id, wait_seconds: 25 });
    if (["ready", "failed"].includes(v2.status)) break;
  }
  if (v2.status !== "ready" || !(v2.duration_s < 20)) throw new Error(`local stop failed: ${v2.status} ${v2.duration_s}`);
  step("pill Stop button stopped + uploaded", { status: v2.status, duration_s: v2.duration_s, pill_restored_at: [p2.x, p2.y] });
  await sleep(2000);
  const opened2 = readFileSync(OPEN_LOG, "utf8").split(/\r?\n/).filter(Boolean);
  step("auto-open after the Stop click", { opened_total: opened2.length, second_is_owner_url: opened2[1] === v2.owner_url });
  if (opened2.length !== 2 || opened2[1] !== v2.owner_url) throw new Error("the Stop-click recording was not auto-opened exactly once");

  report.result = "PASS";
}

function sample(pid, seconds, out) {
  const p = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "sample-procs.ps1"), "-AgentPid", String(pid), "-Seconds", String(seconds), "-Out", out],
    { stdio: "ignore" },
  );
  return new Promise((r) => p.on("exit", r));
}

function summarize(data) {
  const by = {};
  for (const s of data.samples ?? []) (by[s.name] ??= []).push(s);
  const out = { cores: data.cores };
  for (const [name, rows] of Object.entries(by)) {
    const pids = [...new Set(rows.map((r) => r.pid))];
    let cpuMs = 0;
    let wallMs = 0;
    for (const pid of pids) {
      const r = rows.filter((x) => x.pid === pid);
      cpuMs += r[r.length - 1].cpu_ms - r[0].cpu_ms;
      wallMs = Math.max(wallMs, Date.parse(r[r.length - 1].t) - Date.parse(r[0].t));
    }
    const mb = (v) => +(v / 1048576).toFixed(1);
    out[name] = {
      processes: pids.length,
      samples: rows.length,
      private_mb_avg: mb(rows.reduce((a, r) => a + r.private, 0) / rows.length),
      private_mb_max: mb(Math.max(...rows.map((r) => r.private))),
      ws_mb_avg: mb(rows.reduce((a, r) => a + r.ws, 0) / rows.length),
      ws_mb_max: mb(Math.max(...rows.map((r) => r.ws))),
      cpu_pct_of_one_core: wallMs ? +((cpuMs / wallMs) * 100).toFixed(2) : 0,
      cpu_pct_of_machine: wallMs ? +((cpuMs / wallMs / data.cores) * 100).toFixed(3) : 0,
    };
  }
  return out;
}

async function cleanup() {
  try {
    if (winHelper) {
      await closeTestWindows(winHelper);
      winHelper.close();
      step("closed the test Chrome");
    }
  } catch (e) {
    step("test window cleanup error", { err: String(e.message).slice(0, 200) });
  }
  try {
    if (existsSync(join(INSTALL, "agent.log"))) writeFileSync(join(E2E, "agent.log"), readFileSync(join(INSTALL, "agent.log")));
  } catch {}
  try {
    if (existsSync(join(INSTALL, "uninstall.ps1"))) {
      ps(`& '${join(INSTALL, "uninstall.ps1")}' -InstallDir '${INSTALL}'`);
      step("uninstalled agent");
    }
  } catch (e) {
    step("uninstall error", { err: String(e.message).slice(0, 200) });
  }
  if (agentPid) {
    try {
      process.kill(agentPid, 0);
      spawnSync("taskkill", ["/PID", String(agentPid), "/T", "/F"]);
    } catch {}
  }
  if (wrangler?.pid) spawnSync("taskkill", ["/PID", String(wrangler.pid), "/T", "/F"]);
  await sleep(1000);
  // Only this run's agent counts (a real install under %LOCALAPPDATA% may be running too).
  const left = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='AgentRecorder.exe'" | Where-Object { $_.ExecutablePath -like '${INSTALL}*' } | Select-Object -Expand ProcessId`],
    { encoding: "utf8" },
  ).stdout;
  report.agent_processes_left = left.trim().length > 0;
  let wranglerAlive = false;
  try {
    if (wrangler?.pid) {
      process.kill(wrangler.pid, 0);
      wranglerAlive = true;
    }
  } catch {}
  report.wrangler_left = wranglerAlive;
  report.ffmpeg_children_left = /ffmpeg/i.test(
    spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*agent-recorder*' } | Select-Object -Expand Name`], { encoding: "utf8" }).stdout,
  );
  step("cleanup done", { agent_left: report.agent_processes_left, wrangler_left: wranglerAlive, ffmpeg_left: report.ffmpeg_children_left });
}

try {
  await main();
} catch (e) {
  report.result = "FAIL";
  report.error = String(e?.message ?? e);
  console.error("[e2e] FAIL:", report.error);
} finally {
  await cleanup();
  writeFileSync(join(E2E, "report.json"), JSON.stringify(report, null, 2));
  console.log(`[e2e] result: ${report.result} (report: .e2e/report.json)`);
  process.exit(report.result === "PASS" ? 0 : 1);
}
