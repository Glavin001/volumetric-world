import { test, expect } from '@playwright/test';
import { openScene, step, render, metrics } from './utils';

/**
 * Rendering sanity in a real browser: each key look renders a frame whose
 * statistics show a visible cloud, and screenshots are attached as artifacts.
 */

async function frameStats(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.getElementById('shot') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, sum2 = 0, bright = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += l;
      sum2 += l * l;
      if (l > 190) bright++;
    }
    const mean = sum / n;
    return { mean, variance: sum2 / n - mean * mean, brightFrac: bright / n, w, h };
  });
}

const shots: { scene: string; steps: number; check?: 'bright' }[] = [
  { scene: 'puff', steps: 34 },
  { scene: 'backlit', steps: 30, check: 'bright' },
  { scene: 'slab', steps: 62 },
  { scene: 'inside', steps: 40 },
];

for (const s of shots) {
  test(`renders ${s.scene}`, async ({ page }, testInfo) => {
    await openScene(page, s.scene, { render: true });
    await step(page, s.steps);
    await render(page);
    await render(page); // second frame settles jitter/history
    const stats = await frameStats(page);
    expect(stats.variance, 'frame should not be flat').toBeGreaterThan(60);
    expect(stats.mean).toBeGreaterThan(10);
    if (s.check === 'bright') {
      // Backlit silver lining: strong forward scattering must produce
      // a meaningful fraction of very bright cloud pixels.
      expect(stats.brightFrac).toBeGreaterThan(0.01);
    }
    const png = await page.screenshot();
    await testInfo.attach(`${s.scene}.png`, { body: png, contentType: 'image/png' });
    const m = await metrics(page);
    expect(m.totalMassKg).toBeGreaterThan(5);
  });
}

test('camera inside the cloud sees participating media in every direction', async ({ page }) => {
  await openScene(page, 'inside', { render: true });
  await step(page, 45);
  await render(page);
  const stats = await frameStats(page);
  // Inside a dense cloud the frame is dominated by scattered light: bright-ish,
  // low-saturation, with variance well below a clear-sky/ground split.
  expect(stats.mean).toBeGreaterThan(60);
});
