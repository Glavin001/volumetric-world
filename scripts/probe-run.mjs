// Dev probe: loads a scene in test mode, surfaces console errors, steps the sim,
// reads metrics, and saves a screenshot. Usage:
//   node scripts/probe-run.mjs [scene] [steps] [preset]
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

setTimeout(() => { console.log('PROBE WATCHDOG TIMEOUT'); process.exit(3); }, 240000);

const scene = process.argv[2] ?? 'puff';
const steps = Number(process.argv[3] ?? 20);
const preset = process.argv[4] ?? 'test';

const server = await createServer({ server: { port: 4610, strictPort: true }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.PW ?? 480), height: Number(process.env.PH ?? 320) } });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 900)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 1500)}`));

try {
  await page.goto(`http://localhost:4610/?scene=${scene}&preset=${preset}&test=1&norender=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__vwError);
  if (err) {
    console.log('INIT ERROR:', err);
  } else {
    console.log('READY. stepping...');
    const t0 = Date.now();
    await page.evaluate(async (n) => {
      window.__vw.step(1 / 30, n);
    }, steps);
    console.log(`stepped ${steps} enqueued in ${Date.now() - t0}ms`);
    const tr = Date.now();
    await page.evaluate(() => window.__vw.render());
    console.log(`render+present in ${Date.now() - tr}ms`);
    const metrics = await Promise.race([
      page.evaluate(() => window.__vw.metrics()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('metrics timeout')), 60000)),
    ]);
    console.log('METRICS:', JSON.stringify({
      ...metrics,
      islands: metrics.islands.map((i) => ({ ...i, coarse: `Float32Array(${i.coarse?.length ?? 0})`, comWorld: i.comWorld?.map((x) => +x.toFixed(2)) })),
    }, null, 1).slice(0, 1600));
    const tr2 = Date.now();
    await page.evaluate(() => window.__vw.render());
    console.log(`render2 in ${Date.now() - tr2}ms`);
    await page.screenshot({ path: `scripts/probe-${scene}.png` });
    console.log(`screenshot -> scripts/probe-${scene}.png`);
  }
} catch (e) {
  console.log('PROBE FAILED:', String(e).slice(0, 800));
}
console.log('--- console output ---');
for (const l of logs.slice(0, 24)) console.log(l);
if (logs.length > 24) console.log(`(+${logs.length - 24} more)`);
await browser.close();
await server.close();
