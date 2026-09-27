import type { CalendarDate } from "../core/Clock";
import type { EventBus } from "../core/EventBus";
import type { SeededRandom } from "../core/Random";
import { dist, nextId } from "../core/types";
import type { Building, City } from "../world/City";
import type { NPC } from "../npc/NPC";
import { buildSchedule, factionForOccupation, occupationForWorkplace, wageFor } from "../npc/NPCFactory";
import { addMemory } from "../social/Memory";

export type Sector = "retail" | "food" | "office" | "finance" | "logistics";

export interface DayRecord {
  day: number;
  revenue: number;
  costs: number;
  customers: number;
  cash: number;
  employees: number;
}

export interface Business {
  id: string;
  buildingId: string;
  name: string;
  sector: Sector;
  ownerId?: string;
  cash: number;
  /** Average ticket for retail/food. */
  price: number;
  foundedDay: number;
  revenueToday: number;
  costsToday: number;
  customersToday: number;
  daysNegative: number;
  lossStreak: number;
  lateMarks: Map<string, number>;
  lateDay: Map<string, number>;
  history: DayRecord[];
}

export interface CityStats {
  day: number;
  population: number;
  employed: number;
  unemployed: number;
  homeless: number;
  businesses: number;
  avgMoney: number;
  treasury: number;
  climate: number;
  crimes: number;
  arrests: number;
}

const COGS = 0.45; // share of retail/food ticket spent on goods imported from outside the city
const TAX_RATE = 0.1;
const CIVIC = new Set(["hospital", "police_station", "fire_station", "government", "school"]);
const DISTRICT_RENT: Record<string, number> = {
  downtown: 1.35,
  financial: 1.6,
  residential: 1,
  suburbs: 1.15,
  old_town: 0.9,
  entertainment: 1.1,
  industrial: 0.7,
  harbor: 0.75,
};

function sectorFor(kind: Building["kind"]): Sector | undefined {
  switch (kind) {
    case "shop":
      return "retail";
    case "restaurant":
      return "food";
    case "office":
      return "office";
    case "bank":
      return "finance";
    case "warehouse":
      return "logistics";
    default:
      return undefined;
  }
}

function leaseFor(b: Building, sector: Sector): number {
  const base = { retail: 35, food: 45, office: 60, finance: 90, logistics: 50 }[sector];
  return Math.round(base + b.floors * 3);
}

/**
 * City economy. Every dollar moves along an explicit path so the books can be
 * audited: customers → businesses → wages/lease/tax; residents → rent →
 * treasury → civic salaries. Money only enters the city through business
 * contracts (exports) and only leaves through imported goods (COGS), and both
 * are tracked in `external` so tests can verify conservation.
 */
export class Economy {
  businesses = new Map<string, Business>();
  byBuilding = new Map<string, string>();
  treasury = 250_000;
  /** Economic climate multiplier on contract revenue: <0.85 recession, >1.15 boom. */
  climate = 1;
  /** Flows across the city boundary; debtForgiven is negative business cash erased at bankruptcy. */
  external = { exports: 0, imports: 0, debtForgiven: 0 };
  statsHistory: CityStats[] = [];
  /** City-set rent level; the council cuts rents when the treasury is flush and raises them when it's short. */
  rentLevel = 1;
  crimesToday = 0;
  arrestsToday = 0;

  constructor(
    private city: City,
    private npcs: Map<string, NPC>,
    private bus: EventBus,
    private rng: SeededRandom,
  ) {}

  /** Money held outside the ledgers above (gang funds), supplied by the simulation. */
  extraHoldings: () => number = () => 0;

