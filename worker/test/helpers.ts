import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import { issueApiKey, newDeviceToken } from "../src/auth";
import { siteverify } from "../src/comments";
import type { Env } from "../src/env";
import worker from "../src/index";
import { videoUrl } from "../src/share";
import { now, randomId, sha256Hex } from "../src/util";
import { mp4File } from "./mp4-fixture";

export const ORIGIN = "https://rec.example";
let ipCounter = 1;
export const freshIp = () => `10.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}.1`;

export const call = (path: string, init: RequestInit = {}, e: Env = env): Promise<Response> => callUrl(ORIGIN + path, init, e);

/** call() on any host. */
export async function callUrl(url: string, init: RequestInit = {}, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", freshIp());
  const res = await worker.fetch(new Request(url, { ...init, headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function mcp(
  tool: string,
  args: Record<string, unknown> = {},
  key?: string,
  e: Env = env,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; isError: boolean }> {
  const res = await call(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    },
    e,
  );
  if (res.status !== 200) return { status: res.status, data: await res.text(), isError: true };
  const body = (await res.json()) as any;
  return { status: 200, data: body.result?.structuredContent, isError: !!body.result?.isError };
}

export async function seedAccount(paired = true): Promise<{ accountId: string; key: string; deviceId?: string; deviceToken?: string }> {
  const accountId = randomId(128);
  await env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").bind(accountId, now()).run();
  const key = await issueApiKey(env, accountId);
  if (!paired) return { accountId, key };
  const d = await seedDevice(accountId);
  return { accountId, key, deviceId: d.deviceId, deviceToken: d.token };
}

/** Inserts a paired device directly (no pairing code, no device limit). */
export async function seedDevice(accountId: string, name = "test pc"): Promise<{ deviceId: string; token: string }> {
  const d = newDeviceToken();
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO devices (id, account_id, token_hash, name, platform, created_at) VALUES (?, ?, ?, ?, 'windows', ?)").bind(d.deviceId, accountId, await sha256Hex(d.token), name, t),
    env.DB.prepare("UPDATE accounts SET paired_at = coalesce(paired_at, ?) WHERE id = ?").bind(t, accountId),
  ]);
  return d;
}

/** ftyp, a moov with one track of `seconds` (mp4-fixture.ts moovOf), then an mdat of filler up to `size` bytes. */
export const MP4 = (size = 4096, seconds = 1) => mp4File(size, seconds);

/** A JPEG-looking keyframe body (FF D8 FF magic): SOI + APP0 marker, then filler. Not a decodable image. */
export const JPEG = (size = 2048, fill = 7) => {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

export async function seedReady(
  accountId: string,
  opts: { createdAt?: number; expiresAt?: number; transcript?: unknown } = {},
): Promise<string> {
  const id = randomId(128);
  const t = opts.createdAt ?? now();
  await env.DB.prepare(
    "INSERT INTO recordings (id, account_id, device_id, title, status, max_seconds, created_at, expires_at, transcript, transcript_status) VALUES (?, ?, 'dev', 'Demo', 'ready', 60, ?, ?, ?, ?)",
  )
    .bind(id, accountId, t, opts.expiresAt ?? t + 86400, opts.transcript ? JSON.stringify(opts.transcript) : null, opts.transcript ? "ready" : "none")
    .run();
  await env.MEDIA.put(`v/${id}.mp4`, MP4());
  return id;
}

/** Connects a fake recorder over the real device WebSocket route. */
export async function connectDevice(token: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const res = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  const frames: any[] = [];
  ws.addEventListener("message", (ev) => {
    frames.push(JSON.parse(ev.data as string));
  });
  return { ws, frames };
}

export const brokenGovernor = {
  idFromName: () => ({}),
  get: () =>
    new Proxy(
      {},
      {
        get: () => () => Promise.reject(new Error("governor down")),
      },
    ),
} as unknown as Env["GOVERNOR"];

/** The video's one URL (<origin>/<username>/v/<slug>), as the tools return it. Call share first to make it public. */
export async function videoLinkOf(id: string, origin = ORIGIN, e: Env = env): Promise<string> {
  const rec = await e.DB.prepare("SELECT account_id FROM recordings WHERE id = ?").bind(id).first<{ account_id: string }>();
  return videoUrl(e, origin, id, rec!.account_id);
}

export const withEnv = (over: Partial<Env>): Env => ({ ...env, ...over }) as Env;

/**
 * Suspends the account the way admin_takedown does (an open 'takedown' row in admin_actions, takedown-state.ts), without
 * an operator. Returns the action id.
 */
export async function suspendAccount(accountId: string): Promise<string> {
  const id = randomId(128);
  await env.DB.prepare(
    "INSERT INTO admin_actions (id, action, target_type, target_id, account_id, reason_code, before_state, actor_account_id, created_at) " +
      "VALUES (?, 'takedown', 'account', ?, ?, 'impersonation', '{}', 'test-operator', ?)",
  )
    .bind(id, accountId, accountId, now())
    .run();
  return id;
}

/** A token for the sign-in email step's Turnstile check (see fakeSiteverify). */
export const TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/**
 * Turnstile siteverify, answered like Cloudflare does for its test secrets: 1x... passes (any token but "bad-token"),
 * 2x... fails. Only the network hop is replaced. Returns the spy; its calls are the siteverify requests.
 */
export function fakeSiteverify() {
  return vi.spyOn(siteverify, "post").mockImplementation(async (form) => {
    const success = String(form.get("secret")).startsWith("1x") && form.get("response") !== "bad-token";
    return Response.json({ success, "error-codes": success ? [] : ["invalid-input-response"] });
  });
}

export type SentEmail ={ from: { email: string; name: string }; to: string; subject: string; text: string; html: string };

/** A fake EMAIL (send_email) binding that records what it was asked to send. */
export function mailbox(): { sent: SentEmail[]; binding: SendEmail } {
  const sent: SentEmail[] = [];
  const binding = {
    send: async (m: SentEmail) => {
      sent.push(m);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, binding };
}
