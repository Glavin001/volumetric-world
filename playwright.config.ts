import { defineConfig } from '@playwright/test';

/**
 * Real-browser tests against headless Chromium with WebGPU (SwiftShader).
 * The container pre-installs Chromium at /opt/pw-browsers/chromium; WebGPU
 * needs the Vulkan flags below. Presentation to canvas crashes SwiftShader,
 * so the app runs with present=readback in tests (see src/main.ts).
 */
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests',
  timeout: 420_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PW_BASE_URL ?? 'http://localhost:4173',
    viewport: { width: 480, height: 320 },
    launchOptions: {
      executablePath,
      args: [
        '--no-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--disable-vulkan-surface',
      ],
    },
  },
  webServer: process.env.PW_BASE_URL
    ? undefined
    : {
        command: 'npm run test:server',
        port: 4173,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
