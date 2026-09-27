import type { SimClock } from "../core/Clock";
import type { EventBus } from "../core/EventBus";
import type { SeededRandom } from "../core/Random";
import { dist, nextId } from "../core/types";
import type { Building, City } from "../world/City";
import type { NPC } from "../npc/NPC";
import type { NPCSystem } from "../npc/NPCSystem";
import type { VehicleSystem } from "../traffic/VehicleSystem";
import type { Economy } from "../economy/Economy";
import { addMemory, adjustTrust } from "../social/Memory";

export type IncidentKind = "theft" | "robbery" | "mugging" | "assault" | "fire" | "medical";
export type UnitKind = "police" | "fire" | "ambulance";

export interface Incident {
  id: string;
  kind: IncidentKind;
  x: number;
  y: number;
  nodeId: string;
  buildingId?: string;
  suspectId?: string;
  victimId?: string;
  createdAt: number;
  status: "open" | "responding" | "on_scene" | "pursuit" | "closed";
  /** 0..1 how well police can identify the suspect from witness statements. */
  evidence: number;
  witnessIds: string[];
  severity: number;
  unitIds: string[];
  resolution?: string;
}

export interface Unit {
  id: string;
  kind: UnitKind;
  vehicleId: string;
  stationId: string;
  status: "idle" | "responding" | "on_scene" | "pursuing" | "transporting" | "returning";
  incidentId?: string;
  timer: number;
  passengerId?: string;
  pursuitMinutes: number;
  rerouteTimer: number;
}

const UNITS_PER_STATION: Record<UnitKind, number> = { police: 3, fire: 2, ambulance: 2 };
const STATION_KIND: Record<UnitKind, Building["kind"]> = { police: "police_station", fire: "fire_station", ambulance: "hospital" };
const VEHICLE_KIND = { police: "police_car", fire: "fire_truck", ambulance: "ambulance" } as const;
const ARREST_RANGE = 16;
const FLEE_TRIGGER_RANGE = 140;

/**
 * Police, fire and ambulance dispatch. Units are real vehicles parked at real
 * stations; dispatch picks the nearest idle unit and it drives there through
 * traffic. Nothing is ever spawned next to a suspect. Incidents only reach
 * this system if someone reported them.
 */
export class EmergencySystem {
  units = new Map<string, Unit>();
  /** Gang lookups supplied by the crime system, for arrest reporting. */
  gangName?: (gangId: string) => string | undefined;
  isGangLeader?: (npcId: string) => boolean;
  incidents = new Map<string, Incident>();
  closed: Incident[] = [];

  constructor(
    private city: City,
    private npcSystem: NPCSystem,
    private vehicles: VehicleSystem,
    private economy: Economy,
    private bus: EventBus,
    private clock: SimClock,
    private rng: SeededRandom,
  ) {}

  init(): void {
    for (const kind of ["police", "fire", "ambulance"] as UnitKind[]) {
      for (const station of this.city.buildingsOfKind(STATION_KIND[kind])) {
        for (let i = 0; i < UNITS_PER_STATION[kind]; i++) {
          const vid = nextId("veh");
          const v = this.vehicles.spawnParked(vid, VEHICLE_KIND[kind], undefined, station);
          v.homeBuildingId = station.id;
          const unit: Unit = { id: nextId("unit"), kind, vehicleId: vid, stationId: station.id, status: "idle", timer: 0, pursuitMinutes: 0, rerouteTimer: 0 };
          this.units.set(unit.id, unit);
        }
      }
    }
  }

  get npcs(): Map<string, NPC> {
    return this.npcSystem.npcs;
  }

  report(inc: Omit<Incident, "id" | "nodeId" | "status" | "unitIds" | "createdAt">): Incident {
    const node = this.city.roads.nearestNode(inc)!;
    const incident: Incident = { ...inc, id: nextId("inc"), nodeId: node.id, status: "open", unitIds: [], createdAt: this.clock.totalMinutes };
    this.incidents.set(incident.id, incident);
    return incident;
  }

