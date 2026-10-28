import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port ?? 5173);
const HOST = String(args.host ?? '127.0.0.1');
const URL = String(args.url ?? `http://${HOST}:${PORT}/`);

const b = await chromium.launch({
  headless: true,
  // Keep this OS-neutral; forcing --use-angle=metal only works on Apple systems.
  args: ['--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
try {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  try {
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => m.type() === 'error' && errs.push(m.text()));
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await p.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
    const snap = () => p.evaluate(() => {
      const e = window.__ENGINE__, c = e.camera.position;
      return {
        pos: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
        yaw: +e.camera.rotation.y.toFixed(3),
        frame: e.time.frame,
        systems: Object.keys(e.ctx).length,
      };
    });
    const a = await snap();
    // Hold W for roughly 45 animation frames.
    await p.evaluate(() => {
      const e = window.__ENGINE__;
      e.input.enabled = true;
      e.input.frozen = false;
      e.ctx.peek('player')?.setControlEnabled?.(true);
    });
    await p.keyboard.down('w');
    await p.evaluate(() => new Promise(d => {
      let i = 0;
      const t = () => ++i >= 45 ? d() : requestAnimationFrame(t);
      requestAnimationFrame(t);
    }));
    await p.keyboard.up('w');
    const bpos = await snap();

    // Observe the weapon-fire event while asking the weapon subsystem for its
    // documented debug fire pose. This checks the event path, not mouse hardware.
    const fired = await p.evaluate(() => {
      let n = 0;
      const off = window.__ENGINE__.events.on('weapon:fire', () => n++);
      const w = window.__ENGINE__.ctx.peek('weapons');
      try { w?.debugPose?.('fire', { grabFrame: 1 }); } catch {}
      return new Promise(d => {
        let i = 0;
        const t = () => ++i >= 30 ? (off(), d(n)) : requestAnimationFrame(t);
        requestAnimationFrame(t);
      });
    });
    const health = await p.evaluate(() => {
      const e = window.__ENGINE__;
      let n = 0, nan = 0;
      e.scene.traverse(o => {
        n++;
        const v = o.position;
        if (!Number.isFinite(v.x + v.y + v.z)) nan++;
      });
      let vm = 0;
      e.viewScene.traverse(() => vm++);
      return {
        worldObjects: n,
        viewmodelObjects: vm,
        nanTransforms: nan,
        frameMs: +(e.time.dt * 1000).toFixed(2),
      };
    });
    const moved = Math.hypot(bpos.pos[0] - a.pos[0], bpos.pos[2] - a.pos[2]);
    const report = {
      url: URL,
      ready: true,
      startPos: a.pos,
      afterW: bpos.pos,
      metresMoved: +moved.toFixed(2),
      framesAdvanced: bpos.frame - a.frame,
      fireEvents: fired,
      ...health,
      errors: errs.slice(0, 8),
    };
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length || report.nanTransforms > 0 || report.framesAdvanced <= 0) process.exitCode = 1;
  } finally {
    await p.close();
  }
} finally {
  await b.close();
}
