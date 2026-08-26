// Renders one simulated moment from several orbit angles and stitches them into
// a contact sheet — proof that the camera really moves through world space and
// the volumetrics hold up from every side.
// Usage: node scripts/orbit-montage.mjs [scene] [steps] [preset]
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';

setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, 900000);

const scene = process.argv[2] ?? 'puff';
const steps = Number(process.argv[3] ?? 40);
const preset = process.argv[4] ?? 'low';
const YAWS = [0, 60, 120, 180, 240, 300];

mkdirSync('docs/screenshots', { recursive: true });
const server = await createServer({ server: { port: 4622, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 420, height: 280 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(`http://localhost:4622/?scene=${scene}&preset=${preset}&test=1&norender=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 240000 });
const err = await page.evaluate(() => window.__vwError);
if (err) throw new Error(err);

await page.addStyleTag({ content: '#nav,#vw-stats,#cam-hint,.lil-gui{display:none!important}' });
for (let done = 0; done < steps; done += 20) {
  await page.evaluate((n) => window.__vw.step(1 / 30, n), Math.min(20, steps - done));
}

// One warm-up render so pipelines compile before timing the angles.
await page.evaluate(() => window.__vw.render());

const dist = await page.evaluate(() => window.__vw.orbit.orbitDistance);
console.log(`orbit distance from scene camera: ${dist.toFixed(1)}m`);

await page.evaluate(({ cols, rows }) => {
  const shot = document.getElementById('shot');
  const m = document.createElement('canvas');
  m.id = 'montage';
  m.width = shot.width * cols;
  m.height = shot.height * rows;
  m.style.cssText = 'position:fixed;left:0;top:0;z-index:99';
  document.body.appendChild(m);
}, { cols: 3, rows: 2 });

for (const [i, yaw] of YAWS.entries()) {
  const t0 = Date.now();
  await page.evaluate((y) => window.__vw.setView({ yawDeg: y, pitchDeg: 18 }), yaw);
  await page.evaluate(() => window.__vw.render());
  await page.evaluate(() => window.__vw.render()); // settle temporal history
  const pose = await page.evaluate(() => {
    const c = window.__vw.camera.position;
    return [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)];
  });
  await page.evaluate(({ idx, cols }) => {
    const shot = document.getElementById('shot');
    const m = document.getElementById('montage');
    const ctx = m.getContext('2d');
    ctx.drawImage(shot, (idx % cols) * shot.width, Math.floor(idx / cols) * shot.height);
  }, { idx: i, cols: 3 });
  console.log(`yaw ${String(yaw).padStart(3)}° → camera [${pose}]  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

const el = await page.$('#montage');
await el.screenshot({ path: `docs/screenshots/orbit-${scene}.png` });
console.log(`montage -> docs/screenshots/orbit-${scene}.png`);

await browser.close();
await server.close();
process.exit(0);
