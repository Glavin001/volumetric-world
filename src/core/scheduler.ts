import type { IslandTier, QualityPreset, Vec3 } from './types';
import { clamp, dot, len, norm, sub } from './math';

/**
 * The scheduler budgets by activity (active cells/s, ray samples, cache
 * updates), not by "number of clouds". It decides which pooled island slots
 * exist, their tier (world extent + rate), staggered step timing, and when an
 * island retires into far-field packets. Rendering importance never gates
 * SIMULATION participation: off-screen islands keep stepping at reduced tiers
 * so hidden bodies can stir clouds the camera can see.
 */

export interface IslandStateInit {
  center: Vec3;
  tier: IslandTier;
  reason: 'event' | 'promotion' | 'rebox';
  /** Preferred resolution class; the pool falls back to the other class when full. */
  cls?: 'fine' | 'coarse';
}

export interface IslandState {
  slot: number;
  active: boolean;
  /** Fixed resolution class of this slot (mixed-res pool). */
  cls: 'fine' | 'coarse';
  tier: IslandTier;
  sizeM: number;
  origin: [number, number, number];
  center: [number, number, number];
  rateHz: number;
  nextStepAt: number;
  lastStepAt: number;
  lastLightAt: number;
  lastEventAt: number;
  lastExportAt: number;
  createdAt: number;
  /** Exponential moving average of measured mass (kg) from readbacks. */
  massKg: number;
  /** CPU-side estimate updated by emissions (corrected by readbacks). */
  estimatedMassKg: number;
  importance: number;
  lowImportanceSince: number;
  interactionCount: number;
  /** Focus point tracked for scrolling (EMA of emission/interaction centroid). */
  focus: [number, number, number];
  /** Render crossfade 0..1 (used during packet handoff). */
  renderFade: number;
  retiring: boolean;
  /** True while this island is being resampled into another slot (frozen). */
  reboxing: boolean;
  /** simTime since the island's class stopped matching its camera-relative need. */
  classMismatchSince: number;
  /** Step counter for cadenced work (light cache, exports, metrics). */
  stepCount: number;
}

export interface CameraInfo {
  position: Vec3;
  forward: Vec3;
}

export interface SchedulerOptions {
  preset: QualityPreset;
  gpuBudgetMs: number;
}

export class IslandScheduler {
  readonly islands: IslandState[] = [];
  readonly preset: QualityPreset;
  gpuBudgetMs: number;
  /**
   * What fidelity follows: 'camera' allocates fine slots and high rates to
   * islands near the viewer (the viewer always sees the best quality);
   * 'events' gives every island the best free slot regardless of the camera.
   */
  focusMode: 'camera' | 'events' = 'camera';
  /** Global quality scalar the budget controller steers (0.4 .. 1.15). */
  qualityScale = 1;
  private gpuMsEma = 0;

  constructor(opts: SchedulerOptions) {
    this.preset = opts.preset;
    this.gpuBudgetMs = opts.gpuBudgetMs;
    for (let s = 0; s < opts.preset.slots; s++) {
      this.islands.push({
        slot: s,
        active: false,
        cls: opts.preset.slotClasses[s] ?? 'fine',
        tier: 'small',
        sizeM: opts.preset.tierSizeM.small,
        origin: [0, 0, 0],
        center: [0, 0, 0],
        rateHz: opts.preset.tierRateHz.small,
        nextStepAt: 0,
        lastStepAt: 0,
        lastLightAt: -1,
        lastEventAt: -100,
        lastExportAt: 0,
        createdAt: 0,
        massKg: 0,
        estimatedMassKg: 0,
        importance: 0,
        lowImportanceSince: Infinity,
        interactionCount: 0,
        focus: [0, 0, 0],
        renderFade: 1,
        retiring: false,
        reboxing: false,
        classMismatchSince: Infinity,
        stepCount: 0,
      });
    }
  }

  activeIslands(): IslandState[] {
    return this.islands.filter((i) => i.active);
  }

