
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, 420000);
const server = await createServer({ server: { port: 4619, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 200)));
await page.goto('http://localhost:4619/?scene=cityblock&preset=test&test=1&norender=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
await page.evaluate(() => window.__vw.step(1 / 30, 90));
await page.evaluate(() => {
  const w = window.__vw.world;
  for (const i of w.scheduler.activeIslands()) i.retiring = true;
});
for (let k = 0; k < 4; k++) {
  await page.evaluate(() => window.__vw.step(1 / 30, 10));
  const r = await page.evaluate(() => {
    const w = window.__vw.world;
    return {
      t: w.simTime,
      islands: w.scheduler.activeIslands().map((i) => ({ slot: i.slot, tier: i.tier, created: +i.createdAt.toFixed(2), retiring: i.retiring, est: +i.estimatedMassKg.toFixed(1), center: i.center.map((x) => +x.toFixed(1)) })),
      pkts: w.packets.packets.length,
      emissions: w.emissions?.length,
    };
  });
  console.log(`t=${r.t.toFixed(2)} pkts=${r.pkts} islands=${JSON.stringify(r.islands)}`);
}
await browser.close(); await server.close(); process.exit(0);
