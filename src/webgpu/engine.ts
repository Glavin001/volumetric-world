/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../core/types';
import { GpuField, makeField } from './fields';
import { IslandUniforms } from './uniforms';
import {
  IslandFields, ScratchFields,
  kRasterizeSolid, kInjectDensity, kInjectVelocity, kAdvectVelocity, kCurl, kForces,
  kDivergence, kClearScalar, kJacobi, kProject,
  kDensityForward, kDensityReverse, kDensityCorrect, kDensityCommit, kSumCoarseMass,
} from './solverKernels';
import {
  VolumeAtlas, createAtlas, slotOffsetVox, initAtlasTextures, COARSE,
  kWriteVolume, kLightMarch, kClearVolumeSlot, kDownsampleMass, kDownsampleMomentum, kDownsampleAbsDiv,
  kClearShell, kShift, kCopy, kPacketDensity, kPacketVelocity,
} from './outputKernels';

export interface StepFlags {
  light: boolean;
  metrics: boolean;
}

/** GPU resources + kernel graph for one pooled island slot. */
export class IslandGPU {
  readonly fields: IslandFields;
  readonly uni = new IslandUniforms();
  readonly slot: number;
  private readonly N: number;
  private k: Record<string, any> = {};
  private jacobiEvenIters: number;

  constructor(
    private renderer: THREE.WebGPURenderer,
    private scratch: ScratchFields,
    private atlas: VolumeAtlas,
    preset: QualityPreset,
    slot: number,
  ) {
    const N = preset.slotRes;
    this.N = N;
    this.slot = slot;
    this.jacobiEvenIters = Math.ceil(preset.pressureIters / 2) * 2;
    this.fields = {
      N,
      u: makeField(N + 1, N, N, 1, `u${slot}`),
      v: makeField(N, N + 1, N, 1, `v${slot}`),
      w: makeField(N, N, N + 1, 1, `w${slot}`),
      dA: makeField(N, N, N, 4, `dA${slot}`),
      dB: makeField(N, N, N, 4, `dB${slot}`),
    };
    const off = slotOffsetVox(atlas, slot);
    (this.uni.slotOffsetVox.value as THREE.Vector3).set(off[0], off[1], off[2]);

    const f = this.fields;
    const s = scratch;
    const uni = this.uni;
    this.k = {
      rasterize: kRasterizeSolid(f, s, uni),
      injectDensity: kInjectDensity(f, s, uni),
      injectVel: [0, 1, 2].map((c) => kInjectVelocity(f, s, uni, c as 0 | 1 | 2)),
      advect: [0, 1, 2].map((c) => kAdvectVelocity(f, s, uni, c as 0 | 1 | 2)),
      curl: kCurl(f, s, uni),
      forces: [0, 1, 2].map((c) => kForces(f, s, uni, c as 0 | 1 | 2)),
      divScratch: kDivergence(f, s, uni, false),
      divMain: kDivergence(f, s, uni, true),
      clearP: kClearScalar(s.p0),
      jacobi01: kJacobi(f, s, uni, s.p0, s.p1),
      jacobi10: kJacobi(f, s, uni, s.p1, s.p0),
      project: [0, 1, 2].map((c) => kProject(f, s, uni, c as 0 | 1 | 2, s.p0)),
      densFwd: kDensityForward(f, s, uni),
      densRev: kDensityReverse(f, s, uni),
      densCorr: kDensityCorrect(f, s, uni),
      densCommit: kDensityCommit(f, s, uni, s.massStat),
      downMassTil: kDownsampleMass(f, s, uni, s.dTilA),
      sumMassPre: kSumCoarseMass(s.coarseMass, s.massStat, 0),
      sumMassPost: kSumCoarseMass(s.coarseMass, s.massStat, 1),
      writeVolume: kWriteVolume(f, s, uni, atlas),
      light: kLightMarch(f, uni, atlas, preset.lightSteps),
      clearSlot: kClearVolumeSlot(this.N, uni, atlas),
      downMass: kDownsampleMass(f, s, uni),
      downMom: kDownsampleMomentum(f, s, uni),
      downDivPre: kDownsampleAbsDiv(f, s, s.coarseDivPre),
      downDivPost: kDownsampleAbsDiv(f, s, s.coarseDivPost),
      clearShell: kClearShell(f, uni),
      clearU: kClearScalar(f.u),
      clearV: kClearScalar(f.v),
      clearW: kClearScalar(f.w),
      clearDA: kClearScalar(f.dA),
      clearDB: kClearScalar(f.dB),
      shiftU: kShift(f.u, s.uT, uni),
      shiftV: kShift(f.v, s.vT, uni),
      shiftW: kShift(f.w, s.wT, uni),
      shiftDA: kShift(f.dA, s.dHatA, uni),
      shiftDB: kShift(f.dB, s.dHatB, uni),
      copyU: kCopy(s.uT, f.u),
      copyV: kCopy(s.vT, f.v),
      copyW: kCopy(s.wT, f.w),
      copyDA: kCopy(s.dHatA, f.dA),
      copyDB: kCopy(s.dHatB, f.dB),
      packetDensity: kPacketDensity(f, s, uni),
      packetVel: [0, 1, 2].map((c) => kPacketVelocity(f, uni, c as 0 | 1 | 2)),
    };
  }

