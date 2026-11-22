# Recitbot uninstaller: stops the agent, removes this install's logon task, HKCU Run values and Startup shortcuts, and
# the install folder.
param(
  [string]$InstallDir = $(if ($env:AGENT_RECORDER_INSTALL_DIR) { $env:AGENT_RECORDER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Recitbot' })
)
$ErrorActionPreference = 'Stop'

# --- startup entries: the recorder's selftest loads this block (up to the end marker) and runs it against a throwaway
# install in %TEMP%, so keep it free of anything but function definitions. parity: AgentRecorder.cs SelfUninstaller.Script
function Resolve-Exe([string]$p) {
  if ([string]::IsNullOrEmpty($p)) { return $null }
  try {
    $p = [Environment]::ExpandEnvironmentVariables($p).Trim().Trim('"')
    if ($p.Length -eq 0 -or -not [IO.Path]::IsPathRooted($p)) { return $null }
    return [IO.Path]::GetFullPath($p).TrimEnd('\')
  } catch { return $null }
}

# The program of a command line: a quoted path, else the text through '.exe', else the first token.
function Get-CmdExe([string]$cmd) {
  if ([string]::IsNullOrEmpty($cmd)) { return $null }
  $c = $cmd.Trim()
  if ($c.StartsWith('"')) { $e = $c.IndexOf('"', 1); if ($e -lt 0) { $c = $c.Substring(1) } else { $c = $c.Substring(1, $e - 1) } }
  else {
    $m = [regex]::Match($c, '(?i)^.*?\.exe(?=\s|$)')
    if ($m.Success) { $c = $m.Value } else { $c = ($c -split '\s+')[0] }
  }
  return Resolve-Exe $c
}

# Removes only the startup entries that start $Exe (full paths, case-insensitive): a task when every one of its actions
# runs it, a Run value when its command line's program is it, a Startup shortcut when its target is it. Another copy may
# use the same names: its entries stay, and a task of another copy gets a line saying so.
function Remove-Autostart([string]$Exe, [string[]]$TaskNames, [string]$RunKey, [string[]]$RunValues, [string]$StartupDir, [string[]]$StartupLinks) {
  $self = Resolve-Exe $Exe
  if (-not $self) { return }
  foreach ($n in $TaskNames) {
    foreach ($t in @(Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue)) {
      $acts = @($t.Actions)
      $own = $acts.Count -gt 0
      foreach ($a in $acts) { if (-not [string]::Equals((Resolve-Exe $a.Execute), $self, [StringComparison]::OrdinalIgnoreCase)) { $own = $false } }
      if ($own) { Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false }
      else { Write-Output "Left the scheduled task $($t.TaskName) alone: it does not start $self." }
    }
  }
  foreach ($n in $RunValues) {
    $v = (Get-ItemProperty -LiteralPath $RunKey -Name $n -ErrorAction SilentlyContinue).$n
    if ([string]::Equals((Get-CmdExe $v), $self, [StringComparison]::OrdinalIgnoreCase)) { Remove-ItemProperty -LiteralPath $RunKey -Name $n }
  }
  if (-not $StartupDir) { return }
  try { $shell = New-Object -ComObject WScript.Shell } catch { return }
  foreach ($n in $StartupLinks) {
    $f = Join-Path $StartupDir $n
    if (-not (Test-Path -LiteralPath $f)) { continue }
    try { $target = $shell.CreateShortcut($f).TargetPath } catch { continue }
    if ([string]::Equals((Resolve-Exe $target), $self, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $f -Force }
  }
}
# Why $Dir must not be deleted, $null when it is a Recitbot install folder: a rooted folder, not a drive root, not one
# of $Keep (the profile, LocalAppData, AppData, Temp) or a folder above one, and holding Recitbot.exe or (pre-0.6.2)
# AgentRecorder.exe. parity: AgentRecorder.cs SelfUninstaller.InstalledCheck
function Test-InstallDir([string]$Dir, [string[]]$Keep) {
  $d = Resolve-Exe $Dir
  if (-not $d) { return 'install folder unknown' }
  $root = ([IO.Path]::GetPathRoot($d) + '').TrimEnd('\')
  if (-not $root -or [string]::Equals($d, $root, [StringComparison]::OrdinalIgnoreCase)) { return 'refusing to delete a drive root' }
  foreach ($k in $Keep) {
    $kk = Resolve-Exe $k
    if (-not $kk) { continue }
    if ([string]::Equals($d, $kk, [StringComparison]::OrdinalIgnoreCase) -or $kk.StartsWith($d + '\', [StringComparison]::OrdinalIgnoreCase)) { return "refusing to delete $kk" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $d 'Recitbot.exe')) -and -not (Test-Path -LiteralPath (Join-Path $d 'AgentRecorder.exe'))) {
    return "not a Recitbot install folder (no Recitbot.exe or AgentRecorder.exe in $d)"
  }
  return $null
}
# --- end startup entries

$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$refuse = Test-InstallDir $InstallDir @($env:LOCALAPPDATA, $env:APPDATA, $env:USERPROFILE, [IO.Path]::GetTempPath())
if ($refuse) { Write-Error "Not uninstalling: $refuse"; exit 1 }
$pidFile = Join-Path $InstallDir 'agent.pid'
if (Test-Path $pidFile) {
  $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
  if ($p -and @('Recitbot', 'AgentRecorder') -contains $p.ProcessName) { Stop-Process -Id $p.Id -Force; $p.WaitForExit(5000) | Out-Null }
}
# ffmpeg runs in a kill-on-close job with the agent; also stop any stray started from this install.
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$InstallDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Same names as SelfUninstaller.TaskNames / RunValues / StartupLinks (current and pre-0.6.2), for the exe of either name.
foreach ($name in @('Recitbot.exe', 'AgentRecorder.exe')) { Remove-Autostart (Join-Path $InstallDir $name) @('Recitbot', 'AgentRecorder') 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' @('AgentRecorder', 'Recitbot') ([Environment]::GetFolderPath('Startup')) @('AgentRecorder.lnk', 'Recitbot.lnk') }
if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
Write-Output 'Recitbot removed. This does not unpair the device on your account; remove it there too.'
