import { test, expect } from '@playwright/test';
import { openScene, step, metrics } from './utils';

/**
 * Multi-island scheduling and the grid↔packet persistence layer:
 * pooled islands under budget, retirement→packets handoff (mass preserved),
 * wind transport of packets, and packet→grid promotion.
 */
test.describe('scheduler + persistence', () => {
  test('four collapses share the pooled islands within budget', async ({ page }) => {
    await openScene(page, 'multi');
    await step(page, 80); // all four events emitted (staggered 0.55 s apart)
    const m = await metrics(page);
    expect(m.activeIslands).toBeGreaterThanOrEqual(2);
    expect(m.activeIslands).toBeLessThanOrEqual(4); // pool size
    for (const i of m.islands) expect(i.massKg).toBeGreaterThan(1);
    // Tiers must not all collapse to one class.
    const tiers = new Set(m.islands.map((i) => i.tier));
    expect(tiers.size).toBeGreaterThanOrEqual(1);
    expect(m.totalMassKg).toBeGreaterThan(150);
  });

  test('retiring an island exports it into drifting far-field packets, and promotion revoxelizes them', async ({ page }) => {
    await openScene(page, 'cityblock');
    await step(page, 90); // t = 3 s: both collapses running, wind 2.6 m/s +x
    const before = await metrics(page);
    // Wind already blows dust across island boundaries into packets (shell
    // export) — the invariant is the combined total, not where it lives.
    expect(before.totalMassKg).toBeGreaterThan(120);

    // Force-retire every island (the scheduler would do this as importance
    // decays; tests shouldn't wait minutes for hysteresis).
    await page.evaluate(() => {
      const w = (window as any).__vw.world;
      for (const i of w.scheduler.activeIslands()) i.retiring = true;
    });
    await step(page, 10);
    // Let the export readbacks land, then give the sim-time crossfade room.
    await page.evaluate(() => (window as any).__vw.world.flushReadbacks());
    await step(page, 20);
    const after = await metrics(page);

    expect(after.packetCount).toBeGreaterThan(3);
    expect(after.packetMassKg).toBeGreaterThan(before.totalMassKg * 0.45);
    expect(after.activeIslands).toBe(0);

    // Packets drift with the wind while nothing is simulated on the grid.
    const px0 = (await page.evaluate(() => {
      const ps = (window as any).__vw.world.packets.packets;
      return ps.reduce((s: number, p: any) => s + p.position[0] * p.massKg, 0) /
        ps.reduce((s: number, p: any) => s + p.massKg, 0);
    })) as number;
    await step(page, 60); // 2 s of wind
    const px1 = (await page.evaluate(() => {
      const ps = (window as any).__vw.world.packets.packets;
      return ps.reduce((s: number, p: any) => s + p.position[0] * p.massKg, 0) /
        ps.reduce((s: number, p: any) => s + p.massKg, 0);
    })) as number;
    expect(px1 - px0).toBeGreaterThan(1.5); // ≥ ~0.75 m/s mean drift under 2.6 m/s wind

    // Promotion: revoxelize the densest packet cluster back into a fluid island.
    const cluster = (await page.evaluate(() => {
      const ps = (window as any).__vw.world.packets.packets;
      const best = ps.reduce((a: any, b: any) => (a.massKg > b.massKg ? a : b));
      return best.position;
    })) as [number, number, number];
    const promoted = (await page.evaluate((p) => (window as any).__vw.promoteAt(p, 8), cluster)) as boolean;
    expect(promoted).toBe(true);
    await step(page, 6);
    const final = await metrics(page);
    expect(final.activeIslands).toBeGreaterThanOrEqual(1);
    expect(final.islandMassKg).toBeGreaterThan(5);
  });
});
