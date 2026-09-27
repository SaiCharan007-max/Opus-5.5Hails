import { Container, Graphics } from "pixi.js";
import { SeededRandom } from "../core/Random";
import type { City, Building } from "../world/City";
import { BLOCK_SPACING, CITY_HEIGHT, CITY_WIDTH, GRID_H, GRID_W, roadHalfWidth, SHORELINE_Y, SIDEWALK_WIDTH } from "../world/constants";
import { blockInterior, isArterialLine } from "../world/WorldGen";
import type { RoadEdge } from "../world/RoadGraph";
import {
  APARTMENT_ROOFS,
  BUILDING_LOOK,
  CAR_COLORS,
  HOUSE_ROOFS,
  LIGHT,
  LOT_GROUND,
  OFFICE_ROOFS,
  ROAD,
  TERRAIN,
  hashString,
} from "./palette";

export interface PaintedCity {
  /** Drawn under vehicles and pedestrians. */
  ground: Container;
  /** Drawn over vehicles and pedestrians (tall roofs occlude the street behind them). */
  structures: Container;
  /** Additive-blend night lights: lit windows and lamp glow. Alpha is driven by darkness. */
  nightLights: Container;
  /** Lit-window layer per building, so brightness can follow who is actually inside. */
  windowsByBuilding: Map<string, Graphics>;
}

const TERRAIN_MARGIN = 1400;

/** Visual wall height (oblique projection offset) for a building. */
export function wallHeight(b: Building): number {
  if (b.kind === "park" || b.kind === "parking") return 0;
  if (b.kind === "home_house") return 2.5 + b.floors * 1.5;
  return Math.min(4 + b.floors * 1.35, 30);
}

/**
 * Paints the static city once at startup. Nothing here changes per frame, so
 * the GPU keeps the geometry and per-frame cost is zero; dynamic things
 * (vehicles, people, signals, darkness) live in other layers.
 */
export function paintCity(city: City): PaintedCity {
  const rng = new SeededRandom(city.seed ^ 0x9e3779b9);
  const ground = new Container();
  const structures = new Container();
  const nightLights = new Container();

  const terrain = new Graphics();
  const lots = new Graphics();
  const roads = new Graphics();
  const markings = new Graphics();
  const shadows = new Graphics();
  ground.addChild(terrain, lots, roads, markings, shadows);

  const buildings = new Graphics();
  const foliage = new Graphics();
  structures.addChild(buildings, foliage);

  const lamps = new Graphics();
  lamps.blendMode = "add";
  const windowLayer = new Container();
  windowLayer.blendMode = "add";
  nightLights.addChild(lamps, windowLayer);
  const windowsByBuilding = new Map<string, Graphics>();

  paintTerrain(terrain, foliage, rng);
  paintCoast(terrain, structures, rng);
  paintLots(city, lots);
  paintRoads(city, roads, markings, foliage, lamps);

  const sorted = Array.from(city.buildings.values()).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  for (const b of sorted) {
    if (b.kind === "park") paintPark(b, lots, foliage, rng);
    else if (b.kind === "parking") paintParking(b, lots, rng);
    else {
      const windows = new Graphics();
      windowLayer.addChild(windows);
      windowsByBuilding.set(b.id, windows);
      paintBuilding(b, shadows, buildings, windows, foliage, rng);
    }
  }

  return { ground, structures, nightLights, windowsByBuilding };
}

function paintTerrain(g: Graphics, foliage: Graphics, rng: SeededRandom): void {
  const x0 = -TERRAIN_MARGIN;
  const y0 = -TERRAIN_MARGIN;
  const x1 = CITY_WIDTH + TERRAIN_MARGIN;
  g.rect(x0, y0, x1 - x0, SHORELINE_Y - y0).fill(TERRAIN.countryside);

  // Patchwork farmland and woods around the city, leaving a green belt at the edge.
  const cell = 90;
  for (let y = y0; y < SHORELINE_Y - cell; y += cell) {
    for (let x = x0; x < x1; x += cell) {
      const inCity = x > -cell * 1.4 && x < CITY_WIDTH + cell * 0.4 && y > -cell * 1.4;
      if (inCity) continue;
      const roll = rng.next();
      if (roll < 0.45) {
        const shade = rng.pick([TERRAIN.field, 0x7d8a4f, 0x5d7440, 0x8a8250]);
        g.rect(x + 4, y + 4, cell - 8, cell - 8).fill(shade);
        for (let k = 8; k < cell - 8; k += 6) {
          g.moveTo(x + 6, y + k).lineTo(x + cell - 6, y + k).stroke({ width: 0.6, color: 0x000000, alpha: 0.08 });
        }
      } else if (roll < 0.75) {
        for (let t = 0; t < 14; t++) {
          tree(foliage, x + rng.float(6, cell - 6), y + rng.float(6, cell - 6), rng.float(4, 7), rng);
        }
      }
    }
  }
}

