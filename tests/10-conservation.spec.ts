import { test, expect } from '@playwright/test';
import { openScene } from './utils';

/**
 * Mass/property conservation in the packet system — the paths that used to
 * silently destroy or bias mass: budget truncation, promotion overflow, and
 * the mergeAndSplit optical-blend bug.
 */
test.describe('packet conservation', () => {
  test('merging two packets blends optical properties linearly by mass', async ({ page }) => {
    await openScene(page, 'puff');
    const r = await page.evaluate(() => {
      const sys = (window as any).__vw.world.packets;
      sys.packets.length = 0;
      // Two co-located, co-moving packets with very different optics: the
      // merged result must be the mass-weighted mean (NOT biased cubically).
      const mkMat = (ext: number, alb: number, g: number) => ({
        id: 't', extinctionPerMassRgbM2PerKg: [ext, ext, ext], singleScatteringAlbedoRgb: [alb, alb, alb],
        phaseAnisotropyG: g, fineMassFraction: 1, coarseMassFraction: 0, coarseSettlingSpeedMps: 0,
        detail: { baseScaleM: 1, advectionResponse: 1 },
        artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
      });
      sys.spawnFromMaterial(mkMat(1, 0.2, 0.0), [0, 2, 0], [1, 1, 1], 3.0, [0, 0, 0], 1, 1);
      sys.spawnFromMaterial(mkMat(3, 0.8, 0.6), [0.1, 2, 0], [1, 1, 1], 1.0, [0, 0, 0], 2, 1);
      const before = sys.totalMass();
      sys.update(0.016, [0, 0, 0]); // triggers mergeAndSplit
      const p = sys.packets[0];
      return {
        count: sys.packets.length,
        massBefore: before,
        massAfter: sys.totalMass(),
        ext: p.extPerMassRgb[0],
        albedo: p.albedoRgb[0],
        phaseG: p.phaseG,
      };
    });
    expect(r.count).toBe(1);
    expect(r.massAfter).toBeCloseTo(r.massBefore, 1);
    // mass weights: 0.75 / 0.25 → ext = 1*0.75 + 3*0.25 = 1.5, albedo = 0.35, g = 0.15
    expect(r.ext).toBeCloseTo(1.5, 1);
    expect(r.albedo).toBeCloseTo(0.35, 1);
    expect(r.phaseG).toBeCloseTo(0.15, 1);
  });

  test('exceeding the packet budget folds overflow into survivors instead of deleting mass', async ({ page }) => {
    await openScene(page, 'puff');
    const r = await page.evaluate(() => {
      const sys = (window as any).__vw.world.packets;
      sys.packets.length = 0;
      const mat = {
        id: 'm', extinctionPerMassRgbM2PerKg: [1.5, 1.5, 1.5], singleScatteringAlbedoRgb: [0.7, 0.7, 0.7],
        phaseAnisotropyG: 0.3, fineMassFraction: 1, coarseMassFraction: 0, coarseSettlingSpeedMps: 0,
        detail: { baseScaleM: 1, advectionResponse: 1 },
        artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
      };
      // Spread far apart with distinct velocities so nothing merges naturally.
      for (let i = 0; i < 140; i++) {
        sys.spawnFromMaterial(
          mat,
          [(i % 20) * 30, 5 + Math.floor(i / 20) * 25, (i % 7) * 40],
          [1, 1, 1], 2.0, [i % 3, 0, i % 5], i, 1,
        );
      }
      const before = sys.totalMass();
      sys.update(0.016, [0, 0, 0]);
      return { before, after: sys.totalMass(), count: sys.packets.length };
    });
    expect(r.count).toBeLessThanOrEqual(128);
    // Small dissipation from update() is fine; wholesale deletion (was ~12 packets
    // × 2kg = 24kg lost) is not.
    expect(r.after).toBeGreaterThan(r.before * 0.98);
  });

  test('promotion with more packets than the GPU can voxelize returns the overflow to the pool', async ({ page }) => {
    await openScene(page, 'puff');
    const r = await page.evaluate(() => {
      const api = (window as any).__vw;
      const sys = api.world.packets;
      sys.packets.length = 0;
      const mat = {
        id: 'm', extinctionPerMassRgbM2PerKg: [1.5, 1.5, 1.5], singleScatteringAlbedoRgb: [0.7, 0.7, 0.7],
        phaseAnisotropyG: 0.3, fineMassFraction: 1, coarseMassFraction: 0, coarseSettlingSpeedMps: 0,
        detail: { baseScaleM: 1, advectionResponse: 1 },
        artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
      };
      // 12 packets all inside one promotion radius.
      for (let i = 0; i < 12; i++) {
        sys.spawnFromMaterial(mat, [30 + (i % 3), 3 + Math.floor(i / 3) * 0.7, 30 + (i % 4)], [0.8, 0.8, 0.8], 1.5, [0, 0, 0], i, 1);
      }
      const before = sys.totalMass();
      const estSum = () =>
        api.world.scheduler.activeIslands().reduce((m: number, isl: any) => m + isl.estimatedMassKg, 0);
      const estBefore = estSum(); // the scene's own puff island
      const ok = api.world.promoteAt([31, 4, 31], 7);
      return { ok, before, returned: sys.totalMass(), islandEst: estSum() - estBefore, poolCount: sys.packets.length };
    });
    expect(r.ok).toBe(true);
    // 8 heaviest injected (est mass tracks the injected subset), 4 returned.
    expect(r.poolCount).toBe(4);
    expect(r.returned + r.islandEst).toBeCloseTo(r.before, 0);
  });
});
