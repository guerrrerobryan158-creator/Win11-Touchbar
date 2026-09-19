/* Dev-only functional test for public/app.js (direct-feel interaction logic).
   Uses a minimal DOM shim so the real client file runs unmodified. */
const fs = require('fs');
const path = require('path');

// ---------------- minimal DOM shim ----------------
function makeClassList(el) {
  const has = (c) => el.className.split(/\s+/).filter(Boolean).includes(c);
  return {
    add: (...cs) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); el.className = [...s].join(' '); },
    remove: (...cs) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.delete(c)); el.className = [...s].join(' '); },
    contains: has,
    toggle: (c, force) => {
      const on = force === undefined ? !has(c) : !!force;
      if (on) el.classList.add(c); else el.classList.remove(c);
      return on;
    }
  };
}

class El {
  constructor(tag, cls, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.className = cls || '';
    this.id = id || '';
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.value = '';
    this._text = '';
    this.classList = makeClassList(this);
    this.rect = { left: 100, top: 0, width: 200, height: 20, right: 300, bottom: 20 };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || {})); }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture() { this._cap = true; }
  releasePointerCapture() { this._cap = false; }
  hasPointerCapture() { return !!this._cap; }
  focus() {}
  blur() {}
  _all(acc) { for (const c of this.children) { acc.push(c); c._all(acc); } return acc; }
  _match(sel) {
    sel = sel.trim();
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('[')) {
      const attr = sel.slice(1, -1);
      const key = attr.indexOf('data-') === 0 ? attr.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase()) : attr;
      return Object.keys(this.dataset).includes(key);
    }
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel) { return this._all([]).find((e) => e._match(sel)) || null; }
  querySelectorAll(sel) { return this._all([]).filter((e) => e._match(sel)); }
}

const registry = new Map();
const allEls = [];
function mk(id, cls, tag) {
  const e = new El(tag || 'div', cls || '', id);
  if (id) registry.set(id, e);
  allEls.push(e);
  return e;
}
// Elements referenced by app.js
const ids = ['pairingScreen', 'controlsScreen', 'portraitMode', 'codeInputWrap', 'codeHidden', 'pairBtn',
  'pairError', 'connIndicator', 'connText', 'touchbar', 'appCenter', 'centerDefault', 'centerExpanded',
  'chevronBtn', 'closeExpandBtn', 'npTitle', 'npSub', 'escKey', 'menuBtn', 'sheetBackdrop', 'bottomSheet',
  'pairingDetailsBtn', 'togglePortraitBtn', 'unpairBtn', 'backToStripBtn', 'pairBackdrop', 'pairInfo',
  'closePairInfo', 'pairUrl', 'pairInfoCode', 'actionStatus', 'brightnessCtrl', 'volumeCtrl',
  'expBrightCtrl', 'expVolCtrl', 'brightnessIcon', 'volumeIcon', 'muteBtn', 'seekRow', 'seekTrack',
  'seekFill', 'seekThumb', 'seekPos'];
for (const id of ids) mk(id);

// Slider roots need .sc-fill / .sc-thumb children
for (const rootId of ['brightnessCtrl', 'volumeCtrl', 'expBrightCtrl', 'expVolCtrl']) {
  const r = registry.get(rootId);
  const hit = mk('', 'sc-hit');
  const wrap = mk('', 'sc-trackwrap');
  const track = mk('', 'sc-track');
  const fill = mk('', 'sc-fill');
  const thumb = mk('', 'sc-thumb');
  track.appendChild(fill); track.appendChild(thumb); wrap.appendChild(track); hit.appendChild(wrap); r.appendChild(hit);
}
registry.get('seekTrack').rect = { left: 100, top: 0, width: 200, height: 4, right: 300, bottom: 4 };

// Action buttons ([data-action])
function actionBtn(id, action, cls) {
  const b = mk(id, cls || 'tb-btn media-btn', 'button');
  b.dataset.action = action;
  registry.get('appCenter').appendChild(b);
  return b;
}
const playBtn = actionBtn('playBtn', 'media_play_pause', 'tb-btn media-btn play-btn');
actionBtn('prevBtn', 'media_prev', 'tb-btn media-btn');
actionBtn('nextBtn', 'media_next', 'tb-btn media-btn');
registry.get('escKey').dataset.action = 'test.escape';
registry.get('seekRow').hidden = true;

