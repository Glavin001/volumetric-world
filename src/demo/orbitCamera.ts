import * as THREE from 'three/webgpu';

/**
 * Inspection camera for the demo gallery: damped orbit around a world-space
 * target with drag-to-rotate, wheel/pinch zoom, two-finger (or right-drag) pan,
 * keyboard nudges, and a slow auto-orbit that makes volumetric parallax and
 * self-shadowing readable while a scene plays.
 *
 * Pointer Events are used throughout so mouse, pen and touch (iOS Safari
 * included) share one path. The controller only writes to the camera while
 * `enabled` — scenes that animate the camera themselves start it disabled and
 * hand over on the first user gesture, capturing the current pose so the view
 * never jumps.
 */
export interface OrbitOptions {
  autoOrbit?: boolean;
  autoSpeedRadPerS?: number;
  enabled?: boolean;
}

type DragMode = 'none' | 'rotate' | 'pan' | 'pinch';

const MIN_PITCH = -0.35;
const MAX_PITCH = 1.45;
const MIN_DIST = 0.4;
const MAX_DIST = 260;

export class OrbitCamera {
  readonly target = new THREE.Vector3(0, 1.5, 0);
  /** While false the controller leaves the camera alone (scene-driven shots). */
  enabled: boolean;
  autoOrbit: boolean;
  autoSpeed: number;
  /** True once the user has taken manual control at least once. */
  engaged = false;
  /** Called the first time the user grabs the camera. */
  onEngage?: () => void;

  private yaw = 0;
  private pitch = 0.35;
  private dist = 14;
  private goalYaw = 0;
  private goalPitch = 0.35;
  private goalDist = 14;
  private goalTarget = new THREE.Vector3(0, 1.5, 0);
  private home = { yaw: 0, pitch: 0.35, dist: 14, target: new THREE.Vector3(0, 1.5, 0) };

  private pointers = new Map<number, { x: number; y: number }>();
  private mode: DragMode = 'none';
  private pinchStart = 0;
  private pinchStartDist = 14;
  private keys = new Set<string>();
  private scratch = new THREE.Vector3();

  constructor(opts: OrbitOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.autoOrbit = opts.autoOrbit ?? true;
    this.autoSpeed = opts.autoSpeedRadPerS ?? 0.13;
  }

  /** Adopt the camera's current pose (optionally re-targeting) as the orbit state. */
  captureFromCamera(camera: THREE.PerspectiveCamera, target?: THREE.Vector3 | readonly [number, number, number]): void {
    if (target) {
      const t = Array.isArray(target) ? new THREE.Vector3(target[0], target[1], target[2]) : (target as THREE.Vector3);
      this.target.copy(t);
      this.goalTarget.copy(t);
    }
    const off = this.scratch.copy(camera.position).sub(this.target);
    const d = Math.max(off.length(), MIN_DIST);
    this.dist = this.goalDist = THREE.MathUtils.clamp(d, MIN_DIST, MAX_DIST);
    this.yaw = this.goalYaw = Math.atan2(off.x, off.z);
    this.pitch = this.goalPitch = THREE.MathUtils.clamp(Math.asin(off.y / d), MIN_PITCH, MAX_PITCH);
    this.home = {
      yaw: this.yaw,
      pitch: this.pitch,
      dist: this.dist,
      target: this.target.clone(),
    };
  }

  /**
   * Jump straight to an absolute view with no damping — used by capture
   * scripts and tests that need a deterministic angle.
   */
  snapTo(
    camera: THREE.PerspectiveCamera,
    view: { yawDeg?: number; pitchDeg?: number; dist?: number; target?: readonly [number, number, number] },
  ): void {
    this.enabled = true;
    if (view.target) this.goalTarget.set(view.target[0], view.target[1], view.target[2]);
    if (view.yawDeg !== undefined) this.goalYaw = (view.yawDeg * Math.PI) / 180;
    if (view.pitchDeg !== undefined) {
      this.goalPitch = THREE.MathUtils.clamp((view.pitchDeg * Math.PI) / 180, MIN_PITCH, MAX_PITCH);
    }
    if (view.dist !== undefined) this.goalDist = THREE.MathUtils.clamp(view.dist, MIN_DIST, MAX_DIST);
    this.yaw = this.goalYaw;
    this.pitch = this.goalPitch;
    this.dist = this.goalDist;
    this.target.copy(this.goalTarget);
    this.update(0, camera);
  }

  /**
   * Snap back to the scene's authored viewpoint. Deliberately leaves the
   * auto-orbit toggle alone: "reset" restores the framing, it does not
   * silently restart a sweep the viewer switched off.
   */
  reset(): void {
    this.goalYaw = this.home.yaw;
    this.goalPitch = this.home.pitch;
    this.goalDist = this.home.dist;
    this.goalTarget.copy(this.home.target);
  }

