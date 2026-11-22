import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const rnd = () => randomBytes(32).toString("base64url");

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.join(here, "wrangler.test.jsonc") },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SHARE_HMAC_KEY: rnd(),
            UPLOAD_HMAC_KEY: rnd(),
            DEVICE_CMD_KEY: rnd(),
            IP_HASH_KEY: rnd(),
            INSTALLER_URL_KEY: rnd(),
            // The suite runs as a hosted-shaped deployment: a brand and billing. The self-host defaults (neither) have
            // their own tests: brand-unset, billing-disabled, claim, config.
            BRAND_NAME: "Recitbot",
            // Fake Stripe config: tests stub the Stripe API (stripeDeps.fetch), nothing reaches Stripe.
            STRIPE_SECRET_KEY: "PLACEHOLDER_STRIPE_SECRET_KEY",
            STRIPE_WEBHOOK_SECRET: "PLACEHOLDER_STRIPE_WEBHOOK_SECRET",
            STRIPE_PRO_PRICE_ID: "price_PLACEHOLDER_PRO",
            STRIPE_TEAMS_PRICE_ID: "price_PLACEHOLDER_TEAMS",
            STRIPE_PRO_YEARLY_PRICE_ID: "price_PLACEHOLDER_PRO_YEARLY",
            STRIPE_TEAMS_YEARLY_PRICE_ID: "price_PLACEHOLDER_TEAMS_YEARLY",
            STRIPE_PORTAL_CONFIG_ID: "bpc_PLACEHOLDER",
          },
        },
      }),
    ],
    // css.include: let page.test.ts read worker/web/*.css?raw (vitest blanks CSS imports by default)
    test: { setupFiles: ["./test/setup.ts"], root: here, css: { include: [/web\/.*\.css/] } },
  };
});
