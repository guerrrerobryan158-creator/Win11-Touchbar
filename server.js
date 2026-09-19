const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { performAction } = require('./controls');
const { createIconPNG } = require('./icon');

const PORT = 8787;
const pairingCode = String(crypto.randomInt(1000000)).padStart(6, '0');

const pairedDevices = new Map(); // ip -> { deviceId, pairedAt, lastSeen }
const activityLog = [];

function getLanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const ifaceName of Object.keys(interfaces)) {
    const addrs = interfaces[ifaceName];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr && addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

const lanIP = getLanIPv4();
const lanURL = `http://${lanIP}:${PORT}`;

const app = express();
const server = http.createServer(app);

// Icons generated into public/ at startup
const publicDir = path.join(__dirname, 'public');
try {
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'icon-192.png'), createIconPNG(192));
  fs.writeFileSync(path.join(publicDir, 'icon-512.png'), createIconPNG(512));
  fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), createIconPNG(180));
} catch (e) { console.error('Failed to generate icons:', e.message); }

app.use(express.static(path.join(__dirname, 'public')));

function addActivity(entry) {
  activityLog.push({ time: new Date().toISOString(), ...entry });
  if (activityLog.length > 200) activityLog.shift();
}

// ---------------------------------------------------------------------------
// Server-authoritative state cache
// ---------------------------------------------------------------------------
const systemState = { volume: null, brightness: null, media: null };

function applyStateResult(action, result) {
  if (result && typeof result.volume === 'number') systemState.volume = result.volume;
  if (result && typeof result.brightness === 'number') systemState.brightness = result.brightness;
  if (action === 'media.state.get' && result && result.media) systemState.media = result.media;
}

// ---------------------------------------------------------------------------
// Diagnostics module (OFF by default, bounded 100 entries, local only)
// ---------------------------------------------------------------------------
const diagEnabled = { value: false };
const diagnostics = [];
const diagWaiters = new Set();

function recordDiag(entry) {
  diagnostics.push(entry);
  if (diagnostics.length > 100) diagnostics.shift();
  for (const cb of diagWaiters) { try { cb(entry); } catch (_) {} }
}

function mergeDiagReport(requestId, report) {
  if (!requestId) return;
  const entry = diagnostics.find((e) => e.requestId === requestId);
  if (!entry) return;
  if (typeof report.serverToPhoneMs === 'number') entry.serverToPhoneMs = report.serverToPhoneMs;
  if (typeof report.totalMs === 'number') entry.totalMs = report.totalMs;
  if (typeof report.localVisualMs === 'number') entry.localVisualMs = report.localVisualMs;
  for (const cb of diagWaiters) { try { cb(entry); } catch (_) {} }
}

function setDiagnosticsEnabled(v) {
  diagEnabled.value = !!v;
  broadcastDiagConfig();
}

function onNewDiag(cb) { diagWaiters.add(cb); }
function getDiagnosticsEnabled() { return diagEnabled.value; }
function getDiagnostics() { return diagnostics.slice(); }

function sendDiagConfigTo(ws) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'diag', enabled: diagEnabled.value }));
}

