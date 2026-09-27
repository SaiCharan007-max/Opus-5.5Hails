/**
 * Lightweight typed pub/sub used to decouple subsystems (e.g. police doesn't
 * import crime code directly — it subscribes to "crime.committed" events).
 * This is the backbone of the "events have causes and consequences" design:
 * systems react to what happened rather than being called directly.
 */
export type WorldEventMap = {
  "crime.committed": {
    crimeType: string;
    suspectId: string;
    victimId?: string;
    locationId: string;
    witnessIds: string[];
    x: number;
    y: number;
  };
  "crime.reported": { crimeType: string; suspectId: string; reporterId: string; x: number; y: number };
  "police.dispatched": { unitId: string; targetX: number; targetY: number; reason: string };
  "police.arrest": { officerId: string; suspectId: string };
  "npc.fired": { npcId: string; businessId: string };
  "npc.hired": { npcId: string; businessId: string };
  "npc.evicted": { npcId: string };
  "npc.died": { npcId: string; cause: string };
  "npc.moved_home": { npcId: string; newHomeId: string };
  "business.closed": { businessId: string; reason: string };
  "business.opened": { businessId: string };
  "relationship.changed": { aId: string; bId: string; delta: number; reason: string };
  "emergency.fire": { locationId: string; x: number; y: number };
  "emergency.medical": { locationId: string; x: number; y: number; npcId?: string };
  "emergency.resolved": { kind: string; locationId: string };
  "mission.generated": { missionId: string; kind: string };
  "mission.completed": { missionId: string; success: boolean };
  "chronicle.entry": { day: number; text: string; importance: number };
};

export type WorldEventName = keyof WorldEventMap;

type Listener<K extends WorldEventName> = (payload: WorldEventMap[K]) => void;

export class EventBus {
  private handlers: Map<WorldEventName, Set<Listener<any>>> = new Map();

  on<K extends WorldEventName>(name: K, fn: Listener<K>): () => void {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(fn);
    return () => this.off(name, fn);
  }

  off<K extends WorldEventName>(name: K, fn: Listener<K>): void {
    this.handlers.get(name)?.delete(fn);
  }

  emit<K extends WorldEventName>(name: K, payload: WorldEventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    // Copy to array: handlers may subscribe/unsubscribe during emit.
    for (const fn of Array.from(set)) fn(payload);
  }
}
