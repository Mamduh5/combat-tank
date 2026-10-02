import { Terrain, type TerrainConfig } from './terrain.js';
import {
  placeStructures,
  structureHitSegment,
  type PlacedStructure,
  type Structure,
} from './structures.js';
import { sampleConcealment, type ConcealmentSample, type ConcealmentZone } from './concealment.js';
import type { Vec3 } from '../math/index.js';

/**
 * The battlefield: terrain, hard cover, and concealment, and the one line-of-sight answer they
 * together produce.
 *
 * ## Why this exists as a single object
 *
 * V5 had a line of sight that only knew about terrain height, living on `Terrain`. That was correct
 * while the only occluders were hills. V6 adds buildings, which means the question "can A see B" can no
 * longer be answered by one number, and the temptation is to answer it in three places — the AI, the
 * spotting system, and the renderer — which is precisely how a renderer and a simulation come to
 * disagree about whether a wall is solid.
 *
 * So there is one `Battlefield`, it owns all three kinds of occluder, and it exposes exactly one
 * `hasLineOfSight`. Every system that needs to know whether something is visible asks this object. A
 * player who can see a building is being told the truth by the same code the opponent is.
 *
 * ## Sampling
 *
 * The terrain part of the test is inherited from `Terrain` and unchanged. The structure part is a
 * separate pass over the structure list rather than being folded into the same loop, because the two
 * want different things: terrain wants fine steps to catch a ridge, structures want a segment test
 * because a building is a hard edge that fine sampling would only approximate.
 */

/** A named place on the map, for routes, spawn areas, and readable landmarks. */
export interface MapZone {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly radiusM: number;
  /** What this place is for, in the map author's words. Shown on the debug overlay. */
  readonly role: string;
}

/** The complete authored description of a battlefield. */
export interface BattlefieldData {
  /** Stable name, used by tools and by the debug overlay. */
  readonly id: string;
  readonly displayName: string;
  /** Terrain configuration. */
  readonly terrain: TerrainConfig;
  /** Hard cover. Solid to shells, and to sight where `blocksSight`. */
  readonly structures: readonly Structure[];
  /** Gameplay concealment. Every one of these is drawn; anything not listed is decorative. */
  readonly concealment: readonly ConcealmentZone[];
  /** Named places: spawns, routes, and landmarks. Descriptive; no gameplay effect yet. */
  readonly zones: readonly MapZone[];
  /** Where the player starts, and which way it faces. */
  readonly playerSpawn: { readonly x: number; readonly z: number; readonly headingRad: number };
  /** Where the opponent starts. */
  readonly enemySpawn: { readonly x: number; readonly z: number; readonly headingRad: number };
}

/** Why a sight line failed, so callers can explain themselves and tests can assert precisely. */
export type BlockedBy = 'terrain' | 'structure';

export interface LineOfSightResult {
  readonly clear: boolean;
  /** What blocked it, or `null` when clear. */
  readonly blockedBy: BlockedBy | null;
  /** Id of the blocking structure, when `blockedBy` is `'structure'`. */
  readonly blockerId: string | null;
  /** Where the line was stopped, for the debug overlay. */
  readonly blockedAt: Vec3 | null;
}

const CLEAR: LineOfSightResult = Object.freeze({
  clear: true,
  blockedBy: null,
  blockerId: null,
  blockedAt: null,
});

export class Battlefield {
  /** The height field. Exposed because locomotion, ballistics and the renderer all need it. */
  readonly terrain: Terrain;
  /** Hard cover, with rotations and ground heights resolved. */
  readonly structures: readonly PlacedStructure[];
  /** Gameplay concealment. */
  readonly concealment: readonly ConcealmentZone[];
  /** Named places, for tools and the overlay. */
  readonly zones: readonly MapZone[];
  readonly id: string;
  readonly displayName: string;
  /** Where the player starts, and which way it faces. */
  readonly playerSpawn: BattlefieldData['playerSpawn'];
  /** Where the opponent starts. */
  readonly enemySpawn: BattlefieldData['enemySpawn'];

