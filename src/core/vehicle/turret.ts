import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { type Vec3, vec3 } from '../../shared/vec3.js';
import { atan2, clamp, cos, degToRad, moveToward, radToDeg, sin, wrapAngle } from '../math/index.js';

/**
 * Turret and gun orientation.
 *
 * This is the model behind the requirement that **hull movement, turret aiming, gun orientation and
 * firing are separate systems**. The distinctions that matter:
 *
 *  - The **hull** is driven by the player and faces wherever it was last driven.
 *  - The **turret** is mounted on the hull and stores a *local* angle relative to it. Its world
 *    heading is therefore `hull heading + local angle`, which is why rotating the hull swings the gun
 *    with it — mechanically, not because anything is chasing the cursor.
 *  - The **gun** is mounted in the turret and stores an *elevation* relative to the turret's
 *    horizontal plane.
 *  - **Firing** is a separate request, and only the core decides whether it happens.
 *
 * The turret and gun are *servos*: given a world point they work out the bearing and elevation
 * themselves and rotate toward them at a limited rate. Nothing snaps. The player can drive one way,
 * aim another, and rotate the hull underneath a fixed aim point — and if they spin the hull fast
 * enough the turret genuinely cannot keep up and lags, which is the correct behaviour.
 */

/** Orientation state of a vehicle's turret and gun. */
export interface TurretState {
  /** Turret angle relative to the hull, radians. The turret's world heading is hull + this. */
  localAngleRad: number;
  /** Gun elevation relative to the turret's horizontal plane, radians. Positive is up. */
  elevationRad: number;
  /** Current turret traverse rate relative to the hull, degrees/second, signed. */
  traverseRateDegPerSec: number;
  /** Current gun elevation rate, degrees/second, signed. */
  elevateRateDegPerSec: number;
}

/** Creates a turret state pointing straight along the hull's nose. */
export function createTurretState(): TurretState {
  return {
    localAngleRad: 0,
    elevationRad: 0,
    traverseRateDegPerSec: 0,
    elevateRateDegPerSec: 0,
  };
}

/**
 * Servos the turret and gun toward an aim point.
 *
 * @param aimPoint world position to train on, or `null` to hold the current orientation
 */
export function updateTurret(
  state: TurretState,
  definition: VehicleDefinition,
  hullHeadingRad: number,
  trunnionPosition: Vec3,
  aimPoint: Vec3 | null,
  dtSeconds: number,
): void {
  const { turret, mainGun } = definition;

  if (aimPoint === null) {
    // No new aim request: bleed both rates to zero so the mechanisms settle where they are, rather
    // than continuing to slew at their last rate or drifting back to centre.
    //
    // This must *not* also run on a tick where the servo just acted. Decaying immediately after
    // servoing fights the ramp and leaves the turret creeping at a fraction of its rated speed.
    decayRate(state, 'traverseRateDegPerSec', turret.traverseAccelDegPerSec2, dtSeconds);
    decayRate(state, 'elevateRateDegPerSec', Number.POSITIVE_INFINITY, dtSeconds);
    return;
  }

  const dx = aimPoint.x - trunnionPosition.x;
  const dz = aimPoint.z - trunnionPosition.z;
  const dy = aimPoint.y - trunnionPosition.y;
  const horizontalM = Math.sqrt(dx * dx + dz * dz);

  // A point almost directly above or below the trunnion has an ill-defined bearing, so horizontal
  // aim is left alone in that case rather than snapping to an arbitrary direction.
  if (horizontalM > MIN_BEARING_DISTANCE_M) {
    // Heading is measured from +Z toward +X, matching the hull's convention.
    const desiredWorldHeadingRad = atan2(dx, dz);
    const desiredLocalRad = clamp(
      wrapAngle(desiredWorldHeadingRad - hullHeadingRad),
      -degToRad(turret.maxTraverseDeg),
      degToRad(turret.maxTraverseDeg),
    );
    servoAngle(
      state,
      'localAngleRad',
      'traverseRateDegPerSec',
      desiredLocalRad,
      turret.traverseDegPerSec,
      turret.traverseAccelDegPerSec2,
      dtSeconds,
    );
  }

  if (horizontalM > 0) {
    // `atan2` rather than `atan` of a ratio: `atan` is not permitted in the core because it is not
    // guaranteed identical across engines (ADR-0005), and `atan2` from the core trig module is. The
    // two-argument form is also better behaved here, since it stays correct for a target far overhead.
    const clampedElevation = clamp(
      atan2(dy, horizontalM),
      -degToRad(mainGun.maxDepressionDeg),
      degToRad(mainGun.maxElevationDeg),
    );
    servoAngle(
      state,
      'elevationRad',
      'elevateRateDegPerSec',
      clampedElevation,
      mainGun.elevateRateDegPerSec,
      // The elevation gear reaches its rate limit instantly. A separate acceleration parameter would
      // be one more number to tune with no gameplay consequence at V2, and the rate limit alone
      // already makes the barrel move like a mechanism rather than snap.
      Number.POSITIVE_INFINITY,
      dtSeconds,
    );
  }
}

