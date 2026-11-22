# Self-host configuration

Every operator-specific value the Recitbot server needs (its hosts, brand, contacts, Cloudflare and Stripe ids, policy)
comes from Wrangler vars, bindings and secrets. None is hardcoded anywhere in the repository (source, tests, migrations, scripts,
docs): `npm run check:literals` (and `worker/test/selfhost-literals.test.ts`) fail if one creeps in.

**What the literals guard covers:** the server tree only, i.e. the Worker with its tests and migrations, `scripts/`, `docs/`, the
committed configs and the recorder releases' text files that the server serves (`SCAN` in `scripts/check-selfhost-literals.mjs`).
The recorder sources (`mac/`, `recorder/`, and whatever `recorder-mac/` is built from) are handled by a separate recorder job
(branch `wes/recorder-origin`) and are not scanned; only the published release files in `recorder/release/` and
`recorder-mac/` are, as text. Binaries (archives, executables, images, fonts) are never scanned.

- `worker/src/config.ts` parses all of it once per isolate (`getConfig(env)`, frozen). Problems that make the server
  unusable (a missing required secret, a malformed URL or address) are **errors**: every request then gets a 500 that
  names what to fix (names only, never values). Partial optional features (half of the Stripe or custom-domain settings)
  are **warnings**: the feature stays off. Each is logged once per isolate (`config: ...`) and listed in `admin_overview`.
- `GET /health` on any of the server's own hosts answers `{"ok":true,"version":"...","configured":true}` (uncached, no sign-in).
  With configuration errors it answers 500 with `ok` and `configured` false and `errors`, the names of the settings to fix.
- `worker/wrangler.example.jsonc` is the template. Copy it to `worker/wrangler.jsonc` (git-ignored) and fill it in.
- `worker/wrangler.test.jsonc` is what `npm test`, `npm run dev`, `npm run db:migrate:local` and the e2e scripts use:
  local bindings only, placeholder `*.example.test` domains, Cloudflare's public Turnstile test keys.
- `worker/.dev.vars.example` lists the secrets (placeholders). `npm run dev:vars` writes random dev values to
  `worker/.dev.vars` (git-ignored).
- `npm run deploy:prod` deploys `env.production` of `worker/wrangler.jsonc` and stops with a pointer here if the file is
  missing. Before it builds or touches anything remote, its preflight (`scripts/deploy-preflight.mjs`) stops on a production var
  that still holds a template placeholder, on any configuration error above, and on a missing secret: the required ones, both
  Turnstile keys unless `TURNSTILE_DISABLED=true`, the Stripe ones with `STRIPE_PRO_PRICE_ID`, and `CF_SAAS_API_TOKEN` with
  `CF_ZONE_ID` and `CUSTOM_DOMAIN_CNAME_TARGET`. It reads secret names only (`wrangler secret list`); when that can't run (signed
  out, offline, the first deploy) it says it skipped the secret check and goes on.

Who sets it: **setup bot** = filled in at install; **operator** = optional, set when wanted; **upstream** = fixed in
the code for every deployment, never per deployment.

## Wrangler settings (worker/wrangler.jsonc)

| Name | Type | Purpose | Required? | Who sets it | Default |
|---|---|---|---|---|---|
| `account_id` | wrangler setting | Cloudflare account the Worker deploys to | yes | setup bot | none |
| `env.production.name` | wrangler setting | Worker name | yes | setup bot | `recitbot` (template) |
| `env.production.routes` | wrangler setting | Custom domains (`custom_domain: true`) and, for custom video domains, the `*/*` zone route | no (workers.dev only without) | setup bot | one placeholder domain |
| `env.production.workers_dev` | wrangler setting | Also answer on `<name>.<subdomain>.workers.dev` (always one of "our" hosts) | no | setup bot | `true` |
| `d1_databases[].database_name` / `database_id` | wrangler setting | The D1 database behind binding `DB` (`wrangler d1 create`) | yes | setup bot | none |
| `r2_buckets[].bucket_name` | wrangler setting | The private R2 bucket behind binding `MEDIA` | yes | setup bot | none |

