// The setup and usage guidance bots need. Bot templates and skills are frozen at install time, so the server carries
// it: get_latest returns playbook(config) (bots rewrite their skill when its version changes) and the MCP initialize
// instructions are mcpInstructions(config). Describe only what the code does today; bump PLAYBOOK_VERSION on every edit.
// Two variants: with billing (PLAYBOOK_TEXT, MCP_INSTRUCTIONS) and without (version + "-selfhost"): there, owner accounts
// have no limits, other accounts have this server's, and nothing mentions plans, prices or anything to buy.
import type { SelfHostConfig } from "./config";
import { freeLimitMessage, LIMITS } from "./env";
import { plainRecordingLimitMessage } from "./selfhost-text";
import { storageLimitMessage } from "./storage";

/** Learning from a recording: in the playbook and the initialize instructions. */
export const LEARN_SKILL_RULE =
  "When the user sends a Recitbot recording and says \"learn this skill\" (or asks you to learn from it), call " +
  "get_recording_for_skill with its url (or recording_id for one of the user's own), then write a reusable skill from " +
  "its transcript as its `instructions` say.";

export const PLAYBOOK_VERSION = "2026.11.22-1";
/** The version of the text without billing: always different, so a bot that moves between servers rewrites its skill. */
export const PLAIN_PLAYBOOK_VERSION = `${PLAYBOOK_VERSION}-selfhost`;

/** How bots must show videos: in the playbook, the initialize instructions and (short form) every video tool. */
export const VIDEO_LINK_RULE =
  "Always show each video as a clickable Markdown link using its title, e.g. [Q3 walkthrough](https://videos.example.com/alex/v/k7Qm2xR4). " +
  "Never show a bare video id or a bare URL.";
/** After a recording: name it, then show it. In the playbook, the initialize instructions and the recording tools. */
export const NAME_VIDEO_RULE =
  "Right after a recording is ready, call update_video to set a clear, specific title (and a short description if the " +
  "user gave one), then show the video as a Markdown link.";
/** Reporting viewer comments: in the playbook, the initialize instructions and list_comments. */
export const COMMENTS_RULE =
  "Report new comments to the user with a clickable Markdown link to the video, quoting each comment's author and text. " +
  "Call list_comments with since = the time of your last check to get only new ones. Comments exist only while a video " +
  "is shared: revoking access or deleting the video removes them. delete_comment {recording_id, comment_id} deletes " +
  "one (the user can also delete them on the video page).";
/** owner_url: who may get it. In the playbook, the initialize instructions and every tool that returns it. */
export const OWNER_URL_RULE =
  "owner_url is the user's own link to one video (opens for 24 h): give it to the user to open their video as its owner " +
  "and edit the title and description or delete comments on the page, no sign-in needed. NEVER post owner_url anywhere " +
  "public or send it to anyone else: whoever opens it can edit that video. To share a video, give out its url.";
export const VIDEO_LINK_HINT = "Show each video as its `display` Markdown link [title](url); never a bare id or URL.";

const minutes = (s: number) => s / 60;
const hours = (s: number) => s / 3600;
const days = (s: number) => s / 86400;
const GB = (bytes: number) => bytes / 1e9;
/** The Free plan in one line: in the playbook, the initialize instructions and the tools that touch the limits. */
export const FREE_PLAN =
  `Free plan: ${LIMITS.freeRecordings} videos total (never resets; deleting one doesn't give it back; then ` +
  `start_recording returns free_limit_reached: offer upgrade), up to ${minutes(LIMITS.maxSeconds)} minutes per recording, ${LIMITS.transcribeMinPerDay} minutes of transcription per UTC day, videos auto-delete ` +
  `${days(LIMITS.retentionSeconds)} days after recording, each viewer can open a video up to ${LIMITS.viewsPerViewerPerVideoPerDay} ` +
  `times per UTC day, up to ${LIMITS.maxDevices} paired devices (PCs) at once (pairing another keeps the ones already ` +
  "paired; at the limit, remove one with remove_device first). Pro: unlimited videos, up to " +
  `${hours(LIMITS.paidMaxSeconds)} hours per recording, ${LIMITS.paidTranscribeMinPerDay} transcription minutes per UTC day, kept until deleted, ${GB(LIMITS.storageBytesPerSeat)} GB of stored ` +
  "video per account; at the cap start_recording returns storage_limit_reached, at 90% it carries " +
  `storage_warning (tell the user); add_storage adds ${GB(LIMITS.storageAddonBytes)} GB for $3/mo (monthly plans only). ` +
  "Pro is $10/mo or $100/yr: before upgrade, ask the user monthly or yearly unless they said, " +
  "and pass it as billing. Teams is coming soon: not sold yet, no price to quote.";

