# Running on the Workers Free plan

The server is meant to work on Cloudflare's Workers **Free** plan; Workers Paid is optional. Set the var `WORKERS_PLAN` to
`"free"` (the template does). Unset or `"paid"`, every setting below keeps its standard value.

About the numbers: the limits marked ¹ were given with this audit's task; those marked ² are from general knowledge. Neither set
was checked against Cloudflare's documentation when this was written (no web access in that session), so check
<https://developers.cloudflare.com/workers/platform/limits/> (and the D1, Durable Objects, R2 and Workers AI limits pages) before
relying on one. CPU figures are estimates: Node.js on a desktop PC, not Cloudflare's own measurement. Nothing here was run on a
Free account yet.

## What `WORKERS_PLAN=free` changes

| Setting (`worker/src/config.ts`, `workers`) | Standard | Free | Why |
|---|---|---|---|
| `cleanupBatch` | 500 multipart aborts, 100 brand images, 150 size checks, 20 + 20 + 20 custom domains per hourly run | 3 of each | Each row costs its own R2, D1 or API call |
| `cleanupRecordings` | 500 expired recordings per run | 50 | One set-based batch; the rest waits an hour |
| `passcodeIterations` | 100,000 PBKDF2 rounds | 10,000 | 100,000 rounds alone are 12-16 ms of CPU |
| `searchScan` | newest 200 videos | newest 50 | Parses a transcript per video |
| `readyBeforeTranscript` | transcribe first (up to 10 s), then ready | ready first, then transcribe | Running out of CPU while transcribing must not lose the video; the cleanup then marks a transcript that never came `unavailable` |

A passcode keeps the rounds it was made with (they are part of its stored salt), so switching plans breaks none. 10,000 rounds are
weaker against someone who has stolen the database; online guessing stays limited to 5 tries per 15 minutes either way.

Changed for every plan, with the same results: the rest of an upload body is piped natively instead of chunk by chunk in JavaScript;
audio and keyframes are base64-encoded natively (5 minutes of audio: 419 ms before, 2 ms now); `list_videos` and `search_videos` look
up all links in one query instead of four or five per video (20 videos took about 90).

## Audit

