#!/bin/bash
# Recitbot recorder uninstaller for macOS: stops the agent, removes the per-user LaunchAgent, the app and the data folder,
# and resets Recitbot's privacy permissions (Screen Recording, Microphone, Camera rows) so System Settings lists nothing.
# Twin of uninstall.ps1. Usage: uninstall.sh [--data DIR] (or -InstallDir DIR; default AGENT_RECORDER_INSTALL_DIR, else
# ~/Library/Application Support/Recitbot).
set -eu

LABEL='com.recitbot.agent'
InstallDir="${AGENT_RECORDER_INSTALL_DIR:-$HOME/Library/Application Support/Recitbot}"
while [ $# -gt 0 ]; do
  case "$1" in
    -InstallDir|--data|--install-dir|-installdir)
      [ $# -ge 2 ] || { echo "Missing value for $1." >&2; exit 2; }
      InstallDir=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
app="$HOME/Applications/Recitbot.app"
plist="$HOME/Library/LaunchAgents/$LABEL.plist"

# launchctl first: a loaded job could be started again by launchd.
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
pidFile="$InstallDir/agent.pid"
if [ -f "$pidFile" ]; then
  p=$(tr -cd '0-9' <"$pidFile" 2>/dev/null || true)
  if [ -n "$p" ]; then
    case "$(ps -p "$p" -o comm= 2>/dev/null || true)" in
      */Recitbot|Recitbot)
        kill -KILL "$p" 2>/dev/null || true
        i=0
        while [ $i -lt 20 ] && kill -0 "$p" 2>/dev/null; do sleep 0.25; i=$((i + 1)); done
        ;;
    esac
  fi
fi
rm -f "$plist"
if [ -e "$app" ]; then rm -rf "$app"; fi
if [ -e "$InstallDir" ]; then rm -rf "$InstallDir"; fi
if command -v tccutil >/dev/null 2>&1; then tccutil reset All "$LABEL" >/dev/null 2>&1 || true; fi
echo 'Agent Recorder removed. This does not unpair the device on your account.'
