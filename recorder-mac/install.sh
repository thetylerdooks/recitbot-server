#!/bin/bash
# Recitbot recorder installer for macOS (per-user, no admin, no prompts). Twin of install.ps1. Served by the server; its
# SHA-256 is pinned in the command get_installer returns and in signed recorder update commands. The app zip below is
# verified by pinned SHA-256.
# One install serves several Recitbot accounts. With --code on a Mac whose Recitbot.app is this version or newer, it
# only pairs that account with the installed app (nothing is stopped, replaced or wiped; the running recorder picks the
# new account up). Otherwise (no app, an older one, or --update) it stops the recorder, swaps
# ~/Applications/Recitbot.app in place (the data folder and its paired accounts stay), pairs --code's account (added
# next to the others, or refreshed), re-registers the LaunchAgent and restarts it. A failed pairing leaves the
# recorder running with the accounts it already had.
# Prints one line: `RECITBOT_INSTALL_OK device=<id> version=<v> autostart=<logon|none>`, or
# `RECITBOT_INSTALL_FAILED: <reason>` with exit code 2 (arguments, or --update without an install), 3 (download or hash
# check), 4 (pairing), 5 (the recorder did not start) or 6 (--update rolled back).
# --update keeps the app it replaces as ~/Applications/.Recitbot.app.rollback until the new recorder writes
# update-health.txt naming the new version (after its first hello, within AGENT_RECORDER_HEALTH_SECONDS, default 90). If
# it does not (or a start fails after the swap), the previous app goes back (renames only: same bundle id and signature,
# so the privacy grants stay), update-rollback.txt records the attempted version and the previous recorder starts again;
# it reports "rolled_back" on its next connect. The swap leaves the data folder alone, except that config.dat is copied to
# config.dat.rollback first and put back by a rollback: the new recorder may rewrite it in a format the previous one
# cannot read (0.6.2 moves the secrets to the Keychain, config_version=3).
#
# Arguments (PowerShell-style names accepted too): --server URL (-Server), --code CODE (-Code), --update (-Update),
# --data DIR (-InstallDir), --no-autostart (-NoAutostart), --account ID (-Account: the account the code is for, so a
# re-pair sends that account's own device token). The pairing code can also come in RECITBOT_PAIRING_CODE, which
# keeps it out of this script's argv; the account in RECITBOT_ACCOUNT_ID. Environment as install.ps1: AGENT_RECORDER_INSTALL_DIR (data folder),
# AGENT_RECORDER_NO_AUTOSTART=1. bash 3.2 (macOS /bin/bash) compatible.
set -eu
umask 077

RecorderZipSha256='6A47339B32CF7072CA0DEBEE72574111C3E03ACFD9779CB341226FEB1D5149B5'
RecorderVersion='0.6.2'

LABEL='com.recitbot.agent'

# The recorder's self-update (SelfUpdater) starts this script from $TMPDIR/recitbot-update-<id>.sh with --update, in its
# own process group, stdio on /dev/null. Stopping the agent (launchctl bootout) must not take this script with it: run
# the rest from a detached copy of this process in a new session (perl's setsid; nohup when there is no perl) and let
# the agent's child return at once. A --update run from a shell stays in the foreground and prints its result line.
self_name=$(basename -- "$0")
is_update=0
for a in "$@"; do
  case "$a" in -Update|--update|-update) is_update=1 ;; esac
done
self_copy=0
case "$self_name" in recitbot-update-*.sh) [ "$is_update" = 1 ] && self_copy=1 ;; esac
# No `trap ''` here: ignored signals are inherited, and the copy must be able to start an agent that SIGTERM stops.
if [ "$self_copy" = 1 ] && [ "${RECITBOT_INSTALL_DETACHED:-}" != 1 ]; then
  RECITBOT_INSTALL_DETACHED=1
  export RECITBOT_INSTALL_DETACHED
  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' /bin/bash "$0" "$@" </dev/null >/dev/null 2>&1 &
  else
    nohup /bin/bash "$0" "$@" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi

Server=''
Code="${RECITBOT_PAIRING_CODE:-}"
unset RECITBOT_PAIRING_CODE
Account="${RECITBOT_ACCOUNT_ID:-}"
Update=0
InstallDir="${AGENT_RECORDER_INSTALL_DIR:-$HOME/Library/Application Support/Recitbot}"
NoAutostart=0
[ "${AGENT_RECORDER_NO_AUTOSTART:-}" = 1 ] && NoAutostart=1
bad_arg=''

