import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import pkg from "../../package.json?raw";
import { brokenGovernor, callUrl, withEnv } from "./helpers";

const OK = { ok: true, version: "0.1.0", configured: true };
const get = (host: string, e: Env = env, init: RequestInit = {}) => callUrl(`https://${host}/health`, init, e);

describe("GET /health", () => {
  it("answers without sign-in on every host that is ours, uncached", async () => {
    for (const host of ["example.test", "www.example.test", "mcp.example.test", "recitbot.example.workers.dev"]) {
      const res = await get(host);
      expect(res.status, host).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json(), host).toEqual(OK);
    }
    const head = await get("example.test", env, { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    expect((await get("example.test", env, { method: "POST" })).status).toBe(405);
  });

  it("on no other host: reserved names and customer hosts answer as for any unknown path", async () => {
    const t = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO custom_domains (id, account_id, hostname, status, created_at, updated_at) VALUES ('h', 'a', 'videos.example.com', 'active', ?, ?)").bind(t, t).run();
    for (const host of ["other.example.test", "videos.example.com", "unknown.example.com"]) {
      const res = await get(host);
      expect(res.status, host).toBe(404);
      expect(await res.text(), host).not.toContain("version");
    }
  });

  it("works whatever the service mode, and touches neither D1 nor a Durable Object", async () => {
    const boom = new Proxy({}, { get: () => () => { throw new Error("touched"); } });
    for (const SERVICE_MODE of ["ON", "READ_ONLY", "OFF"]) {
      const e = withEnv({ SERVICE_MODE, DB: boom as Env["DB"], GOVERNOR: brokenGovernor, MEDIA: boom as Env["MEDIA"] });
      const res = await get("example.test", e, { headers: { "cf-ipcountry": "DE" } });
      expect(res.status, SERVICE_MODE).toBe(200);
      expect(await res.json()).toEqual(OK);
    }
  });

  it("with configuration errors: ok false and the names only, never a value", async () => {
    const e = withEnv({ SHARE_HMAC_KEY: "", DEVICE_CMD_KEY: "", SUPPORT_EMAIL: "not-an-address-value", BLOCKED_COUNTRIES: "XYZVALUE" });
    const res = await get("example.test", e);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, version: "0.1.0", configured: false, errors: ["SHARE_HMAC_KEY", "DEVICE_CMD_KEY", "SUPPORT_EMAIL", "BLOCKED_COUNTRIES"] });
    expect(text).not.toMatch(/not-an-address|XYZVALUE/);
    // Every other path still gets the readable 500.
    expect(await (await callUrl("https://example.test/", {}, e)).text()).toContain("This server is not configured correctly.");
    expect((await callUrl("https://other.example.test/health", {}, e)).headers.get("content-type")).toContain("text/plain");
  });

  it("the version is package.json's", () => {
    expect((JSON.parse(pkg) as { version: string }).version).toBe(OK.version);
  });
});
