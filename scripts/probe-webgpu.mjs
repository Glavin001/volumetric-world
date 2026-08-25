// Probes WebGPU availability in the container's Chromium with several flag sets,
// served from http://localhost (secure context) rather than about:blank.
import { chromium } from '@playwright/test';
import http from 'node:http';

const EXEC = '/opt/pw-browsers/chromium';

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><body>probe</body></html>');
});
await new Promise((r) => server.listen(4599, r));

const FLAG_SETS = [
  ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
  ['--no-sandbox', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPUService'],
  ['--no-sandbox', '--enable-features=WebGPU,Vulkan', '--enable-unsafe-webgpu'],
  ['--no-sandbox', '--enable-blink-features=WebGPU', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
];

for (const [i, args] of FLAG_SETS.entries()) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: EXEC, args, headless: true });
    const page = await browser.newPage();
    await page.goto('http://localhost:4599/');
    const result = await page.evaluate(async () => {
      if (!navigator.gpu) return { ok: false, reason: 'navigator.gpu missing', secure: window.isSecureContext };
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false, reason: 'no adapter' };
      const info = adapter.info ?? {};
      const device = await adapter.requestDevice();
      if (!device) return { ok: false, reason: 'no device' };
      return {
        ok: true,
        vendor: info.vendor, architecture: info.architecture, description: info.description,
        limits: {
          maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage,
          maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
          maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        },
        features: [...adapter.features.values()],
      };
    });
    console.log(`FLAGSET ${i}:`, JSON.stringify(result).slice(0, 1000));
    await browser.close();
    if (result.ok) { console.log(`WINNER: ${i} -> ${args.join(' ')}`); break; }
  } catch (e) {
    console.log(`FLAGSET ${i} ERROR:`, String(e).slice(0, 300));
    if (browser) await browser.close().catch(() => {});
  }
}
server.close();
