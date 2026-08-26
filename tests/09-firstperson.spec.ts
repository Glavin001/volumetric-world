import { test, expect } from '@playwright/test';
import { openScene, step, render } from './utils';

/** Opt-in walk-through camera: movement, look, and handover with the orbit rig. */
test.describe('first-person camera', () => {
  test('walks along its heading and keeps a walking eye height', async ({ page }) => {
    await openScene(page, 'puff');
    const r = await page.evaluate(() => {
      const api = (window as any).__vw;
      api.setCameraMode('fp');
      api.fp.snapTo(api.camera, { position: [0, 1.7, 18], yawDeg: 180, pitchDeg: 0 });
      const start = api.camera.position.clone();
      // Hold "w" for a second of frames.
      (api.fp as any).keys.add('w');
      for (let i = 0; i < 60; i++) api.fp.update(1 / 60, api.camera);
      (api.fp as any).keys.clear();
      const end = api.camera.position.clone();
      const dir = api.camera.getWorldDirection(new (start.constructor as any)());
      return {
        moved: end.distanceTo(start),
        dz: end.z - start.z,
        dx: Math.abs(end.x - start.x),
        eye: end.y,
        forwardZ: dir.z,
      };
    });
    // yaw 180 faces +z; walking forward must travel that way, not sideways.
    expect(r.forwardZ).toBeGreaterThan(0.9);
    expect(r.moved).toBeGreaterThan(2.5);
    expect(r.dz).toBeGreaterThan(2.5);
    expect(r.dx).toBeLessThan(0.2);
    expect(r.eye).toBeCloseTo(1.7, 1);
  });

  test('mouse-look turns the view without moving the walker', async ({ page }) => {
    await openScene(page, 'puff');
    const r = await page.evaluate(() => {
      const api = (window as any).__vw;
      api.setCameraMode('fp');
      api.fp.snapTo(api.camera, { position: [2, 1.7, 10], yawDeg: 0, pitchDeg: 0 });
      const before = api.camera.getWorldDirection(new (api.camera.position.constructor as any)()).clone();
      const pos = api.camera.position.clone();
      (api.fp as any).look(300, 60); // drag right and down
      api.fp.update(1 / 60, api.camera);
      const after = api.camera.getWorldDirection(new (api.camera.position.constructor as any)()).clone();
      return {
        turnedRad: before.angleTo(after),
        pitch: api.fp.pitch,
        drift: api.camera.position.distanceTo(pos),
      };
    });
    expect(r.turnedRad).toBeGreaterThan(0.3);
    expect(r.pitch).toBeLessThan(0); // dragging down looks down
    expect(r.drift).toBeLessThan(1e-6);
  });

  test('switching modes hands the pose over without jumping the view', async ({ page }) => {
    await openScene(page, 'puff');
    const r = await page.evaluate(() => {
      const api = (window as any).__vw;
      const V = api.camera.position.constructor as any;
      api.setCameraMode('fp');
      api.fp.snapTo(api.camera, { position: [3, 1.7, 9], yawDeg: 20, pitchDeg: -5 });
      const posFp = api.camera.position.clone();
      const dirFp = api.camera.getWorldDirection(new V()).clone();

      api.setCameraMode('orbit');
      api.orbit.update(0, api.camera);
      const posOrbit = api.camera.position.clone();
      const dirOrbit = api.camera.getWorldDirection(new V()).clone();
      return {
        mode: api.cameraMode,
        posShift: posFp.distanceTo(posOrbit),
        dirShift: dirFp.angleTo(dirOrbit),
      };
    });
    expect(r.mode).toBe('orbit');
    expect(r.posShift, 'position is preserved on handover').toBeLessThan(0.05);
    expect(r.dirShift, 'view direction is preserved on handover').toBeLessThan(0.05);
  });

  test('standing inside the plume renders participating media', async ({ page }) => {
    await openScene(page, 'puff', { render: true });
    await step(page, 45);
    await page.evaluate(() => {
      const api = (window as any).__vw;
      api.setCameraMode('fp');
      api.fp.snapTo(api.camera, { position: [0, 1.2, 0], yawDeg: 0, pitchDeg: 0 });
    });
    await render(page);
    const coverage = await page.evaluate(() => {
      const c = document.getElementById('shot') as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      const { width: w, height: h } = c;
      const d = ctx.getImageData(0, 0, w, h).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 120) bright++;
      return bright / (w * h);
    });
    expect(coverage, 'the walker is inside the dust, so most of the view is dust').toBeGreaterThan(0.5);
  });
});
