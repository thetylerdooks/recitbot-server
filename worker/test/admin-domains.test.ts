import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfDeps } from "../src/cf-saas";
import { type CustomDomainRow, DOMAIN_LIMITS, refreshCustomDomains, retireAccountDomains } from "../src/custom-domains";
import { clearCustomHostCache } from "../src/custom-host";
import { type DomainAction, disableDomain, enableDomain, listDomainActions, purgeDomain, REASON_CODES } from "../src/domain-takedown";
import type { Env } from "../src/env";
import { LIMITS } from "../src/env";
import { governor } from "../src/governor";
import worker from "../src/index";
import { hmacHex, now, randomId } from "../src/util";
import { call, freshIp, mcp, seedAccount, seedReady, videoLinkOf, withEnv } from "./helpers";

const TOKEN = "cf_test_token_do_not_log";
const DAY = 86400;

// Fake Cloudflare: custom hostnames by id; `failDelete` makes DELETE fail with a 500.
const cf = { hosts: new Map<string, string>(), calls: [] as string[], failDelete: false };
let cfN = 0;
const real = cfDeps.fetch;
beforeEach(() => {
  cf.hosts.clear();
  cf.calls = [];
  cf.failDelete = false;
  clearCustomHostCache();
  cfDeps.fetch = async (input, init) => {
    const u = new URL(input);
    const path = u.pathname.replace("/client/v4/zones/zone_test", "");
    cf.calls.push(`${init.method} ${path}`);
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (init.method === "POST" && path === "/custom_hostnames") {
      const body = JSON.parse(String(init.body));
      const id = `cfh${++cfN}`;
      cf.hosts.set(id, body.hostname);
      return ok({ id, hostname: body.hostname, status: "pending", ssl: { status: "initializing" } });
    }
    const m = /^\/custom_hostnames\/([^/]+)$/.exec(path);
    if (m && init.method === "DELETE") {
      if (cf.failDelete) return Response.json({ success: false, errors: [{ code: 1000, message: "boom" }] }, { status: 500 });
      cf.hosts.delete(m[1]);
      return ok({ id: m[1] });
    }
    if (m && init.method === "GET") {
      const h = cf.hosts.get(m[1]);
      return h
        ? ok({ id: m[1], hostname: h, status: "pending", ssl: { status: "pending_validation" } })
        : Response.json({ success: false, errors: [{ code: 1436, message: "not found" }] }, { status: 404 });
    }
    return Response.json({ success: false, errors: [{ code: 7000, message: "no route" }] }, { status: 400 });
  };
});
afterEach(() => {
  cfDeps.fetch = real;
  vi.restoreAllMocks();
});

async function setup(over: Partial<Env> = {}) {
  const admin = await seedAccount(false);
  const customer = await seedAccount(false);
  await env.DB.prepare("UPDATE accounts SET plan = 'teams' WHERE id = ?").bind(customer.accountId).run();
  const E = withEnv({ CF_SAAS_API_TOKEN: TOKEN, CF_ZONE_ID: "zone_test", OWNER_ACCOUNT_IDS: `someone,${admin.accountId}`, ...over });
  return { admin, customer, E };
}

