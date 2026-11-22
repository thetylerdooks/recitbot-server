# Signed Windows release (served by the Worker)

A signed recorder release is built and signed in the recorder repo (`node build/build-windows.mjs`, then
`node build/sign-release.mjs --platform windows ...`, its RELEASING.md), never here. Copy these files from its `dist/`
into this folder, unchanged:

- `install.ps1`, `recorder.zip`, `uninstall.ps1`
- `hashes.json` (the build's own record of what it made)
- `update-windows.json` (the manifest and signature, both public; never a key file)

The build refuses a placeholder-key dev build (`--allow-placeholder-keys`): a `release_keys` field in `hashes.json` (any
value; a release build has none), a `hashes.txt` with a `RELEASE_KEYS=` line, or the placeholder keys compiled into
`recorder.zip`. It also refuses a `hashes.json` that does not list this `install.ps1`, `recorder.zip` and version, and a
manifest signed by one of the recorder repo's TEST fixture keys.

`npm run build` then serves `install.ps1` byte for byte (it is not rendered from `../install.template.ps1`), and fails
unless its SHA-256 and size are the signed manifest's, it pins this `recorder.zip`, and it installs the manifest's
version. The manifest and signature go into `worker/src/generated.ts` (`UPDATE_MANIFEST_WINDOWS`,
`UPDATE_MANIFEST_SIG_WINDOWS`) and are relayed in the update command (PROTOCOL.md 5.1 in the recorder repo).

With nothing here but this README, Windows is built as before signed updates (`../AgentRecorder.cs` compiled, install.ps1
rendered): 0.6.1 and older recorders still update by hash, and recorders that announce `signed_update` get no update.
