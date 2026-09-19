// WinTouch Bar - iPhone client (direct-feel inline control strip)
(function () {
  'use strict';

  // ---------------- DOM refs ----------------
  const $ = (id) => document.getElementById(id);
  const els = {
    pairingScreen: $('pairingScreen'),
    controlsScreen: $('controlsScreen'),
    portraitMode: $('portraitMode'),
    codeInputWrap: $('codeInputWrap'),
    codeHidden: $('codeHidden'),
    pairBtn: $('pairBtn'),
    pairError: $('pairError'),
    connIndicator: $('connIndicator'),
    connText: $('connText'),
    touchbar: $('touchbar'),
    appCenter: $('appCenter'),
    centerDefault: $('centerDefault'),
    centerExpanded: $('centerExpanded'),
    chevronBtn: $('chevronBtn'),
    closeExpandBtn: $('closeExpandBtn'),
    npTitle: $('npTitle'),
    npSub: $('npSub'),
    escKey: $('escKey'),
    menuBtn: $('menuBtn'),
    sheetBackdrop: $('sheetBackdrop'),
    bottomSheet: $('bottomSheet'),
    pairingDetailsBtn: $('pairingDetailsBtn'),
    togglePortraitBtn: $('togglePortraitBtn'),
    unpairBtn: $('unpairBtn'),
    backToStripBtn: $('backToStripBtn'),
    pairBackdrop: $('pairBackdrop'),
    pairInfo: $('pairInfo'),
    closePairInfo: $('closePairInfo'),
    pairUrl: $('pairUrl'),
    pairInfoCode: $('pairInfoCode'),
    actionStatus: $('actionStatus'),
    brightnessCtrl: $('brightnessCtrl'),
    volumeCtrl: $('volumeCtrl'),
    expBrightCtrl: $('expBrightCtrl'),
    expVolCtrl: $('expVolCtrl'),
    brightnessIcon: $('brightnessIcon'),
    volumeIcon: $('volumeIcon'),
    muteBtn: $('muteBtn'),
    seekRow: $('seekRow'),
    seekTrack: $('seekTrack'),
    seekFill: $('seekFill'),
    seekThumb: $('seekThumb'),
    seekPos: $('seekPos')
  };

  // ---------------- State ----------------
  let ws = null;
  let paired = false;
  let reconnectTimer = null;
  let expandedOpen = false;
  let inPortraitMode = false;
  let connIndicatorTimer = null;
  let pairingCodeCache = null;
  let lanUrlCache = null;
  let diagEnabled = false;
  let seq = 0;

  // Server-authoritative (Windows) state; the phone never waits for these to
  // react, they are only used to reconcile after gestures.
  const serverState = { volume: null, brightness: null, media: null };

  // Active gestures per kind ('volume' | 'brightness')
  const gestures = {};
  const kindRoots = { volume: [], brightness: [] };
  const KIND_ACTION = { volume: 'media.volume.set', brightness: 'system.brightness.set' };
  const KIND_INTERVAL = { volume: 60, brightness: 80 }; // ms between sends (16.7Hz / 12.5Hz)
  const KIND_PPX = { volume: 1.5, brightness: 1.7 };    // px per 1% (≈1.2-1.8 recommended)

  const nowP = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
  const nextId = (p) => (p || 'a') + Date.now().toString(36).slice(-5) + (++seq);

  // ---------------- Local diagnostics (bounded, local only) ----------------
  const diagLocal = [];
  function diagRec(e) {
    diagLocal.push({ t: new Date().toISOString(), ...e });
    if (diagLocal.length > 100) diagLocal.shift();
  }

  let inMemoryDeviceId = null;
  function getDeviceId() {
    try {
      let id = localStorage.getItem('wtb_device_id');
      if (!id) {
        id = 'iPhone-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        localStorage.setItem('wtb_device_id', id);
      }
      return id;
    } catch (e) {
      if (!inMemoryDeviceId) inMemoryDeviceId = 'iPhone-TEMP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      return inMemoryDeviceId;
    }
  }

  // ---------------- WebSocket ----------------
  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  function setConnState(state) {
    const el = els.connIndicator;
    if (!el) return;
    el.classList.remove('conn-offline', 'conn-online', 'conn-connecting');
    el.classList.add('conn-' + state);
    els.connText.textContent = state === 'online' ? 'Connected'
      : state === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  }

  function scheduleReconnect() {
    if (reconnectTimer) return; // never stack reconnect timers
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    setConnState('connecting');
    try {
      ws = new WebSocket(getWsUrl());
    } catch (e) {
      setConnState('offline');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      setConnState('online');
      if (paired) sendPair(); // silent re-pair (session stays valid)
    };

    ws.onclose = () => {
      setConnState('offline');
      scheduleReconnect();
    };

    ws.onerror = () => {};

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      handleMessage(msg);
    };
  }

  function wsSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function sendPair() {
    wsSend({ type: 'pair', code: els.codeHidden && els.codeHidden.value ? els.codeHidden.value : pairingCodeCache, deviceId: getDeviceId() });
  }

  // Keep-alive heartbeat (never blocks actions; just a light ping)
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 15000);
// Pending request bookkeeping (diagnostics only; bounded)
  const pendingReq = new Map();
  function trackReq(requestId, meta) {
    if (!requestId) return;
    pendingReq.set(requestId, meta);
    if (pendingReq.size > 50) pendingReq.delete(pendingReq.keys().next().value);
  }

  // Reports server->phone and total latency back for the Electron diagnostics
  // table. Only active when the Electron host enabled diagnostics.
  function reportDiag(msg) {
    if (!diagEnabled || !msg.requestId) return;
    const m = pendingReq.get(msg.requestId);
    if (!m) return;
    pendingReq.delete(msg.requestId);
    const tAck = nowP();
    const report = {
      serverToPhoneMs: Math.round(tAck - m.tSend),
      totalMs: Math.round(tAck - m.t0),
      localVisualMs: m.tFirstFrame ? Math.round(m.tFirstFrame - m.t0) : null
    };
    diagRec({
      actionId: m.actionId, requestId: msg.requestId, action: msg.action,
      result: ((msg.result || {}).status) || 'ok', ...report
    });
    wsSend({ type: 'diag.report', requestId: msg.requestId, report });
  }

  // ---------------- Visuals / icons ----------------
  function clamp100(v) { return Math.max(0, Math.min(100, Math.round(v))); }

  function setSliderVisual(kind, pct) {
    const v = clamp100(pct);
    for (const root of kindRoots[kind]) {
      const fill = root && root.querySelector('.sc-fill');
      const thumb = root && root.querySelector('.sc-thumb');
      if (fill) fill.style.width = v + '%';
      if (thumb) thumb.style.left = v + '%';
      if (root && root.getAttribute('role') === 'slider') root.setAttribute('aria-valuenow', String(v));
    }
    if (kind === 'volume') renderVolumeIcon(v);
  }

  function renderVolumeIcon(v) {
    const root = els.volumeCtrl;
    if (!root) return;
    const cls = v <= 0 ? 'v-off' : (v < 35 ? 'v-low' : (v < 70 ? 'v-mid' : 'v-high'));
    root.classList.remove('v-off', 'v-low', 'v-mid', 'v-high');
    root.classList.add(cls);
  }

  function applySlider(kind, pct) {
    if (kind === 'volume') serverState.volume = clamp100(pct);
    if (kind === 'brightness') serverState.brightness = clamp100(pct);
    setSliderVisual(kind, pct);
  }

  // ---------------- Server message handling ----------------
  function handleMessage(msg) {
    switch (msg.type) {
      case 'pair_result':
        if (msg.success) {
          paired = true;
          showStrip();
          if (els.pairError) els.pairError.classList.add('hidden');
          if (els.pairBtn) { els.pairBtn.disabled = false; els.pairBtn.textContent = 'Connect'; }
        } else {
          paired = false;
          if (els.pairError) els.pairError.classList.remove('hidden');
          if (els.codeHidden) els.codeHidden.classList.add('error');
          if (els.pairBtn) { els.pairBtn.disabled = false; els.pairBtn.textContent = 'Connect'; }
          clearCode();
        }
        break;
      case 'state':
        onStateMsg(msg);
        break;
      case 'action_result':
        onActionResult(msg);
        break;
      case 'diag':
        diagEnabled = !!msg.enabled;
        if (!diagEnabled) diagLocal.length = 0;
        break;
      case 'error':
        for (const kind of Object.keys(gestures)) {
          const g = gestures[kind];
          if (g && !g.ended && msg.requestId && msg.requestId === g.requestIdFinal) {
            onActionResult({ type: 'action_result', action: g.action, requestId: msg.requestId, result: { status: 'error', message: msg.message } });
          }
        }
        break;
      case 'pong':
      case 'status':
        break;
    }
  }

  function onStateMsg(msg) {
    if (typeof msg.volume === 'number') {
      const active = gestures.volume && !gestures.volume.ended && gestures.volume.dragging;
      if (!active) { serverState.volume = clamp100(msg.volume); setSliderVisual('volume', msg.volume); }
      else { serverState.volume = clamp100(msg.volume); }
    }
    if (typeof msg.brightness === 'number') {
      const active = gestures.brightness && !gestures.brightness.ended && gestures.brightness.dragging;
      if (!active) { serverState.brightness = clamp100(msg.brightness); setSliderVisual('brightness', msg.brightness); }
    }
    if (msg.media) onMediaState(msg.media);
  }
