import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/Simulation";
import { dist } from "../src/core/types";
import { CITY_HEIGHT, CITY_WIDTH } from "../src/world/constants";

function runMorning(sim: Simulation, untilHour: number) {
  const focus = { x: CITY_WIDTH / 2, y: CITY_HEIGHT / 2 };
  sim.clock.timeScale = 10;
  let maxDriving = 0;
  while (sim.clock.now().hour < untilHour) {
    sim.step(0.1, focus);
    let d = 0;
    for (const n of sim.npcSystem.npcs.values()) if (n.inVehicle) d++;
    maxDriving = Math.max(maxDriving, d);
  }
  return maxDriving;
}

describe("NPCs actually travel", () => {
  it("vehicles cover real distance during the morning commute", () => {
    const sim = new Simulation({ seed: 7, npcCount: 250 });
    const start = new Map(Array.from(sim.vehicleSystem.vehicles.values()).map((v) => [v.id, { ...v.pos }]));
    const maxDriving = runMorning(sim, 10);
    expect(maxDriving).toBeGreaterThan(20);
    let travelled = 0;
    for (const v of sim.vehicleSystem.vehicles.values()) {
      if (dist(v.pos, start.get(v.id)!) > 150) travelled++;
    }
    expect(travelled).toBeGreaterThan(sim.vehicleSystem.vehicles.size * 0.3);
  }, 60_000);

  it("most employed adults are at their workplace by mid-morning", () => {
    const sim = new Simulation({ seed: 7, npcCount: 250 });
    runMorning(sim, 11);
    const workers = Array.from(sim.npcSystem.npcs.values()).filter(
      (n) => n.workplaceId && n.occupation !== "student" && n.occupation !== "police_officer" && n.occupation !== "firefighter",
    );
    const atWork = workers.filter((n) => {
      const w = sim.city.buildings.get(n.workplaceId!)!;
      return dist(n.pos, w) < 10;
    });
    expect(atWork.length).toBeGreaterThan(workers.length * 0.6);
  }, 60_000);
});
