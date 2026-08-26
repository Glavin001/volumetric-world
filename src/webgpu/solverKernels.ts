/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TSL compute kernels for one MAC-grid fluid island.
 *
 * Grid layout (y-up, cell size h, island origin at the min corner):
 *   u: (N+1)·N·N x-face field       v: N·(N+1)·N y-faces      w: N·N·(N+1) z-faces
 *   cell-centered vec4 moments: dA = (σt_rgb, loading), dB = (σs_rgb, g·lum(σs))
 *   solid: vec4 (solidFrac, solidVel.xyz), pressure/divergence: scalar.
 *
 * Every kernel stays within 10 storage buffers / 4 storage textures per stage
 * (the WebGPU core limits; verified against SwiftShader).
 */
import {
  Fn, If, Loop, float, int, uint, vec3, vec4,
  min, max, clamp, abs, normalize, length, dot, cross, smoothstep, select,
  instanceIndex,
} from 'three/tsl';
import { GpuField, fieldCoord, fieldIndex, loadClamped, sampleLinear, neighborhoodMinMax } from './fields';
import {
  IslandUniforms, MAX_PRIMS, PRIM_STRIDE, MAX_EVENTS, EVT_STRIDE, MAX_EFFECTORS, EFF_STRIDE,
  MAX_PROMO, PROMO_STRIDE,
} from './uniforms';

export interface IslandFields {
  N: number;
  u: GpuField; v: GpuField; w: GpuField;
  dA: GpuField; dB: GpuField;
}

export interface ScratchFields {
  uT: GpuField; vT: GpuField; wT: GpuField;
  dHatA: GpuField; dHatB: GpuField;
  dTilA: GpuField; dTilB: GpuField;
  posBuf: GpuField;
  p0: GpuField; p1: GpuField;
  div: GpuField;
  curl: GpuField;
  solid: GpuField;
  coarseMass: GpuField;
  coarseDivPre: GpuField;
  coarseDivPost: GpuField;
  /** vec4[1]: x = pre-advection mass, y = post-advection mass (renormalization). */
  massStat: GpuField;
}

type Uni = IslandUniforms;

const GRAVITY = 9.81;
const RHO_AIR = 1.2;

/** Rotate v by quaternion q. */
function qRot(q: any, v: any): any {
  const t = cross(q.xyz, v).mul(2.0);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}
/** Rotate v by conjugate(q) (world → shape local). */
function qRotInv(q: any, v: any): any {
  const qc = vec4(q.xyz.negate(), q.w);
  return qRot(qc, v);
}

/** World position helpers for lattice coords of each field kind. */
function cellWorld(uni: Uni, x: any, y: any, z: any): any {
  return vec3(float(x).add(0.5), float(y).add(0.5), float(z).add(0.5)).mul(uni.h).add(uni.origin);
}
function faceWorld(uni: Uni, comp: 0 | 1 | 2, x: any, y: any, z: any): any {
  const ox = comp === 0 ? 0.0 : 0.5;
  const oy = comp === 1 ? 0.0 : 0.5;
  const oz = comp === 2 ? 0.0 : 0.5;
  return vec3(float(x).add(ox), float(y).add(oy), float(z).add(oz)).mul(uni.h).add(uni.origin);
}

/** Continuous lattice coords of world p for each field kind. */
function cellLat(uni: Uni, p: any): any {
  return p.sub(uni.origin).mul(uni.invH).sub(vec3(0.5, 0.5, 0.5));
}
function faceLat(uni: Uni, comp: 0 | 1 | 2, p: any): any {
  const off = comp === 0 ? vec3(0.0, 0.5, 0.5) : comp === 1 ? vec3(0.5, 0.0, 0.5) : vec3(0.5, 0.5, 0.0);
  return p.sub(uni.origin).mul(uni.invH).sub(off);
}

/** Trilinear MAC velocity sample at world position. */
function velAt(fields: IslandFields, uni: Uni, p: any): any {
  const su = sampleLinear(fields.u, faceLat(uni, 0, p));
  const sv = sampleLinear(fields.v, faceLat(uni, 1, p));
  const sw = sampleLinear(fields.w, faceLat(uni, 2, p));
  return vec3(su, sv, sw);
}

