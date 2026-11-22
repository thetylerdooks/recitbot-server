// Puts the recorders the Worker serves into worker/public/ and writes worker/src/generated.ts (installer hashes, recorder
// versions, signed update manifests).
//
// Per platform, a signed release (the recorder repo's build output plus its build/sign-release.mjs output,
// RELEASING.md there) is served as is: its install script byte for byte, never re-rendered, and the build fails unless
// the script's SHA-256 and size are the ones in the release's signed manifest. The manifest and signature go into
// generated.ts for the update command; nothing here signs anything.
//   Windows: recorder/release/ = install.ps1, recorder.zip, uninstall.ps1, update-windows.json, hashes.json
//   macOS:   recorder-mac/     = Recitbot-mac-<version>.zip, install.sh, uninstall.sh, update-macos.json, hashes.txt
// The build also fails on a placeholder-key dev build (a release_keys / RELEASE_KEYS marker in a hashes file, or the
// placeholder keys inside a served file), on a hashes file that does not list what is served, and on a manifest signed
// by one of the recorder repo's TEST fixture keys (scripts/signed-release.mjs).
// Without one (no update-<platform>.json), the platform is built as before signed updates: Windows compiles
// recorder/AgentRecorder.cs with the in-box .NET Framework compiler and renders install.ps1, the Mac renders install.sh
// from recorder-mac/install.template.sh. Its manifest constants are then "", and recorders that announce signed_update
// get no update from this server (they would refuse it).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  checkBuildHashes, checkScriptPins, checkSignedRelease, refusePlaceholderArtifact, refusePlaceholderHashes, refuseTestKey, checkReleaseKey,
} from "./signed-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
// Pinned third-party download (gyan.dev build via GitHub release; digest from the release asset metadata).
const FFMPEG_URL = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip";
const FFMPEG_SHA256 = "60F467265B1E312373DBCD92200C2618A74850F98D3D078E94296BB3FA2047BA";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex").toUpperCase();

/** `public const string Version = "x.y.z";` in AgentRecorder.cs: what the recorder says in its hello frame. */
function recorderVersion() {
  const m = /public const string Version = "(\d{1,3}\.\d{1,3}\.\d{1,3})";/.exec(readFileSync(join(root, "recorder", "AgentRecorder.cs"), "utf8"));
  if (!m) throw new Error("Version constant not found in recorder/AgentRecorder.cs");
  return m[1];
}

