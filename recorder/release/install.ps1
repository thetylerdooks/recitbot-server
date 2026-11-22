# Recitbot installer (per-user, no admin, no prompts). Served by the server; its SHA-256 is pinned in the command
# get_installer returns and in signed recorder update commands. Every download below is verified by pinned SHA-256.
# One install serves several Recitbot accounts. With -Code on a PC whose recorder is this version or newer, it only pairs
# that account with the installed recorder (nothing is stopped, replaced or wiped; the running recorder picks the new
# account up). Otherwise (no install, an older one, or -Update) it stops the recorder, swaps the files in place (config.dat
# and its paired accounts stay), pairs -Code's account (added next to the others, or refreshed), re-registers autostart
# and restarts it. A failed pairing leaves the recorder running with the accounts it already had. -Account names the
# account the code is for, so a re-pair sends that account's own device token. The Recitbot logon task is only
# registered when it does not exist or already starts this install's exe: a task of another copy is never re-pointed or
# removed.
# Before 0.6.2 the recorder was AgentRecorder.exe in %LOCALAPPDATA%\AgentRecorder with logon task AgentRecorder. Any
# install into that folder (a 0.6.1 self-update passes it) or into the default folder while the old one still holds
# AgentRecorder.exe and config.dat is a migration to %LOCALAPPDATA%\Recitbot, finished or not, whatever the new folder
# holds: the old recorder is stopped and its task (when it starts the old exe) disabled, the data is copied (never over
# a config.dat the new folder already has), the new recorder starts from there, and only once it is healthy
# (update-health.txt, as below) is the old task unregistered and the old install deleted (known files only, secrets
# first; what is left is recorded in legacy-cleanup.txt and the next install tries again). A failure removes what this
# run put in the new folder, enables the old task again and starts the old recorder. A custom -InstallDir keeps its
# folder; only AgentRecorder.exe(.config) and its task give way to the new names.
# install-options.txt next to the exe records autostart (logon|none) and -DeviceName for the recorder's self-update,
# which passes -NoAutostart / -DeviceName back.
# Prints one line: `RECITBOT_INSTALL_OK device=<id> version=<v> autostart=<logon|none>`, or
# `RECITBOT_INSTALL_FAILED: <reason>` with exit code 2 (arguments, or -Update without an install), 3 (download or hash
# check), 4 (pairing), 5 (the recorder did not start) or 6 (-Update rolled back).
# -Update keeps the files it replaces in update-backup\ until the new recorder writes update-health.txt naming the new
# version (after its first hello, within AGENT_RECORDER_HEALTH_SECONDS, default 90). If it does not (or a start fails
# after the swap), the previous files go back, update-rollback.txt records the attempted version and the previous
# recorder starts again; it reports "rolled_back" on its next connect. config.dat is never part of the backup or the swap.
# -DeviceName (or AGENT_RECORDER_DEVICE_NAME) pairs under that name instead of the computer name. Test and throwaway
# installs must pass -InstallDir, -NoAutostart and -DeviceName so they never share a name with the real PC: the server's
# token-less re-pair replaces an active device with the same name and public IP.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Code,
  [switch]$Update,
  [string]$InstallDir = $(if ($env:AGENT_RECORDER_INSTALL_DIR) { $env:AGENT_RECORDER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Recitbot' }),
  [switch]$UseSystemTools = $($env:AGENT_RECORDER_USE_SYSTEM_TOOLS -eq '1'),
  [switch]$NoAutostart = $($env:AGENT_RECORDER_NO_AUTOSTART -eq '1'),
  [string]$DeviceName = $env:AGENT_RECORDER_DEVICE_NAME,
  [string]$Account = $env:RECITBOT_ACCOUNT_ID
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RecorderZipSha256 = 'FAA609C1CF536AD999BE01CE57F4B82F987AF077D87D09688A30F7CAFF8F738A'
$RecorderVersion = '0.6.2'
$FfmpegUrl = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
$FfmpegSha256 = '60F467265B1E312373DBCD92200C2618A74850F98D3D078E94296BB3FA2047BA'
$FfmpegExeSha256 = '3256173F3F8BFFD7DF12227C68ADF68025EDB1832273A9530688A7BB1ED8EDEC'

function Get-Verified([string]$Url, [string]$Sha256, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutFile).Hash
  if ($actual -ne $Sha256) {
    Remove-Item -LiteralPath $OutFile -Force
    throw "SHA-256 mismatch for $Url - aborting install."
  }
}

# The recorder running from this install (by its pid file, and by path), under its current or its pre-0.6.2 name; during
# a migration also the one of the old folder.
function Get-Recorder {
  $found = @()
  foreach ($d in @($InstallDir, $oldDir)) {
    if (-not $d) { continue }
    $pidFile = Join-Path $d 'agent.pid'
    if (Test-Path -LiteralPath $pidFile) {
      $p = Get-Process -Id ([int](Get-Content -LiteralPath $pidFile)) -ErrorAction SilentlyContinue
      if ($p -and $ProcessNames -contains $p.ProcessName) { $found += $p }
    }
  }
  $found += @(Get-Process -Name $ProcessNames -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -or ($legacyExe -and $_.Path -eq $legacyExe) })
  $found | Sort-Object Id -Unique
}

