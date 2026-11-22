import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { classifyHost, normalizeHost } from "../src/hosts";
import { withEnv } from "./helpers";

const prod = withEnv({ DEV_MODE: "false", PUBLIC_BASE_URL: "https://example.test" });

describe("classifyHost", () => {
  it("example.test, www., mcp., PUBLIC_BASE_URL's host and workers.dev are ours", () => {
    for (const h of ["example.test", "www.example.test", "mcp.example.test", "my-recorder.example.workers.dev"]) {
      expect(classifyHost(h, prod), h).toBe("ours");
    }
    expect(classifyHost("rec.example.net", withEnv({ DEV_MODE: "false", PUBLIC_BASE_URL: "https://rec.example.net/x" }))).toBe("ours");
  });

  it("normalises case and one trailing dot", () => {
    expect(normalizeHost("Videos.Example.COM.")).toBe("videos.example.com");
    expect(classifyHost("Example.TEST.", prod)).toBe("ours");
    expect(classifyHost("MCP.EXAMPLE.TEST", prod)).toBe("ours");
    expect(classifyHost("Videos.Example.com.", prod)).toBe("customer");
  });

  it("any other *.example.test name is reserved", () => {
    for (const h of ["customers.example.test", "fallback.example.test", "x.mcp.example.test", "anything.example.test."]) {
      expect(classifyHost(h, prod), h).toBe("reserved");
    }
  });

  it("everything else is a customer host, including look-alikes", () => {
    for (const h of ["videos.example.com", "example.test.evil.example.org", "evilexample.test", "recitbot.co", "workers.dev.evil.com", "127.0.0.1", "localhost", "[::1]", "rec.example"]) {
      expect(classifyHost(h, prod), h).toBe("customer");
    }
  });

  it("loopback and the reserved .example TLD are ours only with DEV_MODE on", () => {
    expect(env.DEV_MODE).toBe("true");
    for (const h of ["localhost", "127.0.0.1", "[::1]", "rec.example", "app.example"]) expect(classifyHost(h, env), h).toBe("ours");
    expect(classifyHost("videos.example.com", env)).toBe("customer");
    expect(classifyHost("customers.example.test", env)).toBe("reserved");
  });

  it("an invalid or missing PUBLIC_BASE_URL adds no host", () => {
    expect(classifyHost("javascript", withEnv({ DEV_MODE: "false", PUBLIC_BASE_URL: "javascript:alert(1)" }))).toBe("customer");
    expect(classifyHost("videos.example.com", withEnv({ DEV_MODE: "false", PUBLIC_BASE_URL: undefined }))).toBe("customer");
  });
});
