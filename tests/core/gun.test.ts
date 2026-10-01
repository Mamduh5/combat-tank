import { describe, expect, it } from 'vitest';
import {
  createMainGunState,
  isGunLoaded,
  reloadProgress,
  trunnionPosition,
  tryFire,
  updateMainGun,
} from '../../src/core/vehicle/main-gun.js';
import { createTurretState, gunDirection } from '../../src/core/vehicle/turret.js';
import { Simulation, TICK_DT_SECONDS } from '../../src/core/sim/world.js';
import { makeInput } from '../../src/shared/input.js';
import { vec3 } from '../../src/shared/vec3.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';

/**
 * Gun and reload tests.
 *
 * The load-bearing rule from the owner is that **firing is the core's decision, not the player's**.
 * A fire input is a request; the gun refuses it while reloading. That has to hold in the core rather
 * than in the client, because from V9 the server is the authority and a client-owned reload timer
 * could simply be ignored.
 */

const DT = TICK_DT_SECONDS;
const TRUNNION = vec3(0, 1.42, 0);

describe('reload cycle', () => {
  it('starts loaded', () => {
    const state = createMainGunState();
    expect(state.loadState).toBe('loaded');
    expect(isGunLoaded(state)).toBe(true);
    expect(state.reloadRemainingSeconds).toBe(0);
  });

  it('takes the configured reload duration to become loaded again', () => {
    const state = createMainGunState();
    const reloadSeconds = PLACEHOLDER_TANK.mainGun.reloadSeconds;

    tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0);
    expect(state.loadState).toBe('reloading');

    // Advance to just before the reload completes.
    const almostTicks = Math.ceil((reloadSeconds - 0.02) / DT);
    for (let i = 0; i < almostTicks; i += 1) {
      updateMainGun(state, DT);
    }
    expect(isGunLoaded(state)).toBe(false);

    // A few more ticks and it is ready.
    for (let i = 0; i < 5; i += 1) {
      updateMainGun(state, DT);
    }
    expect(isGunLoaded(state)).toBe(true);
    expect(state.reloadRemainingSeconds).toBe(0);
  });

  it('uses a different duration when the definition changes', () => {
    const definition = { ...PLACEHOLDER_TANK, mainGun: { ...PLACEHOLDER_TANK.mainGun, reloadSeconds: 1 } };
    const state = createMainGunState();

    tryFire(state, definition, TRUNNION, createTurretState(), 0);
    for (let i = 0; i < Math.ceil(1.5 / DT); i += 1) {
      updateMainGun(state, DT);
    }
    expect(isGunLoaded(state)).toBe(true);
  });

  it('reports reload progress from zero to one', () => {
    const state = createMainGunState();
    const reloadSeconds = PLACEHOLDER_TANK.mainGun.reloadSeconds;
    expect(reloadProgress(state, reloadSeconds)).toBe(1);

    tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0);
    expect(reloadProgress(state, reloadSeconds)).toBeCloseTo(0, 2);

    for (let i = 0; i < Math.ceil((reloadSeconds / 2) / DT); i += 1) {
      updateMainGun(state, DT);
    }
    // Halfway through the reload the bar should be roughly half full.
    expect(reloadProgress(state, reloadSeconds)).toBeGreaterThan(0.4);
    expect(reloadProgress(state, reloadSeconds)).toBeLessThan(0.6);
  });
});

describe('firing', () => {
  it('produces a shot when loaded', () => {
    const state = createMainGunState();
    const muzzle = tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0);

    expect(muzzle).not.toBeNull();
    expect(state.shotsFired).toBe(1);
  });

  it('refuses to fire while reloading, and does not count the attempt', () => {
    const state = createMainGunState();
    tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0);

    // Holding the trigger down during a reload must not queue rounds or shorten the reload.
    for (let i = 0; i < 60; i += 1) {
      expect(tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0)).toBeNull();
    }
    expect(state.shotsFired).toBe(1);
  });

  it('does not restart the reload when a request is refused', () => {
    const state = createMainGunState();
    tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0);

    const halfway = Math.ceil((PLACEHOLDER_TANK.mainGun.reloadSeconds / 2) / DT);
    for (let i = 0; i < halfway; i += 1) {
      tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0);
      updateMainGun(state, DT);
    }

    // The gun must finish on schedule, not be pushed back by the refused requests.
    for (let i = 0; i < halfway + 10; i += 1) {
      updateMainGun(state, DT);
    }
    expect(isGunLoaded(state)).toBe(true);
  });

  it('fires again once the reload completes', () => {
    const state = createMainGunState();
    tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0);

    for (let i = 0; i < Math.ceil(PLACEHOLDER_TANK.mainGun.reloadSeconds / DT) + 1; i += 1) {
      updateMainGun(state, DT);
    }

    expect(tryFire(state, PLACEHOLDER_TANK, TRUNNION, createTurretState(), 0)).not.toBeNull();
    expect(state.shotsFired).toBe(2);
  });

  it('spawns the shell at the muzzle, along the barrel', () => {
    const state = createMainGunState();
    const turret = createTurretState();
    const direction = gunDirection(turret, 0);

    const muzzle = tryFire(state, PLACEHOLDER_TANK, TRUNNION, turret, 0);
    expect(muzzle).not.toBeNull();

    // The muzzle is one barrel length from the trunnion, along the gun's own direction.
    const barrelLength = PLACEHOLDER_TANK.mainGun.barrelLengthM;
    expect(muzzle!.x).toBeCloseTo(TRUNNION.x + direction.x * barrelLength, 9);
    expect(muzzle!.y).toBeCloseTo(TRUNNION.y + direction.y * barrelLength, 9);
    expect(muzzle!.z).toBeCloseTo(TRUNNION.z + direction.z * barrelLength, 9);
  });

  it('places the gun at the ring height above the vehicle', () => {
    const pivot = trunnionPosition(vec3(5, 2, -3), PLACEHOLDER_TANK.turret.ringHeightM);
    expect(pivot.x).toBe(5);
    expect(pivot.z).toBe(-3);
    expect(pivot.y).toBeCloseTo(2 + PLACEHOLDER_TANK.turret.ringHeightM, 9);
  });
});

