// Signed recorder updates (recorder "signed_update", PROTOCOL.md 5.1 in the recorder repo): the server relays the
// release's offline-signed manifest and signature (never signs one), outside the command HMAC; sends nothing to a
// signed_update recorder when its platform has no signed release; and stops at once when the recorder refuses one.
// 0.6.1 recorders (no signed_update) keep the hash-pinned path unchanged.
//
// The manifests below are the recorder repo's selftest fixtures (windows/UpdateTrustFixtures.cs): signed with throwaway
// TEST keys whose private halves were discarded. No key is made here.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import buildSrc from "../../scripts/build-recorder-zip.mjs?raw";
import deploySrc from "../../scripts/deploy-prod.mjs?raw";
import {
  checkBuildHashes, checkScriptPins, checkSignedRelease, deployProblems, parseManifest, refusePlaceholderArtifact,
  refusePlaceholderHashes, refuseTestKey, TEST_KEY_IDS, unzipEntries,
} from "../../scripts/signed-release.mjs";
import { autoUpdateReport, signatureRefusal, type AutoUpdateStatus } from "../src/auto-update";
import { canonicalCommand, deviceCommandKey, deviceHub, fitCommand, RECORDER_FEATURES } from "../src/device-hub";
import { PLATFORM, updatable, updateCommand } from "../src/recorder-update";
import { hmacHex } from "../src/util";
import { connectDevice, mcp, ORIGIN, seedAccount } from "./helpers";

const TEST_FIXTURES = {
  windowsArtifact: "Write-Output 'recitbot signed update selftest'\r\n",
  macArtifact: "#!/bin/bash\necho ok\n",
  winOk: {
    manifest:
      "cmVjaXRib3QtdXBkYXRlLW1hbmlmZXN0LzEKcGxhdGZvcm09d2luZG93cwp2ZXJzaW9uPTkuMC4wCm1pbl9mcm9tX3ZlcnNpb249MC4wLjAKYXJ0aWZhY3Q9aW5zdGFsbC5wczEKc2hhMjU2PTI2NzM3MkQ3OUFDMDgyRENBQ0Q5NTNBNzFBRUI4QTAzMjQwREFCQzYwRTFDQzZDM0UwQTQzQTI4MTJERDAzRDQKc2l6ZT00OAprZXlfaWQ9NWUwYWYwYmRkMmYyNzQ1Mwppc3N1ZWRfYXQ9MjAyNi0xMS0xOFQwMDowMDowMFoK",
    manifest_sig: "apctYaEKMLKWDgXpCR8LfreQtw/rVtJsPD9Vy+s6kpYq3bW6+GN0kyDA4/st5yoD1sVyqLU36bb6oxUU2rGHDg==",
  },
  winMalformed: {
    manifest:
      "cmVjaXRib3QtdXBkYXRlLW1hbmlmZXN0LzEKcGxhdGZvcm09d2luZG93cwp2ZXJzaW9uPTkuMAptaW5fZnJvbV92ZXJzaW9uPTAuMC4wCmFydGlmYWN0PWluc3RhbGwucHMxCnNoYTI1Nj0yNjczNzJENzlBQzA4MkRDQUNEOTUzQTcxQUVCOEEwMzI0MERBQkM2MEUxQ0M2QzNFMEE0M0EyODEyREQwM0Q0CnNpemU9NDgKa2V5X2lkPTVlMGFmMGJkZDJmMjc0NTMKaXNzdWVkX2F0PTIwMjYtMTEtMThUMDA6MDA6MDBaCg==",
    manifest_sig: "Hk+tFvTcVY+x/ykNyBpEWJEd0H8F8LqcBNo7oM2CR8i4DXSiTxCGfAx5vgGgPPleE9Cy5IVkeRzMsZBrod84Ag==",
  },
  macOk: {
    manifest:
      "cmVjaXRib3QtdXBkYXRlLW1hbmlmZXN0LzEKcGxhdGZvcm09bWFjb3MKdmVyc2lvbj05LjAuMAptaW5fZnJvbV92ZXJzaW9uPTAuMC4wCmFydGlmYWN0PWluc3RhbGwuc2gKc2hhMjU2PUM3RUIyMTVEQjk4QzlCREZFNDk1MDExMUM2QkI5RkNEMjEwQ0MzQzNEMEQyRThBMDg3NUI1ODhFMzBENTdGNzAKc2l6ZT0yMAprZXlfaWQ9NWUwYWYwYmRkMmYyNzQ1Mwppc3N1ZWRfYXQ9MjAyNi0xMS0xOFQwMDowMDowMFoK",
    manifest_sig: "kvCkJAAPIC15r8AOpSrv87MOlpjl8uHVCXXPX/iMmuFkCdZD6Dht55pkNPnLW/F+Qyk/E6FrJhRtOBj5H43EDg==",
  },
};
const WIN_SHA = "267372D79AC082DCACD953A71AEB8A03240DABC60E1CC6C3E0A43A2812DD03D4";
const bytes = (s: string) => new TextEncoder().encode(s);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const SIGNED = [...RECORDER_FEATURES];
/** What 0.6.1 announces: everything but signed_update. */
const V061 = RECORDER_FEATURES.filter((f) => f !== "signed_update");
const BEHIND = "0.0.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const updates = (frames: any[]) => frames.filter((f) => f.type === "update");

