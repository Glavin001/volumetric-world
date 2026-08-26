import * as THREE from 'three/webgpu';
import type {
  ColliderShape, DynamicBodySample, FlowEffector, MediumEmissionEvent, Plane, RigidTransform,
  SourceVolume, Vec3, AerosolMaterial,
} from '../core/types';
import { add, cross, len, luminance, qMul, qRotate, scale, sub, QID } from '../core/math';
import { opticalRates } from '../core/materials';
import {
  IslandUniforms, MAX_EFFECTORS, MAX_EVENTS, MAX_PLANES, MAX_PRIMS, MAX_PROMO,
  EFF_STRIDE, EVT_STRIDE, PRIM_STRIDE, PROMO_STRIDE, PRIM_KIND, SRC_KIND, MOM_KIND, EFF_KIND,
} from './uniforms';
import type { VolumePacket } from '../core/packets';
import { PacketSystem } from '../core/packets';

const RHO_AIR = 1.2;

/** A world-space primitive (compounds are flattened CPU-side each frame). */
export interface WorldPrim {
  kind: number;
  solid: boolean;
  wakeEnabled: boolean;
  wakeScale: number;
  dragCoef: number;
  pos: Vec3;
  prevPos: Vec3;
  quat: readonly [number, number, number, number];
  params: [number, number, number, number];
  planes?: readonly Plane[];
  linVel: Vec3;
  angVel: Vec3;
  boundR: number;
}

export function shapeBoundR(shape: ColliderShape, shapes: Map<number, ColliderShape>): number {
  switch (shape.kind) {
    case 'sphere':
      return shape.radiusM;
    case 'box':
      return len(shape.halfExtentsM);
    case 'capsule':
      return shape.radiusM + shape.halfSegmentM;
    case 'convex': {
      let r = 0.5;
      for (const p of shape.planes) r = Math.max(r, Math.abs(p.offsetM) + 0.25);
      return r;
    }
    case 'compound': {
      let r = 0.5;
      for (const c of shape.children) {
        const child = shapes.get(c.shapeId);
        if (!child) continue;
        r = Math.max(r, len(c.localTransform.positionM) + shapeBoundR(child, shapes));
      }
      return r;
    }
  }
}

/** Flatten a shape instance into world-space primitives (recursing into compounds). */
export function flattenShape(
  shape: ColliderShape,
  shapes: Map<number, ColliderShape>,
  xf: RigidTransform,
  prevXf: RigidTransform,
  linVel: Vec3,
  angVel: Vec3,
  solid: boolean,
  wake: { enabled: boolean; wakeScale: number; dragCoef: number },
  out: WorldPrim[],
): void {
  if (shape.kind === 'compound') {
    for (const c of shape.children) {
      const child = shapes.get(c.shapeId);
      if (!child) continue;
      const childPos = add(xf.positionM, qRotate(xf.rotation, c.localTransform.positionM));
      const childPrevPos = add(prevXf.positionM, qRotate(prevXf.rotation, c.localTransform.positionM));
      const childRot = qMul(xf.rotation, c.localTransform.rotation);
      const childPrevRot = qMul(prevXf.rotation, c.localTransform.rotation);
      // Boundary velocity of the child origin: v + ω×r.
      const childVel = add(linVel, cross(angVel, sub(childPos, xf.positionM)));
      flattenShape(
        child, shapes,
        { positionM: childPos, rotation: childRot },
        { positionM: childPrevPos, rotation: childPrevRot },
        childVel, angVel, solid, wake, out,
      );
    }
    return;
  }
  const kind =
    shape.kind === 'sphere' ? PRIM_KIND.sphere :
    shape.kind === 'box' ? PRIM_KIND.box :
    shape.kind === 'capsule' ? PRIM_KIND.capsule : PRIM_KIND.convex;
  const params: [number, number, number, number] = [0, 0, 0, 0];
  if (shape.kind === 'sphere') params[0] = shape.radiusM;
  else if (shape.kind === 'box') {
    params[0] = shape.halfExtentsM[0];
    params[1] = shape.halfExtentsM[1];
    params[2] = shape.halfExtentsM[2];
  } else if (shape.kind === 'capsule') {
    params[0] = shape.radiusM;
    params[1] = shape.halfSegmentM;
    params[2] = shape.axis === 'x' ? 0 : shape.axis === 'y' ? 1 : 2;
  } else if (shape.kind === 'convex') {
    params[0] = shape.planes.length;
  }
  out.push({
    kind,
    solid,
    wakeEnabled: wake.enabled,
    wakeScale: wake.wakeScale,
    dragCoef: wake.dragCoef,
    pos: xf.positionM,
    prevPos: prevXf.positionM,
    quat: xf.rotation,
    params,
    planes: shape.kind === 'convex' ? shape.planes : undefined,
    linVel,
    angVel,
    boundR: shapeBoundR(shape, shapes),
  });
}