function Stop-Recorder {
  foreach ($p in @(Get-Recorder)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $p.WaitForExit(10000) | Out-Null
  }
}

# The recorder writes agent.pid once it holds its single-instance lock and has read its pairing.
function Wait-Recorder([string]$Dir) {
  $pidFile = Join-Path $Dir 'agent.pid'
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $pidFile) {
      $p = Get-Process -Id ([int](Get-Content -LiteralPath $pidFile)) -ErrorAction SilentlyContinue
      if ($p -and $ProcessNames -contains $p.ProcessName) { return $true }
    }
  }
  $false
}

# --- autostart: the recorder's selftest loads this block (up to the end marker) and runs it against throwaway task
# names, so keep it free of anything but function definitions.
function Resolve-Exe([string]$p) {
  if ([string]::IsNullOrEmpty($p)) { return $null }
  try {
    $p = [Environment]::ExpandEnvironmentVariables($p).Trim().Trim('"')
    if ($p.Length -eq 0 -or -not [IO.Path]::IsPathRooted($p)) { return $null }
    return [IO.Path]::GetFullPath($p).TrimEnd('\')
  } catch { return $null }
}

# 'none' when there is no task of that name, 'ours' when every action of every such task runs $Exe (full paths,
# case-insensitive), else 'foreign': another copy's task (e.g. the real install's, seen from a throwaway).
function Get-TaskOwner([string]$TaskName, [string]$Exe) {
  $tasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($tasks.Count -eq 0) { return 'none' }
  $self = Resolve-Exe $Exe
  foreach ($t in $tasks) {
    $acts = @($t.Actions)
    if ($acts.Count -eq 0) { return 'foreign' }
    foreach ($a in $acts) {
      $p = Resolve-Exe $a.Execute
      if (-not $p -or -not [string]::Equals($p, $self, [StringComparison]::OrdinalIgnoreCase)) { return 'foreign' }
    }
  }
  'ours'
}

# Registers the logon task for $Exe and returns 'logon', or returns 'none'. -NoAutostart never touches the task. A
# task of that name that starts another exe is never re-pointed, overwritten or removed. A failed register only cleans
# up a task that runs $Exe. The task is visible in Task Scheduler, and its description says what it is and how to
# remove it.
function Set-Autostart([bool]$NoAutostart, [string]$TaskName, [string]$Exe, [string]$Dir) {
  if ($NoAutostart) { return 'none' }
  if ((Get-TaskOwner $TaskName $Exe) -eq 'foreign') { return 'none' }
  try {
    $action = New-ScheduledTaskAction -Execute $Exe -Argument "--data `"$Dir`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    $description = "Starts the Recitbot screen recorder at sign-in (per-user, no admin). Remove with uninstall.ps1 in $Dir."
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force -ErrorAction Stop | Out-Null
    return 'logon'
  } catch {
    # No task (policy, restricted shell): the recorder still runs now, it just won't start by itself at logon.
    if ((Get-TaskOwner $TaskName $Exe) -eq 'ours') { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
    return 'none'
  }
}
# --- end autostart

# --- add account: the recorder's selftest loads this block (up to the end marker) and runs it against copies of its own
# exe in %TEMP%, so keep it free of anything but function definitions.
# The installed recorder's version (x.y.z of its assembly version), $null when there is none or it cannot be read.
function Get-InstalledVersion([string]$Exe) {
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return $null }
  try {
    $v = [Reflection.AssemblyName]::GetAssemblyName($Exe).Version
    return "$($v.Major).$($v.Minor).$($v.Build)"
  } catch { return $null }
}

# A pairing code only adds its account when the installed recorder is this version or newer; -Update always reinstalls.
function Test-AddAccountOnly([string]$Installed, [string]$Version, [bool]$Update) {
  if ($Update -or -not $Installed) { return $false }
  try { return ([version]$Installed) -ge ([version]$Version) } catch { return $false }
}
# --- end add account

# --- update health: the recorder's selftest loads this block (up to the end marker) and runs it against throwaway
# folders in %TEMP%, so keep it free of anything but function definitions. parity: AgentRecorder.cs UpdateHealth
# What recorder.zip installs (build/build-windows.mjs), and the pre-0.6.2 names of the same files: the files an update
# replaces and a rollback restores.
function Get-Payload { @('Recitbot.exe', 'Recitbot.exe.config', 'uninstall.ps1', 'AgentRecorder.exe', 'AgentRecorder.exe.config') }

# The x.y.z of the first version= line of a health marker or rollback record, $null when there is none.
function Get-MarkerVersion([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
  try { $line = @(Get-Content -LiteralPath $Path -ErrorAction Stop | Where-Object { $_ -like 'version=*' } | Select-Object -First 1) } catch { return $null }
  if ($line.Count -eq 0) { return $null }
  $v = ([string]$line[0] -replace '^version=', '').Trim()
  if ($v -match '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$') { return $v }
  $null
}

# 'healthy' when the marker names the new version; 'rollback' once the window is over or the new recorder is gone;
# else 'wait'. parity: AgentRecorder.cs UpdateHealth.Decide
function Get-UpdateHealth([string]$MarkerVersion, [string]$Version, [bool]$Running, [double]$Elapsed, [double]$Window) {
  if ($Version -and $MarkerVersion -eq $Version) { return 'healthy' }
  if (-not $Running -or $Elapsed -ge $Window) { return 'rollback' }
  'wait'
}

# Copies the payload files that exist in $Dir to a fresh $Backup; returns how many. Never config.dat.
function Backup-Install([string]$Dir, [string]$Backup) {
  if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Backup | Out-Null
  $n = 0
  foreach ($f in Get-Payload) {
    $src = Join-Path $Dir $f
    if (Test-Path -LiteralPath $src -PathType Leaf) { Copy-Item -LiteralPath $src -Destination (Join-Path $Backup $f) -Force; $n++ }
  }
  $n
}

# Puts the backed-up payload files back over $Dir and removes the payload files the swap added (Recitbot.exe after a
# rename in a custom folder); returns how many were put back.
function Restore-Install([string]$Dir, [string]$Backup) {
  $n = 0
  foreach ($f in Get-Payload) {
    $src = Join-Path $Backup $f
    if (Test-Path -LiteralPath $src -PathType Leaf) { Copy-Item -LiteralPath $src -Destination (Join-Path $Dir $f) -Force; $n++ }
    else { Remove-Item -LiteralPath (Join-Path $Dir $f) -Force -ErrorAction SilentlyContinue }
  }
  $n
}

# The attempted version, for the restored recorder's "rolled_back" report.
function Write-Rollback([string]$Dir, [string]$Version) {
  [IO.File]::WriteAllText((Join-Path $Dir 'update-rollback.txt'), "version=$Version`r`n")
}
# --- end update health

# --- migration: the recorder's selftest loads this block (up to the end marker) and runs it against throwaway folders and
# tasks under its private scratch root, so keep it free of anything but function definitions. It uses Get-TaskOwner
# (autostart) and Get-Payload (update health).
# A pre-0.6.2 install that was not migrated away (yet): the 0.6.1 payload and a pairing. "AgentRecorder" is a generic
# folder name: a folder without both is not taken for one.
function Test-LegacyInstall([string]$Dir) {
  if (-not $Dir) { return $false }
  (Test-Path -LiteralPath (Join-Path $Dir 'AgentRecorder.exe') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $Dir 'config.dat') -PathType Leaf)
}

# The pre-0.6.2 default folder an install into $Dir (a full path) moves from, else $null: $Dir is the old or the new
# default folder and the old one still holds a legacy install. Whatever the new folder holds (nothing, a copy from an
# interrupted or rolled-back run, or a recorder that already runs from it), that is an unfinished migration: the old
# recorder is stopped and its task handled until the old install is gone. Any other folder stays where it is.
function Get-MigrationSource([string]$Dir, [string]$NewDefault, [string]$OldDefault) {
  $d = $Dir.TrimEnd('\')
  $o = $OldDefault.TrimEnd('\')
  if (-not [string]::Equals($d, $o, [StringComparison]::OrdinalIgnoreCase) -and -not [string]::Equals($d, $NewDefault.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { return $null }
  if (Test-LegacyInstall $o) { return $o }
  $null
}

# A 0.6.2 install already in the new folder (Recitbot.exe and config.dat) while the old one is still there: an earlier
# migration got as far as the new recorder and was cut off before the old install was deleted, and that recorder is the
# one that runs (the old task is disabled). An install over it is an update of it: its payload is backed up and put back
# on failure (Restore-MigratedInstall), the old recorder is never started again, a failed pairing rolls nothing back,
# and the old folder is still deleted once the new recorder is healthy.
function Test-MigratedInstall([string]$Dir) {
  if (-not $Dir) { return $false }
  (Test-Path -LiteralPath (Join-Path $Dir 'Recitbot.exe') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $Dir 'config.dat') -PathType Leaf)
}

# The rollback of a run over a migrated install (Test-MigratedInstall): the backed-up payload goes back over $Dir
# (Restore-Install) and the entries this run copied from the old folder go (never config.dat or a nonce file: Copy-InstallData
# copies neither into a paired folder). Outputs the entries left.
function Restore-MigratedInstall([string]$Dir, [string]$Backup, [string[]]$Copied) {
  Restore-Install $Dir $Backup | Out-Null
  foreach ($n in @($Copied)) {
    if (-not $n -or $n -eq 'config.dat' -or $n -like 'nonce*') { continue }
    $p = Join-Path $Dir $n
    if (-not (Test-Path -LiteralPath $p)) { continue }
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $p) { $n }
  }
}

# Copies the old folder's data into $To and outputs the name of each entry copied (a rollback removes exactly those):
# config.dat (its DPAPI entropy does not depend on the folder), the nonce files, install-options.txt, logs. Not the old
# payload, run-time state (pid, lock, tmp, update backup and health marker) or ffmpeg (copied before the stop).
# config.dat is copied as is: its ffmpeg= line is set after the swap like any install's. When $To already has a
# config.dat, nothing is copied over it or its nonce files (nor any other entry $To has): it is the newer pairing (the
# new recorder ran from it, or it is this same copy from an interrupted run, after which the old recorder never ran),
# and copying would drop accounts paired since and put back older nonces, which reopens replay of accepted commands.
function Copy-InstallData([string]$From, [string]$To) {
  $skip = @('AgentRecorder.exe', 'AgentRecorder.exe.config', 'uninstall.ps1', 'agent.pid', 'config.lock', 'tmp', 'update-backup', 'update-health.txt', 'update-rollback.txt', 'ffmpeg')
  $paired = Test-Path -LiteralPath (Join-Path $To 'config.dat') -PathType Leaf
  foreach ($e in @(Get-ChildItem -LiteralPath $From -Force)) {
    if ($skip -contains $e.Name) { continue }
    $dst = Join-Path $To $e.Name
    if ($paired -and ($e.Name -eq 'config.dat' -or $e.Name -like 'nonce*' -or (Test-Path -LiteralPath $dst))) { continue }
    Copy-Item -LiteralPath $e.FullName -Destination $dst -Recurse -Force
    $e.Name
  }
}

# Disables ($Enabled false) or enables the old logon task, only when it starts $Exe: disabled right after the old
# recorder stops, so an interrupted migration never leaves two tasks that start a recorder with the same pairing;
# enabled again by a rollback; unregistered only once the new recorder is healthy. 'none' when there is no such task or
# it starts another exe, 'failed' when Task Scheduler refused, else 'disabled' / 'enabled'.
function Set-LegacyTask([string]$TaskName, [string]$Exe, [bool]$Enabled) {
  try {
    if ((Get-TaskOwner $TaskName $Exe) -eq 'ours') { if ($Enabled) { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null } else { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null } }
    else { return 'none' }
  } catch { return 'failed' }
  if ($Enabled) { 'enabled' } else { 'disabled' }
}

# A rolled-back migration into a folder this run did not create: removes what this run put there (the entries
# Copy-InstallData copied, the new payload, install-options.txt, the health marker and pid file, an ffmpeg folder this
# run copied), never an entry it did not copy (a config.dat that was there before stays). Outputs the entries left.
function Remove-MigratedCopy([string]$Dir, [string[]]$Copied, [bool]$Ffmpeg) {
  $names = @($Copied) + @(Get-Payload) + @('install-options.txt', 'update-health.txt', 'agent.pid')
  if ($Ffmpeg) { $names += 'ffmpeg' }
  foreach ($n in $names) {
    if (-not $n) { continue }
    $p = Join-Path $Dir $n
    if (-not (Test-Path -LiteralPath $p)) { continue }
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $p) { $n }
  }
}

# The old install's own entries in its folder. Remove-LegacyInstall deletes nothing else.
function Get-LegacyEntries {
  @('config.dat', 'config.dat.tmp', 'nonce*.txt', 'install-options.txt', 'agent.log', 'agent.pid', 'config.lock', 'update-health.txt',
    'update-rollback.txt', 'update-backup', 'tmp', 'ffmpeg', 'AgentRecorder.exe', 'AgentRecorder.exe.config', 'uninstall.ps1')
}

# After a healthy migration: deletes the old install in $Dir, its known entries only, secrets first (config.dat and the
# nonce files, then the rest of its data, then the payload), and the folder itself only when nothing else is in it
# (anything not ours stays). Files can stay locked for a moment after the old recorder exits: $Tries rounds, 500 ms
# apart. Outputs the known entries still there (none: done).
function Remove-LegacyInstall([string]$Dir, [int]$Tries = 20) {
  for ($i = 0; $i -lt $Tries; $i++) {
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return }
    $left = @()
    foreach ($pattern in Get-LegacyEntries) {
      foreach ($e in @(Get-ChildItem -LiteralPath $Dir -Force -Filter $pattern -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $e.FullName -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $e.FullName) { $left += $e.Name }
      }
    }
    if ($left.Count -eq 0) {
      if (@(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue).Count -eq 0) { Remove-Item -LiteralPath $Dir -Force -ErrorAction SilentlyContinue }
      return
    }
    if ($i -lt $Tries - 1) { Start-Sleep -Milliseconds 500 }
  }
  $left
}

# Keeps $Record (legacy-cleanup.txt in the new folder) in step with Remove-LegacyInstall's leftovers in $Dir: written,
# with a line in the new folder's agent.log, while some are left (the next install into the default folder tries again);
# removed once there are none.
function Write-LegacyCleanup([string]$Record, [string]$Dir, [string[]]$Left) {
  $Left = @($Left | Where-Object { $_ })
  if ($Left.Count -eq 0) { Remove-Item -LiteralPath $Record -Force -ErrorAction SilentlyContinue; return }
  $now = [DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText($Record, "dir=$Dir`r`nleft=$($Left -join ',')`r`nat=$now`r`n")
  try {
    [IO.File]::AppendAllText((Join-Path (Split-Path -Parent $Record) 'agent.log'), "$now installer: could not delete $($Left -join ', ') of the pre-0.6.2 install in $Dir; the next install tries again`r`n")
  } catch { }
}
# --- end migration

# Starts the recorder outside the caller's process tree, so it outlives the shell (and sandbox) that ran this script:
# through the logon task when this install registered it, else (or when the task did not start it) through WMI.
# -NoAutostart (dev, e2e, throwaway installs) starts it as a child instead. A rollback passes the previous recorder's
# folder, exe and task (whose task, when it starts that exe, is used).
function Start-Recorder([string]$RunDir = $InstallDir, [string]$RunExe = $exe, [string]$RunTask = $TaskName, [bool]$ViaTask = ($autostart -eq 'logon')) {
  Remove-Item -LiteralPath (Join-Path $RunDir 'agent.pid') -Force -ErrorAction SilentlyContinue
  if ($NoAutostart) {
    Start-Process -FilePath $RunExe -ArgumentList '--data', "`"$RunDir`"" -WindowStyle Hidden
    if (Wait-Recorder $RunDir) { return }
  } else {
    if ($ViaTask -and (Get-TaskOwner $RunTask $RunExe) -eq 'ours') {
      Start-ScheduledTask -TaskName $RunTask -ErrorAction SilentlyContinue
      if (Wait-Recorder $RunDir) { return }
    }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$RunExe`" --data `"$RunDir`"" }
    if ($r.ReturnValue -eq 0 -and (Wait-Recorder $RunDir)) { return }
  }
  throw "The recorder did not start. See $RunDir\agent.log."
}

# After an -Update swap: polls update-health.txt until Get-UpdateHealth decides.
function Wait-UpdateHealth {
  $marker = Join-Path $InstallDir 'update-health.txt'
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $h = Get-UpdateHealth (Get-MarkerVersion $marker) $RecorderVersion ([bool]@(Get-Recorder).Count) $clock.Elapsed.TotalSeconds $HealthSeconds
    if ($h -ne 'wait') { return $h }
    Start-Sleep -Milliseconds 500
  }
}

