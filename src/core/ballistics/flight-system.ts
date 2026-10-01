import type { TestShellDefinition } from '../../shared/vehicle-definition.js';
import { type Vec3, vec3 } from '../../shared/vec3.js';
import type { Terrain } from '../world/terrain.js';
import type { ShellImpact } from './impact.js';

/** Shared empty obstacle list, so a world with no vehicles allocates nothing per tick. */
const EMPTY_OBSTACLES: readonly ShellObstacle[] = Object.freeze([]);
import { createShell, stepShell, type ShellObstacle, type ShellState } from './shell.js';

/**
 * Owns every shell in flight and reports what happened to them.
 *
 * Kept separate from `Simulation` so the ballistics can be tested, reasoned about, and later run
 * headlessly without a world around them. `Simulation` creates one of these and drains it each tick.
 *
 * Impacts are **collected, not applied**. V2 answers "where and how did the shell hit?" and nothing
 * else: no penetration, no ricochet, no damage. An impact is handed to the caller intact so V3 can
 * decide what it means. See `docs/gameplay-systems.md` §3 and §4 for that boundary.
 */
export class ShellFlightSystem {
  private readonly shells: ShellState[] = [];
  private nextId = 1;

  /** Number of shells currently in flight. */
  get activeCount(): number {
    return this.shells.length;
  }

  /** Read-only view of the shells in flight, for rendering. */
  get inFlight(): readonly ShellState[] {
    return this.shells;
  }

  /** Spawns a shell at `origin` travelling along `direction`. */
  spawn(
    definition: TestShellDefinition,
    origin: Vec3,
    direction: Vec3,
    shooterId: string | null,
  ): ShellState {
    const shell = createShell(this.nextId, definition, origin, direction, shooterId);
    this.nextId += 1;
    this.shells.push(shell);
    return shell;
  }

  /**
   * Advances every shell by one tick, returning the impacts produced.
   *
   * Shells that impact or expire are removed. The returned list is in the order the impacts
   * occurred, which is deterministic because the shell list is iterated in spawn order.
   *
   * @param obstacles vehicles the shells can strike, supplied by the simulation. The flight system
   *   does not know what a vehicle is; it only passes the obstacle list through.
   */
  step(
    definition: TestShellDefinition,
    terrain: Terrain,
    dtSeconds: number,
    obstacles: readonly ShellObstacle[] = EMPTY_OBSTACLES,
  ): ShellImpact[] {
    const impacts: ShellImpact[] = [];

    // Iterated backwards so removing a shell does not disturb the indices of the ones not yet
    // processed. Spawn order is preserved in the impact list regardless.
    for (let i = this.shells.length - 1; i >= 0; i -= 1) {
      const shell = this.shells[i]!;
      const result = stepShell(shell, definition, terrain, dtSeconds, obstacles);

      if (result.kind === 'impacted') {
        impacts.push(result.impact);
        this.shells.splice(i, 1);
      } else if (result.kind === 'expired') {
        this.shells.splice(i, 1);
      }
    }

    // Reversed back into spawn order, which is easier to reason about when reading a match log.
    impacts.reverse();
    return impacts;
  }

  /** Removes every shell without producing impacts. Used when a match resets. */
  clear(): void {
    this.shells.length = 0;
  }

  /**
   * The furthest point any shell would have reached if it continued on its current path.
   *
   * Not used by the simulation; it exists so a debug overlay can show where a shell is heading
   * before it lands, which is the clearest way to demonstrate that the turret and the shell agree.
   */
  predictLanding(shell: ShellState, terrain: Terrain): Vec3 | null {
    const origin = shell.position;
    // Flat-ground estimate: time to fall back to the current ground height under the muzzle.
    const height = origin.y - terrain.heightAt(origin.x, origin.z);
    if (shell.velocity.y >= 0) {
      return null;
    }
    const timeSeconds = (shell.velocity.y + Math.sqrt(shell.velocity.y ** 2 + 2 * 9.81 * height)) / 9.81;
    return vec3(
      origin.x + shell.velocity.x * timeSeconds,
      terrain.heightAt(origin.x + shell.velocity.x * timeSeconds, origin.z + shell.velocity.z * timeSeconds),
      origin.z + shell.velocity.z * timeSeconds,
    );
  }
}
