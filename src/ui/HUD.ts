import type { Simulation } from "../sim/Simulation";
import type { NPC } from "../npc/NPC";

/**
 * DOM-based overlay rather than Pixi text objects. HUD updates are cheap
 * relative to sim work and DOM text is simpler to style/read than canvas
 * text at small sizes — a deliberate scope cut, not a limitation forced
 * on us.
 */
export class HUD {
  root: HTMLDivElement;
  private timeEl: HTMLDivElement;
  private statsEl: HTMLDivElement;
  private inspectorEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private speedButtons: HTMLDivElement;

  constructor(container: HTMLElement, private onSpeedChange: (scale: number) => void) {
    this.root = document.createElement("div");
    this.root.style.cssText = `
      position: absolute; inset: 0; pointer-events: none;
      font-family: 'Segoe UI', sans-serif; color: #e8e8ee;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    `;
    container.appendChild(this.root);

    this.timeEl = this.panel("top: 12px; left: 12px;");
    this.statsEl = this.panel("top: 12px; right: 12px; text-align: right;");
    this.inspectorEl = this.panel("bottom: 12px; right: 12px; width: 280px; max-height: 60vh; overflow-y: auto;");
    this.inspectorEl.style.display = "none";
    this.hintEl = this.panel("bottom: 12px; left: 12px;");
    this.hintEl.innerHTML =
      "WASD move · Click NPC to inspect · 1-5 sim speed · Space pause · F3 debug overlay";

    this.speedButtons = document.createElement("div");
    this.speedButtons.style.cssText = "position:absolute; top: 60px; left: 12px; pointer-events:auto; display:flex; gap:4px;";
    for (const s of [0, 1, 2, 5, 10, 50, 100]) {
      const btn = document.createElement("button");
      btn.textContent = s === 0 ? "II" : `${s}x`;
      btn.style.cssText =
        "background:#1c1c24; color:#ddd; border:1px solid #444; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:12px;";
      btn.onclick = () => this.onSpeedChange(s);
      this.speedButtons.appendChild(btn);
    }
    this.root.appendChild(this.speedButtons);
  }

  private panel(pos: string): HTMLDivElement {
    const el = document.createElement("div");
    el.style.cssText = `position:absolute; ${pos} background: rgba(10,10,16,0.55); padding: 8px 12px; border-radius: 6px; font-size: 13px; line-height: 1.5; pointer-events: auto;`;
    this.root.appendChild(el);
    return el;
  }

  update(sim: Simulation, fps: number): void {
    const scaleLabel = sim.clock.paused ? "PAUSED" : `${sim.clock.timeScale}x`;
    this.timeEl.textContent = `${sim.clock.formatTime()}  [${scaleLabel}]`;
    this.statsEl.innerHTML = `NPCs: ${sim.npcSystem.npcs.size}<br/>FPS: ${fps.toFixed(0)}`;
  }

  showInspector(npc: NPC, city: Simulation["city"]): void {
    this.inspectorEl.style.display = "block";
    const home = city.buildings.get(npc.homeId);
    const rels = Array.from(npc.relationships.values())
      .slice(0, 5)
      .map((r) => `${r.type} (${r.trust.toFixed(0)})`)
      .join(", ") || "none yet";
    const memories = npc.memories
      .slice(-5)
      .reverse()
      .map((m) => `• ${m.note}`)
      .join("<br/>") || "none yet";
    this.inspectorEl.innerHTML = `
      <b>${npc.name}</b> (${npc.age})<br/>
      Job: ${npc.occupation}<br/>
      Faction: ${npc.faction}<br/>
      Home: ${home?.name ?? "?"}<br/>
      Activity: ${npc.currentActivity} (${npc.lod})<br/>
      Money: $${npc.money.toFixed(0)}<br/>
      Needs: H${npc.needs.hunger.toFixed(0)} E${npc.needs.energy.toFixed(0)} S${npc.needs.social.toFixed(0)} F${npc.needs.fun.toFixed(0)}<br/>
      Wanted: ${npc.wantedLevel} · Record: ${npc.criminalRecord}<br/>
      <hr style="border-color:#444"/>
      Relationships: ${rels}<br/>
      <hr style="border-color:#444"/>
      Recent memories:<br/>${memories}
    `;
  }

  hideInspector(): void {
    this.inspectorEl.style.display = "none";
  }
}
