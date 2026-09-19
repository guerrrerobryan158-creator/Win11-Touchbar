// Quick latency smoke test for controls.js (dev-only)
const { performAction } = require('./controls');

async function timed(label, fn) {
  const t0 = performance.now();
  const r = await fn();
  const dt = Math.round((performance.now() - t0) * 10) / 10;
  console.log(label.padEnd(26), (dt + 'ms').padStart(9), JSON.stringify(r));
  return r;
}

(async () => {
  await new Promise((r) => setTimeout(r, 900)); // let warm boot finish
  await timed('volume.get (cold-ish)', () => performAction('media.volume.get'));
  await timed('volume.get warm', () => performAction('media.volume.get'));
  await timed('brightness.get', () => performAction('system.brightness.get'));
  await timed('brightness.up', () => performAction('brightness_up'));
  await timed('media.seek', () => performAction('media.seek', { position: 123.4 }));
  await timed('media.state.get', () => performAction('media.state.get'));
  await timed('media_play_pause key', () => performAction('media_play_pause'));
  await timed('test.escape', () => performAction('test.escape'));
  await timed('unknown action', () => performAction('does.not.exist'));
  // burst: 30 rapid volume sets (simulating a drag at 20Hz+)
  const t0 = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, (_, i) => performAction('media.volume.set', { level: i }))
  );
  const dt = Math.round((performance.now() - t0) * 10) / 10;
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  console.log('30-volume burst'.padEnd(26), (dt + 'ms').padStart(9), `fulfilled=${okCount}`);
  process.exit(0);
})();