function compile() {
  if (!existsSync(CSC)) throw new Error(`csc.exe not found at ${CSC} (Windows with .NET Framework 4.8 required)`);
  mkdirSync(join(root, "build"), { recursive: true });
  const r = spawnSync(
    CSC,
    [
      "-nologo",
      "-target:winexe",
      "-optimize+",
      "-platform:anycpu",
      `-out:${join(root, "build", "AgentRecorder.exe")}`,
      `-win32manifest:${join(root, "recorder", "AgentRecorder.manifest")}`,
      "-r:System.dll",
      "-r:System.Drawing.dll",
      "-r:System.Windows.Forms.dll",
      "-r:System.Security.dll",
      join(root, "recorder", "AgentRecorder.cs"),
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`csc failed:\n${r.stdout}${r.stderr}`);
  const t = spawnSync(join(root, "build", "AgentRecorder.exe"), ["--selftest"], { encoding: "utf8" });
  if (t.status !== 0) throw new Error(`recorder selftest failed:\n${t.stdout}${t.stderr}`);
  return t.stdout;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal deflate zip writer with fixed timestamps. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name);
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const pub = join(root, "worker", "public");
mkdirSync(pub, { recursive: true });

/** The release's update-<platform>.json checked against the script in `dir` it will serve (null = no signed release). */
function signedRelease(platform, dir, script) {
  const json = join(dir, `update-${platform}.json`);
  if (!existsSync(json)) return null;
  const r = checkSignedRelease(platform, JSON.parse(readFileSync(json, "utf8")), readFileSync(join(dir, script)));
  refuseTestKey(r.keyId, json.slice(root.length + 1).replaceAll("\\", "/"));
  checkReleaseKey(JSON.parse(readFileSync(json, "utf8")), json.slice(root.length + 1).replaceAll("\\", "/"));
  console.log(`${script}: signed release ${r.version}, key ${r.keyId}, sha256=${r.sha256} size=${r.size} (served as is)`);
  return r;
}

/**
 * Refuses a placeholder-key dev build of the recorder (RELEASING.md "Release keys" in the recorder repo): the
 * release_keys / RELEASE_KEYS marker in any hashes.json / hashes.txt in `dir`, and the placeholder keys compiled into
 * any file served from it ([[name, bytes]]). Returns the hashes file named `hashes`, or null when there is none.
 */
function refuseDevBuild(dir, served, hashes) {
  const rel = (f) => join(dir, f).slice(root.length + 1).replaceAll("\\", "/");
  for (const f of ["hashes.json", "hashes.txt"]) if (existsSync(join(dir, f))) refusePlaceholderHashes(rel(f), readFileSync(join(dir, f)));
  for (const [name, buf] of served) refusePlaceholderArtifact(rel(name), buf);
  return hashes && existsSync(join(dir, hashes)) ? { name: rel(hashes), text: readFileSync(join(dir, hashes)) } : null;
}

/** Windows: the signed release in recorder/release/ when there is one, else compiled and rendered here. */
function windowsRecorder() {
  const dir = join(root, "recorder", "release");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f !== "README.md") : [];
  if (files.length) {
    for (const f of ["install.ps1", "recorder.zip", "uninstall.ps1", "update-windows.json", "hashes.json"]) {
      if (!files.includes(f)) throw new Error(`recorder/release/ has no ${f}: copy the whole signed release (recorder/release/README.md)`);
    }
    const installBuf = readFileSync(join(dir, "install.ps1"));
    const zipBuf = readFileSync(join(dir, "recorder.zip"));
    // Static assets are limited to 25 MiB per file.
    if (zipBuf.length > 25 * 1024 * 1024) throw new Error("recorder/release/recorder.zip is over 25 MiB");
    const hashes = refuseDevBuild(dir, [["install.ps1", installBuf], ["recorder.zip", zipBuf], ["uninstall.ps1", readFileSync(join(dir, "uninstall.ps1"))]], "hashes.json");
    const signed = signedRelease("windows", dir, "install.ps1");
    checkScriptPins("windows", installBuf, { zipSha256: sha256(zipBuf), version: signed.version });
    checkBuildHashes("windows", hashes.name, hashes.text, { installSha256: signed.sha256, zipSha256: sha256(zipBuf), version: signed.version });
    writeFileSync(join(pub, "recorder.zip"), zipBuf);
    writeFileSync(join(pub, "install.ps1"), installBuf);
    copyFileSync(join(dir, "uninstall.ps1"), join(pub, "uninstall.ps1"));
    return { selftest: "", zipBuf, zipHash: sha256(zipBuf), installHash: signed.sha256, version: signed.version, signed };
  }
  if (!existsSync(join(root, "recorder", "AgentRecorder.cs"))) {
    throw new Error("no Windows recorder to serve: recorder/release/ has no signed release and there is no recorder/AgentRecorder.cs to compile");
  }
  const version = recorderVersion();
  const selftest = compile();
  const uninstall = readFileSync(join(root, "recorder", "uninstall.ps1"));
  const zipBuf = zip([
    { name: "AgentRecorder.exe", data: readFileSync(join(root, "build", "AgentRecorder.exe")) },
    { name: "AgentRecorder.exe.config", data: readFileSync(join(root, "recorder", "AgentRecorder.exe.config")) },
    { name: "uninstall.ps1", data: uninstall },
  ]);
  writeFileSync(join(pub, "recorder.zip"), zipBuf);
  const zipHash = sha256(zipBuf);

  const install = readFileSync(join(root, "recorder", "install.template.ps1"), "utf8")
    .replaceAll("__RECORDER_ZIP_SHA256__", zipHash)
    .replaceAll("__RECORDER_VERSION__", version)
    .replaceAll("__FFMPEG_URL__", FFMPEG_URL)
    .replaceAll("__FFMPEG_SHA256__", FFMPEG_SHA256);
  const installBuf = Buffer.from(install, "utf8");
  refusePlaceholderArtifact("recorder.zip (compiled from recorder/)", zipBuf);
  refusePlaceholderArtifact("install.ps1 (rendered from recorder/install.template.ps1)", installBuf);
  writeFileSync(join(pub, "install.ps1"), installBuf);
  copyFileSync(join(root, "recorder", "uninstall.ps1"), join(pub, "uninstall.ps1"));
  return { selftest, zipBuf, zipHash, installHash: sha256(installBuf), version, signed: null };
}
const win = windowsRecorder();

