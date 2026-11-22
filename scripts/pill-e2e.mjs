// Control pill end-to-end on one monitor (no server, no mouse or keyboard input). Records with the mic and system audio
// while a quiet (-30 dBFS) 440 Hz tone plays through the default output, presses the pill's PC-sound and mic toggles
// once each (--toggle: the pill's own Toggle(), the code path a click takes), and checks on the final MP4:
//   1. the pill is not in the video: its region in every sampled frame has none of its Tally Red (its own render does);
//   2. the mute stretches: the tone before the PC-sound toggle, the tone gone after it (mic still on), digital silence
//      once the mic is muted too;
//   3. drift: where the tone and the mic actually stop in the audio against where the recorder put the mutes
//      (audio-mix.json; the mic's mute is mixed 100 ms early), and the audio track's length against the video's.
// The monitor is required and the primary is refused (test on a secondary monitor beside someone using the PC). Runs
// itself and every child (recorder, ffmpeg) at below-normal priority, ffmpeg analysis on 2 threads.
// Usage: npm run build && node scripts/pill-e2e.mjs --monitor ID [--seconds 20] [--toggle sys@6,mic@12] [--out DIR]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

setPriority(constants.priority.PRIORITY_BELOW_NORMAL); // inherited by the recorder and every ffmpeg
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(root, "build", "AgentRecorder.exe");
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const MONITOR = arg("--monitor");
const SECONDS = Number(arg("--seconds", "20"));
const TOGGLE = arg("--toggle", "sys@6,mic@12");
const OUT = resolve(arg("--out", join(root, ".e2e", "pill")));
const TONE_HZ = 440;
const report = { started_at: new Date().toISOString(), monitor: MONITOR, seconds: SECONDS, toggle: TOGGLE, checks: [] };
const log = (name, data = {}) => console.log(`[pill-e2e] ${name} ${JSON.stringify(data)}`);
const ms = (s) => Math.round(s * 1000);

function expect(name, ok, data = {}) {
  report.checks.push({ name, ok, ...data });
  log(`${ok ? "PASS" : "FAIL"} ${name}`, data);
}

/** RMS level (dB) per window of `win` s starting in [from, to); band = only around the tone. -Infinity = digital
 * silence. Decoded from the start with each window's own timestamp: an input seek (-ss) on AAC lands tens of ms off. */
function levels(file, from, to, band, win = 0.25) {
  const af = `${band ? `bandpass=f=${TONE_HZ}:width_type=q:w=8,` : ""}asetnsamples=n=${Math.round(48000 * win)}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
  const err = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-loglevel", "info", "-threads", "2", "-i", file, "-t", (to + win).toFixed(3), "-vn", "-af", af, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stderr ?? "";
  return [...err.matchAll(/pts_time:([\d.]+)[\s\S]*?lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g)]
    .map((m) => ({ t: Number(m[1]), v: m[2].endsWith("inf") ? -Infinity : Number(m[2]) }))
    .filter((x) => x.t >= from - 1e-6 && x.t + win <= to + 1e-6);
}

const db = (file, from, to, band, win) => levels(file, from, to, band, win).map((x) => x.v);

const round = (a) => a.map((v) => (Number.isFinite(v) ? +v.toFixed(1) : String(v)));
const spans = (s) => (s ?? "").split(",").filter(Boolean).map((x) => x.split("-").map(Number));
const isRed = (r, g, b) => r > 180 && g < 110 && b < 110 && r - g > 100; // the pill's dot and Stop (#F2463A)

function redFraction(buf) {
  let red = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) if (isRed(buf[i], buf[i + 1], buf[i + 2])) red++;
  return red / (buf.length / 3);
}

/** Frames (sampled at `fps`) of a region of the video, as rgb24 buffers. */
function regionFrames(video, crop, fps = 4) {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "2", "-i", video, "-vf", `fps=${fps},${crop}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 512 * 1024 * 1024 });
  const [, w, h] = /crop=(\d+):(\d+)/.exec(crop).map(Number);
  const out = [];
  for (let o = 0; o + w * h * 3 <= raw.length; o += w * h * 3) out.push(raw.subarray(o, o + w * h * 3));
  return out;
}

