/**
 * Deterministic PRNG (mulberry32) so the whole simulation is seed-reproducible.
 * Every subsystem that needs randomness takes a SeededRandom instance rather
 * than calling Math.random() directly — this is what makes save/load and
 * stress tests reproducible (spec section 23).
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /** True with probability p (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Fisher-Yates shuffle, returns a new array. */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Spawns an independent child RNG deterministically derived from this one. */
  fork(): SeededRandom {
    return new SeededRandom(this.int(0, 0xffffffff));
  }
}