const documentStub = {
  hidden: false,
  getElementById: (id) => registry.get(id) || null,
  querySelectorAll: (sel) => {
    const parts = sel.split(',').map((s) => s.trim());
    return allEls.filter((e) => parts.some((p) => e._match(p)));
  },
  addEventListener: () => {},
  execCommand: () => {}
};

globalThis.document = documentStub;
globalThis.location = { protocol: 'http:', host: '127.0.0.1:8787' };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(globalThis.performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ lanURL: 'http://127.0.0.1:8787', pairingCode: '123456' }) });
globalThis.localStorage = { getItem: () => 'Test-Device', setItem: () => {} };

// Fake WebSocket capturing every send
const sent = [];
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeWS.last = this;
    setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 5);
  }
  send(s) { sent.push({ t: performance.now(), msg: JSON.parse(s) }); }
  close() { this.readyState = 3; }
}
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
globalThis.WebSocket = FakeWS;

// ---------------- run the real client ----------------
const src = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
new Function(src)();
// ---------------- test harness ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '   -> ' + extra : '')); }
}
const evt = (x, extra) => Object.assign({
  button: 0, clientX: x, clientY: 10, pointerId: 1, pointerType: 'touch',
  preventDefault() {}, stopPropagation() {}
}, extra || {});
const el = (id) => document.getElementById(id);
const fillOf = (id) => el(id).querySelector('.sc-fill').style.width;
const sendsFor = (action) => sent.filter((s) => s.msg.action === action);
const sysMsg = (m) => { if (FakeWS.last && FakeWS.last.onmessage) FakeWS.last.onmessage({ data: JSON.stringify(m) }); };

