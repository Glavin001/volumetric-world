// debugMode 7 red channel = max atlas loading sampled along each ray.
// Where does the renderer BELIEVE there is dust?
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
await page.evaluate(() => window.__vw.setDebugMode(7));
await page.evaluate(() => window.__vw.render());
const r = await page.evaluate(() => {
  const api = window.__vw;
  const cv = document.getElementById('shot'), ctx = cv.getContext('2d');
  const { width: w, height: h } = cv, d = ctx.getImageData(0, 0, w, h).data;
  let top = -1, bot = -1;
  for (let y = 0; y < h; y++) { let any = false;
    for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] > 2) any = true;   // red = maxLoad
    if (any) { if (top < 0) top = y; bot = y; } }
  const ndc = (p) => 1 - (p / h) * 2;
  // invert: which world Y projects to a given NDC y, at the cloud's x/z?
  const V = api.camera.position.constructor;
  const worldYatNdc = (target) => {
    let lo = -5, hi = 60;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      const p = new V(0, mid, 0).project(api.camera);
      if (p.y < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const camY = api.camera.position.y;
  return { ndcTop: +ndc(top).toFixed(3), ndcBot: +ndc(bot).toFixed(3),
           worldTop: +worldYatNdc(ndc(top)).toFixed(2), worldBot: +worldYatNdc(ndc(bot)).toFixed(2),
           camY: +camY.toFixed(2) };
});
console.log('renderer finds atlas loading between NDC y', r.ndcBot, '..', r.ndcTop);
console.log('  -> corresponds to world Y', r.worldBot, '..', r.worldTop, ' (camera eye height', r.camY + ')');
console.log('  simulation has dust only in world Y 0.12 .. 2.12');
await browser.close();