/** Signed distance to primitive `pi` (int node) at world p; also returns boundary velocity. */
function primDistance(uni: Uni, pi: any, p: any): { dist: any; vel: any } {
  const base = pi.mul(int(PRIM_STRIDE));
  const q0 = uni.prims.element(base).toVar(); // kind, solidFlag, wakeScale, dragCoef
  const q1 = uni.prims.element(base.add(int(1))).toVar(); // pos, planeStart
  const q2 = uni.prims.element(base.add(int(2))).toVar(); // quat
  const q3 = uni.prims.element(base.add(int(3))).toVar(); // params
  const q4 = uni.prims.element(base.add(int(4))).toVar(); // linVel, wakeEnabled
  const q5 = uni.prims.element(base.add(int(5))).toVar(); // angVel

  const rel = p.sub(q1.xyz).toVar();
  const local = qRotInv(q2, rel).toVar();
  const kind = q0.x;
  const dist = float(1e9).toVar();

  If(kind.lessThan(0.5), () => {
    dist.assign(length(rel).sub(q3.x));
  }).ElseIf(kind.lessThan(1.5), () => {
    const d = abs(local).sub(q3.xyz).toVar();
    const outside = length(max(d, vec3(0.0)));
    const inside = min(max(d.x, max(d.y, d.z)), 0.0);
    dist.assign(outside.add(inside));
  }).ElseIf(kind.lessThan(2.5), () => {
    // Capsule along local axis q3.z (0/1/2), radius q3.x, half segment q3.y.
    const ax = q3.z;
    const axisCoord = select(ax.lessThan(0.5), local.x, select(ax.lessThan(1.5), local.y, local.z));
    const t = clamp(axisCoord, q3.y.negate(), q3.y);
    const axisVec = vec3(
      select(ax.lessThan(0.5), t, 0.0),
      select(ax.greaterThanEqual(0.5).and(ax.lessThan(1.5)), t, 0.0),
      select(ax.greaterThanEqual(1.5), t, 0.0),
    );
    dist.assign(length(local.sub(axisVec)).sub(q3.x));
  }).Else(() => {
    // Convex: max over inward plane distances.
    const start = int(q1.w).toVar();
    const count = int(q3.x).toVar();
    const dmax = float(-1e9).toVar();
    Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: any) => {
      const pl = uni.planes.element(start.add(i));
      dmax.assign(max(dmax, dot(pl.xyz, local).sub(pl.w)));
    });
    dist.assign(dmax);
  });

  const vel = q4.xyz.add(cross(q5.xyz, rel));
  return { dist, vel };
}

/** Emission profile 0..1 for event `ei` at world p. */
function eventProfile(uni: Uni, ei: any, p: any): any {
  const base = ei.mul(int(EVT_STRIDE));
  const e0 = uni.events.element(base).toVar();
  const e1 = uni.events.element(base.add(int(1))).toVar();
  const e2 = uni.events.element(base.add(int(2))).toVar();
  const e3 = uni.events.element(base.add(int(3))).toVar();
  const prof = float(0).toVar();
  const srcKind = e0.x;
  If(srcKind.lessThan(0.5), () => {
    const r = length(p.sub(e1.xyz)).div(max(e1.w, 1e-4));
    prof.assign(smoothstep(1.0, 0.55, r));
  }).ElseIf(srcKind.lessThan(1.5), () => {
    const local = qRotInv(e3, p.sub(e1.xyz)).toVar();
    const q = abs(local).div(max(e2.xyz, vec3(1e-4))).toVar();
    const fx = smoothstep(1.0, 0.75, q.x);
    const fy = smoothstep(1.0, 0.75, q.y);
    const fz = smoothstep(1.0, 0.75, q.z);
    prof.assign(fx.mul(fy).mul(fz));
  }).Else(() => {
    const a = e1.xyz;
    const b = e2.xyz;
    const ab = b.sub(a).toVar();
    const t = clamp(dot(p.sub(a), ab).div(max(dot(ab, ab), 1e-6)), 0.0, 1.0);
    const d = length(p.sub(a.add(ab.mul(t)))).div(max(e1.w, 1e-4));
    prof.assign(smoothstep(1.0, 0.55, d));
  });
  return prof;
}

// ---------------------------------------------------------------------------
// Kernel builders (each returns a ComputeNode)
// ---------------------------------------------------------------------------

export function kRasterizeSolid(f: IslandFields, s: ScratchFields, uni: Uni): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(s.solid, instanceIndex);
      const p = cellWorld(uni, x, y, z).toVar();
      const out = vec4(0.0).toVar();
      const cnt = int(uni.primCount).toVar();
      Loop({ start: int(0), end: cnt, type: 'int', condition: '<' }, ({ i }: any) => {
        const meta = uni.prims.element(i.mul(int(PRIM_STRIDE)));
        If(meta.y.greaterThan(0.5), () => {
          const { dist, vel } = primDistance(uni, i, p);
          // Conservative half-voxel dilation keeps thin walls airtight.
          If(dist.lessThan(uni.h.mul(0.45)), () => {
            out.assign(vec4(1.0, vel));
          });
        });
      });
      s.solid.node.element(instanceIndex).assign(out);
    });
  })().compute(cells);
}

