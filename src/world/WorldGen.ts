import { SeededRandom } from "../core/Random";
import { nextId, type BuildingKind, type DistrictKind } from "../core/types";
import { City, type Building, type District } from "./City";
import { BLOCK_SPACING, GRID_H, GRID_W, roadHalfWidth, SIDEWALK_WIDTH } from "./constants";

interface DistrictSpec {
  kind: DistrictKind;
  name: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

/**
 * Fixed 8-district layout on the block grid. Hand-tuned rather than Voronoi so
 * adjacency is always sane (harbor on the coast, downtown central); everything
 * inside a district is procedural. See DECISIONS.md.
 */
const DISTRICT_LAYOUT: DistrictSpec[] = [
  { kind: "downtown", name: "Downtown", gridX: 3, gridY: 2, gridW: 3, gridH: 2 },
  { kind: "financial", name: "Financial District", gridX: 6, gridY: 2, gridW: 3, gridH: 2 },
  { kind: "residential", name: "Maple Heights", gridX: 0, gridY: 0, gridW: 3, gridH: 3 },
  { kind: "suburbs", name: "Willow Park", gridX: 0, gridY: 3, gridW: 3, gridH: 4 },
  { kind: "old_town", name: "Old Town", gridX: 3, gridY: 0, gridW: 3, gridH: 2 },
  { kind: "entertainment", name: "Neon Row", gridX: 6, gridY: 0, gridW: 3, gridH: 2 },
  { kind: "industrial", name: "Ironworks", gridX: 6, gridY: 4, gridW: 3, gridH: 3 },
  { kind: "harbor", name: "Harbor", gridX: 3, gridY: 4, gridW: 3, gridH: 3 },
];

interface DistrictStyle {
  /** Lot grid per block [cols, rows]; one is picked per block. */
  lotGrids: [number, number][];
  /** Setback from lot edge to building wall. */
  setback: number;
  floors: [number, number];
  parkChance: number;
  mix: Partial<Record<BuildingKind, number>>;
}

const DISTRICT_STYLE: Record<DistrictKind, DistrictStyle> = {
  downtown: {
    lotGrids: [[2, 2], [2, 1], [1, 2]],
    setback: 2.5,
    floors: [6, 18],
    parkChance: 0.06,
    mix: { office: 5, shop: 2, restaurant: 2, home_apartment: 3, bank: 1, parking: 1 },
  },
  financial: {
    lotGrids: [[2, 2], [1, 1], [2, 1]],
    setback: 3,
    floors: [10, 26],
    parkChance: 0.04,
    mix: { office: 7, bank: 2, restaurant: 1, home_apartment: 1, parking: 1 },
  },
  residential: {
    lotGrids: [[3, 2], [2, 3], [3, 3]],
    setback: 3,
    floors: [3, 6],
    parkChance: 0.12,
    mix: { home_apartment: 6, home_house: 2, shop: 1, restaurant: 1, school: 0.6 },
  },
  suburbs: {
    lotGrids: [[3, 3], [3, 2]],
    setback: 5.5,
    floors: [1, 2],
    parkChance: 0.1,
    mix: { home_house: 9, shop: 0.6, school: 0.5 },
  },
  old_town: {
    lotGrids: [[3, 3], [4, 3], [3, 4]],
    setback: 0.8,
    floors: [2, 4],
    parkChance: 0.08,
    mix: { shop: 4, restaurant: 3, home_apartment: 3, government: 0.3 },
  },
  entertainment: {
    lotGrids: [[2, 2], [3, 2]],
    setback: 1.5,
    floors: [2, 7],
    parkChance: 0.05,
    mix: { restaurant: 4, shop: 3, home_apartment: 2, parking: 0.8 },
  },
  industrial: {
    lotGrids: [[1, 2], [2, 1], [2, 2]],
    setback: 4,
    floors: [1, 3],
    parkChance: 0.02,
    mix: { warehouse: 7, office: 0.8, parking: 1 },
  },
  harbor: {
    lotGrids: [[1, 2], [2, 2], [2, 1]],
    setback: 4,
    floors: [1, 3],
    parkChance: 0.04,
    mix: { warehouse: 5, restaurant: 1, home_apartment: 1, shop: 0.5 },
  },
};

const NAME_PARTS: Record<BuildingKind, string[]> = {
  home_apartment: ["Riverside Flats", "Elm Court", "Cedar House", "Highline Lofts", "Union Tower", "The Arbor"],
  home_house: ["Residence"],
  office: ["Meridian", "Quantum Labs", "Apex Holdings", "Vertex Media", "Summit Group", "Northwind Co"],
  shop: ["Corner Market", "General Goods", "Hardware", "Books & Co", "Pharmacy", "Electronics"],
  restaurant: ["Diner", "Bistro", "Grill", "Cafe", "Noodle House", "Pizzeria", "Taqueria"],
  hospital: ["General Hospital"],
  police_station: ["Police Precinct"],
  fire_station: ["Fire Station 1"],
  park: ["Commons", "Gardens", "Green", "Park"],
  warehouse: ["Logistics", "Freight Co", "Storage", "Distribution", "Cold Storage"],
  government: ["City Hall", "Courthouse", "Municipal Records"],
  parking: ["Parking"],
  school: ["Elementary School", "High School"],
  bank: ["Trust Bank", "Credit Union"],
};

const STREET_NAMES = ["Maple", "Oak", "Elm", "Pine", "Cedar", "Birch", "Walnut", "Harbor", "Main", "Market"];

export function generateCity(seed: number): City {
  const rng = new SeededRandom(seed);
  const city = new City(seed);

  buildRoadGrid(city, rng);
  buildDistricts(city);
  if (!city.roads.isFullyConnected()) {
    throw new Error("WorldGen produced a disconnected road graph");
  }
  placeBuildings(city, rng);
  placeCivicBuildings(city, rng);
  return city;
}

function nodeId(gx: number, gy: number): string {
  return `n_${gx}_${gy}`;
}

export function isArterialLine(i: number): boolean {
  return i % 3 === 0;
}

function buildRoadGrid(city: City, rng: SeededRandom): void {
  for (let gy = 0; gy <= GRID_H; gy++) {
    for (let gx = 0; gx <= GRID_W; gx++) {
      city.roads.addNode({
        id: nodeId(gx, gy),
        x: gx * BLOCK_SPACING,
        y: gy * BLOCK_SPACING,
        hasTrafficLight: false,
        lightAxis: rng.chance(0.5) ? "ns" : "ew",
        lightTimer: rng.float(0, 2),
      });
    }
  }
  for (let gy = 0; gy <= GRID_H; gy++) {
    for (let gx = 0; gx <= GRID_W; gx++) {
      if (gx < GRID_W) {
        const arterial = isArterialLine(gy);
        city.roads.addEdge({
          id: `e_${nodeId(gx, gy)}_${nodeId(gx + 1, gy)}`,
          from: nodeId(gx, gy),
          to: nodeId(gx + 1, gy),
          lanes: arterial ? 2 : 1,
          speedLimit: arterial ? 14 : 8,
        });
      }
      if (gy < GRID_H) {
        const arterial = isArterialLine(gx);
        city.roads.addEdge({
          id: `e_${nodeId(gx, gy)}_${nodeId(gx, gy + 1)}`,
          from: nodeId(gx, gy),
          to: nodeId(gx, gy + 1),
          lanes: arterial ? 2 : 1,
          speedLimit: arterial ? 14 : 8,
        });
      }
    }
  }
  for (const node of city.roads.nodes.values()) {
    node.hasTrafficLight = city.roads.neighborsOf(node.id).length >= 3;
  }
}

function buildDistricts(city: City): void {
  for (const spec of DISTRICT_LAYOUT) {
    const d: District = {
      id: nextId("district"),
      kind: spec.kind,
      name: spec.name,
      minX: spec.gridX * BLOCK_SPACING,
      minY: spec.gridY * BLOCK_SPACING,
      maxX: (spec.gridX + spec.gridW) * BLOCK_SPACING,
      maxY: (spec.gridY + spec.gridH) * BLOCK_SPACING,
    };
    city.districts.set(d.id, d);
  }
}

/** Buildable interior of a block cell, inside the roads and sidewalks. */
export function blockInterior(gx: number, gy: number): { x0: number; y0: number; x1: number; y1: number } {
  const left = roadHalfWidth(isArterialLine(gx) ? 2 : 1) + SIDEWALK_WIDTH;
  const right = roadHalfWidth(isArterialLine(gx + 1) ? 2 : 1) + SIDEWALK_WIDTH;
  const top = roadHalfWidth(isArterialLine(gy) ? 2 : 1) + SIDEWALK_WIDTH;
  const bottom = roadHalfWidth(isArterialLine(gy + 1) ? 2 : 1) + SIDEWALK_WIDTH;
  return {
    x0: gx * BLOCK_SPACING + left,
    y0: gy * BLOCK_SPACING + top,
    x1: (gx + 1) * BLOCK_SPACING - right,
    y1: (gy + 1) * BLOCK_SPACING - bottom,
  };
}

function placeBuildings(city: City, rng: SeededRandom): void {
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const b = blockInterior(gx, gy);
      const district = city.districtAt((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      if (!district) continue;
      const style = DISTRICT_STYLE[district.kind];

      if (rng.chance(style.parkChance)) {
        addBuilding(city, rng, district, "park", b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0);
        continue;
      }

      const [cols, rows] = rng.pick(style.lotGrids);
      const lotW = (b.x1 - b.x0) / cols;
      const lotH = (b.y1 - b.y0) / rows;
      const kinds = Object.keys(style.mix) as BuildingKind[];
      const weights = kinds.map((k) => style.mix[k]!);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const kind = weightedPick(rng, kinds, weights);
          const setback = kind === "parking" ? 0.5 : style.setback;
          const shrinkX = kind === "home_house" ? rng.float(0.05, 0.2) : rng.float(0, 0.08);
          const shrinkY = kind === "home_house" ? rng.float(0.05, 0.2) : rng.float(0, 0.08);
          const w = Math.max(6, (lotW - setback * 2) * (1 - shrinkX));
          const h = Math.max(6, (lotH - setback * 2) * (1 - shrinkY));
          const lx = b.x0 + c * lotW + (lotW - w) / 2;
          const ly = b.y0 + r * lotH + (lotH - h) / 2;
          addBuilding(city, rng, district, kind, lx, ly, w, h, floorsFor(kind, style, rng));
        }
      }
    }
  }
}

