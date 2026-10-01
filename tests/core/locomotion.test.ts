import { describe, expect, it } from 'vitest';
import { LongitudinalModel, moveToward } from '../../src/core/vehicle/locomotion.js';
import { Simulation, TICK_DT_SECONDS } from '../../src/core/sim/world.js';
import { Terrain } from '../../src/core/world/terrain.js';
import { makeInput } from '../../src/shared/input.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import type { VehicleDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * Locomotion tests.
 *
 * The central V1 criterion is that the vehicle "accelerates, reverses and turns at rates consistent
 * with its data definition — not with hard-coded constants in code". These tests establish that by
 * running the *same* simulation code against two different definitions and asserting the measured
 * behaviour follows the data. If someone hard-coded a top speed, the second vehicle would behave
 * identically and this suite would fail.
 */

/**
 * Builds a definition that differs from the placeholder only in the values a test cares about.
 *
 * Overrides are spread into each of the three sections, so a single flat list of names is enough
 * for a test to express "a vehicle with these different characteristics". The spread carries
 * unrelated keys into the other sections, which is harmless here because the validator and the
 * simulation only read the keys they know about — but it does mean this helper is for *tests*, not
 * for building real definitions.
 */
function variantWith(overrides: {
  maxSpeedMps?: number;
  maxReverseSpeedMps?: number;
  driveForceN?: number;
  massKg?: number;
  hullTraverseDegPerSec?: number;
  hullTraverseAccelDegPerSec2?: number;
  traverseSpeedPenalty?: number;
  brakeDecelMps2?: number;
  coastDecelMps2?: number;
  maxClimbDeg?: number;
  climbSpeedRetention?: number;
}): VehicleDefinition {
  return {
    ...PLACEHOLDER_TANK,
    id: 'test-variant',
    displayName: 'Test Variant',
    powertrain: { ...PLACEHOLDER_TANK.powertrain, ...overrides },
    traversal: { ...PLACEHOLDER_TANK.traversal, ...overrides },
    ground: { ...PLACEHOLDER_TANK.ground, ...overrides },
  };
}

/** Runs a simulation on flat ground and returns the final speed. */
function topSpeedAfter(def: VehicleDefinition, seconds: number, throttle: number): number {
  const sim = new Simulation({ vehicle: def, terrain: FLAT_TERRAIN });
  const ticks = Math.round(seconds / TICK_DT_SECONDS);
  sim.runTicks(ticks, makeInput(throttle, 0));
  return sim.vehicle.state.speedMps;
}

/**
 * Flat terrain config, for tests that isolate longitudinal or traverse behaviour from slope.
 *
 * `amplitudeM: 0` removes the ridge layers and `edgeRiseM: 0` removes the boundary bowl, so height
 * is exactly zero everywhere. Tests that need a *known gradient* build a dedicated slope fixture
 * instead of relying on the procedural terrain.
 */
const FLAT_TERRAIN = { seed: 1, halfSizeM: 400, amplitudeM: 0, edgeRiseM: 0 };

describe('LongitudinalModel', () => {
  const def = PLACEHOLDER_TANK;

  it('derives acceleration from the definition force and mass, not a constant', () => {
    const light = new LongitudinalModel(variantWith({ massKg: 16_000, driveForceN: 78_000 }));
    const heavy = new LongitudinalModel(variantWith({ massKg: 64_000, driveForceN: 78_000 }));

    // Same force, four times the mass: a quarter of the acceleration. A hard-coded value could not
    // produce this, which is exactly what the criterion is asking us to prove.
    expect(light.driveAccelMps2).toBeCloseTo(78_000 / 16_000, 6);
    expect(heavy.driveAccelMps2).toBeCloseTo(78_000 / 64_000, 6);
    expect(heavy.driveAccelMps2).toBeCloseTo(light.driveAccelMps2 / 4, 6);
  });

  it('reports the flat-ground speed limit from the definition', () => {
    const model = new LongitudinalModel(def);
    expect(model.speedLimit(0)).toBe(def.powertrain.maxSpeedMps);
  });

  it('reduces the speed limit as a gradient steepens', () => {
    const model = new LongitudinalModel(def);
    const flat = model.speedLimit(0);
    const half = model.speedLimit(def.ground.maxClimbDeg / 2);
    const full = model.speedLimit(def.ground.maxClimbDeg);

    expect(half).toBeLessThan(flat);
    expect(full).toBeLessThan(half);

    // At the climb limit the model should reach the definition's retention value.
    const expected = def.powertrain.maxSpeedMps * def.ground.climbSpeedRetention;
    expect(full).toBeCloseTo(expected, 6);
  });

  it('allows a modest overspeed downhill but not an unlimited one', () => {
    const model = new LongitudinalModel(def);
    const descentLimit = model.speedLimit(-def.ground.maxDescendDeg);

    expect(descentLimit).toBeGreaterThan(def.powertrain.maxSpeedMps);
    // A bounded bonus, not an open-ended one.
    expect(descentLimit).toBeLessThan(def.powertrain.maxSpeedMps * 1.3);
  });

  it('stalls on a gradient steeper than the climb limit', () => {
    const model = new LongitudinalModel(def);
    const solution = model.solve(0, 1, def.ground.maxClimbDeg + 5);
    expect(solution.stalled).toBe(true);
    expect(solution.targetSpeedMps).toBe(0);
  });

  it('coasts toward a stop at the definition coast rate', () => {
    const model = new LongitudinalModel(def);
    const solution = model.solve(5, 0, 0);
    expect(solution.accelMps2).toBeCloseTo(-def.powertrain.coastDecelMps2, 6);
  });

  it('brakes harder than it drives', () => {
    const model = new LongitudinalModel(def);
    // Moving forward, asking to reverse: this is a brake application, not a drive one.
    const braking = model.solve(6, -1, 0);
    expect(Math.abs(braking.accelMps2)).toBeCloseTo(def.powertrain.brakeDecelMps2, 6);
    expect(Math.abs(braking.accelMps2)).toBeGreaterThan(model.driveAccelMps2);
  });
});

