using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Bishop;

/// <summary>
/// Frameless WinForms window hosting the React UI in WebView2. Window chrome
/// (drag, resize, min/max/close) is driven from the web UI via /api/window/*.
/// </summary>
public class BishopWindow : Form
{
    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int HT_CAPTION = 0x0002;
    private const int WM_GETMINMAXINFO = 0x0024;
    private const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    private readonly WebView2 _webView;
    private readonly string _appUrl;
    private readonly string _windowStatePath;
    private readonly string _webViewDataDir;

    public BishopWindow(string appUrl, string appDataDir)
    {
        _appUrl = appUrl;
        _windowStatePath = Path.Combine(appDataDir, "window.json");
        _webViewDataDir = Path.Combine(appDataDir, "WebView2Profile");

        Text = "Bishop";
        Width = 1400;
        Height = 860;
        MinimumSize = new Size(900, 560);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.FromArgb(16, 19, 26);

        RestoreWindowBounds();

        try
        {
            var icoPath = Path.Combine(AppContext.BaseDirectory, "app.ico");
            Icon = File.Exists(icoPath) ? new Icon(icoPath) : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch { }

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(16, 19, 26)
        };
        Controls.Add(_webView);

        Load += async (_, _) => await InitWebViewAsync();
        FormClosing += (_, _) => SaveWindowBounds();
    }

