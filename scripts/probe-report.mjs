// One-off probe: build + auto-download the HUD debug report through the test
// API (the exact code path behind the "download debug report" button) and
// verify the JSON contains what a remote-debug session needs.
// Uses test mode because SwiftShader crashes on interactive canvas present.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const base = process.env.PW_BASE_URL ?? 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

await page.goto(`${base}/?scene=puff&preset=test&test=1&metrics=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 120000 });
// Accumulate some sim state + perf samples, then render a frame.
await page.evaluate(() => window.__vw.step(1 / 30, 40));
await page.evaluate(() => window.__vw.render());

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 240000 }),
  page.evaluate(() => window.__vw.downloadDebugReport()),
]);
const path = await download.path();
const report = JSON.parse(fs.readFileSync(path, 'utf8'));

console.log('downloaded:', download.suggestedFilename());
console.log('top-level keys:', Object.keys(report).join(', '));
console.log('perf:', JSON.stringify(report.perf?.simUpdateMs), 'samples:', report.perf?.samples);
console.log('gpu.info:', report.gpu?.info);
console.log('gpu.limits:', JSON.stringify(report.gpu?.limits ?? {}).slice(0, 120));
console.log('islands:', report.engine?.islands?.filter((i) => i.active).length, 'packets:', report.engine?.packets?.count);
console.log('log lines:', report.log?.length);
console.log('frameJpeg:', report.frameJpeg ? `${report.frameJpeg.length} chars, starts ${report.frameJpeg.slice(0, 30)}` : 'MISSING');

const required = ['generatedAt', 'userAgent', 'preset', 'gpu', 'engine', 'metrics', 'perf', 'log'];
const missing = required.filter((k) => !(k in report));
if (missing.length) { console.error('MISSING KEYS:', missing); process.exit(1); }
if (!report.frameJpeg?.startsWith('data:image/jpeg')) { console.error('frame capture missing/not jpeg'); process.exit(1); }
if (!report.perf || report.perf.samples < 10) { console.error('perf ring empty'); process.exit(1); }
if (!report.engine?.islands?.some((i) => i.active)) { console.error('no active island in engine snapshot'); process.exit(1); }
console.log('OK — report is complete');
await browser.close();
