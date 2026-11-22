import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getConfig, REQUIRED_SECRETS } from "../src/config";
import type { Env } from "../src/env";
import { classifyHost } from "../src/hosts";
import { issuerFor } from "../src/oauth/hosts";
import { homeEnv } from "./home-fixture";
import { call, withEnv } from "./helpers";

/** The test config (wrangler.test.jsonc) minus every optional operator value: a bare self-host. */
const bare = (over: Partial<Env> = {}) =>
  withEnv({
    PUBLIC_BASE_URL: undefined,
    MCP_BASE_URL: undefined,
    SITE_HOSTNAMES: undefined,
    SITE_ZONE: undefined,
    HOME_SITE_ENABLED: undefined,
    OPERATOR_NAME: undefined,
    OPERATOR_URL: undefined,
    LEGAL_ENTITY_NAME: undefined,
    STATEMENT_DESCRIPTOR: undefined,
    TEMPLATE_URL: undefined,
    BLOCKED_COUNTRIES: undefined,
    EMAIL_FROM: undefined,
    SUPPORT_EMAIL: undefined,
    ABUSE_EMAIL: undefined,
    BRAND_NAME: undefined,
    CUSTOM_DOMAIN_CNAME_TARGET: undefined,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_PRICE_ID: undefined,
    STRIPE_TEAMS_PRICE_ID: undefined,
    STRIPE_TEAMS_YEARLY_PRICE_ID: undefined,
    STRIPE_PORTAL_CONFIG_ID: undefined,
    STRIPE_STORAGE_ADDON_PRICE_ID: undefined,
    ...over,
  });

