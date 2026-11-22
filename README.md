# Recitbot server

A simple, free, open-source Loom replacement for your Grok Bot: basic screen recording and share links, self-hosted on your Cloudflare account.

Your bot tells it to record and gets a private link back. That's it.

This repo is the server. The recorder app (Windows and Mac) is at [recitbot-screen-recorder](https://github.com/thetylerdooks/recitbot-screen-recorder).

## Install

You need a Cloudflare account (the Workers Free plan is enough) and Node.js 20+. No domain, email, or sign-up.

1. Clone this repo, run `npm install`, then `npx wrangler login` on the Cloudflare account you will deploy to.
2. Copy `worker/wrangler.example.jsonc` to `worker/wrangler.jsonc`.
3. `npx wrangler d1 create recitbot`. Put its id into `env.production.d1_databases[0].database_id`, and your Cloudflare account id into `account_id`.
4. `npx wrangler r2 bucket create recitbot-media`. Keep the bucket private (no public access, no r2.dev). Add a lifecycle rule that aborts incomplete multipart uploads after 1 day. Do not add an object expiry rule.
5. In `env.production`, set `routes` and `PUBLIC_BASE_URL` to your domain, or remove `routes` and run on workers.dev.
6. Set these secrets (32 random bytes each) with `npx wrangler secret put <NAME> --env production -c worker/wrangler.jsonc`: `SHARE_HMAC_KEY`, `UPLOAD_HMAC_KEY`, `DEVICE_CMD_KEY`, `IP_HASH_KEY`, `INSTALLER_URL_KEY`, and `OWNER_CLAIM_SECRET`. Keep the claim secret for step 8.
7. `npm run deploy:prod`. This applies the D1 migrations, then deploys. Check `<PUBLIC_BASE_URL>/health` for `"ok":true`.
8. Claim the server: `POST <PUBLIC_BASE_URL>/claim` with form or JSON field `secret` set to `OWNER_CLAIM_SECRET`. You get `{"owner_key":"..."}` once. Store the key, then delete the claim secret: `npx wrangler secret delete OWNER_CLAIM_SECRET --env production -c worker/wrangler.jsonc`.
9. In Grok Bot, add a connector to `<PUBLIC_BASE_URL>/mcp` with the header `Authorization: Bearer <owner_key>`.
10. Install and pair the recorder on your Windows PC or Mac: ask your bot. It calls `get_installer` and gives you a short-lived signed installer from your server (or runs it if it can). That is how the recorder is paired to your server. Then ask it to record.

Settings are listed in [SELFHOST_CONFIG.md](SELFHOST_CONFIG.md). To update later: pull, `npm install`, `npm run deploy:prod`.

## License

Elastic License 2.0. Free to use, including by businesses, on your own Cloudflare account. You may not offer it as a hosted or managed service. See [LICENSE](LICENSE).
