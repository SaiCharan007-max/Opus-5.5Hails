import { SimClock } from "../core/Clock";
import { EventBus } from "../core/EventBus";
import { SeededRandom } from "../core/Random";
import { resetIdCounter, type Vec2 } from "../core/types";
import { City } from "../world/City";
import { generateCity } from "../world/WorldGen";
import { NPCSystem } from "../npc/NPCSystem";
import { assignVehicles, populateCity } from "../npc/NPCFactory";
import { VehicleSystem } from "../traffic/VehicleSystem";
import { Economy } from "../economy/Economy";
import { EmergencySystem } from "../emergency/EmergencySystem";
import { CrimeSystem } from "../police/CrimeSystem";
import { SocialSystem } from "../social/SocialSystem";
import { Hazards } from "../events/Hazards";
import { Chronicle } from "../events/Chronicle";

export interface SimulationConfig {
  seed: number;
  npcCount: number;
}

const SOCIAL_EVERY_MIN = 15;

/**
 * Top-level orchestrator. Owns the clock and every subsystem, and drives them
 * in a fixed order on a fixed 10 Hz tick, plus hourly and midnight passes.
 * Rendering reads from this but never mutates it.
 */
export class Simulation {
  clock = new SimClock(7);
  bus = new EventBus();
  city: City;
  rng: SeededRandom;
  npcSystem: NPCSystem;
  vehicleSystem: VehicleSystem;
  economy: Economy;
  emergency: EmergencySystem;
  crime: CrimeSystem;
  social: SocialSystem;
  hazards: Hazards;
  chronicle: Chronicle;
  ticks = 0;

  private accumulatorSeconds = 0;
  private readonly tickSeconds = 0.1;
  private lastHour: number;
  private lastDay: number;
  private socialTimer = 0;

  constructor(config: SimulationConfig) {
    // Reset so two Simulations from the same seed get identical entity ids (determinism, save/load).
    resetIdCounter();
    this.rng = new SeededRandom(config.seed);
    this.city = generateCity(config.seed);
    this.chronicle = new Chronicle(this.bus, this.clock);
    this.vehicleSystem = new VehicleSystem(this.city);
    this.npcSystem = new NPCSystem(this.city, this.bus, this.rng.fork(), this.vehicleSystem);
    const npcs = populateCity(this.city, this.rng.fork(), config.npcCount);
    this.npcSystem.addAll(npcs);
    assignVehicles(npcs, this.city, this.rng.fork(), (id, ownerId, home) => this.vehicleSystem.spawnParked(id, "sedan", ownerId, home));

    this.economy = new Economy(this.city, this.npcSystem.npcs, this.bus, this.rng.fork());
    this.emergency = new EmergencySystem(this.city, this.npcSystem, this.vehicleSystem, this.economy, this.bus, this.clock, this.rng.fork());
    this.crime = new CrimeSystem(this.city, this.npcSystem, this.economy, this.emergency, this.vehicleSystem, this.bus, this.clock, this.rng.fork());
    this.social = new SocialSystem(this.city, this.npcSystem.npcs, this.bus, this.clock, this.rng.fork(), {
      assault: (a, v, reason) => this.crime.assault(a, v, reason),
    });
    this.hazards = new Hazards(this.city, this.npcSystem.npcs, this.economy, this.emergency, this.bus, this.clock, this.rng.fork());

    this.economy.extraHoldings = () => this.crime.heldCash();
    this.emergency.gangName = (id) => this.crime.gangs.get(id)?.name;
    this.emergency.isGangLeader = (npcId) => Array.from(this.crime.gangs.values()).some((g) => g.leaderId === npcId);

    const day = this.clock.now().dayOfMonth;
    this.economy.init(day);
    this.emergency.init();
    this.social.seedFamilies();

    this.npcSystem.hooks = {
      isOpen: (b, hour) => this.economy.isOpen(b, hour),
      onArrive: (npc, b, activity, hour) => {
        if (activity !== "eating" && activity !== "shopping" && activity !== "leisure" && activity !== "socializing") return true;
        return this.economy.purchase(npc, b, hour);
      },
      onCrimeIntent: (npc, target) => this.crime.onCrimeIntent(npc, target),
      leisureSpot: () => this.hazards.festivalPark(),
    };

    const now = this.clock.now();
    this.lastHour = now.hour;
    this.lastDay = now.dayOfMonth;
  }

  /** Advance by realDeltaSeconds of wall-clock time. */
  step(realDeltaSeconds: number, focusPos: Vec2): void {
    if (this.clock.paused) return;
    this.accumulatorSeconds += realDeltaSeconds;
    while (this.accumulatorSeconds >= this.tickSeconds) {
      this.accumulatorSeconds -= this.tickSeconds;
      this.tick(focusPos);
    }
  }

  /** One fixed simulation tick. Exposed for headless runs and tests. */
  tick(focusPos: Vec2): void {
    const dt = this.tickSeconds * this.clock.timeScale;
    this.clock.advance(this.tickSeconds);
    const now = this.clock.now();
    this.ticks++;

    this.npcSystem.update(this.clock.totalMinutes, now, dt, focusPos);
    this.vehicleSystem.update(dt);
    this.emergency.update(dt);

    this.socialTimer += dt;
    if (this.socialTimer >= SOCIAL_EVERY_MIN) {
      this.socialTimer -= SOCIAL_EVERY_MIN;
      this.social.tick();
    }
    if (now.hour !== this.lastHour) {
      this.lastHour = now.hour;
      this.economy.hourly(now);
      this.hazards.hourly();
    }
    if (now.dayOfMonth !== this.lastDay) {
      this.lastDay = now.dayOfMonth;
      const day = now.dayOfMonth;
      this.economy.daily(now);
      this.crime.daily(day);
      this.social.daily(day);
      this.hazards.daily(day, (now.day + 1) % 7 >= 5);
    }
  }

  /** Runs the world with nobody watching (every NPC at abstract detail) — for long headless runs. */
  runHeadless(days: number, timeScale = 20): void {
    const far = { x: -100_000, y: -100_000 };
    this.clock.timeScale = timeScale;
    const targetDay = this.clock.now().dayOfMonth + days;
    while (this.clock.now().dayOfMonth < targetDay) this.tick(far);
  }
}
