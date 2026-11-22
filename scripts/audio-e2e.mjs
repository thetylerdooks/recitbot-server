// Local audio end-to-end (no server, no mouse or keyboard input): plays a quiet 440 Hz test tone through the default
// output device and records with `AgentRecorder.exe --record-local`, pressing the pill's PC-sound / mic toggles part
// way through with --toggle (the pill's own Toggle(), the code path a click takes). Checks, on the final MP4:
//   1. system audio: the tone is there before the PC-sound toggle and the track is digital silence after it;
//   2. mic: the mic's signal (its noise floor is enough) is there before the mic toggle, digital silence after;
//   3. both: tone, then (PC sound muted) the tone gone, then (mic muted too) digital silence; RAM/CPU of the recorder
//      and its ffmpeg children are sampled during this run.
// The toggle points come from the recorder's own audio-mix.json (where the mutes landed in the video), so the checks
// also cover the alignment of the system audio with the video. No share link is opened (local mode never asks; the
// opener is stubbed anyway). Usage: npm run build && node scripts/audio-e2e.mjs   (writes .e2e/audio/report.json)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(root, "build", "AgentRecorder.exe");
const OUT = join(root, ".e2e", "audio");
const TONE_HZ = 440;
const SILENT_DB = -130; // digital silence reads -inf; anything below this is treated as silent
const report = { started_at: new Date().toISOString(), runs: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (name, data = {}) => console.log(`[audio-e2e] ${name} ${JSON.stringify(data)}`);

/** RMS level (dB) per 0.25 s window of [from, to) seconds; band = only around the tone. ffmpeg prints them on stderr. */
function db(file, from, to, band) {
  if (to - from < 0.25) return [];
  const af = `${band ? `bandpass=f=${TONE_HZ}:width_type=q:w=8,` : ""}asetnsamples=n=12000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
  const err = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-loglevel", "info", "-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", file, "-vn", "-af", af, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stderr ?? "";
  return [...err.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g)].map((m) => (m[1].endsWith("inf") ? -Infinity : Number(m[1])));
}

const round = (a) => a.map((v) => (Number.isFinite(v) ? +v.toFixed(1) : String(v)));
const spans = (s) =>
  (s ?? "")
    .split(",")
    .filter(Boolean)
    .map((x) => x.split("-").map(Number));

/** Plays the tone in a loop in a separate PowerShell process until stop() (killing it stops the sound). */
function playTone(wav) {
  const p = spawn("powershell.exe", ["-NoProfile", "-Command", `$p = New-Object Media.SoundPlayer '${wav}'; $p.PlayLooping(); Start-Sleep -Seconds 300`], { stdio: "ignore" });
  return { stop: () => p.kill() };
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
      ws_mb_max: mb(Math.max(...rows.map((r) => r.ws))),
      cpu_pct_of_one_core: wallMs ? +((cpuMs / wallMs) * 100).toFixed(2) : 0,
      cpu_pct_of_machine: wallMs ? +((cpuMs / wallMs / data.cores) * 100).toFixed(3) : 0,
    };
  }
  return out;
}

/** One --record-local run; resolves with the finished MP4, the recorder's audio-mix.json and (optionally) a sample. */
async function record(name, seconds, args, sampleSeconds = 0) {
  const dir = join(OUT, name);
  const shots = join(dir, "shots");
  mkdirSync(shots, { recursive: true });
  const p = spawn(EXE, ["--record-local", String(seconds), "--out", dir, ...args], {
    env: { ...process.env, AGENT_RECORDER_E2E_DIR: shots, AGENT_RECORDER_OPEN_LOG: join(OUT, "opened-links.txt") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", () => {});
  const sampled = sampleSeconds ? sample(p.pid, sampleSeconds, join(dir, "sample.json")) : null;
  const code = await new Promise((r) => p.on("exit", r));
  if (sampled) await sampled;
  const done = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l))
    .find((j) => j.status === "done");
  if (code !== 0 || !done) throw new Error(`${name}: recorder exit ${code}; output:\n${out}`);
  const mix = JSON.parse(readFileSync(join(shots, "audio-mix.json"), "utf8"));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,channels,sample_rate:format=duration", "-of", "json", done.video], { encoding: "utf8" }));
  return { mp4: done.video, done, mix, duration: Number(probe.format.duration), streams: probe.streams, sample: sampleSeconds ? summarize(JSON.parse(readFileSync(join(dir, "sample.json"), "utf8").replace(/^﻿/, ""))) : null };
}

async function main() {
  if (!existsSync(EXE)) throw new Error("build/AgentRecorder.exe missing: run npm run build first");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const tone = join(OUT, "tone.wav");
  // Quiet (-30 dBFS) 440 Hz tone, long enough to loop smoothly.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${TONE_HZ}:sample_rate=48000:duration=20`, "-af", "volume=-30dB", "-ac", "2", tone]);
  const failures = [];
  const expect = (run, what, ok, data) => {
    (report.runs[run].checks ??= []).push({ what, ok, ...data });
    log(`${run}: ${ok ? "ok  " : "FAIL"} ${what}`, data);
    if (!ok) failures.push(`${run}: ${what}`);
  };

  // 1. System audio only: tone before the PC-sound toggle, digital silence after it.
  let player = playTone(tone);
  await sleep(800);
  let r;
  try {
    r = await record("system", 10, ["--system-audio", "--toggle", "sys@3"]);
  } finally {
    player.stop();
  }
  report.runs.system = { duration: r.duration, mix: r.mix, streams: r.streams };
  let [t] = spans(r.mix.sys_muted)[0] ?? [NaN];
  expect("system", "PC-sound toggle landed in the video", Number.isFinite(t) && t > 1.5 && t < r.duration - 2, { muted_from_s: t, device: r.mix.sys_device, format: r.mix.sys_format });
  let before = db(r.mp4, 0.5, t - 0.3, true);
  let after = db(r.mp4, t + 0.3, r.duration - 0.2, false);
  expect("system", "tone present before the toggle", before.length > 2 && before.every((v) => v > -75), { tone_band_db: round(before) });
  expect("system", "digital silence after the toggle", after.length > 2 && after.every((v) => v < SILENT_DB), { rms_db: round(after) });

  // 2. Mic only (no system audio): the mic's signal before the mic toggle, digital silence after it.
  r = await record("mic", 10, ["--mic", "--toggle", "mic@3"]);
  report.runs.mic = { duration: r.duration, mix: r.mix, streams: r.streams };
  [t] = spans(r.mix.mic_muted)[0] ?? [NaN];
  expect("mic", "mic toggle landed in the video", Number.isFinite(t) && t > 1.5 && t < r.duration - 2, { muted_from_s: t });
  before = db(r.mp4, 0.5, t - 0.3, false);
  after = db(r.mp4, t + 0.3, r.duration - 0.2, false);
  expect("mic", "mic signal before the toggle (not digital silence)", before.length > 2 && Math.max(...before) > SILENT_DB, { rms_db: round(before) });
  expect("mic", "digital silence after the toggle", after.length > 2 && after.every((v) => v < SILENT_DB), { rms_db: round(after) });

  // 3. Both, sampled: tone, then PC sound muted (tone gone), then mic muted too (silence).
  player = playTone(tone);
  await sleep(800);
  try {
    r = await record("both", 12, ["--system-audio", "--mic", "--toggle", "sys@3,mic@6"], 14);
  } finally {
    player.stop();
  }
  report.runs.both = { duration: r.duration, mix: r.mix, streams: r.streams, resources: r.sample };
  const [ts] = spans(r.mix.sys_muted)[0] ?? [NaN];
  const [tm] = spans(r.mix.mic_muted)[0] ?? [NaN];
  expect("both", "both toggles landed, PC sound first", ts > 1 && tm > ts + 1.5 && tm < r.duration - 1.5, { sys_muted_from_s: ts, mic_muted_from_s: tm });
  const toneBefore = db(r.mp4, 0.5, ts - 0.3, true);
  const toneBetween = db(r.mp4, ts + 0.3, tm - 0.3, true);
  after = db(r.mp4, tm + 0.3, r.duration - 0.2, false);
  const drop = Math.min(...toneBefore) - Math.max(...toneBetween);
  expect("both", "tone (mixed under the mic) before the PC-sound toggle", toneBefore.length > 2 && toneBefore.every((v) => v > -80), { tone_band_db: round(toneBefore) });
  expect("both", "tone gone while only the mic is on (>= 30 dB drop)", toneBetween.length > 2 && drop >= 30, { tone_band_db: round(toneBetween), drop_db: +drop.toFixed(1) });
  expect("both", "digital silence once both are muted", after.length > 2 && after.every((v) => v < SILENT_DB), { rms_db: round(after) });
  expect("both", "one AAC track, 48 kHz stereo", r.streams.filter((s) => s.codec_type === "audio").length === 1 && r.streams.some((s) => s.codec_name === "aac" && s.channels === 2 && s.sample_rate === "48000"), {});
  log("resources while recording with mic + system audio", r.sample);

  expect("both", "no share link opened in local mode", !existsSync(join(OUT, "opened-links.txt")), {});
  report.result = failures.length ? "FAIL" : "PASS";
  report.failures = failures;
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log("result", { result: report.result, failures, report: ".e2e/audio/report.json" });
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
