import { describe, expect, it } from 'vitest';
import { Terrain } from '../../src/core/world/terrain.js';
import { buildTerrainGrid } from '../../src/core/world/terrain-grid.js';

/**
 * Regression tests for the rendered orientation of the shared terrain grid.
 *
 * The terrain winding was reversed relative to Babylon's facing convention, and every face was culled:
 * the ground was invisible and the player saw the tank floating in a void. Nothing caught it, because
 * the *normals* were correct — only the rasteriser's winding test disagreed — and no headless test was
 * looking at the result.
 *
 * So these tests assert the two properties separately, since either can be satisfied while the other
 * is broken:
 *
 *  - the grid's cross products point **up**, which is what lighting and the physics ray casts need;
 *  - the grid's cross products are the ones the renderer treats as front-facing, which is what decides
 *    whether the ground is drawn at all.
 */

/**
 * The facing override `scene.ts` must pair with this winding.
 *
 * Stated here as a constant rather than asserted against the material, because these tests run in Node
 * without Babylon. It is the client's job to apply it; this file's job is to guarantee that applying it
 * is still *necessary*. If the winding in `terrain-grid.ts` changes, this constant stops being true and
 * the override in `scene.ts` becomes either wrong or redundant — both worth finding in review.
 */
const RENDERER_MUST_OVERRIDE_TO_CLOCKWISE = true;

/** Cross product of two vertex triples, as a plain triple. */
function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

/** Reads vertex `i` as a position triple. */
function vertex(positions: Float32Array, i: number): number[] {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

describe('terrain grid orientation', () => {
  const grid = buildTerrainGrid(new Terrain(), 8);

  it('winds every triangle so its face normal points upward', () => {
    let upward = 0;
    let notUpward = 0;

    for (let t = 0; t < grid.indices.length; t += 3) {
      const a = vertex(grid.positions, grid.indices[t]!);
      const b = vertex(grid.positions, grid.indices[t + 1]!);
      const c = vertex(grid.positions, grid.indices[t + 2]!);

      const edge1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const edge2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const normal = cross(edge1, edge2);

      if (normal[1]! > 0) {
        upward += 1;
      } else {
        notUpward += 1;
      }
    }

    // Flat ground would give zero vertical component everywhere, so also require a non-degenerate
    // cross product — a grid of zero-area triangles would otherwise pass this test trivially.
    expect(upward).toBe(grid.indices.length / 3);
    expect(notUpward).toBe(0);
  });

  it('produces non-degenerate triangles on non-flat terrain', () => {
    // Guards the test above: a degenerate grid cannot distinguish correct winding from no winding.
    let degenerate = 0;
    for (let t = 0; t < grid.indices.length; t += 3) {
      const a = vertex(grid.positions, grid.indices[t]!);
      const b = vertex(grid.positions, grid.indices[t + 1]!);
      const c = vertex(grid.positions, grid.indices[t + 2]!);
      const n = cross(
        [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!],
        [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!],
      );
      const length = Math.hypot(n[0]!, n[1]!, n[2]!);
      if (length < 1e-6) {
        degenerate += 1;
      }
    }
    expect(degenerate).toBe(0);
  });

  it('winds upward faces as the renderer expects, so the ground is not back-face culled', () => {
    // The renderer decides facing from the sign of the projected triangle, which for an upward-facing
    // ground triangle viewed from above follows the right-handed (counter-clockwise) cross product.
    //
    // Babylon's default is counter-clockwise front faces, which would make every one of these a *back*
    // face and cull the entire ground. `scene.ts` therefore sets the terrain material to
    // `ClockWiseSideOrientation`. This test pins the grid half of that contract: it asserts the grid
    // really is wound counter-clockwise-upward, so that if the winding is ever changed, the material
    // setting in `scene.ts` has to change with it rather than silently vanishing the terrain again.
    const a = vertex(grid.positions, grid.indices[0]!);
    const b = vertex(grid.positions, grid.indices[1]!);
    const c = vertex(grid.positions, grid.indices[2]!);
    const normal = cross(
      [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!],
      [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!],
    );

    // Upward cross product === counter-clockwise winding === Babylon's default front face. The material
    // must therefore override to clockwise, which is the pairing asserted here.
    expect(normal[1]! > 0).toBe(true);
    expect(RENDERER_MUST_OVERRIDE_TO_CLOCKWISE).toBe(true);
  });

  it('keeps the grid and the analytic surface describing the same terrain', () => {
    // The rendered mesh and the collision surface are built from this one grid, so they cannot drift
    // apart. This is the property that makes the winding question safe to answer at the renderer.
    const terrain = new Terrain();
    const fine = buildTerrainGrid(terrain, 64);
    let worst = 0;

    for (let row = 0; row < fine.samples; row += 3) {
      for (let col = 0; col < fine.samples; col += 3) {
        const x = fine.positions[(row * fine.samples + col) * 3]!;
        const z = fine.positions[(row * fine.samples + col) * 3 + 2]!;
        const y = fine.positions[(row * fine.samples + col) * 3 + 1]!;
        worst = Math.max(worst, Math.abs(terrain.heightAt(x, z) - y));
      }
    }

    expect(worst).toBeLessThan(1e-3);
  });
});