// The self-host default: no BRAND_NAME (and no billing). Nothing a viewer or a person signing in sees names the product,
// shows its logo or icons, or links to it. outputs.ts renders every page and email; golden.test.ts is the branded twin.
// Model-facing tool text may name the product: those outputs are left out (MODEL).
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import type { Env } from "../src/env";
import { tierLimits } from "../src/env";
import { sendEmail } from "../src/oauth/email";
import { collect } from "./outputs";
import { call, callUrl, withEnv } from "./helpers";
import shareSource from "../src/share.ts?raw";
import pagesSource from "../src/oauth/pages.ts?raw";

const NAME = /rec\s*it\s*bot/i;
const LOGO = /lockup|favicon|apple-touch-icon|og-card|\/s\/icon\.svg|class="(?:wm|mark|brand)"|rel="icon"/i;
const BRAND_TEXT = /Powered by|Made with|Recorded with|Shared privately with|og:site_name|twitter:site|application-name/i;
/** For the bot, not a page. */
const MODEL = /^(?:mcp|tool|discovery|enroll|asset):? ?/;
/** The customer's own brand on the customer's own host. */
const OWN_BRAND = /^custom host/;

const OFF: Partial<Env> = {
  BRAND_NAME: undefined,
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  STRIPE_PRO_PRICE_ID: undefined,
  STRIPE_PRO_YEARLY_PRICE_ID: undefined,
  STRIPE_TEAMS_PRICE_ID: undefined,
  STRIPE_TEAMS_YEARLY_PRICE_ID: undefined,
  STRIPE_PORTAL_CONFIG_ID: undefined,
};

let out: Record<string, string>;
beforeAll(async () => {
  out = await collect(OFF);
}, 120_000);

