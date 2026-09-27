import type { Simulation } from "../sim/Simulation";
import type { ActivityKind, NPC, OccupationKind } from "../npc/NPC";
import type { Building } from "../world/City";
import type { Vec2 } from "../core/types";
import type { ChronicleEntry } from "../events/Chronicle";
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
  civil_servant: "Civil servant",
  criminal: "Career criminal",
};

const KIND_LABEL: Record<Building["kind"], string> = {
  home_apartment: "Apartment building",
  home_house: "House",
  office: "Office",
  shop: "Shop",
  restaurant: "Restaurant",
  hospital: "Hospital",
  police_station: "Police station",
  fire_station: "Fire station",
  park: "Park",
  warehouse: "Warehouse",
  government: "Government",
  parking: "Parking",
  school: "School",
  bank: "Bank",
};

const FACTION_LABEL: Record<string, [string, string]> = {
  civilians: ["Civilian", "#9fb4c7"],
  police: ["Police", "#4d7cff"],
  government: ["Government", "#d4af37"],
  criminals: ["Criminal", "#ff6b5e"],
  business: ["Business", "#5fd38d"],
  emergency_services: ["Emergency", "#ff9a4d"],
};

const STATUS_LABEL: Record<NPC["status"], string> = {
  free: "",
  arrested: "In police custody",
  fleeing: "Running from the police",
  incapacitated: "Collapsed — waiting for an ambulance",
  hospitalized: "In hospital",
  deceased: "Deceased",
};

