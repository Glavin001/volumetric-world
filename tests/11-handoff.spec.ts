import { test, expect, type Page } from '@playwright/test';
import { openScene, step, metrics } from './utils';

/**
 * Grid↔packet handoff quality: exported packets must carry the plume's real
 * momentum (not ambient wind), retirement must preserve structure via 4³
 * moment groups, and promotion must crossfade instead of popping.
 */

/** Emit dust with a strong +x initial velocity into a quiet world. */
async function emitDirectional(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = (window as any).__vw.world;
    w.setWind([0, 0, 0]);
    w.emit({
      eventId: 90001,
      simulationTimeS: w.simTime,
      durationS: 0.5,
      substanceId: 'cold-aerosol',
      materialId: 'concrete',
      source: { kind: 'sphere', centerM: [0, 2.5, 0], radiusM: 1.4 },
      fineMassKg: 90,
      momentum: { kind: 'uniform', initialVelocityMps: [7, 0.5, 0] },
      seed: 3,
    });
  });
}

test.describe('grid↔packet handoff', () => {
  test('retired packets inherit the plume momentum, not ambient wind', async ({ page }) => {
    await openScene(page, 'puff', { extra: { seed: '3' } });
    // Neutralize the scene's own emission so only ours matters.
    await page.evaluate(() => {
      const w = (window as any).__vw.world;
      for (const i of w.scheduler.activeIslands()) {
        w.scheduler.free(i);
        w.engine.islands[i.slot].reset();
      }
      w.packets.packets.length = 0;
    });
    await emitDirectional(page);
    await step(page, 25); // fast dust still moving ~+x when we cut over

    // Sanity: the island's dust is genuinely moving +x (COM displacement).
    const com0 = (await metrics(page)).islands[0]?.comWorld ?? [0, 0, 0];
    await step(page, 10);
    const com1 = (await metrics(page)).islands[0]?.comWorld ?? [0, 0, 0];
    expect(com1[0] - com0[0]).toBeGreaterThan(0.15);

    await page.evaluate(() => {
      const w = (window as any).__vw.world;
      for (const i of w.scheduler.activeIslands()) i.retiring = true;
    });
    await step(page, 6);
    await page.evaluate(() => (window as any).__vw.world.flushReadbacks());
    await step(page, 4);

    const r = await page.evaluate(() => {
      const ps = (window as any).__vw.world.packets.packets;
      const m = ps.reduce((s: number, p: any) => s + p.massKg, 0);
      const vx = ps.reduce((s: number, p: any) => s + p.velocity[0] * p.massKg, 0) / Math.max(m, 1e-6);
      return { count: ps.length, massKg: m, meanVx: vx };
    });
    // With wind = 0 the old code exported everything at velocity 0. The plume
    // was launched at 7 m/s +x; after drag/projection the exported mean must
    // still be clearly positive.
    expect(r.count).toBeGreaterThan(0);
    expect(r.massKg).toBeGreaterThan(10);
    expect(r.meanVx).toBeGreaterThan(0.6);
  });

  test('retirement keeps plume structure: multiple moment groups, not one dome', async ({ page }) => {
    await openScene(page, 'puff', { extra: { seed: '3' } });
    await step(page, 60); // slumped pancake spread over several meters
    await page.evaluate(() => {
      const w = (window as any).__vw.world;
      w.packets.packets.length = 0;
      for (const i of w.scheduler.activeIslands()) i.retiring = true;
    });
    await step(page, 6);
    await page.evaluate(() => (window as any).__vw.world.flushReadbacks());
    await step(page, 4);
    const count = await page.evaluate(() => (window as any).__vw.world.packets.packets.length);
    // Octant matching capped this at 8 and usually produced 1-4 for a ground
    // pancake; 4³ groups must resolve more structure for a wide plume.
    expect(count).toBeGreaterThan(6);
  });

  test('promotion crossfades: island fades in while consumed packets fade out', async ({ page }) => {
    await openScene(page, 'puff');
    const r = await page.evaluate(() => {
      const api = (window as any).__vw;
      const w = api.world;
      const sys = w.packets;
      sys.packets.length = 0;
      const mat = {
        id: 'm', extinctionPerMassRgbM2PerKg: [1.5, 1.5, 1.5], singleScatteringAlbedoRgb: [0.7, 0.7, 0.7],
        phaseAnisotropyG: 0.3, fineMassFraction: 1, coarseMassFraction: 0, coarseSettlingSpeedMps: 0,
        detail: { baseScaleM: 1, advectionResponse: 1 },
        artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
      };
      for (let i = 0; i < 5; i++) {
        sys.spawnFromMaterial(mat, [40 + i * 0.5, 3, 40], [1, 1, 1], 2, [0, 0, 0], i, 1);
      }
      const ok = w.promoteAt([41, 3, 40], 7);
      const island = w.scheduler.activeIslands().find((i: any) => Math.abs(i.center[0] - 41) < 10);
      return {
        ok,
        fadeAtStart: island?.renderFade ?? -1,
        dyingCount: sys.dying.length,
        aliveCount: sys.packets.length,
      };
    });
    expect(r.ok).toBe(true);
    expect(r.fadeAtStart).toBe(0); // island starts invisible…
    expect(r.dyingCount).toBe(5); // …while its packets keep rendering
    expect(r.aliveCount).toBe(0);

    await step(page, 15); // 0.5 s
    const after = await page.evaluate(() => {
      const w = (window as any).__vw.world;
      const island = w.scheduler.activeIslands().find((i: any) => Math.abs(i.center[0] - 41) < 10);
      return { fade: island?.renderFade ?? -1, dyingCount: w.packets.dying.length };
    });
    expect(after.fade).toBe(1); // fully faded in
    expect(after.dyingCount).toBe(0); // packets fully faded out and removed
  });
});