export function primFromBody(
  sample: DynamicBodySample,
  shapes: Map<number, ColliderShape>,
  out: WorldPrim[],
): void {
  const shape = shapes.get(sample.shapeId);
  if (!shape) return;
  const air = sample.airInteraction;
  flattenShape(
    shape, shapes,
    sample.transform,
    sample.previousTransform ?? sample.transform,
    sample.linearVelocityMps,
    sample.angularVelocityRadps,
    true,
    {
      enabled: air?.enabled ?? true,
      wakeScale: air?.wakeScale ?? 1,
      dragCoef: air?.dragCoefficient ?? 0.8,
    },
    out,
  );
}

/** Pack world prims overlapping the island into its uniform arrays. */
export function packPrims(uni: IslandUniforms, prims: WorldPrim[], islandMin: Vec3, islandMax: Vec3): void {
  const arr = uni.primsArray;
  const planesArr = uni.planesArray;
  let n = 0;
  let planeCursor = 0;
  for (const p of prims) {
    if (n >= MAX_PRIMS) break;
    const r = p.boundR + 1.0;
    const overlaps =
      p.pos[0] + r > islandMin[0] && p.pos[0] - r < islandMax[0] &&
      p.pos[1] + r > islandMin[1] && p.pos[1] - r < islandMax[1] &&
      p.pos[2] + r > islandMin[2] && p.pos[2] - r < islandMax[2];
    const prevOverlaps =
      p.prevPos[0] + r > islandMin[0] && p.prevPos[0] - r < islandMax[0] &&
      p.prevPos[1] + r > islandMin[1] && p.prevPos[1] - r < islandMax[1] &&
      p.prevPos[2] + r > islandMin[2] && p.prevPos[2] - r < islandMax[2];
    if (!overlaps && !prevOverlaps) continue;
    let planeStart = 0;
    let planeCount = 0;
    if (p.planes) {
      if (planeCursor + p.planes.length > MAX_PLANES) continue;
      planeStart = planeCursor;
      planeCount = p.planes.length;
      for (const pl of p.planes) {
        planesArr[planeCursor++].set(pl.normal[0], pl.normal[1], pl.normal[2], pl.offsetM);
      }
    }
    const b = n * PRIM_STRIDE;
    arr[b + 0].set(p.kind, p.solid ? 1 : 0, p.wakeScale, p.dragCoef);
    arr[b + 1].set(p.pos[0], p.pos[1], p.pos[2], planeStart);
    arr[b + 2].set(p.quat[0], p.quat[1], p.quat[2], p.quat[3]);
    arr[b + 3].set(
      p.kind === PRIM_KIND.convex ? planeCount : p.params[0],
      p.params[1], p.params[2], p.params[3],
    );
    arr[b + 4].set(p.linVel[0], p.linVel[1], p.linVel[2], p.wakeEnabled ? 1 : 0);
    arr[b + 5].set(p.angVel[0], p.angVel[1], p.angVel[2], 0);
    arr[b + 6].set(p.prevPos[0], p.prevPos[1], p.prevPos[2], p.boundR);
    n++;
  }
  (uni.primCount as any).value = n;
}

export function sourceVolumeM3(v: SourceVolume): number {
  switch (v.kind) {
    case 'sphere':
      return (4 / 3) * Math.PI * v.radiusM ** 3;
    case 'box':
      return 8 * v.halfExtentsM[0] * v.halfExtentsM[1] * v.halfExtentsM[2];
    case 'capsule': {
      const l = len(sub(v.endM, v.startM));
      return Math.PI * v.radiusM ** 2 * l + (4 / 3) * Math.PI * v.radiusM ** 3;
    }
  }
}

export function sourceCenter(v: SourceVolume): Vec3 {
  switch (v.kind) {
    case 'sphere':
      return v.centerM;
    case 'box':
      return v.transform.positionM;
    case 'capsule':
      return scale(add(v.startM, v.endM), 0.5);
  }
}

export function sourceBoundR(v: SourceVolume): number {
  switch (v.kind) {
    case 'sphere':
      return v.radiusM;
    case 'box':
      return len(v.halfExtentsM);
    case 'capsule':
      return len(sub(v.endM, v.startM)) * 0.5 + v.radiusM;
  }
}

