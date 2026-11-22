// Accounts for OAuth sign-in. An account is found only through an email proven by a magic link or code
// (oauth_identities); accounts.email from the old signup tool was never verified and is not trusted.
import { getConfig } from "../config";
import type { Env } from "../env";
import { now, randomId } from "../util";
import { assignUsername } from "./username-hook";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * One mailbox, one form: lowercase, no `+tag`, and for Gmail no dots in the local part (googlemail.com = gmail.com). Used
 * for uniqueness and rate limits only; mail goes to the address as typed. Migration 0020 backfills the same rule in SQL.
 */
export function canonicalEmail(email: string): string {
  const addr = normalizeEmail(email);
  const at = addr.indexOf("@");
  if (at < 0) return addr;
  let local = addr.slice(0, at);
  let domain = addr.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

/** The exact address first (rows the 0020 backfill left without a canonical form), else any variant of the mailbox. */
export async function findAccount(env: Env, email: string): Promise<string | null> {
  const addr = normalizeEmail(email);
  const row = await env.DB.prepare("SELECT account_id FROM oauth_identities WHERE email = ? OR email_canonical = ? ORDER BY email = ? DESC LIMIT 1")
    .bind(addr, canonicalEmail(addr), addr)
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/** createAccount while SIGNUPS_DISABLED is on (config.ts auth.signupsDisabled). */
export class SignupsDisabledError extends Error {
  constructor() {
    super("New signups are closed.");
  }
}

/** Whether a new account may be created for email: signups open, or the address is on SIGNUPS_ALLOWLIST (exact, any case). */
export function signupAllowed(env: Env, email: string): boolean {
  const { signupsDisabled, signupAllowlist } = getConfig(env).auth;
  return !signupsDisabled || signupAllowlist.includes(normalizeEmail(email));
}

/**
 * The only place accounts are created. Refuses (SignupsDisabledError) while signups are disabled, whoever calls it,
 * unless the email is on SIGNUPS_ALLOWLIST. The one other exception is the first owner of a server without any account
 * (claim.ts takeClaim).
 */
export async function createAccount(env: Env, email: string): Promise<string> {
  if (!signupAllowed(env, email)) throw new SignupsDisabledError();
  const addr = normalizeEmail(email);
  const accountId = randomId(128);
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)").bind(accountId, addr, t),
    env.DB.prepare("INSERT INTO oauth_identities (email, email_canonical, account_id, created_at) VALUES (?, ?, ?, ?)").bind(addr, canonicalEmail(addr), accountId, t),
  ]);
  await assignUsername(env, accountId, addr);
  return accountId;
}

/**
 * Existing account for a verified email, else a new one (a concurrent creation for the same mailbox wins the race; none
 * while signups are disabled: createAccount throws).
 */
export async function findOrCreateAccount(env: Env, email: string): Promise<string> {
  const found = await findAccount(env, email);
  if (found) return found;
  try {
    return await createAccount(env, email);
  } catch (e) {
    const again = await findAccount(env, email);
    if (again) return again;
    throw e;
  }
}

/** The proven email an account signs in with (for the consent page when a web session skips the email step). */
export async function accountEmail(env: Env, accountId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT email FROM oauth_identities WHERE account_id = ? ORDER BY created_at LIMIT 1")
    .bind(accountId)
    .first<{ email: string }>();
  return row?.email ?? null;
}
