import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron' // Electron core modules
import os from 'os' // OS utilities
import fs from 'fs/promises' // Promise-based FS API
import fssync from 'fs' // Sync FS API
import path from 'path' // Path utilities
import { fileURLToPath } from 'url' // ESM helpers
import { spawn } from 'child_process' // Process spawning

const __filename = fileURLToPath(import.meta.url) // Current file path
const __dirname = path.dirname(__filename) // Current dir path

let win // BrowserWindow ref
let tray // Tray ref
let authWindow = null // OneDrive auth window
let onedriveProcess = null // OneDrive process
let onedriveMonitorProcess = null // OneDrive monitor process
let isQuitting = false // App shutdown flag

// OneDrive configuration paths
const ONEDRIVE_CONFIG_DIR = path.join(os.homedir(), '.config', 'onedrive')
const ONEDRIVE_AUTH_DIR = path.join(ONEDRIVE_CONFIG_DIR, 'auth')
const ONEDRIVE_REQUEST_FILE = path.join(ONEDRIVE_AUTH_DIR, 'request.url')
const ONEDRIVE_RESPONSE_FILE = path.join(ONEDRIVE_AUTH_DIR, 'response.url')
const ONEDRIVE_CONFIG_FILE = path.join(ONEDRIVE_CONFIG_DIR, 'config')
const ONEDRIVE_DEFAULT_SYNC_DIR = path.join(os.homedir(), 'OneDrive-Temp')
const SHARED_WITH_ME_FOLDER_NAME = 'mit dir geteilt'
const GRAPH_DEFAULT_APP_ID = 'd50ca740-c83f-4d1b-b616-12c519384f0c'
const GRAPH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

let activeAuthRun = null // Tracks the currently running auth attempt

function beginAuthRun() {
  const run = { id: Date.now(), settled: false }
  activeAuthRun = run
  return run
}

function settleAuthRun(run) {
  if (!run || run.settled) return
  run.settled = true
  if (activeAuthRun === run) {
    activeAuthRun = null
  }
}

async function failAuthFlow(message, error, run = activeAuthRun) {
  if (!run || run.settled) return
  settleAuthRun(run)
  const safeMessage = message || 'OneDrive Authentifizierung fehlgeschlagen'
  if (error) {
    console.error('Auth flow error:', error)
  } else {
    console.error('Auth flow error:', safeMessage)
  }
  try {
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.close()
    }
  } catch {}
  authWindow = null
  if (onedriveProcess) {
    try { onedriveProcess.kill() } catch {}
    onedriveProcess = null
  }
  uiSend('auth-result', { status: 'error', message: safeMessage })
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  failAuthFlow('Unbekannter Fehler während der Authentifizierung', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
  failAuthFlow('Unerwarteter Fehler während der Authentifizierung', reason instanceof Error ? reason : undefined)
})

function createWindow() {
    win = new BrowserWindow({
        title: "OneDrive Authentifizierung", // Title
        width: 600, // Width
        height: 700, // Height
        icon: path.join(__dirname, 'icon.png'), // Icon
        webPreferences:{ preload: path.join(__dirname, 'preload.js') } // Preload script
    })

    win.loadFile('index.html') // Load UI
    win.removeMenu() // Hide menu

    win.on('close', (event) => {
         if (!app.isQuiting) { event.preventDefault(); win.hide() } // Minimize to tray
    })
}

function createTray() {
    tray = new Tray(path.join(__dirname, 'trayicon.png')) // Create tray icon
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show App', click: () => win.show() }, // Show window
        { label: 'Quit', click: () => { app.isQuiting = true; app.quit() } } // Quit app
    ])
    tray.setToolTip('OneDrive Authentifizierung') // Tooltip
    tray.setContextMenu(contextMenu) // Context menu
  tray.on('click', () => { // Toggle window (guard against destroyed window)
    try {
      if (win && !win.isDestroyed()) {
        win.isVisible() ? win.hide() : win.show()
      }
    } catch {}
  })
}

