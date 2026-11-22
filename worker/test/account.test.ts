// account_info and the bot-only email change (request_email_change / confirm_email_change, migrations 0016 and 0019).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/env";
import { findAccount } from "../src/oauth/accounts";
import { hmacHex, now, randomId } from "../src/util";
import { call, mailbox, mcp, seedAccount, seedDevice, withEnv } from "./helpers";

const owner = async () => {
  const a = await seedAccount(false);
  await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(a.accountId).run();
  return a;
};
const addIdentity = (email: string, accountId: string) =>
  env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(email, accountId, now()).run();

describe("account_info", () => {
  it("returns the signed-in account: username, display name, sign-up email, plan, limits, devices, created date", async () => {
    const { accountId, key } = await seedAccount();
    await seedDevice(accountId, "laptop");
    await env.DB.prepare("UPDATE accounts SET display_name = 'Alex', created_at = 1767225600 WHERE id = ?").bind(accountId).run();
    const email = `alex-${randomId(32).toLowerCase()}@example.com`;
    await addIdentity(email, accountId);
    const r = await mcp("account_info", {}, key);
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      username: expect.stringMatching(/^[a-z0-9-]{3,30}$/),
      display_name: "Alex",
      email,
      plan: "Free",
      billing_interval: null,
      limits: { max_recording_minutes: 5, max_recordings_total: 25, auto_delete_days: 7, max_devices: 2, watermark: true, custom_domain: false },
      recordings_used: 0,
      // Free: no storage cap (its limit is the 25 videos), so no limit and no warning.
      storage_used_bytes: 0,
      storage_limit_bytes: null,
      storage_addons: 0,
      paired_devices: 2,
      created_at: "2026-01-01T00:00:00.000Z",
      pending_email_change: null,
    });
  });

  it("owner via the DB flag: Owner plan, owner limits, no upsell", async () => {
    const { key } = await owner();
    const r = await mcp("account_info", {}, key);
    expect(r.data.plan).toBe("Owner");
    expect(r.data.limits).toEqual({ max_recording_minutes: null, max_recordings_total: null, auto_delete_days: null, max_devices: null, watermark: false, custom_domain: true });
    expect(r.data.paired_devices).toBe(0);
    expect(JSON.stringify(r.data)).not.toMatch(/upgrade|Pro\b|\$/);
  });

  it("requires sign-in; is described for 'my account' / 'what plan am I on' / 'my limits'", async () => {
    expect((await mcp("account_info")).status).toBe(401);
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tool = ((await res.json()) as any).result.tools.find((t: any) => t.name === "account_info");
    for (const phrase of ["account status", "my account", "what plan am I on", "my limits"]) expect(tool.description).toContain(phrase);
  });
});

