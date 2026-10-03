/**
 * Ground support under a tracked vehicle: what the ground beneath it is actually doing.
 *
 * ## Why this exists
 *
 * V6 presented the hull from a **single** ground normal sampled at the vehicle's centre. Measuring what
 * that produced (`tools/measure-grounding.mjs`) showed two independent defects, which had to be fixed
 * together because either one alone still leaves the tank floating:
 *
 * 1. **The attitude had the wrong sign.** The core decomposed the centre normal into pitch and roll, but
 *    each sign was inverted with respect to how Babylon applies `node.rotation`. A vehicle climbing a
 *    hill was pitched *nose-down*, so it drove into the slope with its nose and lifted its tail clear of
 *    it. Measured on the Cairn approach: the terrain rose 0.90 m from tail to nose while the rendered
 *    hull rose 0.89 m the *other* way, burying the nose 0.41 m into the ground and leaving 1.38 m of
 *    daylight under the tail. On a map whose steepest routes are 12 degrees this is the single largest
 *    contributor to "most of it floats".
 * 2. **One sample cannot describe a footprint.** A tank is 6.7 m long and 3.3 m wide. The ground under
 *    its nose, its tail and each flank differ by tens of centimetres on ordinary terrain, and a single
 *    central normal describes none of that. Even with the sign corrected, a rigid hull posed to one point
 *    bridges every dip beneath it.
 *
 * The fix is to stop sampling a point and start sampling the **support area**: a grid of contact points
 * spanning the track footprint, fitted with a least-squares plane. That plane is the best single
 * description of the ground the vehicle is resting on, and pitch and roll follow from its two gradients.
 *
 * ## Why the sign is derived rather than assumed
 *
 * These signs are easy to get backwards and very hard to catch by eye, because an inverted attitude on
 * gentle ground still looks like a tank sitting on a slight slope. So they are derived from the plane's
 * gradients in one place, stated in terms of what the viewer sees, and pinned by a test that compares the
 * rendered body against the terrain's own front-to-rear and left-to-right height differences.
 *
 * ## Scope
 *
 * Deliberately **not** a tracked-vehicle suspension model. This produces one plane for the hull and
 * nothing more; the per-element conforming that closes the residual gaps is a presentation concern and
 * lives in the renderer. No force, no spring, no wheel-level dynamics.
 */
import { atan, sin, cos } from '../math/index.js';

/** The fitted ground plane beneath a vehicle, in the vehicle's own frame. */
export interface GroundSupportPlane {
  /**
   * Metres of rise per metre travelled along the vehicle's **forward** axis.
   *
   * Positive means the ground climbs toward the nose. This is the quantity a tank's pitch must follow,
   * and the sign convention is the point of the type: "positive is nose-up" is stated once, in one place,
   * so no consumer has to re-derive it.
   */
  readonly risePerMetreForward: number;
  /**
   * Metres of rise per metre travelled along the vehicle's **right** axis.
   *
   * Positive means the ground climbs toward the right-hand track, which is the direction a positive roll
   * raises. Same reasoning, for the other axis.
   */
  readonly risePerMetreRight: number;
  /** Terrain height at the centre of the sampled grid. */
  readonly centreHeightM: number;
  /**
   * The largest amount by which any sampled point sits **above** the fitted plane, metres.
   *
   * How far a perfectly rigid hull would have to be lifted to avoid burying its highest point into a
   * rise. Zero on a true plane; positive over a crest.
   */
  readonly maxResidualAboveM: number;
  /**
   * The largest amount by which any sampled point sits **below** the fitted plane, metres.
   *
   * The complementary quantity: how much daylight a rigid hull leaves over a dip. The renderer closes this
   * with conforming track elements, which is why it is reported rather than solved here.
   */
  readonly maxResidualBelowM: number;
}

/** Grid positions along each axis, as multiples of the half-span. Symmetric about the centre. */
const GRID_STEPS = [-1, 0, 1] as const;

/**
 * Fits the ground plane beneath a vehicle from a grid of contact samples.
 *
 * ## The fit
 *
 * A least-squares plane `h = a + b*u + c*v` over a 3x3 grid, where `u` is the forward offset and `v` the
 * lateral offset in the vehicle's frame. Because the grid is **symmetric about its centre** the normal
 * equations decouple exactly: the off-diagonal sums `Î£u`, `Î£v` and `Î£uv` are all zero, so the intercept is
 * the mean height and each gradient is an independent ratio. That is not an approximation â€” the cross
 * terms vanish identically â€” and it means there is no matrix to invert and no pivot to choose wrongly on
 * degenerate ground.
 *
 * Nine samples rather than the five of a simple cross: a bump landing on one arm of a cross biases its
 * gradient badly, whereas a 3x3 grid averages it against eight neighbours. The cost is four extra
 * evaluations of an analytic function per vehicle per tick, which is not a budget worth defending.
 *
 * @param heightAt the terrain sampler
 * @param x world x of the vehicle centre
 * @param z world z of the vehicle centre
 * @param headingRad hull heading, so the grid aligns with the vehicle rather than the world axes
 * @param forwardHalfSpanM half the contact length, nose to tail
 * @param lateralHalfSpanM half the contact width, track to track
 */
