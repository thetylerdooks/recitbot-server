// Checks a signed recorder release (the recorder repo's build/sign-release.mjs output, RELEASING.md) before
// build-recorder-zip.mjs serves it. The server never signs anything and holds no release key: it only relays the
// manifest and signature, so here they are checked for shape and against the bytes that will be served. The recorder
// verifies the signature itself (PROTOCOL.md 5.1).
import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const MAGIC = "recitbot-update-manifest/1";
// UPSTREAM RELEASE PUBLIC KEYS, test half: key_id of each TEST fixture key committed in the recorder repo (windows/UpdateTrustFixtures.cs: TEST-primary,
// TEST-backup, TEST-untrusted). Their private halves were discarded; a manifest signed by one is never a release.
export const TEST_KEY_IDS = ["5e0af0bdd2f27453", "0570fc67ff123479", "f3b6eaa5db2038ca"];
// The recorder repo's placeholder release keys end in this ("PLACEHOLDER-PRIMARY-PUBLIC-KEY-NOT-FOR-RELEASE"); only a
// placeholder-key dev build compiles it in (UTF-8 in the Swift app, UTF-16LE in the .NET exe).
const PLACEHOLDER_KEY_TEXT = "-PUBLIC-KEY-NOT-FOR-RELEASE";
const PLACEHOLDER_NEEDLES = [Buffer.from(PLACEHOLDER_KEY_TEXT, "utf8"), Buffer.from(PLACEHOLDER_KEY_TEXT, "utf16le")];
export const ARTIFACT = { windows: "install.ps1", macos: "install.sh" };
const VERSION = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;
const KEYS = ["platform", "version", "min_from_version", "artifact", "sha256", "size", "key_id", "issued_at"];

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex").toUpperCase();

/** Standard padded base64 that round-trips exactly (no whitespace, no URL alphabet), as the recorders require. */
export function strictBase64(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  const b = Buffer.from(s, "base64");
  return b.toString("base64") === s ? b : null;
}

/**
 * The manifest's fields, or null unless it is exactly the nine-line ASCII form of PROTOCOL.md 5.1 (the recorders'
 * UpdateTrust.Parse rules: LF only, every line ends in \n, at most 1024 bytes, versions x.y.z without leading zeros,
 * upper-case sha256, a size without a leading zero, lower-case key_id).
 */
export function parseManifest(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > 1024 || buf[buf.length - 1] !== 0x0a) return null;
  for (const b of buf) if (b !== 0x0a && (b < 0x20 || b > 0x7e)) return null;
  const lines = buf.subarray(0, buf.length - 1).toString("ascii").split("\n");
  if (lines.length !== KEYS.length + 1 || lines[0] !== MAGIC) return null;
  const v = {};
  for (let i = 0; i < KEYS.length; i++) {
    if (!lines[i + 1].startsWith(KEYS[i] + "=")) return null;
    v[KEYS[i]] = lines[i + 1].slice(KEYS[i].length + 1);
  }
  const ok =
    ARTIFACT[v.platform] === v.artifact &&
    VERSION.test(v.version) &&
    VERSION.test(v.min_from_version) &&
    /^[0-9A-F]{64}$/.test(v.sha256) &&
    /^[1-9][0-9]{0,9}$/.test(v.size) &&
    /^[0-9a-f]{16}$/.test(v.key_id) &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(v.issued_at);
  return ok ? v : null;
}

/**
 * Checks one platform's signed release against the installer script that will be served byte for byte. release: the
 * parsed update-<platform>.json ({manifest, manifest_sig} in base64, plus informational platform/version/sha256/key_id).
 * Throws unless the manifest is well formed, names this platform and its installer, and its sha256 and size are the
 * script's. Returns what generated.ts carries.
 */
export function checkSignedRelease(platform, release, script) {
  const where = `update-${platform}.json`;
  if (!ARTIFACT[platform]) throw new Error(`unknown platform ${platform}`);
  const body = strictBase64(release?.manifest);
  const sig = strictBase64(release?.manifest_sig);
  if (!body || !body.length || body.length > 1024) throw new Error(`${where}: manifest is not strict base64 of at most 1024 bytes`);
  if (!sig || sig.length !== 64) throw new Error(`${where}: manifest_sig is not strict base64 of a 64-byte Ed25519 signature`);
  const m = parseManifest(body);
  if (!m) throw new Error(`${where}: the manifest is malformed (PROTOCOL.md 5.1)`);
  if (m.platform !== platform) throw new Error(`${where}: the manifest is for ${m.platform}, not ${platform}`);
  script = Buffer.from(script);
  const hash = sha256Hex(script);
  if (m.sha256 !== hash) throw new Error(`${ARTIFACT[platform]} sha256 ${hash} does not match the signed manifest's ${m.sha256}`);
  if (Number(m.size) !== script.length) throw new Error(`${ARTIFACT[platform]} is ${script.length} bytes, the signed manifest says ${m.size}`);
  // The json's own copies are informational; disagreeing with the signed bytes means a mixed-up release folder.
  for (const [k, want] of [["platform", m.platform], ["version", m.version], ["sha256", m.sha256], ["key_id", m.key_id]]) {
    if (release[k] !== undefined && String(release[k]).toUpperCase() !== want.toUpperCase()) throw new Error(`${where}: ${k} ${release[k]} is not the manifest's ${want}`);
  }
  return { version: m.version, sha256: m.sha256, size: script.length, keyId: m.key_id, manifest: release.manifest, manifestSig: release.manifest_sig };
}

