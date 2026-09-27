import type { CalendarDate } from "../core/Clock";
import { EventBus } from "../core/EventBus";
import type { SeededRandom } from "../core/Random";
import { dist, type Vec2 } from "../core/types";
import type { City } from "../world/City";
import type { Building } from "../world/City";
import type { ActivityKind, LODTier, NPC } from "./NPC";
import { decideActivity, scheduleTargetBuilding } from "./UtilityAI";

const WALK_SPEED = 6; // world units per sim-minute
const NEED_DECAY = { hunger: 0.06, energy: 0.045, social: 0.03, fun: 0.025 };

const LOD_RADIUS = { high: 250, medium: 700, low: 1600 };
/** How many sim-minutes must pass between updates for each LOD tier (abstract uses event-driven catch-up instead). */
const LOD_UPDATE_EVERY_MIN = { high: 0, medium: 2, low: 10 };

export class NPCSystem {
  npcs: Map<string, NPC> = new Map();

  constructor(
    private city: City,
    private bus: EventBus,
    private rng: SeededRandom,
  ) {}

  addAll(npcs: NPC[]): void {
    for (const n of npcs) this.npcs.set(n.id, n);
  }

  /** Called every sim tick. focusPos is usually the player/camera position, used for LOD. */
  update(nowMinutes: number, now: CalendarDate, dtMinutes: number, focusPos: Vec2): void {
    for (const npc of this.npcs.values()) {
      if (!npc.alive || npc.status === "arrested" || npc.status === "hospitalized") continue;

      const tier = this.computeLOD(npc, focusPos);
      npc.lod = tier;

      if (tier === "abstract") {
        this.abstractCatchUp(npc, nowMinutes, now);
        continue;
      }

      const dueMinutes = LOD_UPDATE_EVERY_MIN[tier];
      const elapsedSinceUpdate = nowMinutes - npc.lastFullUpdateMinutes;
      if (dueMinutes > 0 && elapsedSinceUpdate < dueMinutes) continue;

      const effectiveDt = tier === "high" ? dtMinutes : Math.max(dtMinutes, elapsedSinceUpdate);
      this.fullUpdate(npc, now, nowMinutes, effectiveDt);
    }
  }

  private computeLOD(npc: NPC, focusPos: Vec2): LODTier {
    const d = dist(npc.pos, focusPos);
    if (d <= LOD_RADIUS.high) return "high";
    if (d <= LOD_RADIUS.medium) return "medium";
    if (d <= LOD_RADIUS.low) return "low";
    return "abstract";
  }

  private decayNeeds(npc: NPC, dtMinutes: number): void {
    npc.needs.hunger = Math.max(0, npc.needs.hunger - NEED_DECAY.hunger * dtMinutes);
    npc.needs.energy = Math.max(0, npc.needs.energy - NEED_DECAY.energy * dtMinutes);
    npc.needs.social = Math.max(0, npc.needs.social - NEED_DECAY.social * dtMinutes);
    npc.needs.fun = Math.max(0, npc.needs.fun - NEED_DECAY.fun * dtMinutes);
  }

  private fullUpdate(npc: NPC, now: CalendarDate, nowMinutes: number, dtMinutes: number): void {
    this.decayNeeds(npc, dtMinutes);
    npc.lastFullUpdateMinutes = nowMinutes;

    const decision = decideActivity(npc, now);
    const desiredActivity = decision.activity;

    if (desiredActivity !== npc.currentActivity || npc.pathNodeIds.length === 0) {
      this.beginActivity(npc, desiredActivity, now);
    }

    this.progressMovement(npc, dtMinutes);
    this.applyActivityEffects(npc, dtMinutes, now);
  }

  private beginActivity(npc: NPC, activity: ActivityKind, now: CalendarDate): void {
    npc.currentActivity = activity;
    npc.currentGoal = activity;

    const target = this.resolveTargetBuilding(npc, activity, now);
    npc.targetBuildingId = target?.id;

    if (target && dist(npc.pos, target) > 8) {
      this.requestPath(npc, target);
    } else {
      npc.pathNodeIds = [];
      npc.pathIndex = 0;
    }
  }

  private resolveTargetBuilding(npc: NPC, activity: ActivityKind, now: CalendarDate): Building | undefined {
    const b = this.city.buildings;
    switch (activity) {
      case "sleeping":
        return b.get(npc.homeId);
      case "eating":
        return b.get(npc.homeId) ?? this.nearest(npc, "restaurant");
      case "working":
        return b.get(scheduleTargetBuilding(npc, now) ?? npc.workplaceId ?? "");
      case "commuting":
        return b.get(npc.workplaceId ?? npc.homeId);
      case "shopping":
        return this.nearest(npc, "shop");
      case "socializing":
      case "leisure":
        return this.nearest(npc, "park") ?? b.get(npc.homeId);
      case "committing_crime":
        return this.nearest(npc, "shop");
      case "patrolling":
        return this.nearest(npc, "police_station");
      default:
        return undefined;
    }
  }