## Bindings

| Name | Type | Purpose | Required? | Who sets it | Default |
|---|---|---|---|---|---|
| `DB` | binding (D1) | Accounts, recordings, everything relational | yes | setup bot | none |
| `MEDIA` | binding (R2) | Video, audio, keyframes, brand images | yes | setup bot | none |
| `DEVICE_HUB` | binding (Durable Object, class `DeviceHub`) | Recorder sockets per account | yes | upstream (template) | as in template |
| `GOVERNOR` | binding (Durable Object, class `Governor`) | Rate limits and daily ceilings | yes | upstream (template) | as in template |
| `ASSETS` | binding (static assets, `./public`) | Player, web assets, installers, the optional homepage | yes | upstream (template) | as in template |
| `AI` | binding (Workers AI) | Transcription | no (no transcripts without) | setup bot | in template |
| `EMAIL` | binding (send_email) | Sign-in codes and account emails (with `EMAIL_FROM`) | no (sign-in by email off without) | operator | not bound (email off) |

## Vars

| Name | Type | Purpose | Required? | Who sets it | Default |
|---|---|---|---|---|---|
| `DEV_MODE` | var | `"true"` only for local dev: loopback and `*.example` hosts are ours | yes | upstream (template) | `"false"` in production |
| `SERVICE_MODE` | var | `ON`, `NO_TRANSCRIBE`, `READ_ONLY`, `OFF` (unknown = `OFF`) | yes | operator | `ON` |
| `WORKERS_PLAN` | var | `"free"`: settings that fit the Workers Free plan's CPU and subrequest limits ([docs/workers-free-plan.md](docs/workers-free-plan.md)). `"paid"` or unset: the standard ones | no | setup bot | standard (the template sets `free`) |
| `ALLOW_URL_KEY` | var | `"true"` allows `/mcp/k/<key>` for clients that can't send headers | yes | operator | `"false"` |
| `GLOBAL_MAX_VIDEOS_PER_DAY` | var | Recording starts per UTC day, all accounts | yes | operator | `2000` (template) |
| `GLOBAL_MAX_TRANSCRIBE_MIN_PER_DAY` | var | Transcription minutes per UTC day, all accounts | yes | operator | `400` (template) |
| `PUBLIC_BASE_URL` | var | Origin of every generated link (share links, installer, sign-in); its host is ours | no, but set it in production | setup bot | the request's own origin |
| `MCP_BASE_URL` | var | A separate MCP host: its own OAuth issuer, and the issuer for requests on hosts that aren't ours | no | operator | `PUBLIC_BASE_URL`, else the request's origin |
| `SITE_HOSTNAMES` | var | More hostnames that are ours (comma-separated, e.g. `www.`). The first is the canonical host when `PUBLIC_BASE_URL` is unset | no | operator | none |
| `SITE_ZONE` | var | Zone whose other names are reserved (404 on every path) and never usable as a custom domain or brand image host | no | operator | `PUBLIC_BASE_URL`'s host |
| `BRAND_NAME` | var | Switches branding on: this name in OAuth discovery, as the email sender's display name, in the video pages' footer and in the region notice, plus the product's own name, logo, icons, preview card and Free watermark on every page and email. Unset: no name, logo, icon, watermark or "Powered by" anywhere a viewer looks (see Branding below) | no | operator | none |
| `EMAIL_FROM` | var | The one sender address for every email: sign-in codes and links, account and email-change messages (a domain verified for Cloudflare Email Sending) | for sign-in by email | operator | none (email off) |
| `SUPPORT_EMAIL` | var | Contact shown in user-facing messages, emails and the homepage's legal pages | no | operator | `EMAIL_FROM`, else "the operator of this server" |
| `ABUSE_EMAIL` | var | Report page and takedown contact | no | operator | `SUPPORT_EMAIL` |
| `HOME_SITE_ENABLED` | var | `"true"` serves your own homepage (`worker/home`, not part of the repository: `/`, `/terms/`, `/privacy/`, `/eu/`), once the five values below and `SUPPORT_EMAIL` / `EMAIL_FROM` and a canonical host are set | no | operator | off (those paths 404) |
| `OPERATOR_NAME` | var | Homepage footer: "Built by" name | for the homepage | operator | none (homepage off) |
| `OPERATOR_URL` | var | Homepage footer: "Built by" link (https) | for the homepage | operator | none (homepage off) |
| `LEGAL_ENTITY_NAME` | var | Company named in the footer, terms and privacy pages | for the homepage | operator | none (homepage off) |
| `STATEMENT_DESCRIPTOR` | var | Card statement line the terms and privacy pages quote | for the homepage | operator | none (homepage off) |
| `TEMPLATE_URL` | var | Homepage "Add to" buttons: the bot template link (https) | for the homepage | operator | none (homepage off) |
| `HOME_URL` | var | "Powered by" and watermark link (with `BRAND_NAME`) | no | operator | the canonical base URL, else no link |
| `DOCS_URL` | var | MCP documentation link in OAuth discovery | no | operator | `<canonical base>/docs/mcp` while the homepage is on, else omitted |
| `BLOCKED_COUNTRIES` | var | ISO country codes, or `EU_EEA_UK`, refused MCP, OAuth, installer routes (451) and shown the `/eu/` notice on `/` | no | operator | none |
| `OWNER_ACCOUNT_IDS` | var | Account ids (comma-separated) with no plan limits and the operator tools. Set, it is the whole list of operators (include the account that claimed the server) | no (not needed after an owner claim) | setup bot | none: the account that claimed the server, if one did |
| `TURNSTILE_DISABLED` | var | `"true"` with no Turnstile keys: sign-in works without a bot check (see Turnstile below) | no | operator | off (template: `"true"`) |
| `SIGNUPS_DISABLED` | var | Exactly `"true"`: no new accounts; existing accounts sign in as normal (see Signups below) | no | operator | off: signups open (template: `"true"`) |
| `SIGNUPS_ALLOWLIST` | var | Comma-separated emails that may still sign up while `SIGNUPS_DISABLED` is on (trimmed, any case, exact address); ignored while signups are open | no | operator | empty (nobody) |
| `STRIPE_PRO_PRICE_ID` | var | Pro monthly price; required for billing | for billing | operator | none (billing off) |
| `STRIPE_PRO_YEARLY_PRICE_ID` | var | Pro yearly price | no | operator | none (yearly off) |
| `STRIPE_TEAMS_PRICE_ID` | var | Teams monthly per-seat price (recognised on subscriptions; not sold yet) | no | operator | none |
| `STRIPE_TEAMS_YEARLY_PRICE_ID` | var | Teams yearly per-seat price | no | operator | none |
| `STRIPE_PORTAL_CONFIG_ID` | var | Stripe Customer Portal configuration | no | operator | Stripe's default portal |
| `STRIPE_STORAGE_ADDON_PRICE_ID` | var | +100 GB storage add-on price (monthly) | no | operator | none (`add_storage` off) |
| `CF_ZONE_ID` | var | Zone id for Cloudflare for SaaS custom hostnames | for custom domains | operator | none (custom domains off) |
| `CUSTOM_DOMAIN_CNAME_TARGET` | var | What customers point their CNAME at | for custom domains | operator | none (custom domains off) |
| `OAUTH_DEV_LOG_LINKS` | var | `"1"` on loopback dev only: log sign-in links instead of emailing | no, never in production | dev only | off |