//  ---------------- Action results & reconciliation ----------------
  function kindForAction(a) {
    if (a === 'media.volume.set') return 'volume';
    if (a === 'system.brightness.set') return 'brightness';
    return null;
  }

  function onActionResult(msg) {
    reportDiag(msg);
    const kind = kindForAction(msg.action);
    const g = kind ? gestures[kind] : null;

    if (kind && g && !g.ended && msg.requestId && msg.requestId === g.requestIdFinal) {
      g.confirmed = true;
      const result = msg.result || {};
      if (result.status === 'ok') {
        if (typeof result.volume === 'number') { serverState.volume = clamp100(result.volume); setSliderVisual('volume', result.volume); }
        if (typeof result.brightness === 'number') { serverState.brightness = clamp100(result.brightness); setSliderVisual('brightness', result.brightness); }
      } else {
        // Provider error: keep Windows-authoritative value when the server knows it
        if (typeof result.volume === 'number') { serverState.volume = clamp100(result.volume); setSliderVisual('volume', result.volume); }
        else if (typeof result.brightness === 'number') { serverState.brightness = clamp100(result.brightness); setSliderVisual('brightness', result.brightness); }
      }
      endGesture(kind);
      return;
    }

    if (msg.action === 'media_play_pause' && msg.result && msg.result.status === 'error') {
      togglePlayPauseVisual(false);
    }
    if (msg.action === 'media.volume.mute' && msg.result && typeof msg.result.mute === 'boolean') {
      updateMuteVisual(msg.result.mute);
    }
  }

  function endGesture(kind) {
    const g = gestures[kind];
    if (!g || g.ended) return;
    g.ended = true;
    if (g.confirmTimer) clearTimeout(g.confirmTimer);
    restartIdleCollapse(kind);
  }

  function onMediaState(media) {
    const wasEmpty = !(serverState.media && serverState.media.duration);
    serverState.media = media;
    const nowEmpty = !(media && media.duration);
    if (wasEmpty !== nowEmpty) updateSeekAvailability();
    else if (!nowEmpty) updateSeekAvailability();
    if (!seekingNow) {
      constrainSeekTo(media.position || 0, media.duration || 0);
      seek.playing = !!media.playing;
    }
  }

  // ---------------- Seek state ----------------
  const seek = {
    duration: 0,
    position: 0,
    playing: false,
    dragging: false,
    pointerId: null,
    suppressed: false,
    lastServerAt: 0,
    lastPosAt: 0
  };
  let seekingNow = false;

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function constrainSeekTo(position, duration) {
    if (!(duration > 0)) return;
    seek.position = Math.max(0, Math.min(duration, position));
    seek.duration = duration;
    const track = els.seekTrack;
    if (!track) return;
    const pct = duration > 0 ? (seek.position / duration) * 100 : 0;
    els.seekFill.style.width = pct + '%';
    els.seekThumb.style.left = pct + '%';
    els.seekPos.textContent = fmtTime(seek.position) + ' / ' + fmtTime(duration);
    els.seekTrack.setAttribute('aria-valuenow', String(Math.round(pct * 10)));
  }

  function updateMuteVisual(muted) {
    if (els.muteBtn) els.muteBtn.classList.toggle('is-muted', !!muted);
  }

  // Shows/hides the seek scrubber and syncs it from server media state.
  function updateSeekAvailability() {
    const m = serverState.media;
    const has = !!(m && m.duration > 0);
    if (els.seekRow) els.seekRow.hidden = !has;
    if (els.appCenter) els.appCenter.classList.toggle('has-media', has);
    if (!has) {
      seek.duration = 0;
      seek.position = 0;
      seek.playing = false;
      if (els.seekPos) els.seekPos.textContent = '–:––';
      return;
    }
    seek.playing = !!m.playing;
    seek.lastPosAt = nowP();
    constrainSeekTo(m.position || 0, m.duration);
  }
