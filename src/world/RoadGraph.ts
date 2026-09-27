import type { Vec2 } from "../core/types";
import { dist } from "../core/types";

export interface RoadNode {
  id: string;
  x: number;
  y: number;
  hasTrafficLight: boolean;
  /** Traffic-light phase: which axis currently has green. Toggled by TrafficSystem. */
  lightAxis: "ns" | "ew";
  lightTimer: number;
}

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  length: number;
  lanes: number;
  speedLimit: number; // world units / sim-minute
  /** Current congestion 0..1, updated by TrafficSystem, consumed by pathfinding as a cost penalty. */
  congestion: number;
}

/**
 * The navigable road network. Undirected for pathfinding purposes but edges
 * are stored once and traversed both ways (city streets are two-way unless
 * flagged otherwise — one-ways are a possible future extension, not needed
 * at current scope).
 */
export class RoadGraph {
  nodes: Map<string, RoadNode> = new Map();
  edges: Map<string, RoadEdge> = new Map();
  private adjacency: Map<string, RoadEdge[]> = new Map();

  addNode(node: RoadNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, []);
  }

  addEdge(edge: Omit<RoadEdge, "length" | "congestion">): RoadEdge {
    const from = this.nodes.get(edge.from);
    const to = this.nodes.get(edge.to);
    if (!from || !to) throw new Error(`RoadGraph.addEdge: missing node ${edge.from} or ${edge.to}`);
    const full: RoadEdge = { ...edge, length: dist(from, to), congestion: 0 };
    this.edges.set(full.id, full);
    this.adjacency.get(from.id)!.push(full);
    this.adjacency.get(to.id)!.push(full);
    return full;
  }

  neighborsOf(nodeId: string): RoadEdge[] {
    return this.adjacency.get(nodeId) ?? [];
  }

  other(edge: RoadEdge, nodeId: string): string {
    return edge.from === nodeId ? edge.to : edge.from;
  }

  /** Which traffic-light axis this edge belongs to, based on its dominant direction. */
  axisOf(edge: RoadEdge): "ns" | "ew" {
    const a = this.nodes.get(edge.from)!;
    const b = this.nodes.get(edge.to)!;
    return Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? "ew" : "ns";
  }

  nearestNode(pos: Vec2): RoadNode | undefined {
    let best: RoadNode | undefined;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      const d = dist(pos, n);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /**
   * A* pathfinding over the road graph. Edge cost = travel time estimate,
   * i.e. length / effectiveSpeed, where effectiveSpeed is reduced by
   * congestion. This makes congested routes naturally less attractive
   * without needing a separate "avoid traffic" heuristic.
   */
  findPath(startNodeId: string, goalNodeId: string): string[] | null {
    if (startNodeId === goalNodeId) return [startNodeId];
    const goal = this.nodes.get(goalNodeId);
    if (!goal || !this.nodes.has(startNodeId)) return null;

    const gScore = new Map<string, number>([[startNodeId, 0]]);
    const fScore = new Map<string, number>([[startNodeId, this.heuristic(startNodeId, goalNodeId)]]);
    const cameFrom = new Map<string, string>();
    const open = new Set<string>([startNodeId]);
    const closed = new Set<string>();

    while (open.size > 0) {
      let current: string | null = null;
      let currentF = Infinity;
      for (const id of open) {
        const f = fScore.get(id) ?? Infinity;
        if (f < currentF) {
          currentF = f;
          current = id;
        }
      }
      if (current === null) break;
      if (current === goalNodeId) return this.reconstruct(cameFrom, current);

      open.delete(current);
      closed.add(current);

      for (const edge of this.neighborsOf(current)) {
        const neighbor = this.other(edge, current);
        if (closed.has(neighbor)) continue;
        const effSpeed = edge.speedLimit * (1 - 0.7 * edge.congestion);
        const cost = edge.length / Math.max(effSpeed, 0.5);
        const tentativeG = (gScore.get(current) ?? Infinity) + cost;
        if (tentativeG < (gScore.get(neighbor) ?? Infinity)) {
          cameFrom.set(neighbor, current);
          gScore.set(neighbor, tentativeG);
          fScore.set(neighbor, tentativeG + this.heuristic(neighbor, goalNodeId));
          open.add(neighbor);
        }
      }
    }
    return null; // unreachable
  }

  private heuristic(fromId: string, toId: string): number {
    const a = this.nodes.get(fromId);
    const b = this.nodes.get(toId);
    if (!a || !b) return 0;
    return dist(a, b) / 10; // optimistic: assume max speed 10 units/min
  }

  private reconstruct(cameFrom: Map<string, string>, current: string): string[] {
    const path = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      path.unshift(current);
    }
    return path;
  }

  /** True iff every node can reach every other node — used by worldgen to validate connectivity. */
  isFullyConnected(): boolean {
    if (this.nodes.size === 0) return true;
    const start = this.nodes.keys().next().value as string;
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const edge of this.neighborsOf(cur)) {
        const other = this.other(edge, cur);
        if (!seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
    }
    return seen.size === this.nodes.size;
  }
}