export function kInjectDensity(f: IslandFields, s: ScratchFields, uni: Uni): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const p = cellWorld(uni, x, y, z).toVar();
      const solid = s.solid.node.element(instanceIndex).x;
      If(solid.lessThan(0.5), () => {
        const addA = vec4(0.0).toVar();
        const addB = vec4(0.0).toVar();
        const cnt = int(uni.evtCount).toVar();
        Loop({ start: int(0), end: cnt, type: 'int', condition: '<' }, ({ i }: any) => {
          const prof = eventProfile(uni, i, p).toVar();
          If(prof.greaterThan(0.001), () => {
            const base = i.mul(int(EVT_STRIDE));
            const e0 = uni.events.element(base);
            const e4 = uni.events.element(base.add(int(4)));
            const e5 = uni.events.element(base.add(int(5)));
            const k = prof.mul(uni.dt);
            addA.addAssign(vec4(e4.xyz, e0.z).mul(k));
            addB.addAssign(vec4(e5.xyz, e0.w).mul(k));
          });
        });
        f.dA.node.element(instanceIndex).addAssign(addA);
        f.dB.node.element(instanceIndex).addAssign(addB);
      });
    });
  })().compute(cells);
}

/** Momentum from events, effectors, and body wakes onto one velocity component. */
export function kInjectVelocity(f: IslandFields, s: ScratchFields, uni: Uni, comp: 0 | 1 | 2): any {
  const field = comp === 0 ? f.u : comp === 1 ? f.v : f.w;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(field.count)), () => {
      const { x, y, z } = fieldCoord(field, instanceIndex);
      const p = faceWorld(uni, comp, x, y, z).toVar();
      const vel = field.node.element(instanceIndex).toVar();

      // --- emission momentum ---
      const cnt = int(uni.evtCount).toVar();
      Loop({ start: int(0), end: cnt, type: 'int', condition: '<' }, ({ i }: any) => {
        const prof = eventProfile(uni, i, p).toVar();
        If(prof.greaterThan(0.001), () => {
          const base = i.mul(int(EVT_STRIDE));
          const e0 = uni.events.element(base);
          const e1 = uni.events.element(base.add(int(1)));
          const e4 = uni.events.element(base.add(int(4)));
          const e5 = uni.events.element(base.add(int(5)));
          const e6 = uni.events.element(base.add(int(6)));
          const momKind = e0.y;
          If(momKind.greaterThan(0.5).and(momKind.lessThan(1.5)), () => {
            // uniform: relax toward target velocity
            const target = comp === 0 ? e6.x : comp === 1 ? e6.y : e6.z;
            const kk = min(prof.mul(e5.w).mul(uni.dt), 1.0);
            vel.addAssign(target.sub(vel).mul(kk));
          }).ElseIf(momKind.lessThan(2.5), () => {
            // radial acceleration from volume center (+ optional bias in e6)
            const dir = normalize(p.sub(e1.xyz).add(e6.xyz.mul(0.25)).add(vec3(0.0, 1e-5, 0.0)));
            const dc = comp === 0 ? dir.x : comp === 1 ? dir.y : dir.z;
            vel.addAssign(dc.mul(e4.w).mul(prof).mul(uni.dt));
          }).ElseIf(momKind.lessThan(3.5), () => {
            const ac = comp === 0 ? e6.x : comp === 1 ? e6.y : e6.z;
            vel.addAssign(ac.mul(prof).mul(uni.dt));
          });
        });
      });

      // --- flow effectors ---
      const ecnt = int(uni.effCount).toVar();
      Loop({ start: int(0), end: ecnt, type: 'int', condition: '<' }, ({ i }: any) => {
        const base = i.mul(int(EFF_STRIDE));
        const f0 = uni.effs.element(base).toVar(); // kind, radius, strength, aux
        const f1 = uni.effs.element(base.add(int(1))).toVar(); // posA
        const f2 = uni.effs.element(base.add(int(2))).toVar(); // posB / axis
        const f3 = uni.effs.element(base.add(int(3))).toVar(); // vel, couple
        const kind = f0.x;
        If(kind.lessThan(0.5), () => {
          // jet: capsule from posA along dir (f2) with length aux
          const a = f1.xyz;
          const b = f1.xyz.add(f2.xyz.mul(f0.w)).toVar();
          const ab = b.sub(a).toVar();
          const t = clamp(dot(p.sub(a), ab).div(max(dot(ab, ab), 1e-6)), 0.0, 1.0);
          const d = length(p.sub(a.add(ab.mul(t))));
          const fall = smoothstep(f0.y, f0.y.mul(0.4), d);
          If(fall.greaterThan(0.001), () => {
            const target = f2.xyz.mul(f0.z);
            const tc = comp === 0 ? target.x : comp === 1 ? target.y : target.z;
            const kk = min(f3.w.mul(uni.dt).mul(fall), 1.0);
            vel.addAssign(tc.sub(vel).mul(kk));
          });
        }).ElseIf(kind.lessThan(1.5), () => {
          // vortex ring: swirl around a circle of radius f0.y, axis f2, circulation f0.z
          const rel = p.sub(f1.xyz).toVar();
          const ax = normalize(f2.xyz).toVar();
          const zc = dot(rel, ax);
          const pr = rel.sub(ax.mul(zc)).toVar();
          const rlen = max(length(pr), 1e-4);
          const rhat = pr.div(rlen).toVar();
          const ringPt = f1.xyz.add(rhat.mul(f0.y)).toVar();
          const dvec = p.sub(ringPt).toVar();
          const core = max(f0.y.mul(0.28), 0.05);
          const d2 = dot(dvec, dvec).add(core.mul(core)).toVar();
          const that = cross(ax, rhat).toVar();
          const swirl = cross(that, dvec).div(d2).mul(f0.z.mul(0.159155)).toVar();
          const sc = comp === 0 ? swirl.x : comp === 1 ? swirl.y : swirl.z;
          vel.addAssign(sc.mul(uni.dt).mul(f3.w));
        }).ElseIf(kind.lessThan(2.5), () => {
          // wind volume (sphere): relax toward f3.xyz
          const d = length(p.sub(f1.xyz));
          const fall = smoothstep(f0.y, f0.y.mul(0.5), d);
          If(fall.greaterThan(0.001), () => {
            const tc = comp === 0 ? f3.x : comp === 1 ? f3.y : f3.z;
            const kk = min(f3.w.mul(uni.dt).mul(fall), 1.0);
            vel.addAssign(tc.sub(vel).mul(kk));
          });
        }).Else(() => {
          // impulse (sphere): acceleration f3.xyz for this step
          const d = length(p.sub(f1.xyz));
          const fall = smoothstep(f0.y, f0.y.mul(0.4), d);
          const ac = comp === 0 ? f3.x : comp === 1 ? f3.y : f3.z;
          vel.addAssign(ac.mul(fall).mul(uni.dt));
        });
      });

      // --- body wakes (swept capsule between prev and current transform) ---
      const pcnt = int(uni.primCount).toVar();
      Loop({ start: int(0), end: pcnt, type: 'int', condition: '<' }, ({ i }: any) => {
        const base = i.mul(int(PRIM_STRIDE));
        const q0 = uni.prims.element(base).toVar();
        const q4 = uni.prims.element(base.add(int(4))).toVar();
        If(q4.w.greaterThan(0.5), () => {
          const speed = length(q4.xyz);
          If(speed.greaterThan(0.3), () => {
            const q1 = uni.prims.element(base.add(int(1)));
            const q6 = uni.prims.element(base.add(int(6)));
            const a = q6.xyz;
            const b = q1.xyz;
            const ab = b.sub(a).toVar();
            const t = clamp(dot(p.sub(a), ab).div(max(dot(ab, ab), 1e-6)), 0.0, 1.0);
            const d = length(p.sub(a.add(ab.mul(t))));
            const reach = q6.w.mul(1.15).add(uni.h.mul(1.5));
            const fall = smoothstep(reach, reach.mul(0.3), d).toVar();
            If(fall.greaterThan(0.001), () => {
              const target = q4.xyz.mul(q0.z);
              const tc = comp === 0 ? target.x : comp === 1 ? target.y : target.z;
              const kk = min(q0.w.mul(speed).mul(uni.dt).mul(2.0).div(max(reach, 0.2)).mul(fall), 0.9);
              vel.addAssign(tc.sub(vel).mul(kk));
            });
          });
        });
      });

      field.node.element(instanceIndex).assign(vel);
    });
  })().compute(field.count);
}

