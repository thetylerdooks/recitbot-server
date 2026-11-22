# Recorder length and size ceilings (0.6.1, for Pro "no time limit")

The recorder no longer stops a recording at its own 30 min / 1.5 GiB. Version stays 0.6.1.

| | Before | Now |
| --- | --- | --- |
| Length clamp (`Recorder.MaxSeconds` / `RecordingLength.maxSeconds`) | 1800 s | 14400 s (4 h) |
| Video `-fs` cap, chunked (`upload_part_bytes` set, `max_seconds` > 120 s Windows / > 300 s Mac) | 1.5 GiB | 8 GiB |
| Video cap, one PUT (no part size, or short) | 82 MB Windows / 250 MiB Mac | unchanged |

Both caps leave room for the AAC track (17 500 B/s × `max_seconds`).

**The server still governs.** The recorder clamps the start command's `max_seconds` to 1..14400, so a lower value
always wins: Free's 300 s still records 300 s. The 4 h figure is only the recorder's own ceiling.

**What the Worker has to accept.** A single recording's chunked upload can now total up to 8 GiB of video (256 parts
at 32 MiB), plus its audio. The upload route (create / parts / complete) and the per-recording size check must accept
totals above 1.5 GiB, up to 8 GiB, for the plans that get long recordings. Until the Worker raises
`ownerMaxSeconds` / `ownerMaxVideoBytes` (worker/src/env.ts, 1800 s / 1.5 GiB today) nothing changes in practice: the
server sends at most 1800 and refuses bigger uploads.

**Audio.** The Windows mic WAV runs for `max_seconds + 30` (ffmpeg `-t`), so it scales with the recording. The Mac mic
has no process and stops with the recording. A 4 h stereo system-audio WAV (about 2.8 GB) still fits the WAV header's
32-bit size fields.

**Disk space.** Neither recorder checks free disk space before a recording; none was added. A 4 h recording can need
up to about 8 GiB of video plus the audio WAVs on the local disk until the upload finishes.
