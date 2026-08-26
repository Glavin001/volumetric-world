/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, int, uint, uvec3, vec3, vec4,
  min, max, clamp, exp, sqrt, log, length, dot, smoothstep, mix, floor, fract, sin,
  instanceIndex, textureStore, texture3D,
} from 'three/tsl';
import { GpuField, fieldCoord, fieldIndex } from './fields';
import { IslandUniforms, MAX_PROMO, PROMO_STRIDE } from './uniforms';
import type { IslandFields, ScratchFields } from './solverKernels';

export const COARSE = 16;

export type SlotClass = 'fine' | 'coarse';

/** One pooled island slot in the shared 3D atlas. */
export interface SlotDesc {
  offsetVox: [number, number, number];
  res: number;
  cls: SlotClass;
}

export interface VolumeAtlas {
  texA: THREE.Storage3DTexture; // σt rgb, loading
  texB: THREE.Storage3DTexture; // albedo rgb, g encoded
  texVel: THREE.Storage3DTexture; // velocity xyz (m/s)
  texShadow: THREE.Storage3DTexture; // sqrt(sun transmittance), 16-bit fixed point in (x=hi, y=lo/255)
  dimX: number;
  dimY: number;
  dimZ: number;
  /** Finest slot resolution (the atlas Z extent). */
  fineRes: number;
  slots: SlotDesc[];
}

/**
 * Coarse-class resolution for a given fine resolution: roughly half, snapped
 * to a multiple of the 16³ export grid (kDownsampleMass divisibility).
 */
export function coarseResFor(fineRes: number): number {
  return Math.max(16, Math.round(fineRes / 2 / 16) * 16);
}

/**
 * Mixed-resolution shelf-packed atlas: a row of fine slots (full slotRes),
 * then a row of coarse slots at ~half resolution. Coarse islands cover the
 * same world extents with 1/8 the voxels — the far-from-camera tier of the
 * viewer-centric LOD.
 */
export function createAtlas(slotRes: number, classes: SlotClass[]): VolumeAtlas {
  const N = slotRes;
  const Nc = coarseResFor(N);
  const fine = classes.filter((c) => c === 'fine').length;
  const coarse = classes.length - fine;
  const dimX = Math.max(fine * N, coarse * Nc, N);
  const dimY = N + (coarse > 0 ? Nc : 0);
  const dimZ = N;

  const slots: SlotDesc[] = [];
  let fx = 0;
  let cx = 0;
  for (const cls of classes) {
    if (cls === 'fine') {
      slots.push({ offsetVox: [fx, 0, 0], res: N, cls });
      fx += N;
    } else {
      slots.push({ offsetVox: [cx, N, 0], res: Nc, cls });
      cx += Nc;
    }
  }

  const make = (halfFloat: boolean, label: string) => {
    const t = new THREE.Storage3DTexture(dimX, dimY, dimZ);
    t.name = label;
    t.format = THREE.RGBAFormat;
    t.type = halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = (t as any).wrapR = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  };
  return {
    texA: make(true, 'atlasA'),
    texB: make(false, 'atlasB'),
    texVel: make(true, 'atlasVel'),
    texShadow: make(false, 'atlasShadow'),
    dimX,
    dimY,
    dimZ,
    fineRes: N,
    slots,
  };
}

export function slotOffsetVox(atlas: VolumeAtlas, slot: number): [number, number, number] {
  return atlas.slots[slot].offsetVox;
}

/**
 * Fully initialize the atlas textures with an explicit writeTexture upload.
 * three creates 3D storage textures with RENDER_ATTACHMENT usage, and Dawn's
 * lazy zero-initialization then tries to clear them through 2D attachment
 * views — invalid for 3D textures (fails the whole submit on SwiftShader).
 * Writing every texel once marks the subresource initialized and sets sane
 * defaults (shadow = 1, albedo = 0.5).
 */
