import * as THREE from 'three/webgpu';
import type { VolumetricWorld } from '../three/VolumetricWorld';
import type { ColliderShape, Vec3 } from '../core/types';

let nextShapeId = 1;
let nextColliderId = 1;
let nextBodyId = 1;

export function allocShapeId(): number {
  return nextShapeId++;
}
export function allocBodyId(): number {
  return nextBodyId++;
}

export interface EnvCtx {
  world: VolumetricWorld;
  scene: THREE.Scene;
  sunLight: THREE.DirectionalLight;
}

/** Ground plane + sky + sun/hemisphere lights, synced with the volumetric sun. */
export function buildEnvironment(world: VolumetricWorld, scene: THREE.Scene): EnvCtx {
  scene.background = new THREE.Color(0.52, 0.68, 0.9);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x8d8779, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Subtle road strip for orientation.
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 7),
    new THREE.MeshStandardMaterial({ color: 0x4a4a4e, roughness: 0.9 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.02;
  scene.add(road);

  const sunLight = new THREE.DirectionalLight(0xfff2df, 3.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.left = -35;
  sunLight.shadow.camera.right = 35;
  sunLight.shadow.camera.top = 35;
  sunLight.shadow.camera.bottom = -35;
  sunLight.shadow.camera.far = 160;
  sunLight.shadow.bias = -0.0015;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const hemi = new THREE.HemisphereLight(0x9db8dd, 0x5b5348, 0.9);
  scene.add(hemi);

  const env: EnvCtx = { world, scene, sunLight };
  syncSun(env);
  return env;
}

export function syncSun(env: EnvCtx): void {
  const d = env.world.sun.dir;
  env.sunLight.position.set(d[0] * 80, d[1] * 80, d[2] * 80);
  env.sunLight.target.position.set(0, 0, 0);
  (env.scene.background as THREE.Color).copy(env.world.sun.sky).multiplyScalar(0.75 + 0.45 * Math.max(d[1], 0));
}

export function setSunAngles(env: EnvCtx, elevationDeg: number, azimuthDeg: number): void {
  const el = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  env.world.sun.dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  syncSun(env);
}

/** Visible box mesh + matching static box collider. */
export function addBuilding(
  env: EnvCtx,
  center: Vec3,
  size: Vec3,
  color = 0x9a8f85,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({ color, roughness: 0.9 }),
  );
  mesh.position.set(center[0], center[1], center[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  env.scene.add(mesh);

  const shapeId = allocShapeId();
  env.world.registerShape(shapeId, {
    kind: 'box',
    halfExtentsM: [size[0] / 2, size[1] / 2, size[2] / 2],
  });
  env.world.addStaticCollider({
    colliderId: nextColliderId++,
    shapeId,
    transform: { positionM: center, rotation: [0, 0, 0, 1] },
  });
  return mesh;
}

/** Invisible static collider (sealed test rooms, hidden lids). */
export function addInvisibleCollider(env: EnvCtx, center: Vec3, size: Vec3): void {
  const shapeId = allocShapeId();
  env.world.registerShape(shapeId, {
    kind: 'box',
    halfExtentsM: [size[0] / 2, size[1] / 2, size[2] / 2],
  });
  env.world.addStaticCollider({
    colliderId: nextColliderId++,
    shapeId,
    transform: { positionM: center, rotation: [0, 0, 0, 1] },
  });
}

export interface KinematicBody {
  bodyId: number;
  shapeId: number;
  group: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  prevPosition: THREE.Vector3;
  wakeScale: number;
  dragCoefficient: number;
  push(world: VolumetricWorld, simTime: number): void;
}

/** A scripted kinematic body: compound collider + visible meshes, streamed via updateBody. */
export function makeKinematicBody(
  env: EnvCtx,
  shape: ColliderShape,
  meshes: THREE.Mesh[],
  start: Vec3,
  opts: { wakeScale?: number; dragCoefficient?: number } = {},
): KinematicBody {
  const shapeId = allocShapeId();
  env.world.registerShape(shapeId, shape);
  if (shape.kind === 'compound') {
    for (const c of shape.children) {
      // Children must already be registered by the caller via allocShapeId/registerShape.
      void c;
    }
  }
  const group = new THREE.Group();
  for (const m of meshes) {
    m.castShadow = true;
    group.add(m);
  }
  group.position.set(start[0], start[1], start[2]);
  env.scene.add(group);
  const body: KinematicBody = {
    bodyId: allocBodyId(),
    shapeId,
    group,
    position: new THREE.Vector3(start[0], start[1], start[2]),
    prevPosition: new THREE.Vector3(start[0], start[1], start[2]),
    velocity: new THREE.Vector3(),
    wakeScale: opts.wakeScale ?? 1,
    dragCoefficient: opts.dragCoefficient ?? 0.9,
    push(world: VolumetricWorld, simTime: number) {
      this.group.position.copy(this.position);
      world.updateBody({
        bodyId: this.bodyId,
        shapeId: this.shapeId,
        simulationTimeS: simTime,
        transform: { positionM: [this.position.x, this.position.y, this.position.z], rotation: [0, 0, 0, 1] },
        previousTransform: {
          positionM: [this.prevPosition.x, this.prevPosition.y, this.prevPosition.z],
          rotation: [0, 0, 0, 1],
        },
        linearVelocityMps: [this.velocity.x, this.velocity.y, this.velocity.z],
        angularVelocityRadps: [0, 0, 0],
        airInteraction: { enabled: true, wakeScale: this.wakeScale, dragCoefficient: this.dragCoefficient },
      });
      this.prevPosition.copy(this.position);
    },
  };
  return body;
}

/** A simple car: chassis + cabin compound collider with matching meshes. */
export function makeCar(env: EnvCtx, start: Vec3, color = 0xb33a2f): KinematicBody {
  const chassisShape = allocShapeId();
  env.world.registerShape(chassisShape, { kind: 'box', halfExtentsM: [2.1, 0.55, 0.95] });
  const cabinShape = allocShapeId();
  env.world.registerShape(cabinShape, { kind: 'box', halfExtentsM: [1.0, 0.45, 0.85] });
  const compound: ColliderShape = {
    kind: 'compound',
    children: [
      { shapeId: chassisShape, localTransform: { positionM: [0, 0.55, 0], rotation: [0, 0, 0, 1] } },
      { shapeId: cabinShape, localTransform: { positionM: [-0.25, 1.35, 0], rotation: [0, 0, 0, 1] } },
    ],
  };
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 });
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.1, 1.9), mat);
  chassis.position.set(0, 0.55, 0);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 1.7), mat);
  cabin.position.set(-0.25, 1.35, 0);
  return makeKinematicBody(env, compound, [chassis, cabin], start, { wakeScale: 1.15, dragCoefficient: 1.1 });
}

