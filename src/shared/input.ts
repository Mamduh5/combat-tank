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
 * Fields for the turret, gun and firing are deliberately **absent** in V1. They arrive in V2, and
 * adding them then is a change to this one file.
 */
export interface InputCommand {
  /** Forward/backward demand in `[-1, 1]`. Positive drives forward, negative reverses. */
  readonly throttle: number;
  /** Hull rotation demand in `[-1, 1]`. Positive turns right. */
  readonly turn: number;
}

/** A command with no driver input: coasts and holds heading. */
export const NEUTRAL_INPUT: InputCommand = Object.freeze({ throttle: 0, turn: 0 });

/** Clamps an arbitrary pair of numbers into a valid `InputCommand`. */
export function makeInput(throttle: number, turn: number): InputCommand {
  return {
    throttle: clampUnit(throttle),
    turn: clampUnit(turn),
  };
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
