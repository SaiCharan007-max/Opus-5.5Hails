import { Circle, Container, Graphics } from "pixi.js";
import type { NPC } from "../npc/NPC";
import type { Vehicle } from "../traffic/Vehicle";
import type { City } from "../world/City";
import { roadHalfWidth, SIDEWALK_WIDTH } from "../world/constants";
import { CAR_COLORS, FACTION_COLOR, LIGHT, SHIRT_COLORS, SKIN_TONES, hashString } from "./palette";

interface Smoothed {
  x: number;
  y: number;
  heading: number;
  lastTargetX: number;
  lastTargetY: number;
}

interface CarSprite extends Smoothed {
  body: Graphics;
  brake: Graphics;
  beams: Graphics;
}

interface PersonSprite extends Smoothed {
  g: Graphics;
  debugDot: Graphics;
}

const SNAP_DISTANCE = 45;

/**
 * Per-frame view of moving entities. Sim positions update at 10 Hz on the road
 * centerline; this layer interpolates between ticks, derives headings, and
 * offsets cars into the right-hand lane and pedestrians onto sidewalks so the
 * street reads correctly without the simulation having to model lanes.
 */
export class EntityLayer {
  readonly vehicles = new Container();
  readonly people = new Container();
  readonly beams = new Container();
  private cars = new Map<string, CarSprite>();
  private persons = new Map<string, PersonSprite>();
  debug = false;

  onPersonClick: ((npcId: string) => void) | null = null;
  onVehicleClick: ((vehicleId: string) => void) | null = null;

  constructor(private city: City) {
    this.beams.blendMode = "add";
  }

  syncVehicles(list: Iterable<Vehicle>, dt: number, darkness: number): void {
    const seen = new Set<string>();
    for (const v of list) {
      seen.add(v.id);
      let s = this.cars.get(v.id);
      if (!s) s = this.createCar(v);
      const moving = v.pathNodeIds.length > 0;
      s.body.visible = moving;
      s.beams.visible = moving && darkness > 0.05;
      if (!moving) {
        s.x = v.pos.x;
        s.y = v.pos.y;
        s.lastTargetX = v.pos.x;
        s.lastTargetY = v.pos.y;
        continue;
      }

      const lanes = this.edgeLanes(v.currentRoadNodeId, v.pathNodeIds[v.pathIndex]);
      const laneOffset = lanes >= 2 ? roadHalfWidth(2) * 0.72 : roadHalfWidth(1) * 0.5;
      this.follow(s, v.pos.x, v.pos.y, dt, laneOffset);

      s.body.position.set(s.x, s.y);
      s.body.rotation = s.heading;
      s.brake.visible = v.waiting;
      s.beams.position.set(s.x, s.y);
      s.beams.rotation = s.heading;
      s.beams.alpha = Math.min(1, darkness * 1.2);
    }
    for (const [id, s] of this.cars) {
      if (!seen.has(id)) {
        s.body.destroy({ children: true });
        s.beams.destroy();
        this.cars.delete(id);
      }
    }
  }

