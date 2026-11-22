// Puts the deployment's own homepage (a static site in worker/home) into the Worker's assets dir. It is optional and not
// committed (git-ignored): without worker/home there is no homepage, and the build and the Worker work the same. The Worker
// serves it only with HOME_SITE_ENABLED=true (src/config.ts); worker/src/generated-home.ts lists its files so the Worker can
// refuse them otherwise.
// 1. If a home repo is there (HOME_REPO, default ../recitbot-home from the repo root): `npm run build` in it and
//    mirror its dist into worker/home, so a deploy works without the home repo.
//    HOME_REPO=none skips this step (worker/home is used as is).
//    Operator values in its pages (name, links, company, addresses, host) become {{MARKERS}} on the way in, using the
//    values in the git-ignored worker/wrangler.jsonc (home-markers.mjs). If the literal guard still finds one, the sync
//    stops and worker/home stays as it was. Without worker/wrangler.jsonc the local copy is used.
// 2. Copy worker/home into worker/public. A file the Worker build already put there is a collision and fails the build,
//    unless it is byte-identical (the shared favicon.ico / apple-touch-icon.png). Files from the previous sync are
//    replaced. Paths the Worker routes itself are refused, so the homepage can never shadow a Worker route.
// 3. Append the homepage rules to worker/public/_headers (written by build-web.mjs; run that first).
// "/" itself is run_worker_first (wrangler.jsonc): src/home.ts serves index.html with the same headers.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "./check-selfhost-literals.mjs";
import { homeValues, parseJsonc, toMarkers } from "./home-markers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendored = join(root, "worker", "home");
const pub = join(root, "worker", "public");
// Outside public/ so it is never uploaded as an asset.
const manifestPath = join(root, "build", "home-manifest.json");
const generatedPath = join(root, "worker", "src", "generated-home.ts");
const HEADERS = JSON.parse(readFileSync(join(root, "worker", "src", "home-headers.json"), "utf8"));
const MARK = "# --- homepage (scripts/sync-home.mjs) ---";
// First path segments the Worker routes (src/index.ts, src/oauth); a homepage file under one would shadow it.
const WORKER_SEGMENTS = new Set([
  "mcp", "oauth", ".well-known", "signin", "signout", "device", "upload", "v", "i", "m", "s", "report",
  "install.ps1", "uninstall.ps1", "recorder.zip", "install.sh", "uninstall.sh",
]);
// The macOS recorder zip (src/geo.ts MAC_ZIP).
const WORKER_FILE = /^Recitbot-mac-.*\.zip$/;
// The home repo's _headers is for its own preview deploy (site-wide noindex); this script writes the rules instead.
const SKIP = new Set(["_headers"]);

const fail = (msg) => {
  console.error(`sync-home: ${msg}`);
  process.exit(1);
};
const files = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const rel = (base, f) => relative(base, f).replaceAll("\\", "/");
const headersPath = join(pub, "_headers");
// Checked first: the collision check is only meaningful once the Worker's own files are in public/.
if (!existsSync(headersPath)) fail("worker/public/_headers missing: run scripts/build-web.mjs first");

