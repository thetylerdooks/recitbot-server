// The deployment's configuration: every operator-specific value (hosts, brand, contact addresses, Stripe ids, custom
// domain zone, geo policy) comes from wrangler vars / secrets through here, never from a literal in src. Each self-host
// deploys this Worker to its own Cloudflare account; its setup bot fills in the vars (SELFHOST_CONFIG.md lists them all,
// worker/wrangler.example.jsonc is the template).
//
// getConfig(env) parses once per env object (the runtime hands the same object to every request of an isolate; tests
// pass spread copies) and returns a frozen object. It never throws: problems that make the deployment unusable are in
// `errors` (index.ts answers every request with them, names only, never values), the rest in `warnings` (logged once per
// isolate, and in admin_overview).
// Secret VALUES are never copied into the config: it only says whether a secret is present.
import type { Env } from "./env";

/** EU (27) + EEA (IS, LI, NO) + UK, for BLOCKED_COUNTRIES="EU_EEA_UK". */
export const EU_EEA_UK: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
  "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB",
];

/** Secrets every deployment needs (wrangler secret put; .dev.vars locally). Missing = the Worker refuses requests. */
export const REQUIRED_SECRETS = ["SHARE_HMAC_KEY", "UPLOAD_HMAC_KEY", "DEVICE_CMD_KEY", "IP_HASH_KEY", "INSTALLER_URL_KEY"] as const;

/** OWNER_CLAIM_SECRET must be at least this long (32 random bytes are 43 characters as base64url, 64 as hex). */
export const CLAIM_SECRET_MIN = 32;

/** The {{MARKERS}} in the homepage files (worker/home) that home.ts fills in; scripts/home-markers.mjs is the reverse. */
export type HomeMarker =
  | "OPERATOR_NAME"
  | "OPERATOR_URL"
  | "LEGAL_ENTITY_NAME"
  | "STATEMENT_DESCRIPTOR"
  | "TEMPLATE_URL"
  | "SUPPORT_EMAIL"
  | "ABUSE_EMAIL"
  | "SITE_HOST";

export type SiteConfig = Readonly<{
  /** PUBLIC_BASE_URL's origin: every absolute link the Worker hands out. null = the request's origin. */
  publicBaseUrl: string | null;
  /**
   * Where links go when there is no request origin to use (customer-host redirects, emails, report links):
   * publicBaseUrl, else https://<first SITE_HOSTNAMES entry>, else null.
   */
  canonicalBaseUrl: string | null;
  /** canonicalBaseUrl's hostname (also custom_domains.redirect_to for "back to our own links"). */
  canonicalHost: string | null;
  /** MCP_BASE_URL's origin: the OAuth issuer for requests on hosts that aren't oauthHosts. null = the request's origin. */
  mcpBaseUrl: string | null;
  /** Every hostname that is ours: PUBLIC_BASE_URL's, MCP_BASE_URL's and SITE_HOSTNAMES. (*.workers.dev is always ours.) */
  hostnames: ReadonlySet<string>;
  /** Hosts that are their own OAuth issuer: the canonical host (PUBLIC_BASE_URL's) and MCP_BASE_URL's. */
  oauthHosts: ReadonlySet<string>;
  /** SITE_ZONE (default: PUBLIC_BASE_URL's host): any other name under it is reserved (404 on every path). */
  zone: string | null;
  /** BRAND_NAME. null (the default) = no brand anywhere a viewer looks: no name, logo, icon, watermark or "Powered by". */
  brandName: string | null;
  /** SUPPORT_EMAIL, else EMAIL_FROM. null = messages say to contact the operator of this server. */
  supportEmail: string | null;
  /** ABUSE_EMAIL, else supportEmail. */
  abuseEmail: string | null;
  /** HOME_URL, else canonicalBaseUrl: the "Powered by" / watermark link. null = no link. */
  homeUrl: string | null;
  /** HOME_SITE_ENABLED="true" and every homepage value set: "/" and the static homepage files (worker/home) are served. Off = 404. */
  homeSiteEnabled: boolean;
  /** What the homepage's markers become; null = the homepage is off. */
  homeValues: Readonly<Record<HomeMarker, string>> | null;
  /** DOCS_URL, else <canonicalBaseUrl>/docs/mcp while the home site is on. null = no documentation link. */
  docsUrl: string | null;
  /** BLOCKED_COUNTRIES: ISO codes (or "EU_EEA_UK") refused the MCP, sign-in and installer routes with 451. Empty = none. */
  blockedCountries: ReadonlySet<string>;
}>;

