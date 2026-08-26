import { test, expect } from '@playwright/test';
import { openScene, step, metrics, gridStats } from './utils';

/**
 * Core solver physics on the "dense cold puff" benchmark scene:
 * mass bookkeeping, incompressibility, and the density-loading gravity current.
 */
test.describe('fluid core (puff)', () => {
  test('emits the requested dust mass and conserves it after the source ends', async ({ page }) => {
    await openScene(page, 'puff');
    // Emission lasts 0.55 s → fully emitted after 1 s.
    await step(page, 30);
    const m1 = await metrics(page);
    // 130 kg requested; profile compensation is approximate — expect same order.
    expect(m1.totalMassKg).toBeGreaterThan(60);
    expect(m1.totalMassKg).toBeLessThan(260);

    // Two more seconds: only dissipation (1.2%/s) and boundary export may
    // reduce the total (islands + packets combined).
    await step(page, 60);
    const m2 = await metrics(page);
    expect(m2.totalMassKg).toBeGreaterThan(m1.totalMassKg * 0.8);
    expect(m2.totalMassKg).toBeLessThan(m1.totalMassKg * 1.05);
  });

  test('pressure projection strongly reduces divergence', async ({ page }) => {
    await openScene(page, 'puff');
    await step(page, 12); // during emission: strong sources → divergence stress
    const m = await metrics(page);
    expect(m.divPreMax).toBeGreaterThan(0.05); // the test is meaningful
    expect(m.divPostMax).toBeLessThan(m.divPreMax * 0.25);
    expect(m.divPostMean).toBeLessThanOrEqual(m.divPreMean);
  });

  test('cold dust slumps and spreads as a ground-hugging gravity current', async ({ page }) => {
    await openScene(page, 'puff');
    await step(page, 24); // emission just done (t=0.8 s)
    const a = gridStats((await metrics(page)).islands[0]);
    await step(page, 66); // t = 3.0 s
    const b = gridStats((await metrics(page)).islands[0]);

    expect(a.mass).toBeGreaterThan(10);
    // Center of mass falls (negative dust-loading buoyancy)…
    expect(b.com[1]).toBeLessThan(a.com[1] - 0.15);
    // …and the cloud spreads laterally along the ground.
    expect(b.spreadXZ).toBeGreaterThan(a.spreadXZ * 1.25);
    // Ground plane holds: essentially no mass below y=0.
    const below = (await page.evaluate(() =>
      (window as any).__vw.massInRegion([-20, -10, -20], [20, -0.35, 20]),
    )) as number;
    expect(below).toBeLessThan(b.mass * 0.02);
  });
});
