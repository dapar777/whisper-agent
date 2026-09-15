"""Whisper Agent: drag & drop from the keyboard (Windows).

Starts an OS drag of the given files and waits: Alt+Tab to the chat window (the
cursor jumps to its centre), arrow keys nudge the cursor, Enter drops, Esc cancels.
Modelled on mortalmanager's ``gui/keyboard_drag.py`` but without Qt: a small topmost
status strip of our own is the anchor for the synthetic mouse press that keeps the
OLE drag alive across Alt+Tab (Windows drops the mouse capture, and OLE cancels the
drag, the moment the foreground window changes with no button down).

usage:  python dragdrop.py FILE [FILE ...]
prints: copy | move | none (cancelled)
exit:   0 dropped, 1 cancelled, 2 error (e.g. pywin32 missing: pip install pywin32)

Traps (see mortalmanager CLAUDE.md for the long version):
* the left button is held through SendInput for the whole drag, pressed and
  released over our own strip so no click reaches another window;
* the press must be processed by our window BEFORE DoDragDrop (message pump);
* OLE's loop only wakes on input: a watcher thread injects a zero-length mouse
  move every 80 ms and owns a low-level keyboard hook (Enter / Esc / arrows are
  swallowed so the chat does not see them);
* a stuck Esc or Enter (lost key-up) ends the drag before it starts: OLE reads
  fEscapePressed from the key state, so both get a synthetic key-up first;
* SendInput coordinates are physical pixels: the process is made DPI aware.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import sys
import threading
import time

if sys.platform != "win32":
    print("dragdrop: Windows only", file=sys.stderr)
    sys.exit(2)

_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32
_gdi32 = ctypes.windll.gdi32

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_KEYUP = 0x0002
VK_RETURN, VK_ESCAPE = 0x0D, 0x1B
VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN = 0x25, 0x26, 0x27, 0x28
ARROWS = {VK_LEFT: (-1, 0), VK_RIGHT: (1, 0), VK_UP: (0, -1), VK_DOWN: (0, 1)}
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 76, 77, 78, 79
DROPEFFECT_NONE, DROPEFFECT_COPY, DROPEFFECT_MOVE = 0, 1, 2
S_OK = 0
DRAGDROP_S_DROP = 0x00040100
DRAGDROP_S_CANCEL = 0x00040101
DRAGDROP_S_USEDEFAULTCURSORS = 0x00040102
WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x0100, 0x0101, 0x0104, 0x0105
WM_DESTROY, WM_PAINT, WM_LBUTTONDOWN = 0x0002, 0x000F, 0x0201
QS_ALLINPUT = 0x04FF
PM_REMOVE = 0x0001
MONITOR_DEFAULTTONEAREST = 2
WS_POPUP, WS_BORDER = 0x80000000, 0x00800000
WS_EX_TOPMOST, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x00000008, 0x00000080, 0x08000000
SW_SHOWNOACTIVATE = 4
COLOR_INFOBK = 24
DT_CENTER, DT_VCENTER, DT_WORDBREAK = 0x1, 0x4, 0x10
TRANSPARENT = 1
WAKE_MS = 80
ARROW_FRACTION = 10          # one arrow press = 1/10 of the monitor


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _U)]


class _KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wt.DWORD), ("scanCode", wt.DWORD), ("flags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]


class _PAINTSTRUCT(ctypes.Structure):
    _fields_ = [("hdc", wt.HDC), ("fErase", wt.BOOL), ("rcPaint", wt.RECT), ("fRestore", wt.BOOL),
                ("fIncUpdate", wt.BOOL), ("rgbReserved", wt.BYTE * 32)]


_HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wt.WPARAM, wt.LPARAM)
_WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM)


class _WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wt.UINT), ("lpfnWndProc", _WNDPROC), ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON), ("hCursor", wt.HANDLE), ("hbrBackground", wt.HBRUSH),
                ("lpszMenuName", wt.LPCWSTR), ("lpszClassName", wt.LPCWSTR)]


# 64-bit handles: ctypes' default int return type truncates HWND / HMODULE / HHOOK
_kernel32.GetModuleHandleW.restype = wt.HMODULE
_user32.CreateWindowExW.restype = wt.HWND
_user32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
_user32.DefWindowProcW.restype = ctypes.c_ssize_t
_user32.DefWindowProcW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
_user32.SetWindowsHookExW.argtypes = [ctypes.c_int, _HOOKPROC, wt.HMODULE, wt.DWORD]
_user32.SetWindowsHookExW.restype = wt.HHOOK
_user32.CallNextHookEx.argtypes = [wt.HHOOK, ctypes.c_int, wt.WPARAM, wt.LPARAM]
_user32.CallNextHookEx.restype = ctypes.c_ssize_t
_user32.UnhookWindowsHookEx.argtypes = [wt.HHOOK]
_user32.GetForegroundWindow.restype = wt.HWND
_user32.GetAncestor.restype = wt.HWND
_user32.GetAncestor.argtypes = [wt.HWND, wt.UINT]
_user32.MonitorFromPoint.restype = wt.HMONITOR
_user32.BeginPaint.restype = wt.HDC
_user32.BeginPaint.argtypes = [wt.HWND, ctypes.POINTER(_PAINTSTRUCT)]
_user32.EndPaint.argtypes = [wt.HWND, ctypes.POINTER(_PAINTSTRUCT)]
_user32.DrawTextW.argtypes = [wt.HDC, wt.LPCWSTR, ctypes.c_int, ctypes.POINTER(wt.RECT), wt.UINT]


# ------------------------------------------------------------------ input / windows

def make_dpi_aware() -> None:
    """GetWindowRect / GetCursorPos must be physical pixels, like SendInput."""
    try:
        if not _user32.SetProcessDpiAwarenessContext(ctypes.c_ssize_t(-4)):   # per-monitor v2
            _user32.SetProcessDPIAware()
    except Exception:
        try:
            _user32.SetProcessDPIAware()
        except Exception:
            pass


def _send_mouse(flags: int, dx: int = 0, dy: int = 0) -> None:
    inp = _INPUT()
    inp.type = INPUT_MOUSE
    inp.mi = _MOUSEINPUT(dx, dy, 0, flags, 0, None)
    _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))


def _send_key_up(vk: int) -> None:
    inp = _INPUT()
    inp.type = INPUT_KEYBOARD
    inp.ki = _KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, None)
    _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))


def release_stuck_keys() -> None:
    """A stuck Esc (lost key-up, e.g. swallowed by a hook) cancels the drag before it
    starts: OLE takes fEscapePressed from the key state; a stuck Enter would drop at
    once. Send a key-up for both and clear the "pressed since last call" bits."""
    for vk in (VK_ESCAPE, VK_RETURN):
        _send_key_up(vk)
    time.sleep(0.03)
    for vk in (VK_ESCAPE, VK_RETURN):
        _user32.GetAsyncKeyState(vk)


def move_cursor(x: int, y: int) -> None:
    """Move the mouse cursor (physical screen pixels) with a real input event."""
    vx, vy = _user32.GetSystemMetrics(SM_XVIRTUALSCREEN), _user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    vw, vh = _user32.GetSystemMetrics(SM_CXVIRTUALSCREEN), _user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    _send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                int((x - vx) * 65535 / max(1, vw - 1)), int((y - vy) * 65535 / max(1, vh - 1)))


def cursor_pos() -> tuple[int, int]:
    pt = wt.POINT()
    _user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


def foreground_window() -> int:
    return int(_user32.GetForegroundWindow() or 0)


def root_window(hwnd: int) -> int:
    GA_ROOT = 2
    return int(_user32.GetAncestor(wt.HWND(hwnd), GA_ROOT) or 0) or hwnd


def window_center(hwnd: int) -> tuple[int, int] | None:
    rect = wt.RECT()
    if not _user32.GetWindowRect(wt.HWND(hwnd), ctypes.byref(rect)):
        return None
    return (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2


def client_bottom_center(hwnd: int) -> tuple[int, int] | None:
    """Physical point inside our strip where the synthetic press / release lands."""
    rect = wt.RECT()
    if not _user32.GetClientRect(wt.HWND(hwnd), ctypes.byref(rect)):
        return None
    pt = wt.POINT(rect.right // 2, max(0, rect.bottom - 12))
    _user32.ClientToScreen(wt.HWND(hwnd), ctypes.byref(pt))
    return pt.x, pt.y


def monitor_rect(x: int, y: int) -> tuple[int, int, int, int]:
    hmon = _user32.MonitorFromPoint(wt.POINT(x, y), MONITOR_DEFAULTTONEAREST)
    info = _MONITORINFO()
    info.cbSize = ctypes.sizeof(_MONITORINFO)
    if hmon and _user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
        r = info.rcMonitor
        return r.left, r.top, r.right, r.bottom
    return 0, 0, _user32.GetSystemMetrics(0), _user32.GetSystemMetrics(1)


def nudge_cursor(dx_steps: int, dy_steps: int) -> None:
    x, y = cursor_pos()
    left, top, right, bottom = monitor_rect(x, y)
    nx = min(right - 1, max(left, x + dx_steps * (right - left) // ARROW_FRACTION))
    ny = min(bottom - 1, max(top, y + dy_steps * (bottom - top) // ARROW_FRACTION))
    move_cursor(nx, ny)


# ------------------------------------------------------------------ status strip

class StatusWindow:
    """Topmost strip near the bottom of the primary monitor: tells the user what to
    do and is where the synthetic mouse press lands (it clicks nothing elsewhere)."""

    CLASS = "WhisperDragStatus"

    def __init__(self, text: str) -> None:
        self.text = text
        self._proc = _WNDPROC(self._wndproc)       # keep the callback alive
        hinst = _kernel32.GetModuleHandleW(None)
        wc = _WNDCLASSW()
        wc.lpfnWndProc = self._proc
        wc.hInstance = hinst
        wc.hbrBackground = wt.HBRUSH(COLOR_INFOBK + 1)
        wc.hCursor = _user32.LoadCursorW(None, wt.LPCWSTR(32512))
        wc.lpszClassName = self.CLASS
        _user32.RegisterClassW(ctypes.byref(wc))
        sw, sh = _user32.GetSystemMetrics(0), _user32.GetSystemMetrics(1)
        w, h = min(760, sw - 40), 64
        self.hwnd = _user32.CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, self.CLASS, "Whisper",
                                            WS_POPUP | WS_BORDER, (sw - w) // 2, sh - h - 72, w, h, None, None, hinst, None)
        if not self.hwnd:
            raise OSError("CreateWindowExW failed")
        _user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
        _user32.UpdateWindow(self.hwnd)

    def _wndproc(self, hwnd, msg, wparam, lparam):
        if msg == WM_PAINT:
            ps = _PAINTSTRUCT()
            hdc = _user32.BeginPaint(hwnd, ctypes.byref(ps))
            rect = wt.RECT()
            _user32.GetClientRect(hwnd, ctypes.byref(rect))
            rect.left += 14
            rect.right -= 14
            rect.top += 10
            _gdi32.SetBkMode(hdc, TRANSPARENT)
            _user32.DrawTextW(hdc, self.text, -1, ctypes.byref(rect), DT_CENTER | DT_WORDBREAK)
            _user32.EndPaint(hwnd, ctypes.byref(ps))
            return 0
        if msg == WM_LBUTTONDOWN:
            return 0                                 # the synthetic press: nothing to do
        return _user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def pump(self, ms: int) -> None:
        """Process our messages for `ms` (the synthetic press must be seen before DoDragDrop)."""
        deadline = time.monotonic() + ms / 1000
        msg = wt.MSG()
        while time.monotonic() < deadline:
            while _user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                _user32.TranslateMessage(ctypes.byref(msg))
                _user32.DispatchMessageW(ctypes.byref(msg))
            time.sleep(0.01)

    def destroy(self) -> None:
        if self.hwnd:
            _user32.DestroyWindow(self.hwnd)
            self.hwnd = None


# ------------------------------------------------------------------ keys, watcher, drop source

class _Keys:
    """Enter / Esc flags set by the hook and, as a backup, by polling GetAsyncKeyState."""

    def __init__(self) -> None:
        self.enter = False
        self.escape = False
        self.hooked = False

    def poll(self) -> None:
        if _user32.GetAsyncKeyState(VK_RETURN) & 0x8001:
            self.enter = True
        if _user32.GetAsyncKeyState(VK_ESCAPE) & 0x8001:
            self.escape = True


class _DropSource:
    _public_methods_ = ["QueryContinueDrag", "GiveFeedback"]
    _com_interfaces_ = []                     # set to [IID_IDropSource] at run time

    def __init__(self, keys: _Keys) -> None:
        self.keys = keys

    def QueryContinueDrag(self, escape_pressed: int, key_state: int) -> int:  # noqa: N802
        if escape_pressed or self.keys.escape:
            return DRAGDROP_S_CANCEL
        if self.keys.enter:
            return DRAGDROP_S_DROP
        return S_OK

    def GiveFeedback(self, effect: int) -> int:  # noqa: N802
        return DRAGDROP_S_USEDEFAULTCURSORS


class _Watcher(threading.Thread):
    """Keeps OLE's loop awake, follows Alt+Tab, owns the keyboard hook."""

    def __init__(self, own_hwnd: int, keys: _Keys) -> None:
        super().__init__(daemon=True)
        self._own = root_window(own_hwnd)
        self._last_fg = root_window(foreground_window())
        self._keys = keys
        self.stop = threading.Event()
        self._hook = None
        self._proc = None

    def _hook_proc(self, code: int, wparam: int, lparam: int) -> int:
        if code >= 0 and wparam in (WM_KEYDOWN, WM_SYSKEYDOWN, WM_KEYUP, WM_SYSKEYUP):
            vk = ctypes.cast(lparam, ctypes.POINTER(_KBDLLHOOKSTRUCT)).contents.vkCode
            down = wparam in (WM_KEYDOWN, WM_SYSKEYDOWN)
            if vk == VK_RETURN:
                if down:
                    self._keys.enter = True
                return 1
            if vk == VK_ESCAPE:
                if down:
                    self._keys.escape = True
                return 1
            if vk in ARROWS:
                if down:
                    nudge_cursor(*ARROWS[vk])
                return 1
        return _user32.CallNextHookEx(None, code, wt.WPARAM(wparam), wt.LPARAM(lparam))

    def _install_hook(self) -> None:
        try:
            self._proc = _HOOKPROC(self._hook_proc)
            self._hook = _user32.SetWindowsHookExW(WH_KEYBOARD_LL, self._proc, _kernel32.GetModuleHandleW(None), 0)
            self._keys.hooked = bool(self._hook)
        except Exception as exc:
            print(f"dragdrop: hook install failed: {exc}", file=sys.stderr)
            self._hook = None

    def run(self) -> None:
        self._install_hook()
        _user32.GetAsyncKeyState(VK_RETURN)          # consume "pressed since last call" bits
        _user32.GetAsyncKeyState(VK_ESCAPE)
        msg = wt.MSG()
        try:
            while not self.stop.is_set():
                _user32.MsgWaitForMultipleObjects(0, None, False, WAKE_MS, QS_ALLINPUT)
                while _user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                    _user32.TranslateMessage(ctypes.byref(msg))
                    _user32.DispatchMessageW(ctypes.byref(msg))
                self._keys.poll()
                fg = root_window(foreground_window())
                if fg and fg != self._last_fg:
                    self._last_fg = fg
                    if fg != self._own:
                        c = window_center(fg)
                        if c:
                            move_cursor(*c)
                # wake DoDragDrop the way a real drag does: an injected mouse move to the same spot
                move_cursor(*cursor_pos())
        finally:
            if self._hook:
                _user32.UnhookWindowsHookEx(self._hook)
                self._hook = None


