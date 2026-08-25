import GUI from 'lil-gui';
import type { VolumetricWorld } from '../three/VolumetricWorld';
import type { EnvCtx } from '../demo/environment';
import { setSunAngles } from '../demo/environment';
import { SCENES } from '../demo/scenes';
import { PRESETS } from '../core/presets';

/** Stats overlay + tuning panel. */
export class Hud {
  private statsEl: HTMLDivElement;
  private gui: GUI;
  private frames = 0;
  private lastFpsAt = performance.now();
  private fps = 0;
  private controls = {
    sunElevation: 40,
    sunAzimuth: 130,
    windX: 0,
    windZ: 0,
    detail: 0.75,
    exposure: 0.55,
    dustShadow: 0.85,
    debugDistance: false,
    paused: false,
  };

  constructor(
    private world: VolumetricWorld,
    private env: EnvCtx,
    sceneId: string,
    presetName: string,
  ) {
    this.statsEl = document.createElement('div');
    this.statsEl.id = 'vw-stats';
    document.body.appendChild(this.statsEl);

    const c = this.controls;
    c.windX = world.wind[0];
    c.windZ = world.wind[2];
    this.gui = new GUI({ title: 'volumetric-world' });
    this.gui
      .add({ scene: sceneId }, 'scene', SCENES.map((s) => s.id))
      .onChange((v: string) => this.reload({ scene: v }));
    this.gui
      .add({ preset: presetName }, 'preset', Object.keys(PRESETS))
      .onChange((v: string) => this.reload({ preset: v }));
    const sun = this.gui.addFolder('sun');
    sun.add(c, 'sunElevation', 4, 80, 1).onChange(() => setSunAngles(env, c.sunElevation, c.sunAzimuth));
    sun.add(c, 'sunAzimuth', 0, 360, 1).onChange(() => setSunAngles(env, c.sunElevation, c.sunAzimuth));
    const flow = this.gui.addFolder('flow');
    flow.add(c, 'windX', -6, 6, 0.1).onChange(() => world.setWind([c.windX, 0, c.windZ]));
    flow.add(c, 'windZ', -6, 6, 0.1).onChange(() => world.setWind([c.windX, 0, c.windZ]));
    const look = this.gui.addFolder('render');
    look.add(c, 'detail', 0, 1.2, 0.05).onChange((v: number) => ((world.pass.detailStrength as { value: number }).value = v));
    look.add(c, 'exposure', 0.1, 1.6, 0.05).onChange((v: number) => ((world.pass.exposure as { value: number }).value = v));
    look.add(c, 'dustShadow', 0, 1, 0.05).onChange((v: number) => ((world.pass.dustShadowStrength as { value: number }).value = v));
    look.add(c, 'debugDistance').onChange((v: boolean) => ((world.pass.debugMode as { value: number }).value = v ? 1 : 0));
    this.gui.add(c, 'paused');
  }

  get paused(): boolean {
    return this.controls.paused;
  }

  private reload(overrides: Record<string, string>): void {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(overrides)) p.set(k, v);
    location.search = p.toString();
  }

  update(): void {
    this.frames++;
    const now = performance.now();
    if (now - this.lastFpsAt > 500) {
      this.fps = (this.frames * 1000) / (now - this.lastFpsAt);
      this.frames = 0;
      this.lastFpsAt = now;

      const w = this.world;
      const islands = w.scheduler
        .activeIslands()
        .map(
          (i) =>
            `  slot${i.slot} ${i.tier} ${i.rateHz}Hz ~${i.estimatedMassKg.toFixed(0)}kg imp=${i.importance.toFixed(3)}${i.retiring ? ' retiring' : ''}`,
        )
        .join('\n');
      this.statsEl.textContent =
        `${this.fps.toFixed(0)} fps | sim ${w.simTime.toFixed(1)}s | gpu ${w.scheduler.gpuMsAverage.toFixed(2)}ms | q=${w.scheduler.qualityScale.toFixed(2)}\n` +
        `islands ${w.scheduler.activeIslands().length}/${w.preset.slots}\n${islands}\n` +
        `packets ${w.packets.packets.length} (~${w.packets.totalMass().toFixed(0)}kg)`;
    }
  }
}