  /** Find an active island whose bounds (with margin) contain the point. */
  findCovering(p: Vec3, marginM = 0): IslandState | undefined {
    return this.activeIslands().find((i) => {
      const h = i.sizeM / 2 + marginM;
      return (
        Math.abs(p[0] - i.center[0]) < h &&
        Math.abs(p[1] - i.center[1]) < h &&
        Math.abs(p[2] - i.center[2]) < h
      );
    });
  }

  /**
   * Allocate a slot for a new island. If the pool is exhausted, the least
   * important island below the caller's importance is retired first;
   * returns undefined when nothing can be evicted (caller falls back to
   * spawning far-field packets directly).
   */
  allocate(init: IslandStateInit, now: number, camera: CameraInfo): IslandState | undefined {
    const wanted = init.cls ?? this.classFor(init.center, camera);
    let slot = this.islands.find((i) => !i.active && i.cls === wanted)
      ?? this.islands.find((i) => !i.active);
    if (init.reason === 'rebox' && slot && slot.cls !== wanted) return undefined;
    if (!slot) {
      const candidateImportance = this.scoreHypothetical(init.center, camera, now);
      let worst: IslandState | undefined;
      for (const i of this.activeIslands()) {
        if (i.retiring) continue;
        if (!worst || i.importance < worst.importance) worst = i;
      }
      if (worst && worst.importance < candidateImportance * 0.6) {
        worst.retiring = true; // world will export it to packets, then free the slot
      }
      return undefined;
    }
    const sizeM = this.preset.tierSizeM[init.tier];
    slot.active = true;
    slot.tier = init.tier;
    slot.sizeM = sizeM;
    slot.center = [...init.center] as [number, number, number];
    slot.origin = [init.center[0] - sizeM / 2, init.center[1] - sizeM / 2, init.center[2] - sizeM / 2];
    // Coarse (far-from-camera) islands also step slower: 1/8 the cells AND
    // a reduced rate — the render-side advective interpolation hides it.
    slot.rateHz = this.preset.tierRateHz[init.tier] * (slot.cls === 'coarse' ? 0.6 : 1);
    // Stagger: offset each slot's phase so islands do not step on the same frame.
    slot.nextStepAt = now + (slot.slot * 0.618) % (1 / slot.rateHz);
    slot.lastStepAt = now;
    slot.lastLightAt = -1;
    slot.lastEventAt = now;
    slot.lastExportAt = now;
    slot.createdAt = now;
    slot.massKg = 0;
    slot.estimatedMassKg = 0;
    slot.importance = 1;
    slot.lowImportanceSince = Infinity;
    slot.interactionCount = 0;
    slot.focus = [...init.center] as [number, number, number];
    slot.renderFade = 1;
    slot.retiring = false;
    slot.reboxing = false;
    slot.classMismatchSince = Infinity;
    slot.stepCount = 0;
    return slot;
  }

  /** Which resolution class an island at this position deserves right now. */
  classFor(center: Vec3, camera: CameraInfo): 'fine' | 'coarse' {
    if (this.focusMode === 'events') return 'fine';
    const d = len(sub(center, camera.position));
    return d < 40 ? 'fine' : 'coarse';
  }

  free(island: IslandState): void {
    island.active = false;
    island.retiring = false;
    island.reboxing = false;
    island.classMismatchSince = Infinity;
    island.massKg = 0;
    island.estimatedMassKg = 0;
  }

  /** Pick a tier for a new event by distance and event magnitude. */
  tierFor(center: Vec3, massKg: number, camera: CameraInfo): IslandTier {
    const d = len(sub(center, camera.position));
    const heroBusy = this.activeIslands().some((i) => i.tier === 'hero');
    if (!heroBusy && d < 30 && massKg > 40) return 'hero';
    if (d < 60 && massKg > 8) return 'medium';
    return 'small';
  }

  private scoreHypothetical(center: Vec3, camera: CameraInfo, now: number): number {
    const d = Math.max(1, len(sub(center, camera.position)));
    return (100 / (d * d)) * 4; // fresh events score high (recent-event boost baked in)
  }

