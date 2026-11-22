// MCP tools for custom video domains (Pro, Teams, owner): set_custom_domain, get_custom_domain_status,
// remove_custom_domain. The logic is in custom-domains.ts. Spread into mcp.ts TOOLS; like billing-tools.ts, import this
// module through mcp.ts only (it imports mcp.ts back).
import { z } from "zod";
import { DomainError, getCustomDomainStatus, removeCustomDomain, setCustomDomain } from "./custom-domains";
import { requireNotSuspended, requireWritable, ToolError, tool } from "./mcp";

async function domainCall(f: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof DomainError) throw new ToolError(e.code, e.message, e.extra);
    throw e;
  }
}

export const DOMAIN_TOOLS = {
  set_custom_domain: tool({
    auth: true,
    description:
      "Put the user's videos on their own domain: a subdomain of a domain they own, like videos.example.com (any label " +
      "works: videos., vids., watch., ...; bare domains like example.com don't). Recitbot Pro only " +
      "(UPGRADE_REQUIRED otherwise). Returns `dns` (one CNAME record) and `instructions`: show the user the record exactly " +
      "(its first line, e.g. \"videos CNAME <this server's target>\") plus the hint for their DNS provider, then call " +
      "get_custom_domain_status about once a minute until phase is live. One custom domain per account: calling it with " +
      "a different name switches to that one, and the old one's links redirect to the new one for 30 days. The same name " +
      "again just returns its status. Up to 3 set/change calls per day. Errors (tell the user `message`): INVALID_HOSTNAME, " +
      "APEX_NOT_SUPPORTED, PLATFORM_DOMAIN, RESERVED_HOSTNAME, HOSTNAME_TAKEN, HOSTNAME_NEEDS_REVIEW, UPGRADE_REQUIRED, " +
      "RATE_LIMITED, CUSTOM_DOMAINS_OFF, CLOUDFLARE_ERROR, ACCOUNT_SUSPENDED.",
    input: z.object({
      hostname: z
        .string()
        .min(1)
        .max(300)
        .describe("The full name the user wants, e.g. videos.example.com. A pasted URL like https://videos.example.com/ is fine."),
    }),
    async run(a, c) {
      requireWritable(c.env);
      await requireNotSuspended(c);
      return domainCall(() => setCustomDomain(c.env, c.principal!.accountId, a.hostname));
    },
  }),

  get_custom_domain_status: tool({
    auth: true,
    description:
      "Check the user's custom video domain. While it's being set up it re-checks DNS and Cloudflare and returns `phase`: " +
      "waiting_for_dns (the CNAME isn't visible yet), wrong_target (the CNAME points somewhere else), verifying, " +
      "issuing_certificate, live (`live_url`), error (Cloudflare's `errors`) or failed. Tell the user `message`. Poll it " +
      "about once a minute while the user waits, for up to ~10 minutes; after that tell them it can take up to a few hours " +
      "and Recitbot keeps checking by itself. Also lists old domains that still redirect (`redirecting`, with their end date).",
    input: z.object({}),
    async run(_a, c) {
      return domainCall(() => getCustomDomainStatus(c.env, c.principal!.accountId));
    },
  }),

  remove_custom_domain: tool({
    auth: true,
    description:
      "Stop using the user's custom video domain. A domain that went live keeps redirecting its links to the same videos " +
      "on this server's own host for 30 days, then stops; one that never went live is removed at once. New links use that host. " +
      "Nothing set up = nothing to do. To switch to a different domain, call set_custom_domain with the new name instead.",
    input: z.object({}),
    async run(_a, c) {
      requireWritable(c.env);
      return domainCall(() => removeCustomDomain(c.env, c.principal!.accountId));
    },
  }),
};
