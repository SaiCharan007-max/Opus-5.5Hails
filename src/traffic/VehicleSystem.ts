import { dist, type Vec2 } from "../core/types";
import type { City } from "../world/City";
import type { Building } from "../world/City";
import type { Vehicle, VehicleKind } from "./Vehicle";

const LIGHT_CYCLE_MINUTES = 2;
/** Vehicles per edge before it's considered fully congested (congestion -> 1). */
const EDGE_CAPACITY = 4;

/**
 * Owns vehicle movement, traffic-light cycling, and per-edge congestion.
 * Congestion is written back onto RoadGraph edges so pedestrian AND vehicle
 * pathfinding both naturally route around jams (see RoadGraph.findPath's
 * cost function) without either system needing to know about the other.
 */
export class VehicleSystem {
  vehicles: Map<string, Vehicle> = new Map();
  private edgeOccupancy: Map<string, number> = new Map();

  constructor(private city: City) {}

  spawnParked(id: string, kind: VehicleKind, ownerNpcId: string | undefined, atBuilding: Building): Vehicle {
    const v: Vehicle = {
      id,
      kind,
      ownerNpcId,
      pos: { x: atBuilding.x, y: atBuilding.y },
      health: 100,
      speed: 0,
      maxSpeed: speedFor(kind),
      pathNodeIds: [],
      pathIndex: 0,
      waiting: false,
      parkedBuildingId: atBuilding.id,
      currentRoadNodeId: atBuilding.nearestRoadNodeId,
    };
    this.vehicles.set(id, v);
    return v;
  }

  /** Assigns a route to the target building. Returns false if unreachable. */
  requestTrip(vehicleId: string, target: Building): boolean {
    const v = this.vehicles.get(vehicleId);
    if (!v) return false;
    const startNode = v.currentRoadNodeId ?? this.city.roads.nearestNode(v.pos)?.id;
    if (!startNode) return false;
    const path = this.city.roads.findPath(startNode, target.nearestRoadNodeId);
    if (!path) return false;
    v.pathNodeIds = path;
    v.pathIndex = 0;
    v.parkedBuildingId = undefined;
    return true;
  }

  /** Instantly relocates a vehicle to a building, clearing any in-progress trip. Used when the vehicle's
   * owning NPC is far enough away to be simulated abstractly and shouldn't keep consuming per-tick movement. */
  parkAt(vehicleId: string, building: Building): void {
    const v = this.vehicles.get(vehicleId);
    if (!v) return;
    v.pos = { x: building.x, y: building.y };
    v.pathNodeIds = [];
    v.pathIndex = 0;
    v.speed = 0;
    v.parkedBuildingId = building.id;
    v.currentRoadNodeId = building.nearestRoadNodeId;
  }

  /** True once the vehicle has consumed its path (nothing left to drive toward). */
  hasArrived(vehicleId: string): boolean {
    const v = this.vehicles.get(vehicleId);
    return !v || v.pathNodeIds.length === 0;
  }

  update(dtMinutes: number): void {
    this.cycleTrafficLights(dtMinutes);
    this.decayCongestion(dtMinutes);

    for (const v of this.vehicles.values()) {
      if (v.pathNodeIds.length === 0) {
        v.speed = 0;
        continue;
      }
      this.driveOneStep(v, dtMinutes);
    }

    this.recomputeCongestionFromOccupancy();
  }

  private driveOneStep(v: Vehicle, dtMinutes: number): void {
    const nodeId = v.pathNodeIds[v.pathIndex];
    const node = this.city.roads.nodes.get(nodeId);
    if (!node) {
      v.pathIndex++;
      return;
    }

    // Find the edge we're currently traversing to read its congestion/speed limit.
    const prevNodeId = v.currentRoadNodeId ?? nodeId;
    const edge = this.city.roads.neighborsOf(prevNodeId).find((e) => this.city.roads.other(e, prevNodeId) === nodeId);

    if (edge) {
      const key = edge.id;
      this.edgeOccupancy.set(key, (this.edgeOccupancy.get(key) ?? 0) + 1);
    }

    const approachAxis = edge ? this.city.roads.axisOf(edge) : "ew";
    const atRedLight = node.hasTrafficLight && node.lightAxis !== approachAxis && dist(v.pos, node) < 14;

    if (atRedLight) {
      v.waiting = true;
      v.speed = 0;
      return;
    }
    v.waiting = false;

    const speedLimit = edge ? edge.speedLimit * (1 - 0.7 * edge.congestion) : v.maxSpeed;
    v.speed = Math.min(v.maxSpeed, speedLimit);

    let remaining = v.speed * dtMinutes;
    while (remaining > 0 && v.pathIndex < v.pathNodeIds.length) {
      const curNodeId = v.pathNodeIds[v.pathIndex];
      const curNode = this.city.roads.nodes.get(curNodeId);
      if (!curNode) {
        v.pathIndex++;
        continue;
      }
      const d = dist(v.pos, curNode);
      if (d <= remaining) {
        v.pos = { x: curNode.x, y: curNode.y };
        v.currentRoadNodeId = curNodeId;
        remaining -= d;
        v.pathIndex++;
      } else {
        const t = remaining / d;
        v.pos = { x: v.pos.x + (curNode.x - v.pos.x) * t, y: v.pos.y + (curNode.y - v.pos.y) * t };
        remaining = 0;
      }
      // Re-check for a red light at the next node before continuing this step.
      if (v.pathIndex < v.pathNodeIds.length) {
        const nextNode = this.city.roads.nodes.get(v.pathNodeIds[v.pathIndex]);
        if (nextNode?.hasTrafficLight) break;
      }
    }

    if (v.pathIndex >= v.pathNodeIds.length) {
      v.pathNodeIds = [];
      v.speed = 0;
    }
  }

  private cycleTrafficLights(dtMinutes: number): void {
    for (const node of this.city.roads.nodes.values()) {
      if (!node.hasTrafficLight) continue;
      node.lightTimer -= dtMinutes;
      if (node.lightTimer <= 0) {
        node.lightAxis = node.lightAxis === "ns" ? "ew" : "ns";
        node.lightTimer = LIGHT_CYCLE_MINUTES;
      }
    }
  }

  private decayCongestion(dtMinutes: number): void {
    for (const edge of this.city.roads.edges.values()) {
      edge.congestion = Math.max(0, edge.congestion - 0.05 * dtMinutes);
    }
  }

  private recomputeCongestionFromOccupancy(): void {
    for (const [edgeId, count] of this.edgeOccupancy) {
      const edge = this.city.roads.edges.get(edgeId);
      if (!edge) continue;
      const target = Math.min(1, count / (EDGE_CAPACITY * edge.lanes));
      edge.congestion = Math.max(edge.congestion, target);
    }
    this.edgeOccupancy.clear();
  }

  /** Removes a vehicle entirely (e.g. destroyed in chaos testing / combat). */
  destroy(vehicleId: string): void {
    this.vehicles.delete(vehicleId);
  }
}

function speedFor(kind: VehicleKind): number {
  switch (kind) {
    case "bus":
    case "truck":
      return 10;
    case "police_car":
    case "ambulance":
    case "fire_truck":
      return 20;
    default:
      return 16;
  }
}

export function vehiclePos(system: VehicleSystem, id: string): Vec2 | undefined {
  return system.vehicles.get(id)?.pos;
}
