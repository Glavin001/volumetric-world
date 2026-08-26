/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, int, uint, uvec3, vec3, vec4,
  min, max, clamp, exp, sqrt, length, dot, smoothstep, mix,
  instanceIndex, textureStore, texture3D,
} from 'three/tsl';
import { GpuField, fieldCoord, fieldIndex } from './fields';
import { IslandUniforms, MAX_PROMO, PROMO_STRIDE } from './uniforms';
import type { IslandFields, ScratchFields } from './solverKernels';

export const COARSE = 16;

export interface VolumeAtlas {
  texA: THREE.Storage3DTexture; // σt rgb, loading
  texB: THREE.Storage3DTexture; // albedo rgb, g encoded
  texVel: THREE.Storage3DTexture; // velocity xyz (m/s)
  texShadow: THREE.Storage3DTexture; // sqrt(sun transmittance)
  dimX: number;
  dimY: number;
  dimZ: number;
  slotRes: number;
}

export function createAtlas(slotRes: number, slots: number): VolumeAtlas {
  const sx = Math.min(slots, 2);
  const sy = Math.ceil(slots / 2);
  const dimX = slotRes * sx;
  const dimY = slotRes * sy;
  const dimZ = slotRes;
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
    slotRes,
  };
}

export function slotOffsetVox(atlas: VolumeAtlas, slot: number): [number, number, number] {
  const sx = Math.floor(atlas.dimX / atlas.slotRes);
  return [(slot % sx) * atlas.slotRes, Math.floor(slot / sx) * atlas.slotRes, 0];
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
  upload(atlas.texShadow, 4, (b) => b.fill(0xff));
}

const MAX_SIGMA_T = 250.0;

/** Bake density moments + center velocity into the render atlas (with soft slot-edge fade). */
export function kWriteVolume(f: IslandFields, s: ScratchFields, uni: IslandUniforms, atlas: VolumeAtlas): any {
  const cells = f.dA.count;
  const N = f.N;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const a = f.dA.node.element(instanceIndex).toVar();
      const b = f.dB.node.element(instanceIndex).toVar();

      // Soft 2-voxel fade at slot edges: keeps trilinear sampling from bleeding
      // across atlas slots and gives islands soft open boundaries.
      const ex = min(float(x), float(N - 1).sub(float(x)));
      const ey = min(float(y), float(N - 1).sub(float(y)));
      const ez = min(float(z), float(N - 1).sub(float(z)));
      const edge = min(ex, min(ey, ez)).add(0.5);
      const fade = smoothstep(0.0, 2.0, edge);

      const sigma = clamp(a.xyz.mul(fade), vec3(0.0), vec3(MAX_SIGMA_T)).toVar();
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
      Loop({ start: int(1), end: int(lightSteps), type: 'int', condition: '<=' }, ({ i }: any) => {
        const q = p.add(uni.sunDir.mul(stepLen.mul(float(i).sub(0.5)))).toVar();
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
        od.addAssign(dot(sig, vec3(0.2126, 0.7152, 0.0722)).mul(stepLen));
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
      textureStore(atlas.texShadow, texel, vec4(sqrt(trans), 0.0, 0.0, 1.0)).toWriteOnly();
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
      textureStore(atlas.texShadow, texel, vec4(1.0)).toWriteOnly();
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
