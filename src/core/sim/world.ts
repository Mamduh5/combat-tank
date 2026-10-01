import { NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { PLACEHOLDER_TANK as SPAWN_VEHICLE } from '../../shared/placeholder-tank.js';
import { atan2, cos, sin, vec3, type Vec3 } from '../math/index.js';
import { Tank, type VehicleTelemetry } from '../vehicle/tank.js';
import { Terrain, DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../world/terrain.js';
import { ShellFlightSystem } from '../ballistics/flight-system.js';
import type { ShellImpact } from '../ballistics/impact.js';
import type { ShellObstacle } from '../ballistics/shell.js';
import { buildWorldPlates, raycastPlates, type WorldPlate } from '../armor/geometry.js';
import { resolveCombat, type CombatResult } from '../combat/combat-resolver.js';
import { EnemyController } from '../ai/enemy-controller.js';

/**
 * The simulation core: terrain, vehicles, and the fixed-timestep loop that advances them.
 *
 * This class is the reason the project's architecture is shaped the way it is (ADR-0001). It has
 * no dependency on Babylon, Colyseus, the DOM, or a wall clock, so the *same* object runs in the
 * browser client, in a unit test, and — from V9 — inside an authoritative server. The client never
 * writes vehicle state; it supplies an `InputCommand` and reads the result.
 *
 * Time is advanced by `advance(realDeltaSeconds)`, which accumulates real time and runs whole
 * fixed ticks. Rendering may happen at any rate; simulation time only moves in whole ticks, so a
 * result depends on the inputs rather than on the machine's frame rate.
 */

/** Simulation frequency in ticks per second. See ADR-0008. */
export const TICK_HZ = 60;

/** Fixed timestep in seconds. Every gameplay rate in the core is expressed per this step. */
export const TICK_DT_SECONDS = 1 / TICK_HZ;

/**
 * Cap on catch-up ticks per `advance` call.
 *
 * If a frame takes longer than this many ticks (a breakpoint, a tab restore, a very slow machine),
 * the simulation drops the backlog instead of trying to catch up in a burst. Without this, a stall
 * produces a spiral: catching up costs more time, which causes the next frame to be even later.
 * Dropping time is the lesser evil, and it is a presentation hiccup rather than a correctness bug.
 */
const MAX_CATCHUP_TICKS = 5;

/** Shared empty impact list, so the common "nothing hit" case allocates nothing. */
const EMPTY_IMPACTS: readonly ShellImpact[] = Object.freeze([]);

/** How far ahead of the player the V4 opponent starts, metres. */
const TARGET_DISTANCE_M = 60;

/**
 * Opening distance between the two vehicles in V4, metres.
 *
 * Chosen by measurement rather than by feel, because this number is constrained from below as well as
 * above. At the V3 distance of 60 m the encounter worked, but it was decided by a race: two guns that
 * both reload in about five seconds had both fired before either crew had settled. The obvious fix was
 * to push it out to 78 m — which measured worse, because a longer path crosses more of the procedural
 * terrain, and the worst sustained gradient along it reached 29 degrees: past the vehicle's 26-degree
 * climb limit, so the opening ground was not drivable.
 *
 * 55 m is the longest opening that still crosses ground the tank can actually climb, measured over the
 * whole candidate arc rather than assumed. It is also inside the opponent's engagement band
 * (`nearRangeM` is 32 m, `farRangeM` is 90 m), so the fight starts in earnest rather than with either
 * side closing distance first.
 */
const V4_OPENING_DISTANCE_M = 55;

/** Shared empty obstacle list, so a world with no opponent allocates nothing per tick. */
const EMPTY_OBSTACLES: readonly ShellObstacle[] = Object.freeze([]);

/** Shared empty combat list, so a tick with no vehicle impact allocates nothing. */
const EMPTY_COMBAT: readonly CombatResult[] = Object.freeze([]);

/**
 * Adapts a vehicle into something the shell system can collide with.
 *
 * This is the seam between V2's ballistics and V3's armour. `shell.ts` knows only that something solid
 * is in the way and asks where it is hit; this class answers using the vehicle's armour plates. Keeping
 * the adaptation here means `shell.ts` has no idea armour exists, so a shell's flight stays testable
 * with a stub obstacle and remains independent of the armour model.
 */
class VehicleObstacle implements ShellObstacle {
  readonly vehicleId: string;
  private readonly vehicle: Tank;

  constructor(vehicle: Tank) {
    this.vehicle = vehicle;
    this.vehicleId = vehicle.definition.id;
  }

  /**
   * Finds the plate a shell's segment strikes.
   *
   * Tests the segment from `from` toward `to`, which is what prevents a fast shell passing through a
   * tank between two sub-steps. The cast distance is the segment's own length, so a hit can never be
   * reported beyond where the shell actually reached this tick.
   */
  hitSegment(from: Vec3, to: Vec3): { point: Vec3; normal: Vec3 } | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const segmentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (segmentLength < 1e-9) {
      return null;
    }

    const direction = vec3(dx / segmentLength, dy / segmentLength, dz / segmentLength);
    const hit = raycastPlates(this.currentPlates(), from, direction, segmentLength);

    return hit === null ? null : { point: hit.point, normal: hit.plate.normal };
  }

  /** The vehicle's plates in world space, reflecting its current hull and turret headings. */
  currentPlates(): WorldPlate[] {
    const state = this.vehicle.state;
    return buildWorldPlates(
      this.vehicle.definition,
      state.position,
      state.headingRad,
      state.headingRad + this.vehicle.turretState.localAngleRad,
    );
  }
}

/**
 * Finds a firing-range position for the test target.
 *
 * A stationary target is only useful if the player can **see it and reach it**. The first version simply
 * offset the player's spawn by a fixed distance along +Z and inherited the player's height, which on
 * this terrain put the target 12 m *below* the player on the floor of a valley, hidden behind the lip
 * of the hill the player spawned on. The player had no way to know the game had even loaded a target.
 *
 * So the position is chosen, not assumed. Candidates are sampled on a ring ahead of the player and
 * scored on the three things that matter for a firing range:
 *
 *  - **line of sight** from the player's eye height, so the target is visible on the first frame;
 *  - **similar elevation**, so the shot is roughly level and the drop is learnable;
 *  - **flat, drivable ground** between the two, so the player can actually get there.
 *
 * The search is deterministic — fixed sample order, no randomness — because the whole simulation is
 * (ADR-0001, ADR-0005), and a target that moved between runs would make every V3 test flaky.
 */
function findTargetPosition(
  terrain: Terrain,
  from: Vec3,
  headingRad: number,
  distanceM = TARGET_DISTANCE_M,
): Vec3 {
  const forwardX = sin(headingRad);
  const forwardZ = cos(headingRad);

  // Eye height the player views from, roughly the camera's position above the tank.
  const eyeHeight = from.y + PLAYER_EYE_HEIGHT_M;

  let best: Vec3 = vec3(from.x + forwardX * distanceM, from.y, from.z + forwardZ * distanceM);
  let bestScore = Number.NEGATIVE_INFINITY;
  /**
   * Whether `best` currently satisfies every constraint.
   *
   * Tracked so that a candidate meeting all of them is never replaced by one that does not: once a
   * good position exists, only a *better* good position should displace it.
   */
  let bestIsIdeal = false;

  for (let i = 0; i < TARGET_CANDIDATE_COUNT; i += 1) {
    // Fan the candidates across the forward arc rather than sampling a full ring, so the search
    // concentrates where the player is actually looking.
    const spread = ((i / (TARGET_CANDIDATE_COUNT - 1)) * 2 - 1) * TARGET_SEARCH_ARC_RAD;
    const bearing = headingRad + spread;
    const distance = distanceM;

    const x = from.x + sin(bearing) * distance;
    const z = from.z + cos(bearing) * distance;

    const groundY = terrain.heightAt(x, z);
    if (groundY === null) {
      continue;
    }

    // Line of sight: step along the ground between the two and require nothing to rise above the
    // straight line from the player's eye to the target's top.
    if (!hasLineOfSight(terrain, from, eyeHeight, x, groundY, z)) {
      continue;
    }

    // Penalise height difference and rough ground around the target, and prefer candidates straight
    // ahead. Without the last term, flat terrain scores every candidate identically and the first one
    // sampled wins — which put the target off at a 63-degree bearing, somewhere the player had to
    // discover rather than somewhere they expected.
    // Height difference is penalised linearly **and** super-linearly past a threshold. The linear term
    // alone was not enough: measurement produced an opponent 14 m below the player, which scored well
    // only because every other candidate was worse. Past `PLACEMENT_MAX_HEIGHT_DIFFERENCE_M` the shot
    // is effectively out of the fight — it has to drop, which is not learnable at prototype ranges —
    // so it needs a penalty big enough to lose to any candidate that is merely imperfect.
    const heightDifference = Math.abs(groundY - from.y);
    const excessHeightM = Math.max(0, heightDifference - PLACEMENT_MAX_HEIGHT_DIFFERENCE_M);
    const roughness = localRoughness(terrain, x, z);
    const score =
      -heightDifference * 2 - roughness - Math.abs(spread) * 0.5 - excessHeightM * 40;

    // V4: score **every** candidate, then require the constraints only when choosing.
    //
    // This replaces a hard `continue` on each failed constraint, and that change is the fix for a real
    // bug. Rejecting candidates outright meant that on terrain steeper than the driveability limit
    // *every* candidate was rejected, and the search silently fell back to a straight line at the
    // default distance — a position that satisfied nothing at all: 15 m of elevation difference, no
    // line of sight, and ground the tank could not cross. Falling through to the worst possible answer
    // is worse than choosing the least-bad real one.
    //
    // Constraints are therefore scored, not filtered, and the best candidate that meets all of them
    // wins; if none does, the best-scoring candidate is used anyway, because a compromised opening is
    // playable and an unreachable one is not.
    const visible = hasLineOfSight(terrain, from, eyeHeight, x, groundY, z);
    const drivable = isPathDriveable(terrain, from, x, z);
    const engageable = canEngageFrom(terrain, from, x, groundY, z);

    // Heavily penalised rather than excluded, so a candidate that misses one constraint can still beat
    // one that misses three.
    const penalty = (visible ? 0 : 1000) + (drivable ? 0 : 600) + (engageable ? 0 : 400);
    const weighted = score - penalty;

    const isIdeal = visible && drivable && engageable;

    // Two-tier comparison, written as a single rule rather than a chain of special cases:
    //
    //   an ideal candidate always beats a penalised one;
    //   within the same tier, the better raw score wins.
    //
    // The tier check is what makes this correct. Comparing penalised scores alone would let a candidate
    // missing one constraint outrank a perfect one purely by being flatter, which is the failure this
    // whole change exists to prevent.
    if (!bestIsIdeal || isIdeal) {
      const beatsCurrent = isIdeal === bestIsIdeal && weighted > bestScore + IDEAL_SCORE_MARGIN;
      if (beatsCurrent || !bestIsIdeal) {
        bestScore = weighted;
        best = vec3(x, groundY, z);
        bestIsIdeal = isIdeal;
      }
    }
  }

  // Settle onto the ground exactly. The vehicle does this itself on its first tick, but seeding it
  // correctly means the very first rendered frame is not a tank dropping through the ground.
  return vec3(best.x, terrain.heightAt(best.x, best.z) ?? best.y, best.z);
}

/**
 * True when nothing between the player and the target rises above the line joining them.
 *
 * A coarse march rather than a full occlusion query, because this runs once at startup and only needs
 * to be good enough to reject a target hidden behind a ridge.
 */
function hasLineOfSight(
  terrain: Terrain,
  from: Vec3,
  eyeHeightM: number,
  targetX: number,
  targetGroundY: number,
  targetZ: number,
): boolean {
  const targetEye = targetGroundY + TARGET_VISUAL_HEIGHT_M;
  const steps = LINE_OF_SIGHT_STEPS;

  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const x = from.x + (targetX - from.x) * t;
    const z = from.z + (targetZ - from.z) * t;
    const rayHeight = eyeHeightM + (targetEye - eyeHeightM) * t;
    const ground = terrain.heightAt(x, z);
    if (ground !== null && ground > rayHeight - LINE_OF_SIGHT_MARGIN_M) {
      return false;
    }
  }
  return true;
}

