// GET /report?host=<hostname>&v=<slug> on our hosts (customer hosts never route here: the host gate 404s it): how to
// report a video page (the "Report" link on custom-host pages points here), with a mailto: link to ABUSE_EMAIL (config.ts) that has
// the page's link filled in. No form and no inputs, so there is nothing to spam. Query values are stripped of control
// characters (CR/LF), then dropped unless they are a plain hostname / slug; what's left is escaped and URI-encoded.
import { getConfig } from "./config";
import type { Env } from "./env";
import { esc, log } from "./util";

/** The one abuse / takedown contact (ABUSE_EMAIL, else SUPPORT_EMAIL, else EMAIL_FROM); null = none configured. */
export const abuseEmail = (env: Env): string | null => getConfig(env).site.abuseEmail;

const SLUG = /^[A-Za-z0-9]{10,40}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** CR / LF (and other control characters) go first: nothing from the query can start a new mail header line. */
const clean = (v: string | null) => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();

/** A plain DNS name (two labels or more, IDN as punycode), lowercased; anything else: null. */
function hostParam(v: string | null): string | null {
  const h = clean(v).toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253) return null;
  const labels = h.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]) ? h : null;
}

const slugParam = (v: string | null): string | null => {
  const s = clean(v);
  return SLUG.test(s) ? s : null;
};

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** branded (BRAND_NAME is set) = the product is named. */
const head = (branded: boolean) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<title>Report a video page${branded ? " · Recitbot" : ""}</title></head><body><h1>Report a video page</h1>`;

/**
 * mailto:<abuse>, subject "Report: <host>/<slug>" and the page's link as the body (both encodeURIComponent).
 * host / slug must already be validated (hostParam / slugParam).
 */
export function reportMailto(abuse: string, host: string | null, slug: string | null, branded: boolean): string {
  const product = branded ? "Recitbot " : "";
  const page = host ? `${host}/${slug ?? ""}` : slug;
  if (!page) return `mailto:${abuse}?subject=${encodeURIComponent(`Report a ${product}video page`)}`;
  const subject = `Report: ${page}`;
  const body = host ? `https://${page}` : `${branded ? "Recitbot video" : "Video"} ${page}`;
  return `mailto:${abuse}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The "how to reach us" paragraph: the abuse address and a mailto, or (none configured) a pointer to the operator. */
const contact = (abuse: string | null, mailto: string | null, rest: string) =>
  abuse
    ? `<p>You can also email ${esc(abuse)}: <a href="${esc(mailto ?? `mailto:${abuse}`)}">write the email</a> ${rest}</p>`
    : "<p>Contact the operator of this server with the page's link and what's wrong with it.</p>";

export function reportPage(abuse: string | null, host: string | null, slug: string | null, branded: boolean): string {
  const product = branded ? "Recitbot " : "";
  const what = host ? `https://${host}/${slug ?? ""}` : slug ? `the ${product}video ${slug}` : null;
  return (
    head(branded) +
    (what ? `<p>You're reporting: <strong>${esc(what)}</strong></p>` : "") +
    `<p>If a ${product}video page is phishing, pretends to be another company, or shows something it shouldn't, send us ` +
    "its link and what's wrong with it. We read every report, and we can take a page or a custom domain down at once " +
    "while we look into it.</p>" +
    contact(abuse, abuse ? reportMailto(abuse, host, slug, branded) : null, "(opens your mail app with the link filled in).") +
    "</body></html>\n"
  );
}

/** What /report shows when building the page fails (or the service is paused): still the address, no query values. */
export const reportFallback = (abuse: string | null, branded: boolean) =>
  head(branded) + "<p>This page couldn't load just now.</p>" + contact(abuse, null, "with the page's link and what's wrong with it.") + "</body></html>\n";

export function handleReport(req: Request, env: Env): Response {
  const abuse = abuseEmail(env);
  const branded = getConfig(env).site.brandName !== null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const how = abuse ? `email ${abuse}` : "contact the operator of this server";
    return new Response(`Method not allowed. To report a video page, ${how}.\n`, {
      status: 405,
      headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  let html: string;
  let status = 200;
  try {
    const q = new URL(req.url).searchParams;
    html = reportPage(abuse, hostParam(q.get("host")), slugParam(q.get("v")), branded);
  } catch (e) {
    log("error", "report page failed", { err: String(e) });
    html = reportFallback(abuse, branded);
    status = 500;
  }
  return new Response(req.method === "HEAD" ? null : html, { status, headers: HEADERS });
}