/**
 * The macOS recorder is built and signed on a Mac (`./build-app.sh && installer/package.sh`); its
 * dist/Recitbot-mac-<version>.zip goes into recorder-mac/. With a signed release (its install.sh and update-macos.json
 * there too) install.sh is served as is; otherwise it is rendered from recorder-mac/install.template.sh. Served with
 * uninstall.sh. Without the zip the Mac installer is not served and the RECORDER_MAC_* constants are empty
 * (get_installer platform "macos" then says it is unavailable).
 */
function macRecorder() {
  const dir = join(root, "recorder-mac");
  for (const f of readdirSync(pub)) if (/^Recitbot-mac-.*\.zip$|^(install|uninstall)\.sh$/.test(f)) rmSync(join(pub, f));
  const zips = readdirSync(dir).filter((f) => /^Recitbot-mac-.*\.zip$/.test(f));
  if (zips.length > 1) throw new Error(`recorder-mac/ has several Mac zips (${zips.join(", ")}): keep only the release one`);
  if (!zips.length) {
    refuseDevBuild(dir, []);
    console.warn("recorder-mac/Recitbot-mac-<version>.zip missing: the macOS installer is not served (see recorder-mac/README.md)");
    if (existsSync(join(dir, "update-macos.json"))) throw new Error("recorder-mac/ has update-macos.json but no Recitbot-mac-<version>.zip");
    return { installHash: "", zipHash: "", version: "", signed: null };
  }
  const m = /^Recitbot-mac-(\d{1,3}\.\d{1,3}\.\d{1,3})\.zip$/.exec(zips[0]);
  if (!m) throw new Error(`recorder-mac/${zips[0]}: expected Recitbot-mac-<x.y.z>.zip`);
  const macVersion = m[1];
  const zipBuf = readFileSync(join(dir, zips[0]));
  // Static assets are limited to 25 MiB per file.
  if (zipBuf.length > 25 * 1024 * 1024) throw new Error(`recorder-mac/${zips[0]} is over 25 MiB`);
  const zipHash = sha256(zipBuf);
  const hasJson = existsSync(join(dir, "update-macos.json"));
  if (hasJson !== existsSync(join(dir, "install.sh"))) {
    throw new Error(`recorder-mac/ has ${hasJson ? "update-macos.json but no install.sh" : "install.sh but no update-macos.json"}: copy the whole signed release`);
  }
  const uninstallBuf = readFileSync(join(dir, "uninstall.sh"));
  if (hasJson) {
    const installBuf = readFileSync(join(dir, "install.sh"));
    const hashes = refuseDevBuild(dir, [[zips[0], zipBuf], ["install.sh", installBuf], ["uninstall.sh", uninstallBuf]], "hashes.txt");
    if (!hashes) throw new Error("recorder-mac/ has update-macos.json but no hashes.txt: copy the whole signed release (package.sh writes it)");
    const signed = signedRelease("macos", dir, "install.sh");
    if (signed.version !== macVersion) throw new Error(`recorder-mac/${zips[0]} is ${macVersion}, the signed manifest says ${signed.version}`);
    checkScriptPins("macos", installBuf, { zipSha256: zipHash, version: macVersion });
    checkBuildHashes("macos", hashes.name, hashes.text, { installSha256: signed.sha256, zipSha256: zipHash, version: macVersion });
    if (installBuf.includes(0x0d)) throw new Error("recorder-mac/install.sh has CRLF line endings (bash needs LF)");
    writeFileSync(join(pub, zips[0]), zipBuf);
    writeFileSync(join(pub, "install.sh"), installBuf);
    copyFileSync(join(dir, "uninstall.sh"), join(pub, "uninstall.sh"));
    console.log(`${zips[0]} ${zipBuf.length} bytes sha256=${zipHash}`);
    return { installHash: signed.sha256, zipHash, version: macVersion, signed };
  }
  const install = readFileSync(join(dir, "install.template.sh"), "utf8")
    .replaceAll("__RECORDER_ZIP_SHA256__", zipHash)
    .replaceAll("__RECORDER_VERSION__", macVersion);
  if (install.includes("\r")) throw new Error("recorder-mac/install.template.sh has CRLF line endings (bash needs LF)");
  if (/__[A-Z0-9_]+__/.test(install)) throw new Error("recorder-mac/install.template.sh: placeholder left after rendering");
  if (!install.includes(`RecorderZipSha256='${zipHash}'`) || !install.includes(`RecorderVersion='${macVersion}'`)) {
    throw new Error("install.sh does not carry the zip hash and version");
  }
  const installBuf = Buffer.from(install, "utf8");
  // install.sh is rendered here, so only the archive and version are compared with the build's hashes.txt (if copied).
  const hashes = refuseDevBuild(dir, [[zips[0], zipBuf], ["install.sh (rendered)", installBuf], ["uninstall.sh", uninstallBuf]], "hashes.txt");
  if (hashes) checkBuildHashes("macos", hashes.name, hashes.text, { installSha256: null, zipSha256: zipHash, version: macVersion });
  writeFileSync(join(pub, zips[0]), zipBuf);
  writeFileSync(join(pub, "install.sh"), installBuf);
  copyFileSync(join(dir, "uninstall.sh"), join(pub, "uninstall.sh"));
  const installHash = sha256(installBuf);
  console.log(`${zips[0]} ${zipBuf.length} bytes sha256=${zipHash}`);
  console.log(`install.sh sha256=${installHash} recorder ${macVersion}`);
  return { installHash, zipHash, version: macVersion, signed: null };
}
const mac = macRecorder();

