// API keys, device tokens and pairing codes. Only SHA-256 hashes are stored; lookups use a public id prefix. Each paired
// device has its own token; revoking one leaves the account's other devices paired.
import { deviceHub, type UninstallScope } from "./device-hub";
import type { Env } from "./env";
import { accountLimits } from "./env";
import { verifyAccessToken } from "./oauth/tokens";
import { accountSuspended } from "./takedown-state";
import { now, randomId, safeEqual, sha256Hex } from "./util";

/** keyId: the api_keys id, or "oauth:<token family>" for OAuth access tokens (oauth: true). */
export type Principal = { accountId: string; keyId: string; oauth?: true };

/** A new API key; only its id and hash are ever stored. */
export async function newApiKey(): Promise<{ key: string; id: string; hash: string }> {
  const id = randomId(64);
  const key = `ark_${id}_${randomId(256)}`;
  return { key, id, hash: await sha256Hex(key) };
}

export async function issueApiKey(env: Env, accountId: string): Promise<string> {
  const { key, id, hash } = await newApiKey();
  await env.DB.prepare("INSERT INTO api_keys (id, key_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, hash, accountId, now())
    .run();
  return key;
}

export async function verifyApiKey(env: Env, key: string): Promise<Principal | null> {
  const m = /^ark_([A-Za-z0-9]{8,20})_([A-Za-z0-9]{40,60})$/.exec(key);
  if (!m) return null;
  const row = await env.DB.prepare("SELECT key_hash, account_id FROM api_keys WHERE id = ? AND revoked_at IS NULL")
    .bind(m[1])
    .first<{ key_hash: string; account_id: string }>();
  const hash = await sha256Hex(key);
  // Compare against a dummy when the id is unknown so timing does not reveal valid ids.
  const ok = safeEqual(hash, row?.key_hash ?? "0".repeat(64));
  return ok && row ? { accountId: row.account_id, keyId: m[1] } : null;
}

/**
 * A static API key (ark_...) or an OAuth access token (rbat_..., must be bound to `resource`). "stale" = a genuine OAuth
 * token that is expired, revoked or issued for another resource.
 */
export async function verifyBearer(env: Env, key: string, resource: string): Promise<Principal | "stale" | null> {
  return key.startsWith("rbat_") ? verifyAccessToken(env, key, resource) : verifyApiKey(env, key);
}

export async function revokeApiKey(env: Env, keyId: string): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(now(), keyId).run();
}

