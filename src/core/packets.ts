import type { Vec3, Quat, AerosolMaterial } from './types';
import { add, scale, sub, len, clamp, QID, luminance } from './math';
import { mulberry32 } from './prng';

/**
 * Persistent far-field clouds: world-space anisotropic volumetric kernels
 * (ellipsoidal Gaussians), NOT camera-facing sprites. They have world
 * positions and 3D shape, can be entered, occluded, lit from any direction,
 * revoxelized into a simulation island, and pushed by wakes while off-screen.
 */
export interface VolumePacket {
  id: number;
  position: [number, number, number];
  velocity: [number, number, number];
  rotation: Quat;
  radii: [number, number, number];
  massKg: number;

  /** Additive optical moments per unit mass (m²/kg). */
  extPerMassRgb: Vec3;
  albedoRgb: Vec3;
  phaseG: number;

  turbulencePhase: [number, number, number];
  ageSeconds: number;
  seed: number;
  /** 0..1 crossfade used during grid↔packet handoff to avoid duplicated mass pops. */
  fade: number;
  detailScaleM: number;
}

export interface PacketWake {
  from: Vec3;
  to: Vec3;
  radiusM: number;
  velocityMps: Vec3;
  couple: number; // 0..1 per application
}

let nextPacketId = 1;

export interface PacketSystemOptions {
  maxPackets?: number;
  groundY?: number;
  dissipationPerSecond?: number;
  growthMps?: number;
  windDrag?: number;
  seed?: number;
}

export class PacketSystem {
  packets: VolumePacket[] = [];
  readonly maxPackets: number;
  groundY: number;
  dissipation: number;
  growth: number;
  windDrag: number;
  private rand: () => number;

  constructor(opts: PacketSystemOptions = {}) {
    this.maxPackets = opts.maxPackets ?? 128;
    this.groundY = opts.groundY ?? 0;
    this.dissipation = opts.dissipationPerSecond ?? 0.02;
    this.growth = opts.growthMps ?? 0.22;
    this.windDrag = opts.windDrag ?? 0.35;
    this.rand = mulberry32(opts.seed ?? 1234);
  }

  totalMass(): number {
    let m = 0;
    for (const p of this.packets) m += p.massKg;
    return m;
  }

  spawn(p: Omit<VolumePacket, 'id'>): VolumePacket {
    const packet: VolumePacket = { ...p, id: nextPacketId++ };
    this.packets.push(packet);
    this.enforceBudget();
    return packet;
  }

  spawnFromMaterial(
    material: AerosolMaterial,
    position: Vec3,
    radii: Vec3,
    massKg: number,
    velocity: Vec3,
    seed = 1,
    fade = 1,
  ): VolumePacket {
    const opacity = material.artDirection.opacityMultiplier;
    return this.spawn({
      position: [...position] as [number, number, number],
      velocity: [...velocity] as [number, number, number],
      rotation: QID,
      radii: [Math.max(0.25, radii[0]), Math.max(0.25, radii[1]), Math.max(0.25, radii[2])],
      massKg,
      extPerMassRgb: [
        material.extinctionPerMassRgbM2PerKg[0] * opacity,
        material.extinctionPerMassRgbM2PerKg[1] * opacity,
        material.extinctionPerMassRgbM2PerKg[2] * opacity,
      ],
      albedoRgb: material.singleScatteringAlbedoRgb,
      phaseG: material.phaseAnisotropyG,
      turbulencePhase: [this.rand() * 10, this.rand() * 10, this.rand() * 10],
      ageSeconds: 0,
      seed,
      fade,
      // Same world-space detail scale the island render path uses (meta m2.w):
      // any fudge factor here would desynchronize the noise across a handoff.
      detailScaleM: material.detail.baseScaleM,
    });
  }

  /** Peak extinction coefficient (1/m, luminance) at the packet center. */
  static peakSigmaT(p: VolumePacket): number {
    const norm = Math.pow(2 * Math.PI, 1.5) * p.radii[0] * p.radii[1] * p.radii[2];
    return (luminance(p.extPerMassRgb) * p.massKg * p.fade) / Math.max(norm, 1e-6);
  }

  applyWake(w: PacketWake): void {
    const seg = sub(w.to, w.from);
    const segLen2 = Math.max(1e-6, seg[0] ** 2 + seg[1] ** 2 + seg[2] ** 2);
    for (const p of this.packets) {
      const rel = sub(p.position, w.from);
      const t = clamp((rel[0] * seg[0] + rel[1] * seg[1] + rel[2] * seg[2]) / segLen2, 0, 1);
      const closest = add(w.from, scale(seg, t));
      const reach = w.radiusM + Math.max(p.radii[0], p.radii[1], p.radii[2]);
      const d = len(sub(p.position, closest));
      if (d < reach) {
        const fall = 1 - d / reach;
        const k = clamp(w.couple * fall, 0, 1);
        p.velocity[0] += (w.velocityMps[0] - p.velocity[0]) * k;
        p.velocity[1] += (w.velocityMps[1] - p.velocity[1]) * k;
        p.velocity[2] += (w.velocityMps[2] - p.velocity[2]) * k;
        // Stirring also spreads the packet a little.
        const stir = clamp(len(w.velocityMps) * 0.02 * fall, 0, 0.3);
        p.radii[0] += stir;
        p.radii[1] += stir * 0.5;
        p.radii[2] += stir;
      }
    }
  }