function paintCoast(g: Graphics, structures: Container, rng: SeededRandom): void {
  const x0 = -TERRAIN_MARGIN;
  const x1 = CITY_WIDTH + TERRAIN_MARGIN;
  const seaTop = SHORELINE_Y;
  g.rect(x0, seaTop, x1 - x0, TERRAIN_MARGIN).fill(TERRAIN.sea);
  // Depth shading in soft steps rather than one hard band.
  for (let i = 1; i <= 6; i++) {
    g.rect(x0, seaTop + i * 45, x1 - x0, TERRAIN_MARGIN).fill({ color: TERRAIN.seaDeep, alpha: 0.18 });
  }
  g.rect(x0, seaTop, x1 - x0, 5).fill({ color: 0xbfe3f2, alpha: 0.25 });

  // Shore: sand beach west/east, concrete quay along harbor + industrial.
  const cityEdge = CITY_HEIGHT + roadHalfWidth(2) + SIDEWALK_WIDTH;
  g.rect(x0, cityEdge, x1 - x0, seaTop - cityEdge).fill(TERRAIN.sand);
  const quayX0 = 3 * BLOCK_SPACING;
  const quayX1 = 9 * BLOCK_SPACING;
  g.rect(quayX0, cityEdge, quayX1 - quayX0, seaTop - cityEdge + 6).fill(TERRAIN.quay);

  // Piers with container stacks and moored ships.
  for (let px = quayX0 + 30; px < quayX1 - 20; px += 70) {
    g.rect(px, seaTop, 14, 70).fill(TERRAIN.quay);
    g.rect(px, seaTop, 14, 70).stroke({ width: 0.8, color: 0x000000, alpha: 0.25 });
    if (rng.chance(0.55)) ship(g, px + 24, seaTop + 18 + rng.float(0, 20), rng);
  }
  for (let cx = quayX0 + 8; cx < quayX1 - 12; cx += 10) {
    if (!rng.chance(0.6)) continue;
    const color = rng.pick([0xb5452f, 0x2f6fb5, 0xd1a43b, 0x3f8f58, 0x8f8f8f]);
    g.rect(cx, cityEdge + 3, 8, 5).fill(color).stroke({ width: 0.4, color: 0x000000, alpha: 0.35 });
  }

  // Waves.
  for (let i = 0; i < 260; i++) {
    const wx = rng.float(x0, x1);
    const wy = rng.float(seaTop + 20, seaTop + TERRAIN_MARGIN - 20);
    g.moveTo(wx, wy).lineTo(wx + rng.float(6, 14), wy).stroke({ width: 0.8, color: TERRAIN.wave, alpha: 0.35 });
  }
  void structures;
}

function ship(g: Graphics, x: number, y: number, rng: SeededRandom): void {
  const len = rng.float(40, 70);
  const w = rng.float(10, 14);
  g.poly([x, y, x + len * 0.85, y, x + len, y + w / 2, x + len * 0.85, y + w, x, y + w]).fill(0x2b2f36);
  g.rect(x + 3, y + 2, len * 0.6, w - 4).fill(rng.pick([0xb5452f, 0x2f6fb5, 0xd1a43b, 0x3f8f58]));
  g.rect(x + len * 0.66, y + 2, len * 0.14, w - 4).fill(0xe8e6df);
}

