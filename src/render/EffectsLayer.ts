import { Container, Graphics } from "pixi.js";
import type { Simulation } from "../sim/Simulation";
import { wallHeight } from "./CityPainter";

/**
 * Per-frame effects driven by simulation state: fires and smoke on burning
 * buildings, charred ruins, pulsing incident markers and collapsed people.
 */
export class EffectsLayer {
  readonly under = new Graphics();
  readonly over = new Container();
  readonly smoke = new Graphics();
  private glow = new Graphics();
  private markers = new Graphics();
  private time = 0;

  constructor() {
    this.glow.blendMode = "add";
    this.over.addChild(this.glow, this.markers);
  }

  frame(sim: Simulation, dt: number): void {
    this.time += dt;
    const t = this.time;
    this.under.clear();
    this.smoke.clear();
    this.glow.clear();
    this.markers.clear();

    for (const b of sim.city.buildings.values()) {
      const s = wallHeight(b);
      const x0 = b.x - b.w / 2;
      const y0 = b.y - b.h / 2 - s;
      if (b.ruined) {
        this.smoke.rect(x0, y0, b.w, b.h + s).fill({ color: 0x1b1714, alpha: 0.82 });
        for (let i = 0; i < 6; i++) {
          const px = x0 + ((i * 37) % Math.max(4, b.w - 4)) + 2;
          const py = y0 + ((i * 53) % Math.max(4, b.h - 4)) + 2;
          this.smoke.rect(px, py, 3, 1.2).fill({ color: 0x3a302a, alpha: 0.9 });
        }
        continue;
      }
      if (b.onFire === undefined) continue;
      const k = Math.min(1, b.onFire);
      const cx = b.x;
      const cy = b.y - b.h / 2 - s + b.h / 2;
      this.smoke.rect(x0, y0, b.w, b.h + s).fill({ color: 0x2a1a10, alpha: 0.25 + k * 0.4 });
      const flames = 3 + Math.round(k * 8);
      for (let i = 0; i < flames; i++) {
        const ang = i * 2.39996;
        const r = Math.sqrt(i / flames) * Math.min(b.w, b.h) * 0.42;
        const fx = cx + Math.cos(ang) * r;
        const fy = cy + Math.sin(ang) * r;
        const flick = 0.75 + Math.sin(t * 13 + i * 1.7) * 0.25;
        this.glow.circle(fx, fy, (3 + k * 5) * flick).fill({ color: 0xff5a1f, alpha: 0.55 });
        this.glow.circle(fx, fy - 1, (1.6 + k * 2.5) * flick).fill({ color: 0xffd35a, alpha: 0.75 });
      }
      this.glow.circle(cx, cy, 18 + k * 30).fill({ color: 0xff7a2a, alpha: 0.08 + k * 0.08 });
      // Smoke drifting north-east.
      for (let i = 0; i < 7; i++) {
        const phase = (t * 0.35 + i / 7) % 1;
        const sx = cx + phase * 26 + Math.sin(t + i) * 3;
        const sy = cy - phase * 44;
        this.smoke.circle(sx, sy, 4 + phase * 10 * (0.6 + k)).fill({ color: 0x55504c, alpha: (1 - phase) * 0.45 });
      }
    }

    const pulse = (Math.sin(t * 4) + 1) / 2;
    for (const inc of sim.emergency.incidents.values()) {
      const color = inc.kind === "fire" ? 0xff7a2a : inc.kind === "medical" ? 0xff6bd1 : 0xff3b30;
      this.markers.circle(inc.x, inc.y, 7 + pulse * 7).stroke({ width: 1.1, color, alpha: 0.9 - pulse * 0.5 });
      this.markers.circle(inc.x, inc.y, 2).fill({ color, alpha: 0.9 });
    }

    for (const npc of sim.npcSystem.npcs.values()) {
      if (npc.status !== "incapacitated") continue;
      this.under.ellipse(npc.pos.x, npc.pos.y + 6, 2.6, 1.3).fill({ color: 0x2b4a8a });
      this.under.circle(npc.pos.x + 2.4, npc.pos.y + 6, 1).fill({ color: 0xf1c9a5 });
      this.markers.circle(npc.pos.x, npc.pos.y + 6, 5 + pulse * 3).stroke({ width: 0.8, color: 0xff6bd1, alpha: 0.8 });
    }
  }
}
