import type { Vec2 } from "../core/types";

export type VehicleKind = "sedan" | "taxi" | "bus" | "truck" | "police_car" | "fire_truck" | "ambulance";

export interface Vehicle {
  id: string;
  kind: VehicleKind;
  ownerNpcId?: string;
  pos: Vec2;
  health: number;
  speed: number; // current world units / sim-minute
  maxSpeed: number;

  pathNodeIds: string[];
  pathIndex: number;
  /** True while stopped at a red light / yielding — used by the renderer and by congestion accounting. */
  waiting: boolean;

  parkedBuildingId?: string;
  currentRoadNodeId?: string;
}
