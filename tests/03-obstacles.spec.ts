import { test, expect } from '@playwright/test';
import { openScene, step, massInRegion, metrics } from './utils';

/**
 * Static solid boundaries: voxelized colliders must exclude dust and the
 * projected flow must carry dust around/past them (doc scene "cloud around
 * box and convex hull").
 */
test.describe('static obstacles', () => {
  test('solids exclude dust while flow continues past them', async ({ page }) => {
    await openScene(page, 'obstacles');
    await step(page, 120); // t = 4 s: the sustained jet has split around the box

    const m = await metrics(page);
    const total = m.islandMassKg;
    expect(total).toBeGreaterThan(15);

    // Inside the wooden box obstacle (center 2.6,1.1,0 half 0.85,1.1,0.85; sample its core).
    const inBox = await massInRegion(page, [2.1, 0.5, -0.5], [3.1, 1.7, 0.5]);
    // Same-sized air regions on the box's flanks — the split flow passes here.
    const flankL = await massInRegion(page, [1.6, 0.3, 1.0], [3.6, 2.2, 2.6]);
    const flankR = await massInRegion(page, [1.6, 0.3, -2.6], [3.6, 2.2, -1.0]);
    const flanks = flankL + flankR;
    expect(flanks).toBeGreaterThan(total * 0.01);
    expect(inBox).toBeLessThan(Math.max(flanks * 0.3, total * 0.012));

    // Some dust continues past the obstacle line.
    const downstream = await massInRegion(page, [3.7, 0, -6], [10, 6, 6]);
    expect(downstream).toBeGreaterThan(total * 0.02);
  });

  test('doorway topology: dust reaches the far room only through the opening', async ({ page }) => {
    await openScene(page, 'doorway');
    await step(page, 120); // t = 4 s of a 2.2 s injection aimed at the door

    // Room B interior (x > divider, inside the sealed cutaway rooms).
    const roomB = await massInRegion(page, [0.5, 0.1, -3.4], [4.3, 3.6, 1.8]);
    // Leakage beyond the sealed right wall (x=6 ± 0.25) would be a solver hole.
    const outside = await massInRegion(page, [6.6, 0, -6], [12, 6, 6]);
    // Above the invisible ceiling lid (y=4.05±0.25).
    const above = await massInRegion(page, [-6, 4.6, -4.5], [6, 8, 3]);

    expect(roomB).toBeGreaterThan(1.0);
    expect(outside).toBeLessThan(Math.max(roomB * 0.1, 0.15));
    expect(above).toBeLessThan(Math.max(roomB * 0.15, 0.2));
  });
});