while [ $# -gt 0 ]; do
  case "$1" in
    -Server|--server|-server) [ $# -ge 2 ] || { bad_arg="Missing value for $1."; break; }; Server=$2; shift 2 ;;
    -Code|--code|-code) [ $# -ge 2 ] || { bad_arg="Missing value for $1."; break; }; Code=$2; shift 2 ;;
    -InstallDir|--data|--install-dir|-installdir) [ $# -ge 2 ] || { bad_arg="Missing value for $1."; break; }; InstallDir=$2; shift 2 ;;
    -Account|--account|-account) [ $# -ge 2 ] || { bad_arg="Missing value for $1."; break; }; Account=$2; shift 2 ;;
    -Update|--update|-update) Update=1; shift ;;
    -NoAutostart|--no-autostart|-noautostart) NoAutostart=1; shift ;;
    # ffmpeg does not exist on macOS: accepted so a Windows-style command line does not fail.
    -UseSystemTools|--use-system-tools) shift ;;
    *) bad_arg="Unknown argument: $1"; break ;;
  esac
done

exitCode=2
tmp=''
swapped=0
exe=''
config=''
had_accounts=0
add_only=0
installed=''
device=''
apps="$HOME/Applications"
app="$apps/Recitbot.app"
backup="$apps/.Recitbot.app.rollback"
backed_up=0
HealthSeconds=90
case "${AGENT_RECORDER_HEALTH_SECONDS:-}" in
  ''|*[!0-9]*) ;;
  *) if [ ${#AGENT_RECORDER_HEALTH_SECONDS} -le 3 ] && [ "$AGENT_RECORDER_HEALTH_SECONDS" -ge 5 ]; then HealthSeconds=$AGENT_RECORDER_HEALTH_SECONDS; fi ;;
esac
exe="$app/Contents/MacOS/Recitbot"
plist="$HOME/Library/LaunchAgents/$LABEL.plist"
domain="gui/$(id -u)"

cleanup() {
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  rm -rf "$apps/.Recitbot.app.new.$$" 2>/dev/null || true
  # The recorder's self-update runs this script from a copy in $TMPDIR.
  if [ "$self_copy" = 1 ]; then rm -f -- "$0"; fi
}
trap cleanup EXIT

# The recorder running from this install (by its pid file, and by path).
recorder_pids() {
  local p c
  if [ -f "$InstallDir/agent.pid" ]; then
    p=$(tr -cd '0-9' <"$InstallDir/agent.pid" 2>/dev/null || true)
    if [ -n "$p" ]; then
      c=$(ps -p "$p" -o comm= 2>/dev/null || true)
      case "$c" in */Recitbot|Recitbot) echo "$p" ;; esac
    fi
  fi
  ps -axo pid=,args= 2>/dev/null | while read -r p c; do
    case "$c" in "$exe"|"$exe "*) echo "$p" ;; esac
  done
  return 0
}

recorder_running() {
  [ -n "$(recorder_pids)" ]
}

# launchctl bootout stops the LaunchAgent first (a loaded job could be started again by launchd); then any other copy from this install
# (a --no-autostart start, a fallback start) is stopped: SIGTERM, SIGKILL after 10 s (Stop-Process -Force + WaitForExit).
stop_recorder() {
  local i pids
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  pids=$(recorder_pids | sort -u)
  [ -n "$pids" ] || return 0
  kill -TERM $pids 2>/dev/null || true
  i=0
  while [ $i -lt 40 ]; do
    recorder_running || return 0
    sleep 0.25
    i=$((i + 1))
  done
  pids=$(recorder_pids | sort -u)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null || true
  sleep 0.5
  return 0
}

# The recorder writes agent.pid once it holds its single-instance lock and has read its pairing.
wait_recorder() {
  local i p c
  i=0
  while [ $i -lt 40 ]; do
    sleep 0.25
    if [ -f "$InstallDir/agent.pid" ]; then
      p=$(tr -cd '0-9' <"$InstallDir/agent.pid" 2>/dev/null || true)
      if [ -n "$p" ]; then
        c=$(ps -p "$p" -o comm= 2>/dev/null || true)
        case "$c" in */Recitbot|Recitbot) return 0 ;; esac
      fi
    fi
    i=$((i + 1))
  done
  return 1
}

