import type { CalendarDate } from "../core/Clock";
import type { EventBus } from "../core/EventBus";
import type { SeededRandom } from "../core/Random";
import { dist, type Vec2 } from "../core/types";
import type { Building, City } from "../world/City";
import type { VehicleSystem } from "../traffic/VehicleSystem";
import type { ActivityKind, LODTier, NPC } from "./NPC";
import { decideActivity, scheduleTargetBuilding } from "./UtilityAI";

const WALK_SPEED = 6; // world units per sim-minute
const RUN_SPEED = 11;
const DRIVE_DISTANCE_THRESHOLD = 180; // below this, NPCs walk even if they own a car
const NEED_DECAY = { hunger: 0.06, energy: 0.045, social: 0.03, fun: 0.025 };

const LOD_RADIUS = { high: 250, medium: 700, low: 1600 };
/** Minimum sim-minutes between updates per LOD tier; abstract uses coarse catch-up instead. */
const LOD_UPDATE_EVERY_MIN = { high: 0, medium: 2, low: 10 };

/** Callbacks into other systems, so NPC behavior stays decoupled from economy/crime code. */
export interface NPCHooks {
  isOpen(b: Building, hour: number): boolean;
  /** Called once when an NPC reaches the building for its goal. Return false if it couldn't be done there. */
  onArrive(npc: NPC, b: Building, activity: ActivityKind, hour: number): boolean;
  onCrimeIntent(npc: NPC, target: Building | undefined): void;
  /** A special place drawing crowds today (festival), if any. */
  leisureSpot(): Building | undefined;
}

export class NPCSystem {
  npcs: Map<string, NPC> = new Map();
  hooks?: NPCHooks;
  private byKind = new Map<Building["kind"], Building[]>();

  constructor(
    private city: City,
    private bus: EventBus,
    private rng: SeededRandom,
    private vehicleSystem?: VehicleSystem,
  ) {
    for (const b of city.buildings.values()) {
      const key = indexKey(b.kind);
      if (!this.byKind.has(key)) this.byKind.set(key, []);
      this.byKind.get(key)!.push(b);
    }
  }

  addAll(npcs: NPC[]): void {
    for (const n of npcs) this.npcs.set(n.id, n);
  }

  /** Called every sim tick. focusPos is the player/camera position, used for LOD. */
  update(nowMinutes: number, now: CalendarDate, dtMinutes: number, focusPos: Vec2): void {
    for (const npc of this.npcs.values()) {
      if (!npc.alive) continue;
      if (npc.status === "fleeing") {
        // Pursuit movement is steered by the police system; we just run the path.
        this.progressMovement(npc, dtMinutes, RUN_SPEED);
        npc.currentActivity = "fleeing";
        continue;
      }
      if (npc.status !== "free") continue;

      const tier = this.computeLOD(npc, focusPos);
      npc.lod = tier;
      if (tier === "abstract") {
        this.abstractCatchUp(npc, nowMinutes, now);
        continue;
      }
      const due = LOD_UPDATE_EVERY_MIN[tier];
      const elapsed = nowMinutes - npc.lastFullUpdateMinutes;
      if (due > 0 && elapsed < due) continue;
      this.fullUpdate(npc, now, nowMinutes, tier === "high" ? dtMinutes : Math.max(dtMinutes, elapsed));
    }
  }

  /** External systems (police pursuit, fleeing from a fire) can hand an NPC a walking route. */
  walkTo(npc: NPC, nodeId: string): void {
    const start = this.city.roads.nearestNode(npc.pos);
    if (!start) return;
    npc.pathNodeIds = this.city.roads.findPath(start.id, nodeId) ?? [];
    npc.pathIndex = 0;
    npc.inVehicle = false;
  }

  /** Forces a fresh decision next update (e.g. after release from jail or a fire). */
  resetGoal(npc: NPC): void {
    npc.currentGoal = "idle";
    npc.currentActivity = "idle";
    npc.pathNodeIds = [];
    npc.inVehicle = false;
    npc.targetBuildingId = undefined;
  }

  private computeLOD(npc: NPC, focusPos: Vec2): LODTier {
    const d = dist(npc.pos, focusPos);
    if (d <= LOD_RADIUS.high) return "high";
    if (d <= LOD_RADIUS.medium) return "medium";
    if (d <= LOD_RADIUS.low) return "low";
    return "abstract";
  }

