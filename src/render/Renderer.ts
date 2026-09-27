import { Application, Container, Graphics } from "pixi.js";
import type { Simulation } from "../sim/Simulation";
import type { Vec2 } from "../core/types";
import { CITY_HEIGHT, CITY_WIDTH } from "../world/constants";
import { paintCity, wallHeight } from "./CityPainter";
import { EntityLayer } from "./EntityLayer";
import { EffectsLayer } from "./EffectsLayer";
import { LIGHT } from "./palette";

const MIN_ZOOM = 0.9;
const MAX_ZOOM = 7;

/**
 * Composes the scene. Layer order (bottom to top):
 * ground → route line → vehicles → people → structures → darkness → night lights/beams → signals → selection.
 * Structures sit above moving entities so tall roofs occlude the street behind them.
 */
export class Renderer {
  app!: Application;
  readonly world = new Container();
  entities!: EntityLayer;
  readonly effects = new EffectsLayer();
  private sim!: Simulation;
  private darkness = new Graphics();
  private nightLights!: Container;
  private windowsByBuilding = new Map<string, Graphics>();
  private occupancyTimer = 0;
  private signals = new Graphics();
  private route = new Graphics();
  private selection = new Graphics();
  private player = new Graphics();

  zoom = 2.2;
  private camX = CITY_WIDTH / 2;
  private camY = CITY_HEIGHT / 2;
  darknessLevel = 0;
  private time = 0;

  async init(container: HTMLElement, sim: Simulation): Promise<void> {
    this.app = new Application();
    await this.app.init({
      resizeTo: container,
      background: "#1f4e66",
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    this.app.canvas.style.position = "absolute";
    this.app.canvas.style.inset = "0";
    container.appendChild(this.app.canvas);

    this.sim = sim;
    const painted = paintCity(sim.city);
    this.nightLights = painted.nightLights;
    this.windowsByBuilding = painted.windowsByBuilding;
    this.entities = new EntityLayer(sim.city);

    this.darkness.rect(-2000, -2000, CITY_WIDTH + 4000, CITY_HEIGHT + 4000).fill(0xffffff);
    this.darkness.eventMode = "none";
    this.nightLights.eventMode = "none";
    this.entities.beams.eventMode = "none";

    this.player.circle(0, 0, 7).fill({ color: 0x4dd2ff, alpha: 0.18 });
    this.player.ellipse(0.6, 0.8, 2.3, 1.7).fill({ color: 0x000000, alpha: 0.35 });
    this.player.ellipse(0, 0, 1.6, 2.5).fill(0xffffff);
    this.player.ellipse(0, 0, 1.6, 2.5).stroke({ width: 0.5, color: 0x0a0a0a });
    this.player.circle(0.3, 0, 1.15).fill(0xf1c9a5);
    this.player.poly([3.2, -1.1, 5, 0, 3.2, 1.1]).fill(0x4dd2ff);

    this.effects.over.eventMode = "none";
    this.effects.smoke.eventMode = "none";
    this.world.addChild(
      painted.ground,
      this.route,
      this.effects.under,
      this.entities.vehicles,
      this.entities.people,
      this.player,
      painted.structures,
      this.effects.smoke,
      this.darkness,
      this.nightLights,
      this.entities.beams,
      this.effects.over,
      this.signals,
      this.selection,
    );
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointertap", (e) => {
      const p = this.screenToWorld(e.global.x, e.global.y);
      const id = this.pickBuilding(p.x, p.y);
      this.onBackgroundClick?.(id);
    });
  }

  /** Fired for clicks that didn't hit a person or car; carries the building under the cursor, if any. */
  onBackgroundClick: ((buildingId: string | undefined) => void) | null = null;
  selectedBuildingId: string | null = null;

  screenToWorld(sx: number, sy: number): Vec2 {
    return { x: (sx - this.world.position.x) / this.world.scale.x, y: (sy - this.world.position.y) / this.world.scale.y };
  }

