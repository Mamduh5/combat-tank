import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../src/client/physics/rapier-terrain.js';
import { Simulation } from '../../src/core/sim/world.js';
import { Terrain } from '../../src/core/world/terrain.js';
import { makeInput } from '../../src/shared/input.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';

/**
 * Integration test for the client's physics layer.
 *
 * This is the one place the client and the core meet, and it is where a disagreement between them
 * would show up as a vehicle that floats above the ground, sinks into hills, or a camera that clips
 * through terrain. Babylon itself is not exercised — it needs a WebGL context, and testing a
 * renderer is low value next to testing the *agreement* between the simulated surface and the
 * collision surface.
 *
 * Rapier's compat build inlines its WASM, so the first test pays a one-off decode cost; that is why
 * the timeouts in `vitest.config.ts` are generous.
 */

/** Points sampled across the play area, spanning flat ground and slopes. */
const SAMPLE_POINTS: Array<[number, number]> = [
  [0, 0],
  [25, -40],
  [-60, 35],
  [90, 110],
  [-130, -75],
];

describe('PhysicsWorld against the simulation terrain', () => {
  it('reports ground height matching the analytic surface the vehicle drives on', async () => {
    const terrain = new Terrain();
    const physics = await PhysicsWorld.create(terrain);

    // The collision mesh samples the analytic surface onto a grid, so it can only be as accurate as
    // that sampling allows. With the terrain's shortest wavelength at 95 m and roughly 4 m cells the
    // error is well under a quarter of a metre — far below anything visible, and far tighter than
    // the half-cell bound that would merely prove the two describe the same surface.
    let worstErrorM = 0;
    for (const [x, z] of SAMPLE_POINTS) {
      const hit = physics.groundHeightAt(x, z);
      expect(hit).not.toBeNull();

      worstErrorM = Math.max(worstErrorM, Math.abs(terrain.heightAt(x, z) - hit!.point.y));
    }
    expect(worstErrorM).toBeLessThan(0.5);

    physics.dispose();
  });

  it('reports upward-facing surface normals', async () => {
    const terrain = new Terrain();
    const physics = await PhysicsWorld.create(terrain);

    for (const [x, z] of SAMPLE_POINTS.slice(0, 3)) {
      const hit = physics.groundHeightAt(x, z);
      expect(hit).not.toBeNull();
      // A downward-facing normal would mean the triangle winding is inverted, which makes every ray
      // cast in the game behave strangely. The threshold allows for genuinely steep ground: the
      // steepest part of the map is around 45°, whose normal still has a positive y component.
      expect(hit!.normal.y).toBeGreaterThan(0.3);
    }

    physics.dispose();
  });

  it('finds clear line of sight across open ground', async () => {
    const terrain = new Terrain();
    const physics = await PhysicsWorld.create(terrain);

    const from = { x: 0, y: terrain.heightAt(0, 0) + 1, z: 0 };
    const to = { x: 4, y: terrain.heightAt(4, 0) + 1, z: 0 };
    expect(physics.hasLineOfSight(from, to)).toBe(true);

    physics.dispose();
  });

  it('casts a ray that stops at the terrain surface', async () => {
    const terrain = new Terrain();
    const physics = await PhysicsWorld.create(terrain);

    const from = { x: 15, y: terrain.heightAt(15, -25) + 50, z: -25 };
    const hit = physics.raycast(from, { x: 0, y: -1, z: 0 }, 200);

    expect(hit).not.toBeNull();
    expect(hit!.distanceM).toBeGreaterThan(0);
    expect(hit!.distanceM).toBeLessThan(200);
    expect(hit!.point.y).toBeCloseTo(terrain.heightAt(15, -25), 0);

    physics.dispose();
  });

  it('returns no hit for a ray that points away from the terrain', async () => {
    const terrain = new Terrain();
    const physics = await PhysicsWorld.create(terrain);

    expect(physics.raycast({ x: 0, y: terrain.heightAt(0, 0) + 5, z: 0 }, { x: 0, y: 1, z: 0 }, 50)).toBeNull();

    physics.dispose();
  });

  it('blocks line of sight through a hillside', async () => {
    const terrain = new Terrain();
    const physics = await PhysicsWorld.create(terrain);

    // Find a ridge rather than hard-coding coordinates, which would break if the terrain seed or
    // amplitude changed: two points on opposite sides of ground that rises well above both.
    let foundBlocked = false;
    for (let attempt = 0; attempt < 600 && !foundBlocked; attempt += 1) {
      const x = ((attempt % 25) - 12) * 15;
      const z = (Math.floor(attempt / 25) - 12) * 15;
      const y = terrain.heightAt(x, z);

      if (terrain.heightAt(x + 30, z) > y + 6) {
        const blocked = !physics.hasLineOfSight(
          { x, y: y + 0.5, z },
          { x: x + 60, y: y + 0.5, z },
        );
        expect(blocked).toBe(true);
        foundBlocked = true;
      }
    }

    // If no suitable ridge exists the terrain is too flat for this to be testable; failing loudly
    // beats silently passing an assertion that never ran.
    expect(foundBlocked).toBe(true);

    physics.dispose();
  });

  it('keeps the vehicle on the surface while the physics world agrees with it', async () => {
    // The end-to-end check that matters for V1: drive over real terrain and confirm the collision
    // surface beneath the vehicle never sits meaningfully above where the hull is resting.
    const terrain = new Terrain();
    const physics = await PhysicsWorld.create(terrain);
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK });

    let worstPenetrationM = 0;
    for (let i = 0; i < 900; i += 1) {
      sim.runTicks(1, makeInput(1, i % 120 < 60 ? 0.5 : -0.5));
      const state = sim.vehicle.state;

      const ground = physics.groundHeightAt(state.position.x, state.position.z);
      if (ground !== null) {
        const hullFloorY = state.position.y - state.rideHeightM;
        worstPenetrationM = Math.max(worstPenetrationM, ground.point.y - hullFloorY);
      }
    }

    // Allow for the heightfield's sampling error, but nothing more.
    expect(worstPenetrationM).toBeLessThan(1.0);

    physics.dispose();
  });
});

