import type { SimClock } from "../core/Clock";
import type { EventBus } from "../core/EventBus";
import type { SeededRandom } from "../core/Random";
import type { City } from "../world/City";
import type { NPC } from "../npc/NPC";
import { addMemory, adjustTrust, decayMemories } from "./Memory";

export interface SocialHooks {
  assault(attacker: NPC, victim: NPC, reason: string): void;
}

/**
 * Relationships come from being in the same place: coworkers on shift,
 * neighbors at home, strangers in a park. Each interaction's outcome depends
 * on both personalities, so the relationship graph is emergent rather than
 * assigned (family ties at world-gen are the only exception).
 */
export class SocialSystem {
  constructor(
    private city: City,
    private npcs: Map<string, NPC>,
    private bus: EventBus,
    private clock: SimClock,
    private rng: SeededRandom,
    private hooks: SocialHooks,
  ) {}

  /** World-gen: people sharing a house are family; some are couples. Apartment neighbors know each other. */
  seedFamilies(): void {
    const at = this.clock.totalMinutes;
    for (const b of this.city.buildings.values()) {
      const residents = b.residentIds.map((id) => this.npcs.get(id)!).filter(Boolean);
      if (residents.length < 2) continue;
      if (b.kind === "home_house") {
        for (let i = 0; i < residents.length; i++) {
          for (let j = i + 1; j < residents.length; j++) {
            const a = residents[i];
            const c = residents[j];
            const couple = !a.partnerId && !c.partnerId && a.age >= 20 && c.age >= 20 && Math.abs(a.age - c.age) <= 12;
            if (couple) {
              a.partnerId = c.id;
              c.partnerId = a.id;
              adjustTrust(a, c, 75, at, "romantic");
              adjustTrust(c, a, 75, at, "romantic");
            } else {
              adjustTrust(a, c, 55, at, "family");
              adjustTrust(c, a, 55, at, "family");
            }
          }
        }
      } else {
        for (let k = 0; k < Math.min(3, residents.length - 1); k++) {
          const a = this.rng.pick(residents);
          const c = this.rng.pick(residents);
          if (a === c) continue;
          adjustTrust(a, c, 10, at);
          adjustTrust(c, a, 10, at);
        }
      }
    }
  }

  /** Runs every ~15 sim minutes. */
  tick(): void {
    const at = this.clock.totalMinutes;
    const groups = new Map<string, NPC[]>();
    for (const n of this.npcs.values()) {
      if (n.status !== "free" || !n.alive || !n.targetBuildingId) continue;
      if (n.inVehicle || n.pathNodeIds.length > 0 || n.currentActivity === "sleeping") continue;
      const g = groups.get(n.targetBuildingId);
      if (g) g.push(n);
      else groups.set(n.targetBuildingId, [n]);
    }
    for (const [buildingId, people] of groups) {
      if (people.length < 2) continue;
      const pairs = Math.min(3, Math.floor(people.length / 2));
      for (let k = 0; k < pairs; k++) {
        const a = this.rng.pick(people);
        const b = this.rng.pick(people);
        if (a !== b) this.interact(a, b, buildingId, at);
      }
    }
  }

  private interact(a: NPC, b: NPC, buildingId: string, at: number): void {
    // People mostly steer clear of those they dislike.
    if ((a.relationships.get(b.id)?.trust ?? 0) < -30 && this.rng.chance(0.85)) return;
    const coworkers = a.workplaceId !== undefined && a.workplaceId === b.workplaceId && a.currentActivity === "working";
    const pa = a.personality;
    const pb = b.personality;
    const compatibility = 1 - Math.abs(pa.friendliness - pb.friendliness) * 0.5 + ((pa.sociability + pb.sociability) / 2) * 0.5 - ((pa.aggression + pb.aggression) / 2) * 0.45;
    const existing = a.relationships.get(b.id)?.trust ?? 0;
    const positive = this.rng.chance(Math.min(0.95, 0.5 + compatibility * 0.3 + existing / 400));
    const place = this.city.buildings.get(buildingId)?.name ?? "town";
    const type = coworkers ? "coworker" : undefined;

    if (positive) {
      const gain = this.rng.float(2, 7) * (0.6 + compatibility);
      const ra = adjustTrust(a, b, gain, at, type);
      adjustTrust(b, a, gain * this.rng.float(0.7, 1.2), at, type);
      a.needs.social = Math.min(100, a.needs.social + 6);
      b.needs.social = Math.min(100, b.needs.social + 6);
      if (ra.trust >= 40 && ra.trust - gain < 40) {
        addMemory(a, { kind: "met", note: `Became friends with ${b.name}`, valence: 0.7, importance: 0.6, at, aboutNpcId: b.id, locationId: buildingId });
        addMemory(b, { kind: "met", note: `Became friends with ${a.name}`, valence: 0.7, importance: 0.6, at, aboutNpcId: a.id, locationId: buildingId });
      }
      this.maybeHelp(a, b, at);
      this.maybeHelp(b, a, at);
      this.maybeRomance(a, b, at);
    } else {
      const loss = this.rng.float(3, 10) * (0.5 + (pa.aggression + pb.aggression) / 2);
      const ra = adjustTrust(a, b, -loss, at);
      adjustTrust(b, a, -loss * this.rng.float(0.6, 1.2), at);
      if (loss > 9) {
        addMemory(a, { kind: "argument", note: `Argued with ${b.name} at ${place}`, valence: -0.6, importance: 0.45, at, aboutNpcId: b.id, locationId: buildingId });
        addMemory(b, { kind: "argument", note: `Argued with ${a.name} at ${place}`, valence: -0.6, importance: 0.45, at, aboutNpcId: a.id, locationId: buildingId });
      }
      // Bad blood plus a short temper can turn physical.
      if (ra.trust <= -50 && pa.aggression > 0.75 && this.rng.chance(0.06)) {
        this.hooks.assault(a, b, `a fight with ${a.name}`);
      }
    }
  }

