// Long recording through a LOCAL dev Worker (wrangler dev, local D1/R2 in .e2e/long/state; never production):
// signup -> owner account (OWNER_ACCOUNT_IDS via --var) -> build/AgentRecorder.exe enrolled into .e2e/long/agent and run
// as an agent with --test-camera --below-normal --no-front -> start_recording(max_seconds, monitor by id, webcam, mic)
// -> wait for ready -> download the MP4 -> ffprobe. Reports size, parts, bitrate and the recorder's A/V timing lines.
// Nothing here installs, schedules or touches %LOCALAPPDATA%. The share link opener is stubbed (no browser).
// Usage: node scripts/long-recording.mjs --monitor mon_xxx [--seconds 600] [--mic NAME] [--system-audio] [--keep]
// Without --keep the downloaded MP4, the agent's data and the local Worker state (R2 media with mic audio) are deleted.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, connect } from "./mcp-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const MONITOR = arg("--monitor");
const SECONDS = Number(arg("--seconds", "600"));
const MIC = arg("--mic", "default");
const KEEP = process.argv.includes("--keep");
const SYSTEM_AUDIO = process.argv.includes("--system-audio");
if (!MONITOR || MONITOR === "primary") throw new Error("pass --monitor <id> explicitly (never the primary)");

const DIR = join(root, ".e2e", "long");
const STATE = join(DIR, "state");
const AGENT = join(DIR, "agent");
const EXE = join(root, "build", "AgentRecorder.exe");
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m, d) => console.log(`[long] ${m}${d ? " " + JSON.stringify(d) : ""}`);

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });

let wrangler, agent;
const PORT = await freePort();
const INSPECTOR = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

