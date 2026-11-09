/**
 * Keeps a window "on the desktop": directly above the desktop icon layer and
 * below every other window, like a desktop gadget.
 *
 * Electron has no API for this, so it talks to user32 through koffi:
 *
 * - WM_WINDOWPOSCHANGING is rewritten so every z-order change lands directly
 *   above the desktop (a click activates the window without raising it).
 * - A foreground-change hook re-seats the window whenever another window is
 *   activated. Show Desktop (Win+D) works by raising the desktop window above
 *   everything; re-seating just above it keeps the widget visible there.
 *
 * Windows only. Everywhere else, or if koffi cannot load, `available` is
 * false and the calls do nothing (the window simply floats).
 */
import type { BrowserWindow } from 'electron'

export interface DesktopPin {
  /** False when native pinning could not be set up. */
  readonly available: boolean
  setPinned(pinned: boolean): void
  /** Bring the window in front of everything until it loses focus. */
  peek(): void
  dispose(): void
}

const WM_WINDOWPOSCHANGING = 0x0046
const SWP_NOZORDER = 0x0004
const HWND_TOP = 0n
const HWND_BOTTOM = 1n
const GW_HWNDPREV = 3
const EVENT_SYSTEM_FOREGROUND = 0x0003
const WINEVENT_OUTOFCONTEXT = 0x0000
const WINEVENT_SKIPOWNPROCESS = 0x0002
// Offsets into WINDOWPOS on 64-bit Windows.
const WINDOWPOS_INSERT_AFTER = 8
const WINDOWPOS_FLAGS = 32

type Handle = number | bigint

function floatingOnly(win: BrowserWindow): DesktopPin {
  return {
    available: false,
    setPinned: () => {},
    peek: () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    },
    dispose: () => {}
  }
}

export async function createDesktopPin(win: BrowserWindow): Promise<DesktopPin> {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    return floatingOnly(win)
  }
  try {
    const koffi = (await import('koffi')).default
    if (win.isDestroyed()) return floatingOnly(win)
    return createWin32Pin(win, koffi)
  } catch {
    return floatingOnly(win)
  }
}

type Koffi = (typeof import('koffi'))['default']

function createWin32Pin(win: BrowserWindow, koffi: Koffi): DesktopPin {
  const user32 = koffi.load('user32.dll')
  const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)')
  const FindWindowExW = user32.func(
    'intptr_t __stdcall FindWindowExW(intptr_t hWndParent, intptr_t hWndChildAfter, str16 lpszClass, str16 lpszWindow)'
  )
  const WinEventProc = koffi.proto(
    'void __stdcall PiholeWinEventProc(intptr_t hook, uint32_t event, intptr_t hwnd, int32_t idObject, int32_t idChild, uint32_t thread, uint32_t time)'
  )
  const SetWinEventHook = user32.func(
    'intptr_t __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, intptr_t hmod, PiholeWinEventProc *proc, uint32_t idProcess, uint32_t idThread, uint32_t dwFlags)'
  )
  const UnhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(intptr_t hook)')

  const self = win.getNativeWindowHandle().readBigUInt64LE(0)
  const find = (parent: bigint, after: bigint, cls: string): bigint =>
    BigInt(FindWindowExW(parent, after, cls, null) as Handle)
  const above = (hwnd: bigint): bigint => BigInt(GetWindow(hwnd, GW_HWNDPREV) as Handle)

  /** The top-level window that hosts the desktop icons. */
  function findDesktop(): bigint {
    const progman = find(0n, 0n, 'Progman')
    if (progman !== 0n && find(progman, 0n, 'SHELLDLL_DefView') !== 0n) return progman
    // Older builds move the icons into a WorkerW sibling.
    let worker = 0n
    for (let i = 0; i < 64; i++) {
      worker = find(0n, worker, 'WorkerW')
      if (worker === 0n) break
      if (find(worker, 0n, 'SHELLDLL_DefView') !== 0n) return worker
    }
    return progman
  }

  /** The window ours should sit directly below: whatever is just above the desktop. */
  function insertAfter(): bigint {
    const desktop = findDesktop()
    if (desktop === 0n) return HWND_BOTTOM
    let prev = above(desktop)
    if (prev === self) prev = above(self)
    return prev === 0n ? HWND_TOP : prev
  }

  let pinned = false
  let peeking = false
  let disposed = false
  let settle: NodeJS.Timeout[] = []

  const holding = (): boolean => pinned && !peeking && !disposed && !win.isDestroyed()

  /**
   * Ask for a z-order change and let the message hook below turn it into
   * "directly above the desktop". This deliberately goes through Electron
   * rather than calling SetWindowPos with koffi: the hook runs JavaScript
   * synchronously inside that call, which crashes when the call is being
   * made on koffi's own call stack.
   */
  function seat(): void {
    if (holding()) win.moveTop()
  }

  // Runs inside the window procedure, before Windows applies the change.
  win.hookWindowMessage(WM_WINDOWPOSCHANGING, (_wParam, lParam) => {
    if (!holding()) return
    try {
      const pos = lParam.readBigUInt64LE(0)
      if (pos === 0n) return
      const flags = koffi.decode(pos, WINDOWPOS_FLAGS, 'uint32_t') as number
      koffi.encode(pos, WINDOWPOS_INSERT_AFTER, 'intptr_t', insertAfter())
      koffi.encode(pos, WINDOWPOS_FLAGS, 'uint32_t', (flags & ~SWP_NOZORDER) >>> 0)
    } catch {
      // Leave the message untouched rather than risk a bad write.
    }
  })

  // Another application's window came to the foreground.
  const onForeground = koffi.register(() => {
    peeking = false
    if (!holding()) return
    seat()
    // Show Desktop raises the desktop a moment after this event; seat again
    // once it has (measured at roughly 100-150 ms).
    settle.forEach(clearTimeout)
    settle = [setTimeout(seat, 200), setTimeout(seat, 700)]
  }, koffi.pointer(WinEventProc))
  const hook = BigInt(
    SetWinEventHook(
      EVENT_SYSTEM_FOREGROUND,
      EVENT_SYSTEM_FOREGROUND,
      0,
      onForeground,
      0,
      0,
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
    ) as Handle
  )

  const onBlur = (): void => {
    if (!peeking) return
    peeking = false
    seat()
  }
  win.on('blur', onBlur)

  return {
    available: true,
    setPinned(next: boolean): void {
      pinned = next
      peeking = false
      seat()
    },
    peek(): void {
      if (disposed || win.isDestroyed()) return
      peeking = pinned
      win.show()
      win.moveTop()
      // Windows may refuse the focus; the peek then ends on the next
      // foreground change instead of on blur.
      win.focus()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      settle.forEach(clearTimeout)
      if (hook !== 0n) UnhookWinEvent(hook)
      koffi.unregister(onForeground)
      if (!win.isDestroyed()) {
        win.off('blur', onBlur)
        win.unhookWindowMessage(WM_WINDOWPOSCHANGING)
      }
    }
  }
}