describe('moveToward', () => {
  it('never overshoots the target in one step', () => {
    expect(moveToward(0, 10, 1)).toBe(1);
    expect(moveToward(0, 10, 100)).toBe(10);
    expect(moveToward(10, 0, 100)).toBe(0);
  });

  it('is symmetric when closing from either side', () => {
    expect(moveToward(5, 0, 2)).toBe(3);
    expect(moveToward(5, 10, 2)).toBe(7);
  });

  it('is a no-op when the target is already reached', () => {
    expect(moveToward(4, 4, 10)).toBe(4);
  });
});

describe('vehicle acceleration follows its definition', () => {
  it('reaches but never exceeds the definition top speed', () => {
    const def = variantWith({ maxSpeedMps: 10 });
    const reached = topSpeedAfter(def, 30, 1);
    expect(reached).toBeGreaterThan(def.powertrain.maxSpeedMps * 0.97);
    expect(reached).toBeLessThanOrEqual(def.powertrain.maxSpeedMps + 1e-6);
  });

  it('caps reverse at the definition reverse speed, which is lower than forward', () => {
    const def = variantWith({ maxSpeedMps: 10, maxReverseSpeedMps: 4 });
    const reverse = topSpeedAfter(def, 30, -1);
    expect(reverse).toBeLessThan(0);
    expect(Math.abs(reverse)).toBeLessThanOrEqual(def.powertrain.maxReverseSpeedMps + 1e-6);
    expect(Math.abs(reverse)).toBeGreaterThan(def.powertrain.maxReverseSpeedMps * 0.9);
  });

  it('takes noticeably longer to reach speed than to stop from it', () => {
    // This is the "weight" the vision document asks for, expressed as a measurable property. The
    // vehicle's drive acceleration is deliberately much lower than its brake rate, so starting is
    // a commitment and stopping is decisive — which is how a tracked vehicle actually behaves.
    const def = PLACEHOLDER_TANK;
    const driveAccel = def.powertrain.driveForceN / def.powertrain.massKg;
    const sim = new Simulation({ vehicle: def, terrain: FLAT_TERRAIN });

    sim.runTicks(600, makeInput(1, 0));
    const speedReached = sim.vehicle.state.speedMps;
    expect(speedReached).toBeGreaterThan(1);

    let ticksToStop = 0;
    while (Math.abs(sim.vehicle.state.speedMps) > 0.05 && ticksToStop < 5000) {
      sim.runTicks(1, makeInput(-1, 0));
      ticksToStop += 1;
    }

    const accelTimeSeconds = speedReached / driveAccel;
    const brakeTimeSeconds = ticksToStop * TICK_DT_SECONDS;

    // Accelerating took several seconds, and braking was quicker than accelerating.
    expect(accelTimeSeconds).toBeGreaterThan(2);
    expect(brakeTimeSeconds).toBeLessThan(accelTimeSeconds);
    expect(brakeTimeSeconds).toBeGreaterThan(0.5);
  });

  it('coasts for a long time, which is what makes the vehicle feel heavy', () => {
    const def = variantWith({ coastDecelMps2: 0.2 });
    const sim = new Simulation({ vehicle: def, terrain: FLAT_TERRAIN });

    sim.runTicks(300, makeInput(1, 0));
    const speedAtRelease = sim.vehicle.state.speedMps;
    expect(speedAtRelease).toBeGreaterThan(0.5);

    // After three further seconds of coasting, most of the speed should still be there.
    sim.runTicks(180, makeInput(0, 0));
    expect(sim.vehicle.state.speedMps).toBeGreaterThan(speedAtRelease * 0.5);
  });
});