function floorsFor(kind: BuildingKind, style: DistrictStyle, rng: SeededRandom): number {
  switch (kind) {
    case "parking":
    case "park":
      return 0;
    case "home_house":
      return rng.int(1, 2);
    case "warehouse":
      return rng.int(1, 2);
    case "school":
    case "fire_station":
    case "police_station":
      return rng.int(2, 3);
    case "hospital":
      return rng.int(5, 8);
    case "government":
      return rng.int(3, 5);
    default:
      return rng.int(style.floors[0], style.floors[1]);
  }
}

/**
 * Civic buildings are guaranteed by converting an existing ordinary lot in the
 * preferred district, so they sit on a real lot instead of overlapping others.
 */
function placeCivicBuildings(city: City, rng: SeededRandom): void {
  const required: { kind: BuildingKind; preferred: DistrictKind; floors: number }[] = [
    { kind: "hospital", preferred: "downtown", floors: 7 },
    { kind: "police_station", preferred: "downtown", floors: 3 },
    { kind: "police_station", preferred: "old_town", floors: 2 },
    { kind: "fire_station", preferred: "old_town", floors: 2 },
    { kind: "government", preferred: "downtown", floors: 4 },
    { kind: "school", preferred: "residential", floors: 2 },
  ];
  for (let i = 0; i < required.length; i++) {
    const req = required[i];
    const needSoFar = required.slice(0, i + 1).filter((r) => r.kind === req.kind).length;
    if (city.buildingsOfKind(req.kind).length >= needSoFar) continue;
    const district = Array.from(city.districts.values()).find((d) => d.kind === req.preferred)!;
    const candidates = Array.from(city.buildings.values()).filter(
      (b) =>
        b.districtId === district.id &&
        b.kind !== "park" &&
        !isCivic(b.kind) &&
        b.w * b.h > 500,
    );
    const target = candidates.length ? rng.pick(candidates) : undefined;
    if (!target) continue;
    target.kind = req.kind;
    target.floors = req.floors;
    target.vacant = false;
    target.name = NAME_PARTS[req.kind][0];
    target.residentCapacity = 0;
    target.jobCapacity = jobCapacityFor(req.kind, rng);
    target.openHour = defaultOpenHour(req.kind);
    target.closeHour = defaultCloseHour(req.kind);
  }
}

