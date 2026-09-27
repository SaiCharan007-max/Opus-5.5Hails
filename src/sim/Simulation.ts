import { SimClock } from "../core/Clock";
import { EventBus } from "../core/EventBus";
import { SeededRandom } from "../core/Random";
import { resetIdCounter, type Vec2 } from "../core/types";
import { City } from "../world/City";
import { generateCity } from "../world/WorldGen";
import { NPCSystem } from "../npc/NPCSystem";
import { populateCity } from "../npc/NPCFactory";

export interface SimulationConfig {
  seed: number;
  npcCount: number;
}

/**
 * Top-level orchestrator. Owns the clock, the city, and every subsystem,
 * and drives them in a fixed order each tick. Rendering reads from this
 * but never mutates simulation state — keeps sim/render cleanly separated
 * per spec section 28.
 */
export class Simulation {
  clock = new SimClock(7);
  bus = new EventBus();
  city: City;
  rng: SeededRandom;
  npcSystem: NPCSystem;

  private accumulatorSeconds = 0;
  private readonly tickSeconds = 0.1; // 10 Hz fixed sim tick

  constructor(config: SimulationConfig) {
    // Global id counter reset here so that two Simulations built from the
    // same seed produce byte-identical entity ids — required for
    // deterministic replay and for save/load round-trips (spec section 23).
    // Only one Simulation should be "live" at a time per process under this
    // scheme; a documented tradeoff, see DECISIONS.md.
    resetIdCounter();
    this.rng = new SeededRandom(config.seed);
    this.city = generateCity(config.seed);
    this.bus = new EventBus();
    this.npcSystem = new NPCSystem(this.city, this.bus, this.rng.fork());
    const npcs = populateCity(this.city, this.rng.fork(), config.npcCount);
    this.npcSystem.addAll(npcs);
  }

  /** Advance the whole simulation by realDeltaSeconds of wall-clock time. */
  step(realDeltaSeconds: number, focusPos: Vec2): void {
    if (this.clock.paused) return;
    this.accumulatorSeconds += realDeltaSeconds;
    // Fixed-timestep sim ticks decoupled from render framerate, scaled by clock.timeScale.
    while (this.accumulatorSeconds >= this.tickSeconds) {
      this.accumulatorSeconds -= this.tickSeconds;
      const dtSimMinutes = this.tickSeconds * this.clock.timeScale;
      this.clock.advance(this.tickSeconds);
      const now = this.clock.now();
      this.npcSystem.update(this.clock.totalMinutes, now, dtSimMinutes, focusPos);
    }
  }
}
