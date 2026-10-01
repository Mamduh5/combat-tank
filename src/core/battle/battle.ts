import { NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import type { CombatResult } from '../combat/combat-resolver.js';
import type { Simulation } from '../sim/world.js';

/**
 * The encounter: who won, who lost, and when.
 *
 * ## Why battle state is not inside `Simulation`
 *
 * `Simulation` knows *physics* — it advances vehicles, flies shells, applies penetration. It does not
 * know what the encounter means. Keeping the win condition here rather than in the tick loop means the
 * simulation stays a rules engine (ADR-0001): the same `Simulation` runs the encounter, and from V9
 * will run a room on a server, with no notion of "the player won".
 *
 * ## The lifecycle
 *
 * ```text
 *   ready ──> active ──(opponent destroyed)──> victory
 *               │                                │
 *               └──(player destroyed)──> defeat  │
 *                                            restart
 * ```
 *
 * A **terminal state is sticky**: once victory or defeat is reached, no further tick can change it.
 * That matters because shells are still in flight when a tank dies, and without stickiness the second
 * shell to land could flip the result — a player could win a battle they had already lost, or lose
 * one they had already won, after watching the banner change. Freezing on the first outcome is fairer
 * and much easier to reason about.
 */

/** The state of the encounter. */
export type BattleState =
  /** Constructed but not yet started. Both vehicles at their opening positions. */
  | 'ready'
  /** Both vehicles alive and fighting. */
  | 'active'
  /** The opponent was destroyed. Terminal. */
  | 'victory'
  /** The player was destroyed. Terminal. */
  | 'defeat';

/** A single event worth telling the player about, drained once per frame. */
export interface BattleEvent {
  readonly kind: 'hit-dealt' | 'hit-taken' | 'battle-won' | 'battle-lost';
  /** What the shot did, when this is a combat event. */
  readonly outcome?: CombatResult['kind'];
  /** Damage in hit points, when the shot penetrated. */
  readonly damage?: number;
}

/** How long the battle waits before the opponent is allowed to act, seconds. */
const BATTLE_START_DELAY_SECONDS = 0.6;

/** Ticks per second, for converting the delay above. Mirrors `TICK_HZ` without importing the loop. */
const TICKS_PER_SECOND = 60;

export class Battle {
  /** Current state of the encounter. */
  state: BattleState = 'ready';

  /**
   * Ticks remaining before the battle begins fighting.
   *
   * A short, deliberate pause at the start. It gives the player a beat to read the briefing and move
   * off the spawn before a shell can reach them, and it means the opponent does not start manoeuvring
   * while the player is still orienting. Without it the encounter opens with the opponent already
   * traversing, which feels like the fight began before the player chose to be in it.
   */
  private startDelayTicks = Math.round(BATTLE_START_DELAY_SECONDS * TICKS_PER_SECOND);

  private readonly simulation: Simulation;
  private readonly events: BattleEvent[] = [];

  constructor(simulation: Simulation) {
    this.simulation = simulation;
  }

  /**
   * Advances the encounter by exactly one fixed tick.
   *
   * @param playerInput the player's command, passed straight through to the simulation. The battle
   *   never modifies it: the player has exactly the authority the simulation grants and no more.
   */
  tick(playerInput: InputCommand = NEUTRAL_INPUT): void {
    // A finished battle is frozen. Input is ignored entirely, so a player holding the throttle down
    // through the end screen does not watch their tank still driving behind the victory banner.
    if (this.isOver) {
      this.simulation.tick(NEUTRAL_INPUT);
      return;
    }

    if (this.state === 'ready') {
      if (this.startDelayTicks > 0) {
        this.startDelayTicks -= 1;
        // Still stepping, so both vehicles settle onto the ground and the camera settles rather than
        // snapping the moment the delay expires.
        this.simulation.tick(NEUTRAL_INPUT);
        return;
      }
      this.state = 'active';
    }

    this.simulation.tick(playerInput);
    this.collectEvents();
    this.evaluateOutcome();
  }

  /**
   * Turns this tick's simulation output into events for the presentation layer.
   *
   * Gathered here rather than pushed by the simulation, so the simulation stays free of any notion of
   * "what the player should be told" — it reports combat results, and this decides that a penetration
   * *of the player* is an event worth a warning and a sound while the same penetration of the
   * opponent is a different event entirely.
   */
  private collectEvents(): void {
    for (const result of this.simulation.combat) {
      this.events.push(combatEvent('hit-dealt', result));
    }
    for (const result of this.simulation.incomingCombat) {
      this.events.push(combatEvent('hit-taken', result));
    }
  }

  /**
   * Decides whether the encounter has ended.
   *
   * Checked **after** the tick's combat has resolved, so a shell that destroys a tank on its final
   * tick ends the battle immediately rather than a tick later. The player is checked first, so a tick
   * in which both tanks die reports a defeat: losing the duel should not be masked by winning it in the
   * same instant.
   */
  private evaluateOutcome(): void {
    if (this.simulation.vehicle.damage.destroyed) {
      this.state = 'defeat';
      this.events.push({ kind: 'battle-lost' });
      return;
    }
    if (this.simulation.target !== null && this.simulation.target.damage.destroyed) {
      this.state = 'victory';
      this.events.push({ kind: 'battle-won' });
    }
  }

  /**
   * Takes every event produced since the last call.
   *
   * Draining rather than reading means each event is seen exactly once, which is what lets the HUD show
   * a hit panel per impact without diffing against the previous frame's state.
   */
  drainEvents(): readonly BattleEvent[] {
    const drained = this.events.slice();
    this.events.length = 0;
    return drained;
  }

  /** True while the battle is running and can still be won or lost. */
  get isActive(): boolean {
    return this.state === 'active';
  }

  /** True once the encounter has reached a terminal state. */
  get isOver(): boolean {
    return this.state === 'victory' || this.state === 'defeat';
  }

  /**
   * Restarts the encounter from its opening state.
   *
   * Resets the simulation (both vehicles, all shells, the tick clock), the opponent's memory, the
   * battle state, the start delay, and any undelivered events. **Events are cleared deliberately**: a
   * `battle-won` event left in the queue would be replayed on the first frame of the new battle and
   * fire the victory banner immediately.
   */
  restart(): void {
    this.simulation.restart();
    this.state = 'ready';
    this.startDelayTicks = Math.round(BATTLE_START_DELAY_SECONDS * TICKS_PER_SECOND);
    this.events.length = 0;
  }
}

/** Builds an event from a combat result, carrying the damage only when something penetrated. */
function combatEvent(kind: BattleEvent['kind'], result: CombatResult): BattleEvent {
  if (result.kind !== 'penetrated') {
    return { kind, outcome: result.kind };
  }
  return { kind, outcome: result.kind, damage: result.damage.vehicleDamage };
}

