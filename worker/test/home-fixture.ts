// A small stand-in homepage for the tests. The real one (worker/home) is each deployment's own and is not committed, so
// the tests bring their own pages: an ASSETS binding that answers these paths and hands everything else to the real one.
// The test file also mocks ../src/generated-home with HOME_FILES (vi.mock is hoisted, so it can't live here).
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { withEnv } from "./helpers";

const footer =
  '<a href="/#pricing">Pricing</a><footer>Built by <a href="{{OPERATOR_URL}}" rel="noopener">{{OPERATOR_NAME}}</a><p>&copy; 2026 {{LEGAL_ENTITY_NAME}}</p></footer>';
const page = (body: string) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Home</title></head><body>${body}${footer}</body></html>\n`;
const legal = (name: string) =>
  page(
    `<h1>${name}</h1><p>Email <a href="mailto:{{SUPPORT_EMAIL}}">{{SUPPORT_EMAIL}}</a> or <a href="mailto:{{ABUSE_EMAIL}}?subject=x">abuse</a>. ` +
      'Charges show on your card statement as "{{STATEMENT_DESCRIPTOR}}".</p>',
  );

/** What only the front page says. */
export const PITCH = "Tell your bot to record";

export const PAGES = {
  index: page(`<h1>${PITCH}</h1><a href="{{TEMPLATE_URL}}">Add to your bot</a><code>{{SITE_HOST}}/alex/v/k7Qm2xR4</code>`),
  eu: page("<h1>Not available in your region</h1>"),
  terms: legal("Terms"),
  privacy: legal("Privacy"),
};

const FILES: Record<string, [string, string]> = {
  "/index.html": ["text/html; charset=utf-8", PAGES.index],
  "/eu/index.html": ["text/html; charset=utf-8", PAGES.eu],
  "/terms/index.html": ["text/html; charset=utf-8", PAGES.terms],
  "/privacy/index.html": ["text/html; charset=utf-8", PAGES.privacy],
  "/lockup.svg": ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
};

/** The asset server's way of finding a page: /terms and /terms/ are /terms/index.html, / is /index.html. */
function lookup(path: string): [string, string] | undefined {
  const p = decodeURIComponent(path);
  return FILES[p] ?? FILES[`${p.replace(/\/+$/, "")}/index.html`] ?? FILES[`${p}.html`];
}

/** ASSETS with the homepage in it, as after a build that had worker/home. */
export const homeAssets = {
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input as Request, init);
    const file = lookup(new URL(req.url).pathname);
    if (!file) return env.ASSETS.fetch(req);
    const headers = { "content-type": file[0], etag: '"home-fixture"' };
    if (req.headers.get("if-none-match") === '"home-fixture"') return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : file[1], { headers });
  },
} as Fetcher;

/** ASSETS as after a build without worker/home: none of these files. */
export const noHomeAssets = {
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input as Request, init);
    return lookup(new URL(req.url).pathname) ? new Response(null, { status: 404 }) : env.ASSETS.fetch(req);
  },
} as Fetcher;

/** The test deployment with the homepage built in. */
export const homeEnv = (over: Partial<Env> = {}): Env => withEnv({ ASSETS: homeAssets, ...over });