async function startWrangler(vars = []) {
  wrangler = spawn(
    "node",
    [wranglerJs, "dev", "-c", "worker/wrangler.test.jsonc", "--ip", "127.0.0.1", "--port", String(PORT), "--inspector-port", String(INSPECTOR), "--persist-to", STATE, "--log-level", "warn", ...vars.flatMap((v) => ["--var", v])],
    { cwd: root, env, stdio: ["ignore", openSync(join(DIR, "wrangler.log"), "a"), openSync(join(DIR, "wrangler.err.log"), "a")] },
  );
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) return;
    } catch {}
    if (i > 120) throw new Error("wrangler dev did not start");
    await sleep(500);
  }
}
function stopWrangler() {
  if (wrangler?.pid) spawnSync("taskkill", ["/PID", String(wrangler.pid), "/T", "/F"]);
  wrangler = null;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(AGENT, { recursive: true });
  execFileSync("node", [join(root, "scripts", "gen-dev-vars.mjs")], { stdio: "inherit" });
  execFileSync("node", [wranglerJs, "d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE, "-c", "worker/wrangler.test.jsonc"], { cwd: root, env, stdio: "ignore" });
  await startWrangler();
  const anon = await connect(BASE);
  const { api_key, account_id } = await callTool(anon, "signup", { bot_name: "long-bot" });
  await anon.close();
  // Owner limits (no plan time limit, 8 GiB) for this local account only: restart with the var, same local state.
  stopWrangler();
  await sleep(1000);
  await startWrangler([`OWNER_ACCOUNT_IDS:${account_id}`]);
  log("wrangler dev up (local state, owner account)", { port: PORT });
  let bot = await connect(BASE, api_key);

  const { pairing_code } = await callTool(bot, "get_installer");
  const ffmpeg = execFileSync("where", ["ffmpeg"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  const en = spawnSync(EXE, ["--enroll", "--server", BASE, "--ffmpeg", ffmpeg, "--data", AGENT, "--name", "long-test"], { input: pairing_code + "\n", encoding: "utf8" });
  if (en.status !== 0) throw new Error(`enroll failed (${en.status}); see ${AGENT}\\agent.log`);
  agent = spawn(EXE, ["--data", AGENT, "--test-camera", "--below-normal", "--no-front"], {
    env: { ...process.env, AGENT_RECORDER_OPEN_LOG: join(DIR, "opened-links.txt") },
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    if ((await callTool(bot, "device_status")).online) break;
    if (i > 60) throw new Error("device never came online");
    await sleep(500);
  }
  const devices = await callTool(bot, "list_devices", { refresh: true });
  const mon = devices.monitors.find((m) => m.id === MONITOR);
  if (!mon || mon.primary) throw new Error(`monitor ${MONITOR} not found or primary`);
  log("device online", { monitor: `${mon.id} ${mon.resolution} ${mon.label}` });

  const t0 = Date.now();
  const start = await callTool(bot, "start_recording", {
    title: "long recording check",
    max_seconds: SECONDS,
    monitor: MONITOR,
    webcam: true,
    mic: true,
    mic_device: MIC,
    system_audio: SYSTEM_AUDIO,
  });
  const id = start.recording_id;
  log("start_recording", { id, max_seconds: start.max_seconds, monitor: start.monitor, mic_device: start.mic_device, note: start.note });
  if (start.max_seconds !== SECONDS) throw new Error(`max_seconds shortened to ${start.max_seconds}`);

  let v, last;
  for (;;) {
    await sleep(10000);
    try {
      v = await callTool(bot, "get_video", { recording_id: id });
    } catch {
      await bot.close().catch(() => {});
      bot = await connect(BASE, api_key);
      continue;
    }
    if (v.status !== last) log(`status ${v.status}`, { at_s: Math.round((Date.now() - t0) / 1000) });
    last = v.status;
    if (v.status === "ready" || v.status === "failed" || v.status === "expired") break;
    if (Date.now() - t0 > (SECONDS + 900) * 1000) throw new Error("timed out waiting for ready");
  }
  if (v.status !== "ready") throw new Error(`recording ${v.status}: ${v.error ?? ""}`);
  const readyAt = (Date.now() - t0) / 1000;

  const view = await fetch(v.share_url);
  const cookie = /mt=[^;]+/.exec(view.headers.get("set-cookie") ?? "")?.[0];
  if (view.status !== 200 || !cookie) throw new Error(`viewer ${view.status}`);
  const mp4 = join(DIR, "recording.mp4");
  writeFileSync(mp4, Buffer.from(await (await fetch(`${BASE}/m/${id}`, { headers: { cookie } })).arrayBuffer()));
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,duration,nb_frames,bit_rate:format=duration,size,bit_rate", "-of", "json", mp4], { encoding: "utf8" }),
  );
  const vs = probe.streams.find((s) => s.codec_type === "video");
  const as = probe.streams.find((s) => s.codec_type === "audio");
  const agentLog = readFileSync(join(AGENT, "agent.log"), "utf8");
  const lines = (re) => agentLog.split(/\r?\n/).map((l) => l.replace(/^\S+ /, "")).filter((l) => re.test(l));
  const report = {
    recording_id: id,
    requested_s: SECONDS,
    duration_s_server: v.duration_s,
    ready_after_s: Math.round(readyAt),
    file_bytes: Number(probe.format.size),
    format_duration_s: Number(probe.format.duration),
    video: { codec: vs.codec_name, size: `${vs.width}x${vs.height}`, fps: vs.avg_frame_rate, frames: Number(vs.nb_frames), duration_s: Number(vs.duration), bit_rate_kbps: Math.round(Number(vs.bit_rate) / 1000) },
    audio: as ? { codec: as.codec_name, duration_s: Number(as.duration), bit_rate_kbps: Math.round(Number(as.bit_rate) / 1000) } : null,
    av_stream_end_diff_ms: as ? Math.round((Number(as.duration) - Number(vs.duration)) * 1000) : null,
    start: as ? startCheck(mp4) : null,
    upload: lines(/bytes in \d+ parts|uploaded |aborted the multipart/),
    timing: lines(/^timing:|audio mixed|capture started/),
    errors: lines(/failed|error/i),
    links_opened_stub: existsSync(join(DIR, "opened-links.txt")),
  };
  writeFileSync(join(DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await bot.close().catch(() => {});
}

// How the MP4 opens: first video packet and first audio frame (decoded timeline, edit lists applied), astats over the first
// 100 ms of audio, and the leading run of digital silence (|x| < 1e-6, -120 dBFS: padding decodes to zeros; a live mic's
// noise floor is around -96 dBFS).
function startCheck(mp4) {
  const first = (sel, what, interval = "%+#1") =>
    JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", sel, "-read_intervals", interval, "-show_entries", what, "-of", "json", mp4], { encoding: "utf8" }));
  const vp = first("v:0", "packet=pts_time,flags").packets[0];
  const af = first("a:0", "frame=pts_time", "%+0.5").frames[0]; // the AAC decoder needs more than one packet
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-map", "0:a:0", "-af", "atrim=0:0.1", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 24 });
  const s = new Float32Array(new Uint8Array(pcm).buffer, 0, pcm.length >> 2);
  let lead = 0;
  while (lead < s.length && Math.abs(s[lead]) < 1e-6) lead++;
  const db = (a, b) => {
    let e = 0;
    for (let i = a; i < b; i++) e += s[i] * s[i];
    return b > a ? Math.round(10 * Math.log10(e / (b - a) + 1e-20) * 10) / 10 : null;
  };
  const stats = spawnSync("ffmpeg", ["-hide_banner", "-i", mp4, "-map", "0:a:0", "-af", "atrim=0:0.1,astats=measure_perchannel=none", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const stat = (k) => Number(new RegExp(`${k}:\\s*(-?[\\d.]+|-inf)`).exec(stats.split("Overall")[1] ?? "")?.[1]);
  return {
    video_first_packet: { pts_s: Number(vp.pts_time), flags: vp.flags },
    audio_first_frame_pts_s: Number(af.pts_time),
    audio_vs_video_first_ms: Math.round((Number(af.pts_time) - Number(vp.pts_time)) * 1000 * 10) / 10,
    first_100ms: {
      samples: s.length,
      leading_digital_silence_ms: Math.round((lead / 48000) * 1000 * 10) / 10,
      rms_dbfs_per_10ms: Array.from({ length: 10 }, (_, i) => db(i * 480, Math.min(s.length, (i + 1) * 480))),
      astats_rms_db: stat("RMS level dB"),
      astats_peak_db: stat("Peak level dB"),
      astats_min: stat("Min level"),
      astats_max: stat("Max level"),
    },
  };
}

async function cleanup() {
  if (agent?.pid) spawnSync("taskkill", ["/PID", String(agent.pid), "/T", "/F"]);
  stopWrangler();
  // The agent log has ids, timings and app names only (no titles, no secrets).
  if (existsSync(join(AGENT, "agent.log"))) writeFileSync(join(DIR, "agent.log"), readFileSync(join(AGENT, "agent.log")));
  if (KEEP) return;
  // The MP4, the agent's temp files and the local R2 objects all hold mic audio. workerd lets go of the state files some
  // seconds after it is killed.
  for (const p of [join(DIR, "recording.mp4"), AGENT, STATE]) {
    for (let i = 0; ; i++) {
      try {
        rmSync(p, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i > 60) {
          console.error(`[long] could not delete ${p} (${e.code}); delete it by hand: it holds mic audio`);
          process.exitCode = 1;
          break;
        }
        await sleep(1000);
      }
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(`[long] FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