/**
 * True when two vehicles at these positions would have a clear shot at each other.
 *
 * The mirror of the player's existing line-of-sight test: it marches the ground between the two hulls
 * and requires nothing to rise above the line joining them. Used only at spawn, to guarantee the
 * encounter opens as a duel rather than as two tanks who cannot see each other.
 *
 * Deliberately symmetric and independent of which side is which — the opponent does not start with an
 * advantage the player lacks.
 */
function canEngageFrom(terrain: Terrain, from: Vec3, toX: number, toGroundY: number, toZ: number): boolean {
  const targetTopY = toGroundY + TARGET_VISUAL_HEIGHT_M;
  const eyeHeightM = from.y + PLAYER_EYE_HEIGHT_M;

  for (let i = 1; i < LINE_OF_SIGHT_STEPS; i += 1) {
    const t = i / LINE_OF_SIGHT_STEPS;
    const x = from.x + (toX - from.x) * t;
    const z = from.z + (toZ - from.z) * t;
    const lineY = eyeHeightM + (targetTopY - eyeHeightM) * t;
    if (terrain.heightAt(x, z) > lineY - LINE_OF_SIGHT_MARGIN_M) {
      return false;
    }
  }
  return true;
}

/**
 * True when the ground between two points stays gentle enough to drive.
 *
 * Two independent tests, because they catch different failures:
 *
 *  - **step height** over a fixed stride — catches a cliff face or a sudden drop, which is what
 *    actually stops a tracked vehicle: a short step is a bump, a tall one is a wall;
 *  - **gradient angle** at each sample — catches a *sustained* climb.
 *
 * The slope test is the V4 addition, and it exists because of a measured failure. The step test alone
 * accepted a pair of positions separated by a 57-degree face: sampled at a 6 m stride the height
 * change per step stayed under the step limit, so the path looked smooth to the only test being run. A
 * path can be perfectly smooth in the sense that no single step is a cliff and still be entirely
 * unclimbable, because the vehicle's limit is on *gradient*, not on step size.
 *
 * Measuring the gradient directly makes the test match the thing that actually stops the tank, which
 * is the vehicle's own `maxClimbDeg` with headroom for it to slow down on the approach.
 */
