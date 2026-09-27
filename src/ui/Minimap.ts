import type { Simulation } from "../sim/Simulation";
import type { Vec2 } from "../core/types";
import { CITY_HEIGHT, CITY_WIDTH, roadHalfWidth, SHORELINE_Y } from "../world/constants";
import { LOT_GROUND } from "../render/palette";

const PAD = 40;
const W = 232;

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

/** 2D-canvas minimap: static city drawn once to an offscreen canvas, live markers on top. */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private scale: number;
  private h: number;

  constructor(parent: HTMLElement, sim: Simulation) {
    const worldW = CITY_WIDTH + PAD * 2;
    const worldH = SHORELINE_Y + 40 + PAD;
    this.scale = W / worldW;
    this.h = Math.round(worldH * this.scale);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas = document.createElement("canvas");
    this.canvas.width = W * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${this.h}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.scale(dpr, dpr);

    this.base = document.createElement("canvas");
    this.base.width = W * dpr;
    this.base.height = this.h * dpr;
    const b = this.base.getContext("2d")!;
    b.scale(dpr, dpr);
    this.paintBase(b, sim);
  }

  private tx(x: number): number {
    return (x + PAD) * this.scale;
  }
  private ty(y: number): number {
    return (y + PAD) * this.scale;
  }

  private paintBase(c: CanvasRenderingContext2D, sim: Simulation): void {
    c.fillStyle = "#435d39";
    c.fillRect(0, 0, W, this.h);
    c.fillStyle = "#1f4e66";
    c.fillRect(0, this.ty(SHORELINE_Y), W, this.h);
    for (const d of sim.city.districts.values()) {
      c.fillStyle = hex(LOT_GROUND[d.kind]);
      c.fillRect(this.tx(d.minX), this.ty(d.minY), (d.maxX - d.minX) * this.scale, (d.maxY - d.minY) * this.scale);
    }
    for (const b of sim.city.buildings.values()) {
      if (b.kind === "park") c.fillStyle = "#5d8c47";
      else if (b.floors >= 10) c.fillStyle = "#c9d2dc";
      else c.fillStyle = "rgba(0,0,0,0.18)";
      c.fillRect(this.tx(b.x - b.w / 2), this.ty(b.y - b.h / 2), b.w * this.scale, b.h * this.scale);
    }
    c.strokeStyle = "#2c2f34";
    for (const e of sim.city.roads.edges.values()) {
      const a = sim.city.roads.nodes.get(e.from)!;
      const z = sim.city.roads.nodes.get(e.to)!;
      c.lineWidth = Math.max(1, roadHalfWidth(e.lanes) * 2 * this.scale);
      c.beginPath();
      c.moveTo(this.tx(a.x), this.ty(a.y));
      c.lineTo(this.tx(z.x), this.ty(z.y));
      c.stroke();
    }
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.lineWidth = 1;
    c.strokeRect(this.tx(0), this.ty(0), CITY_WIDTH * this.scale, CITY_HEIGHT * this.scale);
  }

  draw(sim: Simulation, player: Vec2, view: { x: number; y: number; w: number; h: number }, selected?: Vec2): void {
    const c = this.ctx;
    c.clearRect(0, 0, W, this.h);
    c.drawImage(this.base, 0, 0, W, this.h);

    c.fillStyle = "#f2efe6";
    for (const v of sim.vehicleSystem.vehicles.values()) {
      if (v.pathNodeIds.length === 0) continue;
      c.fillRect(this.tx(v.pos.x) - 0.75, this.ty(v.pos.y) - 0.75, 1.5, 1.5);
    }

    for (const inc of sim.emergency.incidents.values()) {
      c.fillStyle = inc.kind === "fire" ? "#ff7a2a" : inc.kind === "medical" ? "#ff6bd1" : "#ff3b30";
      c.beginPath();
      c.arc(this.tx(inc.x), this.ty(inc.y), 3, 0, Math.PI * 2);
      c.fill();
    }
    for (const b of sim.city.buildings.values()) {
      if (b.onFire === undefined && !b.ruined) continue;
      c.fillStyle = b.ruined ? "#1b1714" : "#ff7a2a";
      c.fillRect(this.tx(b.x - b.w / 2), this.ty(b.y - b.h / 2), b.w * this.scale, b.h * this.scale);
    }
    for (const v of sim.vehicleSystem.vehicles.values()) {
      if (!v.siren) continue;
      c.fillStyle = v.kind === "police_car" ? "#4d7cff" : v.kind === "fire_truck" ? "#ff5a3c" : "#ffffff";
      c.fillRect(this.tx(v.pos.x) - 1.5, this.ty(v.pos.y) - 1.5, 3, 3);
    }

    c.strokeStyle = "rgba(77,210,255,0.9)";
    c.lineWidth = 1;
    c.strokeRect(this.tx(view.x), this.ty(view.y), view.w * this.scale, view.h * this.scale);

    if (selected) {
      c.fillStyle = "#4dd2ff";
      c.beginPath();
      c.arc(this.tx(selected.x), this.ty(selected.y), 3, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#ffffff";
    c.strokeStyle = "#0b0f16";
    c.beginPath();
    c.arc(this.tx(player.x), this.ty(player.y), 3.2, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
}
