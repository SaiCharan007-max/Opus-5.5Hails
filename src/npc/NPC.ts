import type { Vec2 } from "../core/types";

export type OccupationKind =
  | "office_worker"
  | "shop_worker"
  | "police_officer"
  | "firefighter"
  | "doctor"
  | "student"
  | "business_owner"
  | "unemployed"
  | "criminal";

export type FactionId = "civilians" | "police" | "government" | "criminals" | "business" | "emergency_services";

export interface Personality {
  aggression: number; // 0..1
  friendliness: number;
  greed: number;
  bravery: number;
  intelligence: number;
  riskTolerance: number;
  sociability: number;
  honesty: number;
}

export interface Needs {
  hunger: number; // 0 = starving, 100 = full
  energy: number; // 0 = exhausted, 100 = rested
  social: number; // 0 = lonely, 100 = fulfilled
  fun: number; // 0 = bored, 100 = entertained
  safety: number; // 0 = terrified, 100 = safe
}

export type MemoryKind =
  | "witnessed_crime"
  | "was_victim"
  | "helped_by"
  | "helped"
  | "fired"
  | "hired"
  | "arrested"
  | "met"
  | "argument"
  | "life_event";

export interface Memory {
  id: string;
  kind: MemoryKind;
  aboutNpcId?: string;
  locationId?: string;
  timestampMinutes: number;
  /** -1..1 how the NPC felt about it. */
  emotionalValence: number;
  /** 0..1 how strongly this is remembered; decays over time, prunes at low values. */
  importance: number;
  note: string;
}

export type RelationType =
  | "stranger"
  | "acquaintance"
  | "friend"
  | "family"
  | "coworker"
  | "romantic"
  | "enemy"
  | "criminal_associate";

export interface Relationship {
  npcId: string;
  type: RelationType;
  /** -100..100 */
  trust: number;
  lastInteractionMinutes: number;
}

export type ActivityKind =
  | "idle"
  | "sleeping"
  | "eating"
  | "commuting"
  | "working"
  | "shopping"
  | "socializing"
  | "leisure"
  | "fleeing"
  | "committing_crime"
  | "patrolling"
  | "responding"
  | "arrested"
  | "incapacitated";

export type LODTier = "high" | "medium" | "low" | "abstract";

export interface ScheduleBlock {
  startHour: number;
  endHour: number;
  activity: ActivityKind;
  targetBuildingId?: string; // resolved at NPC creation (home/work), or looked up dynamically
}

export interface NPC {
  id: string;
  name: string;
  age: number;
  occupation: OccupationKind;
  faction: FactionId;

  personality: Personality;
  needs: Needs;
  skills: { work: number; charisma: number; combat: number };

  homeId: string;
  workplaceId?: string;

  money: number;
  wage: number; // per sim-hour worked, if employed

  inventory: string[];
  relationships: Map<string, Relationship>;
  memories: Memory[];

  schedule: ScheduleBlock[];
  currentGoal: string;
  currentActivity: ActivityKind;

  pos: Vec2;
  currentRoadNodeId?: string;
  pathNodeIds: string[];
  pathIndex: number;
  targetBuildingId?: string;

  vehicleId?: string;
  inVehicle: boolean;

  lod: LODTier;
  lastFullUpdateMinutes: number;

  wantedLevel: number; // 0..5
  criminalRecord: number; // count of past crimes
  alive: boolean;
  status: "free" | "arrested" | "fleeing" | "hospitalized" | "deceased";
}