  update(dt: number, wind: Vec3): void {
    const g = this.growth;
    for (const p of this.packets) {
      p.ageSeconds += dt;
      p.fade = Math.min(1, p.fade + dt * 3);

      // Entrainment-like drag toward ambient wind.
      const k = Math.min(1, this.windDrag * dt);
      p.velocity[0] += (wind[0] - p.velocity[0]) * k;
      p.velocity[1] += (wind[1] - p.velocity[1]) * k;
      p.velocity[2] += (wind[2] - p.velocity[2]) * k;
      // Residual negative buoyancy for a dense packet, fading with age/size.
      p.velocity[1] -= dt * 0.5 * Math.exp(-p.ageSeconds * 0.3);

      p.position[0] += p.velocity[0] * dt;
      p.position[1] += p.velocity[1] * dt;
      p.position[2] += p.velocity[2] * dt;

      // Covariance growth, decelerating with age.
      const grow = (g / (1 + p.ageSeconds * 0.15)) * dt;
      p.radii[0] += grow;
      p.radii[1] += grow * 0.6;
      p.radii[2] += grow;

      // Aspect guard: splits and ground pancaking can leave a packet metres
      // long but only ~0.25 m thin, which renders as a bright "glass shard".
      // Thicken the thin axes (mass is conserved; peak density drops).
      const maxR = Math.max(p.radii[0], p.radii[1], p.radii[2]);
      const minAllowed = maxR / 5;
      p.radii[0] = Math.max(p.radii[0], minAllowed);
      p.radii[1] = Math.max(p.radii[1], minAllowed);
      p.radii[2] = Math.max(p.radii[2], minAllowed);

      // Ground contact: clamp and pancake (gravity-current flavored spreading).
      const floor = this.groundY + p.radii[1] * 0.55;
      if (p.position[1] < floor) {
        p.position[1] = floor;
        if (p.velocity[1] < 0) {
          const spill = -p.velocity[1];
          p.velocity[1] = 0;
          p.radii[0] += spill * dt * 1.5;
          p.radii[2] += spill * dt * 1.5;
        }
      }

      p.massKg *= Math.exp(-this.dissipation * dt);
    }

    this.mergeAndSplit();

    // Cull optically negligible packets.
    this.packets = this.packets.filter(
      (p) => p.massKg > 5e-4 && PacketSystem.peakSigmaT(p) * Math.max(...p.radii) > 2e-4,
    );
  }

