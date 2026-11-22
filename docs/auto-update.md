# Recorder self-update 0.6.1: deferred updates and rollback (recorder contract)

Recorders from 0.6.1 (Windows and Mac) announce `"update_defer_rollback"` in the `features` of their `hello` frame, next
to `"self_update"` (which they still announce). The signed `update` command does not change: same fields, same
signature, same `url` (`/i/v1.update.…` link), `version`, `sha256`. What changes is what the recorder answers and when.

## Report frames

All on the socket the `update` command came in on (or, for `rolled_back`, on each account's socket after a reconnect):

```json
{"type":"update","status":"installing","version":"0.6.2"}
{"type":"update","status":"failed","version":"0.6.2","error":"<text>"}
{"type":"update","status":"deferred","version":"0.6.2"}
{"type":"update","status":"rolled_back","version":"0.6.2"}
```

`error` is optional, at most 200 characters of `[A-Za-z0-9_ .:,()'/-]` (unchanged). `version` is always x.y.z. Today
`device-hub.ts` `UpdateReport` accepts only `installing` and `failed`: it has to accept `deferred` and `rolled_back` as
well, or those frames are dropped.

### `deferred` (new)

Sent at once when a valid, newer `update` arrives while a recording is running. Nothing is downloaded or started. The
recorder holds one update: the newest version it was sent (the same version sent again replaces the held one, so a
resend gets a fresher link). When an older version arrives while a newer one is held, the frame names the held
(newer) version.

Right after that recording finishes (its upload is done or failed, not merely stopped), the recorder runs the held
update and then sends the usual `installing` or `failed`. If a new recording starts first, the update stays held for
that one too.

**Server:** treat `deferred` as "will apply when idle", not as a failure. Do not resend while you only have `deferred`
and the device stays connected; expect `installing` / `failed` after the current recording.

### `failed` after a deferral: expired link

At run time the recorder checks the held update's expiry: the expiry inside the `/i/v1.<purpose>.<account>.<expires>.…`
link (`installerUrl`, 600 s today), or the command's signed `exp` when the link has none. From 15 s before that
moment it does not download; it sends

```json
{"type":"update","status":"failed","version":"0.6.2","error":"update link expired while deferred (send the update again)"}
```

**Server:** on `failed` (this one or any other: download failed, sha256 mismatch, …) retry with backoff, for example on
the device's next `hello`, with a fresh link and command. A recording longer than the link lifetime always ends in
this `failed`, so the retry is the normal path, not an exception.

### `rolled_back` (new)

`install.ps1 -Update` / `install.sh --update` keep the previous version, install the new one and start it, then wait
up to 90 s for the new recorder to connect and send its `hello` (it writes a health marker after that). If that never
happens (it crashed, could not connect, or would not start), the installer puts the previous version back, starts it
and records the attempted version. The restored recorder sends, on each paired account's next connect, after its
`hello`:

```json
{"type":"update","status":"rolled_back","version":"<attempted version>"}
```

**Server:** the device is back on the version in its `hello` (the previous one), still announcing `self_update` and
`update_defer_rollback`. Mark the attempted version as failed for that device; do not resend the same version in a
tight loop (it will likely fail the same way). Resending after a longer backoff or a fixed build is fine.

Pairings (config.dat, every account) and macOS privacy grants are kept on both the success and the rollback path.

## When each is sent

| Situation | Frame(s) |
| --- | --- |
| Not recording, update newer, link ok | `installing` (installer started), or `failed` |
| Recording, update newer, link ok | `deferred` now; after the upload `installing` or `failed` |
| Recording, link not allowed (host, path, …) | `failed` `update link rejected` at once (not held) |
| Held update's link expired by upload time | `failed` `update link expired while deferred (send the update again)` |
| New version installed but never said `hello` within ~90 s | (nothing from the new version), then `rolled_back` from the restored one |
| Version not newer than the recorder | no frame (unchanged) |

## The first rollout (0.6.0 → 0.6.1)

The rollback runs in the installer, which is the new version's (0.6.1's) `install.ps1` / `install.sh`, so it already
protects the 0.6.0 → 0.6.1 update. But a rollback restores 0.6.0, which does not know `rolled_back`. In that one case the
server sees `installing`, then the device reconnecting with `hello` version `0.6.0` and without
`update_defer_rollback`: treat that as a rolled-back (failed) update. Likewise 0.6.0 recorders still answer an update
during a recording with `failed` `recording in progress` (resend later, as today).

## Installer exit codes

Unchanged, plus `6`: `-Update` / `--update` rolled back (`RECITBOT_INSTALL_FAILED: … Rolled back to the previous
version.`). The self-update runs the installer detached, so nothing reads this line; it is for manual runs and tests.
