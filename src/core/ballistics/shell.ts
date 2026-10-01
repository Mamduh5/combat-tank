import type { TestShellDefinition } from '../../shared/vehicle-definition.js';
import { type Vec3, vec3 } from '../../shared/vec3.js';
import type { Terrain } from '../world/terrain.js';
import { computeIncidenceAngleDeg, type ShellImpact } from './impact.js';

/**
 * Shell ballistics.
 *
 * A shell is a **real travelling projectile**, integrated tick by tick under gravity. There is no
 * hitscan anywhere in V2: if the player fires at a target and misses, the shell genuinely flies past
 * it. Travel time and drop are what make range and leading matter, and they only exist if the shell
 * is a thing that is somewhere, at a time, rather than a line drawn instantly.
 *
 * ## Integration model
 *
 * Semi-implicit Euler under constant gravity:
 *
 * ```
 *   velocity.y -= g * dt
 *   position  += velocity * dt
 * ```
 *
 * Semi-implicit rather than explicit because it is stable for a constant acceleration field, and
 * because it uses only addition and multiplication, so it stays bit-identical across engines
 * (ADR-0005). It is not the most accurate scheme available, and V2 does not need it to be: over a
 * ten-second flight the error is centimetres, and the projectile is a blunt object in a game rather
 * than a satellite.
 *
 * **No air resistance.** A real shell loses a large fraction of its velocity to drag, which changes
 * how much it drops. Modelling drag properly needs a drag coefficient, a reference area and air
 * density — the physics package the owner explicitly asked not to build for V2. ADR-0010 records
 * the omission so it reads as a decision, and adding it later touches only `velocity`.
 *
 * ## Sub-stepping
 *
 * A shell at 800 m/s covers about 13 m in one 60 Hz tick. Sampling the ground once per tick would
 * let it pass clean through a hill and reappear on the far side. The trajectory is therefore split
 * into sub-steps no longer than `maxSubstepM`, and the ground is tested at each one, which bounds
 * how far a shell can travel undetected. The cost is proportional to distance travelled rather than
 * to the number of shells.
 */

/** Standard gravity, m/s^2. A physical constant, not a tuning value. */
export const GRAVITY_MPS2 = 9.81;

/** Mutable state of one shell in flight. */
export interface ShellState {
  readonly id: number;
  readonly shellTypeId: string;
  readonly shooterId: string | null;
  readonly massKg: number;
  readonly muzzleVelocityMps: number;
  position: Vec3;
  velocity: Vec3;
  /** Seconds since the shell left the muzzle. */
  flightTimeSeconds: number;
  /** Metres travelled since the muzzle. */
  distanceTravelledM: number;
}

/** What one simulation tick produced for a shell. */
export type ShellStepResult =
  | { readonly kind: 'flying' }
  | { readonly kind: 'impacted'; readonly impact: ShellImpact }
  | {
      readonly kind: 'expired';
      /** Why it was discarded, so a caller can tell a deliberate timeout from a bug. */
      readonly reason: 'range' | 'lifetime';
    };

/** Creates a shell at the muzzle, travelling along `direction` at the definition's velocity. */
export function createShell(
  id: number,
  definition: TestShellDefinition,
  origin: Vec3,
  direction: Vec3,
  shooterId: string | null,
): ShellState {
  return {
    id,
    shellTypeId: definition.id,
    shooterId,
    massKg: definition.massKg,
    muzzleVelocityMps: definition.muzzleVelocityMps,
    position: origin,
    // The direction is assumed unit length; callers build it from the gun's own orthonormal basis.
    velocity: vec3(
      direction.x * definition.muzzleVelocityMps,
      direction.y * definition.muzzleVelocityMps,
      direction.z * definition.muzzleVelocityMps,
    ),
    flightTimeSeconds: 0,
    distanceTravelledM: 0,
  };
}