// Enforce single-instance behavior; on second start, focus/show existing window
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    try {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      } else {
        // In rare cases, recreate if no window exists yet
        createWindow()
      }
    } catch {}
  })
}

app.whenReady().then(() => { createWindow(); createTray(); maybeStartMonitorIfToken() }) // Init app





// Prüfe ob OneDrive installiert ist
async function checkOnedriveInstallation() {
  return new Promise((resolve) => {
    const checkProcess = spawn('which', ['onedrive'])
    
    checkProcess.on('exit', (code) => {
      resolve(code === 0)
    })
    
    checkProcess.on('error', () => {
      resolve(false)
    })
  })
}

// OneDrive Authentifizierung starten
ipcMain.handle('start-onedrive-auth', async (event) => {
    console.log('start-onedrive-auth handler called')
    try {
        const authRun = beginAuthRun()
        // Prüfe zuerst, ob OneDrive installiert ist
        const isOnedriveInstalled = await checkOnedriveInstallation()
        if (!isOnedriveInstalled) {
            const errorMsg = 'OneDrive ist nicht installiert. Bitte installieren Sie es zuerst.'
            console.error('OneDrive not installed')
            event.sender.send('auth-result', { status: 'error', message: errorMsg })
            settleAuthRun(authRun)
            return { status: 'failed', reason: 'onedrive-not-installed' }
        }

        console.log('Creating auth directory:', ONEDRIVE_AUTH_DIR)
        // Erstelle Auth-Verzeichnis
        await fs.mkdir(ONEDRIVE_AUTH_DIR, { recursive: true })
        // Erstelle OneDrive Konfiguration falls nicht vorhanden
        await ensureOnedriveConfig()
        
        // Lösche alte Auth-Dateien
        try {
            await fs.unlink(ONEDRIVE_REQUEST_FILE)
            await fs.unlink(ONEDRIVE_RESPONSE_FILE)
            console.log('Cleared old auth files')
        } catch (e) {
            console.log('No old auth files to clear')
        }
    
    console.log('Starting onedrive process...')
    // Starte OneDrive Auth-Prozess
    onedriveProcess = spawn('onedrive', [
      '--confdir', ONEDRIVE_CONFIG_DIR,
      '--sync',
      '--reauth',
      '--auth-files', `${ONEDRIVE_REQUEST_FILE}:${ONEDRIVE_RESPONSE_FILE}`
    ])
    
    onedriveProcess.on('error', (err) => {
      failAuthFlow('OneDrive Prozess konnte nicht gestartet werden', err, authRun)
    })
    onedriveProcess.on('exit', (code, signal) => {
      onedriveProcess = null
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return
      if (code !== 0) {
        failAuthFlow(`OneDrive Authentifizierung fehlgeschlagen (Code ${code})`, undefined, authRun)
      }
    })
    
    onedriveProcess.stdout.on('data', (data) => {
      console.log('OneDrive stdout:', data.toString())
    })
    
    onedriveProcess.stderr.on('data', (data) => {
      console.log('OneDrive stderr:', data.toString())
    })
    
    console.log('Waiting for auth URL...')
    // Warte auf Auth-URL
    const authUrl = await waitForAuthUrl()
    console.log('Auth URL received:', authUrl)
    
    // Öffne Auth-Fenster
    await openAuthWindow(authUrl, authRun)
    console.log('Auth window opened')
    
    return { status: 'auth-started', url: authUrl }
  } catch (e) {
    console.error('OneDrive auth error:', e.message)
    await failAuthFlow('OneDrive Authentifizierung fehlgeschlagen', e)
    event.sender.send('auth-result', { status: 'error', message: e.message })
    return { status: 'failed' }
  }
})

