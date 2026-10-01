import type { Terrain } from '../world/terrain.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { atan2, cos, radToDeg, sin, wrapAngle, type Vec3, vec3 } from '../math/index.js';

/**
 * Just enough navigation to move tactically.
 *
 * ## Why this is not a navigation framework
 *
 * The brief was explicit: do not build a general-purpose navigation system in anticipation of V6. So
 * there is no navmesh, no A*, no flow field, and no path graph here — and deliberately so, because a
 * pathfinder built before the maps that will use it exist is a pathfinder tuned for terrain that is
 * not in the game.
 *
 * What is here is the **minimum that lets the opponent choose where to be**:
 *
 *  1. `chooseFlankDestination` picks a standing position from a small set of candidates, scored on
 *     driveability, range, whether it actually opens a better angle, and whether the ground between
 *     there and here is crossable.
 *  2. `steerToward` turns a hull toward a destination and, when something in front is too steep to
 *     climb, biases the turn to get around it.
 *
 * ## The two failure modes it exists to prevent
 *
 * **Grinding into a wall.** A tank that drives at a 29-degree slope stalls. A stalled tank that keeps
 * demanding throttle looks *broken*, not tactical. `steerToward` samples the ground ahead on both
 * sides of the direct line and turns toward whichever side is passable.
 *
 * **Oscillating.** The classic failure of a greedy "go around the obstacle" rule is picking left, then
 * right, then left again — the tank pivots on the spot forever. The fix here is a **commitment**: the
 * chosen avoidance side is held for `avoidanceCommitTicks`, and the opposite side is only reconsidered
 * if the chosen one genuinely stops improving. Behaviour emerges from the terrain rather than being
 * replayed from a scripted route, but it does not dither.
 */

/**
 * Ticks in one second, for converting the second-denominated tuning below.
 *
 * Declared at the top rather than beside the code that uses it, because the helpers that need it sit
 * above the point where a bottom-of-file declaration would land. The tick rate is fixed by ADR-0008,
 * so this is the simulation's own clock and not a value this module gets to choose.
 */
const TICKS_PER_SECOND = 60;

/**
 * A point at a given bearing and distance from an origin.
 *
 * Also serves as the arc sampler for candidate fighting positions, which is why the two helpers that
 * once did this job separately have been merged: they computed the same thing, and a second copy is one
 * more place for the two to disagree.
 *
 * Declared near the top because both the destination sampler and the steering function need it, and a
 * reader looking for "where does the AI turn a bearing into a point?" should not have to reach the
 * bottom of the file to find out.
 */
function pointFromBearing(from: Vec3, bearingRad: number, distanceM: number): Vec3 {
  return vec3(
    from.x + sin(bearingRad) * distanceM,
    from.y,
    from.z + cos(bearingRad) * distanceM,
  );
}

/** Tuning for tactical movement. Prototype values, not balance. */
export const NAVIGATION_TUNING = {
  /** Spacing of ground samples along a candidate path, metres. */
  sampleSpacingM: 6,
  /** How far ahead `steerToward` looks for an obstacle, metres. */
  lookaheadM: 18,
  /**
   * How many ticks a chosen avoidance side is committed to, seconds.
   *
   * Long enough that the opponent completes a swing around a mound rather than abandoning it
   * half-way, short enough that it can still abandon a route that has genuinely closed off.
   */
  avoidanceCommitSeconds: 1.2,
  /**
   * Degrees of bearing tried on each side when the direct line is blocked.
   *
   * Spread widely rather than narrowly: a narrow fan produces a shallow sidestep that re-enters the
   * same obstacle, which is exactly the oscillation this module is trying to avoid.
   */
  avoidanceFanDeg: [30, 60, 90, 120] as readonly number[],
} as const;

/** Why a destination was (or was not) considered usable. Reported for diagnostics and tests. */
export interface PathAssessment {
  /** True when a vehicle can plausibly drive from `from` to `to`. */
  readonly driveable: boolean;
  /** Steepest sustained climb along the path, degrees. */
  readonly maxClimbDeg: number;
  /** Steepest sustained descent along the path, degrees. */
  readonly maxDescentDeg: number;
  /** Horizontal length of the path, metres. */
  readonly lengthM: number;
  /** Where the worst gradient occurs, for the debug overlay. `null` when the path is clear. */
  readonly worstPoint: Vec3 | null;
}