/** Unit length of a vector. */
export function magnitude(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Returns a unit-length copy, or `fallback` if the vector is too short to have a direction. */
export function unitOr(v: Vec3, fallback: Vec3): Vec3 {
  const len = magnitude(v);
  if (len < 1e-9) {
    return fallback;
  }
  return vec3(v.x / len, v.y / len, v.z / len);
}

/**
 * Advances a shell by one tick, mutating it in place and reporting what happened.
 *
 * The caller owns the shell's lifetime and must drop it once this returns anything other than
 * `flying`.
 */
export function stepShell(
  shell: ShellState,
  definition: TestShellDefinition,
  terrain: Terrain,
  dtSeconds: number,
): ShellStepResult {
  // --- Expiry checks first ----------------------------------------------------------
  // Checked before the shell moves, so a shell cannot be reported as impacting in the same tick it
  // should have run out of range.
  if (shell.flightTimeSeconds >= definition.maxLifetimeSeconds) {
    return { kind: 'expired', reason: 'lifetime' };
  }
  if (shell.distanceTravelledM >= definition.maxRangeM) {
    return { kind: 'expired', reason: 'range' };
  }

  // --- Sub-stepped integration -------------------------------------------------------
  const travelThisTickM = magnitude(shell.velocity) * dtSeconds;
  const steps = Math.max(1, Math.ceil(travelThisTickM / definition.maxSubstepM));
  const subDt = dtSeconds / steps;

  for (let i = 0; i < steps; i += 1) {
    // Semi-implicit Euler: velocity first, then position from the updated velocity.
    const velocity = vec3(
      shell.velocity.x,
      shell.velocity.y - GRAVITY_MPS2 * subDt,
      shell.velocity.z,
    );
    const next = vec3(
      shell.position.x + velocity.x * subDt,
      shell.position.y + velocity.y * subDt,
      shell.position.z + velocity.z * subDt,
    );

    // --- Ground test ------------------------------------------------------------------
    // Against the analytic surface rather than a collision mesh, for the same reason the vehicle
    // is: the analytic function is exact, so a shell cannot land in a quantisation step or jitter
    // as it crosses a grid cell (ADR-0007).
    if (next.y <= terrain.heightAt(next.x, next.z)) {
      const impact = refineImpact(shell, velocity, next, terrain, subDt);
      // Fold the partial final step into the odometer and clock before reporting, so the impact's
      // flight time and distance are the values at the moment of impact rather than at the start of
      // the tick.
      advanceClock(shell, subDt * impact.fraction);
      return { kind: 'impacted', impact: withFinalTotals(impact, shell) };
    }

    shell.position = next;
    shell.velocity = velocity;
    advanceClock(shell, subDt);
  }

  return { kind: 'flying' };
}

/** Adds elapsed time and the distance just covered to the shell's clock and odometer. */
function advanceClock(shell: ShellState, elapsedSeconds: number): void {
  shell.flightTimeSeconds += elapsedSeconds;
  shell.distanceTravelledM += magnitude(shell.velocity) * elapsedSeconds;
}

/**
 * Bisects the sub-step that crossed the ground, to find where the shell actually met the surface.
 *
 * Without this the impact would be reported wherever the sub-step happened to end, which at 1 m
 * spacing is visibly wrong on a steep slope. Twelve iterations reduce a 1 m step to well under a
 * millimetre, which is finer than the collision can represent and costs nothing measurable.
 */
function refineImpact(
  shell: ShellState,
  velocity: Vec3,
  overshoot: Vec3,
  terrain: Terrain,
  subDt: number,
): { impact: Omit<ShellImpact, 'flightTimeSeconds' | 'distanceTravelledM'>; fraction: number } {
  const startX = shell.position.x;
  const startY = shell.position.y;
  const startZ = shell.position.z;

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) / 2;
    const x = startX + (overshoot.x - startX) * mid;
    const y = startY + (overshoot.y - startY) * mid;
    const z = startZ + (overshoot.z - startZ) * mid;
    if (y <= terrain.heightAt(x, z)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const hitX = startX + (overshoot.x - startX) * hi;
  const hitZ = startZ + (overshoot.z - startZ) * hi;
  // Snap onto the surface, so the reported position is *on* the terrain rather than a hair above or
  // below it, and take the normal from the analytic surface at that point so the two always agree.
  const hitY = terrain.heightAt(hitX, hitZ);
  const normal = terrain.normalAt(hitX, hitZ);

  // Gravity acts continuously, so the velocity at the crossing is the sub-step's end velocity less
  // the fall accrued over the partial step.
  const impactVelocity = vec3(
    velocity.x,
    velocity.y - GRAVITY_MPS2 * subDt * hi,
    velocity.z,
  );
  const incomingDirection = unitOr(impactVelocity, vec3(0, 0, 1));

  return {
    fraction: hi,
    impact: {
      shellId: shell.id,
      shellTypeId: shell.shellTypeId,
      shooterId: shell.shooterId,
      position: vec3(hitX, hitY, hitZ),
      surfaceNormal: normal,
      // V2 has no other vehicles in the world, so terrain is the only thing a shell can strike.
      // The field exists so V3 can report a plate strike without changing this type.
      targetKind: 'terrain',
      targetId: null,
      incomingDirection,
      impactVelocity,
      incidenceAngleDeg: computeIncidenceAngleDeg(incomingDirection, normal),
      shellMassKg: shell.massKg,
      muzzleVelocityMps: shell.muzzleVelocityMps,
    },
  };
}

/** Fills in the shell's totals at the moment of impact. */
function withFinalTotals(
  partial: { impact: Omit<ShellImpact, 'flightTimeSeconds' | 'distanceTravelledM'>; fraction: number },
  shell: ShellState,
): ShellImpact {
  return {
    ...partial.impact,
    flightTimeSeconds: shell.flightTimeSeconds,
    distanceTravelledM: shell.distanceTravelledM,
  };
}