  syncPeople(list: Iterable<NPC>, dt: number): void {
    const seen = new Set<string>();
    for (const npc of list) {
      seen.add(npc.id);
      let s = this.persons.get(npc.id);
      if (!s) s = this.createPerson(npc);

      const target = npc.targetBuildingId ? this.city.buildings.get(npc.targetBuildingId) : undefined;
      const walking = !npc.inVehicle && npc.pathNodeIds.length > 0;
      const inPark = !walking && !npc.inVehicle && target?.kind === "park";
      const outdoors = npc.alive && (walking || inPark);

      s.g.visible = outdoors && !this.debug;
      s.debugDot.visible = this.debug && npc.alive;

      if (inPark && target) {
        const h = hashString(npc.id);
        const px = target.x + (((h & 0xff) / 255) - 0.5) * target.w * 0.8;
        const py = target.y + ((((h >> 8) & 0xff) / 255) - 0.5) * target.h * 0.8;
        this.follow(s, px, py, dt, 0);
      } else {
        const lanes = this.edgeLanes(npc.currentRoadNodeId, npc.pathNodeIds[npc.pathIndex]);
        const offset = walking && lanes > 0 ? roadHalfWidth(lanes) + SIDEWALK_WIDTH * 0.5 : 0;
        this.follow(s, npc.pos.x, npc.pos.y, dt, offset);
      }
      s.g.position.set(s.x, s.y);
      s.g.rotation = s.heading;
      s.debugDot.position.set(s.x, s.y);
      if (this.debug) {
        s.debugDot.clear();
        const r = npc.lod === "high" ? 2.6 : 2;
        s.debugDot.circle(0, 0, r).fill({ color: FACTION_COLOR[npc.faction] ?? 0xffffff, alpha: npc.lod === "abstract" ? 0.45 : 1 });
        s.debugDot.circle(0, 0, r).stroke({ width: 0.5, color: 0x000000 });
      }
    }
    for (const [id, s] of this.persons) {
      if (!seen.has(id)) {
        s.g.destroy();
        s.debugDot.destroy();
        this.persons.delete(id);
      }
    }
  }

  /** Smoothed render position, used for camera follow and selection rings. */
  personPos(id: string): { x: number; y: number } | undefined {
    const s = this.persons.get(id);
    return s ? { x: s.x, y: s.y } : undefined;
  }

  carPos(id: string): { x: number; y: number } | undefined {
    const s = this.cars.get(id);
    return s ? { x: s.x, y: s.y } : undefined;
  }

  private edgeLanes(a: string | undefined, b: string | undefined): number {
    if (!a || !b || a === b) return 0;
    return this.city.roads.edgeBetween(a, b)?.lanes ?? 0;
  }

  /** Exponential smoothing toward the (lane-offset) target, deriving heading from target motion. */
  private follow(s: Smoothed, tx: number, ty: number, dt: number, sideOffset: number): void {
    const dx = tx - s.lastTargetX;
    const dy = ty - s.lastTargetY;
    if (dx * dx + dy * dy > 0.0004) {
      const h = Math.atan2(dy, dx);
      let diff = h - s.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      s.heading += diff * Math.min(1, dt * 14);
      s.lastTargetX = tx;
      s.lastTargetY = ty;
    }
    const ox = tx - Math.sin(s.heading) * sideOffset;
    const oy = ty + Math.cos(s.heading) * sideOffset;
    const gap = Math.hypot(ox - s.x, oy - s.y);
    if (gap > SNAP_DISTANCE) {
      s.x = ox;
      s.y = oy;
      return;
    }
    const k = 1 - Math.exp(-dt * 12);
    s.x += (ox - s.x) * k;
    s.y += (oy - s.y) * k;
  }