/**
 * The served installer must pin the recorder archive served next to it, and install the manifest's version
 * (`$RecorderZipSha256 = '...'` / `RecorderZipSha256='...'`, same for RecorderVersion).
 */
export function checkScriptPins(platform, script, { zipSha256, version }) {
  const text = Buffer.from(script).toString("utf8");
  const pin = (name) => new RegExp(`^\\$?${name}\\s*=\\s*'([^']*)'`, "m").exec(text)?.[1];
  if (/__[A-Z0-9_]+__/.test(text)) throw new Error(`${ARTIFACT[platform]}: unrendered placeholder`);
  if ((pin("RecorderZipSha256") ?? "").toUpperCase() !== zipSha256.toUpperCase())
    throw new Error(`${ARTIFACT[platform]} pins recorder archive ${pin("RecorderZipSha256")}, the release's archive is ${zipSha256}`);
  if (pin("RecorderVersion") !== version) throw new Error(`${ARTIFACT[platform]} installs ${pin("RecorderVersion")}, the signed manifest says ${version}`);
}

// UPSTREAM RELEASE PUBLIC KEYS: the only keys a release may be signed with (recorder repo windows/UpdateTrust.cs, macOS UpdateTrust): key_id -> raw
// Ed25519 public key, hex. A key rotation adds its key here in the same change that ships it to recorders.
// Trust anchors, not deployment config: every self-hosted server serves the upstream recorder release builds,
// and the recorders themselves pin these keys, so a self-host never changes them (SELFHOST_CONFIG.md). Public keys only;
// no private key or passphrase is ever in this repo.
export const RELEASE_KEYS = {
  "40237e5f07331135": "2879224b37afab0426bc311a18decf0f5aad66f08e02be19a920e52ff8a770c9", // primary
  "756a4dad2d25d8a3": "81d0da0d0137a7e8f9628c3e280c8b1615b2f077defc477d8f7a0b36d09b3e86", // backup
};

/**
 * Throws unless the manifest's key_id is a release key and manifest_sig is a valid Ed25519 signature of the manifest
 * bytes under that key. The recorder is the trust boundary; this only stops a mixed-up .sig from deploying and sending
 * every signed_update device to gave_up.
 */
export function checkReleaseKey(release, where, keys = RELEASE_KEYS) {
  const m = parseManifest(strictBase64(release?.manifest) ?? Buffer.alloc(0));
  const keyId = m?.key_id;
  if (!keyId || !Object.hasOwn(keys, keyId)) throw new Error(`${where}: key_id ${keyId} is not a release key (${Object.keys(keys).join(", ")})`);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keys[keyId], "hex")]), format: "der", type: "spki" });
  if (!verify(null, strictBase64(release.manifest), key, strictBase64(release.manifest_sig) ?? Buffer.alloc(0)))
    throw new Error(`${where}: manifest_sig does not verify under release key ${keyId}; not serving it`);
}

/** Throws when key_id is one of the recorder repo's TEST fixture keys. */
export function refuseTestKey(keyId, where) {
  if (TEST_KEY_IDS.includes(String(keyId).toLowerCase())) {
    throw new Error(`${where}: signed with TEST fixture key ${keyId} (recorder repo UpdateTrustFixtures), not a release key; not serving it`);
  }
}

/**
 * Throws when a recorder build's hashes.json / hashes.txt carries the release-keys marker. The recorder repo writes it
 * only into placeholder-key dev builds (`"release_keys": "PLACEHOLDER: dev build, not a release"` in hashes.json,
 * `RELEASE_KEYS=PLACEHOLDER: dev build, not a release` in hashes.txt); a release build has no such field or line, and
 * there is no "real keys" value. So any release_keys field or RELEASE_KEYS line is refused, whatever it says.
 */
