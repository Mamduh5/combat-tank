import { describe, expect, it } from 'vitest';
import {
  createTurretState,
  gunDirection,
  gunElevationDeg,
  gunHeadingRad,
  updateTurret,
} from '../../src/core/vehicle/turret.js';
import { vec3 } from '../../src/shared/vec3.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import type { VehicleDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * Turret and gun tests.
 *
 * These cover the property the owner singled out: **hull, turret, gun and firing are separate
 * systems**. Most of the assertions are about what the turret must *not* do — it must not snap, must
 * not follow the hull's rotation on its own, and must respect mechanical limits.
 */

const DT = 1 / 60;
const ORIGIN = vec3(0, 0, 0);

/** Runs the servo for a number of seconds toward an aim point. */
function servoFor(
  state: ReturnType<typeof createTurretState>,
  aimPoint: ReturnType<typeof vec3> | null,
  seconds: number,
  hullHeadingRad = 0,
  definition: VehicleDefinition = PLACEHOLDER_TANK,
): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i += 1) {
    updateTurret(state, definition, hullHeadingRad, ORIGIN, aimPoint, DT);
  }
}

/** A point `distanceM` away on the horizontal plane, in the direction of `bearingRad`. */
function pointAt(bearingRad: number, distanceM: number, heightM = 0) {
  return vec3(Math.sin(bearingRad) * distanceM, heightM, Math.cos(bearingRad) * distanceM);
}

/** Copies the placeholder with specific turret/gun overrides. */
function variantWith(overrides: {
  traverseDegPerSec?: number;
  traverseAccelDegPerSec2?: number;
  maxTraverseDeg?: number;
  elevateRateDegPerSec?: number;
  maxElevationDeg?: number;
  maxDepressionDeg?: number;
}): VehicleDefinition {
  return {
    ...PLACEHOLDER_TANK,
    turret: { ...PLACEHOLDER_TANK.turret, ...overrides },
    mainGun: { ...PLACEHOLDER_TANK.mainGun, ...overrides },
  };
}

describe('turret traverse', () => {
  it('does not snap to an aim point', () => {
    const state = createTurretState();
    // One tick toward a target 90 degrees away.
    updateTurret(state, PLACEHOLDER_TANK, 0, ORIGIN, pointAt(Math.PI / 2, 100), DT);

    // A 90-degree swing at 32 deg/s with a 45 deg/s^2 ramp cannot happen in 1/60 s.
    const movedDeg = (gunHeadingRad(state, 0) * 180) / Math.PI;
    expect(Math.abs(movedDeg)).toBeLessThan(5);
  });

  it('reaches the aim bearing given enough time', () => {
    const state = createTurretState();
    servoFor(state, pointAt(Math.PI / 2, 100), 8);
    expect(gunHeadingRad(state, 0)).toBeCloseTo(Math.PI / 2, 2);
  });

  it('never exceeds the configured traverse rate', () => {
    const state = createTurretState();
    const maxRate = PLACEHOLDER_TANK.turret.traverseDegPerSec;

    for (let i = 0; i < 600; i += 1) {
      updateTurret(state, PLACEHOLDER_TANK, 0, ORIGIN, pointAt(Math.PI, 200), DT);
      expect(Math.abs(state.traverseRateDegPerSec)).toBeLessThanOrEqual(maxRate + 1e-6);
    }
  });

  it('follows a different rate when the definition changes', () => {
    const slow = variantWith({ traverseDegPerSec: 8, traverseAccelDegPerSec2: 40 });
    const fast = variantWith({ traverseDegPerSec: 60, traverseAccelDegPerSec2: 400 });

    const slowState = createTurretState();
    const fastState = createTurretState();
    servoFor(slowState, pointAt(Math.PI / 2, 150), 1, 0, slow);
    servoFor(fastState, pointAt(Math.PI / 2, 150), 1, 0, fast);

    expect(Math.abs(gunHeadingRad(slowState, 0))).toBeLessThan(
      Math.abs(gunHeadingRad(fastState, 0)),
    );
  });

  it('respects the traverse arc limit', () => {
    // A narrow arc, so the limit is reachable in a test rather than after 200 degrees of travel.
    const narrow = variantWith({
      maxTraverseDeg: 20,
      traverseDegPerSec: 90,
      traverseAccelDegPerSec2: 900,
    });
    const state = createTurretState();
    servoFor(state, pointAt(Math.PI, 200), 15, 0, narrow);

    // The gun is trying to face backwards, but the ring will not let it past the arc.
    expect(Math.abs(gunHeadingRad(state, 0))).toBeLessThanOrEqual(20.5);
  });

  it('holds its bearing when there is no aim point', () => {
    const state = createTurretState();
    servoFor(state, pointAt(Math.PI / 3, 100), 5);
    const settled = gunHeadingRad(state, 0);

    // A null aim point means "no new request": the turret settles, it does not return to centre.
    servoFor(state, null, 5);
    expect(gunHeadingRad(state, 0)).toBeCloseTo(settled, 3);
  });
});