  /**
   * Creates businesses for staffed commercial lots. Consumer-facing sectors are
   * trimmed to what the population can support (about one shop per 14
   * residents), so the city doesn't open with a wave of bankruptcies; staff
   * of trimmed lots move to other workplaces with openings.
   */
  init(day: number): void {
    const pop = this.npcs.size;
    const target: Partial<Record<Sector, number>> = { retail: Math.ceil(pop / 14), food: Math.ceil(pop / 16) };
    const staffed = Array.from(this.city.buildings.values()).filter((b) => sectorFor(b.kind) && !b.vacant);
    const displaced: NPC[] = [];
    for (const sector of ["retail", "food"] as Sector[]) {
      const lots = staffed.filter((b) => sectorFor(b.kind) === sector).sort((a, b) => b.employeeIds.length - a.employeeIds.length);
      for (const b of lots.slice(target[sector]!)) {
        for (const id of b.employeeIds) displaced.push(this.npcs.get(id)!);
        b.employeeIds = [];
      }
    }
    for (const b of staffed) {
      const sector = sectorFor(b.kind)!;
      if (b.employeeIds.length === 0) {
        this.makeVacant(b);
        continue;
      }
      const owner = this.npcs.get(this.rng.pick(b.employeeIds));
      const biz = this.createBusiness(b, sector, day, owner);
      biz.cash = this.dailyPayroll(biz) * 10 + leaseFor(b, sector) * 10 + 2500;
    }
    const openings = Array.from(this.city.buildings.values()).filter((b) => b.jobCapacity > b.employeeIds.length && b.kind !== "school" && !b.vacant);
    for (const npc of displaced) {
      const job = openings.find((b) => b.jobCapacity > b.employeeIds.length);
      npc.workplaceId = undefined;
      if (job) this.employ(npc, job, day, false, false);
      else {
        npc.occupation = "unemployed";
        npc.faction = factionForOccupation("unemployed");
        npc.wage = 0;
        npc.schedule = buildSchedule(this.rng, "unemployed");
      }
    }
  }

  private createBusiness(b: Building, sector: Sector, day: number, owner?: NPC): Business {
    const biz: Business = {
      id: nextId("biz"),
      buildingId: b.id,
      name: b.name,
      sector,
      ownerId: owner?.id,
      cash: 0,
      price: sector === "food" ? this.rng.int(12, 24) : sector === "retail" ? this.rng.int(18, 38) : 0,
      foundedDay: day,
      revenueToday: 0,
      costsToday: 0,
      customersToday: 0,
      daysNegative: 0,
      lossStreak: 0,
      lateMarks: new Map(),
      lateDay: new Map(),
      history: [],
    };
    this.businesses.set(biz.id, biz);
    this.byBuilding.set(b.id, biz.id);
    b.businessId = biz.id;
    if (owner) {
      owner.occupation = "business_owner";
      owner.faction = "business";
      owner.wage = 0; // owners live off profit draws, not a wage
    }
    return biz;
  }

  businessAt(buildingId: string): Business | undefined {
    const id = this.byBuilding.get(buildingId);
    return id ? this.businesses.get(id) : undefined;
  }

  /** A shop/restaurant can serve customers only during hours and with at least one staff member on shift. */
  isOpen(b: Building, hour: number): boolean {
    const biz = this.businessAt(b.id);
    if (!biz) return false;
    if (hour < b.openHour || hour >= b.closeHour) return false;
    return b.employeeIds.some((id) => {
      const e = this.npcs.get(id);
      return e && e.currentActivity === "working" && e.targetBuildingId === b.id;
    });
  }

  /** Cash an NPC won't dip below for discretionary spending. */
  reserveFor(npc: NPC): number {
    const home = this.city.buildings.get(npc.homeId);
    if (isDependent(npc)) return 20;
    // Homeless people save toward a deposit instead of eating out.
    return home ? this.rentFor(home) * 4 : 160;
  }

  rentFor(home: Building): number {
    const d = this.city.districts.get(home.districtId);
    const mult = d ? DISTRICT_RENT[d.kind] ?? 1 : 1;
    return Math.round((home.kind === "home_house" ? 58 : 38) * mult * this.rentLevel);
  }

