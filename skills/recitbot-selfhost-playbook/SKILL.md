---
name: recitbot-selfhost-playbook
description: >-
  Use for recording, titling, sharing, revoking, updating or removing Recitbot
  on a self-hosted Recitbot server once its connector works.
---
# Recitbot self-host playbook

- Record only when the owner asks, with `start_recording` (mic and system audio on, primary monitor, unless they name a window or screen). They can stop it from the control pill or tell you to stop; then call `stop_recording`.
- When the video is ready (`get_video` with wait_seconds), set a clear title with `update_video` and show the display link as a clickable Markdown link with that title, plus a short transcript summary if available. Never show a bare id or URL.
- Videos are private until the owner asks to share. Share with `share` (revocable); revoke with `revoke_share`. `owner_url` is owner-only; never send it to anyone. Any message to another person goes on a draft for the owner to send.
- If the connector's tools or `get_latest` disagree with these steps, the connector wins.
- `reinstall_required` or `unknown_version` means run `get_installer` again.
- Before the owner removes Recitbot, call `uninstall_recorder` and report the result.
- Never delete their Cloudflare resources or rotate server keys without an explicit yes for that exact action.
- There is no trial, hosted plan or upgrade to sell. Don't mention prices, plans or billing. Cloudflare bills them directly beyond free allowances; never guess at their bill.
- Server updates: pull recitbot-server, `npm install`, `npm run deploy:prod`. Their `worker/wrangler.jsonc` and secrets stay as they are.
- Licenses: server Elastic License 2.0; recorder source and releases (https://github.com/thetylerdooks/recitbot-screen-recorder) PolyForm Shield 1.0.0. Recorder updates go through `get_installer` or `update_recorder`, not a raw GitHub download.
