import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=puff&preset=test&test=1&norender=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 20));
await page.evaluate(() => window.__vw.setDebugMode(9));
await page.evaluate(() => window.__vw.render());
const r = await page.evaluate(() => {
  const cv = document.getElementById('shot'), ctx = cv.getContext('2d');
  const { width: w, height: h } = cv, d = ctx.getImageData(0, 0, w, h).data;
  const at = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1]]; };
  return { topLeft: at(2, 2), topRight: at(w - 3, 2), bottomLeft: at(2, h - 3), bottomRight: at(w - 3, h - 3) };
});
console.log('quad uv (r=u, g=v) sampled at screen corners:');
for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(12)} u=${(v[0]/255).toFixed(2)} v=${(v[1]/255).toFixed(2)}`);
console.log(r.topLeft[1] < 128 ? '=> v = 0 at the TOP of the screen  (ndc.y = uv.y*2-1 is INVERTED)'
                               : '=> v = 0 at the BOTTOM of the screen (ndc.y = uv.y*2-1 is correct)');
await browser.close();
