import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { canonicalCommand } from "../src/device-hub";
import { LIMITS } from "../src/env";
import { hmacHex, log, randomId, redact, safeEqual, sha256Hex } from "../src/util";
import { call, freshIp, mcp, seedAccount, withEnv } from "./helpers";

describe("secrets never reach logs", () => {
  it("redacts keys, tokens, auth headers, URL keys and token query strings", () => {
    const key = `ark_${randomId(64)}_${randomId(256)}`;
    const dev = `ardt_${randomId(128)}_${randomId(256)}`;
    const line = redact(
      `authorization: Bearer ${key} GET /mcp/k/${key} /v/abc?e=123&s=SIGNATURE&o=OWNERMARK /x?token=T0K {"api_key":"${key}","device_token":"${dev}","code":"PAIRCODE123"}`,
    );
    expect(line).not.toContain(key);
    expect(line).not.toContain(dev);
    expect(line).not.toContain("SIGNATURE");
    expect(line).not.toContain("OWNERMARK");
    expect(line).not.toContain("T0K");
    expect(line).not.toContain("PAIRCODE123");
    expect(line).toContain("[REDACTED]");
    expect(redact("GET /alex/v/Ab12Cd34Ef56Gh /m/Ab12Cd34Ef56Gh")).toBe("GET /alex/v/[REDACTED] /m/[REDACTED]");
  });

  it("request logging never prints the URL key or share signature", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const key = `ark_${randomId(64)}_${randomId(256)}`;
    await call(`/mcp/k/${key}`, { method: "POST", body: "{}" });
    await call(`/v/${randomId(128)}?e=1&s=SECRETSIG`);
    log("info", "x", { authorization: `Bearer ${key}` });
    const all = spy.mock.calls.flat().join("\n");
    spy.mockRestore();
    expect(all).toContain("/mcp/k/[REDACTED]");
    expect(all).not.toContain(key);
    expect(all).not.toContain("SECRETSIG");
  });
});