## Secrets

| Name | Type | Purpose | Required? | Who sets it | Default |
|---|---|---|---|---|---|
| `SHARE_HMAC_KEY` | secret | Signs share/owner links and sign-in forms | yes | setup bot (random) | none: the server refuses requests |
| `UPLOAD_HMAC_KEY` | secret | Signs upload tokens | yes | setup bot (random) | none: the server refuses requests |
| `DEVICE_CMD_KEY` | secret | Signs recorder commands | yes | setup bot (random) | none: the server refuses requests |
| `IP_HASH_KEY` | secret | Keyed hashes of client IPs (rate limits, view stats) | yes | setup bot (random) | none: the server refuses requests |
| `INSTALLER_URL_KEY` | secret | Signs short-lived installer links (`/i/<token>`) | yes | setup bot (random) | none: the server refuses requests |
| `OWNER_CLAIM_SECRET` | secret | One-time owner claim: sent once to `POST /claim` of a fresh server, it creates the owner and returns the owner's API key (see Owner claim below). Random, 32 bytes or more | for setup; delete it once claimed | setup bot (random) | no claim |
| `TURNSTILE_SITE_KEY` | secret (public value, kept with its pair) | Turnstile widget on sign-in and viewer comments | no | operator | Turnstile off |
| `TURNSTILE_SECRET_KEY` | secret | Turnstile siteverify | no | operator | Turnstile off |
| `STRIPE_SECRET_KEY` | secret | Stripe API | for billing | operator | billing off |
| `STRIPE_WEBHOOK_SECRET` | secret | Verifies `/api/stripe/webhook` | for billing | operator | billing off (route 404) |
| `CF_SAAS_API_TOKEN` | secret | Cloudflare API token, Zone → SSL and Certificates: Edit, that zone only | for custom domains | operator | custom domains off |