  get orbitDistance(): number {
    return this.dist;
  }

  attach(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera): void {
    const engage = (stopAuto: boolean): void => {
      if (!this.enabled) {
        // Scene was driving the camera — adopt its pose, then take over.
        this.captureFromCamera(camera);
        this.enabled = true;
      }
      if (stopAuto) this.autoOrbit = false;
      if (!this.engaged) {
        this.engaged = true;
        this.onEngage?.();
      }
    };

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      try {
        // Throws for pointer ids the browser doesn't consider active
        // (synthetic events in tests) — dragging still works without capture.
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* non-fatal */
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      engage(true);
      if (this.pointers.size >= 2) {
        this.mode = 'pinch';
        this.pinchStart = this.pointerSpread();
        this.pinchStartDist = this.goalDist;
      } else {
        this.mode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'rotate';
      }
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.mode === 'pinch' && this.pointers.size >= 2) {
        const spread = this.pointerSpread();
        if (this.pinchStart > 1) {
          this.goalDist = THREE.MathUtils.clamp(this.pinchStartDist * (this.pinchStart / Math.max(spread, 1)), MIN_DIST, MAX_DIST);
        }
        // Two-finger drag also pans (average motion of both fingers).
        this.pan(camera, dx * 0.5, dy * 0.5);
      } else if (this.mode === 'pan') {
        this.pan(camera, dx, dy);
      } else if (this.mode === 'rotate') {
        this.goalYaw -= dx * 0.006;
        this.goalPitch = THREE.MathUtils.clamp(this.goalPitch + dy * 0.006, MIN_PITCH, MAX_PITCH);
      }
    });

    const release = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.mode = 'none';
      else if (this.pointers.size === 1) this.mode = 'rotate';
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        engage(false); // zooming is compatible with auto-orbit
        const scale = Math.exp(THREE.MathUtils.clamp(e.deltaY, -240, 240) * 0.0014);
        this.goalDist = THREE.MathUtils.clamp(this.goalDist * scale, MIN_DIST, MAX_DIST);
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === ' ') {
        e.preventDefault();
        engage(false);
        this.autoOrbit = !this.autoOrbit;
        return;
      }
      if (k === 'r') {
        engage(false);
        this.reset();
        return;
      }
      this.keys.add(k);
    });
    window.addEventListener('keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointers.clear();
      this.mode = 'none';
    });
  }

  /** Advance damping/auto-orbit and write the pose onto the camera. */
  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (!this.enabled) return;

    if (this.autoOrbit && this.mode === 'none') this.goalYaw += this.autoSpeed * dt;
    this.applyKeys(dt, camera);

    // Critically-damped follow: smooth without feeling laggy.
    const k = 1 - Math.exp(-dt * 11);
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    this.dist += (this.goalDist - this.dist) * k;
    this.target.lerp(this.goalTarget, k);

    const cp = this.scratch
      .set(
        Math.sin(this.yaw) * Math.cos(this.pitch),
        Math.sin(this.pitch),
        Math.cos(this.yaw) * Math.cos(this.pitch),
      )
      .multiplyScalar(this.dist)
      .add(this.target);
    camera.position.copy(cp);
    camera.lookAt(this.target);
  }

  private applyKeys(dt: number, camera: THREE.PerspectiveCamera): void {
    if (this.keys.size === 0) return;
    const step = Math.max(this.dist * 0.55, 1.2) * dt;
    const has = (...names: string[]): boolean => names.some((n) => this.keys.has(n));
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), flat).negate();
    if (has('w', 'arrowup')) this.goalTarget.addScaledVector(flat, step);
    if (has('s', 'arrowdown')) this.goalTarget.addScaledVector(flat, -step);
    if (has('a', 'arrowleft')) this.goalTarget.addScaledVector(right, -step);
    if (has('d', 'arrowright')) this.goalTarget.addScaledVector(right, step);
    if (has('e')) this.goalTarget.y += step;
    if (has('q')) this.goalTarget.y -= step;
    if (has('=', '+')) this.goalDist = THREE.MathUtils.clamp(this.goalDist * (1 - dt * 1.6), MIN_DIST, MAX_DIST);
    if (has('-', '_')) this.goalDist = THREE.MathUtils.clamp(this.goalDist * (1 + dt * 1.6), MIN_DIST, MAX_DIST);
  }

  private pan(camera: THREE.PerspectiveCamera, dx: number, dy: number): void {
    // Screen-space drag → world pan, scaled so the grabbed point tracks the cursor.
    const perPixel = (2 * Math.tan((camera.fov * Math.PI) / 360) * this.dist) / Math.max(window.innerHeight, 1);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    this.goalTarget.addScaledVector(right, -dx * perPixel);
    this.goalTarget.addScaledVector(up, dy * perPixel);
  }

  private pointerSpread(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
}