  update(dt: number): void {
    this.dispatch();
    for (const unit of this.units.values()) this.stepUnit(unit, dt);
    this.stepFires(dt);
    this.stepCustody();
  }

  private dispatch(): void {
    const open = Array.from(this.incidents.values()).filter((i) => i.status === "open").sort((a, b) => b.severity - a.severity);
    for (const inc of open) {
      const kind: UnitKind = inc.kind === "fire" ? "fire" : inc.kind === "medical" ? "ambulance" : "police";
      const want = inc.kind === "fire" && inc.severity > 0.6 ? 2 : 1;
      for (let n = 0; n < want; n++) {
        const unit = this.nearestIdle(kind, inc);
        if (!unit) break;
        if (!this.vehicles.requestTripToNode(unit.vehicleId, inc.nodeId)) continue;
        this.vehicles.vehicles.get(unit.vehicleId)!.siren = true;
        unit.status = "responding";
        unit.incidentId = inc.id;
        inc.unitIds.push(unit.id);
        inc.status = "responding";
        const station = this.city.buildings.get(unit.stationId)!;
        this.bus.emit("police.dispatched", { unitId: unit.id, targetX: inc.x, targetY: inc.y, reason: inc.kind });
        if (inc.kind === "robbery" || inc.kind === "fire" || inc.kind === "assault") {
          this.chronicle(`${label(kind)} dispatched from ${station.name} to a ${inc.kind} ${this.placeOf(inc)}.`, 0.3);
        }
      }
    }
  }

