import { describe, it, expect } from "vitest";
import { RoadGraph } from "../src/world/RoadGraph";

function grid(n: number): RoadGraph {
  const g = new RoadGraph();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      g.addNode({ id: `${x}_${y}`, x: x * 10, y: y * 10, hasTrafficLight: false, lightAxis: "ns", lightTimer: 0 });
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x < n - 1) g.addEdge({ id: `h_${x}_${y}`, from: `${x}_${y}`, to: `${x + 1}_${y}`, lanes: 1, speedLimit: 10 });
      if (y < n - 1) g.addEdge({ id: `v_${x}_${y}`, from: `${x}_${y}`, to: `${x}_${y + 1}`, lanes: 1, speedLimit: 10 });
    }
  }
  return g;
}

describe("RoadGraph.findPath", () => {
  it("finds a path across a grid", () => {
    const g = grid(5);
    const path = g.findPath("0_0", "4_4");
    expect(path).not.toBeNull();
    expect(path![0]).toBe("0_0");
    expect(path![path!.length - 1]).toBe("4_4");
  });

  it("returns a single-node path when start === goal", () => {
    const g = grid(3);
    expect(g.findPath("1_1", "1_1")).toEqual(["1_1"]);
  });

  it("returns null for an unreachable node", () => {
    const g = grid(3);
    g.addNode({ id: "island", x: 999, y: 999, hasTrafficLight: false, lightAxis: "ns", lightTimer: 0 });
    expect(g.findPath("0_0", "island")).toBeNull();
  });

  it("prefers the lower-cost route when congestion penalizes an edge", () => {
    const g = grid(3);
    // Congest the direct horizontal route so the detour becomes cheaper.
    for (const e of g.edges.values()) {
      if (e.from.startsWith("0_") || e.to.startsWith("0_")) e.congestion = 0.95;
    }
    const path = g.findPath("0_0", "2_0");
    expect(path).not.toBeNull();
  });

  it("every consecutive pair in a path is a real edge", () => {
    const g = grid(6);
    const path = g.findPath("0_0", "5_5")!;
    for (let i = 0; i < path.length - 1; i++) {
      const neighbors = g.neighborsOf(path[i]).map((e) => g.other(e, path[i]));
      expect(neighbors).toContain(path[i + 1]);
    }
  });

  it("isFullyConnected detects a disconnected graph", () => {
    const g = grid(3);
    g.addNode({ id: "island", x: 999, y: 999, hasTrafficLight: false, lightAxis: "ns", lightTimer: 0 });
    expect(g.isFullyConnected()).toBe(false);
  });

  it("isFullyConnected passes for a connected grid", () => {
    const g = grid(4);
    expect(g.isFullyConnected()).toBe(true);
  });
});
