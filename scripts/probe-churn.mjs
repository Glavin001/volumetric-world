// Does moving the camera, by itself, change the dust representation?
// Counts slot allocations / retirements over an identical simulation with a
// static camera vs. an orbiting one.
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});

async function run(orbiting) {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(`${base}/?scene=puff&preset=test&test=1&norender=1`);
  await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
  const out = await page.evaluate(async (orb) => {
    const api = window.__vw;
    const w = api.world;
    const seen = w.scheduler.islands.map((i) => i.active);
    let allocs = 0, retires = 0;
    for (let n = 0; n < 320; n++) {
      if (orb) api.setView({ yawDeg: (n * 1.6) % 360, pitchDeg: 16, dist: 14 });
      api.step(1 / 30, 1);
      w.scheduler.islands.forEach((isl, k) => {
        if (isl.active && !seen[k]) allocs++;
        if (!isl.active && seen[k]) retires++;
        seen[k] = isl.active;
      });
    }
    await w.flushReadbacks();
    return { allocs, retires, packets: w.packets.packets.length,
             packetMass: +w.packets.totalMass().toFixed(1),
             active: w.scheduler.activeIslands().length };
  }, orbiting);
  await page.close();
  return out;
}

console.log('static camera :', JSON.stringify(await run(false)));
console.log('orbiting cam  :', JSON.stringify(await run(true)));
await browser.close();
