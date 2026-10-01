import { atan, clamp, cos, normalize, radToDeg, sin, type Vec3, vec3 } from '../math/index.js';

/**
 * Procedural arena terrain.
 *
 * V1 needed terrain only to evaluate driving. V4 needs it to produce a **duel**: enough relief that
 * where a tank stands decides whether it can shoot, be shot, or drive at all.
 *
 * The surface remains an **analytic function** `height(x, z)`, not a sampled grid. That choice still
 * matters: an analytic surface gives exact heights and normals at any point, so a vehicle resting on
 * a slope does not jitter between neighbouring grid cells. Normals come from central differences of
 * the same function, so they always agree with the surface the player sees.
 *
 * ## V4 addition: authored cover
 *
 * The sine ridges alone give undulating ground but no *cover* — nothing to hide behind, so the best
 * strategy was always to sit in the open. `ArenaCover` adds a small hand-placed set of ridges,
 * mounds and depressions on top of the procedural base, chosen to create three things:
 *
 *  - somewhere to break line of sight, so the duel has pauses and the opponent has to search;
 *  - high ground worth taking, so position is contested rather than incidental;
 *  - a depression to fight from, so approaching is a decision.
 *
 * This is deliberately **one encounter space**, not a map system. The cover is a fixed, seeded list
 * evaluated by the same `heightAt` call, so it costs nothing to query, needs no separate collider,
 * and cannot drift out of agreement with the surface — which is the exact bug class `terrain-grid.ts`
 * exists to prevent.
 *
 * Full authored-map tooling is deferred to V6. See `docs/open-decisions.md` OD-10.
 */

/**
 * One piece of arena terrain that modifies the base surface.
 *
 * A **radial bump** rather than a full heightmap stamp: the contribution falls off smoothly to zero
 * at `radiusM`, which means cover blends into the ground instead of meeting it at a visible seam,
 * and a vehicle driving across the boundary experiences a slope rather than a wall. Every cover
 * feature is therefore *driveable*, which matters because the alternative — hard walls — would need
 * a collision system V4 deliberately does not build.
 */
export interface ArenaCover {
  readonly id: string;
  /** Centre in world space. */
  readonly x: number;
  readonly z: number;
  /** Radius the feature fades out over, metres. */
  readonly radiusM: number;
  /**
   * Peak height change at the centre, metres. Positive raises ground (a mound or ridge), negative
   * digs it (a depression or cutting).
   */
  readonly heightM: number;
}

/**
 * The V4 encounter's cover, as prototype level design.
 *
 * Placed by hand relative to the arena rather than generated, because *good* cover placement is a
 * design judgement and random placement reliably produces either nothing useful or an unreadable
 * thicket. These are tuned against the default spawn scan and the opponent's opening position; if
 * the arena layout changes, these need revisiting.
 *
 * The shapes are chosen for distinct tactical roles:
 *  - **Two mounds** as the high ground worth contesting, placed off-centre so neither spawn is on
 *    top of one and the fight has to move.
 *  - **A long low ridge** between the spawns, tall enough to break a vehicle-sized line of sight at
 *    ground level, which is what creates the search-and-reacquire rhythm.
 *  - **Two depressions** as covered approach lanes, shallow enough to drive out of under fire.
 */
export const ARENA_COVER: readonly ArenaCover[] = Object.freeze([
  // North-west mound: the highest ground on the field, and deliberately *not* on the player's spawn
  // axis, so it has to be earned by driving rather than starting on it.
  { id: 'cover-mound-nw', x: -46, z: 58, radiusM: 44, heightM: 5.5 },
  // South-east mound: the mirror position. Holding both is what a player who wins the opening
  // exchange should be trying to do.
  { id: 'cover-mound-se', x: 52, z: 46, radiusM: 42, heightM: 4.5 },
  // Central ridge: breaks the straight line between the two spawns, so neither side opens the
  // encounter with a free shot and the opponent has to come around or over it.
  { id: 'cover-ridge-centre', x: 8, z: 44, radiusM: 46, heightM: 4 },
  // Two shallow cuttings on the flanks: covered lanes for closing without being seen head-on.
  { id: 'cover-cutting-west', x: -62, z: 30, radiusM: 30, heightM: -3 },
  { id: 'cover-cutting-east', x: 68, z: 24, radiusM: 30, heightM: -3 },
]);