describe('turret independence from the hull', () => {
  it('changes world heading with the hull without changing its local angle', () => {
    const state = createTurretState();
    servoFor(state, pointAt(0, 100), 3);
    const localBefore = state.localAngleRad;

    // The hull turns 90 degrees. The turret is bolted to it, so the gun swings with it.
    const worldBefore = gunHeadingRad(state, 0);
    const worldAfter = gunHeadingRad(state, Math.PI / 2);

    expect(worldAfter - worldBefore).toBeCloseTo(Math.PI / 2, 6);
    // The local angle is untouched: the turret did not slew, it was carried.
    expect(state.localAngleRad).toBeCloseTo(localBefore, 9);
  });

  it('can aim 90 degrees away from the hull direction', () => {
    const state = createTurretState();
    // Hull points along +Z; the aim point is off to the side.
    servoFor(state, pointAt(Math.PI / 2, 120), 10);
    expect(gunHeadingRad(state, 0)).toBeCloseTo(Math.PI / 2, 2);
  });

  it('re-serves toward a fixed world aim point when the hull turns under it', () => {
    const state = createTurretState();
    const aimPoint = pointAt(Math.PI / 4, 200);

    servoFor(state, aimPoint, 10, 0);
    // The hull swings 180 degrees. The aim point has not moved, so the gun must come back round to
    // it — and it is the local angle that has to change to do that.
    servoFor(state, aimPoint, 25, Math.PI);

    expect(gunHeadingRad(state, Math.PI)).toBeCloseTo(Math.PI / 4, 1);
  });

  it('lags when the hull turns faster than the turret can slew', () => {
    // The point of a rate-limited turret: spin the hull and the gun cannot keep up.
    //
    // The turret must be *slower* than the hull for this to mean anything. The placeholder's turret
    // is faster than its hull, so it tracks perfectly — which is correct, and asserted separately
    // below. A deliberately sluggish turret is used here so the mechanism's limit is the binding
    // constraint rather than the hull's.
    const sluggish = variantWith({ traverseDegPerSec: 6, traverseAccelDegPerSec2: 30 });
    const state = createTurretState();
    const aimPoint = pointAt(0, 200);

    let hullHeading = 0;
    const hullStepRad = (PLACEHOLDER_TANK.traversal.hullTraverseDegPerSec * DT * Math.PI) / 180;
    for (let i = 0; i < 240; i += 1) {
      hullHeading += hullStepRad;
      updateTurret(state, sluggish, hullHeading, ORIGIN, aimPoint, DT);
    }

    // The gun is still short of where it was asked to point, because it physically cannot get there.
    const errorDeg = Math.abs((gunHeadingRad(state, hullHeading) * 180) / Math.PI);
    expect(errorDeg).toBeGreaterThan(10);
  });

  it('keeps up when the turret is faster than the hull', () => {
    // The complement of the test above: with the placeholder's own numbers the turret out-turns the
    // hull, so holding a fixed world aim point while the hull spins is something it can actually do.
    const state = createTurretState();
    const aimPoint = pointAt(0, 200);

    let hullHeading = 0;
    const hullStepRad = (PLACEHOLDER_TANK.traversal.hullTraverseDegPerSec * DT * Math.PI) / 180;
    for (let i = 0; i < 240; i += 1) {
      hullHeading += hullStepRad;
      updateTurret(state, PLACEHOLDER_TANK, hullHeading, ORIGIN, aimPoint, DT);
    }

    // The target is itself moving one hull-step per tick, so the gun is always chasing a moving
    // bearing and settles a small residual behind it rather than landing exactly on it.
    expect(Math.abs(gunHeadingRad(state, hullHeading))).toBeLessThan(0.2);
  });
});

