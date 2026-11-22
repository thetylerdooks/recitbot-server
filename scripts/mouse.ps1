# Test helper: real mouse input at physical screen coordinates, the way a user clicks or drags.
# Click: -X -Y. Drag: -X -Y -ToX -ToY (press at X,Y, move in steps, release at ToX,ToY). The cursor is put back afterwards.
# Every event carries absolute virtual-desktop coordinates (SendInput), so a press can only land where it was aimed,
# even if someone moves the real mouse while this runs.
param([int]$X, [int]$Y, [int]$ToX = -2147483648, [int]$ToY = -2147483648, [int]$Steps = 12)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Mouse {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Pt p);
  public struct Pt { public int X, Y; }
  /// MOVE|ABSOLUTE|VIRTUALDESK plus the given button flags (0x2 down, 0x4 up), at physical screen pixel (x, y).
  public static void At(int x, int y, uint buttons) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    var i = new INPUT { type = 0 };
    i.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    i.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    i.mi.flags = 0x1 | 0x8000 | 0x4000 | buttons;
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
try { [Mouse]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null } catch { }
$orig = New-Object Mouse+Pt
[Mouse]::GetCursorPos([ref]$orig) | Out-Null
[Mouse]::At($X, $Y, 0)
Start-Sleep -Milliseconds 20
[Mouse]::At($X, $Y, 0x2) # left down
$endX = $X; $endY = $Y
if ($ToX -ne -2147483648) {
  $endX = $ToX; $endY = $ToY
  for ($i = 1; $i -le $Steps; $i++) {
    Start-Sleep -Milliseconds 25
    [Mouse]::At($X + [int](($ToX - $X) * $i / $Steps), $Y + [int](($ToY - $Y) * $i / $Steps), 0)
  }
}
Start-Sleep -Milliseconds 20
[Mouse]::At($endX, $endY, 0x4) # left up
Start-Sleep -Milliseconds 50
[Mouse]::SetCursorPos($orig.X, $orig.Y) | Out-Null
'ok'