// 1. Build the home repo, if present.
const skipRepo = process.env.HOME_REPO === "none";
const configPath = join(root, "worker", "wrangler.jsonc");
const isText = (f) => /\.(html|js|css|svg|txt|xml|json|webmanifest)$/.test(f);
const homeRepo = resolve(root, skipRepo ? "." : (process.env.HOME_REPO ?? join("..", "recitbot-home")));
if (skipRepo) {
  console.log("sync-home: HOME_REPO=none; using worker/home");
} else if (!existsSync(configPath)) {
  if (process.env.HOME_REPO) fail("worker/wrangler.jsonc is missing: its vars say which values become markers");
  console.log("sync-home: no worker/wrangler.jsonc; using worker/home");
} else if (existsSync(join(homeRepo, "package.json"))) {
  console.log(`sync-home: building ${homeRepo}`);
  const b = spawnSync("npm run build", { cwd: homeRepo, shell: true, stdio: "inherit" });
  if (b.status !== 0) fail(`npm run build failed in ${homeRepo} (exit ${b.status})`);
  const dist = join(homeRepo, "dist");
  if (!existsSync(join(dist, "index.html"))) fail(`${dist}/index.html missing after the build`);
  const values = homeValues(parseJsonc(readFileSync(configPath, "utf8")).env?.production?.vars ?? {});
  const synced = files(dist)
    .map((f) => [rel(dist, f), f])
    .filter(([r]) => !SKIP.has(r))
    .map(([r, f]) => [r, isText(f) ? toMarkers(readFileSync(f, "utf8"), values) : readFileSync(f)]);
  // Names of files and rules only, never the matched text.
  const literals = synced.flatMap(([r, data]) => (typeof data === "string" ? scanText(`worker/home/${r}`, data) : []));
  if (literals.length) {
    fail(
      "operator values left in the homepage (set the matching var in worker/wrangler.jsonc, SELFHOST_CONFIG.md); worker/home is unchanged:\n  " +
        literals.map((v) => `${v.file}:${v.line}  ${v.rule}`).join("\n  "),
    );
  }
  rmSync(vendored, { recursive: true, force: true });
  for (const [r, data] of synced) {
    mkdirSync(dirname(join(vendored, r)), { recursive: true });
    writeFileSync(join(vendored, r), data);
  }
} else if (process.env.HOME_REPO) {
  fail(`HOME_REPO=${process.env.HOME_REPO} has no package.json`);
} else {
  console.log(`sync-home: no home repo at ${homeRepo}; using worker/home`);
}
const hasHome = existsSync(vendored);
if (hasHome && !existsSync(join(vendored, "index.html"))) fail("worker/home has no index.html");

// 2. Copy into public/.
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
for (const r of previous) rmSync(join(pub, r), { force: true });
const copied = [];
const problems = [];
const homeFiles = [];
for (const f of hasHome ? files(vendored) : []) {
  const r = rel(vendored, f);
  homeFiles.push(`/${r}`);
  if (WORKER_SEGMENTS.has(r.split("/")[0]) || WORKER_FILE.test(r)) {
    problems.push(`${r}: under a path the Worker routes`);
    continue;
  }
  const dest = join(pub, r);
  if (existsSync(dest)) {
    if (!readFileSync(dest).equals(readFileSync(f))) problems.push(`${r}: worker/public already has a different file there`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  copied.push(r);
}
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(copied, null, 2)}\n`);
writeFileSync(
  generatedPath,
  "// Generated by scripts/sync-home.mjs: every homepage file (worker/home), served only with HOME_SITE_ENABLED.\n" +
    `export const HOME_FILES: ReadonlySet<string> = new Set(${JSON.stringify(homeFiles)});\n`,
);
if (problems.length) fail(`homepage file collisions:\n  ${problems.join("\n  ")}`);

// 3. Header rules for the static pages (and "/", should the asset layer apply them to the Worker's ASSETS fetch).
const base = readFileSync(headersPath, "utf8").split(MARK)[0].trimEnd();
if (!hasHome) {
  writeFileSync(headersPath, `${base}\n`);
  console.log("sync-home: no worker/home; no homepage in this build");
  process.exit(0);
}
const html = Object.entries(HEADERS).map(([k, v]) => `  ${k}: ${v}`);
const immutable = "  Cache-Control: public, max-age=31536000, immutable";
writeFileSync(
  headersPath,
  [
    base,
    MARK,
    ...["/", "/index.html", "/eu/*", "/terms/*", "/privacy/*"].flatMap((p) => [p, ...html]),
    "/_astro/*",
    immutable,
    "/fonts/*",
    immutable,
    "",
  ].join("\n"),
);
console.log(`sync-home: ${copied.length} homepage files -> worker/public`);
