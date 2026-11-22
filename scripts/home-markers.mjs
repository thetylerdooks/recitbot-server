// The homepage's operator values as {{MARKERS}}. The committed worker/home holds only markers; worker/src/home.ts fills
// them in from the deployment's config when it serves a page. sync-home.mjs turns the home repo's literals back into
// markers here, with the values from the operator's git-ignored worker/wrangler.jsonc, so no literal is ever committed.
// worker/test/home-markers.test.ts checks that this and the Worker's renderer (src/home.ts) are inverses.

/** Escaped as the Worker does (src/util.ts esc). */
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Wrangler vars -> marker values, with the same fallbacks as src/config.ts. Missing ones are null. */
export function homeValues(vars) {
  const base = str(vars.PUBLIC_BASE_URL);
  const support = str(vars.SUPPORT_EMAIL) ?? str(vars.EMAIL_FROM);
  return {
    OPERATOR_NAME: str(vars.OPERATOR_NAME),
    OPERATOR_URL: str(vars.OPERATOR_URL),
    LEGAL_ENTITY_NAME: str(vars.LEGAL_ENTITY_NAME),
    STATEMENT_DESCRIPTOR: str(vars.STATEMENT_DESCRIPTOR),
    TEMPLATE_URL: str(vars.TEMPLATE_URL),
    SUPPORT_EMAIL: support,
    ABUSE_EMAIL: str(vars.ABUSE_EMAIL) ?? support,
    SITE_HOST: base ? new URL(base).hostname : (str(vars.SITE_HOSTNAMES)?.split(",")[0].trim() ?? null),
  };
}

/** Every value in `text` (raw or HTML-escaped) as its marker; longest first, so a URL or address wins over the host in it. */
export function toMarkers(text, values) {
  const found = Object.entries(values)
    .filter(([, v]) => v)
    .flatMap(([marker, v]) => [...new Set([v, esc(v)])].map((literal) => [literal, marker]))
    .sort((a, b) => b[0].length - a[0].length);
  return found.reduce((t, [literal, marker]) => t.replaceAll(literal, `{{${marker}}}`), text);
}

/** A .jsonc file's text as an object (comments, trailing commas and a BOM dropped). */
export function parseJsonc(text) {
  const bare = text
    .replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ""));
  return JSON.parse(bare.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, (m) => (m[0] === '"' ? m : "")));
}
