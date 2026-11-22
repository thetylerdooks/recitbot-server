// Window recording on this PC, with the test's OWN windows only (the user's windows are never touched; no mouse or
// keyboard input is injected). Launches a separate Chrome (own --user-data-dir in %TEMP%, hardware acceleration on, the
// default) showing YouTube plus a magenta "occluder" window of the same test Chrome, then records the YouTube window with
// `AgentRecorder.exe --record-local` (no server) while scripts/win-helper.ps1 drives it through:
//   (a) normal  (b) minimized, then restored  (d) resized  (e) partly covered  (c) moved to another monitor
// and checks sampled frames: (f) GPU content is not black, black while minimized, letterbox after the resize, the
// occluder is visible while on top, content again after the monitor switch. Also tries the gdigrab title= alternative.
// Usage: node scripts/window-cases.mjs [--webcam]   (report: .wintest/report.json, frames: .wintest/*.png)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeTestWindows, Helper, openTestWindow, testWindow, windowId } from "./test-windows.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, ".wintest");
const EXE = join(root, "build", "AgentRecorder.exe");
const WEBCAM = process.argv.includes("--webcam");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started_at: new Date().toISOString(), webcam: WEBCAM, events: [], phases: {} };
const log = (m, d = {}) => console.log(`[wintest] ${m}${Object.keys(d).length ? " " + JSON.stringify(d) : ""}`);

/** rgb24 frames of a video at `fps`, scaled to `w` wide. */
function frames(video, fps, w) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", video], { encoding: "utf8" }));
  const s = probe.streams[0];
  const h = Math.round((s.height * w) / s.width / 2) * 2;
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", video, "-vf", `${fps ? `fps=${fps},` : ""}scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 30 });
  const n = w * h * 3;
  const out = [];
  for (let o = 0, i = 0; o + n <= raw.length; o += n, i++) out.push({ t: i / fps, buf: raw.subarray(o, o + n) });
  return { width: s.width, height: s.height, duration: Number(probe.format.duration), w, h, list: out };
}

/** Stats of one frame: luma mean/std, black and magenta fractions, black fraction of the outer 8 % columns and rows. */
function stats(buf, w, h) {
  let sum = 0, sq = 0, black = 0, mag = 0, sideBlack = 0, sideN = 0, tbBlack = 0, tbN = 0;
  const bw = Math.max(1, Math.round(w * 0.08)), bh = Math.max(1, Math.round(h * 0.08));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += l;
      sq += l * l;
      const k = r < 14 && g < 14 && b < 14;
      if (k) black++;
      if (r > 190 && g < 80 && b > 190) mag++;
      if (x < bw || x >= w - bw) { sideN++; if (k) sideBlack++; }
      if (y < bh || y >= h - bh) { tbN++; if (k) tbBlack++; }
    }
  }
  const n = w * h;
  const mean = sum / n;
  return { luma: +mean.toFixed(1), std: +Math.sqrt(sq / n - mean * mean).toFixed(1), black: +(black / n).toFixed(3), magenta: +(mag / n).toFixed(3), side_bars: +(sideBlack / sideN).toFixed(3), top_bottom_bars: +(tbBlack / tbN).toFixed(3) };
}

function phase(f, from, to) {
  const sel = f.list.filter((x) => x.t >= from && x.t <= to).map((x) => stats(x.buf, f.w, f.h));
  if (!sel.length) return { frames: 0 };
  const avg = (k) => +(sel.reduce((a, s) => a + s[k], 0) / sel.length).toFixed(3);
  const min = (k) => Math.min(...sel.map((s) => s[k]));
  const max = (k) => Math.max(...sel.map((s) => s[k]));
  return { from: +from.toFixed(2), to: +to.toFixed(2), frames: sel.length, luma: avg("luma"), std_min: min("std"), black_avg: avg("black"), black_max: max("black"), black_min: min("black"), magenta_max: max("magenta"), side_bars: avg("side_bars"), top_bottom_bars: avg("top_bottom_bars") };
}

function png(video, t, file) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", video, "-frames:v", "1", "-vf", "scale=640:-2", join(OUT, file)]);
}

