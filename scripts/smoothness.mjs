// Recording smoothness: how many frames in a video actually show something new, for the whole frame, the screen
// without the webcam bubble, and the bubble itself (ffmpeg mpdecimate on each region, the method used to diagnose the
// laggy 1440p recordings). A 30 fps file of a constantly changing screen should be near 30 unique fps everywhere.
//
// Measure any recording:
//   node scripts/smoothness.mjs <video> [--bubble X,Y,W,H] [--circle] [--from S] [--to S]
//     --bubble is the bubble's box in video pixels (round bubble unless W != H; --circle forces round). Without it only
//     the whole frame is measured. --from/--to default to 1 s in and 0.5 s before the end.
//
// Drive the real recorder (AgentRecorder.exe --record-local, no mouse or keyboard injection) and measure each case:
//   node scripts/smoothness.mjs --run [--cases monitor,win-small,...] [--seconds 15] [--real-camera] [--label NAME]
//                                     [--monitor-index N] [--encoder NAME] [--video-path auto|gpu|cpu] [--exe PATH]
//                                     [--out DIR] [--no-mic]
//     Runs only on a NON-primary monitor (the first one, or --monitor-index N; the primary is refused, someone may be
//     using it), at below-normal priority (this script and everything it starts, the recorder's capture included via
//     --below-normal), and never takes the foreground: the motion source is scripts/motion-window.ps1 (shown without
//     activation) and the recorder gets --no-front. The foreground window is checked before and after every case.
//     The bubble shows the recorder's --test-camera pattern (changes every camera frame) unless --real-camera.
//     Cases: monitor (whole monitor), win-small (641x481), win-tiny (321x241), win-large (near full screen),
//     win-resize (1280x720, resized to 1701x957 half way). Prints a table and writes <out>/<label>/report.json.
//     Exit code 1 when a case misses the target (screen >= 28, bubble >= 25 unique fps).
//
// Synthetic sources (4K, ultrawide, any size) through the recorder's own capture filter and encoder:
//   node scripts/smoothness.mjs --chain 3840x2160,5120x1440 [--video-path auto|gpu|cpu] [--encoder NAME] [--frames N]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ringStability } from "./ring-metric.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(name);
const EXE = resolve(arg("--exe", join(root, "build", "AgentRecorder.exe")));
const OUT = resolve(arg("--out", join(root, ".e2e", "smooth")));
const SCREEN_MIN = 28;
const BUBBLE_MIN = 25;