  private decayNeeds(npc: NPC, dt: number): void {
    npc.needs.hunger = Math.max(0, npc.needs.hunger - NEED_DECAY.hunger * dt);
    npc.needs.energy = Math.max(0, npc.needs.energy - NEED_DECAY.energy * dt);
    npc.needs.social = Math.max(0, npc.needs.social - NEED_DECAY.social * dt);
    npc.needs.fun = Math.max(0, npc.needs.fun - NEED_DECAY.fun * dt);
    npc.needs.safety = Math.min(100, npc.needs.safety + 0.05 * dt);
    // Starvation and exhaustion wear down health; otherwise it slowly recovers.
    if (npc.needs.hunger <= 0 || npc.needs.energy <= 0) npc.health = Math.max(0, npc.health - 0.03 * dt);
    else npc.health = Math.min(100, npc.health + 0.004 * dt);
  }

  private fullUpdate(npc: NPC, now: CalendarDate, nowMinutes: number, dt: number): void {
    this.decayNeeds(npc, dt);
    npc.lastFullUpdateMinutes = nowMinutes;

    const desired = decideActivity(npc, now).activity;
    const traveling = npc.inVehicle || npc.pathNodeIds.length > 0;
    const target = npc.targetBuildingId ? this.city.buildings.get(npc.targetBuildingId) : undefined;
    // Re-plan only when the goal changes, or when stranded short of the target. Re-planning mid-trip
    // would restart the route from the last node passed and the NPC would never get anywhere.
    const stranded = !traveling && target !== undefined && dist(npc.pos, target) > 8;
    if (desired !== npc.currentGoal || stranded) this.beginActivity(npc, desired, now);

    const wasTraveling = npc.inVehicle || npc.pathNodeIds.length > 0;
    if (npc.inVehicle) this.syncFromVehicle(npc);
    else this.progressMovement(npc, dt, WALK_SPEED);
    const arrivedNow = wasTraveling && !npc.inVehicle && npc.pathNodeIds.length === 0;
    if (arrivedNow) this.arrive(npc, now);

    this.applyActivityEffects(npc, dt);
  }

  private beginActivity(npc: NPC, activity: ActivityKind, now: CalendarDate): void {
    npc.currentActivity = activity;
    npc.currentGoal = activity;

    const target = this.resolveTargetBuilding(npc, activity, now);
    const traveling = npc.inVehicle || npc.pathNodeIds.length > 0;
    if (traveling && target && target.id === npc.targetBuildingId) return; // same destination: keep going
    npc.targetBuildingId = target?.id;

    if (!target || dist(npc.pos, target) <= 8) {
      npc.pathNodeIds = [];
      npc.pathIndex = 0;
      npc.inVehicle = false;
      if (target) this.arrive(npc, now);
      return;
    }
    if (npc.vehicleId && this.vehicleSystem && dist(npc.pos, target) > DRIVE_DISTANCE_THRESHOLD) {
      if (this.vehicleSystem.requestTrip(npc.vehicleId, target)) {
        npc.inVehicle = true;
        npc.pathNodeIds = [];
        return;
      }
    }
    npc.inVehicle = false;
    this.requestPath(npc, target);
  }

  /** One-shot effects on reaching the goal's building: purchases, crimes. */
  private arrive(npc: NPC, now: CalendarDate): void {
    const b = npc.targetBuildingId ? this.city.buildings.get(npc.targetBuildingId) : undefined;
    if (!b) return;
    const goal = npc.currentGoal as ActivityKind;
    if (goal === "committing_crime") {
      this.hooks?.onCrimeIntent(npc, b);
      npc.currentActivity = "leisure";
      this.getaway(npc);
      return;
    }
    const commercial = b.kind === "shop" || b.kind === "restaurant";
    if (!commercial || !this.hooks) return;
    const ok = this.hooks.onArrive(npc, b, goal, now.hour);
    if (!ok) {
      // Closed, unstaffed, or can't afford it: go home instead (homeless: stay out).
      const home = this.city.buildings.get(npc.homeId);
      if (home && home.id !== b.id) {
        npc.targetBuildingId = home.id;
        if (npc.vehicleId && this.vehicleSystem && dist(npc.pos, home) > DRIVE_DISTANCE_THRESHOLD && this.vehicleSystem.requestTrip(npc.vehicleId, home)) {
          npc.inVehicle = true;
        } else {
          this.requestPath(npc, home);
        }
      }
    }
  }