describe('gun elevation', () => {
  it('raises toward a target above the horizon', () => {
    const state = createTurretState();
    servoFor(state, pointAt(0, 100, 20), 6);
    expect(gunElevationDeg(state)).toBeGreaterThan(0);
  });

  it('never exceeds the elevation limit', () => {
    const state = createTurretState();
    // Aim at something far steeper than the gun's elevation limit.
    servoFor(state, pointAt(0, 100, 173), 10);
    expect(gunElevationDeg(state)).toBeLessThanOrEqual(
      PLACEHOLDER_TANK.mainGun.maxElevationDeg + 1e-6,
    );
  });

  it('never exceeds the depression limit', () => {
    const state = createTurretState();
    servoFor(state, pointAt(0, 20, -20), 10);
    expect(gunElevationDeg(state)).toBeGreaterThanOrEqual(
      -PLACEHOLDER_TANK.mainGun.maxDepressionDeg - 1e-6,
    );
  });

  it('respects a different elevation rate from a different definition', () => {
    const slow = variantWith({ elevateRateDegPerSec: 3 });
    const fast = variantWith({ elevateRateDegPerSec: 40 });

    const slowState = createTurretState();
    const fastState = createTurretState();
    servoFor(slowState, pointAt(0, 100, 20), 2, 0, slow);
    servoFor(fastState, pointAt(0, 100, 20), 2, 0, fast);

    expect(gunElevationDeg(slowState)).toBeLessThan(gunElevationDeg(fastState));
  });

  it('never slews faster than the configured elevation rate', () => {
    const state = createTurretState();
    for (let i = 0; i < 600; i += 1) {
      updateTurret(state, PLACEHOLDER_TANK, 0, ORIGIN, pointAt(0, 100, 50), DT);
      expect(Math.abs(state.elevateRateDegPerSec)).toBeLessThanOrEqual(
        PLACEHOLDER_TANK.mainGun.elevateRateDegPerSec + 1e-6,
      );
    }
  });
});

describe('gunDirection', () => {
  it('is a unit vector', () => {
    const state = createTurretState();
    servoFor(state, pointAt(1.1, 150, 10), 8);
    const d = gunDirection(state, 0);
    expect(Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)).toBeCloseTo(1, 6);
  });

  it('is consistent with the reported heading and elevation', () => {
    const state = createTurretState();
    servoFor(state, pointAt(0.8, 150, 8), 8);

    const d = gunDirection(state, 0);
    const elevationRad = gunElevationDeg(state) * (Math.PI / 180);

    expect(Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z))).toBeCloseTo(elevationRad, 5);
    expect(Math.atan2(d.x, d.z)).toBeCloseTo(gunHeadingRad(state, 0), 5);
  });

  it('points horizontally when the gun is level', () => {
    const state = createTurretState();
    expect(gunDirection(state, 0).y).toBeCloseTo(0, 9);
  });
});

