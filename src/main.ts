import * as THREE from 'three/webgpu';
import { VolumetricWorld, type WorldMetrics } from './three/VolumetricWorld';
import { resolvePreset } from './core/presets';
import { buildEnvironment } from './demo/environment';
import { SCENES, sceneById, type SceneCtx } from './demo/scenes';
import { Hud } from './debug/hud';
import { Diag } from './debug/diag';
import { PerfRing, buildDebugReport, downloadReport } from './debug/report';
import { OrbitCamera } from './demo/orbitCamera';
import { FirstPersonCamera } from './demo/firstPerson';
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
  render(): Promise<void>;
  metrics(): Promise<WorldMetrics>;
  /** Mass (kg) inside a world-space AABB, summed from island coarse grids + packets. */
  massInRegion(min: Vec3, max: Vec3): Promise<number>;
  promoteAt(p: Vec3, r?: number): boolean;
  setDebugMode(m: number): void;
  /** Orbit-camera controller (inspection + scripted capture angles). */
  orbit: OrbitCamera;
  /** First-person controller (walk-through perspective). */
  fp: FirstPersonCamera;
  /** 'orbit' inspects from outside; 'fp' walks through the scene. */
  cameraMode: 'orbit' | 'fp';
  setCameraMode(mode: 'orbit' | 'fp'): void;
  /** Jump to an absolute orbit view; angles in degrees, distance in meters. */
  setView(view: { yawDeg?: number; pitchDeg?: number; dist?: number; target?: Vec3 }): void;
  /** Freeze/unfreeze the simulation while leaving the camera live. */
  setPaused(v: boolean): void;
  /** Build the same debug report the HUD button downloads (without saving). */
  debugReport(): Promise<Record<string, unknown>>;
  /** Exactly what the HUD button does: build the report and auto-download it. */
  downloadDebugReport(): Promise<void>;
}

const params = new URLSearchParams(location.search);
const sceneId = params.get('scene') ?? 'puff';
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const presetName = params.get('preset') ?? (isMobile ? 'low' : 'medium');
const testMode = params.get('test') === '1';
const autoMetrics = params.get('metrics') === '1' || testMode;
const diag = new Diag(params.get('diag') === '1');

/**
 * ?safe=1 — plain three.js scene with no volumetric engine at all.
 * Isolates "does three+WebGPU work in this browser" from engine issues.
 */