function broadcastDiagConfig() {
  for (const c of wss.clients) {
    if (c.readyState === 1 && c.wtbPaired) sendDiagConfigTo(c);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (per client + action). Responsive for legitimate drags.
// ---------------------------------------------------------------------------
const SLIDER_LIMITS = { 'media.volume.set': 30, 'system.brightness.set': 25, 'media.seek': 20 };
const DISCRETE_LIMIT = 6;
const buckets = new Map();

function allowRate(ip, action) {
  const limit = SLIDER_LIMITS[action] || DISCRETE_LIMIT;
  const now = Date.now();
  const k = ip + '|' + action;
  let b = buckets.get(k);
  if (!b || now - b.start > 1000) { b = { start: now, count: 0 }; buckets.set(k, b); }
  b.count += 1;
  return b.count <= limit;
}
// ---------------------------------------------------------------------------
// Slider coalescing: one running op per (ip, action); newer packets replace
// the pending target (latest wins). Final commits always execute.
// ---------------------------------------------------------------------------
const sliderQueues = new Map();

function enqueueSlider(ctx, msg) {
  const key = ctx.ip + ':' + msg.action;
  let q = sliderQueues.get(key);
  if (!q) {
    q = { running: false, pending: null, gestureId: '', count: 0, announced: false };
    sliderQueues.set(key, q);
  }
  if (q.gestureId !== (msg.actionId || '')) {
    q.gestureId = msg.actionId || '';
    q.count = 0;
    q.announced = false;
  }
  if (!q.announced) {
    addActivity({ type: 'action', ip: ctx.ip, deviceId: ctx.deviceId, action: msg.action, result: { status: 'drag_start' } });
    q.announced = true;
  }
  q.count += 1;
  q.pending = msg;
  if (!q.running) { q.running = true; runSlider(key, q, ctx); }
}

async function runSlider(key, q, ctx) {
  while (q.pending) {
    const msg = q.pending;
    q.pending = null;
    const final = !!msg.final;
    const tProviderStart = performance.now();
    let result;
    try { result = await performAction(msg.action, msg.params || {}); }
    catch (e) { result = { status: 'error', message: e.message }; }
    const tProviderEnd = performance.now();
    applyStateResult(msg.action, result);

    if (result.status === 'error') {
      addActivity({ type: 'action', ip: ctx.ip, deviceId: ctx.deviceId, action: msg.action, result: { status: 'provider_error', message: result.message } });
    }
    queueStateBroadcast(msg.action);

    if (final) {
      addActivity({ type: 'action', ip: ctx.ip, deviceId: ctx.deviceId, action: msg.action, result: { status: 'drag_end', updates: q.count } });
      sendActionResult(ctx, msg, result, { tProviderStart, tProviderEnd, broadcast: performance.now() });
    }
    if (diagEnabled.value) {
      recordDiag(buildDiagEntry(ctx, msg, result, tProviderStart, tProviderEnd));
    }
  }
  q.running = false;
}

// ---------------------------------------------------------------------------
// Discrete (non-slider) actions
// ---------------------------------------------------------------------------
async function runDiscrete(ctx, msg) {
  const tProviderStart = performance.now();
  let result;
  try { result = await performAction(msg.action, msg.params || {}); }
  catch (e) { result = { status: 'error', message: e.message }; }
  const tProviderEnd = performance.now();
  applyStateResult(msg.action, result);
  addActivity({ type: 'action', ip: ctx.ip, deviceId: ctx.deviceId, action: msg.action, result });
  queueStateBroadcast(msg.action);
  sendActionResult(ctx, msg, result, { tProviderStart, tProviderEnd, broadcast: performance.now() });
  if (diagEnabled.value) {
    recordDiag(buildDiagEntry(ctx, msg, result, tProviderStart, tProviderEnd));
  }
  if (result.status === 'error') {
    addActivity({ type: 'action', ip: ctx.ip, deviceId: ctx.deviceId, action: msg.action, result: { status: 'provider_error', message: result.message } });
  }
}

function buildDiagEntry(ctx, msg, result, tProviderStart, tProviderEnd) {
  return {
    time: new Date().toISOString(),
    actionId: msg.actionId || '',
    requestId: msg.requestId || '',
    session: ctx.ip,
    client: ctx.deviceId ? String(ctx.deviceId).slice(-8) : '',
    action: msg.action,
    localToSendMs: (typeof msg.tSend === 'number' && typeof msg.t0 === 'number') ? Math.round(msg.tSend - msg.t0) : null,
    localVisualMs: (typeof msg.tFirstFrame === 'number' && typeof msg.t0 === 'number') ? Math.round(msg.tFirstFrame - msg.t0) : null,
    validateMs: msg._tValidate ? Math.round(msg._tValidate - msg._tRecv) : null,
    providerMs: Math.round(tProviderEnd - tProviderStart),
    serverToPhoneMs: null,
    totalMs: null,
    result: result.status || 'ok',
    final: !!msg.final
  };
}

function sendActionResult(ctx, msg, result, times) {
  if (!ctx.ws || ctx.ws.readyState !== 1) return;
  const payload = { type: 'action_result', action: msg.action, requestId: msg.requestId || '', result };
  if (diagEnabled.value) {
    payload.t = {
      v: msg._tValidate ? Math.round(msg._tValidate - msg._tRecv) : 0,
      p: Math.round(times.tProviderEnd - times.tProviderStart),
      b: Math.round(times.broadcast - times.tProviderEnd)
    };
  }
  ctx.ws.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Incremental state broadcast (throttled ~11Hz, forced on final commits)
// ---------------------------------------------------------------------------
let lastStateJson = '';
let lastStateBroadcastAt = 0;
let stateTimer = null;

function queueStateBroadcast(triggerAction) {
  const now = performance.now();
  if (now - lastStateBroadcastAt >= 90) {
    flushStateBroadcast(triggerAction);
  } else if (!stateTimer) {
    stateTimer = setTimeout(() => { stateTimer = null; flushStateBroadcast(triggerAction); }, 90 - (now - lastStateBroadcastAt));
  }
}

function flushStateBroadcast(triggerAction) {
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  lastStateBroadcastAt = performance.now();
  const payload = { type: 'state', volume: systemState.volume, brightness: systemState.brightness, media: systemState.media, changed: triggerAction || null };
  const json = JSON.stringify(payload);
  if (json === lastStateJson) return; // no duplicate broadcasts
  lastStateJson = json;
  for (const c of wss.clients) {
    if (c.readyState === 1 && c.wtbPaired) c.send(json);
  }
}
// ---------------------------------------------------------------------------
// Status endpoint for the Electron window
// ---------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({
    lanURL,
    pairingCode,
    pairedDevices: Array.from(pairedDevices.entries()).map(([ip, info]) => ({
      ip, deviceId: info.deviceId, pairedAt: info.pairedAt, lastSeen: info.lastSeen
    })),
    activityLog: activityLog.slice(-50)
  });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

const SLIDER_ACTIONS = new Set(['media.volume.set', 'system.brightness.set', 'media.seek']);

function shortClientId(deviceId) {
  const s = String(deviceId || '');
  return s.slice(-8);
}

async function sendInitialState(ws) {
  let { volume, brightness, media } = systemState;
  if (volume === null) {
    try {
      const r = await performAction('media.volume.get');
      if (r && typeof r.volume === 'number') { volume = r.volume; systemState.volume = volume; }
    } catch (_) {}
  }
  if (brightness === null) {
    try {
      const r = await performAction('system.brightness.get');
      if (r && typeof r.brightness === 'number') { brightness = r.brightness; systemState.brightness = brightness; }
    } catch (_) {}
  }
  if (media === null) {
    try {
      const r = await performAction('media.state.get');
      if (r && r.media) { media = r.media; systemState.media = media; }
    } catch (_) {}
  }
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'state', volume, brightness, media: media || null, changed: 'sync' }));
}