function paintLots(city: City, g: Graphics): void {
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const b = blockInterior(gx, gy);
      const d = city.districtAt((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      const color = d ? LOT_GROUND[d.kind] : TERRAIN.countryside;
      g.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0).fill(color);
    }
  }
}

function edgeGeom(city: City, e: RoadEdge) {
  const a = city.roads.nodes.get(e.from)!;
  const b = city.roads.nodes.get(e.to)!;
  const horizontal = city.roads.axisOf(e) === "ew";
  const hw = roadHalfWidth(e.lanes);
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const len = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  return { a, b, horizontal, hw, minX, minY, len };
}

/** Half-extent of an intersection box along each axis. */
function crossHalf(city: City, nodeId: string): { hx: number; hy: number } {
  let hx = 0;
  let hy = 0;
  for (const e of city.roads.neighborsOf(nodeId)) {
    const hw = roadHalfWidth(e.lanes);
    if (city.roads.axisOf(e) === "ns") hx = Math.max(hx, hw);
    else hy = Math.max(hy, hw);
  }
  return { hx, hy };
}

function paintRoads(city: City, roads: Graphics, marks: Graphics, foliage: Graphics, lamps: Graphics): void {
  const edges = Array.from(city.roads.edges.values());
  const sw = SIDEWALK_WIDTH;

  // Visual-only roads leaving the city along arterials, so it sits in a region rather than a void.
  for (let gx = 0; gx <= GRID_W; gx += 3) {
    roads.rect(gx * BLOCK_SPACING - roadHalfWidth(2), -TERRAIN_MARGIN, roadHalfWidth(2) * 2, TERRAIN_MARGIN).fill(ROAD.asphaltArterial);
  }
  for (let gy = 0; gy <= GRID_H; gy += 3) {
    roads.rect(-TERRAIN_MARGIN, gy * BLOCK_SPACING - roadHalfWidth(2), TERRAIN_MARGIN, roadHalfWidth(2) * 2).fill(ROAD.asphaltArterial);
    roads.rect(CITY_WIDTH, gy * BLOCK_SPACING - roadHalfWidth(2), TERRAIN_MARGIN, roadHalfWidth(2) * 2).fill(ROAD.asphaltArterial);
  }

  for (const e of edges) {
    const { horizontal, hw, minX, minY, len } = edgeGeom(city, e);
    if (horizontal) roads.rect(minX, minY - hw - sw, len, (hw + sw) * 2).fill(ROAD.sidewalk);
    else roads.rect(minX - hw - sw, minY, (hw + sw) * 2, len).fill(ROAD.sidewalk);
  }
  for (const e of edges) {
    const { horizontal, hw, minX, minY, len } = edgeGeom(city, e);
    const color = e.lanes >= 2 ? ROAD.asphaltArterial : ROAD.asphalt;
    if (horizontal) {
      roads.rect(minX, minY - hw - 0.6, len, 0.6).fill(ROAD.curb);
      roads.rect(minX, minY + hw, len, 0.6).fill(ROAD.curb);
      roads.rect(minX, minY - hw, len, hw * 2).fill(color);
    } else {
      roads.rect(minX - hw - 0.6, minY, 0.6, len).fill(ROAD.curb);
      roads.rect(minX + hw, minY, 0.6, len).fill(ROAD.curb);
      roads.rect(minX - hw, minY, hw * 2, len).fill(color);
    }
  }
  for (const n of city.roads.nodes.values()) {
    const { hx, hy } = crossHalf(city, n.id);
    roads.rect(n.x - hx, n.y - hy, hx * 2, hy * 2).fill(ROAD.asphalt);
  }

  for (const e of edges) paintEdgeMarkings(city, e, marks);

  // Street lamps and street trees along sidewalks.
  for (const e of edges) {
    const { horizontal, hw, minX, minY, len } = edgeGeom(city, e);
    const off = hw + sw * 0.55;
    // Staggered lamps on alternating sides, like a real street, lighting the roadway.
    let side = 1;
    for (let t = 30; t < len - 20; t += 45) {
      const x = horizontal ? minX + t : minX + off * side;
      const y = horizontal ? minY + off * side : minY + t;
      const gx = horizontal ? x : minX + (off - 4) * side;
      const gy = horizontal ? minY + (off - 4) * side : y;
      foliage.circle(x, y, 0.8).fill(0x2a2c30);
      lamps.circle(gx, gy, 10).fill({ color: LIGHT.lamp, alpha: 0.045 });
      lamps.circle(gx, gy, 6).fill({ color: LIGHT.lamp, alpha: 0.05 });
      lamps.circle(x, y, 0.9).fill({ color: LIGHT.lamp, alpha: 0.9 });
      side = -side;
    }
    const d = city.districtAt(minX + (horizontal ? len / 2 : 0), minY + (horizontal ? 0 : len / 2));
    if (d && (d.kind === "residential" || d.kind === "suburbs" || d.kind === "old_town")) {
      const rng = new SeededRandom(hashString(e.id));
      for (let t = 40; t < len - 30; t += 38) {
        for (const side of [-1, 1]) {
          const x = horizontal ? minX + t : minX + off * side;
          const y = horizontal ? minY + off * side : minY + t;
          tree(foliage, x, y, rng.float(2.6, 3.6), rng);
        }
      }
    }
  }
}

