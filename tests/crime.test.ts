import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/Simulation";
import { dist } from "../src/core/types";
import type { NPC } from "../src/npc/NPC";

function setup(seed: number) {
  const sim = new Simulation({ seed, npcCount: 120 });
  const shop = Array.from(sim.city.buildings.values()).find((b) => b.kind === "shop" && sim.economy.businessAt(b.id))!;
  const npcs = Array.from(sim.npcSystem.npcs.values());
  const suspect = npcs.find((n) => n.occupation !== "police_officer")!;
  return { sim, shop, npcs, suspect };
}

function placeAt(npc: NPC, x: number, y: number) {
  npc.pos = { x, y };
  npc.pathNodeIds = [];
  npc.inVehicle = false;
}

describe("Crime and police response", () => {
  it("a witnessed crime is reported, police drive from a station, and the suspect is arrested", () => {
    const { sim, shop, npcs, suspect } = setup(31);
    // Keep the suspect at the scene; honest, brave witnesses next to them.
    placeAt(suspect, shop.x, shop.y);
    suspect.personality.aggression = 0.2;
    const witnesses = npcs.filter((n) => n !== suspect && n.occupation !== "police_officer").slice(0, 3);
    for (const w of witnesses) {
      placeAt(w, shop.x + 5, shop.y + 5);
      w.personality.honesty = 1;
      w.personality.bravery = 1;
      w.faction = "civilians";
      w.currentActivity = "leisure";
    }
    const recordBefore = suspect.criminalRecord;
    sim.crime.onCrimeIntent(suspect, shop);
    expect(sim.emergency.incidents.size).toBe(1);
    for (const w of witnesses) expect(w.memories.some((m) => m.kind === "witnessed_crime" && m.aboutNpcId === suspect.id)).toBe(true);

    const unit = () => Array.from(sim.emergency.units.values()).find((u) => u.incidentId !== undefined || u.status !== "idle");
    const stations = sim.city.buildingsOfKind("police_station");
    let dispatchedFromStation = false;
    for (let i = 0; i < 4000 && suspect.status !== "arrested"; i++) {
      // Suspect stays put for the test.
      if (suspect.status === "free") placeAt(suspect, shop.x, shop.y);
      sim.tick({ x: shop.x, y: shop.y });
      const u = unit();
      if (u && u.status === "responding") {
        dispatchedFromStation = stations.some((s) => s.id === u.stationId);
      }
    }
    expect(dispatchedFromStation).toBe(true);
    expect(suspect.status).toBe("arrested");
    expect(suspect.criminalRecord).toBe(recordBefore + 1);
    expect(suspect.releaseAtMinutes).toBeGreaterThan(sim.clock.totalMinutes);
  }, 60_000);

  it("an unwitnessed crime never becomes a police incident", () => {
    const { sim, suspect } = setup(32);
    const shop = Array.from(sim.city.buildings.values()).find((b) => b.kind === "shop" && sim.economy.businessAt(b.id))!;
    // Empty the neighborhood and the shop.
    for (const n of sim.npcSystem.npcs.values()) if (n !== suspect) placeAt(n, -5000, -5000);
    shop.employeeIds = [];
    placeAt(suspect, shop.x, shop.y);
    sim.crime.onCrimeIntent(suspect, shop);
    expect(sim.emergency.incidents.size).toBe(0);
  });

  it("arrested people are released after serving their time", () => {
    const { sim, suspect } = setup(33);
    suspect.status = "arrested";
    suspect.releaseAtMinutes = sim.clock.totalMinutes + 30;
    sim.clock.timeScale = 10; // each tick = 1 sim minute
    for (let i = 0; i < 40; i++) sim.tick({ x: 0, y: 0 });
    expect(suspect.status).toBe("free");
  });

  it("emergency units only ever start from their stations", () => {
    const { sim } = setup(34);
    for (const u of sim.emergency.units.values()) {
      const v = sim.vehicleSystem.vehicles.get(u.vehicleId)!;
      const station = sim.city.buildings.get(u.stationId)!;
      expect(dist(v.pos, station)).toBeLessThan(1);
    }
  });
});