# Outside this script's process tree and session, so it outlives the shell (and sandbox) that ran this script. HUP and
# TERM back to their defaults first: this script ignores them while it swaps the app, and a child would inherit that.
start_direct() {
  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e '$SIG{HUP} = $SIG{TERM} = "DEFAULT"; POSIX::setsid(); exec @ARGV or exit 127' \
      "$exe" --data "$InstallDir" </dev/null >/dev/null 2>&1 &
  else
    (trap - HUP TERM; exec nohup "$exe" --data "$InstallDir" </dev/null >/dev/null 2>&1) &
  fi
}

# Starts the recorder detached: through the LaunchAgent when there is one, else (or when launchd did not start it)
# directly in a new session. --no-autostart (dev, e2e) starts it directly only. Returns 1 when it is not running after.
start_recorder() {
  local i
  rm -f "$InstallDir/agent.pid"
  if [ "$NoAutostart" = 0 ] && [ -f "$plist" ]; then
    # bootout is asynchronous: bootstrap can fail ("5: Input/output error") while the old job is still going away.
    i=0
    while [ $i -lt 10 ]; do
      if launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then break; fi
      sleep 0.5
      i=$((i + 1))
    done
    [ $i -lt 10 ] || launchctl load -w "$plist" >/dev/null 2>&1 || true
    launchctl kickstart "$domain/$LABEL" >/dev/null 2>&1 || true
    if wait_recorder; then return 0; fi
    # launchd did not start it: take the job out so it does not race the direct start (it loads again at next login).
    launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  fi
  start_direct
  wait_recorder
}

# --- update health: check.sh sources this block (up to the end marker) on its own, so keep it free of anything but
# function definitions. parity: AgentRecorder.cs UpdateHealth, install.ps1's block of the same name
# marker_version FILE: the x.y.z of its first version= line; nothing when there is none.
marker_version() {
  local v
  [ -f "$1" ] || return 0
  v=$(sed -n 's/^version=//p' "$1" 2>/dev/null | head -n 1 | tr -d '\r' | tr -d ' \t')
  if printf '%s\n' "$v" | grep -Eq '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then printf '%s\n' "$v"; fi
  return 0
}

# update_health MARKER_VERSION VERSION RUNNING(1|0) ELAPSED WINDOW (whole seconds): healthy when the marker names the
# new version; rollback once the window is over or the new recorder is gone; else wait.
update_health() {
  if [ -n "$2" ] && [ "$1" = "$2" ]; then echo healthy; return 0; fi
  if [ "$3" != 1 ] || [ "$4" -ge "$5" ]; then echo rollback; return 0; fi
  echo wait
}

# write_rollback DIR VERSION: the attempted version, for the restored recorder's "rolled_back" report.
write_rollback() {
  printf 'version=%s\n' "$2" >"$1/update-rollback.txt"
}
# --- end update health

# After an --update swap: polls update-health.txt until update_health decides.
wait_update_health() {
  local start now running h
  start=$(date +%s)
  while :; do
    now=$(date +%s)
    running=0
    if recorder_running; then running=1; fi
    h=$(update_health "$(marker_version "$InstallDir/update-health.txt")" "$RecorderVersion" "$running" $((now - start)) "$HealthSeconds")
    if [ "$h" != wait ]; then echo "$h"; return 0; fi
    sleep 0.5
  done
}

# --update after the swap: the new app is stopped and set aside, the previous one renamed back, the attempted version
# recorded, and the previous recorder started again. 1 when the previous app could not be put back.
rollback() {
  local failed="$apps/.Recitbot.app.failed.$$"
  stop_recorder
  rm -rf "$failed"
  if [ -e "$app" ]; then mv "$app" "$failed" || return 1; fi
  if ! mv "$backup" "$app"; then
    [ -e "$failed" ] && mv "$failed" "$app"
    return 1
  fi
  if [ -f "$config.rollback" ]; then mv -f "$config.rollback" "$config"; fi
  backed_up=0
  rm -rf "$failed"
  write_rollback "$InstallDir" "$RecorderVersion" 2>/dev/null || true
  start_recorder >/dev/null 2>&1 || true
  return 0
}