describe('end-to-end firing through the simulation', () => {
  /** Builds a simulation on flat ground so a shot's outcome is unambiguous. */
  function flatSimulation() {
    return new Simulation({
      vehicle: PLACEHOLDER_TANK,
      spawn: vec3(0, 0, 0),
      terrain: { seed: 1, halfSizeM: 2000, amplitudeM: 0, edgeRiseM: 0 },
    });
  }

  it('spawns a real shell in flight when the player fires', () => {
    const sim = flatSimulation();
    const aimPoint = vec3(0, 0, 200);

    // Aim level, let the turret settle, then fire.
    for (let i = 0; i < 120; i += 1) {
      sim.tick(makeInput(0, 0, aimPoint, false));
    }
    sim.tick(makeInput(0, 0, aimPoint, true));

    expect(sim.telemetry.shotsFired).toBe(1);
    expect(sim.shells.activeCount).toBe(1);
  });

  it('rate-limits held fire to one shot per reload period', () => {
    const sim = flatSimulation();
    const aimPoint = vec3(0, 0, 200);

    for (let i = 0; i < 120; i += 1) {
      sim.tick(makeInput(0, 0, aimPoint, false));
    }

    // Hold the trigger continuously for three full reload periods.
    const holdSeconds = PLACEHOLDER_TANK.mainGun.reloadSeconds * 3;
    const heldTicks = Math.ceil(holdSeconds / DT);
    for (let i = 0; i < heldTicks; i += 1) {
      sim.tick(makeInput(0, 0, aimPoint, true));
    }

    // A shot goes out at t = 0 and then once per completed reload, so three reload periods yield three
    // shots — not the several hundred an unlimited trigger would produce. This is the property that
    // matters: the *rate* is bounded by the gun, not by how often the input is sampled.
    expect(sim.telemetry.shotsFired).toBe(3);
    expect(sim.telemetry.shotsFired).toBeLessThan(heldTicks / 10);
  });

  it('reports an impact long after the shot, proving the shell travels', () => {
    const sim = flatSimulation();
    const aimPoint = vec3(0, 0, 300);

    for (let i = 0; i < 120; i += 1) {
      sim.tick(makeInput(0, 0, aimPoint, false));
    }
    const fireTick = sim.tickCount;
    sim.tick(makeInput(0, 0, aimPoint, true));
    expect(sim.impacts).toHaveLength(0);

    let impactTick = -1;
    for (let i = 0; i < 60 * 20; i += 1) {
      sim.tick(makeInput(0, 0, aimPoint, false));
      if (sim.impacts.length > 0) {
        impactTick = sim.tickCount;
        break;
      }
    }

    expect(impactTick).toBeGreaterThan(fireTick);
    // Not an instant hit: the shell has to cover the distance.
    expect(impactTick - fireTick).toBeGreaterThan(10);

    const impact = sim.impacts[0]!;
    expect(impact.shellId).toBeGreaterThan(0);
    expect(impact.shooterId).toBe(PLACEHOLDER_TANK.id);
    expect(impact.targetKind).toBe('terrain');
    expect(impact.flightTimeSeconds).toBeGreaterThan(0);
  });

  it('clears impacts on the tick after they are reported', () => {
    // A consumer that polls once per frame must see each impact exactly once.
    const sim = flatSimulation();
    const aimPoint = vec3(0, 0, 150);

    for (let i = 0; i < 120; i += 1) {
      sim.tick(makeInput(0, 0, aimPoint, false));
    }
    sim.tick(makeInput(0, 0, aimPoint, true));

    let sawImpact = false;
    let repeatedImpact = false;
    for (let i = 0; i < 60 * 20; i += 1) {
      sim.tick(makeInput(0, 0, aimPoint, false));
      if (sim.impacts.length > 0) {
        if (sawImpact) {
          repeatedImpact = true;
        }
        sawImpact = true;
      }
    }

    expect(sawImpact).toBe(true);
    expect(repeatedImpact).toBe(false);
  });

  it('keeps hull rotation independent of the turret while both are active', () => {
    // Drive and turn while aiming off to one side: the hull must not be dragged toward the aim.
    const sim = flatSimulation();
    const aimPoint = vec3(150, 0, 150);

    for (let i = 0; i < 180; i += 1) {
      sim.tick(makeInput(0.5, 0.5, aimPoint, false));
    }

    const hullDeg = (sim.telemetry.headingRad * 180) / Math.PI;
    const turretDeg = (sim.telemetry.turretWorldHeadingRad * 180) / Math.PI;

    // The hull turned under throttle and steering, and the turret is not simply welded to it.
    expect(Math.abs(hullDeg)).toBeGreaterThan(0);
    expect(Math.abs(turretDeg - hullDeg)).toBeGreaterThan(1);
  });
});