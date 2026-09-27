import type { SimClock } from "../core/Clock";
import type { EventBus } from "../core/EventBus";

export interface ChronicleEntry {
  day: number;
  minute: number;
  text: string;
  importance: number;
}

/**
 * The city's history, written only from real simulation events. Systems emit
 * "chronicle.entry" when something noteworthy happens; nothing here invents
 * content.
 */
export class Chronicle {
  entries: ChronicleEntry[] = [];
  private listeners: ((e: ChronicleEntry) => void)[] = [];
  static readonly MAX = 1500;

  constructor(bus: EventBus, private clock: SimClock) {
    bus.on("chronicle.entry", (e) => {
      const entry: ChronicleEntry = { day: e.day, minute: Math.floor(clock.totalMinutes % 1440), text: e.text, importance: e.importance };
      this.entries.push(entry);
      if (this.entries.length > Chronicle.MAX) this.entries.shift();
      for (const l of this.listeners) l(entry);
    });
  }

  onEntry(fn: (e: ChronicleEntry) => void): void {
    this.listeners.push(fn);
  }

  /** Major events only, grouped by day — what the World Chronicle view shows. */
  headlines(minImportance = 0.6): ChronicleEntry[] {
    return this.entries.filter((e) => e.importance >= minImportance);
  }
}
