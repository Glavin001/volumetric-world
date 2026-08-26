import { test, expect } from '@playwright/test';
import { openScene, step, metrics, gridStats } from './utils';

/**
 * Moving solid boundaries + wakes: the falling slab drives displacement and
 * the hidden car stirs a cloud the camera can see while the car itself is
 * occluded (rendering visibility never gates simulation).
 */
test.describe('dynamic bodies', () => {
  test('falling slab displaces resting dust outward', async ({ page }) => {
    await openScene(page, 'slab');
    // t=0.85 s: dust has settled, slab still overhead.
    await step(page, 26);
    const before = gridStats((await metrics(page)).islands[0]);
    // Slab falls from t≈0.9 and lands ≈1.85 s; give the splash time to develop.
    await step(page, 44); // t ≈ 2.33 s
    const after = gridStats((await metrics(page)).islands[0]);

    expect(before.mass).toBeGreaterThan(10);
    // Displacement pushes the resting layer outward noticeably faster than
    // the slow gravity-current creep before impact.
    expect(after.spreadXZ).toBeGreaterThan(before.spreadXZ * 1.12);
  });

  test('hidden car behind the wall stirs the visible cloud (off-screen interaction)', async ({ page }) => {
    // Combined center of mass across island grids AND far-field packets:
    // wake-pushed dust that crosses the island boundary becomes packets and
    // must stay in the accounting.
    const combinedComX = async (): Promise<{ com: number; mass: number }> => {
      const m = await metrics(page);
      let mass = 0;
      let mx = 0;
      for (const island of m.islands) {
        const s = gridStats(island);
        mass += s.mass;
        mx += s.com[0] * s.mass;
      }
      const packets = (await page.evaluate(() =>
        (window as any).__vw.world.packets.packets.map((p: any) => [p.position[0], p.massKg]),
      )) as [number, number][];
      for (const [x, pm] of packets) {
        mass += pm;
        mx += x * pm;
      }
      return { com: mass > 0 ? mx / mass : 0, mass };
    };

    await openScene(page, 'hiddenCar');
    // Cloud forms; car starts driving at t=1.2 s from x=-26 at 11 m/s.
    await step(page, 60); // t = 2.0 s — car still ~17 m away from the cloud
    const before = await combinedComX();
    // Car crosses the cloud (x≈-1…4) around t ≈ 3.6–4.0 s; sample right after,
    // before the far-field export/promotion churn reshuffles the accounting.
    await step(page, 60); // t = 4.0 s
    const after = await combinedComX();

    expect(before.mass).toBeGreaterThan(20);
    // No wind in this scene: without the car the puff stays x-symmetric.
    // The car's swept wake drags the cloud along +x.
    const shift = after.com - before.com;
    expect(shift).toBeGreaterThan(0.25);
  });
});
