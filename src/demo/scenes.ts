import * as THREE from 'three/webgpu';
import type { Vec3 } from '../core/types';
import type { VolumetricWorld } from '../three/VolumetricWorld';
import {
  EnvCtx, KinematicBody, addBuilding, addInvisibleCollider, emitCollapse, makeCar,
  makeKinematicBody, allocShapeId, nextEvent, setSunAngles,
} from './environment';

export interface SceneCtx {
  env: EnvCtx;
  world: VolumetricWorld;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  state: Record<string, unknown>;
}

export interface SceneDef {
  id: string;
  title: string;
  what: string;
  setup(ctx: SceneCtx): void;
  tick?(ctx: SceneCtx, dt: number, t: number): void;
}

function lookAt(ctx: SceneCtx, pos: Vec3, target: Vec3): void {
  ctx.camera.position.set(pos[0], pos[1], pos[2]);
  ctx.camera.lookAt(target[0], target[1], target[2]);
}

function emitPuff(
  world: VolumetricWorld, center: Vec3, radius: number, massKg: number,
  materialId = 'concrete', durationS = 0.6, vel: Vec3 = [0, 0, 0],
): void {
  world.emit({
    eventId: nextEvent(),
    simulationTimeS: world.simTime,
    durationS,
    substanceId: 'cold-aerosol',
    materialId,
    source: { kind: 'sphere', centerM: center, radiusM: radius },
    fineMassKg: massKg,
    momentum: { kind: 'uniform', initialVelocityMps: vel },
    seed: 11,
  });
}