$TaskName = 'Recitbot'
# The pre-0.6.2 names: an install under them is migrated (see the top), never left half-renamed.
$LegacyName = 'AgentRecorder'
$LegacyTaskName = 'AgentRecorder'
$ProcessNames = @('Recitbot', $LegacyName)
$exitCode = 2
$autostart = 'none'
$exe = $null
$oldDir = $null
$resumed = $false
$legacyExe = $null
$createdDir = $false
$ffCopied = $false
$copied = @()
$legacyTask = 'none'
$healthy = $false
$healthCheck = $false
$tmp = $null
$swapped = $false
$hadAccounts = $false
$addOnly = $false
$device = ''
$installed = $RecorderVersion
$backup = $null
$backedUp = $false
$HealthSeconds = 90
if ([string]$env:AGENT_RECORDER_HEALTH_SECONDS -match '^[0-9]{1,3}$' -and [int]$env:AGENT_RECORDER_HEALTH_SECONDS -ge 5) { $HealthSeconds = [int]$env:AGENT_RECORDER_HEALTH_SECONDS }
try {
  $uri = [Uri]$Server
  if ($uri.Scheme -ne 'https' -and -not $uri.IsLoopback) { throw 'Server must be https.' }
  $Server = $Server.TrimEnd('/')
  $InstallDir = [IO.Path]::GetFullPath($InstallDir)
  $newDefault = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Recitbot'))
  $oldDefault = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA $LegacyName))
  $oldDir = Get-MigrationSource $InstallDir $newDefault $oldDefault
  # Nothing is installed into the old default folder again.
  if ($oldDir -or [string]::Equals($InstallDir.TrimEnd('\'), $oldDefault.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { $InstallDir = $newDefault }
  $exe = Join-Path $InstallDir 'Recitbot.exe'
  $config = Join-Path $InstallDir 'config.dat'
  $options = Join-Path $InstallDir 'install-options.txt'
  # A migration over a 0.6.2 install that already runs from the new folder: handled as an update of that install.
  $resumed = [bool]$oldDir -and (Test-MigratedInstall $InstallDir)
  # The install this one replaces: the old folder during a migration, else this folder (under either exe name).
  $src = if ($oldDir) { $oldDir } else { $InstallDir }
  $legacyExe = Join-Path $src "$LegacyName.exe"
  if (-not $oldDir -and -not (Test-Path -LiteralPath $legacyExe)) { $legacyExe = $null }
  $srcConfig = Join-Path $src 'config.dat'
  # The name recorded by an earlier install (a self-update passes it back; this keeps it when one does not).
  $srcOptions = Join-Path $src 'install-options.txt'
  if (-not $DeviceName -and (Test-Path -LiteralPath $srcOptions)) {
    $DeviceName = (Get-Content -LiteralPath $srcOptions | Where-Object { $_ -like 'device_name=*' } | Select-Object -First 1) -replace '^device_name=', ''
  }
  $DeviceName = ([string]$DeviceName -replace '[\x00-\x1f"]', '').Trim()
  if ($Code) {
    if ($Code -notmatch '^[A-Za-z0-9]{10,40}$') { throw 'Invalid pairing code.' }
  } elseif (-not $Update) {
    throw 'Missing pairing code. Call get_installer for a new command.'
  } elseif (-not (Test-Path -LiteralPath $srcConfig)) {
    throw "No paired recorder in $src to update. Call get_installer for a new command."
  }
  if ($Account -and $Account -notmatch '^[A-Za-z0-9]{1,64}$') { throw 'Invalid account.' }
  $hadAccounts = Test-Path -LiteralPath $srcConfig
  # A pairing code and this version (or newer) already installed: only the account is added (nothing downloaded,
  # stopped or replaced). An exe under the old name is always older.
  $current = Get-InstalledVersion $(if ($oldDir -or -not (Test-Path -LiteralPath $exe)) { $legacyExe } else { $exe })
  $addOnly = $Code -and (Test-AddAccountOnly $current $RecorderVersion ([bool]$Update))
  if ($addOnly) { $installed = $current }

  if (-not $addOnly) {
  $exitCode = 3
  $createdDir = -not (Test-Path -LiteralPath $InstallDir)
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # A migration reuses the old folder's ffmpeg (a copy: the old folder stays whole until the new recorder runs), checked
  # against the pinned hash below like any ffmpeg already in this folder.
  $oldFfmpeg = if ($oldDir) { Join-Path $oldDir 'ffmpeg' } else { $null }
  if ($oldFfmpeg -and (Test-Path -LiteralPath $oldFfmpeg) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'ffmpeg'))) {
    Copy-Item -LiteralPath $oldFfmpeg -Destination $InstallDir -Recurse -Force
    $ffCopied = $true
  }
  $tmp = Join-Path $env:TEMP ('agent-recorder-' + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'recorder.zip'
  Get-Verified "$Server/recorder.zip" $RecorderZipSha256 $zip

  # ffmpeg: the pinned build in <InstallDir>\ffmpeg, reused only when it hashes to the pinned exe; otherwise the pinned zip
  # is downloaded and its ffmpeg.exe verified in $tmp (put in place once the recorder is stopped: the running one holds
  # it open). -UseSystemTools is an explicit opt-in that uses the ffmpeg on PATH as-is, without any verification.
  $ffNew = $null
  if ($UseSystemTools) {
    $sys = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $sys) { throw 'UseSystemTools set but ffmpeg is not on PATH.' }
    $ffmpeg = $sys.Source
  } else {
    $ffmpeg = Join-Path $InstallDir 'ffmpeg\ffmpeg.exe'
    if (-not ((Test-Path -LiteralPath $ffmpeg) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $ffmpeg).Hash -eq $FfmpegExeSha256)) {
      $ffZip = Join-Path $tmp 'ffmpeg.zip'
      Get-Verified $FfmpegUrl $FfmpegSha256 $ffZip
      $ffNew = Join-Path $tmp 'ffmpeg.exe'
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $archive = [IO.Compression.ZipFile]::OpenRead($ffZip)
      try {
        $entry = $archive.Entries | Where-Object { $_.FullName -match '/bin/ffmpeg\.exe$' } | Select-Object -First 1
        if (-not $entry) { throw 'ffmpeg.exe not found in archive.' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $ffNew, $true)
      } finally { $archive.Dispose() }
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ffNew).Hash -ne $FfmpegExeSha256) { throw 'SHA-256 mismatch for ffmpeg.exe - aborting install.' }
    }
  }

  # -Update: the files about to be replaced are kept until the new recorder reports healthy (before anything stops). A
  # migration keeps the whole old folder instead, except over a 0.6.2 install already in the new folder ($resumed),
  # which is backed up like an update (with or without -Update): a rollback puts it back, never the old install.
  if (($Update -and -not $oldDir -and ((Test-Path -LiteralPath $exe) -or $legacyExe)) -or $resumed) {
    $backup = Join-Path $InstallDir 'update-backup'
    $backedUp = (Backup-Install $InstallDir $backup) -gt 0
  }
  # Everything is downloaded and verified: only now stop the running recorder (an update leaves it running until here).
  Stop-Recorder
  $swapped = $true
  if ($oldDir) {
    # The old logon task (when it starts the old exe) is disabled as soon as the old recorder is down: from here on no
    # logon starts both recorders, even if this run is cut off. A rollback enables it again.
    $legacyTask = Set-LegacyTask $LegacyTaskName $legacyExe $false
    $copied = @(Copy-InstallData $oldDir $InstallDir)
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $InstallDir -Force
  if ($ffNew) {
    New-Item -ItemType Directory -Force -Path (Split-Path $ffmpeg) | Out-Null
    Copy-Item -LiteralPath $ffNew -Destination $ffmpeg -Force
  }
  # An earlier install may have configured another ffmpeg (one on PATH, or the old folder's after a migration copied
  # config.dat): the paired accounts move to this one. A code sets it again through --enroll --ffmpeg.
  if (Test-Path -LiteralPath $config) {
    $cfgLines = [IO.File]::ReadAllLines($config)
    $cfgNew = [string[]]@($cfgLines | ForEach-Object { if ($_ -like 'ffmpeg=*') { "ffmpeg=$ffmpeg" } else { $_ } })
    if (($cfgNew -join "`n") -cne ($cfgLines -join "`n")) { [IO.File]::WriteAllLines($config, $cfgNew) }
  }
  }

  if ($Code) {
    # Enroll: the pairing code goes over stdin, never on a command line. The account is added next to the ones already
    # paired (or its entry refreshed); the recorder prints the paired device id. Adding to a running install keeps its
    # ffmpeg.
    $exitCode = 4
    $psi = New-Object Diagnostics.ProcessStartInfo $exe
    $psi.Arguments = "--enroll --server `"$Server`" --data `"$InstallDir`""
    if (-not $addOnly) { $psi.Arguments += " --ffmpeg `"$ffmpeg`"" }
    if ($DeviceName) { $psi.Arguments += " --name `"$($DeviceName -replace '"', '')`"" }
    if ($Account) { $psi.Arguments += " --account $Account" }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.WriteLine($Code)
    $p.StandardInput.Close()
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "Pairing failed (exit $($p.ExitCode)): the code is wrong, used or expired. Call get_installer for a new command. See $InstallDir\agent.log." }
    $device = (@($out -split "`r?`n") | Where-Object { $_ -like 'device=*' } | Select-Object -First 1) -replace '^device=', ''
  }

  if ($addOnly -and @(Get-Recorder).Count) {
    # The running recorder connects the new account by itself (it watches config.dat).
    $recorded = $null
    if (Test-Path -LiteralPath $options) {
      $recorded = (Get-Content -LiteralPath $options | Where-Object { $_ -like 'autostart=*' } | Select-Object -First 1) -replace '^autostart=', ''
    }
    $autostart = if (-not $NoAutostart -and $recorded -eq 'logon') { 'logon' } else { 'none' }
    Write-Output "RECITBOT_INSTALL_OK device=$device version=$installed autostart=$autostart"
    exit 0
  }

  $exitCode = 5
  # A task named Recitbot that starts another copy's exe (the real install, seen from a throwaway) is left alone.
  $autostart = Set-Autostart ([bool]$NoAutostart) $TaskName $exe $InstallDir
  # For the recorder's self-update: whether this install starts at logon, and the name it was paired under.
  try {
    $opts = "autostart=$autostart`r`n"
    if ($DeviceName) { $opts += "device_name=$DeviceName`r`n" }
    [IO.File]::WriteAllText($options, $opts)
  } catch { }
  # An update, and every migration, waits for the new recorder's health marker before the previous files go.
  $healthCheck = $backedUp -or [bool]$oldDir
  if ($healthCheck) { Remove-Item -LiteralPath (Join-Path $InstallDir 'update-health.txt') -Force -ErrorAction SilentlyContinue }
  Start-Recorder
  if ($healthCheck) {
    if ((Wait-UpdateHealth) -ne 'healthy') { throw "The new recorder ($RecorderVersion) did not connect within $HealthSeconds s." }
    if ($backedUp) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue }
  }
  # From here on the new install stays: nothing below rolls back.
  $healthy = $true
  # The new recorder runs: the pre-0.6.2 install it replaces goes. Its task only when it starts the old exe; in this
  # folder the old exe and config; the old default folder through Remove-LegacyInstall (known files only, secrets
  # first). What is left of it is recorded in legacy-cleanup.txt, and the next install into this folder tries again.
  if ($legacyExe) {
    if ((Get-TaskOwner $LegacyTaskName $legacyExe) -eq 'ours') { Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction SilentlyContinue }
    if (-not $oldDir) {
      foreach ($f in @($legacyExe, "$legacyExe.config")) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    }
  }
  $cleanup = Join-Path $InstallDir 'legacy-cleanup.txt'
  if ($oldDir -or (Test-Path -LiteralPath $cleanup)) {
    try { Write-LegacyCleanup $cleanup $oldDefault @(Remove-LegacyInstall $oldDefault) } catch { }
  }
  # -Update without a code: the first paired account's device (a v1 file: device_id).
  if (-not $device) {
    $device = (Get-Content -LiteralPath $config | Where-Object { $_ -like 'account.0.device_id=*' -or $_ -like 'device_id=*' } | Select-Object -First 1) -replace '^(account\.0\.)?device_id=', ''
  }
  Write-Output "RECITBOT_INSTALL_OK device=$device version=$installed autostart=$autostart"
  exit 0
} catch {
  $reason = $_.Exception.Message
  if ($oldDir -and -not $resumed -and $swapped -and -not $healthy) {
    # A migration after the stop (copy, files, pairing, start or health): the old folder was never touched. The new
    # recorder and its task (when it starts the new exe) go, and so does everything this run put in the new folder: the
    # folder when this run created it, else (or what of it is left) the entries it copied and the new payload, never a
    # config.dat that was there before. The old task is enabled again (when this run disabled it) and the old recorder
    # starts; after -Update it reports "rolled_back" for $RecorderVersion on its next connect.
    try {
      Stop-Recorder
      if ((Get-TaskOwner $TaskName $exe) -eq 'ours') { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
      if ($createdDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
      $left = @()
      if (Test-Path -LiteralPath $InstallDir) { $left = @(Remove-MigratedCopy $InstallDir $copied $ffCopied) }
      if ($legacyTask -eq 'disabled') { Set-LegacyTask $LegacyTaskName $legacyExe $true | Out-Null }
      if ($Update) { Write-Rollback $oldDir $RecorderVersion }
      Start-Recorder $oldDir $legacyExe $LegacyTaskName $true
      $reason = "$reason Rolled back to the previous version."
      if ($left.Count) { $reason = "$reason Could not remove $($left -join ', ') from $InstallDir." }
    } catch { $reason = "$reason Rollback failed: $($_.Exception.Message)" }
    if ($Update) { $exitCode = 6 }
  }
  elseif ($resumed -and $swapped -and -not $healthy -and $backedUp -and $exitCode -ne 4) {
    # A run over a 0.6.2 install already in the new folder, after the stop: that install goes back (its payload from
    # the backup, minus what this run copied from the old folder; its config.dat and nonce files were never replaced)
    # and starts again under its own task. The old task stays disabled and the old recorder is never started. A failed
    # pairing (exit 4) rolls nothing back: the new files stay and start below. The old folder goes on a later install.
    try {
      Stop-Recorder
      $left = @(Restore-MigratedInstall $InstallDir $backup $copied)
      if ($Update) { Write-Rollback $InstallDir $RecorderVersion }
      Start-Recorder $InstallDir $exe $TaskName $true
      Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
      $reason = "$reason Rolled back to the previous version."
      if ($left.Count) { $reason = "$reason Could not remove $($left -join ', ') from $InstallDir." }
    } catch { $reason = "$reason Rollback failed: $($_.Exception.Message)" }
    $exitCode = 6
  }
  # A migration that failed before the stop: the old recorder never stopped; a folder this run created goes.
  elseif ($oldDir -and $createdDir -and -not $swapped) { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
  elseif ($backedUp -and -not $resumed -and $swapped -and $exitCode -ne 4) {
    # -Update after the swap (files, start or health): the previous version goes back and starts again; it reports
    # "rolled_back" for $RecorderVersion on its next connect. A failed pairing keeps the new files (the update worked).
    # After a rename in this folder the previous exe is the old one, under its old task.
    try {
      Stop-Recorder
      Restore-Install $InstallDir $backup | Out-Null
      Write-Rollback $InstallDir $RecorderVersion
      if ($legacyExe) {
        if ((Get-TaskOwner $TaskName $exe) -eq 'ours') { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
        Start-Recorder $InstallDir $legacyExe $LegacyTaskName $true
      } else { Start-Recorder }
      Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
      $reason = "$reason Rolled back to the previous version."
    } catch { $reason = "$reason Rollback failed: $($_.Exception.Message)" }
    $exitCode = 6
  }
  # A failed update, or a failed pairing on a PC that already had paired accounts, must not leave the PC without its
  # recorder: start whatever is installed if it is not running.
  elseif (($Update -or $hadAccounts) -and $swapped -and $exe -and (Test-Path -LiteralPath $exe) -and -not @(Get-Recorder).Count) {
    try { Start-Recorder } catch { }
  }
  # Not rolled back (e.g. a failed pairing): the backup is not needed. A failed rollback keeps it.
  if ($backedUp -and $exitCode -ne 6) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Output "RECITBOT_INSTALL_FAILED: $reason"
  exit $exitCode
} finally {
  if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  # The recorder's self-update runs this script from a copy in %TEMP%.
  if ($Update -and $PSCommandPath -and (Split-Path -Leaf $PSCommandPath) -like 'recitbot-update-*.ps1') {
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  }
}