describe("crypto helpers", () => {
  it("safeEqual is exact", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("ids are 128-bit base62", () => {
    expect(randomId(128)).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(randomId(256)).toHaveLength(43);
  });
  it("command canonical form matches the recorder's selftest vector", async () => {
    const canon = canonicalCommand({
      type: "start",
      recording_id: "AAAAAAAAAAAAAAAAAAAAAA",
      max_seconds: 30,
      mic: false,
      nonce: 1731650000000,
      exp: 1731650060,
      account_id: "BBBBBBBBBBBBBBBBBBBBBB",
      device_id: "CCCCCCCCCCCCCCCCCCCCCC",
      upload_token: "1731651800.tok",
    });
    expect(await hmacHex("test-device-secret", canon)).toBe("91b21b4b501c2352952e2591e8c7d738ae9d653f27672744673c47e824d1adfc");
  });
  it("webcam fields are signed and match the recorder's selftest vector", async () => {
    const base = {
      type: "start",
      recording_id: "AAAAAAAAAAAAAAAAAAAAAA",
      max_seconds: 30,
      mic: false,
      nonce: 1731650000000,
      exp: 1731650060,
      account_id: "BBBBBBBBBBBBBBBBBBBBBB",
      device_id: "CCCCCCCCCCCCCCCCCCCCCC",
      upload_token: "1731651800.tok",
    };
    const canon = canonicalCommand({ ...base, webcam: true, camera: "Full HD webcam", webcam_size: "large" });
    expect(canon.endsWith("|cam|1|Full HD webcam|large")).toBe(true);
    expect(await hmacHex("test-device-secret", canon)).toBe("21d8fbbc60cf22ee8ddb9d83b5cf0664f021b7e099c36cd17384af0974311809");
    // Each webcam field changes the signature, including an explicit webcam:false.
    const forms = new Set([
      canonicalCommand(base),
      canonicalCommand({ ...base, webcam: false }),
      canonicalCommand({ ...base, webcam: true }),
      canonicalCommand({ ...base, webcam_size: "small" }),
      canonicalCommand({ ...base, camera: "Other cam" }),
    ]);
    expect(forms.size).toBe(5);
  });
});

describe("API keys", () => {
  it("API keys are stored only as a hash", async () => {
    const { key } = await seedAccount(false);
    expect(key).toMatch(/^ark_[A-Za-z0-9]+_[A-Za-z0-9]{43}$/);
    const id = key.split("_")[1];
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(row!.key_hash).toBe(await sha256Hex(key));
    expect(JSON.stringify(row)).not.toContain(key.split("_")[2]);
    expect((await mcp("device_status", {}, key)).data).toMatchObject({ paired: false, online: false });
  });

  it("rejects bad keys with 401 and backs off after repeated failures", async () => {
    const ip = freshIp();
    const bad = `ark_${randomId(64)}_${randomId(256)}`;
    for (let i = 0; i < 10; i++) expect((await mcp("list", {}, bad, env, { "cf-connecting-ip": ip })).status).toBe(401);
    expect((await mcp("list", {}, bad, env, { "cf-connecting-ip": ip })).status).toBe(429);
  });

  it("rate limits MCP calls per key (60/min)", async () => {
    const { key } = await seedAccount();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await mcp("list", {}, key)).status;
    expect(last).toBe(429);
  });

  it("rotate_key issues a new key and revokes the old one", async () => {
    const { key } = await seedAccount();
    const r = await mcp("rotate_key", {}, key);
    expect(r.data.revoked_previous).toBe(true);
    expect((await mcp("list", {}, key)).status).toBe(401);
    expect((await mcp("list", {}, r.data.api_key)).isError).toBe(false);
  });

  it("key-in-URL is off by default and works only when ALLOW_URL_KEY=true", async () => {
    const { key } = await seedAccount();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list", arguments: {} } });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body };
    expect((await call(`/mcp/k/${key}`, init)).status).toBe(404);
    const on = await call(`/mcp/k/${key}`, init, withEnv({ ALLOW_URL_KEY: "true" }));
    expect(on.status).toBe(200);
    expect(((await on.json()) as any).result.isError).toBe(false);
  });

  it("tools require auth; inputs are validated", async () => {
    expect((await mcp("list")).status).toBe(401);
    const { key } = await seedAccount();
    expect((await mcp("get_video", { recording_id: "../etc" }, key)).data.error).toBe("INVALID_ARGUMENTS");
    expect((await mcp("start_recording", { max_seconds: LIMITS.recordingCeilingSeconds + 1 }, key)).data.error).toBe("INVALID_ARGUMENTS");
    expect((await mcp("start_recording", { max_seconds: 999 }, key)).data.error).toBe("LIMIT_EXCEEDED");
  });

  it("cross-origin /mcp gets the Origin echoed (bearer-only), never a wildcard or credentials", async () => {
    const res = await call("/mcp", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://evil.example");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("lists exactly the v1 tools (plus view stats)", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = ((await res.json()) as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      [
        "account_info",
        "add_storage",
        "billing",
        "cancel_subscription",
        "confirm_email_change",
        "delete",
        "delete_comment",
        "device_status",
        "get_installer",
        "get_latest",
        "get_branding",
        "get_custom_domain_status",
        "get_plan",
        "get_recording_for_skill",
        "get_transcript",
        "get_video",
        "get_video_stats",
        "list",
        "list_comments",
        "list_devices",
        "list_videos",
        "remove_custom_domain",
        "remove_device",
        "request_email_change",
        "revoke_share",
        "rotate_key",
        "search_videos",
        "set_branding",
        "set_custom_domain",
        "set_username",
        "share",
        "share_recording",
        "start_recording",
        "stop_recording",
        "uninstall_recorder",
        "update_recorder",
        "upgrade",
        "update_video",
      ].sort(),
    );
  });
});

describe("pairing", () => {
  const enroll = (code: string) =>
    call("/device/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "pc" }) });

  it("installer one-liner pins the install.ps1 hash; pairing code is single use; token hashed", async () => {
    const { key } = await seedAccount(false);
    const r = await mcp("get_installer", { platform: "windows" }, key);
    expect(r.data.powershell).toContain(r.data.install_ps1_sha256);
    expect(r.data.powershell).not.toMatch(/\|\s*iex/i);
    const first = await enroll(r.data.pairing_code);
    expect(first.status).toBe(200);
    const dev = (await first.json()) as any;
    expect(dev.device_token).toMatch(/^ardt_/);
    expect((await enroll(r.data.pairing_code)).status).toBe(401);
    const row = await env.DB.prepare("SELECT token_hash FROM devices WHERE id = ?").bind(dev.device_id).first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(dev.device_token));
    const code = await env.DB.prepare("SELECT code_hash FROM pairing_codes WHERE code_hash = ?")
      .bind(await sha256Hex(r.data.pairing_code))
      .first();
    expect(code).not.toBeNull();
  });

  it("expired pairing codes are rejected", async () => {
    const { key } = await seedAccount(false);
    const r = await mcp("get_installer", { platform: "windows" }, key);
    await env.DB.prepare("UPDATE pairing_codes SET expires_at = 0").run();
    expect((await enroll(r.data.pairing_code)).status).toBe(401);
  });

  it("served install.ps1 matches the pinned hash", async () => {
    const { INSTALL_PS1_SHA256 } = await import("../src/generated");
    const res = await env.ASSETS.fetch("https://rec.example/install.ps1");
    const buf = await res.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hash.toUpperCase()).toBe(INSTALL_PS1_SHA256);
  });
});
