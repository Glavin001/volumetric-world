// Does the raymarch pass respond to ANY uniform change after the first render?
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=puff&preset=test&test=1&norender=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });

const HASH = () => {
  const c = document.getElementById('shot'); const ctx = c.getContext('2d');
  const { width: w, height: h } = c; const d = ctx.getImageData(0, 0, w, h).data;
  const out = [];
  for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
    let s = 0, n = 0;
    for (let y = Math.floor(by * h / 8); y < Math.floor((by + 1) * h / 8); y += 2)
      for (let x = Math.floor(bx * w / 8); x < Math.floor((bx + 1) * w / 8); x += 2) {
        const i = (y * w + x) * 4; s += (d[i] + d[i + 1] + d[i + 2]) / 3; n++;
      }
    out.push(s / n);
  }
  return out;
};
const diff = (a, b) => +(a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length).toFixed(3);
const draw = async () => { await page.evaluate(() => window.__vw.render()); return page.evaluate(HASH); };

await page.evaluate(() => window.__vw.step(1 / 30, 30));
const h0 = await draw();
await page.evaluate(() => window.__vw.step(1 / 30, 60));   // cloud evolves a lot
const h1 = await draw();
console.log('after 60 more sim steps          :', diff(h0, h1));

await page.evaluate(() => window.__vw.setDebugMode(4));    // completely different output
const h2 = await draw();
console.log('after switching to debugMode 4   :', diff(h1, h2));
await page.evaluate(() => window.__vw.setDebugMode(0));

await page.evaluate(() => { window.__vw.world.pass.exposure.value = 4.0; });  // composite uniform
const h3 = await draw();
console.log('after exposure 0.62 -> 4.0       :', diff(h1, h3));

await page.evaluate(() => { window.__vw.world.pass.detailStrength.value = 0.0; });  // raymarch uniform
const h4 = await draw();
console.log('after detailStrength -> 0        :', diff(h3, h4));

await page.evaluate(() => window.__vw.setView({ yawDeg: 180, pitchDeg: 16 }));
const h5 = await draw();
console.log('after yaw 0 -> 180               :', diff(h4, h5));
await browser.close();
