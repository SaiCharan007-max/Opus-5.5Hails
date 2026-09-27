import type { SimClock } from "../core/Clock";
import type { EventBus } from "../core/EventBus";
import type { SeededRandom } from "../core/Random";
import { dist, nextId } from "../core/types";
import type { Building, City } from "../world/City";
import type { NPC } from "../npc/NPC";
import type { NPCSystem } from "../npc/NPCSystem";
import { buildSchedule } from "../npc/NPCFactory";
import type { Economy } from "../economy/Economy";
import { EmergencySystem, type IncidentKind } from "../emergency/EmergencySystem";
import { addMemory, adjustTrust } from "../social/Memory";
import type { VehicleSystem } from "../traffic/VehicleSystem";

export interface Gang {
  id: string;
  name: string;
  districtId: string;
  leaderId: string;
  memberIds: string[];
  foundedDay: number;
  rivalIds: string[];
  cash: number;
  crimes: number;
}

const GANG_NOUNS = ["Vipers", "Rats", "Crows", "Kings", "Wolves", "Saints", "Jackals", "Hounds"];
const SEVERITY: Record<IncidentKind, number> = { theft: 0.25, mugging: 0.5, robbery: 0.85, assault: 0.6, fire: 0.7, medical: 0.8 };

/**
 * Decides what a would-be criminal actually does, who saw it, who tells the
 * police, and how the criminal underworld organizes itself over time.
 * Crimes only become police incidents if someone reports them.
 */
export class CrimeSystem {
  gangs = new Map<string, Gang>();
  /** Gang funds left with no one to claim them (dissolved with no members); kept for the money ledger. */
  orphanedCash = 0;

  heldCash(): number {
    let total = this.orphanedCash;
    for (const g of this.gangs.values()) total += g.cash;
    return total;
  }

  constructor(
    private city: City,
    private npcSystem: NPCSystem,
    private economy: Economy,
    private emergency: EmergencySystem,
    private vehicles: VehicleSystem,
    private bus: EventBus,
    private clock: SimClock,
    private rng: SeededRandom,
  ) {}

  private get npcs(): Map<string, NPC> {
    return this.npcSystem.npcs;
  }

  private policeNearby(p: { x: number; y: number }): boolean {
    for (const v of this.vehicles.vehicles.values()) {
      if (v.kind === "police_car" && v.pathNodeIds.length > 0 && dist(v.pos, p) < 150) return true;
    }
    for (const n of this.npcs.values()) {
      if (n.occupation === "police_officer" && n.status === "free" && n.currentActivity === "patrolling" && dist(n.pos, p) < 60) return true;
    }
    return false;
  }