/**
 * The largest `heightM / radiusM` ratio a cover feature may use.
 *
 * A smoothstep bump's steepest gradient is `1.5 * height / radius`, so the ratio alone sets how steep
 * the feature is: it is the only number that decides whether cover is something a tank drives over or
 * something a tank collides with.
 *
 * Every feature above stays at or under this. Measured, not assumed: a feature's gradient stacks with
 * whatever the procedural ridges are already doing beneath it, so a mound that looks gentle in
 * isolation can produce a face the vehicle physically cannot climb once combined with the base
 * terrain. Keeping the added gradient small leaves the base terrain in charge of the real slope.
 *
 * Enforced by a test, because a comment does not stop the next person raising a mound.
 */
export const COVER_MAX_SLOPE_RATIO = 0.17;

/** Radial distance over which the bowl lifts the ground toward the centre. */
const ARENA_BOWL_RADIUS_M = 90;

export interface TerrainConfig {
  /** Seed for the ridge phases and amplitudes. Same seed always produces the same terrain. */
  readonly seed: number;
  /** Half-extent of the square play area, in metres. The play area spans -halfSize..+halfSize. */
  readonly halfSizeM: number;
  /** Peak vertical scale of the terrain, in metres. */
  readonly amplitudeM: number;
  /** How quickly the terrain rises toward the map edge to form a soft boundary. */
  readonly edgeRiseM: number;
  /**
   * Authored cover features added in V4. Defaults to `ARENA_COVER` in `DEFAULT_TERRAIN_CONFIG`.
   *
   * Omitted entirely (rather than defaulted to the cover list) when a caller supplies its own terrain
   * config, so an explicitly constructed terrain gets exactly the surface it asked for. A defaulting
   * `?? ARENA_COVER` here would silently add mounds to a caller who configured flat ground for a
   * ballistics test, and the shell would hit a hill the test never knew existed.
   */
  readonly cover?: readonly ArenaCover[];

  /**
   * Depth of the shallow dish that holds the encounter near the middle of the map, metres.
   *
   * Zero disables it. Opt-in for the same reason as `cover`: a caller configuring a specific surface
   * must get that surface. Set in `DEFAULT_TERRAIN_CONFIG`; absent means flat.
   */
  readonly bowlDepthM?: number;
}

/**
 * The V4 encounter arena: the V3 range plus authored cover and a shallow central dish.
 *
 * The dish exists because the spawn scan looks for the most *consistent* surroundings, and on the bare
 * V3 surface it selected a plateau high on the map with the opponent nowhere in sight. A gentle bowl
 * near the origin keeps the encounter near the middle, where the cover is placed.
 */
export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  seed: 20261001,
  halfSizeM: 260,
  // Reduced from V3R's 9 m for V4, deliberately.
  //
  // The V3 range was a *proving ground*: one vehicle, stationary target, and the terrain's job was only
  // to make driving interesting. A duel needs somewhere two tanks can actually manoeuvre. At 9 m the
  // shortest ridge layer (95 m wavelength) reaches roughly 31 degrees, and measurement showed the
  // opponent spawning 14 m below the player on ground neither could usefully manoeuvre across.
  //
  // At 5 m the same layer reaches about 18 degrees, which the vehicle climbs comfortably, and the
  // authored cover supplies the tactical interest that raw amplitude was previously providing. The
  // arena's character now comes from designed features rather than from the noise floor.
  amplitudeM: 5,
  edgeRiseM: 26,
  cover: ARENA_COVER,
  bowlDepthM: 2.2,
};


interface RidgeLayer {
  readonly dirX: number;
  readonly dirZ: number;
  /** Wavelength in metres. The surface repeats over this distance. */
  readonly wavelengthM: number;
  readonly phase: number;
  readonly amplitude: number;
}

/**
 * Wavelengths of the three ridge layers, in metres.
 *
 * These are the most important numbers in the terrain, and they were originally expressed as
 * angular frequency, which was a mistake worth recording. A frequency of 0.6–1.6 radians per metre
 * is a wavelength of roughly 4–10 m, which produces corrugated noise rather than hills: no practical
 * collision grid can represent it, so the physics surface and the analytic surface disagree by tens
 * of metres, and the slopes are near-vertical rather than drivable.
 *
 * Expressed as wavelengths, the intent is legible and the constraint is checkable. A sine layer's
 * steepest gradient is `amplitude * 2*PI / wavelength`, so the shortest layer below sets the scale:
 * with `amplitudeM` of 9 and a 95 m wavelength that is about 0.59, or 31°. Layers combine, so the
 * worst ground in the map is steeper than any single layer, but stays within a range a tank can
 * either climb or deliberately go around.
 */
