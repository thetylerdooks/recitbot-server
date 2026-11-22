// The only production deploy path: apply remote D1 migrations, refuse to go on while any is still pending, then deploy.
// (Prod once ran code ahead of its schema: every start_recording INSERT failed and burned a start slot.) Before anything
// remote, a preflight (deploy-preflight.mjs) refuses placeholder vars, configuration errors and missing secrets, and the
// build output must not hold a placeholder-key recorder build or a TEST-key manifest.
// Usage: npm run deploy:prod. Needs `wrangler login` on the deployment's Cloudflare account. Never prints secrets.
// Deploys with the deployment's own worker/wrangler.jsonc (git-ignored; start from worker/wrangler.example.jsonc, see
// SELFHOST_CONFIG.md): its `env.production` names the Worker, routes, D1 database, bucket and vars. Nothing about the
// deployment is hardcoded here: D1 is addressed by its binding name (DB).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigModule, preflight } from "./deploy-preflight.mjs";
import { parseJsonc } from "./home-markers.mjs";
import { deployProblems } from "./signed-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const CONFIG = "worker/wrangler.jsonc";
const DB = "DB";
const TARGET = ["--env", "production", "-c", CONFIG];
if (!existsSync(join(root, CONFIG))) {
  console.error(
    `deploy:prod stopped: ${CONFIG} is missing. It is this deployment's own config and is not committed: copy ` +
      "worker/wrangler.example.jsonc to worker/wrangler.jsonc and fill it in (SELFHOST_CONFIG.md lists every value). " +
      "Nothing was built or touched.",
  );
  process.exit(1);
}
// CI=1: wrangler never stops at a confirmation prompt.
const env = { ...process.env, CI: "1" };

function run(label, args, capture = false) {
  console.log(`\n== ${label}: wrangler ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [wranglerJs, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (capture) process.stdout.write(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`\ndeploy:prod stopped: ${label} failed (exit ${r.status}). Nothing after it ran.`);
    process.exit(r.status || 1);
  }
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

console.log("== preflight");
let production;
let checked;
try {
  production = parseJsonc(readFileSync(join(root, CONFIG), "utf8")).env?.production;
} catch {
  // Not the parser's own message: it quotes the file.
  console.error(`\ndeploy:prod stopped: ${CONFIG} is not valid JSONC. Nothing was built or touched.`);
  process.exit(1);
}
try {
  checked = preflight(production, await loadConfigModule(join(root, "worker", "src", "config.ts")), () =>
    // Read-only, and its output stays here: only secret names are read from it.
    spawnSync(process.execPath, [wranglerJs, "secret", "list", "--format", "json", ...TARGET], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }),
  );
} catch (e) {
  console.error(`\ndeploy:prod stopped: the preflight could not run (${e?.code ?? e?.name ?? "error"}; is npm install done?). Nothing was built or touched.`);
  process.exit(1);
}
if (checked.problems.length) {
  console.error(
    `\ndeploy:prod stopped: fix these for env.production of ${CONFIG} (SELFHOST_CONFIG.md). Nothing was built or touched.\n  ${checked.problems.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(checked.skipped ? `skipped secret check: ${checked.skipped}` : "vars, configuration and secrets are fine");

console.log("\n== build");
const b = spawnSync(process.execPath, [join(root, "scripts", "build-recorder-zip.mjs")], { cwd: root, stdio: "inherit" });
const w = b.status === 0 && spawnSync(process.execPath, [join(root, "scripts", "build-web.mjs")], { cwd: root, stdio: "inherit" });
const h = w && w.status === 0 && spawnSync(process.execPath, [join(root, "scripts", "sync-home.mjs")], { cwd: root, stdio: "inherit" });
if (b.status !== 0 || !w || w.status !== 0 || !h || h.status !== 0) {
  console.error("\ndeploy:prod stopped: build failed. Nothing remote was touched.");
  process.exit(1);
}

// worker/home is not committed: a fresh clone must not take the homepage down.
const vars = production.vars ?? {};
if (vars.HOME_SITE_ENABLED === "true" && !existsSync(join(root, "worker", "public", "index.html"))) {
  console.error(
    "\ndeploy:prod stopped: HOME_SITE_ENABLED is true but this build has no homepage (no worker/home/index.html). Put your " +
      "homepage there, or set HOME_SITE_ENABLED to false. Nothing remote was touched.",
  );
  process.exit(1);
}

// Never ship a placeholder-key recorder build or a manifest signed by a TEST key, whatever produced worker/public/.
const pub = join(root, "worker", "public");
const served = readdirSync(pub)
  .filter((f) => /^(recorder\.zip|Recitbot-mac-.*\.zip|(install|uninstall)\.(ps1|sh))$/.test(f))
  .map((f) => ({ name: `worker/public/${f}`, data: readFileSync(join(pub, f)) }));
const problems = deployProblems(readFileSync(join(root, "worker", "src", "generated.ts"), "utf8"), served);
if (problems.length) {
  console.error(`\ndeploy:prod stopped: not a release build. Nothing remote was touched.\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

run("apply remote migrations", ["d1", "migrations", "apply", DB, "--remote", ...TARGET]);
const list = run("check pending migrations", ["d1", "migrations", "list", DB, "--remote", ...TARGET], true);
if (!/No migrations to apply/i.test(list)) {
  console.error("\ndeploy:prod stopped: remote D1 still lists pending migrations (see above). The Worker was NOT deployed.");
  process.exit(1);
}
run("deploy", ["deploy", ...TARGET]);
console.log("\ndeploy:prod done: migrations applied, none pending, Worker deployed.");
