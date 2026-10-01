import { describe, expect, it } from 'vitest';
import { acos, asin, atan, atan2, cos, sin, tan } from '../../src/core/math/index.js';

/**
 * Tests for the core's deterministic trigonometry.
 *
 * These matter more than ordinary unit tests, because the whole point of this module is that it
 * behaves like a trig function. If `sin` or `atan2` were subtly wrong, terrain slopes, hull
 * headings and body orientation would all be subtly wrong, and the failure would look like a vague
 * "the tank drives strangely" bug rather than a maths error.
 *
 * The reference values come from `Math.*`, which is correct if not guaranteed deterministic — so
 * using it *here*, in a test, is exactly right. The production code cannot use it (ADR-0005); the
 * test verifying the replacement certainly can.
 */

/** Tolerance for sin/cos/tan. The polynomial approximations are accurate to roughly 1e-7. */
const TRIG_TOLERANCE = 1e-5;

/** Tolerance for inverse trig, which involves a division and so accumulates a little more error. */
const INVERSE_TOLERANCE = 1e-4;

describe('sin', () => {
  it('matches Math.sin across the full range', () => {
    for (let i = -2000; i <= 2000; i += 7) {
      const x = (i / 2000) * 20;
      expect(sin(x)).toBeCloseTo(Math.sin(x), 5);
    }
  });

  it('is zero at multiples of PI', () => {
    for (let k = -8; k <= 8; k += 1) {
      expect(Math.abs(sin(k * Math.PI))).toBeLessThan(1e-6);
    }
  });

  it('returns exactly 1 at PI/2 and -1 at -PI/2', () => {
    expect(sin(Math.PI / 2)).toBeCloseTo(1, 6);
    expect(sin(-Math.PI / 2)).toBeCloseTo(-1, 6);
    expect(sin((3 * Math.PI) / 2)).toBeCloseTo(-1, 6);
  });

  it('is odd', () => {
    for (const x of [0.3, 1.1, 2.7, 5.9, -0.4, -3.2]) {
      expect(sin(-x)).toBeCloseTo(-sin(x), 6);
    }
  });

  it('stays bounded for very large arguments', () => {
    expect(Math.abs(sin(1e6))).toBeLessThanOrEqual(1);
    expect(Number.isFinite(sin(1e9))).toBe(true);
  });

  it('returns 0 for non-finite input rather than NaN', () => {
    expect(sin(Number.NaN)).toBe(0);
    expect(sin(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('cos', () => {
  it('matches Math.cos across the full range', () => {
    for (let i = -2000; i <= 2000; i += 7) {
      const x = (i / 2000) * 20;
      expect(cos(x)).toBeCloseTo(Math.cos(x), 5);
    }
  });

  it('is one at multiples of 2*PI and minus one at odd multiples of PI', () => {
    for (let k = -6; k <= 6; k += 1) {
      expect(cos(k * Math.PI * 2)).toBeCloseTo(1, 6);
      expect(cos(k * Math.PI)).toBeCloseTo(Math.abs(k) % 2 === 0 ? 1 : -1, 6);
    }
  });

  it('is even', () => {
    for (const x of [0.3, 1.1, 2.7, 5.9]) {
      expect(cos(-x)).toBeCloseTo(cos(x), 6);
    }
  });

  it('is zero at odd multiples of PI/2', () => {
    // Only *odd* multiples of PI/2 are cosine zeros. At even multiples the value is +/-1, so the
    // loop must step by two rather than by one.
    for (let k = -7; k <= 7; k += 2) {
      expect(Math.abs(cos(k * Math.PI * 0.5))).toBeLessThan(1e-9);
    }
  });

  it('is exactly plus or minus one at even multiples of PI/2', () => {
    // The complement of the test above, and a check that the quadrant sign logic is right: getting
    // this wrong is easy and produces a plausible-looking but incorrect cosine.
    for (let k = -4; k <= 4; k += 2) {
      const expected = k % 4 === 0 ? 1 : -1;
      expect(cos(k * Math.PI * 0.5)).toBeCloseTo(expected, 9);
    }
  });

  it('satisfies the Pythagorean identity', () => {
    for (const x of [0.2, 1.3, 2.9, 4.4, -3.3]) {
      const s = sin(x);
      const c = cos(x);
      expect(s * s + c * c).toBeCloseTo(1, 5);
    }
  });
});

describe('tan', () => {
  it('matches Math.tan where it is finite', () => {
    for (let i = -200; i <= 200; i += 3) {
      const x = (i / 200) * 3;
      // Skip the asymptotes, where any implementation is allowed to diverge.
      if (Math.abs(Math.cos(x)) < 1e-6) {
        continue;
      }
      expect(tan(x)).toBeCloseTo(Math.tan(x), 4);
    }
  });

  it('equals sin/cos', () => {
    for (const x of [0.4, 1.2, 2.5, -1.1]) {
      expect(tan(x)).toBeCloseTo(sin(x) / cos(x), 6);
    }
  });
});

describe('atan', () => {
  it('matches Math.atan across the full range', () => {
    for (let i = -2000; i <= 2000; i += 7) {
      const x = (i / 2000) * 50;
      expect(atan(x)).toBeCloseTo(Math.atan(x), 4);
    }
  });

  it('is zero at zero and approaches +/-PI/2 at the extremes', () => {
    expect(atan(0)).toBe(0);
    expect(atan(1e9)).toBeCloseTo(Math.PI / 2, 5);
    expect(atan(-1e9)).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('is odd', () => {
    for (const x of [0.2, 1.0, 4.5, -7.2]) {
      expect(atan(-x)).toBeCloseTo(-atan(x), 6);
    }
  });
});

describe('atan2', () => {
  it('matches Math.atan2 across quadrants', () => {
    for (let i = -40; i <= 40; i += 1) {
      for (let j = -40; j <= 40; j += 7) {
        const y = (i / 40) * 6;
        const x = (j / 40) * 6;
        if (x === 0 && y === 0) {
          continue;
        }
        expect(atan2(y, x)).toBeCloseTo(Math.atan2(y, x), 4);
      }
    }
  });

  it('returns PI/2 straight up and -PI/2 straight down', () => {
    expect(atan2(1, 0)).toBeCloseTo(Math.PI / 2, 5);
    expect(atan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('returns 0 for the degenerate origin case rather than NaN', () => {
    expect(atan2(0, 0)).toBe(0);
  });

  it('recovers the heading of an axis-aligned direction', () => {
    expect(atan2(1, 0)).toBeCloseTo(Math.PI / 2, 5);
    expect(atan2(0, 1)).toBeCloseTo(0, 5);
    expect(atan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 5);
    expect(Math.abs(atan2(0, -1))).toBeCloseTo(Math.PI, 5);
  });
});

describe('asin and acos', () => {
  it('match their Math counterparts on the valid range', () => {
    for (let i = -100; i <= 100; i += 5) {
      const x = i / 100;
      expect(asin(x)).toBeCloseTo(Math.asin(x), 4);
      expect(acos(x)).toBeCloseTo(Math.acos(x), 4);
    }
  });

  it('clamps out-of-range input instead of producing NaN', () => {
    expect(asin(2)).toBeCloseTo(Math.PI / 2, 4);
    expect(asin(-2)).toBeCloseTo(-Math.PI / 2, 4);
    expect(acos(5)).toBeCloseTo(0, 4);
    expect(acos(-5)).toBeCloseTo(Math.PI, 4);
  });

  it('satisfy the complementary identity', () => {
    for (let i = -100; i <= 100; i += 10) {
      const x = i / 100;
      expect(asin(x) + acos(x)).toBeCloseTo(Math.PI / 2, 4);
    }
  });
});

describe('declared tolerances', () => {
  it('are actually met, so the constants cannot rot into something untrue', () => {
    expect(Math.abs(sin(1) - Math.sin(1))).toBeLessThan(TRIG_TOLERANCE);
    expect(Math.abs(atan(1) - Math.atan(1))).toBeLessThan(INVERSE_TOLERANCE);
  });
});