  /** Customer visit. Returns false when the place is closed or the customer can't pay. */
  purchase(npc: NPC, b: Building, hour: number): boolean {
    const biz = this.businessAt(b.id);
    if (!biz || !this.isOpen(b, hour)) return false;
    // Wealthier customers buy more per visit.
    const ticket = Math.round(biz.price * this.rng.float(0.7, 1.3) * (1 + Math.min(1, npc.money / 6000) * 0.6));
    // Budgeting: keep enough back for about four days of rent before spending on a meal out or shopping.
    if (npc.money - ticket < this.reserveFor(npc)) return false;
    npc.money -= ticket;
    const cogs = ticket * COGS;
    biz.cash += ticket - cogs;
    biz.revenueToday += ticket;
    biz.costsToday += cogs;
    biz.customersToday += 1;
    this.external.imports += cogs;
    return true;
  }

  /** Cash stolen from a business register. Returns the amount actually taken. */
  steal(b: Building, amount: number): number {
    const biz = this.businessAt(b.id);
    if (!biz) return 0;
    const taken = Math.round(Math.max(0, Math.min(amount, biz.cash * 0.25)));
    biz.cash -= taken;
    biz.costsToday += taken;
    return taken;
  }

  private employer(npc: NPC): { biz?: Business; civic: boolean; building?: Building } {
    if (!npc.workplaceId) return { civic: false };
    const building = this.city.buildings.get(npc.workplaceId);
    if (!building) return { civic: false };
    return { biz: this.businessAt(building.id), civic: CIVIC.has(building.kind), building };
  }

  private dailyPayroll(biz: Business): number {
    const b = this.city.buildings.get(biz.buildingId)!;
    let total = 0;
    for (const id of b.employeeIds) total += (this.npcs.get(id)?.wage ?? 0) * 8.5;
    return total;
  }

  /** Hourly: pay everyone on shift, book contract revenue, record lateness. */
  hourly(now: CalendarDate): void {
    for (const npc of this.npcs.values()) {
      if (!npc.alive || !npc.workplaceId || npc.status !== "free") continue;
      const { biz, civic, building } = this.employer(npc);
      if (!building) continue;
      if (npc.currentActivity === "working" || npc.currentActivity === "patrolling") {
        if (civic) {
          this.treasury -= npc.wage;
          npc.money += npc.wage;
        } else if (biz) {
          biz.cash -= npc.wage;
          biz.costsToday += npc.wage;
          npc.money += npc.wage;
          if (biz.sector === "office" || biz.sector === "finance" || biz.sector === "logistics") {
            const productivity = 1.15 + npc.skills.work * 0.55;
            const earned = (npc.wage || 30) * productivity * this.climate;
            biz.cash += earned;
            biz.revenueToday += earned;
            this.external.exports += earned;
          }
        }
      } else if (biz && npc.currentActivity === "commuting" && npc.currentGoal === "working") {
        // Should be at work but still on the road: the employer notices.
        if (biz.lateDay.get(npc.id) !== now.dayOfMonth) {
          biz.lateMarks.set(npc.id, (biz.lateMarks.get(npc.id) ?? 0) + 1);
          biz.lateDay.set(npc.id, now.dayOfMonth);
        }
      }
    }
  }

