import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cfDeps, customDomainsEnabled } from "../src/cf-saas";
import {
  reservedDomains,
  type CustomDomainRow,
  DOMAIN_LIMITS,
  dnsCnameTarget,
  dnsDeps,
  DomainError,
  liveCustomDomain,
  refreshCustomDomains,
  retireAccountDomains,
  validateHostname,
} from "../src/custom-domains";
import { canUseCustomBranding } from "../src/entitlements";
import { governor } from "../src/governor";
import { cleanup } from "../src/index";
import { PLAYBOOK_TEXT } from "../src/playbook";
import { now, randomId } from "../src/util";
import { call, mcp, seedAccount, withEnv } from "./helpers";

// Custom domains on: a fake token and zone. Every Cloudflare and DoH request goes to the fakes below.
const E = withEnv({ CF_SAAS_API_TOKEN: "cf_test_token", CF_ZONE_ID: "zone_test" });
const DAY = 86400;

type FakeHost = { id: string; hostname: string; status: string; ssl: { status: string; validation_errors?: { message: string }[] }; verification_errors?: string[] };
type CfCall = { method: string; path: string; body: any; auth: string | null; signal: boolean };
let cfN = 0;
const cf = {
  hosts: new Map<string, FakeHost>(),
  calls: [] as CfCall[],
  /** The next request fails like this (once). */
  fail: null as null | { status: number; errors: { code: number; message: string }[] },
  /** Hostnames that exist as custom hostnames on some other Cloudflare zone. */
  elsewhere: new Set<string>(),
};
const dns = new Map<string, string>();
const dnsQueries: string[] = [];

const realCf = cfDeps.fetch;
const realDns = dnsDeps.fetch;
beforeEach(() => {
  cf.hosts.clear();
  cf.calls = [];
  cf.fail = null;
  cf.elsewhere.clear();
  dns.clear();
  dnsQueries.length = 0;
  cfDeps.fetch = async (input, init) => {
    const u = new URL(input);
    const prefix = "/client/v4/zones/zone_test";
    const path = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init.headers as Record<string, string>;
    cf.calls.push({ method: init.method!, path: path + u.search, body, auth: headers.authorization ?? null, signal: !!init.signal });
    const err = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
    const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
    if (u.origin !== "https://api.cloudflare.com" || !u.pathname.startsWith(prefix + "/")) return err(403, 10000, "Authentication error");
    if (cf.fail) {
      const f = cf.fail;
      cf.fail = null;
      return Response.json({ success: false, errors: f.errors, result: null }, { status: f.status });
    }
    if (init.method === "POST" && path === "/custom_hostnames") {
      if (cf.elsewhere.has(body.hostname) || [...cf.hosts.values()].some((h) => h.hostname === body.hostname)) {
        return err(409, 1406, "Duplicate custom hostname found.");
      }
      const h: FakeHost = { id: `cfh${++cfN}`, hostname: body.hostname, status: "pending", ssl: { status: "initializing" } };
      cf.hosts.set(h.id, h);
      return ok(h);
    }
    if (init.method === "GET" && path === "/custom_hostnames") {
      return ok([...cf.hosts.values()].filter((h) => h.hostname === u.searchParams.get("hostname")));
    }
    if (path === "/custom_hostnames/fallback_origin") return ok({ origin: "fallback.example.test", status: "active" });
    const m = /^\/custom_hostnames\/([^/]+)$/.exec(path);
    if (m) {
      const h = cf.hosts.get(m[1]);
      if (!h) return err(404, 1436, "The custom hostname was not found.");
      if (init.method === "GET") return ok(h);
      if (init.method === "DELETE") {
        cf.hosts.delete(m[1]);
        return ok({ id: m[1] });
      }
    }
    return err(400, 7000, "No route for that URI");
  };
  dnsDeps.fetch = async (input, init) => {
    const u = new URL(input);
    expect(u.origin + u.pathname).toBe("https://cloudflare-dns.com/dns-query");
    expect(u.searchParams.get("type")).toBe("CNAME");
    expect((init.headers as Record<string, string>).accept).toBe("application/dns-json");
    const name = u.searchParams.get("name")!;
    dnsQueries.push(name);
    const target = dns.get(name);
    return Response.json({ Status: target ? 0 : 3, Answer: target ? [{ name: `${name}.`, type: 5, TTL: 300, data: `${target}.` }] : undefined });
  };
});
afterEach(() => {
  cfDeps.fetch = realCf;
  dnsDeps.fetch = realDns;
});

