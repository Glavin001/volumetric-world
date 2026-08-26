/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';

/** Packing strides for uniform arrays shared between CPU packers and kernels. */
export const MAX_PRIMS = 24;
export const PRIM_STRIDE = 7; // q0 meta | q1 pos+planeStart | q2 quat | q3 params | q4 linVel+wakeEnabled | q5 angVel | q6 prevPos+boundR
export const MAX_PLANES = 96;
// Sized for a multi-building collapse: several structures × 3 emission events
// each can overlap in time (packEvents drops overflow silently).
export const MAX_EVENTS = 16;
export const EVT_STRIDE = 7; // e0 kinds+loadRate+phaseWRate | e1 pos+r | e2 aux+r2 | e3 quat | e4 extRate+momAux | e5 scatRate+momCouple | e6 momVec
export const MAX_EFFECTORS = 8;
export const EFF_STRIDE = 4; // f0 kind+radius+strength+aux | f1 posA | f2 posB/axis | f3 vel+couple
export const MAX_PROMO = 8;
export const PROMO_STRIDE = 5; // k0 pos+load0 | k1 radii+phaseW0 | k2 ext0 | k3 scat0 | k4 vel

export const PRIM_KIND = { sphere: 0, box: 1, capsule: 2, convex: 3 } as const;
export const SRC_KIND = { sphere: 0, box: 1, capsule: 2 } as const;
export const MOM_KIND = { none: 0, uniform: 1, radial: 2, vector: 3 } as const;
export const EFF_KIND = { jet: 0, vortexRing: 1, windVolume: 2, impulse: 3 } as const;

function vec4Array(n: number): THREE.Vector4[] {
  return Array.from({ length: n }, () => new THREE.Vector4());
}

/** Per-island uniforms; CPU mutates values, GPU kernels close over the nodes. */
export class IslandUniforms {
  // Grid placement
  origin = uniform(new THREE.Vector3());
  h = uniform(0.25);
  invH = uniform(4);
  sizeM = uniform(8);
  dt = uniform(1 / 30);
  timeS = uniform(0);

  // Forces / material response
  wind = uniform(new THREE.Vector3());
  buoyK = uniform(1); // dust-loading coupling (negative buoyancy scale)
  vortEps = uniform(2.2); // vorticity confinement ε (scaled by h in kernel)
  windCouple = uniform(0.25);
  dissFactor = uniform(1); // exp(-dissipation·dt), precomputed per step
  /** Extinction multiplier for the sun-shadow march only (film translucency trick). */
  shadowDensity = uniform(0.35);
  settleMps = uniform(0.0);
  maxVel = uniform(35);

  // Colliders
  primCount = uniform(0);
  prims = uniformArray(vec4Array(MAX_PRIMS * PRIM_STRIDE));
  planes = uniformArray(vec4Array(MAX_PLANES));

  // Emission events + effectors + promoted packets
  evtCount = uniform(0);
  events = uniformArray(vec4Array(MAX_EVENTS * EVT_STRIDE));
  effCount = uniform(0);
  effs = uniformArray(vec4Array(MAX_EFFECTORS * EFF_STRIDE));
  promoCount = uniform(0);
  promo = uniformArray(vec4Array(MAX_PROMO * PROMO_STRIDE));

  // Atlas slot + light
  slotOffsetVox = uniform(new THREE.Vector3());
  sunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.2));
  shellKeep = uniform(0); // clearShell keep factor
  shellVox = uniform(2);
  shiftVox = uniform(new THREE.Vector3());

  /** CPU-side mirrors for packing (same objects as uniformArray values). */
  get primsArray(): THREE.Vector4[] {
    return (this.prims as any).array as THREE.Vector4[];
  }
  get planesArray(): THREE.Vector4[] {
    return (this.planes as any).array as THREE.Vector4[];
  }
  get eventsArray(): THREE.Vector4[] {
    return (this.events as any).array as THREE.Vector4[];
  }
  get effsArray(): THREE.Vector4[] {
    return (this.effs as any).array as THREE.Vector4[];
  }
  get promoArray(): THREE.Vector4[] {
    return (this.promo as any).array as THREE.Vector4[];
  }
}