/** The same limits on a server without billing. */
export const PLAIN_LIMITS =
  "This server's limits: owner accounts have none (one recording can be up to " +
  `${hours(LIMITS.recordingCeilingSeconds)} hours; videos are kept until deleted). Any other account: ${LIMITS.freeRecordings} videos total (never ` +
  "resets; deleting one doesn't give it back; then start_recording returns free_limit_reached: tell the user the message), " +
  `up to ${minutes(LIMITS.maxSeconds)} minutes per recording, ${LIMITS.transcribeMinPerDay} minutes of transcription per UTC day, videos auto-delete ` +
  `${days(LIMITS.retentionSeconds)} days after recording, up to ${LIMITS.maxDevices} paired devices (PCs) at once (pairing another keeps the ones already ` +
  "paired; at the limit, remove one with remove_device first). Each viewer can open a video up to " +
  `${LIMITS.viewsPerViewerPerVideoPerDay} times per UTC day. The operator of the server decides which accounts are owners.`;

/** "## Plans and limits" with billing. */
const PLAN_SECTION = `## Plans and limits
- Free: ${LIMITS.freeRecordings} videos total, each up to ${minutes(LIMITS.maxSeconds)} minutes (${LIMITS.maxSeconds} s). The ${LIMITS.freeRecordings} are for the account's whole
  life: they never reset, deleting a video doesn't give one back, and a start that fails doesn't count. account_info
  shows \`recordings_used\` of \`limits.max_recordings_total\`. Recordings made on Pro don't count.
- Free: videos, their transcripts, view stats and links auto-delete ${days(LIMITS.retentionSeconds)} days after recording (\`expires_at\`).
- Free: up to ${LIMITS.maxDevices} paired devices (PCs) at once. Pairing another keeps the ones already paired; at the limit,
  remove one with remove_device first.
- Pro (upgrade; get_plan shows the plan): unlimited videos, up to ${hours(LIMITS.paidMaxSeconds)} hours (${LIMITS.paidMaxSeconds} s) per recording, kept until you
  delete it, no watermark, any number of paired devices, download, one custom video domain and page branding. Storage
  is the limit (below). Leaving Pro (canceled or unpaid) ends the custom domain: it redirects to the server's own video links
  for 30 days, then is removed.
- Prices (USD, plus applicable tax): Pro $10/mo or $100/yr. upgrade sells Pro: ask
  the user whether they want monthly or yearly (unless they already said) and pass billing: "monthly" or "yearly"
  (monthly if omitted). Tell them the price and how often it renews, and get their explicit yes before giving or
  opening checkout_url. Monthly and yearly are the same plan: switching between
  them (Stripe billing page) keeps the custom domain and branding. get_plan and account_info show the billing interval.
- Teams is coming soon. It isn't sold yet and has no price: never quote one or offer it; if the user asks, say it's
  coming soon and offer Pro.
- Pro storage: ${GB(LIMITS.storageBytesPerSeat)} GB of stored video per account, plus
  ${GB(LIMITS.storageAddonBytes)} GB per storage add-on. account_info shows \`storage_used_bytes\`, \`storage_limit_bytes\` (null = no storage cap:
  Free and Owner) and \`storage_addons\`. Deleting a video frees its space at once.
- At ${LIMITS.storageWarnShare * 100}% or more of it, start_recording (the recording still starts) and account_info carry \`storage_warning\`, e.g.
  "You've used 92.3 GB of your ${GB(LIMITS.storageBytesPerSeat)} GB of Recitbot storage." Tell the user that line.
- storage_limit_reached{storage_used_bytes,storage_limit_bytes,storage_addons} from start_recording: the account is at
  or over its storage and nothing was started; the message says "${storageLimitMessage(LIMITS.storageBytesPerSeat)}"
  Tell the user the message. Offer to delete old videos (list_videos, then delete with their approval) or add_storage.
- add_storage: ${GB(LIMITS.storageAddonBytes)} GB more for $3 USD per month plus applicable tax, added to the user's Pro subscription
  and renewing with it (a prorated charge for the rest of the current period today). It returns \`checkout_url\`, a
  Stripe page where the user confirms it and gives a card. Tell the user the price and get their explicit yes before
  giving or opening it. Each completed page adds one add-on; account_info shows the new \`storage_limit_bytes\` within
  seconds. Free and Owner have no storage cap: nothing to add. The add-on is monthly: on a yearly plan add_storage
  fails with STORAGE_ADDON_MONTHLY_ONLY ("The storage add-on is monthly; it's not available on yearly plans yet."):
  tell the user the message.
- Transcription: up to ${LIMITS.transcribeMinPerDay} minutes per UTC day on Free and ${LIMITS.paidTranscribeMinPerDay} on Pro, counted from the length of each
  recording's audio. Past it the video is still saved and shareable, without a transcript (transcript status unavailable).
- Views: each viewer can open a video up to ${LIMITS.viewsPerViewerPerVideoPerDay} times per UTC day (the user's own views never count), and a
  video takes up to ${LIMITS.viewsPerVideoPerDay} views per UTC day in all. Past that the page asks the viewer to try again tomorrow.
- Over a limit: LIMIT_EXCEEDED{limit,max} (Free: record shorter). free_limit_reached{limit,used} from start_recording: the
  Free account has used all ${LIMITS.freeRecordings} videos and nothing was started; the message says "${freeLimitMessage(LIMITS.freeRecordings)}"
  Tell the user the message and offer upgrade (it never resets, so don't retry). CAP_REACHED{resets_at} from
  start_recording: "Global daily recording ceiling reached." when Recitbot as a whole is at its daily ceiling. Tell
  the user the message and when it resets (resets_at); don't retry in a loop.
`;
/** "## Limits" without. */
const LIMITS_SECTION = `## Limits
- Owner accounts (account_info: owner true) have no limits: any number of videos, up to ${hours(LIMITS.recordingCeilingSeconds)} hours (${LIMITS.recordingCeilingSeconds} s) per
  recording, kept until deleted, no watermark, any number of paired devices, download, one custom video domain and page
  branding. The operator of the server decides which accounts are owners.
- Other accounts: ${LIMITS.freeRecordings} videos total, each up to ${minutes(LIMITS.maxSeconds)} minutes (${LIMITS.maxSeconds} s). The ${LIMITS.freeRecordings} are for the account's whole life: they
  never reset, deleting a video doesn't give one back, and a start that fails doesn't count. account_info shows
  \`recordings_used\` of \`limits.max_recordings_total\`.
- Other accounts: videos, their transcripts, view stats and links auto-delete ${days(LIMITS.retentionSeconds)} days after recording (\`expires_at\`).
- Other accounts: up to ${LIMITS.maxDevices} paired devices (PCs) at once. Pairing another keeps the ones already paired; at the limit,
  remove one with remove_device first.
- Transcription: other accounts up to ${LIMITS.transcribeMinPerDay} minutes per UTC day, counted from the length of each recording's audio. Past it
  the video is still saved and shareable, without a transcript (transcript status unavailable).
- Views: each viewer can open a video up to ${LIMITS.viewsPerViewerPerVideoPerDay} times per UTC day (the user's own views never count), and a
  video of an account that isn't an owner takes up to ${LIMITS.viewsPerVideoPerDay} views per UTC day in all. Past that the page asks the viewer to
  try again tomorrow.
- Over a limit: LIMIT_EXCEEDED{limit,max} (record shorter). free_limit_reached{limit,used} from start_recording: the account
  has used all ${LIMITS.freeRecordings} videos and nothing was started; the message says "${plainRecordingLimitMessage(LIMITS.freeRecordings)}"
  Tell the user the message (it never resets, so don't retry). CAP_REACHED{resets_at} from start_recording: "Global daily
  recording ceiling reached." when the server is at its daily ceiling. Tell the user the message and when it resets
  (resets_at); don't retry in a loop.
`;