export function initAtlasTextures(renderer: THREE.WebGPURenderer, atlas: VolumeAtlas): void {
  const backend: any = (renderer as any).backend;
  const device: GPUDevice = backend.device;
  const upload = (t: THREE.Storage3DTexture, bytesPerTexel: number, fill: (b: Uint8Array) => void) => {
    renderer.initTexture(t);
    const gpuTex: GPUTexture = backend.get(t).texture;
    const data = new Uint8Array(atlas.dimX * atlas.dimY * atlas.dimZ * bytesPerTexel);
    fill(data);
    device.queue.writeTexture(
      { texture: gpuTex },
      data,
      { bytesPerRow: atlas.dimX * bytesPerTexel, rowsPerImage: atlas.dimY },
      { width: atlas.dimX, height: atlas.dimY, depthOrArrayLayers: atlas.dimZ },
    );
  };
  upload(atlas.texA, 8, () => {});
  upload(atlas.texVel, 8, () => {});
  upload(atlas.texB, 4, (b) => b.fill(0x80));
  // sqrt(T)=1 in 16-bit fixed point: hi=0xff, lo=0 (lo=0xff would decode >1).
  upload(atlas.texShadow, 4, (b) => {
    for (let i = 0; i < b.length; i += 4) {
      b[i] = 0xff; b[i + 1] = 0; b[i + 2] = 0; b[i + 3] = 0xff;
    }
  });
}

/** Extinction soft-knee (1/m): sigma compresses toward this instead of clamping. */
const SIGMA_KNEE = 70.0;

/** Bake density moments + center velocity into the render atlas (with soft slot-edge fade). */
export function kWriteVolume(f: IslandFields, s: ScratchFields, uni: IslandUniforms, atlas: VolumeAtlas): any {
  const cells = f.dA.count;
  const N = f.N;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const a = f.dA.node.element(instanceIndex).toVar();
      const b = f.dB.node.element(instanceIndex).toVar();

      // World-space (~1.2 m) fade at slot edges: keeps trilinear sampling from
      // bleeding across atlas slots and gives islands soft open boundaries. A
      // fixed 2-voxel fade was ~0.2 m at fine tiers, which made a freshly
      // filled island read as a hard white box.
      const ex = min(float(x), float(N - 1).sub(float(x)));
      const ey = min(float(y), float(N - 1).sub(float(y)));
      const ez = min(float(z), float(N - 1).sub(float(z)));
      const edge = min(ex, min(ey, ez)).add(0.5);
      const fadeVox = clamp(uni.invH.mul(1.2), 2.0, 12.0);
      const fade = smoothstep(0.0, fadeVox, edge);

      // Soft-knee extinction: compress sigma_t so dense cores stay thick smoke
      // instead of saturating into a solid surface (linear below the knee,
      // asymptotic to it above — replaces the hard MAX_SIGMA_T clamp).
      const sRaw = max(a.xyz.mul(fade), vec3(0.0));
      const sigma = exp(sRaw.negate().div(SIGMA_KNEE)).oneMinus().mul(SIGMA_KNEE).toVar();
      const loading = max(a.w.mul(fade), 0.0);
      const albedo = clamp(b.xyz.div(max(a.xyz, vec3(1e-4))), vec3(0.0), vec3(1.0));
      const scatLum = dot(b.xyz, vec3(0.2126, 0.7152, 0.0722));
      const g = clamp(b.w.div(max(scatLum, 1e-4)), -0.95, 0.95);

      const texel = uvec3(
        uint(x.add(int(uni.slotOffsetVox.x))),
        uint(y.add(int(uni.slotOffsetVox.y))),
        uint(z.add(int(uni.slotOffsetVox.z))),
      ).toVar();

      // Cell-center velocity from MAC faces (for advective render-time interpolation).
      const ux = f.u.node.element(fieldIndex(f.u, x, y, z)).add(f.u.node.element(fieldIndex(f.u, x.add(int(1)), y, z))).mul(0.5);
      const vy = f.v.node.element(fieldIndex(f.v, x, y, z)).add(f.v.node.element(fieldIndex(f.v, x, y.add(int(1)), z))).mul(0.5);
      const wz = f.w.node.element(fieldIndex(f.w, x, y, z)).add(f.w.node.element(fieldIndex(f.w, x, y, z.add(int(1))))).mul(0.5);

      textureStore(atlas.texA, texel, vec4(sigma, loading)).toWriteOnly();
      textureStore(atlas.texB, texel, vec4(albedo, g.mul(0.5).add(0.5))).toWriteOnly();
      textureStore(atlas.texVel, texel, vec4(ux, vy, wz, 0.0)).toWriteOnly();
    });
  })().compute(cells);
}