function paintEdgeMarkings(city: City, e: RoadEdge, g: Graphics): void {
  const { a, b, horizontal, hw } = edgeGeom(city, e);
  const start = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const end = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  const lowNode = (horizontal ? a.x : a.y) <= (horizontal ? b.x : b.y) ? a : b;
  const highNode = lowNode === a ? b : a;
  const lowBox = crossHalf(city, lowNode.id);
  const highBox = crossHalf(city, highNode.id);
  const lowClear = (horizontal ? lowBox.hx : lowBox.hy) + 1;
  const highClear = (horizontal ? highBox.hx : highBox.hy) + 1;
  const s = start + lowClear;
  const t = end - highClear;
  const c = horizontal ? a.y : a.x;

  const rect = (along: number, across: number, lenAlong: number, lenAcross: number, color: number, alpha = 0.9) => {
    if (horizontal) g.rect(along, c + across, lenAlong, lenAcross).fill({ color, alpha });
    else g.rect(c + across, along, lenAcross, lenAlong).fill({ color, alpha });
  };

  const markStart = s + 7;
  const markEnd = t - 7;
  if (e.lanes >= 2) {
    rect(markStart, -0.9, markEnd - markStart, 0.5, ROAD.laneYellow);
    rect(markStart, 0.4, markEnd - markStart, 0.5, ROAD.laneYellow);
    for (let p = markStart; p < markEnd - 4; p += 9) {
      rect(p, -hw / 2 - 0.25, 4.5, 0.5, ROAD.laneWhite, 0.75);
      rect(p, hw / 2 - 0.25, 4.5, 0.5, ROAD.laneWhite, 0.75);
    }
  } else {
    for (let p = markStart; p < markEnd - 3; p += 8) rect(p, -0.25, 4, 0.5, ROAD.laneYellow, 0.8);
  }

  // Zebra crossings and stop lines at signalised intersections.
  for (const [node, from, dir] of [
    [lowNode, s, 1],
    [highNode, t, -1],
  ] as const) {
    if (!node.hasTrafficLight) continue;
    const z0 = dir === 1 ? from : from - 5;
    for (let k = -hw + 0.6; k < hw - 0.6; k += 2.2) rect(z0, k, 5, 1.1, ROAD.crosswalk, 0.85);
    // Traffic drives on the right: the lane entering this node is on the approaching car's right side.
    const stopAt = dir === 1 ? from + 6 : from - 6.8;
    if (dir === 1) rect(stopAt, -hw, 0.8, hw, ROAD.laneWhite);
    else rect(stopAt, 0, 0.8, hw, ROAD.laneWhite);
  }
}

function tree(g: Graphics, x: number, y: number, r: number, rng: SeededRandom): void {
  const base = rng.pick([0x3d6b35, 0x467a3b, 0x355e2f, 0x4f7f3a, 0x5a7d34]);
  g.circle(x + r * 0.35, y + r * 0.4, r).fill({ color: 0x000000, alpha: 0.22 });
  g.circle(x, y, r).fill(base);
  g.circle(x - r * 0.3, y - r * 0.3, r * 0.55).fill({ color: 0xffffff, alpha: 0.1 });
}