const buildPlaybook = (billing: boolean) => `# Recitbot playbook (${billing ? PLAYBOOK_VERSION : PLAIN_PLAYBOOK_VERSION})

Recitbot records the user's Windows screen when you ask and gives you a private link. Nobody presses record: only your
start_recording call starts a recording.

## First run: pair the user's PC or Mac
1. Find out whether the user's computer is a Windows PC or a Mac. If the user named it, use that. If you do not know,
   or the user is adding another computer, ask the user "Windows or Mac?" first and wait for the answer; never guess
   (your own shell may not be on the user's computer). Call get_installer with \`platform: "windows"\` (returns a
   PowerShell one-liner) or \`platform: "macos"\` (returns a bash one-liner that downloads install.sh and checks its
   pinned SHA-256 before running it). Without \`platform\` it uses the platform of the account's paired devices only
   when they are all the same platform; with no paired device, or devices on both, it returns \`needs_choice: true\`
   and no command: ask "Windows or Mac?" and call again with \`platform\`. It returns \`command\`, \`download_url\`,
   \`expires_at\` (${LIMITS.pairingCodeSeconds / 60} minutes) and \`platform\` (check it is the one you meant).
   On a Mac, run \`command\` in Terminal (zsh or bash); it installs Recitbot to ~/Applications, pairs it and starts it
   at login. The first recording asks the user to allow Screen Recording and Microphone in System Settings; tell them
   to click Allow (only the user can grant it). If you cannot run commands, give the user \`download_url\`: they open
   Terminal and run \`bash ~/Downloads/recitbot-install.sh\`. Same result line and exit codes as below.
   Uninstall on a Mac: ~/Library/Application Support/Recitbot/uninstall.sh. Steps 2-3 are for Windows.
2. If you can run shell commands on the user's Windows PC, run \`command\` yourself (cmd, PowerShell or WSL all work).
   It asks nothing and needs no admin: it downloads install.ps1, checks its SHA-256, installs the recorder for the
   current user in %LOCALAPPDATA%\\AgentRecorder, pairs it, registers it to start at logon and starts it in the
   background. It prints \`RECITBOT_INSTALL_OK device=<id> version=<v>\` and exits 0, or
   \`RECITBOT_INSTALL_FAILED: <reason>\` with exit code 1 (installer download or SHA-256 check), 2 (arguments), 3
   (recorder download or hash), 4 (pairing: get a new command) or 5 (the recorder did not start). Tell the user the
   reason. The user never needs the pairing code.
3. If you cannot run commands, give the user \`download_url\`. They download recitbot-install.ps1 and right-click it >
   Run with PowerShell. The link works for ${LIMITS.pairingCodeSeconds / 60} minutes and pairs one PC once.
4. Poll device_status every few seconds until \`online\` is true.
Expired or used code (pairing failed): call get_installer again.
Revoked PC: device_status shows \`revoked: true\` with \`device.revoked_at\` and \`device.revoke_reason\` (replaced_by_repair,
user_revoked or uninstalled). A revoked PC never records again: call get_installer right away and pair it again; do not
retry start_recording or wait for it to come online.
Uninstall: %LOCALAPPDATA%\\AgentRecorder\\uninstall.ps1.

## Several PCs
- Pairing another PC keeps the PCs already paired. ${billing ? `The Free plan allows up to ${LIMITS.maxDevices} paired devices at once.` : `An account may have up to ${LIMITS.maxDevices} paired devices at once (owner accounts: any number).`}
- At the limit, pairing a new PC is refused and nothing changes. get_installer says so up front (\`device_limit\`).
  Call list_devices, ask the user which PC to remove, call remove_device {device}, then run the command again.
- Running get_installer's command again on a PC that is already paired re-pairs that PC; it does not take another slot.
- One computer can be paired with several Recitbot accounts (for example two people sharing a PC, or the user's work
  and personal accounts). If Recitbot is already installed there for another account, that is normal: call
  get_installer and run its command as usual. It adds this account to that computer; nothing is reinstalled or wiped,
  and the other accounts keep working. Each account sees and records on only its own pairing, under its own ${billing ? "plan" : "limits"}, and
  it takes one of this account's device slots.
- list_devices returns \`paired_devices\`: id, name, platform ("windows", "macos", or null = unknown: never assume
  Windows), paired_at, last_seen_at, online, and this_device (the PC your call comes from, when that is clear).
- remove_device {device} unpairs one PC at once: its recorder disconnects and a recording in progress there fails. The
  other PCs stay paired. Removing the PC you are calling from works too (\`removed_this_device: true\`).
- "Uninstall Recitbot", "remove the recorder", "delete Recitbot from my computer": call uninstall_recorder. It
  removes this account from the PC. If no other account uses Recitbot there, the recorder removes itself completely
  (app, startup item, its data) with no visible windows; otherwise it stays installed for the other accounts
  (\`accounts_remaining\`). Tell the user each device's \`message\`. Pass \`full_removal: true\` only when the user
  explicitly asks to remove Recitbot from the computer for everyone. Called with no arguments and several devices
  paired, it returns \`needs_choice: true\` and the devices: ask the user which one, or offer all.
- Before the user removes Recitbot from Grok Bot, you MUST call uninstall_recorder {all:true} (or {device_id} for one
  PC) and tell the user the result. Offline PCs come back as \`pending_on_device: true\`: they'll finish next time
  they connect.
- start_recording, list_devices, device_status and update_recorder use the most recently connected online PC unless
  you pass \`device\` (an id from paired_devices, or the PC's name). When the user names a PC ("on my laptop"), pass it.

## Recording
- start_recording, then get_video with wait_seconds (up to 25, repeat) until status is ready; it returns the video's
  \`url\` and \`display\`.
- Defaults when you omit an option: the primary monitor; max_seconds = the account's limit (${LIMITS.maxSeconds} s, 5 minutes,
  ${billing ? "on the Free plan; " : "or "}${LIMITS.paidMaxSeconds} s, ${hours(LIMITS.paidMaxSeconds)} hours, ${billing ? "on Pro" : "on owner accounts"}; omit it for "until I stop"); mic ON (the Windows default mic; a PC without a mic still records); system
  audio ON (the sound playing on the PC); webcam bubble as set on the PC (off unless turned on there), in the shape
  and size last chosen there (round by default); the share link opens in the user's browser on the PC when the video
  is ready (open_link).
- "no mic" = mic:false. "just my voice"/"no computer sound" = system_audio:false. "mute"/"no audio"/"silent" = both
  false. "with my face"/"cam" = webcam:true.
- The user names a monitor, mic or camera ("2nd monitor", "HyperX mic"): call list_devices first and pass ids. The user
  names an app or window ("my chrome", "the youtube window"): pass their words as start_recording's \`window\`
  ("chrome youtube"). Do not call list_devices(refresh:true) before a start: start_recording uses the PC's window list
  from the last minute and asks the PC itself only when the window is not in it. Ask the user only when two entries
  really match.
- The user sees a small pill (REC timer, mic and PC sound toggles, Stop) that is not in the video. They can stop it
  there; you can call stop_recording. Without recording_id it stops the one recording in progress: NO_ACTIVE_RECORDING
  = nothing is recording; MULTIPLE_ACTIVE_RECORDINGS (several devices recording) lists them in \`active\`: ask the user
  which one and call again with its recording_id.
- ${NAME_VIDEO_RULE}
- When the user names or describes a recording, call update_video.
- update_video sets \`title\` (one line, up to 120 characters; "" resets it to the default) and \`description\` (up to
  280, line breaks kept; "" clears it).
- get_transcript returns the transcript once ready. list_videos, search_videos and get_video_stats show views.
- search_videos matches title, description and transcript: title matches first, then description, then
  transcript-only (\`matched_in\` says which).

## Showing videos
- ${VIDEO_LINK_RULE}
- Every video in a tool result (get_video, update_video, list_videos, search_videos, get_video_stats, list_comments,
  share, start_recording, stop_recording) carries \`title\`, \`url\` and a ready-made \`display\` field, \`[title](url)\`: show \`display\`.
- get_video, update_video, list_videos, search_videos, share and revoke_share also return \`owner_url\`. ${OWNER_URL_RULE}

## Comments
- Viewers of a shared video can comment. list_comments {video_id, since?} returns them newest first (owner only; works
  while the service is read-only), each with its \`id\`, plus the video's \`display\` link and a \`display\` link per comment.
- ${COMMENTS_RULE}

## Learning a skill from a recording
- ${LEARN_SKILL_RULE}
- It returns the title, description, duration_s, created_at and the full transcript (segments with start/end seconds).
  It works for the user's own recordings and for any video shared publicly (by url); another account's private video
  or a revoked link is NOT_FOUND, a shared video with a passcode is PASSCODE_PROTECTED.
- keyframes: up to max_keyframes (default 6) still frames of the screen spread over the video, in time order, each
  {n, t_ms, at} in the result and also sent to you as a JPEG image, labelled with its time. Recordings from older
  recorders (or without a picture) have none: keyframes is empty and keyframes_note says so.
- include_video:true is only for the user's own recording on ${billing ? "Pro or Owner" : "an owner account"}: it adds video.url, a link to the MP4
  that works for ${LIMITS.videoFileUrlSeconds / 60} minutes (with size_bytes and mime_type). Ask for it only when you can watch video,
  and never post it anywhere. On ${billing ? "Free, video is {error: UPGRADE_REQUIRED, message}" : "other accounts, video is {error: OWNER_ONLY, message}"}; for someone else's video it is
  {error: VIDEO_FILE_NOT_SHARED, message}; the transcript and keyframes still come. ${billing ? "Free has no video download (the" : "Other accounts have no video download (the"}
  video plays on its page): never promise ${billing ? "a Free user" : "their user"} the file or a file link, tell them the message.
- Nothing is prepared when a recording is made: the tool only reads the recording when you call it.

## Sharing needs the user's approval
- Every video has one link, \`/<username>/v/<slug>\` (\`url\`; share_url is the same link, kept for older clients).
  Recordings are private by default (\`visibility: "private"\`): only the user (with owner_url, or signed in on the
  website) can open the link. Give the user its \`display\` link; when they want to open, edit or moderate it themselves, give them owner_url
  (owner rights on that one video in the browser that opens it), and only them. revoke_share also retires every
  owner_url handed out before.
- share_recording makes the link viewable by anyone who has it (\`visibility: "public"\`); sharing again keeps the same
  link. It can also set a passcode viewers must enter.
- revoke_share turns sharing off: the video is private again and gets a new link, so the old one stops working for
  everyone. Call share_recording again to share the new link.
- set_username sets the \`<username>\` part of the path (and optionally the display name shown on video pages). Shared
  videos opened at the old username redirect to the new one.
- Never call share_recording, send a link to anyone other than the user, or post it anywhere, until the user approves.
- delete removes a video, its transcript and its link.

${billing ? PLAN_SECTION : LIMITS_SECTION}
## Branding (${billing ? "Pro" : "owner accounts"})
- set_branding brands the user's video pages: brand_name, accent_color, background_color, logo, favicon,
  social_image (the preview picture when a link is shared). Send only what changes; clear removes settings.
  get_branding shows what is set. ${billing ? "Free gets UPGRADE_REQUIRED" : "Other accounts get OWNER_ONLY"}: tell the user the message.
- Ask the user for their brand name, two hex colours (accent for buttons and links, page background) and the
  images. Pass an image the user sent in chat as base64 ({data, content_type}), or an https link to it ({url}).
- Images are PNG, JPG or WebP (favicon: PNG), never SVG or GIF. Logo up to 512 KB, 32-2048 px a side; favicon up to
  100 KB, square, 16-512 px; social image up to 1 MB, at least 600 px wide, about 1.91:1 (1200×630).
- Colours need contrast: the accent at least 3:1 against the background, and the background must keep dark or white
  text readable. A refused colour comes back with the measured ratio and a suggestion: offer it to the user.
- The brand name is plain text, up to 60 characters, with no links or web addresses. A refused call changes nothing;
  tell the user its message. Up to 20 set_branding calls per day.

## Custom domain (${billing ? "Pro" : "owner accounts"})
- The user's videos can live on their own domain: one subdomain of a domain they own per account. Ask which domain they
  own and what subdomain they want for videos (any label: videos., vids., watch., ...). Bare domains (example.com) don't
  work: suggest videos.<their domain>.
- Call set_custom_domain {hostname}. Show the user the CNAME record exactly as \`instructions\` starts (e.g.
  \`videos CNAME <target>\`, the target this server uses) and the hint for their DNS provider. No TXT record is needed.
- Then call get_custom_domain_status about once a minute while the user waits, and tell them its \`message\`. After
  about 10 minutes, tell them it can take up to a few hours and Recitbot keeps checking by itself. \`phase\` live =
  done (\`live_url\`).
- Changing it: set_custom_domain with the new name. The old domain's links redirect to the new one for 30 days.
- Removing it: remove_custom_domain. A domain that went live redirects to the server's own video links for 30 days, then stops.
${billing ? "- UPGRADE_REQUIRED: custom domains are part of Recitbot Pro ($10/mo or $100/yr); tell the user the message." : "- OWNER_ONLY: custom domains are for this server's owner accounts; tell the user the message."}
  CUSTOM_DOMAINS_OFF: not available yet. Other errors (APEX_NOT_SUPPORTED, PLATFORM_DOMAIN, HOSTNAME_TAKEN,
  RATE_LIMITED, ...): tell the user the message and ask for a different name or try later.

## Staying up to date
- Call get_latest now and then. When playbook.version differs from the version in your Recitbot skill or notes,
  rewrite the skill with playbook.text.
- Recorders update themselves: when one that can connects on an older version, Recitbot sends it the new version and
  it installs it in the background (never while recording: it waits until the recording has uploaded). You do not
  need to do anything.
- Call update_recorder only to force an update now or to check one (auto_update in the result is the last automatic
  update). update_sent: the PC downloads, checks and installs the new
  version in the background (no window, it restarts by itself); call update_recorder again after a minute to see
  up_to_date. reinstall_required or unknown_version: the recorder is too old to update itself; run get_installer's
  command again (or give the user download_url). offline: the PC is off or asleep; try later. PLATFORM_UNKNOWN: ask
  the user "Windows or Mac?" and run get_installer's command for that platform on that computer.
`;

