// Electron window renderer logic
const $ = (id) => document.getElementById(id);

const els = {
  serverStatus: $('serverStatus'),
  serverStatusText: $('serverStatusText'),
  qrPlaceholder: $('qrPlaceholder'),
  qrImage: $('qrImage'),
  lanUrl: $('lanUrl'),
  copyBtn: $('copyBtn'),
  pairingCode: $('pairingCode'),
  deviceList: $('deviceList'),
  activityLog: $('activityLog')
};

let currentUrl = '';

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function deviceIdLabel(device) {
  return `${device.deviceId} · ${device.ip}`;
}

function renderStatus(status) {
  // Server status
  if (status.lanURL) {
    els.serverStatus.classList.add('online');
    els.serverStatus.classList.remove('offline');
    els.serverStatusText.textContent = `Online · ${status.lanURL}`;
  } else {
    els.serverStatus.classList.add('offline');
    els.serverStatus.classList.remove('online');
    els.serverStatusText.textContent = 'Offline';
    return;
  }

  // URL
  els.lanUrl.value = status.lanURL || '';
  currentUrl = status.lanURL;

  // QR code
  if (status.qrDataUrl) {
    els.qrImage.src = status.qrDataUrl;
    els.qrImage.classList.remove('hidden');
    els.qrPlaceholder.classList.add('hidden');
  }

  // Pairing code
  els.pairingCode.textContent = status.pairingCode || '------';

  // Paired devices
  const devices = status.pairedDevices || [];
  els.deviceList.innerHTML = '';
  if (devices.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-device';
    li.textContent = 'No devices paired yet.';
    els.deviceList.appendChild(li);
  } else {
    devices.forEach((dev) => {
      const li = document.createElement('li');
      li.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = `${dev.deviceId} · ${dev.ip}`;
      li.appendChild(span);
      els.deviceList.appendChild(li);
    });
  }

  // Activity log
  renderLog(status.activityLog || []);
}

function renderLog(entries) {
  els.activityLog.innerHTML = '';
  if (entries.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty-log';
    div.textContent = 'Waiting for activity…';
    els.activityLog.appendChild(div);
    return;
  }

  // Show newest at top
  const reversed = [...entries].reverse();
  reversed.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'log-entry';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatTime(entry.time);

    const type = document.createElement('span');
    type.className = 'log-type';

    const msg = document.createElement('span');
    msg.className = 'log-message';

    switch (entry.type) {
      case 'pair':
        type.classList.add('log-type-pair');
        type.textContent = 'PAIR';
        msg.textContent = entry.status === 'success'
          ? `${entry.deviceId} (${entry.ip}) paired successfully`
          : `Failed pairing attempt from ${entry.ip}`;
        if (entry.status !== 'success') {
          type.classList.remove('log-type-pair');
          type.classList.add('log-type-pair-failed');
        }
        break;
      case 'action':
        type.classList.add('log-type-action');
        type.textContent = 'ACTION';
        msg.textContent = `${entry.deviceId} (${entry.ip}) → ${entry.action} — ${entry.result ? entry.result.status : 'ok'}`;
        break;
      case 'disconnect':
        type.classList.add('log-type-disconnect');
        type.textContent = 'LEFT';
        msg.textContent = `${entry.deviceId} (${entry.ip}) disconnected`;
        break;
      default:
        type.textContent = entry.type;
        msg.textContent = JSON.stringify(entry);
    }

    row.appendChild(time);
    row.appendChild(type);
    row.appendChild(msg);
    els.activityLog.appendChild(row);
  });

  // Auto scroll to top (newest-first)
  els.activityLog.scrollTop = 0;
}

// Copy URL button
els.copyBtn.addEventListener('click', async () => {
  if (!els.lanUrl.value) return;
  try {
    await navigator.clipboard.writeText(els.lanUrl.value);
    els.copyBtn.textContent = 'Copied!';
    setTimeout(() => { els.copyBtn.textContent = 'Copy'; }, 1500);
  } catch (e) {
    els.lanUrl.select();
    document.execCommand('copy');
    els.copyBtn.textContent = 'Copied!';
    setTimeout(() => { els.copyBtn.textContent = 'Copy'; }, 1500);
  }
});

// Initial status fetch
window.winTouchBar.getStatus().then((status) => {
  if (status && !status.error) {
    renderStatus(status);
  }
});

