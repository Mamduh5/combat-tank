import { Simulation } from '../../core/sim/world.js';
import { Battle } from '../../core/battle/battle.js';
import { PLACEHOLDER_TANK } from '../../shared/placeholder-tank.js';
import { ENEMY_TANK } from '../../shared/enemy-tank.js';
import type { BattlefieldData } from '../../core/world/battlefield.js';
import { DEFAULT_SCENARIO, playerScript, type ScenarioId } from './scenarios.js';

/**
 * Headless batch battles.
 *
 * ## What this is for
 *
 * Balance and behaviour questions are answerable by measurement but not by intuition: "does the opponent
 * actually fight?" and "which seeds does it lose?" need a way to run the same fight many times and read
 * the numbers. That is this module's entire job. It is deliberately **not** a framework — no plugin
 * system, no experiment file format, and no attempt to model a game that does not exist yet.
 *
 * ## The real systems, not a model of them
 *
 * Every battle here is a real `Simulation` and a real `Battle`: the same locomotion, ballistics,
 * penetration and damage, and the same `EnemyController` driving the opponent through `InputCommand`. A
 * simplified battle model would be easier to write and worthless, because the things worth measuring
 * are exactly the interactions between those systems — a turret that cannot slew fast enough, a flank
 * that never completes, a retreat that leaves the gun pointing at nothing. None of them exist in a
 * model that skips the systems.
 *
 * The player is a script rather than a stub for the same reason: it produces the same command struct a
 * keyboard does, so the player side of every battle obeys exactly the rules the opponent's does.
 *
 * ## Determinism
 *
 * A battle is a pure function of `(seed, scenario, tick budget)` (ADR-0005), which is what makes a
 * failing seed worth keeping: it can be replayed rather than merely described. Seeds are therefore
 * consecutive and explicit rather than drawn at random, and nothing here reads a clock.
 */

/** Ticks per second, mirroring `TICK_HZ` (ADR-0008) so durations can be reported in seconds. */
const TICKS_PER_SECOND = 60;

/** Default battle length: two minutes, which is longer than V5 duels take. */
export const DEFAULT_MAX_TICKS = 7200;

/** Default number of battles in a batch. */
export const DEFAULT_BATCH_SIZE = 10;

/** How a battle ended. */
export type BattleOutcome = 'victory' | 'defeat' | 'timeout';

/** One battle's result, as a flat record. */
export interface BattleReport {
  /** The seed this ran with — the key that makes a failure replayable. */
  readonly seed: number;
  /** Which scripted player fought it. */
  readonly scenario: ScenarioId;
  /** Whether the player destroyed the opponent, was destroyed, or the clock ran out. */
  readonly outcome: BattleOutcome;
  /** Ticks the battle lasted. Equal to the budget for a timeout. */
  readonly ticks: number;
  /** Battle length in seconds, for reading rather than for arithmetic. */
  readonly durationSeconds: number;
  /** The opponent's final hit points. */
  readonly enemyHitPoints: number;
  /** The opponent's starting hit points, so a fraction can be derived without the definition file. */
  readonly enemyMaxHitPoints: number;
  /** The player's final hit points. */
  readonly playerHitPoints: number;
  /** Damage the opponent actually inflicted. */
  readonly damageDealt: number;
  /** How many shells the opponent fired. */
  readonly shellsFired: number;
  /** How many struck the player at all, penetrated or not. */
  readonly shellsStruck: number;
  /** How many penetrated — the armour model's verdict, not the opponent's choice. */
  readonly penetrations: number;
  /**
   * Ticks in which the opponent had the player in sight, its gun was loaded, and it did not fire.
   *
   * The batch's most useful diagnostic. A high value is the signature of the defect class this harness
   * exists to catch: an opponent that is aiming and tracking and nonetheless never takes a shot, which
   * is what an unreachable aim point or a too-tight fire gate looks like from outside.
   */
  readonly ticksSeenNotFiring: number;
  /**
   * Longest unbroken run of those ticks.
   *
   * Distinguished from the total because a single long stall is a different bug from the same stall
   * recurring: the first is a convergence failure, the second is a policy that has given up.
   */
  readonly longestStallTicks: number;
  /** Furthest the two vehicles were apart, metres. Sudden growth means contact was lost. */
  readonly maxRangeM: number;
  /** How the opponent spent its time in ticks, keyed by intent. Spots a stuck behaviour. */
  readonly ticksByIntent: Readonly<Record<string, number>>;
  /** Intent on the final tick. `search` or `withdraw` at the end is a bad sign. */
  readonly finalIntent: string;
}

