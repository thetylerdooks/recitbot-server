// MCP tools for page branding: set_branding and get_branding (branding.ts does the checks and storage). Spread into
// mcp.ts TOOLS; like billing-tools.ts, import this module through mcp.ts only (it imports mcp.ts back).
import { z } from "zod";
import { applyBranding, BRANDING_LIMITS, BrandingError, brandingView, getBranding, KINDS, sizeText } from "./branding";
import { canUseCustomBranding } from "./entitlements";
import { accountLimits } from "./env";
import { governor } from "./governor";
import { customBase, requireNotSuspended, requireWritable, ToolError, tool } from "./mcp";
import { BRANDING_OWNER_ONLY, OWNER_ONLY } from "./selfhost-text";
import { billingConfigured } from "./stripe";
import { now } from "./util";

export const BRANDING_UPGRADE_MESSAGE = "Branding is part of Recitbot Pro ($10/mo or $100/yr). Ask me to upgrade to Pro.";

const ImageInput = (what: string, limits: string) =>
  z
    .union([
      z.strictObject({ url: z.string().min(1).max(2048).describe("An https link to the image file.") }),
      z.strictObject({
        data: z.string().min(1).max(12_000_000).describe("The image file as base64 (a data: URL is fine too)."),
        content_type: z.string().max(100).optional().describe("What the file claims to be, e.g. image/png. Ignored: the bytes decide."),
      }),
    ])
    .optional()
    .describe(`${what}: ${limits} Pass the image the user sent in chat as {data: <base64>, content_type}, or {url: <https link to it>}.`);

const ClearField = z.enum(["logo", "favicon", "social_image", "brand_name", "colors"]);

const SetBrandingInput = z.object({
  brand_name: z.string().max(200).optional().describe(`Plain text, 1-${BRANDING_LIMITS.nameMax} characters, no links or web addresses. Shown as the page title and site name.`),
  accent_color: z.string().max(10).optional().describe("Hex colour for buttons and links, #RRGGBB (or #RGB). Must contrast at least 3:1 with the background."),
  background_color: z.string().max(10).optional().describe("Hex page background colour, #RRGGBB (or #RGB). Dark or white text must be readable on it (4.5:1)."),
  logo: ImageInput("Logo shown in the page header", `PNG, JPG or WebP, up to ${sizeText(KINDS.logo.maxBytes)}, each side 32-2048 px.`),
  favicon: ImageInput("Browser tab icon", `PNG only, up to ${sizeText(KINDS.favicon.maxBytes)}, square, 16-512 px (32×32 or 180×180 are typical).`),
  social_image: ImageInput(
    "Preview image when a video link is shared (og:image)",
    `PNG, JPG or WebP, up to ${sizeText(KINDS.og.maxBytes)}, at least 600 px wide, about 1.91:1 (1200×630 is best).`,
  ),
  clear: z.array(ClearField).max(5).optional().describe('Settings to remove: "logo", "favicon", "social_image", "brand_name", "colors" (accent and background together).'),
});

const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export const BRANDING_TOOLS = {
  set_branding: tool({
    auth: true,
    description:
      "Brand the user's video pages (Recitbot Pro): brand name, accent and background colours, logo, favicon and " +
      "social preview image. Send only what changes; everything else stays. Images: pass the image the user sent in chat " +
      "as base64 ({data, content_type}), or an https link to it ({url}). PNG, JPG or WebP only (favicon: PNG), never SVG " +
      "or GIF. Limits: logo up to 512 KB and 32-2048 px a side; favicon up to 100 KB, square, 16-512 px; social image up " +
      "to 1 MB, at least 600 px wide, about 1.91:1 (1200×630). brand_name: plain text, up to 60 characters, no links. " +
      "Colours are hex and need contrast: accent vs background at least 3:1, and dark or white text readable on the " +
      "background (text_color in the result is the one picked). clear removes settings. When something is refused " +
      "nothing changes; tell the user the message (it says what to send instead). Free: UPGRADE_REQUIRED. Suspended: ACCOUNT_SUSPENDED. " +
      `Up to ${BRANDING_LIMITS.callsPerDay} calls per day.`,
    input: SetBrandingInput,
    async run(a, c) {
      requireWritable(c.env);
      await requireNotSuspended(c);
      const acct = c.principal!.accountId;
      const limits = await accountLimits(c.env, acct);
      if (!canUseCustomBranding(limits.tier)) {
        throw billingConfigured(c.env)
          ? new ToolError("UPGRADE_REQUIRED", BRANDING_UPGRADE_MESSAGE, { plan: limits.tier })
          : new ToolError(OWNER_ONLY, BRANDING_OWNER_ONLY);
      }
      const changes =
        a.brand_name !== undefined ||
        a.accent_color !== undefined ||
        a.background_color !== undefined ||
        a.logo !== undefined ||
        a.favicon !== undefined ||
        a.social_image !== undefined ||
        (a.clear?.length ?? 0) > 0;
      if (!changes) throw new ToolError("NOTHING_TO_CHANGE", "Nothing to change: pass at least one setting, or clear. get_branding shows the current branding.");
      const t = now();
      let rl: { ok: boolean; retry_after: number };
      try {
        rl = await governor(c.env).hit(`branding:${acct}`, BRANDING_LIMITS.callsPerDay, 86400, t);
      } catch {
        throw new ToolError("SERVICE_BUSY", "Recitbot couldn't save branding right now. Try again in a minute.");
      }
      if (!rl.ok) {
        throw new ToolError(
          "RATE_LIMITED",
          `Branding was changed ${BRANDING_LIMITS.callsPerDay} times today, the daily limit. Try again after ${utc(t + rl.retry_after)}.`,
          { retry_after: rl.retry_after },
        );
      }
      // Image URLs on the live custom domain once there is one (the branded page serves them there).
      const custom = await customBase(c);
      try {
        const selfHosts = [new URL(c.base).hostname, ...(custom ? [new URL(custom).hostname] : [])];
        const b = await applyBranding(c.env, acct, a, t, selfHosts);
        return { ...brandingView(b, custom ?? c.base), message: "Branding saved. It shows on the user's video pages." };
      } catch (e) {
        if (e instanceof BrandingError) throw new ToolError(e.code, `${e.message} Nothing was changed.`, e.extra);
        throw e;
      }
    },
  }),

  get_branding: tool({
    auth: true,
    description:
      "Show the user's page branding: brand_name, accent_color, background_color, text_color (picked for the background), " +
      "logo_url, favicon_url and social_image_url (null = not set). Free accounts have none (branding is part of " +
      "Pro); message says so. Change it with set_branding.",
    input: z.object({}),
    async run(_a, c) {
      const acct = c.principal!.accountId;
      const limits = await accountLimits(c.env, acct);
      if (!canUseCustomBranding(limits.tier)) {
        return { ...brandingView(null, c.base), message: billingConfigured(c.env) ? BRANDING_UPGRADE_MESSAGE : BRANDING_OWNER_ONLY };
      }
      const b = await getBranding(c.env, acct);
      return {
        ...brandingView(b, (await customBase(c)) ?? c.base),
        message: b ? "This is the branding on the user's video pages. Change it with set_branding." : "No branding set yet. Set it with set_branding.",
      };
    },
  }),
};