/** Unique frames (mpdecimate, default thresholds) of `vf` applied to [from, to) of video, and the longest freeze. */
function unique(video, from, to, vf) {
  const err = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-loglevel", "info", "-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", video, "-an", "-vf", `${vf ? vf + "," : ""}mpdecimate,showinfo`, "-fps_mode", "passthrough", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  ).stderr;
  const t = [...err.matchAll(/\bpts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  let gap = 0;
  for (let i = 1; i < t.length; i++) gap = Math.max(gap, t[i] - t[i - 1]);
  if (t.length) gap = Math.max(gap, to - from - (t[t.length - 1] - t[0]) - (t[0] > 0.05 ? t[0] : 0));
  return { unique: t.length, fps: +(t.length / (to - from)).toFixed(1), max_freeze_ms: Math.round(gap * 1000) };
}

/** Inner part of the bubble (no ring, no anti-aliased edge, no background), even-sized for the crop filter. */
function bubbleCore(b) {
  const round = b.circle ?? b.w === b.h;
  const kw = round ? 0.6 : 0.8, kh = round ? 0.6 : 0.7;
  const w = Math.max(2, Math.floor((b.w * kw) / 2) * 2), h = Math.max(2, Math.floor((b.h * kh) / 2) * 2);
  return { x: Math.round(b.x + (b.w - w) / 2), y: Math.round(b.y + (b.h - h) / 2), w, h };
}

/** crop filter for the bubble's core, cut to the frame (size s) when the bubble sticks out of it. */
const cropOf = (b, s) => {
  const c = bubbleCore(b);
  const x0 = Math.max(0, c.x), y0 = Math.max(0, c.y);
  const w = Math.floor((Math.min(s.width, c.x + c.w) - x0) / 2) * 2, h = Math.floor((Math.min(s.height, c.y + c.h) - y0) / 2) * 2;
  return `crop=${w}:${h}:${x0}:${y0}`;
};

export function measure(video, { bubble, from, to } = {}) {
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", video], { encoding: "utf8" }));
  const duration = Number(p.format.duration);
  const s = p.streams[0];
  from = from ?? Math.min(1, duration / 4);
  to = Math.min(to ?? duration - 0.5, duration);
  const out = { video, width: s.width, height: s.height, nominal_fps: s.r_frame_rate, duration: +duration.toFixed(2), from: +from.toFixed(2), to: +to.toFixed(2) };
  out.whole = unique(video, from, to, "");
  if (bubble) {
    const b = { x: Math.round(bubble.x), y: Math.round(bubble.y), w: Math.round(bubble.w), h: Math.round(bubble.h), circle: bubble.circle };
    // A bubble bigger than a small window sticks out of the video: measure the part inside, never a shifted box.
    b.clipped = b.x < 0 || b.y < 0 || b.x + b.w > s.width || b.y + b.h > s.height;
    out.bubble_box = b;
    // Screen = the whole frame with the bubble (plus a margin for its anti-aliased edge) painted black.
    out.screen = unique(video, from, to, `drawbox=x=${b.x - 4}:y=${b.y - 4}:w=${b.w + 8}:h=${b.h + 8}:color=black:t=fill`);
    out.bubble = unique(video, from, to, cropOf(b, s));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- driving the recorder

/** scripts/motion-window.ps1 at rect (physical pixels): never activated, repaints its whole area ~60 times a second. */
function openMotion(rect) {
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "motion-window.ps1"), "-X", String(rect.x), "-Y", String(rect.y), "-W", String(rect.w), "-H", String(rect.h)], { stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { p.kill(); fail(new Error("motion window did not appear")); }, 30000);
    createInterface({ input: p.stdout }).once("line", (l) => {
      clearTimeout(timer);
      ok({ ...JSON.parse(l), exe: "powershell.exe", stop: () => { p.stdin.end(); setTimeout(() => p.kill(), 1000); } });
    });
  });
}

function sample(pid, seconds, out) {
  const p = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "sample-procs.ps1"), "-AgentPid", String(pid), "-Seconds", String(seconds), "-Out", out],
    { stdio: "ignore" },
  );
  return new Promise((r) => p.on("exit", r));
}

/** Recorder + ffmpeg children: max private MB and CPU % of one core over the sample. */
function summarize(file) {
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  const rows = [].concat(data.samples ?? []);
  const by = {};
  for (const s of rows) (by[s.name] ??= []).push(s);
  const out = {};
  for (const [name, rs] of Object.entries(by)) {
    let cpuMs = 0, wallMs = 0;
    for (const pid of new Set(rs.map((r) => r.pid))) {
      const r = rs.filter((x) => x.pid === pid);
      cpuMs += r[r.length - 1].cpu_ms - r[0].cpu_ms;
      wallMs = Math.max(wallMs, Date.parse(r[r.length - 1].t) - Date.parse(r[0].t));
    }
    out[name] = {
      processes: new Set(rs.map((r) => r.pid)).size,
      private_mb_max: +(Math.max(...rs.map((r) => r.private)) / 1048576).toFixed(1),
      cpu_pct_of_one_core: wallMs ? +((cpuMs / wallMs) * 100).toFixed(1) : 0,
    };
  }
  return out;
}