  onCrimeIntent(npc: NPC, target: Building | undefined): void {
    const at = this.clock.totalMinutes;
    const deterred = this.policeNearby(npc.pos);
    if (deterred && npc.personality.intelligence > 0.35) return; // smart criminals wait for a better moment

    const bystanders = this.nearbyPeople(npc, 55);
    const muggable = bystanders.filter((o) => o.occupation !== "police_officer" && (!npc.gangId || o.gangId !== npc.gangId));
    const biz = target ? this.economy.businessAt(target.id) : undefined;

    let kind: IncidentKind;
    let victim: NPC | undefined;
    if (muggable.length && npc.personality.aggression > 0.5 && this.rng.chance(0.4)) {
      kind = "mugging";
      victim = this.rng.pick(muggable);
    } else if (biz && target) {
      kind = npc.personality.aggression > 0.6 && npc.personality.bravery > 0.5 && this.rng.chance(0.5) ? "robbery" : "theft";
    } else return;

    const success = this.rng.chance(0.62 + npc.personality.riskTolerance * 0.15 + npc.skills.combat * 0.1 - (deterred ? 0.45 : 0));
    let take = 0;
    if (success) {
      if (kind === "mugging" && victim) {
        take = Math.round(Math.min(victim.money * 0.5, this.rng.int(20, 220)));
        victim.money -= take;
        if (npc.personality.aggression > 0.75) this.hurt(victim, this.rng.int(5, 25), "injuries from a mugging");
      } else if (target) {
        take = Math.round(this.economy.steal(target, kind === "robbery" ? this.rng.int(200, 900) : this.rng.int(20, 90)));
      }
    }
    npc.money += take;
    this.economy.crimesToday++;
    const gang = npc.gangId ? this.gangs.get(npc.gangId) : undefined;
    if (gang && take > 0) {
      const cut = Math.round(take * 0.3);
      npc.money -= cut;
      gang.cash += cut;
      gang.crimes++;
    }

    // Witnesses: bystanders plus staff on shift in the targeted business.
    const witnesses = new Set(bystanders.map((b) => b.id));
    if (target) for (const id of target.employeeIds) {
      const e = this.npcs.get(id);
      if (e && e.currentActivity === "working" && e.targetBuildingId === target.id) witnesses.add(id);
    }
    if (victim) witnesses.delete(victim.id);

    const inTurf = gang !== undefined && this.city.districtAt(npc.pos.x, npc.pos.y)?.id === gang.districtId;
    let evidence = 0;
    let reported = false;
    if (victim) {
      EmergencySystem.rememberCrime(victim, npc, kind, "victim", at, target?.id);
      if (this.rng.chance(0.85 - (inTurf ? 0.35 : 0))) {
        reported = true;
        evidence += 0.5;
      }
    }
    for (const id of witnesses) {
      const w = this.npcs.get(id);
      if (!w) continue;
      EmergencySystem.rememberCrime(w, npc, kind, "witness", at, target?.id);
      const friend = (w.relationships.get(npc.id)?.trust ?? 0) > 40;
      const staff = target?.employeeIds.includes(w.id);
      let p = staff ? 0.85 : 0.2 + w.personality.honesty * 0.4 + w.personality.bravery * 0.2;
      if (w.faction === "criminals" || friend) p -= 0.6;
      if (inTurf) p -= 0.3;
      if (this.rng.chance(p)) {
        reported = true;
        evidence += 0.25 + w.personality.intelligence * 0.3;
      }
    }

    if (success) {
      addMemory(npc, { kind: "life_event", note: `Pulled off a ${kind}${take ? ` for $${take}` : ""}`, valence: 0.3, importance: 0.5, at, locationId: target?.id });
    }
    if (reported) {
      this.emergency.report({
        kind,
        x: npc.pos.x,
        y: npc.pos.y,
        buildingId: target?.id,
        suspectId: npc.id,
        victimId: victim?.id,
        evidence: Math.min(1, evidence),
        witnessIds: Array.from(witnesses),
        severity: SEVERITY[kind],
      });
    }
    this.bus.emit("crime.committed", {
      crimeType: kind,
      suspectId: npc.id,
      victimId: victim?.id,
      locationId: target?.id ?? "",
      witnessIds: Array.from(witnesses),
      x: npc.pos.x,
      y: npc.pos.y,
    });
    if ((kind === "robbery" || kind === "mugging") && success) {
      const where = target ? target.name : this.city.districtAt(npc.pos.x, npc.pos.y)?.name ?? "the outskirts";
      const who = victim ? `${victim.name} was mugged` : `${where} was robbed`;
      this.chronicle(`${who}${victim ? ` in ${where}` : ""}${take ? ` ($${take} taken)` : ""}${reported ? "" : ". Nobody called the police"}.`, kind === "robbery" ? 0.6 : 0.4);
    }
  }

  assault(attacker: NPC, victim: NPC, reason: string): void {
    const at = this.clock.totalMinutes;
    this.economy.crimesToday++;
    this.hurt(victim, this.rng.int(10, 45), `injuries from ${reason}`);
    EmergencySystem.rememberCrime(victim, attacker, "assault", "victim", at);
    adjustTrust(attacker, victim, -15, at);
    const witnesses = this.nearbyPeople(attacker, 55).filter((w) => w.id !== victim.id);
    let evidence = victim.status === "free" ? 0.5 : 0.2;
    let reported = victim.status !== "free" || this.rng.chance(0.6);
    for (const w of witnesses) {
      EmergencySystem.rememberCrime(w, attacker, "assault", "witness", at);
      if (this.rng.chance(0.3 + w.personality.honesty * 0.4 - (w.faction === "criminals" ? 0.5 : 0))) {
        reported = true;
        evidence += 0.3;
      }
    }
    if (reported) {
      this.emergency.report({ kind: "assault", x: attacker.pos.x, y: attacker.pos.y, suspectId: attacker.id, victimId: victim.id, evidence: Math.min(1, evidence), witnessIds: witnesses.map((w) => w.id), severity: SEVERITY.assault });
    }
    this.bus.emit("crime.committed", { crimeType: "assault", suspectId: attacker.id, victimId: victim.id, locationId: "", witnessIds: witnesses.map((w) => w.id), x: attacker.pos.x, y: attacker.pos.y });
  }

