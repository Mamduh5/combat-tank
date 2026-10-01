import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/core/sim/world.js';
import { applyPenetration, createDamageState, type DamageState } from '../../src/core/damage/damage-model.js';
import { makeInput } from '../../src/shared/input.js';
import { vec3 } from '../../src/shared/vec3.js';
import { TARGET_TANK } from '../../src/shared/placeholder-target.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';

/**
 * A destroyed target must read as destroyed, and stay destroyed.
 *
 * The V3R playability pass made the wreck state part of how the player understands the outcome, not
 * just a number in a panel. That makes the transition worth pinning: the visual tint and the
 * simulation's own destroyed flag have to agree, because a tank that reads as intact while the panel
 * says it is destroyed teaches the player to distrust the whole readout.
 *
 * Damage is applied **directly through the damage model** rather than by firing shells. The question
 * here is what the destroyed *state* does — whether it latches, whether it stops the vehicle, and
 * whether the health figure the HUD bar is drawn from stays valid — not whether the gun can be aimed
 * at a stationary target from a driven position, which is ballistics and is covered in `combat.test.ts`.
 */
describe('target destruction', () => {
  /**
 * Applies one penetration to the rear of a hull at the origin, facing +Z.
 *
 * The rear is the target's thinnest plate by design, so a shot there is used to guarantee damage
 * lands rather than leaving the test at the mercy of armour tuning. Ballistics and the penetration
 * comparison are covered elsewhere; this helper exists purely to move the damage state forward.
 */
  function hitRearPlate(damage: DamageState): void {
    applyPenetration(
      TARGET_TANK,
      damage,
      // Penetration point on the rear plate, in world space.
      vec3(0, 1.0, -2.4),
      vec3(0, 0, 0),
      0,
      0,
    );
  }

  function freshSim() {
    return new Simulation({
      vehicle: PLACEHOLDER_TANK,
      target: TARGET_TANK,
      // Flat ground, so nothing about this test depends on terrain.
      terrain: { seed: 7, halfSizeM: 2000, amplitudeM: 0, edgeRiseM: 0 },
    });
  }

  it('starts alive and undamaged', () => {
    const sim = freshSim();
    expect(sim.target!.damage.destroyed).toBe(false);
    expect(sim.target!.damage.hitPoints).toBe(TARGET_TANK.survivability.hitPoints);
  });

  it('reports destroyed once hit points are gone, and stays destroyed', () => {
    const damage = createDamageState(TARGET_TANK);
    const before = damage.hitPoints;

    let guard = 0;
    while (!damage.destroyed && guard < 100) {
      guard += 1;
      hitRearPlate(damage);
    }

    expect(damage.destroyed).toBe(true);
    expect(damage.hitPoints).toBeLessThan(before);
    expect(damage.hitPoints).toBeLessThanOrEqual(0);
  });

  it('keeps the health figure a valid proportion for the HUD bar once destroyed', () => {
    const damage = createDamageState(TARGET_TANK);
    let guard = 0;
    while (!damage.destroyed && guard < 100) {
      guard += 1;
      hitRearPlate(damage);
    }

    // The HUD divides by the maximum to size the bar. A destroyed tank must not produce a negative or
    // above-one fraction, or the bar renders backwards.
    const fraction = damage.hitPoints / TARGET_TANK.survivability.hitPoints;
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThanOrEqual(1);
  });

  it('stops the destroyed target from moving or firing', () => {
    const sim = freshSim();
    const target = sim.target!;
    const pos = { ...target.state.position };

    // Kill it through the simulation's own damage state, which is the object the simulation reads.
    let guard = 0;
    while (!target.damage.destroyed && guard < 100) {
      guard += 1;
      hitRearPlate(target.damage);
    }
    expect(target.damage.destroyed).toBe(true);

    // Keep driving and firing hard: a destroyed target must ignore it entirely.
    for (let i = 0; i < 180; i += 1) {
      sim.tick(makeInput(1, 1, vec3(pos.x, pos.y + 1, pos.z + 50), true));
    }

    expect(target.state.position.x).toBeCloseTo(pos.x, 6);
    expect(target.state.position.z).toBeCloseTo(pos.z, 6);
    expect(target.telemetry.shotsFired).toBe(0);
  });
});