//  ---------------- Inline slider control (volume & brightness) ----------------
  const collapseTimers = {};

  function restartIdleCollapse(kind) {
    if (collapseTimers[kind]) clearTimeout(collapseTimers[kind]);
    collapseTimers[kind] = setTimeout(() => {
      collapseTimers[kind] = null;
      const g = gestures[kind];
      if (g && !g.ended) return;
      for (const root of kindRoots[kind]) root.classList.remove('sc-open', 'sc-pressed', 'sc-dragging');
    }, 700); // 650-900ms idle collapse
  }

  function getStartValue(kind) {
    const v = kind === 'volume' ? serverState.volume : serverState.brightness;
    return (typeof v === 'number') ? v : 50;
  }

  function setupSliderCtrl(root, kind) {
    if (!root) return;
    if (!kindRoots[kind].includes(root)) kindRoots[kind].push(root);

    const frameObj = { pending: false };
    function scheduleFrame(g) {
      if (frameObj.pending) return;
      frameObj.pending = true;
      requestAnimationFrame(() => {
        frameObj.pending = false;
        if (!g.ended) {
          setSliderVisual(kind, g.current);
          const interval = KIND_INTERVAL[kind] || 70;
          const t = nowP();
          if (g.dragging && (t - g.lastSendAt) >= interval && g.current !== g.lastSent) {
            g.lastSent = g.current;
            g.lastSendAt = t;
            sendSlider(kind, g, g.current, false);
          }
        }
      });
    }

    function sendSlider(kind, g, level, final) {
      if (!paired || !ws || ws.readyState !== WebSocket.OPEN) return;
      const payload = {
        type: 'action', action: KIND_ACTION[kind],
        params: { level }, actionId: g.actionId, final: !!final
      };
      if (final) {
        payload.level = level;
        payload.requestId = nextId('r');
        g.requestIdFinal = payload.requestId;
        g.lastSent = level;
        trackReq(payload.requestId, { t0: g.tPointerDown, tSend: nowP(), tFirstFrame: g.tFirstFrame, actionId: g.actionId });
      }
      if (diagEnabled) {
        payload.t0 = Math.round(g.tPointerDown);
        payload.tSend = Math.round(nowP());
        payload.tFirstFrame = g.tFirstFrame || 0;
      }
      wsSend(payload);
    }

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      if (gestures[kind] && !gestures[kind].ended) return; // one gesture per kind

      const start = clamp100(getStartValue(kind));
      const g = {
        root, kind, actionId: nextId('g'),
        tPointerDown: nowP(), tFirstFrame: 0,
        startX: e.clientX, startY: e.clientY,
        startVal: start, current: start,
        dragging: false, moved: false,
        ended: false, confirmed: false, confirmTimer: null,
        requestIdFinal: null, lastSent: start, lastSendAt: 0
      };
      gestures[kind] = g;

      root.classList.add('sc-open', 'sc-pressed'); // same frame feedback
      try { root.setPointerCapture(e.pointerId); } catch (_) {}

      requestAnimationFrame(() => { if (!g.tFirstFrame) g.tFirstFrame = Math.round(nowP()); });
      setSliderVisual(kind, start); // local, no server wait
      scheduleFrame(g);
      restartIdleCollapse(kind);
    });

    root.addEventListener('pointermove', (e) => {
      const g = gestures[kind];
      if (!g || g.ended) return;
      if (!g.dragging) {
        const dx = e.clientX - g.startX;
        if (Math.abs(dx) > 3) { g.dragging = true; root.classList.add('sc-dragging'); }
        else return;
      }
      g.moved = true;
      const next = clamp100(g.startVal + (e.clientX - g.startX) / (KIND_PPX[kind] || 1.5));
      if (next !== g.current) { g.current = next; scheduleFrame(g); }
      restartIdleCollapse(kind);
    });
