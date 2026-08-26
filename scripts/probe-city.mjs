
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, 420000);
const server = await createServer({ server: { port: 4618, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 200)));
await page.goto('http://localhost:4618/?scene=cityblock&preset=test&test=1&norender=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.__vw.step(1 / 30, 10));
  const r = await page.evaluate(async () => {
    const w = window.__vw.world;
    const m = await window.__vw.metrics();
    return {
      t: m.simTimeS, island: m.islandMassKg, pkt: m.packetMassKg, n: m.packetCount,
      act: m.activeIslands,
      tiers: m.islands.map((x) => `${x.slot}:${x.tier}@[${x.origin.map((v)=>v.toFixed(0)).join(',')}]m=${x.massKg.toFixed(0)}`),
      est: w.scheduler.activeIslands().map((x) => x.estimatedMassKg.toFixed(0)),
    };
  });
  console.log(`t=${r.t.toFixed(2)} act=${r.act} island=${r.island.toFixed(1)} pkt=${r.pkt.toFixed(1)}(${r.n}) :: ${r.tiers.join(' | ')}`);
}
await browser.close(); await server.close(); process.exit(0);
