import { atan, clamp, cos, normalize, radToDeg, sin, type Vec3, vec3 } from '../math/index.js';

/**
 * Procedural test terrain.
 *
 * V1 needs terrain only to evaluate driving: slopes the tank can climb, slopes it should be
 * slowed or stopped by, and enough open space to feel the vehicle's weight. A real map with
 * designed cover, flanking routes and spawn points is V6 work, so this is deliberately a
 * generated heightfield rather than authored level data.
 *
 * The surface is an **analytic function** `height(x, z)`, not a sampled grid. That choice matters:
 * an analytic surface gives exact heights and exact normals at any point, so a vehicle resting on
 * a slope does not jitter between neighbouring grid cells. Normals come from central differences
 * of the same function, so they always agree with the surface the player sees.
 *
 * The shape is built from three layered, seeded sine ridges plus a bowl that lifts the map edges.
 * The bowl keeps the player inside the play area without needing invisible walls in V1.
 */
export interface TerrainConfig {
  /** Seed for the ridge phases and amplitudes. Same seed always produces the same terrain. */
  readonly seed: number;
  /** Half-extent of the square play area, in metres. The play area spans -halfSize..+halfSize. */
  readonly halfSizeM: number;
  /** Peak vertical scale of the terrain, in metres. */
  readonly amplitudeM: number;
  /** How quickly the terrain rises toward the map edge to form a soft boundary. */
  readonly edgeRiseM: number;
}

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  seed: 20261001,
  halfSizeM: 260,
  amplitudeM: 9,
  edgeRiseM: 26,
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

  constructor(config: TerrainConfig = DEFAULT_TERRAIN_CONFIG) {
    this.config = config;
    this.ridgeA = makeRidge(config.seed, 0x9e3779b9, RIDGE_WAVELENGTHS_M[0]);
    this.ridgeB = makeRidge(config.seed + 1, 0x85ebca6b, RIDGE_WAVELENGTHS_M[1]);
    this.ridgeC = makeRidge(config.seed + 2, 0xc2b2ae35, RIDGE_WAVELENGTHS_M[2]);
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

    return h;
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
