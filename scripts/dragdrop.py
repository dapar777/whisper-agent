"""Whisper Agent: drag & drop of files into another window (Windows).

Two ways to drag, one OLE mechanism (pythoncom.DoDragDrop with a shell data object, so the target
gets a real file, exactly as from Explorer):

* keyboard drag: a small status strip of our own becomes the foreground window, the left button
  is pressed over it through SendInput (Windows keeps the mouse capture across Alt+Tab only while
  a button is down), Alt+Tab to the target, arrows nudge the cursor, Enter drops, Esc cancels;
* mouse drag: the user already holds the button (pressed on the attachment chip in the panel);
  our input queue is attached to the foreground thread's (AttachThreadInput) so the OLE capture
  is honoured, the user drags on and drops by releasing the button.

Modes:
  python dragdrop.py --serve              persistent helper: JSON lines on stdin/stdout (see serve())
  python dragdrop.py FILE...              one keyboard drag, prints copy|move|none
  python dragdrop.py --mouse FILE...      one mouse drag
  python dragdrop.py --check              self-test without a drag
  python dragdrop.py --auto-cancel N FILE keyboard drag cancelled after N seconds (self-test)
exit: 0 dropped, 1 cancelled, 2 error (e.g. pywin32 missing: pip install pywin32)

Nothing may outlive a drag: the synthetic button press, the keyboard hook, the attached input
queue and the cursor overrides are all undone in `finally`, and every drag has a hard deadline
after which it cancels itself, so a lost drop can never leave the system without drag & drop.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import queue
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
VK_LBUTTON, VK_RBUTTON = 0x01, 0x02
VK_RETURN, VK_ESCAPE = 0x0D, 0x1B
VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN = 0x25, 0x26, 0x27, 0x28
ARROWS = {VK_LEFT: (-1, 0), VK_RIGHT: (1, 0), VK_UP: (0, -1), VK_DOWN: (0, 1)}
SM_SWAPBUTTON = 23
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 76, 77, 78, 79
DROPEFFECT_NONE, DROPEFFECT_COPY, DROPEFFECT_MOVE = 0, 1, 2
S_OK = 0
DRAGDROP_S_DROP = 0x00040100
DRAGDROP_S_CANCEL = 0x00040101
DRAGDROP_S_USEDEFAULTCURSORS = 0x00040102
MK_LBUTTON = 0x0001
WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x0100, 0x0101, 0x0104, 0x0105
WM_DESTROY, WM_PAINT, WM_LBUTTONDOWN, WM_MOUSEACTIVATE = 0x0002, 0x000F, 0x0201, 0x0021
QS_ALLINPUT = 0x04FF
PM_REMOVE = 0x0001
MONITOR_DEFAULTTONEAREST = 2
WS_POPUP, WS_BORDER = 0x80000000, 0x00800000
WS_EX_TOPMOST, WS_EX_TOOLWINDOW = 0x00000008, 0x00000080
SW_SHOWNOACTIVATE, SW_HIDE = 4, 0
COLOR_INFOBK = 24
DT_CENTER, DT_WORDBREAK = 0x1, 0x10
TRANSPARENT = 1
WAKE_MS = 80
ARROW_FRACTION = 10          # one arrow press = 1/10 of the monitor
KEYBOARD_DEADLINE = 120.0    # s; the user has to Alt+Tab and aim, but never longer than this
MOUSE_DEADLINE = 30.0        # s; a mouse drag that long is a lost drop
MOUSE_BUTTON_WAIT = 0.4      # s; how long a mouse drag waits for the held button after the request


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
_kernel32.GetCurrentThreadId.restype = wt.DWORD
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
_user32.SetForegroundWindow.argtypes = [wt.HWND]
_user32.GetAncestor.restype = wt.HWND
_user32.GetAncestor.argtypes = [wt.HWND, wt.UINT]
_user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
_user32.GetWindowThreadProcessId.restype = wt.DWORD
_user32.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
_user32.MonitorFromPoint.restype = wt.HMONITOR
_user32.BeginPaint.restype = wt.HDC
_user32.BeginPaint.argtypes = [wt.HWND, ctypes.POINTER(_PAINTSTRUCT)]
_user32.EndPaint.argtypes = [wt.HWND, ctypes.POINTER(_PAINTSTRUCT)]
_user32.DrawTextW.argtypes = [wt.HDC, wt.LPCWSTR, ctypes.c_int, ctypes.POINTER(wt.RECT), wt.UINT]
_user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
_user32.DestroyWindow.argtypes = [wt.HWND]
_user32.UpdateWindow.argtypes = [wt.HWND]
_user32.PostThreadMessageW.argtypes = [wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM]
_kernel32.OpenProcess.restype = wt.HANDLE
_kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
_kernel32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
WM_USER = 0x0400
WM_WHISPER_ABORT = WM_USER + 7
SYNCHRONIZE = 0x00100000
INFINITE = 0xFFFFFFFF

MAIN_THREAD_ID = _kernel32.GetCurrentThreadId()


_drag_active = threading.Event()


def abort_drag(keys: "_Keys | None") -> None:
    """Emergency end of the drag in progress, independent of OLE ever asking us again: first the Esc
    flag plus a message posted to the dragging thread (OLE treats it as a lost capture), and if the
    drag is still running 1.5 s later, the process ends itself: the OS then releases the capture for
    sure. The synthetic button is released first, so nothing stays pressed. The extension restarts
    the helper on the next request."""
    if keys is not None:
        keys.escape = True
    _user32.PostThreadMessageW(MAIN_THREAD_ID, WM_WHISPER_ABORT, 0, 0)

    def hard_stop() -> None:
        time.sleep(1.5)
        if _drag_active.is_set():
            log("drag did not end after abort; ending the helper process (button released first)")
            if button_down():
                _send_mouse(MOUSEEVENTF_LEFTUP)
            for vk in (VK_ESCAPE, VK_RETURN):
                _send_key_up(vk)
            sys.stderr.flush()
            os._exit(3)
    threading.Thread(target=hard_stop, daemon=True).start()


def _process_name(pid: int) -> str:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        n = wt.DWORD(1024)
        if _kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
            return os.path.basename(buf.value)
        return ""
    finally:
        _kernel32.CloseHandle(h)


def session_locked() -> str | None:
    """A reason when no drag can work right now: the lock screen or the secure desktop is in front
    (no foreground to attach to, no input delivered). Returns None when the desktop is usable."""
    fg = foreground_window()
    if not fg:
        return "no foreground window (locked or switching desktops)"
    pid = wt.DWORD()
    _user32.GetWindowThreadProcessId(wt.HWND(fg), ctypes.byref(pid))
    name = _process_name(pid.value).lower()
    if name in ("lockapp.exe", "logonui.exe"):
        return f"the session is locked ({name} is in front)"
    return None


class _ForegroundLease:
    """Attach our input queue to the foreground thread's for the duration of a drag. Only the
    foreground thread may capture the mouse, and OLE's drag lives on that capture: without it OLE
    never sees the cursor over other windows (no drop target, no input, no way to cancel). Sharing
    the queue also lets SetForegroundWindow succeed for our status strip."""

    def __init__(self) -> None:
        self.fg = foreground_window()
        self.fg_thread = window_thread(self.fg) if self.fg else 0
        self.attached = False

    def __enter__(self) -> "_ForegroundLease":
        if self.fg_thread and self.fg_thread != MAIN_THREAD_ID:
            self.attached = bool(_user32.AttachThreadInput(MAIN_THREAD_ID, self.fg_thread, True))
        log(f"foreground {self.fg} (thread {self.fg_thread}), attached={self.attached}")
        return self

    def __exit__(self, *exc) -> None:
        if self.attached:
            _user32.AttachThreadInput(MAIN_THREAD_ID, self.fg_thread, False)
            self.attached = False


def log(msg: str) -> None:
    """Diagnostics to stderr with a timestamp (the extension shows them in its output channel)."""
    print(f"dragdrop {time.strftime('%H:%M:%S')}: {msg}", file=sys.stderr, flush=True)


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


def primary_button_vk() -> int:
    return VK_RBUTTON if _user32.GetSystemMetrics(SM_SWAPBUTTON) else VK_LBUTTON


def button_down(vk: int = 0) -> bool:
    """Is the primary button physically down right now (bit 15, not the sticky "since last call" bit)?"""
    return bool(_user32.GetAsyncKeyState(vk or primary_button_vk()) & 0x8000)


def release_stuck_keys() -> None:
    """A stuck Esc (lost key-up) cancels a drag before it starts (OLE reads fEscapePressed from the
    key state); a stuck Enter would drop at once. Send a key-up for both, clear the sticky bits."""
    for vk in (VK_ESCAPE, VK_RETURN):
        _send_key_up(vk)
    time.sleep(0.03)
    for vk in (VK_ESCAPE, VK_RETURN):
        _user32.GetAsyncKeyState(vk)


def release_stuck_button() -> None:
    """A synthetic press left behind by a killed helper keeps the button logically down and breaks
    drag & drop everywhere. Before a keyboard drag nobody should be holding it, so release it."""
    if button_down():
        log("primary button reported down before a keyboard drag: releasing it")
        _send_mouse(MOUSEEVENTF_LEFTUP)
        time.sleep(0.03)


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


def window_thread(hwnd: int) -> int:
    pid = wt.DWORD()
    return int(_user32.GetWindowThreadProcessId(wt.HWND(hwnd), ctypes.byref(pid)))


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
    """Topmost strip near the bottom of the primary monitor. It tells the user what to do and, for
    the keyboard drag, it is the window the synthetic press activates: only a foreground window
    can capture the mouse, and OLE's drag needs that capture to see the cursor over other apps."""

    CLASS = "WhisperDragStatus"
    _registered = False

    def __init__(self, text: str) -> None:
        self.text = text
        self._proc = _WNDPROC(self._wndproc)       # keep the callback alive
        hinst = _kernel32.GetModuleHandleW(None)
        if not StatusWindow._registered:
            wc = _WNDCLASSW()
            wc.lpfnWndProc = self._proc
            wc.hInstance = hinst
            wc.hbrBackground = wt.HBRUSH(COLOR_INFOBK + 1)
            wc.hCursor = _user32.LoadCursorW(None, wt.LPCWSTR(32512))
            wc.lpszClassName = self.CLASS
            _user32.RegisterClassW(ctypes.byref(wc))
            StatusWindow._registered = True
            StatusWindow._class_proc = self._proc   # the class keeps the first callback
        sw, sh = _user32.GetSystemMetrics(0), _user32.GetSystemMetrics(1)
        w, h = min(760, sw - 40), 64
        self.hwnd = _user32.CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, self.CLASS, "Whisper",
                                            WS_POPUP | WS_BORDER, (sw - w) // 2, sh - h - 72, w, h, None, None, hinst, None)
        if not self.hwnd:
            raise OSError("CreateWindowExW failed")
        StatusWindow._current = self
        _user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
        _user32.UpdateWindow(self.hwnd)

    _current: "StatusWindow | None" = None
    _class_proc = None

    @staticmethod
    def _wndproc(hwnd, msg, wparam, lparam):
        self = StatusWindow._current
        if msg == WM_PAINT and self:
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
        if StatusWindow._current is self:
            StatusWindow._current = None


