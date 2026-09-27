/**
 * SimClock: the authoritative source of simulated time.
 * Decoupled from render frame rate — the render loop calls advance() with
 * a real-world delta, scaled by timeScale, and the clock accumulates
 * simulated minutes. Systems query the clock instead of using wall time.
 *
 * Base rate: 1 real second = 1 simulated minute at timeScale = 1.
 * timeScale can go up to 100x for observer mode fast-forwarding.
 */
export type Season = "spring" | "summer" | "autumn" | "winter";

export interface CalendarDate {
  totalMinutes: number;
  minute: number;
  hour: number;
  day: number; // day of week, 0=Monday
  dayOfMonth: number;
  week: number;
  weekDayName: string;
  isWeekend: boolean;
}

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY;
const DAYS_PER_WEEK = 7;
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export class SimClock {
  /** Simulated minutes elapsed since world start. Fractional for smooth sub-minute interpolation. */
  private minutes = 0;
  timeScale = 1; // simulated minutes per real second
  paused = false;

  private listeners: { everyMinutes: number; acc: number; cb: () => void }[] = [];

  constructor(startHour = 7) {
    this.minutes = startHour * MINUTES_PER_HOUR;
  }

  /** Advance simulated time by realDeltaSeconds of wall-clock time. */
  advance(realDeltaSeconds: number): void {
    if (this.paused) return;
    const deltaMinutes = realDeltaSeconds * this.timeScale;
    this.minutes += deltaMinutes;
    for (const l of this.listeners) {
      l.acc += deltaMinutes;
      while (l.acc >= l.everyMinutes) {
        l.acc -= l.everyMinutes;
        l.cb();
      }
    }
  }

  /** Register a callback fired every N simulated minutes (e.g. hourly upkeep ticks). */
  every(minutes: number, cb: () => void): () => void {
    const entry = { everyMinutes: minutes, acc: 0, cb };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  get totalMinutes(): number {
    return this.minutes;
  }

  set totalMinutes(v: number) {
    this.minutes = v;
  }

  now(): CalendarDate {
    const totalMinutes = this.minutes;
    const dayIndex = Math.floor(totalMinutes / MINUTES_PER_DAY);
    const minuteOfDay = totalMinutes - dayIndex * MINUTES_PER_DAY;
    const hour = Math.floor(minuteOfDay / MINUTES_PER_HOUR);
    const minute = Math.floor(minuteOfDay % MINUTES_PER_HOUR);
    const day = ((dayIndex % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
    const week = Math.floor(dayIndex / DAYS_PER_WEEK);
    return {
      totalMinutes,
      minute,
      hour,
      day,
      dayOfMonth: dayIndex,
      week,
      weekDayName: WEEKDAY_NAMES[day],
      isWeekend: day >= 5,
    };
  }

  season(): Season {
    const day = this.now().dayOfMonth;
    const cycle = Math.floor(day / 20) % 4; // ~20-day seasons, purely cosmetic
    return (["spring", "summer", "autumn", "winter"] as const)[cycle];
  }

  /** 0 (midnight) .. 1 (noon) .. 0 (midnight) — for lighting/day-night visuals. */
  daylightFactor(): number {
    const { hour, minute } = this.now();
    const t = hour + minute / 60;
    // Sunrise ~6, sunset ~20. Smooth cosine curve peaking at 13:00.
    const peak = 13;
    const span = 14;
    const x = ((t - peak) / span) * Math.PI;
    return Math.max(0, Math.cos(x));
  }

  formatTime(): string {
    const { hour, minute, weekDayName, dayOfMonth } = this.now();
    const hh = hour.toString().padStart(2, "0");
    const mm = minute.toString().padStart(2, "0");
    return `${weekDayName} D${dayOfMonth} ${hh}:${mm}`;
  }
}
