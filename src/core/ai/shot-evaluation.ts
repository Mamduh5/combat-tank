import type { ArmorMount, VehicleDefinition } from '../../shared/vehicle-definition.js';
import { normalize, type Vec3, vec3 } from '../../shared/vec3.js';
import { acos, radToDeg } from '../math/index.js';
import { GRAVITY_MPS2 } from '../ballistics/shell.js';
import { resolvePenetration } from '../armor/penetration.js';
import type { WorldPlate } from '../armor/geometry.js';

/**
 * Predicting whether a shot would work, before taking it.
 *
 * ## The capability V4 lacked
 *
 * V4's opponent aimed at the middle of the player's hull and fired when its turret was roughly lined
 * up. It had no idea whether the shot would penetrate. When a player parked and presented a 200 mm
 * frontal plate pitched at 60 degrees — roughly 400 mm of effective armour against a 150 mm shell —
 * the opponent emptied its magazine into an invulnerable surface and concluded nothing. This module
 * is the answer: **it asks the same penetration model the simulation will ask, one tick early.**
 *
 * ## The single most important design decision here
 *
 * The estimate uses `resolvePenetration` — the real function, with the real shell and the real model.
 * It does not reimplement the armour maths, approximate it, or keep a private copy of the rules that
 * could drift from the ones actually applied.
 *
 * That is what makes the AI's belief *correct by construction*. When the V3 penetration tests change,
 * the opponent's behaviour changes with them, and no tuning pass has to remember to update a second
 * implementation. A duplicated "roughly the same" formula in the AI would be the single most likely
 * place for the opponent and the simulation to quietly disagree about what armour does.
 *
 * ## What it is allowed to know — and what it is not
 *
 * The brief is explicit that this must not become supernatural knowledge. So the estimate is built
 * from what a crew could actually work out:
 *
 *  - **Visible plates only.** Every plate is tested against terrain line of sight from the gun, so a
 *    plate behind a hill is not a candidate and the AI never "knows" about armour it cannot see.
 *  - **A real incidence angle**, computed from the plate's actual world normal.
 *  - **An estimated impact speed**, derived from muzzle velocity, range and gravity drop.
 *  - **Its own shell's numbers**, which it genuinely carries.
 *
 * What it cannot know, and what the design deliberately withholds:
 *
 *  - **The player's exact aim scatter, turret position this instant, or how far the player is about to
 *    move.** The estimate is of a shot taken *now* at a target that may move.
 *  - **Whether a module behind a plate is already destroyed.** It reasons about plates, not modules.
 *
 * It is also given a **deliberate pessimism margin**. The opponent must be *confident* a shot will
 * work before it wastes a five-second reload on it. That margin is why it moves rather than shooting
 * at armour it could not beat anyway — which is precisely the behaviour the owner asked for, arrived at
 * by making the AI a better shot-planner rather than by weakening a single millimetre of armour.
 */

/** How a single plate looks as a target, from one firing position. */
export interface PlateAssessment {
  /** The plate's definition id, for diagnostics and tests. */
  readonly plateId: string;
  /** Region label such as `hull-front` or `turret-side`, carried through from the definition. */
  readonly region: string;
  /** Whether the plate follows the hull or the turret. */
  readonly mount: ArmorMount;
  /** True when terrain line of sight reaches this plate from the gun. */
  readonly visible: boolean;
  /** Angle between the shot and the plate normal, degrees. Zero is square on. */
  readonly incidenceAngleDeg: number;
  /** Armour this plate presents at that angle, mm. */
  readonly effectiveArmorMm: number;
  /** Estimated capability of the shell at that angle and range, mm. */
  readonly estimatedPenetrationMm: number;
  /**
   * Capability minus resistance, mm.
   *
   * Negative means the shot would be stopped. This is the number the tactical layer reasons about.
   */
  readonly marginMm: number;
  /**
   * True when the estimate says the shell gets through with margin to spare.
   *
   * Requires clearing the pessimism margin as well as the armour itself, so a technically-positive but
   * marginal shot is treated as not worth taking.
   */
  readonly predictedPenetration: boolean;
  /** Range from the gun to this plate, metres. */
  readonly rangeM: number;
}

/** Tuning for shot prediction. Prototype values, not balance. */
export const SHOT_EVALUATION_TUNING = {
  /**
   * Extra millimetres of armour the opponent assumes it must beat before committing to a shot, mm.
   *
   * The pessimistic bias that turns "can I?" into "am I confident?". A shot predicted to beat armour
   * by 2 mm is, in reality, a coin flip once a moving target and the opponent's own aim scatter are
   * accounted for — and a coin flip costs a five-second reload every time. Requiring a real surplus is
   * what makes the opponent *stop wasting shots* and start moving.
   *
   * Sized against the prototype armour step: the player's flank is 60 mm against 150 mm of penetration
   * (a ~90 mm surplus), while the frontal plate presents ~400 mm (a ~250 mm deficit). A margin well
   * below 90 and well above 0 separates "worth shooting" from "hopeless" cleanly at these values.
   */
  safetyMarginMm: 25,
} as const;

/**
 * Estimates the outcome of firing at one plate from a given eye position.
 *
 * @param eye where the gun is, world space
 * @param plate the target plate, already transformed to world space
 * @param shooter the firing vehicle, for its shell and penetration model
 * @param visible whether terrain line of sight reaches the plate from the gun
 */