/** RK2 semi-Lagrangian advection of one velocity component into scratch. */
export function kAdvectVelocity(f: IslandFields, s: ScratchFields, uni: Uni, comp: 0 | 1 | 2): any {
  const src = comp === 0 ? f.u : comp === 1 ? f.v : f.w;
  const dst = comp === 0 ? s.uT : comp === 1 ? s.vT : s.wT;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(src.count)), () => {
      const { x, y, z } = fieldCoord(src, instanceIndex);
      const p = faceWorld(uni, comp, x, y, z).toVar();
      const v1 = velAt(f, uni, p).toVar();
      const pm = p.sub(v1.mul(uni.dt.mul(0.5))).toVar();
      const v2 = velAt(f, uni, pm).toVar();
      const back = p.sub(v2.mul(uni.dt)).toVar();
      dst.node.element(instanceIndex).assign(sampleLinear(src, faceLat(uni, comp, back)));
    });
  })().compute(src.count);
}

/** Cell-centered vorticity ω (vec3) + |ω| from the MAC field. */
export function kCurl(f: IslandFields, s: ScratchFields, uni: Uni): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(s.curl, instanceIndex);
      // Center velocities of neighbor cells (each an average of two faces).
      const cvel = (cx: any, cy: any, cz: any) => {
        const ux = loadClamped(f.u, cx, cy, cz).add(loadClamped(f.u, cx.add(int(1)), cy, cz)).mul(0.5);
        const vy = loadClamped(f.v, cx, cy, cz).add(loadClamped(f.v, cx, cy.add(int(1)), cz)).mul(0.5);
        const wz = loadClamped(f.w, cx, cy, cz).add(loadClamped(f.w, cx, cy, cz.add(int(1)))).mul(0.5);
        return vec3(ux, vy, wz);
      };
      const inv2h = uni.invH.mul(0.5);
      const vxp = cvel(x.add(int(1)), y, z).toVar();
      const vxm = cvel(x.sub(int(1)), y, z).toVar();
      const vyp = cvel(x, y.add(int(1)), z).toVar();
      const vym = cvel(x, y.sub(int(1)), z).toVar();
      const vzp = cvel(x, y, z.add(int(1))).toVar();
      const vzm = cvel(x, y, z.sub(int(1))).toVar();
      const wx = vyp.z.sub(vym.z).sub(vzp.y.sub(vzm.y)).mul(inv2h);
      const wy = vzp.x.sub(vzm.x).sub(vxp.z.sub(vxm.z)).mul(inv2h);
      const wzc = vxp.y.sub(vxm.y).sub(vyp.x.sub(vym.x)).mul(inv2h);
      const w3 = vec3(wx, wy, wzc).toVar();
      s.curl.node.element(instanceIndex).assign(vec4(w3, length(w3)));
    });
  })().compute(cells);
}

