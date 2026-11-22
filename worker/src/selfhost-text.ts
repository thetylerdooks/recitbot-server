// What the model reads on a server without billing (config.ts billing.enabled false): no plans, prices or anything to buy.
// Owner accounts have no limits; every other account has "this server's limits" (LIMITS' free ones). The billing-on text
// stays where it is and is never edited here: tools/list swaps the parts below (mcp.ts), each of which must be found
// (test/billing-disabled.test.ts). Messages that depend on billing pick their variant with billingConfigured.
import { LIMITS } from "./env";

/** The error code for a feature only owner accounts have (billing on: UPGRADE_REQUIRED). */
export const OWNER_ONLY = "OWNER_ONLY";
const ASK = "Ask the operator of this server.";
export const BRANDING_OWNER_ONLY = `Branding is for this server's owner accounts. ${ASK}`;
export const DOMAINS_OWNER_ONLY = `Custom domains are for this server's owner accounts. ${ASK}`;
export const DOWNLOAD_OWNER_ONLY = {
  error: OWNER_ONLY,
  message: "Downloading the video file is for this server's owner accounts; you can still watch the video on its page.",
};
export const plainRecordingLimitMessage = (max: number) =>
  `This account has used all ${max} recordings this server allows it (${max} in total; deleting videos doesn't give any back). ` +
  "Ask the operator of this server to lift the limit for this account.";
export const plainStorageLimitMessage = (limit: number) => `You've used your ${Math.round(limit / 1e9)} GB of storage. Delete old videos to free space.`;

/** Not listed while billing is off; a call answers BILLING_NOT_ENABLED. */
export const BILLING_ONLY_TOOLS: ReadonlySet<string> = new Set(["get_plan", "upgrade", "add_storage", "billing", "cancel_subscription", "admin_billing"]);

const DEVICES = LIMITS.maxDevices;
const STATS: [string, string][] = [
  ["Free-plan videos and their stats are deleted at expires_at", "Videos and their stats are deleted at expires_at"],
  ["expires_at null = kept until deleted;", "expires_at null = kept until deleted (owner accounts);"],
];