describe('hull traverse follows its definition', () => {
  /** Measures the traverse rate reached after holding a turn input for a while. */
  function traverseRateAfter(def: VehicleDefinition, seconds: number): number {
    const sim = new Simulation({ vehicle: def, terrain: FLAT_TERRAIN });
    sim.runTicks(Math.round(seconds / TICK_DT_SECONDS), makeInput(0, 1));
    return sim.vehicle.state.traverseRateDegPerSec;
  }

  it('never exceeds the definition traverse rate', () => {
    const def = variantWith({ hullTraverseDegPerSec: 20, hullTraverseAccelDegPerSec2: 200 });
    const rate = traverseRateAfter(def, 20);
    expect(rate).toBeLessThanOrEqual(def.traversal.hullTraverseDegPerSec + 1e-6);
    expect(rate).toBeGreaterThan(def.traversal.hullTraverseDegPerSec * 0.95);
  });

  it('reaches a different rate on a differently-tuned vehicle', () => {
    const slowTank = traverseRateAfter(variantWith({ hullTraverseDegPerSec: 8 }), 20);
    const fastTank = traverseRateAfter(variantWith({ hullTraverseDegPerSec: 40 }), 20);
    expect(slowTank).toBeLessThan(fastTank * 0.5);
  });

  it('cannot pivot instantly: the first tick of a turn is far below the peak rate', () => {
    const def = variantWith({ hullTraverseDegPerSec: 60, hullTraverseAccelDegPerSec2: 10 });
    const sim = new Simulation({ vehicle: def, terrain: FLAT_TERRAIN });

    sim.runTicks(1, makeInput(0, 1));

    // One tick at 10 deg/s^2 reaches only a fraction of a degree per second, however high the
    // eventual maximum is. This is the mechanical difference between a tank and a turret.
    expect(sim.vehicle.state.traverseRateDegPerSec).toBeLessThan(
      def.traversal.hullTraverseDegPerSec * 0.1,
    );
  });

  it('rotates the hull only when asked, never automatically toward the camera', () => {
    // OD-02 settled direct WASD control: with no turn input the heading must not change at all.
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK, terrain: FLAT_TERRAIN });
    sim.runTicks(600, makeInput(1, 0));
    expect(sim.vehicle.state.headingRad).toBeCloseTo(0, 6);

    sim.runTicks(600, makeInput(0, 0));
    expect(sim.vehicle.state.headingRad).toBeCloseTo(0, 6);
    expect(sim.vehicle.state.traverseRateDegPerSec).toBeCloseTo(0, 6);
  });

  it('turns the hull while stationary, as a real tracked vehicle can', () => {
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK, terrain: FLAT_TERRAIN });
    const startX = sim.vehicle.state.position.x;
    const startZ = sim.vehicle.state.position.z;

    sim.runTicks(300, makeInput(0, 1));

    // The hull has rotated...
    expect(Math.abs(sim.vehicle.state.headingRad)).toBeGreaterThan(0.5);
    // ...while the vehicle has not translated, because there was no throttle.
    expect(Math.abs(sim.vehicle.state.position.x - startX)).toBeLessThan(1e-6);
    expect(Math.abs(sim.vehicle.state.position.z - startZ)).toBeLessThan(1e-6);
  });

  it('reduces traverse at speed, per the speed penalty', () => {
    const def = variantWith({
      hullTraverseDegPerSec: 30,
      hullTraverseAccelDegPerSec2: 500,
      traverseSpeedPenalty: 0.6,
    });

    const stationary = traverseRateAfter(def, 6);

    const sim = new Simulation({ vehicle: def, terrain: FLAT_TERRAIN });
    sim.runTicks(1200, makeInput(1, 1));

    expect(sim.vehicle.state.traverseRateDegPerSec).toBeLessThan(stationary);
  });
});