describe("getConfig", () => {
  it("reads the test deployment: hosts, zone, contacts, features", () => {
    const c = getConfig(env);
    expect(c.errors).toEqual([]);
    expect(c.devMode).toBe(true);
    expect(c.site.publicBaseUrl).toBeNull();
    expect(c.site.canonicalBaseUrl).toBe("https://example.test");
    expect(c.site.canonicalHost).toBe("example.test");
    expect(c.site.mcpBaseUrl).toBe("https://mcp.example.test");
    expect([...c.site.hostnames].sort()).toEqual(["example.test", "mcp.example.test", "www.example.test"]);
    expect([...c.site.oauthHosts]).toEqual(["example.test", "mcp.example.test"]);
    expect(c.site.zone).toBe("example.test");
    expect(c.site.brandName).toBe("Recitbot");
    expect(c.site.supportEmail).toBe("hello@example.test");
    expect(c.site.abuseEmail).toBe("abuse@example.test");
    expect(c.site.homeUrl).toBe("https://example.test");
    expect(c.site.homeSiteEnabled).toBe(true);
    expect(c.site.homeValues).toEqual({
      OPERATOR_NAME: "Example Operator",
      OPERATOR_URL: "https://operator.example.test",
      LEGAL_ENTITY_NAME: "Example & Sons Ltd.",
      STATEMENT_DESCRIPTOR: "EXAMPLE* VIDEO",
      TEMPLATE_URL: "https://bots.example.test/add/recorder",
      SUPPORT_EMAIL: "hello@example.test",
      ABUSE_EMAIL: "abuse@example.test",
      SITE_HOST: "example.test",
    });
    expect(c.site.docsUrl).toBe("https://example.test/docs/mcp");
    expect(c.site.blockedCountries.size).toBe(31);
    expect(c.email).toEqual({ enabled: true, from: "hello@example.test", fromName: "Recitbot" });
    expect(c.turnstile).toMatchObject({ enabled: true, signinCheckDisabled: false });
    expect(c.billing.enabled).toBe(true);
    expect(c.billing.proPriceId).toBe("price_PLACEHOLDER_PRO");
    expect(c.billing.portalConfigId).toBe("bpc_PLACEHOLDER");
    expect(c.customDomains).toEqual({ enabled: false, zoneId: null, cnameTarget: "customers.example.test" });
  });

  it("is frozen and parsed once per env object", () => {
    const e = withEnv({});
    const c = getConfig(e);
    expect(getConfig(e)).toBe(c);
    expect(Object.isFrozen(c) && Object.isFrozen(c.site) && Object.isFrozen(c.billing)).toBe(true);
    expect(getConfig(withEnv({ BRAND_NAME: "Acme Video" })).site.brandName).toBe("Acme Video");
  });

  it("a bare self-host: every optional value unset is fine, features off, no errors", () => {
    const c = getConfig(bare({ DEV_MODE: "false" }));
    expect(c.errors).toEqual([]);
    expect(c.site).toMatchObject({
      publicBaseUrl: null,
      canonicalBaseUrl: null,
      canonicalHost: null,
      mcpBaseUrl: null,
      zone: null,
      brandName: null,
      supportEmail: null,
      abuseEmail: null,
      homeUrl: null,
      homeSiteEnabled: false,
      homeValues: null,
      docsUrl: null,
    });
    expect(c.site.hostnames.size).toBe(0);
    expect(c.site.blockedCountries.size).toBe(0);
    expect(c.email.enabled).toBe(false);
    expect(c.billing).toEqual({
      enabled: false,
      proPriceId: null,
      proYearlyPriceId: null,
      teamsPriceId: null,
      teamsYearlyPriceId: null,
      storageAddonPriceId: null,
      portalConfigId: null,
    });
    expect(c.customDomains.enabled).toBe(false);
    expect(c.warnings.join(" ")).toMatch(/PUBLIC_BASE_URL is not set/);
    expect(c.warnings.join(" ")).toMatch(/EMAIL_FROM is not set/);
  });

  it("PUBLIC_BASE_URL: the origin, its host is ours and the default zone, and SUPPORT/ABUSE fall back to EMAIL_FROM", () => {
    const c = getConfig(bare({ PUBLIC_BASE_URL: "https://videos.acme.example.com/ignored/path", EMAIL_FROM: "rec@acme.example.com" }));
    expect(c.site.publicBaseUrl).toBe("https://videos.acme.example.com");
    expect(c.site.canonicalBaseUrl).toBe("https://videos.acme.example.com");
    expect(c.site.hostnames.has("videos.acme.example.com")).toBe(true);
    expect(c.site.zone).toBe("videos.acme.example.com");
    expect(c.site.supportEmail).toBe("rec@acme.example.com");
    expect(c.site.abuseEmail).toBe("rec@acme.example.com");
    expect(c.site.homeUrl).toBe("https://videos.acme.example.com");
  });

  it("required secrets and malformed values are errors (names only, never values)", () => {
    const c = getConfig(
      withEnv({ SHARE_HMAC_KEY: "", INSTALLER_URL_KEY: undefined, PUBLIC_BASE_URL: "http://plain.example.com", EMAIL_FROM: "not-an-email", BLOCKED_COUNTRIES: "Germany" } as Partial<Env>),
    );
    expect(c.errors).toEqual([
      "SHARE_HMAC_KEY is not set (secret; required).",
      "INSTALLER_URL_KEY is not set (secret; required).",
      "PUBLIC_BASE_URL must be an https:// URL (an origin, like https://videos.example.com).",
      "EMAIL_FROM is not an email address.",
      "BLOCKED_COUNTRIES must be two-letter country codes (or EU_EEA_UK), comma-separated.",
    ]);
    expect(REQUIRED_SECRETS).toEqual(["SHARE_HMAC_KEY", "UPLOAD_HMAC_KEY", "DEVICE_CMD_KEY", "IP_HASH_KEY", "INSTALLER_URL_KEY"]);
    // Loopback is fine for dev.
    expect(getConfig(withEnv({ PUBLIC_BASE_URL: "http://127.0.0.1:8787" })).site.publicBaseUrl).toBe("http://127.0.0.1:8787");
  });

  it("a misconfigured deployment answers every request with what to fix, never a value", async () => {
    const secret = "do-not-print-this-value";
    const res = await call("/mcp", { method: "POST", body: "{}" }, withEnv({ SHARE_HMAC_KEY: "", PUBLIC_BASE_URL: `ftp://${secret}` }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("This server is not configured correctly");
    expect(text).toContain("SHARE_HMAC_KEY is not set");
    expect(text).toContain("PUBLIC_BASE_URL must be an https:// URL");
    expect(text).not.toContain(secret);
  });

  it("billing: on only with the secret key, the webhook secret and the Pro price together; ids are null when off", () => {
    const all = { STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh", STRIPE_PRO_PRICE_ID: "p1", STRIPE_PORTAL_CONFIG_ID: "pc" };
    expect(getConfig(bare(all)).billing).toMatchObject({ enabled: true, proPriceId: "p1", portalConfigId: "pc" });
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID"] as const) {
      const c = getConfig(bare({ ...all, [k]: undefined }));
      expect(c.billing, k).toMatchObject({ enabled: false, proPriceId: null, portalConfigId: null });
      expect(c.warnings.join(" "), k).toMatch(/Billing is off/);
    }
  });

  it("custom domains: on only with token, zone id, CNAME target and a canonical host", () => {
    const all = { CF_SAAS_API_TOKEN: "t", CF_ZONE_ID: "z", CUSTOM_DOMAIN_CNAME_TARGET: "Customers.Acme.Example.COM.", PUBLIC_BASE_URL: "https://acme.example.com" };
    expect(getConfig(bare(all)).customDomains).toEqual({ enabled: true, zoneId: "z", cnameTarget: "customers.acme.example.com" });
    for (const k of ["CF_SAAS_API_TOKEN", "CF_ZONE_ID", "CUSTOM_DOMAIN_CNAME_TARGET", "PUBLIC_BASE_URL"] as const) {
      const c = getConfig(bare({ ...all, [k]: undefined }));
      expect(c.customDomains.enabled, k).toBe(false);
      expect(c.customDomains.zoneId, k).toBeNull();
      expect(c.warnings.join(" "), k).toMatch(/Custom domains are off/);
    }
  });

  it("homepage: on only with every value its pages name; a bad link is an error", () => {
    for (const k of ["OPERATOR_NAME", "OPERATOR_URL", "LEGAL_ENTITY_NAME", "STATEMENT_DESCRIPTOR", "TEMPLATE_URL"] as const) {
      const c = getConfig(withEnv({ [k]: undefined }));
      expect(c.site, k).toMatchObject({ homeSiteEnabled: false, homeValues: null, docsUrl: null });
      expect(c.warnings.join(" "), k).toContain(`The homepage is off: HOME_SITE_ENABLED also needs ${k}.`);
    }
    expect(getConfig(bare({ HOME_SITE_ENABLED: "true" })).warnings.join(" ")).toContain("SUPPORT_EMAIL, ABUSE_EMAIL, PUBLIC_BASE_URL (or SITE_HOSTNAMES)");
    expect(getConfig(withEnv({ HOME_SITE_ENABLED: undefined, OPERATOR_NAME: undefined })).warnings.join(" ")).not.toContain("homepage");
    expect(getConfig(withEnv({ OPERATOR_URL: "javascript:alert(1)" })).errors).toEqual([expect.stringMatching(/^OPERATOR_URL must be an https:/)]);
  });

  it("turnstile: both keys = on; TURNSTILE_DISABLED only skips the sign-in check while no keys are set", () => {
    const none = { TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined };
    expect(getConfig(withEnv(none)).turnstile).toEqual({ enabled: false, siteKey: null, signinCheckDisabled: false });
    expect(getConfig(withEnv({ ...none, TURNSTILE_DISABLED: "true" })).turnstile).toEqual({ enabled: false, siteKey: null, signinCheckDisabled: true });
    expect(getConfig(withEnv({ TURNSTILE_DISABLED: "true" })).turnstile.signinCheckDisabled).toBe(false);
    expect(getConfig(withEnv({ TURNSTILE_SECRET_KEY: undefined })).turnstile.enabled).toBe(false);
  });

  it("signups: closed only by exactly \"true\"", () => {
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", "false", " true"]) {
      expect(getConfig(withEnv({ SIGNUPS_DISABLED: v })).auth.signupsDisabled, String(v)).toBe(false);
    }
    expect(getConfig(withEnv({ SIGNUPS_DISABLED: "true" })).auth.signupsDisabled).toBe(true);
    // The test deployment leaves signups open.
    expect(getConfig(env).auth.signupsDisabled).toBe(false);
  });

  it("signup allowlist: trimmed and lowercased, only while signups are closed; warns when it can't apply", () => {
    const closed = getConfig(withEnv({ SIGNUPS_DISABLED: "true", SIGNUPS_ALLOWLIST: " A@Example.com , ,b@example.com " }));
    expect(closed.auth.signupAllowlist).toEqual(["a@example.com", "b@example.com"]);
    expect(closed.warnings.join(" ")).not.toContain("SIGNUPS_ALLOWLIST");
    const open = getConfig(withEnv({ SIGNUPS_DISABLED: undefined, SIGNUPS_ALLOWLIST: "a@example.com" }));
    expect(open.auth.signupAllowlist).toEqual([]);
    expect(open.warnings.join(" ")).toContain("SIGNUPS_ALLOWLIST is set but SIGNUPS_DISABLED is not exactly");
    expect(getConfig(withEnv({ SIGNUPS_DISABLED: "true", SIGNUPS_ALLOWLIST: "not-an-email" })).warnings.join(" ")).toContain("not an email address");
    expect(getConfig(withEnv({ SIGNUPS_DISABLED: "true", SIGNUPS_ALLOWLIST: undefined })).auth.signupAllowlist).toEqual([]);
    expect(getConfig(env).auth.signupAllowlist).toEqual([]);
  });

  it("logs each warning once per isolate, names only", async () => {
    // A fresh module = a fresh isolate's state.
    vi.resetModules();
    const fresh = await import("../src/config");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const over = { STRIPE_SECRET_KEY: "do-not-print-this-value" };
      const e = bare({ DEV_MODE: "false", ...over });
      const { warnings } = fresh.getConfig(e);
      expect(warnings.length).toBeGreaterThan(1);
      const lines = () => warn.mock.calls.map((c) => c.join(" "));
      expect(lines()).toEqual(warnings.map((w) => `config: ${w}`));
      expect(lines().join("\n")).not.toContain(over.STRIPE_SECRET_KEY);
      fresh.getConfig(e);
      fresh.getConfig({ ...e });
      expect(warn).toHaveBeenCalledTimes(warnings.length);
    } finally {
      warn.mockRestore();
    }
  });

  it("OWNER_ACCOUNT_IDS: trimmed, empties and the deploy placeholder dropped", () => {
    expect(getConfig(withEnv({ OWNER_ACCOUNT_IDS: " a , ,__SET_BY_DEPLOY__,b" })).auth.ownerAccountIds).toEqual(["a", "b"]);
  });
});