fail() {
  local reason=$1
  if [ "$backed_up" = 1 ] && [ "$swapped" = 1 ] && [ "$exitCode" != 4 ]; then
    # --update after the swap (start or health): back to the previous version, which reports "rolled_back" for
    # $RecorderVersion on its next connect. A failed pairing keeps the new app (the update worked).
    if rollback; then reason="$reason Rolled back to the previous version."; else reason="$reason Rollback failed."; fi
    exitCode=6
  # A failed update, or a failed pairing on a Mac that already had paired accounts, must not leave the Mac without its
  # recorder: start whatever is installed if it is not running.
  elif { [ "$Update" = 1 ] || [ "$had_accounts" = 1 ]; } && [ "$swapped" = 1 ] && [ -x "$exe" ] && ! recorder_running; then
    start_recorder >/dev/null 2>&1 || true
  fi
  # Not rolled back (e.g. a failed pairing): the backup is not needed. A failed rollback keeps it.
  if [ "$backed_up" = 1 ] && [ "$exitCode" != 6 ]; then rm -rf "$backup" "$config.rollback"; fi
  echo "RECITBOT_INSTALL_FAILED: $reason"
  exit "$exitCode"
}

# Asks macOS for Screen Recording once, right after a new pairing, so Recitbot is already listed (switch off) in System
# Settings > Privacy & Security > Screen & System Audio Recording before the first recording. Started through
# LaunchServices (open) so the request is Recitbot's own (a binary started from a shell counts as the terminal's);
# -g: never brought to the front. The app exits by itself after ~1 s without taking the agent's lock. Never fatal, and
# not on --update, --no-autostart or RECITBOT_NO_SCREEN_REQUEST=1 (a background update must not show a prompt).
request_screen() {
  command -v open >/dev/null 2>&1 || return 0
  open -n -g -a "$app" --args --request-screen --data "$InstallDir" >/dev/null 2>&1 || return 0
}

# The installed app's version (CFBundleShortVersionString), empty when there is no app or it cannot be read.
installed_version() {
  [ -x "$exe" ] || return 0
  plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist" 2>/dev/null || true
}

# version_ge A B: A >= B for x.y.z versions (numeric per part); false when A is not x.y.z.
version_ge() {
  local a1 a2 a3 b1 b2 b3 rest
  case "$1" in *[!0-9.]*|'') return 1 ;; esac
  IFS=. read -r a1 a2 a3 rest <<EOF
$1
EOF
  IFS=. read -r b1 b2 b3 rest <<EOF
$2
EOF
  [ -n "$a1" ] && [ -n "$a2" ] && [ -n "$a3" ] || return 1
  [ "$a1" -ne "$b1" ] && { [ "$a1" -gt "$b1" ]; return; }
  [ "$a2" -ne "$b2" ] && { [ "$a2" -gt "$b2" ]; return; }
  [ "$a3" -ge "$b3" ]
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# --- arguments (exit 2) ---
[ -z "$bad_arg" ] || fail "$bad_arg"
[ -n "$Server" ] || fail 'Missing -Server.'
case "$Server" in
  *[!]A-Za-z0-9.:/_~%[-]*) fail 'Invalid URI: The format of the URI could not be determined.' ;;