/**
 * Per-island sun-transmittance cache: short march from each voxel toward the
 * sun through this island's slot of the atlas. Stored as sqrt(T) in rgba8.
 */
export function kLightMarch(f: IslandFields, uni: IslandUniforms, atlas: VolumeAtlas, lightSteps: number): any {
  const cells = f.dA.count;
  const N = f.N;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const p = vec3(float(x).add(0.5), float(y).add(0.5), float(z).add(0.5)).mul(uni.h).add(uni.origin).toVar();
      const stepLen = uni.sizeM.mul(1.74 / lightSteps).toVar();
      const invSize = float(1.0).div(uni.sizeM).toVar();
      const od = float(0).toVar();
      const atlasDims = vec3(atlas.dimX, atlas.dimY, atlas.dimZ);
      // Per-voxel start jitter breaks up concentric shadow banding.
      const jit = float(instanceIndex.toFloat().mul(0.6180339887)).fract().toVar();
      Loop({ start: int(1), end: int(lightSteps), type: 'int', condition: '<=' }, ({ i }: any) => {
        const q = p.add(uni.sunDir.mul(stepLen.mul(float(i).sub(1.0).add(jit).add(0.25)))).toVar();
        const local = q.sub(uni.origin).mul(invSize).toVar();
        If(
          local.x.lessThan(0.0).or(local.y.lessThan(0.0)).or(local.z.lessThan(0.0))
            .or(local.x.greaterThan(1.0)).or(local.y.greaterThan(1.0)).or(local.z.greaterThan(1.0)),
          () => {
            Break();
          },
        );
        const lc = clamp(local, vec3(0.002), vec3(0.998));
        const uvw = uni.slotOffsetVox.add(lc.mul(float(N))).div(atlasDims);
        const sig = texture3D(atlas.texA, uvw, int(0)).xyz;
        od.addAssign(dot(sig, vec3(0.2126, 0.7152, 0.0722)).mul(stepLen).mul(uni.shadowDensity));
        If(od.greaterThan(9.0), () => {
          Break();
        });
      });
      const trans = exp(od.negate());
      const texel = uvec3(
        uint(x.add(int(uni.slotOffsetVox.x))),
        uint(y.add(int(uni.slotOffsetVox.y))),
        uint(z.add(int(uni.slotOffsetVox.z))),
      );
      // 16-bit fixed-point sqrt(T) across two 8-bit channels (x=hi, y=lo):
      // 8 bits alone band visibly on smooth domes. e = hi + lo/255 is linear,
      // so hardware trilinear filtering reconstructs it exactly.
      const enc = sqrt(trans).mul(255.0);
      textureStore(atlas.texShadow, texel, vec4(floor(enc).div(255.0), fract(enc), 0.0, 1.0)).toWriteOnly();
    });
  })().compute(cells);
}

/**
 * O(N³) directional light sweep replacing the O(N³·lightSteps) per-voxel
 * march: one thread per launch column on a 2N×2N grid (covering worst-case
 * 45° shear), each walking N layers along the dominant sun axis, accumulating
 * optical depth once per layer and storing sqrt(T). Per-layer column drift is
 * identical across threads, so each layer's writes are a shifted bijection of
 * the launch grid — full coverage, no races, no barriers, and no per-voxel
 * jitter speckle (a per-COLUMN entry jitter decorrelates banding instead).
 */
