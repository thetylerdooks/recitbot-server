// The sign-in email (6-digit code, optional magic link). Table layout with inline styles; the <style> block only adds
// dark mode and small-screen tweaks. The code is a single text node, so double-click selects just the digits.
import { contactLine, type SelfHostConfig } from "../config";
import { esc } from "./pages";

/**
 * The deployment details an email shows (config.ts): the logo comes from the canonical base URL's /s/ assets, the
 * footer names its host, the "didn't ask for this" lines name the support address (or the operator).
 */
export type EmailSite = {
  baseUrl: string | null;
  /** BRAND_NAME is set: the product's name and logo are shown. Without it no name, logo or wordmark. */
  branded: boolean;
  supportLine: (verb: string) => string;
};
export const emailSite = (c: SelfHostConfig): EmailSite => ({
  baseUrl: c.site.canonicalBaseUrl,
  branded: c.site.brandName !== null,
  supportLine: (verb) => contactLine(c, verb),
});
/** "Your Recitbot code" / "Your code". */
const product = (site: EmailSite) => (site.branded ? "Recitbot " : "");
/** "signed in to Recitbot" / "signed in to this server". */
const service = (site: EmailSite) => (site.branded ? "Recitbot" : "this server");

const INK = "#111318";
const PAPER = "#F5F3EE";
const RED = "#F2463A";
const GRAPHITE = "#5B606B";
const HEADING_FONT = "'Space Grotesk','Segoe UI',Helvetica,Arial,sans-serif";
const BODY_FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const CODE_FONT = "'JetBrains Mono',Consolas,'Courier New',monospace";

const STYLE =
  ":root{color-scheme:light dark;supported-color-schemes:light dark}" +
  "@media (max-width:600px){.rb-card{padding:28px 20px !important}.rb-code{font-size:36px !important;letter-spacing:6px !important}}" +
  `@media (prefers-color-scheme:dark){.rb-bg{background-color:${INK} !important}.rb-card{background-color:${PAPER} !important}` +
  `.rb-ink{color:${INK} !important}.rb-muted{color:${GRAPHITE} !important}.rb-foot{color:#A9ADB6 !important}}` +
  `[data-ogsb] .rb-bg{background-color:${INK} !important}[data-ogsb] .rb-card{background-color:${PAPER} !important}` +
  `[data-ogsc] .rb-ink{color:${INK} !important}[data-ogsc] .rb-muted{color:${GRAPHITE} !important}[data-ogsc] .rb-foot{color:#A9ADB6 !important}`;

function button(site: EmailSite, link: string): string {
  const label = site.branded ? "Sign in to Recitbot" : "Sign in";
  const href = esc(link);
  return (
    `<tr><td align="center" style="padding:28px 0 0">` +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" ` +
    `style="height:50px;v-text-anchor:middle;width:260px" arcsize="20%" stroke="f" fillcolor="${RED}"><w:anchorlock/>` +
    `<center style="color:${INK};font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:bold">${label}</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!--><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>` +
    `<td align="center" bgcolor="${RED}" style="border-radius:10px;background-color:${RED}">` +
    `<a href="${href}" target="_blank" style="display:inline-block;padding:15px 30px;font-family:${HEADING_FONT};font-size:16px;line-height:20px;` +
    `font-weight:700;color:${INK};text-decoration:none;border-radius:10px">${label}</a></td></tr></table><!--<![endif]-->` +
    `</td></tr>` +
    `<tr><td class="rb-muted" style="padding:20px 0 0;font-family:${BODY_FONT};font-size:13px;line-height:20px;color:${GRAPHITE};word-break:break-all">` +
    `Or open this link in the browser where you started:<br><a href="${href}" target="_blank" class="rb-ink" style="color:${INK};text-decoration:underline">${href}</a></td></tr>`
  );
}

