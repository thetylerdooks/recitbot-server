// Flicker check for the webcam bubble outside a full e2e run: starts `AgentRecorder.exe --webcam-preview`,
// records the bubble's screen rectangle losslessly with ddagrab (the production capture path) and scores the ring.
// Usage: node scripts/ring-stability.mjs <AgentRecorder.exe> [label] [seconds]
// Needs a real webcam and ffmpeg on PATH. Writes .e2e/ring-<label>.mkv and prints JSON.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ringStability } from "./ring-metric.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [exe, label = "run", secondsArg = "5"] = process.argv.slice(2);
const seconds = Number(secondsArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(root, ".e2e"), { recursive: true });

// The bubble's default spot (both builds): bottom-left of the primary work area, 24 px in, medium = 240 px at 96 DPI.
const wa = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type 'using System.Runtime.InteropServices; public class D { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'; [D]::SetProcessDPIAware()|Out-Null; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; \"$($w.Left) $($w.Bottom)\"",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split(" ")
  .map(Number);
const side = 240;
const rect = { x: wa[0] + 24, y: wa[1] - side - 24, side };

const preview = spawn(exe, ["--webcam-preview", String(seconds + 6), "--ffmpeg", "ffmpeg", "--size", "medium"], { stdio: ["ignore", "pipe", "inherit"] });
let out = "";
preview.stdout.on("data", (d) => (out += d));
await sleep(3500); // camera open + first frame
const clip = join(root, ".e2e", `ring-${label}.mkv`);
execFileSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", `ddagrab=output_idx=0:framerate=30:draw_mouse=0:offset_x=${rect.x}:offset_y=${rect.y}:video_size=${side}x${side}`,
  "-t", String(seconds), "-vf", "hwdownload,format=bgra", "-c:v", "ffv1", clip,
]);
const metric = ringStability(clip, { x: 0, y: 0, side });
await new Promise((r) => preview.on("exit", r));
console.log(JSON.stringify({ label, exe, rect, preview: out.trim(), ...metric }, null, 2));