export function assessPlate(
  eye: Vec3,
  plate: WorldPlate,
  shooter: VehicleDefinition,
  visible: boolean,
): PlateAssessment {
  const rangeM = distance(eye, plate.center);
  const direction = normalize(
    vec3(plate.center.x - eye.x, plate.center.y - eye.y, plate.center.z - eye.z),
  );

  const incidenceAngleDeg = incidenceBetween(direction, plate.normal);
  const impactSpeedMps = estimateImpactSpeed(shooter.mainShell.muzzleVelocityMps, rangeM);

  const result = resolvePenetration(
    shooter.mainShell,
    shooter.penetration,
    plate.definition.thicknessMm,
    incidenceAngleDeg,
    impactSpeedMps,
  );

  const marginMm = result.penetrationMarginMm;

  return {
    plateId: plate.definition.id,
    region: plate.definition.region,
    mount: plate.definition.mount,
    visible,
    incidenceAngleDeg,
    effectiveArmorMm: result.effectiveArmorMm,
    estimatedPenetrationMm: result.shellPenetrationMm,
    marginMm,
    // A ricochet is not a marginal penetration, it is a guaranteed miss: the shell never enters.
    predictedPenetration:
      result.outcome === 'penetrated' && marginMm >= SHOT_EVALUATION_TUNING.safetyMarginMm,
    rangeM,
  };
}

/**
 * Estimated shell speed on arrival at a target `rangeM` away.
 *
 * Gravity costs a firing shell speed on the way down, and the penetration model scales capability by
 * arrival speed, so a long shot penetrates less than a short one from the same gun. Ignoring that
 * would make the opponent systematically over-confident at range — it would commit to shots that arrive
 * a little too slow to beat the armour it calculated against.
 *
 * Solved from the vertical component alone, which is where essentially all of the loss is:
 *
 * ```text
 *   time   ≈ range / v_horizontal
 *   v_vert  = -g · time          (gravity acting for that long)
 *   speed   = √(v_horizontal² + v_vert²)
 * ```
 *
 * Deliberately **not** a ballistics simulation. A lobbed shot spends longer in the air than a flat one
 * and therefore loses more, and modelling the full arc would mean duplicating the shell integrator — the
 * exact reimplementation this module exists to avoid. The estimate errs slightly optimistic for very
 * high-elevation shots, which is safe here because the safety margin absorbs it and because the
 * opponent re-evaluates every tick rather than committing to a plan.
 */
export function estimateImpactSpeed(muzzleVelocityMps: number, rangeM: number): number {
  const vHorizontal = Math.max(1, muzzleVelocityMps);
  const timeSeconds = Math.max(0, rangeM) / vHorizontal;
  const vVertical = -GRAVITY_MPS2 * timeSeconds;
  return Math.sqrt(vHorizontal * vHorizontal + vVertical * vVertical);
}

/**
 * Angle of arrival relative to a surface normal, degrees, matching the impact record's convention.
 *
 * Distinct from `computeIncidenceAngleDeg` only in taking a *direction toward the target* rather than a
 * measured incoming direction. The convention — the negated travel direction against the normal — is
 * identical, and a test asserts the two agree for a directly opposed shot.
 */
function incidenceBetween(directionToTarget: Vec3, normal: Vec3): number {
  // The shell travels along `-directionToTarget`, so the incidence angle is between the reversed
  // direction and the outward normal. The dot of a negated vector is just the negated dot.
  const cosTheta =
    -(directionToTarget.x * normal.x +
      directionToTarget.y * normal.y +
      directionToTarget.z * normal.z);
  // Clamped because a plate exactly edge-on gives cos = 0, and floating-point error can push a hair
  // past it, which would ask acos for an argument outside its domain.
  const clamped = cosTheta < -1 ? -1 : cosTheta > 1 ? 1 : cosTheta;
  return radToDeg(acos(clamped));
}

/**
 * The best predicted shot among the plates assessed, or `null` when none is worth taking.
 *
 * Ranking is by **margin**, not by raw armour. Margin is the honest measure of "how likely is this to
 * work": a thin plate met at a savage angle can present more effective armour than a thick plate met
 * nearly square, and the opponent has to make that trade the same way the simulation will.
 */
export function bestPredictedShot(
  assessments: readonly PlateAssessment[],
): PlateAssessment | null {
  let best: PlateAssessment | null = null;
  for (const assessment of assessments) {
    if (!assessment.visible || !assessment.predictedPenetration) {
      continue;
    }
    if (best === null || assessment.marginMm > best.marginMm) {
      best = assessment;
    }
  }
  return best;
}

/**
 * The best margin among visible plates, whether or not it is predicted to penetrate.
 *
 * Used to answer "is this engagement worth continuing at all?" — a negative best margin means the
 * opponent currently has *no* viable option against the player's current facing, which is the trigger
 * for repositioning. Returns `-Infinity` when the player cannot be seen at all, so an unseen target
 * never looks like a hopeless-but-visible one.
 */
export function bestVisibleMarginMm(assessments: readonly PlateAssessment[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const assessment of assessments) {
    if (!assessment.visible) {
      continue;
    }
    if (assessment.marginMm > best) {
      best = assessment.marginMm;
    }
  }
  return best;
}

/**
 * The plate presenting the least armour among those visible, whether or not it can be beaten.
 *
 * This is what the flank planner asks: not "can I shoot right now" but "what is the *weakest* thing I
 * can see", which is the direction worth driving toward. Returns `null` when nothing is visible.
 */
export function weakestVisibleRegion(assessments: readonly PlateAssessment[]): PlateAssessment | null {
  let best: PlateAssessment | null = null;
  for (const assessment of assessments) {
    if (!assessment.visible) {
      continue;
    }
    if (best === null || assessment.effectiveArmorMm < best.effectiveArmorMm) {
      best = assessment;
    }
  }
  return best;
}

/** Euclidean distance, kept local so this module depends only on geometry and armour. */
function distance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