# ------------------------------------------------------------------ keys, watcher, drop sources

class _Keys:
    """Enter / Esc flags set by the hook, by polling, by the watchdog or by a `cancel` command."""

    def __init__(self) -> None:
        self.enter = False
        self.escape = False
        self.hooked = False

    def poll(self) -> None:
        if _user32.GetAsyncKeyState(VK_RETURN) & 0x8001:
            self.enter = True
        if _user32.GetAsyncKeyState(VK_ESCAPE) & 0x8001:
            self.escape = True


class _KeyboardDropSource:
    """Enter drops, Esc cancels; the button is held for us by SendInput."""

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


class _MouseDropSource:
    """The user holds the button and drops by releasing it, like a drag started in Explorer. If the
    button is not down when OLE first asks, the drag is cancelled at once: waiting for a press that
    already happened would keep the capture forever."""

    _public_methods_ = ["QueryContinueDrag", "GiveFeedback"]
    _com_interfaces_ = []

    def __init__(self, keys: _Keys) -> None:
        self.keys = keys
        self.calls = 0

    def QueryContinueDrag(self, escape_pressed: int, key_state: int) -> int:  # noqa: N802
        self.calls += 1
        if escape_pressed or self.keys.escape:
            return DRAGDROP_S_CANCEL
        if key_state & MK_LBUTTON:
            return S_OK
        return DRAGDROP_S_DROP if self.calls > 1 else DRAGDROP_S_CANCEL

    def GiveFeedback(self, effect: int) -> int:  # noqa: N802
        return DRAGDROP_S_USEDEFAULTCURSORS


