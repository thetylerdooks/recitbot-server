// deploy-prod.mjs's preflight: what must be right in worker/wrangler.jsonc's env.production before anything remote happens.
// Every problem names a var or secret, never its value. Nothing here starts a process or opens a file except
// loadConfigModule; worker/test/deploy-preflight.test.ts runs the checks without wrangler or the network.

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** What worker/wrangler.example.jsonc and wrangler.test.jsonc hold where a deployment's own value goes: [label, pattern]. */
export const PLACEHOLDERS = [
  ["REPLACE_ME", /REPLACE[_-]ME/i],
  ["example.com", /example\.com/i],
  ["example.test", /example\.test/i],
  ["local-only", /local-only/i],
  ["PLACEHOLDER", /PLACEHOLDER/],
  ["a Cloudflare Turnstile test key", /\b[123]x0{20}/],
];

/** Vars that still hold a placeholder. */
export function placeholderProblems(vars) {
  return Object.entries(vars).flatMap(([name, value]) => {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    const hit = PLACEHOLDERS.find(([, re]) => re.test(text));
    return hit ? [`${name} still holds a placeholder (${hit[0]}).`] : [];
  });
}

/** Secrets the configured features need: [{ name, why }]. A TURNSTILE_SITE_KEY var counts (its value is public). */
export function impliedSecrets(vars, requiredSecrets) {
  const out = requiredSecrets.map((name) => ({ name, why: "required" }));
  if (str(vars.STRIPE_PRO_PRICE_ID)) {
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) out.push({ name, why: "billing: STRIPE_PRO_PRICE_ID is set" });
  }
  const siteKey = str(vars.TURNSTILE_SITE_KEY);
  if (siteKey || vars.TURNSTILE_DISABLED !== "true") {
    const why = siteKey ? "Turnstile: TURNSTILE_SITE_KEY is set" : "the sign-in bot check; or set TURNSTILE_DISABLED=true";
    if (!siteKey) out.push({ name: "TURNSTILE_SITE_KEY", why });
    out.push({ name: "TURNSTILE_SECRET_KEY", why });
  }
  if (str(vars.CF_ZONE_ID) && str(vars.CUSTOM_DOMAIN_CNAME_TARGET)) {
    out.push({ name: "CF_SAAS_API_TOKEN", why: "custom domains: CF_ZONE_ID and CUSTOM_DOMAIN_CNAME_TARGET are set" });
  }
  return out;
}

/** getConfig()'s errors for the production vars, with the secrets stubbed as present and EMAIL bound if it is. */
export function configProblems(production, vars, { getConfig, REQUIRED_SECRETS }) {
  const stubs = Object.fromEntries(impliedSecrets(vars, REQUIRED_SECRETS).map(({ name }) => [name, "present"]));
  const email = Array.isArray(production.send_email) && production.send_email.some((b) => b?.name === "EMAIL");
  return [...getConfig({ ...stubs, ...vars, ...(email && { EMAIL: {} }) }).errors];
}

/** The names in `wrangler secret list`'s JSON (a banner may come first); null = not that. */
export function secretNames(stdout) {
  const text = String(stdout ?? "");
  for (const m of text.matchAll(/^\s*\[/gm)) {
    try {
      const rows = JSON.parse(text.slice(m.index));
      if (Array.isArray(rows) && rows.every((r) => typeof r?.name === "string")) return rows.map((r) => r.name);
    } catch {
      // not the list: try the next line that starts with a bracket
    }
  }
  return null;
}

/** Why the list call gave nothing to check, in our own words: wrangler's output is never repeated. */
export function skipReason({ status, signal, error, stdout, stderr }) {
  if (error?.code === "ETIMEDOUT" || signal) return "wrangler timed out";
  if (error) return `wrangler could not run (${error.code ?? "error"})`;
  if (status === 0) return "wrangler's answer was not a list of secrets";
  const out = `${stdout ?? ""}\n${stderr ?? ""}`;
  if (/\bnot found\b|does not exist|\b10007\b/i.test(out)) return "the Worker does not exist yet, or not on this account";
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|network|internet/i.test(out)) return "Cloudflare could not be reached";
  if (/not logged in|wrangler login|CLOUDFLARE_API_TOKEN|authenticat|unauthorized|\b10000\b/i.test(out)) return "not signed in to Cloudflare (wrangler login)";
  return `wrangler failed (exit ${status})`;
}

/** The secret list call's outcome: { problems, skipped } (skipped = why it could not be checked, else null). */
export function secretProblems(result, implied) {
  const names = !result.error && result.status === 0 ? secretNames(result.stdout) : null;
  if (!names) return { problems: [], skipped: skipReason(result) };
  const have = new Set(names);
  return { problems: implied.filter(({ name }) => !have.has(name)).map(({ name, why }) => `${name} is not set (secret; ${why}).`), skipped: null };
}

/**
 * All of it. `production` = env.production; `configModule` = worker/src/config.ts; `listSecrets()` = the read-only
 * `wrangler secret list` (a spawnSync result), called only once everything local is right.
 */
export function preflight(production, configModule, listSecrets) {
  if (!production || typeof production !== "object") return { problems: ["env.production is missing."], skipped: null };
  const vars = production.vars ?? {};
  const problems = [...placeholderProblems(vars), ...configProblems(production, vars, configModule)];
  if (problems.length) return { problems, skipped: null };
  return secretProblems(listSecrets(), impliedSecrets(vars, configModule.REQUIRED_SECRETS));
}

/** worker/src/config.ts as a module: it imports types only, so its types are stripped and the rest is imported as it is. */
export async function loadConfigModule(file) {
  const { readFileSync } = await import("node:fs");
  const { default: ts } = await import("typescript");
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
