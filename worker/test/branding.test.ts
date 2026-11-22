import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brandingDeps,
  checkBrandName,
  checkColors,
  checkImage,
  contrast,
  getBranding,
  linkProblem,
  parseColor,
  sniffImage,
  sweepBrandAssets,
  textColorFor,
} from "../src/branding";
import { now } from "../src/util";
import { call, mcp, ORIGIN, seedAccount, suspendAccount } from "./helpers";

// ---------- tiny real image headers (byte arrays, no decoder needed) ----------

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const asc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pad = (head: number[], size: number, fill = 0) => {
  const b = new Uint8Array(Math.max(size, head.length)).fill(fill);
  b.set(head);
  return b;
};

/** PNG signature + IHDR (w×h, 8-bit RGBA) + IEND, padded to `size` bytes; `fill` makes distinct bytes. */
const png = (w: number, h: number, size = 64, fill = 0) =>
  pad([0x89, ...asc("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...asc("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0], size, fill);

/** JPEG: SOI, an APP0 (JFIF) segment, then a baseline SOF0 frame header with w×h. */
const jpeg = (w: number, h: number, size = 64) =>
  pad(
    [0xff, 0xd8, 0xff, 0xe0, 0, 16, ...asc("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    size,
  );

const riff = (chunk: string, data: number[], size = 64) => pad([...asc("RIFF"), ...le24(size - 8), 0, ...asc("WEBP"), ...asc(chunk), ...le24(data.length), 0, ...data], size);
/** WebP lossy (VP8), lossless (VP8L) and extended (VP8X) headers. */
const webpVp8 = (w: number, h: number) => riff("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const webpVp8l = (w: number, h: number) => {
  const W = w - 1;
  const H = h - 1;
  return riff("VP8L", [0x2f, W & 255, ((W >> 8) & 0x3f) | ((H & 3) << 6), (H >> 2) & 255, (H >> 10) & 0x0f]);
};
const webpVp8x = (w: number, h: number, flags = 0) => riff("VP8X", [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

const GIF = pad(asc("GIF89a"), 64);
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = new TextEncoder().encode("<html><body><script>alert(1)</script></body></html>");

const b64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
};
const img = (b: Uint8Array, content_type = "image/png") => ({ data: b64(b), content_type });

async function account(plan: "free" | "pro" | "teams" | "owner") {
  const a = await seedAccount(false);
  if (plan !== "free") await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, a.accountId).run();
  return a;
}

const assets = async (accountId: string) =>
  (await env.DB.prepare("SELECT hash, kind, r2_key, content_type, width, height FROM brand_assets WHERE account_id = ? ORDER BY created_at").bind(accountId).all<any>())
    .results;

const realFetch = brandingDeps.fetch;
afterEach(() => {
  brandingDeps.fetch = realFetch;
});

// ---------- pure checks ----------

describe("image sniffing", () => {
  it("reads PNG, JPEG and WebP (VP8, VP8L, VP8X) sizes from the headers", () => {
    expect(sniffImage(png(300, 120), "logo")).toMatchObject({ type: "png", contentType: "image/png", width: 300, height: 120 });
    expect(sniffImage(jpeg(640, 480), "logo")).toMatchObject({ type: "jpeg", contentType: "image/jpeg", ext: "jpg", width: 640, height: 480 });
    expect(sniffImage(webpVp8(200, 100), "logo")).toMatchObject({ type: "webp", width: 200, height: 100 });
    expect(sniffImage(webpVp8l(1200, 630), "logo")).toMatchObject({ type: "webp", width: 1200, height: 630 });
    expect(sniffImage(webpVp8x(2048, 77), "logo")).toMatchObject({ type: "webp", width: 2048, height: 77 });
  });

  it("refuses SVG, GIF, HTML posing as PNG, animated WebP and damaged headers", () => {
    expect(() => sniffImage(SVG, "logo")).toThrow(/SVG isn't allowed/);
    expect(() => sniffImage(GIF, "logo")).toThrow(/GIFs aren't supported/);
    expect(() => sniffImage(HTML, "logo")).toThrow(/isn't a PNG, JPEG or WebP/);
    expect(() => sniffImage(webpVp8x(100, 100, 0x02), "logo")).toThrow(/animated/);
    expect(() => sniffImage(pad([0xff, 0xd8, 0xff, 0xd9], 16), "logo")).toThrow(/damaged/);
  });

  it("applies each kind's size, type and dimension limits", () => {
    expect(() => checkImage(png(100, 100, 3.1 * 1024 * 1024), "logo")).toThrow("Your logo is 3.1 MB; the limit is 512 KB.");
    expect(() => checkImage(png(20, 100), "logo")).toThrow(/between 32 and 2048/);
    expect(() => checkImage(png(2049, 100), "logo")).toThrow(/between 32 and 2048/);
    expect(checkImage(png(32, 2048), "logo").width).toBe(32);
    expect(() => checkImage(jpeg(32, 32), "favicon")).toThrow(/favicon must be a PNG/);
    expect(() => checkImage(png(32, 48), "favicon")).toThrow(/must be square/);
    expect(() => checkImage(png(8, 8), "favicon")).toThrow(/between 16×16 and 512×512/);
    expect(() => checkImage(png(32, 32, 101 * 1024), "favicon")).toThrow(/limit is 100 KB/);
    expect(checkImage(png(180, 180), "favicon").width).toBe(180);
    expect(checkImage(jpeg(1200, 630), "og").height).toBe(630);
    expect(() => checkImage(jpeg(500, 262), "og")).toThrow(/at least 600 pixels wide/);
    expect(() => checkImage(jpeg(1200, 900), "og")).toThrow(/1\.91:1/);
    expect(() => checkImage(jpeg(1200, 630, 1024 * 1024 + 1), "og")).toThrow(/limit is 1 MB/);
  });
});

describe("colours and contrast", () => {
  it("parses #RGB and #RRGGBB into lowercase #rrggbb", () => {
    expect(parseColor("#1FA")).toBe("#11ffaa");
    expect(parseColor("#1FA89A")).toBe("#1fa89a");
    expect(parseColor("1fa89a")).toBe("#1fa89a");
    expect(parseColor("teal")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
  });

  it("computes WCAG contrast and picks dark or white text", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(textColorFor("#ffffff")).toBe("#111111");
    expect(textColorFor("#111318")).toBe("#ffffff");
    expect(textColorFor("#777777")).toBeNull();
  });

  it("passes a readable pair and refuses low contrast with the ratio and a suggestion that works", () => {
    expect(checkColors("#1fa89a", "#111318")).toBe("#ffffff");
    let err: any;
    try {
      checkColors("#aaaaaa", "#ffffff");
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("LOW_CONTRAST");
    expect(err.message).toMatch(/contrast of 2\.3:1; it needs at least 3:1/);
    expect(contrast(err.extra.suggestion, "#ffffff")).toBeGreaterThanOrEqual(3);
    let bg: any;
    try {
      checkColors("#000000", "#777777");
    } catch (e) {
      bg = e;
    }
    expect(bg.message).toMatch(/Text can't be read on background #777777/);
    expect(textColorFor(bg.extra.suggestion)).not.toBeNull();
  });
});

describe("brand name", () => {
  it("trims, strips control and bidi characters, keeps the text as given", () => {
    expect(checkBrandName("  Acme\u0000 Studio‮ ")).toBe("Acme Studio");
    expect(checkBrandName("Café & Co.")).toBe("Café & Co.");
    expect(checkBrandName("x".repeat(60))).toHaveLength(60);
  });

  it("refuses empty, too long, < >, links and web addresses", () => {
    for (const bad of ["", "   ", "\u0000", "x".repeat(61), "<b>Acme</b>", "Acme > all", "http://acme", "see https", "www.acme", "acme.com", "Shop at acme.co.uk now", "ａｃｍｅ．ｃｏｍ"]) {
      expect(() => checkBrandName(bad), bad).toThrow();
    }
    expect(() => checkBrandName("acme.com")).toThrow(/link or a web address/);
  });
});

describe("image links", () => {
  it("allows only public https names", () => {
    expect(linkProblem("https://cdn.example.com/logo.png")).toBeNull();
    expect(linkProblem("http://cdn.example.com/logo.png")).toMatch(/Only https/);
    expect(linkProblem("https://user:pw@cdn.example.com/logo.png")).toMatch(/username or password/);
    expect(linkProblem("https://cdn.example.com:8443/logo.png")).toMatch(/normal https port/);
    for (const ip of ["https://127.0.0.1/x.png", "https://10.0.0.5/x.png", "https://2130706433/x.png", "https://0x7f.1/x.png", "https://[::1]/x.png", "https://169.254.169.254/x"]) {
      expect(linkProblem(ip), ip).toMatch(/IP address/);
    }
    for (const h of ["https://localhost/x.png", "https://localhost./x.png", "https://printer.local/x.png", "https://intranet/x.png", "https://api.example.test/x", "https://example.test/b/x"]) {
      expect(linkProblem(h, [], ["example.test"]), h).toMatch(/private or internal/);
    }
    // Our zone (SITE_ZONE / SITE_HOSTNAMES) is only refused when it is passed in: nothing about any deployment is built in.
    expect(linkProblem("https://example.test/b/x")).toBeNull();
    expect(linkProblem("https://rec.example/b/x", ["rec.example"])).toMatch(/Recitbot itself/);
    expect(linkProblem("not a url")).toMatch(/valid link/);
  });
});

// ---------- the tools ----------

describe("set_branding / get_branding", () => {
  it("tools/list has both tools", async () => {
    const res = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const tools = ((await res.json()) as any).result.tools;
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("set_branding");
    expect(names).toContain("get_branding");
    const set = tools.find((t: any) => t.name === "set_branding");
    expect(set.description).toMatch(/base64/);
    expect(set.description).toMatch(/https link/);
  });

  it("Free gets UPGRADE_REQUIRED; get_branding answers empty with the upgrade message", async () => {
    const a = await account("free");
    const r = await mcp("set_branding", { brand_name: "Acme" }, a.key);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("UPGRADE_REQUIRED");
    expect(r.data.message).toBe("Branding is part of Recitbot Pro ($10/mo or $100/yr). Ask me to upgrade to Pro.");
    const g = await mcp("get_branding", {}, a.key);
    expect(g.isError).toBe(false);
    expect(g.data).toMatchObject({
      brand_name: null,
      accent_color: null,
      logo_url: null,
      message: "Branding is part of Recitbot Pro ($10/mo or $100/yr). Ask me to upgrade to Pro.",
    });
  });

  it("Pro, Teams and owner set name, colours and images; get_branding returns them with /b/<hash> URLs", async () => {
    for (const plan of ["pro", "teams", "owner"] as const) {
      const a = await account(plan);
      const r = await mcp(
        "set_branding",
        {
          brand_name: "  Acme Studio ",
          accent_color: "#1FA89A",
          background_color: "#111318",
          logo: img(png(400, 100, 64, 1)),
          favicon: img(png(32, 32, 64, 2)),
          social_image: img(jpeg(1200, 630), "image/png"),
        },
        a.key,
      );
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      expect(r.data).toMatchObject({ brand_name: "Acme Studio", accent_color: "#1fa89a", background_color: "#111318", text_color: "#ffffff" });
      for (const k of ["logo_url", "favicon_url", "social_image_url"]) expect(r.data[k]).toMatch(new RegExp(`^${ORIGIN}/b/[0-9a-f]{64}$`));
      const g = await mcp("get_branding", {}, a.key);
      expect(g.data).toMatchObject({ ...r.data, message: expect.any(String) });
      const rows = await assets(a.accountId);
      expect(rows.map((x: any) => x.kind).sort()).toEqual(["favicon", "logo", "og"]);
      const og = rows.find((x: any) => x.kind === "og");
      // The claimed type is ignored: the bytes are a JPEG.
      expect(og).toMatchObject({ content_type: "image/jpeg", width: 1200, height: 630 });
      expect(og.r2_key).toBe(`brand/${a.accountId}/${og.hash}.jpg`);
      expect(await env.MEDIA.head(og.r2_key)).not.toBeNull();
      const b = await getBranding(env, a.accountId);
      expect(b).toMatchObject({ brand_name: "Acme Studio", text_color: "#ffffff", social_image: { hash: og.hash, content_type: "image/jpeg", width: 1200, height: 630 } });
    }
  });

  it("refused inputs change nothing and explain what to send", async () => {
    const a = await account("teams");
    await mcp("set_branding", { brand_name: "Acme" }, a.key);
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ brand_name: "acme.com", accent_color: "#1fa89a" }, "INVALID_BRAND_NAME", /web address/],
      [{ accent_color: "#aaaaaa", background_color: "#ffffff" }, "LOW_CONTRAST", /2\.3:1/],
      [{ accent_color: "teal" }, "INVALID_COLOR", /#RRGGBB/],
      [{ logo: img(SVG, "image/png") }, "UNSUPPORTED_IMAGE", /SVG/],
      [{ logo: img(GIF) }, "UNSUPPORTED_IMAGE", /GIF/],
      [{ logo: img(HTML, "image/png") }, "UNSUPPORTED_IMAGE", /isn't a PNG/],
      [{ logo: img(png(100, 100, 3.1 * 1024 * 1024)) }, "IMAGE_TOO_LARGE", /Your logo is 3\.1 MB; the limit is 512 KB/],
      [{ favicon: img(png(32, 64)) }, "IMAGE_DIMENSIONS", /square/],
      [{ social_image: img(png(1200, 1200)) }, "IMAGE_DIMENSIONS", /1\.91:1/],
      [{ logo: { data: "!!!not base64!!!" } }, "INVALID_IMAGE_DATA", /base64/],
      [{ brand_name: "New", clear: ["brand_name"] }, "CONFLICTING_ARGUMENTS", /both set and clear/],
      [{ brand_name: "Ok", logo: img(png(100, 100, 64, 3)), favicon: img(GIF) }, "UNSUPPORTED_IMAGE", /GIF/],
    ];
    for (const [args, code, msg] of cases) {
      const r = await mcp("set_branding", args, a.key);
      expect(r.isError, code).toBe(true);
      expect(r.data.error).toBe(code);
      expect(r.data.message).toMatch(msg);
      expect(r.data.message).toMatch(/Nothing was changed\.$/);
    }
    expect((await mcp("get_branding", {}, a.key)).data).toMatchObject({ brand_name: "Acme", accent_color: null, logo_url: null });
    expect(await assets(a.accountId)).toEqual([]);
    expect((await mcp("set_branding", {}, a.key)).data.error).toBe("NOTHING_TO_CHANGE");
  });

  it("a colour set alone is checked against the stored (or default) other one", async () => {
    const a = await account("teams");
    // Default background is the dark watch page: a dark accent fails on it.
    expect((await mcp("set_branding", { accent_color: "#222222" }, a.key)).data.error).toBe("LOW_CONTRAST");
    expect((await mcp("set_branding", { background_color: "#ffffff", accent_color: "#0b5cad" }, a.key)).data.text_color).toBe("#111111");
    expect((await mcp("set_branding", { accent_color: "#eeeeee" }, a.key)).data.error).toBe("LOW_CONTRAST");
    expect((await mcp("set_branding", { accent_color: "#333" }, a.key)).data.accent_color).toBe("#333333");
    const cleared = await mcp("set_branding", { clear: ["colors"] }, a.key);
    expect(cleared.data).toMatchObject({ accent_color: null, background_color: null, text_color: null });
  });

  it("replacing and clearing images deletes the old R2 objects and rows; empty branding drops the row", async () => {
    const a = await account("teams");
    const first = await mcp("set_branding", { logo: img(png(100, 100, 64, 10)), favicon: img(png(32, 32, 64, 11)) }, a.key);
    const rows = await assets(a.accountId);
    const logo1 = rows.find((x: any) => x.kind === "logo");
    const fav1 = rows.find((x: any) => x.kind === "favicon");
    expect(first.data.logo_url).toBe(`${ORIGIN}/b/${logo1.hash}`);
    const second = await mcp("set_branding", { logo: img(png(100, 100, 64, 12)) }, a.key);
    expect(second.data.logo_url).not.toBe(first.data.logo_url);
    expect(second.data.favicon_url).toBe(first.data.favicon_url);
    expect(await env.MEDIA.head(logo1.r2_key)).toBeNull();
    expect((await assets(a.accountId)).map((x: any) => x.hash)).not.toContain(logo1.hash);
    expect(await env.MEDIA.head(fav1.r2_key)).not.toBeNull();

    const logo2 = (await assets(a.accountId)).find((x: any) => x.kind === "logo");
    const cleared = await mcp("set_branding", { clear: ["logo", "favicon"] }, a.key);
    expect(cleared.data).toMatchObject({ logo_url: null, favicon_url: null });
    expect(await env.MEDIA.head(logo2.r2_key)).toBeNull();
    expect(await env.MEDIA.head(fav1.r2_key)).toBeNull();
    expect(await assets(a.accountId)).toEqual([]);
    expect(await env.DB.prepare("SELECT 1 FROM branding WHERE account_id = ?").bind(a.accountId).first()).toBeNull();
    expect(await getBranding(env, a.accountId)).toBeNull();
    expect((await call(new URL(first.data.logo_url).pathname)).status).toBe(404);
  });

  it("identical bytes on two accounts are stored per account; one clearing keeps the other's", async () => {
    const a = await account("teams");
    const b = await account("owner");
    const same = img(png(64, 64, 64, 42));
    const ra = await mcp("set_branding", { logo: same }, a.key);
    const rb = await mcp("set_branding", { logo: same }, b.key);
    expect(ra.data.logo_url).toBe(rb.data.logo_url);
    const [aa] = await assets(a.accountId);
    const [bb] = await assets(b.accountId);
    expect(aa.r2_key).not.toBe(bb.r2_key);
    await mcp("set_branding", { clear: ["logo"] }, a.key);
    expect(await env.MEDIA.head(aa.r2_key)).toBeNull();
    expect(await env.MEDIA.head(bb.r2_key)).not.toBeNull();
    expect((await call(new URL(rb.data.logo_url).pathname)).status).toBe(200);
  });

  it("the hourly sweep deletes unused brand images once they're an hour old", async () => {
    const a = await account("teams");
    const t = now();
    const key = `brand/${a.accountId}/${"d".repeat(64)}.png`;
    await env.MEDIA.put(key, png(64, 64));
    await env.DB.prepare("INSERT INTO brand_assets (account_id, hash, kind, r2_key, content_type, bytes, width, height, created_at) VALUES (?, ?, 'logo', ?, 'image/png', 64, 64, 64, ?)")
      .bind(a.accountId, "d".repeat(64), key, t - 60)
      .run();
    expect(await sweepBrandAssets(env, t)).toBe(0);
    expect(await sweepBrandAssets(env, t + 3600)).toBeGreaterThanOrEqual(1);
    expect(await env.MEDIA.head(key)).toBeNull();
  });

  it("allows 20 set_branding calls per account per day", async () => {
    const a = await account("teams");
    const other = await account("teams");
    for (let i = 0; i < 20; i++) expect((await mcp("set_branding", { brand_name: `Acme ${i}` }, a.key)).isError).toBe(false);
    const r = await mcp("set_branding", { brand_name: "One more" }, a.key);
    expect(r.data.error).toBe("RATE_LIMITED");
    expect(r.data.message).toMatch(/20 times today/);
    expect((await mcp("get_branding", {}, a.key)).data.brand_name).toBe("Acme 19");
    expect((await mcp("set_branding", { brand_name: "Other" }, other.key)).isError).toBe(false);
  });

  it("refuses while the service is read-only", async () => {
    const a = await account("teams");
    const r = await mcp("set_branding", { brand_name: "Acme" }, a.key, { ...env, SERVICE_MODE: "READ_ONLY" } as typeof env);
    expect(r.data.error).toBe("SERVICE_PAUSED");
  });
});

describe("image links through set_branding (fetch mocked)", () => {
  let seen: { url: string; init: RequestInit }[];
  const serve = (routes: Record<string, () => Response>) => {
    seen = [];
    brandingDeps.fetch = async (url, init) => {
      seen.push({ url, init });
      const r = routes[url];
      if (!r) throw new Error(`unexpected fetch ${url}`);
      return r();
    };
  };
  const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
  beforeEach(() => {
    seen = [];
  });

  it("downloads an https link with manual redirects and stores the image", async () => {
    const a = await account("teams");
    serve({
      "https://cdn.example.com/logo": redirect("/real-logo.png"),
      "https://cdn.example.com/real-logo.png": () => new Response(png(300, 80, 128, 5), { headers: { "content-type": "text/html" } }),
    });
    const r = await mcp("set_branding", { logo: { url: "https://cdn.example.com/logo" } }, a.key);
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(["https://cdn.example.com/logo", "https://cdn.example.com/real-logo.png"]);
    expect(seen.every((s) => s.init.redirect === "manual")).toBe(true);
    expect(await assets(a.accountId)).toMatchObject([{ kind: "logo", content_type: "image/png", width: 300, height: 80 }]);
  });

  it("refuses http, IP and localhost links without fetching", async () => {
    const a = await account("teams");
    serve({});
    for (const url of ["http://cdn.example.com/logo.png", "https://127.0.0.1/logo.png", "https://localhost/logo.png", "https://[::1]/logo.png"]) {
      const r = await mcp("set_branding", { logo: { url } }, a.key);
      expect(r.data.error, url).toBe("IMAGE_LINK_FAILED");
    }
    expect(seen).toEqual([]);
  });

  it("refuses a redirect to a private host or after too many hops", async () => {
    const a = await account("teams");
    serve({
      "https://cdn.example.com/a": redirect("https://10.0.0.7/logo.png"),
      "https://cdn.example.com/b": redirect("http://cdn.example.com/logo.png"),
      "https://cdn.example.com/c": redirect("https://printer.local/logo.png"),
      "https://cdn.example.com/1": redirect("https://cdn.example.com/2"),
      "https://cdn.example.com/2": redirect("https://cdn.example.com/3"),
      "https://cdn.example.com/3": redirect("https://cdn.example.com/4"),
    });
    for (const [url, why] of [
      ["https://cdn.example.com/a", /IP address/],
      ["https://cdn.example.com/b", /Only https/],
      ["https://cdn.example.com/c", /private or internal/],
      ["https://cdn.example.com/1", /redirects too many times/],
    ] as const) {
      const r = await mcp("set_branding", { logo: { url } }, a.key);
      expect(r.data.error, url).toBe("IMAGE_LINK_FAILED");
      expect(r.data.message).toMatch(why);
    }
    expect(seen.map((s) => s.url)).not.toContain("https://10.0.0.7/logo.png");
    expect(seen.map((s) => s.url)).not.toContain("https://cdn.example.com/4");
  });

  it("aborts an oversized download mid-stream whatever Content-Length says", async () => {
    const a = await account("teams");
    let pulled = 0;
    let cancelled = false;
    serve({
      "https://cdn.example.com/huge.png": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(ctl) {
              pulled++;
              ctl.enqueue(pulled === 1 ? png(100, 100, 64 * 1024) : new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": "100" } },
        ),
    });
    const r = await mcp("set_branding", { logo: { url: "https://cdn.example.com/huge.png" } }, a.key);
    expect(r.data.error).toBe("IMAGE_TOO_LARGE");
    expect(r.data.message).toMatch(/bigger than 512 KB/);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(12);
  });

  it("reports a failing site plainly", async () => {
    const a = await account("teams");
    serve({ "https://cdn.example.com/gone.png": () => new Response("no", { status: 404 }) });
    const r = await mcp("set_branding", { logo: { url: "https://cdn.example.com/gone.png" } }, a.key);
    expect(r.data.error).toBe("IMAGE_LINK_FAILED");
    expect(r.data.message).toMatch(/answered 404/);
  });
});

describe("/b/<hash>", () => {
  async function seeded() {
    const a = await account("teams");
    const r = await mcp("set_branding", { logo: img(png(120, 60, 200, 77)) }, a.key);
    const path = new URL(r.data.logo_url).pathname;
    return { path, hash: path.slice(3) };
  }

  it("serves the bytes with locked-down headers, cached for 5 minutes (a takedown needs no CDN purge)", async () => {
    const { path, hash } = await seeded();
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag")).toBe(`"${hash}"`);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("content-disposition")).toBe("inline");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(200);
    expect(sniffImage(body, "logo")).toMatchObject({ width: 120, height: 60 });
  });

  it("HEAD answers the same headers with no body", async () => {
    const { path, hash } = await seeded();
    const res = await call(path, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("etag")).toBe(`"${hash}"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers 304 on a matching If-None-Match", async () => {
    const { path, hash } = await seeded();
    for (const inm of [`"${hash}"`, `W/"${hash}"`, `"other", "${hash}"`, "*"]) {
      const res = await call(path, { headers: { "if-none-match": inm } });
      expect(res.status, inm).toBe(304);
      expect(res.headers.get("etag")).toBe(`"${hash}"`);
    }
    expect((await call(path, { headers: { "if-none-match": '"nope"' } })).status).toBe(200);
  });

  it("404s an unknown hash, and other shapes aren't routed", async () => {
    const res = await call(`/b/${"e".repeat(64)}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call(`/b/${"E".repeat(64)}`)).status).toBe(404);
    expect((await call(`/b/${"e".repeat(63)}`)).status).toBe(404);
    const { path } = await seeded();
    expect((await call(path, { method: "POST" })).status).toBe(404);
  });

  /** A logo no other test uploads (distinct bytes, so a hash only this account has). */
  async function ownLogo(fill: number) {
    const a = await account("pro");
    const r = await mcp("set_branding", { logo: img(png(120, 60, 200, fill)) }, a.key);
    expect(r.isError).toBe(false);
    return { ...a, path: new URL(r.data.logo_url).pathname };
  }

  it("404s while the account that uploaded it is suspended, and serves again after", async () => {
    const { path, accountId } = await ownLogo(201);
    expect((await call(path)).status).toBe(200);
    const action = await suspendAccount(accountId);
    const res = await call(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await call(path, { method: "HEAD" })).status).toBe(404);
    await env.DB.prepare("UPDATE admin_actions SET reversed_at = ?, reversed_by = 'test-operator' WHERE id = ?").bind(now(), action).run();
    expect((await call(path)).status).toBe(200);
  });

  it("the same bytes uploaded by a second account that isn't suspended are still served", async () => {
    const { path, accountId } = await ownLogo(202);
    const other = await account("pro");
    expect((await mcp("set_branding", { logo: img(png(120, 60, 200, 202)) }, other.key)).isError).toBe(false);
    await suspendAccount(accountId);
    expect((await call(path)).status).toBe(200);
    await suspendAccount(other.accountId);
    expect((await call(path)).status).toBe(404);
  });
});

describe("a suspended account", () => {
  it("can't set branding (ACCOUNT_SUSPENDED, nothing stored) or a custom domain", async () => {
    const a = await account("pro");
    await suspendAccount(a.accountId);
    const r = await mcp("set_branding", { brand_name: "Phish Bank", logo: img(png(120, 60, 200, 78)) }, a.key);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("ACCOUNT_SUSPENDED");
    expect(await getBranding(env, a.accountId)).toBeNull();
    expect(await assets(a.accountId)).toEqual([]);
    const d = await mcp("set_custom_domain", { hostname: "videos.example.com" }, a.key);
    expect(d.isError).toBe(true);
    expect(d.data.error).toBe("ACCOUNT_SUSPENDED");
    expect(await env.DB.prepare("SELECT 1 FROM custom_domains WHERE account_id = ?").bind(a.accountId).first()).toBeNull();
  });
});
