// MCP tools for the signed-in account itself: account_info, request_email_change, confirm_email_change. Spread into
// mcp.ts TOOLS; like billing-tools.ts, import this module through mcp.ts only (it imports mcp.ts back).
// The sign-in email lives in oauth_identities (the only email an account is found by); a change needs two 6-digit codes:
// one sent to the NEW address (proves it) and one to the CURRENT address (its owner agrees), so a leaked bot token alone
// can't move the account to another inbox. Codes are never returned or logged: only their HMACs are stored
// (email_change_requests code_hash, old_code_hash).
import { z } from "zod";
import { billingOfRow, limitsOut, PLAN_NAME } from "./billing-tools";
import { contactLine, getConfig } from "./config";
import { disposableDomain } from "./disposable";
import { accountLimits, LIMITS, type Env } from "./env";
import { governor } from "./governor";
import { ToolError, tool } from "./mcp";
import { accountEmail, canonicalEmail, normalizeEmail } from "./oauth/accounts";
import { sixDigits } from "./oauth/authorize";
import { sendEmail } from "./oauth/email";
import { emailSite, renderEmailChangeCode, renderEmailChangedNotice, renderEmailChangeOldCode } from "./oauth/email-template";
import { storageStatus, withStorageWarning } from "./storage";
import { billingConfigured } from "./stripe";
import { assignUsername } from "./username";
import { hmacHex, now, safeEqual, sha256Hex } from "./util";

/** Key for the code HMACs: derived from IP_HASH_KEY under its own label, never IP_HASH_KEY itself. */
const changeKey = (env: Env) => hmacHex(env.IP_HASH_KEY, "email-change-v1");
/** Keyed (not a bare SHA-256: six digits are a million guesses offline), bound to the account and the new address. */
const codeHash = async (env: Env, accountId: string, email: string, code: string) => hmacHex(await changeKey(env), `new:${accountId}:${email}:${code}`);
/** The current address's code: bound to the account, that address (as it is at confirm time) and the new one. */
const oldCodeHash = async (env: Env, accountId: string, oldEmail: string, newEmail: string, code: string) =>
  hmacHex(await changeKey(env), `old:${accountId}:${oldEmail}:${newEmail}:${code}`);

/** The account (other than accountId) that already uses email to sign in, or as its stored address. */
async function emailTaken(env: Env, accountId: string, email: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "SELECT 1 FROM oauth_identities WHERE (email = ? OR email_canonical = ?) AND account_id <> ? UNION ALL SELECT 1 FROM accounts WHERE email = ? AND id <> ? LIMIT 1",
  )
    .bind(email, canonicalEmail(email), accountId, email, accountId)
    .first();
  return r !== null;
}

type ChangeRow = { new_email: string; code_hash: string; old_code_hash: string | null; attempts: number; expires_at: number };