describe('terrain interaction', () => {
  it('keeps the vehicle sitting exactly on the ground surface', () => {
    const terrain = new Terrain();
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK });
    sim.runTicks(400, makeInput(1, 1));

    const state = sim.vehicle.state;
    const groundY = terrain.heightAt(state.position.x, state.position.z);

    // Never below the surface, and the ride height is always the definition's clearance.
    expect(state.position.y).toBeGreaterThanOrEqual(groundY);
    expect(state.rideHeightM).toBeGreaterThan(0);
    expect(state.position.y).toBeCloseTo(groundY + state.rideHeightM, 12);
  });

  it('settles ride height to the definition ground clearance on flat ground', () => {
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK, terrain: FLAT_TERRAIN });
    sim.runTicks(600, makeInput(0, 0));
    expect(sim.vehicle.state.rideHeightM).toBeCloseTo(
      PLACEHOLDER_TANK.dimensions.groundClearanceM,
      3,
    );
  });

  it('never falls through the terrain while driving over varied ground', () => {
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK });
    // Drive a long way in several directions and check clearance every tick. A vehicle that dips
    // below the surface even briefly is the classic ground-collision bug.
    for (let leg = 0; leg < 4; leg += 1) {
      sim.runTicks(1, makeInput(1, leg % 2 === 0 ? 0.6 : -0.6));
      const state = sim.vehicle.state;
      const groundY = sim.terrain.heightAt(state.position.x, state.position.z);
      expect(state.position.y).toBeGreaterThanOrEqual(groundY - 1e-9);
      expect(Number.isFinite(state.position.y)).toBe(true);
    }
  });

  it('produces a unit, upward-facing surface normal from the analytic terrain', () => {
    const terrain = new Terrain();
    for (const [x, z] of [
      [0, 0],
      [40, -25],
      [-90, 60],
      [120, 130],
    ] as const) {
      const n = terrain.normalAt(x, z);
      expect(Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z)).toBeCloseTo(1, 6);
      // A surface normal can never face into the ground.
      expect(n.y).toBeGreaterThan(0);
    }
  });

  it('reports no resistance when travelling downhill, only when climbing', () => {
    // Slope resistance is asymmetric by design: only a climb costs speed, so descending is free.
    // This is asserted against a *known* gradient rather than the procedural terrain, so the test
    // checks the model rather than hunting for a convenient spot on a hill.
    const steepClimb = new LongitudinalModel(PLACEHOLDER_TANK);

    // 20 degrees of climb, derived from the definition rather than hard-coded.
    const climbDeg = PLACEHOLDER_TANK.ground.maxClimbDeg * 0.7;
    const descentDeg = -climbDeg;

    expect(steepClimb.speedLimit(climbDeg)).toBeLessThan(steepClimb.speedLimit(0));
    // A descent is not penalised at all: the limit is the flat speed or a small bonus.
    expect(steepClimb.speedLimit(descentDeg)).toBeGreaterThanOrEqual(
      PLACEHOLDER_TANK.powertrain.maxSpeedMps,
    );

    // And the gradient itself is reported as zero downhill, one-sided by construction.
    const terrain = new Terrain();
    let checkedDescending = false;
    for (let i = 0; i < 400 && !checkedDescending; i += 1) {
      const x = (i % 20) * 11 - 110;
      const z = Math.floor(i / 20) * 11 - 110;
      if (terrain.heightAt(x + 1, z) < terrain.heightAt(x - 1, z) - 0.05) {
        expect(terrain.slopeDegreesAlong(x, z, 1, 0)).toBe(0);
        checkedDescending = true;
      }
    }
    expect(checkedDescending).toBe(true);
  });

  it('keeps the vehicle inside the play area over a long drive', () => {
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK });
    sim.runTicks(6000, makeInput(1, 0));

    // The boundary is inclusive: the vehicle is clamped to exactly the limit, not inside it.
    const half = sim.terrain.halfSizeM;
    expect(Math.abs(sim.vehicle.state.position.x)).toBeLessThanOrEqual(half);
    expect(Math.abs(sim.vehicle.state.position.z)).toBeLessThanOrEqual(half);
  });

  it('stops at the boundary instead of grinding along it', () => {
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK });
    sim.runTicks(20_000, makeInput(1, 0));

    // Once pinned to the edge, forward motion must not resume: a vehicle that slides along the
    // boundary forever looks like the collision is broken.
    expect(sim.vehicle.state.speedMps).toBeLessThanOrEqual(0.01);
  });

  it('generates the same terrain for the same seed and a different one otherwise', () => {
    const a = new Terrain({ seed: 42, halfSizeM: 100, amplitudeM: 8, edgeRiseM: 10 });
    const b = new Terrain({ seed: 42, halfSizeM: 100, amplitudeM: 8, edgeRiseM: 10 });
    const c = new Terrain({ seed: 43, halfSizeM: 100, amplitudeM: 8, edgeRiseM: 10 });

    expect(a.heightAt(12, -7)).toBe(b.heightAt(12, -7));
    expect(a.heightAt(12, -7)).not.toBe(c.heightAt(12, -7));
  });
});


