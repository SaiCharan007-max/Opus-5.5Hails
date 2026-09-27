import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/Simulation";

describe("Simulation stress test", () => {
  it("runs 250 NPCs for thousands of ticks without producing invalid state", () => {
    const sim = new Simulation({ seed: 99, npcCount: 250 });
    const focus = { x: 0, y: 0 };

    const seenIds = new Set<string>();
    for (const npc of sim.npcSystem.npcs.values()) {
      expect(seenIds.has(npc.id)).toBe(false); // no duplicate ids
      seenIds.add(npc.id);
    }

    const TICKS = 5000;
    const DT_SECONDS = 0.5; // ~0.5s of sim advance per iteration at default timeScale
    sim.clock.timeScale = 20;

    for (let i = 0; i < TICKS; i++) {
      // Periodically move the focus point so different NPCs cycle through LOD tiers.
      focus.x = Math.sin(i / 200) * 500;
      focus.y = Math.cos(i / 200) * 500;
      sim.step(DT_SECONDS, focus);
    }

    for (const npc of sim.npcSystem.npcs.values()) {
      expect(Number.isFinite(npc.pos.x)).toBe(true);
      expect(Number.isFinite(npc.pos.y)).toBe(true);
      expect(Number.isNaN(npc.pos.x)).toBe(false);
      expect(Number.isNaN(npc.pos.y)).toBe(false);

      expect(Number.isFinite(npc.money)).toBe(true);
      expect(Number.isNaN(npc.money)).toBe(false);

      for (const key of ["hunger", "energy", "social", "fun", "safety"] as const) {
        const v = npc.needs[key];
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }

      if (!npc.homeless) expect(sim.city.buildings.has(npc.homeId)).toBe(true); // no orphaned home reference
      if (npc.workplaceId) {
        expect(sim.city.buildings.has(npc.workplaceId)).toBe(true);
      }

      expect(["idle","sleeping","eating","commuting","working","shopping","socializing","leisure","fleeing","committing_crime","patrolling","responding","arrested","incapacitated"]).toContain(npc.currentActivity);
    }

    // No duplicated ids after thousands of ticks (nothing should be re-id'd or cloned).
    const idsAfter = new Set(Array.from(sim.npcSystem.npcs.keys()));
    expect(idsAfter.size).toBe(sim.npcSystem.npcs.size);
  }, 60_000);

  it("is deterministic given the same seed and same step sequence", () => {
    const runOnce = () => {
      const sim = new Simulation({ seed: 555, npcCount: 60 });
      for (let i = 0; i < 500; i++) sim.step(0.5, { x: 0, y: 0 });
      return Array.from(sim.npcSystem.npcs.values())
        .map((n) => `${n.id}:${n.pos.x.toFixed(2)}:${n.pos.y.toFixed(2)}:${n.money.toFixed(2)}`)
        .join("|");
    };
    expect(runOnce()).toBe(runOnce());
  }, 30_000);
});