// One-Time Synchronize on demand
ipcMain.handle('force-sync', async () => {
  try {
    // 0) Prüfe zuerst, ob OneDrive installiert ist
    const isOnedriveInstalled = await checkOnedriveInstallation()
    if (!isOnedriveInstalled) {
      const errorMsg = 'OneDrive ist nicht installiert. Bitte installieren Sie es zuerst.'
      win?.webContents?.send('sync-result', { status: 'error', message: errorMsg })
      return { status: 'failed', reason: 'onedrive-not-installed' }
    }

    // 1) Prüfe, ob ein Token vorhanden ist
    const tokenPath = path.join(ONEDRIVE_CONFIG_DIR, 'refresh_token')
    const hasToken = fssync.existsSync(tokenPath)
    
    if (!hasToken) {
      const errorMsg = 'Kein OneDrive Token gefunden – bitte zuerst authentifizieren'
      win?.webContents?.send('sync-result', { status: 'error', message: errorMsg })
      return { status: 'failed', reason: 'no-token' }
    }

    // 1) Monitor (falls laufend) kurz stoppen
    const wasRunning = await stopOnedriveMonitorGracefully()
    if (wasRunning) {
      win?.webContents?.send('sync-result', { status: 'info', message: 'Monitor gestoppt – führe Sofort-Sync aus' })
    }

    // 2) Sofort-Sync ausführen
    const p = spawn('onedrive', [
      '--confdir', ONEDRIVE_CONFIG_DIR,
      '--sync'
    ])

    p.stdout?.on('data', (d) => {
      const msg = d.toString()
      console.log('Force sync stdout:', msg)
      win?.webContents?.send('sync-result', { status: 'info', message: msg.trim() })
    })
    p.stderr?.on('data', (d) => {
      const msg = d.toString()
      console.log('Force sync stderr:', msg)
      win?.webContents?.send('sync-result', { status: 'warning', message: msg.trim() })
    })

    const syncOk = await new Promise((resolve) => {
      p.on('exit', (code) => {
        if (code === 0) {
          win?.webContents?.send('sync-result', { status: 'success', message: 'Einmaliger Sync abgeschlossen' })
          resolve(true)
        } else {
          win?.webContents?.send('sync-result', { status: 'error', message: `Einmaliger Sync fehlgeschlagen (Code ${code})` })
          resolve(false)
        }
      })
    })

    // 3) Monitor wieder starten, wenn er vorher lief oder wenn Sync erfolgreich war
    if (wasRunning || syncOk) {
      startOnedriveMonitor()
    }
    // 4) Graph: "Mit dir geteilt" mit allen Shares aktualisieren (ohne manuellen Shortcut)
    runSharedWithMeSync().catch((e) => {
      console.warn('Shared-with-me sync failed:', e?.message)
      win?.webContents?.send('sync-result', { status: 'warning', message: `„Mit dir geteilt“: ${e?.message}` })
    })
    return { status: syncOk ? 'ok' : 'failed' }
  } catch (e) {
    const m = e?.message || 'Unbekannter Fehler bei force-sync'
    console.error('force-sync error:', m)
    win?.webContents?.send('sync-result', { status: 'error', message: m })
    return { status: 'failed' }
  }
})

// Monitor sanft stoppen (TERM, dann Timeout, dann KILL). Lief er? → true/false
function stopOnedriveMonitorGracefully() {
  return new Promise((resolve) => {
    if (!onedriveMonitorProcess || typeof onedriveMonitorProcess.pid !== 'number') {
      return resolve(false)
    }
    const pid = onedriveMonitorProcess.pid
    let resolved = false
    const done = (result) => { if (!resolved) { resolved = true; resolve(result) } }

    try { process.kill(pid, 'SIGTERM') } catch { done(false); return }

    const timeout = setTimeout(() => {
      try { process.kill(pid, 'SIGKILL') } catch {}
      onedriveMonitorProcess = null
      win?.webContents?.send('sync-result', { status: 'warning', message: 'Monitor musste zwangsweise beendet werden' })
      done(true)
    }, 3000)

    onedriveMonitorProcess.once('exit', () => {
      clearTimeout(timeout)
      onedriveMonitorProcess = null
      done(true)
    })
    onedriveMonitorProcess.once('close', () => {
      clearTimeout(timeout)
      onedriveMonitorProcess = null
      done(true)
    })
  })
}

