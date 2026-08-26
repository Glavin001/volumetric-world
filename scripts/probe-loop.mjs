import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 560, height: 380 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.evaluate;
await page.goto(`${base}/?scene=puff&preset=test&temporal=1&present=readback&orbitSpeed=0.5`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
// Count RAF ticks independently of the app.
await page.evaluate(() => {
  window.__raf = 0;
  const t = () => { window.__raf++; requestAnimationFrame(t); };
  requestAnimationFrame(t);
});
const sample = () => page.evaluate(() => ({
  raf: window.__raf,
  passFrame: window.__vw.world.pass.frame,
  renderCalls: window.__vw.world.renderer.info.render.calls,
  camX: +window.__vw.camera.position.x.toFixed(2),
  camUniformX: +window.__vw.world.pass.camPos.value.x.toFixed(2),
  simT: +window.__vw.world.simTime.toFixed(2),
}));
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(2000);
  console.log(i, JSON.stringify(await sample()));
  if (i === 2) { await page.evaluate(() => window.__vw.setPaused(true)); console.log('-- paused --'); }
}
await browser.close();