  /** Midnight: rent, leases, taxes, books, then hiring/firing/closures/openings. */
  daily(now: CalendarDate): void {
    const day = now.dayOfMonth;
    this.collectRent(day);

    for (const biz of Array.from(this.businesses.values())) {
      const b = this.city.buildings.get(biz.buildingId)!;
      const lease = leaseFor(b, biz.sector);
      const tax = biz.revenueToday * TAX_RATE;
      biz.cash -= lease + tax;
      biz.costsToday += lease + tax;
      this.treasury += lease + tax;
      const profit = biz.revenueToday - biz.costsToday;
      biz.history.push({ day, revenue: biz.revenueToday, costs: biz.costsToday, customers: biz.customersToday, cash: biz.cash, employees: b.employeeIds.length });
      if (biz.history.length > 21) biz.history.shift();
      biz.daysNegative = biz.cash < 0 ? biz.daysNegative + 1 : 0;
      biz.lossStreak = profit < 0 ? biz.lossStreak + 1 : 0;
      this.adjustPrice(biz, b);

      this.ownerDraw(biz, profit);
      if (biz.daysNegative >= 5) {
        this.closeBusiness(biz, "went bankrupt", day);
        continue;
      }
      this.disciplineLateness(biz, b, day);
      if (biz.lossStreak >= 3 && b.employeeIds.length > 1 && biz.cash < this.dailyPayroll(biz) * 4) {
        this.layOffOne(biz, b, day);
      }
      biz.revenueToday = 0;
      biz.costsToday = 0;
      biz.customersToday = 0;
    }

    for (const npc of this.npcs.values()) {
      if (!npc.workplaceId && npc.occupation !== "student" && npc.alive) npc.daysUnemployed++;
    }
    this.payBenefits();
    this.hire(day);
    this.openBusinesses(day);
    this.rehouse(day);
    this.driftClimate(day);
    this.setRentPolicy(day);
    this.recordStats(day);
  }

  /** Owners take half of a profitable day, plus a slice of any large cash pile. */
  private ownerDraw(biz: Business, profit: number): void {
    const owner = biz.ownerId ? this.npcs.get(biz.ownerId) : undefined;
    if (!owner || !owner.alive) return;
    // A modest owner's salary whenever the business has a cushion, plus half of any profit.
    const b = this.city.buildings.get(biz.buildingId)!;
    const salary = biz.cash > leaseFor(b, biz.sector) * 14 ? 90 : 0;
    let draw = salary + (profit > salary ? (profit - salary) * 0.5 : 0);
    if (biz.cash > 25_000) draw += (biz.cash - 25_000) * 0.2;
    draw = Math.round(Math.min(draw, Math.max(0, biz.cash)));
    biz.cash -= draw;
    owner.money += draw;
  }

  /** Unemployment benefit from the treasury for up to three weeks; career criminals don't claim. */
  private payBenefits(): void {
    for (const npc of this.npcs.values()) {
      if (!npc.alive || npc.workplaceId || npc.occupation === "student" || npc.occupation === "criminal") continue;
      if (npc.age < 18 || npc.age >= 68 || npc.daysUnemployed > 21) continue;
      npc.money += 40;
      this.treasury -= 40;
    }
  }

  private collectRent(day: number): void {
    for (const npc of this.npcs.values()) {
      if (!npc.alive || npc.homeless || isDependent(npc)) continue;
      const home = this.city.buildings.get(npc.homeId);
      if (!home) continue;
      // Partners split rent; only one of a couple pays.
      if (npc.partnerId && npc.partnerId < npc.id && this.npcs.get(npc.partnerId)?.homeId === npc.homeId) continue;
      const rent = this.rentFor(home);
      if (npc.money >= rent) {
        npc.money -= rent;
        this.treasury += rent;
        npc.missedRent = 0;
      } else {
        npc.missedRent++;
        if (npc.missedRent >= 3) this.evict(npc, home, day);
      }
    }
  }

  private evict(npc: NPC, home: Building, day: number): void {
    home.residentIds = home.residentIds.filter((id) => id !== npc.id);
    npc.homeless = true;
    npc.homeId = "";
    npc.missedRent = 0;
    addMemory(npc, { kind: "life_event", note: `Evicted from ${home.name} after missing rent`, valence: -0.9, importance: 0.95, at: day * 1440 });
    this.bus.emit("npc.evicted", { npcId: npc.id });
    this.bus.emit("chronicle.entry", { day, text: `${npc.name} was evicted from ${home.name} after falling behind on rent.`, importance: 0.6 });
  }

