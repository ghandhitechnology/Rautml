import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  session,
  shell,
  utilityProcess,
} from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devUrl = process.env.RAUTML_DEV_URL || ''
let mainWindow = null
let engine = null
let engineOrigin = ''
let quitting = false

app.setName('Rautml')

function loginShellEnvironment() {
  if (process.platform !== 'darwin') return {}
  try {
    const loginShell = process.env.SHELL || '/bin/zsh'
    const raw = execFileSync(loginShell, ['-ilc', 'env -0'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return Object.fromEntries(
      raw
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=')
          return separator > 0 ? [entry.slice(0, separator), entry.slice(separator + 1)] : [entry, '']
        }),
    )
  } catch {
    return {}
  }
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = address && typeof address === 'object' ? address.port : 0
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForEngine(origin) {
  let lastError = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/chats`)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
  throw lastError || new Error('The local engine did not become ready.')
}

async function startEngine() {
  if (engine && engineOrigin) return engineOrigin

  const port = await freeLoopbackPort()
  const appRoot = app.getAppPath()
  const userData = app.getPath('userData')
  const dataDir = path.join(userData, 'data')
  const cacheDir = path.join(userData, 'model-cache')
  const envPath = path.join(userData, '.env')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })

  const inherited = { ...loginShellEnvironment(), ...process.env }
  const developmentEnv = path.join(appRoot, '.env')
  const developmentData = path.join(appRoot, 'server', 'data')
  if (!app.isPackaged && existsSync(developmentEnv) && !existsSync(envPath)) {
    copyFileSync(developmentEnv, envPath)
  }
  if (
    !app.isPackaged &&
    existsSync(developmentData) &&
    !existsSync(path.join(dataDir, 'rautml.db'))
  ) {
    cpSync(developmentData, dataDir, { recursive: true })
  }
  const serverEntry = path.join(appRoot, 'server', 'dist', 'index.js')
  const webDist = path.join(appRoot, 'web', 'dist')
  engine = utilityProcess.fork(serverEntry, [], {
    cwd: userData,
    serviceName: 'Rautml Engine',
    stdio: 'pipe',
    env: {
      ...inherited,
      HOST: '127.0.0.1',
      PORT: String(port),
      RAUTML_DATA_DIR: dataDir,
      RAUTML_CACHE_DIR: cacheDir,
      RAUTML_ENV_PATH: existsSync(envPath) ? envPath : developmentEnv,
      RAUTML_WEB_DIST: webDist,
    },
  })

  engine.stdout?.on('data', (chunk) => process.stdout.write(`[engine] ${chunk}`))
  engine.stderr?.on('data', (chunk) => process.stderr.write(`[engine] ${chunk}`))
  engine.on('exit', (code) => {
    engine = null
    engineOrigin = ''
    if (quitting || code === 0) return
    void dialog.showMessageBox({
      type: 'error',
      title: 'Rautml engine stopped',
      message: 'The local engine exited unexpectedly.',
      detail: `Exit code: ${code ?? 'unknown'}`,
    })
  })

  const origin = `http://127.0.0.1:${port}`
  await waitForEngine(origin)
  engineOrigin = origin
  return origin
}

function installApplicationMenu() {
  const template = [
    {
      label: 'Rautml',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Open Configuration Folder',
          click: () => void shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(devUrl ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  const origin = devUrl || (await startEngine())
  const preload = path.join(__dirname, 'preload.cjs')
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5'

  mainWindow = new BrowserWindow({
    title: 'Rautml',
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    fullscreenable: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  await mainWindow.loadURL(origin)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.whenReady().then(async () => {
    installApplicationMenu()
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    try {
      await createWindow()
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Rautml could not start',
        message: 'The local application engine could not be started.',
        detail: error instanceof Error ? error.stack || error.message : String(error),
      })
      app.quit()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('before-quit', () => {
  quitting = true
  engine?.kill()
  engine = null
  engineOrigin = ''
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