/** tool -> its whole description, or [standard text, text without billing] pairs applied to its description and input schema. */
export const PLAIN_TOOL_TEXT: Readonly<Record<string, string | readonly [string, string][]>> = {
  get_installer: [[`Free accounts may have up to ${DEVICES} paired devices at once.`, `this server allows ${DEVICES} paired devices per account at once (owner accounts: any number).`]],
  set_branding: [
    ["(Recitbot Pro): brand name", "(owner accounts): brand name"],
    ["Free: UPGRADE_REQUIRED.", "Other accounts: OWNER_ONLY."],
  ],
  get_branding: [["Free accounts have none (branding is part of Pro); message says so.", "Accounts that aren't owners have none; message says so."]],
  account_info:
    'Show the signed-in user\'s Recitbot account. Use it for "account status", "my account", "my limits", "what email is my ' +
    'account" and similar: account_id, username, display name, sign-in email, owner (true = this server\'s limits don\'t apply), limits ' +
    "(longest recording in minutes, null = no limit; recordings in total and how many are used, auto-delete, devices allowed, " +
    "watermark, custom_domain: one custom video domain and page branding), how many devices are paired now, storage_used_bytes, " +
    "and when the account was created. Always the account this call is signed in to, never another. To change the email call " +
    "request_email_change; to change the username or display name call set_username.",
  get_recording_for_skill: [
    ["recording on Pro or Owner: it adds", "recording on an owner account: it adds"],
    ["On Free, video is {error: UPGRADE_REQUIRED, message}", "On other accounts, video is {error: OWNER_ONLY, message}"],
    ["Free has no video download: never promise one", "Other accounts have no video download: never promise one"],
    ["the user's own video on Pro or Owner only", "the user's own video on an owner account only"],
  ],
  set_custom_domain: [
    ["Recitbot Pro only (UPGRADE_REQUIRED otherwise)", "Owner accounts only (OWNER_ONLY otherwise)"],
    ["HOSTNAME_NEEDS_REVIEW, UPGRADE_REQUIRED,", "HOSTNAME_NEEDS_REVIEW, OWNER_ONLY,"],
  ],
  remove_device: [[`because the Free plan's ${DEVICES} devices are taken`, `because the account's ${DEVICES} devices are taken`]],
  list_devices: [
    [`Free accounts may have up to ${DEVICES} paired devices at once (max_devices; null = unlimited)`, `An account may have up to ${DEVICES} paired devices at once (max_devices; null = unlimited: owner accounts)`],
  ],
  start_recording: [
    [
      `account's limit: ${LIMITS.maxSeconds} s = 5 minutes on the Free plan, ${LIMITS.paidMaxSeconds} s = 4 hours on Pro)`,
      `account's limit: ${LIMITS.maxSeconds} s = 5 minutes, or ${LIMITS.paidMaxSeconds} s = 4 hours on owner accounts)`,
    ],
    [`Free plan: ${LIMITS.freeRecordings} recordings in total (never resets`, `An account that isn't an owner has ${LIMITS.freeRecordings} recordings in total (never resets`],
    ["nothing was started; tell the user the message and offer upgrade.\n", "nothing was started; tell the user the message.\n"],
    [
      `Pro: ${LIMITS.storageBytesPerSeat / 1e9} GB of stored video per account (more with add_storage). At or over it: ` +
        "storage_limit_reached{storage_used_bytes,storage_limit_bytes}: nothing was started; tell the user the message and offer " +
        "add_storage or deleting old videos. At 90% or more a started recording carries storage_warning: tell the user it.\n",
      "",
    ],
    ["free_limit_reached, storage_limit_reached, CAP_REACHED", "free_limit_reached, CAP_REACHED"],
    [
      `Stop after this many seconds. On the Free plan the default and maximum is ${LIMITS.maxSeconds} s (5 minutes); above it: ` +
        `LIMIT_EXCEEDED{limit:'max_seconds', max}. On Pro the default and maximum is ${LIMITS.paidMaxSeconds} s (4 hours). `,
      `Stop after this many seconds. The default and maximum is ${LIMITS.maxSeconds} s (5 minutes); above it: ` +
        `LIMIT_EXCEEDED{limit:'max_seconds', max}. On owner accounts it is ${LIMITS.paidMaxSeconds} s (4 hours). `,
    ],
  ],
  list_videos: STATS,
  search_videos: [...STATS, ["('the pricing demo',", "('the product demo',"]],
  get_video_stats: STATS,
  admin_overview:
    "Owner only, read-only. Recitbot at a glance: accounts total; signups per UTC day (last 30 days) and per week (last " +
    "12 weeks, weeks start Monday); recordings total and storage bytes (video + audio); custom domains (live = active and not " +
    "taken down, pending, redirecting, taken down, total); config_warnings (settings that leave a feature off: names, never values).",
  admin_usage: [["with username, plan, created_at and", "with username, created_at and"]],
  admin_lookup: [
    [
      "plan, status (active or suspended), retention_hold (Free auto-delete and expiry paused), Stripe customer and subscription ids (ids only), usage (recordings, storage, Free recordings used)",
      "owner or not, status (active or suspended), retention_hold (auto-delete and expiry paused), usage (recordings, storage, recordings counted against the limit)",
    ],
  ],
  admin_retention_hold: [
    ["pauses the Free auto-delete and 7-day expiry", "pauses the auto-delete and 7-day expiry"],
    ["Changes nothing else (plan, expires_at, billing).", "Changes nothing else."],
  ],
};

type ListedTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** A tools/list entry as it reads without billing. */
export function plainTool<T extends ListedTool>(t: T): T {
  const text = PLAIN_TOOL_TEXT[t.name];
  if (text === undefined) return t;
  if (typeof text === "string") return { ...t, description: text };
  const swap = (s: string) => text.reduce((acc, [from, to]) => acc.replaceAll(from, to), s);
  const deep = (v: unknown): unknown =>
    typeof v === "string"
      ? swap(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
          : v;
  return { ...t, description: swap(t.description), inputSchema: deep(t.inputSchema) as Record<string, unknown> };
}
