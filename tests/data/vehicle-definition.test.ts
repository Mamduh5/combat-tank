import { describe, expect, it } from 'vitest';
import {
  assertValidVehicleDefinition,
  validateVehicleDefinition,
} from '../../src/shared/vehicle-definition-schema.js';
import { AVAILABLE_VEHICLE_IDS, PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import { makeInput, NEUTRAL_INPUT } from '../../src/shared/input.js';
import type { VehicleDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * Vehicle definition tests (ADR-0003).
 *
 * The point of these is that a vehicle is *data*, validated at load time. The V8 acceptance
 * criterion is that adding a vehicle means adding a data file, and that an invalid definition fails
 * loudly rather than producing a subtly broken tank. Both properties are established here at V1 with
 * a single placeholder, so the mechanism is proven before anything depends on it.
 */

/** A structurally valid definition, used as the base for each mutation below. */
function validDefinition(): VehicleDefinition {
  return structuredClone(PLACEHOLDER_TANK);
}

describe('the shipped placeholder definition', () => {
  it('passes validation', () => {
    const result = validateVehicleDefinition(PLACEHOLDER_TANK, PLACEHOLDER_TANK.id);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('is registered as the only available vehicle in V1', () => {
    expect(AVAILABLE_VEHICLE_IDS).toEqual([PLACEHOLDER_TANK.id]);
  });

  it('has plausible, self-consistent handling numbers', () => {
    const { powertrain, traversal, ground, dimensions } = PLACEHOLDER_TANK;

    // Reverse must be slower than forward, as on a real tracked vehicle.
    expect(powertrain.maxReverseSpeedMps).toBeLessThan(powertrain.maxSpeedMps);

    // Coasting must be weaker than braking, or releasing the throttle would stop the tank faster
    // than asking it to brake, which feels wrong.
    expect(powertrain.coastDecelMps2).toBeLessThan(powertrain.brakeDecelMps2);

    // Traverse must take real time, or the vehicle pivots like a turret (vision principle P5).
    const secondsToFullTraverse =
      traversal.hullTraverseDegPerSec / traversal.hullTraverseAccelDegPerSec2;
    expect(secondsToFullTraverse).toBeGreaterThan(0.5);

    // Descending must be possible at least as steeply as climbing.
    expect(ground.maxDescendDeg).toBeGreaterThan(ground.maxClimbDeg);

    // Dimensions must be a coherent size, not a typo.
    expect(dimensions.lengthM).toBeGreaterThan(dimensions.widthM);
    expect(dimensions.widthM).toBeGreaterThan(dimensions.heightM);
    expect(dimensions.groundClearanceM).toBeLessThan(dimensions.heightM);
  });

  it('has an acceleration consistent with its mass and force', () => {
    // 32 t with 78 kN is a plausible ~2.4 m/s^2, which takes several seconds to reach top speed.
    // If this drifts, the vehicle stops feeling heavy.
    const accel = PLACEHOLDER_TANK.powertrain.driveForceN / PLACEHOLDER_TANK.powertrain.massKg;
    expect(accel).toBeGreaterThan(1.5);
    expect(accel).toBeLessThan(4);

    expect(PLACEHOLDER_TANK.powertrain.maxSpeedMps / accel).toBeGreaterThan(2);
  });
});

describe('validation rejects bad definitions', () => {
  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 42, 'tank', []]) {
      expect(validateVehicleDefinition(bad).valid).toBe(false);
    }
  });

  it('rejects a missing id, and names the field', () => {
    const def = validDefinition() as unknown as Record<string, unknown>;
    delete def['id'];
    const result = validateVehicleDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/id/);
  });

  it('rejects a negative mass', () => {
    const def = validDefinition();
    (def.powertrain as { massKg: number }).massKg = -1;
    const result = validateVehicleDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/massKg/);
  });

  it('rejects a zero top speed, which would make the vehicle undrivable', () => {
    const def = validDefinition();
    (def.powertrain as { maxSpeedMps: number }).maxSpeedMps = 0;
    expect(validateVehicleDefinition(def).valid).toBe(false);
  });

  it('rejects a traverse penalty outside [0, 1]', () => {
    const def = validDefinition();
    (def.traversal as { traverseSpeedPenalty: number }).traverseSpeedPenalty = 1.5;
    const result = validateVehicleDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/traverseSpeedPenalty/);
  });

  it('rejects a missing section entirely', () => {
    const def = validDefinition() as unknown as Record<string, unknown>;
    delete def['ground'];
    const result = validateVehicleDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/ground/);
  });

  it('rejects non-finite numbers, which would silently poison the simulation', () => {
    const def = validDefinition();
    (def.powertrain as { driveForceN: number }).driveForceN = Number.NaN;
    expect(validateVehicleDefinition(def).valid).toBe(false);

    const def2 = validDefinition();
    (def2.dimensions as { lengthM: number }).lengthM = Number.POSITIVE_INFINITY;
    expect(validateVehicleDefinition(def2).valid).toBe(false);
  });

  it('reports every problem at once, not only the first', () => {
    // A designer fixing a data file wants the whole list, not one error per run.
    const def = validDefinition();
    (def.powertrain as { massKg: number }).massKg = -1;
    (def.traversal as { hullTraverseDegPerSec: number }).hullTraverseDegPerSec = 0;
    expect(validateVehicleDefinition(def).errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('assertValidVehicleDefinition', () => {
  it('returns silently for a valid definition', () => {
    expect(() => assertValidVehicleDefinition(validDefinition(), 'test')).not.toThrow();
  });

  it('throws a message naming the failing path', () => {
    const def = validDefinition();
    (def.powertrain as { massKg: number }).massKg = -5;

    // A bad definition must stop the process, not produce a vehicle that behaves wrongly and gets
    // debugged through the renderer.
    expect(() => assertValidVehicleDefinition(def, 'broken-tank')).toThrow(/broken-tank/);
    expect(() => assertValidVehicleDefinition(def, 'broken-tank')).toThrow(/massKg/);
  });
});

describe('input command construction', () => {
  it('clamps out-of-range axes to the valid range', () => {
    expect(makeInput(5, -5)).toEqual({ throttle: 1, turn: -1 });
    expect(makeInput(-99, 99)).toEqual({ throttle: -1, turn: 1 });
  });

  it('substitutes zero for non-finite input, so NaN can never reach the simulation', () => {
    expect(makeInput(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ throttle: 0, turn: 0 });
  });

  it('provides a neutral command for coasting', () => {
    expect(NEUTRAL_INPUT).toEqual({ throttle: 0, turn: 0 });
  });
});