  /** Friends bail each other out: a real transfer, remembered by both. */
  private maybeHelp(giver: NPC, receiver: NPC, at: number): void {
    const r = giver.relationships.get(receiver.id);
    if (!r || r.trust < 40 || receiver.money > 40 || giver.money < 800) return;
    if (!this.rng.chance(giver.personality.friendliness * 0.6)) return;
    const gift = Math.round(Math.min(giver.money * 0.1, this.rng.int(60, 200)));
    giver.money -= gift;
    receiver.money += gift;
    adjustTrust(receiver, giver, 15, at);
    addMemory(receiver, { kind: "helped_by", note: `${giver.name} lent them $${gift} when they were broke`, valence: 0.9, importance: 0.8, at, aboutNpcId: giver.id });
    addMemory(giver, { kind: "helped", note: `Helped out ${receiver.name} with $${gift}`, valence: 0.5, importance: 0.5, at, aboutNpcId: receiver.id });
  }

  private maybeRomance(a: NPC, b: NPC, at: number): void {
    if (a.partnerId || b.partnerId || a.age < 20 || b.age < 20 || Math.abs(a.age - b.age) > 12) return;
    const ta = a.relationships.get(b.id)?.trust ?? 0;
    const tb = b.relationships.get(a.id)?.trust ?? 0;
    if (ta < 70 || tb < 70 || !this.rng.chance(0.03)) return;
    a.partnerId = b.id;
    b.partnerId = a.id;
    adjustTrust(a, b, 10, at, "romantic").since = at;
    adjustTrust(b, a, 10, at, "romantic").since = at;
    addMemory(a, { kind: "life_event", note: `Started dating ${b.name}`, valence: 0.9, importance: 0.85, at, aboutNpcId: b.id });
    addMemory(b, { kind: "life_event", note: `Started dating ${a.name}`, valence: 0.9, importance: 0.85, at, aboutNpcId: a.id });
    this.chronicle(`${a.name} and ${b.name} started dating.`, 0.35);
  }

  daily(day: number): void {
    const at = this.clock.totalMinutes;
    for (const npc of this.npcs.values()) {
      decayMemories(npc);
      for (const [id, r] of npc.relationships) {
        if (r.type === "family" || r.type === "romantic") continue;
        if (at - r.lastInteractionMinutes > 7 * 1440) r.trust *= 0.95;
        if (Math.abs(r.trust) < 2 && r.type !== "coworker") npc.relationships.delete(id);
      }
    }
    this.marriages(day, at);
  }

  /** Long-term couples marry and move in together when there's room. */
  private marriages(day: number, at: number): void {
    for (const a of this.npcs.values()) {
      if (!a.partnerId || a.id > a.partnerId || !a.alive) continue;
      const b = this.npcs.get(a.partnerId);
      if (!b || !b.alive) continue;
      const ta = a.relationships.get(b.id)?.trust ?? 0;
      const together = a.relationships.get(b.id)?.since ?? at;
      if (ta < 90 || a.homeId === b.homeId || a.homeless || at - together < 18 * 1440 || !this.rng.chance(0.04)) continue;
      const home = this.city.buildings.get(a.homeId);
      if (!home || home.residentIds.length >= home.residentCapacity) continue;
      const old = this.city.buildings.get(b.homeId);
      if (old) old.residentIds = old.residentIds.filter((id) => id !== b.id);
      home.residentIds.push(b.id);
      b.homeId = home.id;
      b.homeless = false;
      addMemory(a, { kind: "life_event", note: `Married ${b.name}`, valence: 1, importance: 1, at, aboutNpcId: b.id });
      addMemory(b, { kind: "life_event", note: `Married ${a.name} and moved into ${home.name}`, valence: 1, importance: 1, at, aboutNpcId: a.id });
      this.bus.emit("npc.moved_home", { npcId: b.id, newHomeId: home.id });
      this.chronicle(`${a.name} and ${b.name} got married and moved in together at ${home.name}.`, 0.6);
    }
  }

  private chronicle(text: string, importance: number): void {
    this.bus.emit("chronicle.entry", { day: this.clock.now().dayOfMonth, text, importance });
  }
}