/** Everything a caller can ask for. All of it explicit, because every field affects the result. */
export interface BatchOptions {
  /** How many battles to run. */
  readonly battles: number;
  /** First seed. Seeds are consecutive from here, so a range is reproducible as a pair. */
  readonly seedStart: number;
  /** Which scripted player to fight. */
  readonly scenario: ScenarioId;
  /** Tick budget per battle. Reaching it is a `timeout`, not a runner failure. */
  readonly maxTicks: number;
  /**
   * Which battlefield to fight on, added in V6.
   *
   * Optional rather than required so every V5F-era invocation keeps producing the same numbers: a
   * harness that silently changed maps would make its own history incomparable. Pass `ashford-valley`
   * explicitly to exercise V6, or omit it to reproduce a V5 result exactly.
   */
  readonly map?: BattlefieldData;
}

/** The defaults, exposed so the CLI and the tests cannot disagree about them. */
export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  battles: DEFAULT_BATCH_SIZE,
  seedStart: 1,
  scenario: DEFAULT_SCENARIO,
  maxTicks: DEFAULT_MAX_TICKS,
};

/**
 * Runs one battle to a decision or to the tick budget.
 *
 * Exported on its own so a single failing seed can be replayed without a batch around it, which is what
 * a developer reaches for when the batch hands them a suspect seed.
 */
export function runBattle(
  seed: number,
  scenario: ScenarioId,
  maxTicks: number,
  map?: BattlefieldData,
): BattleReport {
  const simulation = new Simulation({
    vehicle: PLACEHOLDER_TANK,
    target: ENEMY_TANK,
    enemySeed: seed,
    // Spread rather than conditionally assigned: passing `undefined` is the documented way to get
    // the legacy arena, and an explicit ternary here would make the two paths differ invisibly.
    ...(map === undefined ? {} : { map }),
  });
  const battle = new Battle(simulation);
  const script = playerScript(scenario);
  const controller = simulation.enemyController!;
  const enemy = simulation.target!;

  let damageDealt = 0;
  let shellsStruck = 0;
  let penetrations = 0;
  let ticksSeenNotFiring = 0;
  let longestStallTicks = 0;
  let currentStallTicks = 0;
  let maxRangeM = 0;
  const ticksByIntent: Record<string, number> = {};

  let ticks = 0;
  while (ticks < maxTicks) {
    battle.tick(
      script(ticks, {
        enemyPosition: enemy.state.position,
        playerPosition: simulation.vehicle.state.position,
        playerHeadingRad: simulation.vehicle.state.headingRad,
      }),
    );
    ticks += 1;
    if (battle.isOver) {
      break;
    }

    for (const result of simulation.incomingCombat) {
      shellsStruck += 1;
      if (result.kind === 'penetrated') {
        penetrations += 1;
        damageDealt += result.damage.vehicleDamage;
      }
    }

    const diagnostics = controller.diagnostics;
    const rangeM = diagnostics.rangeM;
    if (Number.isFinite(rangeM) && rangeM > maxRangeM) {
      maxRangeM = rangeM;
    }

    // The stall counter answers "was it looking at the player and choosing not to shoot?", which a batch
    // of numbers can answer and a screenshot cannot. A reloading gun is excluded: it is obeying its
    // cycle, not stalling, and counting it would report every opponent as stalled.
    if (diagnostics.hasLineOfSight && enemy.gunState.loadState === 'loaded') {
      currentStallTicks += 1;
      ticksSeenNotFiring += 1;
      if (currentStallTicks > longestStallTicks) {
        longestStallTicks = currentStallTicks;
      }
    } else {
      currentStallTicks = 0;
    }

    const intent = diagnostics.intent;
    ticksByIntent[intent] = (ticksByIntent[intent] ?? 0) + 1;
  }

  return {
    seed,
    scenario,
    outcome: battle.state === 'victory' ? 'victory' : battle.state === 'defeat' ? 'defeat' : 'timeout',
    ticks,
    durationSeconds: round(ticks / TICKS_PER_SECOND, 2),
    enemyHitPoints: enemy.damage.hitPoints,
    enemyMaxHitPoints: enemy.definition.survivability.hitPoints,
    playerHitPoints: simulation.vehicle.damage.hitPoints,
    damageDealt,
    shellsFired: enemy.telemetry.shotsFired,
    shellsStruck,
    penetrations,
    ticksSeenNotFiring,
    longestStallTicks,
    maxRangeM: round(maxRangeM, 1),
    ticksByIntent,
    finalIntent: controller.diagnostics.intent,
  };
}

