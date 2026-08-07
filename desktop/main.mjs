import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell,
  utilityProcess,
} from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devUrl = process.env.RAUTML_DEV_URL || ''
let mainWindow = null
let mainWindowOrigin = ''
let engine = null
let engineOrigin = ''
let engineStarting = null
let windowOpening = null
let hasBootedOnce = false
let crashRecovery = null
let quitting = false
const expectedEngineStops = new WeakSet()
const engineKillTimers = new Map()
let engineIdleTimer = null
let engineIdleSince = 0

const ENGINE_IDLE_CHECK_MS = 30_000
// A busy or unreachable engine is stopped anyway once it has been windowless
// this long, so the idle-stop loop cannot keep a wedged engine alive forever.
const ENGINE_IDLE_MAX_AGE_MS = 4 * 60 * 60 * 1000
const ENGINE_BOOT_POLL_INTERVAL_MS = 125
const ENGINE_BOOT_TIMEOUT_MS = 10_000
const ENGINE_SIGKILL_ESCALATION_MS = 3_000
const ENGINE_RESTART_BACKOFF_MS = 1_000
const ENGINE_MAX_RESTART_TRIES = 2
// freeLoopbackPort() only proves a port was free at probe time; an engine that
// dies this quickly after spawn with EADDRINUSE lost the race, so boot retries
// once with a fresh port.
const ENGINE_PORT_RACE_WINDOW_MS = 1_000
const ENGINE_STDERR_TAIL_CHARS = 4_096
const ENGINE_LOG_MAX_BYTES = 1024 * 1024
const ENGINE_LOAD_RETRY_DELAY_MS = 1_000
const PDF_RESOURCE_WAIT_MS = 5_000
const PDF_IMAGE_FALLBACK_WAIT_MS = 4_000
const MAX_PDF_HTML_BYTES = 50 * 1024 * 1024
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/
const RELEASES_URL = 'https://github.com/ghandhitechnology/Rautml/releases/latest'

app.setName('Rautml')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Engine log — userData/logs/engine.log, rotated at ~1 MB with one old file.
// ---------------------------------------------------------------------------

let engineLogStream = null
let engineLogBytes = 0

function engineLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'engine.log')
}

function openEngineLog() {
  if (engineLogStream) return engineLogStream
  try {
    const logPath = engineLogPath()
    mkdirSync(path.dirname(logPath), { recursive: true })
    engineLogBytes = existsSync(logPath) ? statSync(logPath).size : 0
    engineLogStream = createWriteStream(logPath, { flags: 'a' })
    engineLogStream.on('error', () => {
      // Logging must never take the app down.
      engineLogStream = null
    })
  } catch {
    engineLogStream = null
  }
  return engineLogStream
}

function rotateEngineLog() {
  try {
    engineLogStream?.end()
    engineLogStream = null
    renameSync(engineLogPath(), `${engineLogPath()}.old`)
  } catch {
    // Keeping one old file is best-effort.
  }
  engineLogBytes = 0
}

function writeEngineLog(chunk) {
  const stream = openEngineLog()
  if (!stream) return
  stream.write(chunk)
  engineLogBytes += chunk.length
  if (engineLogBytes > ENGINE_LOG_MAX_BYTES) rotateEngineLog()
}

function logEngineEvent(message) {
  writeEngineLog(`[${new Date().toISOString()}] ${message}\n`)
}

process.on('uncaughtException', (error) => {
  logEngineEvent(`main process uncaughtException: ${error?.stack || error}`)
})
process.on('unhandledRejection', (reason) => {
  logEngineEvent(`main process unhandledRejection: ${reason?.stack || reason}`)
})

