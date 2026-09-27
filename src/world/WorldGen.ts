import { SeededRandom } from "../core/Random";
import { nextId, type BuildingKind, type DistrictKind } from "../core/types";
import { City, type Building, type District } from "./City";

const BLOCK_SPACING = 120;

interface DistrictSpec {
  kind: DistrictKind;
  name: string;
  gridX: number; // top-left cell coords, in block units
  gridY: number;
  gridW: number;
  gridH: number;
}

/**
 * Fixed 8-district layout on a 9x7 block grid. A fully procedural district
 * partitioner (Voronoi over random seeds) was considered, but a hand-tuned
 * layout guarantees sane adjacency (e.g. harbor on an edge, downtown
 * central) without needing adjacency-constraint solving — a reasonable
 * scope cut documented in DECISIONS.md.
 */
const DISTRICT_LAYOUT: DistrictSpec[] = [
  { kind: "downtown", name: "Downtown", gridX: 3, gridY: 2, gridW: 3, gridH: 2 },
  { kind: "financial", name: "Financial District", gridX: 6, gridY: 2, gridW: 2, gridH: 2 },
  { kind: "residential", name: "Maple Residential", gridX: 0, gridY: 0, gridW: 3, gridH: 3 },
  { kind: "suburbs", name: "Willow Suburbs", gridX: 0, gridY: 3, gridW: 3, gridH: 3 },
  { kind: "old_town", name: "Old Town", gridX: 3, gridY: 0, gridW: 3, gridH: 2 },
  { kind: "entertainment", name: "Entertainment Strip", gridX: 6, gridY: 0, gridW: 3, gridH: 2 },
  { kind: "industrial", name: "Ironworks Industrial", gridX: 6, gridY: 4, gridW: 3, gridH: 3 },
  { kind: "harbor", name: "Harbor District", gridX: 3, gridY: 4, gridW: 3, gridH: 3 },
];

const GRID_W = 9;
const GRID_H = 7;

/** Building weight tables per district — determines what gets built where. */
const DISTRICT_BUILDING_MIX: Record<DistrictKind, Partial<Record<BuildingKind, number>>> = {
  downtown: { office: 5, shop: 3, restaurant: 3, home_apartment: 2, bank: 1, parking: 2 },
  financial: { office: 6, bank: 3, restaurant: 1, parking: 2 },
  residential: { home_apartment: 5, home_house: 3, shop: 1, park: 2, school: 1 },
  suburbs: { home_house: 6, park: 2, shop: 1, school: 1 },
  old_town: { shop: 4, restaurant: 3, home_apartment: 2, park: 1, government: 1 },
  entertainment: { restaurant: 4, shop: 3, home_apartment: 1, park: 1 },
  industrial: { warehouse: 6, office: 1, parking: 2 },
  harbor: { warehouse: 4, restaurant: 1, park: 1, home_apartment: 1 },
};

const BUILDING_NAME_PARTS: Record<BuildingKind, string[]> = {
  home_apartment: ["Riverside", "Elm", "Cedar", "Highline", "Union"],
  home_house: ["Maple St", "Willow Ln", "Birch Ave", "Sunset Rd"],
  office: ["Meridian", "Quantum", "Apex", "Vertex", "Summit"],
  shop: ["Corner Store", "Market", "General Goods", "Boutique"],
  restaurant: ["Diner", "Bistro", "Grill", "Cafe", "Noodle House"],
  hospital: ["General Hospital", "Medical Center"],
  police_station: ["Police Precinct"],
  fire_station: ["Fire Station"],
  park: ["Commons", "Gardens", "Green", "Park"],
  warehouse: ["Logistics", "Freight Co", "Storage", "Distribution"],
  government: ["City Hall", "Municipal Building", "Courthouse"],
  parking: ["Parking Garage"],
  school: ["Elementary School", "High School"],
  bank: ["Trust Bank", "Credit Union"],
};

function pickName(rng: SeededRandom, kind: BuildingKind, districtName: string): string {
  const parts = BUILDING_NAME_PARTS[kind];
  return `${districtName.split(" ")[0]} ${rng.pick(parts)}`;
}

export function generateCity(seed: number): City {
  const rng = new SeededRandom(seed);
  const city = new City(seed);

  buildRoadGrid(city, rng);
  buildDistricts(city);
  ensureConnectivity(city);
  placeBuildings(city, rng);
  placeCivicBuildings(city, rng);

  return city;
}

function buildRoadGrid(city: City, rng: SeededRandom): void {
  for (let gy = 0; gy <= GRID_H; gy++) {
    for (let gx = 0; gx <= GRID_W; gx++) {
      const id = nodeId(gx, gy);
      const isArterial = gx % 3 === 0 || gy % 3 === 0;
      city.roads.addNode({
        id,
        x: gx * BLOCK_SPACING,
        y: gy * BLOCK_SPACING,
        hasTrafficLight: false,
        lightAxis: rng.chance(0.5) ? "ns" : "ew",
        lightTimer: rng.float(0, 6),
      });
      void isArterial;
    }
  }
  for (let gy = 0; gy <= GRID_H; gy++) {
    for (let gx = 0; gx <= GRID_W; gx++) {
      const isArterialRow = gy % 3 === 0;
      const isArterialCol = gx % 3 === 0;
      if (gx < GRID_W) {
        city.roads.addEdge({
          id: `e_${nodeId(gx, gy)}_${nodeId(gx + 1, gy)}`,
          from: nodeId(gx, gy),
          to: nodeId(gx + 1, gy),
          lanes: isArterialRow ? 2 : 1,
          speedLimit: isArterialRow ? 14 : 8,
        });
      }
      if (gy < GRID_H) {
        city.roads.addEdge({
          id: `e_${nodeId(gx, gy)}_${nodeId(gx, gy + 1)}`,
          from: nodeId(gx, gy),
          to: nodeId(gx, gy + 1),
          lanes: isArterialCol ? 2 : 1,
          speedLimit: isArterialCol ? 14 : 8,
        });
      }
    }
  }
  // Traffic lights at any intersection with 3+ connecting roads.
  for (const node of city.roads.nodes.values()) {
    node.hasTrafficLight = city.roads.neighborsOf(node.id).length >= 3;
  }
}