describe("hosts and issuer from config", () => {
  it("our hosts, reserved names and customer hosts follow SITE_HOSTNAMES / SITE_ZONE / PUBLIC_BASE_URL", () => {
    const e = bare({ DEV_MODE: "false", PUBLIC_BASE_URL: "https://videos.acme.example.com", SITE_ZONE: "acme.example.com", MCP_BASE_URL: "https://mcp.acme.example.com" });
    expect(classifyHost("videos.acme.example.com", e)).toBe("ours");
    expect(classifyHost("mcp.acme.example.com", e)).toBe("ours");
    expect(classifyHost("anything.acme.example.com", e)).toBe("reserved");
    expect(classifyHost("acme.example.com", e)).toBe("reserved");
    expect(classifyHost("x.workers.dev", e)).toBe("ours");
    expect(classifyHost("example.test", e)).toBe("customer");
    expect(classifyHost("videos.customer.com", e)).toBe("customer");
  });

  it("OAuth issuer: our public hosts are their own; other hosts use MCP_BASE_URL, then PUBLIC_BASE_URL, then their origin", () => {
    const e = bare({ PUBLIC_BASE_URL: "https://videos.acme.example.com", MCP_BASE_URL: "https://mcp.acme.example.com" });
    expect(issuerFor(e, new URL("https://videos.acme.example.com/mcp"))).toBe("https://videos.acme.example.com");
    expect(issuerFor(e, new URL("https://x.example.workers.dev/mcp"))).toBe("https://mcp.acme.example.com");
    expect(issuerFor(bare({ PUBLIC_BASE_URL: "https://videos.acme.example.com" }), new URL("https://x.example.workers.dev/mcp"))).toBe("https://videos.acme.example.com");
    expect(issuerFor(bare(), new URL("https://x.example.workers.dev/mcp"))).toBe("https://x.example.workers.dev");
  });

  it("OAuth discovery leaves out the documentation link when there is none", async () => {
    const meta = (await (await call("/.well-known/oauth-protected-resource", {}, bare())).json()) as Record<string, unknown>;
    expect(meta.resource_documentation).toBeUndefined();
    expect(meta.resource_name).toBeUndefined(); // no BRAND_NAME
    const ours = (await (await call("/.well-known/oauth-protected-resource")).json()) as Record<string, unknown>;
    expect(ours.resource_documentation).toBe("https://example.test/docs/mcp");
  });
});

describe("homepage gate (HOME_SITE_ENABLED)", () => {
  it("off: / and the homepage's pages are 404; the Worker's own static files still load", async () => {
    const off = homeEnv({ HOME_SITE_ENABLED: undefined });
    for (const p of ["/", "/terms/", "/terms", "/privacy/", "/index.html", "/eu/"]) {
      const res = await call(p, {}, off);
      expect(res.status, p).toBe(404);
      await res.body?.cancel();
    }
    const css = await call("/s/recitbot.css", {}, off);
    expect(css.status).toBe(200);
    await css.body?.cancel();
  });

  it("on: / and /terms/ are served", async () => {
    for (const p of ["/", "/terms/"]) {
      const res = await call(p, {}, homeEnv());
      expect(res.status, p).toBe(200);
      await res.body?.cancel();
    }
  });
});