const GOAL_PHRASE: Partial<Record<ActivityKind, string>> = {
  sleeping: "to sleep",
  eating: "to eat",
  working: "for work",
  shopping: "to shop",
  socializing: "to meet people",
  leisure: "to relax",
  committing_crime: "looking for an easy target",
  patrolling: "for their shift",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function money(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString()}`;
}

function clockText(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
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
  onSelectNpc: (npcId: string) => void;
  onSelectBuilding: (buildingId: string) => void;
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
  private feed: HTMLDivElement;
  private chronicle: HTMLDivElement;
  private chronicleMode: "headlines" | "all" = "headlines";
  readonly minimap: Minimap;
  private inspectorTimer = 0;
  private statsTimer = 0;

  constructor(container: HTMLElement, private sim: Simulation, private cb: HUDCallbacks) {
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
    const chronBtn = document.createElement("button");
    chronBtn.className = "chron-btn";
    chronBtn.textContent = "Chronicle";
    chronBtn.title = "World Chronicle (C)";
    chronBtn.onclick = () => this.toggleChronicle();
    speed.appendChild(chronBtn);

    this.stats = this.panel("stats");
    this.banner = this.panel("banner");
    this.inspector = this.panel("inspector");
    this.feed = document.createElement("div");
    this.feed.className = "feed";
    this.root.appendChild(this.feed);
    this.chronicle = this.panel("chronicle");

    const mm = this.panel("minimap");
    this.minimap = new Minimap(mm, sim);

    const hints = this.panel("hints");
    hints.innerHTML = [
      ["WASD", "move"],
      ["Wheel", "zoom"],
      ["Click", "inspect"],
      ["F", "follow"],
      ["C", "chronicle"],
      ["Space", "pause"],
      ["1–6", "speed"],
      ["F3", "debug"],
      ["Esc", "back"],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join("");

    const onClick = (e: Event) => {
      const t = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
      if (!t) return;
      const id = t.dataset.id ?? "";
      switch (t.dataset.action) {
        case "follow":
          cb.onFollow(id);
          break;
        case "close":
          cb.onClose();
          break;
        case "npc":
          cb.onSelectNpc(id);
          break;
        case "building":
          cb.onSelectBuilding(id);
          break;
        case "chron-mode":
          this.chronicleMode = t.dataset.mode as "headlines" | "all";
          this.renderChronicle();
          break;
        case "chron-close":
          this.toggleChronicle(false);
          break;
      }
    };
    this.inspector.addEventListener("click", onClick);
    this.chronicle.addEventListener("click", onClick);

    sim.chronicle.onEntry((e) => this.pushFeed(e));
  }

  private panel(cls: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `panel ${cls}`;
    this.root.appendChild(el);
    return el;
  }

  // ---- Frame updates ------------------------------------------------------

  update(fps: number, simMs: number, cameraPos: Vec2, dt: number): void {
    const sim = this.sim;
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

    this.inspectorTimer -= dt;
    this.statsTimer -= dt;
    if (this.statsTimer > 0) return;
    this.statsTimer = 0.25;

    let driving = 0;
    let walking = 0;
    let working = 0;
    let homeless = 0;
    let unemployed = 0;
    let labor = 0;
    let jailed = 0;
    for (const n of sim.npcSystem.npcs.values()) {
      if (!n.alive) continue;
      if (n.inVehicle) driving++;
      else if (n.pathNodeIds.length > 0) walking++;
      if (n.currentActivity === "working" || n.currentActivity === "patrolling") working++;
      if (n.homeless) homeless++;
      if (n.status === "arrested") jailed++;
      if (n.occupation !== "student" && n.age >= 18 && n.age < 68) {
        labor++;
        if (!n.workplaceId) unemployed++;
      }
    }
    const pop = Array.from(sim.npcSystem.npcs.values()).filter((n) => n.alive).length;
    const district = sim.city.districtAt(cameraPos.x, cameraPos.y)?.name ?? "Outskirts";
    const eco = sim.economy;
    const climate = eco.climate < 0.85 ? ["Recession", "var(--bad)"] : eco.climate > 1.15 ? ["Boom", "var(--good)"] : ["Stable", "var(--text)"];
    this.stats.innerHTML = `
      <div class="title">Location</div>
      <div class="district">${esc(district)}</div>
      <div class="row"><span>Population</span><span>${pop}</span></div>
      <div class="row"><span>Driving · on foot</span><span>${driving} · ${walking}</span></div>
      <div class="row"><span>On shift</span><span>${working}</span></div>
      <div class="sep"></div>
      <div class="row"><span>Unemployment</span><span>${labor ? ((unemployed / labor) * 100).toFixed(1) : 0}%</span></div>
      <div class="row"><span>Homeless</span><span>${homeless}</span></div>
      <div class="row"><span>Businesses</span><span>${eco.businesses.size}</span></div>
      <div class="row"><span>Economy</span><span style="color:${climate[1]}">${climate[0]}</span></div>
      <div class="row"><span>Treasury</span><span>${money(eco.treasury)}</span></div>
      <div class="sep"></div>
      <div class="row"><span>Crimes today</span><span>${eco.crimesToday}</span></div>
      <div class="row"><span>In custody</span><span>${jailed}</span></div>
      <div class="row"><span>Active incidents</span><span>${sim.emergency.incidents.size}</span></div>
      <div class="row"><span>Gangs</span><span>${sim.crime.gangs.size}</span></div>
      <div class="sep"></div>
      <div class="row"><span>FPS · sim cost</span><span>${fps.toFixed(0)} · ${simMs.toFixed(2)}ms</span></div>`;
    if (this.chronicle.style.display === "block") this.renderChronicle();
  }

  setFollowing(name: string | null): void {
    if (!name) {
      this.banner.style.display = "none";
      return;
    }
    this.banner.style.display = "flex";
    this.banner.innerHTML = `<span class="dot"></span>Following <b>${esc(name)}</b><span style="color:var(--muted)">· Esc to return</span>`;
  }

  // ---- News feed ----------------------------------------------------------

  private pushFeed(e: ChronicleEntry): void {
    if (e.importance < 0.4) return;
    const el = document.createElement("div");
    el.className = `toast${e.importance >= 0.7 ? " major" : ""}`;
    el.innerHTML = `<span class="when">Day ${e.day + 1} · ${clockText(e.minute)}</span>${esc(e.text)}`;
    this.feed.prepend(el);
    while (this.feed.children.length > 4) this.feed.lastElementChild?.remove();
    setTimeout(() => el.classList.add("fade"), 8000);
    setTimeout(() => el.remove(), 9000);
  }

  // ---- Chronicle ----------------------------------------------------------

  toggleChronicle(force?: boolean): void {
    const open = force ?? this.chronicle.style.display !== "block";
    this.chronicle.style.display = open ? "block" : "none";
    if (open) this.renderChronicle();
  }

  private renderChronicle(): void {
    const sim = this.sim;
    const entries = this.chronicleMode === "headlines" ? sim.chronicle.headlines(0.6) : sim.chronicle.entries;
    const byDay = new Map<number, ChronicleEntry[]>();
    for (const e of entries) {
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day)!.push(e);
    }
    const stats = sim.economy.statsHistory;
    const last = stats[stats.length - 1];
    const spark = (vals: number[], color: string) => {
      if (vals.length < 2) return "";
      const max = Math.max(...vals, 1);
      const min = Math.min(...vals, 0);
      const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 26}`).join(" ");
      return `<svg viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
    };
    const recent = stats.slice(-30);
    const days = Array.from(byDay.keys()).sort((a, b) => b - a);
    this.chronicle.innerHTML = `
      <div class="chron-head">
        <div><div class="chron-title">World Chronicle</div><div class="sub">Everything here happened in the simulation — nothing is scripted.</div></div>
        <button data-action="chron-close" class="x">✕</button>
      </div>
      <div class="chron-stats">
        <div><span>Unemployed</span><b>${last ? last.unemployed : "—"}</b>${spark(recent.map((s) => s.unemployed), "#ff9a4d")}</div>
        <div><span>Homeless</span><b>${last ? last.homeless : "—"}</b>${spark(recent.map((s) => s.homeless), "#ff6b5e")}</div>
        <div><span>Businesses</span><b>${last ? last.businesses : "—"}</b>${spark(recent.map((s) => s.businesses), "#5fd38d")}</div>
        <div><span>Crimes / day</span><b>${last ? last.crimes : "—"}</b>${spark(recent.map((s) => s.crimes), "#4dd2ff")}</div>
      </div>
      <div class="chron-tabs">
        <button data-action="chron-mode" data-mode="headlines" class="${this.chronicleMode === "headlines" ? "active" : ""}">Headlines</button>
        <button data-action="chron-mode" data-mode="all" class="${this.chronicleMode === "all" ? "active" : ""}">Everything</button>
      </div>
      <div class="chron-list">
        ${
          days.length === 0
            ? `<div class="empty">Nothing notable yet. Speed up time and let the city live.</div>`
            : days
                .map(
                  (d) => `<div class="chron-day">Day ${d + 1}</div>${byDay
                    .get(d)!
                    .slice()
                    .reverse()
                    .map((e) => `<div class="chron-entry${e.importance >= 0.75 ? " major" : ""}"><span>${clockText(e.minute)}</span>${esc(e.text)}</div>`)
                    .join("")}`,
                )
                .join("")
        }
      </div>`;
  }

  // ---- Inspectors ---------------------------------------------------------

  private link(kind: "npc" | "building", id: string, label: string): string {
    return `<a data-action="${kind}" data-id="${esc(id)}">${esc(label)}</a>`;
  }

  /** Re-rendered at ~5 Hz: rebuilding innerHTML every frame would steal clicks and waste time. */
  showInspector(npc: NPC, following: boolean, force = false): void {
    if (!force && this.inspectorTimer > 0 && this.inspector.style.display === "block") return;
    this.inspectorTimer = 0.2;
    this.inspector.style.display = "block";
    this.root.classList.add("inspecting");
    const sim = this.sim;
    const city = sim.city;
    const home = city.buildings.get(npc.homeId);
    const work = npc.workplaceId ? city.buildings.get(npc.workplaceId) : undefined;
    const target = npc.targetBuildingId ? city.buildings.get(npc.targetBuildingId) : undefined;
    const district = city.districtAt(npc.pos.x, npc.pos.y)?.name ?? "Outskirts";
    const [factionLabel, factionColor] = FACTION_LABEL[npc.faction] ?? ["Unknown", "#999"];
    const gang = npc.gangId ? sim.crime.gangs.get(npc.gangId) : undefined;
    const partner = npc.partnerId ? sim.npcSystem.npcs.get(npc.partnerId) : undefined;

    let now: string;
    if (npc.status !== "free") {
      now = `<b>${STATUS_LABEL[npc.status]}</b>`;
    } else if (npc.inVehicle || npc.pathNodeIds.length > 0) {
      const place = target ? (target.id === npc.homeId ? "home" : target.name) : "somewhere";
      now = `${npc.inVehicle ? "Driving" : "Walking"} to <b>${esc(place)}</b> ${GOAL_PHRASE[npc.currentGoal as ActivityKind] ?? ""}`;
    } else {
      now = activityPhrase(npc, target ? (target.id === npc.homeId ? "home" : target.name) : "somewhere");
    }

    const need = (label: string, v: number) => {
      const color = v > 60 ? "var(--good)" : v > 30 ? "var(--warn)" : "var(--bad)";
      return `<div class="need"><span>${label}</span><div class="bar"><div style="width:${v.toFixed(0)}%;background:${color}"></div></div><span>${v.toFixed(0)}</span></div>`;
    };

    const rels = Array.from(npc.relationships.values())
      .sort((a, b) => Math.abs(b.trust) - Math.abs(a.trust))
      .slice(0, 8);
    const relHtml = rels.length
      ? rels
          .map((r) => {
            const other = sim.npcSystem.npcs.get(r.npcId);
            const color = r.trust >= 40 ? "var(--good)" : r.trust <= -40 ? "var(--bad)" : "var(--muted)";
            return `<div class="rel">${this.link("npc", r.npcId, other?.name ?? r.npcId)}<span class="rtype">${r.type.replace("_", " ")}</span><span style="color:${color}">${r.trust > 0 ? "+" : ""}${r.trust.toFixed(0)}</span></div>`;
          })
          .join("")
      : `<div class="empty">No notable relationships yet.</div>`;
    const memHtml = npc.memories.length
      ? npc.memories
          .slice()
          .sort((a, b) => b.timestampMinutes - a.timestampMinutes)
          .slice(0, 6)
          .map((m) => {
            const day = Math.floor(m.timestampMinutes / 1440) + 1;
            return `<div class="memory"><span class="when">Day ${day}</span>${esc(m.note)}</div>`;
          })
          .join("")
      : `<div class="empty">Nothing memorable has happened yet.</div>`;

    const homeText = npc.homeless ? `<span style="color:var(--bad)">Homeless</span>` : home ? this.link("building", home.id, home.name) : "—";
    this.inspector.innerHTML = `
      <div class="head">
        <div>
          <div class="name">${esc(npc.name)}</div>
          <div class="sub">${npc.age} · ${OCCUPATION_LABEL[npc.occupation]} · #${esc(npc.id)}</div>
        </div>
        <span class="chip" style="color:${factionColor}">${gang ? esc(gang.name) : factionLabel}</span>
      </div>
      <div class="now">${now}</div>
      <div class="kv">
        <div>Location</div><div>${esc(district)}</div>
        <div>Home</div><div>${homeText}</div>
        <div>Workplace</div><div>${work ? this.link("building", work.id, work.name) : "—"}</div>
        <div>Money</div><div>${money(npc.money)}</div>
        <div>Income</div><div>${npc.occupation === "business_owner" ? "Owner's draw" : npc.wage ? `$${npc.wage}/hr` : npc.workplaceId ? "—" : npc.daysUnemployed <= 21 && npc.occupation !== "criminal" && npc.occupation !== "student" ? "Benefits $40/day" : "None"}</div>
        <div>Partner</div><div>${partner ? this.link("npc", partner.id, partner.name) : "—"}</div>
        <div>Health</div><div>${npc.health.toFixed(0)}</div>
        <div>Record</div><div>${npc.criminalRecord ? `${npc.criminalRecord} offence${npc.criminalRecord > 1 ? "s" : ""}` : "Clean"}${npc.wantedLevel ? ` · <span style="color:var(--bad)">Wanted</span>` : ""}</div>
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

  showBuilding(b: Building, force = false): void {
    if (!force && this.inspectorTimer > 0 && this.inspector.style.display === "block") return;
    this.inspectorTimer = 0.25;
    this.inspector.style.display = "block";
    this.root.classList.add("inspecting");
    const sim = this.sim;
    const district = sim.city.districts.get(b.districtId)?.name ?? "";
    const biz = sim.economy.businessAt(b.id);
    const owner = biz?.ownerId ? sim.npcSystem.npcs.get(biz.ownerId) : undefined;
    const status = b.ruined ? `<span style="color:var(--bad)">Burned-out ruin</span>` : b.onFire !== undefined ? `<span style="color:var(--bad)">On fire (${Math.round(b.onFire * 100)}%)</span>` : b.vacant ? "Vacant — for lease" : "Operating";
    const people = (ids: string[], empty: string) =>
      ids.length
        ? ids
            .slice(0, 14)
            .map((id) => {
              const n = sim.npcSystem.npcs.get(id);
              return n ? `<div class="rel">${this.link("npc", id, n.name)}<span class="rtype">${n.currentActivity}</span></div>` : "";
            })
            .join("") + (ids.length > 14 ? `<div class="empty">+${ids.length - 14} more</div>` : "")
        : `<div class="empty">${empty}</div>`;

    let finance = "";
    if (biz) {
      const hist = biz.history.slice(-7);
      const rev = hist.reduce((a, h) => a + h.revenue, 0);
      const cost = hist.reduce((a, h) => a + h.costs, 0);
      const cust = hist.reduce((a, h) => a + h.customers, 0);
      const trend = biz.daysNegative > 0 ? `<span style="color:var(--bad)">In debt ${biz.daysNegative} day${biz.daysNegative > 1 ? "s" : ""}</span>` : biz.lossStreak >= 2 ? `<span style="color:var(--warn)">Losing money</span>` : `<span style="color:var(--good)">Healthy</span>`;
      finance = `
        <h4>Business</h4>
        <div class="kv">
          <div>Owner</div><div>${owner ? this.link("npc", owner.id, owner.name) : "—"}</div>
          <div>Cash</div><div>${money(biz.cash)}</div>
          <div>7-day revenue</div><div>${money(rev)}</div>
          <div>7-day profit</div><div>${money(rev - cost)}</div>
          ${biz.sector === "retail" || biz.sector === "food" ? `<div>Customers</div><div>${cust} this week · ${money(biz.price)} avg</div>` : ""}
          <div>Status</div><div>${trend}</div>
          <div>Open</div><div>${b.openHour}:00–${b.closeHour}:00 · ${sim.economy.isOpen(b, sim.clock.now().hour) ? "open now" : "closed now"}</div>
        </div>`;
    }
    this.inspector.innerHTML = `
      <div class="head">
        <div>
          <div class="name">${esc(b.name)}</div>
          <div class="sub">${KIND_LABEL[b.kind]} · ${esc(district)}${b.floors ? ` · ${b.floors} floor${b.floors > 1 ? "s" : ""}` : ""}</div>
        </div>
      </div>
      <div class="now">${status}</div>
      ${finance}
      ${b.jobCapacity || b.employeeIds.length ? `<h4>Staff (${b.employeeIds.length}/${b.jobCapacity})</h4>${people(b.employeeIds, "No staff.")}` : ""}
      ${b.residentCapacity || b.residentIds.length ? `<h4>Residents (${b.residentIds.length}/${b.residentCapacity})${b.residentCapacity ? ` · rent ${money(sim.economy.rentFor(b))}/day` : ""}</h4>${people(b.residentIds, "Nobody lives here.")}` : ""}
      <div class="actions"><button data-action="close">Close</button></div>`;
  }

  hideInspector(): void {
    this.inspector.style.display = "none";
    this.root.classList.remove("inspecting");
  }
}

function activityPhrase(npc: NPC, place: string): string {
  const at = `<b>${esc(place)}</b>`;
  switch (npc.currentActivity) {
    case "sleeping":
      return place === "home" ? "Asleep at <b>home</b>" : `Sleeping rough at ${at}`;
    case "eating":
      return place === "home" ? "Having a meal at <b>home</b>" : `Eating at ${at}`;
    case "working":
      return npc.occupation === "student" ? `In class at ${at}` : `Working at ${at}`;
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