export function kLightSweep(f: IslandFields, uni: IslandUniforms, atlas: VolumeAtlas): any {
  const N = f.N;
  const W = 2 * N;
  const threads = W * W;
  const atlasDims = vec3(atlas.dimX, atlas.dimY, atlas.dimZ);
  return Fn(() => {
    If(instanceIndex.lessThan(uint(threads)), () => {
      const idx = int(instanceIndex).toVar();
      const tb = idx.div(int(W)).toVar();
      const ta = idx.sub(tb.mul(int(W))).toVar();
      const a0 = float(ta).add(uni.sweepBase.x).toVar();
      const b0 = float(tb).add(uni.sweepBase.y).toVar();

      const da = uni.sweepParams.x;
      const db = uni.sweepParams.y;
      const L0 = uni.sweepParams.z;
      const dL = uni.sweepParams.w;
      const stepOd = uni.sweepStepLen.mul(uni.shadowDensity).toVar();

      // Per-column entry jitter breaks residual layer banding without the
      // per-voxel speckle the old march produced.
      const jit = fract(sin(float(ta).mul(127.1).add(float(tb).mul(311.7))).mul(43758.5453)).mul(0.5).toVar();

      const od = float(0).toVar();
      Loop({ start: int(0), end: int(N), type: 'int', condition: '<' }, ({ i }: any) => {
        const fi = float(i).toVar();
        const layer = L0.add(dL.mul(fi)).toVar();
        // Continuous sample position (voxel space) along the true sun ray.
        const ac = a0.add(da.mul(fi.add(jit))).add(0.5);
        const bc = b0.add(db.mul(fi.add(jit))).add(0.5);
        const vox = uni.sweepAxisA.mul(ac)
          .add(uni.sweepAxisL.mul(layer.add(0.5)))
          .add(uni.sweepAxisB.mul(bc)).toVar();
        const local = vox.div(float(N)).toVar();
        const inside = local.x.greaterThanEqual(0.0).and(local.y.greaterThanEqual(0.0)).and(local.z.greaterThanEqual(0.0))
          .and(local.x.lessThan(1.0)).and(local.y.lessThan(1.0)).and(local.z.lessThan(1.0));

        const sigLum = float(0).toVar();
        If(inside.and(od.lessThan(14.0)), () => {
          const lc = clamp(local, vec3(0.002), vec3(0.998));
          const uvw = uni.slotOffsetVox.add(lc.mul(float(N))).div(atlasDims);
          const sig = texture3D(atlas.texA, uvw, int(0)).xyz;
          sigLum.assign(dot(sig, vec3(0.2126, 0.7152, 0.0722)));
        });

        // Half-step self attenuation: write T at the voxel centre.
        od.addAssign(sigLum.mul(stepOd).mul(0.5));
        // Quantized output column for this layer (same drift for all threads —
        // a bijection of the launch grid, so every slot texel is written once).
        const oa = a0.add(floor(da.mul(fi).add(0.5))).toVar();
        const ob = b0.add(floor(db.mul(fi).add(0.5))).toVar();
        const outVox = uni.sweepAxisA.mul(oa)
          .add(uni.sweepAxisL.mul(layer))
          .add(uni.sweepAxisB.mul(ob)).toVar();
        const inRange = outVox.x.greaterThanEqual(0.0).and(outVox.y.greaterThanEqual(0.0)).and(outVox.z.greaterThanEqual(0.0))
          .and(outVox.x.lessThan(float(N))).and(outVox.y.lessThan(float(N))).and(outVox.z.lessThan(float(N)));
        If(inRange, () => {
          const texel = uvec3(
            uint(int(outVox.x).add(int(uni.slotOffsetVox.x))),
            uint(int(outVox.y).add(int(uni.slotOffsetVox.y))),
            uint(int(outVox.z).add(int(uni.slotOffsetVox.z))),
          );
          const enc = sqrt(exp(od.negate())).mul(255.0);
          textureStore(atlas.texShadow, texel, vec4(floor(enc).div(255.0), fract(enc), 0.0, 1.0)).toWriteOnly();
        });
        od.addAssign(sigLum.mul(stepOd).mul(0.5));
      });
    });
  })().compute(threads);
}

/**
 * In-place re-tiering ("rebox"): initialize this island's density/optical
 * fields by trilinearly sampling the OLD slot's atlas region. The decode is
 * the exact inverse of kWriteVolume's encode (soft-knee extinction and slot
 * edge fade divided out, clamped) so an upgrade/downgrade crossfade holds
 * near-constant optical depth. Source slot is pure uniforms — one compiled
 * kernel per island resamples from any slot.
 */
