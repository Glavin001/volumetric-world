// Compare the composited scene (mode 0) with the shader's depth reconstruction
// (mode 1) on asymmetric geometry: if the shader's uv->NDC mapping disagrees
// with the rasteriser, mode 1 comes out mirrored.
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const OUT = '/tmp/claude-0/-home-user-volumetric-world/4dd64bb2-e10e-58d9-a2a1-5e76406c3d00/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=doorway&preset=test&test=1&norender=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 30));
await page.evaluate(() => window.__vw.setView({ yawDeg: 35, pitchDeg: 22, dist: 20 }));
for (const mode of [0, 1]) {
  await page.evaluate((m) => window.__vw.setDebugMode(m), mode);
  await page.evaluate(() => window.__vw.render());
  await page.screenshot({ path: `${OUT}/flip-mode${mode}.png` });
}
console.log('saved flip-mode0.png (composite) and flip-mode1.png (shader depth reconstruction)');
await browser.close();