/** Forces on one velocity component (in scratch): dust loading, wind coupling, vorticity confinement. */
export function kForces(f: IslandFields, s: ScratchFields, uni: Uni, comp: 0 | 1 | 2): any {
  const field = comp === 0 ? s.uT : comp === 1 ? s.vT : s.wT;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(field.count)), () => {
      const { x, y, z } = fieldCoord(field, instanceIndex);
      const vel = field.node.element(instanceIndex).toVar();

      // Cells straddling this face (clamped at the boundary).
      const axisOffX = int(comp === 0 ? 1 : 0);
      const axisOffY = int(comp === 1 ? 1 : 0);
      const axisOffZ = int(comp === 2 ? 1 : 0);
      const xm = clamp(x.sub(axisOffX), int(0), int(f.dA.nx - 1)).toVar();
      const ym = clamp(y.sub(axisOffY), int(0), int(f.dA.ny - 1)).toVar();
      const zm = clamp(z.sub(axisOffZ), int(0), int(f.dA.nz - 1)).toVar();
      const xp = clamp(x, int(0), int(f.dA.nx - 1)).toVar();
      const yp = clamp(y, int(0), int(f.dA.ny - 1)).toVar();
      const zp = clamp(z, int(0), int(f.dA.nz - 1)).toVar();
      const idxM = fieldIndex(f.dA, xm, ym, zm).toVar();
      const idxP = fieldIndex(f.dA, xp, yp, zp).toVar();

      if (comp === 1) {
        // Cold-dust density loading: f = −g·k·ρ_dust (ŷ). loading is kg/m³;
        // capped near 2× air density so extreme sources stay integrable.
        const load = f.dA.node.element(idxM).w.add(f.dA.node.element(idxP).w).mul(0.5);
        const accel = min(load.div(RHO_AIR), 2.2).mul(GRAVITY).mul(uni.buoyK);
        vel.subAssign(accel.mul(uni.dt));
      }

      // Ambient wind coupling (entrainment-flavored relaxation).
      const windC = comp === 0 ? uni.wind.x : comp === 1 ? uni.wind.y : uni.wind.z;
      vel.addAssign(windC.sub(vel).mul(min(uni.windCouple.mul(uni.dt), 1.0)));

      // Vorticity confinement: f = ε·h·(N̂ × ω), N = ∇|ω|.
      const wM = s.curl.node.element(idxM).toVar();
      const wP = s.curl.node.element(idxP).toVar();
      const wFace = wM.add(wP).mul(0.5).toVar();
      // ∇|ω| via neighbor magnitudes around the two cells (cheap face-centered estimate).
      const mag = (cx: any, cy: any, cz: any) =>
        s.curl.node.element(fieldIndex(f.dA, clamp(cx, int(0), int(f.dA.nx - 1)), clamp(cy, int(0), int(f.dA.ny - 1)), clamp(cz, int(0), int(f.dA.nz - 1)))).w;
      const gx = mag(xp.add(int(1)), yp, zp).sub(mag(xp.sub(int(1)), yp, zp));
      const gy = mag(xp, yp.add(int(1)), zp).sub(mag(xp, yp.sub(int(1)), zp));
      const gz = mag(xp, yp, zp.add(int(1))).sub(mag(xp, yp, zp.sub(int(1))));
      const grad = vec3(gx, gy, gz).toVar();
      const gl = length(grad).toVar();
      If(gl.greaterThan(1e-5).and(wFace.w.greaterThan(1e-4)), () => {
        const Nn = grad.div(gl);
        const fc = cross(Nn, wFace.xyz).mul(uni.vortEps.mul(uni.h)).toVar();
        const fcc = comp === 0 ? fc.x : comp === 1 ? fc.y : fc.z;
        vel.addAssign(fcc.mul(uni.dt));
      });

      vel.assign(clamp(vel, uni.maxVel.negate(), uni.maxVel));
      field.node.element(instanceIndex).assign(vel);
    });
  })().compute(field.count);
}

