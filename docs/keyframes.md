# Recording keyframes (recorder contract, 0.6.1)

Status: implemented. A server without the route answers 404 and the recorder quietly skips the stills.

Recorders that send keyframes announce `"keyframes"` in the `features` of their `hello` frame (next to
`"update_defer_rollback"`, `"self_update"` and the rest). Version stays 0.6.1.

## What the recorder does

After a recording is finalized **and its MP4 upload has succeeded** (`POST /upload/<id>/complete` answered 2xx), the
recorder takes up to 6 stills from the final, muxed MP4 (the file it just uploaded) and PUTs them one at a time.

- **Times:** the centres of 6 equal buckets of the video's length `D` (from the MP4 itself, else the recording's own
  length): `t_i = floor(D_ms * (2i - 1) / 12)` for `i = 1..6`. For a 60 s video: 5, 15, 25, 35, 45, 55 s. Never 0 (often
  a blank first frame) and never the exact end (a seek there returns no frame); the first and last are half a bucket in.
- **Skipped entirely** (no stills, no requests) when the MP4 has no video stream (audio only) or is shorter than 2 s.
- **Images:** baseline JPEG, quality 75 (System.Drawing on Windows, ImageIO 0.75 on the Mac), at most 1280 px wide
  (scaled down keeping the aspect ratio; never scaled up), at most 1 MiB each (a larger one is not sent).
- A frame that can't be grabbed or encoded is left out; the other frames keep their own `n` and `t`. So `n` may have
  gaps (e.g. 1, 3, 5, 6).
- Best effort: a keyframe problem is logged on the device and **never fails or changes the recording**. Statuses,
  the ready frame and the share link are unaffected.

## Request

One request per still, in order `n = 1..6`:

```
PUT <server>/upload/<recording_id>/keyframes/<n>?t=<ms>
Authorization: Bearer <upload_token>
Content-Type: image/jpeg
Content-Length: <bytes>

<JPEG bytes>
```

| Part | Meaning |
| --- | --- |
| `<server>` | The account's server, as for the MP4 upload. |
| `<recording_id>` | The recording id (`[A-Za-z0-9]{20,30}`), as in `/upload/<id>/video`. |
| `<n>` | The still's slot, integer `1..6`. A PUT for a slot that already has a still replaces it. |
| `t` | Milliseconds from the start of the uploaded MP4, integer, `0 < t < duration`. |
| `Authorization` | The same per-recording upload token the MP4 upload used (from the `start` command's `upload_token`). |
| `Content-Type` | Always `image/jpeg`. |
| Body | One JPEG (starts `FF D8 FF`), at most 1280 px wide, at most 1 MiB. Not chunked; `Content-Length` is always set. |

**Max frames:** 6 per recording (`n` above 6 can be refused).

The PUTs come right after `complete`, so the recording is usually `transcribing` (or already `ready`) by then. The keyframes route accepts
`uploading`, `transcribing` and `ready`. The upload token is still valid then (it
lives `max_seconds` plus the upload grace from the start).

Why this shape: it sits beside the existing `/upload/<id>/…` routes, so it reuses `verifyUploadToken` (no new device
auth) and the same id regex in `index.ts`; and one small PUT per frame keeps the Worker side free of multipart parsing
and lets it check the JPEG magic on a stream like `checkedStream` does for MP4/WAV.

## Responses

| Status | Recorder does |
| --- | --- |
| `200` / `201` / `204` | Stored; sends the next still. Body ignored (`{"ok":true}` suggested). |
| `404` | No such route on this server. Stops; the rest are skipped without an error. |
| `501` | Route present but keyframes switched off. Same as 404. |
| `401` | Upload token bad or expired. Logged, the rest skipped. |
| `409` | Recording in a state that takes no keyframes (failed / deleted). Logged, the rest skipped. |
| `413` | Too large / too many. Logged, the rest skipped. |
| `415` | Not a JPEG. Logged, the rest skipped. |
| `5xx`, no response | Logged, the rest skipped. No retries (30 s timeout per request). |

The recorder stops at the first still that is not stored. It never retries a keyframe, never re-sends a recording,
and never reports keyframe failures to the server; the device log line is `keyframes: …`
(`keyframes: 6 of 6 sent`, `keyframes: not supported by this server (404); skipped`,
`keyframes: 2 of 6 sent; stopped at 3 (HTTP 500)`, `keyframes: skipped (audio only)`).

## Worker side

The route, its checks and its answers are in [reference.md](reference.md) (Keyframes). Old recorders (no `"keyframes"` in hello)
never send these; nothing on the server waits for them.

See also `docs/auto-update.md` (the other 0.6.1 recorder contract: deferred and rolled-back updates).