  private rehouse(day: number): void {
    const homes = Array.from(this.city.buildings.values()).filter((b) => b.residentCapacity > b.residentIds.length);
    if (homes.length === 0) return;
    for (const npc of this.npcs.values()) {
      if (!npc.homeless || !npc.alive || npc.status !== "free") continue;
      const affordable = homes
        .filter((h) => h.residentCapacity > h.residentIds.length && npc.money >= this.rentFor(h) * 3)
        .sort((a, b) => this.rentFor(a) - this.rentFor(b));
      const home = affordable[0];
      if (!home) continue;
      home.residentIds.push(npc.id);
      npc.homeId = home.id;
      npc.homeless = false;
      addMemory(npc, { kind: "life_event", note: `Moved into ${home.name}`, valence: 0.7, importance: 0.7, at: day * 1440 });
      this.bus.emit("npc.moved_home", { npcId: npc.id, newHomeId: home.id });
      this.bus.emit("chronicle.entry", { day, text: `${npc.name} found a new home at ${home.name}.`, importance: 0.35 });
    }
  }

  private adjustPrice(biz: Business, b: Building): void {
    if (biz.sector !== "retail" && biz.sector !== "food") return;
    const staff = Math.max(1, b.employeeIds.length);
    if (biz.customersToday > staff * 14) biz.price = Math.min(biz.price * 1.04, 60);
    else if (biz.customersToday < staff * 5) biz.price = Math.max(biz.price * 0.97, 8);
  }

  private disciplineLateness(biz: Business, b: Building, day: number): void {
    for (const id of b.employeeIds) {
      if (id === biz.ownerId) continue;
      const marks = biz.lateMarks.get(id) ?? 0;
      if (marks >= 4) {
        const npc = this.npcs.get(id);
        if (!npc) continue;
        biz.lateMarks.set(id, 0);
        this.unemploy(npc, `fired from ${biz.name} for repeated lateness`, day);
        this.bus.emit("npc.fired", { npcId: npc.id, businessId: biz.id });
        this.bus.emit("chronicle.entry", { day, text: `${npc.name} was fired from ${biz.name} for showing up late too often.`, importance: 0.45 });
      }
    }
  }

  private layOffOne(biz: Business, b: Building, day: number): void {
    const candidates = b.employeeIds.map((id) => this.npcs.get(id)!).filter((n) => n && n.id !== biz.ownerId);
    if (candidates.length === 0) return;
    candidates.sort((a, c) => a.skills.work - c.skills.work);
    const npc = candidates[0];
    this.unemploy(npc, `laid off by ${biz.name}`, day);
    this.bus.emit("npc.fired", { npcId: npc.id, businessId: biz.id });
    this.bus.emit("chronicle.entry", { day, text: `${biz.name} is losing money and laid off ${npc.name}.`, importance: 0.45 });
  }

  closeBusiness(biz: Business, reason: string, day: number): void {
    const b = this.city.buildings.get(biz.buildingId)!;
    const staff = b.employeeIds.slice();
    for (const id of staff) {
      const npc = this.npcs.get(id);
      if (npc) this.unemploy(npc, `lost their job when ${biz.name} closed`, day);
    }
    // Remaining cash (or debt) goes to the owner, who takes the loss.
    const owner = biz.ownerId ? this.npcs.get(biz.ownerId) : undefined;
    if (owner && biz.cash > 0) owner.money += biz.cash;
    else if (biz.cash < 0) this.external.debtForgiven += -biz.cash;
    this.businesses.delete(biz.id);
    this.byBuilding.delete(b.id);
    this.makeVacant(b);
    this.bus.emit("business.closed", { businessId: biz.id, reason });
    if (reason !== "burned down") this.bus.emit("chronicle.entry", {
      day,
      text: `${biz.name} ${reason} and closed its doors${staff.length ? `, putting ${staff.length} ${staff.length === 1 ? "person" : "people"} out of work` : ""}.`,
      importance: 0.8,
    });
  }