/** Aggregate result of a whole batch. */
export interface BatchReport {
  /** The options that produced this, echoed so a saved report says how it was generated. */
  readonly options: BatchOptions;
  /** One entry per battle, in seed order. */
  readonly battles: readonly BattleReport[];
  /** Counts by outcome. */
  readonly outcomeCounts: Readonly<Record<BattleOutcome, number>>;
  /** Totals across the batch. */
  readonly totals: {
    readonly shellsFired: number;
    readonly shellsStruck: number;
    readonly penetrations: number;
    readonly damageDealt: number;
    /** Fraction of fired shells that struck the player, in `[0, 1]`. */
    readonly hitRate: number;
    /** Fraction of struck shells that penetrated, in `[0, 1]`. */
    readonly penetrationRate: number;
  };
  /** Means across battles, so one long fight does not silently move the headline number. */
  readonly averages: {
    /** Mean battle length in seconds, over decided battles only. */
    readonly decidedDurationSeconds: number;
    /** Mean damage dealt to the player. */
    readonly damageDealt: number;
    /** Mean ticks the opponent could see the player and did not fire. */
    readonly ticksSeenNotFiring: number;
  };
  /**
   * Seeds whose battle looks like a defect rather than a hard fight.
   *
   * Deliberately a short, explainable list rather than a score. Every entry is a seed a developer can
   * replay, and the reason is stated so the list is actionable without re-running the batch to work out
   * what it meant.
   */
  readonly suspects: readonly BattleSuspect[];
}

/** A battle flagged as worth investigating, with the reason it was flagged. */
export interface BattleSuspect {
  readonly seed: number;
  readonly scenario: ScenarioId;
  readonly reason: string;
}

/**
 * Runs a batch of battles over consecutive seeds and aggregates the results.
 *
 * Seeds are consecutive from `seedStart` rather than drawn at random, so a batch is reproducible from
 * its options alone and a suspect seed identifies exactly which battle produced it.
 */
export function runBatch(options: Partial<BatchOptions> = {}): BatchReport {
  const resolved: BatchOptions = { ...DEFAULT_BATCH_OPTIONS, ...options };
  const battles: BattleReport[] = [];
  for (let i = 0; i < resolved.battles; i += 1) {
    battles.push(
      runBattle(resolved.seedStart + i, resolved.scenario, resolved.maxTicks, resolved.map),
    );
  }
  return aggregate(resolved, battles);
}

/**
 * Folds battle reports into the summary a developer reads. Pure, so it is directly testable.
 *
 * Averages deliberately exclude timeouts from the duration figure. A timeout lasted exactly as long as
 * it was allowed to, so including it would drag the mean toward the budget and make a batch of stalled
 * battles look like a batch of long fights — the opposite of the truth the number is meant to carry.
 */
