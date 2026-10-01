import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { type Vec3, vec3 } from '../../shared/vec3.js';
import { gunDirection, type TurretState } from './turret.js';

/**
 * The main gun: loading state, the reload cycle, and where a shell is born.
 *
 * Deliberately built for **one gun** on **one vehicle**. The owner asked not to introduce weapon
 * abstractions for artillery, machine guns or missiles that no version needs. What is here is the
 * minimum that makes firing a real, timed, rate-limited act rather than an unlimited button.
 *
 * The reload lives in the core, not the client. That is not a detail: from V9 the server must be able
 * to refuse a shot the client asked for, and a reload timer the client owns could simply be ignored.
 */

/** Loading state of the gun. */
export type GunLoadState = 'loaded' | 'reloading';

export interface MainGunState {
  /** Mutable: the reload cycle changes it. */
  loadState: GunLoadState;
  /** Seconds until the gun is loaded. Zero while loaded. */
  reloadRemainingSeconds: number;
  /** Total shots fired, for diagnostics and the V5 AI. */
  shotsFired: number;
}

export function createMainGunState(): MainGunState {
  return { loadState: 'loaded', reloadRemainingSeconds: 0, shotsFired: 0 };
}

/** True when the gun could fire right now. */
export function isGunLoaded(state: MainGunState): boolean {
  return state.loadState === 'loaded';
}

/** Fraction of the reload completed, in `[0, 1]`. Drives the HUD's reload indicator. */
export function reloadProgress(state: MainGunState, reloadSeconds: number): number {
  if (state.loadState === 'loaded' || reloadSeconds <= 0) {
    return 1;
  }
  const remaining = state.reloadRemainingSeconds / reloadSeconds;
  return clamp01(1 - remaining);
}

/** Advances the reload timer. */
export function updateMainGun(state: MainGunState, dtSeconds: number): void {
  if (state.loadState !== 'reloading') {
    return;
  }
  state.reloadRemainingSeconds -= dtSeconds;
  if (state.reloadRemainingSeconds <= 0) {
    state.reloadRemainingSeconds = 0;
    state.loadState = 'loaded';
  }
}

/**
 * Attempts to fire.
 *
 * Returns the origin the shell should be created at, or `null` if the gun was not loaded. The caller
 * spawns the shell; keeping spawn and permission separate means the reload rule is testable without a
 * ballistics system in the way.
 *
 * A fire request while reloading is **silently refused**. That is the correct behaviour rather than an
 * error: the player holding the trigger during a reload has not done anything wrong, and the gun is
 * simply not ready.
 */
export function tryFire(
  state: MainGunState,
  definition: VehicleDefinition,
  trunnionPosition: Vec3,
  turretState: TurretState,
  hullHeadingRad: number,
): Vec3 | null {
  if (!isGunLoaded(state)) {
    return null;
  }

  state.loadState = 'reloading';
  state.reloadRemainingSeconds = definition.mainGun.reloadSeconds;
  state.shotsFired += 1;

  // The muzzle sits at the end of the barrel, along the gun's own direction. Deriving it from the
  // same function the barrel is drawn with means the projectile cannot appear to come from somewhere
  // other than where the gun visibly points.
  const direction = gunDirection(turretState, hullHeadingRad);
  return vec3(
    trunnionPosition.x + direction.x * definition.mainGun.barrelLengthM,
    trunnionPosition.y + direction.y * definition.mainGun.barrelLengthM,
    trunnionPosition.z + direction.z * definition.mainGun.barrelLengthM,
  );
}

/** The world position of the gun's pivot, which is where the barrel is mounted. */
export function trunnionPosition(vehiclePosition: Vec3, ringHeightM: number): Vec3 {
  return vec3(vehiclePosition.x, vehiclePosition.y + ringHeightM, vehiclePosition.z);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