// Light periodic media polling while paired devices exist (best-effort).
setInterval(() => {
  if (!Array.from(wss.clients).some((c) => c.wtbPaired)) return;
  performAction('media.state.get').then((r) => {
    if (!r || !r.media) return;
    const prev = systemState.media;
    const next = r.media;
    const changed = JSON.stringify(prev) !== JSON.stringify(next);
    systemState.media = next;
    if (changed) queueStateBroadcast('media');
  }).catch(() => {});
}, 2500);

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.replace(/^::ffff:/, '');
  let deviceId = null;
  let paired = false;

  ws.wtbPaired = false;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (_) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      return;
    }

    if (msg.type === 'pair') {
      const incomingDeviceId = msg.deviceId || 'unknown';
      if (msg.code === pairingCode) {
        paired = true;
        ws.wtbPaired = true;
        deviceId = incomingDeviceId;
        pairedDevices.set(ip, {
          deviceId, pairedAt: new Date().toISOString(), lastSeen: new Date().toISOString()
        });
        addActivity({ type: 'pair', ip, deviceId, status: 'success' });
        ws.send(JSON.stringify({ type: 'pair_result', success: true }));
        sendDiagConfigTo(ws);
        broadcastStatus();
        sendInitialState(ws); // async, does not block the socket
      } else {
        addActivity({ type: 'pair', ip, deviceId: incomingDeviceId, status: 'failed' });
        ws.send(JSON.stringify({ type: 'pair_result', success: false }));
      }
      return;
    }

    if (msg.type === 'ping') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'state.get') {
      if (!paired) return;
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'state', volume: systemState.volume, brightness: systemState.brightness, media: systemState.media, changed: 'sync' }));
      }
      return;
    }

    if (msg.type === 'diag.report') {
      if (!paired) return;
      mergeDiagReport(msg.requestId, msg.report || {});
      return;
    }

    if (msg.type === 'action') {
      if (!paired) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Not paired' }));
        return;
      }
      const action = typeof msg.action === 'string' ? msg.action : '';
      if (!action) return;
      const ctx = { ws, ip, deviceId };

      // Timestamps for local diagnostics only (never exposed to the phone).
      msg._tRecv = performance.now();

      // Rate limit (final commit exempt so the last value is never dropped)
      if (!allowRate(ip, action) && !msg.final) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'action_result', action, requestId: msg.requestId || '',
            result: { status: 'error', rateLimited: true, message: 'Rate limit exceeded' }
          }));
        }
        return;
      }

      const info = pairedDevices.get(ip);
      if (info) info.lastSeen = new Date().toISOString();

      // Validation complete (session, presence, rate limit).
      msg._tValidate = performance.now();

      if (SLIDER_ACTIONS.has(action)) {
        enqueueSlider(ctx, msg);
      } else {
        runDiscrete(ctx, msg);
      }
    }
  });

  ws.on('close', () => {
    if (paired && deviceId) {
      addActivity({ type: 'disconnect', ip, deviceId });
      pairedDevices.delete(ip);
      broadcastStatus();
    }
  });
});

function broadcastStatus() {
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.wtbPaired) {
      // Pairing UI changes are only relevant to the Electron host; the phone
      // strip receives compact `state` messages instead.
      client.send(JSON.stringify({ type: 'status', pairedDevices: pairedDevices.size }));
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WinTouch Bar server running at ${lanURL}`);
  console.log(`Pairing code: ${pairingCode}`);
});

module.exports = { setDiagnosticsEnabled, getDiagnosticsEnabled, getDiagnostics, onNewDiag };