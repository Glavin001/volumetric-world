// Instruments GPUTexture.createView to find who creates 2D views of 3D textures.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 4611, strictPort: true }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
await page.addInitScript(() => {
  const orig = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (desc) {
    try {
      if (this.dimension === '3d' && desc && desc.dimension && desc.dimension !== '3d') {
        const stack = new Error().stack?.split('\n').slice(1, 7).join(' | ');
        (window.__badViews ??= []).push({ label: this.label, desc: JSON.stringify(desc), stack });
      }
    } catch {}
    return orig.call(this, desc);
  };
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => { const t = m.text(); if (t.includes('dimension') || t.includes('Device') || t.includes('error')) console.log('[console]', t.slice(0, 400)); });
await page.goto('http://localhost:4611/?scene=puff&preset=test&test=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vwReady || window.__vwError, null, { timeout: 120000 });
await page.evaluate(() => window.__vw.step(1 / 30, 12));
await page.evaluate(() => window.__vw.render());
const bad = await page.evaluate(() => window.__badViews ?? []);
console.log('BAD VIEWS:', bad.length);
for (const b of bad.slice(0, 4)) console.log(JSON.stringify(b, null, 1).slice(0, 1200), '\n---');
await browser.close();
await server.close();
