/**
 * Public physics-to-library contract.
 *
 * The static shape registry is sent once; dynamic body samples and source
 * events are streamed with timestamps. This mirrors the recommended contract
 * from the architecture document (coordinates are three.js convention: y-up,
 * meters, seconds, kilograms).
 */
import type { Vec3, Quat } from './math';

export type { Vec3, Quat };

export interface RigidTransform {
  positionM: Vec3;
  rotation: Quat;
}

export interface Plane {
  /** Inside satisfies dot(normal, x) <= offsetM (shape-local space). */
  normal: Vec3;
  offsetM: number;
}

export type ColliderShape =
  | { kind: 'sphere'; radiusM: number }
  | { kind: 'box'; halfExtentsM: Vec3 }
  | { kind: 'capsule'; radiusM: number; halfSegmentM: number; axis: 'x' | 'y' | 'z' }
  | { kind: 'convex'; planes: readonly Plane[] }
  | {
      kind: 'compound';
      children: readonly { shapeId: number; localTransform: RigidTransform }[];
    };

export interface StaticCollider {
  colliderId: number;
  shapeId: number;
  transform: RigidTransform;
}

export interface AirInteraction {
  enabled: boolean;
  /** Scales the velocity the wake tries to impose on nearby air. Default 1. */
  wakeScale?: number;
  /** Approximate drag coefficient controlling wake coupling rate. Default 0.8. */
  dragCoefficient?: number;
}

export interface DynamicBodySample {
  bodyId: number;
  shapeId: number;
  simulationTimeS: number;

  transform: RigidTransform;
  /** Previous transform enables swept-volume wakes for fast bodies. */
  previousTransform?: RigidTransform;

  linearVelocityMps: Vec3;
  angularVelocityRadps: Vec3;

  /** Lets the client skip bodies that should not affect air. */
  airInteraction?: AirInteraction;
}

// ---------------------------------------------------------------------------
// Dust sources
// ---------------------------------------------------------------------------

export type SourceVolume =
  | { kind: 'sphere'; centerM: Vec3; radiusM: number }
  | { kind: 'box'; transform: RigidTransform; halfExtentsM: Vec3 }
  | { kind: 'capsule'; startM: Vec3; endM: Vec3; radiusM: number };

export type MomentumDistribution =
  | { kind: 'uniform'; initialVelocityMps: Vec3 }
  | { kind: 'radial'; centerM: Vec3; totalImpulseNs: number; directionBias?: Vec3 }
  | { kind: 'vector'; totalImpulseNs: Vec3 }
  | { kind: 'body'; bodyId: number; transferScale: number };

export interface MediumEmissionEvent {
  eventId: number;
  simulationTimeS: number;
  durationS: number;

  substanceId: SubstanceKind;
  materialId: string;
  source: SourceVolume;

  fineMassKg: number;
  coarseMassKg?: number;

  momentum: MomentumDistribution;

  /** Reserved for smoke/fire substances. */
  temperatureK?: number;
  fuelKg?: number;

  seed: number;
}

// ---------------------------------------------------------------------------
// Generic user-defined airflow
// ---------------------------------------------------------------------------

export type FlowEffector =
  | { kind: 'jet'; startM: Vec3; direction: Vec3; radiusM: number; speedMps: number; durationS: number }
  | { kind: 'vortexRing'; centerM: Vec3; axis: Vec3; radiusM: number; circulationM2ps: number; durationS: number }
  | { kind: 'windVolume'; volume: SourceVolume; velocityMps: Vec3; turbulence?: number; durationS?: number }
  | { kind: 'impulse'; volume: SourceVolume; impulseNs: Vec3 };

// ---------------------------------------------------------------------------
// Substances and materials
// ---------------------------------------------------------------------------

/** Substance selects which governing fields/forces run. V1 implements cold-aerosol. */
export type SubstanceKind = 'cold-aerosol' | 'hot-smoke' | 'fire' | 'steam';

export interface AerosolMaterial {
  id: string;

  /** Optical cross-section per unit mass (m² per kg), per RGB channel. */
  extinctionPerMassRgbM2PerKg: Vec3;

  singleScatteringAlbedoRgb: Vec3;
  phaseAnisotropyG: number;

  fineMassFraction: number;
  coarseMassFraction: number;
  coarseSettlingSpeedMps: number;

  /** Scales the density-loading (negative buoyancy) coupling. */
  loadingScale: number;
  dissipationPerSecond: number;

  detail: {
    baseScaleM: number;
    octaveStrength: number;
    curlStrength: number;
  };

  artDirection: {
    emissionMultiplier: number;
    opacityMultiplier: number;
    turbulenceMultiplier: number;
  };
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export type IslandTier = 'small' | 'medium' | 'hero';

export interface QualityPreset {
  name: string;
  /** Voxel resolution of one pooled island slot (cells per axis; slots are cubes). */
  slotRes: number;
  /** Number of pooled island slots (atlas capacity). */
  slots: number;
  /** Camera raymarch step count at quality 1.0. */
  raySteps: number;
  /** Max steps of the per-island sun-transmittance sweep. */
  lightSteps: number;
  /** Volumetric target resolution relative to canvas (0.5 = half-res). */
  renderScale: number;
  maxRenderPackets: number;
  /** Jacobi iterations of the fixed-budget pressure solve. */
  pressureIters: number;
  /** Sun-transmittance cache update rate (Hz), staggered across islands. */
  lightRateHz: number;
  temporal: boolean;
  /** Per-tier world extents (meters) for pooled islands. */
  tierSizeM: Record<IslandTier, number>;
  /** Per-tier simulation rates (Hz). */
  tierRateHz: Record<IslandTier, number>;
}

export interface EngineOptions {
  preset?: QualityPreset | keyof typeof import('./presets').PRESETS;
  /** Global ambient wind (m/s). */
  windMps?: Vec3;
  /** GPU frame-time target for the quality controller (ms). */
  gpuBudgetMs?: number;
  seed?: number;
  /** Collect divergence/mass metrics each step (test/debug; costs readbacks). */
  metrics?: boolean;
}