  /**
   * Whether this map states its own spawns, or is the legacy arena and leaves that choice to the
   * simulation.
   */
  private readonly hasAuthoredSpawn: boolean;

  constructor(data: BattlefieldData) {
    this.id = data.id;
    this.displayName = data.displayName;
    this.terrain = new Terrain(data.terrain);
    // Resolved against this battlefield's own terrain, so a structure always sits on the ground the
    // player can see rather than on a height field belonging to a different map.
    this.structures = placeStructures(data.structures, (x, z) => this.terrain.heightAt(x, z));
    this.concealment = data.concealment;
    this.zones = data.zones;
    this.playerSpawn = data.playerSpawn;
    this.enemySpawn = data.enemySpawn;
    // The legacy arena passes spawns at the origin purely because the interface requires them. Treating
    // that as an authored spawn would silently move every V5 test's start position, so the two cases are
    // told apart explicitly rather than guessed at.
    this.hasAuthoredSpawn = data.id !== 'legacy-arena';
  }

  get halfSizeM(): number {
    return this.terrain.halfSizeM;
  }

  /** True when a point is on the playable ground. */
  contains(x: number, z: number): boolean {
    return this.terrain.contains(x, z);
  }

  /**
   * Whether a clear line exists from `from` to `to`, and what stops it if not.
   *
   * The single source of truth for visibility. Terrain is sampled as a height field — inherited from
   * `Terrain` and unchanged from V5 — and structures are tested as solid volumes on top.
   *
   * @param marginM clearance required below the sight line, for terrain. See `Terrain.hasLineOfSight`.
   */
  hasLineOfSight(from: Vec3, to: Vec3, steps = 24, marginM = 0.6): LineOfSightResult {
    if (!this.terrain.hasLineOfSight(from, to, steps, marginM)) {
      return {
        clear: false,
        blockedBy: 'terrain',
        blockerId: null,
        // The terrain path does not report where it stopped, so the midpoint is reported as an
        // approximation for the overlay rather than inventing a precise-looking wrong answer.
        blockedAt: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 },
      };
    }

    for (const placed of this.structures) {
      const hit = structureHitSegment(placed, from, to);
      if (hit !== null && placed.structure.blocksSight) {
        return {
          clear: false,
          blockedBy: 'structure',
          blockerId: placed.structure.id,
          blockedAt: hit.point,
        };
      }
    }

    return CLEAR;
  }

  /** Convenience wrapper for callers that only need a yes or no. */
  canSee(from: Vec3, to: Vec3, steps = 24, marginM = 0.6): boolean {
    return this.hasLineOfSight(from, to, steps, marginM).clear;
  }

  /** How concealed the ground is at a point. See `concealment.ts`. */
  concealmentAt(x: number, z: number): ConcealmentSample {
    return sampleConcealment(this.concealment, x, z);
  }

  /**
   * The player's authored spawn, dropped onto this battlefield's ground.
   *
   * The map states a spawn as a *position and a facing*; the simulation needs a point on the actual
   * surface. Reading the height here rather than in the map data is what keeps the two from
   * disagreeing — the same reason `placeStructures` takes a height function.
   *
   * `null` when the map does not state a spawn, which is the legacy arena's case. See
   * `hasAuthoredSpawn`.
   */
  playerSpawnAtTerrain(): Vec3 | null {
    if (!this.hasAuthoredSpawn) {
      return null;
    }
    return {
      x: this.playerSpawn.x,
      y: this.terrain.heightAt(this.playerSpawn.x, this.playerSpawn.z),
      z: this.playerSpawn.z,
    };
  }

  /** The opponent's authored spawn, on the actual ground. See `playerSpawnAtTerrain`. */
  enemySpawnAtTerrain(): Vec3 | null {
    if (!this.hasAuthoredSpawn) {
      return null;
    }
    return {
      x: this.enemySpawn.x,
      y: this.terrain.heightAt(this.enemySpawn.x, this.enemySpawn.z),
      z: this.enemySpawn.z,
    };
  }

}
