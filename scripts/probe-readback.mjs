// Isolate: does buffer mapAsync readback resolve in this headless environment?
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

setTimeout(() => { console.log('WATCHDOG EXIT'); process.exit(3); }, 240000);

const server = await createServer({ server: { port: 4612, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
page.on('console', (m) => console.log('[c]', m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 300)));
await page.goto('http://localhost:4612/?scene=puff&preset=test&test=1&norender=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });

// 1. raw device-level readback
const raw = await page.evaluate(async () => {
  const dev = window.__vw.world.renderer.backend.device;
  const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  dev.queue.writeBuffer(buf, 0, new Float32Array([1, 2, 3, 4]));
  const rb = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyBufferToBuffer(buf, 0, rb, 0, 16);
  dev.queue.submit([enc.finish()]);
  const t0 = performance.now();
  const result = await Promise.race([
    rb.mapAsync(GPUMapMode.READ).then(() => Array.from(new Float32Array(rb.getMappedRange()))),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 60000)),
  ]);
  return { result, ms: Math.round(performance.now() - t0) };
});
console.log('RAW READBACK:', JSON.stringify(raw));

// 2. three-level readField on coarseMass after one dispatch
const three = await page.evaluate(async () => {
  const w = window.__vw.world;
  w.engine.islands[0].computeMassGrid();
  const r = await Promise.race([
    w.engine.readField(w.engine.scratch.coarseMass).then((a) => `ok len=${a.length} sum=${a.reduce((x, y) => x + y, 0).toFixed(3)}`),
    new Promise((r2) => setTimeout(() => r2('TIMEOUT'), 60000)),
  ]);
  return r;
});
console.log('THREE READBACK:', three);

await browser.close();
await server.close();
process.exit(0);