async function record(dir, seconds, args, opts = {}) {
  const shots = join(dir, "shots");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const env = { ...process.env, AGENT_RECORDER_E2E_DIR: shots, AGENT_RECORDER_OPEN_LOG: join(dir, "opened-links.txt") };
  const p = spawn(EXE, ["--record-local", String(seconds), "--out", dir, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", () => {});
  let started = false;
  const sampled = (async () => {
    for (let i = 0; i < 100 && !out.includes('"recording"'); i++) await sleep(100);
    started = true;
    await sample(p.pid, Math.max(2, seconds - 3), join(dir, "sample.json"));
  })();
  const during = opts.during ? opts.during(() => out.includes('"recording"')) : null;
  const code = await new Promise((r) => p.on("exit", r));
  if (started) await sampled;
  await during;
  const done = out.split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((j) => j.status === "done");
  if (code !== 0 || !done) throw new Error(`${dir}: recorder exit ${code}; output:\n${out}`);
  const read = (f) => (existsSync(join(shots, f)) ? JSON.parse(readFileSync(join(shots, f), "utf8")) : null);
  const log = existsSync(join(dir, "agent.log")) ? readFileSync(join(dir, "agent.log"), "utf8") : "";
  return { pid: p.pid, video: done.video, capture: read("capture.json"), bubble: read("bubble-rect.json"), stats: read("bubble-stats.json"), resources: summarize(join(dir, "sample.json")), log };
}

/** Bubble box in video pixels: screen rect -> monitor-relative -> crop-relative -> scaled to the video (letterboxed). */
function bubbleInVideo(bubble, cap, video) {
  if (!bubble || !cap) return null;
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", video], { encoding: "utf8" })).streams[0];
  const k = Math.min(p.width / cap.crop_w, p.height / cap.crop_h);
  const ox = (p.width - cap.crop_w * k) / 2, oy = (p.height - cap.crop_h * k) / 2;
  return {
    x: (bubble.x - cap.monitor_x - cap.crop_x) * k + ox,
    y: (bubble.y - cap.monitor_y - cap.crop_y) * k + oy,
    w: bubble.w * k,
    h: bubble.h * k,
    circle: bubble.shape !== "rect",
  };
}

/** Other recorder builds capturing on this PC right now (their bubble, camera and screen load would skew a run). */
function otherRecorders() {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Process AgentRecorder -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + ' ' + $_.Path }"], { encoding: "utf8" });
  const installed = join(process.env.LOCALAPPDATA ?? "", "AgentRecorder").toLowerCase();
  return (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.toLowerCase().includes(EXE.toLowerCase()) && !l.toLowerCase().includes(installed));
}

async function waitQuiet(name) {
  for (let i = 0, quiet = 0; i < 600 && quiet < 3; i++) {
    const others = otherRecorders();
    quiet = others.length ? 0 : quiet + 1;
    if (others.length && i % 30 === 0) console.log(`[smooth] ${name}: waiting for another recorder to finish: ${others.join("; ")}`);
    await sleep(1000);
  }
}

async function run() {
  // Below normal for this script and (inherited) everything it starts.
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const { Helper, windowId } = await import("./test-windows.mjs");
  if (!existsSync(EXE)) throw new Error(`${EXE} missing: run npm run build first`);
  const label = arg("--label", "after");
  const out = join(OUT, label);
  mkdirSync(out, { recursive: true });
  const seconds = Number(arg("--seconds", "15"));
  const videoPath = arg("--video-path", null);
  const encoder = arg("--encoder", null);
  const cases = arg("--cases", "monitor,win-small,win-tiny,win-large,win-resize").split(",");
  const inv = JSON.parse(execFileSync(EXE, ["--list-devices"], { encoding: "utf8" }));
  const others = inv.monitors.filter((m) => !m.primary);
  const mon = arg("--monitor-index", null) != null ? inv.monitors.find((m) => m.index === Number(arg("--monitor-index"))) : others[0];
  if (!mon) throw new Error("no non-primary monitor: nothing is recorded on the primary");
  if (mon.primary) throw new Error("refusing the primary monitor");
  const base = ["--monitor", mon.id, "--webcam", ...(flag("--no-mic") ? [] : ["--mic"]), "--no-front", "--below-normal", ...(flag("--real-camera") ? [] : ["--test-camera"]), ...(encoder ? ["--encoder", encoder] : []), ...(videoPath ? ["--video-path", videoPath] : [])];
  const helper = new Helper();
  const report = { started_at: new Date().toISOString(), label, exe: EXE, monitor: { id: mon.id, index: mon.index, size: `${mon.width}x${mon.height}`, scale: mon.scale }, video_path: videoPath ?? "auto", camera: flag("--real-camera") ? "real" : "test", cases: {} };
  const rects = {
    monitor: { x: mon.x, y: mon.y, w: mon.width, h: mon.height },
    "win-small": { x: mon.x + 200, y: mon.y + 150, w: 641, h: 481 },
    "win-tiny": { x: mon.x + 301, y: mon.y + 201, w: 321, h: 241 },
    "win-large": { x: mon.x + 20, y: mon.y + 20, w: mon.width - 40, h: mon.height - 100 },
    "win-resize": { x: mon.x + 100, y: mon.y + 100, w: 1280, h: 720 },
  };
  try {
    for (const name of cases) {
      const rect = rects[name];
      if (!rect) throw new Error(`unknown case ${name}`);
      await waitQuiet(name);
      const fgBefore = await helper.cmd({ op: "foreground" });
      const w = await openMotion(rect);
      await sleep(1500);
      const target = name.startsWith("win-") ? ["--window", windowId(w.hwnd, w.pid, w.exe)] : [];
      const dir = join(out, name);
      let resizedAt = null, bubbleBefore = null;
      let r;
      try {
        r = await record(dir, seconds, [...base, ...target], {
          during: name === "win-resize" ? async (recording) => {
            while (!recording()) await sleep(50);
            const t0 = Date.now();
            await sleep((seconds / 2) * 1000);
            // The bubble follows the window when it is resized: keep where it was before.
            const f = join(dir, "shots", "bubble-rect.json");
            if (existsSync(f)) bubbleBefore = JSON.parse(readFileSync(f, "utf8"));
            await helper.cmd({ op: "move", hwnd: w.hwnd, x: rect.x, y: rect.y, w: 1701, h: 957 });
            resizedAt = (Date.now() - t0) / 1000;
          } : null,
        });
      } finally {
        w.stop();
      }
      const fgAfter = await helper.cmd({ op: "foreground" });
      // A build without capture.json (older ones) recorded the whole monitor.
      const cap = r.capture ?? { monitor_x: mon.x, monitor_y: mon.y, crop_x: 0, crop_y: 0, crop_w: mon.width, crop_h: mon.height };
      const m = measure(r.video, { bubble: bubbleInVideo(bubbleBefore ?? r.bubble, cap, r.video) });
      // After a resize the picture is letterboxed and the bubble has moved: measure the bubble up to the resize.
      if (resizedAt && m.bubble_box) m.bubble = unique(r.video, m.from, Math.min(m.to, resizedAt - 0.3), cropOf(m.bubble_box, m));
      // Broken-ring flicker metric (scripts/ring-metric.mjs) on the same video, where the bubble stays put and the whole
      // ring is in the picture (a bubble taller than a tiny window is cut by the video's edge: not measurable).
      const bb = m.bubble_box;
      if (bb?.clipped) m.ring = { clipped: true };
      else if (bb && !resizedAt && r.bubble) {
        const k = bb.w / r.bubble.w;
        // The capture no longer waits for the camera: the ring is checked from 0.5 s after the bubble appeared (start
        // timing), as scripts/e2e.mjs does.
        const timing = [...r.log.matchAll(/start timing .*?t_first_frame=(\d+) .*?t_bubble=(\d+)/g)].pop();
        const ringFrom = timing ? Math.max(0, (Number(timing[2]) - Number(timing[1])) / 1000 + 0.5) : 0;
        const rr = ringStability(r.video, bb.circle ? { x: bb.x, y: bb.y, side: bb.w } : { x: bb.x, y: bb.y, w: bb.w, h: bb.h, shape: "rect", radius: r.bubble.radius * k }, r.bubble.ring_width * k, ["-ss", ringFrom.toFixed(2)]);
        m.ring = { broken_frames: rr.frames_with_broken_ring, temporal_std: rr.ring_temporal_std_mean, stable: rr.stable };
      }
      const pathLine = /video path: (\S+)/.exec(r.log);
      const path = r.capture?.path ? `${r.capture.fast ? "" : "gdigrab "}${r.capture.path}` : pathLine ? pathLine[1] : /capture started \(ddagrab/.test(r.log) ? "cpu" : "?";
      const encLine = /capture started \([^,]+, (\S+),/.exec(r.log);
      const row = {
        case: name, source: `${cap.crop_w}x${cap.crop_h}`, video: `${m.width}x${m.height}`, path, encoder: r.capture?.encoder ?? encLine?.[1],
        whole_fps: m.whole.fps, screen_fps: m.screen?.fps, bubble_fps: m.bubble?.fps, screen_freeze_ms: m.screen?.max_freeze_ms, bubble_freeze_ms: m.bubble?.max_freeze_ms,
        bubble_redraw: r.stats, resources: r.resources, ring_broken_frames: m.ring?.clipped ? "clipped" : m.ring?.broken_frames, resized_at_s: resizedAt,
        moved_monitor: /moved to monitor/.test(r.log), wrong_monitor: cap.monitor_x !== mon.x || cap.monitor_y !== mon.y,
        foreground_kept: fgBefore.hwnd === fgAfter.hwnd, foreground: { before: fgBefore, after: fgAfter },
        // The user switching windows meanwhile is fine; one of ours in front is not.
        foreground_taken: fgBefore.hwnd !== fgAfter.hwnd && [r.pid, w.pid].includes(fgAfter.pid),
      };
      row.ok = (m.screen?.fps ?? m.whole.fps) >= SCREEN_MIN && (m.bubble ? m.bubble.fps >= BUBBLE_MIN : true) && !row.moved_monitor && !row.wrong_monitor && !(m.ring?.broken_frames > 0) && !row.foreground_taken;
      report.cases[name] = { ...row, measure: m };
      console.log(`[smooth] ${label} ${name} ${JSON.stringify(row)}`);
      if (!row.foreground_kept) console.log(`[smooth] WARNING: the foreground window changed during ${name} (${fgBefore.hwnd} -> ${fgAfter.hwnd}, pid ${fgAfter.pid})`);
    }
  } finally {
    helper.close();
  }
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${label} on monitor ${mon.index} (${mon.width}x${mon.height})`);
  console.log("case        source      video       path       whole  screen bubble  redraw(cam/present fps)  ring  rec CPU%core  ffmpeg CPU%core  RAM MB(rec)");
  for (const c of Object.values(report.cases)) {
    const res = c.resources ?? {};
    const rd = c.bubble_redraw ? `${c.bubble_redraw.camera_fps}/${c.bubble_redraw.present_fps}` : "-";
    console.log(
      [c.case.padEnd(11), c.source.padEnd(11), c.video.padEnd(11), String(c.path).padEnd(10), String(c.whole_fps).padStart(5), String(c.screen_fps ?? "-").padStart(6), String(c.bubble_fps ?? "-").padStart(6), rd.padStart(24), String(c.ring_broken_frames ?? "-").padStart(5), String(res.AgentRecorder?.cpu_pct_of_one_core ?? "-").padStart(12), String(res.ffmpeg?.cpu_pct_of_one_core ?? "-").padStart(16), String(res.AgentRecorder?.private_mb_max ?? "-").padStart(12), c.ok ? " ok" : " BELOW TARGET"].join(" "),
    );
  }
  if (Object.values(report.cases).some((c) => !c.ok)) process.exitCode = 1;
}

/** --chain WxH,...: the recorder's own filter/encoder for a synthetic source of that size (AgentRecorder --chain-bench). */
function chain() {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const args = ["--chain-bench", arg("--chain", "3840x2160,5120x1440"), "--below-normal"];
  for (const k of ["--encoder", "--video-path", "--frames"]) if (arg(k, null)) args.push(k, arg(k));
  const r = spawnSync(EXE, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(r.stdout);
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exitCode = 1; }
}

async function main() {
  if (flag("--run")) return run();
  if (flag("--chain")) return chain();
  const video = process.argv[2];
  if (!video || video.startsWith("--")) throw new Error("usage: node scripts/smoothness.mjs <video> [--bubble X,Y,W,H] [--circle] [--from S] [--to S] | --run ... | --chain WxH,...");
  const b = arg("--bubble", null)?.split(",").map(Number);
  const res = measure(video, {
    bubble: b ? { x: b[0], y: b[1], w: b[2], h: b[3], circle: flag("--circle") || undefined } : null,
    from: arg("--from", null) != null ? Number(arg("--from")) : undefined,
    to: arg("--to", null) != null ? Number(arg("--to")) : undefined,
  });
  console.log(JSON.stringify(res, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