export function solveGroundSupportPlane(
  heightAt: (x: number, z: number) => number,
  x: number,
  z: number,
  headingRad: number,
  forwardHalfSpanM: number,
  lateralHalfSpanM: number,
): GroundSupportPlane {
  const forwardX = sin(headingRad);
  const forwardZ = cos(headingRad);
  // The right axis, in the basis the renderer uses: local +X maps to (cos h, -sin h).
  const rightX = cos(headingRad);
  const rightZ = -sin(headingRad);

  let sumH = 0;
  let sumUH = 0;
  let sumVH = 0;
  let sumU2 = 0;
  let sumV2 = 0;
  const heights: { u: number; v: number; h: number }[] = [];

  for (const stepU of GRID_STEPS) {
    for (const stepV of GRID_STEPS) {
      const u = stepU * forwardHalfSpanM;
      const v = stepV * lateralHalfSpanM;
      const h = heightAt(x + forwardX * u + rightX * v, z + forwardZ * u + rightZ * v);
      heights.push({ u, v, h });
      sumH += h;
      sumUH += u * h;
      sumVH += v * h;
      sumU2 += u * u;
      sumV2 += v * v;
    }
  }

  const count = heights.length;
  const centreHeightM = sumH / count;
  // Denominators are fixed by the grid geometry, but are computed rather than inlined so the formula
  // stays the general least-squares solution and cannot silently disagree with the loop above it.
  const risePerMetreForward = sumU2 > 0 ? sumUH / sumU2 : 0;
  const risePerMetreRight = sumV2 > 0 ? sumVH / sumV2 : 0;

  let maxResidualAboveM = 0;
  let maxResidualBelowM = 0;
  for (const sample of heights) {
    // Height of the fitted plane here, which is not `centreHeightM` unless u and v are both zero.
    const planeHeight = centreHeightM + risePerMetreForward * sample.u + risePerMetreRight * sample.v;
    const residual = sample.h - planeHeight;

    if (residual > maxResidualAboveM) maxResidualAboveM = residual;
    if (-residual > maxResidualBelowM) maxResidualBelowM = -residual;
  }

  return {
    risePerMetreForward,
    risePerMetreRight,
    centreHeightM,
    maxResidualAboveM,
    maxResidualBelowM,
  };
}

/**
 * The hull pitch that presents this plane, in radians, for Babylon's `rotation.x`.
 *
 * ## The sign, derived once
 *
 * Babylon composes a node's rotation as `Ry(yaw) * Rx(pitch) * Rz(roll)`. Under that composition a
 * **positive** `rotation.x` swings the model's local `+Z` — its nose — *downward*, because `Rx` carries
 * `+Z` toward `-Y`. Nose-up therefore needs a negative pitch, so a plane rising toward the nose
 * (`risePerMetreForward > 0`) must produce a negative pitch:
 *
 * ```
 * pitch = -atan(risePerMetreForward)
 * ```
 *
 * The previous code negated the centre normal's forward component, which applies the negation twice: a
 * normal tilted back by a climb already has a **negative** forward component, so negating it produced a
 * positive pitch and drove the nose into the hill. Working from the plane's own gradient removes the
 * double negation, because a gradient's sign is the sign of the climb rather than the sign of the normal's
 * lean.
 */
export function groundSupportPitchRad(plane: GroundSupportPlane): number {
  return -atan(plane.risePerMetreForward);
}

/**
 * The hull roll that presents this plane, in radians, for Babylon's `rotation.z`.
 *
 * Under the same composition a **positive** `rotation.z` raises the model's local `+X`, which is the
 * vehicle's right-hand side. Ground rising toward the right should raise the right side, so the sign is
 * positive and no negation appears:
 *
 * ```
 * roll = atan(risePerMetreRight)
 * ```
 *
 * This was inverted alongside the pitch, through the same normal-projection route, and is fixed for the
 * same reason.
 */
export function groundSupportRollRad(plane: GroundSupportPlane): number {
  return atan(plane.risePerMetreRight);
}


