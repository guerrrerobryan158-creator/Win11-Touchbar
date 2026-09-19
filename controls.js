const { spawn } = require('child_process');
const path = require('path');

// ---------------------------------------------------------------------------
// Persistent PowerShell provider.
// Replaces the old "one fresh powershell.exe per action" model, which caused
// the 1-1.5s input delay. One warm process stays alive; each command is one
// short line on stdin, each reply is a single "@@WTB..." line on stdout.
// ---------------------------------------------------------------------------
const PROVIDER_SCRIPT = path.join(__dirname, 'provider.ps1');
const CLOSE_RESTART_DELAY_MS = 400;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 30000;

class PowerShellProvider {
  constructor() {
    this.child = null;
    this.ready = false;
    this.busy = false;
    this.queue = [];
    this.stdoutBuf = '';
    this.pendingCmd = null;
    this.crashes = [];
    this.dead = false;
  }

  ensure() {
    if (this.child || this.dead) return;
    this.ready = false;
    try {
      this.child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', PROVIDER_SCRIPT
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.child = null;
      this.failAll(e.message);
      return;
    }
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('data', (d) => { this.stdoutBuf += d.toString(); this.drainLines(); });
    this.child.on('error', (err) => { this.handleDeath(err.message); });
    this.child.on('close', (code) => { this.handleDeath('closed'); });
  }

  die(reason) {
    try { if (this.child) this.child.kill(); } catch (_) {}
    try { if (this.child) this.child.stdin.end(); } catch (_) {}
    this.child = null;
    this.ready = false;
    this.dieReason = reason;
  }

  recordCrash() {
    const now = Date.now();
    this.crashes.push(now);
    this.crashes = this.crashes.filter((t) => now - t <= CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_CRASHES) this.dead = true;
  }

  handleDeath(reason) {
    const wasWorking = this.ready || this.pendingCmd;
    this.child = null;
    this.ready = false;
    this.recordCrash();
    if (wasWorking) this.rejectPending(reason);
    this.failQueue(reason);
    if (!this.dead) setTimeout(() => this.ensure(), CLOSE_RESTART_DELAY_MS);
  }

  rejectPending(reason) {
    const job = this.pendingCmd;
    this.pendingCmd = null;
    this.busy = false;
    if (job) { clearTimeout(job.timer); job.reject(new Error('provider ' + reason)); }
  }

  failQueue(reason) {
    const q = this.queue;
    this.queue = [];
    for (const job of q) { clearTimeout(job.timer); job.reject(new Error('provider ' + reason)); }
  }

  failAll(reason) {
    this.rejectPending(reason);
    this.failQueue(reason);
  }

  drainLines() {
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      const t = line.trim();
      if (!t) continue;
      if (t === '@@WTBREADY') { this.ready = true; this.drain(); continue; }
      if (t.startsWith('@@WTB')) {
        let parsed;
        try { parsed = JSON.parse(t.slice(5)); }
        catch (_) { parsed = { ok: false, op: 'parse', raw: t.slice(0, 80) }; }
        this.resolve(parsed);
        continue;
      }
      // Ignore any other diagnostic line; never surface it to clients.
    }
  }

  resolve(result) {
    const job = this.pendingCmd;
    this.pendingCmd = null;
    this.busy = false;
    if (!job) { this.drain(); return; }
    clearTimeout(job.timer);
    job.resolve(result);
    this.drain();
  }

  drain() {
    if (this.busy || !this.ready || !this.child || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.busy = true;
    this.pendingCmd = job;
    try {
      const line = job.cmd + (job.arg !== undefined && job.arg !== null ? ' ' + job.arg : '') + '\n';
      this.child.stdin.write(line);
    } catch (e) {
      this.busy = false; this.pendingCmd = null; job.reject(e);
      this.die('stdin write failed');
      return;
    }
    job.timer = setTimeout(() => {
      this.die('timeout(' + job.cmd + ')');
      this.rejectPending('timeout');
      this.failQueue('timeout');
      if (!this.dead) setTimeout(() => this.ensure(), CLOSE_RESTART_DELAY_MS);
    }, job.timeout || 4000);
  }

  request(cmd, arg, opts) {
    opts = opts || {};
    if (this.dead) return Promise.reject(new Error('provider permanently unavailable'));
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, arg, timeout: opts.timeout || 4000, resolve, reject });
      this.ensure();
      this.drain();
    });
  }

  warm() {
    if (this.ready || this.child || this.dead) return;
    this.ensure();
  }
}

