/* Dev-only test: verify the local-only diagnostics pipeline end to end.
   Boots the real server in-process, pairs a client, records an action and a
   phone report, then asserts the merged entry + bounded buffer. */
const WebSocket = require('ws');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = require('./server');

function getPairingCode() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8787/api/status', (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body).pairingCode); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '   -> ' + extra : '')); }
}

(async () => {
  let pairingCode = null;
  for (let i = 0; i < 60 && !pairingCode; i++) {
    try { pairingCode = await getPairingCode(); } catch (_) { await sleep(100); }
  }
  check('server reachable on 8787', !!pairingCode, pairingCode || 'no response');
  check('diagnostics OFF by default', api.getDiagnosticsEnabled() === false);
  check('diagnostics buffer starts empty', api.getDiagnostics().length === 0);

  const ws = new WebSocket('ws://127.0.0.1:8787');
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((r) => { ws.on('open', r); ws.on('error', r); });
  await sleep(120);
  ws.send(JSON.stringify({ type: 'pair', code: pairingCode, deviceId: 'Diag-Test-1234' }));
  await sleep(300);
  check('client paired for diagnostics test', msgs.some((m) => m.type === 'pair_result' && m.success));

  // Enable from the "Electron host" side -> phone is told via diag config
  api.setDiagnosticsEnabled(true);
  await sleep(120);
  check('diag config pushed to paired phone', msgs.some((m) => m.type === 'diag' && m.enabled === true));
  check('diagnostics enabled flag set', api.getDiagnosticsEnabled() === true);

  // A discrete action carrying phone timestamps
  ws.send(JSON.stringify({
    type: 'action', action: 'test.escape', params: {},
    actionId: 'AID-1', requestId: 'RID-1',
    t0: 1000, tSend: 1012, tFirstFrame: 1004, final: true
  }));
  await sleep(500);

  // Phone reports its measured transport/total latency for that request
  ws.send(JSON.stringify({
    type: 'diag.report', requestId: 'RID-1',
    report: { serverToPhoneMs: 21, totalMs: 74, localVisualMs: 4 }
  }));
  await sleep(250);

  const entries = api.getDiagnostics();
  const e = entries.find((x) => x.requestId === 'RID-1');
  check('entry recorded for the action', !!e);
  if (e) {
    check('action id captured', e.actionId === 'AID-1', e.actionId);
    check('client short id captured', e.client === 'st-1234' || /1234$/.test(e.client), e.client);
    check('local send ms captured (tSend-t0)', e.localToSendMs === 12, String(e.localToSendMs));
    check('local visual ms captured (first frame)', e.localVisualMs === 4, String(e.localVisualMs));
    check('provider ms measured on server', typeof e.providerMs === 'number', String(e.providerMs));
    check('validate ms measured on server', typeof e.validateMs === 'number', String(e.validateMs));
    check('server->phone ms merged from phone', e.serverToPhoneMs === 21, String(e.serverToPhoneMs));
    check('total ms merged from phone', e.totalMs === 74, String(e.totalMs));
    check('result recorded', typeof e.result === 'string', e.result);
  }

  // Buffer must stay bounded at 100 even under many actions
  for (let i = 0; i < 130; i++) {
    ws.send(JSON.stringify({
      type: 'action', action: 'test.escape', params: {},
      actionId: 'bulk-' + i, requestId: 'bulk-' + i, t0: 0, tSend: 1, final: true
    }));
    await sleep(2);
  }
  await sleep(900);
  const size = api.getDiagnostics().length;
  check('diagnostics bounded to 100 entries', size <= 100, 'size=' + size);

  // Turning it off clears the phone-side buffer and stops recording
  api.setDiagnosticsEnabled(false);
  await sleep(150);
  check('diag disable pushed to phone', msgs.some((m) => m.type === 'diag' && m.enabled === false));

  ws.close();
  console.log('\n==========================================');
  console.log('PASSED: ' + pass + '   FAILED: ' + fail);
  console.log('==========================================');
  process.exit(fail === 0 ? 0 : 1);
})();