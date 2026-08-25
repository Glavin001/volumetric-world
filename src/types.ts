export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface VolumePacket {
  id: number;
  position: Vec3;
  velocity: Vec3;
  radii: Vec3;
  massKg: number;
  ageSeconds: number;
  seed: number;
}

export interface MediumEmissionEvent {
  eventId: number;
  simulationTimeS: number;
  centerM: Vec3;
  radiusM: number;
  fineMassKg: number;
  impulseMps: Vec3;
  seed: number;
}

export interface DynamicBodySample {
  bodyId: number;
  positionM: Vec3;
  previousPositionM: Vec3;
  velocityMps: Vec3;
  radiusM: number;
  wakeScale: number;
}

export type QualityPreset = "performance" | "balanced" | "cinematic";
