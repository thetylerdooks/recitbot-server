import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EU_EEA_UK } from "../src/config";
import { isBlockedCountry } from "../src/geo";
import worker from "../src/index";
import { homeEnv, PITCH } from "./home-fixture";
import { call, freshIp, mcp, ORIGIN, seedAccount, seedReady, videoLinkOf } from "./helpers";

const MSG = "Recitbot isn't available in your region.";
const INIT = { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-06-18" } };
const rpc = (h: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...h },
  body: JSON.stringify(INIT),
});
const PATHS: [string, (h?: Record<string, string>) => RequestInit][] = [
  ["/mcp", rpc],
  ["/oauth/authorize", (h) => ({ headers: h })],
  ["/.well-known/oauth-authorization-server", (h) => ({ headers: h })],
  ["/install.ps1", (h) => ({ headers: h })],
];

async function viaCf(path: string, cf: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", freshIp());
  const req = new Request(ORIGIN + path, { ...init, headers, cf } as RequestInit);
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function expect451(res: Response, type: string): Promise<string> {
  expect(res.status).toBe(451);
  expect(res.headers.get("vary")).toBe("CF-IPCountry");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-type")).toBe(type);
  const body = await res.text();
  expect(body).toContain(MSG);
  return body;
}

describe("country list", () => {
  it("locks EU 27 + EEA + UK", () => {
    // The test config sets BLOCKED_COUNTRIES=EU_EEA_UK; a deployment without it blocks nobody.
    expect(new Set(EU_EEA_UK).size).toBe(31);
    for (const c of ["DE", "GB", "NO", "IS", "LI", "FR", "IE"]) expect(isBlockedCountry(env, c)).toBe(true);
    for (const c of ["US", "CA", "CH", "XX", "T1", "", null, undefined]) expect(isBlockedCountry(env, c)).toBe(false);
    expect(isBlockedCountry(env, " de ")).toBe(true);
    const open = { ...env, BLOCKED_COUNTRIES: undefined };
    for (const c of ["DE", "GB", "US"]) expect(isBlockedCountry(open, c)).toBe(false);
    expect(isBlockedCountry({ ...env, BLOCKED_COUNTRIES: "us, ca" }, "CA")).toBe(true);
  });
});

describe("geo gate", () => {
  for (const country of ["DE", "GB", "NO"]) {
    it(`blocks gated paths from ${country}`, async () => {
      for (const [p, init] of PATHS) {
        const res = await call(p, init({ "cf-ipcountry": country }));
        await expect451(res, p === "/mcp" ? "application/json" : "text/plain; charset=utf-8");
      }
    });
  }

  for (const country of ["CA", "US"]) {
    it(`allows gated paths from ${country}`, async () => {
      for (const [p, init] of PATHS) expect((await call(p, init({ "cf-ipcountry": country }))).status).not.toBe(451);
      const res = await call("/mcp", rpc({ "cf-ipcountry": country }));
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).result.serverInfo).toBeTruthy();
      const { key } = await seedAccount(false);
      expect((await mcp("list_videos", {}, key, env, { "cf-ipcountry": country })).isError).toBe(false);
    });
  }

  it("allows unknown countries", async () => {
    for (const h of [{}, { "cf-ipcountry": "" } as Record<string, string>, { "cf-ipcountry": "XX" }, { "cf-ipcountry": "T1" }]) {
      expect((await call("/mcp", rpc(h))).status).toBe(200);
      expect((await call("/install.ps1", { headers: h })).status).not.toBe(451);
    }
  });

  it("blocks /mcp/k/ and tool calls over MCP", async () => {
    await expect451(await call("/mcp/k/abc", rpc({ "cf-ipcountry": "FR" })), "application/json");
    const { key } = await seedAccount(false);
    expect((await mcp("list_videos", {}, key, env, { "cf-ipcountry": "DE" })).status).toBe(451);
  });

  it("prefers request.cf.country, falls back to the header", async () => {
    await expect451(await viaCf("/install.ps1", { country: "DE" }), "text/plain; charset=utf-8");
    await expect451(await viaCf("/install.ps1", { country: "DE" }, { headers: { "cf-ipcountry": "US" } }), "text/plain; charset=utf-8");
    expect((await viaCf("/install.ps1", { country: "US" }, { headers: { "cf-ipcountry": "DE" } })).status).not.toBe(451);
    await expect451(await call("/install.ps1", { headers: { "cf-ipcountry": "gb" } }), "text/plain; charset=utf-8");
  });

  it("negotiates HTML, JSON-RPC, and text", async () => {
    const html = await expect451(
      await call("/oauth/authorize", { headers: { "cf-ipcountry": "DE", accept: "text/html,application/xhtml+xml" } }),
      "text/html; charset=utf-8",
    );
    expect(html).toContain(`<p>${MSG}</p>`);
    const j = JSON.parse(await expect451(await call("/mcp", rpc({ "cf-ipcountry": "DE", accept: "text/html, application/json" })), "application/json"));
    expect(j).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: MSG } });
    expect(await expect451(await call("/install.ps1", { headers: { "cf-ipcountry": "DE" } }), "text/plain; charset=utf-8")).toBe(MSG);
  });

  it("names the deployment's BRAND_NAME, escaped in the page", async () => {
    const e = { ...env, BRAND_NAME: "Acme <Video>" };
    const de = { "cf-ipcountry": "DE" };
    expect(await (await call("/install.ps1", { headers: de }, e)).text()).toBe("Acme <Video> isn't available in your region.");
    const html = await (await call("/oauth/authorize", { headers: { ...de, accept: "text/html" } }, e)).text();
    expect(html).toContain("<title>Acme &lt;Video&gt;</title></head><body><p>Acme &lt;Video&gt; isn't available in your region.</p>");
    expect(await (await call("/mcp", rpc(de), e)).json()).toMatchObject({ error: { message: "Acme <Video> isn't available in your region." } });
  });

  it("matches only the gated paths", async () => {
    for (const p of ["/oauth", "/.well-known", "/uninstall.ps1", "/recorder.zip", "/i/tok"]) {
      await expect451(await call(p, { headers: { "cf-ipcountry": "DE" } }), "text/plain; charset=utf-8");
    }
    for (const p of ["/mcpx", "/oauthx", "/install.ps1x", "/i", "/s/recitbot.css"]) {
      expect((await call(p, { headers: { "cf-ipcountry": "DE" } })).status).not.toBe(451);
    }
  });

  it("leaves share pages alone; the homepage swaps in its own region notice", async () => {
    const de = { "cf-ipcountry": "DE" };
    const home = await call("/", { headers: { ...de, accept: "text/html" } }, homeEnv());
    expect(home.status).toBe(451);
    expect(await home.text()).not.toContain(PITCH);
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    await mcp("share", { recording_id: id }, key);
    const link = await videoLinkOf(id);
    const view = await call(link.slice(ORIGIN.length), { headers: { ...de, accept: "text/html" } });
    expect(view.status).toBe(200);
    const cookie = /mt=([^;]+)/.exec(view.headers.get("set-cookie") ?? "")![0];
    const media = await call(`/m/${link.split("/").pop()}`, { headers: { ...de, cookie } });
    expect(media.status).toBe(200);
    expect((await media.arrayBuffer()).byteLength).toBe(4096);
  });
});