const RIDGE_WAVELENGTHS_M = [340, 170, 95] as const;

export class Terrain {
  private readonly config: TerrainConfig;

  // Ridge parameters are derived once from the seed, then held as fields. Deriving them per
  // sample would be both slower and a chance for the surface to differ between two call sites.
  private readonly ridgeA: RidgeLayer;
  private readonly ridgeB: RidgeLayer;
  private readonly ridgeC: RidgeLayer;
  /**
   * Authored cover, held once at construction.
   *
   * A field rather than read from `config` on every sample: `heightAt` is called on every terrain
   * query, every sub-step of every shell, and many times per frame by the renderer, so the list is
   * resolved once. An empty list when none is configured, which keeps the "no cover" case cheap.
   */
  private readonly cover: readonly ArenaCover[];

  /** Depth of the central dish, metres. Zero when the caller configured a flat surface. */
  private readonly bowlDepthM: number;

  constructor(config: TerrainConfig = DEFAULT_TERRAIN_CONFIG) {
    this.config = config;
    this.ridgeA = makeRidge(config.seed, 0x9e3779b9, RIDGE_WAVELENGTHS_M[0]);
    this.ridgeB = makeRidge(config.seed + 1, 0x85ebca6b, RIDGE_WAVELENGTHS_M[1]);
    this.ridgeC = makeRidge(config.seed + 2, 0xc2b2ae35, RIDGE_WAVELENGTHS_M[2]);
    // Both resolved once, defaulting to *no* arena features rather than to the arena list. A caller
    // that supplies its own config has asked for a specific surface; silently adding cover to it would
    // mean a ballistics test configured for flat ground could hit a mound it never knew existed.
    this.cover = config.cover ?? [];
    this.bowlDepthM = config.bowlDepthM ?? 0;
  }

  /** Surface height in metres at a world position. */
  heightAt(x: number, z: number): number {
    const { halfSizeM, amplitudeM, edgeRiseM } = this.config;

    let h = 0;
    h += ridgeHeight(this.ridgeA, x, z);
    h += ridgeHeight(this.ridgeB, x, z);
    h += ridgeHeight(this.ridgeC, x, z);
    h *= amplitudeM;

    // Soft boundary: rise toward the map edge using a smoothstep of the normalised radius, so
    // the player is gently guided inward instead of hitting an invisible wall.
    const r = Math.sqrt(x * x + z * z) / halfSizeM;
    if (r > 0.62) {
      const t = clamp((r - 0.62) / 0.38, 0, 1);
      h += edgeRiseM * t * t * (3 - 2 * t);
    }

    h += this.bowlHeight(x, z);
    h += this.coverHeight(x, z);

    return h;
  }

  /**
   * The shallow dish that keeps the encounter near the middle of the map.
   *
   * Negative inside `ARENA_BOWL_RADIUS_M`, fading to nothing at the edge, so the centre of the arena
   * sits in a shallow hollow and the ground rises gently away from it.
   */
  private bowlHeight(x: number, z: number): number {
    const d = Math.sqrt(x * x + z * z);
    if (d >= ARENA_BOWL_RADIUS_M) {
      return 0;
    }
    const t = 1 - d / ARENA_BOWL_RADIUS_M;
    // Smoothstep in both directions: flat at the centre, flat at the rim, no crease at either end.
    return -this.bowlDepthM * t * t * (3 - 2 * t);
  }