class _Watcher(threading.Thread):
    """Keyboard drag: keeps OLE's loop awake, follows Alt+Tab, owns the keyboard hook, and is the
    watchdog: after `deadline` seconds it cancels the drag whatever happens."""

    def __init__(self, own_hwnd: int, keys: _Keys, deadline: float, follow_foreground: bool = True) -> None:
        super().__init__(daemon=True)
        self._own = root_window(own_hwnd) if own_hwnd else 0
        self._last_fg = root_window(foreground_window())
        self._keys = keys
        self._deadline = deadline
        self._follow = follow_foreground
        self.stop = threading.Event()
        self._hook = None
        self._proc = None
        self._flag_since = 0.0

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
            log(f"hook install failed: {exc}")
            self._hook = None

    def run(self) -> None:
        self._install_hook()
        _user32.GetAsyncKeyState(VK_RETURN)          # consume "pressed since last call" bits
        _user32.GetAsyncKeyState(VK_ESCAPE)
        msg = wt.MSG()
        started = time.monotonic()
        try:
            while not self.stop.is_set():
                _user32.MsgWaitForMultipleObjects(0, None, False, WAKE_MS, QS_ALLINPUT)
                while _user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                    _user32.TranslateMessage(ctypes.byref(msg))
                    _user32.DispatchMessageW(ctypes.byref(msg))
                self._keys.poll()
                if time.monotonic() - started > self._deadline:
                    log(f"watchdog: keyboard drag exceeded {self._deadline:.0f}s, aborting")
                    abort_drag(self._keys)
                    return
                if self._keys.escape or self._keys.enter:
                    # OLE polls us only when it gets input; give it a moment, then force the end
                    if not self._flag_since:
                        self._flag_since = time.monotonic()
                    elif time.monotonic() - self._flag_since > 0.5:
                        log("OLE did not react to Esc/Enter within 0.5s, aborting the drag")
                        abort_drag(self._keys)
                        return
                if self._follow:
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
                self._keys.hooked = False