  private mergeAndSplit(): void {
    const ps = this.packets;
    // Merge nearly co-moving, highly overlapping packets (O(n²), n is small).
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.massKg <= 0) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (b.massKg <= 0) continue;
        const d = len(sub(a.position, b.position));
        const ra = Math.max(...a.radii);
        const rb = Math.max(...b.radii);
        const dv = len(sub(a.velocity, b.velocity));
        if (d < 0.55 * (ra + rb) && dv < 1.2) {
          PacketSystem.foldInto(a, b);
          b.massKg = 0;
        }
      }
    }
    let out = ps.filter((p) => p.massKg > 0);

    // Split packets stretched too far along one axis.
    const born: VolumePacket[] = [];
    for (const p of out) {
      const axes: [number, number, number] = [...p.radii];
      const maxAxis = axes.indexOf(Math.max(...axes)) as 0 | 1 | 2;
      const minR = Math.min(...axes);
      if (axes[maxAxis] > 3.2 * minR && out.length + born.length < this.maxPackets) {
        const off: [number, number, number] = [0, 0, 0];
        off[maxAxis] = axes[maxAxis] * 0.55;
        const child: VolumePacket = {
          ...p,
          id: nextPacketId++,
          position: [p.position[0] + off[0], p.position[1] + off[1], p.position[2] + off[2]],
          radii: [...p.radii],
          velocity: [...p.velocity],
          turbulencePhase: [...p.turbulencePhase],
          massKg: p.massKg * 0.5,
        };
        child.radii[maxAxis] *= 0.55;
        p.radii[maxAxis] *= 0.55;
        p.massKg *= 0.5;
        p.position[0] -= off[0];
        p.position[1] -= off[1];
        p.position[2] -= off[2];
        born.push(child);
      }
    }
    out = out.concat(born);
    this.packets = out;
    this.enforceBudget();
  }

  private enforceBudget(): void {
    if (this.packets.length <= this.maxPackets) return;
    // Keep the most optically significant packets; the overflow is FOLDED into
    // each one's nearest survivor (moment-matched merge) rather than deleted —
    // the budget is a level-of-detail decision and must never destroy mass.
    this.packets.sort(
      (a, b) =>
        PacketSystem.peakSigmaT(b) * Math.max(...b.radii) - PacketSystem.peakSigmaT(a) * Math.max(...a.radii),
    );
    const survivors = this.packets.slice(0, this.maxPackets);
    const overflow = this.packets.slice(this.maxPackets);
    for (const p of overflow) {
      let best = survivors[0];
      let bestD = Infinity;
      for (const s of survivors) {
        const d = len(sub(p.position, s.position));
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      PacketSystem.foldInto(best, p);
    }
    this.packets = survivors;
  }

  /** Moment-matched absorb of `b` into `a` (mass, position, spread, velocity, optics). */
  private static foldInto(a: VolumePacket, b: VolumePacket): void {
    const m = a.massKg + b.massKg;
    if (m <= 0) return;
    const wa = a.massKg / m;
    const wb = b.massKg / m;
    for (let c = 0; c < 3; c++) {
      const mean = a.position[c] * wa + b.position[c] * wb;
      const va =
        wa * (a.radii[c] ** 2 + (a.position[c] - mean) ** 2) +
        wb * (b.radii[c] ** 2 + (b.position[c] - mean) ** 2);
      a.position[c] = mean;
      a.radii[c] = Math.sqrt(va);
      a.velocity[c] = a.velocity[c] * wa + b.velocity[c] * wb;
    }
    a.extPerMassRgb = [
      a.extPerMassRgb[0] * wa + b.extPerMassRgb[0] * wb,
      a.extPerMassRgb[1] * wa + b.extPerMassRgb[1] * wb,
      a.extPerMassRgb[2] * wa + b.extPerMassRgb[2] * wb,
    ];
    a.albedoRgb = [
      a.albedoRgb[0] * wa + b.albedoRgb[0] * wb,
      a.albedoRgb[1] * wa + b.albedoRgb[1] * wb,
      a.albedoRgb[2] * wa + b.albedoRgb[2] * wb,
    ];
    a.phaseG = a.phaseG * wa + b.phaseG * wb;
    a.massKg = m;
  }

  /** Remove and return packets intersecting the given AABB (for packet→grid promotion). */
  takeInBounds(min: Vec3, max: Vec3): VolumePacket[] {
    const taken: VolumePacket[] = [];
    this.packets = this.packets.filter((p) => {
      const rx = p.radii[0], ry = p.radii[1], rz = p.radii[2];
      const inside =
        p.position[0] + rx > min[0] && p.position[0] - rx < max[0] &&
        p.position[1] + ry > min[1] && p.position[1] - ry < max[1] &&
        p.position[2] + rz > min[2] && p.position[2] - rz < max[2];
      if (inside) taken.push(p);
      return !inside;
    });
    return taken;
  }
}

/**
 * Build packets from a coarse (RES³) mass grid read back from an island:
 * groups cells into octants and moment-matches each into one Gaussian packet.
 * `grid` holds vec4 per coarse cell: (mass, Σm·x, Σm·y, Σm·z) with x,y,z in
 * island-local meters.
 */
export function packetsFromCoarseGrid(
  grid: Float32Array,
  res: number,
  origin: Vec3,
  sizeM: number,
  minMassKg = 0.01,
): { position: Vec3; radii: Vec3; massKg: number }[] {
  const half = res / 2;
  const cellM = sizeM / res;
  interface Acc { m: number; x: number; y: number; z: number; xx: number; yy: number; zz: number }
  const acc: Acc[] = Array.from({ length: 8 }, () => ({ m: 0, x: 0, y: 0, z: 0, xx: 0, yy: 0, zz: 0 }));
  for (let z = 0; z < res; z++) {
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = (x + y * res + z * res * res) * 4;
        const m = grid[i];
        if (m <= 0) continue;
        const cx = m > 1e-9 ? grid[i + 1] / m : (x + 0.5) * cellM;
        const cy = m > 1e-9 ? grid[i + 2] / m : (y + 0.5) * cellM;
        const cz = m > 1e-9 ? grid[i + 3] / m : (z + 0.5) * cellM;
        const o = (x >= half ? 1 : 0) + (y >= half ? 2 : 0) + (z >= half ? 4 : 0);
        const a = acc[o];
        a.m += m;
        a.x += m * cx; a.y += m * cy; a.z += m * cz;
        a.xx += m * cx * cx; a.yy += m * cy * cy; a.zz += m * cz * cz;
      }
    }
  }
  const out: { position: Vec3; radii: Vec3; massKg: number }[] = [];
  for (const a of acc) {
    if (a.m < minMassKg) continue;
    const mx = a.x / a.m, my = a.y / a.m, mz = a.z / a.m;
    const vx = Math.max(a.xx / a.m - mx * mx, 0.04);
    const vy = Math.max(a.yy / a.m - my * my, 0.04);
    const vz = Math.max(a.zz / a.m - mz * mz, 0.04);
    out.push({
      position: [origin[0] + mx, origin[1] + my, origin[2] + mz],
      // Slightly inflate: a Gaussian with σ=std underestimates the visual footprint.
      radii: [Math.sqrt(vx) * 1.35 + cellM, Math.sqrt(vy) * 1.35 + cellM, Math.sqrt(vz) * 1.35 + cellM],
      massKg: a.m,
    });
  }
  return out;
}