let helper, rec;
async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const inv = JSON.parse(execFileSync(EXE, ["--list-devices"], { encoding: "utf8" }));
  const P = inv.monitors.find((m) => m.primary);
  const S = inv.monitors.find((m) => !m.primary);
  if (!S) throw new Error("needs a second monitor for case (c)");
  helper = new Helper();

  // --- own Chrome (separate profile = separate browser process tree), YouTube + magenta occluder ---
  let main = await openTestWindow(helper, "https://www.youtube.com/", { x: P.x + 200, y: P.y + 150, w: 1280, h: 800 });
  const parked = { x: P.x + P.width - 560, y: P.y + 40, w: 500, h: 300 }; // top-right corner, away from the test Chrome
  const occ = await openTestWindow(helper, "data:text/html,<title>AR occluder</title><body style='margin:0;background:%23ff00ff'></body>", parked);
  await sleep(6000); // let YouTube (or its consent page) render
  main = await testWindow(helper, main.hwnd);
  const id = windowId(main.hwnd, main.pid, "chrome.exe");
  report.window = { id, title: main.title, rect: main.rect };
  log("test windows ready", { main: main.title, id, occluder: occ.hwnd });

  // --- gdigrab title= alternative (window DC capture) vs the monitor crop the recorder uses ---
  const alt = join(OUT, "gdigrab-title.png");
  const g = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "gdigrab", "-i", `title=${main.title}`, "-frames:v", "1", alt], { encoding: "utf8" });
  if (g.status === 0) {
    const f = frames(alt, 0, 320);
    report.gdigrab_title = { ok: true, ...stats(f.list[0].buf, f.w, f.h) };
  } else report.gdigrab_title = { ok: false, error: g.stderr.trim().slice(0, 200) };
  log("gdigrab title= alternative", report.gdigrab_title);

  // --- one recording, all cases on a timeline (seconds after the recorder reports "recording") ---
  const env = { ...process.env, AGENT_RECORDER_E2E_DIR: OUT };
  rec = spawn(EXE, ["--record-local", "40", "--out", OUT, "--window", id, ...(WEBCAM ? ["--webcam"] : [])], { env, stdio: ["pipe", "pipe", "inherit"] });
  const statuses = [];
  let onStatus;
  createInterface({ input: rec.stdout }).on("line", (l) => {
    const s = JSON.parse(l);
    statuses.push(s);
    log("recorder", s);
    onStatus?.(s);
  });
  const status = (want) => new Promise((r) => {
    const hit = statuses.find((s) => want.includes(s.status));
    if (hit) return r(hit);
    onStatus = (s) => want.includes(s.status) && r(s);
  });
  const first = await status(["recording", "failed"]);
  if (first.status !== "recording") throw new Error(`recording failed: ${first.error}`);
  const t0 = Date.now();
  const sampler = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "sample-procs.ps1"), "-AgentPid", String(rec.pid), "-Seconds", "22", "-Out", join(OUT, "procs.json")], { stdio: "ignore" });
  const sampled = new Promise((r) => sampler.on("exit", r));
  const at = async (s) => sleep(Math.max(0, t0 + s * 1000 - Date.now()));
  const ev = (key, name, data = {}) => {
    const e = { key, name, t: +((Date.now() - t0) / 1000).toFixed(2), ...data };
    report.events.push(e);
    log("event", e);
  };
  ev("recording", "recording", { foreground: (await helper.cmd({ op: "foreground" })).hwnd === main.hwnd });
  await at(4); await helper.cmd({ op: "minimize", hwnd: main.hwnd }); ev("minimize", "minimize (b)");
  await at(7); await helper.cmd({ op: "restore", hwnd: main.hwnd }); ev("restore", "restore (b)");
  await at(9);
  const r0 = await helper.cmd({ op: "rect", hwnd: main.hwnd });
  await helper.cmd({ op: "move", hwnd: main.hwnd, x: r0.x, y: r0.y, w: 1000, h: 900 }); ev("resize", "resize to 1000x900 (d)", { rect: await helper.cmd({ op: "rect", hwnd: main.hwnd }) });
  await at(12);
  const r1 = await helper.cmd({ op: "rect", hwnd: main.hwnd });
  await helper.cmd({ op: "move", hwnd: occ.hwnd, x: r1.x + r1.w - 450, y: r1.y + 200, w: 600, h: 400 });
  await helper.cmd({ op: "topmost", hwnd: occ.hwnd, on: true }); ev("cover", "occluder over the right part (e)");
  await at(15);
  await helper.cmd({ op: "topmost", hwnd: occ.hwnd, on: false });
  await helper.cmd({ op: "move", hwnd: occ.hwnd, ...parked }); ev("uncover", "occluder away");
  await at(17);
  await helper.cmd({ op: "move", hwnd: main.hwnd, x: S.x + 150, y: S.y + 60, w: 1000, h: 900 }); ev("move", "move to the other monitor (c)", { rect: await helper.cmd({ op: "rect", hwnd: main.hwnd }) });
  await at(25); rec.stdin.write("stop\n"); ev("stop", "stop");
  const done = await status(["done", "failed"]);
  await sampled;
  if (done.status !== "done") throw new Error(`recording failed: ${done.error}`);
  report.recorder_log = readFileSync(join(OUT, "agent.log"), "utf8").split(/\r?\n/).filter((l) => /window|capture started|segments|ddagrab|webcam/.test(l)).map((l) => l.slice(28));
  report.final_rect = await helper.cmd({ op: "rect", hwnd: main.hwnd });
  if (WEBCAM && existsSync(join(OUT, "bubble-rect.json"))) report.bubble_rect_last = JSON.parse(readFileSync(join(OUT, "bubble-rect.json"), "utf8"));
  report.video_file = done.video;
  analyze();
}

