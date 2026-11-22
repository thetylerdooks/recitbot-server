# Test-only full-motion window for smoothness checks (scripts/smoothness.mjs): a borderless window at an exact physical
# rect whose whole area changes about 60 times a second (hue, moving bars, frame counter). It never takes the foreground
# (WS_EX_NOACTIVATE, shown without activation) and injects no input, so it can run beside someone's game. Prints
# {"hwnd":N,"pid":N} once shown; exits when stdin closes.
#   powershell -File scripts/motion-window.ps1 -X 2660 -Y 100 -W 641 -H 481 [-Title ar-smooth-motion]
param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Title = "ar-smooth-motion")
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class MotionWindow : Form {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    int n;
    readonly Timer timer = new Timer();
    public MotionWindow(string title, Rectangle r) {
        Text = title;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = r;
        DoubleBuffered = true;
        timeBeginPeriod(1);
        timer.Interval = 15;
        timer.Tick += delegate { n++; Invalidate(); };
        timer.Start();
    }
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        Console.Out.WriteLine("{\"hwnd\":" + Handle.ToInt64() + ",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}");
        Console.Out.Flush();
        var t = new System.Threading.Thread(delegate () { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
        t.IsBackground = true;
        t.Start();
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 /* NOACTIVATE */ | 0x8 /* TOPMOST */ | 0x40000 /* APPWINDOW: listed like a normal app */;
            return cp;
        }
    }
    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        int w = ClientSize.Width, h = ClientSize.Height;
        double t = n * 7 % 360 / 60.0;
        int k = (int)t, f = (int)((t - k) * 255);
        int[][] hue = { new[] { 255, f, 0 }, new[] { 255 - f, 255, 0 }, new[] { 0, 255, f }, new[] { 0, 255 - f, 255 }, new[] { f, 0, 255 }, new[] { 255, 0, 255 - f } };
        var c = hue[k % 6];
        g.Clear(Color.FromArgb(40 + c[0] * 3 / 5, 40 + c[1] * 3 / 5, 40 + c[2] * 3 / 5));
        int bw = Math.Max(2, w / 40);
        for (int i = 0; i < 8; i++) g.FillRectangle(Brushes.White, (n * 13 + i * w / 8) % Math.Max(1, w), 0, bw, h);
        g.FillRectangle(Brushes.Black, 0, (n * 9) % Math.Max(1, h), w, Math.Max(2, h / 30));
        using (var font = new Font(FontFamily.GenericMonospace, Math.Max(8, h / 6), GraphicsUnit.Pixel))
            g.DrawString(n.ToString(), font, Brushes.Yellow, w * 0.35f, h * 0.25f);
    }
}
'@
[MotionWindow]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
[System.Windows.Forms.Application]::Run((New-Object MotionWindow($Title, (New-Object System.Drawing.Rectangle($X, $Y, $W, $H)))))
