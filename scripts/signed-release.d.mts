// Types for signed-release.mjs (imported by worker/test/signed-update.test.ts).
export type Platform = "windows" | "macos";
export type ReleaseJson = { manifest?: unknown; manifest_sig?: unknown; platform?: unknown; version?: unknown; sha256?: unknown; key_id?: unknown };
export type ManifestFields = {
  platform: string;
  version: string;
  min_from_version: string;
  artifact: string;
  sha256: string;
  size: string;
  key_id: string;
  issued_at: string;
};
export const MAGIC: string;
export const ARTIFACT: Record<Platform, string>;
export function sha256Hex(buf: Uint8Array): string;
export function strictBase64(s: unknown): Uint8Array | null;
export function parseManifest(bytes: Uint8Array): ManifestFields | null;
export function checkSignedRelease(
  platform: Platform,
  release: ReleaseJson,
  script: Uint8Array,
): { version: string; sha256: string; size: number; keyId: string; manifest: string; manifestSig: string };
export function checkScriptPins(platform: Platform, script: Uint8Array, pins: { zipSha256: string; version: string }): void;
export const TEST_KEY_IDS: string[];
export function refuseTestKey(keyId: string, where: string): void;
export function refusePlaceholderHashes(name: string, text: string | Uint8Array): void;
export function checkBuildHashes(
  platform: Platform,
  name: string,
  text: string | Uint8Array,
  served: { installSha256: string | null; zipSha256: string; version: string },
): void;
export function unzipEntries(buf: Uint8Array, where: string): { name: string; data: Uint8Array }[];
export function refusePlaceholderArtifact(name: string, buf: Uint8Array): void;
export function deployProblems(generatedTs: string, served: { name: string; data: Uint8Array }[]): string[];

export const RELEASE_KEYS: Record<string, string>;
export function checkReleaseKey(release: unknown, where: string, keys?: Record<string, string>): void;
