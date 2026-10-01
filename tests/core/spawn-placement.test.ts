import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/core/sim/world.js';
import { Terrain } from '../../src/core/world/terrain.js';
import { TARGET_TANK } from '../../src/shared/placeholder-target.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';

/**
 * The player and the test target must start in positions that make the game playable.
 *
 * Both positions were originally fixed values: the player at a point chosen for locally flat ground,
 * and the target 60 m directly ahead at the player's own height. On the procedural terrain that put
 * the player on the crest of a hill and the target 12.6 m below them on the valley floor, hidden behind
 * the lip of the hill. The player had no indication a target existed at all.
 *
 * These tests pin the properties that made that failure impossible to miss: the target is on screen,
 * at a sensible distance, not far below the player, and reachable over ground the vehicle can drive on.
 */

describe('start positions', () => {
  // Built twice from the same default config: the simulation makes its own terrain from the config,
  // and the tests need an identically-seeded surface to measure against.
  // `targetIsOpponent: false` keeps the V3 inert target for these tests: they are about *placement*, and
  // an opponent that drives away from its spawn makes every positional assertion meaningless.
  const sim = new Simulation({
    vehicle: PLACEHOLDER_TANK,
    target: TARGET_TANK,
    targetIsOpponent: false,
  });
  const terrain = new Terrain();

  it('places the player on the surface of the terrain', () => {
    const p = sim.vehicle.state.position;
    expect(Math.abs(p.y - terrain.heightAt(p.x, p.z))).toBeLessThan(2);
  });

  it('places the target on the surface of the terrain', () => {
    const t = sim.target!.state.position;
    expect(Math.abs(t.y - terrain.heightAt(t.x, t.z))).toBeLessThan(2);
  });

  it('places the opponent in front of the player, facing the player', () => {
    const p = sim.vehicle.state.position;
    const t = sim.target!.state.position;

    const distance = Math.hypot(t.x - p.x, t.z - p.z);
    expect(distance).toBeGreaterThan(20);
    expect(distance).toBeLessThan(200);

    // V4 changed this deliberately. In V3 the target faced the same way as the player, so the opening
    // showed its rear plate and the player could delete it in four shots without ever being shot back.
    // The opponent now faces the player, so the encounter opens on its strongest frontal armour and the
    // first exchange has to be earned.
    //
    // Asserted as a bearing check rather than a heading equality, because "faces the player" is the
    // property that matters and it holds regardless of where on the map the pair are placed.
    const bearingToPlayer = Math.atan2(p.x - t.x, p.z - t.z);
    expect(Math.abs(Math.atan2(
      Math.sin(bearingToPlayer - sim.target!.state.headingRad),
      Math.cos(bearingToPlayer - sim.target!.state.headingRad),
    ))).toBeLessThan(0.02);
  });

  it('keeps the target close enough in elevation to be a usable shot', () => {
    // The original placement was 12.6 m below the player, on the valley floor behind a hill. The
    // threshold is generous because terrain has to be gentle *and* visible *and* near-level at once,
    // and the search will accept a few metres of height difference rather than place the target
    // somewhere unreachable. What matters is that the shot is roughly level, so gravity drop stays a
    // learnable effect rather than dominating the range.
    const drop = sim.vehicle.state.position.y - sim.target!.state.position.y;
    expect(Math.abs(drop)).toBeLessThan(6);
  });

  it('has unobstructed ground between the player and the target', () => {
    // The target must be visible from the player's eye, not behind a ridge. Sampled along the line.
    const p = sim.vehicle.state.position;
    const t = sim.target!.state.position;
    const eyeY = p.y + 2.4;
    const targetTopY = t.y + 2.6;

    for (let i = 1; i < 24; i += 1) {
      const f = i / 24;
      const x = p.x + (t.x - p.x) * f;
      const z = p.z + (t.z - p.z) * f;
      const lineY = eyeY + (targetTopY - eyeY) * f;
      const ground = terrain.heightAt(x, z);
      expect(ground).toBeLessThan(lineY);
    }
  });

  it('places both vehicles on ground gentle enough to drive between', () => {
    // Steep ground between the two would strand the player or make the approach pointless.
    const p = sim.vehicle.state.position;
    const t = sim.target!.state.position;

    // The gradient **along the route**, in both directions, using **unit** vectors.
    //
    // Two corrections to the original version of this test, both found by measurement:
    //
    //  - it passed (4, 0) and (0, 4) as directions, but `slopeDegreesAlong` projects the gradient onto
    //    whatever vector it is given, so it reported roughly *four times* the true slope. The test only
    //    passed originally because the V3 spawn sat on ground gentle enough to absorb a 4x error.
    //  - it sampled the world axes rather than the direction of travel. A slope *across* the route
    //    only makes a tank lean on its suspension; it does not stop it. Measured on the V4 arena, the
    //    worst cross-gradient is 28.8 degrees while the along-route gradient is 19.3 — and it is the
    //    second number that decides whether the player can drive from their spawn to the opponent.
    //
    // What is asserted is therefore the gradient the vehicle actually has to climb, against the
    // vehicle's own climb limit.
    const lengthM = Math.hypot(t.x - p.x, t.z - p.z);
    const dirX = (t.x - p.x) / lengthM;
    const dirZ = (t.z - p.z) / lengthM;

    let worstSlope = 0;
    for (let i = 0; i <= 20; i += 1) {
      const f = i / 20;
      const x = p.x + (t.x - p.x) * f;
      const z = p.z + (t.z - p.z) * f;
      worstSlope = Math.max(
        worstSlope,
        terrain.slopeDegreesAlong(x, z, dirX, dirZ),
        terrain.slopeDegreesAlong(x, z, -dirX, -dirZ),
      );
    }

    // The measured worst slope along the opening approach, against the vehicle's actual climb limit.
    //
    // This does **not** assert a comfortable margin, and that is a deliberate finding rather than a
    // weak test. The procedural terrain's shortest ridge layer (95 m wavelength, 9 m amplitude) already
    // reaches roughly 31 degrees on its own: a comparison against a terrain with no cover at all
    // measured 29.1 degrees on the same path. The encounter's opening ground is therefore governed by
    // the base surface, not by the authored cover, and no amount of tuning the cover changes it.
    //
    // What is asserted is the property that actually matters: the player can *get there*. The path
    // must be under the vehicle's climb limit, which the placement search enforces by rejecting any
    // candidate that is not (see `isPathDriveable`). A tighter margin would require changing the
    // terrain generator's wavelengths, which is a V1 decision rather than a V4 one.
    const maxClimbDeg = PLACEHOLDER_TANK.ground.maxClimbDeg;
    expect(worstSlope).toBeLessThan(maxClimbDeg);
  });

  it('is deterministic: the same terrain always yields the same positions', () => {
    // Placement must not vary between runs, or every integration test that fires at the target
    // becomes flaky (ADR-0001, ADR-0005).
    const again = new Simulation({
      vehicle: PLACEHOLDER_TANK,
      target: TARGET_TANK,
      targetIsOpponent: false,
    });
    expect(again.vehicle.state.position).toEqual(sim.vehicle.state.position);
    expect(again.target!.state.position).toEqual(sim.target!.state.position);
  });

  it('leaves the target stationary over time', () => {
    // Scalar values captured directly rather than spreading `state.position`. The simulation mutates
    // the position record in place, so holding a reference would compare the object against itself
    // and pass for the wrong reason; and heading is a sibling field on `state`, not on `position`, so
    // it has to be captured on its own rather than picked up by a spread.
    const t = sim.target!.state;
    const startX = t.position.x;
    const startZ = t.position.z;
    const startHeading = t.headingRad;

    for (let i = 0; i < 120; i += 1) {
      sim.advance(1 / 60);
    }

    expect(t.position.x).toBeCloseTo(startX, 6);
    expect(t.position.z).toBeCloseTo(startZ, 6);
    expect(t.headingRad).toBeCloseTo(startHeading, 6);
  });
});