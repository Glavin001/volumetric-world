import { test, expect, type Page } from '@playwright/test';
import { openScene, step, render } from './utils';

/**
 * World-anchoring: the dust must be rendered where the simulation actually put
 * it. These assertions are absolute — they compare the composited image against
 * the world-space mass distribution and the camera's own projection — rather
 * than merely checking that two views differ, which a mirrored or displaced
 * volume can satisfy just as well as a correct one.
 */

/** Screen rows (as NDC y) where the volume is drawn, via the density debug view. */
async function drawnNdcY(page: Page): Promise<[number, number] | null> {
  return page.evaluate(() => {
    const c = document.getElementById('shot') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    const d = ctx.getImageData(0, 0, w, h).data;
    let top = -1;
    let bot = -1;
    for (let y = 0; y < h; y++) {
      let any = false;
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4] >= 40) { any = true; break; }
      }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (top < 0) return null;
    const ndc = (p: number): number => 1 - (p / h) * 2;
    return [ndc(bot), ndc(top)] as [number, number];
  });
}

test.describe('render is anchored to the world', () => {
  test('quad uv runs top-to-bottom, so ray generation must flip NDC y', async ({ page }) => {
    // Guards the convention the whole raymarch depends on: if v ever changes
    // orientation, every volumetric ray mirrors about the view axis.
    await openScene(page, 'puff', { render: true });
    await step(page, 10);
    await page.evaluate(() => (window as any).__vw.setDebugMode(9));
    await render(page);
    const corners = await page.evaluate(() => {
      const c = document.getElementById('shot') as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      const { width: w, height: h } = c;
      const d = ctx.getImageData(0, 0, w, h).data;
      const at = (x: number, y: number): number => d[(y * w + x) * 4 + 1] / 255; // green = v
      return { top: at(2, 2), bottom: at(2, h - 3) };
    });
    expect(corners.top, 'v = 0 at the top row').toBeLessThan(0.1);
    expect(corners.bottom, 'v = 1 at the bottom row').toBeGreaterThan(0.9);
  });

  test('ground-hugging dust renders below the horizon, not in the sky', async ({ page }) => {
    await openScene(page, 'puff', { render: true });
    await step(page, 90);
    await page.evaluate(() => (window as any).__vw.setView({ yawDeg: 25, pitchDeg: 14, dist: 15 }));
    await page.evaluate(() => (window as any).__vw.setDebugMode(5));
    await render(page);

    const drawn = await drawnNdcY(page);
    expect(drawn, 'the puff should be visible').not.toBeNull();

    const geom = await page.evaluate(async () => {
      const api = (window as any).__vw;
      const m = await api.metrics();
      const isl = m.islands[0];
      // Highest world Y that holds any mass, from the coarse grid.
      const c = 16;
      const cell = isl.sizeM / c;
      let topLayer = 0;
      for (let z = 0; z < c; z++) {
        for (let y = 0; y < c; y++) {
          for (let x = 0; x < c; x++) {
            if (isl.coarse[(x + y * c + z * c * c) * 4] > 1e-5) topLayer = Math.max(topLayer, y);
          }
        }
      }
      const dustTopY = isl.origin[1] + (topLayer + 1) * cell;
      // The horizon: the camera's own eye height, infinitely far away.
      const V = api.camera.position.constructor;
      const eye = api.camera.position.y;
      const horizonNdc = new V(0, eye, -1e6).project(api.camera).y;
      return { dustTopY, eye, horizonNdc };
    });

    // Dust exists only well below eye level, so none of it can project above
    // the horizon. The pre-fix renderer drew it far into the sky.
    expect(geom.dustTopY).toBeLessThan(geom.eye);
    expect(drawn![1], 'volume must not reach above the horizon').toBeLessThan(geom.horizonNdc);
  });

  test('an off-centre plume tracks its world position across opposite views', async ({ page }) => {
    await openScene(page, 'vortex', { render: true });
    await step(page, 55);
    await page.evaluate(() => (window as any).__vw.setDebugMode(5));

    const sideOf = async (yawDeg: number): Promise<{ drawn: number; expected: number }> => {
      await page.evaluate((y) => (window as any).__vw.setView({ yawDeg: y, pitchDeg: 16 }), yawDeg);
      await render(page);
      return page.evaluate(async () => {
        const api = (window as any).__vw;
        const m = await api.metrics();
        const com = m.islands[0].comWorld;
        const V = api.camera.position.constructor;
        const expected = new V(com[0], com[1], com[2]).project(api.camera).x;

        const c = document.getElementById('shot') as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        const { width: w, height: h } = c;
        const d = ctx.getImageData(0, 0, w, h).data;
        let sx = 0;
        let sw = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const lum = d[(y * w + x) * 4];
            if (lum < 40) continue;
            sx += x * lum;
            sw += lum;
          }
        }
        return { drawn: sw ? (sx / sw / w) * 2 - 1 : 0, expected };
      });
    };

    // Viewed from opposite sides, an off-centre plume swaps which side of the
    // frame it sits on; a mirrored or camera-locked volume does not.
    const a = await sideOf(50);
    const b = await sideOf(230);
    expect(Math.sign(a.drawn), 'plume sits on the same side its COM projects to').toBe(Math.sign(a.expected));
    expect(Math.sign(b.drawn)).toBe(Math.sign(b.expected));
    expect(Math.sign(a.drawn), 'opposite views put the plume on opposite sides').not.toBe(Math.sign(b.drawn));
  });
});