  private createCar(v: Vehicle): CarSprite {
    const h = hashString(v.id);
    const body = new Graphics();
    const color = v.kind === "police_car" ? 0x1c2f5e : v.kind === "taxi" ? 0xf2c230 : CAR_COLORS[h % CAR_COLORS.length];
    const L = v.kind === "bus" || v.kind === "truck" ? 16 : 8.6;
    const W = v.kind === "bus" || v.kind === "truck" ? 5.4 : 4.4;
    body.roundRect(-L / 2 + 0.6, -W / 2 + 0.8, L, W, 1.4).fill({ color: 0x000000, alpha: 0.3 });
    body.roundRect(-L / 2, -W / 2, L, W, 1.4).fill(color);
    body.roundRect(-L / 2, -W / 2, L, W, 1.4).stroke({ width: 0.4, color: 0x000000, alpha: 0.5 });
    body.rect(L * 0.1, -W / 2 + 0.6, L * 0.2, W - 1.2).fill({ color: 0x1a2330, alpha: 0.85 });
    body.rect(-L * 0.36, -W / 2 + 0.7, L * 0.14, W - 1.4).fill({ color: 0x1a2330, alpha: 0.7 });
    body.rect(-L * 0.08, -W / 2 + 0.5, L * 0.18, W - 1).fill({ color: 0xffffff, alpha: 0.12 });
    body.rect(L / 2 - 0.9, -W / 2 + 0.5, 0.8, 1).fill(0xfff6d8);
    body.rect(L / 2 - 0.9, W / 2 - 1.5, 0.8, 1).fill(0xfff6d8);
    const brake = new Graphics();
    brake.rect(-L / 2, -W / 2 + 0.4, 0.9, 1.3).fill(LIGHT.brake);
    brake.rect(-L / 2, W / 2 - 1.7, 0.9, 1.3).fill(LIGHT.brake);
    brake.circle(-L / 2, -W / 2 + 1, 1.8).fill({ color: LIGHT.brake, alpha: 0.35 });
    brake.circle(-L / 2, W / 2 - 1, 1.8).fill({ color: LIGHT.brake, alpha: 0.35 });
    brake.visible = false;
    body.addChild(brake);
    body.eventMode = "static";
    body.cursor = "pointer";
    body.hitArea = new Circle(0, 0, 6);
    body.on("pointertap", (e) => {
      e.stopPropagation();
      this.onVehicleClick?.(v.id);
    });

    const beams = new Graphics();
    beams.poly([L / 2, -W / 2 + 0.6, L / 2 + 18, -W / 2 - 4, L / 2 + 18, W / 2 + 4, L / 2, W / 2 - 0.6]).fill({ color: LIGHT.headlight, alpha: 0.06 });
    beams.poly([L / 2, -W / 2 + 0.8, L / 2 + 9, -W / 2 - 1.2, L / 2 + 9, W / 2 + 1.2, L / 2, W / 2 - 0.8]).fill({ color: LIGHT.headlight, alpha: 0.09 });

    this.vehicles.addChild(body);
    this.beams.addChild(beams);
    const s: CarSprite = { body, brake, beams, x: v.pos.x, y: v.pos.y, heading: 0, lastTargetX: v.pos.x, lastTargetY: v.pos.y };
    this.cars.set(v.id, s);
    return s;
  }

  private createPerson(npc: NPC): PersonSprite {
    const h = hashString(npc.id);
    const g = new Graphics();
    const shirt = npc.faction === "police" ? 0x2b4a8a : npc.faction === "emergency_services" ? 0xd9623b : SHIRT_COLORS[h % SHIRT_COLORS.length];
    const skin = SKIN_TONES[(h >> 4) % SKIN_TONES.length];
    g.ellipse(0.5, 0.6, 1.9, 1.4).fill({ color: 0x000000, alpha: 0.3 });
    g.ellipse(0, 0, 1.3, 2.1).fill(shirt);
    g.ellipse(0, 0, 1.3, 2.1).stroke({ width: 0.35, color: 0x000000, alpha: 0.6 });
    g.circle(0.2, 0, 1).fill(skin);
    g.eventMode = "static";
    g.cursor = "pointer";
    g.hitArea = new Circle(0, 0, 5);
    g.on("pointertap", (e) => {
      e.stopPropagation();
      this.onPersonClick?.(npc.id);
    });

    const debugDot = new Graphics();
    debugDot.eventMode = "static";
    debugDot.cursor = "pointer";
    debugDot.hitArea = new Circle(0, 0, 5);
    debugDot.on("pointertap", (e) => {
      e.stopPropagation();
      this.onPersonClick?.(npc.id);
    });

    this.people.addChild(g, debugDot);
    const s: PersonSprite = { g, debugDot, x: npc.pos.x, y: npc.pos.y, heading: 0, lastTargetX: npc.pos.x, lastTargetY: npc.pos.y };
    this.persons.set(npc.id, s);
    return s;
  }
}