/** What one invocation may spend (WORKERS_PLAN; docs/workers-free-plan.md has the reasons). */
export type WorkersConfig = Readonly<{
  free: boolean;
  /** Rows the hourly cleanup handles one by one per step (multipart aborts, brand images, size checks, custom domains); null = the steps' own standard limits. */
  cleanupBatch: number | null;
  /** Expired recordings deleted per cleanup run (in set-based batches of 100). */
  cleanupRecordings: number;
  /** PBKDF2 rounds for a new video passcode. Each passcode keeps the count it was made with. */
  passcodeIterations: number;
  /** Newest videos search_videos reads transcripts of. */
  searchScan: number;
  /** A video is marked ready (transcript pending) before its transcription starts, so running out of CPU can't hold it back. */
  readyBeforeTranscript: boolean;
}>;
const WORKERS_STANDARD: WorkersConfig = Object.freeze({
  free: false,
  cleanupBatch: null,
  cleanupRecordings: 500,
  passcodeIterations: 100_000,
  searchScan: 200,
  readyBeforeTranscript: false,
});
const WORKERS_FREE: WorkersConfig = Object.freeze({
  free: true,
  cleanupBatch: 3,
  cleanupRecordings: 50,
  passcodeIterations: 10_000,
  searchScan: 50,
  readyBeforeTranscript: true,
});

export type SelfHostConfig = Readonly<{
  devMode: boolean;
  /** WORKERS_PLAN="free" or the standard settings. */
  workers: WorkersConfig;
  site: SiteConfig;
  /** Sign-in and account emails through the EMAIL (send_email) binding, from EMAIL_FROM as brandName (null = the bare address). */
  email: Readonly<{ enabled: boolean; from: string | null; fromName: string | null }>;
  /**
   * ownerAccountIds (OWNER_ACCOUNT_IDS): no plan limits, operator tools. signupsDisabled = SIGNUPS_DISABLED is exactly
   * "true": no new accounts (oauth/accounts.ts createAccount refuses); existing ones sign in as normal. signupAllowlist
   * (SIGNUPS_ALLOWLIST, lowercased): emails that may still sign up while signups are disabled (oauth/accounts.ts
   * signupAllowed); empty while signups are open, where it means nothing. claim: OWNER_CLAIM_SECRET is set and long enough
   * (whether a claim is still possible also depends on D1: oauth/claim.ts claimOpen). signupsDisabled doesn't close the claim.
   */
  auth: Readonly<{
    ownerAccountIds: readonly string[];
    signupsDisabled: boolean;
    signupAllowlist: readonly string[];
    claim: Readonly<{ enabled: boolean }>;
  }>;
  /**
   * enabled = both TURNSTILE keys. TURNSTILE_DISABLED="true" (and no keys) = sign-in skips the bot check (an explicit
   * operator choice; viewer comments stay closed). Neither = sign-in fails closed and viewer comments are closed.
   */
  turnstile: Readonly<{ enabled: boolean; siteKey: string | null; signinCheckDisabled: boolean }>;
  /** Stripe: enabled only with STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRO_PRICE_ID. Ids are null when off. */
  billing: Readonly<{
    enabled: boolean;
    proPriceId: string | null;
    proYearlyPriceId: string | null;
    teamsPriceId: string | null;
    teamsYearlyPriceId: string | null;
    storageAddonPriceId: string | null;
    portalConfigId: string | null;
  }>;
  /**
   * Cloudflare for SaaS: enabled only with CF_SAAS_API_TOKEN, CF_ZONE_ID, CUSTOM_DOMAIN_CNAME_TARGET and a canonical host.
   * cnameTarget is kept while off too, so existing rows still show the right record.
   */
  customDomains: Readonly<{ enabled: boolean; zoneId: string | null; cnameTarget: string | null }>;
  /** Problems that make the deployment unusable (names only, never values). */
  errors: readonly string[];
  /** Partial configuration that switches a feature off (names only, never values). */
  warnings: readonly string[];
}>;