class _MouseWatchdog(threading.Thread):
    """Mouse drag: Esc cancels, and after `deadline` seconds the drag cancels itself."""

    def __init__(self, keys: _Keys, deadline: float) -> None:
        super().__init__(daemon=True)
        self._keys = keys
        self._deadline = deadline
        self.stop = threading.Event()

    def run(self) -> None:
        _user32.GetAsyncKeyState(VK_ESCAPE)
        started = time.monotonic()
        flag_since = 0.0
        while not self.stop.is_set():
            time.sleep(0.05)
            if _user32.GetAsyncKeyState(VK_ESCAPE) & 0x8001:
                self._keys.escape = True
            if self._keys.escape:
                flag_since = flag_since or time.monotonic()
                if time.monotonic() - flag_since > 0.5:
                    abort_drag(self._keys)
                    return
            if time.monotonic() - started > self._deadline:
                log(f"watchdog: mouse drag exceeded {self._deadline:.0f}s, aborting")
                abort_drag(self._keys)
                return


# ------------------------------------------------------------------ the drags

def _shell_data(paths: list[str]):
    """Shell data object for the files (CF_HDROP + IDList): exactly what Explorer offers."""
    import pythoncom
    from win32com.shell import shell

    pidls = []
    for p in paths:
        try:
            pidls.append(shell.SHParseDisplayName(p, 0)[0])
        except Exception as exc:
            log(f"cannot parse {p}: {exc}")
    if not pidls:
        return None
    items = shell.SHCreateShellItemArrayFromIDLists(pidls)
    return items.BindToHandler(None, shell.BHID_DataObject, pythoncom.IID_IDataObject)


def _effect_to_result(effect) -> str:
    if isinstance(effect, tuple):
        effect = effect[-1]
    if not effect:
        return "none"
    return "move" if effect & DROPEFFECT_MOVE else "copy"