/** The shared shell: logo + wordmark, a heading, then `rows` (table rows), then the footer. */
function layout(site: EmailSite, title: string, preheader: string, heading: string, rows: string): string {
  const logo = site.baseUrl
    ? `<td style="padding:0 12px 0 0;vertical-align:middle"><img src="${esc(site.baseUrl)}/s/apple-touch-icon.png" width="48" height="48" alt="Recitbot" style="display:block;border:0;border-radius:10px"></td>`
    : "";
  const foot = [...(site.branded ? ["Recitbot"] : []), ...(site.baseUrl ? [esc(new URL(site.baseUrl).host)] : [])].join(" · ");
  return (
    '<!doctype html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="x-ua-compatible" content="ie=edge">' +
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body class="rb-bg" style="margin:0;padding:0;background-color:#E9E6DF;-webkit-text-size-adjust:100%">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader)}</div>` +
    `<table role="presentation" class="rb-bg" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#E9E6DF" style="background-color:#E9E6DF">` +
    '<tr><td align="center" style="padding:32px 12px">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px">' +
    `<tr><td height="4" bgcolor="${RED}" style="height:4px;background-color:${RED};font-size:0;line-height:0;border-radius:12px 12px 0 0">&nbsp;</td></tr>` +
    `<tr><td class="rb-card" bgcolor="${PAPER}" style="background-color:${PAPER};padding:36px 40px;border-radius:0 0 12px 12px">` +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">' +
    // Logo + wordmark
    (site.branded
      ? '<tr><td style="padding:0 0 28px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>' +
        logo +
        `<td class="rb-ink" style="vertical-align:middle;font-family:${HEADING_FONT};font-size:26px;line-height:30px;font-weight:700;letter-spacing:-0.3px;color:${INK}">recitbot</td>` +
        "</tr></table></td></tr>"
      : "") +
    `<tr><td class="rb-ink" style="font-family:${HEADING_FONT};font-size:24px;line-height:30px;font-weight:700;color:${INK};padding:0 0 10px">${esc(heading)}</td></tr>` +
    rows +
    "</table></td></tr>" +
    (foot && `<tr><td class="rb-foot" align="center" style="font-family:${BODY_FONT};font-size:12px;line-height:18px;color:${GRAPHITE};padding:18px 0 0">${foot}</td></tr>`) +
    "</table></td></tr></table></body></html>\n"
  );
}

/** A paragraph row; `html` is already escaped. */
const para = (html: string) =>
  `<tr><td class="rb-ink" style="font-family:${BODY_FONT};font-size:16px;line-height:24px;color:${INK};padding:0 0 20px">${html}</td></tr>`;
const muted = (html: string, pad = "28px 0 0") =>
  `<tr><td class="rb-muted" style="font-family:${BODY_FONT};font-size:13px;line-height:20px;color:${GRAPHITE};padding:${pad}">${html}</td></tr>`;

/** The 6-digit code: Ink on white in one text node; letter-spacing only (padding-left balances the trailing spacing). */
function codeBox(code: string): string {
  return (
    '<tr><td align="center" bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E4E0D8;border-radius:10px;padding:18px 12px">' +
    `<span class="rb-code rb-ink" style="display:inline-block;padding-left:8px;font-family:${CODE_FONT};font-size:38px;line-height:46px;font-weight:700;` +
    `letter-spacing:8px;color:${INK};mso-line-height-rule:exactly">${esc(code)}</span></td></tr>` +
    `<tr><td class="rb-muted" align="center" style="font-family:${BODY_FONT};font-size:14px;line-height:20px;color:${GRAPHITE};padding:12px 0 0">Expires in 10 minutes.</td></tr>`
  );
}

type Rendered = { subject: string; text: string; html: string };

export function renderSigninEmail({ code, link, email }: { code: string; link?: string; email: string }, site: EmailSite): Rendered {
  const subject = `Your ${product(site)}code: ${code}`;
  const text =
    `Your ${product(site)}sign-in code\n\n` +
    `Enter this code in the browser where you started signing in as ${email}:\n\n` +
    `${code}\n\n` +
    "Expires in 10 minutes.\n\n" +
    (link ? `Or open this link in the browser where you started:\n${link}\n\n` : "") +
    "If you didn't ask for this, you can ignore this email.\n";
  const html = layout(
    site,
    `Your ${product(site)}sign-in code`,
    "Your sign-in code expires in 10 minutes.",
    "Your sign-in code",
    para(`Enter this code in the browser where you started signing in as <strong>${esc(email)}</strong>.`) +
      codeBox(code) +
      (link ? button(site, link) : "") +
      muted("If you didn't ask for this, you can ignore this email."),
  );
  return { subject, text, html };
}

