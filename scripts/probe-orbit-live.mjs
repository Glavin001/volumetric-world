// Capture the INTERACTIVE loop (RAF, temporal accumulator on, auto-orbit) with
// the simulation frozen. A paused cloud is a rigid world-space object, so any
// apparent motion of it relative to the ground/road is a renderer bug.
import { chromium } from '@playwright/test';

const base = process.env.PW_BASE_URL ?? 'http://localhost:4173';
const OUT = process.env.OUT ?? '/tmp/claude-0/-home-user-volumetric-world/4dd64bb2-e10e-58d9-a2a1-5e76406c3d00/scratchpad';
const scene = process.env.SCENE ?? 'puff';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 560, height: 380 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 240)));

await page.goto(`${base}/?scene=${scene}&preset=test&temporal=1&present=readback&orbitSpeed=0.5`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
// Let the sim build a cloud, then freeze it and keep orbiting.
await page.waitForTimeout(12000);
await page.evaluate(() => window.__vw.setPaused(true));
console.log('sim frozen; capturing orbit frames');

for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(2500);
  const pose = await page.evaluate(() => {
    const p = window.__vw.camera.position, t = window.__vw.orbit.target;
    return { p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
             t: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
             simT: +window.__vw.world.simTime.toFixed(2) };
  });
  console.log(`frame ${i}: cam=${JSON.stringify(pose.p)} target=${JSON.stringify(pose.t)} simTime=${pose.simT}`);
  await page.screenshot({ path: `${OUT}/live-orbit-${scene}-${i}.png` });
}
await browser.close();
