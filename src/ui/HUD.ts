import type { Simulation } from "../sim/Simulation";
import type { ActivityKind, NPC, OccupationKind } from "../npc/NPC";
import type { Vec2 } from "../core/types";
import { Minimap } from "./Minimap";

const SPEEDS = [0, 1, 2, 5, 10, 50, 100];

const OCCUPATION_LABEL: Record<OccupationKind, string> = {
  office_worker: "Office worker",
  shop_worker: "Shop worker",
  police_officer: "Police officer",
  firefighter: "Firefighter",
  doctor: "Doctor",
  student: "Student",
  business_owner: "Business owner",
  unemployed: "Unemployed",
  criminal: "Career criminal",
};

const FACTION_LABEL: Record<string, [string, string]> = {
  civilians: ["Civilian", "#9fb4c7"],
  police: ["Police", "#4d7cff"],
  government: ["Government", "#d4af37"],
  criminals: ["Criminal", "#ff6b5e"],
  business: ["Business", "#5fd38d"],
  emergency_services: ["Emergency", "#ff9a4d"],
};

const GOAL_PHRASE: Partial<Record<ActivityKind, string>> = {
  sleeping: "to sleep",
  eating: "to eat",
  working: "for work",
  shopping: "to shop",
  socializing: "to meet people",
  leisure: "to relax",
  committing_crime: "looking for an easy target",
  patrolling: "for patrol",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function sunIcon(): string {
  return `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="6.5" fill="#f2c14e"/><g stroke="#f2c14e" stroke-width="2.2" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => {
      const r = (a * Math.PI) / 180;
      return `<line x1="${16 + Math.cos(r) * 10}" y1="${16 + Math.sin(r) * 10}" x2="${16 + Math.cos(r) * 13}" y2="${16 + Math.sin(r) * 13}"/>`;
    })
    .join("")}</g></svg>`;
}

function moonIcon(): string {
  return `<svg viewBox="0 0 32 32"><path d="M21 5a11 11 0 1 0 6 19A12 12 0 0 1 21 5z" fill="#c9d6ff"/><circle cx="12" cy="13" r="1.3" fill="#9fb0e0"/><circle cx="15" cy="21" r="1.8" fill="#9fb0e0"/></svg>`;
}

export interface HUDCallbacks {
  onSpeed: (scale: number) => void;
  onFollow: (npcId: string) => void;
  onClose: () => void;
}

export class HUD {
  private root: HTMLDivElement;
  private clockTime!: HTMLDivElement;
  private clockDate!: HTMLDivElement;
  private clockIcon!: HTMLDivElement;
  private isNightIcon: boolean | null = null;
  private speedButtons: HTMLButtonElement[] = [];
  private stats: HTMLDivElement;
  private inspector: HTMLDivElement;
  private banner: HTMLDivElement;
  readonly minimap: Minimap;
  private inspectorTimer = 0;

  constructor(container: HTMLElement, sim: Simulation, private cb: HUDCallbacks) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    container.appendChild(this.root);

    const clock = this.panel("clock");
    this.clockIcon = document.createElement("div");
    const text = document.createElement("div");
    this.clockTime = document.createElement("div");
    this.clockTime.className = "time";
    this.clockDate = document.createElement("div");
    this.clockDate.className = "date";
    text.append(this.clockTime, this.clockDate);
    clock.append(this.clockIcon, text);

    const speed = this.panel("speed");
    for (const s of SPEEDS) {
      const b = document.createElement("button");
      b.textContent = s === 0 ? "❚❚" : `${s}×`;
      b.title = s === 0 ? "Pause (Space)" : `${s}× speed`;
      b.onclick = () => cb.onSpeed(s);
      speed.appendChild(b);
      this.speedButtons.push(b);
    }

    this.stats = this.panel("stats");
    this.banner = this.panel("banner");
    this.inspector = this.panel("inspector");

    const mm = this.panel("minimap");
    this.minimap = new Minimap(mm, sim);

    const hints = this.panel("hints");
    hints.innerHTML = [
      ["WASD", "move"],
      ["Wheel", "zoom"],
      ["Click", "inspect"],
      ["F", "follow"],
      ["Space", "pause"],
      ["1–6", "speed"],
      ["F3", "debug"],
      ["Esc", "back"],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join("");

    this.inspector.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("button");
      if (!t) return;
      if (t.dataset.action === "follow" && t.dataset.id) cb.onFollow(t.dataset.id);
      if (t.dataset.action === "close") cb.onClose();
    });
  }

  private panel(cls: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `panel ${cls}`;
    this.root.appendChild(el);
    return el;
  }

  update(sim: Simulation, fps: number, simMs: number, cameraPos: Vec2, dt: number): void {
    const now = sim.clock.now();
    this.clockTime.textContent = `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
    const phase = now.hour < 5 ? "Night" : now.hour < 12 ? "Morning" : now.hour < 17 ? "Afternoon" : now.hour < 21 ? "Evening" : "Night";
    const fullDay = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][now.day];
    this.clockDate.textContent = `${fullDay} · Day ${now.dayOfMonth + 1} · ${phase}`;
    const night = sim.clock.daylightFactor() < 0.15;
    if (night !== this.isNightIcon) {
      this.clockIcon.innerHTML = night ? moonIcon() : sunIcon();
      this.isNightIcon = night;
    }

    const active = sim.clock.paused ? 0 : sim.clock.timeScale;
    this.speedButtons.forEach((b, i) => b.classList.toggle("active", SPEEDS[i] === active));

    let driving = 0;
    let walking = 0;
    let working = 0;
    for (const n of sim.npcSystem.npcs.values()) {
      if (n.inVehicle) driving++;
      else if (n.pathNodeIds.length > 0) walking++;
      if (n.currentActivity === "working") working++;
    }
    const district = sim.city.districtAt(cameraPos.x, cameraPos.y)?.name ?? "Outskirts";
    this.stats.innerHTML = `
      <div class="title">Location</div>
      <div class="district">${esc(district)}</div>
      <div class="row"><span>Population</span><span>${sim.npcSystem.npcs.size}</span></div>
      <div class="row"><span>Driving</span><span>${driving}</span></div>
      <div class="row"><span>On foot</span><span>${walking}</span></div>
      <div class="row"><span>At work</span><span>${working}</span></div>
      <div class="row"><span>FPS</span><span>${fps.toFixed(0)}</span></div>
      <div class="row"><span>Sim cost</span><span>${simMs.toFixed(2)} ms</span></div>`;

    this.inspectorTimer -= dt;
  }

  setFollowing(name: string | null): void {
    if (!name) {
      this.banner.style.display = "none";
      return;
    }
    this.banner.style.display = "flex";
    this.banner.innerHTML = `<span class="dot"></span>Following <b>${esc(name)}</b><span style="color:var(--muted)">· Esc to return</span>`;
  }

  /** Re-rendered at ~5 Hz: rebuilding innerHTML every frame would steal clicks and waste time. */
  showInspector(npc: NPC, sim: Simulation, following: boolean, force = false): void {
    if (!force && this.inspectorTimer > 0 && this.inspector.style.display === "block") return;
    this.inspectorTimer = 0.2;
    this.inspector.style.display = "block";
    const city = sim.city;
    const home = city.buildings.get(npc.homeId);
    const work = npc.workplaceId ? city.buildings.get(npc.workplaceId) : undefined;
    const target = npc.targetBuildingId ? city.buildings.get(npc.targetBuildingId) : undefined;
    const district = city.districtAt(npc.pos.x, npc.pos.y)?.name ?? "Outskirts";
    const [factionLabel, factionColor] = FACTION_LABEL[npc.faction] ?? ["Unknown", "#999"];

    const moving = npc.inVehicle || npc.pathNodeIds.length > 0;
    const place = target ? (target.id === npc.homeId ? "home" : target.name) : "somewhere";
    let now: string;
    if (moving) {
      now = `${npc.inVehicle ? "Driving" : "Walking"} to <b>${esc(place)}</b> ${GOAL_PHRASE[npc.currentGoal as ActivityKind] ?? ""}`;
    } else {
      now = activityPhrase(npc, place, npc.occupation);
    }

    const need = (label: string, v: number) => {
      const color = v > 60 ? "var(--good)" : v > 30 ? "var(--warn)" : "var(--bad)";
      return `<div class="need"><span>${label}</span><div class="bar"><div style="width:${v.toFixed(0)}%;background:${color}"></div></div><span>${v.toFixed(0)}</span></div>`;
    };

    const rels = Array.from(npc.relationships.values()).slice(0, 6);
    const relHtml = rels.length
      ? rels.map((r) => `<div class="memory">${esc(sim.npcSystem.npcs.get(r.npcId)?.name ?? r.npcId)} · ${r.type} (${r.trust.toFixed(0)})</div>`).join("")
      : `<div class="empty">No notable relationships yet.</div>`;
    const memHtml = npc.memories.length
      ? npc.memories.slice(-5).reverse().map((m) => `<div class="memory">• ${esc(m.note)}</div>`).join("")
      : `<div class="empty">Nothing memorable has happened yet.</div>`;

    this.inspector.innerHTML = `
      <div class="head">
        <div>
          <div class="name">${esc(npc.name)}</div>
          <div class="sub">${npc.age} · ${OCCUPATION_LABEL[npc.occupation]} · #${esc(npc.id)}</div>
        </div>
        <span class="chip" style="color:${factionColor}">${factionLabel}</span>
      </div>
      <div class="now">${now}</div>
      <div class="kv">
        <div>Location</div><div>${esc(district)}</div>
        <div>Home</div><div>${esc(home?.name ?? "Homeless")}</div>
        <div>Workplace</div><div>${esc(work?.name ?? "—")}</div>
        <div>Money</div><div>$${Math.floor(npc.money).toLocaleString()}</div>
        <div>Wage</div><div>${npc.wage ? `$${npc.wage}/hr` : "—"}</div>
        <div>Car</div><div>${npc.vehicleId ? (npc.inVehicle ? "Driving it now" : "Owns one") : "None"}</div>
        <div>Record</div><div>${npc.criminalRecord ? `${npc.criminalRecord} offence${npc.criminalRecord > 1 ? "s" : ""}` : "Clean"}</div>
        <div>Sim detail</div><div>${npc.lod}</div>
      </div>
      <h4>Needs</h4>
      ${need("Hunger", npc.needs.hunger)}
      ${need("Energy", npc.needs.energy)}
      ${need("Social", npc.needs.social)}
      ${need("Fun", npc.needs.fun)}
      ${need("Safety", npc.needs.safety)}
      <h4>Relationships</h4>${relHtml}
      <h4>Recent memories</h4>${memHtml}
      <div class="actions">
        <button class="primary" data-action="follow" data-id="${esc(npc.id)}">${following ? "Following" : "Follow"}</button>
        <button data-action="close">Close</button>
      </div>`;
  }

  hideInspector(): void {
    this.inspector.style.display = "none";
  }
}

function activityPhrase(npc: NPC, place: string, occ: OccupationKind): string {
  const at = `<b>${esc(place)}</b>`;
  switch (npc.currentActivity) {
    case "sleeping":
      return place === "home" ? "Asleep at <b>home</b>" : `Sleeping at ${at}`;
    case "eating":
      return place === "home" ? "Having a meal at <b>home</b>" : `Eating at ${at}`;
    case "working":
      return occ === "student" ? `In class at ${at}` : `Working at ${at}`;
    case "shopping":
      return `Shopping at ${at}`;
    case "socializing":
      return `Hanging out at ${at}`;
    case "leisure":
      return place === "home" ? "Relaxing at <b>home</b>" : `Relaxing at ${at}`;
    case "patrolling":
      return `On duty at ${at}`;
    case "committing_crime":
      return `Loitering near ${at}`;
    default:
      return `Idle at ${at}`;
  }
}