const dom = () => `ex${randomId(40).toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
const rowOf = (hostname: string) => env.DB.prepare("SELECT * FROM custom_domains WHERE hostname = ?").bind(hostname).first<CustomDomainRow>();
const actionsOf = async (hostname: string) =>
  (await env.DB.prepare("SELECT * FROM custom_domain_actions WHERE hostname = ? ORDER BY created_at, rowid").bind(hostname).all<DomainAction>()).results;
const deletes = () => cf.calls.filter((c) => c.startsWith("DELETE"));

async function insertRow(accountId: string, hostname: string, over: Partial<CustomDomainRow> = {}): Promise<CustomDomainRow> {
  const t = now();
  const row: CustomDomainRow = {
    id: randomId(128),
    account_id: accountId,
    hostname,
    cf_id: null,
    status: "active",
    cf_status: "active",
    ssl_status: "active",
    verification_errors: null,
    redirect_to: null,
    redirect_until: null,
    disabled_at: null,
    disabled_reason: null,
    live_at: t,
    checked_at: t,
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

/** A live row with a Cloudflare hostname in the fake. */
async function liveRow(accountId: string, hostname: string, over: Partial<CustomDomainRow> = {}) {
  const id = `cfh${++cfN}`;
  cf.hosts.set(id, hostname);
  return insertRow(accountId, hostname, { cf_id: id, ...over });
}

/** The Worker's fetch for a full URL on any host. */
async function at(url: string, e: Env, ip = freshIp(), method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = { "cf-connecting-ip": ip, "user-agent": "Mozilla/5.0 Chrome/140.0", origin: "https://evil.example" };
  const res = await worker.fetch(new Request(url, { method, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function toolsList(key: string | undefined, e: Env): Promise<{ name: string; description: string }[]> {
  const res = await call(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
    e,
  );
  return ((await res.json()) as any).result.tools;
}
const namesOf = async (key: string | undefined, e: Env) => (await toolsList(key, e)).map((t) => t.name);

/** tools/call's raw JSON-RPC answer. */
async function rawCall(name: string, args: Record<string, unknown>, key: string, e: Env) {
  const res = await call(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    },
    e,
  );
  return (await res.json()) as any;
}

/** A customer with a live custom domain and a public video on it. */
async function liveVideo() {
  const s = await setup();
  const customer = await seedAccount();
  await env.DB.prepare("UPDATE accounts SET plan = 'teams' WHERE id = ?").bind(customer.accountId).run();
  const h = `videos.${dom()}`;
  await liveRow(customer.accountId, h);
  const id = await seedReady(customer.accountId);
  expect((await mcp("share", { recording_id: id }, customer.key)).isError).toBe(false);
  const [, username, , slug] = new URL(await videoLinkOf(id)).pathname.split("/");
  return { ...s, customer, h, id, slug, username };
}

const ADMIN = [
  "admin_disable_custom_domain",
  "admin_enable_custom_domain",
  "admin_purge_custom_domain",
  "admin_list_custom_domains",
  "admin_domain_actions",
];

describe("admin tools are operator-only", () => {
  it("hidden from tools/list for everyone but OWNER_ACCOUNT_IDS accounts", async () => {
    const { admin, customer, E } = await setup();
    const anon = await namesOf(undefined, E);
    const theirs = await namesOf(customer.key, E);
    expect(theirs).toContain("set_custom_domain");
    for (const t of ADMIN) {
      expect(anon).not.toContain(t);
      expect(theirs).not.toContain(t);
    }
    const mine = await namesOf(admin.key, E);
    for (const t of ADMIN) expect(mine).toContain(t);
    // accounts.plan = 'owner' is not enough: only the env list.
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(customer.accountId).run();
    const owned = await namesOf(customer.key, E);
    for (const t of ADMIN) expect(owned).not.toContain(t);
  });

  it("a non-operator's call answers exactly like an unknown tool, and changes nothing", async () => {
    const { customer, E } = await setup();
    const h = `videos.${dom()}`;
    await liveRow(customer.accountId, h, { disabled_at: now(), disabled_reason: "other" });
    const unknown = await rawCall("no_such_tool", {}, customer.key, E);
    for (const name of ADMIN) {
      const r = await rawCall(name, { hostname: h, reason: "phishing", confirm: true }, customer.key, E);
      expect(r.error).toEqual({ code: unknown.error.code, message: `Unknown tool: ${name}` });
      expect(r.result).toBeUndefined();
    }
    expect((await rowOf(h))!.disabled_reason).toBe("other");
    expect(await actionsOf(h)).toEqual([]);
    expect(cf.calls).toEqual([]);
    expect((await mcp(ADMIN[0], { hostname: h, reason: "phishing" }, undefined, E)).status).toBe(401);
  });
});

describe("disable -> enable is reversible with no customer action", () => {
  it("neutral 451 on every path, then the same video page serves 200 again; Cloudflare is never called", async () => {
    const { admin, E, h, slug, username, customer } = await liveVideo();
    const page = `https://${h}/${slug}`;
    expect((await at(page, E)).status).toBe(200); // warms this isolate's cache with the live row

    const warn = vi.spyOn(console, "warn");
    const d = await mcp(
      "admin_disable_custom_domain",
      { hostname: `https://${h.toUpperCase()}/`, reason: "phishing", note: "report #12 SECRET-NOTE" },
      admin.key,
      E,
    );
    expect(d.isError).toBe(false);
    expect(d.data).toMatchObject({
      domain: { hostname: h, account_id: customer.accountId, status: "active", disabled: true, reason: "phishing", on_cloudflare: true },
      already: false,
      also_disabled: [],
    });
    const row = (await rowOf(h))!;
    expect(row).toMatchObject({ disabled_reason: "phishing", status: "active" });
    expect(row.cf_id).not.toBeNull();

    const paths = [`/${slug}`, `/${slug}/b`, `/m/${slug}`, `/b/${"a".repeat(64)}`, "/s/player.js", "/favicon.ico", "/robots.txt", "/", "/mcp", "/%2e%2e/x"];
    for (const p of paths) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const res = await at(`https://${h}${p}`, E, freshIp(), method);
        expect(res.status, `${method} ${p}`).toBe(451);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
        expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = await res.text();
        if (method === "HEAD") expect(body).toBe("");
        else {
          expect(body).toContain("This page is unavailable.");
          for (const leak of [slug, username, "Recitbot", "phishing", "report #12", h]) expect(body, `${p} leaks ${leak}`).not.toContain(leak);
        }
      }
    }
    // The customer can't change or remove it meanwhile.
    expect((await mcp("set_custom_domain", { hostname: `watch.${dom()}` }, customer.key, E)).data.error).toBe("DOMAIN_DISABLED");
    expect((await mcp("remove_custom_domain", {}, customer.key, E)).data.error).toBe("DOMAIN_DISABLED");

    const e = await mcp("admin_enable_custom_domain", { hostname: h, note: "false alarm" }, admin.key, E);
    expect(e.data).toMatchObject({ changed: true, domain: { status: "active", disabled: false, reason: null, on_cloudflare: true } });
    expect((await at(page, E)).status).toBe(200);
    expect((await rowOf(h))!.cf_id).toBe(row.cf_id);

    expect(deletes()).toEqual([]);
    expect(cf.calls).toEqual([]);
    const log = await actionsOf(h);
    expect(log.map((a) => [a.action, a.reason_code, a.note, a.actor_account_id, a.account_id])).toEqual([
      ["disable", "phishing", "report #12 SECRET-NOTE", admin.accountId, customer.accountId],
      ["enable", null, "false alarm", admin.accountId, customer.accountId],
    ]);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("takedown: custom domain disabled") && l.includes(h) && l.includes(admin.accountId))).toBe(true);
    expect(lines.some((l) => l.includes("takedown: custom domain enabled"))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain(admin.key);
      expect(l).not.toContain("SECRET-NOTE");
    }
  });

  it("the reason is required and must be one of the codes; notes are capped", async () => {
    const { admin, customer, E } = await setup();
    const h = `videos.${dom()}`;
    await liveRow(customer.accountId, h);
    const bad = [{ hostname: h }, { hostname: h, reason: "spam" }, { hostname: h, reason: "" }, { hostname: h, reason: "phishing", note: "x".repeat(1001) }];
    for (const args of bad) {
      expect((await mcp("admin_disable_custom_domain", args, admin.key, E)).data.error).toBe("INVALID_ARGUMENTS");
    }
    expect((await rowOf(h))!.disabled_at).toBeNull();
    for (const reason of REASON_CODES) {
      const r = await mcp("admin_disable_custom_domain", { hostname: h, reason }, admin.key, E);
      expect(r.data.domain.reason).toBe(reason);
    }
    const log = await actionsOf(h);
    expect(log.map((a) => a.reason_code)).toEqual(["csam", "phishing", "malware", "impersonation", "other"]);
    // disabled_at stays the first disable's; the code is the latest.
    expect((await rowOf(h))!.disabled_at).toBe(log[0].created_at);
  });

  it("disableDomain / enableDomain called directly (the contract other tools build on)", async () => {
    const { customer } = await setup();
    const h = `videos.${dom()}`;
    await liveRow(customer.accountId, h);
    await expect(disableDomain(env, { hostname: h, reason: "spam", actor: "x" })).rejects.toMatchObject({ code: "INVALID_REASON" });
    await expect(disableDomain(env, { hostname: h, reason: "malware", actor: "" })).rejects.toMatchObject({ code: "ACTOR_REQUIRED" });
    await expect(disableDomain(env, { hostname: `nope.${dom()}`, reason: "malware", actor: "bot" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(disableDomain(env, { hostname: h, reason: "malware", actor: "bot", note: "x".repeat(1001) })).rejects.toMatchObject({ code: "NOTE_TOO_LONG" });
    await expect(disableDomain(env, { hostname: h, reason: "malware", actor: "bot", evidence: { blob: "x".repeat(20_000) } })).rejects.toMatchObject({
      code: "EVIDENCE_TOO_LARGE",
    });
    expect(await actionsOf(h)).toEqual([]);
    const evidence = { url: `https://${h}/x`, score: 0.98 };
    const d = await disableDomain(env, { hostname: h, reason: "malware", actor: "auto-mode", evidence });
    expect(d).toMatchObject({ already: false, domain: { disabled_reason: "malware", status: "active" } });
    expect((await disableDomain(env, { hostname: h, reason: "malware", actor: "auto-mode" })).already).toBe(true);
    const list = await listDomainActions(env, { hostname: `HTTPS://${h.toUpperCase()}/` });
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ id: d.action_id, action: "disable", actor_account_id: "auto-mode", evidence: JSON.stringify(evidence) });
    const en = await enableDomain(env, { hostname: h, actor: "owner" });
    expect(en).toMatchObject({ changed: true, domain: { disabled_at: null, status: "active" } });
    expect(await enableDomain(env, { hostname: h, actor: "owner" })).toMatchObject({ changed: false, action_id: null });
    expect((await listDomainActions(env, { hostname: h })).map((a) => a.action)).toEqual(["enable", "disable", "disable"]);
    expect(cf.calls).toEqual([]);
  });

  it("suspend_account also disables the account's other hostnames, each reversible", async () => {
    const { admin, customer, E } = await setup();
    const d = dom();
    await liveRow(customer.accountId, `videos.${d}`);
    await insertRow(customer.accountId, `old.${d}`, { status: "redirecting", redirect_to: `videos.${d}`, redirect_until: now() + DAY });
    const r = await mcp("admin_disable_custom_domain", { hostname: `old.${d}`, reason: "impersonation", suspend_account: true }, admin.key, E);
    expect(r.data.also_disabled).toEqual([`videos.${d}`]);
    expect(await rowOf(`videos.${d}`)).toMatchObject({ status: "active", disabled_reason: "impersonation" });
    expect(await rowOf(`old.${d}`)).toMatchObject({ status: "redirecting", redirect_to: `videos.${d}`, disabled_reason: "impersonation" });
    expect((await at(`https://videos.${d}/robots.txt`, E)).status).toBe(451);
    expect((await at(`https://old.${d}/abcdefghij12`, E)).status).toBe(451);
    for (const h of [`old.${d}`, `videos.${d}`]) await mcp("admin_enable_custom_domain", { hostname: h }, admin.key, E);
    expect(await rowOf(`videos.${d}`)).toMatchObject({ status: "active", disabled_at: null });
    expect(await rowOf(`old.${d}`)).toMatchObject({ status: "redirecting", redirect_to: `videos.${d}`, disabled_at: null });
    expect((await at(`https://videos.${d}/robots.txt`, E)).status).toBe(200);
    expect(deletes()).toEqual([]);
  });

  it("works while the service is read-only; an unknown hostname is NOT_FOUND", async () => {
    const { admin, customer, E } = await setup({ SERVICE_MODE: "READ_ONLY" } as Partial<Env>);
    const h = `videos.${dom()}`;
    await liveRow(customer.accountId, h);
    expect((await mcp("admin_disable_custom_domain", { hostname: h, reason: "other" }, admin.key, E)).isError).toBe(false);
    expect((await mcp("admin_disable_custom_domain", { hostname: `x.${dom()}`, reason: "other" }, admin.key, E)).data.error).toBe("NOT_FOUND");
  });

  it("the cron never refreshes, fails or deletes a disabled row, and never deletes its Cloudflare hostname", async () => {
    const { customer, E } = await setup();
    const d = dom();
    const t = now();
    const p = await liveRow(customer.accountId, `p.${d}`, { status: "pending", live_at: null, created_at: t - 8 * DAY, disabled_at: t, disabled_reason: "other" });
    await insertRow(customer.accountId, `r.${d}`, { status: "redirecting", redirect_to: "example.test", redirect_until: t - 1, disabled_at: t, disabled_reason: "other" });
    await insertRow(customer.accountId, `f.${d}`, { status: "failed", updated_at: t - 2 * DAY, disabled_at: t, disabled_reason: "other" });
    await refreshCustomDomains(E, t);
    expect(cf.calls.filter((c) => c.includes(p.cf_id!))).toEqual([]);
    expect(await rowOf(`p.${d}`)).toMatchObject({ status: "pending", cf_id: p.cf_id, disabled_reason: "other" });
    expect(await rowOf(`r.${d}`)).toMatchObject({ status: "redirecting" });
    expect(await rowOf(`f.${d}`)).toMatchObject({ status: "failed" });
    for (const h of [`p.${d}`, `r.${d}`, `f.${d}`]) expect((await at(`https://${h}/`, E)).status, h).toBe(451);
  });
});