const endPointer = (e) => {
      const g = gestures[kind];
      if (!g || g.ended) return;
      try { if (root.hasPointerCapture && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId); } catch (_) {}
      root.classList.remove('sc-pressed');

      if (g.dragging || g.moved) {
        sendSlider(kind, g, g.current, true); // exact final, highest priority
      }
      // Stop any queued animation frame from sending an intermediate value
      // after release (the final commit above is authoritative).
      g.dragging = false;
      g.moved = false;
      setSliderVisual(kind, g.current);

      if (!g.dragging && !g.moved) {
        // tap: slider stays open & immediately ready for a drag
        if (collapseTimers[kind]) clearTimeout(collapseTimers[kind]);
        restartIdleCollapse(kind);
        return;
      }
      // wait briefly for authoritative confirmation, then collapse on idle
      g.confirmTimer = setTimeout(() => endGesture(kind), 600);
    };
    root.addEventListener('pointerup', endPointer);
    root.addEventListener('pointercancel', endPointer);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setupSliderCtrl(els.brightnessCtrl, 'brightness');
  setupSliderCtrl(els.volumeCtrl, 'volume');
  setupSliderCtrl(els.expBrightCtrl, 'brightness');
  setupSliderCtrl(els.expVolCtrl, 'volume');
//  ---------------- Media seek scrubber (direct feel) ----------------
  let seekGesture = null;
  const SEEK_INTERVAL = 78; // ~12.8Hz while dragging
  let lastSeekSentAt = 0;

  function seekWidthRect() {
    const r = els.seekTrack.getBoundingClientRect();
    return { left: r.left, width: Math.max(1, r.width) };
  }

  function sendSeek(position, final) {
    if (!paired || !seek.duration) return;
    const payload = {
      type: 'action', action: 'media.seek',
      params: { position: Math.round(position * 10) / 10 },
      actionId: seekGesture ? seekGesture.actionId : 'seek_' + nextId('g'),
      final: !!final
    };
    payload.level = undefined;
    if (final) {
      payload.requestId = nextId('r');
      if (seekGesture) seekGesture.requestIdFinal = payload.requestId;
      trackReq(payload.requestId, {
        t0: seekGesture ? seekGesture.tDown : nowP(),
        tSend: nowP(), tFirstFrame: null,
        actionId: seekGesture ? seekGesture.actionId : ''
      });
    }
    if (diagEnabled) {
      payload.t0 = seekGesture ? Math.round(seekGesture.tDown) : Math.round(nowP());
      payload.tSend = Math.round(nowP());
    }
    wsSend(payload);
    lastSeekSentAt = nowP();
  }

  if (els.seekTrack) {
    els.seekTrack.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (!(seek.duration > 0)) return;
      e.preventDefault();
      try { els.seekTrack.setPointerCapture(e.pointerId); } catch (_) {}
      const rect = seekWidthRect();
      seekGesture = {
        actionId: nextId('sg'), tDown: nowP(), startX: e.clientX,
        startPos: seek.position, dragging: true, suppressed: true, requestIdFinal: null
      };
      seekingNow = true;
      const norm = clamp01((e.clientX - rect.left) / rect.width);
      constrainSeekTo(seek.duration * norm, seek.duration);
      sendSeek(seek.position, true); // direct tap = immediate commit preview
    });

    els.seekTrack.addEventListener('pointermove', (e) => {
      if (!seekGesture || !seekGesture.dragging) return;
      const rect = seekWidthRect();
      const norm = clamp01((e.clientX - rect.left) / rect.width);
      constrainSeekTo(seek.duration * norm, seek.duration);
      const t = nowP();
      if (t - lastSeekSentAt >= SEEK_INTERVAL) sendSeek(seek.position, false);
    });

    const seekEnd = (e) => {
      if (!seekGesture || !seekGesture.dragging) return;
      try { if (els.seekTrack.hasPointerCapture && els.seekTrack.hasPointerCapture(e.pointerId)) els.seekTrack.releasePointerCapture(e.pointerId); } catch (_) {}
      seekGesture.dragging = false;
      sendSeek(seek.position, true); // exact final
      // suppress stale server positions briefly, then resume
      seekGesture = null;
      setTimeout(() => { seekingNow = false; seek.suppressed = false; }, 700);
    };
    els.seekTrack.addEventListener('pointerup', seekEnd);
    els.seekTrack.addEventListener('pointercancel', seekEnd);
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // Playback progression between server media-state pushes (rAF driven)
  let seekRafId = null;
  let lastSeekLabelSec = -1;
  function seekProgressionLoop() {
    seekRafId = requestAnimationFrame(seekProgressionLoop);
    if (!seek.duration || seekingNow || !seek.playing || document.hidden) {
      seek.lastPosAt = nowP();
      return;
    }
    const t = nowP();
    const dt = (t - (seek.lastPosAt || t)) / 1000;
    seek.lastPosAt = t;
    if (dt <= 0 || dt > 2) return; // backgrounded/clock jump: let the server push resync
    seek.position = Math.min(seek.duration, seek.position + dt);
    const pct = (seek.position / seek.duration) * 100;
    els.seekFill.style.width = pct + '%';
    els.seekThumb.style.left = pct + '%';
    const secNow = Math.floor(seek.position);
    if (secNow !== lastSeekLabelSec) {
      lastSeekLabelSec = secNow;
      els.seekPos.textContent = fmtTime(seek.position) + ' / ' + fmtTime(seek.duration);
    }
  }
  seekRafId = requestAnimationFrame(seekProgressionLoop);

  function seekActiveFromServer() {
    const m = serverState.media;
    if (m && m.duration) { seek.playing = !!m.playing; seek.lastPosAt = nowP(); }
  }
