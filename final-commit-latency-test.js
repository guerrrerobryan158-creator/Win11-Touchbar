/* Dev-only test: prove that a pending slider burst never delays the FINAL
   commit (no accumulating 1-1.5s queue). Measures, under load, the latency
   from sending the final commit to receiving its acknowledgement. */
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '   -> ' + extra : '')); }
}

function getStatus() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8787/api/status', (res) => {
      let b = '';
      res.on('data', (d) => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const serverProc = spawn(process.execPath, ['server.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let status = null;
  for (let i = 0; i < 80 && !status; i++) {
    try { status = await getStatus(); } catch (_) { await sleep(100); }
  }
  if (!status) { console.log('server did not start'); serverProc.kill(); process.exit(1); }

  const ws = new WebSocket('ws://127.0.0.1:8787');
  const acks = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'action_result' && m.requestId) acks.set(m.requestId, { t: Date.now(), result: m.result });
  });
  await new Promise((r) => { ws.on('open', r); ws.on('error', r); });
  await sleep(150);
  ws.send(JSON.stringify({ type: 'pair', code: status.pairingCode, deviceId: 'Final-Latency-Test' }));
  await sleep(300);
  await sleep(1200); // let the warm provider finish booting

  async function measureFinalCommit(action, paramsKey, label) {
    const burstCount = 30;
    const inFlight = [];
    for (let i = 0; i < burstCount; i++) {
      const rid = label + '-burst-' + i;
      const payload = { type: 'action', action, actionId: label + '-g', requestId: rid, final: false };
      payload.params = {};
      payload.params[paramsKey] = 20 + i;
      ws.send(JSON.stringify(payload));
      inFlight.push(rid);
      await sleep(50); // 20Hz drag rate
    }
    // Final commit sent immediately after the last drag packet
    const finalRid = label + '-final';
    const payload = { type: 'action', action, actionId: label + '-g', requestId: finalRid, final: true };
    payload.params = {};
    payload.params[paramsKey] = 55;
    const tSend = Date.now();
    ws.send(JSON.stringify(payload));

    let ack = null;
    for (let i = 0; i < 400 && !ack; i++) {
      ack = acks.get(finalRid) || null;
      if (!ack) await sleep(10);
    }
    const latency = ack ? ack.t - tSend : -1;
    check(label + ': final commit ack under load', latency >= 0 && latency < 400,
      latency >= 0 ? latency + 'ms' : 'no ack');
    return latency;
  }

  const volFinal = await measureFinalCommit('media.volume.set', 'level', 'volume');
  const brightFinal = await measureFinalCommit('system.brightness.set', 'level', 'brightness');
  const seekFinal = await measureFinalCommit('media.seek', 'position', 'seek');

  console.log('\n  final-commit latency while a 30-packet drag is in flight:');
  console.log('    volume     ' + volFinal + 'ms');
  console.log('    brightness ' + brightFinal + 'ms');
  console.log('    seek       ' + seekFinal + 'ms');

  ws.close();
  serverProc.kill();
  console.log('\n==========================================');
  console.log('PASSED: ' + pass + '   FAILED: ' + fail);
  console.log('==========================================');
  process.exit(fail === 0 ? 0 : 1);
})();