function paintPark(b: Building, g: Graphics, foliage: Graphics, rng: SeededRandom): void {
  const x0 = b.x - b.w / 2;
  const y0 = b.y - b.h / 2;
  g.rect(x0, y0, b.w, b.h).fill(0x5d8c47);
  g.rect(x0, y0, b.w, b.h).stroke({ width: 1.2, color: 0x4a7338 });
  const path = 0xcdbf97;
  g.moveTo(x0, y0).lineTo(x0 + b.w, y0 + b.h).stroke({ width: 2.4, color: path });
  g.moveTo(x0 + b.w, y0).lineTo(x0, y0 + b.h).stroke({ width: 2.4, color: path });
  g.circle(b.x, b.y, 9).fill(path);
  if (rng.chance(0.5)) {
    g.circle(b.x, b.y, 5.5).fill(0x3f7fa3);
    g.circle(b.x, b.y, 2).fill({ color: 0xbfe3f2, alpha: 0.8 });
  } else {
    g.ellipse(x0 + b.w * 0.27, y0 + b.h * 0.5, b.w * 0.12, b.h * 0.18).fill(0x3f7fa3);
  }
  const count = Math.round((b.w * b.h) / 260);
  for (let i = 0; i < count; i++) {
    const tx = rng.float(x0 + 4, x0 + b.w - 4);
    const ty = rng.float(y0 + 4, y0 + b.h - 4);
    const nearPath = Math.abs(ty - y0 - ((tx - x0) * b.h) / b.w) < 5 || Math.abs(ty - y0 - b.h + ((tx - x0) * b.h) / b.w) < 5;
    if (nearPath || Math.hypot(tx - b.x, ty - b.y) < 14) continue;
    tree(foliage, tx, ty, rng.float(3, 5.5), rng);
  }
}

function paintParking(b: Building, g: Graphics, rng: SeededRandom): void {
  const x0 = b.x - b.w / 2;
  const y0 = b.y - b.h / 2;
  g.rect(x0, y0, b.w, b.h).fill(0x46494f);
  g.rect(x0, y0, b.w, b.h).stroke({ width: 0.8, color: 0x9d9a91 });
  const rows = Math.max(1, Math.floor(b.h / 16));
  for (let r = 0; r < rows; r++) {
    const ry = y0 + 3 + r * 16;
    for (let x = x0 + 3; x < x0 + b.w - 5; x += 6) {
      g.rect(x, ry, 0.4, 9).fill({ color: 0xffffff, alpha: 0.55 });
      if (rng.chance(0.6)) {
        g.roundRect(x + 1, ry + 0.8, 4, 7.4, 1.2).fill(rng.pick(CAR_COLORS));
        g.rect(x + 1.6, ry + 2, 2.8, 1.6).fill({ color: 0x1a2330, alpha: 0.7 });
      }
    }
  }
}

function roofColor(b: Building, rng: SeededRandom): number {
  if (b.vacant) return 0xa4a39d;
  switch (b.kind) {
    case "home_house":
      return rng.pick(HOUSE_ROOFS);
    case "home_apartment":
      return rng.pick(APARTMENT_ROOFS);
    case "office":
      return rng.pick(OFFICE_ROOFS);
    default:
      return BUILDING_LOOK[b.kind].roof;
  }
}

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const bl = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | bl;
}

