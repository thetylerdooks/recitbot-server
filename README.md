# Recitbot server

Recitbot is an agent-first screen recorder: a bot tells it to record and gets back a private link to the video. Nobody
clicks anything. This repository is the server. You run it on **your own Cloudflare account**; your recordings, accounts
and links stay there.

```
bot ──MCP (Streamable HTTP)──▶ Worker ──▶ DeviceHub DO (per account) ══WebSocket══▶ recorder (your PC or Mac)
                                 │  ▲                                                  │ control pill + ffmpeg
                                 │  └──────────── PUT /upload/:id (upload token) ◀─────┘
                                 ├─ Governor DO (global caps, rate limits, fail closed)
                                 ├─ D1 (accounts, hashed keys and tokens, recordings, views)
                                 ├─ R2 (private media)
                                 └─ Workers AI (transcripts, optional)
viewer ──GET /<username>/v/<slug> (public, or its signed-in owner)──▶ player + transcript
```

- Recordings start only when an agent calls `start_recording`. While recording, the user sees a control pill with a timer,
  mic and PC-sound toggles and Stop. The pill is not in the video.
- Every video is private until it is shared, and has one unguessable URL.
- The server serves the official, signed recorder releases from `recorder/release/` (Windows) and `recorder-mac/` (macOS).
  It holds no signing key; the recorders check updates against the upstream release public keys.

## What you need

- A Cloudflare account with Workers, D1, R2 and Durable Objects. The Workers Free plan works, with limits
  ([docs/workers-free-plan.md](docs/workers-free-plan.md)); Workers Paid is optional.
- Node.js 20 or newer on the machine you deploy from.
- No domain, email or sign-up: your bot claims the server once with a secret and uses the key it gets back (step 8).
- Optional: your own domain for links, Turnstile, Workers AI, Stripe, Cloudflare for SaaS.

## Install

Every value that belongs to your deployment lives in `worker/wrangler.jsonc` (git-ignored) and in Wrangler secrets. Nothing
about a deployment is in the code. [SELFHOST_CONFIG.md](SELFHOST_CONFIG.md) lists every setting, its default and who sets it.

1. `npm install`, then `npx wrangler login` on the account you deploy to.
2. Copy `worker/wrangler.example.jsonc` to `worker/wrangler.jsonc`.
3. `npx wrangler d1 create recitbot`. Put its id into `env.production.d1_databases[0].database_id`, and your account id into
   `account_id`.
4. `npx wrangler r2 bucket create recitbot-media`. Keep it **private**: no public bucket, no r2.dev. Add a lifecycle rule that
   aborts incomplete multipart uploads after 1 day. Do **not** add an expiry rule: the hourly cron deletes what has expired,
   and owners' media is kept until deleted.
5. In `env.production` set `routes` and `PUBLIC_BASE_URL` to your domain, or remove `routes` and run on workers.dev. Wrangler
   creates the DNS records and certificates for `routes`; don't add conflicting records first. New signups and sign-in by
   email are off in the template: leave them off.
6. Required secrets, 32 random bytes each, with `npx wrangler secret put <NAME> --env production -c worker/wrangler.jsonc`:
   `SHARE_HMAC_KEY`, `UPLOAD_HMAC_KEY`, `DEVICE_CMD_KEY`, `IP_HASH_KEY`, `INSTALLER_URL_KEY`. A missing one makes every
   request answer 500 with its name. Set `OWNER_CLAIM_SECRET` the same way; keep its value for step 8.
7. `npm run deploy:prod`. **Deploy only this way.** It builds, applies the D1 migrations, stops if any is still pending, and
   only then deploys, so the code never runs ahead of its schema. `<PUBLIC_BASE_URL>/health` then answers `"ok":true`.
8. Claim the server: `POST <PUBLIC_BASE_URL>/claim` with the form or JSON field `secret` set to `OWNER_CLAIM_SECRET`'s value. The
   answer is `{"owner_key":"..."}`, once: the owner's API key (no limits, operator tools). Store it like a password. Then delete
   the secret (`npx wrangler secret delete OWNER_CLAIM_SECRET --env production -c worker/wrangler.jsonc`). It works only while the
   server has no account (SELFHOST_CONFIG.md, Owner claim).
9. Connect your bot to `<PUBLIC_BASE_URL>/mcp` with the header `Authorization: Bearer <owner_key>`.
10. Ask your bot to set up the recorder: the command from `get_installer` installs and pairs it. Then ask it to record.

Optional features stay off until they are configured: billing (Stripe), custom video domains (Cloudflare for SaaS,
[docs/operations.md](docs/operations.md)), a homepage, transcripts (remove the `ai` binding to run without).

## Update

Pull the new version, `npm install`, `npm run deploy:prod`. Your `worker/wrangler.jsonc` and secrets stay as they are.
Migrations are tracked by file name and applied once. Recorders update themselves from your server.

## Billing (optional)

Set the secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` and the var `STRIPE_PRO_PRICE_ID`; point a Stripe webhook at
`<PUBLIC_BASE_URL>/api/stripe/webhook`. The other price vars are optional (SELFHOST_CONFIG.md). The webhook maps a
subscription's plan item to a plan by these ids (`planPrice` in `worker/src/stripe.ts`: the monthly and the yearly price of a
plan give the same plan) and stores the interval; an unknown price leaves the plan as it is and logs an error. The storage
add-on is monthly only. For switching between monthly and yearly, the Customer Portal configuration must list both prices.
The prices the tools quote are text in `worker/src/billing-tools.ts` and the playbook: make your Stripe prices match, or change
the text. Without billing, nothing your bot reads mentions plans or prices, and the plan tools are gone.

## Local development

```
npm install
npm run build           # recorder downloads, share page assets and the homepage (if any) into worker/public
npm run typecheck       # build, then tsc
npm test                # build, then vitest in workerd (Miniflare)
npm run check:literals  # no deployment's own values in the source
npm run dev             # wrangler dev on 127.0.0.1:8787, with random dev-only secrets in worker/.dev.vars
node scripts/mcp-smoke.mjs http://127.0.0.1:8787
```

Tests and `npm run dev` use the committed `worker/wrangler.test.jsonc`: local bindings, placeholder domains, Cloudflare's
public Turnstile test keys. Transcription is stubbed in dev. The other scripts in `scripts/` (`e2e.mjs`, `audio-e2e.mjs`,
`smoothness.mjs`, ...) test the Windows recorder itself: they need Windows, ffmpeg and a recorder build.

`node scripts/check-selfhost-literals.mjs --dir <path>` scans any directory, for example a copy you are about to publish.

## More

- [SELFHOST_CONFIG.md](SELFHOST_CONFIG.md): every var, binding and secret.
- [docs/reference.md](docs/reference.md): tools, links and privacy, view stats, installers and updates, limits, threat model.
- [docs/operations.md](docs/operations.md): kill switch, key rotation, custom domains, abuse and takedowns.
- [docs/workers-free-plan.md](docs/workers-free-plan.md): what the Workers Free plan can and can't run.
- `docs/auto-update.md`, `docs/keyframes.md`, `docs/multi-account.md`, `docs/recording-caps.md`: recorder contracts.

## License

Source-available under the Elastic License 2.0. Free to use, including by businesses, on your own Cloudflare account. You may not
offer it to others as a hosted or managed service, and you may not remove license or copyright notices. See [LICENSE](LICENSE).