/**
 * Rotates one angle toward a target at a rate limit, ramping the rate up and down.
 *
 * Shared by traverse and elevation so both behave identically, which is what makes the vehicle feel
 * like one machine rather than two.
 */
function servoAngle(
  state: TurretState,
  angleKey: 'localAngleRad' | 'elevationRad',
  rateKey: 'traverseRateDegPerSec' | 'elevateRateDegPerSec',
  targetRad: number,
  maxRateDegPerSec: number,
  accelDegPerSec2: number,
  dtSeconds: number,
): void {
  const currentRad = state[angleKey];
  const remainingDeg = radToDeg(wrapAngle(targetRad - currentRad));
  const remaining = Math.abs(remainingDeg);

  // Two separate limits, and both are needed.
  //
  // `rateForDistanceDeg` is the obvious one: never move further in a tick than the distance left,
  // or the mechanism steps past its target. That alone is not enough, because the *rate itself* is
  // ramped, so the turret needs room to slow down as well. Limiting only by distance makes the
  // turret arrive at full speed, sail past the target, and then hunt back and forth around it.
  //
  // `rateForStoppingDeg` is the missing half: the fastest rate from which the mechanism can still
  // decelerate to rest exactly at the target, which for constant deceleration is the square root of
  // twice the deceleration times the distance remaining. This is what makes the approach settle
  // instead of oscillating.
  const rateForDistanceDeg = remaining / Math.max(dtSeconds, 1e-6);
  const rateForStoppingDeg = Number.isFinite(accelDegPerSec2)
    ? Math.sqrt(2 * accelDegPerSec2 * remaining)
    : Number.POSITIVE_INFINITY;

  const desiredRateDeg =
    Math.sign(remainingDeg) * Math.min(maxRateDegPerSec, rateForDistanceDeg, rateForStoppingDeg);

  let rate = state[rateKey];
  if (Number.isFinite(accelDegPerSec2)) {
    rate = moveToward(rate, desiredRateDeg, accelDegPerSec2 * dtSeconds);
  } else {
    rate = desiredRateDeg;
  }
  state[rateKey] = rate;

  state[angleKey] = currentRad + degToRad(rate) * dtSeconds;
}

/** Bleeds a rate back toward zero, so the mechanism settles when the input stops. */
function decayRate(
  state: TurretState,
  rateKey: 'traverseRateDegPerSec' | 'elevateRateDegPerSec',
  accelDegPerSec2: number,
  dtSeconds: number,
): void {
  const rate = state[rateKey];
  if (Math.abs(rate) < 1e-6) {
    state[rateKey] = 0;
    return;
  }
  // An infinite acceleration means "stop now", which is what an instant-rate mechanism should do.
  const maxDelta = Number.isFinite(accelDegPerSec2) ? accelDegPerSec2 * dtSeconds : Math.abs(rate);
  state[rateKey] = moveToward(rate, 0, maxDelta);
}

/**
 * The gun's world-space direction, from the turret heading and the gun elevation.
 *
 * Assembled from the vehicle's own basis so the barrel and the projectile can never disagree about
 * which way the gun is pointing.
 */
export function gunDirection(state: TurretState, hullHeadingRad: number): Vec3 {
  const worldHeadingRad = hullHeadingRad + state.localAngleRad;
  const horizontal = cos(state.elevationRad);
  return vec3(
    sin(worldHeadingRad) * horizontal,
    sin(state.elevationRad),
    cos(worldHeadingRad) * horizontal,
  );
}

/** The gun's world heading, ignoring elevation. Used for the HUD and by V5 AI. */
export function gunHeadingRad(state: TurretState, hullHeadingRad: number): number {
  return wrapAngle(hullHeadingRad + state.localAngleRad);
}

/** The gun's elevation in degrees, for the HUD and by V5 AI. */
export function gunElevationDeg(state: TurretState): number {
  return radToDeg(state.elevationRad);
}

/**
 * Below this horizontal distance the aim point is too close for a meaningful bearing.
 *
 * Prevents the turret spinning wildly when the cursor lands on the vehicle's own roof.
 */
const MIN_BEARING_DISTANCE_M = 0.75;