  /**
   * Total contribution of every cover feature at a point.
   *
   * Each feature uses a **smoothstep falloff** rather than a linear ramp. A linear ramp has a slope
   * discontinuity at the feature's radius, which a vehicle driving over it feels as a small jolt;
   * the smoothstep reaches zero gradient at the rim, so cover is entered and left as a slope.
   */
  private coverHeight(x: number, z: number): number {
    const cover = this.cover;
    let total = 0;
    for (let i = 0; i < cover.length; i += 1) {
      const feature = cover[i]!;
      const dx = x - feature.x;
      const dz = z - feature.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= feature.radiusM) {
        continue;
      }
      const t = 1 - d / feature.radiusM;
      total += feature.heightM * t * t * (3 - 2 * t);
    }
    return total;
  }

  /**
   * True when nothing between two points rises above the line joining them.
   *
   * The V4 opponent needs this every tick to decide whether it can see the player, and the spawn
   * checks already wanted it, so it lives on `Terrain` rather than being reimplemented per caller.
   * A march rather than a full raycast: it runs at 60 Hz and only needs to be right about whether a
   * ridge is in the way, not to find the exact silhouette edge.
   *
   * `marginM` is clearance required *below* the sight line. A positive value means the ground must
   * stay slightly below the line for the shot to count as clear, which stops a vehicle that is
   * barely visible being treated as fully visible and produces the more forgiving, less jittery
   * behaviour that suits an opponent rather than a laser designator.
   */
  hasLineOfSight(from: Vec3, to: Vec3, steps = 24, marginM = 0.6): boolean {
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      const rayHeight = from.y + (to.y - from.y) * t;
      if (this.heightAt(x, z) > rayHeight - marginM) {
        return false;
      }
    }
    return true;
  }

  /** The authored cover features in this terrain, for rendering and for tests. */
  get coverFeatures(): readonly ArenaCover[] {
    return this.cover;
  }

  /**
   * Unit surface normal at a world position, from central differences of `heightAt`.
   *
   * The sample offset is a compromise: too small and floating-point cancellation makes the normal
   * noisy, too large and the tank's pitch/roll lags behind real terrain. 0.25 m is well under the
   * size of a tank track and large enough to stay numerically clean.
   */
  normalAt(x: number, z: number): Vec3 {
    const e = 0.25;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);

    // Central-difference gradient, negated and scaled to form the normal.
    const dx = (hR - hL) / (2 * e);
    const dz = (hU - hD) / (2 * e);
    return normalize(vec3(-dx, 1, -dz));
  }

  /**
   * Slope of the ground along a horizontal direction, in degrees.
   *
   * Positive means uphill in the direction of travel. Computed from the gradient rather than by
   * comparing two heights, so it stays correct on long, shallow slopes where a height difference
   * over a short baseline would round away.
   *
   * **`dirX`/`dirZ` must be a unit vector.** The direction is projected onto the gradient directly, so
   * passing `(4, 0)` instead of `(1, 0)` reports roughly four times the true slope. This is a silent
   * error — nothing throws, the number is simply wrong — and it has already cost real debugging time:
   * a 29-degree slope was read as 66 degrees, which made authored terrain look unusable and sent a
   * tuning pass in the wrong direction entirely. Callers pass normalised directions for this reason.
   */
  slopeDegreesAlong(x: number, z: number, dirX: number, dirZ: number): number {
    const e = 0.5;
    const gradX = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gradZ = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);

    // Rate of climb per metre travelled along the direction.
    const rise = gradX * dirX + gradZ * dirZ;
    if (rise <= 0) {
      return 0;
    }
    return radToDeg(atan(rise));
  }

  /** True when the position is inside the playable area. */
  contains(x: number, z: number): boolean {
    return Math.abs(x) < this.config.halfSizeM && Math.abs(z) < this.config.halfSizeM;
  }

  get halfSizeM(): number {
    return this.config.halfSizeM;
  }

  get seed(): number {
    return this.config.seed;
  }
}

/**
 * Builds one ridge layer from the seed.
 *
 * Only the *direction*, *phase* and a small amplitude jitter are randomised. The wavelength is
 * supplied by the caller, because it is a design decision about the shape of the battlefield rather
 * than a per-layer variation.
 */
function makeRidge(seed: number, salt: number, wavelengthM: number): RidgeLayer {
  // Cheap integer hash to derive stable, well-spread values from the seed. Integer ops only, so
  // this is deterministic everywhere.
  let h = (seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;

  // Direction as an angle in [0, 2PI).
  const angle = (h / 4294967296) * Math.PI * 2;
  const phase = (((h >>> 20) % 2048) / 2048) * Math.PI * 2;
  // Amplitude jitter in [0.6, 1.0], so layers vary in prominence without any becoming extreme.
  const amplitude = 0.6 + ((h >>> 12) % 1000) / 2500;

  return { dirX: cos(angle), dirZ: sin(angle), wavelengthM, phase, amplitude };
}

function ridgeHeight(layer: RidgeLayer, x: number, z: number): number {
  const k = (Math.PI * 2) / layer.wavelengthM;
  return layer.amplitude * sin((x * layer.dirX + z * layer.dirZ) * k + layer.phase);
}