## Branding

Without `BRAND_NAME` (the default) the video pages, sign-in pages, emails, region notice, report page and billing pages carry no
product name, logo, icon, preview image, watermark or "Powered by" line, and the product's icon and logo files answer 404. The
pages load neutral copies of their styles and scripts (`/s/plain/*`, made by `scripts/build-web.mjs`).
`worker/test/brand-unset.test.ts` renders all of them and fails if a name or logo comes back. Tool and playbook text that only bots
read still says "Recitbot", and so does the recorder.

With `BRAND_NAME` set, everything looks as it does on the hosted service: `BRAND_NAME` in the places above, and the product's own
name and logo elsewhere, whatever the name is. There is no setting yet for another logo.

## Owner claim

How a fresh server gets its owner. Nobody signs up or signs in: the setup bot generates a random secret (32 bytes or more), stores
it with `wrangler secret put OWNER_CLAIM_SECRET --env production -c worker/wrangler.jsonc`, deploys, and sends it once:

```
POST <PUBLIC_BASE_URL>/claim
Content-Type: application/json

{"secret":"<OWNER_CLAIM_SECRET>"}
```

(a form field `secret` works too). The answer is `{"owner_key":"ark_..."}`: a new API key, shown this once and stored hashed. Put
it in the connector's header, `Authorization: Bearer <owner_key>`, for `<PUBLIC_BASE_URL>/mcp`. The recorder pairs with the
command from `get_installer`.

- **Possible only while** the secret is set (shorter than 32 characters counts as unset, with a warning), **no owner exists**
  and the server **was never claimed**. "No owner exists" means `OWNER_ACCOUNT_IDS` is empty **and** D1 holds no account at
  all: a server anyone has signed in to can't be claimed over. Otherwise `/claim` is a plain 404, even with the right secret.
- **Works once.** The `server_claim` row (migration 0034) is written in the same transaction that creates the account and the
  key, so of two concurrent claims one wins, and the row stays for good. Delete the secret afterwards
  (`wrangler secret delete OWNER_CLAIM_SECRET --env production -c worker/wrangler.jsonc`); it does nothing any more.
- **What the owner gets:** `accounts.plan = 'owner'` (no limits), and the operator tools while `OWNER_ACCOUNT_IDS` is empty.
  Once you set `OWNER_ACCOUNT_IDS`, list the claimed account's id in it too. The account is named `owner` (`set_username`
  changes it) and has no email.
- **Works with `SIGNUPS_DISABLED=true`.** The claim needs a server without any account, so it can only make the first one, and
  it is the one exception to closed signups.
- **Limits:** 5 attempts per IP per hour and 20 wrong secrets per day in all (so nobody without the secret can stall the claim), through the Governor; if it can't be reached the claim is refused.
  Turnstile doesn't apply (a server-to-server call). The comparison is constant-time, the answer to a wrong secret is generic,
  and neither the secret nor the key is ever logged.