export function kReboxDensity(f: IslandFields, uni: IslandUniforms, atlas: VolumeAtlas): any {
  const cells = f.dA.count;
  const atlasDims = vec3(atlas.dimX, atlas.dimY, atlas.dimZ);
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const p = vec3(float(x).add(0.5), float(y).add(0.5), float(z).add(0.5)).mul(uni.h).add(uni.origin).toVar();
      const srcLocal = p.sub(uni.reboxSrcOrigin).div(uni.reboxSrcSize).toVar();
      const inside = srcLocal.x.greaterThanEqual(0.0).and(srcLocal.y.greaterThanEqual(0.0)).and(srcLocal.z.greaterThanEqual(0.0))
        .and(srcLocal.x.lessThan(1.0)).and(srcLocal.y.lessThan(1.0)).and(srcLocal.z.lessThan(1.0));
      const outA = vec4(0.0).toVar();
      const outB = vec4(0.0).toVar();
      If(inside, () => {
        const lc = clamp(srcLocal, vec3(0.002), vec3(0.998));
        const uvw = uni.reboxSrcOff.add(lc.mul(uni.reboxSrcRes)).div(atlasDims).toVar();
        const a = texture3D(atlas.texA, uvw, int(0)).toVar();
        const b = texture3D(atlas.texB, uvw, int(0)).toVar();
        // Undo the OLD slot's edge fade (clamped: a downgrade must not inherit
        // a density-dip ring at the old boundary).
        const voxCoord = srcLocal.mul(uni.reboxSrcRes).toVar();
        const edge = min(
          min(voxCoord.x, uni.reboxSrcRes.sub(voxCoord.x)),
          min(min(voxCoord.y, uni.reboxSrcRes.sub(voxCoord.y)), min(voxCoord.z, uni.reboxSrcRes.sub(voxCoord.z))),
        );
        const invHOld = uni.reboxSrcRes.div(uni.reboxSrcSize);
        const fadeVox = clamp(invHOld.mul(1.2), 2.0, 12.0);
        // The clamp bounds noise amplification, but every 1/clamp of head-room
        // recovers real mass stored under the fade — 0.08 keeps ~all of the
        // plume through repeated up/down reboxes.
        const fade = max(smoothstep(0.0, fadeVox, edge), 0.08);
        // Invert the soft knee back to raw extinction.
        const sigKnee = min(a.xyz, vec3(SIGMA_KNEE * 0.98));
        const sRaw = vec3(0.0).sub(vec3(SIGMA_KNEE).mul(sigKnee.div(SIGMA_KNEE).oneMinus().log())).div(fade).toVar();
        const loading = a.w.div(fade);
        const albedo = b.xyz;
        const g = b.w.mul(2.0).sub(1.0);
        const scat = albedo.mul(sRaw).toVar();
        outA.assign(vec4(sRaw, loading));
        outB.assign(vec4(scat, g.mul(dot(scat, vec3(0.2126, 0.7152, 0.0722)))));
      });
      f.dA.node.element(instanceIndex).assign(outA);
      f.dB.node.element(instanceIndex).assign(outB);
    });
  })().compute(cells);
}

