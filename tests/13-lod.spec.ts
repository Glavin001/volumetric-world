import { test, expect, type Page } from '@playwright/test';
import { openScene, step, metrics } from './utils';

/**
 * Viewer-centric LOD: fidelity follows the camera. Near events get fine slots
 * and higher rates; far events get coarse slots; moving the camera re-tiers an
 * island in place (GPU rebox) without a packet round-trip or mass loss.
 */

async function emitAt(page: Page, center: [number, number, number], massKg = 60): Promise<void> {
  await page.evaluate(([c, m]) => {
    const w = (window as any).__vw.world;
    w.emit({
      eventId: Math.floor(Math.random() * 1e6) + 1000,
      simulationTimeS: w.simTime,
      durationS: 0.4,
      substanceId: 'cold-aerosol',
      materialId: 'concrete',
      source: { kind: 'sphere', centerM: c, radiusM: 1.4 },
      fineMassKg: m,
      momentum: { kind: 'uniform', initialVelocityMps: [0, 0.5, 0] },
      seed: 5,
    });
  }, [center, massKg] as [typeof center, number]);
}

function clearWorld(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = (window as any).__vw.world;
    for (const i of w.scheduler.activeIslands()) {
      w.scheduler.free(i);
      w.engine.islands[i.slot].reset();
    }
    w.packets.packets.length = 0;
  });
}

test.describe('viewer-centric LOD', () => {
  test('near emissions get fine slots, far emissions get coarse slots', async ({ page }) => {
    await openScene(page, 'puff');
    await clearWorld(page);
    // Camera at origin-ish; test-mode default camera is the scene's authored one.
    await page.evaluate(() => (window as any).__vw.setView({ yawDeg: 0, pitchDeg: 15, dist: 12, target: [0, 2, 0] }));
    await emitAt(page, [0, 2.5, 0]); // ~12 m from camera
    await emitAt(page, [80, 2.5, 0]); // ~75+ m away
    await step(page, 8);
    const r = await page.evaluate(() => {
      const w = (window as any).__vw.world;
      return w.scheduler.activeIslands().map((i: any) => ({
        cls: i.cls,
        res: w.engine.islands[i.slot].N,
        cx: i.center[0],
        rateHz: i.rateHz,
      }));
    });
    const near = r.find((i: any) => Math.abs(i.cx) < 20)!;
    const far = r.find((i: any) => i.cx > 40)!;
    expect(near.cls).toBe('fine');
    expect(far.cls).toBe('coarse');
    expect(near.res).toBeGreaterThan(far.res);
    expect(near.rateHz).toBeGreaterThan(far.rateHz);
  });

  test('events focus mode gives every event a fine slot regardless of distance', async ({ page }) => {
    await openScene(page, 'puff', { extra: { focus: 'events' } });
    await clearWorld(page);
    await emitAt(page, [80, 2.5, 0]);
    await step(page, 8);
    const cls = await page.evaluate(() => (window as any).__vw.world.scheduler.activeIslands()[0]?.cls);
    expect(cls).toBe('fine');
  });

  test('approaching a coarse island reboxes it into a fine slot in place, conserving mass', async ({ page }) => {
    await openScene(page, 'puff');
    await clearWorld(page);
    await page.evaluate(() => (window as any).__vw.setView({ yawDeg: 0, pitchDeg: 15, dist: 12, target: [0, 2, 0] }));
    await emitAt(page, [80, 2.5, 0], 80);
    await step(page, 30); // emission done, dust settled into the coarse grid
    const before = await metrics(page);
    const beforeIsland = before.islands.find((i) => i.origin[0] > 40)!;
    const beforeState = await page.evaluate(() => {
      const w = (window as any).__vw.world;
      const i = w.scheduler.activeIslands()[0];
      return { cls: i.cls, slot: i.slot, packets: w.packets.packets.length };
    });
    expect(beforeState.cls).toBe('coarse');

    // Walk the camera up to the far island: the LOD controller should rebox
    // it into a fine slot (1.5 s hysteresis + rate limiting).
    await page.evaluate(() => (window as any).__vw.setView({ yawDeg: 0, pitchDeg: 15, dist: 12, target: [80, 2, 0] }));
    await step(page, 90); // 3 s
    const afterState = await page.evaluate(() => {
      const w = (window as any).__vw.world;
      const islands = w.scheduler.activeIslands().map((i: any) => ({
        cls: i.cls, slot: i.slot, reboxing: i.reboxing, fade: i.renderFade,
      }));
      return { islands, packets: w.packets.packets.length };
    });
    // Crossfade complete: exactly one island remains and it is fine-class.
    expect(afterState.islands.length).toBe(1);
    expect(afterState.islands[0].cls).toBe('fine');
    expect(afterState.islands[0].fade).toBe(1);
    // No packet round-trip was involved.
    expect(afterState.packets).toBe(beforeState.packets);

    // Mass survived the resample (tolerances cover dissipation + regridding).
    const after = await metrics(page);
    const afterIsland = after.islands.find((i) => i.origin[0] > 40)!;
    expect(afterIsland.massKg).toBeGreaterThan(beforeIsland.massKg * 0.75);
    expect(afterIsland.massKg).toBeLessThan(beforeIsland.massKg * 1.25);
  });
});