function nodeId(gx: number, gy: number): string {
  return `n_${gx}_${gy}`;
}

function buildDistricts(city: City): void {
  for (const spec of DISTRICT_LAYOUT) {
    const id = nextId("district");
    const d: District = {
      id,
      kind: spec.kind,
      name: spec.name,
      minX: spec.gridX * BLOCK_SPACING,
      minY: spec.gridY * BLOCK_SPACING,
      maxX: (spec.gridX + spec.gridW) * BLOCK_SPACING,
      maxY: (spec.gridY + spec.gridH) * BLOCK_SPACING,
    };
    city.districts.set(id, d);
  }
}

function ensureConnectivity(city: City): void {
  if (!city.roads.isFullyConnected()) {
    throw new Error("WorldGen produced a disconnected road graph — grid generation invariant violated");
  }
}

function placeBuildings(city: City, rng: SeededRandom): void {
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const cx = (gx + 0.5) * BLOCK_SPACING;
      const cy = (gy + 0.5) * BLOCK_SPACING;
      const district = city.districtAt(cx, cy);
      if (!district) continue;
      const mix = DISTRICT_BUILDING_MIX[district.kind];
      const kinds = Object.keys(mix) as BuildingKind[];
      const weights = kinds.map((k) => mix[k]!);
      const buildingsInBlock = rng.int(1, 3);
      for (let b = 0; b < buildingsInBlock; b++) {
        const kind = weightedPick(rng, kinds, weights);
        const jitterX = rng.float(-BLOCK_SPACING * 0.3, BLOCK_SPACING * 0.3);
        const jitterY = rng.float(-BLOCK_SPACING * 0.3, BLOCK_SPACING * 0.3);
        const x = cx + jitterX;
        const y = cy + jitterY;
        const nearest = city.roads.nearestNode({ x, y })!;
        addBuilding(city, rng, district, kind, x, y, nearest.id);
      }
    }
  }
}

/** Force-place at least one of each civic building type so the city is functionally complete. */
function placeCivicBuildings(city: City, rng: SeededRandom): void {
  const required: { kind: BuildingKind; preferredDistrict: DistrictKind }[] = [
    { kind: "hospital", preferredDistrict: "downtown" },
    { kind: "police_station", preferredDistrict: "downtown" },
    { kind: "fire_station", preferredDistrict: "old_town" },
    { kind: "government", preferredDistrict: "downtown" },
  ];
  for (const req of required) {
    if (city.buildingsOfKind(req.kind).length > 0) continue;
    const district = Array.from(city.districts.values()).find((d) => d.kind === req.preferredDistrict)!;
    const x = rng.float(district.minX, district.maxX);
    const y = rng.float(district.minY, district.maxY);
    const nearest = city.roads.nearestNode({ x, y })!;
    addBuilding(city, rng, district, req.kind, x, y, nearest.id);
  }
}

function addBuilding(
  city: City,
  rng: SeededRandom,
  district: District,
  kind: BuildingKind,
  x: number,
  y: number,
  nearestRoadNodeId: string,
): void {
  const isResidential = kind === "home_apartment" || kind === "home_house";
  const isWorkplace = !isResidential && kind !== "park" && kind !== "parking";
  const building: Building = {
    id: nextId("bldg"),
    kind,
    name: pickName(rng, kind, district.name),
    districtId: district.id,
    x,
    y,
    nearestRoadNodeId,
    jobCapacity: isWorkplace ? jobCapacityFor(kind, rng) : 0,
    employeeIds: [],
    residentCapacity: isResidential ? residentCapacityFor(kind, rng) : 0,
    residentIds: [],
    openHour: defaultOpenHour(kind),
    closeHour: defaultCloseHour(kind),
  };
  city.buildings.set(building.id, building);
}

function jobCapacityFor(kind: BuildingKind, rng: SeededRandom): number {
  switch (kind) {
    case "office":
      return rng.int(8, 20);
    case "hospital":
      return rng.int(10, 25);
    case "police_station":
      return rng.int(8, 15);
    case "fire_station":
      return rng.int(6, 12);
    case "government":
      return rng.int(6, 15);
    case "warehouse":
      return rng.int(4, 10);
    case "shop":
      return rng.int(2, 5);
    case "restaurant":
      return rng.int(3, 8);
    case "bank":
      return rng.int(3, 6);
    case "school":
      return rng.int(6, 12);
    default:
      return rng.int(1, 4);
  }
}

function residentCapacityFor(kind: BuildingKind, rng: SeededRandom): number {
  return kind === "home_apartment" ? rng.int(6, 16) : rng.int(1, 4);
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