  /** Hit-tests the drawn 2.5D shape (facade + shifted roof), front-most building first. */
  pickBuilding(x: number, y: number): string | undefined {
    let best: string | undefined;
    let bestDepth = -Infinity;
    for (const b of this.sim.city.buildings.values()) {
      const s = wallHeight(b);
      const x0 = b.x - b.w / 2;
      const top = b.y - b.h / 2 - s;
      const bottom = b.y + b.h / 2;
      if (x < x0 || x > x0 + b.w || y < top || y > bottom) continue;
      const depth = b.y + b.h / 2;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = b.id;
      }
    }
    return best;
  }

  /** Called once per frame with the camera target (player or followed NPC). */
  frame(sim: Simulation, dt: number, focus: Vec2, playerPos: Vec2, playerHeading: number, selectedNpcId: string | null): void {
    this.time += dt;
    const k = 1 - Math.exp(-dt * 8);
    this.camX += (focus.x - this.camX) * k;
    this.camY += (focus.y - this.camY) * k;
    this.applyCamera();

    this.updateLighting(sim);
    this.occupancyTimer -= dt;
    if (this.occupancyTimer <= 0) {
      this.occupancyTimer = 0.5;
      this.updateWindowLights(sim);
    }
    this.entities.syncVehicles(sim.vehicleSystem.vehicles.values(), dt, this.darknessLevel);
    this.entities.syncPeople(sim.npcSystem.npcs.values(), dt);
    this.drawSignals(sim);
    this.effects.frame(sim, dt);

    this.player.position.set(playerPos.x, playerPos.y);
    this.player.rotation = playerHeading;
    this.drawSelection(sim, selectedNpcId);
  }

  private applyCamera(): void {
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const halfW = sw / 2 / this.zoom;
    const halfH = sh / 2 / this.zoom;
    const margin = 260;
    const cx = clampRange(this.camX, -margin + halfW, CITY_WIDTH + margin - halfW);
    const cy = clampRange(this.camY, -margin + halfH, CITY_HEIGHT + margin + 120 - halfH);
    this.world.scale.set(this.zoom);
    this.world.position.set(sw / 2 - cx * this.zoom, sh / 2 - cy * this.zoom);
  }

  snapCamera(pos: Vec2): void {
    this.camX = pos.x;
    this.camY = pos.y;
  }

  zoomBy(factor: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
  }

  /** Visible world rect, for the minimap viewport indicator. */
  viewRect(): { x: number; y: number; w: number; h: number } {
    const s = this.world.scale.x;
    return {
      x: -this.world.position.x / s,
      y: -this.world.position.y / s,
      w: this.app.screen.width / s,
      h: this.app.screen.height / s,
    };
  }

  private updateLighting(sim: Simulation): void {
    const darkness = 1 - sim.clock.daylightFactor();
    this.darknessLevel = darkness;
    // Deep blue at night, violet-amber through dusk and dawn.
    const dusk = darkness > 0.05 && darkness < 0.8 ? 1 - Math.abs(darkness - 0.4) / 0.4 : 0;
    this.darkness.tint = mixColor(0x0a1236, 0x6a3f5a, Math.max(0, dusk) * 0.6);
    this.darkness.alpha = darkness * 0.68 + Math.max(0, dusk) * 0.06;
    this.nightLights.alpha = smoothstep(0.25, 0.75, darkness);
  }

  /**
   * Window lights follow real occupancy: a building glows in proportion to
   * the people awake inside it right now. Empty towers stay dark; a busy
   * hospital or a late shift at the precinct stays lit.
   */
  private updateWindowLights(sim: Simulation): void {
    const awake = new Map<string, number>();
    for (const n of sim.npcSystem.npcs.values()) {
      if (!n.alive || !n.targetBuildingId || n.inVehicle || n.pathNodeIds.length > 0) continue;
      const lateNight = n.currentActivity === "sleeping";
      if (lateNight && n.status === "free") continue;
      awake.set(n.targetBuildingId, (awake.get(n.targetBuildingId) ?? 0) + 1);
    }
    for (const [id, g] of this.windowsByBuilding) {
      const b = sim.city.buildings.get(id);
      if (!b) continue;
      if (b.ruined || b.vacant) {
        g.alpha = 0;
        continue;
      }
      const people = awake.get(id) ?? 0;
      const capacity = Math.max(1, b.residentCapacity + b.jobCapacity);
      const civic = b.kind === "hospital" || b.kind === "police_station" || b.kind === "fire_station";
      g.alpha = civic ? 0.7 + Math.min(0.3, people * 0.05) : people === 0 ? 0.04 : Math.min(1, 0.3 + (people / capacity) * 1.6);
    }
  }

  private drawSignals(sim: Simulation): void {
    const g = this.signals;
    g.clear();
    for (const n of sim.city.roads.nodes.values()) {
      if (!n.hasTrafficLight) continue;
      const ns = n.lightAxis === "ns" ? LIGHT.signalGreen : LIGHT.signalRed;
      const ew = n.lightAxis === "ew" ? LIGHT.signalGreen : LIGHT.signalRed;
      const o = 12.5;
      g.circle(n.x - o, n.y - o, 0.95).fill(ns);
      g.circle(n.x + o, n.y + o, 0.95).fill(ns);
      g.circle(n.x + o, n.y - o, 0.95).fill(ew);
      g.circle(n.x - o, n.y + o, 0.95).fill(ew);
    }
  }

  private drawSelection(sim: Simulation, id: string | null): void {
    this.selection.clear();
    this.route.clear();
    if (this.selectedBuildingId) {
      const b = sim.city.buildings.get(this.selectedBuildingId);
      if (b) {
        const s = wallHeight(b);
        const a = 0.6 + Math.sin(this.time * 5) * 0.3;
        this.selection.rect(b.x - b.w / 2 - 1.5, b.y - b.h / 2 - s - 1.5, b.w + 3, b.h + s + 3).stroke({ width: 1.2, color: 0x4dd2ff, alpha: a });
      }
    }
    if (!id) return;
    const npc = sim.npcSystem.npcs.get(id);
    if (!npc) return;

    let pos = this.entities.personPos(id) ?? npc.pos;
    if (npc.inVehicle && npc.vehicleId) pos = this.entities.carPos(npc.vehicleId) ?? pos;
    const pulse = 1 + Math.sin(this.time * 5) * 0.15;
    this.selection.circle(pos.x, pos.y, 6 * pulse).stroke({ width: 1, color: 0x4dd2ff, alpha: 0.95 });
    this.selection.circle(pos.x, pos.y, 9 * pulse).stroke({ width: 0.6, color: 0x4dd2ff, alpha: 0.4 });

    // Remaining route: walking path, or the vehicle's path while driving.
    const vehicle = npc.inVehicle && npc.vehicleId ? sim.vehicleSystem.vehicles.get(npc.vehicleId) : undefined;
    const nodes = vehicle ? vehicle.pathNodeIds.slice(vehicle.pathIndex) : npc.pathNodeIds.slice(npc.pathIndex);
    const target = npc.targetBuildingId ? sim.city.buildings.get(npc.targetBuildingId) : undefined;
    if (nodes.length === 0 && !target) return;
    this.route.moveTo(pos.x, pos.y);
    for (const nid of nodes) {
      const n = sim.city.roads.nodes.get(nid);
      if (n) this.route.lineTo(n.x, n.y);
    }
    if (target) this.route.lineTo(target.x, target.y);
    this.route.stroke({ width: 1.6, color: 0x4dd2ff, alpha: 0.55 });
    if (target) {
      this.route.circle(target.x, target.y, 3).fill({ color: 0x4dd2ff, alpha: 0.9 });
    }
  }
}

function clampRange(v: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
