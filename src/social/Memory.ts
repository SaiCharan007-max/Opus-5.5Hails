import { nextId } from "../core/types";
import type { Memory, MemoryKind, NPC, RelationType, Relationship } from "../npc/NPC";

export const MAX_MEMORIES = 14;
export const MAX_RELATIONSHIPS = 24;

export interface MemoryInput {
  kind: MemoryKind;
  note: string;
  valence: number;
  importance: number;
  at: number;
  aboutNpcId?: string;
  locationId?: string;
}

/**
 * Adds a memory, merging with a near-duplicate from the last few hours instead
 * of stacking copies. When full, the least important memory is forgotten
 * first, so a single mugging outlives a dozen small talks.
 */
export function addMemory(npc: NPC, m: MemoryInput): void {
  const recent = npc.memories.find(
    (x) => x.kind === m.kind && x.aboutNpcId === m.aboutNpcId && x.note === m.note && m.at - x.timestampMinutes < 360,
  );
  if (recent) {
    recent.importance = Math.min(1, Math.max(recent.importance, m.importance) + 0.05);
    recent.timestampMinutes = m.at;
    return;
  }
  const mem: Memory = {
    id: nextId("mem"),
    kind: m.kind,
    aboutNpcId: m.aboutNpcId,
    locationId: m.locationId,
    timestampMinutes: m.at,
    emotionalValence: m.valence,
    importance: m.importance,
    note: m.note,
  };
  npc.memories.push(mem);
  if (npc.memories.length > MAX_MEMORIES) {
    let weakest = 0;
    for (let i = 1; i < npc.memories.length; i++) {
      if (npc.memories[i].importance < npc.memories[weakest].importance) weakest = i;
    }
    npc.memories.splice(weakest, 1);
  }
}

/** Daily fade. Strong emotional memories fade slower; trivial ones are forgotten. */
export function decayMemories(npc: NPC): void {
  for (const m of npc.memories) {
    const stickiness = 0.9 + Math.abs(m.emotionalValence) * 0.07;
    m.importance *= stickiness;
  }
  npc.memories = npc.memories.filter((m) => m.importance >= 0.08);
}

export function relationTo(npc: NPC, otherId: string): Relationship | undefined {
  return npc.relationships.get(otherId);
}

function classify(r: Relationship): RelationType {
  if (r.type === "family" || r.type === "romantic" || r.type === "criminal_associate") {
    if (r.type === "romantic" && r.trust < 10) return r.trust < -40 ? "enemy" : "acquaintance";
    return r.type;
  }
  if (r.trust <= -40) return "enemy";
  if (r.trust >= 40) return "friend";
  if (r.type === "coworker") return "coworker";
  if (r.trust >= 8) return "acquaintance";
  return r.type === "enemy" ? "acquaintance" : r.type;
}

/**
 * Changes trust in one direction (a→b). Relationships are asymmetric on
 * purpose: a victim distrusts the mugger far more than the mugger cares.
 */
export function adjustTrust(a: NPC, b: NPC, delta: number, at: number, asType?: RelationType): Relationship {
  let r = a.relationships.get(b.id);
  if (!r) {
    r = { npcId: b.id, type: asType ?? "stranger", trust: 0, lastInteractionMinutes: at };
    a.relationships.set(b.id, r);
    pruneRelationships(a);
  }
  if (asType && (asType === "coworker" || asType === "family" || asType === "romantic" || asType === "criminal_associate")) r.type = asType;
  r.trust = Math.max(-100, Math.min(100, r.trust + delta));
  r.lastInteractionMinutes = at;
  r.type = classify(r);
  return r;
}

function pruneRelationships(npc: NPC): void {
  if (npc.relationships.size <= MAX_RELATIONSHIPS) return;
  let weakestId: string | undefined;
  let weakest = Infinity;
  for (const [id, r] of npc.relationships) {
    if (r.type === "family" || r.type === "romantic") continue;
    const strength = Math.abs(r.trust) - (r.type === "stranger" ? 20 : 0);
    if (strength < weakest) {
      weakest = strength;
      weakestId = id;
    }
  }
  if (weakestId) npc.relationships.delete(weakestId);
}