/** Rebox companion: initialize one MAC velocity component from the old slot's texVel. */
export function kReboxVelocity(f: IslandFields, uni: IslandUniforms, atlas: VolumeAtlas, comp: 0 | 1 | 2): any {
  const field = comp === 0 ? f.u : comp === 1 ? f.v : f.w;
  const cells = field.count;
  const atlasDims = vec3(atlas.dimX, atlas.dimY, atlas.dimZ);
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(field, instanceIndex);
      // Face-center world position for this MAC component.
      const off = comp === 0 ? vec3(0.0, 0.5, 0.5) : comp === 1 ? vec3(0.5, 0.0, 0.5) : vec3(0.5, 0.5, 0.0);
      const p = vec3(float(x), float(y), float(z)).add(off).mul(uni.h).add(uni.origin).toVar();
      const srcLocal = p.sub(uni.reboxSrcOrigin).div(uni.reboxSrcSize).toVar();
      const inside = srcLocal.x.greaterThanEqual(0.0).and(srcLocal.y.greaterThanEqual(0.0)).and(srcLocal.z.greaterThanEqual(0.0))
        .and(srcLocal.x.lessThan(1.0)).and(srcLocal.y.lessThan(1.0)).and(srcLocal.z.lessThan(1.0));
      const vel = float(0.0).toVar();
      If(inside, () => {
        const lc = clamp(srcLocal, vec3(0.002), vec3(0.998));
        const uvw = uni.reboxSrcOff.add(lc.mul(uni.reboxSrcRes)).div(atlasDims);
        const v = texture3D(atlas.texVel, uvw, int(0)).xyz;
        vel.assign(comp === 0 ? v.x : comp === 1 ? v.y : v.z);
      });
      field.node.element(instanceIndex).assign(vel);
    });
  })().compute(cells);
}

/** Zero a whole atlas slot (on island spawn/free) — shadow initialized to 1. */
export function kClearVolumeSlot(N: number, uni: IslandUniforms, atlas: VolumeAtlas): any {
  const cells = N * N * N;
  const fake: GpuField = { nx: N, ny: N, nz: N } as GpuField;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(fake, instanceIndex);
      const texel = uvec3(
        uint(x.add(int(uni.slotOffsetVox.x))),
        uint(y.add(int(uni.slotOffsetVox.y))),
        uint(z.add(int(uni.slotOffsetVox.z))),
      ).toVar();
      textureStore(atlas.texA, texel, vec4(0.0)).toWriteOnly();
      textureStore(atlas.texB, texel, vec4(0.5)).toWriteOnly();
      textureStore(atlas.texVel, texel, vec4(0.0)).toWriteOnly();
      textureStore(atlas.texShadow, texel, vec4(1.0, 0.0, 0.0, 1.0)).toWriteOnly();
    });
  })().compute(cells);
}

/**
 * Downsample loading into a COARSE³ grid of (mass kg, Σm·x, Σm·y, Σm·z) with
 * island-local positions in meters — used for metrics, export, and tests.
 */
export function kDownsampleMass(f: IslandFields, s: ScratchFields, uni: IslandUniforms, src?: GpuField): any {
  const N = f.N;
  const source = src ?? f.dA;
  const block = N / COARSE;
  if (!Number.isInteger(block)) throw new Error(`slotRes ${N} not divisible by ${COARSE}`);
  const coarseCells = COARSE * COARSE * COARSE;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(coarseCells)), () => {
      const { x, y, z } = fieldCoord(s.coarseMass, instanceIndex);
      const acc = vec4(0.0).toVar();
      const cellVol = uni.h.mul(uni.h).mul(uni.h).toVar();
      Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i }: any) => {
        Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i: j }: any) => {
          Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i: k }: any) => {
            const cx = x.mul(int(block)).add(k).toVar();
            const cy = y.mul(int(block)).add(j).toVar();
            const cz = z.mul(int(block)).add(i).toVar();
            const m = source.node.element(fieldIndex(f.dA, cx, cy, cz)).w.mul(cellVol).toVar();
            const px = float(cx).add(0.5).mul(uni.h);
            const py = float(cy).add(0.5).mul(uni.h);
            const pz = float(cz).add(0.5).mul(uni.h);
            acc.addAssign(vec4(m, m.mul(px), m.mul(py), m.mul(pz)));
          });
        });
      });
      s.coarseMass.node.element(instanceIndex).assign(acc);
    });
  })().compute(coarseCells);
}

/**
 * Mass-weighted momentum per coarse cell: (Σm·vx, Σm·vy, Σm·vz, Σm) with
 * velocity averaged from the MAC faces. Read back with the mass grid so
 * exported packets inherit the plume's actual outgoing velocity instead of
 * ambient wind (the single biggest cause of "a dome appears out of nowhere
 * and just sits there" at retirement).
 */