- **A lost or leaked key** has no second claim. Make a new one where you deploy from:
  `node -e "const c=require('crypto'),i=c.randomBytes(8).toString('hex'),k='ark_'+i+'_'+c.randomBytes(24).toString('hex');console.log(k,i,c.createHash('sha256').update(k).digest('hex'))"`
  prints the key, its id and its hash. Store the id and hash (never the key); this revokes the owner's other keys:
  `wrangler d1 execute DB --remote --env production -c worker/wrangler.jsonc --command "UPDATE api_keys SET revoked_at = unixepoch() WHERE account_id = (SELECT account_id FROM server_claim); INSERT INTO api_keys (id, key_hash, account_id, created_at) SELECT '<id>', '<hash>', account_id, unixepoch() FROM server_claim"`

## Optional features

- **Billing** is on only with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRO_PRICE_ID` all set. Off:
  nothing bots read mentions plans, prices or anything to buy (tool list, playbook, initialize instructions, messages:
  `worker/src/selfhost-text.ts`, `playbook.ts`; the playbook's version ends in `-selfhost`). `get_plan`, `upgrade`,
  `add_storage`, `billing`, `cancel_subscription` and `admin_billing` are not listed and answer `BILLING_NOT_ENABLED`, with no
  link and no Stripe call; `/api/stripe/webhook` and `/billing/*` are 404; no Stripe id is read. Owner accounts have no limits.
  Every other account has the limits in `LIMITS` (`worker/src/env.ts`), described as "this server's limits"; branding, custom
  domains and downloads answer them `OWNER_ONLY`. `account_info` shows `account_id`; add it to `OWNER_ACCOUNT_IDS` to lift the limits.
- **Custom video domains** are on only with `CF_SAAS_API_TOKEN`, `CF_ZONE_ID`, `CUSTOM_DOMAIN_CNAME_TARGET` and a
  canonical host (`PUBLIC_BASE_URL` or `SITE_HOSTNAMES`). Removed domains redirect back to the canonical host.
- **Email sign-in** (operator option, off in the template): for people besides the owner to sign in, bind `EMAIL` (`send_email`),
  set `EMAIL_FROM` (a domain verified for Cloudflare Email Sending, Workers Paid) and Turnstile keys, and open signups or list
  the addresses in `SIGNUPS_ALLOWLIST`. The owner needs none of this.
- **Turnstile**: with both keys, sign-in and viewer comments need the check. With neither, sign-in is **refused**
  (fail closed) and viewer comments are closed, unless `TURNSTILE_DISABLED=true`: then sign-in works without a bot check.
  Risk: anyone can make the server send sign-in emails; only the per-IP, per-address and daily limits
  (`LIMITS.signinEmailsPerDay`) bound it, and your Email Sending reputation pays for abuse. Viewer comments stay closed
  without Turnstile either way.
- **Signups** are closed in the template. `SIGNUPS_DISABLED=true` (exactly `true`; any other value leaves them open) closes them: an
  email without an account gets "New signups are closed." (403) on every sign-in path, before any email is sent, and no
  account is created. Existing accounts, their bots and their recorders work as before. The owner claim works with signups
  closed (it makes the first account only, and is the one exception).
  To let a few people in while closed, list their emails in `SIGNUPS_ALLOWLIST` (comma-separated; trimmed, any case, the exact
  address: no `+tag` or Gmail-dot variants). They sign up through the normal email check and the usual limits.
- **Homepage**: none ships with the server, and none is needed: without one `/` and its pages are 404 and everything else works.
  To have one, put a static site in `worker/home/` (git-ignored, so it stays yours): `index.html` and, if you want them,
  `terms/`, `privacy/` and an `eu/` notice for `BLOCKED_COUNTRIES`. Set `HOME_SITE_ENABLED=true` and the values below.
  Pages may name their operator through `{{MARKERS}}` (`OPERATOR_NAME`, `OPERATOR_URL`, `LEGAL_ENTITY_NAME`,
  `STATEMENT_DESCRIPTOR`, `TEMPLATE_URL`, `SUPPORT_EMAIL`, `ABUSE_EMAIL`, `SITE_HOST` = the canonical host) that
  `worker/src/home.ts` fills in, HTML-escaped, on every serve. Any of them missing = a warning, and the homepage stays off.
  `deploy:prod` stops if the homepage is on but the build has none. If the site is built in a repo of its own,
  `scripts/sync-home.mjs` builds it (`HOME_REPO`, default `../recitbot-home`; `HOME_REPO=none` skips it) and turns the values in
  `worker/wrangler.jsonc` into markers on the way in.
- **Hosts**: every hostname comes from `PUBLIC_BASE_URL`, `MCP_BASE_URL`, `SITE_HOSTNAMES` (e.g. `www.`), `SITE_ZONE` and
  `CUSTOM_DOMAIN_CNAME_TARGET`. Other names under the zone need no setting (reserved). The Cloudflare for SaaS fallback
  origin is set only in the Cloudflare dashboard (docs/operations.md); the code never names it.

## Upstream constants (not per deployment)

| What | Where | Why it is not config |
|---|---|---|
| Upstream release public keys `RELEASE_KEYS` and `TEST_KEY_IDS` | `scripts/signed-release.mjs` | Trust anchors for the upstream recorder builds every server serves; the recorders pin the same keys. Public keys only; no private key or passphrase is in the repo. |
| Product name "Recitbot" in tool text, and in pages and emails while `BRAND_NAME` is set | `worker/src`, `worker/web` | The product's name. The deployment's own name is `BRAND_NAME`. |
| Stripe metadata tag `app=recitbot`, OAuth scope `recitbot` | `worker/src/stripe.ts`, `worker/src/oauth/hosts.ts` | Protocol identifiers that clients and stored objects already carry. |
| `LIMITS`, plan prices text (shown only with billing on) | `worker/src/env.ts`, `worker/src/billing-tools.ts` | Product rules, the same everywhere. |

## Your private overlay

What makes a deployment yours is never in git. Keep a private copy of it outside the repository (names only here):

- `worker/wrangler.jsonc`:
  - Wrangler settings: `account_id`, `env.production.name`, `routes`, `workers_dev`, the D1 `database_name` / `database_id`,
    the R2 `bucket_name`.
  - Production vars: `DEV_MODE`, `SERVICE_MODE`, `WORKERS_PLAN`, `ALLOW_URL_KEY`, `GLOBAL_MAX_VIDEOS_PER_DAY`,
    `GLOBAL_MAX_TRANSCRIBE_MIN_PER_DAY`, `PUBLIC_BASE_URL`, `SITE_HOSTNAMES`, `SITE_ZONE`, `MCP_BASE_URL`, `BRAND_NAME`,
    `SUPPORT_EMAIL`, `ABUSE_EMAIL`, `HOME_SITE_ENABLED`, `OPERATOR_NAME`, `OPERATOR_URL`, `LEGAL_ENTITY_NAME`,
    `STATEMENT_DESCRIPTOR`, `TEMPLATE_URL`, `HOME_URL`, `DOCS_URL`, `BLOCKED_COUNTRIES`, `EMAIL_FROM`, `OWNER_ACCOUNT_IDS`,
    `TURNSTILE_DISABLED`, `SIGNUPS_DISABLED`, the `STRIPE_*_ID` vars, `CF_ZONE_ID`, `CUSTOM_DOMAIN_CNAME_TARGET`: the ones you use.
- `worker/home/`, if you have a homepage.
- Secrets live in Cloudflare (`wrangler secret`), never in a file: the five required keys and, if used, both Turnstile keys,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CF_SAAS_API_TOKEN`, and `OWNER_CLAIM_SECRET` until the server is claimed.

On a fresh clone, copy `worker/wrangler.jsonc` (and `worker/home/`) back in place; `npm run deploy:prod` then works as before.
`git status` never shows either (`.gitignore`).
