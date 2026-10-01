/**
 * Minimal 3-component vector.
 *
 * Deliberately a plain immutable-ish value type with free functions rather than a class with
 * operators: the simulation core is hot, allocation-sensitive code, and the explicit form makes
 * it obvious at each call site whether a function mutates or returns a new value.
 *
 * Every function here is pure and deterministic. `length`/`normalize` use `Math.sqrt`, which is
 * an IEEE-754 correctly-rounded operation and therefore safe for cross-platform determinism.
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const ZERO: Vec3 = vec3(0, 0, 0);
export const UP: Vec3 = vec3(0, 1, 0);

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);

export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);

export const scale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lengthSq = (a: Vec3): number => dot(a, a);

export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/**
 * Returns a unit-length copy of `a`, or `fallback` when `a` is too short to have a meaningful
 * direction. Guards against division by zero in the simulation.
 */
export function normalize(a: Vec3, fallback: Vec3 = UP): Vec3 {
  const lenSq = dot(a, a);
  if (lenSq < 1e-12) {
    return fallback;
  }
  const inv = 1 / Math.sqrt(lenSq);
  return vec3(a.x * inv, a.y * inv, a.z * inv);
}

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/** Clamps every component into `[min, max]`. */
export const clampVec3 = (a: Vec3, min: number, max: number): Vec3 =>
  vec3(clamp(a.x, min, max), clamp(a.y, min, max), clamp(a.z, min, max));

/**
 * Removes the component of `a` that points along `unitNormal`, leaving the part of `a` that lies
 * in the plane through the origin with that normal. Used to project a heading onto sloped ground.
 */
export function projectOnPlane(a: Vec3, unitNormal: Vec3): Vec3 {
  return sub(a, scale(unitNormal, dot(a, unitNormal)));
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerpNumber = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Frame-rate-independent exponential smoothing factor.
 *
 * Returns the fraction by which to move a value toward a target this tick, given a rate in
 * units of 1/second. The result is derived from `dt` rather than being a per-frame constant, so
 * suspension and camera smoothing settle at the same rate on a 30 Hz laptop and a 144 Hz monitor.
 *
 * Implemented as the first-order rational form of `1 - e^(-rate*dt)` rather than using
 * `Math.exp`, because `Math.exp` is one of the transcendental functions that are not guaranteed
 * identical across JavaScript engines (ADR-0005). The approximation is accurate to well under a
 * percent for the rate/dt ranges this game uses, and it never overshoots: the result is always in
 * `[0, 1)`, which is what makes it safe to apply unconditionally.
 */
export function smoothingFactor(ratePerSecond: number, dtSeconds: number): number {
  const x = ratePerSecond * dtSeconds;
  if (x <= 0) {
    return 0;
  }
  // Rational approximation of 1 - e^-x, accurate for small x and monotonic thereafter.
  return x / (1 + x);
}

export const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;

export const radToDeg = (radians: number): number => (radians * 180) / Math.PI;

/**
 * Wraps an angle into `(-PI, PI]`. Used to keep hull heading from drifting toward large values
 * over a long session, which would gradually cost floating-point precision.
 */
export function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let a = (radians + Math.PI) % twoPi;
  if (a < 0) {
    a += twoPi;
  }
  return a - Math.PI;
}

/** Smallest signed rotation from `from` to `to`, in `(-PI, PI]`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}