  private makeVacant(b: Building): void {
    b.vacant = true;
    b.jobCapacity = 0;
    b.businessId = undefined;
  }

  unemploy(npc: NPC, why: string, day: number): void {
    const b = npc.workplaceId ? this.city.buildings.get(npc.workplaceId) : undefined;
    if (b) b.employeeIds = b.employeeIds.filter((id) => id !== npc.id);
    npc.workplaceId = undefined;
    npc.wage = 0;
    npc.daysUnemployed = 0;
    npc.occupation = "unemployed";
    npc.faction = factionForOccupation("unemployed");
    npc.schedule = buildSchedule(this.rng, "unemployed");
    addMemory(npc, { kind: "fired", note: `Got ${why}`, valence: -0.8, importance: 0.9, at: day * 1440 });
  }

  employ(npc: NPC, b: Building, day: number, asOwner = false, remember = true): void {
    if (npc.workplaceId) this.city.buildings.get(npc.workplaceId)!.employeeIds = this.city.buildings.get(npc.workplaceId)!.employeeIds.filter((id) => id !== npc.id);
    b.employeeIds.push(npc.id);
    npc.workplaceId = b.id;
    npc.occupation = asOwner ? "business_owner" : occupationForWorkplace(b.kind);
    npc.faction = factionForOccupation(npc.occupation);
    npc.wage = asOwner ? 0 : wageFor(npc.occupation, this.rng);
    npc.daysUnemployed = 0;
    npc.schedule = buildSchedule(this.rng, npc.occupation, b.id);
    if (remember) addMemory(npc, { kind: "hired", note: asOwner ? `Opened ${b.name}` : `Started a new job at ${b.name}`, valence: 0.8, importance: 0.8, at: day * 1440 });
  }

  private jobSeekers(): NPC[] {
    return Array.from(this.npcs.values()).filter(
      (n) => n.alive && n.status === "free" && !n.workplaceId && n.occupation !== "student" && n.age >= 18 && n.age < 68,
    );
  }

  /** Employers with room and healthy books hire the most employable seeker (skill, clean record). */
  private hire(day: number): void {
    const seekers = this.jobSeekers();
    if (seekers.length === 0) return;
    const score = (n: NPC) => n.skills.work + n.skills.charisma * 0.3 - n.criminalRecord * 0.35 - (n.homeless ? 0.2 : 0) + (n.occupation === "criminal" ? -0.3 : 0);
    seekers.sort((a, b) => score(b) - score(a));

    const openings: Building[] = [];
    for (const b of this.city.buildings.values()) {
      if (b.jobCapacity <= b.employeeIds.length) continue;
      if (CIVIC.has(b.kind)) {
        if (this.treasury > 40_000 && b.kind !== "school") openings.push(b);
        continue;
      }
      const biz = this.businessAt(b.id);
      if (!biz) continue;
      const last = biz.history[biz.history.length - 1];
      const busy = biz.sector === "retail" || biz.sector === "food" ? (last?.customers ?? 0) > b.employeeIds.length * 10 : this.climate > 0.95;
      if (busy && biz.cash > this.dailyPayroll(biz) * 6 + 1500) openings.push(b);
    }
    for (const b of this.rng.shuffle(openings)) {
      const pick = seekers.find((s) => s.criminalRecord < 3 || this.rng.chance(0.15));
      if (!pick) break;
      seekers.splice(seekers.indexOf(pick), 1);
      const wasCriminal = pick.occupation === "criminal";
      this.employ(pick, b, day);
      this.bus.emit("npc.hired", { npcId: pick.id, businessId: b.businessId ?? b.id });
      if (wasCriminal) {
        this.bus.emit("chronicle.entry", { day, text: `${pick.name}, known to police, went straight and took a job at ${b.name}.`, importance: 0.5 });
      }
    }
  }