//  ---------------- Discrete actions ----------------
  let mutedState = false;

  function sendDiscrete(action, extra) {
    if (!paired) return;
    const payload = { type: 'action', action, params: extra && extra.params ? extra.params : {} };
    payload.actionId = nextId('a');
    payload.requestId = nextId('r');
    trackReq(payload.requestId, { t0: nowP(), tSend: nowP(), tFirstFrame: null, actionId: payload.actionId });
    if (diagEnabled) {
      payload.t0 = Math.round(nowP());
      payload.tSend = Math.round(nowP());
    }
    wsSend(payload);
  }

  function togglePlayPauseVisual(opting) {
    document.querySelectorAll('.play-btn, .ex-play').forEach((btn) => {
      btn.classList.toggle('is-playing');
    });
  }

  function bindAction(btn) {
    attachPressed(btn);
    btn.addEventListener('click', (e) => {
      const action = btn.dataset.action;
      if (!action) return;
      if (action === 'media_play_pause') {
        togglePlayPauseVisual(true); // optimistic flip
        if (seek.duration) { seek.playing = !seek.playing; constrainSeekTo(seek.position, seek.duration); }
        sendDiscrete(action);
      } else if (action === 'media_prev' || action === 'media_next') {
        sendDiscrete(action);
      } else {
        sendDiscrete(action);
      }
    });
  }

  document.querySelectorAll('[data-action]').forEach(bindAction);

  // Mute (expanded control strip)
  if (els.muteBtn) {
    attachPressed(els.muteBtn);
    els.muteBtn.addEventListener('click', () => {
      mutedState = !mutedState;
      updateMuteVisual(mutedState);
      sendDiscrete('media.volume.mute', { params: { mute: mutedState } });
    });
  }

  // ---------------- Expanded / compact center ----------------
  function expandControls() {
    expandedOpen = true;
    els.appCenter.classList.add('expanded');
    if (els.chevronBtn) els.chevronBtn.setAttribute('aria-expanded', 'true');
  }
  function collapseExpanded() {
    expandedOpen = false;
    els.appCenter.classList.remove('expanded');
    if (els.chevronBtn) els.chevronBtn.setAttribute('aria-expanded', 'false');
  }
  if (els.chevronBtn) {
    attachPressed(els.chevronBtn);
    els.chevronBtn.addEventListener('click', () => { expandedOpen ? collapseExpanded() : expandControls(); });
  }
  if (els.closeExpandBtn) {
    attachPressed(els.closeExpandBtn);
    els.closeExpandBtn.addEventListener('click', collapseExpanded);
  }

  // ---------------- Pressed visuals (50-90ms, one frame) ----------------
  function attachPressed(el) {
    if (!el) return;
    el.addEventListener('pointerdown', () => el.classList.add('is-pressed'));
    const clear = () => el.classList.remove('is-pressed');
    el.addEventListener('pointerup', clear);
    el.addEventListener('pointercancel', clear);
    el.addEventListener('pointerleave', clear);
  }