// Live updates from main process
window.winTouchBar.onStatusUpdate((payload) => {
  renderStatus(payload);
});

// ---------- Local latency diagnostics (Electron host only) ----------
const diagEls = {
  toggle: $('diagToggle'),
  copy: $('diagCopy'),
  clear: $('diagClear'),
  note: $('diagNote'),
  body: $('diagBody')
};

let diagEnabled = false;
let diagEntries = [];
let diagText = '';

function fmtMs(v) {
  return (typeof v === 'number' && isFinite(v)) ? String(v) : '—';
}

function shortClient(entry) {
  const c = entry.client ? String(entry.client) : (entry.session || '');
  return c.length > 8 ? c.slice(-8) : c;
}

function renderDiagnostics(payload) {
  if (!diagEls.body) return;
  diagEnabled = !!payload.enabled;
  diagEntries = payload.entries || [];

  if (diagEls.toggle) {
    diagEls.toggle.textContent = diagEnabled ? 'Disable diagnostics' : 'Enable diagnostics';
    diagEls.toggle.setAttribute('aria-pressed', diagEnabled ? 'true' : 'false');
    diagEls.toggle.classList.toggle('btn-on', diagEnabled);
  }
  if (diagEls.note) {
    diagEls.note.textContent = diagEnabled
      ? 'Recording locally · most recent 100 actions · nothing is sent anywhere'
      : 'Off by default · measured locally only · most recent 100 actions · nothing is sent anywhere';
  }

  // Build the copyable text once per update
  const lines = ['Time\tAction ID\tRequest ID\tClient\tLocal ms\tUp est ms\tValidate ms\tProvider ms\tServer to phone ms\tTotal ms\tResult'];

  diagEls.body.innerHTML = '';
  if (diagEntries.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 11;
    td.className = 'diag-empty';
    td.textContent = diagEnabled
      ? 'Waiting for actions from the phone…'
      : 'Enable diagnostics to record latency for every action.';
    tr.appendChild(td);
    diagEls.body.appendChild(tr);
    diagText = lines.join('\n');
    return;
  }

  // newest first
  for (let i = diagEntries.length - 1; i >= 0; i--) {
    const e = diagEntries[i];
    const total = e.totalMs;
    const local = e.localToSendMs;
    const validate = e.validateMs;
    const provider = e.providerMs;
    const down = e.serverToPhoneMs;
    const up = (typeof total === 'number')
      ? Math.max(0, total - (local || 0) - (validate || 0) - (provider || 0) - (down || 0))
      : null;

    const tr = document.createElement('tr');
    if (e.final) tr.classList.add('diag-final');
    if (e.result && e.result !== 'ok') tr.classList.add('diag-error');

    const cells = [
      formatTime(e.time),
      (e.actionId || '').slice(-10),
      (e.requestId || '').slice(-10),
      shortClient(e),
      fmtMs(local),
      fmtMs(up),
      fmtMs(validate),
      fmtMs(provider),
      fmtMs(down),
      fmtMs(total),
      (e.result || 'ok') + (e.final ? ' · final' : '')
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    diagEls.body.appendChild(tr);

    lines.push(cells.join('\t'));
  }

  diagText = lines.join('\n');
}

if (diagEls.toggle) {
  diagEls.toggle.addEventListener('click', async () => {
    const next = !diagEnabled;
    diagEnabled = await window.winTouchBar.setDiagnostics(next);
    const payload = await window.winTouchBar.getDiagnostics();
    renderDiagnostics(payload);
  });
}

if (diagEls.clear) {
  diagEls.clear.addEventListener('click', async () => {
    await window.winTouchBar.clearDiagnostics();
    const payload = await window.winTouchBar.getDiagnostics();
    renderDiagnostics(payload);
  });
}

if (diagEls.copy) {
  diagEls.copy.addEventListener('click', async () => {
    const ok = await window.winTouchBar.copyText(diagText);
    const prev = diagEls.copy.textContent;
    diagEls.copy.textContent = ok ? 'Copied!' : 'Copy failed';
    setTimeout(() => { diagEls.copy.textContent = prev; }, 1200);
  });
}

// Batched updates pushed from the main process (never per slider packet)
window.winTouchBar.onDiagnosticsUpdate((payload) => renderDiagnostics(payload));

// Initial state
window.winTouchBar.getDiagnostics().then((payload) => renderDiagnostics(payload));