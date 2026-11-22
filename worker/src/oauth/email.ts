// Sign-in email through the Cloudflare Email Sending binding (EMAIL), from EMAIL_FROM as BRAND_NAME. On loopback dev
// hosts with OAUTH_DEV_LOG_LINKS=1 the link and code are logged instead of sent. Without the binding anywhere else,
// sign-in fails closed.
import { getConfig } from "../config";
import type { Env } from "../env";
import { log } from "../util";
import { emailSite, renderSigninEmail } from "./email-template";
import { isDevHost } from "./hosts";

export type SendResult = "sent" | "logged" | "unconfigured" | "failed";

export async function sendSigninEmail(env: Env, to: string, link: string, code: string): Promise<SendResult> {
  if (isDevHost(new URL(link)) && env.OAUTH_DEV_LOG_LINKS === "1") {
    console.log(`[magic-link] to=${to} link=${link} code=${code}`);
    return "logged";
  }
  return sendEmail(env, to, renderSigninEmail({ code, link, email: to }, emailSite(getConfig(env))), "sign-in");
}

/**
 * Any Recitbot email through the EMAIL binding, from EMAIL_FROM as BRAND_NAME (the sign-in email's sender). Never logs
 * the message: `what` names it in the failure log. No binding or no EMAIL_FROM = "unconfigured" (no dev logging here:
 * codes sent this way, like email change codes, must never reach a log).
 */
export async function sendEmail(env: Env, to: string, msg: { subject: string; text: string; html: string }, what: string): Promise<SendResult> {
  const { email } = getConfig(env);
  if (!env.EMAIL || !email.enabled || !email.from) {
    log("error", `${what} email not sent: ${env.EMAIL ? "EMAIL_FROM is not set" : "no EMAIL (send_email) binding"}`);
    return "unconfigured";
  }
  try {
    await env.EMAIL.send({ from: email.fromName === null ? email.from : { email: email.from, name: email.fromName }, to, ...msg });
    return "sent";
  } catch (e) {
    log("warn", `${what} email failed`, { err: e instanceof Error ? e.message : String(e) });
    return "failed";
  }
}