//  ---------------- Screens ----------------
  function updateDigits() {
    if (!els.codeHidden) return;
    const v = (els.codeHidden.value || '').replace(/\D/g, '').slice(0, 6);
    if (v !== els.codeHidden.value) els.codeHidden.value = v;
  }

  function clearCode() {
    if (!els.codeHidden) return;
    els.codeHidden.value = '';
    els.codeHidden.classList.remove('error');
  }

  function paintKnownState() {
    if (typeof serverState.volume === 'number') setSliderVisual('volume', serverState.volume);
    if (typeof serverState.brightness === 'number') setSliderVisual('brightness', serverState.brightness);
    updateSeekAvailability();
  }

  function showStrip() {
    if (els.pairingScreen) els.pairingScreen.classList.add('hidden');
    if (els.portraitMode) els.portraitMode.classList.add('hidden');
    if (els.controlsScreen) els.controlsScreen.classList.remove('hidden');
    inPortraitMode = false;
    paintKnownState();
  }

  function enterPairing() {
    if (els.controlsScreen) els.controlsScreen.classList.add('hidden');
    if (els.portraitMode) els.portraitMode.classList.add('hidden');
    if (els.pairingScreen) els.pairingScreen.classList.remove('hidden');
  }

  function enterStrip() {
    inPortraitMode = false;
    if (els.portraitMode) els.portraitMode.classList.add('hidden');
    if (els.pairingScreen) els.pairingScreen.classList.add('hidden');
    if (els.controlsScreen) els.controlsScreen.classList.remove('hidden');
  }

  function enterPortrait() {
    inPortraitMode = true;
    if (els.controlsScreen) els.controlsScreen.classList.add('hidden');
    if (els.pairingScreen) els.pairingScreen.classList.add('hidden');
    if (els.portraitMode) els.portraitMode.classList.remove('hidden');
  }