/**
 * Divergence with moving solid boundaries: faces adjacent to a solid cell use
 * the solid's boundary-normal velocity, so pressure projection displaces air.
 */
export function kDivergence(f: IslandFields, s: ScratchFields, uni: Uni, fromMain: boolean): any {
  const cells = f.dA.count;
  const U = fromMain ? f.u : s.uT;
  const V = fromMain ? f.v : s.vT;
  const W = fromMain ? f.w : s.wT;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(s.div, instanceIndex);
      const solidC = s.solid.node.element(instanceIndex).toVar();
      const out = float(0).toVar();
      If(solidC.x.lessThan(0.5), () => {
        const N = f.N;
        const solidAt = (cx: any, cy: any, cz: any) =>
          s.solid.node.element(
            fieldIndex(f.dA, clamp(cx, int(0), int(N - 1)), clamp(cy, int(0), int(N - 1)), clamp(cz, int(0), int(N - 1))),
          );
        // For each face: use fluid face velocity unless the neighbor is solid.
        const faceVel = (F: GpuField, fx: any, fy: any, fz: any, nbx: any, nby: any, nbz: any, compSel: 0 | 1 | 2, inBounds: any) => {
          const v = F.node.element(fieldIndex(F, fx, fy, fz)).toVar();
          If(inBounds, () => {
            const nb = solidAt(nbx, nby, nbz).toVar();
            If(nb.x.greaterThan(0.5), () => {
              v.assign(compSel === 0 ? nb.y : compSel === 1 ? nb.z : nb.w);
            });
          });
          return v;
        };
        const uL = faceVel(U, x, y, z, x.sub(int(1)), y, z, 0, x.greaterThan(int(0)));
        const uR = faceVel(U, x.add(int(1)), y, z, x.add(int(1)), y, z, 0, x.lessThan(int(N - 1)));
        const vB = faceVel(V, x, y, z, x, y.sub(int(1)), z, 1, y.greaterThan(int(0)));
        const vT2 = faceVel(V, x, y.add(int(1)), z, x, y.add(int(1)), z, 1, y.lessThan(int(N - 1)));
        const wK = faceVel(W, x, y, z, x, y, z.sub(int(1)), 2, z.greaterThan(int(0)));
        const wF = faceVel(W, x, y, z.add(int(1)), x, y, z.add(int(1)), 2, z.lessThan(int(N - 1)));
        out.assign(uR.sub(uL).add(vT2.sub(vB)).add(wF.sub(wK)).mul(uni.invH));
      });
      s.div.node.element(instanceIndex).assign(out);
    });
  })().compute(cells);
}

export function kClearScalar(field: GpuField): any {
  return Fn(() => {
    If(instanceIndex.lessThan(uint(field.count)), () => {
      field.node.element(instanceIndex).assign(field.itemSize === 1 ? float(0) : vec4(0.0));
    });
  })().compute(field.count);
}

/**
 * One weighted-Jacobi iteration: solid neighbors are Neumann (dropped from the
 * stencil), island-boundary neighbors are open (Dirichlet p=0).
 */