/** Start (s) of the first window where `pred(level)` holds for it and the next `hold - 1` windows. */
function edge(ls, pred, hold) {
  for (let i = 0; i + hold <= ls.length; i++) if (ls.slice(i, i + hold).every((x) => pred(x.v))) return ls[i].t;
  return null;
}

function playTone(wav) {
  const p = spawn("powershell.exe", ["-NoProfile", "-Command", `$p = New-Object Media.SoundPlayer '${wav}'; $p.PlayLooping(); Start-Sleep -Seconds 300`], { stdio: "ignore" });
  return { stop: () => p.kill() };
}

async function main() {
  if (!MONITOR) throw new Error("--monitor ID is required (a secondary monitor; see --list-devices)");
  if (!existsSync(EXE)) throw new Error("build/AgentRecorder.exe missing: run npm run build first");
  const inv = JSON.parse(execFileSync(EXE, ["--list-devices"], { encoding: "utf8" }));
  const mon = inv.monitors.find((m) => m.id === MONITOR);
  if (!mon) throw new Error(`monitor ${MONITOR} not found`);
  if (mon.primary) throw new Error(`monitor ${MONITOR} is the primary; this test records a secondary monitor only`);
  report.monitor_info = { name: mon.friendly_name, x: mon.x, y: mon.y, w: mon.width, h: mon.height, scale: mon.scale };
  rmSync(OUT, { recursive: true, force: true });
  const shots = join(OUT, "shots");
  mkdirSync(shots, { recursive: true });
  const tone = join(OUT, "tone.wav");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${TONE_HZ}:sample_rate=48000:duration=20`, "-af", "volume=-30dB", "-ac", "2", tone]);

  const player = playTone(tone);
  await new Promise((r) => setTimeout(r, 1500));
  let out = "";
  let code;
  try {
    const p = spawn(EXE, ["--record-local", String(SECONDS), "--out", OUT, "--monitor", MONITOR, "--mic", "--system-audio", "--toggle", TOGGLE, "--below-normal"], {
      env: { ...process.env, AGENT_RECORDER_E2E_DIR: shots },
      stdio: ["pipe", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    code = await new Promise((r) => p.on("exit", r));
  } finally {
    player.stop();
  }
  const lines = out.split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const done = lines.find((j) => j.status === "done");
  if (code !== 0 || !done) throw new Error(`recorder exit ${code}; output:\n${out}`);
  report.toggles_pressed = lines.filter((j) => j.toggle);
  const mp4 = done.video;
  const mix = JSON.parse(readFileSync(join(shots, "audio-mix.json"), "utf8"));
  const pill = JSON.parse(readFileSync(join(shots, "pill-rect.json"), "utf8"));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", mp4], { encoding: "utf8" }));
  const vs = probe.streams.find((s) => s.codec_type === "video"), as = probe.streams.find((s) => s.codec_type === "audio");
  report.video = { file: mp4, width: vs.width, height: vs.height, duration: Number(probe.format.duration), video_s: Number(vs.duration), audio_s: as ? Number(as.duration) : null };
  report.pill = pill;
  log("recorded", { ...report.video, pill_at: [pill.x, pill.y], capture_mode: pill.capture_mode });

  // 1. The pill is not in the video.
  const kx = vs.width / mon.width, ky = vs.height / mon.height;
  const X = Math.round((pill.x - mon.x) * kx), Y = Math.round((pill.y - mon.y) * ky), W = Math.round(pill.w * kx), H = Math.round(pill.h * ky);
  const self = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", join(shots, "pill.png"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 16 * 1024 * 1024 });
  const frames = regionFrames(mp4, `crop=${W}:${H}:${X}:${Y}`);
  const inVideo = frames.map(redFraction);
  expect("pill was capture-excluded", pill.capture_excluded === true, { capture_mode: pill.capture_mode });
  expect("pill sits top-centre of the monitor's work area", Math.abs(pill.x + pill.w / 2 - (mon.x + mon.width / 2)) <= 1, { pill: [pill.x, pill.y, pill.w, pill.h] });
  expect("pill absent from every sampled frame of its region", redFraction(self) > 0.05 && frames.length >= SECONDS * 3 && Math.max(...inVideo) < 0.01, {
    red_in_pill_render: +redFraction(self).toFixed(4),
    frames_checked: frames.length,
    red_in_video_max: +Math.max(...inVideo).toFixed(4),
  });

  // 2. Mute stretches (video time, from the recorder's own mix report).
  const ts = spans(mix.sys_muted)[0]?.[0], tm = spans(mix.mic_muted)[0]?.[0];
  if (ts == null || tm == null) throw new Error(`no mute spans in audio-mix.json: ${JSON.stringify(mix)}`);
  const end = report.video.duration;
  const toneBefore = db(mp4, 0.5, ts - 0.3, true);
  const toneBetween = db(mp4, ts + 0.3, tm - 0.3, true);
  const between = db(mp4, ts + 0.3, tm - 0.3, false);
  const after = db(mp4, tm + 0.3, end - 0.1, false);
  const drop = Math.min(...toneBefore) - Math.max(...toneBetween);
  expect("tone before the PC-sound toggle", toneBefore.length > 2 && toneBefore.every((v) => v > -80), { tone_band_db: round(toneBefore) });
  expect("PC sound muted: tone gone (>= 30 dB drop), mic still on", toneBetween.length > 2 && drop >= 30 && between.every((v) => v > -130), {
    drop_db: +drop.toFixed(1),
    mic_db: round(between),
  });
  expect("mic muted too: digital silence to the end", after.length > 2 && after.every((v) => v === -Infinity), { db: round(after) });

  // 3. Drift: measured edges (5 ms windows, whole band: the tone is ~40 dB over the mic) against where the recorder put
  // the mutes: the first of 3 windows >= 20 dB under the tone (system) or >= 15 dB under the mic's own level (mic). AAC
  // reaches exact digital zero only 1-2 frames (21-43 ms) after its input does; that point is reported, not judged.
  // An edge inside AAC can only be placed to about one 1024-sample frame (21.3 ms): the bound is that plus one window.
  const win = 0.005;
  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const sysLv = levels(mp4, Math.max(0, ts - 0.5), ts + 0.5, false, win);
  const sysEdge = edge(sysLv, (v) => v < median(sysLv.filter((x) => x.t < ts - 0.05).map((x) => x.v)) - 20, 3);
  const micLv = levels(mp4, Math.max(ts + 0.05, tm - 0.6), tm + 0.5, false, win);
  const micEdge = edge(micLv, (v) => v < median(micLv.filter((x) => x.t < tm - 0.15).map((x) => x.v)) - 15, 3);
  const micZero = edge(micLv, (v) => v === -Infinity, 20);
  const sysDrift = sysEdge == null ? null : sysEdge - ts, micDrift = micEdge == null ? null : micEdge - (tm - 0.1);
  const avDiff = report.video.audio_s != null ? report.video.audio_s - report.video.video_s : null;
  report.drift = {
    sys_mute_expected_s: ts, sys_mute_measured_s: sysEdge, sys_drift_ms: sysDrift == null ? null : ms(sysDrift),
    mic_mute_expected_s: +(tm - 0.1).toFixed(3), mic_mute_measured_s: micEdge, mic_drift_ms: micDrift == null ? null : ms(micDrift),
    mic_digital_silence_from_s: micZero,
    audio_minus_video_ms: avDiff == null ? null : ms(avDiff),
  };
  expect("no drift: mute edges within 25 ms (one AAC frame + one window) of where the recorder put them, audio as long as the video (+/- 50 ms)",
    sysDrift != null && micDrift != null && Math.abs(sysDrift) <= 0.025 && Math.abs(micDrift) <= 0.025 && avDiff != null && Math.abs(avDiff) <= 0.05, report.drift);

  report.pass = report.checks.every((c) => c.ok);
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log(report.pass ? "PASS" : "FAIL", { report: join(OUT, "report.json") });
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`[pill-e2e] ERROR ${e.message}`);
  process.exit(1);
});
