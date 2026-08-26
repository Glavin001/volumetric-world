import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=puff&preset=test&test=1&norender=1&metrics=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 90));
const r = await page.evaluate(async () => {
  const m = await window.__vw.metrics();
  const isl = m.islands[0];
  const c = 16, cell = isl.sizeM / c;
  const col = new Array(c).fill(0), occupied = new Array(c).fill(0);
  for (let z = 0; z < c; z++) for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) {
    const v = isl.coarse[(x + y * c + z * c * c) * 4];
    col[y] += v;
    if (v > 1e-6) occupied[y]++;
  }
  return { origin: isl.origin, sizeM: isl.sizeM, cell, mass: isl.massKg,
           col: col.map((v) => +v.toFixed(3)), occupied };
});
console.log(`island origin ${JSON.stringify(r.origin.map((v)=>+v.toFixed(2)))} size ${r.sizeM} cell ${r.cell}m  total ${r.mass.toFixed(1)}kg`);
console.log('layer |  worldY range   |    mass kg | cells with dust (of 256)');
r.col.forEach((v, y) => {
  const y0 = (r.origin[1] + y * r.cell).toFixed(2), y1 = (r.origin[1] + (y + 1) * r.cell).toFixed(2);
  const pct = (100 * v / r.mass).toFixed(2);
  console.log(`${String(y).padStart(5)} | ${y0.padStart(6)} .. ${y1.padStart(6)} | ${v.toFixed(3).padStart(9)} (${pct.padStart(5)}%) | ${r.occupied[y]}`);
});
await browser.close();