export function kJacobi(f: IslandFields, s: ScratchFields, uni: Uni, srcP: GpuField, dstP: GpuField): any {
  const cells = f.dA.count;
  const N = f.N;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(dstP, instanceIndex);
      const solidC = s.solid.node.element(instanceIndex).x;
      const out = float(0).toVar();
      If(solidC.lessThan(0.5), () => {
        const sum = float(0).toVar();
        const diag = float(0).toVar();
        const tap = (cx: any, cy: any, cz: any, inside: any) => {
          If(inside, () => {
            const ni = fieldIndex(f.dA, cx, cy, cz).toVar();
            const nsolid = s.solid.node.element(ni).x;
            If(nsolid.lessThan(0.5), () => {
              sum.addAssign(srcP.node.element(ni));
              diag.addAssign(1.0);
            });
            // solid neighbor: Neumann → excluded from sum and diagonal
          }).Else(() => {
            diag.addAssign(1.0); // open boundary: p=0 Dirichlet keeps diagonal
          });
        };
        tap(x.sub(int(1)), y, z, x.greaterThan(int(0)));
        tap(x.add(int(1)), y, z, x.lessThan(int(N - 1)));
        tap(x, y.sub(int(1)), z, y.greaterThan(int(0)));
        tap(x, y.add(int(1)), z, y.lessThan(int(N - 1)));
        tap(x, y, z.sub(int(1)), z.greaterThan(int(0)));
        tap(x, y, z.add(int(1)), z.lessThan(int(N - 1)));
        const b = s.div.node.element(instanceIndex);
        If(diag.greaterThan(0.5), () => {
          out.assign(sum.sub(b.mul(uni.h).mul(uni.h)).div(diag));
        });
      });
      dstP.node.element(instanceIndex).assign(out);
    });
  })().compute(cells);
}

/**
 * Pressure projection: subtract ∇p from scratch velocity and write into the
 * persistent MAC field; solid faces take the solid's velocity component.
 */
export function kProject(f: IslandFields, s: ScratchFields, uni: Uni, comp: 0 | 1 | 2, pField: GpuField): any {
  const srcVel = comp === 0 ? s.uT : comp === 1 ? s.vT : s.wT;
  const dstVel = comp === 0 ? f.u : comp === 1 ? f.v : f.w;
  const N = f.N;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(srcVel.count)), () => {
      const { x, y, z } = fieldCoord(srcVel, instanceIndex);
      const vel = srcVel.node.element(instanceIndex).toVar();

      const axX = int(comp === 0 ? 1 : 0);
      const axY = int(comp === 1 ? 1 : 0);
      const axZ = int(comp === 2 ? 1 : 0);
      const mInside = (comp === 0 ? x : comp === 1 ? y : z).greaterThan(int(0));
      const pInside = (comp === 0 ? x : comp === 1 ? y : z).lessThan(int(N));

      const cxm = x.sub(axX).toVar();
      const cym = y.sub(axY).toVar();
      const czm = z.sub(axZ).toVar();

      const pM = float(0).toVar();
      const pP = float(0).toVar();
      const solidM = vec4(0.0).toVar();
      const solidP = vec4(0.0).toVar();
      If(mInside, () => {
        const mi = fieldIndex(f.dA, cxm, cym, czm).toVar();
        pM.assign(pField.node.element(mi));
        solidM.assign(s.solid.node.element(mi));
      });
      If(pInside, () => {
        const pidx = fieldIndex(f.dA, x, y, z).toVar();
        pP.assign(pField.node.element(pidx));
        solidP.assign(s.solid.node.element(pidx));
      });

      If(solidM.x.greaterThan(0.5).or(solidP.x.greaterThan(0.5)), () => {
        // Face on a solid boundary: match the solid's normal velocity.
        const sv = select(solidP.x.greaterThan(0.5), solidP, solidM);
        vel.assign(comp === 0 ? sv.y : comp === 1 ? sv.z : sv.w);
      }).Else(() => {
        vel.subAssign(pP.sub(pM).mul(uni.invH));
        vel.assign(clamp(vel, uni.maxVel.negate(), uni.maxVel));
      });
      dstVel.node.element(instanceIndex).assign(vel);
    });
  })().compute(srcVel.count);
}

/** MacCormack forward pass: RK2 backtrace (with settling), store position + advected moments. */
export function kDensityForward(f: IslandFields, s: ScratchFields, uni: Uni): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const p = cellWorld(uni, x, y, z).toVar();
      const settle = vec3(0.0, uni.settleMps.negate(), 0.0);
      const v1 = velAt(f, uni, p).add(settle).toVar();
      const pm = p.sub(v1.mul(uni.dt.mul(0.5))).toVar();
      const v2 = velAt(f, uni, pm).add(settle).toVar();
      const back = p.sub(v2.mul(uni.dt)).toVar();
      const lat = cellLat(uni, back).toVar();
      s.posBuf.node.element(instanceIndex).assign(vec4(lat, 0.0));
      s.dHatA.node.element(instanceIndex).assign(sampleLinear(f.dA, lat));
      s.dHatB.node.element(instanceIndex).assign(sampleLinear(f.dB, lat));
    });
  })().compute(cells);
}

