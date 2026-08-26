// Bisect the render path: scene→RT, raymarch quad, composite quad — flush after each.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, Number(process.env.WD ?? 300000));
const server = await createServer({ server: { port: 4614, strictPort: true }, logLevel: 'error' });
await server.listen();
const FLAGSETS = {
  cts: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
  vulkansurf: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'],
  angleswift: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'],
  adapter: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  gl: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-gl=angle', '--use-angle=swiftshader'],
};
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: FLAGSETS[process.env.FLAGS ?? 'cts'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 250)));
page.on('console', (m) => { const t = m.text(); if (/error|lost|dimension|valid/i.test(t)) console.log('[c]', t.slice(0, 350)); });
await page.goto(`http://localhost:4614/?scene=puff&preset=test&test=1&norender=1&mlevel=${process.env.MLEVEL ?? 0}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
console.log('ready');

async function stage(label, fn) {
  const t = Date.now();
  try {
    await page.evaluate(fn);
    await page.evaluate(() => window.__vw.world.renderer.backend.device.queue.onSubmittedWorkDone());
    console.log(`${label}: OK ${Date.now() - t}ms`);
    return true;
  } catch (e) {
    console.log(`${label}: FAIL ${Date.now() - t}ms :: ${String(e).slice(0, 160)}`);
    return false;
  }
}

await stage('A opaque scene → RT', () => {
  const w = window.__vw.world;
  const p = w.pass;
  w.renderer.setRenderTarget(p.sceneRT);
  w.renderer.render(window.__vw.scene, window.__vw.camera);
  w.renderer.setRenderTarget(null);
});

await stage('B raymarch quad → hist RT', () => {
  const w = window.__vw.world;
  const p = w.pass;
  p.historyTexNode.value = p.histRT[1].texture;
  p.quad.material = p.raymarchMat;
  w.renderer.setRenderTarget(p.histRT[0]);
  p.quad.render(w.renderer);
  w.renderer.setRenderTarget(null);
});

await stage('C2 composite quad → RT', () => {
  const w = window.__vw.world;
  const p = w.pass;
  p.volTexNode.value = p.histRT[0].texture;
  p.quad.material = p.compositeMat;
  w.renderer.setRenderTarget(p.histRT[1]);
  p.quad.render(w.renderer);
  w.renderer.setRenderTarget(null);
});

await stage('C composite quad → screen', () => {
  const w = window.__vw.world;
  const p = w.pass;
  p.volTexNode.value = p.histRT[0].texture;
  p.quad.material = p.compositeMat;
  w.renderer.setRenderTarget(null);
  p.quad.render(w.renderer);
});

await browser.close();
await server.close();
process.exit(0);