export function refusePlaceholderHashes(name, text) {
  text = Buffer.from(text).toString("utf8");
  if (name.endsWith(".json")) {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`${name} is not JSON`); }
    if (j && typeof j === "object" && Object.keys(j).some((k) => k.toLowerCase() === "release_keys")) {
      throw new Error(`${name} has release_keys=${JSON.stringify(j.release_keys)}: a placeholder-key dev build, not a release; not serving it`);
    }
  }
  const line = /^\s*RELEASE_KEYS\b.*$/im.exec(text);
  if (line) throw new Error(`${name} has "${line[0].trim()}": a placeholder-key dev build, not a release; not serving it`);
}

/**
 * The recorder build's own hashes file must describe exactly what is served: refuses the marker
 * (refusePlaceholderHashes), then checks the install script, archive and version it lists.
 *   windows: dist/hashes.json {recorder_version, recorder_zip_sha256, install_ps1_sha256}
 *   macos:   dist/hashes.txt  RECORDER_VERSION=, RECORDER_MAC_ZIP_SHA256=, INSTALL_SH_SHA256=
 * installSha256 null = the script is rendered here, not the build's, so it is not compared.
 */
export function checkBuildHashes(platform, name, text, { installSha256, zipSha256, version }) {
  refusePlaceholderHashes(name, text);
  text = Buffer.from(text).toString("utf8");
  let got;
  if (platform === "windows") {
    const j = JSON.parse(text);
    got = { version: j.recorder_version, zip: j.recorder_zip_sha256, install: j.install_ps1_sha256 };
  } else {
    const v = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1]?.trim();
    got = { version: v("RECORDER_VERSION"), zip: v("RECORDER_MAC_ZIP_SHA256"), install: v("INSTALL_SH_SHA256") };
  }
  const same = (a, b) => typeof a === "string" && a.toUpperCase() === String(b).toUpperCase();
  if (!same(got.version, version)) throw new Error(`${name} is for recorder ${got.version}, the served one is ${version}`);
  if (!same(got.zip, zipSha256)) throw new Error(`${name} lists archive ${got.zip}, the served one is ${zipSha256}`);
  if (installSha256 && !same(got.install, installSha256)) throw new Error(`${name} lists install script ${got.install}, the served one is ${installSha256}`);
}

/** [{name, data}] for each entry of a zip (stored or deflated; no zip64). Throws on anything else. */
export function unzipEntries(buf, where) {
  buf = Buffer.from(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${where} is not a zip`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${where}: bad zip central directory`);
    const method = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (comp === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error(`${where}: zip64 entry ${name} not supported`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${where}: bad zip local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + comp);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`${where}: ${name} uses zip method ${method}, cannot inspect it`);
  }
  return out;
}

/**
 * Throws when a served recorder file (an install/uninstall script, or a recorder archive, every entry of it inflated)
 * carries the placeholder release keys a dev build compiles in. Zips are recognised by name (*.zip).
 */
export function refusePlaceholderArtifact(name, buf) {
  const scan = (where, data) => {
    data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (PLACEHOLDER_NEEDLES.some((n) => data.includes(n))) {
      throw new Error(`${where} carries the placeholder release keys (${PLACEHOLDER_KEY_TEXT}): a dev build, not a release; not serving it`);
    }
  };
  if (/\.zip$/i.test(name)) for (const e of unzipEntries(buf, name)) scan(`${name}:${e.name}`, e.data);
  else scan(name, buf);
}

/**
 * What a deploy must not ship, after the build (scripts/deploy-prod.mjs): generatedTs = worker/src/generated.ts,
 * served = [{name, data}] for the recorder files in worker/public/. Returns the reasons ([] = deployable).
 */
export function deployProblems(generatedTs, served) {
  const problems = [];
  const consts = [...String(generatedTs).matchAll(/export const (UPDATE_MANIFEST_(?:WINDOWS|MACOS))(?:: string)? = "([^"]*)";/g)];
  if (consts.length !== 2) problems.push("generated.ts does not carry UPDATE_MANIFEST_WINDOWS and UPDATE_MANIFEST_MACOS (rerun the build)");
  for (const [, constName, b64] of consts) {
    if (!b64) continue;
    const body = strictBase64(b64);
    const m = body && parseManifest(body);
    if (!m) { problems.push(`generated.ts ${constName} is not a well-formed signed manifest`); continue; }
    try { refuseTestKey(m.key_id, `generated.ts ${constName}`); } catch (e) { problems.push(e.message); }
  }
  for (const { name, data } of served) {
    try { refusePlaceholderArtifact(name, data); } catch (e) { problems.push(e.message); }
  }
  return problems;
}