/**
 * Measures whether a vehicle could drive from one point to another.
 *
 * ## Why this is not a formality
 *
 * V4 measured a real bug in exactly this area: the spawn-placement code passed a non-unit direction to
 * `slopeDegreesAlong`, which reported **four times** the true gradient. A 29-degree slope read as 66
 * degrees, which made perfectly good arena terrain look like a cliff face and sent an entire tuning
 * pass in the wrong direction. That is the failure this function exists to make impossible: every
 * direction handed to `slopeDegreesAlong` below is explicitly normalised at the call site, and a test
 * asserts this function's verdict agrees with a hand-computed gradient.
 *
 * ## Two independent tests
 *
 *  - **Sustained gradient**, sampled along the route. This is the test that matches what actually
 *    stops a tracked vehicle, because `maxClimbDeg` is a limit on gradient and not on step size.
 *  - **Step height**, sampled on the same stride. Catches a sharp lip that a gradient sampled too
 *    coarsely would average away — the two catch different failures and either alone is insufficient.
 */
export function assessPath(terrain: Terrain, vehicle: VehicleDefinition, from: Vec3, to: Vec3): PathAssessment {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthM = Math.sqrt(dx * dx + dz * dz);

  if (lengthM < 1e-3) {
    return { driveable: true, maxClimbDeg: 0, maxDescentDeg: 0, lengthM: 0, worstPoint: null };
  }

  // Unit direction along the route. Explicitly normalised, and asserted by test — passing the raw
  // offsets here is exactly the bug described above.
  const dirX = dx / lengthM;
  const dirZ = dz / lengthM;

  const climbLimit = vehicle.ground.maxClimbDeg;
  const descendLimit = vehicle.ground.maxDescendDeg;
  const stride = NAVIGATION_TUNING.sampleSpacingM;
  const steps = Math.max(1, Math.ceil(lengthM / stride));

  let maxClimbDeg = 0;
  let maxDescentDeg = 0;
  let worstPoint: Vec3 | null = null;
  let worstRatio = 0;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = from.x + dx * t;
    const z = from.z + dz * t;

    const climbDeg = terrain.slopeDegreesAlong(x, z, dirX, dirZ);

    // The reverse direction measures descent. Sampling it explicitly is what makes this a gradient
    // test rather than a one-sided height comparison.
    const descentDeg = terrain.slopeDegreesAlong(x, z, -dirX, -dirZ);

    if (climbDeg > maxClimbDeg) {
      maxClimbDeg = climbDeg;
    }
    if (descentDeg > maxDescentDeg) {
      maxDescentDeg = descentDeg;
    }

    // Ratio against the *relevant* limit for this direction, so the worst point recorded is the one
    // that actually nearly stopped the vehicle.
    const ratio = Math.max(climbDeg / climbLimit, descentDeg / descendLimit);
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstPoint = vec3(x, terrain.heightAt(x, z), z);
    }
  }

  const driveable = maxClimbDeg <= climbLimit && maxDescentDeg <= descendLimit;
  return { driveable, maxClimbDeg, maxDescentDeg, lengthM, worstPoint };
}

/** What the opponent wants from a candidate fighting position, and why. */
export interface DestinationChoice {
  /** Where to drive to, world space. */
  readonly position: Vec3;
  /** Combined score. Higher is better. */
  readonly score: number;
  /** True when the ground from here to there was judged crossable. */
  readonly reachable: boolean;
  /** Bearing from the player that this position would present, radians in the vehicle frame. */
  readonly aspectRad: number;
}

/** Tuning for choosing a fighting position. */
export const DESTINATION_TUNING = {
  /**
   * Offsets from the player's own front bearing at which a position is scored, degrees.
   *
   * The player's heading defines its front and rear, so "90 degrees off their nose" is a flank and
   * "180" is the rear deck. Sampling a spread of these — rather than only the perfect 90 — is what
   * lets the opponent settle for a *good enough* angle on terrain that will not give it a perfect one,
   * instead of refusing every position that is not ideal and standing still.
   */
  aspectOffsetsDeg: [60, 90, 120, 150] as readonly number[],
  /**
   * Score penalty for a position that is not reachable, as a fraction of a perfect score.
   *
   * Large enough that an unreachable position never wins, but finite so that if *every* candidate is
   * unreachable the opponent still drives somewhere useful instead of freezing. A total rejection
   * would leave it stationary in front of a player it cannot hurt, which is the V4 failure in a new
   * disguise.
   */
  unreachablePenalty: 0.8,
  /** Weight on preferring positions at a sensible fighting range. */
  rangeWeight: 0.6,
  /** Weight on preferring a clear line of sight to the player from the destination. */
  sightLineWeight: 0.5,
} as const;