def run_drag(paths: list[str], win: StatusWindow, auto_cancel: float = 0.0) -> str:
    """Blocking OLE drag of ``paths``; returns "copy", "move" or "none" (cancelled).
    ``auto_cancel`` (seconds, self-test) presses a virtual Esc after that time."""
    import pythoncom
    from win32com.server import util
    from win32com.shell import shell

    try:
        pythoncom.OleInitialize()
    except Exception:
        pass                                      # already initialised for this thread
    _DropSource._com_interfaces_ = [pythoncom.IID_IDropSource]
    pidls = []
    for p in paths:
        try:
            pidls.append(shell.SHParseDisplayName(p, 0)[0])
        except Exception as exc:
            print(f"dragdrop: cannot parse {p}: {exc}", file=sys.stderr)
    if not pidls:
        return "none"
    items = shell.SHCreateShellItemArrayFromIDLists(pidls)
    data = items.BindToHandler(None, shell.BHID_DataObject, pythoncom.IID_IDataObject)
    keys = _Keys()
    source = util.wrap(_DropSource(keys), pythoncom.IID_IDropSource)
    watcher = _Watcher(win.hwnd, keys)
    release_stuck_keys()
    anchor = client_bottom_center(win.hwnd)
    origin = cursor_pos()
    if anchor:
        move_cursor(*anchor)
        time.sleep(0.03)
    _send_mouse(MOUSEEVENTF_LEFTDOWN)
    win.pump(250)                                  # our window must see the press before the drag starts
    if anchor:
        move_cursor(*origin)
        time.sleep(0.02)
    watcher.start()
    if auto_cancel > 0:
        threading.Timer(auto_cancel, lambda: setattr(keys, "escape", True)).start()
    started = time.monotonic()
    try:
        effect = pythoncom.DoDragDrop(data, source, DROPEFFECT_COPY | DROPEFFECT_MOVE)
    finally:
        # a drag that ends within a fraction of a second never really started (capture lost, stuck Esc…)
        elapsed = time.monotonic() - started
        if elapsed < 0.5:
            print(f"dragdrop: DoDragDrop returned after {elapsed:.2f}s (the drag did not start)", file=sys.stderr)
        watcher.stop.set()
        watcher.join(1.0)
        end_pos = cursor_pos()
        if anchor:
            move_cursor(*anchor)
            time.sleep(0.03)
        _send_mouse(MOUSEEVENTF_LEFTUP)
        if anchor:
            time.sleep(0.02)
            move_cursor(*end_pos)
    if isinstance(effect, tuple):
        effect = effect[-1]
    if not effect:
        return "none"
    return "move" if effect & DROPEFFECT_MOVE else "copy"