/** Sent to the NEW address by request_email_change: the code the user gives their bot (confirm_email_change). */
export function renderEmailChangeCode({ code, email }: { code: string; email: string }, site: EmailSite): Rendered {
  const subject = `Your ${product(site)}code: ${code}`;
  const text =
    `Confirm your new ${product(site)}email\n\n` +
    `Someone signed in to ${service(site)} asked to change the account's email to ${email}. If that was you, give this code to your bot:\n\n` +
    `${code}\n\n` +
    "Expires in 10 minutes.\n\n" +
    "If you didn't ask for this, ignore this email. Nothing changes without the code.\n";
  const html = layout(
    site,
    `Confirm your new ${product(site)}email`,
    "Your email change code expires in 10 minutes.",
    "Confirm your new email",
    para(`Someone signed in to ${service(site)} asked to change the account's email to <strong>${esc(email)}</strong>. If that was you, give this code to your bot.`) +
      codeBox(code) +
      muted("If you didn't ask for this, ignore this email. Nothing changes without the code."),
  );
  return { subject, text, html };
}

/** Sent to the CURRENT address by request_email_change: its code approves moving the account to newEmail. */
export function renderEmailChangeOldCode({ code, newEmail }: { code: string; newEmail: string }, site: EmailSite): Rendered {
  const subject = `Your ${product(site)}code: ${code}`;
  const text =
    `Approve your ${product(site)}email change\n\n` +
    `Someone signed in to your ${product(site)}account asked to move it from this address to ${newEmail}. If that was you, give this code to your bot, along with the code sent to ${newEmail}:\n\n` +
    `${code}\n\n` +
    "Expires in 10 minutes.\n\n" +
    `If you didn't ask for this, don't share the code. Nothing changes without it. ${site.supportLine("Write to")} so we can check your account.\n`;
  const html = layout(
    site,
    `Approve your ${product(site)}email change`,
    "Your email change approval code expires in 10 minutes.",
    "Approve your email change",
    para(
      `Someone signed in to your ${product(site)}account asked to move it from this address to <strong>${esc(newEmail)}</strong>. ` +
        `If that was you, give this code to your bot, along with the code sent to ${esc(newEmail)}.`,
    ) +
      codeBox(code) +
      muted(esc(`If you didn't ask for this, don't share the code. Nothing changes without it. ${site.supportLine("Write to")} so we can check your account.`)),
  );
  return { subject, text, html };
}

/** Sent to the OLD address after confirm_email_change: the account now signs in with newEmail. */
export function renderEmailChangedNotice({ oldEmail, newEmail }: { oldEmail: string; newEmail: string }, site: EmailSite): Rendered {
  const subject = `Your ${product(site)}email was changed`;
  const text =
    `Your ${product(site)}email was changed\n\n` +
    `The ${product(site)}account that signed in as ${oldEmail} now signs in as ${newEmail}. This address no longer signs in to it.\n\n` +
    `If you didn't make this change, ${site.supportLine("write to")} right away.\n`;
  const html = layout(
    site,
    `Your ${product(site)}email was changed`,
    `Your ${product(site)}account now signs in with a different email.`,
    "Your email was changed",
    para(
      `The ${product(site)}account that signed in as <strong>${esc(oldEmail)}</strong> now signs in as <strong>${esc(newEmail)}</strong>. ` +
        "This address no longer signs in to it.",
    ) + muted(esc(`If you didn't make this change, ${site.supportLine("write to")} right away.`), "8px 0 0"),
  );
  return { subject, text, html };
}
