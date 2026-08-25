import { describe, expect, it } from "vitest";
import { VolumePacketSimulation } from "./simulation";

describe("VolumePacketSimulation", () => {
  it("conserves emitted mass and remains above the ground", () => {
    const simulation = new VolumePacketSimulation();
    simulation.emit({ eventId: 1, simulationTimeS: 0, centerM: [0, 0, 0], radiusM: 3, fineMassKg: 680, impulseMps: [1, 0, 0], seed: 4 }, 17);
    for (let i = 0; i < 240; i++) simulation.update(1 / 60, [0.3, 0, 0], []);
    expect(simulation.totalMassKg).toBeCloseTo(680, 6);
    expect(simulation.packets.every((packet) => packet.position[1] >= 0.4)).toBe(true);
  });

  it("responds to off-screen body wakes", () => {
    const simulation = new VolumePacketSimulation();
    simulation.emit({ eventId: 1, simulationTimeS: 0, centerM: [0, 0, 0], radiusM: 1, fineMassKg: 10, impulseMps: [0, 0, 0], seed: 2 }, 1);
    const before = simulation.packets[0].velocity[0];
    simulation.update(0.1, [0, 0, 0], [{ bodyId: 1, positionM: [0, 1, 0], previousPositionM: [-1, 1, 0], velocityMps: [12, 0, 0], radiusM: 3, wakeScale: 2 }]);
    expect(simulation.packets[0].velocity[0]).toBeGreaterThan(before);
  });
});
