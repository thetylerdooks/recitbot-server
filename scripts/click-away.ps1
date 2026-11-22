# Test helper: "the user clicks somewhere else". Shows a small throwaway window at X,Y, clicks it with real mouse input
# (which activates it and deactivates whatever had the foreground), then closes it. Prints 'ok'.
param([int]$X, [int]$Y)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }'
try { [Dpi]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null } catch { }
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size(160, 80)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Gray
$form.Text = 'e2e click target'
$script:clicked = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
  if (-not $script:clicked) {
    $script:clicked = $true
    # Absolute-position click via mouse.ps1 (SendInput): it can only land on this test window.
    & (Join-Path $PSScriptRoot 'mouse.ps1') -X ($X + 80) -Y ($Y + 40) | Out-Null
  } else {
    $timer.Stop()
    $form.Close()
  }
})
$form.Add_Shown({ $timer.Start() })
[System.Windows.Forms.Application]::Run($form)
'ok'