  private hurt(npc: NPC, amount: number, cause: string): void {
    npc.health = Math.max(0, npc.health - amount);
    if (npc.health < 18) this.emergency.collapse(npc, cause);
  }

  private nearbyPeople(npc: NPC, radius: number): NPC[] {
    const out: NPC[] = [];
    for (const o of this.npcs.values()) {
      if (o.id === npc.id || o.status !== "free" || !o.alive) continue;
      if (o.currentActivity === "sleeping") continue;
      if (dist(o.pos, npc.pos) < radius) out.push(o);
    }
    return out;
  }

  // ---- Daily: careers and the underworld ---------------------------------

  daily(day: number): void {
    this.turnToCrime(day);
    this.maintainGangs(day);
    this.formGangs(day);
    this.gangConflict(day);
  }

  private turnToCrime(day: number): void {
    for (const npc of this.npcs.values()) {
      if (!npc.alive || npc.status !== "free" || npc.occupation === "criminal" || npc.workplaceId) continue;
      if (npc.occupation === "student" || npc.age < 18) continue;
      const hardened = npc.criminalRecord >= 2 && npc.daysUnemployed > 4 && npc.personality.honesty < 0.5;
      const desperate = npc.homeless && npc.daysUnemployed > 6 && npc.personality.honesty < 0.35;
      if (!hardened && !desperate) continue;
      npc.occupation = "criminal";
      npc.faction = "criminals";
      npc.schedule = buildSchedule(this.rng, "criminal");
      addMemory(npc, { kind: "life_event", note: "Gave up on finding honest work", valence: -0.6, importance: 0.9, at: this.clock.totalMinutes });
      this.chronicle(`${npc.name}, ${npc.homeless ? "homeless" : "out of work"} for ${npc.daysUnemployed} days, turned to a life of crime.`, 0.6);
    }
  }

  private homeDistrict(npc: NPC): string | undefined {
    const home = this.city.buildings.get(npc.homeId);
    const p = home ?? npc.pos;
    return this.city.districtAt(p.x, p.y)?.id;
  }

  private formGangs(day: number): void {
    const byDistrict = new Map<string, NPC[]>();
    for (const npc of this.npcs.values()) {
      if (!npc.alive || npc.occupation !== "criminal" || npc.gangId) continue;
      const d = this.homeDistrict(npc);
      if (!d) continue;
      if (!byDistrict.has(d)) byDistrict.set(d, []);
      byDistrict.get(d)!.push(npc);
    }
    for (const [districtId, crew] of byDistrict) {
      const existing = Array.from(this.gangs.values()).find((g) => g.districtId === districtId);
      if (existing) {
        // Local criminals drift into the established gang.
        for (const npc of crew) if (this.rng.chance(0.35)) this.join(existing, npc);
        continue;
      }
      const free = crew.filter((n) => n.status === "free");
      if (free.length < 3) continue;
      const district = this.city.districts.get(districtId)!;
      const leader = free.slice().sort((a, b) => b.criminalRecord + b.personality.aggression - (a.criminalRecord + a.personality.aggression))[0];
      const gang: Gang = {
        id: nextId("gang"),
        name: `${district.name.split(" ")[0]} ${this.rng.pick(GANG_NOUNS)}`,
        districtId,
        leaderId: leader.id,
        memberIds: [],
        foundedDay: day,
        rivalIds: [],
        cash: 0,
        crimes: 0,
      };
      this.gangs.set(gang.id, gang);
      for (const npc of free) this.join(gang, npc);
      this.chronicle(`A new criminal gang, the ${gang.name}, formed in ${district.name}, led by ${leader.name}.`, 0.85);
    }
  }

  private join(gang: Gang, npc: NPC): void {
    if (npc.gangId) return;
    npc.gangId = gang.id;
    gang.memberIds.push(npc.id);
    const at = this.clock.totalMinutes;
    for (const id of gang.memberIds) {
      const other = this.npcs.get(id);
      if (!other || other.id === npc.id) continue;
      adjustTrust(npc, other, 30, at, "criminal_associate");
      adjustTrust(other, npc, 30, at, "criminal_associate");
    }
    addMemory(npc, { kind: "life_event", note: `Joined the ${gang.name}`, valence: 0.4, importance: 0.85, at });
  }