/** The MCP initialize instructions: the short form of the playbook. */
const buildInstructions = (billing: boolean) =>
  "Recitbot (Agent Recorder) records the user's Windows screen on request. Sign-in happens through the app's OAuth " +
  "connector (no API key needed). Flow: ask the user \"Windows or Mac?\" unless you know (never guess) -> " +
  "get_installer with platform \"windows\" or \"macos\" -> run its `command` on " +
  "the user's computer yourself (or give the user its download_url) -> device_status until online -> start_recording -> " +
  "get_video(wait_seconds) for the video's link. device_status revoked:true = that PC is unpaired for good: call " +
  "get_installer at once and pair it again; never retry recording on it. Recordings are private by default (only the signed-in user can open " +
  "the link); share_recording makes the link viewable by anyone who has it, revoke_share turns that off (the video " +
  "gets a new private link), and set_username sets the /<username>/v/<slug> path. Never share or send a link to " +
  "anyone but the user until they approve. " +
  OWNER_URL_RULE +
  " " +
  VIDEO_LINK_RULE +
  " " +
  NAME_VIDEO_RULE +
  " " +
  COMMENTS_RULE +
  " " +
  LEARN_SKILL_RULE +
  " When the user names or describes a recording, call update_video. When the user names a monitor, mic or camera " +
  "('2nd mon', 'HyperX mic'), call list_devices first and " +
  "pass ids to start_recording. When the user names an app or window ('rec my chrome', 'the youtube window'), pass " +
  "their words as start_recording's window (never call list_devices(refresh:true) before a start: start_recording " +
  "checks the PC's windows itself); ask the user when several windows match. Several paired PCs: commands go to the most recently connected online one unless you pass `device`; " +
  "list_devices lists the paired devices and remove_device removes one. search_videos matches title, description and transcript. View stats: list_videos (newest first) and " +
  "search_videos include views/unique_views per video; " +
  "get_video_stats adds a per-day breakdown. " +
  (billing ? FREE_PLAN : PLAIN_LIMITS) +
  ` Custom video domain (${billing ? "Pro" : "owner accounts"}, a subdomain like videos.example.com): set_custom_domain, show its CNAME record ` +
  "exactly, then get_custom_domain_status about once a minute until live; remove_custom_domain stops it." +
  " get_latest returns the full playbook (rewrite your Recitbot skill when " +
  "its version changes); recorders update themselves when they connect, update_recorder forces an update now.";

export const PLAYBOOK_TEXT = buildPlaybook(true);
export const MCP_INSTRUCTIONS = buildInstructions(true);

/** What this deployment's bots get (get_latest, initialize), built once per config. */
const built = new WeakMap<SelfHostConfig, { playbook: { version: string; text: string }; instructions: string }>();
function forConfig(c: SelfHostConfig) {
  let b = built.get(c);
  if (!b) {
    b = c.billing.enabled
      ? { playbook: { version: PLAYBOOK_VERSION, text: PLAYBOOK_TEXT }, instructions: MCP_INSTRUCTIONS }
      : { playbook: { version: PLAIN_PLAYBOOK_VERSION, text: buildPlaybook(false) }, instructions: buildInstructions(false) };
    built.set(c, b);
  }
  return b;
}
export const playbook = (c: SelfHostConfig): { version: string; text: string } => forConfig(c).playbook;
export const mcpInstructions = (c: SelfHostConfig): string => forConfig(c).instructions;
