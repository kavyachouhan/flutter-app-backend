/**
 * Deterministic pseudo-random source for contract vectors. The vectors are
 * committed, so generation must be reproducible byte for byte from the seed;
 * Math.random would make every regeneration a spurious diff.
 *
 * mulberry32: small, fast, good enough distribution for fixture data.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.int(0, values.length - 1)];
    if (value === undefined) throw new Error('pick() from an empty list');
    return value;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
