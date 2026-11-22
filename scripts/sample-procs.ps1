# Samples memory/CPU of the recorder agent and its ffmpeg children once per second. Output: JSON.
param([int]$AgentPid, [int]$Seconds, [string]$Out)
$samples = @()
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $t = (Get-Date).ToUniversalTime().ToString('o')
  $procs = @()
  $a = Get-Process -Id $AgentPid -ErrorAction SilentlyContinue
  if ($a) { $procs += $a }
  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$AgentPid AND Name='ffmpeg.exe'" -ErrorAction SilentlyContinue
  foreach ($k in $kids) { $p = Get-Process -Id $k.ProcessId -ErrorAction SilentlyContinue; if ($p) { $procs += $p } }
  foreach ($p in $procs) {
    $samples += [pscustomobject]@{
      t = $t; pid = $p.Id; name = $p.ProcessName
      private = $p.PrivateMemorySize64; ws = $p.WorkingSet64; cpu_ms = [math]::Round($p.TotalProcessorTime.TotalMilliseconds)
    }
  }
  Start-Sleep -Milliseconds 1000
}
[pscustomobject]@{ cores = [Environment]::ProcessorCount; samples = $samples } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Out