  /** After a crime, leave the scene: home if there is one, otherwise the far side of town. */
  private getaway(npc: NPC): void {
    if (npc.status !== "free") return;
    const home = this.city.buildings.get(npc.homeId);
    const dest = home ?? this.nearestN(npc, "park", 5).pop();
    if (!dest) return;
    npc.targetBuildingId = dest.id;
    if (npc.lod === "abstract") {
      npc.pos = { x: dest.x, y: dest.y };
      return;
    }
    if (npc.vehicleId && this.vehicleSystem?.requestTrip(npc.vehicleId, dest)) npc.inVehicle = true;
    else this.requestPath(npc, dest);
  }

  private syncFromVehicle(npc: NPC): void {
    const vehicle = npc.vehicleId ? this.vehicleSystem?.vehicles.get(npc.vehicleId) : undefined;
    if (!vehicle) {
      npc.inVehicle = false;
      return;
    }
    npc.pos = { ...vehicle.pos };
    if (this.vehicleSystem!.hasArrived(vehicle.id)) {
      npc.inVehicle = false;
      // Car stays parked at the curb; the driver walks the last few meters inside.
      const target = npc.targetBuildingId ? this.city.buildings.get(npc.targetBuildingId) : undefined;
      if (target) npc.pos = { x: target.x, y: target.y };
    }
  }

  private resolveTargetBuilding(npc: NPC, activity: ActivityKind, now: CalendarDate): Building | undefined {
    const b = this.city.buildings;
    const home = b.get(npc.homeId);
    switch (activity) {
      case "sleeping":
        return home ?? this.nearest(npc, "park");
      case "eating": {
        const lunchAtWork = npc.workplaceId && now.hour >= 11 && now.hour < 15 && npc.money > 40;
        const dinnerOut = now.hour >= 18 && now.hour < 22 && npc.money > 250 && this.rng.chance(0.2 + npc.personality.sociability * 0.3);
        if (lunchAtWork || dinnerOut || !home) {
          const spot = this.pickVenue(npc, "restaurant", now.hour);
          if (spot) return spot;
        }
        return home ?? this.nearest(npc, "park");
      }
      case "working":
        return b.get(scheduleTargetBuilding(npc, now) ?? npc.workplaceId ?? "") ?? home;
      case "commuting":
        // Morning commute blocks carry the workplace; evening ones mean "head home".
        return b.get(scheduleTargetBuilding(npc, now) ?? npc.homeId) ?? this.nearest(npc, "park");
      case "shopping":
        return (npc.money > 30 ? this.pickVenue(npc, "shop", now.hour) : undefined) ?? home;
      case "socializing":
      case "leisure": {
        const festival = this.hooks?.leisureSpot();
        if (festival && now.hour >= 10 && now.hour < 22 && this.rng.chance(0.4 + npc.personality.sociability * 0.4)) return festival;
        if (npc.money > 200 && now.hour >= 17 && this.rng.chance(0.25)) {
          const spot = this.pickVenue(npc, "restaurant", now.hour);
          if (spot) return spot;
        }
        return this.rng.chance(0.55) || !home ? this.nearest(npc, "park") ?? home : home;
      }
      case "committing_crime":
        return this.rng.pick(this.nearestN(npc, "shop", 4)) ?? this.nearest(npc, "restaurant");
      case "patrolling":
        return b.get(npc.workplaceId ?? "") ?? this.nearest(npc, "police_station");
      default:
        return home;
    }
  }

  /** Picks one of the nearest open venues, so nearby businesses genuinely compete for customers. */
  private pickVenue(npc: NPC, kind: Building["kind"], hour: number): Building | undefined {
    const open = this.nearestN(npc, kind, 6).filter((v) => !this.hooks || this.hooks.isOpen(v, hour));
    if (open.length === 0) return undefined;
    return open[Math.min(open.length - 1, Math.floor(this.rng.next() * this.rng.next() * open.length))];
  }

  private nearestN(npc: NPC, kind: Building["kind"], n: number): Building[] {
    const list = (this.byKind.get(indexKey(kind)) ?? []).filter((b) => b.kind === kind && !b.vacant && !b.ruined);
    list.sort((a, c) => dist(npc.pos, a) - dist(npc.pos, c));
    return list.slice(0, n);
  }