// Token-Status für UI abfragen
ipcMain.handle('check-token', async () => {
  try {
    const tokenPath = path.join(ONEDRIVE_CONFIG_DIR, 'refresh_token')
    const hasToken = fssync.existsSync(tokenPath)
    return { hasToken }
  } catch {
    return { hasToken: false }
  }
})

ipcMain.handle('get-app-version', () => ({ version: app.getVersion() }))

// Auth-URL aus Datei lesen
async function waitForAuthUrl() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout: Keine Auth-URL erhalten'))
    }, 120000) // 120 Sekunden Timeout
    
    const checkFile = async () => {
      try {
        if (fssync.existsSync(ONEDRIVE_REQUEST_FILE)) {
          const content = await fs.readFile(ONEDRIVE_REQUEST_FILE, 'utf8')
          if (content.trim()) {
            clearTimeout(timeout)
            resolve(content.trim())
            return
          }
        }
        setTimeout(checkFile, 200) // Alle 200ms prüfen
      } catch (e) {
        clearTimeout(timeout)
        reject(e)
      }
    }
    
    checkFile()
  })
}

// Auth-Fenster öffnen
async function openAuthWindow(authUrl, run = activeAuthRun) {
    if (authWindow) {
        authWindow.close()
    }
    
    authWindow = new BrowserWindow({
            title: 'OneDrive Authentifizierung',
            width: 800,
            height: 600,
            webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            partition: 'persist:onedrive-auth'
        }
    })
  
  // Set a modern desktop Chrome user-agent to avoid block by Microsoft login
  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  try { authWindow.webContents.setUserAgent(userAgent) } catch {}
  
  let redirectHandled = false
  const initialAuthUrl = String(authUrl)

  // Hilfsfunktion: Erkennen, ob es sich um die Redirect-URL handelt
  const isRedirectUrl = (url) => {
    if (!url) return false
    const ustr = String(url)
    // Not a redirect if it's still the initial authorize URL
    if (ustr === initialAuthUrl) return false
    let u
    try { u = new URL(ustr) } catch { return false }
    // Accept redirects either to nativeclient endpoint or to localhost
    const isNativeClient = (u.hostname === 'login.microsoftonline.com' && u.pathname.endsWith('/oauth2/nativeclient'))
    const isLocal = (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    return isNativeClient || isLocal
  }

  // URL-Handler für verschiedene Navigationsereignisse
  const tryHandle = (url) => {
    if (!redirectHandled && isRedirectUrl(url)) {
      redirectHandled = true
      handleAuthRedirect(url, run)
    }
  }

  authWindow.webContents.on('will-navigate', (_event, url) => tryHandle(url))
  authWindow.webContents.on('will-redirect', (_event, url) => tryHandle(url))
  authWindow.webContents.on('did-navigate', (_event, url) => tryHandle(url))
  authWindow.webContents.on('did-navigate-in-page', (_event, url) => tryHandle(url))
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    tryHandle(url)
    return { action: 'deny' }
  })
  authWindow.once('closed', () => {
    authWindow = null
    if (run && !run.settled) {
      failAuthFlow('Authentifizierung wurde abgebrochen', undefined, run)
    }
  })
  
  // Load URL with UA and handle load failures by retrying once
  try {
    await authWindow.loadURL(authUrl, { userAgent })
  } catch (e) {
    console.warn('Initial load failed, retrying with custom UA:', e?.message)
    try { await authWindow.loadURL(authUrl, { userAgent }) } catch {}
  }
  
  // Zeige Fenster
  if (authWindow && !authWindow.isDestroyed() && !redirectHandled) {
    authWindow.show()
  }
}

// Resolve sync_dir from config or use default (supports quoted paths and ~)
function getSyncDirFromConfig() {
  try {
    const raw = fssync.readFileSync(ONEDRIVE_CONFIG_FILE, 'utf8')
    const m = raw.match(/sync_dir\s*=\s*["']([^"']+)["']/)
    if (m) {
      let p = m[1].trim()
      if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
      return path.resolve(p)
    }
  } catch {}
  return ONEDRIVE_DEFAULT_SYNC_DIR
}

