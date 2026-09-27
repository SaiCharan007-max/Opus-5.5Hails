import { SeededRandom } from "../core/Random";
import { nextId } from "../core/types";
import type { City } from "../world/City";
import type { Building } from "../world/City";
import type {
  FactionId,
  NPC,
  OccupationKind,
  Personality,
  ScheduleBlock,
} from "./NPC";

const FIRST_NAMES = [
  "Alex", "Jordan", "Sam", "Casey", "Riley", "Morgan", "Taylor", "Jamie", "Drew", "Avery",
  "Quinn", "Reese", "Skyler", "Rowan", "Elliot", "Dana", "Kai", "Micah", "Noel", "Sage",
];
const LAST_NAMES = [
  "Reyes", "Novak", "Whitfield", "Okafor", "Sato", "Marsh", "Delgado", "Petrov", "Nakamura",
  "Brennan", "Alvi", "Castillo", "Larsen", "Mbeki", "Rossi", "Kowalski", "Haddad", "Lund",
];

function randomName(rng: SeededRandom): string {
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
}

function randomPersonality(rng: SeededRandom): Personality {
  return {
    aggression: rng.next(),
    friendliness: rng.next(),
    greed: rng.next(),
    bravery: rng.next(),
    intelligence: rng.next(),
    riskTolerance: rng.next(),
    sociability: rng.next(),
    honesty: rng.next(),
  };
}

function occupationForWorkplace(kind: Building["kind"]): OccupationKind {
  switch (kind) {
    case "police_station":
      return "police_officer";
    case "fire_station":
      return "firefighter";
    case "hospital":
      return "doctor";
    case "shop":
    case "restaurant":
      return "shop_worker";
    case "school":
      return "student"; // teachers modeled as office_worker below is overridden by caller for staff
    default:
      return "office_worker";
  }
}

function factionForOccupation(occ: OccupationKind): FactionId {
  if (occ === "police_officer") return "police";
  if (occ === "firefighter" || occ === "doctor") return "emergency_services";
  if (occ === "criminal") return "criminals";
  if (occ === "business_owner" || occ === "shop_worker" || occ === "office_worker") return "business";
  return "civilians";
}

function buildSchedule(rng: SeededRandom, occupation: OccupationKind, workplaceId?: string): ScheduleBlock[] {
  const wake = rng.int(6, 8);
  const sleep = rng.int(22, 24);
  if (occupation === "unemployed" || occupation === "criminal") {
    return [
      { startHour: 0, endHour: wake, activity: "sleeping" },
      { startHour: wake, endHour: wake + 1, activity: "eating" },
      { startHour: wake + 1, endHour: 13, activity: "leisure" },
      { startHour: 13, endHour: 14, activity: "eating" },
      { startHour: 14, endHour: 19, activity: occupation === "criminal" ? "committing_crime" : "leisure" },
      { startHour: 19, endHour: 21, activity: "socializing" },
      { startHour: 21, endHour: 24, activity: "sleeping" },
    ];
  }
  if (occupation === "police_officer" || occupation === "firefighter") {
    const shiftStart = rng.pick([6, 14, 22]);
    return ([
      { startHour: 0, endHour: shiftStart, activity: shiftStart === 0 ? "patrolling" : "sleeping" },
      { startHour: shiftStart, endHour: shiftStart + 1, activity: "commuting", targetBuildingId: workplaceId },
      { startHour: shiftStart + 1, endHour: shiftStart + 9, activity: "patrolling", targetBuildingId: workplaceId },
      { startHour: shiftStart + 9, endHour: shiftStart + 10, activity: "commuting" },
      { startHour: shiftStart + 10, endHour: 24, activity: "sleeping" },
    ] as ScheduleBlock[]).map((b) => ({ ...b, startHour: ((b.startHour % 24) + 24) % 24, endHour: ((b.endHour % 24) + 24) % 24 }));
  }
  if (occupation === "student") {
    return [
      { startHour: 0, endHour: wake, activity: "sleeping" },
      { startHour: wake, endHour: wake + 0.5, activity: "eating" },
      { startHour: wake + 0.5, endHour: 8.5, activity: "commuting", targetBuildingId: workplaceId },
      { startHour: 8.5, endHour: 15, activity: "working", targetBuildingId: workplaceId },
      { startHour: 15, endHour: 15.5, activity: "commuting" },
      { startHour: 15.5, endHour: 18, activity: "socializing" },
      { startHour: 18, endHour: 19, activity: "eating" },
      { startHour: 19, endHour: 21.5, activity: "leisure" },
      { startHour: 21.5, endHour: 24, activity: "sleeping" },
    ];
  }
  // office_worker, shop_worker, doctor, business_owner — the "standard" worker schedule from spec section 5.
  const workStart = rng.int(8, 9);
  const workEnd = workStart + rng.int(8, 9);
  return ([
    { startHour: 0, endHour: wake, activity: "sleeping" },
    { startHour: wake, endHour: wake + 0.5, activity: "eating" },
    { startHour: wake + 0.5, endHour: workStart, activity: "commuting", targetBuildingId: workplaceId },
    { startHour: workStart, endHour: workStart + 4, activity: "working", targetBuildingId: workplaceId },
    { startHour: workStart + 4, endHour: workStart + 5, activity: "eating" },
    { startHour: workStart + 5, endHour: workEnd, activity: "working", targetBuildingId: workplaceId },
    { startHour: workEnd, endHour: workEnd + 1, activity: "commuting" },
    { startHour: workEnd + 1, endHour: workEnd + 2, activity: "shopping" },
    { startHour: workEnd + 2, endHour: sleep, activity: "leisure" },
    { startHour: sleep, endHour: 24, activity: "sleeping" },
  ] as ScheduleBlock[]).map((b) => ({ ...b, startHour: b.startHour % 24, endHour: Math.min(b.endHour, 24) }));
}

