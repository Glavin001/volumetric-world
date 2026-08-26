// debugMode 6 draws a raw mid-Z slice of the whole atlas (red = loading).
// Slot 0 is the lower-left quadrant: atlas texel y 0..31 -> screen uv.y 0..0.5.
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const OUT = '/tmp/claude-0/-home-user-volumetric-world/4dd64bb2-e10e-58d9-a2a1-5e76406c3d00/scratchpad';
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
await page.evaluate(() => window.__vw.setDebugMode(6));
await page.evaluate(() => window.__vw.render());
await page.screenshot({ path: `${OUT}/atlas-slice.png` });
const r = await page.evaluate(() => {
  const cv = document.getElementById('shot'), ctx = cv.getContext('2d');
  const { width: w, height: h } = cv, d = ctx.getImageData(0, 0, w, h).data;
  // screen row y -> uv.y = 1 - y/h  (uv.y = 0 is the bottom of the screen)
  const rows = [];
  for (let y = 0; y < h; y++) {
    let maxR = 0;
    for (let x = 0; x < w; x++) maxR = Math.max(maxR, d[(y * w + x) * 4]);
    if (maxR > 6) rows.push({ uvY: +(1 - y / h).toFixed(3), maxR });
  }
  if (!rows.length) return null;
  const uv0 = Math.min(...rows.map((r) => r.uvY)), uv1 = Math.max(...rows.map((r) => r.uvY));
  return { uvRange: [uv0, uv1], atlasTexelY: [+(uv0 * 64).toFixed(1), +(uv1 * 64).toFixed(1)], rows: rows.length };
});
console.log('atlas rows containing loading:', JSON.stringify(r));
console.log('field has dust in voxel y 6..10 of slot 0  => expect atlas texel y 6..10');
await browser.close();
