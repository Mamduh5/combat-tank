import type { ArmorPlate, VehicleDefinition } from '../../shared/vehicle-definition.js';
import { dot, length, type Vec3, vec3 } from '../../shared/vec3.js';
import { cos, degToRad, sin } from '../math/index.js';

/**
 * Armour plate geometry: where a plate is, which way it faces, and whether a ray hits it.
 *
 * This module answers one question — **which plate did that shell hit, and where on it?** — and
 * nothing about armour's resistance or what happens next. Keeping hit resolution separate from
 * penetration is what lets the geometry be tested against known numeric cases independently of any
 * balance value.
 *
 * ## Local space
 *
 * Plates are defined in **vehicle local space**: origin at the centre of the hull floor, +Z forward,
 * +X right, +Y up. A hull plate is transformed by the vehicle's position and heading; a turret plate
 * additionally by the turret's local angle. Working in local space and transforming the *ray* in,
 * rather than transforming every plate out, is what keeps this exact: a plate's own definition stays
 * free of any runtime rotation.
 *
 * ## Why oriented slabs
 *
 * See `ArmorPlate` for the reasoning. The practical consequence is that hit resolution is a closed-form
 * ray-versus-oriented-box test with no sampling, so a shell cannot pass "between samples" and a plate
 * boundary is exact rather than approximate.
 */

/** A plate transformed into world space, ready for intersection tests. */
export interface WorldPlate {
  readonly definition: ArmorPlate;
  /** Centre of the outer surface, world space. */
  readonly center: Vec3;
  /** Outward unit normal of the outer surface, world space. */
  readonly normal: Vec3;
  /** Unit vector along the plate's width, world space. */
  readonly axisX: Vec3;
  /** Unit vector along the plate's height, world space. */
  readonly axisY: Vec3;
  /** Unit vector through the plate's thickness, pointing inward, world space. */
  readonly axisZ: Vec3;
}

/** The result of a ray-versus-plate intersection. */
export interface PlateHit {
  readonly plate: WorldPlate;
  /** Where the ray met the outer surface, world space. */
  readonly point: Vec3;
  /** Distance from the ray origin to that point, metres. */
  readonly distanceM: number;
}

/**
 * Transforms a vehicle-local point to world space.
 *
 * @param origin vehicle position, world space
 * @param headingRad the body's world heading (hull heading, or turret world heading)
 */
export function localToWorld(origin: Vec3, headingRad: number, local: Vec3): Vec3 {
  const c = cos(headingRad);
  const s = sin(headingRad);
  // Yaw only. Roll and pitch are presentation (ADR-0001), so a shot's resolution must not depend on
  // the cosmetic tilt of the hull on a slope.
  return vec3(
    origin.x + local.x * c + local.z * s,
    origin.y + local.y,
    origin.z - local.x * s + local.z * c,
  );
}

/**
 * Builds the world-space representation of every plate on a vehicle.
 *
 * Hull plates and turret plates are separated because they rotate about different pivots: a turret
 * plate turns about the ring height, not about the ground.
 */
export function buildWorldPlates(
  definition: VehicleDefinition,
  hullPosition: Vec3,
  hullHeadingRad: number,
  turretWorldHeadingRad: number,
): WorldPlate[] {
  const plates: WorldPlate[] = [];

  for (const plate of definition.armor) {
    if (plate.mount === 'turret') {
      const pivot = vec3(
        hullPosition.x,
        hullPosition.y + definition.turret.ringHeightM,
        hullPosition.z,
      );
      plates.push(transformPlate(plate, pivot, turretWorldHeadingRad));
    } else {
      plates.push(transformPlate(plate, hullPosition, hullHeadingRad));
    }
  }

  return plates;
}

/**
 * Transforms one local-space plate into world space.
 *
 * Built in two clearly separated steps — tilt about the plate's own horizontal axis, then yaw with the
 * vehicle — rather than by combining both angles into one expression. The combined form is shorter but
 * makes the sign of the pitch ambiguous, and getting it wrong points the plate's normal *into* the
 * vehicle: the plate still looks right in the data, still gets hit, but at a mirrored angle, which
 * silently inverts every penetration result derived from it.
 */
function transformPlate(plate: ArmorPlate, origin: Vec3, headingRad: number): WorldPlate {
  const yaw = degToRad(plate.yawDeg);
  const pitch = degToRad(plate.pitchDeg);

  // Step 1: tilt about the plate's own horizontal (width) axis.
  //
  // A **positive `pitchDeg` leans the top of the plate backward**, so the outward normal tilts *upward*.
  // For a hull front plate this is what makes a shot meet it at a steep angle, which is the entire point
  // of sloping armour. The height axis tilts the opposite way, keeping the two perpendicular.
  const tiltedNormal = vec3(0, sin(pitch), cos(pitch));
  const tiltedHeight = vec3(0, cos(pitch), -sin(pitch));
  const width = vec3(1, 0, 0);

  return {
    definition: plate,
    center: localToWorld(origin, headingRad, plate.centerM),
    normal: rotateAboutY(tiltedNormal, yaw, headingRad),
    axisX: rotateAboutY(width, yaw, headingRad),
    axisY: rotateAboutY(tiltedHeight, yaw, headingRad),
    axisZ: rotateAboutY(tiltedNormal, yaw, headingRad),
  };
}

/**
 * Rotates a vector about +Y by the plate's own yaw, then into world space by the vehicle heading.
 *
 * Y components are preserved by both rotations. Stated because a plate's normal must stay perpendicular
 * to its own surface: if the two rotations disagreed about pitch, the normal would stop being perpendicular
 * to the plate and every incidence angle computed from it would be wrong.
 */
