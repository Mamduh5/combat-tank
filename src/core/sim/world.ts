import { NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { vec3, cos, sin, type Vec3 } from '../math/index.js';
import { Tank, type VehicleTelemetry } from '../vehicle/tank.js';
import { Terrain, DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../world/terrain.js';

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

  /** Total fixed ticks executed since construction. A simulation clock in ticks, not seconds. */
  private tickCount = 0;
  private accumulatorSeconds = 0;
  private readonly dtSeconds: number;

  constructor(options: SimulationOptions) {
    this.terrain = new Terrain(options.terrain ?? DEFAULT_TERRAIN_CONFIG);
    this.tickRateHz = TICK_HZ;
    this.dtSeconds = TICK_DT_SECONDS;

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

  /** Runs exactly one fixed tick. Exposed so tests can step deterministically. */
  tick(input: InputCommand = NEUTRAL_INPUT): void {
    this.vehicle.step(input, this.terrain, this.dtSeconds);
    this.tickCount += 1;
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