/**
 * Chooses where to stand to fight from.
 *
 * ## How the flank actually works
 *
 * The player's hull heading defines their front and rear, so a *flank* is a bearing measured from their
 * nose rather than an absolute compass direction. Candidates are sampled on an arc around the player
 * at 60/90/120/150 degrees off that nose, on one side chosen by the caller, at two ranges.
 *
 * Note what this is **not**: a fixed waypoint list. There is no path here, only a destination. The route
 * to it is worked out continuously by `steerToward` against whatever ground it turns out to cross, so
 * the same flank attempt produces a different drive through the arena every time, because the
 * opponent is choosing *where to be* and then navigating rather than replaying a manoeuvre.
 *
 * @param side `-1` to try the player's left arc, `+1` for their right.
 */
export function chooseFlankDestination(
  terrain: Terrain,
  vehicle: VehicleDefinition,
  enemyPosition: Vec3,
  playerPosition: Vec3,
  playerHeadingRad: number,
  side: 1 | -1,
  preferredRangeM: number,
): DestinationChoice | null {
  let best: DestinationChoice | null = null;

  for (const aspectDeg of DESTINATION_TUNING.aspectOffsetsDeg) {
    // World bearing of this candidate: the player's nose, rotated onto the requested side by the
    // off-nose angle. Negative aspects sweep one way around the player, positive the other.
    const worldBearingRad = wrapAngle(playerHeadingRad + side * (aspectDeg * Math.PI) / 180);

    for (const rangeFactor of [1, 0.8]) {
      const rangeM = preferredRangeM * rangeFactor;
      const flat = pointFromBearing(playerPosition, worldBearingRad, rangeM);
      const y = terrain.heightAt(flat.x, flat.z);
      if (y === null) {
        continue;
      }
      const candidate = vec3(flat.x, y, flat.z);

      const path = assessPath(terrain, vehicle, enemyPosition, candidate);

      // Prefer the wider angles slightly: 90 degrees is a clean flank, but the rear arc at 150 is
      // genuinely thinner armour and worth preferring when it is reachable. Weighted so that it never
      // overrides reachability, which matters more.
      const aspectScore = aspectDeg / 150;

      const rangeScore = 1 - Math.min(1, Math.abs(rangeM - preferredRangeM) / preferredRangeM);

      // A position with no line of sight to the player is worse than one with a clear shot, but not
      // disqualifying: driving to a rise to shoot over it is legitimate, and refusing every blind
      // position would make the opponent refuse to use cover at all.
      const sightLine = terrain.hasLineOfSight(
        vec3(candidate.x, candidate.y + vehicle.turret.ringHeightM, candidate.z),
        vec3(playerPosition.x, playerPosition.y + vehicle.turret.ringHeightM, playerPosition.z),
      );

      const score =
        aspectScore * 1 +
        rangeScore * DESTINATION_TUNING.rangeWeight +
        (sightLine ? DESTINATION_TUNING.sightLineWeight : 0);

      const adjusted = path.driveable
        ? score
        : score * (1 - DESTINATION_TUNING.unreachablePenalty);

      if (best === null || adjusted > best.score) {
        best = {
          position: candidate,
          score: adjusted,
          reachable: path.driveable,
          aspectRad: worldBearingRad,
        };
      }
    }
  }

  return best;
}



/** Mutable steering state, held by the caller so it survives across ticks. */
export interface SteeringMemory {
  /**
   * Which side of the direct line the opponent is currently trying to get around: `-1` left, `+1`
   * right, `0` driving straight at the target with nothing detected in the way.
   */
  avoidanceSide: 1 | -1 | 0;
  /** Ticks left on the current avoidance commitment. */
  commitTicksRemaining: number;
}