function rotateAboutY(v: Vec3, plateYawRad: number, headingRad: number): Vec3 {
  const cy = cos(plateYawRad);
  const sy = sin(plateYawRad);
  const plateYawed = vec3(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);

  const ch = cos(headingRad);
  const sh = sin(headingRad);
  return vec3(
    plateYawed.x * ch + plateYawed.z * sh,
    plateYawed.y,
    -plateYawed.x * sh + plateYawed.z * ch,
  );
}

/**
 * Finds the first plate a ray strikes, or `null`.
 *
 * A ray is used rather than a point because a shell covers many metres per tick: the sub-step
 * segment is cast as a ray so a fast shell cannot pass through a plate between two samples.
 *
 * Only the **outer** surface is tested. A penetration is a property of the plate it entered through,
 * and testing the back face would let a ray that started inside the vehicle register as an impact.
 *
 * @param maxDistanceM how far along the ray to look. A vehicle is a few metres across, so this is
 *   a cheap guard against a ray that points away from the tank but still technically "hits" something
 *   far away.
 */
export function raycastPlates(
  plates: readonly WorldPlate[],
  origin: Vec3,
  direction: Vec3,
  maxDistanceM: number,
): PlateHit | null {
  let nearest: PlateHit | null = null;

  for (const plate of plates) {
    const hit = raycastPlate(plate, origin, direction, maxDistanceM);
    if (hit !== null && (nearest === null || hit.distanceM < nearest.distanceM)) {
      nearest = hit;
    }
  }

  return nearest;
}

/** Ray-versus-single-plate test, in the plate's own axis frame. */
function raycastPlate(
  plate: WorldPlate,
  origin: Vec3,
  direction: Vec3,
  maxDistanceM: number,
): PlateHit | null {
  // Work in plate coordinates: express the ray relative to the plate's own axes. This turns the
  // oriented box into an axis-aligned one, where the test is three interval overlaps.
  const rel = vec3(
    origin.x - plate.center.x,
    origin.y - plate.center.y,
    origin.z - plate.center.z,
  );

  const ox = dot(rel, plate.axisX);
  const oy = dot(rel, plate.axisY);
  const oz = dot(rel, plate.axisZ);

  const dx = dot(direction, plate.axisX);
  const dy = dot(direction, plate.axisY);
  const dz = dot(direction, plate.axisZ);

  // Half extents. The plate's *outer* surface sits at +Z, and its thickness runs inward to -Z, so
  // the box spans [-(thickness), 0] on the Z axis rather than being centred on the surface.
  const halfX = plate.definition.widthM / 2;
  const halfY = plate.definition.heightM / 2;
  const thicknessM = plate.definition.thicknessMm / 1000;

  // Slab intersection against the three axes.
  const tX = intersectSlab(ox, dx, halfX, maxDistanceM);
  const tY = intersectSlab(oy, dy, halfY, maxDistanceM);
  const tZ = intersectSlabOutward(oz, dz, thicknessM, maxDistanceM);

  if (tX === null || tY === null || tZ === null) {
    return null;
  }

  // The entry point is the *latest* of the three near intersections: the ray must have cleared all
  // three slabs before it is inside the plate.
  const distanceM = Math.max(tX, tY, tZ);
  if (distanceM < 0 || distanceM > maxDistanceM) {
    return null;
  }

  return {
    plate,
    point: vec3(
      origin.x + direction.x * distanceM,
      origin.y + direction.y * distanceM,
      origin.z + direction.z * distanceM,
    ),
    distanceM,
  };
}

/**
 * Slab intersection for a box centred on the origin.
 *
 * Returns the distance at which the ray enters the slab `[-half, +half]`, or `null` if it misses.
 * A ray parallel to the slab (`direction` component ~0) either lies entirely inside it — in which case
 * entry is the start of the ray — or misses, and this returns `null`.
 */
function intersectSlab(origin: number, direction: number, half: number, maxDistanceM: number): number | null {
  if (Math.abs(direction) < 1e-9) {
    return Math.abs(origin) <= half ? -Infinity : null;
  }

  const t1 = (-half - origin) / direction;
  const t2 = (half - origin) / direction;
  const near = Math.min(t1, t2);
  const far = Math.max(t1, t2);

  if (far < 0 || near > maxDistanceM) {
    return null;
  }
  return near;
}

/**
 * Slab intersection for the plate's thickness axis, where the box spans `[-thickness, 0]`.
 *
 * The asymmetric interval is what enforces "the outer surface only": a ray approaching from `+Z` meets
 * the outer face first, and a ray already past it travels away from the box and misses.
 */
function intersectSlabOutward(
  origin: number,
  direction: number,
  thickness: number,
  maxDistanceM: number,
): number | null {
  if (Math.abs(direction) < 1e-9) {
    return origin <= 0 && origin >= -thickness ? -Infinity : null;
  }

  const t1 = (-thickness - origin) / direction;
  const t2 = (0 - origin) / direction;
  const near = Math.min(t1, t2);
  const far = Math.max(t1, t2);

  if (far < 0 || near > maxDistanceM) {
    return null;
  }
  return near;
}

/** Distance from a world point to a plate's centre, for debugging and module tests. */
export function distanceToPlateCentre(plate: WorldPlate, point: Vec3): number {
  return length(vec3(point.x - plate.center.x, point.y - plate.center.y, point.z - plate.center.z));
}