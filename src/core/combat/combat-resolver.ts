import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { type Vec3 } from '../../shared/vec3.js';
import { computeIncidenceAngleDeg, type ShellImpact } from '../ballistics/impact.js';
import type { WorldPlate } from '../armor/geometry.js';
import { resolvePenetration, type PenetrationResult } from '../armor/penetration.js';
import { applyPenetration, type DamageReport, type DamageState } from '../damage/damage-model.js';

/**
 * Combat resolution: what a shell did to a vehicle.
 *
 * This is the module that makes V3's promise real. It takes a **V2 impact record** — position,
 * incoming direction, impact velocity — and turns it into a combat outcome: which plate, at what angle,
 * penetrated or not, and what damage resulted.
 *
 * ## The V2 → V3 contract, exercised
 *
 * Everything this module needs already exists in `ShellImpact`. In particular the **surface normal is
 * the plate's own normal**, not the terrain's: when a shell strikes a vehicle, the normal reported on
 * the impact is the plate's, so the incidence angle computed from it is the angle at which the shell met
 * *that plate*. Nothing here re-derives geometry from the camera or from a visual approximation, which
 * is exactly what the owner asked for.
 *
 * ## Ordering
 *
 * ```
 *   ray → nearest plate → incidence angle → penetration verdict → (if penetrated) damage
 * ```
 *
 * Ricochet and blockage are decided before any damage is applied, so a shell that fails to penetrate
 * cannot deal damage — the property the version plan calls out explicitly.
 */

/**
 * How far an impact point may sit from a plate's surface and still count as having struck it, metres.
 *
 * Generous relative to the millimetre-scale accuracy of the shell's sub-step refinement, but far below
 * the distance between a tank's plates. Without a bound of this kind, a shot that missed the vehicle
 * entirely would be scored against the nearest plate and reported as a hit.
 */
const PLATE_MATCH_TOLERANCE_M = 0.25;

/** A shell that struck a vehicle but did not get in. */
export interface NonPenetratingResult {
  readonly kind: 'ricocheted' | 'blocked';
  readonly plate: WorldPlate;
  readonly penetration: PenetrationResult;
  readonly impactPoint: Vec3;
}

/** A shell that got through, and what it cost the vehicle. */
export interface PenetratingResult {
  readonly kind: 'penetrated';
  readonly plate: WorldPlate;
  readonly penetration: PenetrationResult;
  readonly impactPoint: Vec3;
  /**
   * Where the shell ended up inside the vehicle: the entry point plus the plate thickness along the
   * shell's direction. This is the point tested against module radii, because it is roughly where the
   * shell ended up rather than merely where it touched.
   */
  readonly penetrationPoint: Vec3;
  readonly damage: DamageReport;
}

/** A shell that passed through the space a vehicle occupies without striking a plate. */
export interface ArmourMissResult {
  readonly kind: 'armour-miss';
}

export type CombatResult = NonPenetratingResult | PenetratingResult | ArmourMissResult;

/**
 * Resolves one shell against one vehicle.
 *
 * @param plates the vehicle's plates, already transformed into world space
 * @param damage the vehicle's damage state, mutated in place when the shell penetrates
 */