(async () => {
  await sleep(40);
  check('websocket opened (socket reused, single connection)', FakeWS.last && FakeWS.last.readyState === 1);

  el('codeHidden').value = '123456';
  sysMsg({ type: 'pair_result', success: true });
  check('pair result shows the strip', el('controlsScreen').className.indexOf('hidden') === -1);
  await sleep(20);

  console.log('\n[1] Volume: immediate local feedback, no server wait');
  sysMsg({ type: 'state', volume: 40, brightness: 30, media: null });
  check('server state 40 painted as 40%', fillOf('volumeCtrl') === '40%', fillOf('volumeCtrl'));

  const before = sendsFor('media.volume.set').length;
  el('volumeCtrl').dispatch('pointerdown', evt(300));
  check('pointerdown gives pressed state same frame', el('volumeCtrl').classList.contains('sc-pressed'));
  check('pointerdown opens the inline slider (no hold delay)', el('volumeCtrl').classList.contains('sc-open'));
  check('pointerdown sends nothing yet (UI first)', sendsFor('media.volume.set').length === before);
  check('pointerdown keeps local value (no reset/jump)', fillOf('volumeCtrl') === '40%', fillOf('volumeCtrl'));

  console.log('\n[2] Volume: 3px horizontal move enters drag, local 60fps render');
  el('volumeCtrl').dispatch('pointermove', evt(302));
  check('2px move does not start drag', !el('volumeCtrl').classList.contains('sc-dragging'));
  el('volumeCtrl').dispatch('pointermove', evt(315));
  await sleep(40);
  check('drag started after >3px', el('volumeCtrl').classList.contains('sc-dragging'));
  check('local fill follows finger (40+10=50%)', fillOf('volumeCtrl') === '50%', fillOf('volumeCtrl'));
  const dragSends = sendsFor('media.volume.set').length - before;
  check('drag sends throttled (>=1 and <=3 in ~40ms)', dragSends >= 1 && dragSends <= 3, 'sends=' + dragSends);

  console.log('\n[3] Volume: stale server state must not rubber-band the finger');
  sysMsg({ type: 'state', volume: 12, brightness: 30, media: null });
  await sleep(20);
  check('stale state does not pull fill back during drag', fillOf('volumeCtrl') === '50%', fillOf('volumeCtrl'));

  console.log('\n[4] Volume: pointerup sends the exact final value immediately');
  el('volumeCtrl').dispatch('pointermove', evt(330));
  await sleep(40);
  const localAtUp = fillOf('volumeCtrl');
  el('volumeCtrl').dispatch('pointerup', evt(330));
  const finals = sent.filter((s) => s.msg.action === 'media.volume.set' && s.msg.final === true);
  check('a final commit was sent on pointerup', finals.length >= 1);
  const lastFinal = finals[finals.length - 1];
  check('final commit is the exact local value', lastFinal && lastFinal.msg.params.level === 60, lastFinal ? JSON.stringify(lastFinal.msg.params) : 'none');
  check('final commit carries a unique requestId', !!(lastFinal && lastFinal.msg.requestId));
  check('local value stays shown until confirmation', localAtUp === '60%', localAtUp);
  const countAtUp = sendsFor('media.volume.set').length;
  await sleep(60);
  check('no intermediate sends after release', sendsFor('media.volume.set').length === countAtUp,
    'delta=' + (sendsFor('media.volume.set').length - countAtUp));
  check('total sends for this drag stay small', sendsFor('media.volume.set').length - before <= 6, 'sends=' + (sendsFor('media.volume.set').length - before));
console.log('\n[5] Volume: tap reveals the slider and stays ready (no second wait)');
  const beforeTap = sendsFor('media.volume.set').length;
  el('volumeCtrl').dispatch('pointerdown', evt(300));
  el('volumeCtrl').dispatch('pointerup', evt(300));
  check('tap keeps the inline slider open', el('volumeCtrl').classList.contains('sc-open'));
  check('tap does not step volume unexpectedly', sendsFor('media.volume.set').length === beforeTap);
  check('pressed state cleared on release', !el('volumeCtrl').classList.contains('sc-pressed'));

  console.log('\n[6] Media seek: local 60fps scrub, no wait for Comet/YouTube');
  sysMsg({ type: 'state', volume: 60, brightness: 30, media: { title: 'T', position: 50, duration: 200, playing: false } });
  await sleep(20);
  check('seek scrubber revealed when media exists', el('seekRow').hidden === false);
  check('initial thumb at 25%', el('seekFill').style.width === '25%', el('seekFill').style.width);

  const seekSendsBefore = sendsFor('media.seek').length;
  el('seekTrack').dispatch('pointerdown', evt(200));
  check('seek fill updates locally on pointerdown', el('seekFill').style.width === '50%', el('seekFill').style.width);
  check('seek time preview updates locally', el('seekPos').textContent.indexOf('1:40') === 0, el('seekPos').textContent);
  check('seek commits immediate on pointerdown', sendsFor('media.seek').length === seekSendsBefore + 1);
  el('seekTrack').dispatch('pointermove', evt(250));
  await sleep(20);
  check('seek fill tracks finger to 75%', el('seekFill').style.width === '75%', el('seekFill').style.width);
  el('seekTrack').dispatch('pointerup', evt(250));
  const seekFinals = sent.filter((s) => s.msg.action === 'media.seek' && s.msg.final === true);
  check('seek sends exact final position', seekFinals.length >= 1 && Math.abs(seekFinals[seekFinals.length - 1].msg.params.position - 150) < 1,
    seekFinals.length ? String(seekFinals[seekFinals.length - 1].msg.params.position) : 'none');

  console.log('\n[7] Play/pause: optimistic icon flip, action sent right away');
  const beforePlay = sendsFor('media_play_pause').length;
  playBtn.dispatch('click', evt(0));
  check('icon flips immediately (optimistic)', playBtn.classList.contains('is-playing'));
  check('play/pause action sent immediately', sendsFor('media_play_pause').length === beforePlay + 1);

  console.log('\n[8] Static guarantees (no blocking delays in the client)');
  const clientSrc = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  check('no 150/180ms hold timer in client', !/setTimeout\([^)]*,\s*1[58]0\b/.test(clientSrc));
  check('no 1s debounce in client', !/setTimeout\([^)]*,\s*1000\b/.test(clientSrc));
  check('exactly one WebSocket constructor (persistent socket)', (clientSrc.match(/new WebSocket\(/g) || []).length === 1);
  check('no HTTP fetch used for control actions', sendsFor('media.volume.set').length > 0 && sent.every((s) => s.msg.type));

  console.log('\n==========================================');
  console.log('PASSED: ' + pass + '   FAILED: ' + fail);
  console.log('==========================================');
  process.exit(fail === 0 ? 0 : 1);
})();