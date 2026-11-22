// Recorder self-update: the latest recorder per platform and the signed "update" command that installs it. Sent by
// update_recorder (installer-tools.ts) and, on hello, by DeviceHub on its own.
import type { Env } from "./env";
import { LIMITS } from "./env";
import {
  INSTALL_PS1_SHA256,
  INSTALL_SH_SHA256,
  RECORDER_MAC_VERSION,
  RECORDER_VERSION,
  UPDATE_MANIFEST_MACOS,
  UPDATE_MANIFEST_SIG_MACOS,
  UPDATE_MANIFEST_SIG_WINDOWS,
  UPDATE_MANIFEST_WINDOWS,
} from "./generated";
import { installerUrl, type Platform } from "./installer";
import { now } from "./util";

/**
 * Per platform: the installer the update/download links serve, its SHA-256 and the recorder version it installs, and
 * the offline-signed release manifest and signature for it (base64, from the release; "" = none). The server never
 * signs a manifest: build-recorder-zip.mjs takes both from the signed release and checks the manifest names exactly the
 * served installer.
 */
export const PLATFORM = {
  windows: {
    latest: RECORDER_VERSION,
    sha256: INSTALL_PS1_SHA256,
    manifest: UPDATE_MANIFEST_WINDOWS,
    manifestSig: UPDATE_MANIFEST_SIG_WINDOWS,
    update: "update",
    install: "install",
    shaField: "install_ps1_sha256",
  },
  macos: {
    latest: RECORDER_MAC_VERSION,
    sha256: INSTALL_SH_SHA256,
    manifest: UPDATE_MANIFEST_MACOS,
    manifestSig: UPDATE_MANIFEST_SIG_MACOS,
    update: "mac_update",
    install: "mac_install",
    shaField: "install_sh_sha256",
  },
} as const;

/** Whether this server has a recorder for the platform (no Mac recorder pinned = none for macos). */
export function hasRecorder(platform: Platform): boolean {
  return !!PLATFORM[platform].latest && !!PLATFORM[platform].sha256;
}

/** Whether the platform's latest recorder comes with a signed release manifest (what "signed_update" recorders require). */
export function hasManifest(platform: Platform): boolean {
  return !!PLATFORM[platform].manifest && !!PLATFORM[platform].manifestSig;
}

/**
 * Whether a recorder with these hello features would accept this platform's update at all: one that announces
 * "signed_update" refuses an update without a signed manifest, so none is sent to it. Older recorders keep the
 * hash-pinned path.
 */
export function updatable(platform: Platform, features: readonly string[]): boolean {
  return !features.includes("signed_update") || hasManifest(platform);
}

export type UpdateCommand = { url: string; version: string; sha256: string; manifest?: string; manifest_sig?: string };

/**
 * What hub.pushUpdate sends: a short-lived signed link to the platform's installer, its version and SHA-256, and the
 * release's manifest and manifest_sig when it has them (outside the command's HMAC: the Ed25519 signature covers them;
 * hub.pushUpdate leaves them out for recorders without "signed_update"). ttlSeconds: how long the link works (the
 * automatic push uses AUTO_UPDATE.linkSeconds, so an update deferred until a recording has uploaded can still download
 * it).
 */
export async function updateCommand(
  env: Env,
  base: string,
  accountId: string,
  platform: Platform,
  ttlSeconds: number = LIMITS.pairingCodeSeconds,
): Promise<UpdateCommand> {
  const p = PLATFORM[platform];
  const url = await installerUrl(env, base, { purpose: p.update, accountId, expiresAt: now() + ttlSeconds });
  return { url, version: p.latest, sha256: p.sha256, ...(hasManifest(platform) && { manifest: p.manifest, manifest_sig: p.manifestSig }) };
}