function getApplicationIdFromConfig() {
  try {
    const raw = fssync.readFileSync(ONEDRIVE_CONFIG_FILE, 'utf8')
    const m = raw.match(/application_id\s*=\s*["']([^"']+)["']/i)
    if (m) return m[1].trim()
  } catch {}
  return GRAPH_DEFAULT_APP_ID
}

// Ensure sync dir exists on disk (client may not have created it if it never ran successfully)
async function ensureSyncDirExists() {
  try {
    const syncDir = getSyncDirFromConfig()
    await fs.mkdir(syncDir, { recursive: true })
  } catch (e) {
    console.warn('Could not ensure sync dir:', e?.message)
  }
}

// "mit dir geteilt" as real folder for Graph API shared-with-me sync (not symlink)
async function ensureSharedWithMeDir() {
  try {
    const syncDir = getSyncDirFromConfig()
    const sharedDir = path.join(syncDir, SHARED_WITH_ME_FOLDER_NAME)
    const stat = await fs.stat(sharedDir).catch(() => null)
    if (stat?.isSymbolicLink()) await fs.unlink(sharedDir)
    if (!stat || stat.isSymbolicLink()) await fs.mkdir(sharedDir, { recursive: true })
  } catch (e) {
    console.warn('Could not ensure shared-with-me dir:', e?.message)
  }
}