//  ---------------- Menu sheet + pairing details ----------------
  function openSheet() {
    if (!els.bottomSheet) return;
    els.sheetBackdrop.hidden = false;
    els.bottomSheet.hidden = false;
    requestAnimationFrame(() => {
      els.sheetBackdrop.classList.add('show');
      els.bottomSheet.classList.add('show');
    });
  }
  function closeSheet() {
    if (!els.bottomSheet) return;
    els.sheetBackdrop.classList.remove('show');
    els.bottomSheet.classList.remove('show');
    setTimeout(() => { els.sheetBackdrop.hidden = true; els.bottomSheet.hidden = true; }, 120);
  }
  function openPairInfo() {
    closeSheet();
    if (els.pairUrl) els.pairUrl.textContent = lanUrlCache || location.host;
    if (els.pairInfoCode) els.pairInfoCode.textContent = pairingCodeCache || '------';
    els.pairBackdrop.hidden = false;
    els.pairInfo.hidden = false;
  }
  function closePairInfo() {
    els.pairBackdrop.hidden = true;
    els.pairInfo.hidden = true;
  }

  // ---------------- Pairing UI ----------------
  function tryPair() {
    updateDigits();
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    if (!els.codeHidden.value || els.codeHidden.value.length !== 6) {
      if (els.pairError) {
        els.pairError.textContent = 'Enter the 6-digit code shown on your PC.';
        els.pairError.classList.remove('hidden');
      }
      return;
    }
    if (els.pairBtn) { els.pairBtn.disabled = true; els.pairBtn.textContent = 'Connecting…'; }
    sendPair();
  }

  if (els.codeHidden) {
    els.codeHidden.addEventListener('input', () => { els.codeHidden.classList.remove('error'); updateDigits(); });
    els.codeHidden.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { els.codeHidden.blur(); tryPair(); }
    });
  }
  if (els.pairBtn) els.pairBtn.addEventListener('click', tryPair);

  // ---------------- Menu wiring ----------------
  if (els.menuBtn) { attachPressed(els.menuBtn); els.menuBtn.addEventListener('click', openSheet); }
  if (els.sheetBackdrop) els.sheetBackdrop.addEventListener('click', closeSheet);
  if (els.pairingDetailsBtn) els.pairingDetailsBtn.addEventListener('click', openPairInfo);
  if (els.closePairInfo) els.closePairInfo.addEventListener('click', closePairInfo);
  if (els.pairBackdrop) els.pairBackdrop.addEventListener('click', closePairInfo);
  if (els.togglePortraitBtn) {
    els.togglePortraitBtn.addEventListener('click', () => {
      closeSheet();
      if (inPortraitMode) { enterStrip(); } else { enterPortrait(); }
    });
  }
  if (els.backToStripBtn) els.backToStripBtn.addEventListener('click', enterStrip);
  if (els.unpairBtn) {
    els.unpairBtn.addEventListener('click', () => {
      paired = false;
      if (ws) { try { ws.close(); } catch (_) {} ws = null; }
      closeSheet();
      clearCode();
      enterPairing();
      setConnState('offline');
    });
  }
//  ---------------- Init ----------------
  getDeviceId();
  lanUrlCache = location.host;
  updateDigits();

  fetch('/api/status')
    .then((r) => r.json())
    .then((data) => {
      if (data.lanURL) lanUrlCache = data.lanURL;
      if (data.pairingCode) pairingCodeCache = data.pairingCode;
    })
    .catch(() => {});

  requestAnimationFrame(() => { paintKnownState(); });
  connect();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!ws || ws.readyState !== WebSocket.OPEN)) connect();
  });

  document.addEventListener('dblclick', (e) => e.preventDefault());
})();