async function renderDocumentPdf(html) {
  const tempDirectory = await mkdtemp(path.join(app.getPath('temp'), 'rautml-pdf-'))
  const htmlPath = path.join(tempDirectory, 'document.html')
  const printWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 960,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  printWindow.webContents.on('will-navigate', (event) => {
    // The export document is a temporary local file, so no navigation (links,
    // meta refresh) is ever legitimate. Remote <img> resources still load —
    // they are fetches, not navigations — which keeps export fidelity.
    event.preventDefault()
  })

  try {
    await writeFile(htmlPath, html, 'utf8')
    await printWindow.loadFile(htmlPath)

    const resourcesReady = printWindow.webContents.executeJavaScript(`
      Promise.all([
        document.fonts?.ready ?? Promise.resolve(),
        Promise.all(Array.from(document.images, (image) => {
          if (image.complete) return Promise.resolve()
          return new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', resolve, { once: true })
            window.setTimeout(resolve, ${PDF_IMAGE_FALLBACK_WAIT_MS})
          })
        })),
      ])
    `)
    await Promise.race([resourcesReady.catch(() => undefined), delay(PDF_RESOURCE_WAIT_MS)])

    const pdf = await printWindow.webContents.printToPDF({
      pageSize: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
    })
    return Uint8Array.from(pdf).buffer
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy()
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

ipcMain.handle('rautml:render-pdf', (event, html) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('PDF export is only available from the Rautml window.')
  }
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_PDF_HTML_BYTES) {
    throw new Error('This document is too large to export as a PDF.')
  }
  return renderDocumentPdf(html)
})

