/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import type {
  ColliderShape, DynamicBodySample, EngineOptions, FlowEffector, MediumEmissionEvent,
  StaticCollider, Vec3,
} from '../core/types';
import { resolvePreset } from '../core/presets';
import { getMaterial } from '../core/materials';
import { add, len, lerp3, norm, scale, sub } from '../core/math';
import { PacketSystem, packetsFromCoarseGrid, type VolumePacket } from '../core/packets';
import { IslandScheduler, type IslandState, type CameraInfo } from '../core/scheduler';
import { SolverEngine, IslandGPU } from '../webgpu/engine';
import { COARSE } from '../webgpu/outputKernels';
import {
  ActiveEmission, ActiveEffector, WorldPrim, activateEmission, effectorDuration, flattenShape,
  packEffectors, packEvents, packPrims, packPromo, primFromBody, sourceBoundR, sourceCenter,
} from '../webgpu/packing';
import { MAX_PROMO } from '../webgpu/uniforms';
import { VolumetricPass, MAX_ISLANDS, ISLE_STRIDE, PKT_STRIDE } from './volumetricPass';
import { QID } from '../core/math';
import type { AerosolMaterial, QualityPreset } from '../core/types';

export interface IslandMetrics {
  slot: number;
  massKg: number;
  comWorld: Vec3;
  /** Coarse 16³ mass grid (vec4 per cell) in island-local meters. */
  coarse: Float32Array;
  origin: Vec3;
  sizeM: number;
  tier: string;
  rateHz: number;
}

export interface WorldMetrics {
  simTimeS: number;
  islands: IslandMetrics[];
  islandMassKg: number;
  packetCount: number;
  packetMassKg: number;
  totalMassKg: number;
  /** Mean |divergence| per fluid cell before/after projection (last metric step). */
  divPreMean: number;
  divPostMean: number;
  divPreMax: number;
  divPostMax: number;
  gpuMsAverage: number;
  qualityScale: number;
  activeIslands: number;
}

interface RetireJob {
  island: IslandState;
  phase: 'readback' | 'fading';
  fadeEnd: number;
}

/**
 * VolumetricWorld — the public facade. Owns the island scheduler, the GPU
 * solver pool, the far-field packet system, and the volumetric render pass.
 */
export class VolumetricWorld {
  readonly renderer: THREE.WebGPURenderer;
  /** True when running on a software WebGPU adapter (SwiftShader/llvmpipe). */
  softwareAdapter = false;
  /** Adapter description string for diagnostics overlays. */
  gpuInfo = 'unknown adapter';
  readonly preset: QualityPreset;
  readonly engine: SolverEngine;
  readonly pass: VolumetricPass;
  readonly scheduler: IslandScheduler;
  readonly packets: PacketSystem;

  simTime = 0;
  wind: Vec3 = [0, 0, 0];
  groundY = 0;
  groundEnabled = true;
  metricsEnabled: boolean;

  /** Direction TO the sun (normalized) + radiometric-ish intensities. */
  sun = {
    dir: [0.45, 0.62, 0.35] as Vec3,
    color: new THREE.Color(1.0, 0.95, 0.88),
    intensity: 30,
    sky: new THREE.Color(0.4, 0.58, 0.85),
    skyIntensity: 1.8,
  };

  private shapes = new Map<number, ColliderShape>();
  private statics: StaticCollider[] = [];
  private bodies = new Map<number, DynamicBodySample>();
  private emissions: ActiveEmission[] = [];
  private effectors: ActiveEffector[] = [];
  private islandMaterial = new Map<number, AerosolMaterial>();
  private retireJobs: RetireJob[] = [];
  private readbackChain: Promise<unknown> = Promise.resolve();
  private lastPacketUpdate = 0;
  private lastPromoteCheck = 0;
  private promoteCooldownUntil = 0;
  private lastDivStats = { preMean: 0, postMean: 0, preMax: 0, postMax: 0 };
  private massPollAt = new Map<number, number>();
  private lastDivPollAt = -1;
  private divPollPending = false;

  private constructor(renderer: THREE.WebGPURenderer, opts: EngineOptions) {
    this.renderer = renderer;
    this.preset = resolvePreset(opts.preset);
    this.metricsEnabled = opts.metrics ?? false;
    if (opts.windMps) this.wind = opts.windMps;
    this.engine = new SolverEngine(renderer, this.preset);
    this.scheduler = new IslandScheduler({ preset: this.preset, gpuBudgetMs: opts.gpuBudgetMs ?? 3.0 });
    this.packets = new PacketSystem({ maxPackets: 128, seed: opts.seed ?? 7, groundY: this.groundY });
    this.pass = new VolumetricPass(renderer, this.engine.atlas, {
      renderScale: this.preset.renderScale,
      maxRenderPackets: this.preset.maxRenderPackets,
      temporal: this.preset.temporal,
    });
    (this.pass.raySteps as any).value = this.preset.raySteps;
  }

