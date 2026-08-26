import { test, expect, type Page } from '@playwright/test';
import { openScene, step, render } from './utils';

/**
 * Inspection camera: real pointer/wheel events driving the orbit controller in
 * the browser, plus the parallax check that proves the camera moves through
 * world space rather than the image being re-projected.
 */

/** Attach the controller (test mode leaves it detached) and advance its damping. */
async function attach(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).__vw;
    api.orbit.attach(document.getElementById('view'), api.camera);
  });
}

async function settle(page: Page, frames = 40): Promise<void> {
  await page.evaluate((n) => {
    const api = (window as any).__vw;
    for (let i = 0; i < n; i++) api.orbit.update(1 / 60, api.camera);
    api.camera.updateMatrixWorld();
  }, frames);
}

async function pose(page: Page): Promise<{ pos: [number, number, number]; dist: number; target: [number, number, number] }> {
  return page.evaluate(() => {
    const api = (window as any).__vw;
    const p = api.camera.position;
    const t = api.orbit.target;
    return {
      pos: [p.x, p.y, p.z] as [number, number, number],
      dist: p.distanceTo(t),
      target: [t.x, t.y, t.z] as [number, number, number],
    };
  });
}

async function drag(page: Page, from: [number, number], to: [number, number], button = 0): Promise<void> {
  await page.evaluate(
    ({ from, to, button }) => {
      const el = document.getElementById('view')!;
      const opts = { pointerId: 1, pointerType: 'mouse', bubbles: true, button, buttons: button === 2 ? 2 : 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: from[0], clientY: from[1] }));
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        el.dispatchEvent(new PointerEvent('pointermove', {
          ...opts,
          clientX: from[0] + ((to[0] - from[0]) * i) / steps,
          clientY: from[1] + ((to[1] - from[1]) * i) / steps,
        }));
      }
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: to[0], clientY: to[1] }));
    },
    { from, to, button },
  );
}

test.describe('inspection camera', () => {
  test('drag orbits around the subject at constant radius and takes over auto-orbit', async ({ page }) => {
    await openScene(page, 'puff');
    await attach(page);
    const before = await pose(page);
    expect(before.dist).toBeGreaterThan(2);

    await drag(page, [240, 160], [400, 160]);
    await settle(page);
    const after = await pose(page);

    // Orbit, not dolly: the radius is preserved…
    expect(Math.abs(after.dist - before.dist)).toBeLessThan(before.dist * 0.06);
    // …the pivot is untouched…
    expect(Math.hypot(...after.target.map((v, i) => v - before.target[i]))).toBeLessThan(0.05);
    // …and the camera actually swung around it.
    const swing = Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]);
    expect(swing).toBeGreaterThan(before.dist * 0.25);

    const state = await page.evaluate(() => {
      const o = (window as any).__vw.orbit;
      return { engaged: o.engaged, autoOrbit: o.autoOrbit, enabled: o.enabled };
    });
    expect(state.engaged).toBe(true);
    expect(state.enabled).toBe(true);
    expect(state.autoOrbit).toBe(false); // manual drag stops the automatic sweep
  });

  test('wheel and pinch zoom the radius without moving the pivot', async ({ page }) => {
    await openScene(page, 'puff');
    await attach(page);
    const before = await pose(page);

    await page.evaluate(() => {
      document.getElementById('view')!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }),
      );
    });
    await settle(page);
    const zoomedIn = await pose(page);
    expect(zoomedIn.dist).toBeLessThan(before.dist * 0.85);
    expect(Math.hypot(...zoomedIn.target.map((v, i) => v - before.target[i]))).toBeLessThan(0.05);

    // Two fingers moving apart => zoom in further.
    await page.evaluate(() => {
      const el = document.getElementById('view')!;
      const mk = (type: string, id: number, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', bubbles: true, clientX: x, clientY: y, buttons: 1 }));
      mk('pointerdown', 11, 200, 150);
      mk('pointerdown', 12, 240, 150);
      for (let i = 1; i <= 5; i++) {
        mk('pointermove', 11, 200 - i * 12, 150);
        mk('pointermove', 12, 240 + i * 12, 150);
      }
      mk('pointerup', 11, 140, 150);
      mk('pointerup', 12, 300, 150);
    });
    await settle(page);
    const pinched = await pose(page);
    expect(pinched.dist).toBeLessThan(zoomedIn.dist * 0.95);
  });

  test('auto-orbit sweeps the camera on its own and reset restores the authored view', async ({ page }) => {
    await openScene(page, 'puff');
    const home = await page.evaluate(() => {
      const api = (window as any).__vw;
      api.setView({}); // enable the controller at the scene's own pose
      const p = api.camera.position;
      return [p.x, p.y, p.z] as [number, number, number];
    });

    await page.evaluate(() => ((window as any).__vw.orbit.autoOrbit = true));
    await settle(page, 120); // 2 s of auto-orbit
    const swept = await pose(page);
    const moved = Math.hypot(swept.pos[0] - home[0], swept.pos[2] - home[2]);
    expect(moved).toBeGreaterThan(0.5);
    expect(swept.dist).toBeGreaterThan(2);

    await page.evaluate(() => {
      const o = (window as any).__vw.orbit;
      o.autoOrbit = false;
      o.reset();
    });
    await settle(page, 180);
    const back = await pose(page);
    expect(Math.hypot(back.pos[0] - home[0], back.pos[1] - home[1], back.pos[2] - home[2])).toBeLessThan(0.35);
  });

  test('orbiting produces genuine parallax: opposite sides render different images', async ({ page }, testInfo) => {
    await openScene(page, 'obstacles', { render: true });
    await step(page, 60);

    const frameAt = async (yawDeg: number): Promise<{ hash: number[]; png: Buffer }> => {
      await page.evaluate((y) => (window as any).__vw.setView({ yawDeg: y, pitchDeg: 16 }), yawDeg);
      await render(page);
      await render(page);
      const hash = await page.evaluate(() => {
        // Coarse 8x8 luminance signature of the composited frame.
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
      return { hash, png: await page.screenshot() };
    };

    const front = await frameAt(0);
    const side = await frameAt(90);
    const back = await frameAt(180);
    await testInfo.attach('orbit-0deg.png', { body: front.png, contentType: 'image/png' });
    await testInfo.attach('orbit-90deg.png', { body: side.png, contentType: 'image/png' });
    await testInfo.attach('orbit-180deg.png', { body: back.png, contentType: 'image/png' });

    const diff = (a: number[], b: number[]): number =>
      a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    // A camera that truly moved sees a different scene from each side; a broken
    // controller (or a re-projected still) would leave these near-identical.
    expect(diff(front.hash, side.hash)).toBeGreaterThan(4);
    expect(diff(front.hash, back.hash)).toBeGreaterThan(4);
  });
});