describe("no BRAND_NAME", () => {
  it("every page and email: no product name", () => {
    const pages = Object.entries(out).filter(([name]) => !MODEL.test(name));
    expect(pages.length).toBeGreaterThan(45);
    for (const part of ["watch: public", "watch: owner, private", "watch: not found", "watch: removed", "sign-in: web", "sign-in: consent", "sign-out: page", "email: sign-in", "email: changed notice", "report: plain", "geo: html", "custom host: branded"]) {
      expect(pages.map(([n]) => n)).toContain(part);
    }
    for (const [name, text] of pages) expect({ name, hits: text.match(new RegExp(NAME, "gi")) ?? [] }).toEqual({ name, hits: [] });
  });

  it("no logo, icon, preview card, watermark, 'powered by' or site name, and no dangling separators", () => {
    for (const [name, text] of Object.entries(out)) {
      if (MODEL.test(name)) continue;
      if (!OWN_BRAND.test(name)) {
        const html = text.replace(/<style>[\s\S]*?<\/style>/g, "");
        expect({ name, hit: LOGO.exec(html)?.[0] ?? null }).toEqual({ name, hit: null });
        expect({ name, hit: BRAND_TEXT.exec(html)?.[0] ?? null }).toEqual({ name, hit: null });
      }
      expect(text, name).not.toMatch(/Powered by|Made with/);
      const title = /<title>([^<]*)<\/title>/.exec(text)?.[1];
      if (title !== undefined) expect(title, name).toMatch(/^\S(?:.*[^\s·|-])?$/);
      if (name !== "geo: mcp") expect(text, name).not.toMatch(/\bundefined\b|\bnull\b|  ·|· <|with <\/|your  |content=" |>\s*·/);
    }
  });

  it("the pages still say what they are for", () => {
    expect(out["watch: public"]).toContain("<title>Q3 walkthrough</title>");
    expect(out["watch: public, untitled, no transcript"]).toContain("<title>Screen recording</title>");
    expect(out["watch: owner, untitled"]).toContain('data-default="Screen recording"');
    expect(out["watch: public"]).toContain('content="A screen recording, with a timestamped transcript.');
    expect(out["watch: public"]).toContain('<meta name="twitter:card" content="summary">');
    expect(out["watch: public"]).not.toContain("og:image");
    expect(out["watch: not found"]).toContain("This video is private or doesn&#39;t exist.");
    expect(out["sign-in: web"]).toContain("<h1>What&#39;s your email?</h1>");
    expect(out["sign-in: consent"]).toContain("wants to use your account <strong>golden-new@example.com</strong>");
    expect(out["email: sign-in"]).toContain('"subject":"Your code: 482915"');
    expect(out["geo: html"]).toContain("This service isn't available in your region.");
    expect(out["geo: text"]).toContain("This service isn't available in your region.");
    expect(out["report: plain"]).toContain("<title>Report a video page</title>");
    expect(out["custom host: branded"]).toContain('<footer class="pwr"><a href="https://example.test/report');
    expect(out["custom host: branded"]).toContain("Acme");
    expect(out["download: untitled"]).toContain('filename="screen-recording.mp4"');
  });

  it("the watermark flag alone never draws one", () => {
    expect(tierLimits("free").watermark).toBe(true);
    expect(out["watch: public"]).not.toMatch(/id="wm"/);
  });

  it("the styles and scripts it loads are the neutral copies, and those name nothing", async () => {
    const e = withEnv(OFF);
    const paths = [...new Set([...out["watch: owner, public"].matchAll(/(?:href|src)="(\/s\/[^"?]+)/g)].map((m) => m[1]))];
    expect(paths).toEqual(expect.arrayContaining(["/s/plain/watch.css", "/s/plain/player.js", "/s/plain/meta.js", "/s/plain/comments.js"]));
    for (const p of paths) {
      const res = await call(p, {}, e);
      expect(res.status, p).toBe(200);
      const text = await res.text();
      if (/\.(?:css|js)$/.test(p)) expect(text, p).not.toMatch(NAME);
    }
    const css = await (await call("/s/plain/watch.css", {}, e)).text();
    for (const m of css.matchAll(/url\(([^)]+)\)/g)) expect((await call(new URL(m[1], "https://x.test/s/plain/").pathname, {}, e)).status, m[1]).toBe(200);
  });

  it("the product's icon and logo files are 404 on our hosts (200 with a brand)", async () => {
    for (const p of ["/favicon.ico", "/apple-touch-icon.png", "/s/favicon.ico", "/s/favicon.svg", "/s/icon.svg", "/s/apple-touch-icon.png", "/s/og-card.png", "/s/recitbot-lockup.svg"]) {
      expect((await call(p, {}, withEnv(OFF))).status, p).toBe(404);
      expect((await call(p)).status, p).toBe(200);
    }
    expect((await callUrl("https://golden.example.com/s/icon.svg", {}, withEnv(OFF))).status).toBe(404);
  });

  it("config, OAuth discovery and the email sender carry no name", async () => {
    const e = withEnv(OFF);
    expect(getConfig(e).site.brandName).toBeNull();
    expect(getConfig(withEnv({ BRAND_NAME: "  " })).site.brandName).toBeNull();
    expect(out["discovery: /.well-known/oauth-protected-resource"]).not.toContain("resource_name");
    const sent: any[] = [];
    const mail = { ...e, EMAIL: { send: async (m: unknown) => void sent.push(m) } as unknown as SendEmail } as Env;
    expect(await sendEmail(mail, "a@example.com", { subject: "s", text: "t", html: "h" }, "test")).toBe("sent");
    expect(sent[0].from).toBe("hello@example.test");
    expect(env.BRAND_NAME).toBe("Recitbot");
  });
});

// A new page that names the product outright, instead of asking for the brand, fails here before anyone renders it.
it("templates mention the product only next to a brand check", () => {
  for (const [file, src] of [["share.ts", shareSource], ["pages.ts", pagesSource]]) {
    src.split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, "");
      if (!/Recitbot/.test(code)) return;
      expect(/brand|EMAIL_HEADING|aria-label="Made with|<span>Recitbot<\/span>|og:image:alt|\? " ?(?:Recitbot|shared)/i.test(code), `${file}:${i + 1} ${code.trim().slice(0, 120)}`).toBe(true);
    });
  }
});
