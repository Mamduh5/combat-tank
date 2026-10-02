import { type Vec3, vec3, sin, cos } from '../math/index.js';

/**
 * Hard cover: things on the battlefield that a shell does not pass through and sight does not pass
 * through.
 *
 * ## Why these are simulation objects and not scenery
 *
 * The single most damaging thing a V6 implementation could do is put a building in the renderer and
 * nothing in the core. The result is a player who watches a shell pass through a concrete wall, and an
 * opponent that happily shoots through one. The two halves of the game would be lying in opposite
 * directions, and no amount of visual polish would fix it.
 *
 * So cover is **data in the core**, and three systems read the same list:
 *
 * - **ballistics** treats a structure as a shell obstacle, so it stops shells;
 * - **line of sight** tests against it, so it blocks seeing;
 * - **the renderer** builds a mesh from it.
 *
 * Because there is exactly one description, the renderer cannot show a wall the simulation thinks is
 * missing. If a structure is not in the map data it does not exist anywhere; if it is, it is solid
 * everywhere.
 *
 * ## Shape
 *
 * Structures are **boxes on the ground plane**, described by a centre, a footprint, a yaw, and a
 * height. That is a deliberate constraint rather than a simplification:
 *
 * - A box is testable in a few lines and in constant time, and line-of-sight is sampled thousands of
 *   times per battle. A general convex hull would be correct and unaffordable.
 * - Yaw is supported, so a wall can be placed at an angle to the lanes it protects without the map
 *   data becoming unreadable: rotation about the vertical axis costs one dot product per test.
 * - Height is what makes cover *hard*: a 3 m bunker breaks a sight line between two hulls sitting on
 *   the ground, which is the entire point of it. A waist-high barrier stops shells but not sight, and
 *   that distinction is carried by the same `blocksSight` flag.
 */

/** What a structure is, for rendering and for the map's readability. */
export type StructureKind =
  /** A tall solid mass. Blocks sight and shells: a building, bunker, or hangar. */
  | 'building'
  /** A long low mass: concrete barriers and walls. Blocks shells; blocks sight only if flagged. */
  | 'barrier'
  /** An irregular natural mass: a rock formation or outcrop. Blocks sight and shells. */
  | 'rock'
  /** Cover that shells pass over but sight does not: a treeline or camouflage screen. */
  | 'screen';

/** One piece of hard cover, in world space. */
export interface Structure {
  /** Stable id, used by tests, the map validator, and debugging tools. */
  readonly id: string;
  /** What it is, which decides its appearance. */
  readonly kind: StructureKind;
  /** Centre of the footprint on the ground plane. */
  readonly x: number;
  readonly z: number;
  /** Footprint half-extent along the structure's own facing, metres. */
  readonly halfLengthM: number;
  /** Footprint half-extent across the structure's own facing, metres. */
  readonly halfWidthM: number;
  /** Height above the ground at the centre, metres. */
  readonly heightM: number;
  /** Facing in radians, 0 being +Z. Lets a wall sit at an angle to the lanes it protects. */
  readonly yawRad: number;
  /**
   * Whether this blocks line of sight.
   *
   * Separate from height because a 1 m concrete barrier is meaningful cover against a shell and
   * invisible to sight, and conflating the two would force a choice between those two very different
   * pieces of cover. `false` means shells stop here and eyes do not.
   */
  readonly blocksSight: boolean;
}

/** A structure's own axes, with its rotation resolved, so per-ray tests are pure arithmetic. */
export interface StructureFrame {
  /** Unit vector along the structure's length (its facing). */
  readonly alongX: number;
  readonly alongZ: number;
  /** Unit vector across the structure's width. */
  readonly acrossX: number;
  readonly acrossZ: number;
}

/** A structure with its rotation and its ground height resolved. */
export interface PlacedStructure {
  readonly structure: Structure;
  readonly frame: StructureFrame;
  /** Ground height at the centre, resolved once so a ray test never calls the height field. */
  readonly groundHeightM: number;
}

/** Resolves a structure's rotation into its own axes. */
export function structureFrame(structure: Structure): StructureFrame {
  // The core's own trigonometry, not `Math.sin`/`Math.cos`. ADR-0005 makes that substitution mandatory
  // rather than stylistic, because a structure's exact corners feed both the renderer's mesh and the
  // ballistics' collision, and those two must not be able to disagree by an engine's rounding.
  const sinY = sin(structure.yawRad);
  const cosY = cos(structure.yawRad);
  return {
    // Facing is +Z rotated by yaw, matching the vehicle heading convention.
    alongX: sinY,
    alongZ: cosY,
    acrossX: cosY,
    acrossZ: -sinY,
  };
}

/**
 * Builds the placed list for a set of structures, resolving their ground heights.
 *
 * `groundHeightAt` is injected rather than imported so this module has no dependency on `Terrain` and
 * therefore no cycle: the battlefield owns the terrain, and the terrain does not know about cover.
 */
export function placeStructures(
  structures: readonly Structure[],
  groundHeightAt: (x: number, z: number) => number,
): PlacedStructure[] {
  return structures.map((structure) => ({
    structure,
    frame: structureFrame(structure),
    groundHeightM: groundHeightAt(structure.x, structure.z),
  }));
}

/**
 * Where a ray segment meets a structure, or `null` if it misses.
 *
 * A 2D slab test in the structure's own frame, then a height test. Constant time, no allocation, and
 * safe to call from a line-of-sight sampler that runs thousands of times a battle.
 *
 * @returns the entry point and the face normal, or `null` when the segment does not meet the structure
 */
