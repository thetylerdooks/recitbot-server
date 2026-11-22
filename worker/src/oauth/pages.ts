// Server-rendered sign-in pages: no script of our own, never framed, never cached. Only the email step loads a third
// party: Cloudflare Turnstile's script and challenge frame. Without BRAND_NAME they carry no name and no logo.
import { getConfig } from "../config";
import type { Env } from "../env";

const HEADING = '"Space Grotesk","Segoe UI",Helvetica,Arial,sans-serif';
const CSS =
  '@font-face{font-family:"Space Grotesk";font-weight:700;font-display:swap;src:url(/s/fonts/space-grotesk-700.woff2) format("woff2")}' +
  '@font-face{font-family:"JetBrains Mono";font-weight:500;font-display:swap;src:url(/s/fonts/jetbrains-mono-500.woff2) format("woff2")}' +
  "*{box-sizing:border-box}html{color-scheme:dark}" +
  'body{margin:0;background:#111318;color:#F5F3EE;font:400 16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
  "main{max-width:460px;margin:0 auto;padding:40px 20px 56px}" +
  `.brand{display:flex;align-items:center;gap:12px;margin:0 0 36px;font:700 24px/1 ${HEADING};letter-spacing:-.01em}` +
  ".brand img{display:block;border-radius:9px}" +
  `h1{margin:0 0 16px;font:700 30px/1.15 ${HEADING};letter-spacing:-.015em;overflow-wrap:anywhere}` +
  "p{margin:0 0 14px;overflow-wrap:anywhere}.muted{color:#A9ADB6;font-size:14px}.warn{padding:10px 12px;border:1px solid #F2463A;border-radius:10px}" +
  ".err{color:#FF8A80;font-weight:600}form{margin:20px 0}label{display:block;margin:0 0 8px;font-weight:600}" +
  "input{display:block;width:100%;padding:12px 14px;margin:0 0 14px;border:1px solid #5B606B;border-radius:10px;background:#fff;color:#111318;font:inherit;font-size:17px}" +
  'input.code{padding:14px 0 14px .4em;font:500 34px/1.15 "JetBrains Mono",Consolas,"Courier New",monospace;letter-spacing:.4em;text-align:center}' +
  "input:focus,button:focus-visible{outline:3px solid #F2463A;outline-offset:2px}" +
  "button{display:inline-block;padding:13px 22px;margin:0 8px 8px 0;border:0;border-radius:10px;background:#F2463A;color:#111318;font:inherit;font-weight:700;cursor:pointer}" +
  "button.wide{display:block;width:100%;margin:0}button.alt{background:transparent;color:#F5F3EE;border:1px solid #5B606B}" +
  "button.link{padding:0;margin:0;background:none;color:#F5F3EE;font-weight:600;text-decoration:underline}form.inline{display:inline;margin:0}" +
  ".cf-turnstile{min-height:65px;margin:0 0 14px}";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";
// Turnstile: its script and its challenge frame, plus the fetch('data:,') probe it makes. Nothing else.
const TURNSTILE_CSP = `${CSP}; script-src ${TURNSTILE_ORIGIN}; frame-src ${TURNSTILE_ORIGIN}; connect-src data:`;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** BRAND_NAME is set: the pages show the product's name and logo. */
const branded = (env: Env): boolean => getConfig(env).site.brandName !== null;
/** "your Recitbot account" / "your account". */
const product = (env: Env): string => (branded(env) ? "Recitbot " : "");

/**
 * `body` is trusted HTML: escape every interpolated value with esc(). `cookies` are Set-Cookie values. `turnstile` = load
 * Turnstile and allow it in the CSP.
 */
