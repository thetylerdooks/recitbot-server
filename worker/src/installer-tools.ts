// MCP tools for installing, pairing and updating: get_installer, update_recorder, get_latest. Spread into mcp.ts TOOLS.
// mcp.ts imports this file and this file imports mcp.ts back: at load time only the hoisted `tool` function is used
// from there, so import this module through mcp.ts only.
import { z } from "zod";
import { issuePairingCode } from "./auth";
import { deviceHub } from "./device-hub";
import { DEVICE_QUERY } from "./devices";
import { accountLimits, deviceLimitMessage, LIMITS } from "./env";
import { INSTALL_PS1_SHA256, INSTALL_SH_SHA256, RECORDER_MAC_VERSION, RECORDER_VERSION } from "./generated";
import { compareVersions, installCommand, installerUrl, macInstallCommand, type Platform } from "./installer";
import { connectionLost, deviceOffline, onDevice, pairedDevices, requireNotSuspended, requireWritable, targetDevice, tool, ToolError } from "./mcp";
import { getConfig } from "./config";
import { playbook } from "./playbook";
import { hasRecorder, PLATFORM, updatable, updateCommand } from "./recorder-update";
import { now } from "./util";

const PlatformParam = z
  .enum(["windows", "macos"])
  .describe('The computer to install on: "windows" for a Windows PC, "macos" for a Mac. Default "windows".');
const InstallPlatformParam = z
  .enum(["windows", "macos"])
  .describe(
    'Which computer the user will install on: "windows" for a Windows PC, "macos" for a Mac. If you do not know, ask ' +
      'the user "Windows or Mac?" first; never guess. Omitted: the platform of the account\'s paired devices when they ' +
      "are all the same platform; with no paired device or devices on both, nothing is installed and the result is " +
      'needs_choice (ask "Windows or Mac?").',
  );

const ASK_PLATFORM =
  'Ask the user "Windows or Mac?" and call get_installer again with platform "windows" or "macos". Do not guess. ' +
  "Nothing was issued.";

/** A device row's platform; null = unknown (never reported nor inferred), not assumed to be Windows. */
const platformOf = (p: string | null | undefined): Platform | null => (p === "macos" || p === "windows" ? p : null);

function requireMacInstaller(): void {
  if (!hasRecorder("macos")) {
    throw new ToolError("MAC_INSTALLER_UNAVAILABLE", "The Mac recorder is not available on this server yet. Try again later.");
  }
}

const REINSTALL =
  "This recorder is too old to update itself. Call get_installer and run its command on the user's PC (or give the " +
  "user its download_url); it installs the new version over the old one and pairs again.";

const NO_SIGNED_RELEASE =
  "This recorder installs only updates signed with a Recitbot release key, and this server has no signed release of " +
  "the latest version for it yet. Nothing was sent; it updates itself once one is published.";

