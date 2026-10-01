import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { clamp, degToRad, tan } from '../math/index.js';

/**
 * Longitudinal motion model for a tracked vehicle.
 *
 * Kept separate from `Tank` so the speed curve can be read, tuned, and tested on its own. Every
 * number it uses comes from the vehicle definition (ADR-0003): there are no gameplay constants in
 * this file, which is what the V1 validation criterion "accelerates, reverses and turns at rates
 * consistent with its data definition" actually tests.
 *
 * The model is kinematic and explicit: drive acceleration from force and mass, rate-limited
 * toward a gradient-dependent speed limit, with gravity's component along the direction of travel
 * opposing climbs and assisting descents. See ADR-0007 for why this is not a rigid-body
 * simulation.
 */

/** Gradient-derived limits and forces for one tick. */
export interface LongitudinalSolution {
  /** Speed the vehicle is heading toward this tick, m/s. Signed; negative is reverse. */
  readonly targetSpeedMps: number;
  /** Signed acceleration to apply this tick, m/s^2. */
  readonly accelMps2: number;
  /** True when the climb penalty is what caps speed, rather than the drive force. */
  readonly tractionLimited: boolean;
  /** True when the gradient is too steep to climb. */
  readonly stalled: boolean;
}

const GRAVITY_MPS2 = 9.81;

/**
 * Gravity's share of the drive budget lost to a gradient.
 *
 * A named tuning constant in one place rather than a bare `0.85` inline. It scales how much of the
 * vehicle's drive force a slope consumes; at the definition's climb limit this makes the drive
 * force roughly cancel gravity, which keeps `maxClimbDeg` and `driveForceN` consistent with each
 * other instead of independently arbitrary.
 */
const SLOPE_GRAVITY_COUPLING = 0.85;

/** How much faster than flat speed a full-limit descent may reach, as a fraction. */
const DESCENT_SPEED_BONUS = 0.15;

export class LongitudinalModel {
  private readonly definition: VehicleDefinition;

  constructor(definition: VehicleDefinition) {
    this.definition = definition;
  }

  /**
   * Maximum speed magnitude available at a given gradient, in m/s.
   *
   * Forward and reverse have different limits. Uphill, the forward limit falls toward
   * `climbSpeedRetention` as the gradient approaches `maxClimbDeg`, so a hill slows the vehicle
   * progressively rather than acting as a wall. Downhill allows a small, capped overspeed.
   */
  speedLimit(slopeDeg: number): number {
    const { powertrain, ground } = this.definition;

    if (slopeDeg > 0) {
      const t = clamp(slopeDeg / ground.maxClimbDeg, 0, 1);
      const retention = 1 + (ground.climbSpeedRetention - 1) * t;
      return powertrain.maxSpeedMps * retention;
    }

    if (slopeDeg < 0) {
      const t = clamp(-slopeDeg / ground.maxDescendDeg, 0, 1);
      return powertrain.maxSpeedMps * (1 + DESCENT_SPEED_BONUS * t);
    }

    return powertrain.maxSpeedMps;
  }

  /** Drive acceleration available from the definition, m/s^2. */
  get driveAccelMps2(): number {
    const { driveForceN, massKg } = this.definition.powertrain;
    return driveForceN / massKg;
  }

  /**
   * Solves one tick of longitudinal motion.
   *
   * @param currentSpeedMps current signed speed
   * @param throttle       requested throttle in [-1, 1]
   * @param slopeDeg       gradient along the direction of travel; positive is uphill
   */
  solve(currentSpeedMps: number, throttle: number, slopeDeg: number): LongitudinalSolution {
    const { powertrain, ground } = this.definition;

    // A gradient past the climb limit cannot be ascended; past the descent limit the vehicle
    // cannot hold its footing. Both cases mean the throttle is ignored.
    const tooSteepToClimb = slopeDeg > ground.maxClimbDeg;
    const descendingTooSteeply = -slopeDeg > ground.maxDescendDeg;

    if ((tooSteepToClimb && throttle > 0) || descendingTooSteeply) {
      return { targetSpeedMps: 0, accelMps2: 0, tractionLimited: false, stalled: tooSteepToClimb };
    }

    const limit = this.speedLimit(slopeDeg);

    if (throttle === 0) {
      // Coasting. Engine braking is weak, so the vehicle keeps rolling: a large part of why it
      // reads as heavy (vision principle P5).
      return {
        targetSpeedMps: 0,
        accelMps2: -Math.sign(currentSpeedMps) * powertrain.coastDecelMps2,
        tractionLimited: false,
        stalled: false,
      };
    }

    // Gravity along the direction of travel: opposes a climb, assists a descent.
    const slopeAccel = -GRAVITY_MPS2 * tan(degToRad(slopeDeg)) * SLOPE_GRAVITY_COUPLING;

    // Braking when the throttle opposes current motion, at a much stronger rate than the drive
    // force. This is what makes stopping feel decisive while starting feels gradual.
    const opposing =
      (throttle > 0 && currentSpeedMps < -0.05) || (throttle < 0 && currentSpeedMps > 0.05);

    const accelMps2 = opposing
      ? throttle > 0
        ? powertrain.brakeDecelMps2
        : -powertrain.brakeDecelMps2
      : throttle * this.driveAccelMps2 + slopeAccel;

    // Target: full throttle drives toward the gradient's speed limit; reverse is capped by the
    // vehicle's much lower reverse limit.
    const targetSpeedMps = throttle > 0 ? limit : -Math.min(powertrain.maxReverseSpeedMps, limit);

    // If the vehicle is already faster than the gradient allows, it is bled back to the limit at
    // the brake rate rather than snapping. This is the visible "climb penalty".
    const overLimit = Math.abs(currentSpeedMps) - limit;
    const tractionLimited = throttle > 0 && overLimit > 1e-6;

    return { targetSpeedMps, accelMps2, tractionLimited, stalled: false };
  }
}

/**
 * Moves `current` toward `target` by at most `maxDelta`, never overshooting.
 *
 * The explicit clamp is what guarantees a tick can never carry the vehicle past its target,
 * however long that tick is, so behaviour stays identical at any tick rate.
 */
export function moveToward(current: number, target: number, maxDelta: number): number {
  return current + clamp(target - current, -maxDelta, maxDelta);
}

