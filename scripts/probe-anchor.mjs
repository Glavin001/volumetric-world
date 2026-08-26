// Symmetry-proof anchoring check: the screen-space centroid of the rendered
// volume must land where the island's world-space centre of mass projects.
// Any mismatch that grows with yaw means the volume is not world-anchored.
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const scene = process.env.SCENE ?? 'vortex';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=${scene}&preset=test&test=1&norender=1&metrics=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 55));
await page.evaluate(() => window.__vw.setDebugMode(5));   // accumulated density only

const m = await page.evaluate(() => window.__vw.metrics());
const com = m.islands[0].comWorld;
console.log('island world COM:', com.map((v) => +v.toFixed(2)), 'mass', m.islands[0].massKg.toFixed(1));

for (const yaw of [0, 60, 120, 180, 240, 300]) {
  await page.evaluate((y) => window.__vw.setView({ yawDeg: y, pitchDeg: 16 }), yaw);
  await page.evaluate(() => window.__vw.render());
  const r = await page.evaluate((c) => {
    // where the world COM projects (three's own camera math)
    const v = new (window.__vw.camera.constructor.prototype.constructor === Function ? Object : Object)();
    const THREEVec = window.__vw.camera.position.constructor;
    const p = new THREEVec(c[0], c[1], c[2]).project(window.__vw.camera);
    // where the rendered volume actually is
    const cv = document.getElementById('shot');
    const ctx = cv.getContext('2d');
    const { width: w, height: h } = cv;
    const d = ctx.getImageData(0, 0, w, h).data;
    let sx = 0, sy = 0, sw = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (lum < 8) continue;
      sx += x * lum; sy += y * lum; sw += lum;
    }
    if (sw < 1) return { expected: [p.x, p.y], actual: null, coverage: 0 };
    const cxNdc = (sx / sw / w) * 2 - 1;
    const cyNdc = 1 - (sy / sw / h) * 2;
    return { expected: [+p.x.toFixed(3), +p.y.toFixed(3)], actual: [+cxNdc.toFixed(3), +cyNdc.toFixed(3)],
             coverage: +(sw / (w * h * 255)).toFixed(4) };
  }, com);
  const err = r.actual ? Math.hypot(r.actual[0] - r.expected[0], r.actual[1] - r.expected[1]).toFixed(3) : 'n/a';
  console.log(`yaw ${String(yaw).padStart(3)}: expected NDC ${JSON.stringify(r.expected)}  rendered ${JSON.stringify(r.actual)}  err=${err}  cov=${r.coverage}`);
}
await browser.close();