// PLATFORM comes from generated.ts (whatever release this checkout was built with). Tests pin it to the TEST fixture
// release, or to none, and put it back afterwards.
const saved = { windows: { ...PLATFORM.windows }, macos: { ...PLATFORM.macos } };
function release(platform: "windows" | "macos", r: { latest: string; sha256: string; manifest: string; manifestSig: string }) {
  Object.assign(PLATFORM[platform], r);
}
const signedWindows = () => release("windows", { latest: "9.0.0", sha256: WIN_SHA, manifest: TEST_FIXTURES.winOk.manifest, manifestSig: TEST_FIXTURES.winOk.manifest_sig });
const unsignedWindows = () => release("windows", { latest: "9.0.0", sha256: WIN_SHA, manifest: "", manifestSig: "" });
afterEach(() => {
  Object.assign(PLATFORM.windows, saved.windows);
  Object.assign(PLATFORM.macos, saved.macos);
  vi.restoreAllMocks();
});

type Rec = { accountId: string; key: string; deviceId: string; deviceToken: string };
async function hello(a: Rec, version: string, features: string[]) {
  const dev = await connectDevice(a.deviceToken);
  dev.ws.send(JSON.stringify({ type: "hello", version, features }));
  const hub = deviceHub(env, a.accountId);
  for (let i = 0; i < 50 && (await hub.recorderInfo(a.accountId, a.deviceId))?.version !== version; i++) await sleep(10);
  await sleep(100);
  return dev;
}
const status = (a: Rec) => deviceHub(env, a.accountId).autoUpdate(a.accountId, a.deviceId);
const expireWindow = (a: Rec) =>
  runInDurableObject(env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(a.accountId)), async (_i, state) => {
    const s = (await state.storage.get<AutoUpdateStatus>(`autoupdate:${a.deviceId}`))!;
    await state.storage.put(`autoupdate:${a.deviceId}`, { ...s, next_at: 0 });
  });