export const INSTALL_TOOLS = {
  get_installer: tool({
    auth: true,
    description:
      "Install and pair the recorder on the user's Windows PC or Mac. Before calling, know which computer it is: if the " +
      "user named it, pass that; if you do not know (or the user is adding another computer), ask the user \"Windows " +
      "or Mac?\" and wait for the answer; never guess (your own shell may not be the user's computer). Pass platform " +
      "\"windows\" to get a PowerShell one-liner, platform \"macos\" to get a bash one-liner that runs install.sh after " +
      "checking its pinned SHA-256. Omitted platform: only when every paired device on the account is the same " +
      "platform is that platform used (`platform` in the result says which); with no paired device, or devices on both " +
      "platforms, the result is needs_choice:true with no command: ask the user \"Windows or Mac?\" and call again with " +
      "platform. Returns" +
      ` a one-time pairing code (valid ${LIMITS.pairingCodeSeconds / 60} minutes, ` +
      "single use) built into `command` and `download_url`; the user never needs to see the code.\n" +
      "Windows: " +
      "If you can run shell commands on the user's Windows PC, run `command` yourself: it works from cmd, PowerShell " +
      "and WSL, asks nothing, needs no admin, downloads install.ps1 and checks its SHA-256 (install_ps1_sha256), " +
      "installs to %LOCALAPPDATA%\\AgentRecorder, pairs, registers autostart at logon and starts the recorder in the " +
      "background (it outlives your shell). If you cannot run commands, give the user " +
      "download_url (valid until expires_at): they download recitbot-install.ps1 and right-click > Run with PowerShell.\n" +
      "macOS: run `command` in Terminal (zsh or bash) on the Mac: it downloads install.sh, checks its SHA-256 " +
      "(install_sh_sha256) before running it, installs Recitbot to ~/Applications, pairs and starts it at login; no " +
      "admin, no prompts. The first recording asks the user to allow Screen Recording and Microphone in System Settings: " +
      "tell them to click Allow. If you cannot run commands, give the user download_url: they run " +
      "`bash ~/Downloads/recitbot-install.sh` in Terminal.\n" +
      "Result (both platforms): the last line is `RECITBOT_INSTALL_OK device=<id> version=<v> autostart=<logon|none>` " +
      "with exit code 0, or `RECITBOT_INSTALL_FAILED: <reason>` with exit code 1 (the installer download or its SHA-256 " +
      "check failed), 2 (bad arguments, or an update without an install), 3 (recorder download or hash check failed), " +
      "4 (pairing failed: get a new command), 5 (the recorder could not start, or this computer is not supported). Tell " +
      "the user the reason. " +
      "Then poll device_status until online is true. Running it again on an installed computer updates and re-pairs it " +
      "(it keeps one slot). A computer can be paired with several Recitbot accounts: when Recitbot is already installed " +
      "there for another account, that is normal: run the command as usual. It adds this account to that computer; " +
      "nothing is reinstalled or wiped and the other accounts keep working. It takes one of this account's device " +
      "slots. Pairing another computer keeps the devices already paired: Free accounts may have up to " +
      `${LIMITS.maxDevices} paired devices at once. At that limit pairing a new one is refused (nothing changes; the ` +
      "result's device_limit says so up front): call list_devices, ask the user which device to remove, call " +
      "remove_device, then run the command again. On Windows `powershell` is the same command (older field name). A " +
      "suspended account gets the error ACCOUNT_SUSPENDED (nothing issued): tell the user its message.",
    input: z.object({ platform: InstallPlatformParam.optional() }),
    async run(a, c) {
      requireWritable(c.env);
      await requireNotSuspended(c);
      const devices = await pairedDevices(c);
      const accountId = c.principal!.accountId;
      const max = (await accountLimits(c.env, accountId)).maxDevices;
      const paired = devices.length;
      const platforms = [...new Set(devices.map((d) => platformOf(d.platform)))];
      // Omitted platform: only an account whose paired devices are all one known platform decides it; otherwise ask.
      const platform: Platform | undefined = a.platform ?? (platforms.length === 1 ? (platforms[0] ?? undefined) : undefined);
      if (!platform) {
        return {
          needs_choice: true,
          choices: ["windows", "macos"],
          question: "Windows or Mac?",
          paired_devices: paired,
          max_devices: max,
          devices: devices.map((d) => ({ device_id: d.id, name: d.name, platform: platformOf(d.platform) })),
          note:
            (!paired
              ? "No device is paired yet. "
              : platforms.includes(null)
                ? "A paired device's platform is unknown. "
                : "Paired devices are on both Windows and Mac. ") + ASK_PLATFORM,
        };
      }
      if (platform === "macos") requireMacInstaller();
      const { code, expires_at } = await issuePairingCode(c.env, accountId, LIMITS.pairingCodeSeconds, platform);
      const limit = {
        paired_devices: paired,
        max_devices: max,
        ...(max !== null &&
          paired >= max && {
            device_limit:
              deviceLimitMessage(c.env, max) + " This command still re-pairs (updates) a computer that is already paired; on a new one it fails until a device is removed.",
          }),
      };
      const download_url = await installerUrl(c.env, c.base, { purpose: PLATFORM[platform].install, accountId, expiresAt: expires_at, code });
      if (platform === "macos") {
        return {
          ...limit,
          platform,
          command: macInstallCommand(c.base, code, accountId),
          download_url,
          expires_at,
          install_sh_sha256: INSTALL_SH_SHA256,
          pairing_code: code,
          uninstall: `Run ~/Library/Application Support/Recitbot/uninstall.sh (also served at ${c.base}/uninstall.sh).`,
        };
      }
      const command = installCommand(c.base, code, accountId);
      return {
        ...limit,
        platform,
        command,
        download_url,
        expires_at,
        install_ps1_sha256: INSTALL_PS1_SHA256,
        pairing_code: code,
        powershell: command,
        uninstall: `Run %LOCALAPPDATA%\\AgentRecorder\\uninstall.ps1 (also served at ${c.base}/uninstall.ps1).`,
      };
    },
  }),

  update_recorder: tool({
    auth: true,
    description:
      "Recorders that can update themselves are updated automatically when they connect; call this only to force an " +
      "update now or to check one. " +
      "Update the recorder on one of the user's paired computers (Windows PC or Mac: platform in the result) to the latest " +
      "version. Compares the connected recorder's version " +
      "(current) with latest and returns action: up_to_date; update_sent (the PC downloads install.ps1, a Mac install.sh, checks its " +
      "SHA-256 and reinstalls in the background with no window, keeping its pairing, then reconnects: call " +
      "update_recorder again after about a minute to see up_to_date); " +
      "not_paired (call get_installer); no_signed_release (the recorder takes only signed updates and this server has " +
      "none for its platform yet: nothing was sent, tell the user it updates itself later); reinstall_required or unknown_version (too old to update itself: run " +
      "get_installer's command again, or give the user its download_url). A device that is not connected (or drops) is " +
      "the error DEVICE_OFFLINE: tell the user its message. A device whose platform is unknown is the error " +
      "PLATFORM_UNKNOWN: ask the user \"Windows or Mac?\" and run get_installer's command for it. last_update is the PC's last report on an update; " +
      "auto_update is the server's last automatic update of it (version, at, result: sent, installing, busy, waiting " +
      "(held until the PC stops recording), deferred (the PC installs it once its recording has uploaded), failed, " +
      "rolled_back (the installer put the previous version back), gave_up after repeated failures, or updated; next_at = " +
      "no automatic retry before then). " +
      "With several paired devices it updates one (`device` in the result): the most recently connected online one, or " +
      "the one you pass as `device`; call it once per device to update them all. A suspended account gets the error " +
      "ACCOUNT_SUSPENDED (nothing sent).",
    input: z.object({
      device: z
        .string()
        .min(1)
        .max(128)
        .regex(DEVICE_QUERY, "invalid device")
        .optional()
        .describe("Which paired device: its id from list_devices (paired_devices), or its name. Default: the most recently connected online one."),
    }),
    async run(a, c) {
      await requireNotSuspended(c);
      const acct = c.principal!.accountId;
      const all = await pairedDevices(c);
      if (!all.length) {
        return { current: null, latest: RECORDER_VERSION, platform: "windows", action: "not_paired", next_step: "Call get_installer and run its command on the user's PC." };
      }
      const dev = (await targetDevice(c, a.device)).device;
      const platform = platformOf(dev.platform);
      if (!platform) {
        throw new ToolError(
          "PLATFORM_UNKNOWN",
          `It is not known whether ${dev.name} is a Windows PC or a Mac. Ask the user, then call get_installer with that platform and run its command on that computer: it updates and re-pairs it.`,
          { device: dev.id, device_name: dev.name, platform: null },
        );
      }
      if (platform === "macos") requireMacInstaller();
      const p = PLATFORM[platform];
      const latest = p.latest;
      const hub = deviceHub(c.env, acct);
      const who = { device: dev.id, device_name: dev.name, platform };
      const info = await onDevice(dev.name, hub.recorderInfo(acct, dev.id), { ...who, latest });
      if (!info || info.device_id !== dev.id) throw deviceOffline(dev.name, { ...who, latest });
      const last = await onDevice(dev.name, hub.lastUpdate(acct, dev.id), { ...who, latest });
      const auto = await onDevice(dev.name, hub.autoUpdate(acct, dev.id), { ...who, latest });
      const report = { ...(last && { last_update: last }), ...(auto && { auto_update: auto }) };
      const current = info.version;
      if (!current) return { current: null, ...who, latest, action: "unknown_version", next_step: REINSTALL, ...report };
      if (compareVersions(current, latest) >= 0) return { current, ...who, latest, action: "up_to_date", ...report };
      if (!info.features.includes("self_update")) return { current, ...who, latest, action: "reinstall_required", next_step: REINSTALL, ...report };
      const unsigned = { current, ...who, latest, action: "no_signed_release", next_step: NO_SIGNED_RELEASE, ...report };
      if (!updatable(platform, info.features)) return unsigned;
      const sent = await onDevice(dev.name, hub.pushUpdate(acct, dev.id, await updateCommand(c.env, c.base, acct, platform)), { ...who, latest });
      if (!sent.ok) {
        if (sent.reason === "unsupported") return { current, ...who, latest, action: "reinstall_required", next_step: REINSTALL, ...report };
        if (sent.reason === "unsigned") return unsigned;
        throw connectionLost(dev.name, { ...who, latest });
      }
      return {
        current,
        ...who,
        latest,
        action: "update_sent",
        next_step: "The PC installs the update in the background and reconnects. Call update_recorder again in about a minute.",
        ...report,
      };
    },
  }),

  get_latest: tool({
    auth: true,
    description:
      "The latest Recitbot playbook (how to pair, record, share and update; playbook.version + playbook.text), the " +
      "latest recorder version for platform (\"windows\" or \"macos\"; default: the most recently connected paired " +
      "device's), and a short-lived signed download link to its installer, install.ps1 or install.sh (installer.download_url; no " +
      "pairing code). Call it now and then: when playbook.version differs from the one in your Recitbot skill, rewrite " +
      "the skill with playbook.text. Recorders update themselves when they connect; update_recorder forces an update now.",
    input: z.object({ platform: PlatformParam.optional() }),
    async run(a, c) {
      const expiresAt = now() + LIMITS.pairingCodeSeconds;
      let platform: Platform = a.platform ?? platformOf((await pairedDevices(c))[0]?.platform) ?? "windows";
      // A paired Mac while this server has no Mac recorder: the playbook is still what matters here.
      if (platform === "macos" && !RECORDER_MAC_VERSION) {
        if (a.platform) requireMacInstaller();
        platform = "windows";
      }
      const p = PLATFORM[platform];
      return {
        playbook: playbook(getConfig(c.env)),
        platform,
        recorder: { version: p.latest, [p.shaField]: p.sha256 },
        installer: {
          download_url: await installerUrl(c.env, c.base, { purpose: p.update, accountId: c.principal!.accountId, expiresAt }),
          expires_at: expiresAt,
        },
        how_to_update:
          "Rewrite your Recitbot skill with playbook.text when playbook.version changed. Recorders update themselves when " +
          `they connect; call update_recorder only to force an update on the user's computer now. installer.download_url is ${platform === "macos" ? "install.sh" : "install.ps1"} itself (SHA-256 = ` +
          `recorder.${p.shaField}); to pair a computer use get_installer.`,
      };
    },
  }),
};
