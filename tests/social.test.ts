import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/Simulation";
import { addMemory, decayMemories, MAX_MEMORIES, MAX_RELATIONSHIPS } from "../src/social/Memory";

describe("Memory", () => {
  it("caps memories and forgets the least important first", () => {
    const sim = new Simulation({ seed: 41, npcCount: 20 });
    const npc = Array.from(sim.npcSystem.npcs.values())[0];
    npc.memories = [];
    addMemory(npc, { kind: "was_victim", note: "Mugged", valence: -1, importance: 0.99, at: 0 });
    for (let i = 0; i < 40; i++) addMemory(npc, { kind: "met", note: `Small talk ${i}`, valence: 0.1, importance: 0.1 + (i % 5) * 0.01, at: i * 400 });
    expect(npc.memories.length).toBeLessThanOrEqual(MAX_MEMORIES);
    expect(npc.memories.some((m) => m.note === "Mugged")).toBe(true);
  });

  it("merges near-duplicate memories instead of stacking them", () => {
    const sim = new Simulation({ seed: 42, npcCount: 20 });
    const npc = Array.from(sim.npcSystem.npcs.values())[0];
    npc.memories = [];
    for (let i = 0; i < 5; i++) addMemory(npc, { kind: "argument", note: "Argued with X", valence: -0.5, importance: 0.4, at: i * 10 });
    expect(npc.memories).toHaveLength(1);
  });

  it("fades trivial memories over days but keeps traumatic ones longer", () => {
    const sim = new Simulation({ seed: 43, npcCount: 20 });
    const npc = Array.from(sim.npcSystem.npcs.values())[0];
    npc.memories = [];
    addMemory(npc, { kind: "met", note: "Trivial", valence: 0, importance: 0.2, at: 0 });
    addMemory(npc, { kind: "was_victim", note: "Traumatic", valence: -1, importance: 0.95, at: 0 });
    for (let d = 0; d < 12; d++) decayMemories(npc);
    expect(npc.memories.some((m) => m.note === "Trivial")).toBe(false);
    expect(npc.memories.some((m) => m.note === "Traumatic")).toBe(true);
  });
});

describe("Relationships", () => {
  it("form from shared time and stay valid over a long run", () => {
    const sim = new Simulation({ seed: 44, npcCount: 250 });
    sim.runHeadless(15);
    let total = 0;
    let friends = 0;
    for (const npc of sim.npcSystem.npcs.values()) {
      expect(npc.relationships.size).toBeLessThanOrEqual(MAX_RELATIONSHIPS + 1);
      for (const [id, r] of npc.relationships) {
        expect(id).not.toBe(npc.id);
        expect(sim.npcSystem.npcs.has(id)).toBe(true);
        expect(r.trust).toBeGreaterThanOrEqual(-100);
        expect(r.trust).toBeLessThanOrEqual(100);
        total++;
        if (r.type === "friend") friends++;
      }
      if (npc.partnerId) {
        const p = sim.npcSystem.npcs.get(npc.partnerId)!;
        if (p.alive && npc.alive) expect(p.partnerId).toBe(npc.id);
      }
    }
    expect(total).toBeGreaterThan(250);
    expect(friends).toBeGreaterThan(10);
  }, 60_000);
});

describe("Long-run determinism", () => {
  it("same seed produces an identical history over 10 days", () => {
    const run = () => {
      const sim = new Simulation({ seed: 45, npcCount: 250 });
      sim.runHeadless(10);
      return JSON.stringify({ chronicle: sim.chronicle.entries, stats: sim.economy.statsHistory });
    };
    expect(run()).toBe(run());
  }, 60_000);
});
