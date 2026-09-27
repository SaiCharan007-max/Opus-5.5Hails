import { describe, it, expect } from "vitest";
import { SimClock } from "../src/core/Clock";

describe("SimClock", () => {
  it("advances simulated minutes at the configured time scale", () => {
    const clock = new SimClock(7);
    clock.timeScale = 60; // 1 real second = 60 sim minutes = 1 sim hour
    clock.advance(1);
    expect(clock.now().hour).toBe(8);
  });

  it("wraps hours/days correctly", () => {
    const clock = new SimClock(23);
    clock.totalMinutes = 23 * 60 + 50;
    clock.timeScale = 1;
    clock.advance(20); // +20 sim minutes -> crosses midnight
    const now = clock.now();
    expect(now.hour).toBe(0);
    expect(now.minute).toBe(10);
  });

  it("does not advance while paused", () => {
    const clock = new SimClock(7);
    clock.paused = true;
    const before = clock.totalMinutes;
    clock.advance(100);
    expect(clock.totalMinutes).toBe(before);
  });

  it("fires every() callbacks the correct number of times", () => {
    const clock = new SimClock(0);
    clock.timeScale = 60;
    let ticks = 0;
    clock.every(60, () => ticks++); // once per sim hour
    for (let i = 0; i < 10; i++) clock.advance(1); // 10 real seconds = 10 sim hours
    expect(ticks).toBe(10);
  });

  it("weekday cycles across 7 days and flags weekends", () => {
    const clock = new SimClock(0);
    clock.totalMinutes = 5 * 24 * 60; // Saturday (day index 5)
    expect(clock.now().isWeekend).toBe(true);
    clock.totalMinutes = 1 * 24 * 60; // Tuesday
    expect(clock.now().isWeekend).toBe(false);
  });
});