| Item | What the code does | Free limit | Status | Fix |
|---|---|---|---|---|
| Durable Objects | Two classes, `DeviceHub` and `Governor`, both in migration `v1` `new_sqlite_classes`; no key-value-backed class anywhere. Device sockets hibernate and pings are auto-answered | SQLite-backed classes only² | OK | none |
| DO requests | One Governor call per MCP call, page view, upload part; DeviceHub per device command | 100,000 requests/day² | OK | none |
| CPU: watch page | 4-hour transcript: about 1 ms; 5 minutes: well under. HMACs are native | 10 ms per request¹ | OK | none |
| CPU: MCP calls | `tools/list` (54 KB) is built once per isolate; serialising takes under 1 ms | 10 ms¹ | OK | none |
| CPU: `search_videos` | Parses up to 200 transcripts: about 2 ms for 5-minute videos, far more for 4-hour ones | 10 ms¹ | toggle | `searchScan` 50 |
| CPU: video passcode | PBKDF2-SHA-256, 100,000 rounds: 12-16 ms | 10 ms¹ | toggle | `passcodeIterations` 10,000 (about 1.5 ms) |
| CPU: upload body | Was a JavaScript read/write loop over the whole part | 10 ms¹ | fixed | Native `pipeTo` after the first bytes are checked |
| CPU: video length check at `/complete` | A few small ranged R2 reads and one read of the MP4 index (a few hundred KB for 5 minutes, MBs for hours) | 10 ms¹ | OK for short videos; not measured for hours-long ones | none |
| CPU: transcription | Per 5 minutes of audio: silence check about 6-10 ms, base64 2 ms, handing 12.8 MB to Workers AI about 9 ms | 10 ms¹ | can't be guaranteed on Free | `readyBeforeTranscript`: the video is safe and the transcript may be missing. Expect it for roughly the first 2 minutes of audio; longer ones depend on Cloudflare's tolerance. Off: remove the `ai` binding or set `SERVICE_MODE=NO_TRANSCRIBE` |
| CPU: keyframes to the bot | Base64 of up to 12 JPEGs (was about 30 ms per MB) | 10 ms¹ | fixed | Native base64 |
| CPU: startup | One bundle with no work at load but building the tool list | 1 s² | OK | none |
| Subrequests: `list_videos`, `search_videos` | Were 4-5 D1 queries per video | 50 per invocation¹ | fixed | One query for all (under 15 in all, whatever the count) |
| Subrequests: watch page | Under 30 D1, R2 and DO calls | 50¹ | OK | none |
| Subrequests: uploads | Per part: a few D1 queries, one DO call, one R2 call, whatever the size | 50¹ | OK | none |
| Subrequests: transcription | Two per 5-minute window (R2 read, AI run) | 50¹ | OK to about 100 minutes of audio; past that the transcript is `unavailable` | none (CPU ends it first) |
| Subrequests: hourly cleanup | Was up to 1,000 (multipart aborts) + 600 (size checks) + custom domains | 50¹ | toggle | `cleanupBatch` 3, `cleanupRecordings` 50: under 50 without custom domains. With custom domains a run that has work in every step could pass 50; each step catches its own failure and the next hour goes on |
| Subrequests: Stripe, custom domains | 2-4 calls per tool call | 50¹ | OK | none |
| Subrequests: brand images | One fetch and its redirects | 50¹ | OK | none |
| Sign-in and claim | At most 1 siteverify, a few DO calls and D1 queries | 50¹ | OK | none |
| Cron triggers | One (`0 * * * *`) | 5 per account¹ | OK | none |
| Queues | Not used | Paid only¹ | OK | none |
| Workers AI | Whisper large v3 turbo. Past the allowance the call fails: the video is saved, its transcript `unavailable` | 10,000 neurons/day¹ (very roughly 200 minutes of audio²) | OK | Set `GLOBAL_MAX_TRANSCRIBE_MIN_PER_DAY` to 180 or so, so the server stops first |
| Request body | One PUT is at most 80 MiB; larger files go in parts of 32 MiB (16-50 allowed) | 100 MB¹ | OK | none |
| Script size | Dry-run build: 1,472 KiB, **357 KiB gzip** | 3 MB compressed¹ (10 MB on Paid) | OK | none |
| Static assets | 25 files, 1.4 MB, the largest 0.9 MB (the Mac recorder) | 20,000 files, 25 MiB each² | OK | none |
| Requests | Every request, assets too, runs the Worker (`run_worker_first`: the host gate must see it first) | 100,000/day² | OK | none: a watch page is about 8 requests, so about 12,000 page loads a day |
| D1 | Indexed queries; at most 100 bound parameters a statement | 500 MB per database, 5 million rows read and 100,000 written a day² | OK | none. Transcripts are the bulk of the data |
| KV | Not used | | OK | none |
| R2 | Private bucket; videos and audio waiting for transcription | 10 GB stored, 1 million writes, 10 million reads a month² | OK | Owner videos are kept until deleted: 10 GB is the real limit |
| Email Sending | Sign-in codes to any address | Needs Workers Paid² | can't on Free | Not needed: the owner claims the server with `POST /claim` (SELFHOST_CONFIG.md) |
| Custom video domains | Cloudflare for SaaS on your own zone | Separate from the Workers plan² | optional, off | none |
| Logs | Invocation logs off; one line per request | 200,000 events a day, 3 days kept² | OK | none |
| Memory | Audio is read in 5-minute windows (9.6 MB) | 128 MB² | OK | none |

## Uploads on Free

Nothing to set. The recorder sends anything over one part in 32 MiB pieces, each a request of its own, and the Worker checks the
first 12 bytes and pipes the rest to R2, so the CPU cost doesn't grow with the size. A request body must stay under 100 MB: don't
raise `LIMITS.singleUploadMaxBytes` (80 MiB) or `maxPartBytes` (50 MiB). Every part but the last must be the same size, at least
16 MiB (the server's rule, above R2's 5 MiB), so smaller parts are not an option.

## What can't run on Free

- **Email sign-in** (Email Sending): not needed, the owner uses the key from the owner claim.
- **Guaranteed transcripts** of more than a couple of minutes: best effort, the video itself is never held back.
- **Very long transcripts** (over about 100 minutes): too many calls in one invocation.