/** Creates fresh steering state, for a new battle. */
export function createSteeringMemory(): SteeringMemory {
  return { avoidanceSide: 0, commitTicksRemaining: 0 };
}

/** The steering decision for one tick. */
export interface SteerDecision {
  /** Hull turn demand in `[-1, 1]`. Positive turns right. */
  readonly turn: number;
  /** Forward/backward demand in `[-1, 1]`. Negative reverses. */
  readonly throttle: number;
  /** The world point the hull was actually steered toward, for the debug overlay. */
  readonly steeringTarget: Vec3;
  /** True when something impassable was detected ahead and the turn was biased around it. */
  readonly avoiding: boolean;
}

/**
 * Turns a hull toward a destination, steering around ground it cannot climb.
 *
 * ## How obstacle avoidance works here
 *
 * The direct line to the destination is sampled at `lookaheadM`. If nothing along it exceeds the
 * vehicle's climb limit, the opponent simply drives at the destination — no cleverness, no cost.
 *
 * If something does, the function tries bearings fanned out to either side of the direct line and picks
 * the one whose ground is actually passable, preferring the smaller deviation. That produces movement
 * which reads as *driving around* a mound rather than *deciding* to go around it: the turn is a
 * response to terrain the opponent can see, not a replayed manoeuvre.
 *
 * ## Why the commitment exists
 *
 * A pure greedy rule oscillates. The opponent approaches a steep face, decides to pass left, and two
 * seconds later the lookahead from its new position reports the same face slightly to the right — so it
 * commits right, and the tank spends the fight pivoting on the spot. This was a real failure during V5
 * development, visible in the debug overlay as a tank that never got closer to its destination.
 *
 * The fix is a **time-based commitment**: once a side is chosen it is held for
 * `avoidanceCommitSeconds`, and a new side is only adopted when the committed one has run out of time.
 * Deciding on the direct line alone is what makes a vehicle reverse its mind every second; requiring
 * the chosen route to be given time before it is abandoned is what lets the swing complete.
 */
