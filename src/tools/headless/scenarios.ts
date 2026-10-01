import { makeInput, NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import { vec3 } from '../../shared/vec3.js';

/**
 * Player behaviours the batch runner can fight against.
 *
 * ## Why the runner needs scripted players at all
 *
 * A batch is only useful for balance work if it produces fights, and a fight needs an opponent. Real
 * human input is not an option headlessly, so the "player" here is a **script**, driven through the
 * identical `InputCommand` a keyboard produces. That keeps the property the whole project rests on:
 * the harness fights the battle with the real systems, and the player side has no more authority than a
 * human's would.
 *
 * The scripts are deliberately simple and constant. A randomised player would produce variance that has
 * to be averaged away, and a player that adapts would be a second AI to maintain. What matters is that
 * the scenarios bracket the cases the opponent's behaviour actually branches on:
 *
 * - **parked** — presents frontal armour and never moves. The case ADR-0016 is about.
 * - **circling** — moves laterally at a steady rate. The hardest case for a finite turret traverse, and
 *   the one that exposed the loss-of-contact defect.
 * - **charging** — closes at full speed. The case that exposed the opponent closing out of its own
 *   firing range while its gun was still coming around.
 * - **retreating** — opens the range and turns away. Tests whether the opponent keeps up.
 * - **mixed** — a scripted sequence of the others, so a single battle contains more than one kind of
 *   exchange. The most useful default for balance work because it is the least uniform.
 */
export type ScenarioId = 'parked' | 'circling' | 'charging' | 'retreating' | 'mixed';

/** Every scenario, in a stable order. Used to validate a `--scenario` argument and to label output. */
export const SCENARIOS: readonly ScenarioId[] = [
  'parked',
  'circling',
  'charging',
  'retreating',
  'mixed',
] as const;

/** The scenario used when the caller does not name one. */
export const DEFAULT_SCENARIO: ScenarioId = 'mixed';

/** Returns true when `value` names a real scenario. Used to reject a bad CLI argument clearly. */
export function isScenarioId(value: string): value is ScenarioId {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** Ticks per second, mirroring `TICK_HZ` (ADR-0008). */
const TICKS_PER_SECOND = 60;

/**
 * How hard a steering script corrects toward its target, per radian of heading error.
 *
 * Large enough to turn decisively when pointed the wrong way, small enough not to oscillate when already
 * lined up: a 90-degree error saturates the demand, and a 10-degree one asks for about a fifth of full
 * turn. `makeInput` clamps whatever this produces, so the value only shapes the approach.
 */
const TURN_GAIN = 1.2;

/** Wraps an angle into `[-pi, pi]` so a heading correction never asks for a full revolution. */
function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = ((radians + Math.PI) % twoPi + twoPi) % twoPi;
  return wrapped - Math.PI;
}

function clampUnit(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/**
 * What a script can see when it decides what to do.
 *
 * Passed in rather than reached for, so a script stays a pure function of its inputs and can be tested
 * without constructing a battle. A player obviously knows where the other tank is; a script that could
 * not would be testing an opponent unable to see, which is a different scenario.
 */
export interface PlayerContext {
  /** The opponent's world position this tick. */
  readonly enemyPosition: { readonly x: number; readonly y: number; readonly z: number };
  /** The scripted player's own world position, for scripts that steer toward something. */
  readonly playerPosition: { readonly x: number; readonly y: number; readonly z: number };
  /**
   * The scripted player's own heading in radians, with 0 pointing along +Z.
   *
   * Present because of a property of this game a script has to respect: **the aim point moves the turret,
   * not the hull.** Driving toward something means commanding `turn`, and that command is relative to
   * where the hull already points. A scenario that wanted to charge the opponent and supplied only an aim
   * point would have driven a perfectly straight line past it — which is exactly what the first version of
   * this scenario did, and why it measured a footrace rather than a charge.
   */
  readonly playerHeadingRad: number;
}

/**
 * Produces the player's input for one tick of a battle.
 *
 * @param tick how many ticks have elapsed, for the time-varying scripts
 * @param context where the opponent is, for the scripts that act on it
 */
export type PlayerScript = (tick: number, context: PlayerContext) => InputCommand;


/**
 * Returns the script for a scenario.
 *
 * The constants are the *player's* intent, not the opponent's: this is a driver choosing to circle at
 * roughly half throttle, not a tuning knob for the AI. Keeping them here rather than inline in the
 * runner means a future balance pass can compare scenarios against each other.
 *
 * No script supplies an aim point. That is deliberate — the player never shoots, so every shell in a
 * batch belongs to the opponent, and a measurement of the opponent's behaviour is not muddied by the
 * harness's own gunnery.
 */
export function playerScript(scenario: ScenarioId): PlayerScript {
  switch (scenario) {
    case 'parked':
      return () => NEUTRAL_INPUT;

    case 'circling':
      // A steady lateral arc: forward throttle plus continuous hull rotation, so the opponent's
      // bearing to the player keeps sweeping without the player ever closing much.
      return () => makeInput(0.4, 0.5, null, false);

    case 'charging':
      // Full throttle straight at the opponent: the fastest possible approach, and the worst case for
      // turret tracking.
      //
      // Drives toward the opponent by commanding the **hull**, not by supplying an aim point. Those are
      // different systems in this game: `aimPoint` servos the turret, and `turn` turns the hull. The first
      // version of this scenario supplied only an aim point, so the player accelerated in a straight line,
      // passed the opponent on about the third second, and kept going — the terrain is unbounded, so all
      // twenty seeds finished 183 m apart. That measured a footrace between an 8.4 m/s tank and a 5.6 m/s
      // one and called it a charge, which is a good illustration of why a measurement has to be checked
      // against what it claims to measure.
      return (_tick, context) => {
        const bearingToEnemy = Math.atan2(
          context.enemyPosition.x - context.playerPosition.x,
          context.enemyPosition.z - context.playerPosition.z,
        );
        // Wrapped into [-pi, pi] so the command is a correction rather than a demand to spin.
        const headingError = wrapAngle(bearingToEnemy - context.playerHeadingRad);
        return makeInput(1, clampUnit(headingError * TURN_GAIN), vec3(
          context.enemyPosition.x,
          context.enemyPosition.y,
          context.enemyPosition.z,
        ), false);
      };

    case 'retreating':
      // Back away and turn away from the opponent, so the range genuinely opens and the enemy has to
      // close rather than merely hold a station. Steered by the hull for the same reason `charging` is:
      // the aim point does not move the tank.
      return (_tick, context) => {
        const bearingToEnemy = Math.atan2(
          context.enemyPosition.x - context.playerPosition.x,
          context.enemyPosition.z - context.playerPosition.z,
        );
        // Pointed opposite the enemy, so reversing opens the distance rather than closing it.
        const headingError = wrapAngle(bearingToEnemy + Math.PI - context.playerHeadingRad);
        return makeInput(-0.8, clampUnit(headingError * TURN_GAIN), null, false);
      };

    case 'mixed':
      return mixedScript();
  }
}

/**
 * A scripted sequence that changes what the player is doing partway through a battle.
 *
 * The point is a fight with more than one phase without the harness becoming a second AI. Each segment
 * runs for a fixed span of ticks and hands over to the next. The segment lengths are long enough for the
 * opponent to complete a flank or a range correction within each one, so every phase produces a distinct
 * kind of exchange rather than being cut off mid-manoeuvre.
 */
function mixedScript(): PlayerScript {
  const segments: { readonly seconds: number; readonly script: PlayerScript }[] = [
    { seconds: 15, script: playerScript('parked') },
    { seconds: 20, script: playerScript('circling') },
    { seconds: 20, script: playerScript('retreating') },
    { seconds: 15, script: playerScript('charging') },
    { seconds: 20, script: playerScript('parked') },
  ];

  const ticksPerSegment = segments.map((segment) => Math.round(segment.seconds * TICKS_PER_SECOND));
  const totalTicks = ticksPerSegment.reduce((sum, ticks) => sum + ticks, 0);

  return (tick: number, context: PlayerContext): InputCommand => {
    // Wrapped rather than clamped, so a battle longer than the sequence repeats the whole pattern
    // instead of sitting in its last phase. Repeating is closer to a player who keeps changing what
    // they are doing, and it keeps a long battle from being dominated by however it happened to end.
    const bounded = ((tick % totalTicks) + totalTicks) % totalTicks;
    let start = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const length = ticksPerSegment[i]!;
      if (bounded < start + length) {
        return segments[i]!.script(bounded - start, context);
      }
      start += length;
    }
    return segments[segments.length - 1]!.script(0, context);
  };
}

