// Test windows for window-recording checks (scripts/window-cases.mjs, scripts/e2e.mjs E2E_WINDOW=1). Everything here
// acts only on the test's OWN Chrome, started with its own --user-data-dir in %TEMP% (a separate browser process tree,
// hardware acceleration on as by default), never on the user's windows, and injects no mouse or keyboard input.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MARK = "ar-wintest-chrome";
const PROFILE = join(tmpdir(), MARK);
export const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** scripts/win-helper.ps1, long-lived: one JSON command per line. */
export class Helper {
  constructor() {
    this.p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "win-helper.ps1")], { stdio: ["pipe", "pipe", "inherit"] });
    this.waiting = [];
    createInterface({ input: this.p.stdout }).on("line", (l) => this.waiting.shift()?.(JSON.parse(l)));
  }
  cmd(o) {
    return new Promise((r) => {
      this.waiting.push(r);
      this.p.stdin.write(JSON.stringify(o) + "\n");
    });
  }
  close() {
    this.p.stdin.end();
  }
}

/** The recorder's window id: win_ + first 5 bytes of sha256(lowercase "hwnd|pid|exe"). */
export const windowId = (hwnd, pid, exe) => "win_" + createHash("sha256").update(`${hwnd}|${pid}|${exe}`.toLowerCase()).digest("hex").slice(0, 10);

/** Opens a new window of the test Chrome at url and moves it to rect; resolves with {hwnd, pid, title, rect}. */
export async function openTestWindow(helper, url, rect) {
  if (!CHROME) throw new Error("Chrome not found");
  const before = new Set((await helper.cmd({ op: "windows", pids: await helper.cmd({ op: "pids", name: "chrome.exe", pattern: MARK }) })).map((w) => w.hwnd));
  if (!before.size) rmSync(PROFILE, { recursive: true, force: true });
  const args = [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--disable-features=Translate", "--new-window"];
  if (rect) args.push(`--window-position=${rect.x},${rect.y}`, `--window-size=${rect.w},${rect.h}`);
  spawn(CHROME, [...args, url], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const w = (await helper.cmd({ op: "windows", pids: await helper.cmd({ op: "pids", name: "chrome.exe", pattern: MARK }) })).find((x) => !before.has(x.hwnd));
    if (w) {
      if (rect) await helper.cmd({ op: "move", hwnd: w.hwnd, ...rect });
      return w;
    }
  }
  throw new Error("test Chrome window did not appear");
}

/** Current title/rect of one of our windows. */
export async function testWindow(helper, hwnd) {
  const pids = await helper.cmd({ op: "pids", name: "chrome.exe", pattern: MARK });
  return (await helper.cmd({ op: "windows", pids })).find((w) => w.hwnd === hwnd);
}

/** Closes every test-Chrome window (WM_CLOSE), then kills what is left of that process tree only. */
export async function closeTestWindows(helper) {
  const pids = await helper.cmd({ op: "pids", name: "chrome.exe", pattern: MARK });
  for (const w of await helper.cmd({ op: "windows", pids })) await helper.cmd({ op: "close", hwnd: w.hwnd });
  await sleep(2500);
  for (const pid of await helper.cmd({ op: "pids", name: "chrome.exe", pattern: MARK })) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  await sleep(500);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
