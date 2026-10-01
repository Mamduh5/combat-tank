/**
 * Deterministic pseudo-random number generator.
 *
 * Why this exists: a battle must be reproducible from `(seed, input log)`. That is what makes
 * bugs replayable, headless balance batches meaningful, and server/client agreement checkable
 * (ADR-0005). `Math.random()` is banned inside `src/core` by the ESLint configuration.
 *
 * The algorithm is mulberry32: a small, fast, well-distributed 32-bit generator. It uses only
 * integer operations (`|0`, `^`, `>>>`, `Math.imul`, `+`), all of which are exactly specified and
 * therefore identical on every JavaScript engine.
 *
 * The generator is explicitly seeded and *not* shared through a global. Each system that needs
 * randomness takes an `Rng` instance, so the order in which subsystems consume random numbers
 * cannot silently change one another's results.
 */
import { cos, sin } from '../math/trig.js';

const TWO_PI = Math.PI * 2;

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Normalise to an unsigned 32-bit integer so any caller-supplied seed is valid.
    this.state = seed >>> 0;
  }

  /** Returns the next raw 32-bit unsigned integer. */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Returns a float in `[0, 1)`. */
  nextFloat(): number {
    // Divide by 2^32 to map the full unsigned range onto [0, 1).
    return this.nextUint32() / 4294967296;
  }

  /** Returns a float in `[min, max)`. */
  range(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /** Returns an integer in `[min, max]`, inclusive. */
  intRange(min: number, max: number): number {
    const span = max - min + 1;
    if (span <= 0) {
      return min;
    }
    return min + (this.nextUint32() % span);
  }

  /** Returns `true` with the given probability. */
  chance(probability: number): boolean {
    return this.nextFloat() < probability;
  }

  /** Returns a uniformly distributed unit vector on the sphere. */
  nextUnitVector(): { x: number; y: number; z: number } {
    // Inverse-CDF sampling on the vertical component: uniform over the sphere, not over a cube.
    // Uses the core's own trig so the result is bit-identical everywhere (ADR-0005).
    const z = this.range(-1, 1);
    const theta = this.range(0, TWO_PI);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * cos(theta), y: r * sin(theta), z };
  }

  /** Returns a copy of this generator's internal state, for save/restore. */
  getState(): number {
    return this.state;
  }

  /** Restores a state previously obtained from `getState()`. */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}
