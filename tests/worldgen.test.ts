import { describe, it, expect } from "vitest";
import { generateCity } from "../src/world/WorldGen";

describe("generateCity", () => {
  it("produces a fully connected road network", () => {
    const city = generateCity(42);
    expect(city.roads.isFullyConnected()).toBe(true);
  });

  it("is deterministic for a given seed", () => {
    const a = generateCity(42);
    const b = generateCity(42);
    expect(a.buildings.size).toBe(b.buildings.size);
    expect(a.roads.nodes.size).toBe(b.roads.nodes.size);
    const aFirst = Array.from(a.buildings.values())[0];
    const bFirst = Array.from(b.buildings.values())[0];
    expect(aFirst.x).toBe(bFirst.x);
    expect(aFirst.kind).toBe(bFirst.kind);
  });

  it("produces all 8 districts", () => {
    const city = generateCity(7);
    expect(city.districts.size).toBe(8);
  });

  it("includes at least one of each essential civic building", () => {
    const city = generateCity(7);
    for (const kind of ["hospital", "police_station", "fire_station", "government"] as const) {
      expect(city.buildingsOfKind(kind).length).toBeGreaterThan(0);
    }
  });

  it("has enough residential capacity to house a reasonable population", () => {
    const city = generateCity(7);
    const capacity = Array.from(city.buildings.values()).reduce((sum, b) => sum + b.residentCapacity, 0);
    expect(capacity).toBeGreaterThan(200);
  });

  it("every building snaps to a real road node", () => {
    const city = generateCity(7);
    for (const b of city.buildings.values()) {
      expect(city.roads.nodes.has(b.nearestRoadNodeId)).toBe(true);
    }
  });
});
