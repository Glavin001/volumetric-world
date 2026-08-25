import * as THREE from 'three/webgpu';
import { VolumetricWorld, type WorldMetrics } from './three/VolumetricWorld';
import { buildEnvironment } from './demo/environment';
import { SCENES, sceneById, type SceneCtx } from './demo/scenes';
import { Hud } from './debug/hud';
import type { Vec3 } from './core/types';

declare global {
  interface Window {
    __vw?: TestApi;
    __vwError?: string;
    __vwReady?: boolean;
  }
}

interface TestApi {
  world: VolumetricWorld;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sceneId: string;
  /** Deterministic stepping: scene tick + every island + packets, n times. */
  step(dt: number, n?: number): void;
  render(): void;
  metrics(): Promise<WorldMetrics>;
  /** Mass (kg) inside a world-space AABB, summed from island coarse grids + packets. */
  massInRegion(min: Vec3, max: Vec3): Promise<number>;
  promoteAt(p: Vec3, r?: number): boolean;
  setDebugMode(m: number): void;
}

const params = new URLSearchParams(location.search);
const sceneId = params.get('scene') ?? 'puff';
const presetName = params.get('preset') ?? 'medium';
const testMode = params.get('test') === '1';
const autoMetrics = params.get('metrics') === '1' || testMode;

async function boot(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const world = await VolumetricWorld.create(canvas, {
    preset: presetName,
    metrics: autoMetrics,
    seed: Number(params.get('seed') ?? 7),
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
  const env = buildEnvironment(world, scene);
  const def = sceneById(sceneId);
  const ctx: SceneCtx = { env, world, scene, camera, state: {} };

  const resize = (): void => {
    const dpr = testMode ? 1 : Math.min(window.devicePixelRatio, 1.5);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    world.renderer.setSize(window.innerWidth, window.innerHeight, false);
    canvas.width = w;
    canvas.height = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    world.setSize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  def.setup(ctx);
  world.setCamera(camera);
  camera.updateMatrixWorld();

  let sceneTime = 0;

  const api: TestApi = {
    world,
    scene,
    camera,
    sceneId,
    step(dt: number, n = 1) {
      for (let i = 0; i < n; i++) {
        sceneTime += dt;
        def.tick?.(ctx, dt, sceneTime);
        camera.updateMatrixWorld();
        world.setCamera(camera);
        world.stepAll(dt);
      }
    },
    render() {
      camera.updateMatrixWorld();
      world.render(scene, camera);
    },
    metrics: () => world.metrics(),
    async massInRegion(min: Vec3, max: Vec3): Promise<number> {
      const m = await world.metrics();
      let total = 0;
      for (const island of m.islands) {
        const c = 16;
        const cell = island.sizeM / c;
        for (let z = 0; z < c; z++) {
          for (let y = 0; y < c; y++) {
            for (let x = 0; x < c; x++) {
              const i = (x + y * c + z * c * c) * 4;
              const mass = island.coarse[i];
              if (mass <= 0) continue;
              const wx = island.origin[0] + (x + 0.5) * cell;
              const wy = island.origin[1] + (y + 0.5) * cell;
              const wz = island.origin[2] + (z + 0.5) * cell;
              if (wx >= min[0] && wx <= max[0] && wy >= min[1] && wy <= max[1] && wz >= min[2] && wz <= max[2]) {
                total += mass;
              }
            }
          }
        }
      }
      for (const p of world.packets.packets) {
        if (
          p.position[0] >= min[0] && p.position[0] <= max[0] &&
          p.position[1] >= min[1] && p.position[1] <= max[1] &&
          p.position[2] >= min[2] && p.position[2] <= max[2]
        ) {
          total += p.massKg;
        }
      }
      return total;
    },
    promoteAt: (p, r) => world.promoteAt(p, r),
    setDebugMode(m: number) {
      (world.pass.debugMode as { value: number }).value = m;
    },
  };
  window.__vw = api;

  if (testMode) {
    // Deterministic manual stepping only; a single warm-up render compiles pipelines.
    world.render(scene, camera);
    window.__vwReady = true;
    document.getElementById('loading')?.remove();
    return;
  }

  const hud = new Hud(world, env, sceneId, presetName);
  let last = performance.now();
  const loop = (): void => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!hud.paused) {
      sceneTime += dt;
      def.tick?.(ctx, dt, sceneTime);
      camera.updateMatrixWorld();
      world.update(dt, camera);
    }
    world.render(scene, camera);
    hud.update();
  };
  window.__vwReady = true;
  document.getElementById('loading')?.remove();
  loop();
}

function showError(message: string): void {
  window.__vwError = message;
  const el = document.createElement('div');
  el.id = 'vw-error';
  el.innerHTML = `<h2>WebGPU required</h2><p>${message}</p>
    <p>volumetric-world needs WebGPU (Chrome/Edge 121+ on a desktop GPU).
    On Linux, launch Chrome with <code>--enable-unsafe-webgpu --enable-features=Vulkan</code>.</p>`;
  document.body.appendChild(el);
  document.getElementById('loading')?.remove();
}

boot().catch((e) => {
  console.error(e);
  showError(String(e?.message ?? e));
});

// Gallery footer: quick links to every scene.
const nav = document.getElementById('nav');
if (nav) {
  for (const s of SCENES) {
    const a = document.createElement('a');
    const p = new URLSearchParams(location.search);
    p.set('scene', s.id);
    a.href = `?${p.toString()}`;
    a.textContent = s.id;
    a.title = `${s.title} — ${s.what}`;
    if (s.id === sceneId) a.className = 'active';
    nav.appendChild(a);
  }
}
