# Operations

Running a Recitbot server: the kill switch and key rotation, custom video domains, and takedowns. `example.com` stands for
your own domain.

## Kill switch, key rotation, revocation

- `SERVICE_MODE` var, checked on every request:
  - `ON`
  - `NO_TRANSCRIBE`: no Whisper calls.
  - `READ_ONLY`: no new accounts, pairing, recording or uploads; links still play, but no view stats are recorded.
  - `OFF`: everything returns 503.
  - Unknown values are treated as `OFF`.
- **Rotating `SHARE_HMAC_KEY` kills every legacy `/v/<id>?e&s` link, owner cookie and media token at once** (video URLs
  keep working; the page mints new media cookies). Per video, use `revoke_share` (new private URL) or
  `share_recording(rotate=true)` (new public URL).
- Rotating `UPLOAD_HMAC_KEY` invalidates in-flight uploads. Rotating `DEVICE_CMD_KEY` breaks every paired device, so all of them must re-pair.
- Rotating `INSTALLER_URL_KEY` invalidates the installer links handed out in the last 10 minutes; nothing else.
- API key: `rotate_key`. Operator revoke: `UPDATE api_keys SET revoked_at = unixepoch() WHERE account_id = ?`.
- Device: pairing a new device revokes the old one and closes its socket. Operator: `UPDATE devices SET revoked_at = unixepoch() WHERE id = ?`.

## Custom domains (Cloudflare for SaaS)

Pro, Teams and owner accounts get one custom video hostname (e.g. `videos.customer.example`, a subdomain the customer owns,
CNAME `customers.example.com`), served by this Worker through Cloudflare for SaaS on the `example.com` zone. Hostnames
live in D1 `custom_domains` (migration 0027).