// Get Graph API access token from stored refresh_token (same app id as onedrive client)
async function refreshGraphAccessToken() {
  const refreshTokenPath = path.join(ONEDRIVE_CONFIG_DIR, 'refresh_token')
  const raw = await fs.readFile(refreshTokenPath, 'utf8')
  const refreshToken = raw.trim()
  if (!refreshToken) throw new Error('Empty refresh token')
  const clientId = getApplicationIdFromConfig()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: 'https://graph.microsoft.com/.default'
  })
  const res = await fetch(GRAPH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Token refresh failed: ${res.status} ${t}`)
  }
  const data = await res.json()
  if (!data.access_token) throw new Error('No access_token in response')
  return data.access_token
}

// Fetch all items from sharedWithMe (paginated)
async function fetchSharedWithMeAll(accessToken) {
  const items = []
  let url = `${GRAPH_BASE}/me/drive/sharedWithMe`
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) throw new Error(`sharedWithMe failed: ${res.status}`)
    const data = await res.json()
    if (Array.isArray(data.value)) items.push(...data.value)
    url = data['@odata.nextLink'] || null
  }
  return items
}

// Sanitize name for filesystem (one line)
function sanitizeFileName(name) {
  if (typeof name !== 'string' || !name) return 'unnamed'
  return name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 200).trim() || 'unnamed'
}

// Download one file from Graph to local path
async function downloadGraphFile(accessToken, driveId, itemId, localPath) {
  const res = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) throw new Error(`get item ${res.status}`)
  const item = await res.json()
  const downloadUrl = item['@microsoft.graph.downloadUrl']
  if (!downloadUrl) throw new Error('No download URL')
  const fileRes = await fetch(downloadUrl)
  if (!fileRes.ok) throw new Error(`download ${fileRes.status}`)
  const buf = Buffer.from(await fileRes.arrayBuffer())
  await fs.writeFile(localPath, buf)
}

// List children of a drive item (folder)
async function graphListChildren(accessToken, driveId, itemId) {
  const items = []
  let url = `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/children`
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`children ${res.status}`)
    const data = await res.json()
    if (Array.isArray(data.value)) items.push(...data.value)
    url = data['@odata.nextLink'] || null
  }
  return items
}

// Sync one shared item (file or folder) into localDir; item has .remoteItem or is plain driveItem with .parentReference
async function syncSharedItemToLocal(accessToken, item, localDir) {
  const remote = item.remoteItem || item
  const driveId = remote.parentReference?.driveId
  const itemId = remote.id
  if (!driveId || !itemId) return
  const name = sanitizeFileName(remote.name || 'unnamed')
  const localPath = path.join(localDir, name)
  if (remote.file) {
    await downloadGraphFile(accessToken, driveId, itemId, localPath)
    uiSend('sync-result', { status: 'info', message: `Geteilt: ${name}` })
  } else if (remote.folder) {
    await fs.mkdir(localPath, { recursive: true })
    const children = await graphListChildren(accessToken, driveId, itemId)
    for (const child of children) await syncSharedItemToLocal(accessToken, child, localPath)
  }
}

// Run full "shared with me" sync into "mit dir geteilt" via Graph API (no manual shortcuts needed)
async function runSharedWithMeSync() {
  await ensureSharedWithMeDir()
  const sharedDir = path.join(getSyncDirFromConfig(), SHARED_WITH_ME_FOLDER_NAME)
  const accessToken = await refreshGraphAccessToken()
  uiSend('sync-result', { status: 'info', message: '„Mit dir geteilt“ wird aktualisiert…' })
  const items = await fetchSharedWithMeAll(accessToken)
  for (const item of items) {
    try {
      await syncSharedItemToLocal(accessToken, item, sharedDir)
    } catch (e) {
      console.warn('Shared item sync failed:', e?.message)
      uiSend('sync-result', { status: 'warning', message: `Geteiltes Element fehlgeschlagen: ${e?.message}` })
    }
  }
  uiSend('sync-result', { status: 'success', message: `„Mit dir geteilt“: ${items.length} Elemente aktualisiert` })
}

// Minimalen OneDrive Config schreiben, damit onedrive nicht mit "missing --sync/--monitor" abbricht
async function ensureOnedriveConfig() {
  try {
    await fs.mkdir(ONEDRIVE_CONFIG_DIR, { recursive: true })
    let existing = ''
    try { existing = await fs.readFile(ONEDRIVE_CONFIG_FILE, 'utf8') } catch { existing = '' }
    const hasSyncDir = /\bsync_dir\b/.test(existing)
    if (!hasSyncDir) {
      const content = `sync_dir = "${ONEDRIVE_DEFAULT_SYNC_DIR}"
sync_business_shared_items = "false"
resync_auth = "true"
`
      await fs.writeFile(ONEDRIVE_CONFIG_FILE, content, 'utf8')
      console.log('Wrote minimal OneDrive config at', ONEDRIVE_CONFIG_FILE)
      await ensureSyncDirExists()
      await ensureSharedWithMeDir()
    } else {
      // Shared items: we use Graph API in "mit dir geteilt", so client shared sync can stay false
      let updated = existing
      if (/\bsync_business_shared_items\b/.test(updated)) {
        updated = updated.replace(/sync_business_shared_items\s*=\s*["']true["']/i, 'sync_business_shared_items = "false"')
      }
      if (!/\bsync_business_shared_items\b/.test(updated)) updated += '\nsync_business_shared_items = "false"\n'
      // resync_auth = "true" allows non-interactive resync if ever needed via CLI
      if (!/\bresync_auth\b/.test(updated)) updated += 'resync_auth = "true"\n'
      else updated = updated.replace(/resync_auth\s*=\s*["']false["']/i, 'resync_auth = "true"')
      if (updated !== existing) await fs.writeFile(ONEDRIVE_CONFIG_FILE, updated, 'utf8')
      await ensureSyncDirExists()
      await ensureSharedWithMeDir()
      console.log('Using existing OneDrive config at', ONEDRIVE_CONFIG_FILE)
    }
  } catch (e) {
    console.warn('Could not ensure OneDrive config:', e?.message)
  }
}

// Auth-Redirect verarbeiten
async function handleAuthRedirect(redirectUrl, run = activeAuthRun) {
  try {
    // Speichere Response-URL
    await fs.writeFile(ONEDRIVE_RESPONSE_FILE, redirectUrl)
    
    // Schließe Auth-Fenster
    if (authWindow) {
      settleAuthRun(run)
      authWindow.close()
      authWindow = null
    }
    
    // Benachrichtige Hauptfenster (intermediate success)
    win?.webContents?.send('auth-result', { status: 'success', message: 'Authentifizierung erfolgreich abgeschlossen' })

    const decideAfterExit = () => {
      try {
        const tokenExists = fssync.existsSync(path.join(ONEDRIVE_CONFIG_DIR, 'refresh_token'))
        if (tokenExists) {
          win?.webContents?.send('auth-result', { status: 'completed', message: 'OneDrive Authentifizierung abgeschlossen' })
          startOnedriveMonitor()
        } else {
          win?.webContents?.send('auth-result', { status: 'error', message: 'OneDrive Authentifizierung fehlgeschlagen (kein Token gefunden)' })
        }
      } catch (e) {
        win?.webContents?.send('auth-result', { status: 'error', message: 'Fehler bei Token-Prüfung' })
      }
    }

        // Warte auf OneDrive-Prozess; falls schon beendet, entscheide direkt
        if (onedriveProcess) {
        if (typeof onedriveProcess.exitCode === 'number') {
            decideAfterExit()
            } else {
                onedriveProcess.once('exit', () => decideAfterExit())
                onedriveProcess.once('close', () => decideAfterExit())
            }
        } else {
         decideAfterExit()
        }
    } catch (e) {
        console.error('Error handling auth redirect:', e.message)
        await failAuthFlow('Fehler beim Verarbeiten der Authentifizierung', e, run)
    }
}

// Cleanup beim Beenden
app.on('before-quit', async () => {
  isQuitting = true
  if (onedriveProcess) {
    onedriveProcess.kill()
  }
  if (onedriveMonitorProcess) {
    onedriveMonitorProcess.kill()
  }
  if (authWindow) {
    authWindow.close()
  }
  try { tray?.destroy?.() } catch {}
})

// OneDrive Monitor starten (einfacher Hintergrund-Sync)
function startOnedriveMonitor() {
  try {
    if (onedriveMonitorProcess) {
      try { onedriveMonitorProcess.kill() } catch {}
      onedriveMonitorProcess = null
    }
    onedriveMonitorProcess = spawn('onedrive', [
      '--confdir', ONEDRIVE_CONFIG_DIR,
      '--monitor'
    ])
    onedriveMonitorProcess.stdout?.on('data', (d) => {
      const text = d.toString()
      console.log('Monitor stdout:', text)
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        const msg = line.trim()
        if (!msg) continue
        const isComplete = /Sync with Microsoft OneDrive is complete/i.test(msg)
        uiSend('sync-result', { status: isComplete ? 'success' : 'info', message: msg })
      }
    })
    onedriveMonitorProcess.stderr?.on('data', (d) => {
      const text = d.toString()
      console.log('Monitor stderr:', text)
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        const msg = line.trim()
        if (!msg) continue
        uiSend('sync-result', { status: 'warning', message: msg })
      }
    })
    onedriveMonitorProcess.on('exit', (code) => {
      console.log('Monitor exited with code', code)
    })
    uiSend('auth-result', { status: 'info', message: 'OneDrive Monitor gestartet' })
  } catch (e) {
    console.error('Could not start OneDrive monitor:', e?.message)
    uiSend('auth-result', { status: 'error', message: 'Konnte OneDrive Monitor nicht starten' })
  }
}

// Beim App-Start: Falls Token vorhanden, Monitor automatisch starten
function maybeStartMonitorIfToken() {
  try {
    const tokenPath = path.join(ONEDRIVE_CONFIG_DIR, 'refresh_token')
    if (fssync.existsSync(tokenPath)) {
      ensureSyncDirExists().catch(() => {})
      ensureSharedWithMeDir().catch(() => {})
      startOnedriveMonitor()
      runSharedWithMeSync().catch(() => {})
    } else {
      uiSend('auth-result', { status: 'info', message: 'Kein gespeichertes Token gefunden – bitte authentifizieren' })
    }
  } catch (e) {
    console.warn('Token check failed:', e?.message)
  }
}

// Safe UI sender
function uiSend(channel, payload) {
  if (isQuitting) return
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  } catch {}
}