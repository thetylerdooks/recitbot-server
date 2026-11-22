import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { disposableDomain } from "../src/disposable";
import type { Env } from "../src/env";
import worker from "../src/index";
import { canonicalEmail, createAccount, findAccount } from "../src/oauth/accounts";
import { now, randomId } from "../src/util";
import { fakeSiteverify, freshIp, mailbox, mcp, seedAccount, TURNSTILE_TOKEN, withEnv } from "./helpers";

const ROOT = "https://example.test";
const box = mailbox();
fakeSiteverify();
const mail = withEnv({ EMAIL: box.binding, OAUTH_DEV_LOG_LINKS: undefined });

beforeEach(() => {
  box.sent.length = 0;
});

type Browser = { ip: string; jar: Map<string, string> };
const browser = (): Browser => ({ ip: freshIp(), jar: new Map() });

async function send(b: Browser, path: string, init: RequestInit = {}, e: Env = mail): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("cookie", [...b.jar].map(([k, v]) => `${k}=${v}`).join("; "));
  headers.set("cf-connecting-ip", b.ip);
  const res = await worker.fetch(new Request(ROOT + path, { ...init, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    b.jar.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
  }
  return res;
}

const post = (b: Browser, fields: Record<string, string>) =>
  send(b, "/signin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ROOT }, body: new URLSearchParams(fields).toString() });

/** GET /signin: the signed email form (the sign-in has no row until an email goes out). */
async function signinForm(b: Browser) {
  const html = await (await send(b, "/signin?next=/")).text();
  return { f: /name="f" value="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&") };
}

/** The whole web sign-in as typed: email step, then the emailed code. Returns the account it signed in to. */
async function signIn(typed: string): Promise<string> {
  const b = browser();
  const res = await post(b, { ...(await signinForm(b)), email: typed, "cf-turnstile-response": TURNSTILE_TOKEN });
  expect(res.status).toBe(200);
  const html = await res.text();
  const f = { p: /name="p" value="([^"]+)"/.exec(html)![1], csrf: /name="csrf" value="([^"]+)"/.exec(html)![1] };
  const code = /^(\d{6})$/m.exec(box.sent.at(-1)!.text)![1];
  expect((await post(b, { ...f, code })).status).toBe(303);
  return (await env.DB.prepare("SELECT account_id FROM oauth_pending WHERE id = ?").bind(f.p).first<{ account_id: string }>())!.account_id;
}

const name = () => `j${randomId(64).toLowerCase()}`;
const dotted = (local: string) => local.split("").join(".");

describe("canonicalEmail", () => {
  it("Gmail: no dots, no +tag, googlemail.com = gmail.com; elsewhere only lowercase and no +tag", () => {
    expect(canonicalEmail("John.Doe+x@GMail.com")).toBe("johndoe@gmail.com");
    expect(canonicalEmail("johndoe@googlemail.com")).toBe("johndoe@gmail.com");
    expect(canonicalEmail("a.b+x@example.com")).toBe("a.b@example.com");
    expect(canonicalEmail(" A.B@Example.com ")).toBe("a.b@example.com");
  });
});

describe("one mailbox, one account", () => {
  it("a new account keeps the address as typed (lowercased) for sending and storage; only the canonical column is canonical", async () => {
    const n = name();
    const typed = `${dotted(n)}+x@GoogleMail.com`;
    const acct = await signIn(typed);
    expect(box.sent.at(-1)!.to).toBe(typed.toLowerCase());
    const id = await env.DB.prepare("SELECT email, email_canonical FROM oauth_identities WHERE account_id = ?").bind(acct).first();
    expect(id).toEqual({ email: typed.toLowerCase(), email_canonical: `${n}@gmail.com` });
    expect((await env.DB.prepare("SELECT email FROM accounts WHERE id = ?").bind(acct).first())!.email).toBe(typed.toLowerCase());
  });

  it("signing up as j.o.h.n+1@gmail.com when john@gmail.com exists signs in to the SAME account; mail goes to the typed address", async () => {
    const n = name();
    const first = await signIn(`${n}@gmail.com`);
    const variant = `${dotted(n)}+1@gmail.com`;
    expect(await signIn(variant)).toBe(first);
    expect(box.sent.at(-1)!.to).toBe(variant);
    expect(await signIn(`${n}+other@googlemail.com`)).toBe(first);
    const rows = await env.DB.prepare("SELECT email FROM oauth_identities WHERE account_id = ?").bind(first).all();
    expect(rows.results).toEqual([{ email: `${n}@gmail.com` }]);
  });

  it("the per-address hourly email limit counts every variant of the mailbox together", async () => {
    const n = name();
    const variants = [`${n}@gmail.com`, `${dotted(n)}@gmail.com`, `${n}+a@gmail.com`, `${n}@googlemail.com`, `${n.slice(0, 2)}.${n.slice(2)}+b@gmail.com`];
    for (const email of variants) {
      const b = browser();
      expect((await post(b, { ...(await signinForm(b)), email, "cf-turnstile-response": TURNSTILE_TOKEN })).status).toBe(200);
    }
    const b = browser();
    const res = await post(b, { ...(await signinForm(b)), email: `${n}+c@gmail.com`, "cf-turnstile-response": TURNSTILE_TOKEN });
    expect(res.status).toBe(429);
    expect(box.sent).toHaveLength(variants.length);
    // Another mailbox is not affected.
    const c = browser();
    expect((await post(c, { ...(await signinForm(c)), email: `${name()}@gmail.com`, "cf-turnstile-response": TURNSTILE_TOKEN })).status).toBe(200);
  });

  it("two accounts can't hold the same mailbox: a concurrent creation for a variant resolves to the first", async () => {
    const n = name();
    const a = await createAccount(env, `${n}@gmail.com`);
    await expect(createAccount(env, `${dotted(n)}@gmail.com`)).rejects.toThrow(/UNIQUE/);
    expect(await findAccount(env, `${dotted(n)}+z@googlemail.com`)).toBe(a);
  });

  it("an email change to a variant of another account's mailbox is EMAIL_TAKEN", async () => {
    const n = name();
    await createAccount(env, `${n}@gmail.com`);
    const { accountId, key } = await seedAccount(false);
    // An email change needs a current sign-in address (NO_CURRENT_EMAIL otherwise).
    const mine = `${name()}@example.com`;
    await env.DB.prepare("INSERT INTO oauth_identities (email, email_canonical, account_id, created_at) VALUES (?, ?, ?, ?)").bind(mine, mine, accountId, now()).run();
    expect((await mcp("request_email_change", { new_email: `${dotted(n)}+me@googlemail.com` }, key, mail)).data.error).toBe("EMAIL_TAKEN");
    expect(box.sent).toEqual([]);
  });
});

describe("signup behind Turnstile", () => {
  it("without a valid token: no account, no email, and no code to finish with", async () => {
    for (const token of [undefined, "", "bad-token"]) {
      const email = `${name()}@example.com`;
      const b = browser();
      const f = await signinForm(b);
      const res = await post(b, { ...f, email, ...(token !== undefined ? { "cf-turnstile-response": token } : {}) });
      expect(res.status).toBe(400);
      expect(box.sent).toEqual([]);
      expect((await post(b, { ...f, code: "123456" })).status).toBe(400);
      expect(await findAccount(env, email)).toBeNull();
      expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = ?").bind(email).first()).toBeNull();
    }
  });
});

describe("disposable domains", () => {
  it("the vendored list (and its subdomains) is refused; the hand-list extras still are; mainstream providers are allowed", async () => {
    expect(disposableDomain("x@kakslsie.store")).toBe(true);
    expect(disposableDomain("x@safermail.info")).toBe(true);
    expect(disposableDomain("x@sub.mailinator.com")).toBe(true);
    expect(disposableDomain("x@a.b.mailinator.com")).toBe(true);
    for (const d of ["tempmail.com", "temp-mail.io", "spamgourmet.com", "burnermail.io"]) expect(disposableDomain(`x@${d}`), d).toBe(true);
    for (const d of ["gmail.com", "outlook.com", "googlemail.com", "example.com"]) expect(disposableDomain(`x@${d}`), d).toBe(false);

    const b = browser();
    const res = await post(b, { ...(await signinForm(b)), email: "x@kakslsie.store", "cf-turnstile-response": TURNSTILE_TOKEN });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Disposable email addresses can&#39;t be used.");
    expect(box.sent).toEqual([]);
  });
});

describe("migration 0020 backfill", () => {
  it("existing identities are found by a dot/+tag variant; a later collision stays NULL and keeps its exact address", async () => {
    const n = name();
    const older = randomId(128);
    const later = randomId(128);
    const plain = randomId(128);
    const t = now();
    // Back to the state before 0020: no canonical forms, no unique index.
    await env.DB.prepare("DROP INDEX oauth_identities_email_canonical").run();
    await env.DB.prepare("UPDATE oauth_identities SET email_canonical = NULL").run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(`${dotted(n)}@gmail.com`, older, t - 100),
      env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(`${n}+old@googlemail.com`, later, t - 50),
      env.DB.prepare("INSERT INTO oauth_identities (email, account_id, created_at) VALUES (?, ?, ?)").bind(`a.${n}+tag@example.com`, plain, t),
    ]);
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0020_"))!;
    for (const q of m.queries.filter((q) => !/^\s*ALTER TABLE/i.test(q))) await env.DB.prepare(q).run();

    const canon = async (acct: string) =>
      (await env.DB.prepare("SELECT email_canonical FROM oauth_identities WHERE account_id = ?").bind(acct).first<{ email_canonical: string | null }>())!.email_canonical;
    expect(await canon(older)).toBe(`${n}@gmail.com`);
    expect(await canon(later)).toBeNull();
    expect(await canon(plain)).toBe(`a.${n}@example.com`);

    expect(await findAccount(env, `${n}@gmail.com`)).toBe(older);
    expect(await findAccount(env, `${n.slice(0, 1)}.${n.slice(1)}+x@gmail.com`)).toBe(older);
    expect(await findAccount(env, `${n}+old@googlemail.com`)).toBe(later);
    expect(await findAccount(env, `a.${n}+other@example.com`)).toBe(plain);
    expect(await findAccount(env, `a${n}@example.com`)).toBeNull();
    // The unique index is back.
    await expect(
      env.DB.prepare("INSERT INTO oauth_identities (email, email_canonical, account_id, created_at) VALUES (?, ?, ?, ?)").bind(`x${n}@gmail.com`, `${n}@gmail.com`, randomId(128), t).run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