describe("admin_purge_custom_domain (irreversible)", () => {
  it("needs the domain disabled first and confirm: true; then deletes the Cloudflare hostname exactly once", async () => {
    const { admin, customer, E } = await setup();
    const h = `videos.${dom()}`;
    const row = await liveRow(customer.accountId, h);
    const purgeTool = (await toolsList(admin.key, E)).find((t) => t.name === "admin_purge_custom_domain")!;
    expect(purgeTool.description).toMatch(/^IRREVERSIBLE:/);

    expect((await mcp("admin_purge_custom_domain", { hostname: h, confirm: true }, admin.key, E)).data.error).toBe("NOT_DISABLED");
    await mcp("admin_disable_custom_domain", { hostname: h, reason: "csam" }, admin.key, E);
    for (const args of [{ hostname: h }, { hostname: h, confirm: false }, { hostname: h, confirm: "true" }]) {
      expect((await mcp("admin_purge_custom_domain", args, admin.key, E)).data.error).toBe("INVALID_ARGUMENTS");
    }
    await expect(purgeDomain(env, { hostname: h, actor: "x", confirm: false })).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    expect(deletes()).toEqual([]);

    // Cloudflare refusing: nothing changes, nothing logged.
    cf.failDelete = true;
    expect((await mcp("admin_purge_custom_domain", { hostname: h, confirm: true }, admin.key, E)).data.error).toBe("CLOUDFLARE_ERROR");
    expect((await rowOf(h))!.cf_id).toBe(row.cf_id);
    expect((await actionsOf(h)).map((a) => a.action)).toEqual(["disable"]);
    cf.failDelete = false;
    cf.calls = [];

    const p = await mcp("admin_purge_custom_domain", { hostname: h, confirm: true, note: "final" }, admin.key, E);
    expect(p.data).toMatchObject({ domain: { status: "failed", disabled: true, reason: "csam", on_cloudflare: false } });
    expect(deletes()).toEqual([`DELETE /custom_hostnames/${row.cf_id}`]);
    expect(cf.hosts.has(row.cf_id!)).toBe(false);
    expect((await at(`https://${h}/`, E)).status).toBe(451);

    // Enabling afterwards can't bring it back (and calls nothing).
    const e = await mcp("admin_enable_custom_domain", { hostname: h }, admin.key, E);
    expect(e.data.message).toMatch(/purged/);
    expect((await at(`https://${h}/`, E)).status).toBe(404);
    expect(deletes()).toHaveLength(1);
    expect((await actionsOf(h)).map((a) => [a.action, a.reason_code, a.note])).toEqual([
      ["disable", "csam", null],
      ["purge", "csam", "final"],
      ["enable", null, null],
    ]);
  });

  it("custom domains off: purge refuses and changes nothing", async () => {
    const { admin, customer, E } = await setup({ CF_SAAS_API_TOKEN: undefined });
    const h = `videos.${dom()}`;
    await liveRow(customer.accountId, h, { disabled_at: now(), disabled_reason: "other" });
    expect((await mcp("admin_purge_custom_domain", { hostname: h, confirm: true }, admin.key, E)).data.error).toBe("CUSTOM_DOMAINS_OFF");
    expect((await rowOf(h))!.cf_id).not.toBeNull();
    expect(cf.calls).toEqual([]);
  });
});