function paintBuilding(b: Building, shadows: Graphics, g: Graphics, windows: Graphics, foliage: Graphics, rng: SeededRandom): void {
  const look = BUILDING_LOOK[b.kind];
  const s = wallHeight(b);
  const x0 = b.x - b.w / 2;
  const y0 = b.y - b.h / 2;
  const roof = roofColor(b, rng);
  const wall = b.vacant ? 0x7d7c77 : b.kind === "home_house" ? shade(roof, 0.62) : look.wall;

  // Cast shadow toward the south-east (sun from the north-west in this projection).
  const sl = s * 0.55;
  shadows.poly([x0 + b.w, y0 - s, x0 + b.w + sl, y0 - s + sl * 0.6, x0 + b.w + sl, y0 + b.h + sl * 0.3, x0 + sl * 0.4, y0 + b.h + sl * 0.3, x0, y0 + b.h]).fill({ color: 0x000000, alpha: 0.22 });

  // South wall (the visible facade), then roof.
  g.rect(x0, y0 + b.h - s, b.w, s).fill(wall);
  g.rect(x0, y0 + b.h - s, b.w, s).stroke({ width: 0.5, color: 0x000000, alpha: 0.35 });

  const floors = Math.max(1, b.floors);
  const floorH = s / floors;
  const hasWindowGrid = b.kind !== "warehouse" && b.kind !== "home_house";
  if (hasWindowGrid && floorH > 0.7) {
    const cols = Math.max(1, Math.floor((b.w - 2) / 3.2));
    const pitch = (b.w - 2) / cols;
    for (let f = 0; f < floors; f++) {
      const wy = y0 + b.h - s + f * floorH + floorH * 0.22;
      const wh = floorH * 0.5;
      for (let c = 0; c < cols; c++) {
        const wx = x0 + 1 + c * pitch + pitch * 0.2;
        const ww = pitch * 0.6;
        g.rect(wx, wy, ww, wh).fill({ color: 0x1d2a38, alpha: 0.75 });
        if (rng.chance(litChance(b))) {
          windows.rect(wx, wy, ww, wh).fill({ color: LIGHT.window, alpha: rng.float(0.55, 0.95) });
        }
      }
    }
  } else if (b.kind === "home_house") {
    for (let wx = x0 + 2; wx < x0 + b.w - 3; wx += 5) {
      g.rect(wx, y0 + b.h - s * 0.75, 2.2, s * 0.45).fill({ color: 0x1d2a38, alpha: 0.8 });
      if (rng.chance(0.55)) windows.rect(wx, y0 + b.h - s * 0.75, 2.2, s * 0.45).fill({ color: LIGHT.window, alpha: 0.85 });
    }
  }

  // Storefront awnings and garage doors on the facade.
  if ((b.kind === "shop" || b.kind === "restaurant") && !b.vacant) {
    const aw = Math.min(3, s * 0.35);
    for (let x = x0; x < x0 + b.w; x += 3) {
      g.rect(x, y0 + b.h - aw, Math.min(1.5, x0 + b.w - x), aw).fill(look.accent ?? 0xffffff);
    }
    windows.rect(x0 + 1, y0 + b.h - aw - 0.8, b.w - 2, 0.6).fill({ color: LIGHT.window, alpha: 0.4 });
  }
  if (b.kind === "fire_station") {
    for (let x = x0 + 2; x < x0 + b.w - 6; x += 8) g.rect(x, y0 + b.h - s * 0.8, 6, s * 0.8).fill(0xd8d2c4);
  }

  const ry = y0 - s;
  g.rect(x0, ry, b.w, b.h).fill(roof);
  g.rect(x0, ry, b.w, b.h).stroke({ width: 0.6, color: shade(roof, 0.7) });
  paintRoofDetail(b, g, x0, ry, roof, look.accent, rng);

  if (b.kind === "home_house") {
    for (let i = rng.int(0, 2); i > 0; i--) {
      const side = rng.chance(0.5) ? -1 : 1;
      tree(foliage, b.x + side * (b.w / 2 + 3), b.y + rng.float(-b.h / 2, b.h / 2), rng.float(2.5, 4), rng);
    }
  }
}

function litChance(b: Building): number {
  if (b.kind === "home_apartment") return 0.45;
  if (b.kind === "office" || b.kind === "bank") return 0.22;
  if (b.kind === "hospital" || b.kind === "police_station") return 0.7;
  return 0.35;
}

