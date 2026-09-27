import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/Simulation";

describe("Economy", () => {
  it("conserves money: the ledger matches cash in the city after 20 days", () => {
    const sim = new Simulation({ seed: 21, npcCount: 250 });
    const start = sim.economy.moneyInCity();
    sim.runHeadless(20);
    const ext = sim.economy.external;
    const expected = start + ext.exports - ext.imports + ext.debtForgiven;
    expect(Math.abs(sim.economy.moneyInCity() - expected)).toBeLessThan(1e-3 * Math.abs(expected));
  }, 60_000);

  it("keeps employment and housing records consistent in both directions", () => {
    const sim = new Simulation({ seed: 22, npcCount: 250 });
    sim.runHeadless(25);
    for (const npc of sim.npcSystem.npcs.values()) {
      expect(npc.money).toBeGreaterThanOrEqual(0);
      if (npc.workplaceId) {
        const w = sim.city.buildings.get(npc.workplaceId)!;
        expect(w.employeeIds).toContain(npc.id);
        expect(w.vacant).toBe(false);
      }
      if (npc.homeless) {
        expect(npc.homeId).toBe("");
      } else if (npc.alive) {
        expect(sim.city.buildings.get(npc.homeId)!.residentIds).toContain(npc.id);
      }
    }
    for (const b of sim.city.buildings.values()) {
      for (const id of b.employeeIds) expect(sim.npcSystem.npcs.get(id)!.workplaceId).toBe(b.id);
      for (const id of b.residentIds) expect(sim.npcSystem.npcs.get(id)!.homeId).toBe(b.id);
      expect(b.residentIds.length).toBeLessThanOrEqual(b.residentCapacity);
      if (b.vacant) expect(b.employeeIds).toHaveLength(0);
    }
  }, 60_000);

  it("a bankrupt business closes and its staff lose their jobs", () => {
    const sim = new Simulation({ seed: 23, npcCount: 250 });
    const biz = Array.from(sim.economy.businesses.values()).find((b) => sim.city.buildings.get(b.buildingId)!.employeeIds.length >= 2)!;
    const building = sim.city.buildings.get(biz.buildingId)!;
    const staff = building.employeeIds.slice();
    biz.cash = -1_000_000;
    sim.runHeadless(6);
    expect(sim.economy.businesses.has(biz.id)).toBe(false);
    expect(building.vacant).toBe(true);
    for (const id of staff) {
      const npc = sim.npcSystem.npcs.get(id)!;
      expect(npc.workplaceId === building.id).toBe(false);
    }
    expect(sim.chronicle.entries.some((e) => e.text.includes(biz.name) && e.text.includes("closed"))).toBe(true);
  }, 60_000);

  it("customers pay businesses and businesses pay wages", () => {
    const sim = new Simulation({ seed: 24, npcCount: 250 });
    sim.runHeadless(2);
    const history = Array.from(sim.economy.businesses.values()).flatMap((b) => b.history);
    const customers = history.reduce((a, h) => a + h.customers, 0);
    expect(customers).toBeGreaterThan(50);
    expect(sim.economy.external.exports).toBeGreaterThan(0);
  }, 60_000);
});