const provider = new PowerShellProvider();
setTimeout(() => provider.warm(), 300);
// ---------------------------------------------------------------------------
// One-shot PowerShell for rare system operations (no latency requirement).
// ---------------------------------------------------------------------------
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function clampInt(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const handlers = {

  // ---- System (rare operations; spawn cost irrelevant) ----
  async lock() {
    await runPowerShell('rundll32.exe user32.dll,LockWorkStation');
    return { status: 'ok' };
  },
  async sleep() {
    await runPowerShell('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
    return { status: 'ok' };
  },
  async shutdown() {
    await runPowerShell('shutdown /s /t 3 /f');
    return { status: 'ok' };
  },
  async restart() {
    await runPowerShell('shutdown /r /t 3 /f');
    return { status: 'ok' };
  },
  async logoff() {
    await runPowerShell('shutdown /l');
    return { status: 'ok' };
  },
  async empty_recycle_bin() {
    await runPowerShell('Clear-RecycleBin -Force -ErrorAction SilentlyContinue');
    return { status: 'ok' };
  },
  async turn_off_display() {
    const script = 'Add-Type -TypeDefinition @"' +
      'using System; using System.Runtime.InteropServices;' +
      'public class MonitorPower {' +
      '  [DllImport("user32.dll")] public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);' +
      '}"@' +
      ' [MonitorPower]::SendMessage([IntPtr]0xffff, 0x0112, 0xF170, 2) | Out-Null';
    await runPowerShell(script);
    return { status: 'ok' };
  },

  // ---- App Launcher ----
  async launch_notepad() { await runPowerShell('Start-Process notepad'); return { status: 'ok' }; },
  async launch_calculator() { await runPowerShell('Start-Process calc'); return { status: 'ok' }; },
  async launch_cmd() { await runPowerShell('Start-Process cmd'); return { status: 'ok' }; },

  // ---- Media keys (warm provider) ----
  async media_play_pause() { await provider.request('KEY', 179); return { status: 'ok' }; },
  async media_next() { await provider.request('KEY', 176); return { status: 'ok' }; },
  async media_prev() { await provider.request('KEY', 177); return { status: 'ok' }; },

  // ---- Volume ----
  async 'media.volume.get'() {
    const r = await provider.request('GVO', null, { timeout: 2000 });
    return { status: 'ok', volume: r.value, available: r.ok && r.value !== null };
  },
  async 'media.volume.set'(params) {
    const level = clampInt(params.level, 0, 100);
    if (level === null) return { status: 'error', message: 'Invalid volume level' };
    const r = await provider.request('SVO', level, { timeout: 2000 });
    return {
      status: r.ok ? 'ok' : 'error',
      volume: (r.value !== null && r.value !== undefined) ? r.value : level,
      message: r.ok ? undefined : 'Core Audio volume unavailable in this session'
    };
  },
  async 'media.volume.mute'(params) {
    const r = await provider.request('MUTE', params.mute ? 1 : 0, { timeout: 2000 });
    return { status: r.ok ? 'ok' : 'error', mute: !!r.value, message: r.ok ? undefined : 'Mute unavailable' };
  },
  async volume_up() { await provider.request('KEY', 0xAF); return { status: 'ok' }; },
  async volume_down() { await provider.request('KEY', 0xAE); return { status: 'ok' }; },
  async volume_mute() { await provider.request('KEY', 0xAD); return { status: 'ok' }; },

  // ---- Brightness (WMI, warm provider; one WMI call per op) ----
  async 'system.brightness.get'() {
    const r = await provider.request('GBR', null, { timeout: 2000 });
    return { status: 'ok', brightness: r.value, available: r.ok };
  },
  async 'system.brightness.set'(params) {
    const level = clampInt(params.level, 0, 100);
    if (level === null) return { status: 'error', message: 'Invalid brightness level' };
    const r = await provider.request('SBR', level, { timeout: 3000 });
    return {
      status: r.ok ? 'ok' : 'error',
      brightness: (r.value !== null && r.value !== undefined) ? r.value : level,
      message: r.ok ? undefined : 'Brightness set is unavailable (WMI/driver lacks WmiSetBrightness)'
    };
  },
  async brightness_up() {
    const cur = await provider.request('GBR', null, { timeout: 2000 });
    if (!cur.ok || cur.value === null) return { status: 'error', message: 'Brightness unsupported' };
    const sbr = await provider.request('SBR', clampInt(cur.value + 5, 0, 100), { timeout: 3000 });
    return { status: sbr.ok ? 'ok' : 'error', brightness: sbr.value };
  },
  async brightness_down() {
    const cur = await provider.request('GBR', null, { timeout: 2000 });
    if (!cur.ok || cur.value === null) return { status: 'error', message: 'Brightness unsupported' };
    const sbr = await provider.request('SBR', clampInt(cur.value - 5, 0, 100), { timeout: 3000 });
    return { status: sbr.ok ? 'ok' : 'error', brightness: sbr.value };
  },

  // ---- Media state / seek ----
  async 'media.state.get'() {
    const r = await provider.request('MSTATE', null, { timeout: 2500 });
    return { status: 'ok', media: r.media };
  },
  // Arbitrary seek is not exposed by Windows SMTC. This handler is the exact
  // integration point for a Comet/YouTube extension provider when available.
  async 'media.seek'(params) {
    const pos = Number(params.position);
    if (!Number.isFinite(pos) || pos < 0) return { status: 'error', message: 'Invalid position' };
    const r = await provider.request('SEEK', Math.round(pos * 10) / 10, { timeout: 2000 });
    if (!r.ok) {
      return { status: 'error', message: r.reason || 'Seek provider unavailable', position: pos };
    }
    return { status: 'ok', position: pos };
  },

  // ---- Test no-op actions ----
  async 'test.escape'() { return { status: 'ok', test: 'escape' }; },
  async 'test.screenshot'() { return { status: 'ok', test: 'screenshot' }; },
  async 'test.show_desktop'() { return { status: 'ok', test: 'show_desktop' }; }
};

async function performAction(action, params = {}) {
  const handler = handlers[action];
  if (!handler) {
    return { status: 'error', message: `Unknown action: ${action}` };
  }
  try {
    return await handler(params);
  } catch (e) {
    return { status: 'error', message: e.message || 'Provider error' };
  }
}

module.exports = { performAction, handlers, provider };