# macOS recorder (served by the Worker)

The Mac app is built and signed on a Mac (`./build-app.sh && installer/package.sh` in the Mac recorder repo), not here.
Copy its `dist/Recitbot-mac-<version>.zip` into this folder (exactly one zip). `npm run build` then:

- hashes the zip bytes and renders `install.sh` from `install.template.sh` (`__RECORDER_ZIP_SHA256__`, `__RECORDER_VERSION__`);
- copies the zip, `install.sh` and `uninstall.sh` into `worker/public/`;
- writes `INSTALL_SH_SHA256`, `RECORDER_MAC_ZIP_SHA256` and `RECORDER_MAC_VERSION` into `worker/src/generated.ts`.

A signed release (the Mac repo's `dist/install.sh` and `dist/hashes.txt`, and the `update-macos.json` that
`build/sign-release.mjs --platform macos` wrote for it, RELEASING.md there) goes here too. Then `install.sh` is served byte for byte instead of being
rendered, the build fails unless its SHA-256 and size are the signed manifest's (and it pins this zip and its version),
and the manifest and signature go into `UPDATE_MANIFEST_MACOS` / `UPDATE_MANIFEST_SIG_MACOS` for the update command.
Without `update-macos.json`, Macs that announce `signed_update` get no update from this server.

Signed or not, the build refuses a placeholder-key dev build (`RECITBOT_ALLOW_PLACEHOLDER_KEYS=1`): a `RELEASE_KEYS=` line
in `hashes.txt` (any value; a release build has none), or the placeholder keys compiled into the zip's app. A
`hashes.txt` here must list this zip and version (and, for a signed release, this `install.sh`). A manifest signed by
one of the recorder repo's TEST fixture keys is refused.

Without the zip those constants are empty and get_installer `platform: "macos"` answers `MAC_INSTALLER_UNAVAILABLE`.
`install.template.sh` and `uninstall.sh` must stay LF (`.gitattributes`); keep them in sync with the Mac repo's
`installer/`.