async function bootSafe(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  diag.attachDevice((renderer as any).backend?.device, 'safe mode (no engine)');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.5, 0.65, 0.85);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
  camera.position.set(8, 5, 10);
  camera.lookAt(0, 1, 0);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x8d8779 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: 0xb0603a }));
  box.position.y = 1;
  scene.add(box);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(20, 40, 10);
  scene.add(sun, new THREE.HemisphereLight(0x9db8dd, 0x5b5348, 1.2));
  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio, 1.5);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();
  const loop = (t: number): void => {
    requestAnimationFrame(loop);
    box.rotation.y = t / 1200;
    renderer.render(scene, camera);
  };
  window.__vwReady = true;
  document.getElementById('loading')?.remove();
  requestAnimationFrame(loop);
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  if (params.get('safe') === '1') {
    await bootSafe(canvas);
    return;
  }
  // ?temporal=0|1 forces the temporal accumulator on/off regardless of preset,
  // so CI (whose 'test' preset disables it) can still exercise that path.
  const temporalParam = params.get('temporal');
  const preset = temporalParam === null
    ? resolvePreset(presetName)
    : { ...resolvePreset(presetName), temporal: temporalParam === '1' };
  const world = await VolumetricWorld.create(canvas, {
    preset,
    metrics: autoMetrics,
    seed: Number(params.get('seed') ?? 7),
  });

  diag.attachDevice((world.renderer as any).backend?.device, world.gpuInfo + (world.softwareAdapter ? ' [software]' : ''));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
  const env = buildEnvironment(world, scene);
  const def = sceneById(sceneId);
  const ctx: SceneCtx = { env, world, scene, camera, state: {} };

  // SwiftShader/headless crashes on WebGPU canvas presentation — composite into
  // a readable target and blit through a 2D canvas instead.
  const readbackPresent = params.get('present') === 'readback' || world.softwareAdapter;
  let ctx2d: CanvasRenderingContext2D | null = null;
  if (readbackPresent) {
    world.pass.enableReadbackPresent();
    const shot = document.createElement('canvas');
    shot.id = 'shot';
    shot.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;';
    document.body.appendChild(shot);
    ctx2d = shot.getContext('2d');
  }
  // One blit in flight at a time: the RAF loop must never queue readbacks
  // faster than the GPU retires them, or the presented image falls further and
  // further behind the live camera (unbounded backlog, frozen-looking canvas).
  let blitBusy = false;
  const present = async (): Promise<void> => {
    if (!ctx2d || blitBusy) return;
    blitBusy = true;
    try {
      await world.pass.blitToCanvas2D(ctx2d);
    } finally {
      blitBusy = false;
    }
  };

  const resize = (): void => {
    // Bake DPR into the size passed to three (pixelRatio stays 1) so the
    // renderer's viewport, the canvas buffer, and our RTs always agree —
    // a manual canvas.width override broke presentation on DPR>1 displays.
    const dpr = testMode ? 1 : Math.min(window.devicePixelRatio, 1.5);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    world.renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    world.setSize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  def.setup(ctx);

  // Inspection camera. Scenes that animate the camera keep control until the
  // viewer grabs it; everything else starts under a slow auto-orbit so the
  // volumetrics show parallax and self-shadowing while the sim runs.
  const orbit = new OrbitCamera({
    enabled: !testMode && !def.animatesCamera,
    autoOrbit: params.get('autoOrbit') !== '0',
    autoSpeedRadPerS: Number(params.get('orbitSpeed') ?? 0.13),
  });
  orbit.captureFromCamera(camera, (ctx.state.camTarget as Vec3 | undefined) ?? [0, 1.5, 0]);
  if (!testMode) {
    orbit.onEngage = () => {
      ctx.state.userCamera = true;
      document.getElementById('cam-hint')?.classList.add('faded');
    };
    orbit.attach(canvas, camera);
    window.setTimeout(() => document.getElementById('cam-hint')?.classList.add('faded'), 9000);
  }

  // Opt-in walk-through rig. Only one controller drives the camera at a time;
  // each adopts the other's pose on switch so the view never jumps.
  const fp = new FirstPersonCamera({ groundY: world.groundY });
  let cameraMode: 'orbit' | 'fp' = params.get('fp') === '1' ? 'fp' : 'orbit';
  const setCameraMode = (mode: 'orbit' | 'fp'): void => {
    if (mode === cameraMode) return;
    cameraMode = mode;
    if (mode === 'fp') {
      orbit.enabled = false;
      fp.captureFromCamera(camera);
      fp.enabled = true;
    } else {
      fp.releaseLock();
      fp.enabled = false;
      // Pivot around whatever the walker was looking at, ~8 m ahead.
      const ahead = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(8).add(camera.position);
      ahead.y = Math.max(ahead.y, world.groundY + 0.5);
      orbit.enabled = true;
      orbit.captureFromCamera(camera, ahead);
    }
    document.body.classList.toggle('fp-mode', mode === 'fp');
  };
  if (cameraMode === 'fp') {
    orbit.enabled = false;
    fp.captureFromCamera(camera);
    fp.enabled = true;
    document.body.classList.add('fp-mode');
  }
  if (!testMode) {
    fp.attach(canvas);
    fp.onEngage = () => {
      ctx.state.userCamera = true;
      document.getElementById('cam-hint')?.classList.add('faded');
    };
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key.toLowerCase() === 'f') setCameraMode(cameraMode === 'fp' ? 'orbit' : 'fp');
    });
  }

  world.setCamera(camera);
  camera.updateMatrixWorld();

  let sceneTime = 0;
  // Pause driven from the test API; OR-ed with the HUD's own toggle below.
  let apiPaused = false;

  const perf = new PerfRing();
  const makeReport = async (): Promise<Record<string, unknown>> => {
    // Grab a JPEG of the current frame first (uses the readback path briefly),
    // then bundle state + metrics + perf + logs.
    let frameDataUrl: string | undefined;
    try {
      frameDataUrl = await world.captureFrame(scene, camera);
    } catch (e) {
      diag.log('report', `frame capture failed: ${String(e)}`);
    }
    return buildDebugReport(world, diag, {
      sceneId, presetName, perf, frameDataUrl,
      camera: {
        mode: cameraMode,
        position: camera.position.toArray().map((v) => +v.toFixed(2)),
        forward: camera.getWorldDirection(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)),
        fov: camera.fov,
        orbitDistance: +orbit.orbitDistance.toFixed(2),
        autoOrbit: orbit.autoOrbit,
        eyeHeightM: +fp.eyeHeight.toFixed(2),
      },
    });
  };
  const downloadDebugReport = async (): Promise<void> => downloadReport(await makeReport(), sceneId);

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
        const t0 = performance.now();
        world.stepAll(dt);
        perf.push({ dt: dt * 1000, updateMs: performance.now() - t0, renderMs: 0 });
      }
    },
    async render() {
      camera.updateMatrixWorld();
      world.render(scene, camera);
      await present();
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
    orbit,
    fp,
    get cameraMode() {
      return cameraMode;
    },
    setCameraMode,
    setView(view) {
      orbit.snapTo(camera, view);
      camera.updateMatrixWorld();
      world.setCamera(camera);
    },
    setPaused(v: boolean) {
      apiPaused = v;
    },
    debugReport: makeReport,
    downloadDebugReport,
  };
  window.__vw = api;

  if (testMode) {
    // Deterministic manual stepping only; a warm-up render compiles pipelines
    // (skippable for pure-simulation metric tests via norender=1).
    if (params.get('norender') !== '1') {
      world.render(scene, camera);
      await present();
    }
    window.__vwReady = true;
    document.getElementById('loading')?.remove();
    return;
  }

  const hud = new Hud(world, env, orbit, sceneId, presetName, downloadDebugReport, {
    get: () => cameraMode,
    set: setCameraMode,
    fp,
  });
  let last = performance.now();
  const loop = (): void => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const paused = hud.paused || apiPaused;
    if (!paused) {
      sceneTime += dt;
      def.tick?.(ctx, dt, sceneTime);
    }
    // The camera keeps moving even while the sim is paused, so a frozen moment
    // can be inspected from every side (or walked around).
    if (cameraMode === 'fp') fp.update(dt, camera);
    else orbit.update(dt, camera);
    camera.updateMatrixWorld();
    const t0 = performance.now();
    if (!paused) world.update(dt, camera);
    else world.setCamera(camera);
    const t1 = performance.now();
    world.render(scene, camera);
    void present();
    const t2 = performance.now();
    perf.push({ dt: dt * 1000, updateMs: t1 - t0, renderMs: t2 - t1 });
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
  el.style.cssText = 'position:fixed;inset:0;display:grid;place-content:center;z-index:40;' +
    'background:#f4ede2;color:#3a2c20;padding:32px;text-align:center;font-family:system-ui,sans-serif;';
  el.innerHTML = `<h2>WebGPU initialization failed</h2><p>${message}</p>
    <p>volumetric-world needs WebGPU (Chrome/Edge 121+ recommended; iOS Safari needs the WebGPU feature flag).
    On Linux, launch Chrome with <code>--enable-unsafe-webgpu --enable-features=Vulkan</code>.</p>
    <p>Add <code>?safe=1</code> to test plain three.js/WebGPU, or <code>?diag=1</code> for adapter details.</p>`;
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
