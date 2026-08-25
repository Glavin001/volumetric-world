import type { DynamicBodySample, MediumEmissionEvent, Vec3, VolumePacket } from "./types";

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** Deterministic world-space packet simulation used by the far-field tier. */
export class VolumePacketSimulation {
  readonly packets: VolumePacket[] = [];
  private nextId = 1;
  private accumulator = 0;
  readonly fixedStep = 1 / 20;

  emit(event: MediumEmissionEvent, count = 34): void {
    const packetMass = event.fineMassKg / count;
    for (let i = 0; i < count; i++) {
      const angle = i * 2.399963 + event.seed;
      const ring = Math.sqrt((i + 0.5) / count) * event.radiusM;
      const lift = 0.2 + 1.1 * this.random(event.seed + i * 17);
      const radial: Vec3 = [Math.cos(angle) * ring, lift, Math.sin(angle) * ring];
      const speed = 0.8 + this.random(event.seed + i * 31) * 2.1;
      this.packets.push({
        id: this.nextId++,
        position: add(event.centerM, radial),
        velocity: add(event.impulseMps, [Math.cos(angle) * speed, lift * 1.3, Math.sin(angle) * speed]),
        radii: [1.2 + ring * 0.18, 0.8 + lift * 0.4, 1.2 + ring * 0.18],
        massKg: packetMass,
        ageSeconds: 0,
        seed: event.seed + i,
      });
    }
  }

  update(delta: number, wind: Vec3, bodies: readonly DynamicBodySample[]): void {
    this.accumulator = Math.min(this.accumulator + delta, 0.25);
    while (this.accumulator >= this.fixedStep) {
      this.step(this.fixedStep, wind, bodies);
      this.accumulator -= this.fixedStep;
    }
  }

  clear(): void {
    this.packets.length = 0;
  }

  get totalMassKg(): number {
    return this.packets.reduce((sum, packet) => sum + packet.massKg, 0);
  }

  private step(dt: number, wind: Vec3, bodies: readonly DynamicBodySample[]): void {
    for (const packet of this.packets) {
      let velocity = packet.velocity;
      const coupling = 1 - Math.exp(-dt * 0.75);
      velocity = add(velocity, scale([wind[0] - velocity[0], wind[1] - velocity[1], wind[2] - velocity[2]], coupling));

      // Cold aerosol loading creates a slow gravity current rather than ballistic fall.
      velocity = add(velocity, [0, -0.42 * dt * Math.min(packet.massKg / 40, 1), 0]);

      for (const body of bodies) {
        const offset: Vec3 = [packet.position[0] - body.positionM[0], packet.position[1] - body.positionM[1], packet.position[2] - body.positionM[2]];
        const range = body.radiusM * 5;
        const distance = length(offset);
        if (distance < range) {
          const wake = (1 - distance / range) ** 2 * body.wakeScale * dt;
          velocity = add(velocity, scale(body.velocityMps, wake));
        }
      }

      let position = add(packet.position, scale(velocity, dt));
      if (position[1] < 0.4) {
        position = [position[0], 0.4, position[2]];
        velocity = [velocity[0] * 0.98, Math.max(0, velocity[1]) * 0.15, velocity[2] * 0.98];
      }
      const growth = dt * (0.28 + Math.min(packet.ageSeconds * 0.015, 0.16));
      packet.position = position;
      packet.velocity = velocity;
      packet.radii = [packet.radii[0] + growth, packet.radii[1] + growth * 0.42, packet.radii[2] + growth];
      packet.ageSeconds += dt;
    }
  }

  private random(seed: number): number {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }
}
