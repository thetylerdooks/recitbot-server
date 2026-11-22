import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import HEADERS from "../src/home-headers.json";
import type { Env } from "../src/env";
import wranglerConfig from "../wrangler.example.jsonc?raw";
import testConfig from "../wrangler.test.jsonc?raw";
import { homeEnv, noHomeAssets, PITCH } from "./home-fixture";
import { callUrl, mcp, seedAccount, seedReady, videoLinkOf, withEnv } from "./helpers";

vi.mock("../src/generated-home", () => ({
  HOME_FILES: new Set(["/index.html", "/eu/index.html", "/terms/index.html", "/privacy/index.html", "/lockup.svg"]),
}));

const recit = withEnv({ PUBLIC_BASE_URL: "https://example.test" });
const site = (url: string, init: RequestInit = {}, e: Env = homeEnv()) => callUrl(url, init, e);

const expectHomeHeaders = (res: Response) => {
  for (const [k, v] of Object.entries(HEADERS)) expect(res.headers.get(k), k).toBe(v);
};

describe("homepage", () => {
  it("example.test/ is the static homepage, with the security headers", async () => {
    const res = await site("https://example.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expectHomeHeaders(res);
    expect(await res.text()).toContain(PITCH);
    const head = await site("https://example.test/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expectHomeHeaders(head);
  });

  it("mcp.example.test/ never serves it; MCP still answers there", async () => {
    const res = await site("https://mcp.example.test/", { headers: { accept: "text/html" } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(PITCH);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const m = await site("https://mcp.example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://mcp.example.test" },
      body,
    });
    expect(m.status).toBe(200);
  });

  it("only GET and HEAD", async () => {
    const res = await site("https://example.test/", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("EU/EEA/UK visitors get the /eu/ notice with 451, not the front page", async () => {
    const res = await site("https://example.test/", { headers: { "cf-ipcountry": "DE", "if-none-match": '"home-fixture"' } });
    expect(res.status).toBe(451);
    expectHomeHeaders(res);
    expect(res.headers.get("etag")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Not available in your region");
    expect(html).not.toContain(PITCH);
  });

  it("built without worker/home: / and its pages are the Worker's JSON 404, even with HOME_SITE_ENABLED", async () => {
    const none = withEnv({ ASSETS: noHomeAssets });
    const cases: [string, Record<string, string>][] = [["/", {}], ["/", { "cf-ipcountry": "DE" }], ["/terms/", {}], ["/privacy/", {}], ["/eu/", {}]];
    for (const [p, headers] of cases) {
      const res = await site(`https://example.test${p}`, { headers }, none);
      expect(res.status, p).toBe(404);
      expect(await res.json(), p).toEqual({ error: "not found" });
    }
    expect((await site("https://example.test/s/player.js", {}, none)).status).toBe(200);
  });

  it("every path runs the Worker first in every environment, so the host can decide (host gate)", () => {
    const values = [...wranglerConfig.matchAll(/"run_worker_first": ([^ ,}]+)/g)].map((m) => m[1]);
    expect(values).toEqual(["true", "true"]);
    expect([...testConfig.matchAll(/"run_worker_first": ([^ ,}]+)/g)].map((m) => m[1])).toEqual(["true"]);
  });

  it("the homepage's static pages and files still come out of the Worker on example.test", async () => {
    for (const p of ["/terms/", "/privacy/"]) {
      const res = await site(`https://example.test${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("content-type"), p).toMatch(/text\/html/);
      expect(await res.text(), p).toContain('href="/#pricing"');
    }
    expect((await site("https://example.test/lockup.svg")).status).toBe(200);
    expect((await site("https://example.test/s/player.js")).status).toBe(200);
    expect((await site("https://example.test/favicon.ico", { method: "HEAD" })).status).toBe(200);
    // Not a file and not a route: still the Worker's JSON 404; other methods never reach the asset server.
    expect((await site("https://example.test/terms/", { method: "POST" })).status).toBe(404);
  });

  it("the favicons and share page files are there whether or not a homepage is", async () => {
    for (const p of ["/favicon.ico", "/apple-touch-icon.png", "/s/recitbot.css"]) {
      const res = await env.ASSETS.fetch(`https://example.test${p}`);
      expect(res.status, p).toBe(200);
      await res.body?.cancel();
    }
  });

  it("a watch page still comes from the Worker", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    expect((await mcp("share", { recording_id: id }, key, recit)).isError).toBe(false);
    const url = new URL(await videoLinkOf(id, "https://example.test", recit));
    expect(url.pathname).toMatch(/^\/[A-Za-z0-9-]+\/v\/[A-Za-z0-9]+$/);
    const res = await site(url.href, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:site_name" content="Recitbot">');
    expect(html).not.toContain(PITCH);
  });

  it("/install.ps1 still goes through the Worker first (geo gate), then the asset", async () => {
    expect((await site("https://example.test/install.ps1", { headers: { "cf-ipcountry": "DE" } })).status).toBe(451);
    const ok = await site("https://example.test/install.ps1", { headers: { "cf-ipcountry": "US" } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain(PITCH);
  });

  it("unknown paths are still the Worker's 404", async () => {
    const res = await site("https://example.test/no-such-page");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
