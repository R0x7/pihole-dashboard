import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/contract'
import { createDesktopPin, type DesktopPin } from './desktopPin'
import { registerIpc, type IpcController } from './ipc'
import { createElectronSettingsStore } from './settingsElectron'
import { createTrayIcon } from './trayIcon'
import {
  initialBounds,
  loadWindowState,
  MIN_SIZE,
  saveWindowState,
  type WindowState
} from './windowState'

const devUrl = process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null
let ipc: IpcController | null = null
let pin: DesktopPin | null = null
let tray: Tray | null = null
let windowState: WindowState = { bounds: null, pinned: true }

const windowStatePath = (): string => join(app.getPath('userData'), 'window-state.json')

/** Pinned only counts once the native helper is up; until then the widget floats. */
const isPinned = (): boolean => windowState.pinned && pin !== null && pin.available

function createWindow(): void {
  windowState = loadWindowState(windowStatePath())
  const bounds = initialBounds(
    windowState.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea
  )

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    // A widget, not an app window: no title bar, and no taskbar button while pinned.
    frame: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: windowState.pinned,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12151a' : '#f4f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = win

  let shown = false
  let pinReady = false
  const showWhenReady = (): void => {
    if (!shown || !pinReady || win.isDestroyed()) return
    applyPinned()
    // A pinned widget appears quietly; it should not take focus at sign-in.
    if (isPinned()) win.showInactive()
    else win.show()
  }
  win.once('ready-to-show', () => {
    shown = true
    showWhenReady()
  })
  void createDesktopPin(win).then((created) => {
    if (win.isDestroyed()) {
      created.dispose()
      return
    }
    pin = created
    pinReady = true
    showWhenReady()
  })

  const rememberBounds = (): void => {
    windowState.bounds = win.getNormalBounds()
    saveWindowState(windowStatePath(), windowState)
  }
  win.on('moved', rememberBounds)
  win.on('resized', rememberBounds)
  // Show Desktop and Win+M must not tuck a pinned widget away.
  win.on('minimize', () => {
    if (isPinned()) win.restore()
  })
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = null
    pin?.dispose()
    pin = null
  })

  // The app is a single page: never open new windows, never navigate away.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const blockNavigation = (event: Electron.Event, url: string): void => {
    // Allow only the dev server reloading itself (vite full-page reload).
    if (devUrl && sameOrigin(url, devUrl)) return
    event.preventDefault()
  }
  win.webContents.on('will-navigate', blockNavigation)
  win.webContents.on('will-redirect', blockNavigation)
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** Bring the window and tray in line with windowState.pinned. */
function applyPinned(): void {
  const win = mainWindow
  if (!win || !pin) return
  const pinned = isPinned()
  win.setSkipTaskbar(pinned)
  win.setMinimizable(!pinned)
  pin.setPinned(pinned)
  tray?.setContextMenu(buildMenu())
}

function setPinned(pinned: boolean): void {
  windowState.pinned = pinned
  saveWindowState(windowStatePath(), windowState)
  applyPinned()
  // Unpinning should be visible straight away, not leave the window buried.
  if (!pinned) bringToFront()
}

function bringToFront(): void {
  const win = mainWindow
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (pin) pin.peek()
  else {
    win.show()
    win.focus()
  }
}

/** Shared by the tray icon and the widget's own menu button. */
function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Bring to front', click: bringToFront },
    { type: 'separator' },
    {
      label: 'Pin to desktop',
      type: 'checkbox',
      checked: isPinned(),
      enabled: pin !== null && pin.available,
      click: (item) => setPinned(item.checked)
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      // A development run would register the bare Electron binary.
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
        tray?.setContextMenu(buildMenu())
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Pi-hole Dashboard')
  tray.setContextMenu(buildMenu())
  tray.on('click', bringToFront)
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', bringToFront)

  void app.whenReady().then(() => {
    // The renderer needs no camera, notifications, etc.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    )

    // IPC must be registered before the window starts loading.
    ipc = registerIpc(createElectronSettingsStore(), { isTrustedSender })
    ipcMain.on(IPC.showMenu, (event) => {
      if (!isTrustedSender(event) || !mainWindow) return
      buildMenu().popup({ window: mainWindow })
    })
    createTray()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Free the Pi-hole API session on quit, but never let that hold the quit up.
  let loggedOut = false
  app.on('before-quit', (event) => {
    if (loggedOut || !ipc) return
    event.preventDefault()
    loggedOut = true
    void ipc.shutdown(1500).finally(() => app.quit())
  })
  app.on('will-quit', () => {
    tray?.destroy()
    tray = null
  })
}
