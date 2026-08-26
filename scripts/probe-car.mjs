
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, 420000);
const server = await createServer({ server: { port: 4616, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 200)));
await page.goto('http://localhost:4616/?scene=hiddenCar&preset=test&test=1&norender=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
for (let i = 0; i < 16; i++) {
  await page.evaluate(() => window.__vw.step(1 / 30, 10));
  const r = await page.evaluate(async () => {
    const m = await window.__vw.metrics();
    let mass = 0, mx = 0;
    for (const isl of m.islands) {
      const c = 16, cell = isl.sizeM / c;
      for (let z = 0; z < c; z++) for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) {
        const idx = (x + y * c + z * c * c) * 4;
        const mm = isl.coarse[idx];
        if (mm <= 0) continue;
        mass += mm; mx += mm * (isl.origin[0] + (x + 0.5) * cell);
      }
    }
    let pmass = 0;
    for (const p of window.__vw.world.packets.packets) { mass += p.massKg; pmass += p.massKg; mx += p.massKg * p.position[0]; }
    const w = window.__vw.world;
    const isl0 = w.scheduler.activeIslands()[0];
    return { t: m.simTimeS, com: mx / mass, mass, pmass, primCount: isl0 ? w.engine.islands[isl0.slot].uni.primCount.value : -1 };
  });
  console.log(`t=${r.t.toFixed(2)} comX=${r.com.toFixed(3)} mass=${r.mass.toFixed(1)} pkt=${r.pmass.toFixed(1)} prims=${r.primCount}`);
}
await browser.close(); await server.close(); process.exit(0);