/** MacCormack reverse pass: advect the forward result backwards (negated velocity). */
export function kDensityReverse(f: IslandFields, s: ScratchFields, uni: Uni): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const { x, y, z } = fieldCoord(f.dA, instanceIndex);
      const p = cellWorld(uni, x, y, z).toVar();
      const settle = vec3(0.0, uni.settleMps.negate(), 0.0);
      const v1 = velAt(f, uni, p).add(settle).toVar();
      const pm = p.add(v1.mul(uni.dt.mul(0.5))).toVar();
      const v2 = velAt(f, uni, pm).add(settle).toVar();
      const fwd = p.add(v2.mul(uni.dt)).toVar();
      const lat = cellLat(uni, fwd).toVar();
      s.dTilA.node.element(instanceIndex).assign(sampleLinear(s.dHatA, lat));
      s.dTilB.node.element(instanceIndex).assign(sampleLinear(s.dHatB, lat));
    });
  })().compute(cells);
}

/**
 * MacCormack correction with monotonic clamp against the source neighborhood,
 * plus dissipation. Falls back to the semi-Lagrangian value where the corrected
 * result overshoots (the clamp enforces this). Writes into dTil (safe in place).
 */
export function kDensityCorrect(f: IslandFields, s: ScratchFields, uni: Uni): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const lat = s.posBuf.node.element(instanceIndex).xyz.toVar();
      const hatA = s.dHatA.node.element(instanceIndex).toVar();
      const hatB = s.dHatB.node.element(instanceIndex).toVar();
      const n0A = f.dA.node.element(instanceIndex).toVar();
      const n0B = f.dB.node.element(instanceIndex).toVar();
      const tilA = s.dTilA.node.element(instanceIndex).toVar();
      const tilB = s.dTilB.node.element(instanceIndex).toVar();

      const corrA = hatA.add(n0A.sub(tilA).mul(0.5)).toVar();
      const corrB = hatB.add(n0B.sub(tilB).mul(0.5)).toVar();

      const nbA = neighborhoodMinMax(f.dA, lat);
      const nbB = neighborhoodMinMax(f.dB, lat);
      corrA.assign(max(clamp(corrA, nbA.lo, nbA.hi), vec4(0.0)));
      corrB.assign(clamp(corrB, nbB.lo, nbB.hi));

      // Solids hold no aerosol: advection must not soak dust into walls/ground.
      // The commit renormalization redistributes this mass back into the fluid.
      If(s.solid.node.element(instanceIndex).x.greaterThan(0.5), () => {
        corrA.assign(vec4(0.0));
        corrB.assign(vec4(0.0));
      });

      s.dTilA.node.element(instanceIndex).assign(corrA);
      s.dTilB.node.element(instanceIndex).assign(corrB);
    });
  })().compute(cells);
}

/**
 * Commit corrected density with global mass renormalization: semi-Lagrangian
 * gather advection is not conservative (converging flow duplicates mass), so
 * the committed field is rescaled by (mass before advection)/(mass after),
 * bounded to keep genuine bugs visible, then dissipation is applied.
 * massStat.x = pre-advection mass, massStat.y = post-advection mass.
 */
export function kDensityCommit(f: IslandFields, s: ScratchFields, uni: Uni, massStat: GpuField): any {
  const cells = f.dA.count;
  return Fn(() => {
    If(instanceIndex.lessThan(uint(cells)), () => {
      const stat = massStat.node.element(int(0)).toVar();
      const scale = select(
        stat.y.greaterThan(1e-6),
        clamp(stat.x.div(stat.y), 0.55, 1.8),
        float(1.0),
      ).mul(uni.dissFactor).toVar();
      f.dA.node.element(instanceIndex).assign(s.dTilA.node.element(instanceIndex).mul(scale));
      f.dB.node.element(instanceIndex).assign(s.dTilB.node.element(instanceIndex).mul(scale));
    });
  })().compute(cells);
}

/** Sum the coarse mass grid (16³, kg in .x) into massStat.{x|y} (single thread over 4096). */
export function kSumCoarseMass(coarse: GpuField, massStat: GpuField, component: 0 | 1): any {
  return Fn(() => {
    If(instanceIndex.equal(uint(0)), () => {
      const total = float(0).toVar();
      Loop({ start: int(0), end: int(coarse.count), type: 'int', condition: '<' }, ({ i }: any) => {
        total.addAssign(coarse.node.element(i).x);
      });
      const stat = massStat.node.element(int(0)).toVar();
      if (component === 0) stat.x.assign(total);
      else stat.y.assign(total);
      massStat.node.element(int(0)).assign(stat);
    });
  })().compute(1);
}
