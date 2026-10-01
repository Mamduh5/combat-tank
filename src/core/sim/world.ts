import { NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { cos, sin, vec3, type Vec3 } from '../math/index.js';
import { Tank, type VehicleTelemetry } from '../vehicle/tank.js';
import { Terrain, DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../world/terrain.js';
import { ShellFlightSystem } from '../ballistics/flight-system.js';
import type { ShellImpact } from '../ballistics/impact.js';

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

export interface SimulationOptions {
  readonly vehicle: VehicleDefinition;
  readonly spawn?: Vec3;
  readonly spawnHeadingRad?: number;
  readonly terrain?: TerrainConfig;
}

export class Simulation {
  readonly terrain: Terrain;
  readonly vehicle: Tank;
  readonly tickRateHz: number;

  /** Every shell currently in flight. V2 has no friendly-fire or self-hit rules, so this is the whole story. */
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
    );
    this.tickCountInternal += 1;
  }

  private impactsThisTick: readonly ShellImpact[] = EMPTY_IMPACTS;

  /**
   * Impacts produced by the most recent `tick`, in the order they occurred.
   *
   * Cleared by every tick, so a consumer that reads it once per frame sees each impact exactly once.
   */
  get impacts(): readonly ShellImpact[] {
    return this.impactsThisTick;
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
