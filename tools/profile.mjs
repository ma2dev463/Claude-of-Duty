#!/usr/bin/env node
/**
 * Gameplay profiler — exercises a moving camera, firing, and active AI, then
 * reports frame-time distribution and resource/program-count changes.
 *
 * Examples:
 *   node tools/profile.mjs
 *   node tools/profile.mjs --port=5173 --dpr=1 --w=1280 --h=720
 *   node tools/profile.mjs --url=http://127.0.0.1:8080/ --warmup=0
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 5173);
const HOST = String(args.host ?? '127.0.0.1');
const URL = String(args.url ?? `http://${HOST}:${PORT}/${args.query ? `?${args.query}` : ''}`);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const DPR = Number(args.dpr ?? 1);
const FRAMES = Number(args.frames ?? 900);

const browser = await chromium.launch({
  headless: true,
  // Use the browser's native backend instead of forcing Apple's Metal backend.
  args: ['--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  try {
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => m.type() === 'error' && errs.push(m.text()));

    const t0 = Date.now();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
    const bootMs = Date.now() - t0;
    const bootMarks = await page.evaluate(() =>
      performance.getEntriesByType('measure')
        .map(m => ({ name: m.name, ms: +m.duration.toFixed(1) }))
        .sort((a, b) => b.ms - a.ms).slice(0, 25));

    const internal = await page.evaluate(() => {
      const r = window.__ENGINE__.ctx.peek('render');
      const gl = r.renderer.getContext();
      return {
        pixelRatio: r.renderer.getPixelRatio(),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        megapixels: +((gl.drawingBufferWidth * gl.drawingBufferHeight) / 1e6).toFixed(2),
        quality: window.__ENGINE__.config.quality,
        renderScale: window.__ENGINE__.config.q.renderScale,
        renderer: gl.getParameter(gl.RENDERER),
      };
    });

    await page.evaluate(() => {
      const e = window.__ENGINE__;
      e.input.enabled = true;
      e.input.frozen = false;
      e.ctx.peek('player')?.setControlEnabled?.(true);
      e.ctx.peek('ai')?.debugStage?.('firefight');
    });

    const result = await page.evaluate(FRAMES => new Promise(done => {
      const e = window.__ENGINE__;
      const r = e.ctx.peek('render');
      const samples = [];
      let last = performance.now(), i = 0;
      const tick = () => {
        const now = performance.now();
        const dt = now - last; last = now;
        e.camera.rotation.y += 0.006;
        if (e.ctx.peek('player')) e.input.down.add('KeyW');
        if (i % 90 < 30) e.input.down.add('Mouse0');
        else e.input.down.delete('Mouse0');
        samples.push({
          i, dt,
          progs: r.renderer.info.programs?.length ?? 0,
          calls: r.renderer.info.render.calls,
          tris: r.renderer.info.render.triangles,
          geos: r.renderer.info.memory.geometries,
          texs: r.renderer.info.memory.textures,
          heap: performance.memory ? performance.memory.usedJSHeapSize >> 20 : 0,
        });
        if (++i >= FRAMES) return done(samples);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), FRAMES);

    const WARMUP = Number(args.warmup ?? 60);
    const warm = result.slice(WARMUP);
    if (!warm.length) throw new Error('Not enough frames: increase --frames or reduce --warmup');
    const dts = warm.map(s => s.dt).sort((a, b) => a - b);
    const q = p => +dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(2);
    const med = q(0.5);
    const hitches = warm.filter(s => s.dt > Math.max(2 * med, med + 8)).map(s => {
      const prev = warm[warm.indexOf(s) - 1];
      return {
        frame: s.i, ms: +s.dt.toFixed(1),
        progDelta: prev ? s.progs - prev.progs : 0,
        geoDelta: prev ? s.geos - prev.geos : 0,
        texDelta: prev ? s.texs - prev.texs : 0,
      };
    });
    const first = warm[0], lastS = warm[warm.length - 1];
    console.log(JSON.stringify({
      url: URL, bootMs, bootMarks, internal, frames: warm.length,
      frameTimeMs: { p1: q(0.01), p50: med, p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) },
      fps: { p50: +(1000 / med).toFixed(0), p95: +(1000 / q(0.95)).toFixed(0), p99: +(1000 / q(0.99)).toFixed(0) },
      hitchCount: hitches.length,
      hitchPctOfFrames: +((hitches.length / warm.length) * 100).toFixed(2),
      worstHitches: hitches.sort((a, b) => b.ms - a.ms).slice(0, 15),
      programs: { start: first.progs, end: lastS.progs, compiledDuringPlay: lastS.progs - first.progs },
      resources: { geosStart: first.geos, geosEnd: lastS.geos, texStart: first.texs, texEnd: lastS.texs },
      heapMb: { start: first.heap, end: lastS.heap, growth: lastS.heap - first.heap },
      drawCalls: { min: Math.min(...warm.map(s => s.calls)), max: Math.max(...warm.map(s => s.calls)) },
      errors: errs.slice(0, 6),
    }, null, 2));
    if (errs.length) process.exitCode = 1;
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}
