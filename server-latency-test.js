/* Integration + latency test for the WinTouch Bar server (dev-only) */
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const PORT = 8787;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, ms, note) => { console.log(label.padEnd(40), (ms >= 0 ? ms + 'ms' : ' n/a').padStart(8), note || ''); if (ms >= 0) results.push([label, ms]); };

(async () => {
  const serverProc = spawn(process.execPath, ['server.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pairingCode = null, buf = '';
  serverProc.stdout.on('data', (d) => { buf += d.toString(); const m = buf.match(/Pairing code: (\d{6})/); if (m && !pairingCode) pairingCode = m[1]; });
  const tBoot0 = performance.now();
  while (!pairingCode && performance.now() - tBoot0 < 10000) await sleep(50);
  log('server boot -> pairing code', Math.round(performance.now() - tBoot0), pairingCode ? '' : 'TIMEOUT');
  if (!pairingCode) { serverProc.kill(); process.exit(1); }

  const tC0 = performance.now();
  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  let pairLat = -1, gotPair = false, syncLat = -1;
  const onMsg = (data) => {
    let m; try { m = JSON.parse(data); } catch (_) { return; }
    if (m.type === 'pair_result') { pairLat = Math.round(performance.now() - tC0); gotPair = true; }
    if (m.type === 'state') syncLat = Math.round(performance.now() - tC0);
  };
  ws.on('message', onMsg);
  await new Promise((res) => { ws.on('open', res); ws.on('error', res); });
  log('ws connect', Math.round(performance.now() - tC0));
  await sleep(150);
  ws.send(JSON.stringify({ type: 'pair', code: pairingCode, deviceId: 'Test-ABC12345' }));
  for (let i = 0; i < 200 && !gotPair; i++) await sleep(20);
  log('pair round-trip', pairLat);
  await sleep(250);
  log('initial state sync', syncLat);

  await sleep(900); // provider warm/boot
  const t1 = performance.now();
  let ack1 = false;
  ws.on('message', (data) => { let m; try { m = JSON.parse(data); } catch (_) { return; } if (m.type === 'action_result' && m.requestId === 'r-1') ack1 = true; });
  ws.send(JSON.stringify({ type: 'action', action: 'media.volume.set', params: { level: 60 }, actionId: 'g1', requestId: 'r-1', final: true }));
  for (let i = 0; i < 150 && !ack1; i++) await sleep(20);
  log('volume.set final -> ack', Math.round(performance.now() - t1));

  // Drag simulation: 40 brightness packets ~45Hz + final (client actually sends 12-20Hz)
  const tB0 = performance.now();
  let ackFinal = false, stateCount = 0;
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch (_) { return; }
    if (m.type === 'action_result' && m.requestId === 'rb-final') ackFinal = true;
    if (m.type === 'state') stateCount++;
  });
  for (let k = 0; k < 40; k++) {
    ws.send(JSON.stringify({ type: 'action', action: 'system.brightness.set', params: { level: k % 100 }, actionId: 'g2', requestId: 'rb-' + k, final: false }));
    await sleep(22);
  }
  ws.send(JSON.stringify({ type: 'action', action: 'system.brightness.set', params: { level: 42 }, actionId: 'g2', requestId: 'rb-final', final: true }));
  for (let i = 0; i < 300 && !ackFinal; i++) await sleep(20);
  log('40-pkt slider burst + final', Math.round(performance.now() - tB0), 'stateBroadcasts=' + stateCount);

  // Invalid params must be rejected (kept validation)
  let bad = null;
  ws.on('message', (data) => { let m; try { m = JSON.parse(data); } catch (_) { return; } if (m.type === 'action_result' && m.requestId === 'r-bad') bad = m.result; });
  ws.send(JSON.stringify({ type: 'action', action: 'media.volume.set', params: { level: -5 }, actionId: 'g3', requestId: 'r-bad', final: true }));
  for (let i = 0; i < 150 && !bad; i++) await sleep(20);
  log('invalid level rejected', -1, bad ? (bad.status + ' / ' + (bad.message || '')) : 'NO-ACK');

  // Unpaired socket must be rejected
  const ws2 = new WebSocket('ws://127.0.0.1:' + PORT);
  let rejected = false;
  ws2.on('message', (data) => { let m; try { m = JSON.parse(data); } catch (_) { return; } if (m.type === 'error' && m.message === 'Not paired') rejected = true; });
  await sleep(150);
  ws2.send(JSON.stringify({ type: 'action', action: 'test.escape', params: {} }));
  for (let i = 0; i < 100 && !rejected; i++) await sleep(20);
  log('unpaired action rejected', -1, String(rejected));

  // HTTP status
  const tH0 = performance.now();
  http.get('http://127.0.0.1:' + PORT + '/api/status', (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => {
      const st = JSON.parse(body);
      log('/api/status', Math.round(performance.now() - tH0), 'devices=' + st.pairedDevices.length);

      // Discrete rate limit: bursts of test.escape (>6/s must be limited)
      const rateRes = [];
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data); } catch (_) { return; }
        if (m.type === 'action_result' && m.requestId && String(m.requestId).startsWith('rr-')) rateRes.push(m.result.rateLimited ? 'L' : 'o');
      });
      (async () => {
        for (let k = 0; k < 11; k++) {
          ws.send(JSON.stringify({ type: 'action', action: 'test.escape', params: {}, requestId: 'rr-' + k, final: false }));
          await sleep(30);
        }
        await sleep(400);
        log('discrete rate limit (11@33Hz)', -1, JSON.stringify(rateRes));
        console.log('\n--- SUMMARY ---');
        for (const [l, ms] of results) console.log(l.padEnd(40), ms + 'ms');
        try { ws.close(); } catch (_) {}
        try { ws2.close(); } catch (_) {}
        setTimeout(() => { serverProc.kill(); process.exit(0); }, 150);
      })();
    });
  });
})().catch((e) => { console.error('TEST FAIL', e); process.exit(1); });