  private maintainGangs(day: number): void {
    for (const gang of Array.from(this.gangs.values())) {
      gang.memberIds = gang.memberIds.filter((id) => {
        const n = this.npcs.get(id);
        const stays = n && n.alive && n.occupation === "criminal";
        if (n && !stays) n.gangId = undefined;
        return stays;
      });
      const active = gang.memberIds.map((id) => this.npcs.get(id)!).filter((n) => n.status === "free");
      const leader = this.npcs.get(gang.leaderId);
      if (!leader || !gang.memberIds.includes(leader.id) || leader.status === "arrested") {
        const successor = active.sort((a, b) => b.criminalRecord - a.criminalRecord)[0];
        const why = leader?.status === "arrested" ? `With ${leader.name} behind bars` : leader && !leader.alive ? `After the death of ${leader.name}` : `With ${leader?.name ?? "their leader"} gone`;
        if (successor && successor.id !== gang.leaderId && (leader?.status !== "arrested" || gang.memberIds.includes(successor.id))) {
          gang.leaderId = successor.id;
          this.chronicle(`${why}, ${successor.name} took over the ${gang.name}.`, 0.75);
        }
      }
      // Jailed members still belong; a gang only breaks up when too few members remain at all.
      if (gang.memberIds.length < 2) {
        const share = gang.memberIds.length ? Math.floor(gang.cash / gang.memberIds.length) : 0;
        for (const id of gang.memberIds) {
          const n = this.npcs.get(id);
          if (n) {
            n.gangId = undefined;
            n.money += share;
          }
        }
        this.orphanedCash += gang.cash - share * gang.memberIds.length;
        this.gangs.delete(gang.id);
        for (const g of this.gangs.values()) g.rivalIds = g.rivalIds.filter((r) => r !== gang.id);
        this.chronicle(`The ${gang.name} broke apart.`, 0.8);
      }
    }
  }

  /** Established gangs become rivals and occasionally clash. */
  private gangConflict(day: number): void {
    const gangs = Array.from(this.gangs.values());
    for (let i = 0; i < gangs.length; i++) {
      for (let j = i + 1; j < gangs.length; j++) {
        const a = gangs[i];
        const b = gangs[j];
        if (day - a.foundedDay < 2 || day - b.foundedDay < 2) continue;
        if (!a.rivalIds.includes(b.id)) {
          if (!this.rng.chance(0.3)) continue;
          a.rivalIds.push(b.id);
          b.rivalIds.push(a.id);
          const turf = this.city.districts.get(b.districtId)?.name ?? "the city";
          this.chronicle(`Gang conflict began: the ${a.name} are moving in on ${b.name} turf in ${turf}.`, 0.9);
        }
        if (!this.rng.chance(0.4)) continue;
        const [att, def] = this.rng.chance(0.5) ? [a, b] : [b, a];
        const attacker = this.pickFree(att);
        const target = this.pickFree(def);
        if (!attacker || !target) continue;
        // Only stage the clash where nobody's watching it teleport: at least one side is off-screen.
        if (attacker.lod !== "abstract" && target.lod !== "abstract" && dist(attacker.pos, target.pos) > 200) continue;
        attacker.pos = { x: target.pos.x + 6, y: target.pos.y + 4 };
        this.assault(attacker, target, "a gang fight");
        adjustTrust(target, attacker, -40, this.clock.totalMinutes, "enemy");
        const where = this.city.districtAt(target.pos.x, target.pos.y)?.name ?? "the outskirts";
        this.chronicle(`${att.name} member ${attacker.name} attacked ${target.name} of the ${def.name} in ${where}.`, 0.7);
      }
    }
  }

  private pickFree(gang: Gang): NPC | undefined {
    const free = gang.memberIds.map((id) => this.npcs.get(id)!).filter((n) => n && n.status === "free");
    return free.length ? this.rng.pick(free) : undefined;
  }

  private chronicle(text: string, importance: number): void {
    this.bus.emit("chronicle.entry", { day: this.clock.now().dayOfMonth, text, importance });
  }
}
