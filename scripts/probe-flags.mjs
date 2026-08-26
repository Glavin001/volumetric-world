// Find a flag set where BOTH adapter creation AND buffer mapAsync work headless.
import { chromium } from '@playwright/test';
import http from 'node:http';

setTimeout(() => { console.log('WATCHDOG'); process.exit(3); }, 300000);

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><body>x</body></html>');
});
await new Promise((r) => server.listen(4599, r));

const FLAG_SETS = [
  ['--no-sandbox', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--enable-begin-frame-control'],
  ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout'],
  ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
];

async function testFlags(args, headlessMode) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args, headless: headlessMode });
    const page = await browser.newPage();
    await page.goto('http://localhost:4599/');
    const res = await page.evaluate(async () => {
      if (!navigator.gpu) return 'no navigator.gpu';
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return 'no adapter';
      const dev = await adapter.requestDevice();
      const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      dev.queue.writeBuffer(buf, 0, new Float32Array([1, 2, 3, 4]));
      const rb = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(buf, 0, rb, 0, 16);
      dev.queue.submit([enc.finish()]);
      const r = await Promise.race([
        rb.mapAsync(GPUMapMode.READ).then(() => `MAPPED ${Array.from(new Float32Array(rb.getMappedRange()))}`),
        new Promise((res2) => setTimeout(() => res2('map TIMEOUT'), 6000)),
      ]);
      return `${adapter.info?.architecture ?? '?'} | ${r}`;
    });
    await browser.close();
    return res;
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return `ERR ${String(e).slice(0, 160)}`;
  }
}

for (const [i, args] of FLAG_SETS.entries()) {
  console.log(`SET ${i} headless:`, await testFlags(args, true));
}
// Also try headful with Xvfb absent → likely fails, but try headless=false with --headless removed handled by PW
server.close();
process.exit(0);
