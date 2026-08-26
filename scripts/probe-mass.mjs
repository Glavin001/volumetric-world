// Track island vs packet mass over time to find the conservation leak.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, 420000);
const server = await createServer({ server: { port: 4615, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 200)));
await page.goto('http://localhost:4615/?scene=puff&preset=test&test=1&norender=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });

for (let i = 0; i < 9; i++) {
  await page.evaluate(() => window.__vw.step(1 / 30, 10));
  const m = await page.evaluate(() => window.__vw.metrics());
  console.log(
    `t=${m.simTimeS.toFixed(2)} island=${m.islandMassKg.toFixed(1)} packets=${m.packetMassKg.toFixed(1)} (${m.packetCount}) total=${m.totalMassKg.toFixed(1)} divPostMax=${m.divPostMax.toFixed(3)}`,
  );
}
await browser.close();
await server.close();
process.exit(0);