const memo = new WeakMap<Env, SelfHostConfig>();
/** Warnings already logged in this isolate (the Worker and its Durable Objects have an env object each). */
const logged = new Set<string>();

export function getConfig(env: Env): SelfHostConfig {
  let c = memo.get(env);
  if (!c) {
    c = parseConfig(env);
    memo.set(env, c);
    for (const w of c.warnings) {
      if (logged.has(w)) continue;
      logged.add(w);
      console.warn(`config: ${w}`);
    }
  }
  return c;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const host = (h: string): string => h.toLowerCase().replace(/\.$/, "");
const list = (v: unknown): string[] =>
  (str(v) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

function parseConfig(env: Env): SelfHostConfig {
  const errors: string[] = [];
  const warnings: string[] = [];
  const devMode = env.DEV_MODE === "true";

  const workersPlan = str(env.WORKERS_PLAN)?.toLowerCase() ?? null;
  if (workersPlan && workersPlan !== "free" && workersPlan !== "paid") errors.push('WORKERS_PLAN must be "free" or "paid" (or unset).');

  for (const k of REQUIRED_SECRETS) if (!str(env[k])) errors.push(`${k} is not set (secret; required).`);

  /** An https origin (or a loopback one in dev). Bad values are errors, never silently replaced. */
  const origin = (name: "PUBLIC_BASE_URL" | "MCP_BASE_URL" | "HOME_URL" | "DOCS_URL" | "OPERATOR_URL" | "TEMPLATE_URL", keepPath = false): string | null => {
    const v = str(env[name]);
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol === "https:" || LOOPBACK.has(u.hostname)) return keepPath ? u.href : u.origin;
    } catch {
      // reported below
    }
    errors.push(`${name} must be an https:// URL${keepPath ? "" : " (an origin, like https://videos.example.com)"}.`);
    return null;
  };
  const email = (name: "EMAIL_FROM" | "SUPPORT_EMAIL" | "ABUSE_EMAIL"): string | null => {
    const v = str(env[name]);
    if (v && !EMAIL.test(v)) {
      errors.push(`${name} is not an email address.`);
      return null;
    }
    return v;
  };

  const publicBaseUrl = origin("PUBLIC_BASE_URL");
  const mcpBaseUrl = origin("MCP_BASE_URL");
  const extraHosts = list(env.SITE_HOSTNAMES).map(host);
  for (const h of extraHosts) if (!HOSTNAME.test(h)) errors.push(`SITE_HOSTNAMES has an entry that isn't a hostname.`);
  const publicHost = publicBaseUrl ? new URL(publicBaseUrl).hostname : null;
  const mcpHost = mcpBaseUrl ? new URL(mcpBaseUrl).hostname : null;
  const canonicalBaseUrl = publicBaseUrl ?? (extraHosts[0] ? `https://${extraHosts[0]}` : null);
  const canonicalHost = canonicalBaseUrl ? new URL(canonicalBaseUrl).hostname : null;
  const hostnames = new Set([publicHost, mcpHost, ...extraHosts].filter((h): h is string => !!h));
  const oauthHosts = new Set([canonicalHost, mcpHost].filter((h): h is string => !!h));
  const zoneVar = str(env.SITE_ZONE);
  if (zoneVar && !HOSTNAME.test(host(zoneVar))) errors.push("SITE_ZONE is not a hostname.");
  const zone = zoneVar ? host(zoneVar) : publicHost;
  if (!devMode && !publicBaseUrl) warnings.push("PUBLIC_BASE_URL is not set: links use whatever host each request came in on.");

  const brandName = str(env.BRAND_NAME);
  const from = email("EMAIL_FROM");
  const supportEmail = email("SUPPORT_EMAIL") ?? from;
  const abuseEmail = email("ABUSE_EMAIL") ?? supportEmail;
  // The homepage names its operator (footer, legal pages), so it is served only once every value is known.
  const home: Record<HomeMarker, string | null> = {
    OPERATOR_NAME: str(env.OPERATOR_NAME),
    // As written: the URL parser would add a trailing slash.
    OPERATOR_URL: origin("OPERATOR_URL", true) && str(env.OPERATOR_URL),
    LEGAL_ENTITY_NAME: str(env.LEGAL_ENTITY_NAME),
    STATEMENT_DESCRIPTOR: str(env.STATEMENT_DESCRIPTOR),
    TEMPLATE_URL: origin("TEMPLATE_URL", true) && str(env.TEMPLATE_URL),
    SUPPORT_EMAIL: supportEmail,
    ABUSE_EMAIL: abuseEmail,
    SITE_HOST: canonicalHost,
  };
  const homeMissing = Object.entries(home).flatMap(([k, v]) => (v ? [] : [k === "SITE_HOST" ? "PUBLIC_BASE_URL (or SITE_HOSTNAMES)" : k]));
  const homeSiteEnabled = env.HOME_SITE_ENABLED === "true" && homeMissing.length === 0;
  if (env.HOME_SITE_ENABLED === "true" && !homeSiteEnabled) warnings.push(`The homepage is off: HOME_SITE_ENABLED also needs ${homeMissing.join(", ")}.`);
  const homeValues = homeSiteEnabled ? Object.freeze(home as Record<HomeMarker, string>) : null;
  const homeUrl = origin("HOME_URL", true) ?? canonicalBaseUrl;
  const docsUrl = origin("DOCS_URL", true) ?? (homeSiteEnabled && canonicalBaseUrl ? `${canonicalBaseUrl}/docs/mcp` : null);

  const blockedCountries = new Set<string>();
  for (const c of list(env.BLOCKED_COUNTRIES).map((s) => s.toUpperCase())) {
    if (c === "EU_EEA_UK") EU_EEA_UK.forEach((x) => blockedCountries.add(x));
    else if (/^[A-Z]{2}$/.test(c)) blockedCountries.add(c);
    else errors.push("BLOCKED_COUNTRIES must be two-letter country codes (or EU_EEA_UK), comma-separated.");
  }

  if (env.EMAIL && !from) warnings.push("EMAIL is bound but EMAIL_FROM is not set: sign-in emails are off.");
  const emailEnabled = !!env.EMAIL && !!from;

  const ownerAccountIds = list(env.OWNER_ACCOUNT_IDS).filter((id) => id !== "__SET_BY_DEPLOY__");

  const signupsDisabled = env.SIGNUPS_DISABLED === "true";
  const allowlisted = list(env.SIGNUPS_ALLOWLIST).map((e) => e.toLowerCase());
  if (allowlisted.some((e) => !/^[^@\s,]+@[^@\s,]+$/.test(e))) warnings.push("SIGNUPS_ALLOWLIST has an entry that is not an email address; it matches nobody.");
  if (allowlisted.length && !signupsDisabled) warnings.push('SIGNUPS_ALLOWLIST is set but SIGNUPS_DISABLED is not exactly "true": signups are open to everyone and the allowlist does nothing.');
  const signupAllowlist = signupsDisabled ? allowlisted : [];

  const claimSecret = str(env.OWNER_CLAIM_SECRET);
  const claimEnabled = !!claimSecret && claimSecret.length >= CLAIM_SECRET_MIN;
  if (claimSecret && !claimEnabled) warnings.push(`OWNER_CLAIM_SECRET is too short (at least ${CLAIM_SECRET_MIN} characters): the owner claim is off.`);

  const siteKey = str(env.TURNSTILE_SITE_KEY);
  const turnstileEnabled = !!siteKey && !!str(env.TURNSTILE_SECRET_KEY);
  const signinCheckDisabled = !turnstileEnabled && env.TURNSTILE_DISABLED === "true";
  if (!turnstileEnabled && (siteKey || str(env.TURNSTILE_SECRET_KEY))) warnings.push("Only one of TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY is set: Turnstile is off.");
  if (!turnstileEnabled && !signinCheckDisabled) {
    warnings.push("Turnstile is not configured: sign-in is refused and viewer comments are closed (set both keys, or TURNSTILE_DISABLED=true).");
  }

  const stripeKeys = [str(env.STRIPE_SECRET_KEY), str(env.STRIPE_WEBHOOK_SECRET), str(env.STRIPE_PRO_PRICE_ID)];
  const billingEnabled = stripeKeys.every(Boolean);
  if (!billingEnabled && stripeKeys.some(Boolean)) {
    warnings.push("Billing is off: it needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRO_PRICE_ID together.");
  }
  const price = (k: "STRIPE_PRO_PRICE_ID" | "STRIPE_PRO_YEARLY_PRICE_ID" | "STRIPE_TEAMS_PRICE_ID" | "STRIPE_TEAMS_YEARLY_PRICE_ID" | "STRIPE_STORAGE_ADDON_PRICE_ID" | "STRIPE_PORTAL_CONFIG_ID") =>
    billingEnabled ? str(env[k]) : null;

  const cnameVar = str(env.CUSTOM_DOMAIN_CNAME_TARGET);
  const cnameTarget = cnameVar ? host(cnameVar) : null;
  if (cnameTarget && !HOSTNAME.test(cnameTarget)) errors.push("CUSTOM_DOMAIN_CNAME_TARGET is not a hostname.");
  const cdParts = [str(env.CF_SAAS_API_TOKEN), str(env.CF_ZONE_ID), cnameTarget];
  const customDomainsEnabled = cdParts.every(Boolean) && !!canonicalHost;
  if (!customDomainsEnabled && cdParts.some(Boolean)) {
    warnings.push(
      "Custom domains are off: they need CF_SAAS_API_TOKEN, CF_ZONE_ID, CUSTOM_DOMAIN_CNAME_TARGET and PUBLIC_BASE_URL (or SITE_HOSTNAMES) together.",
    );
  }

  return Object.freeze({
    devMode,
    workers: workersPlan === "free" ? WORKERS_FREE : WORKERS_STANDARD,
    site: Object.freeze({
      publicBaseUrl,
      canonicalBaseUrl,
      canonicalHost,
      mcpBaseUrl,
      hostnames,
      oauthHosts,
      zone,
      brandName,
      supportEmail,
      abuseEmail,
      homeUrl,
      homeSiteEnabled,
      homeValues,
      docsUrl,
      blockedCountries,
    }),
    email: Object.freeze({ enabled: emailEnabled, from, fromName: brandName }),
    auth: Object.freeze({
      ownerAccountIds: Object.freeze(ownerAccountIds),
      signupsDisabled,
      signupAllowlist: Object.freeze(signupAllowlist),
      claim: Object.freeze({ enabled: claimEnabled }),
    }),
    turnstile: Object.freeze({ enabled: turnstileEnabled, siteKey: turnstileEnabled ? siteKey : null, signinCheckDisabled }),
    billing: Object.freeze({
      enabled: billingEnabled,
      proPriceId: price("STRIPE_PRO_PRICE_ID"),
      proYearlyPriceId: price("STRIPE_PRO_YEARLY_PRICE_ID"),
      teamsPriceId: price("STRIPE_TEAMS_PRICE_ID"),
      teamsYearlyPriceId: price("STRIPE_TEAMS_YEARLY_PRICE_ID"),
      storageAddonPriceId: price("STRIPE_STORAGE_ADDON_PRICE_ID"),
      portalConfigId: price("STRIPE_PORTAL_CONFIG_ID"),
    }),
    customDomains: Object.freeze({
      enabled: customDomainsEnabled,
      zoneId: customDomainsEnabled ? str(env.CF_ZONE_ID) : null,
      cnameTarget,
    }),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  });
}

/** "Write to <support email>." or, with none configured, a pointer to the operator. */
export const contactLine = (c: SelfHostConfig, verb = "Write to"): string =>
  c.site.supportEmail ? `${verb} ${c.site.supportEmail}` : `${verb} the operator of this server`;

/** The readable answer index.ts gives while the configuration has errors (names only, never values). */
export function configErrorResponse(c: SelfHostConfig): Response {
  const body =
    "This server is not configured correctly. Its operator needs to fix:\n" + c.errors.map((e) => `- ${e}`).join("\n") + "\nSee SELFHOST_CONFIG.md.\n";
  return new Response(body, { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