export interface SpawnPlan {
  home: Building;
  workplace?: Building;
  occupation: OccupationKind;
}

/**
 * Assigns residents to homes and (when capacity allows) jobs to workplaces,
 * then constructs full NPC records. This runs once at world-gen time; the
 * economy system takes over hiring/firing afterward during play.
 */
export function populateCity(city: City, rng: SeededRandom, targetCount: number): NPC[] {
  const homes = Array.from(city.buildings.values()).filter((b) => b.residentCapacity > 0);
  const workplaces = Array.from(city.buildings.values()).filter((b) => b.jobCapacity > 0);
  const npcs: NPC[] = [];

  if (homes.length === 0) return npcs;

  for (let i = 0; i < targetCount; i++) {
    const home = rng.pick(homes);
    if (home.residentIds.length >= home.residentCapacity) {
      // simple retry: find any home with space, else skip (city too small for target count)
      const alt = homes.find((h) => h.residentIds.length < h.residentCapacity);
      if (!alt) continue;
      npcs.push(spawnOne(city, rng, alt, workplaces));
    } else {
      npcs.push(spawnOne(city, rng, home, workplaces));
    }
  }
  return npcs;
}

function spawnOne(city: City, rng: SeededRandom, home: Building, workplaces: Building[]): NPC {
  const age = rng.int(16, 75);
  const isStudent = age < 19;
  let workplace: Building | undefined;
  let occupation: OccupationKind;

  if (isStudent) {
    workplace = city.buildingsOfKind("school").find((s) => s.employeeIds.length < s.jobCapacity);
    occupation = "student";
  } else {
    const unemployedChance = 0.08;
    const criminalChance = 0.05;
    const roll = rng.next();
    if (roll < unemployedChance) {
      occupation = "unemployed";
    } else if (roll < unemployedChance + criminalChance) {
      occupation = "criminal";
    } else {
      const candidates = workplaces.filter((w) => w.employeeIds.length < w.jobCapacity && w.kind !== "school");
      workplace = candidates.length ? rng.pick(candidates) : undefined;
      occupation = workplace ? occupationForWorkplace(workplace.kind) : "unemployed";
      if (workplace?.kind === "office") occupation = rng.chance(0.15) ? "business_owner" : "office_worker";
    }
  }

  const npc: NPC = {
    id: nextId("npc"),
    name: randomName(rng),
    age,
    occupation,
    faction: factionForOccupation(occupation),
    personality: randomPersonality(rng),
    needs: { hunger: rng.int(60, 100), energy: rng.int(60, 100), social: rng.int(50, 100), fun: rng.int(50, 100), safety: 100 },
    skills: { work: rng.next(), charisma: rng.next(), combat: rng.next() * (occupation === "police_officer" ? 0.6 + rng.next() * 0.4 : 1) },
    homeId: home.id,
    workplaceId: workplace?.id,
    money: rng.int(200, 3000),
    wage: workplace ? rng.int(12, 40) : 0,
    inventory: [],
    relationships: new Map(),
    memories: [],
    schedule: buildSchedule(rng, occupation, workplace?.id),
    currentGoal: "idle",
    currentActivity: "idle",
    pos: { x: home.x, y: home.y },
    pathNodeIds: [],
    pathIndex: 0,
    inVehicle: false,
    lod: "abstract",
    lastFullUpdateMinutes: 0,
    wantedLevel: 0,
    criminalRecord: occupation === "criminal" ? rng.int(1, 4) : 0,
    alive: true,
    status: "free",
  };

  home.residentIds.push(npc.id);
  if (workplace) workplace.employeeIds.push(npc.id);
  return npc;
}

/**
 * Gives car ownership to a subset of employed NPCs and spawns their vehicle
 * parked at home. Run once at world-gen time, after populateCity(). Kept
 * separate rather than folded into spawnOne() because it needs a
 * VehicleSystem instance, which is constructed after NPCs are populated
 * (see Simulation constructor) — a small ordering dependency worth keeping
 * explicit rather than threading VehicleSystem through the whole factory.
 */
export function assignVehicles(
  npcs: NPC[],
  city: City,
  rng: SeededRandom,
  spawnVehicle: (id: string, ownerNpcId: string, home: Building) => void,
): void {
  for (const npc of npcs) {
    if (npc.occupation === "unemployed" || npc.occupation === "student") continue;
    if (!rng.chance(0.6)) continue;
    const home = city.buildings.get(npc.homeId);
    if (!home) continue;
    const vehicleId = nextId("veh");
    spawnVehicle(vehicleId, npc.id, home);
    npc.vehicleId = vehicleId;
  }
}
