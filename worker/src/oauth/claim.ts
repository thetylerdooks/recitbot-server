// One-time owner claim: how a fresh server gets its owner without sign-up, sign-in, email or a domain. The setup bot puts a
// random OWNER_CLAIM_SECRET (wrangler secret put) and sends it to POST /claim (claim-route.ts); the answer holds the owner's
// API key, once.
//
// Open only while ALL of these hold; otherwise POST /claim is the 404 of a path that doesn't exist, even with the right
// secret:
//   - OWNER_CLAIM_SECRET is set (config.ts auth.claim: at least 32 characters),
//   - no owner exists: OWNER_ACCOUNT_IDS is empty AND D1 has no account at all (the safest reading: a server anyone has
//     ever signed in to can't be claimed over, whatever those accounts' plans),
//   - it was never claimed (no server_claim row, migration 0034).
// SIGNUPS_DISABLED doesn't close it: the claim makes a server's first account only (it needs zero accounts), and takeClaim
// is the only place besides createAccount (accounts.ts, which does refuse) that creates one.
// The claim writes the server_claim row, the account (plan 'owner': no limits) and the key's hash in one D1 transaction
// whose first statement checks all of that again, so of two concurrent claims only one can win.
// The secret, what was submitted and the key are never logged; the key is stored hashed only, like every API key.
import { getConfig } from "../config";
import type { Env } from "../env";
import { serviceMode } from "../env";
import { log, now, randomId } from "../util";
import { assignUsername } from "./username-hook";

/** Claim attempts per IP per hour, and in all per UTC day (Governor; an attempt that can't be counted is refused). */
export const CLAIMS_PER_IP_PER_HOUR = 5;
export const CLAIMS_PER_DAY = 20;

/** No secret (every server that isn't being set up this way) = no D1 read either. */
export async function claimOpen(env: Env): Promise<boolean> {
  const { auth } = getConfig(env);
  if (!auth.claim.enabled || auth.ownerAccountIds.length > 0 || !["ON", "NO_TRANSCRIBE"].includes(serviceMode(env))) return false;
  try {
    const r = await env.DB.prepare("SELECT EXISTS (SELECT 1 FROM accounts) OR EXISTS (SELECT 1 FROM server_claim) AS taken").first<{ taken: number }>();
    return r?.taken === 0;
  } catch (e) {
    log("error", "owner claim check failed", { err: String(e) });
    return false;
  }
}

/** Constant-time: both values become HMACs under a random one-time key, so neither length nor content shows in timing. */
export async function claimSecretMatches(env: Env, given: string): Promise<boolean> {
  const secret = (env.OWNER_CLAIM_SECRET ?? "").trim();
  if (!secret || !getConfig(env).auth.claim.enabled) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [a, b] = await Promise.all([secret, given.trim()].map((s) => crypto.subtle.sign("HMAC", key, enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Takes the claim and creates the owner account (no email) with its first API key (auth.ts newApiKey; only its id and hash
 * come in here). Returns the account id, or null when someone was first.
 */
export async function takeClaim(env: Env, key: { id: string; hash: string }): Promise<string | null> {
  const accountId = randomId(128);
  const t = now();
  const mine = "EXISTS (SELECT 1 FROM server_claim WHERE id = 1 AND account_id = ?)";
  const res = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO server_claim (id, account_id, claimed_at) SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts) " +
        "AND NOT EXISTS (SELECT 1 FROM server_claim)",
    ).bind(accountId, t),
    env.DB.prepare(`INSERT INTO accounts (id, email, plan, created_at) SELECT ?, NULL, 'owner', ? WHERE ${mine}`).bind(accountId, t, accountId),
    env.DB.prepare(`INSERT INTO api_keys (id, key_hash, account_id, created_at) SELECT ?, ?, ?, ? WHERE ${mine}`).bind(key.id, key.hash, accountId, t, accountId),
  ]);
  if (res[0].meta.changes !== 1) return null;
  // The claim is used up by now, so a failure here must not cost the caller the key (set_username can name the account).
  await assignUsername(env, accountId, "owner").catch((e) => log("error", "owner claim: username", { err: String(e) }));
  return accountId;
}

/** The account that claimed this server; null = never claimed. */
export async function claimedOwner(env: Env): Promise<string | null> {
  try {
    return (await env.DB.prepare("SELECT account_id FROM server_claim WHERE id = 1").first<{ account_id: string }>())?.account_id ?? null;
  } catch (e) {
    log("error", "owner claim lookup failed", { err: String(e) });
    return null;
  }
}
