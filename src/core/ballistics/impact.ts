import { type Vec3 } from '../../shared/vec3.js';
import { acos, radToDeg } from '../math/index.js';

/**
 * The V2 impact contract.
 *
 * This is the boundary between V2 and V3, and it is deliberately narrow:
 *
 *   V2 answers **"where and how did the shell hit?"**
 *   V3 answers **"what does that hit do?"**
 *
 * Everything here is measured or derived from measurement. There is no penetration, no ricochet, no
 * damage and no armour in this file or anywhere else in V2 — a consumer can compute those from these
 * fields, and nothing in the core has decided them.
 *
 * The fields are chosen for what a penetration calculation actually needs:
 *  - **position** to identify which plate was struck and where,
 *  - **normal** to establish the angle the shell met the surface at,
 *  - **incomingDirection** to establish the shell's heading, and therefore its remaining energy,
 *  - **impactVelocity** for kinetic calculations and for the effect of gravity on the descent,
 *  - **incidenceAngleDeg** precomputed because every consumer needs it and it is easy to get
 *    subtly wrong (see the derivation below).
 */

/** What a shell struck. V2 can only produce `terrain`; V3 adds `vehicle`. */
export type ImpactTargetKind = 'terrain' | 'vehicle';

export interface ShellImpact {
  /** Identifier of the shell that produced this impact. */
  readonly shellId: number;
  /** Id of the shell type that was fired, for example the V2 test shell id. */
  readonly shellTypeId: string;
  /** Which vehicle fired it, or `null` for a shell with no owner. */
  readonly shooterId: string | null;
  /** Where the shell struck, in world space. */
  readonly position: Vec3;
  /** Unit surface normal at the impact, pointing away from the struck surface. */
  readonly surfaceNormal: Vec3;
  /** What was struck. */
  readonly targetKind: ImpactTargetKind;
  /** Id of the struck vehicle, or `null` for terrain. */
  readonly targetId: string | null;
  /** Unit direction the shell was travelling when it struck. */
  readonly incomingDirection: Vec3;
  /** Shell velocity at the moment of impact, m/s. */
  readonly impactVelocity: Vec3;
  /**
   * Angle between the shell's direction of travel and the surface normal, degrees.
   *
   * **0° is a perpendicular hit** and **90° is a grazing hit**. This is the number armour
   * normalisation is built on: the steeper the angle, the greater the effective thickness a plate
   * presents.
   *
   * Derived as the angle between `-incomingDirection` (pointing back along the shell's path) and
   * `surfaceNormal`. Using the negated direction is the detail that is easy to get backwards, so it
   * is stated here and asserted by a test.
   */
  readonly incidenceAngleDeg: number;
  /** Time since the shell left the muzzle, seconds. */
  readonly flightTimeSeconds: number;
  /** Total distance the shell travelled, metres. */
  readonly distanceTravelledM: number;
  /** Shell mass at the moment of firing, kg. Carried for V3; unused in V2. */
  readonly shellMassKg: number;
  /** Speed at the muzzle, m/s. Carried for V3; unused in V2. */
  readonly muzzleVelocityMps: number;
}

/**
 * Computes the angle of incidence in degrees.
 *
 * Exported because it is pure, and because the sign convention is the kind of thing that should be
 * tested directly rather than only through a shell that happens to hit something.
 */
export function computeIncidenceAngleDeg(
  incomingDirection: Vec3,
  surfaceNormal: Vec3,
): number {
  // The angle of incidence is measured between the *reversed* travel direction and the surface
  // normal: the shell meets the surface along the line it came from. Reversing the direction is what
  // turns "0 = flying parallel to the surface" into "0 = driving straight into it".
  const reversed = negate(incomingDirection);

  // Uses the core's own `acos` rather than `Math.acos`, which is not guaranteed identical across
  // JavaScript engines (ADR-0005). The core lint rule enforces that substitution.
  return radToDeg(acos(dot(reversed, surfaceNormal)));
}

/** Dot product of two vectors. */
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Returns `-v`. Written out rather than using `scale` so the intent reads directly. */
function negate(v: Vec3): Vec3 {
  return { x: -v.x, y: -v.y, z: -v.z };
}
