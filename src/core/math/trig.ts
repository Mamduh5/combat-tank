/**
 * Cross-platform deterministic trigonometry.
 *
 * Rapier's documentation states that its WASM build is deterministic across platforms, but the
 * same documentation warns that JavaScript's `Math.sin` and `Math.cos` are *not*. Since Combat
 * Tank's server-authoritative multiplayer depends on the client and server agreeing on where a
 * tank ended up, the simulation core cannot depend on the platform's transcendental functions.
 *
 * These implementations are polynomial approximations on a reduced range. They are accurate to
 * roughly 1e-7 or better over the ranges the game uses, which is far tighter than any gameplay
 * tolerance, and they are bit-identical everywhere because they use only +, -, *, /.
 *
 * See ADR-0005 and `docs/technical-direction.md` §4.2.
 *
 * The ESLint configuration bans `Math.sin`, `Math.cos`, `Math.atan2`, and friends inside
 * `src/core` so this module cannot be bypassed by accident.
 */

const PI = Math.PI;
const TWO_PI = PI * 2;
const HALF_PI = PI / 2;
const QUARTER_PI = PI / 4;

// --- sin ---------------------------------------------------------------------------
// Taylor series coefficients for sin, valid on [-PI/4, PI/4]:
//   sin(x) = x - x^3/6 + x^5/120 - x^7/5040 + x^9/362880 - x^11/39916800
const S1 = -1 / 6;
const S2 = 1 / 120;
const S3 = -1 / 5040;
const S4 = 1 / 362880;
const S5 = -1 / 39916800;

// --- cos ---------------------------------------------------------------------------
// Taylor series coefficients for cos, valid on [-PI/4, PI/4]:
//   cos(x) = 1 - x^2/2 + x^4/24 - x^6/720 + x^8/40320 - x^10/3628800 + x^12/479001600
//
// Note the leading constant 1 is outside the polynomial: cosCore returns `1 + z*(...)`. Getting
// this sequence wrong by one term (dropping the -1/2 and shifting the rest up) is easy to do and
// produces a function that is smooth, plausible-looking, and quietly wrong — it returns about 1.03
// where cos should return 0.71.
const C1 = -1 / 2;
const C2 = 1 / 24;
const C3 = -1 / 720;
const C4 = 1 / 40320;
const C5 = -1 / 3628800;
const C6 = 1 / 479001600;

/**
 * Reduces `x` to a first-quadrant angle.
 *
 * Returns the quadrant index (0..3) and the residual angle in `[0, PI/2)`. The residual is then
 * folded once more by the caller into `[0, PI/4]`, which is the range the polynomials below are
 * valid over.
 *
 * `Math.floor` is used rather than `Math.round` because it is exactly specified by IEEE-754, and
 * the quadrant mapping below does not care which way a tie breaks.
 */
function reduceToQuadrant(x: number): { r: number; quadrant: number } {
  // Normalise into [0, 2*PI). Keeping the intermediate small preserves precision for the large
  // angles a long play session can accumulate.
  const k = Math.floor(x / TWO_PI);
  let t = x - k * TWO_PI;
  if (t < 0) {
    t += TWO_PI;
  }

  const q = Math.floor(t / HALF_PI);
  const r = t - q * HALF_PI;
  return { r, quadrant: q };
}

/**
 * Evaluates sin or cos of an angle reduced to `quadrant * (PI/2) + r`.
 *
 * Two independent decisions are combined here, and conflating them is an easy and silent mistake:
 *
 *  1. **Which polynomial.** sin of an angle in an *odd* quadrant is a cosine, and vice versa:
 *     `sin(PI/2 + r) = cos(r)`, `cos(PI/2 + r) = -sin(r)`. This depends on the quadrant's parity.
 *  2. **Which argument.** The polynomials are only valid on `[0, PI/4]`, so a residual above PI/4
 *     is replaced by its complement, which *also* swaps which polynomial is correct.
 *
 * Getting only the second right (and ignoring parity) makes `sin(PI/2)` return 0 instead of 1,
 * because the residual there is exactly zero and the parity term is the whole answer.
 *
 * The sign then follows from the quadrant: sin is positive in quadrants 0 and 1, cos in 0 and 3.
 */
function sinCosCore(quadrant: number, r: number, wantSin: boolean): number {
  const qIsOdd = (quadrant & 1) === 1;
  const needsComplement = r > QUARTER_PI;

  // Which polynomial the *quadrant* calls for, before any folding:
  //   sin(q*PI/2 + r) uses cos when q is odd   (sin(PI/2 + r) =  cos(r))
  //   cos(q*PI/2 + r) uses sin when q is odd   (cos(PI/2 + r) = -sin(r))
  const quadrantWantsCos = wantSin ? qIsOdd : !qIsOdd;

  // Folding to the complement swaps sin and cos, so it inverts that choice.
  const useCosPolynomial = quadrantWantsCos !== needsComplement;
  const arg = needsComplement ? HALF_PI - r : r;

  const value = useCosPolynomial ? cosCore(arg) : sinCore(arg);

  // sin is positive in quadrants 0 and 1; cos is positive in 0 and 3.
  const positive = wantSin ? quadrant <= 1 : quadrant === 0 || quadrant === 3;
  return positive ? value : -value;
}

