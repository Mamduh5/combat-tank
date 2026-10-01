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

    // The target is placed ahead of the player so it is in view at the start, and **faces the same way
    // the player does**, so the player sees its rear plate and must drive around it to reach the front
    // and flanks. Facing the player instead would put its vulnerable rear toward the gun at all times
    // and teach the wrong lesson about armour.
    this.target =
      options.target === undefined
        ? null
        : new Tank(options.target, {
            position: vec3(spawn.x, spawn.y, spawn.z + TARGET_DISTANCE_M),
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
   * A flat, central spawn point facing along +Z.
   *
   * Chosen by scanning for the flattest spot near the origin rather than assuming (0,0) is flat:
   * the terrain is procedural, so the origin is not guaranteed to be a sensible place to start.
   */
  private defaultSpawn(): Vec3 {
    let bestX = 0;
    let bestZ = 0;
    let bestSlope = Number.POSITIVE_INFINITY;

    for (let i = 0; i < 64; i += 1) {
      const angle = (i / 64) * Math.PI * 2;
      const radius = 12 + (i % 8) * 6;
      const x = sin(angle) * radius;
      const z = cos(angle) * radius;

      const slope = this.terrain.slopeDegreesAlong(x, z, 1, 0) + this.terrain.slopeDegreesAlong(x, z, 0, 1);
      if (slope < bestSlope) {
        bestSlope = slope;
        bestX = x;
        bestZ = z;
      }
    }

    return vec3(bestX, this.terrain.heightAt(bestX, bestZ), bestZ);
  }
}