function isCivic(kind: BuildingKind): boolean {
  return ["hospital", "police_station", "fire_station", "government", "school"].includes(kind);
}

function addBuilding(
  city: City,
  rng: SeededRandom,
  district: District,
  kind: BuildingKind,
  x0: number,
  y0: number,
  w: number,
  h: number,
  floors: number,
): void {
  const x = x0 + w / 2;
  const y = y0 + h / 2;
  const isResidential = kind === "home_apartment" || kind === "home_house";
  const isCommercial = kind === "shop" || kind === "restaurant" || kind === "office";
  const vacant = isCommercial && rng.chance(0.3);
  const isWorkplace = !isResidential && kind !== "park" && kind !== "parking" && !vacant;
  const building: Building = {
    id: nextId("bldg"),
    kind,
    name: buildingName(rng, kind, district),
    districtId: district.id,
    x,
    y,
    w,
    h,
    floors,
    vacant,
    nearestRoadNodeId: city.roads.nearestNode({ x, y })!.id,
    jobCapacity: isWorkplace ? jobCapacityFor(kind, rng) : 0,
    employeeIds: [],
    residentCapacity: isResidential ? residentCapacityFor(kind, floors, rng) : 0,
    residentIds: [],
    openHour: defaultOpenHour(kind),
    closeHour: defaultCloseHour(kind),
  };
  city.buildings.set(building.id, building);
}

