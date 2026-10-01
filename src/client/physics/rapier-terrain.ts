import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Terrain } from '../../core/world/terrain.js';
import { buildTerrainGrid } from '../../core/world/terrain-grid.js';
import type { Vec3 } from '../../core/math/index.js';

/**
 * Rapier-backed collision world.
 *
 * Rapier is used here for **geometry queries**, not for gameplay decisions
 * (`docs/technical-direction.md` §5). In V1 it serves two purposes:
 *
 *  1. A heightfield collider for the terrain, so the debug view can show the world the simulation
 *     stands in, and so later versions have a real collider to query against.
 *  2. Ray casts for camera obstruction handling and, from V6, line of sight.
 *
 * It deliberately does **not** drive the tank. Movement is kinematic and lives in the core
 * (ADR-0007), because handling must be a designed, designer-tunable feel that a server can
 * reproduce exactly, not an emergent property of a rigid-body solver.
 *
 * The collider is rebuilt from the core's analytic height function, so the collision world and the
 * surface the tank actually drives on cannot disagree.
 */

type Rapier = typeof RAPIER_NS;
type RapierWorld = RAPIER_NS.World;

/**
 * Grid resolution of the collision mesh.
 *
 * Slightly coarser than the render mesh (see `TERRAIN_GRID_CELLS`) because collision does not need
 * the visual fidelity, and a static trimesh's cost scales with triangle count. 128 cells over the
 * play area is roughly 4 m triangles, which is finer than any slope the vehicle actually drives.
 */
const TERRAIN_COLLISION_CELLS = 128;

/** A ray that struck geometry. */
export interface RayHit {
  /** Distance along the ray at which the hit occurred, in metres. */
  readonly distanceM: number;
  /** World-space hit point. */
  readonly point: Vec3;
  /** Surface normal at the hit, pointing away from the surface. */
  readonly normal: Vec3;
}

export class PhysicsWorld {
  private readonly RAPIER: Rapier;
  private readonly world: RapierWorld;
  private readonly terrain: Terrain;

  private constructor(RAPIER: Rapier, terrain: Terrain) {
    this.RAPIER = RAPIER;
    this.terrain = terrain;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    const { positions, indices } = buildTerrainGrid(terrain, TERRAIN_COLLISION_CELLS);

    // A triangle mesh rather than Rapier's `heightfield` shape. The heightfield takes a flat height
    // array whose index-to-axis mapping is not evident from its signature, and inferring it wrong
    // produces a collider that is quietly rotated or mirrored — a bug that reads as a terrain
    // problem rather than an indexing one. A trimesh takes explicit vertices and explicit triangle
    // indices, so there is no convention to get wrong.
    //
    // It is also built from `buildTerrainGrid`, the same geometry the renderer uses, so the
    // collision surface and the visible surface cannot drift apart.
    const desc = RAPIER.ColliderDesc.trimesh(positions, indices)
      // High friction, because the surface is used for ray casts and obstruction rather than for
      // simulated contact. The value is a placeholder until V2 needs real contact behaviour.
      .setFriction(1.0);

    this.world.createCollider(desc);

    // Rapier builds its query pipeline during `step()`, so scene queries return nothing until the
    // world has been stepped at least once. Stepping immediately means a freshly created
    // PhysicsWorld is usable, rather than silently returning `null` for every ray until the first
    // frame happens to run. There are no dynamic bodies yet, so this costs one idle step.
    this.world.step();
  }

  /**
   * Initialises Rapier and builds a collision world matching `terrain`.
   *
   * Async because the compat build's WASM must be decoded before any call. Call once at startup.
   */
  static async create(terrain: Terrain): Promise<PhysicsWorld> {
    const RAPIER = await import('@dimforge/rapier3d-compat');
    await RAPIER.init();
    return new PhysicsWorld(RAPIER, terrain);
  }

  /**
   * Casts a ray and returns the nearest hit, or `null` if nothing was struck within `maxDistanceM`.
   *
   * `solid` is true so a ray starting inside geometry reports a hit at distance zero rather than
   * missing, which is what camera obstruction handling wants.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistanceM: number): RayHit | null {
    const ray = new this.RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      normalizeToUnit(direction),
    );

    const hit = this.world.castRayAndGetNormal(ray, maxDistanceM, true);
    if (hit === null) {
      return null;
    }

    const distanceM = hit.timeOfImpact;
    return {
      distanceM,
      point: {
        x: origin.x + ray.dir.x * distanceM,
        y: origin.y + ray.dir.y * distanceM,
        z: origin.z + ray.dir.z * distanceM,
      },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
    };
  }

  /**
   * Casts a ray straight down from above `x, z` and returns the ground height and normal.
   *
   * Provided for the debug view and as a cross-check on the collision world. Note that the
   * **simulation** does not use this: `Terrain.heightAt` already gives the exact analytic height,
   * and a heightfield ray cast quantises it to the grid, which shows up as jitter as a vehicle
   * crosses cells. Movement uses the analytic surface; Rapier answers visual and collision queries.
   */
  groundHeightAt(x: number, z: number): RayHit | null {
    const probeTopM = this.terrain.heightAt(x, z) + 200;
    return this.raycast({ x, y: probeTopM, z }, { x: 0, y: -1, z: 0 }, 400);
  }

  /**
   * Line-of-sight test between two world points.
   *
   * Returns true when nothing obstructs the segment. V1 uses this for camera obstruction; V6 reuses
   * the same query for spotting, so it lives on the physics world rather than in the camera.
   */
  hasLineOfSight(from: Vec3, to: Vec3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distanceM < 1e-6) {
      return true;
    }
    // Stop just short of the target so the target's own geometry is not counted as an obstruction.
    return this.raycast(from, { x: dx, y: dy, z: dz }, distanceM - 0.05) === null;
  }

  /** Advances the physics world. No dynamic bodies exist in V1, so this only refreshes queries. */
  step(): void {
    this.world.step();
  }

  /** Releases the WASM-backed world. */
  dispose(): void {
    this.world.free();
  }

  /** Exposed so the client can draw Rapier's own debug lines if needed. */
  debugRender(): { vertices: Float32Array; colors: Float32Array } {
    return this.world.debugRender();
  }
}

function normalizeToUnit(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-9) {
    return { x: 0, y: -1, z: 0 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

