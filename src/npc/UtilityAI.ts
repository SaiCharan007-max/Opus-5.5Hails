import type { CalendarDate } from "../core/Clock";
import type { ActivityKind, NPC, ScheduleBlock } from "./NPC";

export interface ActionCandidate {
  activity: ActivityKind;
  utility: number;
}

function currentScheduleBlock(npc: NPC, now: CalendarDate): ScheduleBlock | undefined {
  const t = now.hour + now.minute / 60;
  return npc.schedule.find((b) => (b.startHour <= b.endHour ? t >= b.startHour && t < b.endHour : t >= b.startHour || t < b.endHour));
}

/**
 * Utility AI: every candidate action gets a 0..~2 score from need deficits
 * and personality; the scheduled activity gets a baseline bonus so NPCs
 * follow their routine by default, but a severe need (e.g. near-zero
 * energy) can outscore the schedule and cause a believable deviation
 * ("stayed home sick" rather than "walked to work half-dead").
 */
export function decideActivity(npc: NPC, now: CalendarDate): ActionCandidate {
  const scheduled = currentScheduleBlock(npc, now);
  const candidates: ActionCandidate[] = [];

  candidates.push({ activity: "eating", utility: ((100 - npc.needs.hunger) / 100) * 1.1 });
  candidates.push({ activity: "sleeping", utility: ((100 - npc.needs.energy) / 100) * 1.3 });
  candidates.push({
    activity: "socializing",
    utility: ((100 - npc.needs.social) / 100) * 0.8 * (0.4 + npc.personality.sociability),
  });
  candidates.push({ activity: "leisure", utility: ((100 - npc.needs.fun) / 100) * 0.7 });

  if (npc.occupation === "criminal" || npc.money < 50) {
    const desperation = npc.money < 50 ? (50 - npc.money) / 50 : 0.3;
    candidates.push({
      activity: "committing_crime",
      utility: desperation * npc.personality.riskTolerance * (1 - npc.personality.honesty) * 0.9,
    });
  }

  if (scheduled) {
    candidates.push({ activity: scheduled.activity, utility: 0.75 });
  }

  candidates.sort((a, b) => b.utility - a.utility);
  const top = candidates[0];

  // Hysteresis: only deviate from the schedule if the winning need clearly
  // beats it, otherwise stick to routine — prevents needs flapping causing
  // NPCs to teleport between activities every tick.
  if (scheduled && top.activity !== scheduled.activity && top.utility < 0.85) {
    return { activity: scheduled.activity, utility: 0.75 };
  }
  return top;
}

export function scheduleTargetBuilding(npc: NPC, now: CalendarDate): string | undefined {
  return currentScheduleBlock(npc, now)?.targetBuildingId;
}