/** `platform`: what get_installer was asked for; the device that enrolls with the code is recorded as that platform. */
export async function issuePairingCode(
  env: Env,
  accountId: string,
  ttl: number,
  platform: "windows" | "macos" = "windows",
): Promise<{ code: string; expires_at: number }> {
  const code = randomId(96);
  const expires_at = now() + ttl;
  await env.DB.prepare("INSERT INTO pairing_codes (code_hash, account_id, expires_at, platform) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(code), accountId, expires_at, platform)
    .run();
  return { code, expires_at };
}

/** A new device id and its token (ardt_<device id>_<secret>). Only the token's hash is ever stored. */
export function newDeviceToken(): { deviceId: string; token: string } {
  const deviceId = randomId(128);
  return { deviceId, token: `ardt_${deviceId}_${randomId(256)}` };
}

export type Pairing =
  | { ok: true; accountId: string; deviceId: string; token: string; replaced: string | null }
  | { ok: false; error: "invalid_code" }
  | { ok: false; error: "account_suspended"; accountId: string }
  | { ok: false; error: "device_revoked"; scope: UninstallScope }
  | { ok: false; error: "device_limit"; accountId: string; max: number };

/**
 * Pairs a device with a pairing code. The code is single use and only valid before expiry. Other devices of the account
 * stay paired; the account's device limit (accountLimits.maxDevices) is checked in the same transaction that consumes
 * the code, so a refused pairing changes nothing (the code stays usable). Re-pairing the same PC does not take another
 * slot: when it sends its current device token and the same platform, that device row is reused (same device id, new
 * token). So is a row whose platform was only inferred (platform_reported null: the pairing code's, or 0017's backfill),
 * and it takes the platform resolved now, so a Mac once recorded as "windows" is corrected instead of duplicated; a
 * platform the recorder reported earlier is kept (another platform pairs a new device). Without a token (older
 * recorders), an active device of the account with the same name, public IP and platform is replaced, but only while it
 * is not connected (a connected one is another PC: a new device is added). A token of an uninstalled device of the
 * same account (revoked_device_tokens) is refused with device_revoked. Every read and write is scoped to the code's
 * account: a token of another account (one install paired with several accounts) only means no row is reused, and no
 * device of another account is ever revoked or changed.
 */
export async function pairDevice(
  env: Env,
  code: string,
  d: { name: string; platform: string | null; ipHash: string; deviceToken?: string },
): Promise<Pairing> {
  if (!/^[A-Za-z0-9]{10,40}$/.test(code)) return { ok: false, error: "invalid_code" };
  const codeHash = await sha256Hex(code);
  const live = () =>
    env.DB.prepare("SELECT account_id, platform FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .bind(codeHash, now())
      .first<{ account_id: string; platform: string | null }>();
  const pc = await live();
  if (!pc) return { ok: false, error: "invalid_code" };
  const accountId = pc.account_id;
  // A suspended account (an open admin takedown) pairs nothing; the code stays unused.
  if (await accountSuspended(env, accountId)) return { ok: false, error: "account_suspended", accountId };
  const revoked = d.deviceToken ? await revokedDeviceToken(env, d.deviceToken) : null;
  if (revoked && (revoked.accountId ?? accountId) === accountId) return { ok: false, error: "device_revoked", scope: revoked.scope };
  // What the recorder reports wins; the pairing code's platform (get_installer) fills in for recorders that send none
  // (older Windows and Mac ones). Neither: unknown (null), never a guess.
  const platform = d.platform ?? pc.platform ?? null;
  const reported = d.platform ? 1 : null;

  const prev = d.deviceToken ? await verifyDeviceToken(env, d.deviceToken) : null;
  const reuse =
    prev && prev.accountId === accountId && (prev.platform === platform || !prev.platformReported) ? prev.deviceId : null;
  const replaced = reuse ?? (d.deviceToken ? null : await offlineTwin(env, accountId, { ...d, platform }));
  const max = (await accountLimits(env, accountId)).maxDevices;
  const fresh = newDeviceToken();
  const deviceId = reuse ?? fresh.deviceId;
  const token = reuse ? `ardt_${reuse}_${randomId(256)}` : fresh.token;
  const t = now();
  const mine = "EXISTS (SELECT 1 FROM pairing_codes WHERE code_hash = ? AND device_id = ?)";
  const res = await env.DB.batch([
    env.DB.prepare(
      "UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? " +
        "AND (SELECT count(*) FROM devices WHERE account_id = ? AND revoked_at IS NULL AND id IS NOT ?) < ?",
    ).bind(t, deviceId, codeHash, t, accountId, replaced, max ?? Number.MAX_SAFE_INTEGER),
    reuse
      ? env.DB.prepare(
          "UPDATE devices SET token_hash = ?, name = ?, platform = coalesce(?, platform), platform_reported = coalesce(?, platform_reported) " +
            `WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND ${mine}`,
        ).bind(
          await sha256Hex(token),
          d.name,
          platform,
          reported,
          reuse,
          accountId,
          codeHash,
          deviceId,
        )
      : env.DB.prepare(
          `UPDATE devices SET revoked_at = ?, revoke_reason = 'replaced_by_repair' WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND ${mine}`,
        ).bind(
          t,
          replaced,
          accountId,
          codeHash,
          deviceId,
        ),
    ...(reuse
      ? []
      : [
          env.DB.prepare(
            `INSERT INTO devices (id, account_id, token_hash, name, platform, platform_reported, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${mine}`,
          ).bind(deviceId, accountId, await sha256Hex(token), d.name, platform, reported, t, codeHash, deviceId),
        ]),
    env.DB.prepare(`UPDATE accounts SET paired_at = coalesce(paired_at, ?) WHERE id = ? AND ${mine}`).bind(t, accountId, codeHash, deviceId),
  ]);
  if (res[0].meta.changes === 1) return { ok: true, accountId, deviceId, token, replaced };
  // Nothing was written: the code went (used or expired in the meantime), or the account is at its limit.
  return (await live()) && max !== null ? { ok: false, error: "device_limit", accountId, max } : { ok: false, error: "invalid_code" };
}

/** The newest active device of the account with this name, public IP and platform that is not connected right now. */
async function offlineTwin(env: Env, accountId: string, d: { name: string; platform: string | null; ipHash: string }): Promise<string | null> {
  const rows = (
    await env.DB.prepare(
      "SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL AND name = ? AND ip_hash = ? AND platform IS ? ORDER BY created_at DESC",
    )
      .bind(accountId, d.name, d.ipHash, d.platform)
      .all<{ id: string }>()
  ).results;
  if (!rows.length) return null;
  const online = await deviceHub(env, accountId).online(accountId);
  return rows.find((r) => !online.includes(r.id))?.id ?? null;
}

/** Revokes one device of the account (its token stops working at once). False when it is not an active device there. */
export async function revokeDevice(env: Env, accountId: string, deviceId: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE devices SET revoked_at = ?, revoke_reason = 'user_revoked' WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
    .bind(now(), deviceId, accountId)
    .run();
  return r.meta.changes === 1;
}

export async function verifyDeviceToken(
  env: Env,
  token: string,
): Promise<{ deviceId: string; accountId: string; platform: string | null; platformReported: boolean } | null> {
  const m = /^ardt_([A-Za-z0-9]{20,30})_([A-Za-z0-9]{40,60})$/.exec(token);
  if (!m) return null;
  const row = await env.DB.prepare("SELECT token_hash, account_id, platform, platform_reported FROM devices WHERE id = ? AND revoked_at IS NULL")
    .bind(m[1])
    .first<{ token_hash: string; account_id: string; platform: string | null; platform_reported: number | null }>();
  const ok = safeEqual(await sha256Hex(token), row?.token_hash ?? "0".repeat(64));
  return ok && row ? { deviceId: m[1], accountId: row.account_id, platform: row.platform, platformReported: row.platform_reported === 1 } : null;
}

/**
 * The token belongs to a device removed by uninstall_recorder: the caller answers 410 device_revoked (not 401).
 * accountId: whose device it was (null for uninstalls before 0017). scope: what the uninstall asked the recorder to remove.
 */
export async function revokedDeviceToken(env: Env, token: string): Promise<{ accountId: string | null; scope: UninstallScope } | null> {
  if (!/^ardt_[A-Za-z0-9]{20,30}_[A-Za-z0-9]{40,60}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT account_id, scope FROM revoked_device_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ account_id: string | null; scope: UninstallScope }>();
  return row ? { accountId: row.account_id, scope: row.scope } : null;
}

/**
 * Uninstall: records the device's token hash and the uninstall's scope in revoked_device_tokens, then deletes the device
 * row (one transaction, in that order). In-flight recordings on it fail. Only this account's device is touched, whatever
 * the scope. False when it is not a device of the account.
 */
export async function uninstallDevice(env: Env, accountId: string, deviceId: string, scope: UninstallScope): Promise<boolean> {
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO revoked_device_tokens (token_hash, device_id, revoked_at, account_id, name, platform, scope) " +
        "SELECT token_hash, id, ?, account_id, name, platform, ? FROM devices WHERE id = ? AND account_id = ?",
    ).bind(t, scope, deviceId, accountId),
    env.DB.prepare(
      "UPDATE recordings SET status = 'failed', error = 'DEVICE_REMOVED' WHERE account_id = ? AND device_id = ? AND status IN ('starting','recording','uploading')",
    ).bind(accountId, deviceId),
    env.DB.prepare("DELETE FROM devices WHERE id = ? AND account_id = ?").bind(deviceId, accountId),
  ]);
  return res[2].meta.changes === 1;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1] : null;
}
