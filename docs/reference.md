# Server reference

How the Worker works. Setup is in the [README](../README.md), every setting in [SELFHOST_CONFIG.md](../SELFHOST_CONFIG.md),
day-to-day operation in [operations.md](operations.md). `example.com` stands for your own domain.

## MCP tools

| Tool | Auth | Purpose |
|---|---|---|
| `get_installer(platform?)` | key | `platform`: `"windows"` or `"macos"` (bots ask the user "Windows or Mac?" when unsure, never guess; omitted = the platform of the paired devices when they are all one known platform; no paired device, devices on both or one of unknown platform = `needs_choice: true`, `question: "Windows or Mac?"`, no command or pairing code). `command` (Windows: no-prompt `powershell.exe` one-liner the bot runs on the user's PC from cmd, PowerShell or WSL; macOS: `/bin/bash -c` one-liner that downloads install.sh and checks its pinned SHA-256 (`install_sh_sha256`) before running it), `download_url` (signed, pre-paired installer for bots that cannot run commands), `expires_at`, `platform`, `install_ps1_sha256` (Windows), `pairing_code` (10 min, single use, built into both), `uninstall`, `paired_devices` (count), `max_devices` (2 free, null owners) and, at the limit, `device_limit` (the refusal message; re-pairing an already paired PC still works). `powershell` = `command` (older field name). See [Windows install flow](#windows-install-flow-no-admin). |
| `update_recorder()` | key | `{current, latest, action}`: `up_to_date`, `update_sent` (signed `update` command sent), `offline`, `not_paired`, `unknown_version` / `reinstall_required` (recorder too old to update itself: run `get_installer` again); `last_update` = the PC's last update report. See [Recorder self-update](#recorder-self-update). |
| `get_latest()` | key | `{playbook: {version, text}, recorder: {version, install_ps1_sha256}, installer: {download_url, expires_at}, how_to_update}`. The download link is an update link (install.ps1 itself, no pairing code). See [Playbook](#playbook-setup-guidance-carried-by-the-server). |
| `device_status(device?)` | key | `{paired, online, device, paired_devices, max_devices}` for the default device (most recently connected online one) or `device`. |
| `remove_device(device)` | key | Unpairs one device (id, or name / unique part of it): its token is revoked at once, its socket closed (4001), its stored inventory dropped, a recording in progress on it marked `failed`/`DEVICE_REMOVED`. Other devices stay paired. Returns `removed`, `removed_this_device` (the call came from that device's network), the remaining `paired_devices`, `note`. |
| `list_devices(refresh?, device?)` | key | `paired_devices` (`id`, `name`, `platform` (`"windows"`, `"macos"` or null = unknown, never assumed Windows; what the recorder reports at pairing is kept, else the pairing code's), `paired_at`, `last_seen_at`, `online`, `this_device`; online first, most recently connected first), `max_devices`, and for `device` (default: the most recently connected online one; named in `device`/`device_name`): monitors (`id`, `index`, `primary`, `label` left/center/right, `position`, resolution, model), mics (`default` marks the Windows default), webcams and open windows (`id`, `app`, `exe`, `title`, `monitor` + `monitor_label`, `minimized`, `size`; topmost first, at most 40) of the paired PC. From the recorder's report on connect; `refresh` asks the PC live (signed `devices` command, ≤4 s). Always `refresh` before recording a window. |
| `start_recording(title?, device?, max_seconds? (default and max = the account limit: 300 s free, 14400 s = 4 h Pro and Teams; owners have no plan limit, the start ceiling is 14400 s), monitor?, window?, mic?, mic_device?, system_audio?, webcam?, camera?, webcam_size?, webcam_shape?, open_link?)` | key | Starts recording immediately on one device: `device` (id or name) or, by default, the most recently connected online one (result: `device`, `device_name`; `NO_DEVICE_ONLINE` names an online alternative). `monitor`: id, index, `primary` (default), `left`/`right`/`center`, `second`/`other`. `window` (instead of `monitor`): a window id, or words that must all match app, exe and title (`chrome youtube`). `mic` defaults to **on** (the Windows default mic); `mic:false` turns it off, and a PC with no mic still records. `mic_device`: id or name part (`HyperX`); default = Windows default mic. `system_audio` defaults to **on**: the sound playing on the PC's default output, mixed with the mic. "no mic" = `mic:false` only; "no system audio", "no computer sound", "mute desktop audio", "just my voice" = `system_audio:false` only; "mute", "muted", "no audio", "silent" = both false. `webcam` shows the webcam bubble (omit = device setting); `camera` id/name; `webcam_size` small/medium/large = 160/240/360 px, or a number = percent of the monitor's shorter side (clamped to 120–480 px); `webcam_shape` `circle` (default) or `rect` ("square cam", "rectangle", "box"). `open_link:false` skips the auto-open for this recording. A recorder too old for an option still records without it; the result then has `recorder_version`, `unsupported` and `notes` (e.g. "System audio isn't supported on this recorder version"). Errors: `NO_DEVICE_ONLINE`, `DEVICE_NOT_PAIRED`, `CAP_REACHED{resets_at}`, `SERVICE_PAUSED`, `DEVICE_NOT_FOUND`/`DEVICE_AMBIGUOUS{field,candidates}`, `WINDOW_NOT_FOUND`/`WINDOW_AMBIGUOUS{candidates}`, `RECORDER_UPDATE_REQUIRED`, `INVALID_ARGUMENTS` (window + monitor). |
| `stop_recording(recording_id?)` | key | Stops; the recorder uploads what was captured. Without `recording_id`: the account's one active recording (`NO_ACTIVE_RECORDING` when none, `MULTIPLE_ACTIVE_RECORDINGS` with the list when several devices are recording). |
| `get_video(recording_id, wait_seconds<=25)` | key | Status, `has_system_audio`, `owner_url` (the user's own link, see [Owner links](#owner-links-owner_url)), plus, once `ready`, `share_url` (the video's one URL, `/<username>/v/<slug>`), `visibility` (`private`/`public`) and a one-line `note`. `expires_at` null = owner tier, kept until deleted. Long-polls. `transcript_status: pending` = watchable, transcript still coming (transcription took over 10 s). |
| `list_videos(limit?)` | key | Own recordings, newest first, each with `has_system_audio`, `views`, `unique_views`, `last_viewed_at`, `avg_watch_pct`, `previews`. |
| `list(limit?)` | key | Same as `list_videos` (kept for older clients). |
| `search_videos(query, limit?)` | key | Title + transcript search. Best match first, ties newest first, non-matches left out. Same stats per video. |
| `get_video_stats(recording_id \| video_id)` | key | Totals plus a per-UTC-day breakdown (last 30 days, days without views omitted). |
| `get_transcript(recording_id, format text\|vtt)` | key | `[mm:ss] text` lines or WebVTT, from the mic only (system audio is never transcribed). Needs the mic (the default); a recording without one has no transcript. |
| `share_recording(recording_id, passcode?, rotate?)` | key | Makes the video public and returns its URL (the same one `get_video` shows; sharing again keeps it). Optional passcode. `rotate:true` = `revoke_share` then share: a new public URL. |
| `share(...)` | key | Same as `share_recording` (kept for older clients). |
| `revoke_share(recording_id)` | key | Makes the video private **and** replaces its slug: the old URL 404s at once for everyone (page and media). Returns the new, private URL. Owner only. |
| `set_username(username?, display_name?)` | key | Changes the `<username>` in URLs (public videos at the old username 301 to the new one). `display_name` is shown as "Recorded by …" (default: the username). Without arguments returns the current values. `INVALID_USERNAME`, `USERNAME_RESERVED`, `USERNAME_TAKEN`. |
| `delete(recording_id)` | key | Deletes media, transcript, view stats and links. |
| `rotate_key()` | key | New key; the key used for the call is revoked. |
| `set_custom_domain(hostname)` | key | Pro, Teams and owner only (`UPGRADE_REQUIRED`). One custom video hostname per account, any subdomain of a domain the customer owns (`videos.customer.example`). Validated before any network call (lowercase, IDN → punycode, a pasted `https://host/` is fine; no IP, wildcard, port, path or userinfo; Public Suffix List: bare domains → `APEX_NOT_SUPPORTED`, private suffixes like `vercel.app`/`github.io`/`workers.dev` → `PLATFORM_DOMAIN`, `example.com` → `RESERVED_HOSTNAME`), look-alike / brand names need a manual review (`HOSTNAME_NEEDS_REVIEW`, see [abuse runbook](operations.md#custom-domains-abuse-runbook)), unique across accounts (`HOSTNAME_TAKEN`), 3 per account and 200 in all per UTC day, 60 in all per hour (`RATE_LIMITED`). Creates the Cloudflare for SaaS custom hostname (HTTP DCV), then stores it `pending`. Returns `dns` (`<sub> CNAME customers.example.com`), `instructions` (per DNS host). Same name again = its status; a new name replaces the old, which redirects to it for 30 days. See [Custom video domains](#custom-video-domains). |
| `get_custom_domain_status()` | key | The account's hostname; a pending one is re-checked with Cloudflare and a DoH CNAME lookup. `phase`: `waiting_for_dns`, `wrong_target`, `verifying`, `issuing_certificate`, `live` (`live_url`), `error` (`errors`), `failed`. Plus `redirecting` hostnames and their end dates. |
| `remove_custom_domain()` | key | Live hostname → redirects to example.com for 30 days, then deleted; never-live → deleted from Cloudflare and D1 at once. Idempotent. |
| `admin_disable_custom_domain(hostname, reason, note?, suspend_account?)`, `admin_enable_custom_domain(hostname, note?, force?)`, `admin_purge_custom_domain(hostname, confirm, note?)`, `admin_list_custom_domains(status?, limit?)`, `admin_domain_actions(hostname?, limit?)` | key, `OWNER_ACCOUNT_IDS` only | Operator takedown tools: hidden from `tools/list` and answered as unknown tools for every other account. Disable / enable are reversible (D1 only); purge (IRREVERSIBLE) deletes the Cloudflare hostname. See [abuse runbook](operations.md#custom-domains-abuse-runbook). |
| `admin_takedown(target, reason_code, note?, mode?)`, `admin_restore(action_id, confirm?, note?)`, `admin_actions(target?, limit?)` | key, `OWNER_ACCOUNT_IDS` only | Operator takedowns of a recording, an account (suspend) or a custom hostname; `reason_code` required. Reversible, logged append-only with a before-state snapshot (`admin_actions`, migration 0031); csam needs `confirm` to restore and its files are never deleted. See [Takedowns](operations.md#takedowns-recordings-accounts-hostnames). |
| `admin_retention_hold(account_id \| username, hold, note?)` | key, `OWNER_ACCOUNT_IDS` only | Pauses (`hold: true`) or resumes (`false`) the Free auto-delete and 7-day expiry for one account (`accounts.retention_hold`, migration 0032). Reversible and idempotent (`already`); changes no plan, `expires_at` or billing and deletes nothing itself. `recordings_past_expiry` = what the next cleanup deletes once it is cleared. |
| `admin_overview()`, `admin_billing()`, `admin_usage()`, `admin_devices()`, `admin_errors()`, `admin_lookup(email \| username \| account_id)` | key, `OWNER_ACCOUNT_IDS` only | Read-only operator views: signups, plans, conversions, storage, custom domains (live / pending / redirecting / taken down) and configuration warnings; Stripe MRR and failures; top accounts by storage; recorder versions; recording failures; one account (plan, suspended or not, retention hold, Stripe ids only, usage, devices, recent recordings, custom domains, open takedowns). Never a key, token, signed URL, transcript or full email. |

Endpoint: `POST /mcp` with `Authorization: Bearer <api_key>`, on every host: `<PUBLIC_BASE_URL>/mcp`, `<MCP_BASE_URL>/mcp`
and the workers.dev URL. Responses are stateless JSON (no SSE). Clients that support MCP OAuth sign in through `/oauth/authorize` instead of sending a key.

**Several devices.** An account can have several paired devices, each with its own hashed `ardt_` token; removing one
never touches the others. Free accounts may have up to 2 at once (`LIMITS.maxDevices`), owner accounts
(`OWNER_ACCOUNT_IDS`) any number. Pairing another device keeps the existing ones. At the limit `POST /device/enroll`
answers 409 `{error: "device_limit", message, max_devices}` and changes nothing (the code stays unused): the limit check,
the code's consumption and the insert are one D1 batch (`pairDevice`, migration 0010). Re-pairing a PC that is already
paired replaces its own row instead of taking a slot. The DeviceHub keeps one socket per device; commands go to
`device` or to the most recently connected online device, `stop` to the device that is recording, and inventories and
update reports are stored per device. `devices.last_seen_at` is written on connect and disconnect.

**Casual device requests.** The `start_recording` and `list_devices` descriptions teach the model the shorthand users type
(rec, mon, 2nd, webcame, cam, face, mic, headset, "no cam", "no mic", "just my voice", "no computer sound", "mute", "no audio",
"silent", "square cam", "round") with worked examples (mic and system audio are on unless the user turns them off), and tell it to call
`list_devices` first whenever a specific monitor, mic or camera is named, then pass ids. The Worker resolves names against the
last inventory before any quota is spent (`DEVICE_NOT_FOUND` / `DEVICE_AMBIGUOUS` with candidates, so the model can ask the
user only when two entries really match). The recorder resolves again against its own live inventory, and only inventory
entries ever reach ffmpeg. Matching rules are the same on both sides (`worker/src/devices.ts`, `DeviceMatch` in the recorder)
and are covered by the same fixture in both test suites.

**Window requests.** "rec my chrome", "the youtube window", "record zoom", "that notepad" map to `window` (two worked examples
in the `start_recording` description). The model calls `list_devices(refresh:true)` and passes a window id. Text is matched
by tokens: every word except filler (`the`, `my`, `window`, `that`, `with`, `open`, ...) must appear in app, exe or title,
so `chrome youtube` means app Chrome *and* a title containing YouTube. Several hits give `WINDOW_AMBIGUOUS` with candidates
(id, app, title, monitor), and the model asks the user. No hit gives `WINDOW_NOT_FOUND` with the closest windows. Both fail
before any quota is used. The Worker matches against a report at most 20 s old (`windowReportMaxAgeSeconds`; otherwise it
asks the PC live) and sends only the resolved id, signed in a `|win|<id>` block that exists only when a window is recorded.
The recorder looks the id up in its own live window list (`hash(hwnd|pid|exe)`). If the window is gone, the recording
fails with `WINDOW_NOT_FOUND`; it never falls back to a whole monitor. A recorder older than 0.3 reports no windows, and
the Worker answers `RECORDER_UPDATE_REQUIRED` instead of sending a command it would reject.

**"How many people watched my last video?"** The `list_videos` description spells it out: call `list_videos{limit:1}`
(newest first, so the first entry is the last video) and answer with `unique_views` (people), plus `views` (opens). Every
stats tool repeats what each number means and that stats disappear with the video (7 days after recording on the free tier).

**Key in URL (`/mcp/k/<key>`)** is implemented but **off** (`ALLOW_URL_KEY=false`). Enable it only if a specific MCP client cannot send headers. The URL then *is* the secret: it can end up in client configs, shell history and proxy logs. The Worker redacts it from its own logs.

## View stats

D1 only. No Analytics Engine, no new products, no new dependencies. Migration `0002_view_stats.sql` is additive: four
counters on `recordings` (`views`, `unique_views`, `previews`, `last_viewed_at`), `devices.ip_hash`, a `video_views`
table (one row per counted view) with one index, and `view_salts` (one row per day).

**What counts as a view.** The player page carries a signed view token (`<view id>.<exp>.<HMAC>`, 6 h, bound to the
video) in `data-vt`. Its script (`/s/player.js`) sends `navigator.sendBeacon(location.pathname + '/b', t=<token>&p=<pct>)` once on load. That first
beacon is the view, so prefetchers and scanners that don't run JavaScript never count. Later beacons fire when playback
first passes 25/50/75/100 % and on `pagehide` with the furthest point reached (at most ~6 per view). One D1 batch
(a transaction) per beacon: `INSERT OR IGNORE` the view row, bump the recording's counters only if that insert happened
(`changes() = 1`), raise `max_pct` only upward. Replays and duplicate beacons are therefore no-ops: idempotent per view id.

- `views`: counted views. `unique_views`: distinct viewers, where a viewer is
  `HMAC(IP_HASH_KEY, daily salt + video + IP + User-Agent)` cut to 128 bits. The salt is random per UTC day, kept in
  `view_salts`, and the cron deletes it after a day, so hashes can't be tied back to an IP even by someone holding
  `IP_HASH_KEY`. The same person on two days counts twice, and two people behind one NAT with the same browser build
  count once. `last_viewed_at`: unix seconds.
- `avg_watch_pct`: mean of each view's furthest point (0–100), computed on read. A view that never pressed play is 0.
  Seeking forward counts as reaching that point.
- `previews`: link-preview bots (Slackbot, Twitterbot, facebookexternalhit, Discordbot, WhatsApp, TelegramBot,
  LinkedInBot, …) get the link-preview meta and a title-only page: no token, no player, no cookie, no media URL.
  Counted separately, capped at 50 per video per day.
- Never counted: `HEAD` (not routed for video pages), `/m/<slug>` media and Range requests (they need the page's cookie and
  never touch stats), beacons with a bot User-Agent, anything while `SERVICE_MODE` is `READ_ONLY`.

**Write cost per view:** 1 `video_views` row + its index entry + 1 `recordings` update. Progress beacons rewrite only
that view's `max_pct`; no-op beacons write nothing. Views are already capped (page loads) at 300 per viewer per video per
day and 20000 per video per day (no per-video ceiling for an Owner-tier account's videos), and beacons at 20 per view per hour through the Governor (unreachable Governor = beacon refused, nothing written). Worst
case is far inside the D1 free tier. View rows are deleted with their video (`delete` or the hourly cron at the video's `expires_at`).

**Owner exclusion.** A page view is the owner's, and gets no view token (so it cannot count), when any of these holds:

1. **Owner.** The request is the video's owner (`isOwner`, see [Owner links](#owner-links-owner_url)): signed in on
   the website, or holding this video's owner cookie from its `owner_url`. Only then does the page show "Owner view: not
   counted in view stats."
2. **Legacy stats cookie.** `ro`, an HttpOnly, `SameSite=Lax`, `Path=/` cookie valid for 30 days holding a signed, opaque
   per-account tag (not the account id). New ones are only set when an `owner_url` handed out before migration 0005
   (`/v/<id>?e&s&o=`) is opened. It only keeps views out of the stats: no chip, no editor, no owner rights.
3. **Paired PC.** When the recorder connects, the Worker stores `HMAC(IP_HASH_KEY, ip)` on the device row (writing only
   when it changes). Views from that public IP are not counted while the device is not revoked (any of the account's
   paired devices). Like `ro`, this grants nothing.

Limits:
- The owner opening a public video in a browser that is not the owner's and not on the PC's network is counted as a viewer.
- The IP rule excludes everyone behind the same public IP as the PC (office NAT, shared Wi-Fi, CGNAT). Colleagues
  there are not counted. A VPN on either side defeats it.
- MCP calls never look like views (they don't load the page), so the bot reading stats doesn't skew them.

## Video URLs: one per video, private by default

**URL.** Every video has exactly one URL, `https://example.com/<username>/v/<slug>`. `recordings.slug` (migration
0005, unique index) is 80 random bits in base62 (14 chars), set when the recording starts; it is the only id in the URL and
on the page (media is `/m/<slug>`), so the internal recording id never reaches viewers. MCP outputs, tool descriptions and
the server instructions give only this URL form.

**Visibility.** `recordings.shared_at` NULL = **private** (the default): only the owner (`isOwner` in
`worker/src/owner-link.ts`: signed in on the website, or this video's owner cookie) can open the page or its media. Everyone else, link-preview bots included, gets the same 404 page, "This video is private or doesn't exist", that a
slug which never existed gets, so private and nonexistent can't be told apart. Expired and not-yet-ready videos answer the
same. `share_recording` sets `shared_at`: the same URL now opens for anyone. `revoke_share` clears it **and** replaces the
slug, so the old URL is dead at once for everyone, owner included, and bumps `shares.version`, which kills media cookies
already handed out (they are bound to it). It returns the new URL, private. Sharing again later keeps the current slug; you
rotate by revoking (`share_recording rotate:true` = revoke, then share).

**Usernames** (`worker/src/username.ts`, `accounts.username`, unique). 3-30 chars of `[a-z0-9-]`, starting and ending with a
letter or digit, no `--`. Reserved: `v mcp api oauth well-known upload admin login signup settings pricing faq about www
static assets recitbot` plus the existing root routes `m s device install uninstall`. `assignUsername(db, accountId, hint?)`
derives one from the hint, else the email local part, else the bot name, else `user` (lowercased, accents stripped, other
runs become `-`, max 24 chars); a taken, reserved or too-short base gets a 4-char suffix (`alex-x7k2`). It is idempotent and
runs on first use (any tool or page that builds a URL), which is also how accounts from before migration 0005 get one.
`accounts.display_name` (optional, via `set_username`) is what the page shows as "Recorded by …".

**Routing.** The slug decides what is shown. A wrong username (old, other case, anything) with a valid slug 301s to the
right one only when the video is public; for a private video it is the generic 404, even for the owner.
Links already sent: `/v/<id>?e=&s=` (and the old `owner_url`'s `&o=`) 301 to the video's URL while the video is public and the
signature is valid for the current share version; otherwise the generic 404. Revoking bumps the version, so a revoked
video's old links stay dead after it is shared again. The bare `/v/<id>` 301s only the owner.

**Ready push.** It sends the owner link on the `/v/<id>` path, `/v/<id>?ot=<token>`: shipped recorders only open that
path, and their `LinkPolicy` already accepts the token's characters in the query. Opening it makes that browser the
video's owner and lands on `/<username>/v/<slug>`, private or not.

### Owner links (`owner_url`)

`worker/src/owner-link.ts`. Every video tool result (`get_video`, `update_video`, `list_videos`/`list`, `search_videos`,
`share_recording`/`share`, `revoke_share`) carries `owner_url` = the video's URL + `?ot=<token>`, next to the public
`url`. The token is `base64url(JSON {a, v, ov, exp, p:"owner"})` + `.` + HMAC-SHA256 under a key derived from
`SHARE_HMAC_KEY` (label `owner-link-v1`, no new secret), valid 24 h. Opening it (not a link-preview bot) sets one
HttpOnly, Secure, `SameSite=Lax`, `Path=/` cookie (`__Host-rb_owner`, 30 days, at most 20 videos, newest kept, signed
with the same derived key) and 303s to the clean URL (`Referrer-Policy: no-referrer`, `no-store`). An invalid, expired,
revoked or other video's token: the same 303, no cookie, no error. It is not a web sign-in: it grants owner rights on
that one video only (editor, deleting any comment, owner comments without Turnstile, the Owner view chip, the private
page). `/signin` still grants them on all of the account's videos. `isOwner` (web session OR this video's cookie entry
at the current `recordings.owner_version`) is the only owner check; the meta PATCH, comment DELETE and owner comment
POST also need same-origin. `revoke_share` (and `share rotate:true`) bumps `owner_version` (migration 0011), so every
owner link and owner cookie for that video stops working at once. Bots give `owner_url` to the user only, never in public.

**Migration 0005** adds `accounts.username`, `accounts.display_name`, `recordings.slug` (backfilled with random hex) and
`recordings.shared_at`. Recordings that already had a share link (a `shares` row) start public, so links already sent keep
working through the 301; everything else, and everything recorded from now on, starts private.

**Retention.** Free tier: new recordings get `expires_at = created_at + 7 days`. Rows recorded before that change keep
the `created_at + 24 h` they were given (no migration rewrites `expires_at`). The hourly cron deletes every row past its
own stored `expires_at` (index `recordings_expires`, migration 0009), so both kinds expire on time. Owner tier
(`OWNER_ACCOUNT_IDS`): `expires_at = 253402300799` (`KEEP_FOREVER`), kept until `delete`; revoking does not delete. The
cron skips owner accounts' rows and moves any expired owner row (from before `KEEP_FOREVER`, or an account promoted since)
to `KEEP_FOREVER`. **Retention hold** (`accounts.retention_hold`, migration 0032, `admin_retention_hold`): while it is 1
the cron skips the account's rows and they never count as expired (`worker/src/retention-hold.ts`: watchable, listed,
downloadable, shareable); `expires_at` is left as stored, so it applies again once the hold is cleared. It is separate from
takedown holds, and the account's owner can still `delete`. Tools show `auto_delete_paused: true` meanwhile.

## Share page

`GET /<username>/v/<slug>` renders a Recitbot-branded page (`worker/src/share.ts`) with a custom player and the transcript. No
framework and no new dependencies: one vanilla script and one stylesheet, served with the fonts and images as Workers
Static Assets under `/s/`. Sources live in `worker/web/`. `npm run build` runs `scripts/build-web.mjs`, which copies them to
`worker/public/s/` (gitignored), writes `worker/public/_headers` (`/s/*`: 7-day cache, `nosniff`, `noindex`) and puts a
content hash in `worker/src/generated-web.ts`, so the page links `player.js?v=<hash>` and `recitbot.css?v=<hash>`.

**Homepage.** Optional and yours: none ships with the server. Put a static site in `worker/home/` (git-ignored;
`index.html`, and if you want them `terms/`, `privacy/` and `eu/`), set `HOME_SITE_ENABLED=true` and its operator values
(SELFHOST_CONFIG.md). `scripts/sync-home.mjs` (last step of `npm run build` and `deploy:prod`) copies it into
`worker/public/`; it fails on a file the Worker build already put there (byte-identical icons excepted) and on paths the
Worker routes, and appends the homepage rules to `_headers` from `worker/src/home-headers.json`. `worker/src/home.ts` fills
the pages' `{{MARKERS}}` in on every serve (so pages carry no ETag), 404s `/` on the `mcp.` host and gives
`BLOCKED_COUNTRIES` visitors the `/eu/` notice with 451. Without `worker/home`, or with the homepage off, those paths are 404.

**Brand.** Ink `#111318` page, Paper `#F5F3EE` text, Transcript Teal `#1FA89A` for progress and timestamps, Tally Red
`#F2463A` only on the main play button, Blush `#FFE1DC` focus rings, `#A3A8B3` muted text (Graphite on Ink is only 3:1).
The header is the dark transparent lockup. Expired-link, passcode and limit pages use the app icon. Fonts are self-hosted,
latin-subset woff2 from Fontsource (all SIL OFL 1.1, licence files next to them in `worker/web/fonts/`): Space Grotesk 700
(headings), Inter variable (UI) and JetBrains Mono 500 (timestamps), with `font-display: swap` and system fallbacks. No font
CDN, no analytics, no third-party requests of any kind.

**Player** (`worker/web/player.js`). The page ships a normal `<video controls playsinline preload="metadata">`. The script
removes the native controls and shows its own, so without JS the browser's controls still work.
- Play/pause (big red button and control bar), scrub bar with current time / duration, buffered range, a time preview on
  mouse hover or while dragging (pointer events; touch drags are throttled to one seek per 120 ms because each seek is a
  Range request), volume slider and mute (on iOS, where scripts can't set volume, only mute is shown), speed 0.5–2×
  (native `<select>`), full screen on the player container, and on iPhone Safari `video.webkitEnterFullscreen()`.
- Keyboard: Space / `k` play/pause, ←/→ seek 5 s, ↑/↓ volume, `m` mute, `f` full screen. Ignored while focus is in an
  input, select or textarea, or with Ctrl/Alt/Cmd held. Space on a focused button just presses the button.
- Mouse: click plays/pauses, double-click toggles full screen. Touch: a tap shows or hides the controls. Controls hide
  after 2.5 s of no activity while playing and always show while paused.
- Accessible: every button has an `aria-label` that names its shortcut, the scrub bar is a `role="slider"` with
  `aria-valuetext` ("00:42 of 01:30") that also takes Home/End, icons are `aria-hidden`, and `:focus-visible` rings. With
  `prefers-reduced-motion`, transitions are off and the transcript jumps instead of scrolling smoothly.
- If playback fails (for example the 5-minute media cookie lapsed during a long pause and a seek hits an unbuffered range),
  the player says to reload the page. A reload counts as a new view.

**Transcript.** Each line is a `<button data-t="<start seconds>">` with its timestamp in JetBrains Mono, teal. Clicking a
line seeks there and plays. The active line gets `aria-current="true"` (teal bar and tint). If it is out of view, the
transcript box (never the page) scrolls to it, but not within 4 s after the viewer scrolled the box themselves. Side by
side with the video from 1024 px, stacked below it on phones.

**Link previews and privacy.** Every page (viewer, bot, passcode, expired) carries `og:title` (the video title, or
"Recitbot recording"), `og:description`, `og:image` (static 1200×630 card `/s/og-card.png`, as an absolute URL on the host
that was asked), `og:site_name` Recitbot, `twitter:card` `summary_large_image`, favicons (ico, svg, apple-touch-icon),
`<meta name="robots" content="noindex, nofollow, noarchive">`, plus the `X-Robots-Tag` header and
`Referrer-Policy: strict-origin-when-cross-origin`. The page makes no cross-origin requests and has no links, so the signed
URL never travels in a Referer to anyone else. Link-preview bots get the meta but no player, token, cookie or media URL, so
they can't get around the signature and don't count as views. The signed-link, passcode, view-cap and owner checks are
unchanged.

**CSP.** `default-src 'none'`. Scripts, styles, fonts and images only from `<origin>/s/`, media and `connect-src` (beacons)
`'self'`, `frame-ancestors 'none'`. No inline script or style, no nonces.

**Expired or invalid link.** 404 with the same branding: "This link has expired or isn't valid", with what to do next.

**Weight.** `player.js` 12.0 KB (3.9 KB gzip), `recitbot.css` 8.2 KB (2.8 KB gzip), fonts 82.9 KB (Inter 48.3, JetBrains
Mono 21.8, Space Grotesk 12.8; woff2 is already compressed). The lockup is 6.1 KB, the og card 45 KB (fetched only by
unfurlers).

**OG card.** `scripts/og-card.html` is the source. Re-render it with headless Chrome (command in the file's header).

## Windows install flow (no admin)

1. The bot calls `get_installer` and runs `command` on the user's PC itself; the user never sees the pairing code. The command is
   `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "<script>"`, where `<script>` contains no `$`, `"`,
   `` ` ``, `%` or `!`, so the same line works from cmd, PowerShell and bash under WSL (it calls `powershell.exe` explicitly).
   The script downloads `install.ps1` to a temp file → checks its SHA-256 against the hash embedded in the command (computed at
   build time, served from a constant) → runs it in a child `powershell.exe -NonInteractive -File … -Server … -Code …` → deletes
   the temp file → exits with the installer's exit code. There is no `irm | iex`. Shape (placeholders in `<>`):
   ```
   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try{[Net.ServicePointManager]::SecurityProtocol=…Tls12;
   Set-Variable ProgressPreference SilentlyContinue;Set-Variable f (Join-Path ([IO.Path]::GetTempPath()) ('recitbot-install-'+[guid]::NewGuid()+'.ps1'));
   Invoke-WebRequest -UseBasicParsing -Uri '<origin>/install.ps1' -OutFile (gv f -ValueOnly) -ErrorAction Stop;
   if((Get-FileHash -Algorithm SHA256 -LiteralPath (gv f -ValueOnly)).Hash -ne '<INSTALL_PS1_SHA256>'){throw 'install.ps1 SHA-256 mismatch'};
   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (gv f -ValueOnly) -Server '<origin>' -Code '<code>';
   Set-Variable rc (gv LASTEXITCODE -ValueOnly)}catch{Write-Output ('RECITBOT_INSTALL_FAILED: '+(gv _ -ValueOnly));Set-Variable rc 1}
   finally{…remove the temp file…};exit (gv rc -ValueOnly)"
   ```
   (one line in reality). Bots that cannot run commands give the user `download_url` instead (see [Signed installer links](#signed-installer-links)).
2. `install.ps1` downloads `recorder.zip` and verifies its pinned SHA-256. It uses `ffmpeg` from PATH if present. Otherwise it downloads
   the pinned gyan.dev build (`ffmpeg-9.0.2-essentials_build.zip`, SHA-256 `60F46726…47BA`) and verifies it. Any hash mismatch aborts.
3. Installs to `%LOCALAPPDATA%\AgentRecorder`, then enrolls with the pairing code. The code goes over stdin, never on a command line.
   The device token and command key are stored with DPAPI (CurrentUser).
4. Registers a per-user Scheduled Task at logon (hidden, `RunLevel Limited`) and starts the agent **through that task**, so it is not
   a child of the calling shell and survives the bot's shell or sandbox ending (Codex kills children). If the task cannot be
   registered (policy, restricted shell) or does not start it within 10 s, it starts the agent through WMI (`Win32_Process.Create`, also outside the caller's
   process tree); `autostart=none` in the result means there is no logon task. Each start waits up to 10 s for `agent.pid`.
   `-NoAutostart` skips the task and starts the agent as a child (dev, e2e). `-UseSystemTools` requires ffmpeg on PATH. The same
   settings can come from env vars `AGENT_RECORDER_NO_AUTOSTART=1`, `AGENT_RECORDER_USE_SYSTEM_TOOLS=1` and `AGENT_RECORDER_INSTALL_DIR`.
5. Result: one line, `RECITBOT_INSTALL_OK device=<device id> version=<recorder version> autostart=<logon|none>` and exit 0, or
   `RECITBOT_INSTALL_FAILED: <reason>` and exit 2 (arguments; `-Update` without an install), 3 (download or hash check), 4 (pairing:
   wrong, used or expired code) or 5 (the agent did not start). Nothing prompts: `-NonInteractive` everywhere, `-Server` is the only
   mandatory parameter. The bot then polls `device_status` until `online`.
6. **Re-running is safe.** On an installed PC it downloads and verifies everything first, then stops the running agent (by
   `agent.pid` and by path), swaps the files, re-pairs with the new code (the new pairing replaces that PC's old one: same name from the same public IP, or the old `device_token` in the enroll body; it does not take another slot), re-registers the
   task and restarts. `-Update` without `-Code` keeps the existing DPAPI pairing (the recorder's self-update uses this). A failed
   `-Update` restarts whatever is installed.
7. Uninstall: `%LOCALAPPDATA%\AgentRecorder\uninstall.ps1` (also served at `/uninstall.ps1`). It stops the agent, removes the task and the folder.

### Signed installer links

`GET /i/<token>`, where token = `v1.<purpose>.<account id>.<exp>.<nonce>.<pairing code or empty>.<mac>` and mac =
base64url `HMAC-SHA256(INSTALLER_URL_KEY, "installer-url|" + everything before it)`, compared in constant time. Expiry =
the pairing code's (10 min).

- `install` (from `get_installer`): serves `recitbot-install.ps1` (`Content-Disposition: attachment`, `no-store`), a pre-paired
  script that does exactly what `command` does. The user runs it with right-click > Run with PowerShell.
- `update` (from `update_recorder` and `get_latest`): serves `install.ps1` itself as `recitbot-update.ps1`; its SHA-256 is
  `INSTALL_PS1_SHA256`. Carries no pairing code.
- Malformed token or unknown purpose: 404. Bad signature (any field changed, other key, purpose swapped): 403. Expired: 410.
- The link may be fetched again until it expires; the pairing code inside still pairs only once (`pairDevice`). A pairing refused at the device limit leaves the code unused.
- **Why the code is carried in the token, not encrypted and not stored:** D1 keeps only the code's SHA-256 as before. Whoever
  holds the link can download the script, which has to contain the code anyway, so encrypting it inside the link would protect
  nothing; the link is a bearer secret for 10 minutes, the code works once, and `/i/…` paths are redacted from the Worker's logs.

Windows has no OS permission prompt for screen capture. **macOS** (`recorder-mac/`, served as `/install.sh`) needs the TCC Screen
Recording permission: install.sh asks for it once right after a new pairing; `uninstall.sh` resets it.

## Recorder self-update

`update_recorder` compares the connected recorder's hello version with `RECORDER_VERSION` (written into `generated.ts` by
`scripts/build-recorder-zip.mjs` from `public const string Version` in `AgentRecorder.cs`).

- Behind and online, and the hello listed `self_update` (recorder 0.5.0+): the DeviceHub sends a signed `update` command
  (same per-device HMAC, 60 s expiry and nonce as every command) with `url` = a signed update link, `version` and `sha256` =
  `INSTALL_PS1_SHA256`, signed as `…|url|<url>|upd|<version>|<sha256>`. Only to the paired device's current socket.
- Older recorders get `reinstall_required` (or `unknown_version` without a hello) and are never sent the command: its
  `upd` block would fail their MAC check. The agent runs `get_installer`'s command again, which updates in place.
- Recorder (`SelfUpdater`): acts only on a version newer than its own, never while recording, only for an installed copy
  (exe folder = data folder), at most once per 10 minutes. The link must be https on the server's host or the recorder's built-in upstream host, path
  `/i/<token>`, no query (http only against a loopback dev server); at most 1 MB, SHA-256 must match. It writes the script to
  `%TEMP%\recitbot-update-<guid>.ps1` and starts `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle
  Hidden -File <ps1> -Server <server> -Update -InstallDir <dir>` with `CreateNoWindow` (no window, no focus change).
- `install.ps1 -Update` downloads and verifies recorder.zip, then stops the old recorder, swaps the files, keeps the DPAPI
  pairing, re-registers the task and starts the new recorder, whose hello carries the new version (`update_recorder` then says
  `up_to_date`). The old recorder keeps running until the new files are verified, so a failed download changes nothing.
- The recorder reports `{"type":"update","status":"installing"|"failed","version","error"?}`; the DeviceHub keeps the last report
  per device and `update_recorder` returns it as `last_update`.

### Signed updates (recorder `signed_update`)

Recorders that announce `signed_update` install an update only with a release manifest signed offline by a Recitbot
release key (recorder repo: PROTOCOL.md 5.1, RELEASING.md). The server holds no key and signs nothing; it relays.

- **Release in, byte for byte out.** A signed Windows release goes into `recorder/release/` (`install.ps1`, `recorder.zip`,
  `uninstall.ps1`, `update-windows.json`, `hashes.json`); a signed Mac release adds `install.sh`, `update-macos.json` and
  `hashes.txt` to `recorder-mac/`.
  `scripts/build-recorder-zip.mjs` then serves that install script as is (no rendering) and fails unless its SHA-256 and
  size are the manifest's, it pins the archive served with it, and it installs the manifest's version
  (`scripts/signed-release.mjs`). `manifest` / `manifest_sig` go into `generated.ts` (`UPDATE_MANIFEST_*`). `.gitattributes`
  keeps those files' line ends untouched.
- **Command.** `updateCommand` adds `manifest` and `manifest_sig` (base64, verbatim) when the platform has them. They are
  sent after the `mac` is computed and are **not** in the canonical string; `fitCommand` drops them for recorders without
  `signed_update`, so 0.6.1 and older get exactly the hash-pinned command above.
- **No manifest, no push.** A `signed_update` recorder would refuse an unsigned update: the auto-update sends nothing,
  `hub.pushUpdate` refuses (`unsigned`), and `update_recorder` answers `no_signed_release`. Older recorders still get it.
- **Refusals are final.** A report whose `error` is one of the recorder's release-manifest refusals (`update not signed …`,
  `update signature …`, `update manifest …`, `update needs … installed first`, downgrade refused, installer size / sha256
  not matching the manifest) sets the automatic push for that version to `gave_up` at once (no `maxFailures` retries) and
  logs one warning. A new release (new version) starts over.
- **No dev builds, no TEST keys.** The build fails on a placeholder-key recorder build: a `release_keys` field in
  `hashes.json` or a `RELEASE_KEYS=` line in `hashes.txt` (any value: the recorder repo writes them only for placeholder
  keys, `"PLACEHOLDER: dev build, not a release"`), or its placeholder keys (`…-PUBLIC-KEY-NOT-FOR-RELEASE`) inside a
  served script or recorder zip (every entry inflated). A signed release must bring its build's hashes file
  (`hashes.json` / `hashes.txt`), listing the served script, archive and version. A manifest whose `key_id` is one of the
  recorder repo's TEST fixture keys (`TEST_KEY_IDS`) fails the build too. `npm run deploy:prod` re-checks `generated.ts`
  and `worker/public/` after the build (`deployProblems`) and stops before anything remote.
- Without a signed release a platform builds as before (Windows compiled here, scripts rendered from the templates).

## Playbook: setup guidance carried by the server

Bot templates and skills never update after they are installed, so the server carries the guidance. `worker/src/playbook.ts`
holds `PLAYBOOK_VERSION` (`YYYY.MM.DD-n`) and `PLAYBOOK_TEXT`: first-run pairing (`get_installer` → run `command`, or hand over
`download_url` → poll `device_status`), recording defaults, share approval (videos are private; no link goes to anyone but the
user until the user approves), the free-tier limits (numbers taken from `LIMITS`) and updating (`get_latest`, `update_recorder`).
`get_latest` returns it; bots rewrite their skill when the version changes. The MCP `initialize` instructions are its short
form (`MCP_INSTRUCTIONS`). Describe only what the code does; bump the version with every edit.

## Auto-open of the share link

- When an upload completes, the Worker transcribes (waiting at most 10 s for the transcript, `LIMITS.readyPushWaitMs`; after
  that the video is marked ready with `transcript_status: pending` and the transcript lands later) and pushes one signed
  `ready` frame over the existing DeviceHub WebSocket to **the device that recorded it**. The frame carries the bare `/v/<id>`,
  which 301s the signed-in owner to the video's URL (see [Video URLs](#video-urls-one-per-video-private-by-default)).
- The push is claimed in D1 (`ready_pushed_at`) before it is sent: never twice per recording, never replayed after a reconnect,
  nothing for failed or expired recordings, for `open_link:false`, or for recorders that did not announce `ready_push`.
- Only `https` links to `/v/<that recording>` on the Worker's public host (`PUBLIC_BASE_URL`, or the
  workers.dev host) are pushed. The recorder applies the same rule (`LinkPolicy`: its server's host or its built-in upstream host, https,
  default port, no user info or fragment, `/v/<id>` only; http only for a loopback dev server) and opens a link only for a
  recording it uploaded itself in the last 30 min, once (`ReadyLinks`). The URL is never written to the agent log.
- Opening is `ShellExecute` of the https URL (`Process.Start` with `UseShellExecute`), so the default browser opens it as a new
  tab in the window that is already open. No browser exe is started by name.
- Every stop path ends in the same upload, so the Stop click, `stop_recording` and the max-time stop all open the link.
- **Turn it off:** `AgentRecorder.exe --set auto_open_link=false [--data DIR]` (default `true`; `--data` defaults to the exe's
  folder, i.e. `%LOCALAPPDATA%\AgentRecorder` for an install). Exit code 0 = saved, 6 = unknown key or value, 3 = not
  enrolled there. A running agent reads it when a link is ready, so no restart is needed. For one recording only:
  `start_recording(open_link:false)`.
- Tests stub the opener with `AGENT_RECORDER_OPEN_LOG=<file>` (the URL is appended there instead of opening a tab).

## Cost guardrails (Governor DO, fail closed)

| Guardrail | Limit | Where |
|---|---|---|
| Video length | 300 s free, 14400 s (4 h) Pro and Teams; owners (`OWNER_ACCOUNT_IDS` or `accounts.plan` 'owner') no plan limit, 14400 s start ceiling; also checked on upload complete from the MP4 itself (fragmented files too; unreadable = refused except Owner); above it `LIMIT_EXCEEDED` (server cap + ffmpeg `-t`). Recorders without `chunked_upload`: 120 s | `start_recording`, recorder |
| Video size | Per recording: 250 MiB free, 8 GiB Pro, Teams and owners. One PUT ≤ 80 MB (`Content-Length` + `FixedLengthStream`, `ftyp` magic); more = chunked upload (at most 512 parts) | `/upload` |
| Audio (transcription WAV) size | 10 MiB free, 480 MiB Pro, Teams and owners (4 h of 16 kHz mono is ~461 MB) | `/upload` |
| Recording starts per account | Per UTC day: 20 free, 200 Pro/Teams, 500 owner; failed starts are handed back; past it `CAP_REACHED{resets_at}` | Governor + `start_recording` |
| Transcription per account | Per UTC day, from the audio's bytes: 60 min free, 600 min Pro/Teams, owner only the global cap; past it the recording has no transcript | Governor + upload complete |
| Unpaired account | 0 recordings | Governor + `start_recording` |
| Global videos/day | `GLOBAL_MAX_VIDEOS_PER_DAY` (template: 2000 in production) | Governor |
| Global transcription | `GLOBAL_MAX_TRANSCRIBE_MIN_PER_DAY` (template: 400 min a day in production, about $0.21 a day at $0.000513/min) | Governor |
| Views | 300 page loads per viewer (salted IP hash) per video per UTC day; 20000 per video per UTC day (none for an Owner-tier account's videos); the owner's own views never capped; link-preview bots not counted | Governor |
| View stats | Beacons: 20 per view per hour, ≤256-byte body; previews counted ≤50 per video per day; no stats writes in `READ_ONLY` | Governor + `/v/:id/b` |
| MCP calls | 60/min per key; 60/min per IP unauthenticated | Governor |
| New accounts (OAuth sign-in) | 3/day per IP, 10/day per /24 (/64 for IPv6); disposable domains blocked; one account per canonical mailbox | Governor |
| Sign-in emails | Turnstile on the email step (fails closed); 500 per UTC day in all | Governor + `/signin`, `/oauth/authorize/email` |
| Failed auth | 10 per 10 min per IP, then 429 | Governor |
| Retention | Free tier: each row's own `expires_at` (7 days for new recordings, 24 h for older rows; hourly cron deletes R2 + rows incl. `video_views`; view salts after 1 day); owner tier kept until deleted. An R2 lifecycle rule must not delete owner media: scope it or drop it | cron |

Every spend point (start, upload, transcribe, view) checks the Governor first. If the Governor is unreachable, the request is refused.
Degradation order: transcripts go first (`transcript_unavailable`), then new recordings (`CAP_REACHED`). Existing links keep playing.

## Custom video domains

Pro, Teams and owner accounts can put their videos on one hostname of their own (`videos.customer.example`), served by
Cloudflare for SaaS custom hostnames on the example.com zone. Managed only through the MCP tools above
(`worker/src/custom-domains.ts`, `domain-tools.ts`, the Cloudflare client `cf-saas.ts`); table `custom_domains`
(migration 0027). The customer adds one CNAME, `<sub> CNAME customers.example.com`; Cloudflare validates it over HTTP
and issues the certificate, and the row goes `pending` → `active` once Cloudflare's hostname and SSL status are both
active. A changed or removed hostname goes `redirecting` (to the new host, or `example.com`) for 30 days. The hourly
cron re-checks up to 20 pending rows, fails (and deletes from Cloudflare) rows still pending after 7 days, and deletes
expired redirects and day-old failed rows from Cloudflare and D1.

Env (names only; without the token, the zone id or the CNAME target custom domains are off and the tools answer `CUSTOM_DOMAINS_OFF`):

| Name | Kind | Value |
|---|---|---|
| `CF_SAAS_API_TOKEN` | secret | API token with Zone → SSL and Certificates: Edit, scoped to example.com only |
| `CF_ZONE_ID` | var | The example.com zone id |
| `CUSTOM_DOMAIN_CNAME_TARGET` | var | What customers CNAME to (e.g. `customers.example.com`); required |

## Long recordings: chunked upload

Cloudflare caps one request body at 100 MB, and a single `PUT /upload/:id/video` is capped at 80 MB. Free accounts can record
up to 5 minutes (up to 250 MiB of video) and Pro, Teams and owner accounts longer (up to 8 GiB of video per recording), so a recorder that sends `chunked_upload` in its hello can upload in parts through an
R2 multipart upload. Older recorders keep the single PUT and are held to 120 s (`start_recording` shortens `max_seconds` and adds
a note).

- **Start command:** for `chunked_upload` recorders it carries `upload_part_bytes` (32 MiB), signed as the trailing block
  `|mp|<bytes>`. If a file is larger than that, the recorder uses the chunked path. Otherwise it uses the single PUT as before.
- **Endpoints:** all use the same upload token (`Authorization: Bearer`), which is checked against the recording's device:
  - `POST /upload/:id/(video|audio)/mp` with optional `{total_bytes}` creates the upload (and aborts any earlier one for that file).
  - `PUT …/mp/:n` sends part `n` = 1, 2, 3… in order. A re-sent last part replaces it. Every part except the last is `upload_part_bytes`.
  - `POST …/mp/complete` with `{parts: N}` assembles the file.
  - `DELETE …/mp` aborts.
  - Then `POST /upload/:id/complete` finishes the recording as before.
- **Rules:** non-final parts are 16–50 MiB and all the same size (part 1 sets it). A smaller part is the last one. At most 512 parts (8 GiB at the 16 MiB minimum; recorders send 32 MiB parts).
  Part 1 must start with the `ftyp`/`RIFF…WAVE` magic.
- **Errors:**
  - `PART_OUT_OF_ORDER{expected}`, `PART_AFTER_LAST`, `PARTS_MISSING{received}`, `NO_UPLOAD` (409).
  - `BAD_PART_SIZE`, `TOO_MANY_PARTS`, `LIMIT_EXCEEDED{limit,max}` (413).
  - `UPLOAD_ABORTED` (502): any R2 failure aborts the whole upload, and the recorder starts again with a new create.
- **Cleanup:** finishing, deleting or expiring a recording aborts its open uploads. The hourly cron aborts any upload older than 24 h.
  State lives in D1 `multipart_uploads` (migration `0004_multipart_uploads.sql`).
- **Audio:** the transcription WAV is 16 kHz mono PCM16 (32 KB/s), so 30 minutes is about 57.6 MB (one PUT) and 4 hours about
  461 MB (chunked), under the 480 MiB Pro, Teams and owner cap. Audio longer than 5 minutes is transcribed in 5-minute windows
  read with R2 range reads, so the Worker never holds the whole WAV (at most 64 MiB of a WAV that can't be windowed).
- **Limit errors** look like `{error: "LIMIT_EXCEEDED", message, limit, max, requested, tier}`.
- **Recorder side** (`Uploader`, covered by the selftest against a scripted server): `max_seconds` is accepted up to 14400 (4 h; the start command's value still governs). The
  video's `-fs` cap is 82 MB less room for the AAC track, or 8 GiB less that room when the command carries `upload_part_bytes`
  and `max_seconds` is over 120 s. A free 5-minute recording stays under its 250 MiB server cap through the encoder's
  bitrate cap (at most 5 Mb/s, about 190 MB in 300 s). A file larger than `upload_part_bytes` goes through create, parts 1..N in order and complete. A part with
  no response or a 5xx other than 502 is sent again with the same number and byte range (3 tries, 2 s and 4 s apart). A 502
  starts over from create (at most 3 times). Any other 4xx fails the recording (`UPLOAD_REJECTED_<status>`). The agent log
  has `video: <bytes> bytes in <N> parts of up to <part>`, and `timing:` lines for each capture process (see below).
- **A/V timing lines:** the screen and the mic are separate ffmpeg processes. For each one, the recorder logs its `t0` (shared
  QPC clock), the smallest (arrival − `out_time`) of its `-progress` lines in the first and last 10 s relative to `t0` (`lag
  start/end`, which moves apart if that timeline drifts from the wall clock), its final `out_time`, and for the mic the WAV's
  own sample length. When the mic's `t0` is after the video's, one more line gives the start trim: `timing: mic starts <ms>
  ms after the first frame; video starts at its keyframe at <ms> ms`, or past 500 ms `timing: mic late <ms> ms, capped; …`
 . The mic is then cut at `video t0 + trim − mic t0` (the
  `offset` in the `audio mixed` line; negative only when capped, a delay), so the offset left at the start is the difference
  of the start lags, and at the end it is the difference of the end lags.

## Keyframes (recorder 0.6.1, `keyframes`)

After `POST /upload/:id/complete` the recorder PUTs up to 6 JPEG stills from the uploaded MP4, one per request, with the
same upload token: `PUT /upload/:id/keyframes/:n?t=<ms>` (`Content-Type: image/jpeg`). They are stored at R2
`k/<id>/<n>.jpg` with `n` and `t_ms` in D1 `recording_keyframes` (migration `0025_recording_keyframes.sql`); a PUT to a slot
that has one replaces it. `get_recording_for_skill` returns them. Deleting or expiring the recording deletes them.

| Status | When |
|---|---|
| 200 `{ok, n, t_ms, bytes}` | Stored |
| 400 `BAD_REQUEST` | `n` is 0, or `t` is not a whole number of ms (`^\d{1,8}$`) |
| 401 `UNAUTHORIZED` | Unknown recording, or the upload token is missing, wrong or expired |
| 404 `NOT_FOUND` | Not a PUT |
| 409 `BAD_STATE` | The recording is not `uploading`, `transcribing` or `ready` (also when it was deleted or failed during the PUT) |
| 413 `TOO_MANY_KEYFRAMES` / `TOO_LARGE_OR_NO_LENGTH` | `n` above 6; body empty, without `Content-Length`, or over 1 MiB |
| 415 `BAD_CONTENT_TYPE` / `BAD_MAGIC` | Not `image/jpeg`; the body does not start `FF D8 FF` |
| 503 `SERVICE_PAUSED` / `CAP_REACHED` | `READ_ONLY` or `OFF`; the Governor refused or is unreachable |

## Threat model

**Assets:** screen recordings and transcripts (highly sensitive); API keys; device tokens and command keys; share links; the
user's PC (a recorder that obeys forged commands would be spyware); Cloudflare spend.

| Actor / threat | Mitigations | Residual risk |
|---|---|---|
| Abusive signups | Accounts are created only through the OAuth sign-in (6-digit code sent to the email); 3/day/IP, 10/day per /24, disposable-email blocklist, 0 recordings until a real Windows device pairs, per-account and global caps | Botnets with many IPs and mailboxes can still create accounts. Each one needs a real paired PC to cost anything, and the global caps bound spend. |
| Stolen API key | Stored only as SHA-256; `rotate_key`; 60 calls/min; caps per account; recording always shows the control pill to the user | The thief can start recordings (visible to the user) and read that account's links until the key is rotated. |
| Key in URL | Off by default; redacted from logs | If enabled, URLs leak through client configs and history. |
| Stolen share link | Private by default; public URLs carry an unguessable 80-bit slug; `revoke_share` replaces it (old URL dead at once); deleted 7 days after recording on the free tier; optional passcode with 5-try lockout, 50 views/day, `noindex` + `Referrer-Policy: strict-origin-when-cross-origin` (no outbound links or third-party requests, so the URL is never sent cross-origin), strict CSP limited to `/s/`, media needs a 5-min HttpOnly SameSite=Strict cookie | Anyone holding a valid link can watch until it is revoked or rotated, or the video is deleted (owner-tier videos are kept until deleted). Screen-recording the viewer can't be prevented. |
| Leaked installer link (`/i/…`) | Signed (`INSTALLER_URL_KEY`), expires with the pairing code (10 min), the code inside pairs once, path redacted from Worker logs; update links carry no code | Within 10 minutes, whoever holds an install link can pair their own PC to the account (replacing the user's device, which the user notices) before the user does. |
| Forged self-update | Only through a signed `update` command (per-device HMAC, expiry, nonce); recorder checks version order, link host/path and the SHA-256 before running anything; installer runs hidden without prompts | Whoever controls the Worker deploy controls the update, as with the installer itself. |
| Compromised download / MITM | One-liner pins the `install.ps1` SHA-256; `install.ps1` pins `recorder.zip` and ffmpeg SHA-256; HTTPS only (loopback allowed for dev) | Whoever controls the Worker deploy controls the hashes. Code signing (Authenticode) is a later step. |
| Malicious MCP client / bot | zod validation on every tool, account-scoped queries, Origin check (no CORS), no tool reaches another account's data | A bot with the user's key acts as that user (by design). |
| Forged / replayed command to recorder | Device token bound to account in D1; DeviceHub checks the account; per-device HMAC + expiry + monotonic nonce on the device; recorder only connects out (no ports) | If the user's PC is already compromised, the local DPAPI secrets are too. |
| Upload abuse | Short-lived HMAC upload token bound to recording + device; magic bytes; size limit streamed without buffering | — |
| Window titles leave the PC | The inventory carries up to 40 window titles (cut to 120 characters), kept only as the DeviceHub's last report (overwritten on every report) and returned only to the account's own key. The agent log records window ids and app names, never titles | Titles can be sensitive (mail subjects, document names); anyone holding the API key can read the current list. |
| Viewer privacy / view-stat abuse | No raw IP or User-Agent stored: viewer hashes use a random daily salt deleted after a day; the PC's IP is stored only as a keyed hash; nothing about viewers is logged. Beacons need a view token signed into a real page load (bound to the video, 6 h), same-origin checks, 20 per view per hour, and are idempotent per view id. `owner_url` tokens, the owner cookie and the `ro` cookie are HMAC-signed and bound to their video/account; `o=` and `ot=` are redacted from logs | Someone holding a share link can inflate `views` up to the 50 page loads per video per day; `unique_views` needs distinct IPs. Owner exclusion is best effort (see [View stats](#view-stats)). A leaked `owner_url` lets whoever opens it within 24 h edit that one video and delete its comments for 30 days; `revoke_share` ends it at once. Within a day, whoever has `IP_HASH_KEY` and D1 can test whether a given IP + UA viewed a video. |
| Secrets in logs | One logging function that redacts `Authorization`, `ark_`/`ardt_` tokens, `/mcp/k/…`, token query strings and JSON secret fields (tested) | Platform-level request logs (Cloudflare) record URLs: a public video's URL is its access key. Keep Logpush off or scrub. |
| System audio captures more than the user meant | **On by default.** It records everything the PC plays: call audio (the other side of a Zoom/Teams call), notification sounds, media. The pill shows a PC-sound toggle from the first second, muted spans are written as zeros (never on disk), and `system_audio:false` / "just my voice" turns it off per recording | A user who forgets it is on can upload other people's voices from a call, or a notification sound, into a share link. The transcript also covers system audio. |
| Mic audio after a mute click | Live `volume@mic 0` plus exact silencing at mix time; temp WAVs deleted after the upload | Up to ~0.1 s of raw mic audio after the click sits in a local temp WAV until the recording ends. |
| Auto-open of the share link | Signed `ready` frame (same HMAC, expiry, nonce as commands) sent only to the recording device; https only, our own viewer path for that recording on the recorder's built-in upstream host or the server host, checked on both sides; opened once per recording this PC uploaded in the last 30 min; URL never logged; `--set auto_open_link=false` | Whoever controls the Worker can make the PC open one of its own viewer links (not an arbitrary site). The opened link is the owner link: on a shared PC the next user of that browser is that video's owner for 30 days (until `revoke_share`). |
