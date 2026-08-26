import { test, expect } from '@playwright/test';
import { openScene, step, metrics, render, pageErrors } from './utils';

test.describe('engine boot', () => {
  test('initializes WebGPU, spawns an island for the first emission, and renders', async ({ page }) => {
    await openScene(page, 'puff', { render: true });

    const m0 = await metrics(page);
    expect(m0.activeIslands).toBe(1);
    expect(m0.islands[0].tier).toBeTruthy();

    await step(page, 8);
    await render(page);
    const m1 = await metrics(page);
    expect(m1.islandMassKg).toBeGreaterThan(1);

    // The composited 2D canvas must contain non-trivial image data.
    const stats = await page.evaluate(() => {
      const c = document.getElementById('shot') as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      let sum2 = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += l;
        sum2 += l * l;
      }
      const mean = sum / n;
      return { mean, variance: sum2 / n - mean * mean, w: c.width, h: c.height };
    });
    expect(stats.mean).toBeGreaterThan(8); // not a black frame
    expect(stats.variance).toBeGreaterThan(40); // not a flat frame

    const fatal = pageErrors(page).filter((e) => !/favicon/i.test(e));
    expect(fatal, `page errors: ${fatal.join(' | ')}`).toHaveLength(0);
  });
});
