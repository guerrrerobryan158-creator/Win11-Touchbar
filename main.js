const { app, BrowserWindow, ipcMain, nativeImage, clipboard } = require('electron');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');
const { createIconPNG } = require('./icon');

// Start the Express + WebSocket server immediately.
// The returned API exposes the local-only diagnostics controls.
const serverApi = require('./server');

const POLL_INTERVAL_MS = 1000;

let mainWindow = null;
let pollTimer = null;
let lastStatusPayload = '';
let lastQrKey = '';
let cachedQrDataUrl = null;
let diagPushTimer = null;

// Diagnostics entries are pushed to the renderer in batches (never per packet)
// so slider drags never redraw the Electron UI per intermediate update.
function scheduleDiagPush() {
  if (diagPushTimer) return;
  diagPushTimer = setTimeout(() => {
    diagPushTimer = null;
    if (!mainWindow) return;
    mainWindow.webContents.send('diag-update', {
      enabled: serverApi.getDiagnosticsEnabled(),
      entries: serverApi.getDiagnostics()
    });
  }, 250);
}

// Generate app icon from our runtime PNG encoder
function getAppIcon() {
  try {
    const pngBuffer = createIconPNG(256);
    return nativeImage.createFromBuffer(pngBuffer);
  } catch (e) {
    console.error('Failed to generate icon:', e);
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 500,
    title: 'WinTouch Bar',
    icon: getAppIcon(),
    autoHideMenuBar: true,
    backgroundColor: '#0d1015',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'desktop.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Fetch status from the local Express API
function fetchStatus() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8787/api/status', (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function generateQRDataURL(text) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
      color: {
        dark: '#0d1015',
        light: '#ffffff'
      }
    });
  } catch (e) {
    console.error('QR generation failed:', e);
    return null;
  }
}

async function pollStatus() {
  if (!mainWindow) return;
  try {
    const status = await fetchStatus();

    // QR is only regenerated when the LAN URL changes (no per-second work).
    if (status.lanURL !== lastQrKey) {
      lastQrKey = status.lanURL;
      cachedQrDataUrl = await generateQRDataURL(status.lanURL);
    }

    const payload = { ...status, qrDataUrl: cachedQrDataUrl };
    const payloadStr = JSON.stringify(payload);

    // Only send to renderer if something changed
    if (payloadStr !== lastStatusPayload) {
      lastStatusPayload = payloadStr;
      mainWindow.webContents.send('status-update', payload);
    }
  } catch (e) {
    // Server not ready yet - ignore
  }
}

ipcMain.handle('status', async () => {
  try {
    const status = await fetchStatus();
    if (status.lanURL !== lastQrKey) {
      lastQrKey = status.lanURL;
      cachedQrDataUrl = await generateQRDataURL(status.lanURL);
    }
    return { ...status, qrDataUrl: cachedQrDataUrl };
  } catch (e) {
    return { error: e.message };
  }
});

// ---- Diagnostics (local only; OFF by default; bounded to 100 entries) ----
ipcMain.handle('diag:get', () => ({
  enabled: serverApi.getDiagnosticsEnabled(),
  entries: serverApi.getDiagnostics()
}));

ipcMain.handle('diag:set', (event, enabled) => {
  serverApi.setDiagnosticsEnabled(!!enabled);
  scheduleDiagPush();
  return serverApi.getDiagnosticsEnabled();
});

ipcMain.handle('diag:clear', () => {
  serverApi.getDiagnostics().length = 0;
  scheduleDiagPush();
  return true;
});

ipcMain.handle('diag:copy', (event, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return true;
  } catch (e) {
    return false;
  }
});

// Push batched diagnostics updates to the Electron renderer only.
serverApi.onNewDiag(() => scheduleDiagPush());

app.whenReady().then(() => {
  createWindow();
  pollStatus();
  pollTimer = setInterval(pollStatus, POLL_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
});