  /** People living or working within reach of a lot, per existing competitor of a sector there. */
  private demandAt(b: Building, sector: Sector): number {
    const R = 260;
    let people = 0;
    for (const n of this.npcs.values()) {
      if (!n.alive) continue;
      const home = this.city.buildings.get(n.homeId);
      const work = n.workplaceId ? this.city.buildings.get(n.workplaceId) : undefined;
      if ((home && dist(home, b) < R) || (work && dist(work, b) < R)) people++;
    }
    let competitors = 0;
    for (const biz of this.businesses.values()) {
      if (biz.sector !== sector) continue;
      const other = this.city.buildings.get(biz.buildingId)!;
      if (dist(other, b) < R) competitors++;
    }
    return people / (1 + competitors);
  }

  /**
   * Entrepreneurs with savings open a business only where there's unmet
   * demand. Small storefronts become whichever of shop or restaurant the
   * neighborhood lacks most.
   */
  private openBusinesses(day: number): void {
    const vacant = Array.from(this.city.buildings.values()).filter((b) => b.vacant && !b.ruined && sectorFor(b.kind));
    if (vacant.length === 0) return;
    const candidates = Array.from(this.npcs.values()).filter(
      (n) => n.alive && n.status === "free" && n.money > 4500 && n.personality.riskTolerance > 0.4 && n.occupation !== "business_owner" && n.occupation !== "criminal" && n.age >= 21,
    );
    let opened = 0;
    for (const npc of this.rng.shuffle(candidates)) {
      if (opened >= 2) return;
      if (!this.rng.chance(0.15 * this.climate)) continue;
      let best: { b: Building; sector: Sector; score: number } | undefined;
      for (const b of vacant) {
        if (!b.vacant) continue;
        const options: Sector[] = b.kind === "shop" || b.kind === "restaurant" ? ["retail", "food"] : [sectorFor(b.kind)!];
        for (const sector of options) {
          const threshold = sector === "retail" ? 22 : sector === "food" ? 20 : 30;
          const demand = this.demandAt(b, sector) * (sector === "office" || sector === "finance" || sector === "logistics" ? this.climate : 1);
          const score = demand / threshold - dist(b, npc.pos) / 2000;
          if (demand >= threshold && (!best || score > best.score)) best = { b, sector, score };
        }
      }
      if (!best) continue;
      const { b, sector } = best;
      b.kind = sector === "retail" ? "shop" : sector === "food" ? "restaurant" : b.kind;
      b.name = sector === "retail" ? `${surname(npc)}'s ${this.rng.pick(["Market", "Goods", "Corner Shop", "Hardware"])}` : sector === "food" ? `${surname(npc)}'s ${this.rng.pick(["Diner", "Kitchen", "Cafe", "Grill"])}` : `${surname(npc)} & Co`;
      b.vacant = false;
      b.openHour = sector === "food" ? 7 : sector === "retail" ? 8 : 9;
      b.closeHour = sector === "food" ? 23 : sector === "retail" ? 21 : 18;
      b.jobCapacity = Math.min(sector === "office" ? 8 : 4, Math.max(2, Math.round((b.w * b.h * Math.max(1, b.floors)) / 900)));
      const investment = Math.round(npc.money * 0.6);
      npc.money -= investment;
      const biz = this.createBusiness(b, sector, day);
      biz.cash = investment;
      biz.ownerId = npc.id;
      this.employ(npc, b, day, true);
      opened++;
      this.bus.emit("business.opened", { businessId: biz.id });
      this.bus.emit("chronicle.entry", { day, text: `${npc.name} invested $${investment.toLocaleString()} and opened ${b.name}.`, importance: 0.65 });
    }
  }

