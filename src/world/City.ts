import type { BuildingKind, DistrictKind } from "../core/types";
import { RoadGraph } from "./RoadGraph";

export interface District {
  id: string;
  kind: DistrictKind;
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Building {
  id: string;
  kind: BuildingKind;
  name: string;
  districtId: string;
  x: number;
  y: number;
  nearestRoadNodeId: string;
  /** Max simultaneous jobs this building offers (0 for homes/parks). */
  jobCapacity: number;
  employeeIds: string[];
  /** Max residents (0 for non-residential). */
  residentCapacity: number;
  residentIds: string[];
  openHour: number;
  closeHour: number;
  /** Only meaningful for shops/restaurants/offices — drives economy + business.closed events. */
  businessId?: string;
}

export class City {
  seed: number;
  roads = new RoadGraph();
  districts: Map<string, District> = new Map();
  buildings: Map<string, Building> = new Map();

  constructor(seed: number) {
    this.seed = seed;
  }

  districtAt(x: number, y: number): District | undefined {
    for (const d of this.districts.values()) {
      if (x >= d.minX && x <= d.maxX && y >= d.minY && y <= d.maxY) return d;
    }
    return undefined;
  }

  buildingsOfKind(kind: BuildingKind): Building[] {
    return Array.from(this.buildings.values()).filter((b) => b.kind === kind);
  }
}