export const ACCOUNT_TOOLS = {
  account_info: tool({
    auth: true,
    description:
      'Show the signed-in user\'s Recitbot account. Use it for "account status", "my account", "what plan am I on", ' +
      '"my limits", "what email is my account" and similar: username, display name, sign-up email, plan, billing_interval (monthly or yearly on Pro), limits ' +
      "(longest recording in minutes: 5 Free, 240 = 4 hours Pro, null = no plan time limit; Free recordings in total and how many are used, auto-delete, devices allowed, watermark, custom_domain: one custom video domain and page branding on Pro and Owner), how many devices are paired now, and when the account " +
      "was created. Storage: storage_used_bytes, storage_limit_bytes (Pro: 100 GB per account plus 100 GB per " +
      "add-on; null = no storage cap) and storage_addons; storage_warning, when present, is for the user: tell them. Always the account this call is signed in to, never another. For the renewal date and price call " +
      "get_plan; to change the email call request_email_change; to change the username or display name call set_username.",
    input: z.object({}),
    async run(_a, c) {
      const acct = c.principal!.accountId;
      const username = await assignUsername(c.env.DB, acct);
      const row = await c.env.DB.prepare("SELECT display_name, email, created_at, free_recordings_used, billing_interval FROM accounts WHERE id = ?")
        .bind(acct)
        .first<{ display_name: string | null; email: string | null; created_at: number; free_recordings_used: number; billing_interval: string | null }>();
      const limits = await accountLimits(c.env, acct);
      const devices = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND revoked_at IS NULL")
        .bind(acct)
        .first<{ n: number }>();
      const storage = await storageStatus(c.env, acct, limits);
      const pending = await c.env.DB.prepare("SELECT new_email FROM email_change_requests WHERE account_id = ? AND expires_at > ? AND attempts < ?")
        .bind(acct, now(), LIMITS.emailChangeMaxAttempts)
        .first<{ new_email: string }>();
      // Without billing: the account's id (for OWNER_ACCOUNT_IDS) and whether it is an owner, instead of its plan.
      const billing = billingConfigured(c.env);
      return {
        ...(!billing && { account_id: acct }),
        username,
        display_name: row?.display_name ?? null,
        email: (await accountEmail(c.env, acct)) ?? row?.email ?? null,
        ...(billing
          ? {
              plan: PLAN_NAME[limits.tier],
              // How the paid plan bills: "monthly" or "yearly"; null on Free and Owner.
              billing_interval: limits.tier === "pro" || limits.tier === "teams" ? billingOfRow(row?.billing_interval) : null,
            }
          : { owner: limits.tier === "owner" }),
        limits: limitsOut(limits),
        // Free only: how many of its max_recordings_total are used (null on plans without that limit).
        recordings_used: limits.freeRecordings === null ? null : (row?.free_recordings_used ?? 0),
        // Stored video (MP4s and transcription WAVs not yet deleted). Limit null = no storage cap (Free, Owner).
        storage_used_bytes: storage.used,
        storage_limit_bytes: storage.limit,
        ...(billing && { storage_addons: storage.addons }),
        ...withStorageWarning(storage),
        paired_devices: devices?.n ?? 0,
        created_at: row ? new Date(row.created_at * 1000).toISOString() : null,
        pending_email_change: pending?.new_email ?? null,
      };
    },
  }),

  request_email_change: tool({
    auth: true,
    description:
      "Start changing the email the user signs in to Recitbot with. Sends two 6-digit codes: one to new_email and one to " +
      "the CURRENT address. Ask the user for both, then call confirm_email_change with code (new address) and old_code " +
      "(current address); both are needed. The codes expire in 10 minutes and allow 5 tries. Nothing changes until it is " +
      "confirmed. A new request replaces the previous one. Errors: INVALID_EMAIL, SAME_EMAIL, EMAIL_TAKEN (another account " +
      "uses it), RATE_LIMITED, NO_CURRENT_EMAIL, EMAIL_UNAVAILABLE.",
    input: z.object({ new_email: z.string().min(3).max(254).describe("The address to sign in with from now on.") }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      const email = normalizeEmail(a.new_email);
      if (!z.email().max(254).safeParse(email).success) throw new ToolError("INVALID_EMAIL", "That isn't a valid email address.");
      if (disposableDomain(email)) throw new ToolError("INVALID_EMAIL", "Disposable email addresses can't be used.");

      // Rate limits first: SAME_EMAIL / EMAIL_TAKEN answers can't be used to probe addresses at speed.
      const t = now();
      const g = governor(c.env);
      const perAcct = await g.hit(`email-change:acct:${acct}`, LIMITS.emailChangesPerAccountPerHour, 3600, t);
      const perTo = perAcct.ok ? await g.hit(`email-change:to:${await sha256Hex(email)}`, LIMITS.emailChangesPerAddressPerHour, 3600, t) : perAcct;
      if (!perAcct.ok || !perTo.ok) {
        throw new ToolError("RATE_LIMITED", "Too many email change requests. Wait a while, then try again.", { retry_after: perTo.retry_after });
      }

      const current = await accountEmail(c.env, acct);
      if (current === email) throw new ToolError("SAME_EMAIL", "That is already this account's email.");
      if (!current) {
        throw new ToolError("NO_CURRENT_EMAIL", `This account has no sign-in email to confirm the change from. ${contactLine(getConfig(c.env))}.`);
      }
      if (await emailTaken(c.env, acct, email)) throw new ToolError("EMAIL_TAKEN", "Another Recitbot account already uses that email. Pick a different address.");

      const code = sixDigits();
      const oldCode = sixDigits();
      await c.env.DB.prepare(
        "INSERT INTO email_change_requests (account_id, new_email, code_hash, old_code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?) " +
          "ON CONFLICT(account_id) DO UPDATE SET new_email = excluded.new_email, code_hash = excluded.code_hash, " +
          "old_code_hash = excluded.old_code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at",
      )
        .bind(acct, email, await codeHash(c.env, acct, email, code), await oldCodeHash(c.env, acct, current, email, oldCode), t, t + LIMITS.emailChangeCodeSeconds)
        .run();
      const sentNew = await sendEmail(c.env, email, renderEmailChangeCode({ code, email }, emailSite(getConfig(c.env))), "email change code");
      const sentOld = sentNew === "sent" ? await sendEmail(c.env, current, renderEmailChangeOldCode({ code: oldCode, newEmail: email }, emailSite(getConfig(c.env))), "email change approval code") : sentNew;
      if (sentNew !== "sent" || sentOld !== "sent") {
        await c.env.DB.prepare("DELETE FROM email_change_requests WHERE account_id = ?").bind(acct).run();
        throw new ToolError("EMAIL_UNAVAILABLE", "The code emails couldn't be sent right now. Try again later.");
      }
      return {
        sent_to: email,
        approval_sent_to: current,
        expires_in_minutes: LIMITS.emailChangeCodeSeconds / 60,
        note:
          `Two 6-digit codes went out: one to ${email} (the new address) and one to ${current} (the current address). Ask ` +
          "the user for both, then call confirm_email_change with code (new address) and old_code (current address). " +
          "The current email keeps working until then.",
      };
    },
  }),

  confirm_email_change: tool({
    auth: true,
    description:
      "Finish an email change started with request_email_change: pass code (the 6-digit code the user got at the NEW " +
      "address) and old_code (the one they got at the CURRENT address). Both are required. On success the account signs " +
      "in with the new email only, and the old address gets a notice. Errors: NO_PENDING_CHANGE, CODE_EXPIRED, WRONG_CODE " +
      "(one or both codes wrong; attempts_left), TOO_MANY_ATTEMPTS, EMAIL_TAKEN.",
    input: z.object({
      code: z.string().trim().regex(/^\d{6}$/, "the code is 6 digits").describe("The 6-digit code sent to the new address."),
      old_code: z.string().trim().regex(/^\d{6}$/, "the code is 6 digits").describe("The 6-digit code sent to the current address."),
    }),
    async run(a, c) {
      const acct = c.principal!.accountId;
      const t = now();
      // Count the attempt first, atomically: concurrent guesses can't go past the limit.
      const row = await c.env.DB.prepare(
        "UPDATE email_change_requests SET attempts = attempts + 1 WHERE account_id = ? AND attempts < ? AND expires_at > ? " +
          "RETURNING new_email, code_hash, old_code_hash, attempts, expires_at",
      )
        .bind(acct, LIMITS.emailChangeMaxAttempts, t)
        .first<ChangeRow>();
      if (!row) {
        const left = await c.env.DB.prepare("SELECT attempts, expires_at FROM email_change_requests WHERE account_id = ?")
          .bind(acct)
          .first<{ attempts: number; expires_at: number }>();
        if (!left) throw new ToolError("NO_PENDING_CHANGE", "There is no email change waiting. Start one with request_email_change.");
        if (left.expires_at <= t) {
          await c.env.DB.prepare("DELETE FROM email_change_requests WHERE account_id = ?").bind(acct).run();
          throw new ToolError("CODE_EXPIRED", "That code has expired. Call request_email_change for a new one.");
        }
        throw new ToolError("TOO_MANY_ATTEMPTS", "Too many wrong codes. Call request_email_change for a new one.");
      }
      // Both codes, both always checked (the answer never says which one was wrong). The old one is bound to the current
      // address: if it changed since the request, the request can't be confirmed.
      const oldEmail = await accountEmail(c.env, acct);
      const newOk = safeEqual(await codeHash(c.env, acct, row.new_email, a.code), row.code_hash);
      const oldOk = !!oldEmail && !!row.old_code_hash && safeEqual(await oldCodeHash(c.env, acct, oldEmail, row.new_email, a.old_code), row.old_code_hash);
      if (!newOk || !oldOk) {
        const attemptsLeft = Math.max(0, LIMITS.emailChangeMaxAttempts - row.attempts);
        if (!attemptsLeft) throw new ToolError("TOO_MANY_ATTEMPTS", "Too many wrong codes. Call request_email_change for new ones.");
        throw new ToolError("WRONG_CODE", "One or both codes aren't right. Check both emails and try again.", { attempts_left: attemptsLeft });
      }

      // One transaction, every statement keyed on this very request row: whichever call deletes it first wins (single use).
      const mine = "EXISTS (SELECT 1 FROM email_change_requests WHERE account_id = ? AND code_hash = ?)";
      let res: D1Result[];
      try {
        res = await c.env.DB.batch([
          c.env.DB.prepare(`DELETE FROM oauth_identities WHERE account_id = ? AND ${mine}`).bind(acct, acct, row.code_hash),
          c.env.DB.prepare(
            "INSERT INTO oauth_identities (email, email_canonical, account_id, created_at) SELECT new_email, ?, account_id, ? FROM email_change_requests WHERE account_id = ? AND code_hash = ?",
          ).bind(canonicalEmail(row.new_email), t, acct, row.code_hash),
          c.env.DB.prepare(`UPDATE accounts SET email = ? WHERE id = ? AND ${mine}`).bind(row.new_email, acct, acct, row.code_hash),
          c.env.DB.prepare("DELETE FROM email_change_requests WHERE account_id = ? AND code_hash = ?").bind(acct, row.code_hash),
        ]);
      } catch (e) {
        // oauth_identities.email and email_canonical are unique: another account took the address since the request.
        if (!/UNIQUE|constraint/i.test(String(e))) throw e;
        await c.env.DB.prepare("DELETE FROM email_change_requests WHERE account_id = ? AND code_hash = ?").bind(acct, row.code_hash).run();
        throw new ToolError("EMAIL_TAKEN", "Another Recitbot account started using that email in the meantime. Pick a different address.");
      }
      if (res[3].meta.changes !== 1) throw new ToolError("NO_PENDING_CHANGE", "There is no email change waiting. Start one with request_email_change.");

      let notified = false;
      if (oldEmail && oldEmail !== row.new_email) {
        notified = (await sendEmail(c.env, oldEmail, renderEmailChangedNotice({ oldEmail, newEmail: row.new_email }, emailSite(getConfig(c.env))), "email changed notice")) === "sent";
      }
      return {
        email: row.new_email,
        previous_email_notified: notified,
        note: `Done: the account now signs in with ${row.new_email}. The old address no longer signs in` + (notified ? " and got a notice." : "."),
      };
    },
  }),
};