def keyboard_drag(paths: list[str], keys: _Keys, auto_cancel: float = 0.0) -> str:
    """Blocking OLE drag driven by the keyboard; returns copy | move | none."""
    import pythoncom
    from win32com.server import util

    _KeyboardDropSource._com_interfaces_ = [pythoncom.IID_IDropSource]
    log("keyboard drag: building shell data object")
    data = _shell_data(paths)
    if data is None:
        return "none"
    log("keyboard drag: data ready, creating strip")
    names = ", ".join(os.path.basename(p) for p in paths)
    win = StatusWindow(f"Whisper táhne: {names}\n"
                       "Alt+Tab do chatu (kurzor skočí do okna), šipky posunou, Enter pustí, Esc zruší")
    source = util.wrap(_KeyboardDropSource(keys), pythoncom.IID_IDropSource)
    watcher = _Watcher(win.hwnd, keys, KEYBOARD_DEADLINE)
    lease = _ForegroundLease()
    pressed = False
    anchor = client_bottom_center(win.hwnd)
    origin = cursor_pos()
    effect = 0
    try:
        log("keyboard drag: strip shown")
        win.pump(60)
        release_stuck_keys()
        release_stuck_button()
        log("keyboard drag: keys/button clean, taking foreground")
        with lease:
            # With the queues shared our strip may take the foreground; only a foreground thread
            # can capture the mouse, and the physically-down button keeps the capture across Alt+Tab.
            _user32.SetForegroundWindow(wt.HWND(win.hwnd))
            win.pump(80)
            if anchor:
                move_cursor(*anchor)
                time.sleep(0.03)
            _send_mouse(MOUSEEVENTF_LEFTDOWN)
            pressed = True
            win.pump(150)
            if foreground_window() != win.hwnd:
                _user32.SetForegroundWindow(wt.HWND(win.hwnd))
                win.pump(80)
            if anchor:
                move_cursor(*origin)
                time.sleep(0.02)
            watcher.start()
            if auto_cancel > 0:
                threading.Timer(auto_cancel, lambda: setattr(keys, "escape", True)).start()
            started = time.monotonic()
            log(f"keyboard DoDragDrop start (foreground={'ours' if foreground_window() == win.hwnd else foreground_window()}, button={button_down()})")
            _drag_active.set()
            try:
                effect = pythoncom.DoDragDrop(data, source, DROPEFFECT_COPY | DROPEFFECT_MOVE)
            except pythoncom.com_error as exc:
                log(f"DoDragDrop raised {exc!r} after {time.monotonic() - started:.2f}s")
                raise
            finally:
                _drag_active.clear()
            elapsed = time.monotonic() - started
            log(f"keyboard DoDragDrop ended after {elapsed:.2f}s: {_effect_to_result(effect)}")
            if elapsed < 0.5:
                log("the drag did not really start (capture lost or a key was stuck)")
    finally:
        watcher.stop.set()
        watcher.join(1.0)
        if watcher._hook:                          # the thread died without unhooking
            _user32.UnhookWindowsHookEx(watcher._hook)
        end_pos = cursor_pos()
        if pressed:
            if anchor:
                move_cursor(*anchor)
                time.sleep(0.03)
            _send_mouse(MOUSEEVENTF_LEFTUP)
            if anchor:
                time.sleep(0.02)
                move_cursor(*end_pos)
        release_stuck_keys()
        win.destroy()
        if lease.fg and foreground_window() != lease.fg:
            _user32.SetForegroundWindow(wt.HWND(lease.fg))
    return _effect_to_result(effect)


def mouse_drag(paths: list[str], keys: _Keys) -> str:
    """Blocking OLE drag driven by the mouse the user is already holding; returns copy | move | none."""
    import pythoncom
    from win32com.server import util

    _MouseDropSource._com_interfaces_ = [pythoncom.IID_IDropSource]
    vk = primary_button_vk()
    _user32.GetAsyncKeyState(vk)                  # drop the sticky bit of an old click
    deadline = time.monotonic() + MOUSE_BUTTON_WAIT
    while not button_down(vk) and time.monotonic() < deadline:
        time.sleep(0.005)
    if not button_down(vk):
        log("mouse drag requested but the button is not held; nothing started")
        return "none"
    data = _shell_data(paths)
    if data is None:
        return "none"
    source = util.wrap(_MouseDropSource(keys), pythoncom.IID_IDropSource)
    # The user pressed the button in VS Code, so that thread is in the foreground; sharing its
    # input queue lets OLE's capture follow the cursor over every window.
    watchdog = _MouseWatchdog(keys, MOUSE_DEADLINE)
    effect = 0
    with _ForegroundLease():
        watchdog.start()
        _drag_active.set()
        try:
            started = time.monotonic()
            effect = pythoncom.DoDragDrop(data, source, DROPEFFECT_COPY | DROPEFFECT_MOVE)
            log(f"mouse DoDragDrop ended after {time.monotonic() - started:.2f}s: {_effect_to_result(effect)}")
        finally:
            _drag_active.clear()
            watchdog.stop.set()
    return _effect_to_result(effect)


