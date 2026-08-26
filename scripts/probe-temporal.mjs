// Reproduce the "cloud drags with the camera" report: render the SAME camera
// pose two ways with temporal accumulation on — (a) arrived at while orbiting,
// (b) held still until the accumulator converges — and diff them against the
// temporal-off ground truth for that pose.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const base = process.env.PW_BASE_URL ?? 'http://localhost:4173';
const OUT = process.env.OUT ?? '/tmp/claude-0/-home-user-volumetric-world/4dd64bb2-e10e-58d9-a2a1-5e76406c3d00/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});

// 16x16 luminance signature of the composited frame.
const HASH = () => {
  const c = document.getElementById('shot');
  const ctx = c.getContext('2d');
  const { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = [];
  for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
    let sum = 0, n = 0;
    for (let y = Math.floor(by * h / 16); y < Math.floor((by + 1) * h / 16); y += 2)
      for (let x = Math.floor(bx * w / 16); x < Math.floor((bx + 1) * w / 16); x += 2) {
        const i = (y * w + x) * 4; sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++;
      }
    out.push(n ? sum / n : 0);
  }
  return out;
};
const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

async function open(temporal) {
  const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 160)); });
  await page.goto(`${base}/?scene=obstacles&preset=test&test=1&temporal=${temporal}`);
  await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
  await page.evaluate(() => window.__vw.step(1 / 30, 60));
  return page;
}
const view = (page, yaw) => page.evaluate((y) => window.__vw.setView({ yawDeg: y, pitchDeg: 16 }), yaw);
const draw = async (page, n = 1) => { for (let i = 0; i < n; i++) await page.evaluate(() => window.__vw.render()); };
const hash = (page) => page.evaluate(HASH);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

const TARGET = 30, START = 6, FRAMES = 24;  // 1 deg/frame — an ordinary drag speed

// --- ground truth (no accumulator) ---
const off = await open(0);
await view(off, TARGET); await draw(off, 2);
const truth = await hash(off);
await shot(off, 'temporal-off-30');

// --- accumulator on ---
const on = await open(1);
// (a) arrive at the pose while orbiting
await view(on, START); await draw(on, 6);
for (let i = 1; i <= FRAMES; i++) {
  await view(on, START + (TARGET - START) * i / FRAMES);
  await draw(on, 1);
}
const moving = await hash(on);
await shot(on, 'temporal-on-30-moving');
// (b) same pose, held still until converged
await draw(on, 24);
const settled = await hash(on);
await shot(on, 'temporal-on-30-settled');

console.log('pose separation (truth@30 vs truth@6):', (await (async () => {
  await view(off, START); await draw(off, 2); const h6 = await hash(off);
  await view(off, TARGET); await draw(off, 2);
  return diff(truth, h6).toFixed(2);
})()));
console.log('temporal-on SETTLED  vs truth :', diff(settled, truth).toFixed(2));
console.log('temporal-on MOVING   vs truth :', diff(moving, truth).toFixed(2));
console.log('temporal-on MOVING   vs SETTLED:', diff(moving, settled).toFixed(2));
fs.writeFileSync(`${OUT}/temporal-hashes.json`, JSON.stringify({ truth, moving, settled }));
await browser.close();