function paintRoofDetail(b: Building, g: Graphics, x0: number, y0: number, roof: number, accent: number | undefined, rng: SeededRandom): void {
  const w = b.w;
  const h = b.h;
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  switch (b.kind) {
    case "home_house": {
      const horizontalRidge = w >= h;
      if (horizontalRidge) {
        g.rect(x0, y0, w, h / 2).fill(shade(roof, 1.12));
        g.moveTo(x0, cy).lineTo(x0 + w, cy).stroke({ width: 0.7, color: shade(roof, 0.6) });
      } else {
        g.rect(x0, y0, w / 2, h).fill(shade(roof, 1.12));
        g.moveTo(cx, y0).lineTo(cx, y0 + h).stroke({ width: 0.7, color: shade(roof, 0.6) });
      }
      if (rng.chance(0.4)) g.rect(x0 + w * 0.7, y0 + h * 0.15, 1.8, 1.8).fill(0x5a4a42);
      break;
    }
    case "warehouse": {
      for (let x = x0 + 2; x < x0 + w - 1; x += 3) g.moveTo(x, y0 + 1).lineTo(x, y0 + h - 1).stroke({ width: 0.4, color: shade(roof, 0.8) });
      for (let y = y0 + 4; y < y0 + h - 4; y += 10) g.rect(cx - w * 0.2, y, w * 0.4, 2.5).fill({ color: 0xcfe3ef, alpha: 0.5 });
      break;
    }
    case "hospital": {
      g.rect(x0 + 2, y0 + 2, w - 4, h - 4).stroke({ width: 0.6, color: 0xc9d0d7 });
      g.circle(cx, cy, Math.min(w, h) * 0.28).stroke({ width: 1, color: 0xd6343a });
      g.rect(cx - 1, cy - 4, 2, 8).fill(0xd6343a);
      g.rect(cx - 4, cy - 1, 8, 2).fill(0xd6343a);
      break;
    }
    case "government": {
      g.rect(x0 + 1.5, y0 + 1.5, w - 3, h - 3).stroke({ width: 0.8, color: shade(roof, 0.8) });
      const r = Math.min(w, h) * 0.24;
      g.circle(cx, cy, r).fill(0x8aa27a);
      g.circle(cx - r * 0.25, cy - r * 0.25, r * 0.45).fill({ color: 0xffffff, alpha: 0.25 });
      g.circle(cx, cy, r).stroke({ width: 0.6, color: 0x5e7552 });
      break;
    }
    case "police_station":
    case "fire_station":
    case "school": {
      g.rect(x0 + 1.5, y0 + 1.5, w - 3, h - 3).stroke({ width: 0.8, color: accent ?? 0xffffff, alpha: 0.7 });
      if (b.kind === "police_station") {
        g.circle(cx, cy, Math.min(w, h) * 0.22).stroke({ width: 0.9, color: 0xeef1f4 });
        g.rect(cx - 0.6, cy - 3, 1.2, 6).fill(0xeef1f4);
        g.rect(cx - 2.5, cy - 0.6, 5, 1.2).fill(0xeef1f4);
      }
      break;
    }
    default: {
      // Flat commercial/residential roofs: parapet, rooftop plant, occasional garden or helipad.
      g.rect(x0 + 1, y0 + 1, w - 2, h - 2).stroke({ width: 0.6, color: shade(roof, 1.15), alpha: 0.8 });
      const units = Math.floor((w * h) / 220);
      for (let i = 0; i < units; i++) {
        const ux = rng.float(x0 + 3, x0 + w - 6);
        const uy = rng.float(y0 + 3, y0 + h - 6);
        g.rect(ux, uy, 3, 2.4).fill(shade(roof, 0.78));
        g.rect(ux, uy, 3, 0.7).fill({ color: 0xffffff, alpha: 0.18 });
      }
      if (b.floors >= 20 && w > 26 && rng.chance(0.25)) {
        g.circle(cx, cy, 5).fill(0x4a4d53);
        g.circle(cx, cy, 5).stroke({ width: 0.6, color: 0xf2c14e });
        g.rect(cx - 1.6, cy - 2.2, 0.7, 4.4).fill(0xf2c14e);
        g.rect(cx + 0.9, cy - 2.2, 0.7, 4.4).fill(0xf2c14e);
        g.rect(cx - 1.6, cy - 0.35, 3.2, 0.7).fill(0xf2c14e);
      } else if (b.kind === "home_apartment" && rng.chance(0.3)) {
        g.rect(x0 + w * 0.2, y0 + h * 0.2, w * 0.35, h * 0.3).fill(0x5d8c47);
      }
      break;
    }
  }
}