describe("the action log is append-only", () => {
  it("survives purge, retire, the cron and deleting the domain row; admin_domain_actions reads it", async () => {
    const { admin, customer, E } = await setup();
    const h = `videos.${dom()}`;
    await liveRow(customer.accountId, h);
    await mcp("admin_disable_custom_domain", { hostname: h, reason: "malware", note: "n1" }, admin.key, E);
    await mcp("admin_purge_custom_domain", { hostname: h, confirm: true }, admin.key, E);
    await retireAccountDomains(env, customer.accountId);
    await refreshCustomDomains(E, now() + 400 * DAY);
    await env.DB.prepare("DELETE FROM custom_domains WHERE hostname = ?").bind(h).run();
    expect((await actionsOf(h)).map((a) => a.action)).toEqual(["disable", "purge"]);

    const r = await mcp("admin_domain_actions", { hostname: h }, admin.key, E);
    expect(r.data.count).toBe(2);
    expect(r.data.actions.map((a: any) => a.action)).toEqual(["purge", "disable"]);
    expect(r.data.actions[1]).toMatchObject({ reason_code: "malware", note: "n1", actor_account_id: admin.accountId, account_id: customer.accountId });
    const all = await mcp("admin_domain_actions", { limit: 500 }, admin.key, E);
    expect(all.data.actions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("admin_list_custom_domains", () => {
  it("lists newest first, filters by status or disabled, caps with limit", async () => {
    const { admin, customer, E } = await setup();
    const d = dom();
    const t = now() + 1000; // newer than anything else in this file
    await insertRow(customer.accountId, `a.${d}`, { created_at: t });
    await insertRow(customer.accountId, `b.${d}`, { status: "redirecting", redirect_to: "example.test", redirect_until: t + DAY, created_at: t + 1 });
    await insertRow(customer.accountId, `c.${d}`, { status: "failed", created_at: t + 2, disabled_at: t, disabled_reason: "other" });
    const all = await mcp("admin_list_custom_domains", { limit: 3 }, admin.key, E);
    expect(all.data.domains.map((x: any) => x.hostname)).toEqual([`c.${d}`, `b.${d}`, `a.${d}`]);
    expect(all.data.message).toMatch(/more may exist/);
    const dis = await mcp("admin_list_custom_domains", { status: "disabled" }, admin.key, E);
    expect(dis.data.domains.map((x: any) => x.hostname)).toContain(`c.${d}`);
    expect(dis.data.domains.every((x: any) => x.disabled)).toBe(true);
    const red = await mcp("admin_list_custom_domains", { status: "redirecting" }, admin.key, E);
    expect(red.data.domains.every((x: any) => x.status === "redirecting")).toBe(true);
    expect((await mcp("admin_list_custom_domains", { status: "bogus" }, admin.key, E)).data.error).toBe("INVALID_ARGUMENTS");
  });
});

describe("view caps on customer hosts", () => {
  it("the per-viewer daily cap (governor checkView) applies to a custom-host page like any other", async () => {
    const { h, id, slug } = await liveVideo();
    const ip = freshIp();
    expect((await at(`https://${h}/${slug}`, env, ip)).status).toBe(200);
    const viewer = (await hmacHex(env.IP_HASH_KEY, `ip:${ip}`)).slice(0, 32);
    const g = governor(env);
    for (let i = 1; i < LIMITS.viewsPerViewerPerVideoPerDay; i++) await g.checkView(id, viewer, now(), 1e9, 1e9);
    const res = await at(`https://${h}/${slug}`, env, ip);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Too many reloads");
    expect((await at(`https://${h}/${slug}`, env)).status).toBe(200);
  });
});

// Last in the file: it fills this hour's global counter.
describe("global hourly cap on set_custom_domain", () => {
  it("refuses once the hour's Cloudflare-reaching sets are used up, before any Cloudflare call", async () => {
    const { customer, E } = await setup();
    await governor(env).hit("cdset:global:hour", 1e9, 3600, now(), true, DOMAIN_LIMITS.setsPerHour);
    const r = await mcp("set_custom_domain", { hostname: `videos.${dom()}` }, customer.key, E);
    expect(r.data).toMatchObject({ error: "RATE_LIMITED", message: expect.stringMatching(/being set up right now\. Try again in \d+ minutes?/) });
    expect(r.data.retry_after).toBeGreaterThan(0);
    expect(cf.calls).toEqual([]);
    expect((await governor(env).hit(`cdset:${customer.accountId}`, DOMAIN_LIMITS.setsPerAccountPerDay, DAY, now(), false)).ok).toBe(true);
  });
});