  private nearestIdle(kind: UnitKind, inc: Incident): Unit | undefined {
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      if (u.kind !== kind || u.status !== "idle") continue;
      const v = this.vehicles.vehicles.get(u.vehicleId);
      if (!v) continue;
      const d = dist(v.pos, inc);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private stepUnit(unit: Unit, dt: number): void {
    const v = this.vehicles.vehicles.get(unit.vehicleId);
    if (!v) return;
    const inc = unit.incidentId ? this.incidents.get(unit.incidentId) : undefined;
    switch (unit.status) {
      case "idle":
        return;
      case "responding":
        if (!inc || inc.status === "closed") return this.returnToBase(unit);
        if (this.vehicles.hasArrived(v.id)) {
          unit.status = "on_scene";
          unit.timer = inc.kind === "fire" ? 0 : inc.kind === "medical" ? 8 : 20;
          if (inc.status !== "pursuit") inc.status = "on_scene";
          v.siren = inc.kind === "fire";
          if (inc.kind === "theft" || inc.kind === "robbery" || inc.kind === "mugging" || inc.kind === "assault") this.policeArrive(unit, inc);
        }
        return;
      case "on_scene":
        if (!inc) return this.returnToBase(unit);
        if (inc.kind === "fire") return; // handled by stepFires
        unit.timer -= dt;
        if (unit.timer > 0) return;
        if (inc.kind === "medical") return this.loadPatient(unit, inc);
        return this.concludeInvestigation(unit, inc);
      case "pursuing":
        return this.stepPursuit(unit, inc, dt);
      case "transporting":
        if (unit.passengerId) {
          const p = this.npcs.get(unit.passengerId);
          if (p) p.pos = { ...v.pos };
        }
        if (this.vehicles.hasArrived(v.id)) this.dropOff(unit);
        return;
      case "returning":
        if (this.vehicles.hasArrived(v.id)) {
          unit.status = "idle";
          v.siren = false;
          const station = this.city.buildings.get(unit.stationId);
          if (station) this.vehicles.parkAt(v.id, station);
        }
        return;
    }
  }

  /** Officers reach the scene: a suspect still nearby either gets arrested or runs. */
  private policeArrive(unit: Unit, inc: Incident): void {
    const suspect = inc.suspectId ? this.npcs.get(inc.suspectId) : undefined;
    if (!suspect || suspect.status !== "free") return;
    const v = this.vehicles.vehicles.get(unit.vehicleId)!;
    const d = dist(suspect.pos, v.pos);
    if (d < ARREST_RANGE * 1.5) return this.arrest(unit, inc, suspect);
    if (d < FLEE_TRIGGER_RANGE) this.startPursuit(unit, inc, suspect);
  }

  private startPursuit(unit: Unit, inc: Incident, suspect: NPC): void {
    unit.status = "pursuing";
    unit.pursuitMinutes = 0;
    unit.rerouteTimer = 0;
    inc.status = "pursuit";
    const v = this.vehicles.vehicles.get(unit.vehicleId)!;
    v.siren = true;
    suspect.status = "fleeing";
    suspect.needs.safety = 10;
    this.fleeFrom(suspect, v.pos);
    this.chronicle(`Police are chasing ${suspect.name} through ${this.districtName(suspect.pos)}.`, 0.35);
  }

  private fleeFrom(npc: NPC, from: { x: number; y: number }): void {
    // Run toward a node well away from the pursuer, preferring ones further from the police.
    let best: string | undefined;
    let bestScore = -Infinity;
    for (const n of this.city.roads.nodes.values()) {
      const away = dist(n, from);
      const near = dist(n, npc.pos);
      if (near > 300) continue;
      const score = away - near * 0.4 + this.rng.float(0, 40);
      if (score > bestScore) {
        bestScore = score;
        best = n.id;
      }
    }
    if (best) this.npcSystem.walkTo(npc, best);
  }

  private stepPursuit(unit: Unit, inc: Incident | undefined, dt: number): void {
    const v = this.vehicles.vehicles.get(unit.vehicleId)!;
    const suspect = inc?.suspectId ? this.npcs.get(inc.suspectId) : undefined;
    if (!inc || !suspect || suspect.status !== "fleeing") return this.returnToBase(unit);
    unit.pursuitMinutes += dt;
    unit.rerouteTimer -= dt;
    const d = dist(v.pos, suspect.pos);
    if (d < ARREST_RANGE) return this.arrest(unit, inc, suspect);
    // Suspects who run out of path keep running.
    if (suspect.pathNodeIds.length === 0) this.fleeFrom(suspect, v.pos);
    if (unit.rerouteTimer <= 0) {
      unit.rerouteTimer = 1.5;
      const target = this.city.roads.nearestNode(suspect.pos);
      if (target) this.vehicles.requestTripToNode(v.id, target.id);
    }
    // Cars catch runners fast; a head start, smarts and courage buy time.
    const escapeOdds = 0.012 * dt * (0.5 + suspect.personality.intelligence + (d > 80 ? 1 : 0));
    if (unit.pursuitMinutes > 45 || this.rng.chance(escapeOdds)) {
      suspect.status = "free";
      suspect.wantedLevel = Math.min(5, suspect.wantedLevel + 1);
      this.npcSystem.resetGoal(suspect);
      addMemory(suspect, { kind: "life_event", note: "Got away from the police", valence: 0.4, importance: 0.8, at: this.clock.totalMinutes });
      this.chronicle(`${suspect.name} escaped a police chase and is now wanted.`, 0.45);
      inc.status = "closed";
      inc.resolution = "suspect escaped";
      this.closeIncident(inc);
      this.returnToBase(unit);
    }
  }

  private arrest(unit: Unit, inc: Incident, suspect: NPC): void {
    suspect.status = "arrested";
    suspect.pathNodeIds = [];
    suspect.inVehicle = false;
    suspect.criminalRecord += 1;
    suspect.wantedLevel = 0;
    const hours = 10 + inc.severity * 24 + suspect.criminalRecord * 6;
    suspect.releaseAtMinutes = this.clock.totalMinutes + hours * 60;
    addMemory(suspect, { kind: "arrested", note: `Arrested for ${inc.kind}`, valence: -0.9, importance: 0.95, at: this.clock.totalMinutes });
    this.economy.arrestsToday++;
    unit.passengerId = suspect.id;
    unit.status = "transporting";
    const station = this.city.buildings.get(unit.stationId)!;
    this.vehicles.requestTrip(unit.vehicleId, station);
    this.vehicles.vehicles.get(unit.vehicleId)!.siren = false;
    inc.status = "closed";
    inc.resolution = "suspect arrested";
    this.closeIncident(inc);
    this.bus.emit("police.arrest", { officerId: unit.id, suspectId: suspect.id });
    const gang = suspect.gangId ? this.gangName?.(suspect.gangId) : undefined;
    const leader = suspect.gangId ? this.isGangLeader?.(suspect.id) : false;
    const who = gang ? `${suspect.name}${leader ? `, leader of the ${gang},` : ` of the ${gang}`}` : suspect.name;
    this.chronicle(`Police arrested ${who} for ${inc.kind} ${this.placeOf(inc)}.`, leader ? 0.9 : gang ? 0.65 : inc.severity > 0.5 ? 0.55 : 0.4);

    // An arrest can cost you your job.
    if (suspect.workplaceId && this.rng.chance(0.55)) {
      const b = this.city.buildings.get(suspect.workplaceId);
      this.economy.unemploy(suspect, `fired from ${b?.name ?? "work"} after an arrest`, this.clock.now().dayOfMonth);
    }
  }

  /** No suspect in sight: identify them from witness statements, or close unsolved. */
  private concludeInvestigation(unit: Unit, inc: Incident): void {
    const suspect = inc.suspectId ? this.npcs.get(inc.suspectId) : undefined;
    if (suspect && suspect.status === "free" && inc.evidence >= 0.6) {
      // Identified: go pick them up wherever they are now.
      const node = this.city.roads.nearestNode(suspect.pos)!;
      inc.nodeId = node.id;
      inc.x = suspect.pos.x;
      inc.y = suspect.pos.y;
      suspect.wantedLevel = Math.min(5, suspect.wantedLevel + 1);
      if (this.vehicles.requestTripToNode(unit.vehicleId, node.id)) {
        unit.status = "responding";
        this.vehicles.vehicles.get(unit.vehicleId)!.siren = true;
        inc.status = "responding";
        return;
      }
    }
    inc.status = "closed";
    inc.resolution = suspect ? "unsolved: not enough evidence" : "unsolved";
    this.closeIncident(inc);
    this.returnToBase(unit);
  }

  private loadPatient(unit: Unit, inc: Incident): void {
    const patient = inc.victimId ? this.npcs.get(inc.victimId) : undefined;
    const hospital = this.city.buildings.get(unit.stationId)!;
    inc.status = "closed";
    this.closeIncident(inc);
    if (!patient || patient.status !== "incapacitated") return this.returnToBase(unit);
    unit.passengerId = patient.id;
    patient.status = "hospitalized";
    unit.status = "transporting";
    this.vehicles.requestTrip(unit.vehicleId, hospital);
  }

  private dropOff(unit: Unit): void {
    const p = unit.passengerId ? this.npcs.get(unit.passengerId) : undefined;
    const station = this.city.buildings.get(unit.stationId)!;
    unit.passengerId = undefined;
    if (p) {
      p.pos = { x: station.x, y: station.y };
      if (unit.kind === "ambulance") {
        p.status = "hospitalized";
        p.releaseAtMinutes = this.clock.totalMinutes + this.rng.int(8, 30) * 60;
        const bill = Math.min(p.money, this.rng.int(250, 900));
        p.money -= bill;
        this.economy.treasury += bill;
        addMemory(p, { kind: "life_event", note: `Treated at ${station.name} ($${bill} bill)`, valence: -0.5, importance: 0.8, at: this.clock.totalMinutes });
      }
    }
    unit.status = "idle";
    this.vehicles.vehicles.get(unit.vehicleId)!.siren = false;
    this.vehicles.parkAt(unit.vehicleId, station);
  }

  private returnToBase(unit: Unit): void {
    const station = this.city.buildings.get(unit.stationId)!;
    unit.incidentId = undefined;
    unit.status = "returning";
    const v = this.vehicles.vehicles.get(unit.vehicleId)!;
    v.siren = false;
    if (!this.vehicles.requestTrip(unit.vehicleId, station)) {
      unit.status = "idle";
      this.vehicles.parkAt(unit.vehicleId, station);
    }
  }

  private closeIncident(inc: Incident): void {
    this.incidents.delete(inc.id);
    this.closed.push(inc);
    if (this.closed.length > 200) this.closed.shift();
  }

  /** Releases people whose jail time or hospital stay is over. */
  private stepCustody(): void {
    const now = this.clock.totalMinutes;
    for (const npc of this.npcs.values()) {
      if ((npc.status === "arrested" || npc.status === "hospitalized") && npc.releaseAtMinutes !== undefined && now >= npc.releaseAtMinutes) {
        const wasJailed = npc.status === "arrested";
        npc.status = "free";
        npc.releaseAtMinutes = undefined;
        if (!wasJailed) npc.health = Math.max(npc.health, 80);
        this.npcSystem.resetGoal(npc);
        addMemory(npc, { kind: "life_event", note: wasJailed ? "Released from custody" : "Discharged from hospital", valence: 0.3, importance: 0.5, at: now });
      }
    }
  }

  // ---- Fires -------------------------------------------------------------

  startFire(b: Building, cause: string): void {
    if (b.onFire !== undefined || b.ruined) return;
    b.onFire = 0.08;
    // Occupants get out and head for the nearest park.
    const park = this.nearestPark(b);
    for (const npc of this.npcs.values()) {
      if (npc.status !== "free" || npc.targetBuildingId !== b.id || npc.pathNodeIds.length > 0) continue;
      npc.needs.safety = 5;
      addMemory(npc, { kind: "life_event", note: `Escaped a fire at ${b.name}`, valence: -0.8, importance: 0.9, at: this.clock.totalMinutes, locationId: b.id });
      if (park) {
        npc.targetBuildingId = park.id;
        this.npcSystem.walkTo(npc, park.nearestRoadNodeId);
      }
    }
    this.report({ kind: "fire", x: b.x, y: b.y, buildingId: b.id, evidence: 0, witnessIds: [], severity: 0.7 });
    this.bus.emit("emergency.fire", { locationId: b.id, x: b.x, y: b.y });
    this.chronicle(`${cause} started a fire at ${b.name}.`, 0.7);
  }

  private stepFires(dt: number): void {
    for (const inc of this.incidents.values()) {
      if (inc.kind !== "fire" || !inc.buildingId) continue;
      const b = this.city.buildings.get(inc.buildingId);
      if (!b || b.onFire === undefined) continue;
      const crews = inc.unitIds.map((id) => this.units.get(id)!).filter((u) => u.status === "on_scene").length;
      b.onFire += dt * (0.009 - crews * 0.03);
      if (b.onFire <= 0) {
        b.onFire = undefined;
        inc.status = "closed";
        inc.resolution = crews ? "extinguished" : "burned out";
        this.closeIncident(inc);
        for (const id of inc.unitIds) this.returnToBase(this.units.get(id)!);
        this.bus.emit("emergency.resolved", { kind: "fire", locationId: b.id });
        this.chronicle(`Firefighters put out the fire at ${b.name}.`, 0.4);
      } else if (b.onFire >= 1) {
        this.destroyBuilding(b);
        inc.status = "closed";
        inc.resolution = "building destroyed";
        this.closeIncident(inc);
        for (const id of inc.unitIds) this.returnToBase(this.units.get(id)!);
      }
    }
  }

  private destroyBuilding(b: Building): void {
    b.onFire = undefined;
    b.ruined = true;
    b.ruinedSinceDay = this.clock.now().dayOfMonth;
    const day = this.clock.now().dayOfMonth;
    const biz = this.economy.businessAt(b.id);
    if (biz) this.economy.closeBusiness(biz, "burned down", day);
    for (const id of b.residentIds.slice()) {
      const npc = this.npcs.get(id);
      if (!npc) continue;
      npc.homeless = true;
      npc.homeId = "";
      addMemory(npc, { kind: "life_event", note: `Lost their home when ${b.name} burned down`, valence: -1, importance: 1, at: this.clock.totalMinutes });
      this.bus.emit("npc.evicted", { npcId: npc.id });
    }
    const displaced = b.residentIds.length;
    b.residentIds = [];
    b.rebuildResidentCapacity = b.residentCapacity;
    b.residentCapacity = 0;
    b.jobCapacity = 0;
    this.chronicle(`${b.name} burned down${displaced ? `, leaving ${displaced} ${displaced === 1 ? "resident" : "residents"} homeless` : ""}.`, 0.9);
  }

  // ---- Medical -----------------------------------------------------------

  collapse(npc: NPC, cause: string): void {
    if (npc.status !== "free") return;
    npc.status = "incapacitated";
    npc.pathNodeIds = [];
    npc.inVehicle = false;
    npc.incapacitatedAt = this.clock.totalMinutes;
    this.report({ kind: "medical", x: npc.pos.x, y: npc.pos.y, victimId: npc.id, evidence: 0, witnessIds: [], severity: 0.8 });
    this.bus.emit("emergency.medical", { locationId: "", x: npc.pos.x, y: npc.pos.y, npcId: npc.id });
    this.chronicle(`${npc.name} collapsed (${cause}) ${this.districtPhrase(npc.pos)}; an ambulance is on the way.`, 0.45);
  }

  /** People left waiting too long for an ambulance may not make it. */
  checkUnattended(): void {
    for (const npc of this.npcs.values()) {
      if (npc.status !== "incapacitated" || npc.incapacitatedAt === undefined) continue;
      if (this.clock.totalMinutes - npc.incapacitatedAt > 150 && this.rng.chance(0.3)) {
        npc.status = "deceased";
        npc.alive = false;
        this.bus.emit("npc.died", { npcId: npc.id, cause: "no ambulance arrived in time" });
        this.chronicle(`${npc.name} died waiting for an ambulance.`, 0.9);
        const home = this.city.buildings.get(npc.homeId);
        if (home) home.residentIds = home.residentIds.filter((id) => id !== npc.id);
        if (npc.workplaceId) this.economy.unemploy(npc, "passed away", this.clock.now().dayOfMonth);
        for (const other of this.npcs.values()) {
          const r = other.relationships.get(npc.id);
          if (r && (r.type === "family" || r.type === "romantic" || r.type === "friend")) {
            addMemory(other, { kind: "life_event", note: `Grieving the loss of ${npc.name}`, valence: -1, importance: 1, at: this.clock.totalMinutes, aboutNpcId: npc.id });
            if (other.partnerId === npc.id) other.partnerId = undefined;
          }
        }
      }
    }
  }

  private nearestPark(b: Building): Building | undefined {
    let best: Building | undefined;
    let bestD = Infinity;
    for (const p of this.city.buildingsOfKind("park")) {
      const d = dist(p, b);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private placeOf(inc: Incident): string {
    const b = inc.buildingId ? this.city.buildings.get(inc.buildingId) : undefined;
    return b ? `at ${b.name}` : this.districtPhrase(inc);
  }

  private districtName(p: { x: number; y: number }): string {
    return this.city.districtAt(p.x, p.y)?.name ?? "the outskirts";
  }

  private districtPhrase(p: { x: number; y: number }): string {
    return `in ${this.districtName(p)}`;
  }

  private chronicle(text: string, importance: number): void {
    this.bus.emit("chronicle.entry", { day: this.clock.now().dayOfMonth, text, importance });
  }

  /** Makes a victim or witness remember and resent the suspect. */
  static rememberCrime(npc: NPC, suspect: NPC, kind: IncidentKind, role: "victim" | "witness", at: number, locationId?: string): void {
    const victim = role === "victim";
    addMemory(npc, {
      kind: victim ? "was_victim" : "witnessed_crime",
      note: victim ? `Was the victim of a ${kind} by ${suspect.name}` : `Saw ${suspect.name} commit a ${kind}`,
      valence: victim ? -0.9 : -0.5,
      importance: victim ? 0.95 : 0.6,
      at,
      aboutNpcId: suspect.id,
      locationId,
    });
    adjustTrust(npc, suspect, victim ? -60 : -25, at);
    npc.needs.safety = Math.max(0, npc.needs.safety - (victim ? 60 : 25));
  }
}

function label(kind: UnitKind): string {
  return kind === "police" ? "Police" : kind === "fire" ? "Fire crews" : "An ambulance";
}