/** A fresh domain per test, so tests never share hostnames. */
const dom = () => `ex${randomId(40).toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;

async function account(plan: string) {
  const a = await seedAccount(false);
  await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, a.accountId).run();
  return a;
}

const rowsOf = async (accountId: string) =>
  (await env.DB.prepare("SELECT * FROM custom_domains WHERE account_id = ? ORDER BY created_at, hostname").bind(accountId).all<CustomDomainRow>()).results;
const rowOf = (hostname: string) => env.DB.prepare("SELECT * FROM custom_domains WHERE hostname = ?").bind(hostname).first<CustomDomainRow>();
const cfHostOf = (hostname: string) => [...cf.hosts.values()].find((h) => h.hostname === hostname)!;

async function insertRow(accountId: string, hostname: string, over: Partial<CustomDomainRow> = {}): Promise<CustomDomainRow> {
  const t = now();
  const row: CustomDomainRow = {
    id: randomId(128),
    account_id: accountId,
    hostname,
    cf_id: null,
    status: "pending",
    cf_status: null,
    ssl_status: null,
    verification_errors: null,
    redirect_to: null,
    redirect_until: null,
    disabled_at: null,
    disabled_reason: null,
    live_at: null,
    checked_at: null,
    created_at: t,
    updated_at: t,
    ...over,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO custom_domains (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => (row as Record<string, unknown>)[c]))
    .run();
  return row;
}

function fakeHost(hostname: string, status = "pending", ssl = "pending_validation"): FakeHost {
  const h: FakeHost = { id: `cfh${++cfN}`, hostname, status, ssl: { status: ssl } };
  cf.hosts.set(h.id, h);
  return h;
}

describe("hostname validation", () => {
  const code = (input: string) => {
    try {
      validateHostname(input, reservedDomains(env));
      return "OK";
    } catch (e) {
      if (e instanceof DomainError) return e.code;
      throw e;
    }
  };

  it("normalises good names and pasted URLs", () => {
    expect(validateHostname("videos.example.com")).toEqual({ hostname: "videos.example.com", domain: "example.com", sub: "videos" });
    expect(validateHostname("  HTTPS://Videos.Example.COM/  ").hostname).toBe("videos.example.com");
    expect(validateHostname("http://videos.example.com").hostname).toBe("videos.example.com");
    expect(validateHostname("videos.example.com.").hostname).toBe("videos.example.com");
    expect(validateHostname("videos.example.com:443").hostname).toBe("videos.example.com");
    expect(validateHostname("watch.team.brand.co.uk")).toEqual({ hostname: "watch.team.brand.co.uk", domain: "brand.co.uk", sub: "watch.team" });
    expect(validateHostname("vids.example.app").sub).toBe("vids");
  });

  it("turns an IDN into punycode", () => {
    const v = validateHostname("vidéos.exämple.com");
    expect(v.hostname).toBe("xn--vidos-dsa.xn--exmple-cua.com");
    expect(v.sub).toBe("xn--vidos-dsa");
  });

  it.each([
    ["example.com", "APEX_NOT_SUPPORTED"],
    ["Example.com", "APEX_NOT_SUPPORTED"],
    ["https://example.com/", "APEX_NOT_SUPPORTED"],
    ["brand.co.uk", "APEX_NOT_SUPPORTED"],
    ["x.vercel.app", "PLATFORM_DOMAIN"],
    ["videos.me.github.io", "PLATFORM_DOMAIN"],
    ["site.pages.dev", "PLATFORM_DOMAIN"],
    ["a.b.blogspot.com", "PLATFORM_DOMAIN"],
    ["my-recorder.example.workers.dev", "RESERVED_HOSTNAME"],
    ["example.test", "RESERVED_HOSTNAME"],
    ["videos.example.test", "RESERVED_HOSTNAME"],
    ["customers.example.test", "RESERVED_HOSTNAME"],
    ["1.2.3.4", "INVALID_HOSTNAME"],
    ["https://10.0.0.1/", "INVALID_HOSTNAME"],
    ["[::1]", "INVALID_HOSTNAME"],
    ["*.example.com", "INVALID_HOSTNAME"],
    ["videos.example.com:8443", "INVALID_HOSTNAME"],
    ["https://videos.example.com/watch", "INVALID_HOSTNAME"],
    ["videos.example.com/?x=1", "INVALID_HOSTNAME"],
    ["videos.example.com#top", "INVALID_HOSTNAME"],
    ["user@videos.example.com", "INVALID_HOSTNAME"],
    ["https://user:pw@videos.example.com/", "INVALID_HOSTNAME"],
    ["ftp://videos.example.com", "INVALID_HOSTNAME"],
    ["videos example.com", "INVALID_HOSTNAME"],
    ["-bad.example.com", "INVALID_HOSTNAME"],
    ["bad-.example.com", "INVALID_HOSTNAME"],
    ["vid_eos.example.com", "INVALID_HOSTNAME"],
    [`${"a".repeat(64)}.example.com`, "INVALID_HOSTNAME"],
    [`${Array(5).fill("a".repeat(60)).join(".")}.example.com`, "INVALID_HOSTNAME"],
    ["videos.example.notatld", "INVALID_HOSTNAME"],
    ["localhost", "INVALID_HOSTNAME"],
    ["", "INVALID_HOSTNAME"],
  ])("%s -> %s", (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it("tells the user which subdomain to pick for a bare domain", () => {
    expect(() => validateHostname("example.com")).toThrow(/Pick a subdomain like videos\.example\.com/);
  });
});

describe("entitlement and configuration", () => {
  it("canUseCustomBranding: Pro, Teams and owner only", () => {
    for (const t of ["pro", "teams", "owner"]) expect(canUseCustomBranding(t)).toBe(true);
    for (const t of ["free", ""]) expect(canUseCustomBranding(t)).toBe(false);
  });

  it("free is refused before any Cloudflare call; pro, teams and owner are allowed", async () => {
    const d = dom();
    const { key } = await account("free");
    const refused = await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    expect(refused.isError).toBe(true);
    expect(refused.data.error).toBe("UPGRADE_REQUIRED");
    expect(refused.data.message).toBe("Custom domains are part of Recitbot Pro ($10/mo or $100/yr). Ask me to upgrade to Pro.");
    expect(cf.calls).toEqual([]);
    for (const [i, plan] of ["pro", "teams", "owner"].entries()) {
      const { key } = await account(plan);
      const r = await mcp("set_custom_domain", { hostname: `v${i}.${d}` }, key, E);
      expect(r.isError).toBe(false);
      expect(r.data.status).toBe("pending");
    }
    // Owner by OWNER_ACCOUNT_IDS too.
    const o = await account("free");
    const r = await mcp("set_custom_domain", { hostname: `v9.${d}` }, o.key, withEnv({ ...E, OWNER_ACCOUNT_IDS: o.accountId }));
    expect(r.data.status).toBe("pending");
  });

  it("CUSTOM_DOMAINS_OFF without the token or the zone id, and nothing is called", async () => {
    expect(customDomainsEnabled(E)).toBe(true);
    expect(customDomainsEnabled(env)).toBe(false);
    expect(customDomainsEnabled(withEnv({ CF_SAAS_API_TOKEN: "x" }))).toBe(false);
    expect(customDomainsEnabled(withEnv({ CF_ZONE_ID: "z" }))).toBe(false);
    const { key } = await account("teams");
    const set = await mcp("set_custom_domain", { hostname: `videos.${dom()}` }, key);
    expect(set.data).toMatchObject({ error: "CUSTOM_DOMAINS_OFF", message: "Custom domains aren't switched on yet." });
    const st = await mcp("get_custom_domain_status", {}, key);
    expect(st.data.error).toBe("CUSTOM_DOMAINS_OFF");
    const rm = await mcp("remove_custom_domain", {}, key);
    expect(rm.data.removed).toBeNull();
    expect(cf.calls).toEqual([]);
    expect(dnsQueries).toEqual([]);
  });

  it("validation errors come back before any network call", async () => {
    const { key } = await account("teams");
    const r = await mcp("set_custom_domain", { hostname: "example.com" }, key, E);
    expect(r.data).toMatchObject({ error: "APEX_NOT_SUPPORTED", message: expect.stringMatching(/Pick a subdomain like videos\.example\.com/) });
    expect((await mcp("set_custom_domain", { hostname: "me.vercel.app" }, key, E)).data.error).toBe("PLATFORM_DOMAIN");
    expect(cf.calls).toEqual([]);
  });

  it("the three tools are listed on the MCP endpoint", async () => {
    const res = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string; inputSchema: any }[];
    const set = tools.find((t) => t.name === "set_custom_domain")!;
    expect(set.inputSchema.required).toEqual(["hostname"]);
    expect(set.description).toMatch(/videos CNAME </);
    expect(tools.find((t) => t.name === "get_custom_domain_status")).toBeTruthy();
    expect(tools.find((t) => t.name === "remove_custom_domain")).toBeTruthy();
    expect((await mcp("set_custom_domain", { hostname: "videos.example.com" })).status).toBe(401);
  });

  it("the playbook tells the bot the flow", () => {
    expect(PLAYBOOK_TEXT).toContain("## Custom domain (Pro)");
    // The playbook is the same for every server: the real target comes from set_custom_domain's instructions.
    expect(PLAYBOOK_TEXT).toContain("videos CNAME <target>");
    expect(PLAYBOOK_TEXT).toMatch(/get_custom_domain_status about once a minute/);
    expect(PLAYBOOK_TEXT).toMatch(/remove_custom_domain/);
  });
});

describe("set_custom_domain", () => {
  it("creates the Cloudflare hostname, stores it pending and returns the exact CNAME", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    const r = await mcp("set_custom_domain", { hostname: `https://Videos.${d}/` }, key, E);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      hostname: `videos.${d}`,
      status: "pending",
      phase: "waiting_for_dns",
      live_url: null,
      replaced: null,
      dns: { type: "CNAME", name: "videos", full_name: `videos.${d}`, target: "customers.example.test", ttl: "Auto" },
    });
    const lines = (r.data.instructions as string).split("\n");
    expect(lines[0]).toBe("videos CNAME customers.example.test");
    expect(r.data.instructions).toMatch(/DNS only \(grey cloud\) is simplest; proxied \(orange cloud\) works too/);
    expect(r.data.instructions).toMatch(/GoDaddy, Namecheap, Squarespace.*Host\/Name videos/);
    expect(r.data.instructions).toContain(`Route 53: Record name videos.${d} (the full name)`);
    expect(r.data.instructions).toMatch(/No TXT record is needed/);
    expect(r.data.message).toContain("videos CNAME customers.example.test");

    expect(cf.calls).toHaveLength(1);
    expect(cf.calls[0]).toMatchObject({
      method: "POST",
      path: "/custom_hostnames",
      auth: "Bearer cf_test_token",
      signal: true,
      body: { hostname: `videos.${d}`, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } },
    });
    const rows = await rowsOf(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostname: `videos.${d}`, status: "pending", cf_id: cfHostOf(`videos.${d}`).id, cf_status: "pending", ssl_status: "initializing" });
    // No secret in the result.
    expect(JSON.stringify(r.data)).not.toContain("cf_test_token");
  });

  it("the same hostname again is idempotent: same row, no Cloudflare call, no rate-limit slot", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    for (let i = 0; i < 4; i++) {
      const r = await mcp("set_custom_domain", { hostname: `VIDEOS.${d}` }, key, E);
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ already: true, hostname: `videos.${d}`, status: "pending" });
    }
    expect(cf.calls).toHaveLength(1);
    expect(await rowsOf(accountId)).toHaveLength(1);
  });

  it("a hostname another account uses (any status) is HOSTNAME_TAKEN", async () => {
    const d = dom();
    const a = await account("teams");
    const b = await account("teams");
    await mcp("set_custom_domain", { hostname: `videos.${d}` }, a.key, E);
    const r = await mcp("set_custom_domain", { hostname: `videos.${d}` }, b.key, E);
    expect(r.data.error).toBe("HOSTNAME_TAKEN");
    // Even while it's only redirecting.
    await insertRow(a.accountId, `old.${d}`, { status: "redirecting", redirect_to: `videos.${d}`, redirect_until: now() + DAY });
    expect((await mcp("set_custom_domain", { hostname: `old.${d}` }, b.key, E)).data.error).toBe("HOSTNAME_TAKEN");
    expect(cf.calls).toHaveLength(1);
    expect(await rowsOf(b.accountId)).toEqual([]);
  });

  it("a hostname on another Cloudflare zone is HOSTNAME_TAKEN; an orphan on our zone is adopted", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    cf.elsewhere.add(`videos.${d}`);
    const r = await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    expect(r.data).toMatchObject({ error: "HOSTNAME_TAKEN", message: expect.stringMatching(/another service on Cloudflare/) });
    expect(await rowsOf(accountId)).toEqual([]);

    const orphan = fakeHost(`watch.${d}`);
    const r2 = await mcp("set_custom_domain", { hostname: `watch.${d}` }, key, E);
    expect(r2.data.status).toBe("pending");
    expect((await rowOf(`watch.${d}`))!.cf_id).toBe(orphan.id);
  });

  it("changing it: new hostname pending, the old one redirects to it for 30 days", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    await env.DB.prepare("UPDATE custom_domains SET status = 'active', live_at = ? WHERE hostname = ?").bind(now(), `videos.${d}`).run();
    const t = now();
    const r = await mcp("set_custom_domain", { hostname: `watch.${d}` }, key, E);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ hostname: `watch.${d}`, status: "pending", replaced: { hostname: `videos.${d}`, redirect_to: `watch.${d}` } });
    expect(r.data.message).toMatch(new RegExp(`videos\\.${d.replace(".", "\\.")} now redirects to watch\\.`));
    const old = (await rowOf(`videos.${d}`))!;
    expect(old.status).toBe("redirecting");
    expect(old.redirect_to).toBe(`watch.${d}`);
    expect(old.redirect_until! - t).toBeGreaterThanOrEqual(30 * DAY - 5);
    expect(old.redirect_until! - t).toBeLessThanOrEqual(30 * DAY + 5);
    // The old Cloudflare hostname stays until the redirect ends.
    expect(cfHostOf(`videos.${d}`)).toBeTruthy();
    expect(await liveCustomDomain(env, accountId)).toBeNull();

    // A third name: both older ones point straight at it.
    await mcp("set_custom_domain", { hostname: `clips.${d}` }, key, E);
    expect((await rowOf(`videos.${d}`))!.redirect_to).toBe(`clips.${d}`);
    expect((await rowOf(`watch.${d}`))!).toMatchObject({ status: "redirecting", redirect_to: `clips.${d}` });
  });

  it("switching back to a hostname that still redirects reuses its Cloudflare hostname", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    const t = now();
    const v = fakeHost(`videos.${d}`, "active", "active");
    const w = fakeHost(`watch.${d}`, "active", "active");
    await insertRow(accountId, `videos.${d}`, { cf_id: v.id, status: "redirecting", redirect_to: `clips.${d}`, redirect_until: t + DAY, live_at: t - DAY });
    await insertRow(accountId, `watch.${d}`, { cf_id: w.id, status: "redirecting", redirect_to: `clips.${d}`, redirect_until: t + DAY, live_at: t - DAY });
    await insertRow(accountId, `clips.${d}`, { cf_id: fakeHost(`clips.${d}`).id, status: "pending" });
    const cfId = v.id;
    const calls = cf.calls.length;
    const back = await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    // Its hostname and certificate are still active on Cloudflare: live again at once.
    expect(back.data).toMatchObject({ status: "active", phase: "live", live_url: `https://videos.${d}`, replaced: { hostname: `clips.${d}` } });
    expect(cf.calls.slice(calls).map((c) => c.method)).toEqual(["GET"]);
    expect((await rowOf(`videos.${d}`))!).toMatchObject({ status: "active", cf_id: cfId, redirect_to: null, redirect_until: null });
    expect((await rowOf(`clips.${d}`))!).toMatchObject({ status: "redirecting", redirect_to: `videos.${d}` });
    expect((await rowOf(`watch.${d}`))!).toMatchObject({ status: "redirecting", redirect_to: `videos.${d}` });
    expect((await rowsOf(accountId)).filter((x) => x.status === "pending" || x.status === "active")).toHaveLength(1);
  });

  it("Cloudflare refusing changes nothing in D1", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    const before = await rowsOf(accountId);
    cf.fail = { status: 500, errors: [{ code: 1000, message: "Internal error\nwith Bearer abc.def and a token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] };
    const r = await mcp("set_custom_domain", { hostname: `watch.${d}` }, key, E);
    expect(r.data.error).toBe("CLOUDFLARE_ERROR");
    expect(r.data.message).toMatch(/^Cloudflare couldn't set up watch\./);
    expect(r.data.message).not.toMatch(/abc\.def|a{40}|\n/);
    expect(await rowsOf(accountId)).toEqual(before);

    cf.fail = { status: 403, errors: [{ code: 10000, message: "Authentication error" }] };
    const r2 = await mcp("set_custom_domain", { hostname: `watch.${d}` }, key, E);
    expect(r2.data.error).toBe("CUSTOM_DOMAINS_OFF");
    expect(await rowsOf(accountId)).toEqual(before);
    expect([...cf.hosts.values()].map((h) => h.hostname)).toEqual([`videos.${d}`]);
  });

  it("a timeout reads as a Cloudflare error", async () => {
    const { accountId, key } = await account("teams");
    cfDeps.fetch = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const r = await mcp("set_custom_domain", { hostname: `videos.${dom()}` }, key, E);
    expect(r.data).toMatchObject({ error: "CLOUDFLARE_ERROR", message: expect.stringMatching(/didn't answer in time/) });
    expect(await rowsOf(accountId)).toEqual([]);
  });

  it("3 set/change calls per account per UTC day", async () => {
    const d = dom();
    const { key } = await account("teams");
    for (const s of ["a", "b", "c"]) expect((await mcp("set_custom_domain", { hostname: `${s}.${d}` }, key, E)).data.status).toBe("pending");
    const r = await mcp("set_custom_domain", { hostname: `d.${d}` }, key, E);
    expect(r.data).toMatchObject({ error: "RATE_LIMITED", message: expect.stringMatching(/3 times per day/) });
    expect(r.data.retry_after).toBeGreaterThan(0);
    // The current one still answers (idempotent, no slot needed).
    expect((await mcp("set_custom_domain", { hostname: `c.${d}` }, key, E)).data.already).toBe(true);
    expect(cf.calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("refuses while the service is read-only", async () => {
    const { key } = await account("teams");
    const r = await mcp("set_custom_domain", { hostname: `videos.${dom()}` }, key, withEnv({ ...E, SERVICE_MODE: "READ_ONLY" }));
    expect(r.data.error).toBe("SERVICE_PAUSED");
  });
});

describe("get_custom_domain_status", () => {
  it("walks pending -> verifying -> issuing certificate -> live", async () => {
    const d = dom();
    const h = `videos.${d}`;
    const { accountId, key } = await account("teams");
    await mcp("set_custom_domain", { hostname: h }, key, E);
    const st = async () => (await mcp("get_custom_domain_status", {}, key, E)).data;

    let s = await st();
    expect(s.custom_domain).toMatchObject({ hostname: h, status: "pending", phase: "waiting_for_dns", cname_seen: null });
    expect(s.message).toMatch(/I don't see the CNAME/);
    expect(dnsQueries).toEqual([h]);

    dns.set(h, "somewhere.else.net");
    s = await st();
    expect(s.custom_domain.phase).toBe("wrong_target");
    expect(s.message).toBe(`${h} points to somewhere.else.net; it should point to customers.example.test. Change the CNAME record's target to customers.example.test.`);

    dns.set(h, "customers.example.test");
    cfHostOf(h).ssl.status = "pending_validation";
    s = await st();
    expect(s.custom_domain.phase).toBe("verifying");
    expect(s.message).toMatch(/^DNS found, verifying/);

    cfHostOf(h).status = "active";
    cfHostOf(h).ssl.status = "pending_issuance";
    s = await st();
    expect(s.custom_domain.phase).toBe("issuing_certificate");
    expect(s.message).toMatch(/issuing the HTTPS certificate/i);
    expect((await rowOf(h))!).toMatchObject({ status: "pending", cf_status: "active", ssl_status: "pending_issuance" });

    cfHostOf(h).ssl.status = "active";
    s = await st();
    expect(s.custom_domain).toMatchObject({ status: "active", phase: "live", live_url: `https://${h}` });
    expect(s.message).toBe(`Live at https://${h}.`);
    const row = (await rowOf(h))!;
    expect(row.status).toBe("active");
    expect(row.live_at).toBeGreaterThan(0);
    expect((await liveCustomDomain(env, accountId))!.hostname).toBe(h);

    // Live rows aren't re-checked.
    const calls = cf.calls.length;
    await st();
    expect(cf.calls.length).toBe(calls);
  });

  it("reports Cloudflare's errors, sanitised", async () => {
    const h = `videos.${dom()}`;
    const { key } = await account("teams");
    await mcp("set_custom_domain", { hostname: h }, key, E);
    Object.assign(cfHostOf(h), {
      verification_errors: ["custom hostname does not CNAME to this zone."],
      ssl: { status: "validation_timed_out", validation_errors: [{ message: "<b>timed out</b>\u0000 waiting" }] },
    });
    const s = (await mcp("get_custom_domain_status", {}, key, E)).data;
    expect(s.custom_domain.phase).toBe("error");
    expect(s.custom_domain.errors).toEqual(["custom hostname does not CNAME to this zone.", "<b>timed out</b> waiting"]);
    expect(s.message).toMatch(/^Cloudflare reported a problem with videos\..*: custom hostname does not CNAME to this zone\./);
  });

  it("a hostname Cloudflare no longer has is failed; a Cloudflare outage keeps the last state", async () => {
    const d = dom();
    const { key } = await account("teams");
    await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    cf.fail = { status: 503, errors: [{ code: 1000, message: "Service unavailable" }] };
    let s = (await mcp("get_custom_domain_status", {}, key, E)).data;
    expect(s.custom_domain.status).toBe("pending");
    expect(s.message).toMatch(/Couldn't reach Cloudflare just now/);
    cf.hosts.clear();
    s = (await mcp("get_custom_domain_status", {}, key, E)).data;
    expect(s.custom_domain).toMatchObject({ status: "failed", phase: "failed" });
    expect(s.message).toMatch(/didn't go live \(Cloudflare no longer has this hostname\.\)\. Call set_custom_domain/);
    // Setting it again starts over.
    expect((await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E)).data.status).toBe("pending");
  });

  it("lists redirecting hostnames with their end dates; nothing set up says how to start", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    let s = (await mcp("get_custom_domain_status", {}, key, E)).data;
    expect(s).toMatchObject({ custom_domain: null, redirecting: [] });
    expect(s.message).toMatch(/call set_custom_domain/);
    const until = now() + 10 * DAY;
    await insertRow(accountId, `old.${d}`, { status: "redirecting", redirect_to: "example.test", redirect_until: until });
    s = (await mcp("get_custom_domain_status", {}, key, E)).data;
    const date = new Date(until * 1000).toISOString().slice(0, 10);
    expect(s.redirecting).toEqual([{ hostname: `old.${d}`, redirect_to: "example.test", until: date }]);
    expect(s.message).toContain(`old.${d} redirects to example.test until ${date}.`);
  });
});

describe("remove_custom_domain", () => {
  it("a live hostname redirects to example.test for 30 days; removing again is a no-op", async () => {
    const h = `videos.${dom()}`;
    const { accountId, key } = await account("teams");
    await mcp("set_custom_domain", { hostname: h }, key, E);
    await env.DB.prepare("UPDATE custom_domains SET status = 'active', live_at = ? WHERE hostname = ?").bind(now(), h).run();
    const r = await mcp("remove_custom_domain", {}, key, E);
    expect(r.isError).toBe(false);
    expect(r.data.removed).toMatchObject({ hostname: h, redirect_to: "example.test" });
    expect(r.data.message).toMatch(/redirect to the same videos on example\.test/);
    expect((await rowOf(h))!).toMatchObject({ status: "redirecting", redirect_to: "example.test" });
    expect(cfHostOf(h)).toBeTruthy();
    expect(await liveCustomDomain(env, accountId)).toBeNull();
    const again = await mcp("remove_custom_domain", {}, key, E);
    expect(again.data.removed).toBeNull();
    expect(again.data.redirecting).toHaveLength(1);
  });

  it("a hostname that never went live is deleted from Cloudflare and D1 at once", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    await insertRow(accountId, `old.${d}`, { status: "redirecting", redirect_to: `videos.${d}`, redirect_until: now() + DAY });
    await mcp("set_custom_domain", { hostname: `videos.${d}` }, key, E);
    const r = await mcp("remove_custom_domain", {}, key, E);
    expect(r.data.removed).toEqual({ hostname: `videos.${d}`, redirect_to: null, until: null });
    expect(await rowOf(`videos.${d}`)).toBeNull();
    expect(cf.hosts.size).toBe(0);
    expect(cf.calls.at(-1)!.method).toBe("DELETE");
    // What redirected to it now goes to example.test.
    expect((await rowOf(`old.${d}`))!.redirect_to).toBe("example.test");
  });

  it("if Cloudflare's delete fails, the row is marked failed for the cron", async () => {
    const h = `videos.${dom()}`;
    const { key } = await account("teams");
    await mcp("set_custom_domain", { hostname: h }, key, E);
    cf.fail = { status: 500, errors: [{ code: 1000, message: "boom" }] };
    await mcp("remove_custom_domain", {}, key, E);
    expect((await rowOf(h))!.status).toBe("failed");
  });

  it("retireAccountDomains (downgrade / takedown) redirects pending and active to example.test", async () => {
    const d = dom();
    const { accountId } = await account("teams");
    await insertRow(accountId, `videos.${d}`, { status: "active", live_at: now() });
    await insertRow(accountId, `old.${d}`, { status: "redirecting", redirect_to: `videos.${d}`, redirect_until: now() + DAY });
    const t = now();
    expect(await retireAccountDomains(env, accountId, t)).toBe(1);
    expect((await rowOf(`videos.${d}`))!).toMatchObject({ status: "redirecting", redirect_to: "example.test", redirect_until: t + 30 * DAY });
    expect((await rowOf(`old.${d}`))!.redirect_to).toBe("example.test");
    expect(await retireAccountDomains(env, accountId, t)).toBe(0);
  });

  it("a disabled (taken down) domain can't be changed or removed by the user", async () => {
    const d = dom();
    const { accountId, key } = await account("teams");
    await insertRow(accountId, `videos.${d}`, { status: "active", live_at: now(), disabled_at: now(), disabled_reason: "abuse" });
    expect((await mcp("set_custom_domain", { hostname: `watch.${d}` }, key, E)).data.error).toBe("DOMAIN_DISABLED");
    expect((await mcp("remove_custom_domain", {}, key, E)).data.error).toBe("DOMAIN_DISABLED");
    expect(await liveCustomDomain(env, accountId)).toBeNull();
  });
});

describe("cron", () => {
  it("refreshes pending rows, fails 7-day-old ones and purges expired redirects and failed rows", async () => {
    const d = dom();
    const { accountId } = await account("teams");
    const t = now();
    const stale = fakeHost(`stale.${d}`);
    await insertRow(accountId, `stale.${d}`, { cf_id: stale.id, created_at: t - 8 * DAY, updated_at: t - 8 * DAY });
    const fresh = fakeHost(`fresh.${d}`, "active", "active");
    const b = await account("teams");
    await insertRow(b.accountId, `fresh.${d}`, { cf_id: fresh.id, created_at: t - 3600, updated_at: t - 3600 });
    const gone = fakeHost(`gone.${d}`, "active", "active");
    await insertRow(accountId, `gone.${d}`, { cf_id: gone.id, status: "redirecting", redirect_to: "example.test", redirect_until: t - 1 });
    const keep = fakeHost(`keep.${d}`, "active", "active");
    await insertRow(accountId, `keep.${d}`, { cf_id: keep.id, status: "redirecting", redirect_to: "example.test", redirect_until: t + DAY });
    const dead = fakeHost(`dead.${d}`);
    await insertRow(accountId, `dead.${d}`, { cf_id: dead.id, status: "failed", updated_at: t - 2 * DAY });

    const r = await refreshCustomDomains(E, t);
    expect(r).toMatchObject({ failed: 1, live: 1, purged: 2 });
    expect((await rowOf(`stale.${d}`))!.status).toBe("failed");
    expect(JSON.parse((await rowOf(`stale.${d}`))!.verification_errors!)).toContain("Not verified within 7 days: the CNAME record was never found.");
    expect(cf.hosts.has(stale.id)).toBe(false);
    expect((await rowOf(`fresh.${d}`))!).toMatchObject({ status: "active", live_at: t, checked_at: t });
    expect(await rowOf(`gone.${d}`)).toBeNull();
    expect(cf.hosts.has(gone.id)).toBe(false);
    expect(await rowOf(`dead.${d}`)).toBeNull();
    expect(cf.hosts.has(dead.id)).toBe(false);
    expect((await rowOf(`keep.${d}`))!.status).toBe("redirecting");
    expect(cf.hosts.has(keep.id)).toBe(true);

    // A day later the stale one (now failed) is purged too.
    await refreshCustomDomains(E, t + DAY + 1);
    expect(await rowOf(`stale.${d}`)).toBeNull();
  });

  it("keeps a row whose Cloudflare delete failed, for the next run", async () => {
    const d = dom();
    const { accountId } = await account("teams");
    const t = now();
    const h = fakeHost(`gone.${d}`, "active", "active");
    await insertRow(accountId, `gone.${d}`, { cf_id: h.id, status: "redirecting", redirect_to: "example.test", redirect_until: t - 1 });
    const realFake = cfDeps.fetch;
    cfDeps.fetch = async (input, init) =>
      init.method === "DELETE" ? Response.json({ success: false, errors: [{ code: 1000, message: "boom" }] }, { status: 500 }) : realFake(input, init);
    await refreshCustomDomains(E, t);
    expect(await rowOf(`gone.${d}`)).not.toBeNull();
    cfDeps.fetch = realFake;
    await refreshCustomDomains(E, t);
    expect(await rowOf(`gone.${d}`)).toBeNull();
  });

  it("refreshes the least recently checked first, at most refreshPerRun per run", async () => {
    const d = dom();
    const t = now();
    const ids: string[] = [];
    for (let i = 0; i < DOMAIN_LIMITS.refreshPerRun + 2; i++) {
      const { accountId } = await account("teams");
      const h = fakeHost(`v${i}.${d}`);
      await insertRow(accountId, `v${i}.${d}`, { cf_id: h.id, checked_at: i === 0 ? t : t - 1000 + i });
      ids.push(`v${i}.${d}`);
    }
    // Other tests' pending rows may exist: count only this test's hostnames.
    const r = await refreshCustomDomains(E, t + 10);
    expect(r.refreshed).toBeLessThanOrEqual(DOMAIN_LIMITS.refreshPerRun);
    expect((await rowOf(ids[1]))!.checked_at).toBe(t + 10);
    expect((await rowOf(ids[0]))!.checked_at).toBe(t);
  });

  it("does nothing when custom domains are off; cleanup() runs it", async () => {
    expect(await refreshCustomDomains(env)).toEqual({ skipped: true });
    expect((await cleanup(env)).domains).toEqual({ skipped: true });
    expect((await cleanup(E)).domains).toMatchObject({ failed: expect.any(Number), purged: expect.any(Number) });
    expect(cf.calls.every((c) => c.auth === "Bearer cf_test_token")).toBe(true);
  });
});

describe("DoH lookup", () => {
  it("returns the CNAME target, or null on no answer or failure", async () => {
    dns.set("videos.example.com", "Customers.Example.TEST");
    expect(await dnsCnameTarget("videos.example.com")).toBe("customers.example.test");
    expect(await dnsCnameTarget("none.example.com")).toBeNull();
    dnsDeps.fetch = async () => {
      throw new Error("network down");
    };
    expect(await dnsCnameTarget("videos.example.com")).toBeNull();
  });
});

// Last in the file: it fills today's global counter.
describe("global cap", () => {
  it("refuses once the day's global set/change calls are used up", async () => {
    const { key } = await account("teams");
    await governor(env).hit("cdset:global", 1e9, DAY, now(), true, DOMAIN_LIMITS.setsPerDay);
    const r = await mcp("set_custom_domain", { hostname: `videos.${dom()}` }, key, E);
    expect(r.data).toMatchObject({ error: "RATE_LIMITED", message: expect.stringMatching(/Too many custom domains were set up today/) });
    expect(cf.calls).toEqual([]);
  });
});
