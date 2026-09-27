import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { Simulation } from "../sim/Simulation";
import type { NPC } from "../npc/NPC";
import type { Vehicle } from "../traffic/Vehicle";
import type { Vec2 } from "../core/types";

const DISTRICT_COLORS: Record<string, number> = {
  downtown: 0x2b2f3a,
  financial: 0x243447,
  residential: 0x2e3a2b,
  suburbs: 0x33402e,
  old_town: 0x3a2f2b,
  entertainment: 0x3a2b3a,
  industrial: 0x2f2f2f,
  harbor: 0x1f3038,
};

const NPC_COLOR: Record<string, number> = {
  civilians: 0x9fb4c7,
  police: 0x4d7cff,
  government: 0xd4af37,
  criminals: 0xd14b4b,
  business: 0x7fd17f,
  emergency_services: 0xff9a4d,
};

export class Renderer {
  app!: Application;
  world = new Container();
  roadLayer = new Graphics();
  buildingLayer = new Graphics();
  npcLayer = new Container();
  vehicleLayer = new Container();
  playerMarker = new Graphics();

  private npcSprites = new Map<string, Graphics>();
  private vehicleSprites = new Map<string, Graphics>();
  private hoveredNpcId: string | null = null;

  onNpcClick: ((npcId: string) => void) | null = null;

  async init(container: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      resizeTo: container,
      background: "#0a0a0f",
      antialias: true,
    });
    container.appendChild(this.app.canvas);

    this.world.addChild(this.roadLayer, this.buildingLayer, this.vehicleLayer, this.npcLayer, this.playerMarker);
    this.app.stage.addChild(this.world);

    this.drawStaticBackdropPlaceholder();
  }

  private drawStaticBackdropPlaceholder(): void {
    // populated by drawCity() once a simulation exists
  }

  drawCity(sim: Simulation): void {
    this.buildingLayer.clear();
    this.roadLayer.clear();

    for (const d of sim.city.districts.values()) {
      const color = DISTRICT_COLORS[d.kind] ?? 0x222222;
      this.buildingLayer.rect(d.minX, d.minY, d.maxX - d.minX, d.maxY - d.minY).fill({ color, alpha: 0.5 });
    }

    this.roadLayer.setStrokeStyle({ width: 4, color: 0x555b66, alpha: 0.9 });
    for (const edge of sim.city.roads.edges.values()) {
      const from = sim.city.roads.nodes.get(edge.from)!;
      const to = sim.city.roads.nodes.get(edge.to)!;
      this.roadLayer.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke();
    }
    for (const node of sim.city.roads.nodes.values()) {
      if (node.hasTrafficLight) {
        this.roadLayer.circle(node.x, node.y, 3).fill({ color: node.lightAxis === "ns" ? 0x4dff4d : 0xff4d4d });
      }
    }

    for (const b of sim.city.buildings.values()) {
      const size = 10 + b.jobCapacity * 0.4 + b.residentCapacity * 0.3;
      this.buildingLayer.rect(b.x - size / 2, b.y - size / 2, size, size).fill({ color: buildingColor(b.kind), alpha: 0.9 });
    }
  }

  syncNPCs(npcs: Iterable<NPC>): void {
    const seen = new Set<string>();
    for (const npc of npcs) {
      seen.add(npc.id);
      let g = this.npcSprites.get(npc.id);
      if (!g) {
        g = new Graphics();
        g.eventMode = "static";
        g.cursor = "pointer";
        g.on("pointertap", () => this.onNpcClick?.(npc.id));
        this.npcSprites.set(npc.id, g);
        this.npcLayer.addChild(g);
      }
      g.clear();
      const radius = npc.lod === "high" ? 3.5 : 2.5;
      const color = NPC_COLOR[npc.faction] ?? 0xffffff;
      g.circle(0, 0, radius).fill({ color, alpha: npc.lod === "abstract" ? 0.35 : 1 });
      g.position.set(npc.pos.x, npc.pos.y);
      g.visible = npc.lod !== "abstract" || true; // abstract NPCs still drawn faintly for observer mode
    }
    for (const [id, g] of this.npcSprites) {
      if (!seen.has(id)) {
        g.destroy();
        this.npcSprites.delete(id);
      }
    }
  }

  syncVehicles(vehicles: Iterable<Vehicle>): void {
    const seen = new Set<string>();
    for (const v of vehicles) {
      seen.add(v.id);
      let g = this.vehicleSprites.get(v.id);
      if (!g) {
        g = new Graphics();
        this.vehicleSprites.set(v.id, g);
        this.vehicleLayer.addChild(g);
      }
      const moving = v.pathNodeIds.length > 0;
      g.clear();
      g.visible = moving;
      if (moving) {
        g.rect(-4, -2.5, 8, 5).fill({ color: v.waiting ? 0xaa3333 : vehicleColor(v.kind) });
        g.position.set(v.pos.x, v.pos.y);
      }
    }
    for (const [id, g] of this.vehicleSprites) {
      if (!seen.has(id)) {
        g.destroy();
        this.vehicleSprites.delete(id);
      }
    }
  }

  drawPlayer(pos: Vec2): void {
    this.playerMarker.clear();
    this.playerMarker.circle(0, 0, 5).fill({ color: 0xffffff }).stroke({ width: 1.5, color: 0x000000 });
    this.playerMarker.position.set(pos.x, pos.y);
  }

  centerCameraOn(pos: Vec2, zoom = 2): void {
    this.world.scale.set(zoom);
    this.world.position.set(this.app.screen.width / 2 - pos.x * zoom, this.app.screen.height / 2 - pos.y * zoom);
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.world.position.x) / this.world.scale.x,
      y: (sy - this.world.position.y) / this.world.scale.y,
    };
  }
}

function vehicleColor(kind: string): number {
  switch (kind) {
    case "police_car":
      return 0x4d7cff;
    case "fire_truck":
      return 0xff5a3c;
    case "ambulance":
      return 0xff6bd1;
    case "bus":
      return 0xffd24d;
    case "truck":
      return 0x8d8d8d;
    default:
      return 0xcccccc;
  }
}

function buildingColor(kind: string): number {
  switch (kind) {
    case "police_station":
      return 0x4d7cff;
    case "fire_station":
      return 0xff5a3c;
    case "hospital":
      return 0xff6bd1;
    case "government":
      return 0xd4af37;
    case "park":
      return 0x4caf50;
    case "home_apartment":
    case "home_house":
      return 0x8ab4f8;
    case "shop":
      return 0xffd24d;
    case "restaurant":
      return 0xff9a4d;
    case "warehouse":
      return 0x8d8d8d;
    case "bank":
      return 0x6bd1ff;
    case "school":
      return 0xb388ff;
    case "office":
      return 0xaaaaaa;
    default:
      return 0x666666;
  }
}

export function makeLabel(text: string, size = 12, color = 0xffffff): Text {
  return new Text({ text, style: new TextStyle({ fontSize: size, fill: color, fontFamily: "Segoe UI, sans-serif" }) });
}