describe("signed release check (build-recorder-zip.mjs)", () => {
  it("accepts the release whose manifest names exactly the served script", () => {
    const r = checkSignedRelease("windows", { ...TEST_FIXTURES.winOk, platform: "windows", version: "9.0.0" }, bytes(TEST_FIXTURES.windowsArtifact));
    expect(r).toMatchObject({ version: "9.0.0", sha256: WIN_SHA, size: 48, keyId: "5e0af0bdd2f27453" });
    // Relayed exactly as the release made them.
    expect(r.manifest).toBe(TEST_FIXTURES.winOk.manifest);
    expect(r.manifestSig).toBe(TEST_FIXTURES.winOk.manifest_sig);
    expect(checkSignedRelease("macos", TEST_FIXTURES.macOk, bytes(TEST_FIXTURES.macArtifact)).version).toBe("9.0.0");
  });

  it("fails when the served script's hash or size is not the manifest's", () => {
    expect(() => checkSignedRelease("windows", TEST_FIXTURES.winOk, bytes(TEST_FIXTURES.windowsArtifact.replace("\r\n", "\n")))).toThrow(/does not match the signed manifest/);
    expect(() => checkSignedRelease("windows", TEST_FIXTURES.winOk, bytes(TEST_FIXTURES.windowsArtifact + " "))).toThrow(/does not match the signed manifest/);
  });

  it("fails on a manifest for the other platform, a malformed one, or a bad encoding", () => {
    expect(() => checkSignedRelease("windows", TEST_FIXTURES.macOk, bytes(TEST_FIXTURES.macArtifact))).toThrow(/for macos, not windows/);
    expect(() => checkSignedRelease("windows", TEST_FIXTURES.winMalformed, bytes(TEST_FIXTURES.windowsArtifact))).toThrow(/malformed/);
    expect(() => checkSignedRelease("windows", { ...TEST_FIXTURES.winOk, manifest: ` ${TEST_FIXTURES.winOk.manifest}` }, bytes(TEST_FIXTURES.windowsArtifact))).toThrow(/strict base64/);
    expect(() => checkSignedRelease("windows", { ...TEST_FIXTURES.winOk, manifest_sig: TEST_FIXTURES.winOk.manifest_sig.slice(4) }, bytes(TEST_FIXTURES.windowsArtifact))).toThrow(/64-byte/);
    expect(() => checkSignedRelease("windows", { manifest_sig: TEST_FIXTURES.winOk.manifest_sig }, bytes(TEST_FIXTURES.windowsArtifact))).toThrow(/manifest is not/);
    // The json's informational copies must agree with the signed bytes.
    expect(() => checkSignedRelease("windows", { ...TEST_FIXTURES.winOk, version: "9.0.1" }, bytes(TEST_FIXTURES.windowsArtifact))).toThrow(/version 9.0.1/);
  });

  it("parses only the exact nine-line form", () => {
    const text = atob(TEST_FIXTURES.winOk.manifest);
    expect(parseManifest(ascii(text))).toMatchObject({ platform: "windows", artifact: "install.ps1", size: "48" });
    expect(parseManifest(ascii(text.replaceAll("\n", "\r\n")))).toBeNull();
    expect(parseManifest(ascii(text.slice(0, -1)))).toBeNull();
    expect(parseManifest(ascii(text.replace("sha256=2673", "sha256=a673")))).toBeNull();
  });

  it("the served installer must pin the served archive and install the signed version", () => {
    const zip = "AB".repeat(32);
    const ps1 = `$RecorderZipSha256 = '${zip}'\r\n$RecorderVersion = '9.0.0'\r\n`;
    expect(() => checkScriptPins("windows", bytes(ps1), { zipSha256: zip, version: "9.0.0" })).not.toThrow();
    expect(() => checkScriptPins("windows", bytes(ps1), { zipSha256: "CD".repeat(32), version: "9.0.0" })).toThrow(/pins recorder archive/);
    expect(() => checkScriptPins("windows", bytes(ps1), { zipSha256: zip, version: "9.0.1" })).toThrow(/installs 9.0.0/);
    const sh = `RecorderZipSha256='${zip}'\nRecorderVersion='9.0.0'\n`;
    expect(() => checkScriptPins("macos", bytes(sh), { zipSha256: zip, version: "9.0.0" })).not.toThrow();
    expect(() => checkScriptPins("macos", bytes(sh + "x=__RECORDER_VERSION__\n"), { zipSha256: zip, version: "9.0.0" })).toThrow(/placeholder/);
  });
});

// Placeholder-key dev builds and TEST keys (recorder repo RELEASING.md "Release keys"). The marker texts are exactly what
// the recorder repo's build/build-windows.mjs and macos/installer/package.sh write into a dev build's hashes files.
const DEV_MARKER = "PLACEHOLDER: dev build, not a release";
const ZIP_SHA = "AB".repeat(32);
const SH_SHA = "CD".repeat(32);
const winHashes = (extra: object = {}) =>
  JSON.stringify({ recorder_version: "9.0.0", recitbot_exe_sha256: "EF".repeat(32), recorder_zip_sha256: ZIP_SHA, install_ps1_sha256: WIN_SHA, compiler: "x", reference_assemblies: "y", ...extra }, null, 2) + "\n";