export function page(env: Env, title: string, body: string, status = 200, cookies: string[] = [], turnstile = false): Response {
  const brand = branded(env);
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(title)}${brand ? " · Recitbot" : ""}</title><style>${CSS}</style></head><body><main>` +
    (brand ? '<div class="brand"><img src="/s/apple-touch-icon.png" width="40" height="40" alt=""><span>recitbot</span></div>' : "") +
    `<h1>${esc(title)}</h1>${body}</main>` +
    (turnstile ? `<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>` : "") +
    "</body></html>\n";
  const headers = new Headers(HEADERS);
  if (turnstile) headers.set("content-security-policy", TURNSTILE_CSP);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(html, { status, headers });
}

export const errorPage = (env: Env, message: string, status = 400) =>
  page(env, "Can't sign in", `<p>${esc(message)}</p><p class="muted">Go back and start signing in again.</p>`, status);

const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");

/** Where a sign-in's forms post: /signin for a web sign-in, /oauth/authorize/* for an app connecting. */
export type Steps = { p: string; csrf: string; emailAction: string; codeAction: string };

export const EMAIL_HEADING = "What's your email to sign up for Rec It Bot?";

/**
 * Step 1, shared by /signin and /oauth/authorize. `client` = the app connecting, if any. `f` = the signed /signin form,
 * before the sign-in has a row. `siteKey` = the Turnstile site key (without it there is no check box, and every submit is
 * refused). `email` prefills the field.
 */
export function emailPage(
  env: Env,
  s: Steps | { f: string; emailAction: string },
  client: string | null,
  siteKey: string | undefined,
  error = "",
  cookies: string[] = [],
  email = "",
): Response {
  return page(
    env,
    branded(env) ? EMAIL_HEADING : "What's your email?",
    (client ? `<p><strong>${esc(client)}</strong> wants to connect to your ${product(env)}account.</p>` : "") +
      "<p class=\"muted\">We'll email you a 6-digit code to sign in or create your account.</p>" +
      (error ? `<p class="err" role="alert">${esc(error)}</p>` : "") +
      `<form method="post" action="${esc(s.emailAction)}">${hidden("f" in s ? { f: s.f } : { p: s.p, csrf: s.csrf })}` +
      '<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" autofocus' +
      (email ? ` value="${esc(email)}"` : "") +
      ">" +
      (siteKey ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-action="signin" data-theme="dark"></div>` : "") +
      '<button class="wide" type="submit">Email me a code</button></form>',
    error ? 400 : 200,
    cookies,
    !!siteKey,
  );
}

/** Step 2: the emailed code (the link in the email is a shortcut to the same place). */
export function codePage(env: Env, s: Steps, email: string, error = "", cookies: string[] = []): Response {
  return page(
    env,
    "Enter your code",
    `<p>We emailed a code to <strong>${esc(email)}</strong>. It expires in 10 minutes.</p>` +
      (error ? `<p class="err" role="alert">${esc(error)}</p>` : "") +
      `<form method="post" action="${esc(s.codeAction)}">${hidden({ p: s.p, csrf: s.csrf })}` +
      '<label for="code">6-digit code</label>' +
      '<input class="code" id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="9" required autofocus>' +
      '<button class="wide" type="submit">Continue</button></form>' +
      '<div class="muted">You can also open the link in the email in this browser. No email? ' +
      `<form class="inline" method="post" action="${esc(s.emailAction)}">${hidden({ p: s.p, csrf: s.csrf, resend: "1" })}` +
      '<button class="link" type="submit">Resend code</button></form></div>',
    error ? 400 : 200,
    cookies,
  );
}

export function consentPage(
  env: Env,
  p: string,
  csrf: string,
  a: { client: string; clientHost: string | null; redirectHost: string; loopback: boolean; email: string },
  cookies: string[] = [],
): Response {
  return page(
    env,
    "Allow access?",
    `<p><strong>${esc(a.client)}</strong>${a.clientHost ? ` (${esc(a.clientHost)})` : ""} wants to use your ${product(env)}account ` +
      `<strong>${esc(a.email)}</strong>: record your screen when asked and read, share and delete your recordings.</p>` +
      `<p class="muted">You'll be sent back to <strong>${esc(a.redirectHost)}</strong>.</p>` +
      (a.loopback
        ? `<p class="warn">This app runs on your own computer. Only allow it if you started connecting ${branded(env) ? "Recitbot " : ""}from an app on this computer just now.</p>`
        : "") +
      `<form method="post" action="/oauth/authorize/decide">${hidden({ p, csrf })}` +
      '<button type="submit" name="decision" value="allow">Approve</button><button class="alt" type="submit" name="decision" value="deny">Deny</button></form>',
    200,
    cookies,
  );
}

export function signoutPage(env: Env, next: string): Response {
  return page(
    env,
    "Sign out?",
    `<p>This signs you out ${branded(env) ? "of Recitbot " : ""}in this browser.</p>` +
      `<form method="post" action="/signout">${hidden({ next })}<button type="submit">Sign out</button></form>`,
  );
}
