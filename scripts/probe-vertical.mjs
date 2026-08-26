// Where is the dust drawn vertically, vs. where the simulation says it is?
// Ground truth comes from the coarse mass grid (world space, the same data the
// physics tests assert on); the render is measured from debugMode 5.
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=puff&preset=test&test=1&norender=1&metrics=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 90));
await page.evaluate(() => window.__vw.setView({ yawDeg: 25, pitchDeg: 14, dist: 15 }));
await page.evaluate(() => window.__vw.setDebugMode(5));
await page.evaluate(() => window.__vw.render());

const r = await page.evaluate(async () => {
  const api = window.__vw;
  const m = await api.metrics();
  const isl = m.islands[0];
  // world-space vertical mass distribution from the coarse grid
  const c = 16, cell = isl.sizeM / c;
  const col = new Array(c).fill(0);
  for (let z = 0; z < c; z++) for (let y = 0; y < c; y++) for (let x = 0; x < c; x++)
    col[y] += isl.coarse[(x + y * c + z * c * c) * 4];
  const total = col.reduce((a, b) => a + b, 0);
  let lo = 0, hi = c - 1, acc = 0;
  for (let y = 0; y < c; y++) { acc += col[y]; if (acc > total * 0.05) { lo = y; break; } }
  acc = 0;
  for (let y = c - 1; y >= 0; y--) { acc += col[y]; if (acc > total * 0.05) { hi = y; break; } }
  const yLo = isl.origin[1] + lo * cell, yHi = isl.origin[1] + (hi + 1) * cell;

  const V = api.camera.position.constructor;
  const proj = (wy) => +new V(isl.comWorld[0], wy, isl.comWorld[2]).project(api.camera).y.toFixed(3);

  // rendered vertical extent
  const cv = document.getElementById('shot'), ctx = cv.getContext('2d');
  const { width: w, height: h } = cv, d = ctx.getImageData(0, 0, w, h).data;
  let top = -1, bot = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4] < 40) continue;
    if (top < 0) top = y;
    bot = y; break;
  }
  // recompute properly (row scan)
  top = -1; bot = -1;
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] >= 40) { any = true; break; }
    if (any) { if (top < 0) top = y; bot = y; }
  }
  const ndcOf = (py) => +(1 - (py / h) * 2).toFixed(3);
  return {
    simWorldY: [+yLo.toFixed(2), +yHi.toFixed(2)], groundY: 0,
    expectedNdcY: [proj(yLo), proj(yHi)], projectedGround: proj(0),
    renderedNdcY: [ndcOf(bot), ndcOf(top)],
  };
});
console.log('simulation says dust occupies world Y', r.simWorldY, '(ground at 0)');
console.log('  -> that band projects to NDC y', r.expectedNdcY, ' | ground point projects to', r.projectedGround);
console.log('  -> volume actually drawn at NDC y', r.renderedNdcY);
await browser.close();