class DragUnavailable(Exception):
    """No drag can work right now (locked session); reported instead of hanging."""


def run_drag(paths: list[str], mode: str, keys: _Keys | None = None, auto_cancel: float = 0.0) -> str:
    reason = session_locked()
    if reason:
        raise DragUnavailable(reason)
    keys = keys or _Keys()
    return mouse_drag(paths, keys) if mode == "mouse" else keyboard_drag(paths, keys, auto_cancel)


def check_pywin32() -> str | None:
    try:
        import pythoncom  # noqa: F401
        from win32com.shell import shell  # noqa: F401
        return None
    except ImportError as exc:
        return f"pywin32 is required (pip install pywin32): {exc}"


def ole_init() -> None:
    import pythoncom
    try:
        pythoncom.OleInitialize()
    except Exception:
        pass                                      # already initialised for this thread


# ------------------------------------------------------------------ persistent helper

def serve() -> int:
    """JSON lines on stdin, one reply per request on stdout. Requests:
       {"cmd":"drag","files":[...],"mode":"keyboard"|"mouse","autoCancel":N} → {"result":..,"detail":..,"id":..}
       {"cmd":"cancel"}   cancels the drag in progress (reply comes from the drag request)
       {"cmd":"ping"}     → {"result":"pong"}
       {"cmd":"exit"}     ends the helper (so does EOF on stdin)
    Startup cost (Python, pywin32, OLE) is paid once, so a drag starts within milliseconds of the
    request: the mouse drag needs that, the button is still held only briefly after the mousedown."""
    err = check_pywin32()
    if err:
        print(json.dumps({"result": "error", "detail": err}), flush=True)
        return 2
    make_dpi_aware()
    ole_init()
    requests: "queue.Queue[dict]" = queue.Queue()
    current: dict = {"keys": None}

    def reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception:
                print(json.dumps({"result": "error", "detail": "bad json"}), flush=True)
                continue
            if req.get("cmd") == "cancel":
                if current["keys"] is not None:
                    log("cancel requested")
                    abort_drag(current["keys"])
                continue
            requests.put(req)
        # EOF: the extension is gone; end a running drag and leave
        if current["keys"] is not None:
            abort_drag(current["keys"])
        requests.put({"cmd": "exit"})

    threading.Thread(target=reader, daemon=True).start()
    parent = int(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--parent=")), "0") or 0)
    if parent:
        # the extension host died without closing our stdin (killed, crashed): do not outlive it
        def watch_parent() -> None:
            h = _kernel32.OpenProcess(SYNCHRONIZE, False, parent)
            if not h:
                return
            _kernel32.WaitForSingleObject(h, INFINITE)
            log(f"parent {parent} is gone, exiting")
            if current["keys"] is not None:
                abort_drag(current["keys"])
                time.sleep(1.0)
            os._exit(0)
        threading.Thread(target=watch_parent, daemon=True).start()
    print(json.dumps({"result": "ready"}), flush=True)
    while True:
        req = requests.get()
        cmd = req.get("cmd")
        if cmd == "exit":
            return 0
        if cmd == "ping":
            print(json.dumps({"result": "pong", "id": req.get("id")}), flush=True)
            continue
        if cmd != "drag":
            print(json.dumps({"result": "error", "detail": f"unknown command {cmd}", "id": req.get("id")}), flush=True)
            continue
        files = [os.path.abspath(p) for p in req.get("files", [])]
        missing = [p for p in files if not os.path.exists(p)]
        if not files or missing:
            print(json.dumps({"result": "error", "detail": f"file not found: {', '.join(missing) or '(none given)'}", "id": req.get("id")}), flush=True)
            continue
        keys = _Keys()
        current["keys"] = keys
        started = time.monotonic()
        try:
            result = run_drag(files, req.get("mode", "keyboard"), keys, float(req.get("autoCancel", 0) or 0))
            detail = ""
        except DragUnavailable as exc:
            log(f"drag unavailable: {exc}")
            result, detail = "error", str(exc)
        except Exception as exc:                  # never let one failed drag kill the helper
            log(f"drag failed: {exc!r}")
            result, detail = "error", repr(exc)
        finally:
            current["keys"] = None
        print(json.dumps({"result": result, "detail": detail, "id": req.get("id"), "ms": int((time.monotonic() - started) * 1000)}), flush=True)


# ------------------------------------------------------------------ self-tests

def selftest_mouse(path: str) -> bool:
    """Mouse-driven drag without a user: our own strip (no drop target registered, so nothing is
    ever dropped anywhere), cursor over it, synthetic press, mouse_drag(), synthetic release after
    a second. Passes when DoDragDrop ran about that long and ended on the release."""
    win = StatusWindow("Whisper: samotest myšího tažení")
    try:
        win.pump(100)
        c = window_center(win.hwnd)
        if not c:
            return False
        move_cursor(*c)
        time.sleep(0.05)
        _send_mouse(MOUSEEVENTF_LEFTDOWN)
        win.pump(150)

        def release() -> None:
            time.sleep(1.0)
            move_cursor(c[0] + 5, c[1] + 5)
            time.sleep(0.05)
            _send_mouse(MOUSEEVENTF_LEFTUP)
        threading.Thread(target=release, daemon=True).start()
        started = time.monotonic()
        result = mouse_drag([path], _Keys())
        elapsed = time.monotonic() - started
        log(f"selftest-mouse: {result} after {elapsed:.2f}s")
        return result == "none" and 0.8 <= elapsed <= 3.0
    finally:
        if button_down():
            _send_mouse(MOUSEEVENTF_LEFTUP)
        win.destroy()


# ------------------------------------------------------------------ CLI

def main(argv: list[str]) -> int:
    args = argv[1:]
    if "--selftest-mouse" in args:
        err = check_pywin32()
        if err:
            print(f"dragdrop: {err}", file=sys.stderr)
            return 2
        if session_locked():
            print(f"dragdrop: {session_locked()}", file=sys.stderr)
            return 2
        make_dpi_aware()
        ole_init()
        ok = selftest_mouse(os.path.abspath(__file__))
        print("ok" if ok else "failed")
        return 0 if ok else 1
    if "--serve" in args:
        try:
            return serve()
        finally:
            # whatever happened, never leave the button logically pressed behind us
            if button_down():
                _send_mouse(MOUSEEVENTF_LEFTUP)
    check = "--check" in args
    mouse = "--mouse" in args
    auto_cancel = 0.0
    if "--auto-cancel" in args:
        i = args.index("--auto-cancel")
        auto_cancel = float(args[i + 1])
        del args[i:i + 2]
    args = [a for a in args if not a.startswith("--")]
    paths = [os.path.abspath(p) for p in args]
    if not paths and not check:
        print(__doc__.strip().split("\n\n")[0], file=sys.stderr)
        return 2
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        print(f"dragdrop: file not found: {', '.join(missing)}", file=sys.stderr)
        return 2
    err = check_pywin32()
    if err:
        print(f"dragdrop: {err}", file=sys.stderr)
        return 2
    make_dpi_aware()
    ole_init()
    if check:
        win = StatusWindow("Whisper: kontrola (bez tažení)")
        try:
            win.pump(60)
            release_stuck_keys()
            win.pump(200)
        finally:
            win.destroy()
        print("ok")
        return 0
    try:
        result = run_drag(paths, "mouse" if mouse else "keyboard", auto_cancel=auto_cancel)
    except DragUnavailable as exc:
        print(f"dragdrop: {exc}", file=sys.stderr)
        return 2
    print(result)
    return 0 if result in ("copy", "move") else 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as exc:  # any Win32/COM failure: report, never hang
        print(f"dragdrop: {exc}", file=sys.stderr)
        sys.exit(2)