export function resolveCombat(
  definition: VehicleDefinition,
  impact: ShellImpact,
  plates: readonly WorldPlate[],
  damage: DamageState,
  hullPosition: Vec3,
  hullHeadingRad: number,
  turretWorldHeadingRad: number,
): CombatResult {
  const speed = Math.sqrt(
    impact.impactVelocity.x ** 2 +
      impact.impactVelocity.y ** 2 +
      impact.impactVelocity.z ** 2,
  );

  // The struck plate, taken from the impact record rather than re-cast.
  //
  // Re-casting is not merely redundant — it is **wrong**. A second ray started at the impact point and
  // run along the travel direction passes straight through the plate that was hit and lands on a
  // different one behind it, so a shot at a sloped hull front gets scored against the turret plate
  // rising behind it. Every angle and every penetration result would then describe the wrong plate while
  // looking entirely plausible. The impact's position *is* the point where the shell met the plate.
  const hit = plateAtImpactPoint(plates, impact.position);
  if (hit === null) {
    return { kind: 'armour-miss' };
  }

  // The plate's own outward normal, not the impact's stored normal. The two normally agree, but taking
  // it from the plate guarantees the angle describes this plate rather than whatever produced the normal.
  const incidenceAngleDeg = computeIncidenceAngleDeg(impact.incomingDirection, hit.normal);

  const penetration = resolvePenetration(
    definition.mainShell,
    definition.penetration,
    hit.definition.thicknessMm,
    incidenceAngleDeg,
    speed,
  );

  if (penetration.outcome === 'ricocheted') {
    return { kind: 'ricocheted', plate: hit, penetration, impactPoint: impact.position };
  }
  if (penetration.outcome === 'blocked') {
    return { kind: 'blocked', plate: hit, penetration, impactPoint: impact.position };
  }

  // Where the shell ends up: through the plate along its own direction. Plate thickness is millimetres,
  // and the shell only travels the full thickness when it goes straight in, which is why the distance is
  // scaled by the cosine of the incidence angle.
  const thicknessM = hit.definition.thicknessMm / 1000;
  const cosTheta = Math.max(
    impact.incomingDirection.x * hit.normal.x +
      impact.incomingDirection.y * hit.normal.y +
      impact.incomingDirection.z * hit.normal.z,
    0.2,
  );
  const travelM = thicknessM / cosTheta;

  const penetrationPoint: Vec3 = {
    x: impact.position.x + impact.incomingDirection.x * travelM,
    y: impact.position.y + impact.incomingDirection.y * travelM,
    z: impact.position.z + impact.incomingDirection.z * travelM,
  };

  const damageReport = applyPenetration(
    definition,
    damage,
    penetrationPoint,
    hullPosition,
    hullHeadingRad,
    turretWorldHeadingRad,
  );

  return {
    kind: 'penetrated',
    plate: hit,
    penetration,
    impactPoint: impact.position,
    penetrationPoint,
    damage: damageReport,
  };
}

/**
 * The plate whose outer surface contains an impact point, or `null` if the point is not on any plate.
 *
 * The shell system has already resolved *which* plate was struck; this recovers that plate from the
 * recorded position so the penetration maths describes the surface the shell actually met.
 *
 * The tolerance matters. Without one, a point that missed the vehicle entirely would still be scored
 * against whatever plate happened to be nearest, so a shot passing forty metres wide of a tank would be
 * reported as a hit on its side plate. Within the tolerance the impact is genuinely on a surface; beyond
 * it, there is no plate here and the shot missed.
 *
 * `nearestSurfaceDistance` is used rather than distance to the plate *centre*, because a plate's centre
 * is up to half its width inside the hull while its surface is where a shell actually stops.
 */
function plateAtImpactPoint(
  plates: readonly WorldPlate[],
  point: Vec3,
): WorldPlate | null {
  let best: WorldPlate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const plate of plates) {
    const distance = nearestSurfaceDistance(plate, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = plate;
    }
  }

  return best !== null && bestDistance <= PLATE_MATCH_TOLERANCE_M ? best : null;
}

/**
 * Shortest distance from a point to a plate's outer surface rectangle.
 *
 * Measured as the distance to the plate's finite rectangular face in the plate's own axis frame, with
 * the thickness ignored. A shell always stops on the outer face — the inner face is never tested — so
 * this is the surface the impact position lies on.
 */
function nearestSurfaceDistance(plate: WorldPlate, point: Vec3): number {
  const dx = point.x - plate.center.x;
  const dy = point.y - plate.center.y;
  const dz = point.z - plate.center.z;

  // Project into the plate's own axes.
  const ox = dx * plate.axisX.x + dy * plate.axisX.y + dz * plate.axisX.z;
  const oy = dx * plate.axisY.x + dy * plate.axisY.y + dz * plate.axisY.z;
  const oz = dx * plate.axisZ.x + dy * plate.axisZ.y + dz * plate.axisZ.z;

  // Clamp to the face's rectangle; anything beyond is measured from the edge.
  const halfX = plate.definition.widthM / 2;
  const halfY = plate.definition.heightM / 2;
  const clampedX = ox < -halfX ? -halfX : ox > halfX ? halfX : ox;
  const clampedY = oy < -halfY ? -halfY : oy > halfY ? halfY : oy;

  const excessX = ox - clampedX;
  const excessY = oy - clampedY;
  return Math.sqrt(excessX * excessX + excessY * excessY + oz * oz);
}