ipcMain.handle('rautml:retry-boot', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || devUrl) {
    return { ok: false, error: 'Boot retry is only available from the Rautml window.' }
  }
  try {
    const origin = await startEngine()
    mainWindowOrigin = origin
    // Navigate without awaiting: the reply must reach the boot page before the
    // navigation tears its context down. did-fail-load covers a failed load.
    void mainWindow.loadURL(origin).catch((error) => {
      logEngineEvent(`boot retry load failed: ${error?.message || error}`)
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

let loginShellEnvironmentCache = null

function loginShellEnvironment() {
  if (process.platform !== 'darwin') return {}
  // The login shell runs once per app run; spawning it on every engine start
  // (crash recovery, retry) would add seconds to each boot.
  if (loginShellEnvironmentCache) return loginShellEnvironmentCache
  try {
    const loginShell = process.env.SHELL || '/bin/zsh'
    const raw = execFileSync(loginShell, ['-ilc', 'env -0'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    loginShellEnvironmentCache = Object.fromEntries(
      raw
        .split('\0')
        .filter((entry) => ENV_NAME_PATTERN.test(entry))
        .map((entry) => {
          const separator = entry.indexOf('=')
          return [entry.slice(0, separator), entry.slice(separator + 1)]
        }),
    )
  } catch {
    loginShellEnvironmentCache = {}
  }
  return loginShellEnvironmentCache
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

async function waitForEngine(child, origin) {
  let onExit
  const exited = new Promise((_, reject) => {
    onExit = (code, signal) => {
      reject(
        new Error(
          `The local engine exited during startup (code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}).`,
        ),
      )
    }
    child.once('exit', onExit)
  })
  // The exit handler below races against readiness; a settled loss must never
  // surface as an unhandled rejection when readiness wins.
  exited.catch(() => {})
  let lastFailure = ''
  const deadline = Date.now() + ENGINE_BOOT_TIMEOUT_MS
  try {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/api/health`)
        if (response.ok) return
        lastFailure = `HTTP ${response.status}`
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error)
      }
      await Promise.race([delay(ENGINE_BOOT_POLL_INTERVAL_MS), exited])
    }
    const detail = lastFailure ? ` Last response: ${lastFailure}.` : ''
    throw new Error(
      `The local engine did not become ready within ${Math.round(ENGINE_BOOT_TIMEOUT_MS / 1000)}s.${detail}`,
    )
  } finally {
    child.removeListener('exit', onExit)
  }
}

async function startEngine() {
  if (engine && engineOrigin) return engineOrigin
  // Every entry point shares one in-flight boot, so a second-instance or
  // activate arriving mid-boot cannot spawn a second engine over the same
  // SQLite database and orphan the first.
  if (engineStarting) return engineStarting
  engineStarting = bootEngine()
  try {
    return await engineStarting
  } finally {
    engineStarting = null
  }
}

async function bootEngine() {
  try {
    return await bootEngineOnce()
  } catch (error) {
    if (!error?.addressInUse) throw error
    logEngineEvent('engine lost a port race during boot; retrying with a fresh port')
    return bootEngineOnce()
  }
}

async function bootEngineOnce() {
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
  const child = utilityProcess.fork(serverEntry, [], {
    cwd: userData,
    serviceName: 'Rautml Engine',
    stdio: 'pipe',
    env: {
      ...inherited,
      HOST: '127.0.0.1',
      PORT: String(port),
      RAUTML_DATA_DIR: dataDir,
      RAUTML_CACHE_DIR: cacheDir,
      // Packaged builds always use the writable userData env file: dotenv
      // no-ops while it is missing and writeKeys() creates it atomically, so
      // the first API-key save on a fresh install must not target the asar.
      RAUTML_ENV_PATH: app.isPackaged ? envPath : existsSync(envPath) ? envPath : developmentEnv,
      RAUTML_WEB_DIST: webDist,
    },
  })
  engine = child
  const spawnedAt = Date.now()
  let stderrTail = ''

  logEngineEvent(`engine spawned (pid ${child.pid ?? 'unknown'}, port ${port})`)
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(`[engine] ${chunk}`)
    writeEngineLog(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[engine] ${chunk}`)
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-ENGINE_STDERR_TAIL_CHARS)
    writeEngineLog(chunk)
  })
  child.on('exit', (code, signal) => {
    clearSigkillTimer(child)
    logEngineEvent(`engine exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`)
    if (engine === child) {
      engine = null
      engineOrigin = ''
    }
    if (quitting || expectedEngineStops.has(child) || code === 0) return
    // Startup failures are reported by the boot path; the exit handler only
    // acts once an engine has served a successful boot.
    if (!hasBootedOnce) return
    void recoverFromCrash(code).catch((error) => {
      logEngineEvent(`crash recovery failed: ${error?.stack || error}`)
    })
  })

  const origin = `http://127.0.0.1:${port}`
  try {
    await waitForEngine(child, origin)
  } catch (error) {
    // A wedged or crashed child must not linger after a failed boot.
    terminateEngine(child)
    if (
      Date.now() - spawnedAt < ENGINE_PORT_RACE_WINDOW_MS &&
      /eaddrinuse|address already in use/i.test(stderrTail)
    ) {
      error.addressInUse = true
    }
    throw error
  }
  engineOrigin = origin
  hasBootedOnce = true
  logEngineEvent(`engine ready at ${origin}`)
  return origin
}

async function recoverFromCrash(code) {
  if (crashRecovery) return crashRecovery
  crashRecovery = (async () => {
    for (let attempt = 1; attempt <= ENGINE_MAX_RESTART_TRIES; attempt += 1) {
      await delay(ENGINE_RESTART_BACKOFF_MS * attempt)
      if (quitting) return
      try {
        const origin = await startEngine()
        logEngineEvent(`engine restarted after crash (attempt ${attempt})`)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindowOrigin = origin
          await mainWindow.loadURL(origin)
        }
        return
      } catch (error) {
        logEngineEvent(`engine restart attempt ${attempt} failed: ${error?.message || error}`)
      }
    }
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Rautml engine stopped',
      message: 'The local engine stopped and could not be restarted.',
      detail: `Exit code: ${code ?? 'unknown'}`,
      buttons: ['Relaunch', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      app.relaunch()
      app.exit(0)
    } else {
      app.quit()
    }
  })()
  try {
    await crashRecovery
  } finally {
    crashRecovery = null
  }
}

function armSigkillTimer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const timer = setTimeout(() => {
    engineKillTimers.delete(child)
    if (child.exitCode === null && child.signalCode === null) {
      logEngineEvent('engine ignored SIGTERM; escalating to SIGKILL')
      child.kill('SIGKILL')
    }
  }, ENGINE_SIGKILL_ESCALATION_MS)
  timer.unref?.()
  engineKillTimers.set(child, timer)
}

function clearSigkillTimer(child) {
  const timer = engineKillTimers.get(child)
  if (timer) clearTimeout(timer)
  engineKillTimers.delete(child)
}

function terminateEngine(child) {
  expectedEngineStops.add(child)
  child.kill()
  armSigkillTimer(child)
  if (engine === child) {
    engine = null
    engineOrigin = ''
  }
}

function stopEngine() {
  cancelIdleEngineStop()
  const child = engine
  if (!child) return
  terminateEngine(child)
}

function cancelIdleEngineStop() {
  if (engineIdleTimer) clearTimeout(engineIdleTimer)
  engineIdleTimer = null
  engineIdleSince = 0
}

function scheduleIdleEngineStop() {
  if (engineIdleTimer) clearTimeout(engineIdleTimer)
  if (!engine || !engineOrigin || BrowserWindow.getAllWindows().length > 0) {
    engineIdleSince = 0
    return
  }
  if (!engineIdleSince) engineIdleSince = Date.now()
  engineIdleTimer = setTimeout(async () => {
    engineIdleTimer = null
    if (!engine || !engineOrigin || BrowserWindow.getAllWindows().length > 0) {
      engineIdleSince = 0
      return
    }
    // Busy or failed checks reschedule only until the engine has been
    // windowless for ENGINE_IDLE_MAX_AGE_MS; past that it is stopped anyway.
    const expired = Date.now() - engineIdleSince >= ENGINE_IDLE_MAX_AGE_MS
    try {
      const response = await fetch(`${engineOrigin}/api/health`)
      const health = response.ok ? await response.json() : { busy: true }
      if (health?.busy && !expired) {
        scheduleIdleEngineStop()
        return
      }
      stopEngine()
    } catch {
      // A failed health check is not proof that a generation is safe to stop —
      // unless the cap above has expired, in which case the engine is wedged.
      if (!expired) {
        scheduleIdleEngineStop()
        return
      }
      stopEngine()
    }
  }, ENGINE_IDLE_CHECK_MS)
  engineIdleTimer.unref?.()
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readWindowState() {
  try {
    const state = JSON.parse(readFileSync(windowStatePath(), 'utf8'))
    const { width, height, x, y } = state ?? {}
    if (![width, height, x, y].every(Number.isFinite) || width < 400 || height < 300) return null
    // Restore only when the saved frame is at least partly on a known screen.
    const onScreen = screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return (
        x < area.x + area.width &&
        x + width > area.x &&
        y < area.y + area.height &&
        y + height > area.y
      )
    })
    return onScreen ? { width, height, x, y } : null
  } catch {
    return null
  }
}