function sinCore(x: number): number {
  const z = x * x;
  return x * (1 + z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * S5)))));
}

function cosCore(x: number): number {
  const z = x * x;
  return 1 + z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/** Deterministic sine. Accurate to ~1e-7 over the range the game uses. */
export function sin(x: number): number {
  if (!Number.isFinite(x)) {
    return 0;
  }
  const { r, quadrant } = reduceToQuadrant(x);
  return sinCosCore(quadrant, r, true);
}

/** Deterministic cosine. Accurate to ~1e-7 over the range the game uses. */
export function cos(x: number): number {
  if (!Number.isFinite(x)) {
    return 1;
  }
  const { r, quadrant } = reduceToQuadrant(x);
  return sinCosCore(quadrant, r, false);
}

/** Deterministic tangent. */
export function tan(x: number): number {
  const c = cos(x);
  if (c === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return sin(x) / c;
}

// --- inverse trigonometry -----------------------------------------------------------

/** tan(PI/6), used to fold the argument down before evaluating the series. */
const TAN_PI_6 = 0.5773502691896257;
/** tan(PI/12), the second fold. */
const TAN_PI_12 = 0.2679491924311227;
const PI_6 = Math.PI / 6;
const PI_4 = Math.PI / 4;

/**
 * Deterministic arctangent, valid on the full real line.
 *
 * The argument is folded into a small range before a Taylor series is evaluated, because the
 * alternating series for atan converges very slowly near 1 — truncating it there is not accurate
 * enough for the tolerances the simulation relies on.
 *
 * Folding uses the tangent subtraction identity `atan(a) - atan(b) = atan((a-b)/(1+ab))`:
 *   |x| > 1        ->  atan(x) = PI/2 - atan(1/x)
 *   |x| > tan(PI/6)->  atan(x) = PI/6 + atan((x-b)/(1+xb))
 *   |x| > tan(PI/12)-> atan(x) = PI/4 + atan((x-1)/(1+x))
 * After the folds the remaining argument is at most ~0.13, where four series terms already give
 * roughly 1e-7 absolute accuracy.
 */
export function atan(x: number): number {
  if (!Number.isFinite(x)) {
    return x > 0 ? HALF_PI : -HALF_PI;
  }
  if (x === 0) {
    return 0;
  }

  const negative = x < 0;
  const ax = negative ? -x : x;

  let result: number;
  if (ax > 1) {
    result = HALF_PI - atanFolded(1 / ax);
  } else {
    result = atanFolded(ax);
  }

  return negative ? -result : result;
}

/** Evaluates atan on a value already known to be within [0, 1]. */
function atanFolded(x: number): number {
  if (x > TAN_PI_6) {
    return PI_6 + atanSmall((x - TAN_PI_6) / (1 + x * TAN_PI_6));
  }
  if (x > TAN_PI_12) {
    // atan(x) = PI/4 + atan((x-1)/(1+x)), and the reduced argument is negative here.
    return PI_4 + atanSmall((x - 1) / (1 + x));
  }
  return atanSmall(x);
}

/**
 * Taylor series for atan, valid for small arguments.
 *
 * Only ever called with |z| <= ~0.13, where the fifth omitted term is below 1e-8.
 */
function atanSmall(z: number): number {
  const z2 = z * z;
  return z * (1 + z2 * (-1 / 3 + z2 * (1 / 5 + z2 * (-1 / 7 + z2 * (1 / 9 + z2 * -1 / 11)))));
}

/**
 * Deterministic two-argument arctangent, returning the angle in `(-PI, PI]`.
 *
 * This is the workhorse for converting a direction vector into a heading, and is the reason the
 * core does not depend on `Math.atan2`.
 */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) {
    return 0;
  }
  if (x > 0) {
    return atan(y / x);
  }
  if (x < 0) {
    return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  }
  // x === 0
  return y > 0 ? HALF_PI : -HALF_PI;
}

/** Deterministic arcsine. `x` is clamped to `[-1, 1]`. */
export function asin(x: number): number {
  return atan2(x, Math.sqrt(Math.max(0, 1 - x * x)));
}

/** Deterministic arccosine. `x` is clamped to `[-1, 1]`. */
export function acos(x: number): number {
  const c = clampToUnit(x);
  return atan2(Math.sqrt(Math.max(0, 1 - c * c)), c);
}

function clampToUnit(x: number): number {
  if (x > 1) {
    return 1;
  }
  if (x < -1) {
    return -1;
  }
  return x;
}