function aggregate(options: BatchOptions, battles: readonly BattleReport[]): BatchReport {
  const outcomeCounts: Record<BattleOutcome, number> = { victory: 0, defeat: 0, timeout: 0 };
  let shellsFired = 0;
  let shellsStruck = 0;
  let penetrations = 0;
  let damageDealt = 0;
  let decidedSeconds = 0;
  let decidedCount = 0;
  let stallTicks = 0;

  for (const battle of battles) {
    outcomeCounts[battle.outcome] += 1;
    shellsFired += battle.shellsFired;
    shellsStruck += battle.shellsStruck;
    penetrations += battle.penetrations;
    damageDealt += battle.damageDealt;
    stallTicks += battle.ticksSeenNotFiring;
    if (battle.outcome !== 'timeout') {
      decidedSeconds += battle.durationSeconds;
      decidedCount += 1;
    }
  }

  return {
    options,
    battles,
    outcomeCounts,
    totals: {
      shellsFired,
      shellsStruck,
      penetrations,
      damageDealt,
      hitRate: ratio(shellsStruck, shellsFired),
      penetrationRate: ratio(penetrations, shellsStruck),
    },
    averages: {
      decidedDurationSeconds: round(decidedCount === 0 ? 0 : decidedSeconds / decidedCount, 2),
      damageDealt: round(battles.length === 0 ? 0 : damageDealt / battles.length, 1),
      ticksSeenNotFiring: round(battles.length === 0 ? 0 : stallTicks / battles.length, 1),
    },
    suspects: battles
      .map((battle) => ({ battle, reason: suspectReason(battle) }))
      .filter((entry): entry is { battle: BattleReport; reason: string } => entry.reason !== null)
      .map((entry) => ({
        seed: entry.battle.seed,
        scenario: entry.battle.scenario,
        reason: entry.reason,
      })),
  };
}

/**
 * Returns why one battle is suspicious, or `null` when it looks like an ordinary fight.
 *
 * The bar is deliberately high. A battle where the opponent fires, lands shots and loses is a fine
 * battle and is not flagged however lopsided. What is flagged is the set of behaviours that mean the
 * opponent has stopped participating — which is what a batch is good at spotting and a single
 * playthrough is bad at.
 */
export function suspectReason(battle: BattleReport): string | null {
  // A long unbroken period of seeing the player and not shooting is a convergence failure: the gun is
  // pointed at something the fire gate will not accept, so the opponent waits indefinitely. This is
  // exactly the defect that shipped in V5 and was only caught by looking at the numbers.
  if (battle.longestStallTicks > STALL_TICKS_THRESHOLD) {
    return (
      `saw the player and did not fire for ${(battle.longestStallTicks / TICKS_PER_SECOND).toFixed(1)}s ` +
      `(${battle.longestStallTicks} ticks)`
    );
  }

  // Finishing a whole battle without firing once is the same failure arriving by a different route.
  if (battle.shellsFired === 0) {
    return 'never fired';
  }

  // Repeatedly firing and never once striking the player means the aim solution is wrong, rather than
  // the gunner being unlucky. Some misses are the point of a fallible opponent; all of them is not.
  if (battle.shellsFired >= MIN_SHELLS_FOR_HIT_RATE && battle.shellsStruck === 0) {
    return `fired ${battle.shellsFired} shells and struck the player with none of them`;
  }

  return null;
}

/**
 * Consecutive-tick stall above which a battle is reported as suspicious: thirty seconds.
 *
 * Chosen from measurement, not taste. A healthy V5 opponent lays its gun within a few seconds, so a
 * stall this long cannot be a slow convergence — it is a stuck one. Comfortably below the default
 * two-minute budget so a genuinely hard fight is not mistaken for a broken one.
 */
const STALL_TICKS_THRESHOLD = 1800;

/** Below this many shells the hit rate is too small a sample to judge. */
const MIN_SHELLS_FOR_HIT_RATE = 4;

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : round(part / whole, 4);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}




