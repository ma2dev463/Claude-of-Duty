import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port ?? 5173);
const HOST = String(args.host ?? '127.0.0.1');
const URL = String(args.url ?? `http://${HOST}:${PORT}/?capture=1`);

const b = await chromium.launch({
  headless: true,
  // Let Chromium select the graphics backend for the host OS. In particular,
  // do not force Apple's Metal backend on Windows/Linux.
  args: ['--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
try {
  const out = [];
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    try {
      await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await p.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
      await p.evaluate(() => window.__APPLY_SHOT__('hero'));
      await p.evaluate(() => new Promise(d => {
        let i = 0;
        const t = () => ++i >= 120 ? d() : requestAnimationFrame(t);
        requestAnimationFrame(t);
      }));
      const r = await p.evaluate(() => new Promise(d => {
        const N = 300, ts = [];
        let last = performance.now(), i = 0;
        const t = () => {
          const n = performance.now(); ts.push(n - last); last = n;
          if (++i >= N) {
            ts.sort((a, b) => a - b);
            d({ med: ts[Math.floor(N * 0.5)], p95: ts[Math.floor(N * 0.95)], min: ts[0] });
          } else requestAnimationFrame(t);
        };
        requestAnimationFrame(t);
      }));
      const info = await p.evaluate(() => window.__RENDER_INFO__);
      out.push({
        res: `${w}x${h}`,
        medMs: +r.med.toFixed(2),
        p95Ms: +r.p95.toFixed(2),
        medFps: +(1000 / r.med).toFixed(0),
        calls: info.calls,
        tris: info.tris,
      });
    } finally {
      await p.close();
    }
  }
  console.log(JSON.stringify({ url: URL, results: out }, null, 2));
} finally {
  await b.close();
}
