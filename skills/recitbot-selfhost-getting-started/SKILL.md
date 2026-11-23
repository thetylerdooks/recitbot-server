---
name: recitbot-selfhost-getting-started
description: >-
  Use as the first conversation with a new owner of the self-hosted Recitbot
  bot, or whenever the Recitbot connector is missing or not working: walks them
  through deploying recitbot-server on their own Cloudflare account and pairing
  a recorder.
---
# Recitbot self-host getting started

Say in one line what you do: record their screen when they ask and hand back a private share link, with videos stored in their own Cloudflare account. There is no hosted Recitbot and no account to sign up for.

First check whether a working Recitbot connector is already installed (call `device_status` or `get_latest`). If it works and a recorder is paired, skip to step 9.

Otherwise walk them through the Install section of https://github.com/thetylerdooks/recitbot-server one step at a time. Show one instruction, then wait for them to say it's done.

1. They need a Cloudflare account (Workers Free is enough) and Node.js 20+ on the machine they deploy from.
2. Clone recitbot-server, run `npm install`, then `npx wrangler login`.
3. Copy `worker/wrangler.example.jsonc` to `worker/wrangler.jsonc`. Create D1 (`npx wrangler d1 create recitbot`) and a private R2 bucket (`npx wrangler r2 bucket create recitbot-media`). Fill in `database_id`, `account_id`, and `routes` / `PUBLIC_BASE_URL` (or remove `routes` and use workers.dev). The bucket stays private. Add a lifecycle rule that aborts incomplete multipart uploads after 1 day. Never add an object expiry rule.
4. Set secrets with `npx wrangler secret put <NAME> --env production -c worker/wrangler.jsonc`, 32 random bytes each: SHARE_HMAC_KEY, UPLOAD_HMAC_KEY, DEVICE_CMD_KEY, IP_HASH_KEY, INSTALLER_URL_KEY, OWNER_CLAIM_SECRET.
5. Deploy with `npm run deploy:prod` (applies D1 migrations, then deploys). Check `<PUBLIC_BASE_URL>/health` shows "ok":true.
6. Claim once: POST `<PUBLIC_BASE_URL>/claim` with field `secret` set to OWNER_CLAIM_SECRET. The response `{"owner_key":"..."}` is shown once; they store it privately, then delete the claim secret with `npx wrangler secret delete OWNER_CLAIM_SECRET --env production -c worker/wrangler.jsonc`.
7. They add a custom Grok Bot connector themselves: URL `<PUBLIC_BASE_URL>/mcp`, header `Authorization: Bearer <owner_key>`. A template is this repo's root `mcp.json`: replace the workers.dev placeholder with their `/mcp` URL and set `RECITBOT_API_KEY` in their environment to the owner key (never put the key in the file, in chat, or in memory). This bot ships with no connector and never assumes a fixed URL.
8. Ask "Windows or Mac?" Never guess. Call `get_installer` for that platform. If you can run commands on their computer, run the returned `command`; otherwise give them `download_url` (valid about 10 minutes). That signed installer comes from their server and is how the recorder is paired. The recorder's source and GitHub releases are at https://github.com/thetylerdooks/recitbot-screen-recorder; do not install a raw release in place of `get_installer`, or the recorder will not be paired. Poll `device_status` until online. Expired or used installer: call `get_installer` again. On Mac, the first recording asks them to allow Screen Recording and Microphone; only they can click Allow.
9. Offer a short test recording. On yes, follow the recitbot-selfhost-playbook skill.

Secrets, the claim secret and the owner key never go in chat, memory, screenshots or logs. If they paste one, don't use or repeat it; tell them to store it privately and rotate it if exposed. Save to memory only preferences they state, such as which computer to record by default.
