import { execFile } from "child_process";

export type IndicatorState = "idle" | "waiting" | "attention" | "executing" | "done" | "error";

/**
 * Stav agenta na tlačítku VS Code v hlavním panelu Windows (ITaskbarList3):
 * pulzující ukazatel = čekám na model, žlutý = čeká se na uživatele (schválení / odpověď),
 * zelený = hotovo, červený = chyba. Navíc překryvná ikonka s písmenem.
 * Mimo Windows nedělá nic.
 */
export class TaskbarIndicator {
  private current: IndicatorState = "idle";
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private queued: IndicatorState | undefined;

  constructor(private readonly windowHint: string) {}

  set(state: IndicatorState): void {
    if (process.platform !== "win32" || state === this.current) return;
    this.current = state;
    if (this.timer) clearTimeout(this.timer);
    // krátké mezistavy neblikají: aplikuje se až po 300 ms klidu
    this.timer = setTimeout(() => void this.apply(state), 300);
  }

  private async apply(state: IndicatorState): Promise<void> {
    if (this.busy) {
      this.queued = state;
      return;
    }
    this.busy = true;
    try {
      await runScript(state, this.windowHint);
    } catch {
      /* bez hlavního panelu (např. vzdálená plocha) se indikátor tiše vzdá */
    } finally {
      this.busy = false;
      const q = this.queued;
      this.queued = undefined;
      if (q && q !== state) void this.apply(q);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (process.platform === "win32") void runScript("idle", this.windowHint).catch(() => undefined);
  }
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList3 {
  [PreserveSig] int HrInit();
  [PreserveSig] int AddTab(IntPtr hwnd);
  [PreserveSig] int DeleteTab(IntPtr hwnd);
  [PreserveSig] int ActivateTab(IntPtr hwnd);
  [PreserveSig] int SetActiveAlt(IntPtr hwnd);
  [PreserveSig] int MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
  [PreserveSig] int SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
  [PreserveSig] int SetProgressState(IntPtr hwnd, int tbpFlags);
  [PreserveSig] int RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
  [PreserveSig] int UnregisterTab(IntPtr hwndTab);
  [PreserveSig] int SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
  [PreserveSig] int SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
  [PreserveSig] int ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
  [PreserveSig] int ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
  [PreserveSig] int ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
  [PreserveSig] int SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
  [PreserveSig] int SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
  [PreserveSig] int SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
}
[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
public class TaskbarListClass {}
public static class TbWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
  public static IntPtr FindCode(string hint) {
    IntPtr best = IntPtr.Zero; IntPtr any = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512); var t = sb.ToString();
      if (!t.EndsWith("Visual Studio Code")) return true;
      if (any == IntPtr.Zero) any = h;
      if (hint.Length > 0 && t.IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) { best = h; return false; }
      return true;
    }, IntPtr.Zero);
    return best != IntPtr.Zero ? best : any;
  }
  // PowerShell neumí volat metody COM rozhraní přímo, proto obalovací statické metody
  static ITaskbarList3 tb;
  public static void Init() { tb = (ITaskbarList3)new TaskbarListClass(); tb.HrInit(); }
  public static int Progress(IntPtr h, int flags, ulong value) { int r = tb.SetProgressState(h, flags); if (value > 0) tb.SetProgressValue(h, value, 100); return r; }
  public static int Overlay(IntPtr h, IntPtr icon, string desc) { return tb.SetOverlayIcon(h, icon, desc); }
}
"@
$state = $env:WHISPER_TB_STATE
$hwnd = [TbWin]::FindCode($env:WHISPER_TB_HINT)
if ($hwnd -eq [IntPtr]::Zero) { throw "VS Code window not found" }
[TbWin]::Init()
switch ($state) {
  'waiting'   { $color = [System.Drawing.Color]::FromArgb(217,119,87);  $glyph = '…'; $prog = 1;  $val = 0 }
  'attention' { $color = [System.Drawing.Color]::FromArgb(210,153,34);  $glyph = '!'; $prog = 8;  $val = 100 }
  'executing' { $color = [System.Drawing.Color]::FromArgb(88,166,255);  $glyph = '»'; $prog = 1;  $val = 0 }
  'done'      { $color = [System.Drawing.Color]::FromArgb(63,185,80);   $glyph = '✓'; $prog = 2;  $val = 100 }
  'error'     { $color = [System.Drawing.Color]::FromArgb(248,81,73);   $glyph = '×'; $prog = 4;  $val = 100 }
  default     { $color = $null; $glyph = ''; $prog = 0; $val = 0 }
}
[void][TbWin]::Progress($hwnd, [int]$prog, [uint64]$val)
if ($color -eq $null) {
  [void][TbWin]::Overlay($hwnd, [IntPtr]::Zero, '')
} else {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($brush, 1, 1, 30, 30)
  $font = New-Object System.Drawing.Font 'Segoe UI', 17, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, -1, 32, 32), $fmt)
  $hicon = $bmp.GetHicon()
  [void][TbWin]::Overlay($hwnd, $hicon, "Whisper: $state")
  [TbWin]::DestroyIcon($hicon) | Out-Null
  $g.Dispose(); $bmp.Dispose()
}
Write-Output "ok $state"
`;

function runScript(state: IndicatorState, hint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      { windowsHide: true, timeout: 15000, env: { ...process.env, WHISPER_TB_STATE: state, WHISPER_TB_HINT: hint } },
      (err, _stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim().split("\n")[0])) : resolve()),
    );
  });
}
