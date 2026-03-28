'use strict';
/**
 * StremioPI — Electron main process
 * Starts the backend (Node.js server) then opens a fullscreen kiosk window.
 * MPV is launched via IPC from the renderer and controlled via UNIX socket.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn }   = require('child_process');
const path        = require('path');
const http        = require('http');
const net         = require('net');
const fs          = require('fs');

const BACKEND_PORT = process.env.PORT || 3000;
const MPV_SOCKET   = '/tmp/stremio-pi-mpv.sock';
const isDev        = process.env.NODE_ENV === 'development';

let mainWindow     = null;
let backendProcess = null;
let mpvProcess     = null;

// ── Start backend server ────────────────────────────────────────────
function startBackend() {
  const serverPath = path.join(__dirname, '..', 'backend', 'src', 'server.js');
  const envFile    = path.join(__dirname, '..', '.env');

  const env = { ...process.env, PORT: String(BACKEND_PORT) };
  if (fs.existsSync(envFile)) env.DOTENV_CONFIG_PATH = envFile;

  backendProcess = spawn(process.execPath, [serverPath], {
    env,
    stdio: isDev ? 'inherit' : 'pipe',
  });

  if (!isDev && backendProcess.stderr) {
    backendProcess.stderr.on('data', (d) => process.stderr.write('[backend] ' + d));
  }
  if (!isDev && backendProcess.stdout) {
    backendProcess.stdout.on('data', (d) => process.stdout.write('[backend] ' + d));
  }

  backendProcess.on('error', (err) => console.error('[StremioPI] Backend error:', err.message));
  console.log('[StremioPI] Backend started (pid', backendProcess.pid + ')');
}

// ── Wait for backend to respond on /health ─────────────────────────
function waitForBackend(timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      http.get(`http://localhost:${BACKEND_PORT}/health`, (res) => {
        if (res.statusCode === 200) { resolve(); return; }
        retry();
      }).on('error', retry);
    }
    function retry() {
      if (Date.now() > deadline) { reject(new Error('Backend not ready')); return; }
      setTimeout(check, 600);
    }
    check();
  });
}

// ── Create the main fullscreen window ─────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen:       true,
    frame:            false,
    backgroundColor:  '#0d0d0f',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadURL(`http://localhost:${BACKEND_PORT}`);

  // F11 toggles fullscreen, Ctrl+Q quits
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F11' && input.type === 'keyDown')
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    if (input.key === 'q' && input.control && input.type === 'keyDown')
      app.quit();
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── MPV IPC helpers ────────────────────────────────────────────────
function sendMpvIpc(commandArray) {
  return new Promise((resolve) => {
    const client = net.createConnection(MPV_SOCKET);
    const timer  = setTimeout(() => { try { client.destroy(); } catch {} resolve(false); }, 1500);
    client.on('connect', () => {
      client.write(JSON.stringify({ command: commandArray }) + '\n');
      client.end();
      clearTimeout(timer);
      resolve(true);
    });
    client.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function killMpv() {
  if (mpvProcess && !mpvProcess.killed) {
    try { mpvProcess.kill('SIGTERM'); } catch {}
    mpvProcess = null;
  }
}

// ── IPC handlers (called from renderer via electronAPI) ────────────
ipcMain.handle('player:launch', async (_e, { url, title }) => {
  killMpv();
  await new Promise(r => setTimeout(r, 150)); // brief pause before new instance

  const args = [
    '--fullscreen',
    `--input-ipc-server=${MPV_SOCKET}`,
    '--no-terminal',
    '--osd-level=1',
    `--title=${title || 'StremioPI'}`,
    url,
  ];

  console.log('[StremioPI] Launching MPV:', url.slice(0, 80));
  mpvProcess = spawn('mpv', args, { detached: true, stdio: 'ignore' });
  mpvProcess.unref();
  mpvProcess.on('exit',  (c) => { console.log('[StremioPI] MPV exit', c); mpvProcess = null; });
  mpvProcess.on('error', (e) => { console.error('[StremioPI] MPV error:', e.message); mpvProcess = null; });

  return { ok: true };
});

ipcMain.handle('player:stop', async () => {
  await sendMpvIpc(['quit']);
  killMpv();
  return { ok: true };
});

ipcMain.handle('player:pause', async () => {
  await sendMpvIpc(['cycle', 'pause']);
  return { ok: true };
});

ipcMain.handle('player:status', () => ({
  running: mpvProcess != null && !mpvProcess.killed,
}));

// ── App lifecycle ──────────────────────────────────────────────────
app.whenReady().then(async () => {
  startBackend();
  try {
    await waitForBackend();
    console.log('[StremioPI] Backend ready — opening window');
  } catch (e) {
    console.warn('[StremioPI] Backend slow to start, opening anyway');
  }
  createWindow();
});

app.on('window-all-closed', () => {
  killMpv();
  if (backendProcess) { try { backendProcess.kill(); } catch {} }
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