esac
scheme=$(printf '%s' "${Server%%://*}" | tr 'A-Z' 'a-z')
case "$Server" in *://*) ;; *) fail 'Invalid URI: The format of the URI could not be determined.' ;; esac
rest=${Server#*://}
hostport=${rest%%/*}
case "$hostport" in
  \[*\]*) host=${hostport%%]*}]; ;;
  *) host=${hostport%%:*} ;;
esac
host=$(printf '%s' "$host" | tr 'A-Z' 'a-z')
[ -n "$host" ] || fail 'Invalid URI: The format of the URI could not be determined.'
loopback=0
case "$host" in localhost|127.*|'[::1]') loopback=1 ;; esac
if [ "$scheme" != https ] && ! { [ "$scheme" = http ] && [ "$loopback" = 1 ]; }; then fail 'Server must be https.'; fi
while :; do case "$Server" in */) Server=${Server%/} ;; *) break ;; esac; done
case "$InstallDir" in /*) ;; *) InstallDir="$(pwd)/$InstallDir" ;; esac
while :; do case "$InstallDir" in */) InstallDir=${InstallDir%/} ;; *) break ;; esac; done
config="$InstallDir/config.dat"
if [ -n "$Code" ]; then
  case "$Code" in *[!A-Za-z0-9]*) fail 'Invalid pairing code.' ;; esac
  if [ ${#Code} -lt 10 ] || [ ${#Code} -gt 40 ]; then fail 'Invalid pairing code.'; fi
elif [ "$Update" = 0 ]; then
  fail 'Missing pairing code. Call get_installer for a new command.'
elif [ ! -f "$config" ]; then
  fail "No paired recorder in $InstallDir to update. Call get_installer for a new command."
fi
case "$Account" in *[!A-Za-z0-9]*) fail 'Invalid account.' ;; esac
[ ${#Account} -le 64 ] || fail 'Invalid account.'

# --- this Mac (exit 5: the recorder cannot run here). Recitbot.app needs macOS 14 (LSMinimumSystemVersion). ---
exitCode=5
[ "$(uname -s)" = Darwin ] || fail 'This installer is for macOS.'
osmajor=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
case "$osmajor" in ''|*[!0-9]*) osmajor=0 ;; esac
[ "$osmajor" -ge 14 ] || fail 'macOS 14 or later is required.'

[ -f "$config" ] && had_accounts=1
# A pairing code and this version (or newer) already installed: only the account is added (nothing downloaded,
# stopped or replaced).
installed=$(installed_version)
if [ -n "$Code" ] && [ "$Update" = 0 ] && version_ge "$installed" "$RecorderVersion"; then add_only=1; fi

if [ "$add_only" = 0 ]; then
# --- download and verify (exit 3) ---
exitCode=3
mkdir -p "$InstallDir" || fail "Cannot create $InstallDir."
chmod 700 "$InstallDir" 2>/dev/null || true
tmp=$(mktemp -d "${TMPDIR:-/tmp}/recitbot-install.XXXXXXXX") || fail 'Cannot create a temporary folder.'
zip="$tmp/recorder.zip"
zipUrl="$Server/Recitbot-mac-$RecorderVersion.zip"
proto='=https'
[ "$scheme" = http ] && proto='=http,https'
curl -fsSL --proto "$proto" --connect-timeout 30 --max-time 900 --retry 2 -o "$zip" "$zipUrl" >/dev/null 2>&1 \
  || fail "Download failed: $zipUrl"
actual=$(shasum -a 256 "$zip" | cut -c1-64 | tr 'a-f' 'A-F')
want=$(printf '%s' "$RecorderZipSha256" | tr 'a-f' 'A-F')
if [ "$actual" != "$want" ]; then
  rm -f "$zip"
  fail "SHA-256 mismatch for $zipUrl - aborting install."
fi
mkdir "$tmp/x"
ditto -x -k "$zip" "$tmp/x" >/dev/null 2>&1 || fail 'The recorder archive could not be extracted.'
[ -x "$tmp/x/Recitbot.app/Contents/MacOS/Recitbot" ] || fail 'Recitbot.app not found in archive.'

# Staged next to the app (same volume) so the swap below is two renames.
mkdir -p "$apps" || fail "Cannot create $apps."
new="$apps/.Recitbot.app.new.$$"
old="$apps/.Recitbot.app.old.$$"
rm -rf "$new" "$old"
ditto "$tmp/x/Recitbot.app" "$new" >/dev/null 2>&1 || fail "Cannot write to $apps."
# Our own verified download only: no Gatekeeper prompt for the bundle this script just checked.
xattr -dr com.apple.quarantine "$new" >/dev/null 2>&1 || true

# Everything is downloaded and verified: only now stop the running recorder (an update leaves it running until here).
# From here on the agent's bootout (and a closing terminal) must not stop this script.
trap '' HUP TERM
stop_recorder
swapped=1
if [ -e "$app" ]; then mv "$app" "$old" || fail "Cannot replace $app."; fi
if ! mv "$new" "$app"; then
  [ -e "$old" ] && mv "$old" "$app"
  fail "Cannot replace $app."
fi
if [ "$Update" = 1 ] && [ -e "$old" ]; then
  # --update: the previous app is kept until the new recorder reports healthy (wait_update_health).
  rm -rf "$backup" "$config.rollback"
  if mv "$old" "$backup"; then backed_up=1; fi
  if [ "$backed_up" = 1 ] && [ -f "$config" ]; then cp -p "$config" "$config.rollback" || fail "Cannot back up $config."; fi
fi
rm -rf "$old"
if [ -f "$tmp/x/uninstall.sh" ]; then
  cp "$tmp/x/uninstall.sh" "$InstallDir/uninstall.sh" && chmod 700 "$InstallDir/uninstall.sh" || true
fi
installed=$RecorderVersion
fi

if [ -n "$Code" ]; then
  # Enroll: the pairing code goes over stdin (printf is a shell builtin), never on a command line. The account is added
  # next to the ones already paired (or its entry refreshed); the recorder prints the paired device id.
  exitCode=4
  rc=0
  enrolled=$(printf '%s\n' "$Code" | "$exe" --enroll --server "$Server" --data "$InstallDir" ${Account:+--account "$Account"} 2>/dev/null) || rc=$?
  Code=''
  if [ "$rc" != 0 ]; then
    fail "Pairing failed (exit $rc). See $InstallDir/agent.log."
  fi
  device=$(printf '%s\n' "$enrolled" | sed -n 's/^device=//p' | head -n 1)
  if [ "$Update" = 0 ] && [ "$NoAutostart" = 0 ] && [ "${RECITBOT_NO_SCREEN_REQUEST:-}" != 1 ]; then request_screen; fi
fi

autostart=none
if [ "$add_only" = 1 ] && recorder_running; then
  # The running recorder connects the new account by itself (it watches config.dat).
  if [ "$NoAutostart" = 0 ] && [ -f "$plist" ]; then autostart=logon; fi
  echo "RECITBOT_INSTALL_OK device=$device version=$installed autostart=$autostart"
  exit 0
fi

exitCode=5
if [ "$NoAutostart" = 0 ]; then
  # LaunchAgent: starts at login (RunAtLoad), restarted only after a crash (KeepAlive Crashed: a crash signal such as
  # SIGSEGV/SIGILL/SIGBUS, at most every ThrottleInterval 30 s). Any exit, clean or not (2 already running, 3 not paired),
  # is left alone, like the Windows logon task. AbandonProcessGroup: the installer the agent starts for a self-update is
  # not killed with it (install.sh bootstraps and kickstarts the new agent itself, nothing waits for a restart).
  if mkdir -p "$HOME/Library/LaunchAgents" && {
    printf '%s\n' \
      '<?xml version="1.0" encoding="UTF-8"?>' \
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
      '<plist version="1.0">' \
      '<dict>' \
      '  <key>Label</key>' \
      "  <string>$LABEL</string>" \
      '  <key>ProgramArguments</key>' \
      '  <array>' \
      "    <string>$(xml_escape "$exe")</string>" \
      '    <string>--data</string>' \
      "    <string>$(xml_escape "$InstallDir")</string>" \
      '  </array>' \
      '  <key>RunAtLoad</key>' \
      '  <true/>' \
      '  <key>KeepAlive</key>' \
      '  <dict>' \
      '    <key>Crashed</key>' \
      '    <true/>' \
      '  </dict>' \
      '  <key>ThrottleInterval</key>' \
      '  <integer>30</integer>' \
      '  <key>ProcessType</key>' \
      '  <string>Interactive</string>' \
      '  <key>LimitLoadToSessionType</key>' \
      '  <string>Aqua</string>' \
      '  <key>AbandonProcessGroup</key>' \
      '  <true/>' \
      '  <key>StandardOutPath</key>' \
      "  <string>$(xml_escape "$InstallDir/agent.out.log")</string>" \
      '  <key>StandardErrorPath</key>' \
      "  <string>$(xml_escape "$InstallDir/agent.out.log")</string>" \
      '</dict>' \
      '</plist>' >"$plist.tmp.$$" && mv "$plist.tmp.$$" "$plist"
  } 2>/dev/null && { ! command -v plutil >/dev/null 2>&1 || plutil -lint "$plist" >/dev/null 2>&1; }; then
    chmod 644 "$plist" 2>/dev/null || true
    autostart=logon
  else
    # No LaunchAgent: the recorder still runs now, it just won't start by itself at login.
    rm -f "$plist" "$plist.tmp.$$"
  fi
fi
if [ "$backed_up" = 1 ]; then rm -f "$InstallDir/update-health.txt"; fi
start_recorder || fail "The recorder did not start. See $InstallDir/agent.log."
if [ "$backed_up" = 1 ]; then
  [ "$(wait_update_health)" = healthy ] || fail "The new recorder ($RecorderVersion) did not connect within $HealthSeconds s."
  rm -rf "$backup" "$config.rollback"
  backed_up=0
fi
# --update without a code: the first paired account's device (a v1 file: device_id).
[ -n "$device" ] || device=$(sed -n -e 's/^account\.0\.device_id=//p' -e 's/^device_id=//p' "$config" 2>/dev/null | head -n 1 | tr -d '\r')
echo "RECITBOT_INSTALL_OK device=$device version=$installed autostart=$autostart"
exit 0