export function structureHitSegment(
  placed: PlacedStructure,
  from: Vec3,
  to: Vec3,
): { point: Vec3; normal: Vec3 } | null {
  const { structure, frame } = placed;

  // Into the structure's own frame, with its centre as the origin.
  const originX = from.x - structure.x;
  const originZ = from.z - structure.z;
  const startAlong = originX * frame.alongX + originZ * frame.alongZ;
  const startAcross = originX * frame.acrossX + originZ * frame.acrossZ;

  const deltaX = to.x - from.x;
  const deltaZ = to.z - from.z;
  const deltaAlong = deltaX * frame.alongX + deltaZ * frame.alongZ;
  const deltaAcross = deltaX * frame.acrossX + deltaZ * frame.acrossZ;

  const entryAlong = enterSlab(startAlong, deltaAlong, structure.halfLengthM);
  const entryAcross = enterSlab(startAcross, deltaAcross, structure.halfWidthM);
  if (entryAlong === null || entryAcross === null) {
    return null;
  }

  // The later of the two entries is where the segment is actually inside the box: the ray must clear
  // both slabs, and the second one it clears is the face it meets.
  const t = Math.max(entryAlong, entryAcross);
  if (t > 1) {
    return null;
  }

  const point = vec3(from.x + deltaX * t, from.y + (to.y - from.y) * t, from.z + deltaZ * t);

  // Height test at the entry point. A structure that does not block sight is a barrier a sight line
  // passes over, but a shell still hits it.
  if (structure.blocksSight) {
    const top = placed.groundHeightM + structure.heightM;
    if (point.y > top || point.y < placed.groundHeightM) {
      return null;
    }
  }

  return { point, normal: faceNormal(frame, structure, startAlong, startAcross) };
}

/**
 * The horizontal normal of whichever face the ray met.
 *
 * Derived from which slab the ray was outside of when it entered: crossing the length slab means a long
 * face, crossing the width slab means a short one. Only the horizontal component is meaningful, which is
 * what the ballistics layer consumes.
 */
function faceNormal(
  frame: StructureFrame,
  structure: Structure,
  startAlong: number,
  startAcross: number,
): Vec3 {
  if (Math.abs(startAlong) > structure.halfLengthM) {
    const sign = startAlong > 0 ? 1 : -1;
    return vec3(frame.alongX * sign, 0, frame.alongZ * sign);
  }
  const sign = startAcross > 0 ? 1 : -1;
  return vec3(frame.acrossX * sign, 0, frame.acrossZ * sign);
}

/**
 * The parameter at which a segment enters the slab `[-half, +half]`, or `null` if it never does.
 *
 * Returns the *entry* rather than the exit, which is what makes the `max` in the caller correct. A
 * segment whose direction component is zero is "inside if it started inside", mirroring the same
 * convention in `armor/geometry.ts`.
 */
function enterSlab(origin: number, direction: number, half: number): number | null {
  if (Math.abs(direction) < 1e-9) {
    return Math.abs(origin) <= half ? -1 : null;
  }
  const t1 = (-half - origin) / direction;
  const t2 = (half - origin) / direction;
  const near = Math.min(t1, t2);
  const far = Math.max(t1, t2);
  if (far < 0 || near > 1) {
    return null;
  }
  return near;
}

/** True when a world point lies inside a structure's footprint. Used for spawn validation and props. */
export function structureContains(placed: PlacedStructure, x: number, z: number): boolean {
  const { structure, frame } = placed;
  const dx = x - structure.x;
  const dz = z - structure.z;
  const along = dx * frame.alongX + dz * frame.alongZ;
  const across = dx * frame.acrossX + dz * frame.acrossZ;
  return Math.abs(along) <= structure.halfLengthM && Math.abs(across) <= structure.halfWidthM;
}

/**
 * A structure presented as something a shell can hit.
 *
 * ## Why this adapter exists
 *
 * `shell.ts` defines the obstacle contract it knows how to handle: obstacles identified by id, hit by a
 * segment test. A building is not a vehicle, and pretending otherwise — by giving walls vehicle ids —
 * would pollute the combat report with impacts that have no attacker and no damage.
 *
 * So structures are adapted to that contract with a distinct id prefix. The shell stops on them and
 * reports an impact, and the combat layer then finds no *plate* there, so the outcome is "the shell hit
 * something solid" rather than "the shell hit a tank". The consequence that matters is the one the V6
 * brief asks for: **a shell does not pass through a building**, in the simulation, not only in the
 * picture — and because the renderer builds from the same list, it cannot show a wall the simulation
 * thinks is missing.
 */
export interface StaticObstacleLike {
  readonly vehicleId: string;
  hitSegment(from: Vec3, to: Vec3): { point: Vec3; normal: Vec3 } | null;
}

/** Id prefix for structure impacts, so a consumer can tell a wall from a vehicle without a second list. */
export const STRUCTURE_ID_PREFIX = 'structure:';

/** Wraps one placed structure as a shell obstacle. */
export function structureAsObstacle(placed: PlacedStructure): StaticObstacleLike {
  return {
    vehicleId: `${STRUCTURE_ID_PREFIX}${placed.structure.id}`,
    hitSegment: (from, to) => structureHitSegment(placed, from, to),
  };
}

/** Wraps a map's structures as shell obstacles. Built once at construction, not per tick. */
export function structuresAsObstacles(
  structures: readonly PlacedStructure[],
): StaticObstacleLike[] {
  return structures.map(structureAsObstacle);
}


