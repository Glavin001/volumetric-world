
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, 420000);
const server = await createServer({ server: { port: 4617, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 200)));
await page.goto('http://localhost:4617/?scene=obstacles&preset=test&test=1&norender=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.__vw.step(1 / 30, 12));
  const r = await page.evaluate(async () => {
    const w = window.__vw;
    const m = await w.metrics();
    const isl = m.islands[0];
    const total = m.islandMassKg;
    const down = await w.massInRegion([3.7, 0, -6], [10, 6, 6]);
    const mid = await w.massInRegion([0.5, 0, -6], [3.7, 6, 6]);
    const near = await w.massInRegion([-8, 0, -6], [0.5, 6, 6]);
    const s = (await import('/tests/utils.ts').catch(() => null));
    return { t: m.simTimeS, total, near, mid, down, origin: isl?.origin, com: isl ? null : null };
  });
  console.log(`t=${r.t.toFixed(2)} total=${r.total.toFixed(1)} near=${r.near.toFixed(1)} mid=${r.mid.toFixed(1)} down=${r.down.toFixed(2)} origin=${JSON.stringify(r.origin)}`);
}
await browser.close(); await server.close(); process.exit(0);
