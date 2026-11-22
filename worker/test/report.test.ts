import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCustomHostCache } from "../src/custom-host";
import worker from "../src/index";
import { abuseEmail, reportFallback, reportMailto } from "../src/report";
import { now, randomId } from "../src/util";
import { call, freshIp, seedAccount, withEnv } from "./helpers";

const recit = withEnv({ PUBLIC_BASE_URL: "https://example.test" });

async function at(url: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { ...init, headers: { "cf-connecting-ip": freshIp() } }), recit, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The prefilled mailto: link: raw href (HTML-unescaped) and its decoded subject and body. */
function mailto(html: string) {
  const href = /<a href="(mailto:[^"]+)">write the email<\/a>/.exec(html)![1].replace(/&amp;/g, "&");
  const u = new URL(href);
  return { href, to: u.pathname, subject: u.searchParams.get("subject")!, body: u.searchParams.get("body") };
}

/** Every href is one quoted attribute value with no quote, angle bracket, whitespace or control character inside. */
function hrefsAreClean(html: string) {
  for (const m of html.matchAll(/href=/g)) {
    expect(html.slice(m.index)).toMatch(/^href="[^"<>\s\u0000-\u001f]*"[ >]/);
  }
}

beforeEach(() => clearCustomHostCache());

describe("GET /report", () => {
  it("explains how to report, with the link prefilled in a mailto: to abuse@example.test", async () => {
    const res = await call("/report?host=videos.example.com&v=AbCdEf123456");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(abuseEmail(env)).toBe("abuse@example.test");
    expect(html).toContain("You can also email abuse@example.test");
    expect(html).toContain("https://videos.example.com/AbCdEf123456");
    expect(html).not.toMatch(/<form|<input|<textarea|<script/i);
    const m = mailto(html);
    expect(m.to).toBe("abuse@example.test");
    // encodeURIComponent on both: exactly this href.
    expect(m.href).toBe(
      "mailto:abuse@example.test?subject=Report%3A%20videos.example.com%2FAbCdEf123456&body=https%3A%2F%2Fvideos.example.com%2FAbCdEf123456",
    );
    expect(m.subject).toBe("Report: videos.example.com/AbCdEf123456");
    expect(m.body).toBe("https://videos.example.com/AbCdEf123456");
    hrefsAreClean(html);
  });

  it("works with no query, or only a host", async () => {
    const plain = await (await call("/report")).text();
    expect(mailto(plain).subject).toBe("Report a Recitbot video page");
    expect(plain).not.toContain("You're reporting");
    const hostOnly = await (await call("/report?host=Videos.Example.COM.")).text();
    expect(mailto(hostOnly)).toMatchObject({ subject: "Report: videos.example.com/", body: "https://videos.example.com/" });
    expect(mailto(plain).body).toBeNull();
  });

  it("drops query values that aren't a hostname / slug, and escapes the rest", async () => {
    const bad = [
      "host=%3Cscript%3Ealert(1)%3C/script%3E&v=%22%3E%3Cimg",
      "host=evil.com/%22onmouseover=x&v=short",
      "host=javascript:alert(1)",
      "host=localhost&v=" + "a".repeat(41),
      "host=1.2.3.4",
      "host=-bad-.com",
      "host=a..b.com",
    ];
    for (const q of bad) {
      const html = await (await call(`/report?${q}`)).text();
      expect(html, q).not.toContain("You're reporting");
      expect(html, q).not.toMatch(/<script|<img|onmouseover|javascript:/i);
      expect(mailto(html).subject, q).toBe("Report a Recitbot video page");
    }
    // CR / LF, quotes and angle brackets never reach the page or the mailto (no header or attribute injection).
    const injections = [
      "host=videos.example.com%0D%0ABcc:evil@example.org",
      "host=videos.example.com%0ABcc%3A%20evil%40example.org&v=AbCdEf123456",
      "host=videos.example.com%22%3E%3Ca%20href=x&v=AbCdEf123456",
      "host=videos.example.com&v=AbCdEf123456%0D%0ABcc:evil@example.org",
      "host=videos.example.com&v=AbCdEf123456%22onclick=x",
      "host=videos.example.com&v=%3CAbCdEf123456%3E",
      "host=%3Cvideos.example.com%3E",
      "host=videos.example.com%27%20x=%27",
    ];
    for (const q of injections) {
      const html = await (await call(`/report?${q}`)).text();
      hrefsAreClean(html);
      const m = mailto(html);
      expect(m.href, q).not.toMatch(/%0[AD]|[\r\n"'<>]|bcc|evil|onclick/i); // no encoded or raw CR / LF...
      // ...nor a quote, angle bracket or anything of the injected header.
      expect(html, q).not.toMatch(/Bcc|evil@|onclick|<a href=x|<videos|x='/i);
      expect(html, q).toContain("You can also email abuse@example.test");
    }
    // CR / LF around an otherwise valid value are stripped, not passed on.
    const trimmed = mailto(await (await call("/report?host=%0Dvideos.example.com%0A&v=AbCdEf123456%0D%0A")).text());
    expect(trimmed).toMatchObject({ subject: "Report: videos.example.com/AbCdEf123456", body: "https://videos.example.com/AbCdEf123456" });
    expect(reportMailto("abuse@example.test", null, "AbCdEf123456", true)).toBe("mailto:abuse@example.test?subject=Report%3A%20AbCdEf123456&body=Recitbot%20video%20AbCdEf123456");
    // A slug alone (no host) is kept.
    const slugOnly = await (await call("/report?v=AbCdEf123456")).text();
    expect(slugOnly).toContain("the Recitbot video AbCdEf123456");
  });

  it("HEAD has no body; POST and other methods are 405", async () => {
    const head = await call("/report", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call("/report?host=videos.example.com", { method, body: method === "DELETE" ? undefined : "x=1" });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(await res.text()).toContain("abuse@example.test");
    }
  });

  it("the fallback page and a paused service still show the address", async () => {
    expect(reportFallback("abuse@example.test", true)).toContain("You can also email abuse@example.test");
    expect(reportFallback("abuse@example.test", true)).toContain('href="mailto:abuse@example.test"');
    // No abuse address configured: a pointer to the operator, no mailto.
    expect(reportFallback(null, true)).toContain("Contact the operator of this server");
    expect(reportFallback(null, true)).not.toContain("mailto:");
    const off = await call("/report?host=videos.example.com&v=AbCdEf123456", {}, withEnv({ SERVICE_MODE: "OFF" }));
    expect(off.status).toBe(200);
    expect(await off.text()).toContain("You can also email abuse@example.test");
  });

  it("is served on example.test, never on a customer host", async () => {
    expect((await at("https://example.test/report?host=videos.example.com")).status).toBe(200);
    const { accountId } = await seedAccount(false);
    const host = `videos-${randomId(30).toLowerCase()}.example.org`;
    const t = now();
    await env.DB.prepare("INSERT INTO custom_domains (id, account_id, hostname, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .bind(randomId(), accountId, host, t, t)
      .run();
    expect((await at(`https://${host}/report?host=${host}`)).status).toBe(404);
    expect((await at(`https://unknown-${randomId(20).toLowerCase()}.example.org/report`)).status).toBe(404);
    expect((await at("https://customers.example.test/report")).status).toBe(404);
  });
});