function buildingName(rng: SeededRandom, kind: BuildingKind, district: District): string {
  if (kind === "home_house") return `${rng.int(2, 199)} ${rng.pick(STREET_NAMES)} St`;
  if (kind === "park") return `${district.name.split(" ")[0]} ${rng.pick(NAME_PARTS.park)}`;
  if (kind === "restaurant") return `${rng.pick(STREET_NAMES)} ${rng.pick(NAME_PARTS.restaurant)}`;
  if (kind === "shop") return `${rng.pick(STREET_NAMES)} ${rng.pick(NAME_PARTS.shop)}`;
  if (kind === "parking") return `${district.name} Parking`;
  return rng.pick(NAME_PARTS[kind]);
}

function jobCapacityFor(kind: BuildingKind, rng: SeededRandom): number {
  switch (kind) {
    case "office":
      return rng.int(3, 8);
    case "hospital":
      return rng.int(10, 16);
    case "police_station":
      return rng.int(6, 10);
    case "fire_station":
      return rng.int(5, 8);
    case "government":
      return rng.int(5, 9);
    case "warehouse":
      return rng.int(2, 5);
    case "shop":
      return rng.int(1, 3);
    case "restaurant":
      return rng.int(2, 4);
    case "bank":
      return rng.int(2, 4);
    case "school":
      return rng.int(4, 8);
    default:
      return rng.int(1, 3);
  }
}

function residentCapacityFor(kind: BuildingKind, floors: number, rng: SeededRandom): number {
  return kind === "home_apartment" ? Math.max(4, Math.round(floors * rng.float(1, 1.8))) : rng.int(1, 4);
}

function defaultOpenHour(kind: BuildingKind): number {
  if (kind === "restaurant") return 7;
  if (kind === "shop") return 8;
  if (kind === "office" || kind === "bank" || kind === "government") return 9;
  return 0;
}

function defaultCloseHour(kind: BuildingKind): number {
  if (kind === "restaurant") return 23;
  if (kind === "shop") return 21;
  if (kind === "office" || kind === "bank" || kind === "government") return 18;
  return 24;
}

function weightedPick<T>(rng: SeededRandom, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.float(0, total);
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
