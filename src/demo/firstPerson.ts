import * as THREE from 'three/webgpu';

/**
 * Opt-in first-person camera: walk through the scene and stand inside the dust
 * instead of inspecting it from outside. Mouse-look uses Pointer Lock when the
 * browser grants it and falls back to drag-look (touch, or a denied lock), so
 * the same controller works on desktop and on iOS Safari.
 *
 * Movement is horizontal relative to the current heading with a damped
 * velocity, and eye height is held at a walking height unless the viewer
 * deliberately raises or lowers it — a volumetric plume reads very differently
 * from eye level than from an orbit rig, which is the point of the mode.
 */
export interface FirstPersonOptions {
  eyeHeightM?: number;
  walkSpeedMps?: number;
  groundY?: number;
}

const MIN_PITCH = -1.45;
const MAX_PITCH = 1.45;
const LOOK_PER_PIXEL = 0.0026;

export class FirstPersonCamera {
  /** While false the controller leaves the camera alone. */
  enabled = false;
  /** True once the viewer has actually looked or moved in this mode. */
  engaged = false;
  onEngage?: () => void;

  readonly position = new THREE.Vector3(0, 1.7, 12);
  yaw = 0;
  pitch = 0;
  eyeHeight: number;
  walkSpeed: number;
  groundY: number;

  private velocity = new THREE.Vector3();
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number }>();
  private locked = false;
  private canvas: HTMLCanvasElement | null = null;
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(opts: FirstPersonOptions = {}) {
    this.eyeHeight = opts.eyeHeightM ?? 1.7;
    this.walkSpeed = opts.walkSpeedMps ?? 4.2;
    this.groundY = opts.groundY ?? 0;
  }

  /** Adopt the camera's current pose so entering the mode never jumps the view. */
  captureFromCamera(camera: THREE.PerspectiveCamera): void {
    this.position.copy(camera.position);
    this.position.y = Math.max(this.position.y, this.groundY + 0.35);
    const dir = camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), MIN_PITCH, MAX_PITCH);
    this.eyeHeight = this.position.y - this.groundY;
    this.velocity.set(0, 0, 0);
  }

  /**
   * Enter walking on the ground: keep the horizontal position and heading the
   * viewer was just looking from (so the switch still feels continuous), but
   * drop to a normal walking eye height instead of adopting whatever altitude
   * the orbit rig happened to be flying at — orbit inspects from the air,
   * first-person is meant to be a person standing on the ground.
   */
  enterGrounded(camera: THREE.PerspectiveCamera, eyeHeightM = 1.7): void {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = 0; // look at the horizon, not wherever the orbit camera was pitched
    this.eyeHeight = eyeHeightM;
    this.position.set(camera.position.x, this.groundY + this.eyeHeight, camera.position.z);
    this.velocity.set(0, 0, 0);
    this.enabled = true;
    this.update(0, camera);
  }

  /** Absolute placement for capture scripts and tests. */
  snapTo(
    camera: THREE.PerspectiveCamera,
    view: { position?: readonly [number, number, number]; yawDeg?: number; pitchDeg?: number },
  ): void {
    this.enabled = true;
    if (view.position) {
      this.position.set(view.position[0], view.position[1], view.position[2]);
      this.eyeHeight = this.position.y - this.groundY;
    }
    if (view.yawDeg !== undefined) this.yaw = (view.yawDeg * Math.PI) / 180;
    if (view.pitchDeg !== undefined) {
      this.pitch = THREE.MathUtils.clamp((view.pitchDeg * Math.PI) / 180, MIN_PITCH, MAX_PITCH);
    }
    this.velocity.set(0, 0, 0);
    this.update(0, camera);
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;

    const engage = (): void => {
      if (!this.engaged) {
        this.engaged = true;
        this.onEngage?.();
      }
    };

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.enabled) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      engage();
      // Pointer Lock gives unbounded mouse-look; touch and denied locks fall
      // back to dragging, so never depend on it succeeding.
      if (e.pointerType === 'mouse' && !this.locked) {
        void Promise.resolve(canvas.requestPointerLock?.()).catch(() => {
          /* drag-look still works */
        });
      }
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.enabled) return;
      if (this.locked) {
        this.look(e.movementX ?? 0, e.movementY ?? 0);
        engage();
        return;
      }
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.look(e.clientX - prev.x, e.clientY - prev.y);
      engage();
    });

    const release = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!this.enabled) return;
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
      this.keys.add(k);
      engage();
    });
    window.addEventListener('keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointers.clear();
      this.velocity.set(0, 0, 0);
    });
  }

  /** Release the pointer lock (used when leaving the mode). */
  releaseLock(): void {
    if (this.locked) document.exitPointerLock?.();
    this.locked = false;
    this.pointers.clear();
    this.keys.clear();
  }

  private look(dx: number, dy: number): void {
    this.yaw -= dx * LOOK_PER_PIXEL;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * LOOK_PER_PIXEL, MIN_PITCH, MAX_PITCH);
  }

  /** Advance movement and write the pose onto the camera. */
  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (!this.enabled) return;

    const has = (...names: string[]): boolean => names.some((n) => this.keys.has(n));
    // Heading-relative basis on the ground plane.
    this.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(-this.fwd.z, 0, this.fwd.x);

    const wish = new THREE.Vector3();
    if (has('w', 'arrowup')) wish.add(this.fwd);
    if (has('s', 'arrowdown')) wish.sub(this.fwd);
    if (has('d', 'arrowright')) wish.add(this.right);
    if (has('a', 'arrowleft')) wish.sub(this.right);
    if (wish.lengthSq() > 0) wish.normalize();
    const speed = this.walkSpeed * (has('shift') ? 2.6 : 1);

    // Damped acceleration toward the wish direction: no lurching, and letting
    // go coasts to a stop rather than stopping dead.
    const k = 1 - Math.exp(-dt * 12);
    this.velocity.lerp(wish.multiplyScalar(speed), k);
    if (dt > 0) this.position.addScaledVector(this.velocity, dt);

    // Eye height: held at walking height, nudged by q/e (or space/c).
    if (has('e', ' ')) this.eyeHeight += dt * 3.2;
    if (has('q', 'c')) this.eyeHeight -= dt * 3.2;
    this.eyeHeight = THREE.MathUtils.clamp(this.eyeHeight, 0.25, 60);
    this.position.y = this.groundY + this.eyeHeight;

    camera.position.copy(this.position);
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(this.euler);
  }
}