export const SCENES: SceneDef[] = [
  {
    id: 'puff',
    title: 'Dense cold puff over ground',
    what: 'Negative dust-loading buoyancy: the cloud slumps and rolls outward as a gravity current.',
    setup(ctx) {
      lookAt(ctx, [11, 4.2, 11], [0, 1.6, 0]);
      setSunAngles(ctx.env, 38, 130);
      emitPuff(ctx.world, [0, 2.0, 0], 1.7, 130, 'concrete', 0.55);
    },
  },
  {
    id: 'vortex',
    title: 'Vortex ring',
    what: 'Vorticity preservation: an injected ring impulse rolls the dust into a traveling torus.',
    setup(ctx) {
      lookAt(ctx, [10.5, 3.4, 2.5], [0, 2.4, 0]);
      setSunAngles(ctx.env, 42, 115);
      emitPuff(ctx.world, [-2.4, 2.4, 0], 1.15, 34, 'drywall', 0.4);
      ctx.world.addEffector({
        kind: 'vortexRing',
        centerM: [-2.4, 2.4, 0],
        axis: [1, 0, 0],
        radiusM: 1.1,
        circulationM2ps: 22,
        durationS: 0.8,
      });
      ctx.world.addEffector({
        kind: 'jet',
        startM: [-4.2, 2.4, 0],
        direction: [1, 0, 0],
        radiusM: 1.2,
        speedMps: 5,
        durationS: 0.7,
      });
    },
  },
  {
    id: 'obstacles',
    title: 'Cloud around obstacles',
    what: 'Pressure projection around static solids: flow splits and wraps around box, sphere and capsule.',
    setup(ctx) {
      lookAt(ctx, [3.5, 5.4, 13.5], [3.2, 1.6, 0]);
      setSunAngles(ctx.env, 40, 140);
      addBuilding(ctx.env, [2.6, 1.1, 0], [1.7, 2.2, 1.7], 0x8f6f52);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(1.0, 24, 16),
        new THREE.MeshStandardMaterial({ color: 0x5f7f9f, roughness: 0.6 }),
      );
      sphere.position.set(5.4, 1.0, 2.2);
      sphere.castShadow = true;
      ctx.scene.add(sphere);
      const sShape = allocShapeId();
      ctx.world.registerShape(sShape, { kind: 'sphere', radiusM: 1.0 });
      ctx.world.addStaticCollider({ colliderId: 9001, shapeId: sShape, transform: { positionM: [5.4, 1.0, 2.2], rotation: [0, 0, 0, 1] } });

      const cap = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.55, 2.4, 8, 16),
        new THREE.MeshStandardMaterial({ color: 0x74975e, roughness: 0.7 }),
      );
      cap.position.set(5.2, 1.75, -2.0);
      cap.castShadow = true;
      ctx.scene.add(cap);
      const cShape = allocShapeId();
      ctx.world.registerShape(cShape, { kind: 'capsule', radiusM: 0.55, halfSegmentM: 1.2, axis: 'y' });
      ctx.world.addStaticCollider({ colliderId: 9002, shapeId: cShape, transform: { positionM: [5.2, 1.75, -2.0], rotation: [0, 0, 0, 1] } });

      ctx.world.emit({
        eventId: nextEvent(),
        simulationTimeS: ctx.world.simTime,
        durationS: 5.0,
        substanceId: 'cold-aerosol',
        materialId: 'concrete',
        source: { kind: 'capsule', startM: [-2.6, 0.6, 0], endM: [-2.6, 2.1, 0], radiusM: 0.9 },
        fineMassKg: 150,
        momentum: { kind: 'uniform', initialVelocityMps: [6.5, 0.4, 0] },
        seed: 5,
      });
    },
  },
  {
    id: 'slab',
    title: 'Falling slab displacement',
    what: 'Moving solid boundaries: a falling slab drives displacement jets through resting dust.',
    setup(ctx) {
      lookAt(ctx, [9.5, 4.6, 9.5], [0, 1.2, 0]);
      setSunAngles(ctx.env, 44, 125);
      ctx.world.emit({
        eventId: nextEvent(),
        simulationTimeS: ctx.world.simTime,
        durationS: 0.8,
        substanceId: 'cold-aerosol',
        materialId: 'drywall',
        source: {
          kind: 'box',
          transform: { positionM: [0, 0.8, 0], rotation: [0, 0, 0, 1] },
          halfExtentsM: [3.4, 0.8, 3.4],
        },
        fineMassKg: 110,
        momentum: { kind: 'uniform', initialVelocityMps: [0, 0, 0] },
        seed: 3,
      });
      const slabShape = allocShapeId();
      ctx.world.registerShape(slabShape, { kind: 'box', halfExtentsM: [1.6, 0.22, 1.1] });
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 0.44, 2.2),
        new THREE.MeshStandardMaterial({ color: 0x7d7a74, roughness: 0.85 }),
      );
      const body = makeKinematicBody(ctx.env, { kind: 'box', halfExtentsM: [1.6, 0.22, 1.1] }, [mesh], [0, 7.5, 0], {
        wakeScale: 1.0,
        dragCoefficient: 1.2,
      });
      ctx.state.slab = body;
      ctx.state.impacted = false;
    },
    tick(ctx, dt, t) {
      const body = ctx.state.slab as KinematicBody;
      if (t > 0.9 && body.position.y > 0.44) {
        body.velocity.set(0, -7.5, 0);
        body.position.y = Math.max(0.44, body.position.y - 7.5 * dt);
        if (body.position.y <= 0.45 && !ctx.state.impacted) {
          ctx.state.impacted = true;
          emitPuff(ctx.world, [0, 0.5, 0], 1.9, 26, 'concrete', 0.3);
        }
      } else if (body.position.y <= 0.45) {
        body.velocity.set(0, 0, 0);
      }
      body.push(ctx.world, ctx.world.simTime);
    },
  },
  {
    id: 'hiddenCar',
    title: 'Car behind opaque wall',
    what: 'Off-screen world-space interaction: a hidden car stirs the visible cloud before it appears.',
    setup(ctx) {
      lookAt(ctx, [-1, 3.4, 17], [1.5, 2.4, 0]);
      setSunAngles(ctx.env, 40, 150);
      // Opaque wall between camera and the road (car passes behind it).
      addBuilding(ctx.env, [1.5, 2.6, 7.5], [12, 5.2, 1.1], 0x93856f);
      emitPuff(ctx.world, [1.5, 1.7, 0], 2.4, 170, 'concrete', 0.7);
      const car = makeCar(ctx.env, [-26, 0, 0]);
      ctx.state.car = car;
    },
    tick(ctx, dt, t) {
      const car = ctx.state.car as KinematicBody;
      if (t > 1.2) {
        car.velocity.set(11, 0, 0);
        car.position.x += 11 * dt;
        if (car.position.x > 34) car.position.x = -34;
      }
      car.push(ctx.world, ctx.world.simTime);
    },
  },
  {
    id: 'doorway',
    title: 'Doorway transport',
    what: 'Topologically correct indoor flow: dust reaches the far room only through the doorway (cutaway rooms).',
    setup(ctx) {
      lookAt(ctx, [0, 4.6, 14.5], [0, 1.7, -1]);
      setSunAngles(ctx.env, 46, 155);
      const wallColor = 0xa39782;
      // Two rooms sharing a dividing wall with a doorway gap at x=0.
      // Visible walls: back, left, right, divider (with gap). Invisible: front + ceiling (sealed cutaway).
      addBuilding(ctx.env, [0, 1.9, -4.0], [12.4, 3.8, 0.5], wallColor); // back
      addBuilding(ctx.env, [-6.0, 1.9, -0.75], [0.5, 3.8, 7.0], wallColor); // left
      addBuilding(ctx.env, [6.0, 1.9, -0.75], [0.5, 3.8, 7.0], wallColor); // right
      // Divider at x=0 with a 1.4 m wide × 2.2 m tall doorway centered at z=-0.75.
      addBuilding(ctx.env, [0, 1.9, -3.05], [0.45, 3.8, 2.4], wallColor); // divider rear segment
      addBuilding(ctx.env, [0, 1.9, 1.55], [0.45, 3.8, 2.4], wallColor); // divider front segment
      addBuilding(ctx.env, [0, 3.0, -0.75], [0.45, 1.6, 2.2], wallColor); // divider header above door
      addInvisibleCollider(ctx.env, [0, 4.05, -0.75], [12.4, 0.5, 7.0]); // ceiling lid
      addInvisibleCollider(ctx.env, [0, 1.9, 2.75], [12.4, 3.8, 0.5]); // front pane
      ctx.world.emit({
        eventId: nextEvent(),
        simulationTimeS: ctx.world.simTime,
        durationS: 2.2,
        substanceId: 'cold-aerosol',
        materialId: 'drywall',
        source: { kind: 'sphere', centerM: [-3.6, 1.5, -0.75], radiusM: 1.2 },
        fineMassKg: 95,
        momentum: { kind: 'uniform', initialVelocityMps: [5.5, 0.6, 0] },
        seed: 8,
      });
    },
  },
  {
    id: 'backlit',
    title: 'Strong backlighting',
    what: 'Dual-lobe HG phase + multiple-scattering octaves: silver lining against a low sun.',
    setup(ctx) {
      lookAt(ctx, [0, 2.6, 12.5], [0, 2.6, 0]);
      // Sun nearly behind the cloud, low over the horizon, facing the camera.
      setSunAngles(ctx.env, 11, 188);
      ctx.world.sun.intensity = 42;
      emitPuff(ctx.world, [0, 2.6, 0], 2.1, 120, 'drywall', 0.8, [0, 0.4, 0]);
    },
  },
  {
    id: 'inside',
    title: 'Camera inside the cloud',
    what: 'True volumetric media: the camera can enter the cloud (no billboards to break).',
    setup(ctx) {
      lookAt(ctx, [0, 2.0, 2.2], [2, 2.2, -6]);
      setSunAngles(ctx.env, 35, 160);
      emitPuff(ctx.world, [0, 2.2, -1.5], 2.8, 210, 'concrete', 0.8);
      addBuilding(ctx.env, [4.5, 2.4, -6], [3, 4.8, 3], 0x8f7f6a);
    },
    tick(ctx, _dt, t) {
      ctx.camera.position.set(Math.sin(t * 0.12) * 1.5, 2.0 + Math.sin(t * 0.3) * 0.2, 2.2 - t * 0.12);
    },
  },
  {
    id: 'multi',
    title: 'Four simultaneous collapses',
    what: 'Multi-island scheduling: staggered tiers and rates under one GPU budget.',
    setup(ctx) {
      lookAt(ctx, [22, 13, 24], [0, 2, 0]);
      setSunAngles(ctx.env, 48, 120);
      const spots: Vec3[] = [
        [-9, 0, -8],
        [9, 0, -7],
        [-8, 0, 8],
        [10, 0, 9],
      ];
      spots.forEach((p, i) => {
        addBuilding(ctx.env, [p[0], 2.6, p[2] - 3.6], [4.5, 5.2, 3.4], 0x968878);
        ctx.state[`spot${i}`] = p;
      });
      ctx.state.emitted = 0;
    },
    tick(ctx, _dt, t) {
      const emitted = ctx.state.emitted as number;
      if (emitted < 4 && t > emitted * 0.55) {
        const p = ctx.state[`spot${emitted}`] as Vec3;
        emitCollapse(ctx.world, [p[0], 0, p[2]], [3.6, 4.5, 3.2], 210 + emitted * 30, 'concrete', emitted * 7 + 1);
        ctx.state.emitted = emitted + 1;
      }
    },
  },
  {
    id: 'cityblock',
    title: 'City-block persistence',
    what: 'Grid→packet handoff: retiring islands become drifting anisotropic volume packets in the wind.',
    setup(ctx) {
      lookAt(ctx, [26, 15, 30], [-2, 2, -4]);
      setSunAngles(ctx.env, 42, 118);
      ctx.world.setWind([2.6, 0, 0.7]);
      for (let gx = -1; gx <= 1; gx++) {
        for (let gz = -1; gz <= 1; gz++) {
          if (gx === 0 && gz === 0) continue;
          addBuilding(
            ctx.env,
            [gx * 13, 3.0 + ((gx + gz + 4) % 3), gz * 12 - 4],
            [5.5, 6 + ((gx * 2 + gz + 6) % 4), 4.6],
            0x9a8d7d,
          );
        }
      }
      ctx.state.emitted = 0;
    },
    tick(ctx, _dt, t) {
      const emitted = ctx.state.emitted as number;
      if (emitted === 0 && t > 0.2) {
        emitCollapse(ctx.world, [-13, 0, -4], [4.5, 5.5, 3.8], 260, 'concrete', 21);
        ctx.state.emitted = 1;
      } else if (emitted === 1 && t > 1.4) {
        emitCollapse(ctx.world, [0, 0, -16], [4.0, 5.0, 3.6], 230, 'drywall', 33);
        ctx.state.emitted = 2;
      }
    },
  },
];

export function sceneById(id: string): SceneDef {
  const s = SCENES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scene '${id}'`);
  return s;
}