describe("email change (request_email_change / confirm_email_change)", () => {
  const box = mailbox();
  const mail = withEnv({ EMAIL: box.binding });
  let logged: string[] = [];
  beforeEach(() => {
    box.sent.length = 0;
    logged = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const addr = (who: string) => `${who}-${randomId(32).toLowerCase()}@example.com`;
  async function signedUp() {
    const a = await seedAccount(false);
    const email = addr("old");
    await addIdentity(email, a.accountId);
    await env.DB.prepare("UPDATE accounts SET email = ? WHERE id = ?").bind(email, a.accountId).run();
    return { ...a, email };
  }
  /** The code in the newest email sent to `to`. */
  const codeTo = (to: string) => {
    const m = box.sent.filter((s) => s.to === to).at(-1);
    return /\b(\d{6})\b/.exec(m!.text)![1];
  };
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  it("happy path: codes to the NEW and the CURRENT address, both confirm the switch, the OLD address is notified; codes never in output or logs", async () => {
    const { accountId, key, email: oldEmail } = await signedUp();
    const newEmail = addr("new");
    const req = await mcp("request_email_change", { new_email: newEmail.toUpperCase() }, key, mail);
    expect(req.isError, JSON.stringify(req.data)).toBe(false);
    expect(req.data).toMatchObject({ sent_to: newEmail, approval_sent_to: oldEmail, expires_in_minutes: 10 });
    expect(box.sent.map((s) => s.to)).toEqual([newEmail, oldEmail]);
    for (const s of box.sent) expect(s.from).toEqual({ email: "hello@example.test", name: "Recitbot" });
    const code = codeTo(newEmail);
    const oldCode = codeTo(oldEmail);
    expect(box.sent[0].html).toContain(code);
    expect(box.sent[1].html).toContain(oldCode);
    expect(box.sent[1].text).toContain(newEmail);
    expect(box.sent[1].text).toMatch(/Approve your Recitbot email change/);
    expect(JSON.stringify(req.data)).not.toContain(code);
    expect(JSON.stringify(req.data)).not.toContain(oldCode);
    // Hashed at rest.
    const row = await env.DB.prepare("SELECT * FROM email_change_requests WHERE account_id = ?").bind(accountId).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(oldCode);
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.old_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await mcp("account_info", {}, key)).data.pending_email_change).toBe(newEmail);

    const ok = await mcp("confirm_email_change", { code, old_code: oldCode }, key, mail);
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    expect(ok.data).toMatchObject({ email: newEmail, previous_email_notified: true });
    expect(JSON.stringify(ok.data)).not.toContain(code);
    expect(await findAccount(env, newEmail)).toBe(accountId);
    expect(await findAccount(env, oldEmail)).toBeNull();
    expect((await env.DB.prepare("SELECT email FROM accounts WHERE id = ?").bind(accountId).first<{ email: string }>())!.email).toBe(newEmail);
    expect(box.sent).toHaveLength(3);
    expect(box.sent[2].to).toBe(oldEmail);
    expect(box.sent[2].subject).toBe("Your Recitbot email was changed");
    expect(box.sent[2].text).toContain(newEmail);
    expect(box.sent[2].text + box.sent[2].html).not.toContain(code);
    const info = await mcp("account_info", {}, key);
    expect(info.data).toMatchObject({ email: newEmail, pending_email_change: null });

    // Single use.
    expect((await mcp("confirm_email_change", { code, old_code: oldCode }, key, mail)).data.error).toBe("NO_PENDING_CHANGE");
    const logs = logged.join("\n");
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(oldCode);
  });

  it("a leaked bot token alone can't take the account: the new address's code without the current address's is refused", async () => {
    const { accountId, key, email: oldEmail } = await signedUp();
    const attacker = addr("attacker");
    await mcp("request_email_change", { new_email: attacker }, key, mail);
    const code = codeTo(attacker);
    const oldCode = codeTo(oldEmail);
    // The attacker sees only their own inbox: every guess for old_code fails, then the request locks.
    for (let left = 4; left >= 1; left--) {
      expect((await mcp("confirm_email_change", { code, old_code: wrong(oldCode) }, key, mail)).data).toMatchObject({ error: "WRONG_CODE", attempts_left: left });
    }
    expect((await mcp("confirm_email_change", { code, old_code: wrong(oldCode) }, key, mail)).data.error).toBe("TOO_MANY_ATTEMPTS");
    expect((await mcp("confirm_email_change", { code, old_code: oldCode }, key, mail)).data.error).toBe("TOO_MANY_ATTEMPTS");
    expect(await findAccount(env, oldEmail)).toBe(accountId);
    expect(await findAccount(env, attacker)).toBeNull();
    // old_code is required; the two codes are not interchangeable.
    await mcp("request_email_change", { new_email: addr("again") }, key, mail);
    expect((await mcp("confirm_email_change", { code: codeTo(box.sent.at(-2)!.to) }, key, mail)).data.error).toBe("INVALID_ARGUMENTS");
    const n = codeTo(box.sent.at(-2)!.to);
    const o = codeTo(oldEmail);
    if (n !== o) expect((await mcp("confirm_email_change", { code: o, old_code: n }, key, mail)).data.error).toBe("WRONG_CODE");
    expect((await mcp("confirm_email_change", { code: n, old_code: o }, key, mail)).isError).toBe(false);
  });

  it("the current address changing after the request voids it", async () => {
    const { accountId, key, email: oldEmail } = await signedUp();
    const newEmail = addr("new");
    await mcp("request_email_change", { new_email: newEmail }, key, mail);
    const code = codeTo(newEmail);
    const oldCode = codeTo(oldEmail);
    await env.DB.prepare("UPDATE oauth_identities SET email = ? WHERE account_id = ?").bind(addr("moved"), accountId).run();
    expect((await mcp("confirm_email_change", { code, old_code: oldCode }, key, mail)).data.error).toBe("WRONG_CODE");
  });

  it("codes are HMACs under a key derived for email change, not IP_HASH_KEY itself", async () => {
    const { accountId, key } = await signedUp();
    const newEmail = addr("new");
    await mcp("request_email_change", { new_email: newEmail }, key, mail);
    const code = codeTo(newEmail);
    const row = await env.DB.prepare("SELECT code_hash FROM email_change_requests WHERE account_id = ?").bind(accountId).first<{ code_hash: string }>();
    const derived = await hmacHex(env.IP_HASH_KEY, "email-change-v1");
    expect(row!.code_hash).toBe(await hmacHex(derived, `new:${accountId}:${newEmail}:${code}`));
    expect(row!.code_hash).not.toBe(await hmacHex(env.IP_HASH_KEY, `email-change:${accountId}:${newEmail}:${code}`));
    expect(row!.code_hash).not.toBe(await hmacHex(env.IP_HASH_KEY, `new:${accountId}:${newEmail}:${code}`));
  });

  it("expired codes: CODE_EXPIRED, nothing changes", async () => {
    const { accountId, key, email } = await signedUp();
    const newEmail = addr("new");
    await mcp("request_email_change", { new_email: newEmail }, key, mail);
    const codes = { code: codeTo(newEmail), old_code: codeTo(email) };
    await env.DB.prepare("UPDATE email_change_requests SET expires_at = ? WHERE account_id = ?").bind(now() - 1, accountId).run();
    expect((await mcp("confirm_email_change", codes, key, mail)).data.error).toBe("CODE_EXPIRED");
    expect((await mcp("confirm_email_change", codes, key, mail)).data.error).toBe("NO_PENDING_CHANGE");
    expect(await findAccount(env, email)).toBe(accountId);
  });

  it("10-minute expiry is stored with the request", async () => {
    const { accountId, key } = await signedUp();
    const t = now();
    await mcp("request_email_change", { new_email: addr("new") }, key, mail);
    const row = await env.DB.prepare("SELECT created_at, expires_at FROM email_change_requests WHERE account_id = ?").bind(accountId).first<{ created_at: number; expires_at: number }>();
    expect(row!.expires_at - row!.created_at).toBe(600);
    expect(row!.created_at).toBeGreaterThanOrEqual(t);
  });

  it("wrong new-address codes: attempts_left counts down, the 5th locks it, then even the right codes are refused", async () => {
    const { accountId, key, email } = await signedUp();
    const newEmail = addr("new");
    await mcp("request_email_change", { new_email: newEmail }, key, mail);
    const code = codeTo(newEmail);
    const oldCode = codeTo(email);
    for (let left = 4; left >= 1; left--) {
      const r = await mcp("confirm_email_change", { code: wrong(code), old_code: oldCode }, key, mail);
      expect(r.data).toMatchObject({ error: "WRONG_CODE", attempts_left: left });
    }
    expect((await mcp("confirm_email_change", { code: wrong(code), old_code: oldCode }, key, mail)).data.error).toBe("TOO_MANY_ATTEMPTS");
    expect((await mcp("confirm_email_change", { code, old_code: oldCode }, key, mail)).data.error).toBe("TOO_MANY_ATTEMPTS");
    expect(await findAccount(env, email)).toBe(accountId);
    expect((await mcp("account_info", {}, key)).data.pending_email_change).toBeNull();
    expect((await mcp("confirm_email_change", { code: "12345", old_code: oldCode }, key, mail)).data.error).toBe("INVALID_ARGUMENTS");
  });

  it("refuses an email another account uses (at request, and if taken before confirm); refuses the same email", async () => {
    const { key, email } = await signedUp();
    const other = await signedUp();
    expect((await mcp("request_email_change", { new_email: other.email }, key, mail)).data.error).toBe("EMAIL_TAKEN");
    expect((await mcp("request_email_change", { new_email: email }, key, mail)).data.error).toBe("SAME_EMAIL");
    expect(box.sent).toHaveLength(0);

    const target = addr("race");
    await mcp("request_email_change", { new_email: target }, key, mail);
    const codes = { code: codeTo(target), old_code: codeTo(email) };
    await addIdentity(target, other.accountId);
    expect((await mcp("confirm_email_change", codes, key, mail)).data.error).toBe("EMAIL_TAKEN");
    expect(await findAccount(env, target)).toBe(other.accountId);
    expect(await findAccount(env, email)).not.toBeNull();
  });

  it("the rate limit comes before EMAIL_TAKEN: probing taken addresses is limited too", async () => {
    const { key } = await signedUp();
    const others = await Promise.all(Array.from({ length: LIMITS.emailChangesPerAccountPerHour + 1 }, () => signedUp()));
    for (let i = 0; i < LIMITS.emailChangesPerAccountPerHour; i++) {
      expect((await mcp("request_email_change", { new_email: others[i].email }, key, mail)).data.error).toBe("EMAIL_TAKEN");
    }
    expect((await mcp("request_email_change", { new_email: others.at(-1)!.email }, key, mail)).data.error).toBe("RATE_LIMITED");
    expect(box.sent).toHaveLength(0);
  });

  it("an account without a sign-in email can't start a change", async () => {
    const { key } = await seedAccount(false);
    const r = await mcp("request_email_change", { new_email: addr("new") }, key, mail);
    expect(r.data.error).toBe("NO_CURRENT_EMAIL");
    expect(box.sent).toHaveLength(0);
  });

  it("rate-limited per account; invalid and disposable addresses refused; no EMAIL binding = EMAIL_UNAVAILABLE and nothing pending", async () => {
    const { accountId, key } = await signedUp();
    for (let i = 0; i < LIMITS.emailChangesPerAccountPerHour; i++) {
      expect((await mcp("request_email_change", { new_email: addr(`n${i}`) }, key, mail)).isError).toBe(false);
    }
    expect((await mcp("request_email_change", { new_email: addr("more") }, key, mail)).data.error).toBe("RATE_LIMITED");

    const b = await signedUp();
    expect((await mcp("request_email_change", { new_email: "not-an-email" }, b.key, mail)).data.error).toBe("INVALID_EMAIL");
    expect((await mcp("request_email_change", { new_email: "x@mailinator.com" }, b.key, mail)).data.error).toBe("INVALID_EMAIL");
    const r = await mcp("request_email_change", { new_email: addr("nomail") }, b.key, withEnv({ EMAIL: undefined }));
    expect(r.data.error).toBe("EMAIL_UNAVAILABLE");
    expect(await env.DB.prepare("SELECT 1 FROM email_change_requests WHERE account_id = ?").bind(b.accountId).first()).toBeNull();
    expect(accountId).not.toBe(b.accountId);
  });

  it("a new request replaces the old one (old codes dead)", async () => {
    const { key, email } = await signedUp();
    const firstTo = addr("first");
    await mcp("request_email_change", { new_email: firstTo }, key, mail);
    const first = { code: codeTo(firstTo), old_code: codeTo(email) };
    const second = addr("second");
    await mcp("request_email_change", { new_email: second }, key, mail);
    const codes = { code: codeTo(second), old_code: codeTo(email) };
    if (first.code !== codes.code || first.old_code !== codes.old_code) {
      expect((await mcp("confirm_email_change", first, key, mail)).data.error).toBe("WRONG_CODE");
    }
    expect((await mcp("confirm_email_change", codes, key, mail)).data.email).toBe(second);
  });
});