/** Frame checks. Video time ~= event time + 2 s (the recorder reports "recording" after ddagrab's 2 s health check).
 *  "Black" means fully black and flat: YouTube's dark theme alone is ~70 % near-black pixels. */
function analyze() {
  const video = report.video_file;
  const f = frames(video, 4, 320);
  report.video = { width: f.width, height: f.height, duration: f.duration, capture: JSON.parse(readFileSync(join(OUT, "window-capture.json"), "utf8")) };
  const E = Object.fromEntries(report.events.map((e) => [e.key, e.t]));
  const off = 2.0;
  report.phases = {
    a_normal: phase(f, 0.5 + off, E.minimize + off - 0.3),
    b_minimized: phase(f, E.minimize + off + 0.8, E.restore + off - 0.3),
    b_restored: phase(f, E.restore + off + 0.8, E.resize + off - 0.3),
    d_resized: phase(f, E.resize + off + 0.8, E.cover + off - 0.3),
    e_covered: phase(f, E.cover + off + 0.8, E.uncover + off - 0.3),
    c_other_monitor: phase(f, f.duration - 4.5, f.duration - 0.5), // after the segment switch (its gap shifts later frames)
  };
  png(video, 2.5, "a-normal.png");
  png(video, E.minimize + off + 1.5, "b-minimized.png");
  png(video, E.resize + off + 1.5, "d-resized.png");
  png(video, E.cover + off + 1.5, "e-covered.png");
  png(video, f.duration - 1.5, "c-other-monitor.png");
  const p = report.phases;
  const content = (x) => x.frames > 0 && x.black_max < 0.98 && x.std_min > 10; // real pixels in every sampled frame
  report.verdict = {
    a_normal_and_f_gpu_not_black: content(p.a_normal) && p.a_normal.side_bars < 0.95, // no bars: the window fills the frame
    b_black_while_minimized: p.b_minimized.frames > 0 && p.b_minimized.black_min > 0.99 && p.b_minimized.std_min < 2,
    b_back_after_restore: content(p.b_restored),
    d_letterboxed_after_resize: content(p.d_resized) && p.d_resized.side_bars > 0.99, // narrower window: pillarbox bars
    e_occluder_recorded: p.e_covered.magenta_max > 0.05,
    c_follows_to_other_monitor: report.recorder_log.some((l) => /moved to monitor/.test(l)) && report.recorder_log.some((l) => /joined 2 segments/.test(l)) && content(p.c_other_monitor),
  };
  const procs = JSON.parse(readFileSync(join(OUT, "procs.json"), "utf8").replace(/^\uFEFF/, ""));
  const by = {};
  for (const s of procs.samples) (by[s.name] ??= []).push(s);
  report.resources = Object.fromEntries(Object.entries(by).map(([name, rows]) => {
    const pids = [...new Set(rows.map((r) => r.pid))];
    let cpu = 0, wall = 0;
    for (const pid of pids) {
      const r = rows.filter((x) => x.pid === pid);
      cpu += r[r.length - 1].cpu_ms - r[0].cpu_ms;
      wall = Math.max(wall, Date.parse(r[r.length - 1].t) - Date.parse(r[0].t));
    }
    return [name, { processes: pids.length, private_mb_max: +(Math.max(...rows.map((r) => r.private)) / 1048576).toFixed(1), cpu_pct_of_one_core: wall ? +((cpu / wall) * 100).toFixed(1) : 0 }];
  }));
  report.result = Object.values(report.verdict).every(Boolean) ? "PASS" : "FAIL";
}

async function cleanup() {
  if (rec && rec.exitCode === null) {
    rec.stdin.on("error", () => {});
    rec.stdin.write("stop\n");
  }
  try {
    if (helper) {
      await closeTestWindows(helper);
      helper.close();
    }
  } catch (e) {
    log("cleanup error", { err: String(e) });
  }
}

if (process.argv.includes("--analyze")) {
  // Re-check the last run's video without recording again: node scripts/window-cases.mjs --analyze
  Object.assign(report, JSON.parse(readFileSync(join(OUT, "report.json"), "utf8")));
  report.video_file ??= join(OUT, readdirSync(OUT).find((n) => /^local\d+\.mp4$/.test(n)));
  analyze();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, phases: report.phases }, null, 1));
  console.log(`[wintest] result: ${report.result}`);
  process.exit(report.result === "PASS" ? 0 : 1);
}

try {
  await main();
} catch (e) {
  report.result = "FAIL";
  report.error = String(e?.message ?? e);
  console.error("[wintest] FAIL:", report.error);
} finally {
  await cleanup();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, phases: report.phases, gdigrab_title: report.gdigrab_title, resources: report.resources, video: report.video }, null, 1));
  console.log(`[wintest] result: ${report.result} (.wintest/report.json)`);
  process.exit(report.result === "PASS" ? 0 : 1);
}