    private void RestoreWindowBounds()
    {
        try
        {
            if (!File.Exists(_windowStatePath)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(_windowStatePath));
            var root = doc.RootElement;
            int w = root.TryGetProperty("width", out var wp) && wp.TryGetInt32(out int wi) ? wi : 1400;
            int h = root.TryGetProperty("height", out var hp) && hp.TryGetInt32(out int hi) ? hi : 860;
            Width = Math.Max(900, w);
            Height = Math.Max(560, h);

            if (root.TryGetProperty("left", out var lp) && lp.TryGetInt32(out int l) &&
                root.TryGetProperty("top", out var tp) && tp.TryGetInt32(out int t))
            {
                var rect = new Rectangle(l, t, Width, Height);
                if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect)))
                {
                    StartPosition = FormStartPosition.Manual;
                    Left = l;
                    Top = t;
                }
            }

            if (root.TryGetProperty("maximized", out var mp) && mp.ValueKind == JsonValueKind.True)
            {
                WindowState = FormWindowState.Maximized;
            }
        }
        catch { }
    }

    private void SaveWindowBounds()
    {
        try
        {
            var dir = Path.GetDirectoryName(_windowStatePath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var payload = new
            {
                left = bounds.Left,
                top = bounds.Top,
                width = Math.Max(900, bounds.Width),
                height = Math.Max(560, bounds.Height),
                maximized = WindowState == FormWindowState.Maximized
            };
            File.WriteAllText(_windowStatePath, JsonSerializer.Serialize(payload));
        }
        catch { }
    }

    private async Task InitWebViewAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, _webViewDataDir);
            await _webView.EnsureCoreWebView2Async(env);
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;

            // Keep the webview pinned to the local app; never navigate elsewhere.
            _webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!args.Uri.StartsWith(_appUrl, StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                }
            };

            _webView.Source = new Uri(_appUrl);
        }
        catch
        {
            // Fallback if the WebView2 runtime is unavailable
            Process.Start(new ProcessStartInfo { FileName = _appUrl, UseShellExecute = true });
        }
    }

    private void NotifyWebViewMaximizeState()
    {
        try
        {
            if (_webView?.CoreWebView2 != null)
            {
                bool isMax = WindowState == FormWindowState.Maximized;
                _ = _webView.CoreWebView2.ExecuteScriptAsync(
                    $"window.dispatchEvent(new CustomEvent('bishop-window-state', {{ detail: {{ isMaximized: {(isMax ? "true" : "false")} }} }}));"
                );
            }
        }
        catch { }
    }

    public void DragWindow()
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(DragWindow));
            return;
        }

        if (WindowState == FormWindowState.Maximized)
        {
            var startCursor = Cursor.Position;
            bool draggedBeyondThreshold = false;
            while ((Control.MouseButtons & MouseButtons.Left) == MouseButtons.Left)
            {
                var cur = Cursor.Position;
                if (Math.Abs(cur.X - startCursor.X) > 6 || Math.Abs(cur.Y - startCursor.Y) > 6)
                {
                    draggedBeyondThreshold = true;
                    break;
                }
                Application.DoEvents();
                Thread.Sleep(8);
            }

            if (!draggedBeyondThreshold)
            {
                return;
            }

            var currentScreen = Screen.FromPoint(Cursor.Position);
            double xRatio = currentScreen.WorkingArea.Width > 0
                ? Math.Clamp((double)(Cursor.Position.X - currentScreen.WorkingArea.Left) / currentScreen.WorkingArea.Width, 0.1, 0.9)
                : 0.5;

            WindowState = FormWindowState.Normal;
            Left = Cursor.Position.X - (int)(Width * xRatio);
            Top = Math.Max(currentScreen.WorkingArea.Top + 14, Cursor.Position.Y - 16);
            NotifyWebViewMaximizeState();
        }

        ReleaseCapture();
        SendMessage(Handle, WM_NCLBUTTONDOWN, HT_CAPTION, 0);

        // When drag completes, if docked to the top of a monitor, maximize to fill that screen
        var dropCursor = Cursor.Position;
        var targetScreen = Screen.FromPoint(dropCursor);
        bool dockedToTop =
            dropCursor.Y <= targetScreen.WorkingArea.Top + 12 ||
            dropCursor.Y <= targetScreen.Bounds.Top + 12 ||
            (Top <= targetScreen.WorkingArea.Top + 4 && Top >= targetScreen.Bounds.Top - 24);

        if (WindowState == FormWindowState.Normal && dockedToTop)
        {
            Left = targetScreen.WorkingArea.Left + Math.Max(0, (targetScreen.WorkingArea.Width - Width) / 2);
            Top = targetScreen.WorkingArea.Top + Math.Max(0, (targetScreen.WorkingArea.Height - Height) / 2);
            WindowState = FormWindowState.Maximized;
            NotifyWebViewMaximizeState();
        }
    }

    public void ResizeWindow(string dir)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => ResizeWindow(dir)));
            return;
        }
        if (WindowState == FormWindowState.Maximized) return;

        int ht = dir switch
        {
            "left" => 10,        // HTLEFT
            "right" => 11,       // HTRIGHT
            "top" => 12,         // HTTOP
            "topLeft" => 13,     // HTTOPLEFT
            "topRight" => 14,    // HTTOPRIGHT
            "bottom" => 15,      // HTBOTTOM
            "bottomLeft" => 16,  // HTBOTTOMLEFT
            "bottomRight" => 17, // HTBOTTOMRIGHT
            _ => 17
        };

        ReleaseCapture();
        SendMessage(Handle, WM_NCLBUTTONDOWN, ht, 0);
    }

    public void MinimizeWindow()
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(MinimizeWindow));
            return;
        }
        WindowState = FormWindowState.Minimized;
    }

    public bool ToggleMaximizeWindow()
    {
        if (InvokeRequired)
        {
            return (bool)Invoke(new Func<bool>(ToggleMaximizeWindow));
        }
        WindowState = WindowState == FormWindowState.Maximized
            ? FormWindowState.Normal
            : FormWindowState.Maximized;
        NotifyWebViewMaximizeState();
        return WindowState == FormWindowState.Maximized;
    }

    public void CloseWindow()
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(CloseWindow));
            return;
        }
        Close();
    }

    protected override void WndProc(ref Message m)
    {
        // Keep maximized borderless window inside the monitor's work area (don't cover the taskbar).
        if (m.Msg == WM_GETMINMAXINFO)
        {
            var mmi = Marshal.PtrToStructure<MINMAXINFO>(m.LParam);
            IntPtr monitor = MonitorFromWindow(Handle, MONITOR_DEFAULTTONEAREST);
            if (monitor != IntPtr.Zero)
            {
                var monitorInfo = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
                if (GetMonitorInfo(monitor, ref monitorInfo))
                {
                    var rcWorkArea = monitorInfo.rcWork;
                    var rcMonitorArea = monitorInfo.rcMonitor;
                    mmi.ptMaxPosition.X = Math.Abs(rcWorkArea.Left - rcMonitorArea.Left);
                    mmi.ptMaxPosition.Y = Math.Abs(rcWorkArea.Top - rcMonitorArea.Top);
                    mmi.ptMaxSize.X = Math.Abs(rcWorkArea.Right - rcWorkArea.Left);
                    mmi.ptMaxSize.Y = Math.Abs(rcWorkArea.Bottom - rcWorkArea.Top);
                    mmi.ptMinTrackSize.X = MinimumSize.Width;
                    mmi.ptMinTrackSize.Y = MinimumSize.Height;
                    Marshal.StructureToPtr(mmi, m.LParam, true);
                    m.Result = IntPtr.Zero;
                    return;
                }
            }
        }
        base.WndProc(ref m);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // Enable native taskbar minimize/restore & maximize box on a borderless form
            cp.Style |= 0x00020000 | 0x00010000; // WS_MINIMIZEBOX | WS_MAXIMIZEBOX
            cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
            return cp;
        }
    }
}
