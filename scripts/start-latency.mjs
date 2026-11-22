// Start latency: the time from a start command to the first captured frame, on this PC's real devices. Runs
// `AgentRecorder.exe --start-latency`: short recordings one after another in one process, through the same Recorder
// code as a server command (no server, no mouse or keyboard input). Prints each run's start timing and the median/max.
//   node scripts/start-latency.mjs [--runs 5] [--seconds 3] [--no-webcam] [--no-mic] [--no-system-audio] [--monitor Q]
//                                  [--encoder NAME] [--video-path auto|gpu|cpu] [--test-camera] [--below-normal]
//                                  [--exe PATH] [--out DIR]
// The defaults match a default start_recording: mic and system audio on, webcam on when the PC has a camera; the
// monitor defaults to the first non-primary one (the primary only on a single-monitor PC). --exe runs
// another build (e.g. an older one, for a before/after table). Writes .e2e/latency/ (agent.log and the MP4s) unless --out.
// Exit 1 when a run fails or the target is missed (median < 1.0 s, max < 1.5 s).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const EXE = resolve(arg("--exe", join(root, "build", "AgentRecorder.exe")));
const OUT = resolve(arg("--out", join(root, ".e2e", "latency")));
const flag = (name) => process.argv.includes(name);

if (!existsSync(EXE)) throw new Error(`${EXE} missing: run npm run build first`);
if (!arg("--out")) rmSync(OUT, { recursive: true, force: true }); // only ever clears its own default folder
mkdirSync(OUT, { recursive: true });

const inventory = JSON.parse(spawnSync(EXE, ["--list-devices"], { encoding: "utf8" }).stdout);
const webcam = !flag("--no-webcam") && (inventory.cameras ?? []).length > 0;
const args = ["--start-latency", arg("--runs", "5"), "--seconds", arg("--seconds", "3"), "--out", OUT];
if (webcam) args.push("--webcam");
if (!flag("--no-mic")) args.push("--mic");
if (!flag("--no-system-audio")) args.push("--system-audio");
// The test puts its pill and bubble on the recorded monitor, so it records a secondary monitor when there is one (the
// primary is where the user is working) unless --monitor says otherwise.
const secondary = (inventory.monitors ?? []).find((m) => !m.primary);
const monitor = arg("--monitor", secondary ? secondary.id : undefined);
if (monitor) args.push("--monitor", monitor);
if (arg("--encoder")) args.push("--encoder", arg("--encoder"));
if (arg("--video-path")) args.push("--video-path", arg("--video-path"));
// Dev runs beside someone's game: a test pattern instead of the camera, capture at below-normal priority.
for (const f of ["--test-camera", "--below-normal"]) if (flag(f)) args.push(f);
console.log(`[latency] AgentRecorder.exe ${args.join(" ")}`);

const p = spawn(EXE, args, { stdio: ["ignore", "pipe", "inherit"] });
const lines = [];
let buf = "";
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    lines.push(line);
    if (line.includes('"run"') || line.includes('"median_ms"')) console.log(`[latency] ${line}`);
  }
});
const code = await new Promise((r) => p.on("exit", r));
const summary = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x && "median_ms" in x);
if (!summary) throw new Error(`no summary from the recorder (exit ${code}); see ${join(OUT, "agent.log")}`);
console.log(`[latency] command -> first frame: median ${summary.median_ms} ms, max ${summary.max_ms} ms (${summary.target}) ${summary.pass ? "PASS" : "FAIL"}`);
process.exit(code);
