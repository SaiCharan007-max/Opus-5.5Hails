import type { SimClock } from "../core/Clock";
import type { EventBus } from "../core/EventBus";
import type { SeededRandom } from "../core/Random";
import type { Building, City } from "../world/City";
import type { NPC } from "../npc/NPC";
import type { Economy } from "../economy/Economy";
import type { EmergencySystem } from "../emergency/EmergencySystem";

/** Hourly fire odds by building kind. */
const FIRE_RISK: Partial<Record<Building["kind"], number>> = {
  restaurant: 0.00009,
  warehouse: 0.00007,
  home_apartment: 0.00002,
  home_house: 0.000015,
  shop: 0.00002,
  office: 0.00001,
};

const FIRE_CAUSE: Partial<Record<Building["kind"], string[]>> = {
  restaurant: ["A kitchen grease fire", "A gas leak"],
  warehouse: ["An electrical fault", "A forklift battery fire"],
  home_apartment: ["A cooking accident", "A faulty space heater"],
  home_house: ["Faulty wiring", "An unattended candle"],
  shop: ["An electrical fault"],
  office: ["A server room fault"],
};

export interface Festival {
  parkId: string;
  day: number;
}

/**
 * Hazards with causes: fire odds rise when a struggling business neglects
 * upkeep; collapses follow from hunger, exhaustion, injury or age. Also runs
 * reconstruction and schedules weekend festivals.
 */
export class Hazards {
  festival?: Festival;

  constructor(
    private city: City,
    private npcs: Map<string, NPC>,
    private economy: Economy,
    private emergency: EmergencySystem,
    private bus: EventBus,
    private clock: SimClock,
    private rng: SeededRandom,
  ) {}

  hourly(): void {
    for (const b of this.city.buildings.values()) {
      const risk = FIRE_RISK[b.kind];
      if (!risk || b.ruined || b.onFire !== undefined) continue;
      const biz = this.economy.businessAt(b.id);
      const neglect = biz && biz.cash < 0 ? 2.5 : 1;
      if (this.rng.chance(risk * neglect)) {
        this.emergency.startFire(b, this.rng.pick(FIRE_CAUSE[b.kind] ?? ["A fire"]));
      }
    }
    for (const npc of this.npcs.values()) {
      if (npc.status !== "free" || !npc.alive) continue;
      if (npc.health < 15) this.emergency.collapse(npc, npc.needs.hunger <= 0 ? "malnutrition" : "exhaustion");
      else if (npc.age > 65 && this.rng.chance(0.00025 * (npc.age - 60) / 5)) this.emergency.collapse(npc, "a heart attack");
      else if (this.rng.chance(0.00003)) this.emergency.collapse(npc, "a sudden illness");
    }
    this.emergency.checkUnattended();
  }

  daily(day: number, isWeekendTomorrow: boolean): void {
    for (const b of this.city.buildings.values()) {
      if (!b.ruined || b.ruinedSinceDay === undefined || day - b.ruinedSinceDay < 5) continue;
      b.ruined = false;
      b.ruinedSinceDay = undefined;
      b.residentCapacity = b.rebuildResidentCapacity ?? 0;
      if (b.kind === "shop" || b.kind === "restaurant" || b.kind === "office" || b.kind === "warehouse" || b.kind === "bank") b.vacant = true;
      this.bus.emit("chronicle.entry", { day, text: `Reconstruction finished at ${b.name}.`, importance: 0.4 });
    }
    if (isWeekendTomorrow && this.rng.chance(0.45)) {
      const parks = this.city.buildingsOfKind("park");
      if (parks.length) {
        const park = this.rng.pick(parks);
        this.festival = { parkId: park.id, day: day + 1 };
        this.bus.emit("chronicle.entry", { day: day + 1, text: `A weekend street festival is drawing crowds to ${park.name}.`, importance: 0.45 });
      }
    } else if (this.festival && this.festival.day < day + 1) {
      this.festival = undefined;
    }
  }

  /** Where people go for fun today, if a festival is on. */
  festivalPark(): Building | undefined {
    if (!this.festival || this.festival.day !== this.clock.now().dayOfMonth) return undefined;
    return this.city.buildings.get(this.festival.parkId);
  }
}