  static async create(canvas: HTMLCanvasElement, opts: EngineOptions = {}): Promise<VolumetricWorld> {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU is not available in this browser (volumetric-world requires WebGPU).');
    }
    // Software adapters (SwiftShader) never complete timestamp-query readbacks,
    // and one stuck mapAsync blocks every later buffer callback (FIFO delivery) —
    // so GPU timings are only tracked on real hardware.
    const probeAdapter = await (navigator as any).gpu.requestAdapter();
    if (!probeAdapter) {
      throw new Error('navigator.gpu.requestAdapter() returned null — WebGPU is present but no adapter is available.');
    }
    const info = probeAdapter?.info ?? {};
    const arch = info.architecture ?? '';
    const softwareAdapter = /swiftshader|llvmpipe|software/i.test(arch);
    const gpuInfo =
      `${info.vendor ?? '?'} ${arch || '?'} ${info.description ?? ''} | ` +
      `storageBufs=${probeAdapter.limits?.maxStorageBuffersPerShaderStage ?? '?'} ` +
      `storageTex=${probeAdapter.limits?.maxStorageTexturesPerShaderStage ?? '?'} ` +
      `sampled=${probeAdapter.limits?.maxSampledTexturesPerShaderStage ?? '?'}`;
    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      trackTimestamp: !softwareAdapter,
      forceWebGL: false,
    });
    await renderer.init();
    const backend = (renderer as any).backend;
    if (!backend?.isWebGPUBackend) {
      throw new Error('three.js fell back to WebGL — the compute solver requires the WebGPU backend.');
    }
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const world = new VolumetricWorld(renderer, opts);
    world.softwareAdapter = softwareAdapter;
    world.gpuInfo = gpuInfo;
    return world;
  }

  // ------------------------------------------------------------------
  // Physics contract
  // ------------------------------------------------------------------

  registerShape(shapeId: number, shape: ColliderShape): void {
    this.shapes.set(shapeId, shape);
  }

  addStaticCollider(c: StaticCollider): void {
    this.statics.push(c);
  }

  removeStaticCollider(colliderId: number): void {
    this.statics = this.statics.filter((c) => c.colliderId !== colliderId);
  }

  clearStaticColliders(): void {
    this.statics.length = 0;
  }

  /** Stream a dynamic body sample (call every physics tick for moving bodies). */
  updateBody(sample: DynamicBodySample): void {
    const prev = this.bodies.get(sample.bodyId);
    if (prev && !sample.previousTransform) {
      (sample as any).previousTransform = prev.transform;
    }
    this.bodies.set(sample.bodyId, sample);
    for (const island of this.scheduler.activeIslands()) {
      const d = len(sub(sample.transform.positionM, island.center));
      if (d < island.sizeM * 0.75 && len(sample.linearVelocityMps) > 0.5) {
        island.interactionCount = Math.min(island.interactionCount + 1, 4);
        island.lastEventAt = Math.max(island.lastEventAt, this.simTime - 1);
      }
    }
  }

  removeBody(bodyId: number): void {
    this.bodies.delete(bodyId);
  }

  /** Emit dust/smoke. Routes to a covering island, spawns one, or falls back to packets. */
  emit(ev: MediumEmissionEvent): void {
    const material = getMaterial(ev.materialId);
    const em = activateEmission(ev, material);
    this.emissions.push(em);

    const center0 = sourceCenter(ev.source);
    // Directional sources get their island biased downstream so the flow stays
    // covered (islands spawn around the interaction region, not just the source).
    let center = center0;
    if (ev.momentum.kind === 'uniform') {
      const v = ev.momentum.initialVelocityMps;
      const speed = len(v);
      if (speed > 2) {
        const tier0 = this.scheduler.tierFor(center0, ev.fineMassKg, this.cameraInfo);
        const size = this.preset.tierSizeM[tier0];
        center = add(center0, scale(norm(v), size * 0.22));
      }
    }
    const camera = this.cameraInfo;
    let island = this.scheduler.findCovering(center0, -0.5);
    if (!island) {
      const tier = this.scheduler.tierFor(center, ev.fineMassKg, camera);
      island = this.scheduler.allocate({ center: this.islandCenterFor(center, tier), tier, reason: 'event' }, this.simTime, camera);
      if (island) {
        this.configureIslandPlacement(island);
        this.gpuFor(island).reset();
        this.islandMaterial.set(island.slot, material);
      }
    }
    if (island) {
      island.lastEventAt = this.simTime;
      island.estimatedMassKg += ev.fineMassKg;
      this.islandMaterial.set(island.slot, material);
      // Track emission focus for scrolling.
      island.focus = lerp3(island.focus, center, 0.35) as [number, number, number];
    } else {
      // Pool exhausted: represent the event directly as far-field packets.
      const r = sourceBoundR(ev.source);
      let vel: Vec3 = [...this.wind] as Vec3;
      if (ev.momentum.kind === 'uniform') vel = ev.momentum.initialVelocityMps;
      else if (ev.momentum.kind === 'body') {
        const b = this.bodies.get(ev.momentum.bodyId);
        if (b) vel = scale(b.linearVelocityMps, ev.momentum.transferScale);
      }
      this.packets.spawnFromMaterial(material, center, [r, r * 0.8, r], ev.fineMassKg, vel, ev.seed, 0.15);
    }
  }

  addEffector(e: FlowEffector): void {
    this.effectors.push({ eff: e, startTime: this.simTime, endTime: this.simTime + effectorDuration(e) });
    // Effectors also stir far-field packets (approximate, position-only kinds).
    if (e.kind === 'jet') {
      this.packets.applyWake({
        from: e.startM,
        to: add(e.startM, scale(e.direction, e.radiusM * 6)),
        radiusM: e.radiusM * 1.5,
        velocityMps: scale(e.direction, e.speedMps * 0.5),
        couple: 0.5,
      });
    }
  }

  setWind(w: Vec3): void {
    this.wind = w;
  }

  /**
   * Translucency: extinction multiplier used ONLY by the self-shadow paths
   * (island sun caches + packet analytic shadows). Lower = softer, more
   * layered light penetration; 1 = physically matched to the primary march.
   */
  setTranslucency(shadowDensity: number): void {
    const v = Math.max(0.05, Math.min(1.5, shadowDensity));
    (this.pass.shadowDensity as any).value = v;
    for (const gpu of this.engine.islands) {
      (gpu.uni.shadowDensity as any).value = v;
    }
  }

  // ------------------------------------------------------------------
  // Frame update
  // ------------------------------------------------------------------

  private cameraInfo: CameraInfo = { position: [0, 2, 10], forward: [0, 0, -1] };

  setCamera(camera: THREE.PerspectiveCamera): void {
    const p = camera.getWorldPosition(new THREE.Vector3());
    const f = camera.getWorldDirection(new THREE.Vector3());
    this.cameraInfo = { position: [p.x, p.y, p.z], forward: [f.x, f.y, f.z] };
  }

  /** Real-time update: staggered island stepping at tier rates (call once per frame). */
  update(dtS: number, camera: THREE.PerspectiveCamera): void {
    const dt = Math.min(dtS, 0.1);
    this.simTime += dt;
    this.setCamera(camera);
    this.scheduler.updateImportance(this.simTime, this.cameraInfo);
    this.beginRetirements();

    const due = this.scheduler.dueIslands(this.simTime, 2);
    for (const island of due) {
      this.stepIsland(island, 1 / island.rateHz);
      this.scheduler.markStepped(island, this.simTime);
    }

    this.commonUpdate(dt);
  }

  /** Deterministic update for tests: every active island steps exactly once with dt. */
  stepAll(dt: number): void {
    this.simTime += dt;
    this.scheduler.updateImportance(this.simTime, this.cameraInfo);
    this.beginRetirements();
    for (const island of this.scheduler.activeIslands()) {
      if (!island.retiring) {
        this.stepIsland(island, dt);
        island.lastStepAt = this.simTime;
        island.stepCount++;
      }
    }
    this.commonUpdate(dt, true);
  }

  private commonUpdate(dt: number, force = false): void {
    // Far-field packets at ~10 Hz.
    if (force || this.simTime - this.lastPacketUpdate >= 0.1) {
      const pdt = force ? dt : Math.min(this.simTime - this.lastPacketUpdate, 0.25);
      this.lastPacketUpdate = this.simTime;
      this.applyBodyWakesToPackets(pdt);
      this.packets.update(pdt, this.wind);
    }

    // Retire fades → free slots.
    for (const job of [...this.retireJobs]) {
      if (job.phase === 'fading') {
        const island = job.island;
        island.renderFade = Math.max(0, (job.fadeEnd - this.simTime) / 0.35);
        if (this.simTime >= job.fadeEnd) {
          this.gpuFor(island).reset();
          this.scheduler.free(island);
          this.retireJobs.splice(this.retireJobs.indexOf(job), 1);
        }
      }
    }

    // Packet→grid promotion checks (2 Hz).
    if (this.simTime - this.lastPromoteCheck > 0.5) {
      this.lastPromoteCheck = this.simTime;
      this.autoPromote();
    }

    // Expired emissions/effectors cleanup.
    this.emissions = this.emissions.filter((e) => this.simTime < e.endTime + 0.5);
    this.effectors = this.effectors.filter((e) => this.simTime < e.endTime + 0.5);
  }

  private islandCenterFor(eventCenter: Vec3, tier: 'small' | 'medium' | 'hero'): Vec3 {
    const size = this.preset.tierSizeM[tier];
    return [eventCenter[0], Math.max(eventCenter[1], this.groundY + size * 0.32), eventCenter[2]];
  }

  private configureIslandPlacement(island: IslandState): void {
    const gpu = this.gpuFor(island);
    const h = island.sizeM / this.preset.slotRes;
    (gpu.uni.origin.value as THREE.Vector3).set(island.origin[0], island.origin[1], island.origin[2]);
    (gpu.uni.h as any).value = h;
    (gpu.uni.invH as any).value = 1 / h;
    (gpu.uni.sizeM as any).value = island.sizeM;
  }

  private gpuFor(island: IslandState): IslandGPU {
    return this.engine.islands[island.slot];
  }

  private buildPrimList(island: IslandState): WorldPrim[] {
    const out: WorldPrim[] = [];
    if (this.groundEnabled) {
      out.push({
        kind: 1,
        solid: true,
        wakeEnabled: false,
        wakeScale: 0,
        dragCoef: 0,
        pos: [island.center[0], this.groundY - 50, island.center[2]],
        prevPos: [island.center[0], this.groundY - 50, island.center[2]],
        quat: QID,
        params: [400, 50, 400, 0],
        linVel: [0, 0, 0],
        angVel: [0, 0, 0],
        boundR: 1e6,
      });
    }
    for (const c of this.statics) {
      const shape = this.shapes.get(c.shapeId);
      if (!shape) continue;
      flattenShape(shape, this.shapes, c.transform, c.transform, [0, 0, 0], [0, 0, 0], true,
        { enabled: false, wakeScale: 0, dragCoef: 0 }, out);
    }
    for (const b of this.bodies.values()) {
      primFromBody(b, this.shapes, out);
    }
    return out;
  }

  private stepIsland(island: IslandState, dt: number): void {
    const gpu = this.gpuFor(island);
    const uni = gpu.uni;
    const material = this.islandMaterial.get(island.slot) ?? getMaterial('concrete');

    // --- scrolling: follow the tracked focus in integer voxel increments ---
    const h = island.sizeM / this.preset.slotRes;
    const drift = sub(island.focus, island.center);
    const driftLen = len([drift[0], 0, drift[2]]);
    if (driftLen > island.sizeM * 0.16) {
      const shift: [number, number, number] = [
        Math.round(drift[0] / h),
        0,
        Math.round(drift[2] / h),
      ];
      const maxShift = Math.floor(this.preset.slotRes / 4);
      shift[0] = Math.max(-maxShift, Math.min(maxShift, shift[0]));
      shift[2] = Math.max(-maxShift, Math.min(maxShift, shift[2]));
      if (shift[0] !== 0 || shift[2] !== 0) {
        (uni.shiftVox.value as THREE.Vector3).set(shift[0], shift[1], shift[2]);
        gpu.scroll();
        island.origin[0] += shift[0] * h;
        island.origin[2] += shift[2] * h;
        island.center[0] += shift[0] * h;
        island.center[2] += shift[2] * h;
        this.configureIslandPlacement(island);
      }
    }

    // --- pack per-step uniforms ---
    const bmin: Vec3 = [...island.origin] as Vec3;
    const bmax: Vec3 = [island.origin[0] + island.sizeM, island.origin[1] + island.sizeM, island.origin[2] + island.sizeM];
    packPrims(uni, this.buildPrimList(island), bmin, bmax);
    packEvents(uni, this.overlappingEmissions(bmin, bmax), this.simTime, (id) => this.bodies.get(id)?.linearVelocityMps);
    packEffectors(uni, this.effectors, this.simTime, dt);

    (uni.dt as any).value = dt;
    (uni.timeS as any).value = this.simTime;
    (uni.wind.value as THREE.Vector3).set(this.wind[0], this.wind[1], this.wind[2]);
    (uni.buoyK as any).value = material.loadingScale;
    (uni.dissFactor as any).value = Math.exp(-material.dissipationPerSecond * dt);
    (uni.settleMps as any).value = material.coarseSettlingSpeedMps * material.coarseMassFraction * 0.2;
    (uni.sunDir.value as THREE.Vector3).set(this.sun.dir[0], this.sun.dir[1], this.sun.dir[2]);

    const light = this.scheduler.lightDue(island, this.simTime);
    if (light) island.lastLightAt = this.simTime;
    gpu.step({ light, metrics: this.metricsEnabled });
    island.estimatedMassKg *= Math.exp(-material.dissipationPerSecond * dt);
    if (this.metricsEnabled) this.pollDivStats();

    // Decay interaction counter.
    island.interactionCount = Math.max(0, island.interactionCount - 1);

    // Periodic boundary export + mass poll.
    const pollDue = (this.massPollAt.get(island.slot) ?? 0) <= this.simTime;
    if (pollDue) {
      this.massPollAt.set(island.slot, this.simTime + 0.7);
      this.pollIslandMass(island);
    }
  }

  private overlappingEmissions(bmin: Vec3, bmax: Vec3): ActiveEmission[] {
    return this.emissions.filter((em) => {
      const c = sourceCenter(em.ev.source);
      const r = sourceBoundR(em.ev.source) + 0.5;
      return (
        c[0] + r > bmin[0] && c[0] - r < bmax[0] &&
        c[1] + r > bmin[1] && c[1] - r < bmax[1] &&
        c[2] + r > bmin[2] && c[2] - r < bmax[2]
      );
    });
  }

  private pollDivStats(): void {
    // Rate-limit: readback callbacks resolve in FIFO order, so flooding the
    // chain (e.g. one poll per step) starves export/retirement readbacks.
    if (this.divPollPending || this.simTime - this.lastDivPollAt < 0.35) return;
    this.divPollPending = true;
    this.lastDivPollAt = this.simTime;
    this.enqueueReadback(async () => {
      const pre = await this.engine.readField(this.engine.scratch.coarseDivPre);
      const post = await this.engine.readField(this.engine.scratch.coarseDivPost);
      let sPre = 0, sPost = 0, nPre = 0, nPost = 0, mPre = 0, mPost = 0;
      for (let i = 0; i < pre.length; i += 4) {
        sPre += pre[i];
        mPre = Math.max(mPre, pre[i + 1]);
        nPre += pre[i + 2];
        sPost += post[i];
        mPost = Math.max(mPost, post[i + 1]);
        nPost += post[i + 2];
      }
      this.lastDivStats = {
        preMean: nPre > 0 ? sPre / nPre : 0,
        postMean: nPost > 0 ? sPost / nPost : 0,
        preMax: mPre,
        postMax: mPost,
      };
      this.divPollPending = false;
    });
  }

  /** Read the island's coarse mass grid; update estimates and export the boundary shell to packets. */
  private pollIslandMass(island: IslandState): void {
    const gpu = this.gpuFor(island);
    this.enqueueReadback(async () => {
      if (!island.active) return;
      gpu.computeMassGrid();
      const grid = await this.engine.readField(this.engine.scratch.coarseMass);
      let mass = 0;
      for (let i = 0; i < grid.length; i += 4) mass += grid[i];
      island.massKg = mass;
      island.estimatedMassKg = mass;

      // Boundary export: mass in the outer coarse ring becomes far-field packets.
      let shellMass = 0;
      const shellCells: Vec3[] = [];
      const c = COARSE;
      for (let z = 0; z < c; z++) {
        for (let y = 0; y < c; y++) {
          for (let x = 0; x < c; x++) {
            if (x > 0 && x < c - 1 && y > 0 && y < c - 1 && z > 0 && z < c - 1) continue;
            const i = (x + y * c + z * c * c) * 4;
            shellMass += grid[i];
            if (grid[i] > 0.02) shellCells.push([grid[i], i, 0]);
          }
        }
      }
      const exportThreshold = Math.max(0.4, mass * 0.015);
      if (shellMass > exportThreshold && shellCells.length > 0) {
        const material = this.islandMaterial.get(island.slot) ?? getMaterial('concrete');
        // Moment-match the shell mass into a handful of packets by octant.
        const shellGrid = new Float32Array(grid.length);
        for (let z = 0; z < c; z++) {
          for (let y = 0; y < c; y++) {
            for (let x = 0; x < c; x++) {
              const i = (x + y * c + z * c * c) * 4;
              const isShell = !(x > 0 && x < c - 1 && y > 0 && y < c - 1 && z > 0 && z < c - 1);
              if (isShell) {
                shellGrid[i] = grid[i];
                shellGrid[i + 1] = grid[i + 1];
                shellGrid[i + 2] = grid[i + 2];
                shellGrid[i + 3] = grid[i + 3];
              }
            }
          }
        }
        const protos = packetsFromCoarseGrid(shellGrid, c, island.origin, island.sizeM, 0.05);
        for (const p of protos) {
          this.packets.spawnFromMaterial(material, p.position, p.radii, p.massKg, [...this.wind] as Vec3, island.slot, 0.35);
        }
        gpu.clearShell(0, this.preset.slotRes / COARSE);
        island.lastExportAt = this.simTime;
      }
    });
  }

  private beginRetirements(): void {
    for (const island of this.scheduler.activeIslands()) {
      if (!island.retiring) continue;
      if (this.retireJobs.some((j) => j.island === island)) continue;
      const job: RetireJob = { island, phase: 'readback', fadeEnd: 0 };
      this.retireJobs.push(job);
      const gpu = this.gpuFor(island);
      this.enqueueReadback(async () => {
        gpu.computeMassGrid();
        const grid = await this.engine.readField(this.engine.scratch.coarseMass);
        const material = this.islandMaterial.get(island.slot) ?? getMaterial('concrete');
        const protos = packetsFromCoarseGrid(grid, COARSE, island.origin, island.sizeM, 0.03);
        for (const p of protos) {
          this.packets.spawnFromMaterial(material, p.position, p.radii, p.massKg, [...this.wind] as Vec3, island.slot, 0);
        }
        job.phase = 'fading';
        job.fadeEnd = this.simTime + 0.35;
      });
    }
  }

  private applyBodyWakesToPackets(dt: number): void {
    for (const b of this.bodies.values()) {
      const v = b.linearVelocityMps;
      const speed = len(v);
      if (speed < 1.0) continue;
      const air = b.airInteraction;
      if (air && !air.enabled) continue;
      const shape = this.shapes.get(b.shapeId);
      const r = shape ? Math.min(6, Math.max(0.5, sourceBoundRForShape(shape, this.shapes))) : 1;
      this.packets.applyWake({
        from: b.previousTransform?.positionM ?? b.transform.positionM,
        to: b.transform.positionM,
        radiusM: r * 1.6,
        velocityMps: scale(v, (air?.wakeScale ?? 1) * 0.6),
        couple: Math.min(0.8, (air?.dragCoefficient ?? 0.8) * speed * dt * 0.5),
      });
    }
  }

  /** Promote far-field packets back into a fluid island (camera or interaction driven). */
  promoteAt(point: Vec3, radiusM = 7): boolean {
    if (this.scheduler.findCovering(point, 1)) return false;
    const min: Vec3 = [point[0] - radiusM, point[1] - radiusM, point[2] - radiusM];
    const max: Vec3 = [point[0] + radiusM, point[1] + radiusM, point[2] + radiusM];
    const cluster = this.packets.takeInBounds(min, max);
    if (cluster.length === 0) return false;
    const mass = cluster.reduce((m, p) => m + p.massKg, 0);
    if (mass < 0.3) {
      for (const p of cluster) this.packets.packets.push(p);
      return false;
    }
    let cx = 0, cy = 0, cz = 0;
    for (const p of cluster) {
      cx += p.position[0] * p.massKg;
      cy += p.position[1] * p.massKg;
      cz += p.position[2] * p.massKg;
    }
    const center: Vec3 = [cx / mass, cy / mass, cz / mass];
    const tier = 'medium';
    const island = this.scheduler.allocate(
      { center: this.islandCenterFor(center, tier), tier, reason: 'promotion' },
      this.simTime, this.cameraInfo,
    );
    if (!island) {
      for (const p of cluster) this.packets.packets.push(p);
      return false;
    }
    this.configureIslandPlacement(island);
    const gpu = this.gpuFor(island);
    gpu.reset();
    // The GPU can only voxelize MAX_PROMO packets — inject the heaviest and
    // RETURN the rest to the pool (they used to vanish, silently losing mass).
    cluster.sort((a, b) => b.massKg - a.massKg);
    const injected = cluster.slice(0, MAX_PROMO);
    for (const p of cluster.slice(MAX_PROMO)) this.packets.packets.push(p);
    const injectedMass = injected.reduce((m, p) => m + p.massKg, 0);
    packPromo(gpu.uni, injected);
    gpu.injectPromotedPackets();
    island.estimatedMassKg = injectedMass;
    island.lastEventAt = this.simTime;
    this.promoteCooldownUntil = this.simTime + 3;
    return true;
  }

  private autoPromote(): void {
    if (this.simTime < this.promoteCooldownUntil) return;
    // Camera proximity trigger.
    const cam = this.cameraInfo.position;
    for (const p of this.packets.packets) {
      const d = len(sub(p.position, cam));
      if (d < 12 && p.massKg > 1.5) {
        if (this.promoteAt(p.position)) return;
      }
    }
    // Fast bodies stirring packet regions get true fluid response.
    for (const b of this.bodies.values()) {
      if (len(b.linearVelocityMps) < 2) continue;
      for (const p of this.packets.packets) {
        const d = len(sub(p.position, b.transform.positionM));
        if (d < Math.max(...p.radii) + 2 && p.massKg > 1.0) {
          if (this.promoteAt(p.position)) return;
        }
      }
    }
  }

  private enqueueReadback(fn: () => Promise<void>): void {
    this.readbackChain = this.readbackChain.then(fn).catch((e) => console.error('[volumetric-world] readback', e));
  }

  /** Wait for queued readbacks (tests). */
  async flushReadbacks(): Promise<void> {
    await this.readbackChain;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  setSize(w: number, h: number): void {
    this.pass.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.syncRenderUniforms();
    this.pass.render(scene, camera);
    this.resolveGpuTimings();
  }

  /**
   * Capture the current composited frame as a JPEG data URL (for debug
   * reports). Renders one extra frame through the readback target so it works
   * even when presenting straight to the canvas.
   */
  async captureFrame(scene: THREE.Scene, camera: THREE.PerspectiveCamera, maxW = 640): Promise<string> {
    const pass = this.pass;
    const prevMode = pass.presentMode;
    pass.ensureOutRT();
    pass.presentMode = 'readback';
    try {
      this.render(scene, camera);
      const full = document.createElement('canvas');
      const ctx = full.getContext('2d');
      if (!ctx) return '';
      await pass.blitToCanvas2D(ctx);
      const scale = Math.min(1, maxW / Math.max(full.width, 1));
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(full.width * scale));
      small.height = Math.max(1, Math.round(full.height * scale));
      small.getContext('2d')!.drawImage(full, 0, 0, small.width, small.height);
      return small.toDataURL('image/jpeg', 0.72);
    } finally {
      pass.presentMode = prevMode;
    }
  }

  private syncRenderUniforms(): void {
    const pass = this.pass;
    const sunD = norm(this.sun.dir);
    (pass.sunDir.value as THREE.Vector3).set(sunD[0], sunD[1], sunD[2]);
    (pass.sunColor.value as THREE.Color).copy(this.sun.color);
    (pass.sunIntensity as any).value = this.sun.intensity;
    (pass.skyColor.value as THREE.Color).copy(this.sun.sky);
    (pass.skyIntensity as any).value = this.sun.skyIntensity;
    (pass.timeS as any).value = this.simTime;
    (pass.raySteps as any).value = Math.max(16, Math.round(this.preset.raySteps * this.scheduler.qualityScale));

    // Island metadata.
    const meta = (pass.islandMeta as any).array as THREE.Vector4[];
    let count = 0;
    for (const island of this.scheduler.islands) {
      const b = island.slot * ISLE_STRIDE;
      const gpu = this.gpuFor(island);
      const active = island.active && island.renderFade > 0.01;
      const so = gpu.uni.slotOffsetVox.value as THREE.Vector3;
      meta[b + 0].set(island.origin[0], island.origin[1], island.origin[2], island.sizeM);
      meta[b + 1].set(so.x, so.y, so.z, active ? 1 : 0);
      // m2.zw: (reserved for slot res), material detail scale — the same
      // world-space noise scale the packets carry, so both representations
      // sample one continuous detail field.
      const detailScaleM = this.islandMaterial.get(island.slot)?.detail.baseScaleM ?? 1.4;
      meta[b + 2].set(Math.min(this.simTime - island.lastStepAt, 0.4), island.renderFade, 0, detailScaleM);
      if (active) count++;
    }
    (pass.islandCount as any).value = count;

    // Nearest packets for rendering.
    const cam = this.cameraInfo.position;
    const sorted = [...this.packets.packets].sort(
      (a, b) => len(sub(a.position, cam)) - len(sub(b.position, cam)),
    );
    const parr = (pass.packets as any).array as THREE.Vector4[];
    const maxP = Math.floor(parr.length / PKT_STRIDE);
    let pc = 0;
    for (const p of sorted) {
      if (pc >= maxP) break;
      if (p.fade <= 0.01) continue;
      const normV = Math.pow(2 * Math.PI, 1.5) * p.radii[0] * p.radii[1] * p.radii[2];
      const load0 = (p.massKg * p.fade) / Math.max(normV, 1e-6);
      const b = pc * PKT_STRIDE;
      parr[b + 0].set(p.position[0], p.position[1], p.position[2], 1);
      parr[b + 1].set(p.radii[0], p.radii[1], p.radii[2], p.phaseG);
      parr[b + 2].set(
        p.extPerMassRgb[0] * load0, p.extPerMassRgb[1] * load0, p.extPerMassRgb[2] * load0,
        p.detailScaleM,
      );
      parr[b + 3].set(p.albedoRgb[0], p.albedoRgb[1], p.albedoRgb[2], Math.min(p.ageSeconds, 20));
      parr[b + 4].set(p.velocity[0], p.velocity[1], p.velocity[2], p.seed % 17);
      pc++;
    }
    (pass.packetCount as any).value = pc;
  }

  private gpuTimingsPending = false;
  private resolveGpuTimings(): void {
    // In three r180 `trackTimestamp` lives on the BACKEND (narrowed by the
    // timestamp-query feature check during init), not on the renderer — the
    // old renderer-level guard was always undefined, so timings never resolved
    // and the GPU-budget quality controller was flying blind on real GPUs.
    if (!(this.renderer as any).backend?.trackTimestamp) return;
    if (this.gpuTimingsPending) return;
    this.gpuTimingsPending = true;
    // Resolve BOTH pools every frame: each pool holds 2048 queries and this
    // engine issues dozens of compute dispatches per island step, so an
    // unresolved pool exhausts within seconds and timing silently stops.
    Promise.all([
      this.renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER),
      this.renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE),
    ])
      .then(() => {
        const info: any = this.renderer.info;
        const ms = (info.render?.timestamp ?? 0) + (info.compute?.timestamp ?? 0);
        if (ms > 0) this.scheduler.reportGpuMs(ms);
      })
      .catch(() => {})
      .finally(() => {
        this.gpuTimingsPending = false;
      });
  }

  // ------------------------------------------------------------------
  // Metrics (tests/debug)
  // ------------------------------------------------------------------

  async metrics(): Promise<WorldMetrics> {
    const islands: IslandMetrics[] = [];
    for (const island of this.scheduler.activeIslands()) {
      const gpu = this.gpuFor(island);
      await new Promise<void>((resolve) => {
        this.enqueueReadback(async () => {
          gpu.computeMassGrid();
          const grid = await this.engine.readField(this.engine.scratch.coarseMass);
          let mass = 0, mx = 0, my = 0, mz = 0;
          for (let i = 0; i < grid.length; i += 4) {
            mass += grid[i];
            mx += grid[i + 1];
            my += grid[i + 2];
            mz += grid[i + 3];
          }
          island.massKg = mass;
          islands.push({
            slot: island.slot,
            massKg: mass,
            comWorld: mass > 1e-9
              ? [island.origin[0] + mx / mass, island.origin[1] + my / mass, island.origin[2] + mz / mass]
              : [...island.center] as Vec3,
            coarse: grid.slice(),
            origin: [...island.origin] as Vec3,
            sizeM: island.sizeM,
            tier: island.tier,
            rateHz: island.rateHz,
          });
          resolve();
        });
      });
    }
    await this.flushReadbacks();
    const islandMass = islands.reduce((m, i) => m + i.massKg, 0);
    const packetMass = this.packets.totalMass();
    return {
      simTimeS: this.simTime,
      islands,
      islandMassKg: islandMass,
      packetCount: this.packets.packets.length,
      packetMassKg: packetMass,
      totalMassKg: islandMass + packetMass,
      divPreMean: this.lastDivStats.preMean,
      divPostMean: this.lastDivStats.postMean,
      divPreMax: this.lastDivStats.preMax,
      divPostMax: this.lastDivStats.postMax,
      gpuMsAverage: this.scheduler.gpuMsAverage,
      qualityScale: this.scheduler.qualityScale,
      activeIslands: this.scheduler.activeIslands().length,
    };
  }

  dispose(): void {
    this.pass.dispose();
  }
}

function sourceBoundRForShape(shape: ColliderShape, shapes: Map<number, ColliderShape>): number {
  switch (shape.kind) {
    case 'sphere': return shape.radiusM;
    case 'box': return len(shape.halfExtentsM);
    case 'capsule': return shape.radiusM + shape.halfSegmentM;
    case 'convex': {
      let r = 0.5;
      for (const p of shape.planes) r = Math.max(r, Math.abs(p.offsetM) + 0.25);
      return r;
    }
    case 'compound': {
      let r = 0.5;
      for (const c of shape.children) {
        const child = shapes.get(c.shapeId);
        if (child) r = Math.max(r, len(c.localTransform.positionM) + sourceBoundRForShape(child, shapes));
      }
      return r;
    }
  }
}
