import { clamp, type Vec3 } from '../math/index.js';
import type { Terrain } from './terrain.js';

/**
 * The terrain's triangle geometry, generated once from the analytic height function.
 *
 * This exists so the **renderer and the physics world are built from the same vertices and the same
 * triangle indices**. That is not a tidy-up; it is what makes the two provably agree. Building them
 * independently means two samplings of the same function with two independent chances to disagree,
 * and a mismatch shows up as a tank hovering over a hill or a camera clipping through ground.
 *
 * Sharing the geometry also removes a whole class of bug: Rapier's `heightfield` shape takes a flat
 * height array whose index-to-axis mapping is not obvious from its signature, and getting it wrong
 * yields a collider that is plausible but rotated or mirrored. A `trimesh` takes explicit vertices
 * and explicit indices, so there is no convention to infer.
 *
 * This module is in `core` rather than `client` because it is pure geometry with no platform
 * dependency, which is exactly what the core is for.
 */

/**
 * Grid resolution used for the shared terrain mesh.
 *
 * 200 cells, raised from 160 during the V6 railway work.
 *
 * The reason is not smoothness, it is *occlusion*. The mesh linearly interpolates between samples, so on
 * concave ground the rendered surface sits slightly *above* the true analytic height — and anything drawn
 * on that surface (a road, a rail bed, a building's base) is swallowed by it. At 160 cells across a 500 m
 * map the error is a few centimetres, which is enough to hide a ribbon laid 10 cm up. 200 cells cuts the
 * interpolation error by roughly a third and keeps flat ground flatter for free.
 *
 * The cost is 40 000 vertices rather than 25 000, which is nothing for a mesh this simple.
 */
export const TERRAIN_GRID_CELLS = 200;

export interface TerrainGrid {
  /** Flat xyz vertex positions, row-major with `row -> z` and `col -> x`. */
  readonly positions: Float32Array;
  /** Flat triangle indices, three per triangle. */
  readonly indices: Uint32Array;
  /** Per-vertex rgba colours, a height-based ramp so slopes are readable. */
  readonly colors: Float32Array;
  readonly cells: number;
  readonly samples: number;
  readonly halfSizeM: number;
  /** Lowest and highest vertex height, for the colour ramp and for camera bounds. */
  readonly minHeight: number;
  readonly maxHeight: number;
}

/** Builds the shared terrain geometry from the analytic surface. */
export function buildTerrainGrid(terrain: Terrain, cells = TERRAIN_GRID_CELLS): TerrainGrid {
  const half = terrain.halfSizeM;
  const samples = cells + 1;
  const step = (half * 2) / cells;

  const positions = new Float32Array(samples * samples * 3);
  const colors = new Float32Array(samples * samples * 4);

  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;

  // First pass: sample heights, tracking the range so the colour ramp is relative to this terrain
  // rather than hard-coded to absolute metres.
  for (let row = 0; row < samples; row += 1) {
    const z = -half + row * step;
    for (let col = 0; col < samples; col += 1) {
      const h = terrain.heightAt(-half + col * step, z);
      positions[(row * samples + col) * 3 + 1] = h;
      if (h < minHeight) {
        minHeight = h;
      }
      if (h > maxHeight) {
        maxHeight = h;
      }
    }
  }
  const heightRange = Math.max(1e-3, maxHeight - minHeight);

  // Second pass: write x/z and the colour ramp.
  for (let row = 0; row < samples; row += 1) {
    const z = -half + row * step;
    for (let col = 0; col < samples; col += 1) {
      const i = row * samples + col;
      const h = positions[i * 3 + 1]!;

      positions[i * 3] = -half + col * step;
      positions[i * 3 + 2] = z;

      const t = clamp((h - minHeight) / heightRange, 0, 1);
      colors[i * 4] = t;
      colors[i * 4 + 1] = t;
      colors[i * 4 + 2] = t;
      colors[i * 4 + 3] = 1;
    }
  }

  // Two triangles per cell. Wound so the computed face normals point **upward**, which is what the
  // lighting and the physics engine's ray-cast normals depend on.
  //
  // This winding is the one a right-handed cross product calls upward-facing, which means Babylon's
  // default renderer treats these faces as back faces and culls them — the ground then disappears and
  // the player sees the tank floating in a void. The render side is corrected in `scene.ts` by setting
  // the terrain material's `sideOrientation`, which is the honest place for it: the geometry and the
  // normals stay in the conventional orientation, and only the renderer is told to flip.
  //
  // Regression-tested by `tests/core/terrain-grid.test.ts`, which asserts the normals point up, and by
  // `tests/client/terrain-material.test.ts`, which asserts the material presents them front-facing.
  const indices = new Uint32Array(cells * cells * 6);
  let t = 0;
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const i0 = row * samples + col;
      const i1 = i0 + 1;
      const i2 = i0 + samples;
      const i3 = i2 + 1;

      indices[t++] = i0;
      indices[t++] = i2;
      indices[t++] = i1;
      indices[t++] = i1;
      indices[t++] = i2;
      indices[t++] = i3;
    }
  }

  return { positions, indices, colors, cells, samples, halfSizeM: half, minHeight, maxHeight };
}

/** Reads a vertex position from the grid, for callers that need a single point. */
export function gridPosition(grid: TerrainGrid, row: number, col: number): Vec3 {
  const i = (row * grid.samples + col) * 3;
  return { x: grid.positions[i]!, y: grid.positions[i + 1]!, z: grid.positions[i + 2]! };
}