  /** Reset all persistent fields and the atlas slot (on spawn or free). */
  reset(): void {
    const r = this.renderer;
    r.compute(this.k.clearU);
    r.compute(this.k.clearV);
    r.compute(this.k.clearW);
    r.compute(this.k.clearDA);
    r.compute(this.k.clearDB);
    r.compute(this.k.clearSlot);
  }

  /** Voxelize promoted packets (uniforms already packed by caller). */
  injectPromotedPackets(): void {
    const r = this.renderer;
    r.compute(this.k.packetDensity);
    for (const n of this.k.packetVel) r.compute(n);
    r.compute(this.k.writeVolume);
    r.compute(this.k.light);
  }

  /** Scroll the island by an integer voxel offset (uniform shiftVox pre-set). */
  scroll(): void {
    const r = this.renderer;
    r.compute(this.k.shiftU);
    r.compute(this.k.copyU);
    r.compute(this.k.shiftV);
    r.compute(this.k.copyV);
    r.compute(this.k.shiftW);
    r.compute(this.k.copyW);
    r.compute(this.k.shiftDA);
    r.compute(this.k.copyDA);
    r.compute(this.k.shiftDB);
    r.compute(this.k.copyDB);
  }

  /** One full simulation step. Uniforms must be packed before calling. */
  step(flags: StepFlags): void {
    const r = this.renderer;
    const k = this.k;

    r.compute(k.rasterize);
    r.compute(k.injectDensity);
    // Pre-advection mass for the conservation renormalization in densCommit.
    r.compute(k.downMass);
    r.compute(k.sumMassPre);
    for (const n of k.injectVel) r.compute(n);
    for (const n of k.advect) r.compute(n);
    r.compute(k.curl);
    for (const n of k.forces) r.compute(n);
    r.compute(k.divScratch);
    if (flags.metrics) r.compute(k.downDivPre);

    r.compute(k.clearP);
    for (let i = 0; i < this.jacobiEvenIters / 2; i++) {
      r.compute(k.jacobi01);
      r.compute(k.jacobi10);
    }
    for (const n of k.project) r.compute(n);

    if (flags.metrics) {
      r.compute(k.divMain);
      r.compute(k.downDivPost);
    }

    r.compute(k.densFwd);
    r.compute(k.densRev);
    r.compute(k.densCorr);
    r.compute(k.downMassTil);
    r.compute(k.sumMassPost);
    r.compute(k.densCommit);
    r.compute(k.writeVolume);
    if (flags.light) r.compute(k.light);
  }

  computeMassGrid(): void {
    this.renderer.compute(this.k.downMass);
  }

  /** Fill the shared coarseMom grid with this island's mass-weighted momentum. */
  computeMomentumGrid(): void {
    this.renderer.compute(this.k.downMom);
  }

  clearShell(keep: number, shellVox: number): void {
    (this.uni.shellKeep as any).value = keep;
    (this.uni.shellVox as any).value = shellVox;
    this.renderer.compute(this.k.clearShell);
  }
}

/** Owns the shared scratch fields, the render atlas, and the island slot pool. */
export class SolverEngine {
  readonly atlas: VolumeAtlas;
  readonly scratch: ScratchFields;
  readonly islands: IslandGPU[] = [];
  readonly preset: QualityPreset;

  constructor(readonly renderer: THREE.WebGPURenderer, preset: QualityPreset) {
    this.preset = preset;
    const N = preset.slotRes;
    this.atlas = createAtlas(N, preset.slots);
    initAtlasTextures(renderer, this.atlas);
    this.scratch = {
      uT: makeField(N + 1, N, N, 1, 'uT'),
      vT: makeField(N, N + 1, N, 1, 'vT'),
      wT: makeField(N, N, N + 1, 1, 'wT'),
      dHatA: makeField(N, N, N, 4, 'dHatA'),
      dHatB: makeField(N, N, N, 4, 'dHatB'),
      dTilA: makeField(N, N, N, 4, 'dTilA'),
      dTilB: makeField(N, N, N, 4, 'dTilB'),
      posBuf: makeField(N, N, N, 4, 'posBuf'),
      p0: makeField(N, N, N, 1, 'p0'),
      p1: makeField(N, N, N, 1, 'p1'),
      div: makeField(N, N, N, 1, 'div'),
      curl: makeField(N, N, N, 4, 'curl'),
      solid: makeField(N, N, N, 4, 'solid'),
      coarseMass: makeField(COARSE, COARSE, COARSE, 4, 'coarseMass'),
      coarseMom: makeField(COARSE, COARSE, COARSE, 4, 'coarseMom'),
      coarseDivPre: makeField(COARSE, COARSE, COARSE, 4, 'coarseDivPre'),
      coarseDivPost: makeField(COARSE, COARSE, COARSE, 4, 'coarseDivPost'),
      massStat: makeField(1, 1, 1, 4, 'massStat'),
    };
    for (let sIdx = 0; sIdx < preset.slots; sIdx++) {
      this.islands.push(new IslandGPU(renderer, this.scratch, this.atlas, preset, sIdx));
    }
  }

  async readField(field: GpuField): Promise<Float32Array> {
    const ab = await (this.renderer as any).getArrayBufferAsync(field.attr);
    return new Float32Array(ab);
  }
}