export function kDownsampleMomentum(f: IslandFields, s: ScratchFields, uni: IslandUniforms): any {
  const N = f.N;
  const block = N / COARSE;
  const coarseCells = COARSE * COARSE * COARSE;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(coarseCells)), () => {
      const { x, y, z } = fieldCoord(s.coarseMom, instanceIndex);
      const acc = vec4(0.0).toVar();
      const cellVol = uni.h.mul(uni.h).mul(uni.h).toVar();
      Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i }: any) => {
        Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i: j }: any) => {
          Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i: k }: any) => {
            const cx = x.mul(int(block)).add(k).toVar();
            const cy = y.mul(int(block)).add(j).toVar();
            const cz = z.mul(int(block)).add(i).toVar();
            const m = f.dA.node.element(fieldIndex(f.dA, cx, cy, cz)).w.mul(cellVol).toVar();
            const vx = f.u.node.element(fieldIndex(f.u, cx, cy, cz))
              .add(f.u.node.element(fieldIndex(f.u, cx.add(int(1)), cy, cz))).mul(0.5);
            const vy = f.v.node.element(fieldIndex(f.v, cx, cy, cz))
              .add(f.v.node.element(fieldIndex(f.v, cx, cy.add(int(1)), cz))).mul(0.5);
            const vz = f.w.node.element(fieldIndex(f.w, cx, cy, cz))
              .add(f.w.node.element(fieldIndex(f.w, cx, cy, cz.add(int(1))))).mul(0.5);
            acc.addAssign(vec4(m.mul(vx), m.mul(vy), m.mul(vz), m));
          });
        });
      });
      s.coarseMom.node.element(instanceIndex).assign(acc);
    });
  })().compute(coarseCells);
}

/** Downsample |divergence| into a COARSE³ grid of (Σ|div|, max|div|, fluidCells, 0). */
export function kDownsampleAbsDiv(f: IslandFields, s: ScratchFields, dst: GpuField): any {
  const N = f.N;
  const block = N / COARSE;
  const coarseCells = COARSE * COARSE * COARSE;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(coarseCells)), () => {
      const { x, y, z } = fieldCoord(dst, instanceIndex);
      const acc = vec4(0.0).toVar();
      Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i }: any) => {
        Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i: j }: any) => {
          Loop({ start: int(0), end: int(block), type: 'int', condition: '<' }, ({ i: k }: any) => {
            const cx = x.mul(int(block)).add(k);
            const cy = y.mul(int(block)).add(j);
            const cz = z.mul(int(block)).add(i);
            const idx = fieldIndex(f.dA, cx, cy, cz).toVar();
            const d = s.div.node.element(idx).abs().toVar();
            const isFluid = s.solid.node.element(idx).x.lessThan(0.5).toFloat();
            acc.addAssign(vec4(d.mul(isFluid), 0.0, isFluid, 0.0));
            acc.y.assign(max(acc.y, d.mul(isFluid)));
          });
        });
      });
      dst.node.element(instanceIndex).assign(acc);
    });
  })().compute(coarseCells);
}

/** Scale density in the outer `shellVox` shell (used after boundary export to packets). */
export function kClearShell(f: IslandFields, uni: IslandUniforms): any {
  const cells = f.dA.count;
  const N = f.N;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const ex = min(float(x), float(N - 1).sub(float(x)));
      const ey = min(float(y), float(N - 1).sub(float(y)));
      const ez = min(float(z), float(N - 1).sub(float(z)));
      const edge = min(ex, min(ey, ez));
      If(edge.lessThan(uni.shellVox), () => {
        f.dA.node.element(instanceIndex).mulAssign(uni.shellKeep);
        f.dB.node.element(instanceIndex).mulAssign(uni.shellKeep);
      });
    });
  })().compute(cells);
}

