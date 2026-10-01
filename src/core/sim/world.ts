import { NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { cos, sin, vec3, type Vec3 } from '../math/index.js';
import { Tank, type VehicleTelemetry } from '../vehicle/tank.js';
import { Terrain, DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../world/terrain.js';
import { ShellFlightSystem } from '../ballistics/flight-system.js';
import type { ShellImpact } from '../ballistics/impact.js';
import type { ShellObstacle } from '../ballistics/shell.js';
import { buildWorldPlates, raycastPlates, type WorldPlate } from '../armor/geometry.js';
import { resolveCombat, type CombatResult } from '../combat/combat-resolver.js';

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

/** How far ahead of the player the V3 test target is placed, metres. */
const TARGET_DISTANCE_M = 60;

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
): Vec3 {
  const forwardX = sin(headingRad);
  const forwardZ = cos(headingRad);

  // Eye height the player views from, roughly the camera's position above the tank.
  const eyeHeight = from.y + PLAYER_EYE_HEIGHT_M;

  let best: Vec3 = vec3(from.x + forwardX * TARGET_DISTANCE_M, from.y, from.z + forwardZ * TARGET_DISTANCE_M);
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < TARGET_CANDIDATE_COUNT; i += 1) {
    // Fan the candidates across the forward arc rather than sampling a full ring, so the search
    // concentrates where the player is actually looking.
    const spread = ((i / (TARGET_CANDIDATE_COUNT - 1)) * 2 - 1) * TARGET_SEARCH_ARC_RAD;
    const bearing = headingRad + spread;
    const distance = TARGET_DISTANCE_M;

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

    // The ground between the two has to be driveable. Line of sight alone is not enough: a cliff edge
    // is perfectly visible from above and completely impassable, so a candidate could be "visible" on
    // the far side of a drop the vehicle could never cross. Requiring a gentle slope the whole way
    // means the target is somewhere the player can actually get to.
    if (!isPathDriveable(terrain, from, x, z)) {
      continue;
    }

    // Penalise height difference and rough ground around the target, and prefer candidates
    // straight ahead. Without the last term, flat terrain scores every candidate identically and the
    // first one sampled wins — which put the target off at a 63° bearing, somewhere the player had to
    // discover rather than somewhere they expected. The bias is small enough that line of sight and
    // elevation still dominate: it only decides between positions that are all otherwise good.
    const heightDifference = Math.abs(groundY - from.y);
    const roughness = localRoughness(terrain, x, z);
    const score = -heightDifference * 2 - roughness - Math.abs(spread) * 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = vec3(x, groundY, z);
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
 * True when the ground between two points stays gentle enough to drive.
 *
 * A step limit rather than a slope limit, because that is what actually stops a tracked vehicle: a
 * short step is a bump, a tall one is a wall. Sampling along the path and measuring the height change
 * over a fixed stride catches both a cliff face and a sudden drop.
 */
function isPathDriveable(terrain: Terrain, from: Vec3, toX: number, toZ: number): boolean {
  const stride = PATH_DRIVABILITY_STRIDE_M;
  const steps = Math.max(
    1,
    Math.ceil(horizontalDistance(from.x, from.z, toX, toZ) / stride),
  );

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
}

export class Simulation {
  readonly terrain: Terrain;
  readonly vehicle: Tank;
  readonly tickRateHz: number;

  /**
   * The stationary damage target, or `null` when none was configured.
   *
   * A **single optional target** rather than a list of enemies. That is a deliberate scope boundary,
   * not an oversight: V4 is where opposing vehicles, AI, and battle flow arrive, and a general vehicle
   * list here would be the first step toward an opponent the project has not designed. Supporting more
   * later is a small change; un-building a combat loop is not.
   */
  readonly target: Tank | null;

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

  private tickCountInternal = 0;
  private accumulatorSeconds = 0;
  private readonly dtSeconds: number;

  constructor(options: SimulationOptions) {
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
    // player's spawn and on ground they can drive to. It faces the same way the player does, so the
    // player sees its rear plate at the start and must work around it to reach the front and flanks —
    // facing the player instead would present its vulnerable rear at all times and teach the wrong
    // lesson about armour.
    this.target =
      options.target === undefined
        ? null
        : new Tank(options.target, {
            position: findTargetPosition(
              this.terrain,
              spawn,
              options.spawnHeadingRad ?? 0,
            ),
            headingRad: options.spawnHeadingRad ?? 0,
          });

    this.targetObstacle = new VehicleObstacle(this.target ?? this.vehicle);
  }

  /**
   * Vehicles a shell can strike, excluding the one that fired it.
   *
   * Built fresh each tick rather than cached, because the plates depend on the vehicles' current
   * headings, which change as the turret servos. Rebuilding a dozen slab transforms per tick is
   * nothing next to the shell integration itself.
   */
  private shellObstacles(): ShellObstacle[] {
    const obstacles: ShellObstacle[] = [];
    if (this.target !== null) {
      obstacles.push(new VehicleObstacle(this.target));
    }
    return obstacles;
  }

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

    // The target is stepped with neutral input: it stays settled on the ground and its turret holds
    // still, which is what makes it a stationary target rather than a very slow opponent.
    if (this.target !== null) {
      this.target.step(NEUTRAL_INPUT, this.terrain, this.dtSeconds);
    }

    // The gun has already decided whether the shot is allowed; anything it hands over is a shot
    // that genuinely happened.
    const shot = this.vehicle.takePendingShot();
    if (shot !== null) {
      this.shells.spawn(
        this.vehicle.definition.mainShell,
        shot.origin,
        shot.direction,
        this.vehicle.definition.id,
      );
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
      return EMPTY_COMBAT;
    }

    const results: CombatResult[] = [];
    const target = this.target;
    const state = target.state;
    const plates = this.targetObstacle.currentPlates();

    for (const impact of impacts) {
      if (impact.targetKind !== 'vehicle' || impact.targetId !== target.definition.id) {
        continue;
      }

      results.push(
        resolveCombat(
          target.definition,
          impact,
          plates,
          target.damage,
          state.position,
          state.headingRad,
          state.headingRad + target.turretState.localAngleRad,
        ),
      );
    }

    return results;
  }

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
