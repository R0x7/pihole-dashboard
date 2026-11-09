import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { join } from 'node:path'
import { registerIpc, type IpcController } from './ipc'
import { createElectronSettingsStore } from './settingsElectron'

const devUrl = process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null
let ipc: IpcController | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12151a' : '#f4f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    // The renderer needs no camera, notifications, etc.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    )

    // IPC must be registered before the window starts loading.
    ipc = registerIpc(createElectronSettingsStore(), {
      isTrustedSender: (event) =>
        mainWindow !== null &&
        event.sender === mainWindow.webContents &&
        event.senderFrame === mainWindow.webContents.mainFrame
    })
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
}