  private nearest(npc: NPC, kind: Building["kind"]): Building | undefined {
    let best: Building | undefined;
    let bestD = Infinity;
    for (const b of this.byKind.get(indexKey(kind)) ?? []) {
      if (b.kind !== kind || b.vacant || b.ruined) continue;
      const d = dist(npc.pos, b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private requestPath(npc: NPC, target: Building): void {
    const startNode = this.city.roads.nearestNode(npc.pos);
    if (!startNode) return;
    npc.pathNodeIds = this.city.roads.findPath(startNode.id, target.nearestRoadNodeId) ?? [];
    npc.pathIndex = 0;
  }

  private progressMovement(npc: NPC, dt: number, speed: number): void {
    if (npc.pathNodeIds.length === 0) return;
    let remaining = speed * dt;
    while (remaining > 0 && npc.pathIndex < npc.pathNodeIds.length) {
      const node = this.city.roads.nodes.get(npc.pathNodeIds[npc.pathIndex]);
      if (!node) {
        npc.pathIndex++;
        continue;
      }
      const d = dist(npc.pos, node);
      if (d <= remaining) {
        npc.pos = { x: node.x, y: node.y };
        npc.currentRoadNodeId = node.id;
        remaining -= d;
        npc.pathIndex++;
      } else {
        const t = remaining / d;
        npc.pos = { x: npc.pos.x + (node.x - npc.pos.x) * t, y: npc.pos.y + (node.y - npc.pos.y) * t };
        remaining = 0;
      }
    }
    if (npc.pathIndex >= npc.pathNodeIds.length) {
      npc.pathNodeIds = [];
      if (npc.status !== "fleeing") {
        const target = npc.targetBuildingId ? this.city.buildings.get(npc.targetBuildingId) : undefined;
        if (target) npc.pos = { x: target.x, y: target.y };
      }
    }
  }

  private applyActivityEffects(npc: NPC, dt: number): void {
    if (npc.inVehicle || npc.pathNodeIds.length > 0) {
      npc.currentActivity = "commuting";
      return;
    }
    if (npc.currentActivity === "commuting") npc.currentActivity = npc.currentGoal as ActivityKind;
    applyNeedRecovery(npc, npc.currentActivity, dt);
  }

  /**
   * Abstract-tier NPCs skip pathfinding and movement. When their goal changes
   * they jump straight to the goal's building, and needs are bulk-updated for
   * the elapsed time — O(1) per NPC regardless of how much time passed. When
   * the camera approaches they resume real movement from wherever they are.
   */
  private abstractCatchUp(npc: NPC, nowMinutes: number, now: CalendarDate): void {
    const elapsed = nowMinutes - npc.lastFullUpdateMinutes;
    if (elapsed < 15) return;
    npc.lastFullUpdateMinutes = nowMinutes;
    this.decayNeeds(npc, elapsed);

    const decision = decideActivity(npc, now).activity;
    if (decision !== npc.currentGoal || npc.inVehicle || npc.pathNodeIds.length > 0) {
      npc.currentGoal = decision;
      npc.currentActivity = decision;
      const target = this.resolveTargetBuilding(npc, decision, now);
      npc.pathNodeIds = [];
      npc.inVehicle = false;
      npc.targetBuildingId = target?.id;
      if (target) {
        npc.pos = { x: target.x, y: target.y };
        if (npc.vehicleId) this.vehicleSystem?.parkAt(npc.vehicleId, target);
        this.arrive(npc, now);
      }
    }
    applyNeedRecovery(npc, npc.currentActivity, elapsed);
  }
}

function applyNeedRecovery(npc: NPC, activity: ActivityKind, dt: number): void {
  const n = npc.needs;
  switch (activity) {
    case "sleeping":
      n.energy = Math.min(100, n.energy + (npc.homeless ? 0.3 : 0.5) * dt);
      break;
    case "eating":
      n.hunger = Math.min(100, n.hunger + 0.8 * dt);
      n.social = Math.min(100, n.social + 0.1 * dt);
      break;
    case "working":
      n.energy = Math.max(0, n.energy - 0.02 * dt);
      n.social = Math.min(100, n.social + 0.08 * dt);
      break;
    case "shopping":
      n.fun = Math.min(100, n.fun + 0.25 * dt);
      break;
    case "socializing":
      n.social = Math.min(100, n.social + 0.6 * dt);
      n.fun = Math.min(100, n.fun + 0.2 * dt);
      break;
    case "leisure":
      n.fun = Math.min(100, n.fun + 0.5 * dt);
      break;
    case "patrolling":
      n.energy = Math.max(0, n.energy - 0.01 * dt);
      break;
    default:
      break;
  }
}

/** Shops and restaurants share an index bucket because storefronts can change between them. */
function indexKey(kind: Building["kind"]): Building["kind"] {
  return kind === "restaurant" ? "shop" : kind;
}