function saveWindowState(window) {
  try {
    if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return
    writeFileSync(windowStatePath(), JSON.stringify(window.getBounds()))
  } catch {
    // Losing the saved frame only means the next launch uses defaults.
  }
}

let updateFeedbackWanted = false

function wireAutoUpdater() {
  if (!app.isPackaged) return
  autoUpdater.on('update-available', (info) => {
    logEngineEvent(`update available: ${info?.version ?? 'unknown'}`)
    if (!updateFeedbackWanted) return
    void dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Rautml ${info?.version ?? ''} is available.`,
      detail: 'The update is downloading and will be installed when you quit Rautml.',
    })
  })
  autoUpdater.on('update-not-available', () => {
    if (!updateFeedbackWanted) return
    updateFeedbackWanted = false
    void dialog.showMessageBox({
      type: 'info',
      title: 'Rautml is up to date',
      message: `Rautml ${app.getVersion()} is the latest version.`,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    logEngineEvent(`update downloaded: ${info?.version ?? 'unknown'}`)
    if (!updateFeedbackWanted) return
    updateFeedbackWanted = false
    void dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'The update has been downloaded and will be installed when you quit Rautml.',
    })
  })
  autoUpdater.on('error', (error) => {
    logEngineEvent(`auto-update error: ${error?.message || error}`)
    if (!updateFeedbackWanted) return
    updateFeedbackWanted = false
    void dialog.showMessageBox({
      type: 'error',
      title: 'Update check failed',
      message: 'Rautml could not check for updates.',
      detail: error instanceof Error ? error.message : String(error),
    })
  })
  void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    logEngineEvent(`auto-update check failed: ${error?.message || error}`)
  })
}

function checkForUpdatesManually() {
  if (!app.isPackaged) {
    // Dev builds have no app-update.yml; the releases page is the feedback.
    void shell.openExternal(RELEASES_URL)
    return
  }
  updateFeedbackWanted = true
  void autoUpdater.checkForUpdates().catch((error) => {
    updateFeedbackWanted = false
    void dialog.showMessageBox({
      type: 'error',
      title: 'Update check failed',
      message: 'Rautml could not check for updates.',
      detail: error instanceof Error ? error.message : String(error),
    })
  })
}

async function showOrCreateWindow() {
  cancelIdleEngineStop()
  if (windowOpening) {
    await windowOpening
  } else if (!mainWindow) {
    windowOpening = createWindow()
    try {
      await windowOpening
    } finally {
      windowOpening = null
    }
  }
  const window = mainWindow
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function showOrCreateWindowSafely() {
  void showOrCreateWindow().catch((error) => {
    void dialog.showErrorBox(
      'Rautml could not open',
      error instanceof Error ? error.message : String(error),
    )
  })
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
        {
          label: 'Check for Updates…',
          click: () => checkForUpdatesManually(),
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
  cancelIdleEngineStop()
  const preload = path.join(__dirname, 'preload.cjs')
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5'
  const savedState = readWindowState()

  const window = new BrowserWindow({
    title: 'Rautml',
    width: savedState?.width ?? 1440,
    height: savedState?.height ?? 920,
    ...(savedState ? { x: savedState.x, y: savedState.y } : {}),
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
  mainWindow = window
  mainWindowOrigin = ''

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    let sameOrigin = false
    try {
      sameOrigin =
        Boolean(mainWindowOrigin) && new URL(url).origin === new URL(mainWindowOrigin).origin
    } catch {
      sameOrigin = false
    }
    if (sameOrigin) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  let retriedFailedLoad = false
  window.webContents.on('did-finish-load', () => {
    retriedFailedLoad = false
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // -3 means the load was aborted on purpose (retry, crash-restart swap).
    if (!isMainFrame || errorCode === -3 || retriedFailedLoad || !mainWindowOrigin) return
    retriedFailedLoad = true
    logEngineEvent(`main frame failed to load (${errorCode}: ${errorDescription}); retrying once`)
    setTimeout(() => {
      if (mainWindow !== window || window.isDestroyed() || !mainWindowOrigin) return
      window.loadURL(mainWindowOrigin).catch((error) => {
        logEngineEvent(`load retry failed: ${error?.message || error}`)
      })
    }, ENGINE_LOAD_RETRY_DELAY_MS)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logEngineEvent(`renderer process gone (${details?.reason ?? 'unknown'})`)
    if (mainWindow !== window || window.isDestroyed()) return
    window.reload()
  })
  window.on('unresponsive', () => {
    void (async () => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Rautml is not responding',
        message: 'The window stopped responding.',
        buttons: ['Reload', 'Wait'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0 && mainWindow === window && !window.isDestroyed()) window.reload()
    })()
  })
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
  window.on('close', () => saveWindowState(window))
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // The bundled boot screen shows immediately; the app swaps in once the
  // engine answers, and boot failures render there with a Retry button.
  await window.loadFile(path.join(__dirname, 'loading.html'))

  let origin = devUrl
  if (!origin) {
    try {
      origin = await startEngine()
    } catch (error) {
      logEngineEvent(`boot failed: ${error?.stack || error}`)
      if (!window.isDestroyed()) {
        const message = error instanceof Error ? error.message : String(error)
        await window
          .loadFile(path.join(__dirname, 'loading.html'), { query: { error: message } })
          .catch(() => {})
      }
      return
    }
  }

  try {
    mainWindowOrigin = origin
    await window.loadURL(origin)
  } catch (error) {
    // A failed first load must not leave a stale hidden window behind.
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = null
    throw error
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void app.whenReady().then(showOrCreateWindowSafely)
  })
  app.whenReady().then(async () => {
    installApplicationMenu()
    wireAutoUpdater()
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
      if (BrowserWindow.getAllWindows().length === 0) showOrCreateWindowSafely()
    })
  })
}

app.on('before-quit', () => {
  quitting = true
  stopEngine()
})

app.on('window-all-closed', () => {
  // Preserve active generations/indexing, but reclaim the local engine once it
  // reports idle. This keeps durable background work intact without retaining
  // Node/ONNX for the rest of a windowless macOS session.
  scheduleIdleEngineStop()
  if (process.platform !== 'darwin') app.quit()
})