  private nearest(npc: NPC, kind: Building["kind"]): Building | undefined {
    let best: Building | undefined;
    let bestD = Infinity;
    for (const b of this.city.buildings.values()) {
      if (b.kind !== kind) continue;
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
    const path = this.city.roads.findPath(startNode.id, target.nearestRoadNodeId);
    npc.pathNodeIds = path ?? [];
    npc.pathIndex = 0;
  }

  private progressMovement(npc: NPC, dtMinutes: number): void {
    if (npc.pathNodeIds.length === 0) return;
    let remaining = WALK_SPEED * dtMinutes;
    while (remaining > 0 && npc.pathIndex < npc.pathNodeIds.length) {
      const nodeId = npc.pathNodeIds[npc.pathIndex];
      const node = this.city.roads.nodes.get(nodeId);
      if (!node) {
        npc.pathIndex++;
        continue;
      }
      const d = dist(npc.pos, node);
      if (d <= remaining) {
        npc.pos = { x: node.x, y: node.y };
        npc.currentRoadNodeId = nodeId;
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
      // Final hop from last road node into the building itself, if we have a target.
      const target = npc.targetBuildingId ? this.city.buildings.get(npc.targetBuildingId) : undefined;
      if (target) npc.pos = { x: target.x, y: target.y };
    }
  }

  private applyActivityEffects(npc: NPC, dtMinutes: number, now: CalendarDate): void {
    const arrived = npc.pathNodeIds.length === 0;
    if (!arrived) {
      if (npc.currentActivity !== "committing_crime") npc.currentActivity = "commuting";
      return;
    }
    switch (npc.currentActivity) {
      case "sleeping":
        npc.needs.energy = Math.min(100, npc.needs.energy + 0.5 * dtMinutes);
        break;
      case "eating": {
        npc.needs.hunger = Math.min(100, npc.needs.hunger + 0.8 * dtMinutes);
        const target = npc.targetBuildingId ? this.city.buildings.get(npc.targetBuildingId) : undefined;
        if (target && target.id !== npc.homeId) npc.money -= Math.min(2 * dtMinutes, npc.money);
        break;
      }
      case "working": {
        npc.money += (npc.wage / 60) * dtMinutes;
        npc.needs.energy = Math.max(0, npc.needs.energy - 0.02 * dtMinutes);
        break;
      }
      case "shopping":
        npc.needs.fun = Math.min(100, npc.needs.fun + 0.2 * dtMinutes);
        npc.money -= Math.min(1.5 * dtMinutes, npc.money);
        break;
      case "socializing":
        npc.needs.social = Math.min(100, npc.needs.social + 0.6 * dtMinutes);
        break;
      case "leisure":
        npc.needs.fun = Math.min(100, npc.needs.fun + 0.5 * dtMinutes);
        break;
      case "committing_crime":
        this.attemptCrime(npc, now);
        break;
      default:
        break;
    }
  }

  private attemptCrime(npc: NPC, now: CalendarDate): void {
    // One roll per arrival; consume the goal afterward so NPCs don't loop-steal every tick.
    npc.currentActivity = "leisure";
    const success = this.rng.chance(0.5 + npc.personality.riskTolerance * 0.3);
    const gain = success ? this.rng.int(20, 150) : 0;
    npc.money += gain;
    if (success) npc.criminalRecord += 1;

    const witnesses = Array.from(this.npcs.values())
      .filter((o) => o.id !== npc.id && dist(o.pos, npc.pos) < 60 && o.alive)
      .map((o) => o.id);

    this.bus.emit("crime.committed", {
      crimeType: "theft",
      suspectId: npc.id,
      locationId: npc.targetBuildingId ?? "",
      witnessIds: witnesses,
      x: npc.pos.x,
      y: npc.pos.y,
    });
  }

  /**
   * Abstract-tier NPCs skip per-tick pathfinding/movement entirely. Instead
   * we fast-forward: figure out which schedule block they *should* be in
   * right now, teleport them to that block's building, and bulk-apply need
   * decay/income for the elapsed time. This is the "coarse event" LOD tier
   * from spec section 24 — cheap enough that thousands of NPCs cost O(1)
   * each per tick instead of O(pathfinding).
   */
  private abstractCatchUp(npc: NPC, nowMinutes: number, now: CalendarDate): void {
    const elapsed = nowMinutes - npc.lastFullUpdateMinutes;
    if (elapsed < 15) return; // don't bother resolving sub-15-minute gaps for offscreen NPCs
    npc.lastFullUpdateMinutes = nowMinutes;
    this.decayNeeds(npc, elapsed);

    const decision = decideActivity(npc, now);
    npc.currentActivity = decision.activity;
    const target = this.resolveTargetBuilding(npc, decision.activity, now);
    if (target) {
      npc.pos = { x: target.x, y: target.y };
      npc.targetBuildingId = target.id;
    }
    npc.pathNodeIds = [];

    if (decision.activity === "working") {
      npc.money += (npc.wage / 60) * elapsed;
    } else if (decision.activity === "sleeping") {
      npc.needs.energy = Math.min(100, npc.needs.energy + 0.5 * elapsed);
    } else if (decision.activity === "eating") {
      npc.needs.hunger = Math.min(100, npc.needs.hunger + 0.8 * elapsed);
    }
  }
}
