import { type Vec3 } from './vec3.js';

/**
 * The single input interface shared by the player and by AI.
 *
 * This is the mechanism behind the rule in `docs/gameplay-systems.md` §8 that "AI must run inside
 * the simulation core on the same rules as the player". There is one command type, the core
 * applies it, and neither a human nor a bot can bypass the rate limits, reload timers or traction
 * model that the core enforces.
 *
 * The owner settled the driving model for V1 (OD-02): **direct WASD hull control**. `throttle` and
 * `turn` are independent axes, and the hull is never automatically rotated toward the camera or
 * the aim point. That keeps the command honest: whatever the camera is doing has no effect on
 * which way the tank goes.
 *
 * V2 adds the gunnery axes. The important property is that **hull, turret, gun, and firing are four
 * separate systems**: `throttle`/`turn` move the hull, `aimPoint` asks the turret to servo toward a
 * world point, and `fire` is a request the core may refuse. Nothing here can point the whole vehicle
 * at the cursor, which is the failure mode the owner called out.
 */
export interface InputCommand {
  /** Forward/backward demand in `[-1, 1]`. Positive drives forward, negative reverses. */
  readonly throttle: number;
  /** Hull rotation demand in `[-1, 1]`. Positive turns right. */
  readonly turn: number;
  /**
   * World point the operator wants the gun trained on, or `null` to hold the current orientation.
   *
   * A world point rather than a pair of angles, because the turret is a servo: given a point it
   * works out the bearing and elevation itself, which keeps the "how fast can it turn" limits in the
   * vehicle data instead of in the caller. The client resolves the cursor ray against the terrain;
   * an AI in V5 can supply a target's position instead, through the identical field.
   *
   * `null` means "no new aim request", which is what a released mouse or an AI without a target
   * sends. The turret then holds its current bearing and elevation rather than snapping to centre.
   */
  readonly aimPoint: Vec3 | null;
  /**
   * Request to fire. A *request*, not a command: the core refuses it while the gun is reloading, and
   * nothing in the network protocol will ever let a client assert that a shot happened.
   */
  readonly fire: boolean;
}

/** A command with no driver input: coasts, holds heading, holds the gun, does not fire. */
export const NEUTRAL_INPUT: InputCommand = Object.freeze({
  throttle: 0,
  turn: 0,
  aimPoint: null,
  fire: false,
});

/** Builds a valid `InputCommand`, clamping the axes and rejecting a non-finite aim point. */
export function makeInput(
  throttle: number,
  turn: number,
  aimPoint: Vec3 | null = null,
  fire = false,
): InputCommand {
  return {
    throttle: clampUnit(throttle),
    turn: clampUnit(turn),
    aimPoint: sanitiseAimPoint(aimPoint),
    fire,
  };
}

/**
 * Rejects an aim point that is not a real position.
 *
 * A `NaN` reaching the turret solver would poison the gun's angles permanently, because the error
 * would be integrated rather than recomputed. Dropping the point makes the gun hold instead, which
 * degrades to "no aim request" rather than to a tank whose barrel points at the origin of the
 * universe.
 */
function sanitiseAimPoint(point: Vec3 | null): Vec3 | null {
  if (point === null) {
    return null;
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    return null;
  }
  return point;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < -1) {
    return -1;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