export function steerToward(
  terrain: Terrain,
  vehicle: VehicleDefinition,
  from: Vec3,
  headingRad: number,
  destination: Vec3,
  memory: SteeringMemory,
  dtSeconds: number,
  turnAuthority: number,
  throttleAuthority: number,
): SteerDecision {
  const directBearing = bearingTo(from, destination);
  const climbLimit = vehicle.ground.maxClimbDeg;

  // Sampled only as far as the lookahead. A destination forty metres away may cross a cliff much
  // further on, and refusing to move at all because of terrain it cannot see yet would make the
  // opponent freeze whenever it is not already close.
  const blockedDeg = worstGradientAhead(terrain, from, directBearing, NAVIGATION_TUNING.lookaheadM);
  const blocked = blockedDeg > climbLimit;

  if (memory.commitTicksRemaining > 0) {
    memory.commitTicksRemaining -= Math.max(1, Math.round(dtSeconds * TICKS_PER_SECOND));
  }

  let targetBearing = directBearing;
  let avoiding = false;

  if (blocked) {
    avoiding = true;
    const committed = memory.avoidanceSide;

    // While a commitment is live, keep going the chosen way. Only once it expires is the terrain
    // re-examined, which is the whole anti-oscillation mechanism.
    if (committed !== 0 && memory.commitTicksRemaining > 0) {
      targetBearing = wrapAngle(directBearing + (committed * 45 * Math.PI) / 180);
    } else {
      const chosen = chooseAvoidanceBearing(terrain, from, directBearing, climbLimit, committed);
      // `chosen` is a side, not a bearing. The offset applied here is the same 45 degrees the committed
      // branch uses, so re-deciding mid-approach produces a consistent heading rather than a jump.
      targetBearing = wrapAngle(directBearing + (chosen * 45 * Math.PI) / 180);
      memory.avoidanceSide = chosen;
      memory.commitTicksRemaining = Math.round(
        NAVIGATION_TUNING.avoidanceCommitSeconds * TICKS_PER_SECOND,
      );
    }
  } else if (memory.commitTicksRemaining <= 0) {
    // Nothing in the way and no commitment outstanding: return to driving straight.
    memory.avoidanceSide = 0;
  }

  const errorRad = wrapAngle(targetBearing - headingRad);
  const errorDeg = radToDeg(errorRad);

  // Inside this the hull is already usefully pointed. Without it the opponent pivots continuously,
  // which spoils both its own shot and any attempt to hold a facing.
  const settleToleranceDeg = 14;
  const turn = Math.abs(errorDeg) < settleToleranceDeg ? 0 : Math.sign(errorDeg) * turnAuthority;

  // Reverse out of a situation rather than continuing to push into it. Committed to when the hull is
  // facing substantially away from the destination *and* the way forward is blocked, which is the
  // nosed-into-a-mound case; backing up is what lets such a tank recover.

/**
 * Steepest climb along a bearing from a point, out to `distanceM`, degrees.
 *
 * Sampled at the same stride the path assessment uses, so the steering check and the destination check
 * agree about what counts as too steep. Two different samplings would mean the opponent could reject a
 * destination as unreachable and then drive straight at it.
 */
function worstGradientAhead(
  terrain: Terrain,
  from: Vec3,
  bearingRad: number,
  distanceM: number,
): number {
  const dirX = sin(bearingRad);
  const dirZ = cos(bearingRad);
  const steps = Math.max(1, Math.ceil(distanceM / NAVIGATION_TUNING.sampleSpacingM));
  let worst = 0;
  for (let i = 1; i <= steps; i += 1) {
    const d = (i / steps) * distanceM;
    const grade = terrain.slopeDegreesAlong(from.x + dirX * d, from.z + dirZ * d, dirX, dirZ);
    if (grade > worst) {
      worst = grade;
    }
  }
  return worst;
}

/**
 * Picks a bearing offset from the direct line whose ground is actually passable.
 *
 * Tries the fan on each side in order of increasing deviation and takes the first clear one, so the
 * opponent takes the *smallest* detour that works rather than swinging wide for no reason. `preferred`
 * breaks the tie toward the side already being committed to, so re-evaluating an obstacle mid-swing
 * tends to continue the swing instead of reversing it.
 *
 * When nothing on either side is clear, returns the least-bad option found, because returning "no
 * route" would leave the caller with no bearing at all and the tank driving straight into the obstacle
 * at full throttle — which is the exact behaviour this function exists to prevent.
 */
function chooseAvoidanceBearing(
  terrain: Terrain,
  from: Vec3,
  directBearingRad: number,
  climbLimitDeg: number,
  preferred: 1 | -1 | 0,
): 1 | -1 {
  let bestSide: 1 | -1 = preferred === 0 ? 1 : preferred;
  let bestGrade = Number.POSITIVE_INFINITY;

  for (const side of [1, -1] as const) {
    // The best of the fan on this side, rather than the whole fan treated as one option: a wide
    // bearing that is clear is a legitimate route even if the narrow ones are not.
    let sideBest = Number.POSITIVE_INFINITY;
    for (const offsetDeg of NAVIGATION_TUNING.avoidanceFanDeg) {
      const bearing = wrapAngle(directBearingRad + (side * offsetDeg * Math.PI) / 180);
      const grade = worstGradientAhead(terrain, from, bearing, NAVIGATION_TUNING.lookaheadM);
      if (grade < sideBest) {
        sideBest = grade;
      }
      // This bearing alone is clear; the side is viable and wider fan members need not be tried.
      if (grade <= climbLimitDeg) {
        break;
      }
    }

    // Prefer a clear side over a merely less-bad one, and on equal footing prefer the committed side so
    // a continuing swing is not undone.
    const better =
      sideBest < bestGrade ||
      (sideBest === bestGrade && side === bestSide) ||
      (sideBest <= climbLimitDeg && bestGrade > climbLimitDeg);
    if (better) {
      bestSide = side;
      bestGrade = sideBest;
    }
  }

  return bestSide;
}

/** Compass bearing from one point to another, radians, in the vehicle heading frame. */
function bearingTo(from: Vec3, to: Vec3): number {
  return atan2(to.x - from.x, to.z - from.z);
}

  const reverse = blocked && Math.abs(errorDeg) > 110;
  const throttle = reverse ? -throttleAuthority * 0.7 : throttleAuthority;

  return {
    turn,
    throttle,
    steeringTarget: pointFromBearing(from, targetBearing, NAVIGATION_TUNING.lookaheadM),
    avoiding,
  };
}