writeFileSync(
  join(root, "worker", "src", "generated.ts"),
  `// GENERATED by scripts/build-recorder-zip.mjs. Do not edit.\n` +
    `export const INSTALL_PS1_SHA256 = "${win.installHash}";\n` +
    `export const RECORDER_ZIP_SHA256 = "${win.zipHash}";\n` +
    `export const RECORDER_VERSION = "${win.version}";\n` +
    `// macOS ("" = recorder-mac/Recitbot-mac-<version>.zip missing at build time: no Mac installer).\n` +
    `export const INSTALL_SH_SHA256: string = "${mac.installHash}";\n` +
    `export const RECORDER_MAC_ZIP_SHA256: string = "${mac.zipHash}";\n` +
    `export const RECORDER_MAC_VERSION: string = "${mac.version}";\n` +
    `// The offline-signed release manifest and its Ed25519 signature per platform (base64, PROTOCOL.md 5.1), relayed as\n` +
    `// is in the update command. "" = no signed release: recorders that announce signed_update get no update.\n` +
    `export const UPDATE_MANIFEST_WINDOWS: string = "${win.signed?.manifest ?? ""}";\n` +
    `export const UPDATE_MANIFEST_SIG_WINDOWS: string = "${win.signed?.manifestSig ?? ""}";\n` +
    `export const UPDATE_MANIFEST_MACOS: string = "${mac.signed?.manifest ?? ""}";\n` +
    `export const UPDATE_MANIFEST_SIG_MACOS: string = "${mac.signed?.manifestSig ?? ""}";\n`,
);
if (win.selftest) console.log(win.selftest.trim());
console.log(`recorder.zip ${win.zipBuf.length} bytes sha256=${win.zipHash}`);
console.log(`install.ps1 sha256=${win.installHash} recorder ${win.version}${win.signed ? " (signed release, served as is)" : ""}`);
for (const [p, r] of [["Windows", win], ["macOS", mac]]) {
  if (r.version && !r.signed) console.warn(`${p}: no signed release; recorders that announce signed_update get no update from this build`);
}
