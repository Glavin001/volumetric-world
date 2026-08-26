// Captures gallery screenshots of every benchmark scene into docs/screenshots/.
// Runs fine on real GPUs and (slowly) on SwiftShader via readback presentation.
// Usage: node scripts/capture.mjs [preset] [sceneFilter]
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';

const preset = process.argv[2] ?? 'low';
const only = process.argv[3];

const SHOTS = [
  { scene: 'puff', steps: 46 },
  { scene: 'vortex', steps: 46 },
  { scene: 'obstacles', steps: 78 },
  { scene: 'slab', steps: 64 },
  { scene: 'hiddenCar', steps: 124 },
  { scene: 'doorway', steps: 104 },
  { scene: 'backlit', steps: 34 },
  { scene: 'inside', steps: 44 },
  { scene: 'multi', steps: 96 },
  { scene: 'cityblock', steps: 175 },
];

mkdirSync('docs/screenshots', { recursive: true });
const server = await createServer({ server: { port: 4620, strictPort: true }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});

for (const s of SHOTS) {
  if (only && s.scene !== only) continue;
  const t0 = Date.now();
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => console.log(`[${s.scene}] pageerror:`, String(e).slice(0, 200)));
  try {
    await page.goto(`http://localhost:4620/?scene=${s.scene}&preset=${preset}&test=1&norender=1`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 240000 });
    const err = await page.evaluate(() => window.__vwError);
    if (err) throw new Error(err);
    await page.addStyleTag({ content: '#nav,#vw-stats,.lil-gui{display:none!important}' });
    const chunk = 20;
    for (let done = 0; done < s.steps; done += chunk) {
      await page.evaluate((n) => window.__vw.step(1 / 30, n), Math.min(chunk, s.steps - done));
    }
    await page.evaluate(() => window.__vw.render());
    await page.evaluate(() => window.__vw.render());
    await page.screenshot({ path: `docs/screenshots/${s.scene}.png` });
    console.log(`${s.scene}: ok (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) {
    console.log(`${s.scene}: FAILED ${String(e).slice(0, 300)}`);
  }
  await page.close();
}

await browser.close();
await server.close();
process.exit(0);
