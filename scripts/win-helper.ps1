# Test-only helper for window-recording tests: finds and moves the test's OWN windows (by process id) with exact Win32
# calls. No mouse or keyboard input is injected, and nothing is activated unless asked. Long-lived: one JSON command per
# stdin line, one JSON reply per line (so the C# helper below is compiled once).
#   {"op":"pids","name":"x.exe","pattern":"..."}       ids of x.exe processes whose command line contains pattern
#   {"op":"windows","pids":[..]}                       visible top-level windows of those processes
#   {"op":"rect","hwnd":N}                             DWM frame bounds + minimized flag
#   {"op":"move","hwnd":N,"x":..,"y":..,"w":..,"h":..} SetWindowPos without activation or z-order change
#   {"op":"minimize"|"restore"|"close","hwnd":N}       SW_SHOWMINNOACTIVE / SW_SHOWNOACTIVATE / WM_CLOSE
#   {"op":"topmost","hwnd":N,"on":true|false}          pin above other windows (occlusion test), no activation
#   {"op":"foreground"}                                hwnd + pid of the foreground window
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinHelper {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
    public struct RECT { public int L, T, R, B; }

    static string Esc(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    public static string Rect(IntPtr h) {
        RECT r;
        DwmGetWindowAttribute(h, 9, out r, 16);
        return "{\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + ",\"minimized\":" + (IsIconic(h) ? "true" : "false") + "}";
    }

    public static string Windows(int[] pids) {
        var list = new List<string>();
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (Array.IndexOf(pids, (int)pid) < 0 || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.Length == 0) return true;
            list.Add("{\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"title\":" + Esc(sb.ToString()) + ",\"rect\":" + Rect(h) + "}");
            return true;
        }, IntPtr.Zero);
        return "[" + string.Join(",", list) + "]";
    }
}
'@
[WinHelper]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
$noActivate = 0x0010; $noZ = 0x0004; $noMove = 0x0002; $noSize = 0x0001
while ($null -ne ($line = [Console]::In.ReadLine())) {
    try {
        $c = $line | ConvertFrom-Json
        $h = if ($c.hwnd) { [IntPtr][long]$c.hwnd } else { [IntPtr]::Zero }
        switch ($c.op) {
            'pids' {
                $ids = @(Get-CimInstance Win32_Process -Filter "Name='$($c.name)'" | Where-Object { $_.CommandLine -like "*$($c.pattern)*" } | ForEach-Object { [int]$_.ProcessId })
                $out = ConvertTo-Json -Compress -InputObject $ids
            }
            'windows' { $out = [WinHelper]::Windows([int[]]@($c.pids)) }
            'rect' { $out = [WinHelper]::Rect($h) }
            'move' { $out = ConvertTo-Json -Compress ([WinHelper]::SetWindowPos($h, [IntPtr]::Zero, $c.x, $c.y, $c.w, $c.h, $noActivate -bor $noZ)) }
            'minimize' { $out = ConvertTo-Json -Compress ([WinHelper]::ShowWindow($h, 7)) }
            'restore' { $out = ConvertTo-Json -Compress ([WinHelper]::ShowWindow($h, 4)) }
            'close' { $out = ConvertTo-Json -Compress ([WinHelper]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) }
            'topmost' {
                $after = if ($c.on) { [IntPtr](-1) } else { [IntPtr](-2) }
                $out = ConvertTo-Json -Compress ([WinHelper]::SetWindowPos($h, $after, 0, 0, 0, 0, $noActivate -bor $noMove -bor $noSize))
            }
            'foreground' {
                $fg = [WinHelper]::GetForegroundWindow(); $fpid = [uint32]0
                [WinHelper]::GetWindowThreadProcessId($fg, [ref]$fpid) | Out-Null
                $out = "{`"hwnd`":$($fg.ToInt64()),`"pid`":$fpid}"
            }
            default { $out = '{"error":"unknown op"}' }
        }
        if ($null -eq $out -or $out -eq '') { $out = 'null' }
        [Console]::Out.WriteLine($out)
    } catch {
        [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ error = $_.Exception.Message }))
    }
    [Console]::Out.Flush()
}