function isPathDriveable(terrain: Terrain, from: Vec3, toX: number, toZ: number): boolean {
  const stride = PATH_DRIVABILITY_STRIDE_M;
  const steps = Math.max(
    1,
    Math.ceil(horizontalDistance(from.x, from.z, toX, toZ) / stride),
  );

  // Unit vector along the path, so the gradient is measured along the route rather than along whichever
  // world axis happened to line up with it.
  const pathLength = Math.max(1e-6, horizontalDistance(from.x, from.z, toX, toZ));
  const dirX = (toX - from.x) / pathLength;
  const dirZ = (toZ - from.z) / pathLength;

  // Perpendicular to the path, in the horizontal plane. Derived rather than taken from a fixed pair of
  // axes, so the cross-check is always genuinely across the route.
  const crossX = -dirZ;
  const crossZ = dirX;

  const limit = maxPathSlopeDeg();

  for (let i = 0; i < steps; i += 1) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const x0 = from.x + (toX - from.x) * t0;
    const z0 = from.z + (toZ - from.z) * t0;
    const x1 = from.x + (toX - from.x) * t1;
    const z1 = from.z + (toZ - from.z) * t1;

    const rise = Math.abs(terrain.heightAt(x1, z1) - terrain.heightAt(x0, z0));
    if (rise > PATH_MAX_STEP_M) {
      return false;
    }

    // Gradient along the direction of travel, and across it. Both matter and they fail differently:
    // the along-path gradient is what decides whether the vehicle can *climb*, and the cross-path
    // gradient is what decides whether it can hold a level attitude while doing so.
    //
    // Only these two, not all four world axes: an axis-aligned test rejects ground for being steep in
    // a direction the vehicle never travels, which on a long path rejects every candidate and drops the
    // placement search back to its fallback — measurably worse opening positions, not better ones.
    if (terrain.slopeDegreesAlong(x1, z1, dirX, dirZ) > limit) {
      return false;
    }
    if (
      terrain.slopeDegreesAlong(x1, z1, crossX, crossZ) > limit ||
      terrain.slopeDegreesAlong(x1, z1, -crossX, -crossZ) > limit
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Horizontal distance between two ground positions.
 *
 * Deliberately not `Math.hypot`: the core avoids the platform transcendentals because they are not
 * guaranteed bit-identical across engines (ADR-0005), and target placement feeds directly into
 * simulation state. `Math.sqrt` is exactly specified and so stays deterministic; `hypot` is not on
 * the restricted list for that reason.
 */
function horizontalDistance(x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Roughness of the ground around a point, as the mean absolute height difference to its neighbours. */
function localRoughness(terrain: Terrain, x: number, z: number): number {
  const centre = terrain.heightAt(x, z) ?? 0;
  let total = 0;
  for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
    total += Math.abs((terrain.heightAt(x + dx, z + dz) ?? centre) - centre);
  }
  return total / NEIGHBOUR_OFFSETS.length;
}

/** Height the player's view sits above their vehicle, metres. */
const PLAYER_EYE_HEIGHT_M = 2.4;
/** Approximate height of a vehicle's turret above its ground contact, for line-of-sight tests. */
const TARGET_VISUAL_HEIGHT_M = 2.6;
/**
 * How much better a second ideal candidate must score to displace the first, points.
 *
 * Small, because the score already prefers positions straight ahead and near the player's elevation.
 * This exists only to break near-ties deterministically and stably, not to express a preference.
 */
const IDEAL_SCORE_MARGIN = 0.05;

/**
 * Height difference beyond which a candidate is heavily penalised, metres.
 *
 * Beyond this the two vehicles are not exchanging shots on comparable terms: the lower one is shooting
 * up, and the shot has to carry both the range and the climb. A prototype encounter wants them level.
 */
const PLACEMENT_MAX_HEIGHT_DIFFERENCE_M = 4;

/** Candidate positions sampled across the arc in front of the player. */
const TARGET_CANDIDATE_COUNT = 25;
/** How far either side of the player's facing the search looks, radians. */
const TARGET_SEARCH_ARC_RAD = 1.1;
/** Samples along the sight line. */
const LINE_OF_SIGHT_STEPS = 24;
/** Clearance required between the sight line and intervening ground, metres. */
const LINE_OF_SIGHT_MARGIN_M = 1.2;
/** Spacing of the step-height samples used to judge whether a path is driveable, metres. */
const PATH_DRIVABILITY_STRIDE_M = 6;
/** Largest height step a tracked vehicle is expected to cross while driving, metres. */
const PATH_MAX_STEP_M = 1.6;


/**
 * Steepest sustained climb allowed along the opening approach, degrees.
 *
 * Set from the **vehicle's own** climb limit rather than a number chosen here, so retuning the vehicle
 * automatically retunes the spawn requirement with it. The vehicle stalls at `maxClimbDeg`, so a path
 * at or below that is drivable; a hair under it leaves room to slow into the steepest section rather
 * than arriving at the limit already losing speed.
 *
 * Measured context: the default terrain's shortest ridge layer already reaches roughly 31 degrees, so
 * this limit is genuinely constraining and the placement search really does reject candidates. It is
 * not a formality.
 */
function maxPathSlopeDeg(): number {
  return Math.min(SPAWN_VEHICLE.ground.maxClimbDeg - 2, SPAWN_VEHICLE.ground.maxDescendDeg - 2);
}

/** Neighbour offsets used for the roughness estimate, metres. */
const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [4, 0],
  [-4, 0],
  [0, 4],
  [0, -4],
];

export interface SimulationOptions {
  readonly vehicle: VehicleDefinition;
  readonly spawn?: Vec3;
  readonly spawnHeadingRad?: number;
  readonly terrain?: TerrainConfig;
  /**
   * Optional stationary target to shoot at, added in V3.
   *
   * It does not drive, aim, or fire — it exists so armour and damage can be tested by hand. Its
   * position comes from the simulation's default spawn scan, so it lands on usable ground rather than
   * at a coordinate someone assumed was flat.
   */
  readonly target?: VehicleDefinition;

  /**
   * Seed for the opponent's aim scatter, added in V4.
   *
   * A constructor parameter rather than a constant, because a seeded opponent makes an encounter
   * exactly reproducible. That is what turns "the AI is unbeatable sometimes" into a bug report with
   * a number attached, and it lets a test assert a specific duel outcome rather than a statistical
   * tendency.
   */
  readonly enemySeed?: number;

  /**
   * Distance the opponent starts at, metres. Added in V4; defaults to `V4_OPENING_DISTANCE_M`.
   *
   * Overridable because spawn distance is the single most important balance input in the encounter and
   * is exactly the kind of thing a test or a tuning pass needs to sweep without editing terrain.
   */
  readonly openingDistanceM?: number;

  /**
   * Whether the configured `target` is a fighting opponent or an inert object to shoot at. Added in V4.
   *
   * Defaults to `true`, because in V4 a configured target *is* an opponent. Pass `false` to get the V3
   * behaviour back: a stationary, silent vehicle that exists purely as something to shoot, with no
   * controller stepping it.
   *
   * This is the honest way to support both. Making an inert target work by zeroing its speed and
   * removing its turret would only mean fighting an opponent that cannot move — the tests and tools
   * that want a static target need the controller removed outright, not neutered. The armour tests
   * depend on this: they need an object that stays exactly where it was put so a shell fired at a
   * known bearing lands on a known plate.
   */
  readonly targetIsOpponent?: boolean;
}

/**
 * Compass bearing from one ground point to another, radians, in the vehicle heading frame.
 *
 * Uses the core's own `atan2`. This started as a hand-rolled quadrant fixup — `dx >= 0 ? atan(dx/dz) :
 * PI - atan(dx/dz)` — which was wrong in the third quadrant: for a target behind-and-right it
 * returned a bearing roughly `PI` away from the correct one, so the opponent spawned facing *away*
 * from the player. The core already had a deterministic, unit-tested `atan2` for exactly this; the
 * lesson is to look for it rather than to re-derive it.
 */
function headingToward(from: Vec3, to: Vec3): number {
  // Arguments are (y, x) to match `atan2`'s convention, with the world axes mapped so that +Z is a
  // bearing of zero and +X is a bearing of +90 degrees — the same frame the vehicle's heading uses.
  return atan2(to.x - from.x, to.z - from.z);
}

export class Simulation {
  readonly terrain: Terrain;
  readonly vehicle: Tank;
  readonly tickRateHz: number;

  /**
   * The opposing vehicle, or `null` when none was configured.
   *
   * A **single opponent** rather than a list of enemies. That is a deliberate scope boundary: multiple
   * simultaneous enemies are a V5+ concern and a general vehicle list here would be the first step
   * toward a squad system the project has not designed. Supporting more later is a small change;
   * un-building a combat loop is not.
   *
   * In V4 this is no longer a stationary target. It is a full `Tank` with its own turret, gun, reload
   * cycle, armour and damage state, stepped through the same `step` call as the player's vehicle, and
   * its shells travel through the same ballistics and resolve through the same penetration model.
   */
  readonly target: Tank | null;

  /**
   * The opponent's controller, or `null` when no opponent was configured.
   *
   * Owned by the world because the opponent's input must be produced *before* it is stepped, in the
   * same tick the player's is. A caller cannot drive the opponent directly, which is what guarantees
   * both vehicles are advanced by identical rules.
   */
  readonly enemyController: EnemyController | null;


  /**
   * Which side each combat result belonged to.
   *
   * Read-only, and recomputed per tick so a consumer sees each outcome exactly once.
   */
  private playerCombatThisTick: readonly CombatResult[] = EMPTY_COMBAT;

  /** Every shell currently in flight. */
  readonly shells: ShellFlightSystem;

  /** Total fixed ticks executed since construction. A simulation clock in ticks, not seconds. */
  /**
   * Ticks executed since construction, as a simulation clock in ticks rather than seconds.
   *
   * Read-only, and deliberately a *tick* count rather than a wall-clock time: from V9 this is the
   * authoritative simulation clock, and a consumer that could set it would be able to rewind or skip
   * the world.
   */
  get tickCount(): number {
    return this.tickCountInternal;
  }

  /** The options this world was built from, so `restart` can reproduce the opening state. */
  private readonly options: SimulationOptions;
  private tickCountInternal = 0;
  private accumulatorSeconds = 0;
  private readonly dtSeconds: number;

  constructor(options: SimulationOptions) {
    // Retained so `restart` can rebuild the opening positions without the caller re-supplying them.
    // The options are treated as immutable after construction.
    this.options = options;
    this.terrain = new Terrain(options.terrain ?? DEFAULT_TERRAIN_CONFIG);
    this.tickRateHz = TICK_HZ;
    this.dtSeconds = TICK_DT_SECONDS;
    this.shells = new ShellFlightSystem();

    const spawn = options.spawn ?? this.defaultSpawn();
    this.vehicle = new Tank(options.vehicle, {
      position: spawn,
      headingRad: options.spawnHeadingRad ?? 0,
    });

    // The target is placed by a search rather than a fixed offset, so that it is visible from the
    // player's spawn and on ground they can drive to.
    //
    // V4 change: it now **faces the player**, rather than facing the same way the player does. The V3
    // target faced the same way, so a stationary player saw its rear and had to work around it to
    // reach the front and flanks. That was a sound armour lesson but a poor *opening*: an opponent
    // presenting its most vulnerable plate while unable to return fire let the player delete it in
    // four shots. Facing the player means the encounter opens on the enemy's strongest frontal
    // armour, so the first exchange is a contest the player has to earn rather than a gift.
    const targetPosition = options.target === undefined
      ? null
      : findTargetPosition(
          this.terrain,
          spawn,
          options.spawnHeadingRad ?? 0,
          options.openingDistanceM ?? V4_OPENING_DISTANCE_M,
        );

    this.target =
      options.target === undefined || targetPosition === null
        ? null
        : new Tank(options.target, {
            position: targetPosition,
            headingRad: headingToward(targetPosition, spawn),
          });

    // Both vehicles are shell obstacles. The shooter is excluded inside the shell system itself, by
    // id, so a gun can never hit the hull it is mounted on.
    this.playerObstacle = new VehicleObstacle(this.vehicle);
    this.targetObstacle = new VehicleObstacle(this.target ?? this.vehicle);

    // The opponent's controller is created here rather than by the caller so that the opponent's input
    // is produced inside `tick`, in the same place and at the same moment as the player's. A caller
    // that drove the opponent itself would be able to step it with input the player could not.
    this.enemyController =
      this.target === null || options.targetIsOpponent === false
        ? null
        : new EnemyController(this.target, this.vehicle, this.terrain, options.enemySeed);

    // Refilled in place, never reassigned: `shellObstacles` hands this array to the shell system each
    // tick, and a fresh array per tick would allocate for no benefit.
    if (this.target !== null) {
      this.obstacleCache.length = 0;
      this.obstacleCache.push(this.playerObstacle, this.targetObstacle);
    }
  }

  /**
   * Returns the world to its opening state without rebuilding it.
   *
   * Restarting by constructing a new `Simulation` would work, but it forces every consumer to rebuild
   * its view of the world too — the renderer, the physics collider, the audio graph — and any of them
   * holding a reference to the old object would silently stop updating. Resetting in place means the
   * same `Simulation` identity survives a restart, which is what lets a restart be a single call.
   *
   * Everything mutable is reset: both vehicles' motion, turret, gun and damage state; the opponent's
   * memory; the tick clock; and every shell in flight. Leaving any of those behind is precisely how a
   * restart ends up with a stray shell killing the player a second after the battle "restarts".
   */
  restart(): void {
    const options = this.options;
    const spawn = options.spawn ?? this.defaultSpawn();
    const headingRad = options.spawnHeadingRad ?? 0;

    this.vehicle.reset(spawn, headingRad);

    const targetPosition =
      options.target === undefined
        ? null
        : findTargetPosition(
            this.terrain,
            spawn,
            headingRad,
            options.openingDistanceM ?? V4_OPENING_DISTANCE_M,
          );
    if (this.target !== null && targetPosition !== null) {
      this.target.reset(targetPosition, headingToward(targetPosition, spawn));
    }

    this.enemyController?.restart();
    this.shells.clear();

    // The tick clock restarts too, so the first tick of a new battle is tick zero. This matters for
    // determinism: a second battle must be able to replay identically to the first.
    this.tickCountInternal = 0;
    this.accumulatorSeconds = 0;

    this.impactsThisTick = EMPTY_IMPACTS;
    this.combatThisTick = EMPTY_COMBAT;
    this.playerCombatThisTick = EMPTY_COMBAT;
    this.enemySeesPlayer = false;
  }

  /**
   * Vehicles a shell can strike, excluding the one that fired it.
   *
   * Built fresh each tick rather than cached, because the plates depend on the vehicles' current
   * headings, which change as the turret servos. Rebuilding a dozen slab transforms per tick is
   * nothing next to the shell integration itself.
   */
  private shellObstacles(): readonly ShellObstacle[] {
    if (this.target === null) {
      return EMPTY_OBSTACLES;
    }
    // Both vehicles. Before V4 the player was not an obstacle at all, because nothing could shoot it;
    // now that both sides fire, a shell must be able to strike either one. The shooter's own hull is
    // skipped inside the shell system by vehicle id, so this list simply contains everyone.
    return this.obstacleCache;
  }

  /**
   * Reusable list holding the two vehicle obstacles.
   *
   * The obstacles are stable objects that read the tanks' live state on each call, so the array is
   * built once and refilled rather than allocated per tick. It is only ever mutated in place, and
   * always outside `tick`, so nothing observes it changing mid-tick.
   */
  private readonly obstacleCache: ShellObstacle[] = [];

  /**
   * Advances the simulation by a real elapsed duration, running as many whole fixed ticks as fit.
   *
   * @param realDeltaSeconds wall-clock seconds since the last call, as measured by the *caller*.
   *   The core deliberately does not read a clock itself (ADR-0005), so this stays testable and
   *   reproducible: a headless test can drive the simulation with a synthetic delta.
   * @returns the number of fixed ticks executed.
   */
  advance(realDeltaSeconds: number, input: InputCommand = NEUTRAL_INPUT): number {
    // Guard against a negative or non-finite delta, which would otherwise rewind the simulation.
    if (!Number.isFinite(realDeltaSeconds) || realDeltaSeconds <= 0) {
      return 0;
    }

    this.accumulatorSeconds += realDeltaSeconds;

    let ticks = 0;
    while (this.accumulatorSeconds >= this.dtSeconds && ticks < MAX_CATCHUP_TICKS) {
      this.accumulatorSeconds -= this.dtSeconds;
      this.tick(input);
      ticks += 1;
    }

    // If the backlog is still larger than one tick after the cap, discard the excess so the
    // simulation does not fall permanently behind real time.
    if (this.accumulatorSeconds > this.dtSeconds) {
      this.accumulatorSeconds = 0;
    }

    return ticks;
  }

  /**
   * Runs exactly one fixed tick.
   *
   * The order matters: the vehicle is stepped first, so a shot accepted this tick leaves from the
   * muzzle position the vehicle has *just* reached, and only then are the shells advanced. A shell
   * therefore never starts a tick already part-way through its flight, and an impact reported this
   * tick reflects a muzzle position no more than one tick old.
   */
  tick(input: InputCommand = NEUTRAL_INPUT): void {
    this.vehicle.step(input, this.terrain, this.dtSeconds);

    // The opponent's input is produced *after* the player has moved, so it reacts to where the player
    // actually is this tick rather than to last tick's position. It is then stepped through the same
    // `Tank.step` call as the player, so locomotion, traverse, reload and damage consequences apply
    // identically to both. There is no separate enemy code path anywhere below this line.
    if (this.target !== null && this.enemyController !== null) {
      // The controller measures its own line of sight from its own gun to the player's hull, and
      // reports it here afterwards. Reading it back rather than passing it in makes it structurally
      // impossible for the opponent to behave as though it can see the player while the HUD says it
      // cannot — the two were separate measurements before, and they did disagree.
      this.target.step(this.enemyController.think(this.dtSeconds), this.terrain, this.dtSeconds);
      this.enemySeesPlayer = this.enemyController.lastSawPlayer;
    }

    // Both guns have already decided whether their shots were allowed; anything they hand over is a
    // shot that genuinely happened. Taken in a fixed order so the shell list is deterministic.
    const playerShot = this.vehicle.takePendingShot();
    if (playerShot !== null) {
      this.shells.spawn(
        this.vehicle.definition.mainShell,
        playerShot.origin,
        playerShot.direction,
        this.vehicle.definition.id,
      );
    }

    if (this.target !== null) {
      const enemyShot = this.target.takePendingShot();
      if (enemyShot !== null) {
        this.shells.spawn(
          this.target.definition.mainShell,
          enemyShot.origin,
          enemyShot.direction,
          this.target.definition.id,
        );
      }
    }

    this.impactsThisTick = this.shells.step(
      this.vehicle.definition.mainShell,
      this.terrain,
      this.dtSeconds,
      this.shellObstacles(),
    );

    // Any impact on a vehicle is resolved into a combat outcome. Terrain impacts are left as they
    // were in V2: they are already the complete answer, and there is nothing to penetrate.
    this.combatThisTick = this.resolveImpacts(this.impactsThisTick);

    this.tickCountInternal += 1;
  }

  /**
   * Turns vehicle impacts into combat results, applying damage.
   *
   * A separate pass from the shell step so ballistics never needs to know about armour, and so the
   * order is explicit: first the shell stops, then we work out what stopping meant.
   */
  private resolveImpacts(impacts: readonly ShellImpact[]): readonly CombatResult[] {
    if (this.target === null || impacts.length === 0) {
      this.playerCombatThisTick = EMPTY_COMBAT;
      return EMPTY_COMBAT;
    }

    const results: CombatResult[] = [];
    const incoming: CombatResult[] = [];
    const target = this.target;
    const targetPlates = this.targetObstacle.currentPlates();
    const playerPlates = this.playerObstacle.currentPlates();
    const playerState = this.vehicle.state;

    for (const impact of impacts) {
      if (impact.targetKind !== 'vehicle') {
        continue;
      }

      // A hit on the opponent: the player fired this. A hit on the player: the opponent fired it.
      // Both go through the identical resolver, which is the property that makes the two sides
      // symmetrical — there is no separate rule set for damage dealt to the player.
      if (impact.targetId === target.definition.id) {
        const state = target.state;
        results.push(
          resolveCombat(
            target.definition,
            impact,
            targetPlates,
            target.damage,
            state.position,
            state.headingRad,
            state.headingRad + target.turretState.localAngleRad,
          ),
        );
      } else if (impact.targetId === this.vehicle.definition.id) {
        incoming.push(
          resolveCombat(
            this.vehicle.definition,
            impact,
            playerPlates,
            this.vehicle.damage,
            playerState.position,
            playerState.headingRad,
            playerState.headingRad + this.vehicle.turretState.localAngleRad,
          ),
        );
      }
    }

    // Hits taken are kept separately from hits dealt, because the player needs to be told about them
    // very differently: an incoming penetration is the single most urgent thing on screen.
    this.playerCombatThisTick = incoming;
    return results;
  }

  /**
   * Combat results from the most recent tick that hit the **player**, as opposed to `combat`, which
   * reports hits on the opponent.
   *
   * Separate because the HUD treats them very differently: an incoming hit needs its own prominent
   * warning, and conflating the two would mean the player could not tell "I hit it" from "it hit me".
   */
  get incomingCombat(): readonly CombatResult[] {
    return this.playerCombatThisTick;
  }

  /** True when the opponent had line of sight on the player at the last tick. */
  get enemyHasLineOfSight(): boolean {
    return this.enemySeesPlayer;
  }

  private enemySeesPlayer = false;

  /**
   * Adapts the player's tank into a shell obstacle.
   *
   * Held as a field rather than rebuilt each tick, unlike the V3 arrangement: once the player is
   * strikeable, its plates have to be available to `resolveImpacts` every tick, and keeping one
   * stable object makes it obvious that both sides are treated identically.
   */
  private readonly playerObstacle: VehicleObstacle;

  private impactsThisTick: readonly ShellImpact[] = EMPTY_IMPACTS;
  private combatThisTick: readonly CombatResult[] = EMPTY_COMBAT;

  /** Cached so the collision adapter and the combat pass share one plate transform per tick. */
  private readonly targetObstacle: VehicleObstacle;

  /**
   * Impacts produced by the most recent `tick`, in the order they occurred.
   *
   * Cleared by every tick, so a consumer that reads it once per frame sees each impact exactly once.
   */
  get impacts(): readonly ShellImpact[] {
    return this.impactsThisTick;
  }

  /**
   * Combat outcomes produced by the most recent `tick`.
   *
   * Empty on any tick with no vehicle impact. Like `impacts`, it is replaced each tick so a per-frame
   * consumer sees each outcome once — which is what the hit-feedback HUD relies on.
   */
  get combat(): readonly CombatResult[] {
    return this.combatThisTick;
  }

  /** Runs `count` fixed ticks with a constant input. A convenience for tests and headless tools. */
  runTicks(count: number, input: InputCommand = NEUTRAL_INPUT): void {
    for (let i = 0; i < count; i += 1) {
      this.tick(input);
    }
  }

  get elapsedTicks(): number {
    return this.tickCount;
  }

  /** Elapsed simulation time in seconds. Derived from ticks, so it is exact. */
  get elapsedSeconds(): number {
    return this.tickCount * this.dtSeconds;
  }

  get telemetry(): VehicleTelemetry {
    return this.vehicle.telemetry;
  }

  /**
   * Chooses where the player starts.
   *
   * Originally this scanned 64 points near the origin for the *flattest immediate slope*, which is a
   * poor proxy for a good starting position: a point on the crest of a hill is locally flat and has
   * open ground in every direction, yet everything visible from it is the sky beyond a cliff edge. The
   * player spawned looking into a void, with the terrain 12 m below them.
   *
   * A tank game wants open, level ground with room ahead, so the scan now scores candidates on how
   * **consistent** their surroundings are rather than on the slope at the point itself: a wide ring of
   * samples whose spread measures whether this is a plateau or a ridge. Low spread wins.
   *
   * A V4 experiment added a bias toward the arena centre, on the reasoning that the cover is authored
   * around the origin and a far-out spawn would put the encounter away from all of it. Measured, that
   * was the wrong trade: it moved the player from a plateau onto an 18-degree slope in the middle of the
   * map's most undulating ground, where the camera looked down a hillside and the terrain filled the
   * screen. Evenness is worth more than proximity, so the arena's cover is placed around wherever this
   * scan chooses instead.
   *
   * Deterministic, like everything else in the core: a fixed candidate order and no randomness, so the
   * same terrain always starts the player in the same place (ADR-0001, ADR-0005).
   */
  private defaultSpawn(): Vec3 {
    let bestX = 0;
    let bestZ = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < SPAWN_CANDIDATE_COUNT; i += 1) {
      const angle = (i / SPAWN_CANDIDATE_COUNT) * Math.PI * 2;
      const radius = 14 + (i % 10) * 9;
      const x = sin(angle) * radius;
      const z = cos(angle) * radius;

      const centre = this.terrain.heightAt(x, z);
      if (centre === null) {
        continue;
      }


      // Spread of heights on a wide ring: small on a plateau, large on a ridge or in a gully.
      let spread = 0;
      let counted = 0;
      for (let s = 0; s < SPAWN_PROBE_COUNT; s += 1) {
        const probeAngle = (s / SPAWN_PROBE_COUNT) * Math.PI * 2;
        for (const r of SPAWN_PROBE_RADII) {
          const h = this.terrain.heightAt(
            x + sin(probeAngle) * r,
            z + cos(probeAngle) * r,
          );
          if (h !== null) {
            spread += Math.abs(h - centre);
            counted += 1;
          }
        }
      }

      const score = counted > 0 ? spread / counted : Number.POSITIVE_INFINITY;

      if (score < bestScore) {
        bestScore = score;
        bestX = x;
        bestZ = z;
      }
    }

    return vec3(bestX, this.terrain.heightAt(bestX, bestZ), bestZ);
  }
}

/** Candidate spawn points scanned around the origin. */
const SPAWN_CANDIDATE_COUNT = 60;

/** Angular samples used to measure how even a candidate's surroundings are. */
const SPAWN_PROBE_COUNT = 12;
/** Ring radii, in metres, at which surrounding height is sampled. */
const SPAWN_PROBE_RADII: readonly number[] = [18, 34, 52];