/** Emission event with precomputed per-second rates for the injection kernels. */
export interface ActiveEmission {
  ev: MediumEmissionEvent;
  material: AerosolMaterial;
  loadRate: number;
  extRate: Vec3;
  scatRate: Vec3;
  phaseWRate: number;
  endTime: number;
  /** Slot that owns this emission (-1 = packet-represented). Exactly ONE island injects it. */
  ownerSlot: number;
}

export function activateEmission(ev: MediumEmissionEvent, material: AerosolMaterial): ActiveEmission {
  const vol = Math.max(sourceVolumeM3(ev.source), 0.05);
  const dur = Math.max(ev.durationS, 1 / 60);
  // The soft-edged emission profile integrates to less than the source volume;
  // compensate per shape so fineMassKg lands in the field (sphere smoothstep
  // 1→0.55 ≈ 0.36·V, box 1→0.75 ≈ 0.63·V, capsule ≈ 0.45·V).
  const comp = ev.source.kind === 'sphere' ? 2.1 : ev.source.kind === 'box' ? 1.5 : 1.9;
  const loadRate = (ev.fineMassKg * material.artDirection.emissionMultiplier * comp) / (vol * dur);
  const rates = opticalRates(material);
  return {
    ownerSlot: -1,
    ev,
    material,
    loadRate,
    extRate: scale(rates.extRgb, loadRate),
    scatRate: scale(rates.scatRgb, loadRate),
    phaseWRate: rates.phaseW * loadRate,
    endTime: ev.simulationTimeS + dur,
  };
}

export function packEvents(
  uni: IslandUniforms,
  emissions: ActiveEmission[],
  now: number,
  bodyVelocity: (bodyId: number) => Vec3 | undefined,
): void {
  const arr = uni.eventsArray;
  let n = 0;
  for (const em of emissions) {
    if (n >= MAX_EVENTS) break;
    const { ev } = em;
    if (now < ev.simulationTimeS || now > em.endTime) continue;
    const b = n * EVT_STRIDE;
    const src = ev.source;
    const vol = Math.max(sourceVolumeM3(src), 0.05);
    const dur = Math.max(ev.durationS, 1 / 60);

    let srcKind = SRC_KIND.sphere as number;
    if (src.kind === 'box') srcKind = SRC_KIND.box;
    else if (src.kind === 'capsule') srcKind = SRC_KIND.capsule;

    let momKind = MOM_KIND.none as number;
    let momVec: Vec3 = [0, 0, 0];
    let momAux = 0;
    let momCouple = 0;
    const m = ev.momentum;
    if (m.kind === 'uniform') {
      momKind = MOM_KIND.uniform;
      momVec = m.initialVelocityMps;
      momCouple = 8;
    } else if (m.kind === 'radial') {
      momKind = MOM_KIND.radial;
      momAux = m.totalImpulseNs / (RHO_AIR * vol * dur);
      momVec = m.directionBias ?? [0, 0, 0];
    } else if (m.kind === 'vector') {
      momKind = MOM_KIND.vector;
      momVec = scale(m.totalImpulseNs, 1 / (RHO_AIR * vol * dur));
    } else if (m.kind === 'body') {
      const bv = bodyVelocity(m.bodyId);
      if (bv) {
        momKind = MOM_KIND.uniform;
        momVec = scale(bv, m.transferScale);
        momCouple = 6;
      }
    }

    arr[b + 0].set(srcKind, momKind, em.loadRate, em.phaseWRate);
    if (src.kind === 'sphere') {
      arr[b + 1].set(src.centerM[0], src.centerM[1], src.centerM[2], src.radiusM);
      arr[b + 2].set(0, 0, 0, 0);
      arr[b + 3].set(0, 0, 0, 1);
    } else if (src.kind === 'box') {
      const t = src.transform;
      arr[b + 1].set(t.positionM[0], t.positionM[1], t.positionM[2], 0);
      arr[b + 2].set(src.halfExtentsM[0], src.halfExtentsM[1], src.halfExtentsM[2], 0);
      arr[b + 3].set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    } else {
      arr[b + 1].set(src.startM[0], src.startM[1], src.startM[2], src.radiusM);
      arr[b + 2].set(src.endM[0], src.endM[1], src.endM[2], src.radiusM);
      arr[b + 3].set(0, 0, 0, 1);
    }
    arr[b + 4].set(em.extRate[0], em.extRate[1], em.extRate[2], momAux);
    arr[b + 5].set(em.scatRate[0], em.scatRate[1], em.scatRate[2], momCouple);
    arr[b + 6].set(momVec[0], momVec[1], momVec[2], 0);
    n++;
  }
  (uni.evtCount as any).value = n;
}