const macHashes = (extra = "") => `INSTALL_SH_SHA256=${SH_SHA}\nRECORDER_MAC_ZIP_SHA256=${ZIP_SHA}\nRECORDER_VERSION=9.0.0\n${extra}`;
// What a placeholder build compiles in: the placeholder key literal (UTF-16LE in the .NET exe, UTF-8 in the Swift app).
const PLACEHOLDER_KEY = "PLACEHOLDER-PRIMARY-PUBLIC-KEY-NOT-FOR-RELEASE";
const utf16 = (s: string) => new Uint8Array(Buffer.from(s, "utf16le"));
/** A zip with central directory: stored entries, or deflated ones (deflate: true). */
function makeZip(files: { name: string; data: Uint8Array; deflate?: boolean }[]) {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), body = f.deflate ? deflateRawSync(f.data) : Buffer.from(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(f.deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}
// The TEST fixture manifest re-labelled with the real primary key's id (the server checks shape, never the signature).
const realKeyManifest = btoa(atob(TEST_FIXTURES.winOk.manifest).replace("key_id=5e0af0bdd2f27453", "key_id=40237e5f07331135"));
const generatedTs = (win: string, mac = "") =>
  `export const UPDATE_MANIFEST_WINDOWS: string = "${win}";\nexport const UPDATE_MANIFEST_SIG_WINDOWS: string = "";\n` +
  `export const UPDATE_MANIFEST_MACOS: string = "${mac}";\nexport const UPDATE_MANIFEST_SIG_MACOS: string = "";\n`;

describe("placeholder-key builds and TEST keys are never served (build-recorder-zip.mjs, deploy-prod.mjs)", () => {
  it("refuses a manifest signed by any committed TEST key, accepts the release keys", () => {
    for (const id of ["5e0af0bdd2f27453", "0570fc67ff123479", "f3b6eaa5db2038ca"]) {
      expect(() => refuseTestKey(id, "update-windows.json")).toThrow(new RegExp(`update-windows.json: signed with TEST fixture key ${id}`));
      expect(() => refuseTestKey(id.toUpperCase(), "x")).toThrow(/TEST fixture key/);
    }
    expect(TEST_KEY_IDS).toEqual(["5e0af0bdd2f27453", "0570fc67ff123479", "f3b6eaa5db2038ca"]);
    expect(() => refuseTestKey("40237e5f07331135", "x")).not.toThrow();
    expect(() => refuseTestKey("756a4dad2d25d8a3", "x")).not.toThrow();
  });

  it("refuses the Windows placeholder marker (hashes.json release_keys, hashes.txt RELEASE_KEYS) and any other value", () => {
    expect(() => refusePlaceholderHashes("recorder/release/hashes.json", winHashes({ release_keys: DEV_MARKER }))).toThrow(/release_keys="PLACEHOLDER: dev build.*not serving it/);
    expect(() => refusePlaceholderHashes("recorder/release/hashes.txt", `RELEASE_KEYS=${DEV_MARKER}\n`)).toThrow(/RELEASE_KEYS=PLACEHOLDER/);
    // There is no "real keys" value: a release build has no release_keys at all.
    for (const v of ["real", "RELEASE", "", null, { placeholder: false }]) {
      expect(() => refusePlaceholderHashes("hashes.json", winHashes({ release_keys: v }))).toThrow(/release_keys=/);
    }
    expect(() => refusePlaceholderHashes("hashes.json", winHashes({ RELEASE_KEYS: "real" }))).toThrow(/release_keys=|RELEASE_KEYS/);
    expect(() => refusePlaceholderHashes("hashes.json", "{not json")).toThrow(/not JSON/);
    expect(() => refusePlaceholderHashes("hashes.json", winHashes())).not.toThrow();
  });

  it("refuses the Mac placeholder marker (hashes.txt RELEASE_KEYS=PLACEHOLDER) and any other RELEASE_KEYS line", () => {
    expect(() => refusePlaceholderHashes("recorder-mac/hashes.txt", macHashes(`RELEASE_KEYS=${DEV_MARKER}\n`))).toThrow(/recorder-mac\/hashes.txt has "RELEASE_KEYS=PLACEHOLDER/);
    expect(() => refusePlaceholderHashes("hashes.txt", macHashes("RELEASE_KEYS=REAL\n"))).toThrow(/RELEASE_KEYS=REAL/);
    expect(() => refusePlaceholderHashes("hashes.txt", macHashes("release_keys = placeholder\r\n"))).toThrow(/release_keys/);
    expect(() => refusePlaceholderHashes("hashes.txt", bytes(macHashes()))).not.toThrow();
  });

  it("the build's hashes file must list exactly the served script, archive and version", () => {
    const served = { installSha256: WIN_SHA, zipSha256: ZIP_SHA, version: "9.0.0" };
    expect(() => checkBuildHashes("windows", "hashes.json", winHashes(), served)).not.toThrow();
    expect(() => checkBuildHashes("windows", "hashes.json", winHashes({ release_keys: DEV_MARKER }), served)).toThrow(/release_keys/);
    expect(() => checkBuildHashes("windows", "hashes.json", winHashes(), { ...served, zipSha256: "00".repeat(32) })).toThrow(/lists archive/);
    expect(() => checkBuildHashes("windows", "hashes.json", winHashes(), { ...served, installSha256: "00".repeat(32) })).toThrow(/lists install script/);
    expect(() => checkBuildHashes("windows", "hashes.json", winHashes(), { ...served, version: "9.0.1" })).toThrow(/is for recorder 9.0.0/);
    const mac = { installSha256: SH_SHA, zipSha256: ZIP_SHA.toLowerCase(), version: "9.0.0" };
    expect(() => checkBuildHashes("macos", "hashes.txt", macHashes(), mac)).not.toThrow();
    expect(() => checkBuildHashes("macos", "hashes.txt", macHashes(`RELEASE_KEYS=${DEV_MARKER}\n`), mac)).toThrow(/RELEASE_KEYS=PLACEHOLDER/);
    // install.sh rendered by this server (no signed release): only the archive and version are the build's.
    expect(() => checkBuildHashes("macos", "hashes.txt", macHashes(), { ...mac, installSha256: null })).not.toThrow();
    expect(() => checkBuildHashes("macos", "hashes.txt", macHashes(), { ...mac, installSha256: "00".repeat(32) })).toThrow(/lists install script/);
  });

  it("refuses a recorder archive or script that has the placeholder keys compiled in, looking inside the zip", () => {
    const exe = (key: string) => utf16(`\0\0UpdateTrust${key}\0primary\0`);
    const clean = makeZip([{ name: "Recitbot.exe", data: exe("2879224b37afab0426bc311a18decf0f5aad66f08e02be19a920e52ff8a770c9"), deflate: true }]);
    expect(() => refusePlaceholderArtifact("recorder/release/recorder.zip", clean)).not.toThrow();
    // A release build still has the selftest's own placeholder literals ("PLACEHOLDER-PUBLIC-KEY"); those are fine.
    expect(() => refusePlaceholderArtifact("recorder.zip", makeZip([{ name: "Recitbot.exe", data: utf16("PLACEHOLDER-KEY-ID\0PLACEHOLDER-PUBLIC-KEY"), deflate: true }]))).not.toThrow();
    // Windows dev build: UTF-16LE in a deflated .exe.
    const devWin = makeZip([{ name: "uninstall.ps1", data: bytes("x") }, { name: "Recitbot.exe", data: exe(PLACEHOLDER_KEY), deflate: true }]);
    expect(() => refusePlaceholderArtifact("recorder/release/recorder.zip", devWin)).toThrow(/recorder\/release\/recorder.zip:Recitbot.exe carries the placeholder release keys/);
    // Mac dev build: UTF-8 in the app binary, stored.
    const devMac = makeZip([{ name: "Recitbot.app/Contents/MacOS/Recitbot", data: bytes(`\0${PLACEHOLDER_KEY.replace("PRIMARY", "BACKUP")}\0`) }]);
    expect(() => refusePlaceholderArtifact("Recitbot-mac-9.0.0.zip", devMac)).toThrow(/Recitbot.app\/Contents\/MacOS\/Recitbot carries/);
    expect(() => refusePlaceholderArtifact("install.sh", bytes(`echo ${PLACEHOLDER_KEY}\n`))).toThrow(/install.sh carries/);
    expect(() => refusePlaceholderArtifact("install.sh", bytes("echo ok\n"))).not.toThrow();
    // An archive that cannot be inspected is refused, never waved through.
    expect(() => refusePlaceholderArtifact("recorder.zip", bytes("not a zip at all, just text"))).toThrow(/not a zip/);
    expect(unzipEntries(devWin, "z").map((e) => e.name)).toEqual(["uninstall.ps1", "Recitbot.exe"]);
  });

  it("deploy refuses a TEST-key manifest in generated.ts or a placeholder build in worker/public, before anything remote", () => {
    const served = [{ name: "worker/public/recorder.zip", data: makeZip([{ name: "Recitbot.exe", data: utf16("ok"), deflate: true }]) }];
    expect(deployProblems(generatedTs(""), served)).toEqual([]);
    expect(deployProblems(generatedTs(realKeyManifest), served)).toEqual([]);
    expect(deployProblems(generatedTs(TEST_FIXTURES.winOk.manifest), served)).toEqual([
      expect.stringMatching(/generated.ts UPDATE_MANIFEST_WINDOWS: signed with TEST fixture key 5e0af0bdd2f27453/),
    ]);
    expect(deployProblems(generatedTs("", TEST_FIXTURES.macOk.manifest), served)).toEqual([expect.stringMatching(/UPDATE_MANIFEST_MACOS: signed with TEST/)]);
    expect(deployProblems(generatedTs("bm90IGEgbWFuaWZlc3QK"), served)).toEqual([expect.stringMatching(/not a well-formed signed manifest/)]);
    expect(deployProblems("// stale generated.ts\n", served)).toEqual([expect.stringMatching(/does not carry UPDATE_MANIFEST/)]);
    const dev = [...served, { name: "worker/public/Recitbot-mac-9.0.0.zip", data: makeZip([{ name: "Recitbot.app/Contents/MacOS/Recitbot", data: bytes(PLACEHOLDER_KEY), deflate: true }]) }];
    expect(deployProblems(generatedTs(""), dev)).toEqual([expect.stringMatching(/Recitbot-mac-9.0.0.zip:Recitbot.app\/Contents\/MacOS\/Recitbot carries the placeholder/)]);
  });

  it("the generator and the deploy path run these checks", () => {
    // build-recorder-zip.mjs: every signed release is checked for TEST keys, both platforms' hashes and served files
    // for the placeholder marker, and a signed release must bring its build's hashes file.
    expect(buildSrc).toMatch(/checkSignedRelease\([^\n]*\n\s*refuseTestKey\(r\.keyId, json[.)]/);
    expect(buildSrc).toMatch(/"update-windows\.json", "hashes\.json"\]/);
    expect(buildSrc).toMatch(/refuseTestKey\(r\.keyId, json[^\n]*\n\s*checkReleaseKey\(JSON\.parse\(readFileSync\(json/);
    expect(buildSrc.match(/refuseDevBuild\(dir, \[\[/g)).toHaveLength(3);
    expect(buildSrc).toMatch(/refuseDevBuild\(dir, \[\]\)/);
    expect(buildSrc.match(/checkBuildHashes\("(windows|macos)"/g)).toHaveLength(3);
    expect(buildSrc.match(/refusePlaceholderArtifact\("/g)).toHaveLength(2);
    // deploy-prod.mjs: checked after the build, before the first remote wrangler call.
    const check = deploySrc.indexOf("deployProblems(readFileSync");
    expect(check).toBeGreaterThan(deploySrc.indexOf("build failed"));
    expect(check).toBeLessThan(deploySrc.indexOf('run("apply remote migrations"'));
    expect(deploySrc).toMatch(/if \(problems\.length\) \{\r?\n[^\n]*\n\s*process\.exit\(1\);/);
  });
});

describe("update command", () => {
  it("carries the release's manifest and manifest_sig when there is one, nothing otherwise", async () => {
    signedWindows();
    const u = await updateCommand(env, ORIGIN, "A".repeat(22), "windows");
    expect(u).toMatchObject({ version: "9.0.0", sha256: WIN_SHA, ...TEST_FIXTURES.winOk });
    unsignedWindows();
    const v = await updateCommand(env, ORIGIN, "A".repeat(22), "windows");
    expect(v).not.toHaveProperty("manifest");
    expect(v).not.toHaveProperty("manifest_sig");
  });

  it("manifest and manifest_sig are never part of the HMAC canonical string", () => {
    const base = {
      type: "update", recording_id: "A".repeat(22), max_seconds: 0, mic: false, nonce: 1, exp: 2, account_id: "B".repeat(22),
      device_id: "C".repeat(22), upload_token: "", url: `${ORIGIN}/i/x`, version: "9.0.0", sha256: WIN_SHA,
    };
    const canonical = canonicalCommand(base);
    expect(canonicalCommand({ ...base, ...TEST_FIXTURES.winOk } as typeof base)).toBe(canonical);
    expect(canonical.endsWith(`|url|${ORIGIN}/i/x|upd|9.0.0|${WIN_SHA}`)).toBe(true);
  });

  it("fitCommand keeps them for signed_update recorders only", () => {
    const cmd = { type: "update" as const, recording_id: "A".repeat(22), url: "u", version: "9.0.0", sha256: WIN_SHA, ...TEST_FIXTURES.winOk };
    expect(fitCommand(cmd, SIGNED).cmd).toMatchObject(TEST_FIXTURES.winOk);
    expect(fitCommand(cmd, V061).cmd).not.toHaveProperty("manifest");
    expect(fitCommand(cmd, V061).cmd).not.toHaveProperty("manifest_sig");
  });

  it("updatable: signed_update needs a manifest, older recorders do not", () => {
    unsignedWindows();
    expect(updatable("windows", SIGNED)).toBe(false);
    expect(updatable("windows", V061)).toBe(true);
    signedWindows();
    expect(updatable("windows", SIGNED)).toBe(true);
  });
});

describe("auto-update to signed_update recorders", () => {
  it("relays manifest and manifest_sig as is, outside the HMAC", async () => {
    expect(RECORDER_FEATURES).toContain("signed_update");
    signedWindows();
    const a = (await seedAccount()) as Rec;
    const sent = updates((await hello(a, BEHIND, SIGNED)).frames);
    expect(sent).toHaveLength(1);
    const { mac, manifest, manifest_sig, ...rest } = sent[0];
    expect(manifest).toBe(TEST_FIXTURES.winOk.manifest);
    expect(manifest_sig).toBe(TEST_FIXTURES.winOk.manifest_sig);
    expect(rest).toMatchObject({ version: "9.0.0", sha256: WIN_SHA });
    expect(mac).toBe(await hmacHex(await deviceCommandKey(env, a.deviceId), canonicalCommand(rest)));
  });

  it("sends nothing when the platform has no signed release (the recorder would refuse it)", async () => {
    unsignedWindows();
    const a = (await seedAccount()) as Rec;
    const dev = await hello(a, BEHIND, SIGNED);
    expect(updates(dev.frames)).toHaveLength(0);
    expect(await status(a)).toBeNull();
    // update_recorder says so and sends nothing either.
    const r = (await mcp("update_recorder", {}, a.key)).data;
    expect(r).toMatchObject({ current: BEHIND, latest: "9.0.0", action: "no_signed_release" });
    await sleep(50);
    expect(updates(dev.frames)).toHaveLength(0);
  });

  it("the hub refuses an unsigned update to a signed_update recorder even when asked directly", async () => {
    const a = (await seedAccount()) as Rec;
    const dev = await hello(a, "9.9.9", SIGNED);
    const r = await deviceHub(env, a.accountId).pushUpdate(a.accountId, a.deviceId, { url: `${ORIGIN}/i/x`, version: "9.0.0", sha256: WIN_SHA });
    expect(r).toEqual({ ok: false, reason: "unsigned" });
    await sleep(50);
    expect(updates(dev.frames)).toHaveLength(0);
  });

  it("a signature refusal is final for that version: no retries, logged once", async () => {
    signedWindows();
    const warn = vi.spyOn(console, "warn");
    const a = (await seedAccount()) as Rec;
    let dev = await hello(a, BEHIND, SIGNED);
    expect(updates(dev.frames)).toHaveLength(1);
    const refusal = "update signature invalid (not signed by a release key)";
    dev.ws.send(JSON.stringify({ type: "update", status: "failed", version: "9.0.0", error: refusal }));
    for (let i = 0; i < 50 && (await status(a))?.result !== "gave_up"; i++) await sleep(10);
    expect(await status(a)).toMatchObject({ version: "9.0.0", result: "gave_up", attempts: 1, failures: 1, error: refusal });
    // The same report again (e.g. after a manual push) changes and logs nothing.
    dev.ws.send(JSON.stringify({ type: "update", status: "failed", version: "9.0.0", error: refusal }));
    await sleep(100);
    // Later hellos, after the window too, get nothing.
    await expireWindow(a);
    dev = await hello(a, BEHIND, SIGNED);
    expect(updates(dev.frames)).toHaveLength(0);
    expect(await status(a)).toMatchObject({ result: "gave_up", attempts: 1, failures: 1 });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("refused the signed update"))).toHaveLength(1);
  });

  it("an ordinary failure still gets the usual retries", async () => {
    signedWindows();
    const a = (await seedAccount()) as Rec;
    let dev = await hello(a, BEHIND, SIGNED);
    dev.ws.send(JSON.stringify({ type: "update", status: "failed", version: "9.0.0", error: "download failed: WebException" }));
    for (let i = 0; i < 50 && (await status(a))?.failures !== 1; i++) await sleep(10);
    expect(await status(a)).toMatchObject({ result: "failed", failures: 1 });
    await expireWindow(a);
    dev = await hello(a, BEHIND, SIGNED);
    expect(updates(dev.frames)).toHaveLength(1);
  });

  it("every release-manifest refusal of PROTOCOL.md 5.1 counts, nothing else does", () => {
    for (const e of [
      "update not signed (no release manifest)",
      "update signature malformed",
      "update signature invalid (not signed by a release key)",
      "update manifest malformed",
      "update manifest key_id does not match its signer",
      "update manifest is for macos",
      "update manifest names the wrong installer",
      "update manifest version does not match the command",
      "update manifest sha256 does not match the command",
      "update not newer than this recorder (downgrade refused)",
      "update needs 0.6.2 or newer installed first",
      "installer size does not match the release manifest",
      "installer sha256 does not match the release manifest",
    ]) expect(signatureRefusal(e), e).toBe(true);
    for (const e of [undefined, "sha256 mismatch", "download failed: WebException", "recording in progress", "an update is already in progress", "update link rejected"]) {
      expect(signatureRefusal(e), String(e)).toBe(false);
    }
  });

  it("autoUpdateReport: a refusal turns a sent push into gave_up in one step", async () => {
    const a = (await seedAccount()) as Rec;
    await runInDurableObject(env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(a.accountId)), async (_i, state) => {
      await state.storage.put(`autoupdate:${a.deviceId}`, { version: "9.0.0", at: 1, result: "sent", attempts: 1, failures: 0, next_at: 9e9 } satisfies AutoUpdateStatus);
      expect(autoUpdateReport(state.storage, a.deviceId, { status: "failed", version: "9.0.0", error: "update needs 0.6.2 or newer installed first" })).toBe(false);
      expect(await state.storage.get(`autoupdate:${a.deviceId}`)).toMatchObject({ result: "gave_up", failures: 1 });
    });
  });
});

describe("0.6.1 recorders (no signed_update): the hash-pinned path, unchanged", () => {
  it("get exactly today's update command, without manifest fields, even when the release is signed", async () => {
    signedWindows();
    const a = (await seedAccount()) as Rec;
    const sent = updates((await hello(a, BEHIND, V061)).frames);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual(
      ["type", "recording_id", "max_seconds", "mic", "nonce", "exp", "account_id", "device_id", "upload_token", "url", "version", "sha256", "mac"].sort(),
    );
    const { mac, ...rest } = sent[0];
    expect(rest).toMatchObject({ version: "9.0.0", sha256: WIN_SHA });
    expect(mac).toBe(await hmacHex(await deviceCommandKey(env, a.deviceId), canonicalCommand(rest)));
  });

  it("still get the update when the platform has no signed release", async () => {
    unsignedWindows();
    const a = (await seedAccount()) as Rec;
    const sent = updates((await hello(a, BEHIND, V061)).frames);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("manifest");
    const r = (await mcp("update_recorder", {}, a.key)).data;
    expect(r).toMatchObject({ action: "update_sent" });
  });
});