let nextEventId = 1;

/**
 * A staged structural-collapse emission: a falling dust column followed by a
 * radial ground surge — several distributed sources over the collapse duration
 * (much better than one giant instantaneous sphere).
 */
export function emitCollapse(
  world: VolumetricWorld,
  at: Vec3,
  footprint: Vec3,
  fineMassKg: number,
  materialId = 'concrete',
  seed = 1,
): void {
  const t = world.simTime;
  world.emit({
    eventId: nextEventId++,
    simulationTimeS: t,
    durationS: 1.1,
    substanceId: 'cold-aerosol',
    materialId,
    source: {
      kind: 'box',
      transform: { positionM: [at[0], at[1] + footprint[1] * 0.55, at[2]], rotation: [0, 0, 0, 1] },
      halfExtentsM: [footprint[0] * 0.55, footprint[1] * 0.55, footprint[2] * 0.55],
    },
    fineMassKg: fineMassKg * 0.4,
    momentum: { kind: 'uniform', initialVelocityMps: [0, -5.5, 0] },
    seed,
  });
  world.emit({
    eventId: nextEventId++,
    simulationTimeS: t + 0.35,
    durationS: 1.4,
    substanceId: 'cold-aerosol',
    materialId,
    source: {
      kind: 'box',
      transform: { positionM: [at[0], at[1] + 0.9, at[2]], rotation: [0, 0, 0, 1] },
      halfExtentsM: [footprint[0] * 0.8, 0.9, footprint[2] * 0.8],
    },
    fineMassKg: fineMassKg * 0.45,
    momentum: { kind: 'radial', centerM: [at[0], at[1] + 0.6, at[2]], totalImpulseNs: fineMassKg * 130 },
    seed: seed + 1,
  });
  world.emit({
    eventId: nextEventId++,
    simulationTimeS: t + 0.8,
    durationS: 2.2,
    substanceId: 'cold-aerosol',
    materialId,
    source: {
      kind: 'sphere',
      centerM: [at[0], at[1] + 1.2, at[2]],
      radiusM: Math.max(footprint[0], footprint[2]) * 0.8,
    },
    fineMassKg: fineMassKg * 0.15,
    momentum: { kind: 'uniform', initialVelocityMps: [0, -1.2, 0] },
    seed: seed + 2,
  });
}

export function nextEvent(): number {
  return nextEventId++;
}