/** Gather-shift a field by an integer voxel offset (island scrolling), zero-filling exposed cells. */
export function kShift(src: GpuField, dst: GpuField, uni: IslandUniforms): any {
  return Fn(() => {
    If(instanceIndex.lessThan(uint(src.count)), () => {
      const { x, y, z } = fieldCoord(src, instanceIndex);
      const sx = x.add(int(uni.shiftVox.x)).toVar();
      const sy = y.add(int(uni.shiftVox.y)).toVar();
      const sz = z.add(int(uni.shiftVox.z)).toVar();
      const inside = sx.greaterThanEqual(int(0)).and(sx.lessThan(int(src.nx)))
        .and(sy.greaterThanEqual(int(0))).and(sy.lessThan(int(src.ny)))
        .and(sz.greaterThanEqual(int(0))).and(sz.lessThan(int(src.nz)));
      const out = src.itemSize === 1 ? float(0).toVar() : vec4(0.0).toVar();
      If(inside, () => {
        out.assign(src.node.element(fieldIndex(src, sx, sy, sz)));
      });
      dst.node.element(instanceIndex).assign(out);
    });
  })().compute(src.count);
}

export function kCopy(src: GpuField, dst: GpuField): any {
  return Fn(() => {
    If(instanceIndex.lessThan(uint(src.count)), () => {
      dst.node.element(instanceIndex).assign(src.node.element(instanceIndex));
    });
  })().compute(src.count);
}

/** Voxelize promoted far-field packets into the island's density moments. */
export function kPacketDensity(f: IslandFields, s: ScratchFields, uni: IslandUniforms): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const p = vec3(float(x).add(0.5), float(y).add(0.5), float(z).add(0.5)).mul(uni.h).add(uni.origin).toVar();
      const addA = vec4(0.0).toVar();
      const addB = vec4(0.0).toVar();
      const cnt = int(uni.promoCount).toVar();
      Loop({ start: int(0), end: cnt, type: 'int', condition: '<' }, ({ i }: any) => {
        const base = i.mul(int(PROMO_STRIDE));
        const k0 = uni.promo.element(base).toVar(); // pos, loading0
        const k1 = uni.promo.element(base.add(int(1))).toVar(); // radii, phaseW0
        const k2 = uni.promo.element(base.add(int(2))).toVar(); // ext0 rgb
        const k3 = uni.promo.element(base.add(int(3))).toVar(); // scat0 rgb
        const rel = p.sub(k0.xyz).div(max(k1.xyz, vec3(1e-3))).toVar();
        const q = dot(rel, rel);
        If(q.lessThan(9.0), () => {
          const gaus = exp(q.mul(-0.5)).toVar();
          addA.addAssign(vec4(k2.xyz, k0.w).mul(gaus));
          addB.addAssign(vec4(k3.xyz, k1.w).mul(gaus));
        });
      });
      f.dA.node.element(instanceIndex).addAssign(addA);
      f.dB.node.element(instanceIndex).addAssign(addB);
    });
  })().compute(cells);
}

/** Blend face velocities toward promoted packet velocities (Gaussian-weighted). */
export function kPacketVelocity(f: IslandFields, uni: IslandUniforms, comp: 0 | 1 | 2): any {
  const field = comp === 0 ? f.u : comp === 1 ? f.v : f.w;
  const ox = comp === 0 ? 0.0 : 0.5;
  const oy = comp === 1 ? 0.0 : 0.5;
  const oz = comp === 2 ? 0.0 : 0.5;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(field.count)), () => {
      const { x, y, z } = fieldCoord(field, instanceIndex);
      const p = vec3(float(x).add(ox), float(y).add(oy), float(z).add(oz)).mul(uni.h).add(uni.origin).toVar();
      const vel = field.node.element(instanceIndex).toVar();
      const cnt = int(uni.promoCount).toVar();
      Loop({ start: int(0), end: cnt, type: 'int', condition: '<' }, ({ i }: any) => {
        const base = i.mul(int(PROMO_STRIDE));
        const k0 = uni.promo.element(base);
        const k1 = uni.promo.element(base.add(int(1)));
        const k4 = uni.promo.element(base.add(int(4)));
        const rel = p.sub(k0.xyz).div(max(k1.xyz, vec3(1e-3)));
        const gaus = exp(dot(rel, rel).mul(-0.5));
        const tc = comp === 0 ? k4.x : comp === 1 ? k4.y : k4.z;
        vel.addAssign(tc.sub(vel).mul(min(gaus, 1.0)));
      });
      field.node.element(instanceIndex).assign(vel);
    });
  })().compute(field.count);
}
