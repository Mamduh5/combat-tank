import type { PenetrationModel, TestShellDefinition } from '../../shared/vehicle-definition.js';
import { cos, degToRad } from '../math/index.js';

/**
 * Penetration, normalisation and ricochet.
 *
 * This module answers the V3 question: **given a shell and the plate it struck, did it get through?**
 * It is deliberately pure — numbers in, verdict out, touching no vehicle state — so the arithmetic can
 * be tested against hand-computed cases rather than against whatever the implementation happens to
 * print.
 *
 * ## The model, stated plainly
 *
 * Three steps, in order:
 *
 * 1. **Effective armour.** A plate of nominal thickness `t` presents more armour to a shell arriving
 *    at angle `θ` from its normal, because the shell must travel further through the material. The path
 *    length is `t / cos θ`, and that ratio is the effective thickness:
 *
 *    ```
 *    effective = nominal / cos θ
 *    ```
 *
 *    At 0° (square-on) this is exactly the nominal thickness. At 60° it is twice as much.
 *
 * 2. **Normalisation.** A shell is not a ray of light: its construction resists obliquity. The shell's
 *    `normalization` value in `[0, 1]` says how much of the angle penalty it cancels:
 *
 *    ```
 *    normalised = 1 + normalization × (1/cos θ − 1)
 *    ```
 *
 *    At `0` this is 1, so the shell pays the full geometric penalty. At `1` it equals `1/cos θ`
 *    exactly, so the shell is as capable at an angle as head-on and only ricochet protects the plate.
 *    The shipped test shell sits in between, which is what produces the behaviour the player should
 *    learn: sloped armour helps, but not completely.
 *
 * 3. **Ricochet.** Above `ricochetThresholdDeg`, a shell skips penetration entirely and deflects. This
 *    is checked *first*, before any trigonometry, because a shell at 85° should not be handed a
 *    meaningless effective thickness to be compared against.
 *
 * ## Why not World of Tanks' formulas
 *
 * The brief asked for something understandable and tunable, not a reproduction of another game's
 * proprietary model. These are three lines whose behaviour at any angle can be reasoned about without
 * running code, and every parameter is data. Recorded in ADR-0012.
 */

/** What happened to a shell that struck a plate. */
export type PenetrationOutcome =
  /** The shell defeated the plate and continued into the vehicle. */
  | 'penetrated'
  /** The shell did not have enough capability; it stopped in the plate. */
  | 'blocked'
  /** The impact angle was too severe; the shell deflected off the plate. */
  | 'ricocheted';

/** Full explanation of a penetration decision, for both the HUD and the tests. */
export interface PenetrationResult {
  readonly outcome: PenetrationOutcome;
  /** The plate's nominal thickness, mm. */
  readonly nominalArmorMm: number;
  /** Thickness after accounting for impact angle, before normalisation. mm. */
  readonly effectiveArmorMm: number;
  /** The shell's capability at this angle, after normalisation and velocity scaling. mm. */
  readonly shellPenetrationMm: number;
  /** Capability minus resistance. Positive means it got through. mm. */
  readonly penetrationMarginMm: number;
  /** Angle between the shell's path and the plate normal, degrees. 0 = square on. */
  readonly incidenceAngleDeg: number;
  /** Impact speed used in the calculation, m/s. */
  readonly impactSpeedMps: number;
}

/**
 * Decides whether a shell penetrates a plate.
 *
 * @param nominalArmorMm the plate's nominal thickness
 * @param incidenceAngleDeg angle between the shell's path and the plate normal. 0° is square-on, 90°
 *   is a graze. This is the V2 convention, computed from the impact record's reversed direction.
 * @param impactSpeedMps shell speed at impact. Slower shells penetrate less.
 */
export function resolvePenetration(
  shell: TestShellDefinition,
  model: PenetrationModel,
  nominalArmorMm: number,
  incidenceAngleDeg: number,
  impactSpeedMps: number,
): PenetrationResult {
  // --- Ricochet, checked first ---------------------------------------------------------
  // A shell at a severe angle never reaches a penetration comparison. Testing before the trigonometry
  // also avoids asking `1/cos θ` a question it answers with a huge number.
  if (incidenceAngleDeg >= model.ricochetThresholdDeg) {
    return {
      outcome: 'ricocheted',
      nominalArmorMm,
      // Reported as the nominal thickness: the shell never got far enough for angle to matter, and an
      // enormous "effective" number here would be misleading rather than informative.
      effectiveArmorMm: nominalArmorMm,
      shellPenetrationMm: 0,
      penetrationMarginMm: -nominalArmorMm,
      incidenceAngleDeg,
      impactSpeedMps,
    };
  }

  // --- Effective armour ------------------------------------------------------------------
  const geometricFactor = geometricFactorFor(incidenceAngleDeg);
  const effectiveArmorMm = nominalArmorMm * geometricFactor;

  // --- Normalised shell capability ------------------------------------------------------
  // The shell cancels `normalization` of the angle penalty. Clamped to [0, 1] because above 1 a shell
  // would *gain* capability from an angled hit, which is not a thing.
  const normalization = clamp01(shell.normalization);
  const normalizedPenetrationMm =
    shell.nominalPenetrationMm * (1 + normalization * (geometricFactor - 1));

  // --- Velocity scaling ------------------------------------------------------------------
  // A shell that has dropped over a long flight arrives slower and penetrates less. Linear in the
  // ratio, and deliberately not clamped: a very slow shell should be nearly harmless, and clamping
  // would create a floor below which speed stopped mattering.
  const referenceVelocity = Math.max(model.referenceVelocityMps, 1e-6);
  const shellPenetrationMm = normalizedPenetrationMm * (impactSpeedMps / referenceVelocity);

  const penetrationMarginMm = shellPenetrationMm - effectiveArmorMm;

  return {
    outcome: shellPenetrationMm >= effectiveArmorMm ? 'penetrated' : 'blocked',
    nominalArmorMm,
    effectiveArmorMm,
    shellPenetrationMm,
    penetrationMarginMm,
    incidenceAngleDeg,
    impactSpeedMps,
  };
}

/**
 * `1 / cos θ`, the factor by which a plate presents extra thickness to an angled shot.
 *
 * The `cos θ` is floored because it reaches exactly 0 at 90°. The ricochet rule means a real shell
 * never reaches this function at that angle, but the guard keeps it total: a caller passing 90° by hand
 * gets a large finite number rather than Infinity or NaN propagating into a damage calculation.
 */
function geometricFactorFor(incidenceAngleDeg: number): number {
  const c = cos(degToRad(incidenceAngleDeg));
  return 1 / Math.max(c, 1e-6);
}

/**
 * Effective armour in millimetres for a plate at an angle, ignoring the shell entirely.
 *
 * Exposed separately because it is the single most useful number for understanding the armour model:
 * "this plate presents 180 mm at 40°" is the fact the whole system exists to make visible.
 */
export function effectiveArmorMm(nominalArmorMm: number, incidenceAngleDeg: number): number {
  return nominalArmorMm * geometricFactorFor(incidenceAngleDeg);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}