**Host gate (`worker/src/hosts.ts`, `worker/src/custom-host.ts`).** Every request is classified by `new URL(req.url).hostname`
only (lowercased, trailing dot dropped; `X-Forwarded-Host`, `Forwarded` and similar headers are never read):
- *ours*: `PUBLIC_BASE_URL`'s, `MCP_BASE_URL`'s and the `SITE_HOSTNAMES` hosts (e.g. `example.com`,
  `www.example.com`, `mcp.example.com`), `*.workers.dev` (installed
  recorders), and with `DEV_MODE` on loopback hosts and the reserved `.example` TLD (the tests' origin). These route as before.
- *reserved*: any other name under `SITE_ZONE` (e.g. `*.example.com`: `customers.`, `fallback.`, ...): 404 on every path.
- *customer*: everything else. Looked up in `custom_domains` (cached ~30 s per isolate, misses ~10 s). Unknown or
  `failed`: 404. `disabled_at` set: a neutral 451 "This page is unavailable." on every path, whatever the status. `redirecting` (until
  `redirect_until`): 301 to `https://<redirect_to><path>`, or for `redirect_to = example.com` from `/<slug>` of that
  account to `https://example.com/<username>/v/<slug>`; afterwards 404. `pending` / `active`: only `GET|HEAD /<slug>`
  (the account's public video; anything private, passcode, not ready or expired 302s to its example.com URL, so sign-in
  and passcodes never happen on a customer domain), `POST /<slug>/b` (view beacon), `GET|HEAD /m/<slug>` (media),
  `GET|HEAD /s/*`, `GET|HEAD /b/<sha256>` (brand assets; 404 until branding ships), `/robots.txt`. Everything else,
  any other method included, is 404: `/`, `/mcp`, OAuth, `/.well-known/*`, `/device/*`, `/upload/*`, `/api/*`,
  `/billing/*`, `/i/*`, `/v/*`, `/<user>/v/*`, installer files, `/m/<slug>/file`. Paths containing `//`, `\`, `/..`,
  `%2f`, `%5c` or `%2e%2e` are 404 before matching. The page there has no comments, owner controls or download; its
  canonical and `og:url` are on the custom host; its only cookie is the per-path `mt` media cookie.
- Static assets: `run_worker_first` is `true`, so the gate runs before any file is served (the asset server would
  otherwise hand `/terms/`, `/privacy/`, `/eu/`, `index.html` and the installers to any host). On our hosts, a GET/HEAD
  that matches no route is passed to `env.ASSETS` (`worker/src/index.ts` `staticAsset`), same files and `_headers` as before.

**One-time setup (dashboard, by the operator; nothing here is done by deploy):**
1. example.com → SSL/TLS → Custom Hostnames: enable Cloudflare for SaaS (Custom Hostnames).
2. DNS: `fallback.example.com AAAA 100::`, proxied. Set it as the fallback origin and wait for **Active**.
3. DNS: `customers.example.com CNAME fallback.example.com`, proxied. This is the `CUSTOM_DOMAIN_CNAME_TARGET` customers use.
4. Worker route `*/*` on example.com → this Worker. It is in `env.production.routes` in `worker/wrangler.jsonc`, so
   `npm run deploy:prod` creates it. The Workers Custom Domains for `example.com` and `mcp.example.com` take precedence on
   those names; `*/*` catches the SaaS custom hostnames, grey- and orange-clouded. Any other proxied name on the zone now
   reaches the Worker too and gets the reserved 404, so check the zone's DNS records first.
5. API token: Zone → SSL and Certificates: Edit, scoped to example.com only. Store it as the Worker secret
   `CF_SAAS_API_TOKEN` (`npx wrangler secret put CF_SAAS_API_TOKEN --env production`), and put the zone id in the
   `CF_ZONE_ID` var (not a secret). Either one missing = custom domains are off (the tools answer `CUSTOM_DOMAINS_OFF`).

Cloudflare answers HTTP domain-control validation for custom hostnames at its edge, so no `/.well-known` route is needed
(and the gate 404s `/.well-known/*` on customer hosts).

Env: secret `CF_SAAS_API_TOKEN`; vars `CF_ZONE_ID`, `CUSTOM_DOMAIN_CNAME_TARGET` (no default; e.g. `customers.example.com`).

## Custom domains: abuse runbook

**Prevention.** `set_custom_domain` refuses names that could pass for a bank, a payment or sign-in page, a big brand or
Recitbot (`worker/src/domain-blocklist.ts`: brand / auth words per label, homoglyph folds like `paypa1`, `rnicrosoft`,
mixed-script or all-look-alike punycode) with `HOSTNAME_NEEDS_REVIEW`, telling the user to email `ABUSE_EMAIL`.
Each refusal is logged (`custom domain needs review`, with the hostname and reason). To approve one by hand there is no
override yet: it's a code change to the list. Rate limits: 3 sets per account per UTC day, 200 per day and 60 per hour
in all (every set that reaches Cloudflare counts). Page views on customer hosts get the same per-viewer and per-video
daily caps as example.com pages (Governor `checkView`).

**Where reports arrive.** `https://example.com/report?host=<hostname>&v=<slug>` (our hosts only; 404 on customer hosts)
explains how to report and offers a prefilled email to **`ABUSE_EMAIL`** (`mailto:` with subject
`Report: <host>/<slug>` and the page's link as the body; query values are stripped of CR/LF and must be a plain hostname /
slug). It has no form, so there is nothing to spam; it answers even while the service is off, and a failure still shows
the address. Custom-host pages link to `/report`, never to a `mailto:` directly. The address is the
`ABUSE_EMAIL` var (else `SUPPORT_EMAIL`, else `EMAIL_FROM`). Mail for it is routed outside this repo;
the Worker has no email handler.

**Taking a domain down.** Rule: every takedown is reversible by the owner with no customer action; only purge isn't.
The logic is `worker/src/domain-takedown.ts` (`disableDomain`, `enableDomain`, `purgeDomain`, `listDomainActions`; the
contract is at the top of the file) and every step is appended to `custom_domain_actions` (migration 0029), which no code
path updates or deletes. Operator tools, from an MCP client signed in as an account in `OWNER_ACCOUNT_IDS` (invisible,
and "Unknown tool", for everyone else; `accounts.plan = 'owner'` alone isn't enough):
1. `admin_list_custom_domains {status?}` to find it (`status: "disabled"` lists what's already down).
2. `admin_disable_custom_domain {hostname, reason, note?, suspend_account?}` (reversible). `reason` is one of
   `csam | phishing | malware | impersonation | other` (stored in `disabled_reason`); `note` goes to the action log only.
   - Only D1 changes: `disabled_at` / `disabled_reason` are set and the host cache is cleared. **Cloudflare is not
     touched**: the custom hostname and certificate stay, which is what makes enable instant.
   - The host gate answers a neutral **451** "This page is unavailable." on every path and method, whatever the row's
     status (no customer content, branding, slug or reason; no cookies, no CORS; noindex): immediately on the server
     that ran the tool and within **30 s** on every other one (custom-host.ts caches rows per isolate for 30 s).
   - The account gets `DOMAIN_DISABLED` from `set_custom_domain` / `remove_custom_domain`, no other account can claim
     the name (`HOSTNAME_TAKEN`), and the hourly cron never refreshes, fails or deletes a disabled row.
   - `suspend_account: true` also disables the account's other custom hostnames, each reversible the same way.
3. `admin_enable_custom_domain {hostname, note?, force?}` undoes it with no customer action: the row keeps the status it
   had, so an active domain serves again at once (30 s elsewhere). While an `admin_takedown` of the hostname is open it
   refuses with `OPEN_TAKEDOWN` (listing the action ids): reverse those with `admin_restore` instead, or pass
   `force: true` (the takedowns then stay open in the log).
4. `admin_purge_custom_domain {hostname, confirm: true, note?}` (**irreversible**, for final takedowns only): the domain
   must already be disabled. It deletes the Cloudflare custom hostname (if Cloudflare refuses, nothing changes), sets
   `cf_id` NULL and status `failed`, and keeps the row disabled, so the name still answers 451 and stays blocked.
   Enabling a purged domain can't bring it back: the customer would have to set it up again.
5. `admin_domain_actions {hostname?, limit?}` reads the action log (who, when, action, reason, note, evidence).

## Takedowns: recordings, accounts, hostnames

`admin_takedown {target, reason_code, note?}` takes down one thing; `target` is a recording id, an account id or a custom
hostname, `reason_code` is required (`csam | phishing | malware | impersonation | other`), `mode` is only `disable`.
The logic is `worker/src/takedown.ts` (contract at the top) and the state is read by `worker/src/takedown-state.ts`:
- **Recording**: removed at once. Its page (example.com, `/v/<id>` and the custom host) answers **451** "This video was
  removed" (a neutral Recitbot page: no title, branding or reason); media, download, the signed file link and comments
  are refused; the owner can't share it (`RECORDING_REMOVED`), read its transcript, learn from it or delete it.
- **Account**: suspended. `start_recording`, sharing, `set_custom_domain`, `set_branding`, `get_installer` and
  `update_recorder` answer `ACCOUNT_SUSPENDED`, `/device/enroll` refuses its pairing codes (403, the code stays unused),
  and every video of the account is removed as above. An upload already in progress still finishes (the bytes are kept
  and held) but is never transcribed. Its brand images (`/b/<hash>`, unless another account that isn't suspended has
  the same bytes) and the custom host's `/favicon.ico` answer 404; brand images cache for 5 minutes, so no CDN purge is
  needed. Its custom hostname keeps serving the 451 removal pages; take it down too if needed.
- **Hostname**: `disableDomain` (above), with the `custom_domain_actions` row linked from the evidence log.

Nothing is deleted. Every takedown appends an `admin_actions` row (migration 0031): operator, time, target, account,
reason, note, a JSON before-state snapshot (no keys, tokens, signed URLs or transcripts), and later
`reversed_by` / `reversed_at`. That table *is* the state (removed = an open takedown of the recording or its account), and
SQLite triggers make it append-only: no `DELETE`, no `INSERT OR REPLACE`, and the only `UPDATE` sets `reversed_at` and
`reversed_by` once. `admin_restore {action_id}` reverses exactly that takedown and appends a `restore` row; the target
comes back unless another open takedown still covers it (`effect` says), and a hostname is enabled only if it wasn't
disabled before and wasn't disabled or purged again (`admin_disable_custom_domain`) after the takedown. A hostname
takedown commits the domain disable and its `admin_actions` row in one batch. **csam**: restoring needs `confirm: true`, and the recordings (the one taken down, or every recording of
the account) are *held* for good: never deleted by the owner, the expiry cleanup, `deleteRecordings` or the storage
reconcile, even after a restore. `admin_actions {target?}` reads the log (`target` also matches the account's rows).
Purging stays hostname-only (`admin_purge_custom_domain`); there is no media-delete path for operators.

Every takedown step is logged at warn level (`takedown: custom domain disabled|enabled|purged`, `takedown: done|restored`, with hostname, account,
reason and actor; never a note, token or key); the list tools log `admin: ... listed`. If you publish terms of use, cover custom domains in them.
