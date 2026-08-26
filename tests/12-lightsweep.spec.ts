import { test, expect, type Page } from '@playwright/test';
import { openScene, step, render } from './utils';

/**
 * The O(N³) light sweep must light the volume like the legacy per-voxel march
 * (?lightpath=march) — same scene, same deterministic steps, same view.
 */

async function litFrame(page: Page, extra: Record<string, string>): Promise<number[]> {
  await openScene(page, 'backlit', { render: true, extra });
  await step(page, 45);
  await page.evaluate(() => (window as any).__vw.setView({ yawDeg: 200, pitchDeg: 10, dist: 12 }));
  await render(page);
  await render(page);
  return page.evaluate(() => {
    const c = document.getElementById('shot') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    const d = ctx.getImageData(0, 0, w, h).data;
    const out: number[] = [];
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        let sum = 0;
        let n = 0;
        for (let y = Math.floor((by * h) / 8); y < Math.floor(((by + 1) * h) / 8); y += 2) {
          for (let x = Math.floor((bx * w) / 8); x < Math.floor(((bx + 1) * w) / 8); x += 2) {
            const i = (y * w + x) * 4;
            sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
            n++;
          }
        }
        out.push(n ? sum / n : 0);
      }
    }
    return out;
  });
}

test('light sweep matches the legacy per-voxel march within tolerance', async ({ page }) => {
  const sweep = await litFrame(page, {});
  const march = await litFrame(page, { lightpath: 'march' });
  const meanDiff = sweep.reduce((s, v, i) => s + Math.abs(v - march[i]), 0) / sweep.length;
  const meanLum = sweep.reduce((s, v) => s + v, 0) / sweep.length;
  // Backlit dust is the harshest test of the shadow cache (transmittance
  // drives everything). The two algorithms sample differently, so allow a
  // modest local tolerance, but the images must clearly be the same lighting.
  expect(meanLum).toBeGreaterThan(20); // scene actually renders
  expect(meanDiff).toBeLessThan(14);
});
