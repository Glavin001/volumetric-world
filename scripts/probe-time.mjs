// Time GPU stages separately on SwiftShader: N sim steps flush, then 1 render flush.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, Number(process.env.WD ?? 240000));
const W = Number(process.env.PW ?? 320);
const H = Number(process.env.PH ?? 240);
const STEPS = Number(process.argv[2] ?? 2);

const server = await createServer({ server: { port: 4613, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 300)));
await page.goto(`http://localhost:4613/?scene=puff&preset=test&test=1&norender=1&mlevel=${process.env.MLEVEL ?? 0}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
console.log('ready; viewport', W, H);

const flush = async (label) => {
  const t = Date.now();
  await page.evaluate(() => window.__vw.world.renderer.backend.device.queue.onSubmittedWorkDone());
  console.log(`${label}: ${Date.now() - t}ms`);
};

await flush('boot flush');

let t = Date.now();
await page.evaluate((n) => window.__vw.step(1 / 30, n), STEPS);
console.log(`enqueue ${STEPS} steps: ${Date.now() - t}ms`);
await flush(`gpu ${STEPS} steps`);

t = Date.now();
await page.evaluate(() => window.__vw.render());
console.log(`enqueue render: ${Date.now() - t}ms`);
await flush('gpu render');

t = Date.now();
await page.evaluate(() => window.__vw.render());
await flush('gpu render #2');

await page.screenshot({ path: 'scripts/probe-time.png' });
console.log('screenshot saved');
await browser.close();
await server.close();
process.exit(0);