def main(argv: list[str]) -> int:
    args = argv[1:]
    check = "--check" in args                     # self-test: pywin32 + status window, no drag
    auto_cancel = 0.0
    if "--auto-cancel" in args:                   # self-test: real drag, cancelled after N seconds
        i = args.index("--auto-cancel")
        auto_cancel = float(args[i + 1])
        del args[i:i + 2]
    args = [a for a in args if a != "--check"]
    paths = [os.path.abspath(p) for p in args]
    if not paths and not check:
        print(__doc__.strip().split("\n\n")[0], file=sys.stderr)
        return 2
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        print(f"dragdrop: file not found: {', '.join(missing)}", file=sys.stderr)
        return 2
    try:
        import pythoncom  # noqa: F401
        from win32com.shell import shell  # noqa: F401
    except ImportError as exc:
        print(f"dragdrop: pywin32 is required (pip install pywin32): {exc}", file=sys.stderr)
        return 2
    make_dpi_aware()
    names = ", ".join(os.path.basename(p) for p in paths) or "(check)"
    win = StatusWindow(f"Whisper táhne: {names}\n"
                       "Alt+Tab do chatu (kurzor skočí do okna), šipky posunou, Enter pustí, Esc zruší")
    try:
        win.pump(60)
        if check:
            release_stuck_keys()
            win.pump(300)
            print("ok")
            return 0
        result = run_drag(paths, win, auto_cancel)
    finally:
        win.destroy()
    print(result)
    return 0 if result in ("copy", "move") else 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as exc:  # any Win32/COM failure: report, never hang
        print(f"dragdrop: {exc}", file=sys.stderr)
        sys.exit(2)
