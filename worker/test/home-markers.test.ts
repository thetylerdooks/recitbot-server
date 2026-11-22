// The homepage's operator values: {{MARKERS}} in the pages (home-fixture.ts here), filled in from the config on every serve
// (src/home.ts), and put back by the sync from the home repo (scripts/home-markers.mjs).
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { homeValues, parseJsonc, toMarkers } from "../../scripts/home-markers.mjs";
import { getConfig } from "../src/config";
import { fillMarkers, isPagePath } from "../src/home";
import testConfig from "../wrangler.test.jsonc?raw";
import { homeAssets, homeEnv, PAGES } from "./home-fixture";
import { call } from "./helpers";

vi.mock("../src/generated-home", () => ({
  HOME_FILES: new Set(["/index.html", "/eu/index.html", "/terms/index.html", "/privacy/index.html", "/lockup.svg"]),
}));

const on = homeEnv();
const values = getConfig(env).site.homeValues!;

describe("homepage markers", () => {
  it("the served pages carry this deployment's values, escaped, and no marker", async () => {
    for (const p of ["/", "/terms/", "/privacy/", "/eu/"]) {
      const res = await call(p, {}, on);
      expect(res.status, p).toBe(200);
      const html = await res.text();
      expect(html, p).not.toContain("{{");
      expect(html, p).toContain('Built by <a href="https://operator.example.test" rel="noopener">Example Operator</a>');
      expect(html, p).toContain("Example &amp; Sons Ltd.</p>");
    }
    const privacyHtml = await (await call("/privacy/", {}, on)).text();
    expect(privacyHtml).toContain('<a href="mailto:hello@example.test">hello@example.test</a>');
    expect(privacyHtml).toContain('card statement as "EXAMPLE* VIDEO"');
    const home = await (await call("/", {}, on)).text();
    expect(home).toContain('href="https://bots.example.test/add/recorder"');
    expect(home).toContain("example.test/alex/v/k7Qm2xR4");
  });

  it("the region notice is filled in too", async () => {
    const res = await call("/", { headers: { "cf-ipcountry": "DE" } }, on);
    expect(res.status).toBe(451);
    const html = await res.text();
    expect(html).not.toContain("{{");
    expect(html).toContain("Example Operator");
  });

  it("never a 304 or a part of the marker file: no validators out, conditional and range headers ignored; HEAD has no body", async () => {
    for (const p of ["/", "/terms/"]) {
      const asset = await homeAssets.fetch(`https://rec.example${p}`);
      const etag = asset.headers.get("etag")!;
      await asset.body?.cancel();
      const res = await call(p, { headers: { "if-none-match": etag, range: "bytes=0-99" } }, on);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("etag"), p).toBeNull();
      expect(await res.text(), p).toContain("</html>");
      const head = await call(p, { method: "HEAD" }, on);
      expect(head.status, p).toBe(200);
      expect(await head.text(), p).toBe("");
    }
  });

  it("pages are found by path shape; other static files keep their validators", async () => {
    for (const p of ["/terms", "/terms/", "/index.html", "/a/b", "/terms/index%2ehtml"]) expect(isPagePath(p), p).toBe(true);
    for (const p of ["/s/player.js", "/favicon.ico", "/fonts/inter400.woff2"]) expect(isPagePath(p), p).toBe(false);
    const css = await call("/s/recitbot.css");
    expect(css.headers.get("etag")).toBeTruthy();
    await css.body?.cancel();
  });

  it("homepage off: no page comes out under another spelling of its path either", async () => {
    const off = homeEnv({ HOME_SITE_ENABLED: "false" });
    for (const p of ["/%74erms/", "/terms/index%2ehtml", "/%69ndex"]) {
      const res = await call(p, { redirect: "manual" }, off);
      expect(await res.text(), p).not.toContain("<html");
    }
  });

  it("fillMarkers escapes values and leaves unknown markers alone", () => {
    const html = fillMarkers('<a href="{{OPERATOR_URL}}">{{OPERATOR_NAME}}</a>{{NOPE}}', { ...values, OPERATOR_NAME: '<b>"x"' });
    expect(html).toBe('<a href="https://operator.example.test">&lt;b&gt;&quot;x&quot;</a>{{NOPE}}');
  });
});

describe("sync from the home repo (scripts/home-markers.mjs)", () => {
  it("reads the same values from the config as the Worker", () => {
    const vars = (parseJsonc(testConfig) as { vars: Record<string, unknown> }).vars;
    expect(homeValues(vars)).toEqual(values);
    expect(homeValues({})).toEqual(Object.fromEntries(Object.keys(values).map((k) => [k, null])));
  });

  it("is the inverse of serving: every page survives values in, markers back", () => {
    for (const [name, page] of Object.entries(PAGES)) {
      const served = fillMarkers(page, values);
      expect(served, name).not.toBe(page);
      expect(toMarkers(served, values), name).toBe(page);
    }
  });

  it("every marker in the pages has a value", () => {
    for (const [name, page] of Object.entries(PAGES)) {
      for (const [, k] of page.matchAll(/\{\{([^}]*)\}\}/g)) expect(Object.keys(values), `${name} ${k}`).toContain(k);
    }
  });

  it("parseJsonc: comments, trailing commas, a BOM, and // or , inside strings", () => {
    expect(parseJsonc('﻿// x\n{ "a": "https://x/y", /* b */ "b": ["1,]",], }')).toEqual({ a: "https://x/y", b: ["1,]"] });
  });
});