  private setRentPolicy(day: number): void {
    const homeless = Array.from(this.npcs.values()).filter((n) => n.alive && n.homeless).length;
    if (day % 7 !== 0) return;
    if (this.treasury > 450_000 && this.rentLevel > 0.6 && (homeless > 3 || this.treasury > 800_000)) {
      this.rentLevel = Math.round((this.rentLevel - 0.1) * 100) / 100;
      this.bus.emit("chronicle.entry", { day, text: `With the treasury at $${Math.round(this.treasury / 1000)}k${homeless ? ` and ${homeless} people homeless` : ""}, the city council cut rents by 10%.`, importance: 0.75 });
    } else if (this.treasury < 120_000 && this.rentLevel < 1.3) {
      this.rentLevel = Math.round((this.rentLevel + 0.1) * 100) / 100;
      this.bus.emit("chronicle.entry", { day, text: `Facing a budget shortfall, the city council raised rents by 10%.`, importance: 0.75 });
    }
  }

  private driftClimate(day: number): void {
    const before = this.climate;
    this.climate += this.rng.float(-0.045, 0.045) + (1 - this.climate) * 0.04;
    this.climate = Math.max(0.6, Math.min(1.4, this.climate));
    if (before >= 0.85 && this.climate < 0.85) {
      this.bus.emit("chronicle.entry", { day, text: `Economists warn of a recession as business contracts dry up.`, importance: 0.85 });
    } else if (before < 0.85 && this.climate >= 0.85) {
      this.bus.emit("chronicle.entry", { day, text: `The recession is easing; firms report new contracts.`, importance: 0.75 });
    } else if (before <= 1.15 && this.climate > 1.15) {
      this.bus.emit("chronicle.entry", { day, text: `The city economy is booming.`, importance: 0.7 });
    }
  }

  private recordStats(day: number): void {
    let employed = 0;
    let unemployed = 0;
    let homeless = 0;
    let money = 0;
    let pop = 0;
    for (const n of this.npcs.values()) {
      if (!n.alive) continue;
      pop++;
      money += n.money;
      if (n.homeless) homeless++;
      if (n.workplaceId && n.occupation !== "student") employed++;
      else if (n.occupation !== "student" && n.age >= 18 && n.age < 68) unemployed++;
    }
    const prev = this.statsHistory[this.statsHistory.length - 1];
    const stats: CityStats = {
      day,
      population: pop,
      employed,
      unemployed,
      homeless,
      businesses: this.businesses.size,
      avgMoney: pop ? money / pop : 0,
      treasury: this.treasury,
      climate: this.climate,
      crimes: this.crimesToday,
      arrests: this.arrestsToday,
    };
    this.statsHistory.push(stats);
    this.crimesToday = 0;
    this.arrestsToday = 0;
    if (prev) {
      const rateNow = unemployed / Math.max(1, employed + unemployed);
      const ratePrev = prev.unemployed / Math.max(1, prev.employed + prev.unemployed);
      if (rateNow - ratePrev > 0.03) {
        this.bus.emit("chronicle.entry", { day, text: `Unemployment rose to ${(rateNow * 100).toFixed(0)}%.`, importance: 0.65 });
      } else if (ratePrev - rateNow > 0.03) {
        this.bus.emit("chronicle.entry", { day, text: `Unemployment fell to ${(rateNow * 100).toFixed(0)}%.`, importance: 0.55 });
      }
    }
  }

  /** Total money inside the city (people, businesses, treasury) — for conservation checks. */
  moneyInCity(): number {
    let total = this.treasury + this.extraHoldings();
    for (const n of this.npcs.values()) total += n.money;
    for (const b of this.businesses.values()) total += b.cash;
    return total;
  }
}

function surname(npc: NPC): string {
  return npc.name.split(" ").slice(1).join(" ") || npc.name;
}

/** Students and minors live with family and don't pay rent. */
function isDependent(npc: NPC): boolean {
  return npc.occupation === "student" || npc.age < 19;
}