/** Effector with CPU-managed lifetime. */
export interface ActiveEffector {
  eff: FlowEffector;
  startTime: number;
  endTime: number;
}

export function effectorDuration(eff: FlowEffector): number {
  switch (eff.kind) {
    case 'jet':
    case 'vortexRing':
      return eff.durationS;
    case 'windVolume':
      return eff.durationS ?? Infinity;
    case 'impulse':
      return 0.1;
  }
}

export function packEffectors(uni: IslandUniforms, effectors: ActiveEffector[], now: number, dt: number): void {
  const arr = uni.effsArray;
  let n = 0;
  for (const a of effectors) {
    if (n >= MAX_EFFECTORS) break;
    if (now < a.startTime || now > a.endTime) continue;
    const b = n * EFF_STRIDE;
    const e = a.eff;
    if (e.kind === 'jet') {
      const dir = e.direction;
      arr[b + 0].set(EFF_KIND.jet, e.radiusM, e.speedMps, e.radiusM * 6);
      arr[b + 1].set(e.startM[0], e.startM[1], e.startM[2], 0);
      arr[b + 2].set(dir[0], dir[1], dir[2], 0);
      arr[b + 3].set(0, 0, 0, 4);
    } else if (e.kind === 'vortexRing') {
      arr[b + 0].set(EFF_KIND.vortexRing, e.radiusM, e.circulationM2ps, 0);
      arr[b + 1].set(e.centerM[0], e.centerM[1], e.centerM[2], 0);
      arr[b + 2].set(e.axis[0], e.axis[1], e.axis[2], 0);
      arr[b + 3].set(0, 0, 0, 1);
    } else if (e.kind === 'windVolume') {
      const c = sourceCenter(e.volume);
      const r = sourceBoundR(e.volume);
      arr[b + 0].set(EFF_KIND.windVolume, r, 0, 0);
      arr[b + 1].set(c[0], c[1], c[2], 0);
      arr[b + 2].set(0, 1, 0, 0);
      arr[b + 3].set(e.velocityMps[0], e.velocityMps[1], e.velocityMps[2], 3 + (e.turbulence ?? 0));
    } else {
      const c = sourceCenter(e.volume);
      const r = sourceBoundR(e.volume);
      const vol = Math.max(sourceVolumeM3(e.volume), 0.05);
      // Impulse delivered across whatever step first sees it: accel = J/(ρV·dt).
      const accel = scale(e.impulseNs, 1 / (RHO_AIR * vol * Math.max(dt, 1 / 120)));
      arr[b + 0].set(EFF_KIND.impulse, r, 0, 0);
      arr[b + 1].set(c[0], c[1], c[2], 0);
      arr[b + 2].set(0, 1, 0, 0);
      arr[b + 3].set(accel[0], accel[1], accel[2], 1);
    }
    n++;
  }
  (uni.effCount as any).value = n;
}

/** Pack packets for voxelization into an island (packet→grid promotion). */
export function packPromo(uni: IslandUniforms, packets: VolumePacket[]): void {
  const arr = uni.promoArray;
  let n = 0;
  for (const p of packets) {
    if (n >= MAX_PROMO) break;
    const norm = Math.pow(2 * Math.PI, 1.5) * p.radii[0] * p.radii[1] * p.radii[2];
    const load0 = (p.massKg * p.fade) / Math.max(norm, 1e-6);
    const ext0: Vec3 = scale(p.extPerMassRgb, load0);
    const scat0: Vec3 = [ext0[0] * p.albedoRgb[0], ext0[1] * p.albedoRgb[1], ext0[2] * p.albedoRgb[2]];
    const phaseW0 = p.phaseG * luminance(scat0);
    const b = n * PROMO_STRIDE;
    arr[b + 0].set(p.position[0], p.position[1], p.position[2], load0);
    arr[b + 1].set(p.radii[0], p.radii[1], p.radii[2], phaseW0);
    arr[b + 2].set(ext0[0], ext0[1], ext0[2], 0);
    arr[b + 3].set(scat0[0], scat0[1], scat0[2], 0);
    arr[b + 4].set(p.velocity[0], p.velocity[1], p.velocity[2], 0);
    n++;
  }
  (uni.promoCount as any).value = n;
}

export { QID, PacketSystem };