  /**
   * I = A_screen · τ_optical · W_distance · W_interaction · W_recentEvent · W_cameraRelevance
   * (screen area is approximated from bounding-sphere solid angle).
   */
  updateImportance(now: number, camera: CameraInfo): void {
    for (const i of this.activeIslands()) {
      const toC = sub(i.center, camera.position);
      const d = Math.max(1, len(toC));
      const aScreen = clamp((i.sizeM / d) ** 2, 0.0004, 4);
      const mass = Math.max(i.massKg, i.estimatedMassKg);
      const tau = clamp(mass / (i.sizeM * i.sizeM * 0.02 + 1e-3), 0.02, 4);
      const wDist = 1 / (1 + d / 60);
      const wInter = 1 + 2 * Math.min(i.interactionCount, 3);
      const wRecent = 1 + 3 * Math.exp(-Math.max(0, now - i.lastEventAt) / 3);
      const facing = dot(norm(toC), camera.forward);
      const wCam = clamp(0.35 + 0.65 * (facing * 0.5 + 0.5), 0.35, 1);
      const wFocus = this.focusMode === 'camera' ? 1 / (1 + d / 25) + 0.25 : 1;
      i.importance = aScreen * tau * wDist * wInter * wRecent * wCam * wFocus;

      // Track how long the slot's resolution class has disagreed with what
      // this island deserves (hysteresis input for the rebox controller).
      const wantedCls = this.classFor(i.center, camera);
      if (wantedCls !== i.cls && !i.retiring && !i.reboxing) {
        if (i.classMismatchSince === Infinity) i.classMismatchSince = now;
      } else {
        i.classMismatchSince = Infinity;
      }

      const threshold = 0.004;
      const negligibleMass = mass < 0.05 && now - i.lastEventAt > 2 && now - i.createdAt > 3;
      if ((i.importance < threshold || negligibleMass) && now - i.lastEventAt > 4) {
        if (i.lowImportanceSince === Infinity) i.lowImportanceSince = now;
        // Hysteresis: only retire after 2.5 s below threshold.
        if (now - i.lowImportanceSince > 2.5 || negligibleMass) i.retiring = true;
      } else {
        i.lowImportanceSince = Infinity;
      }
    }
  }

  /**
   * Islands due for a simulation step, ordered by importance, capped by a
   * cell-update budget in FINE-slot equivalents (a coarse island costs 1/8 a
   * fine one, so far dust no longer competes head-to-head with near dust).
   */
  dueIslands(now: number, budgetFineEquiv: number): IslandState[] {
    const due = this.activeIslands()
      .filter((i) => now >= i.nextStepAt && !i.reboxing)
      .sort((a, b) => b.importance - a.importance);
    const out: IslandState[] = [];
    let budget = budgetFineEquiv * Math.max(this.qualityScale, 0.4);
    for (const i of due) {
      const cost = i.cls === 'coarse' ? 0.125 : 1;
      if (budget < cost && out.length > 0) break;
      out.push(i);
      budget -= cost;
    }
    return out;
  }

  markStepped(i: IslandState, now: number): void {
    const rate = Math.max(4, i.rateHz * (this.qualityScale < 0.7 ? 0.75 : 1));
    i.lastStepAt = now;
    i.nextStepAt = Math.max(now + 1 / rate, Math.min(i.nextStepAt + 1 / rate, now + 2 / rate));
    i.stepCount++;
  }

  lightDue(i: IslandState, now: number): boolean {
    const rate = Math.max(3, this.preset.lightRateHz * this.qualityScale);
    return now - i.lastLightAt >= 1 / rate;
  }

  /** Feed measured GPU frame time; steers the global quality scalar. */
  reportGpuMs(ms: number): void {
    if (!(ms > 0) || !isFinite(ms)) return;
    this.gpuMsEma = this.gpuMsEma === 0 ? ms : this.gpuMsEma * 0.92 + ms * 0.08;
    if (this.gpuMsEma > this.gpuBudgetMs * 1.15) {
      this.qualityScale = clamp(this.qualityScale * 0.985, 0.4, 1.15);
    } else if (this.gpuMsEma < this.gpuBudgetMs * 0.7) {
      this.qualityScale = clamp(this.qualityScale * 1.006, 0.4, 1.15);
    }
  }

  get gpuMsAverage(): number {
    return this.gpuMsEma;
  }
}
