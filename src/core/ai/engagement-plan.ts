import type { Vec3 } from '../../shared/vec3.js';
import { radToDeg, wrapAngle } from '../math/index.js';
import type { PlateAssessment } from './shot-evaluation.js';

/**
 * Deciding *what to do*, as distinct from *how to do it*.
 *
 * ## The V4 gap this closes
 *
 * V4's opponent had one policy: circle to 58 degrees off the direct line and shoot. It never asked
 * whether shooting was working. It would fire five shells into a 400 mm frontal plate, take five
 * bounces, and then do exactly the same thing again — because nothing in its state recorded that the
 * last five attempts had failed.
 *
 * That is the whole of OD-11. A player who parked was not beating the opponent; they were exploiting
 * the fact that the opponent had no memory of its own failures. The fix is not armour: it is giving
 * the opponent a memory of what worked and a reason to change when it did not.
 *
 * ## The decision, stated plainly
 *
 * The opponent keeps a short record of its recent shots and asks one question each tick:
 *
 * > Is shooting the player right now producing penetrations?
 *
 * If yes, it keeps shooting. If no — repeatedly — it concludes the engagement geometry is wrong rather
 * than that its gun is weak, and commits to a **flank**: drive to a position that presents the player
 * from an angle where the armour is thinner. That is the whole strategy, and the rest is tuning.
 *
 * ## Why this is a pure function of a record
 *
 * `chooseIntent` takes the current situation and a record and returns a decision, mutating only the
 * record. That means the interesting question — "would this opponent flank after *these* three
 * bounces?" — is answerable in a test without running a battle, and the answer cannot depend on frame
 * timing or on what the renderer did.
 */

/** What the opponent has decided to do. */
export type EngagementIntent =
  /** No usable sight: go and look. */
  | 'search'
  /** Visible but out of the useful range band: close or back off. */
  | 'adjust-range'
  /** Visible, in band, and the current geometry gives a shot worth taking: fight from here. */
  | 'engage'
  /**
   * No shot is predicted, but the opponent has not yet confirmed the geometry is hopeless.
   *
   * This intent exists because of a deadlock the first V5 build fell into, and the reason is worth
   * recording because it is the subtle part of "make the AI armour-aware".
   *
   * The prediction says a frontal plate cannot be beaten. The first implementation therefore held
   * fire. But holding fire means the opponent never fires, which means it never observes a failure,
   * which means `ineffectiveStreak` never rises, which means it never triggers a flank. The AI
   * reasoned its way into standing in front of an invulnerable tank forever — strictly worse than the
   * V4 behaviour it replaced, because it had *decided* the shot was impossible and so never tested it.
   *
   * The resolution is that a prediction is an estimate, and estimates are confirmed by firing. So the
   * opponent is allowed a **deliberate probing shot** at a plate it does not expect to beat, and treats
   * the real result as evidence. If the shot gets through — the prediction was too pessimistic — it
   * drops straight into `engage`. If it bounces, that is one tick on the streak toward a flank.
   *
   * This is the one place the opponent knowingly fires at armour it believes will stop it, and it is
   * bounded rather than continuous: see `probeShotLimit` in `ENGAGEMENT_TUNING`.
   */
  | 'probe'
  /** Current geometry is not producing hits: drive to a position that opens a better angle. */
  | 'flank'
  /**
   * Immobilised with a working gun.
   *
   * Distinct from `engage` because the opponent cannot improve its situation any more — it cannot move
   * to a better angle — so it commits to the best shot available from where it is stuck, and stops
   * pretending to manoeuvre.
   */
  | 'hold-position'
  /** Gun destroyed: nothing offensive is possible, so get out of the player's way. */
  | 'withdraw'
  /** Destroyed or unable to act at all. */
  | 'disabled';

/** Ticks in one second. Mirrors `TICK_HZ` without importing the loop, as `battle.ts` does. */
const TICKS_PER_SECOND = 60;


/** Second-denominated tactical values, kept separate so the planner reads as a policy table. */
export const TACTIC_TUNING = {
  /**
   * Range band the opponent tries to fight in, metres. Inherited from V4 and measured, not guessed.
   *
   * The near edge must sit **at or inside** `ENEMY_TUNING.minEngageRangeM`, and that relationship is
   * load-bearing rather than incidental. Measured during V5 development with the near edge at 32 m
   * while the gun could fire from 24 m: the opponent retreated to 32 m, could not fire from there, and
   * then flapped between `flank` and `adjust-range` for the rest of the fight, alternating every few
   * seconds without ever taking a shot. Two rules disagreed about the same distance, and the interval
   * between them - 24 m to 32 m - was a band in which the opponent was perfectly able to shoot and had
   * decided not to. Sizing this from the gun's actual capability rather than from a separate guess is
   * what removes that dead zone.
   *
   * Equal to the gun's minimum rather than below it: the band is where the opponent wants to be, and
   * the gun's limit is how close it may be pushed. Retreating to exactly the gun's minimum puts the
   * opponent on the boundary, which is where it can immediately shoot again - a metre further out and it
   * is managing range instead of fighting. A test asserts the two cannot drift apart.
   */
  nearRangeM: 24,
  farRangeM: 90,
  /** Grace period before the first shot after acquiring the player, seconds. */
  acquisitionDelaySeconds: 1.5,
} as const;

/** What the opponent remembers about how its shooting has been going. */
export interface EngagementMemory {
  /**
   * Consecutive non-penetrating shots, capped at `ineffectiveThreshold`.
   *
   * The single most important number in the opponent. It is what turns "my shots are not working" from
   * an impression into a decision, and it resets the instant a shell gets through, so one lucky bounce
   * does not send the opponent wandering off mid-fight.
   */
  ineffectiveStreak: number;
  /** Total shots observed this battle, for diagnostics and tests. */
  shotsObserved: number;
  /** Total penetrations observed this battle. */
  penetrations: number;
  /**
   * Which side the opponent is committed to flanking around: `-1` left, `+1` right, `0` not flanking.
   *
   * Persisted across a flank so the swing completes rather than restarting each tick, and so the two
   * sides of the player are never tried simultaneously.
   */
  flankSide: 1 | -1 | 0;
  /** Ticks spent in the current flank, used to time it out and try the other side. */
  flankTicks: number;
  /** Ticks remaining before the opponent is willing to shoot after acquiring the player. */
  acquisitionTicksRemaining: number;
  /** Ticks remaining before the flank destination is recomputed. */
  flankRethinkTicks: number;
  /** The destination the current flank is driving toward, or `null` when not flanking. */
  flankDestination: Vec3 | null;
  /**
   * Deliberate shots fired at armour the prediction said would stop them, consecutively.
   *
   * Bounded so the opponent tests its assumption without settling into a firing pattern the player can
   * time. Reset by any penetration, and by losing sight of the player, because a stale frustration count
   * from before a hill should not suppress probing once the geometry has changed.
   */
  probeStreak: number;
  /**
   * The side this battle opens a flank from, from the seeded profile.
   *
   * Persisted rather than re-rolled so the opponent's first approach is consistent within a fight
   * while still differing between seeds. This is the main source of "several fights are not identical"
   * without introducing any randomness into the opponent's competence.
   */
  preferredFlankSide: 1 | -1;
}

/** Creates a fresh memory for a new battle. */
export function createEngagementMemory(preferredFlankSide: 1 | -1 = 1): EngagementMemory {
  return {
    ineffectiveStreak: 0,
    shotsObserved: 0,
    penetrations: 0,
    flankSide: 0,
    flankTicks: 0,
    acquisitionTicksRemaining: 0,
    flankRethinkTicks: 0,
    flankDestination: null,
    probeStreak: 0,
    preferredFlankSide,
  };
}

/** Tuning for the tactical layer. */
export const ENGAGEMENT_TUNING = {
  /**
   * Consecutive bounced or blocked shots that trigger a flank.
   *
   * The core tuning decision of the whole version, so the reasoning is worth stating.
   *
   * Too low (1) and the opponent flinches away after a single unlucky ricochet — it would be a tank
   * that could never stand its ground, and a player could farm it by wobbling. Too high (5+) and the
   * flank arrives so late the player has already disengaged, and five wasted five-second reloads is
   * exactly the "shoots the invulnerable plate forever" behaviour V5 exists to remove.
   *
   * Three is the point where the evidence is unambiguous — no reasonable crew would fire a fourth or
   * fifth shell at armour that has already stopped three — while still tolerating an odd bad bounce.
   */
  ineffectiveThreshold: 3,
  /**
   * Seconds a flank attempt runs before the opponent tries the other side.
   *
   * Without this, an obstacle the chosen side cannot get around would be attempted forever. Time-boxing
   * it makes the failure mode "it tried the other way", which is legible, rather than "it sat in a
   * ditch", which is not.
   */
  flankTimeoutSeconds: 9,
  /** How far away the flank destination must be before the opponent counts itself arrived, metres. */
  flankArrivalRadiusM: 14,
  /**
   * Seconds before a flank re-evaluates its destination.
   *
   * Stops the opponent recomputing a destination every tick and chasing a moving goal as the player
   * drives, which produces a tank that continuously changes its mind and arrives nowhere.
   */
  flankRethinkSeconds: 1.5,
  /**
   * How many deliberate probing shots the opponent may fire before giving up on the current geometry.
   *
   * Bounds the deadlock fix above. One probe is a reasonable test; two is a stubborn tank; three is
   * already the `ineffectiveThreshold` at which the opponent commits to a flank anyway, so beyond this
   * number the probe limit and the streak limit agree and the behaviour stops changing.
   *
   * Deliberately **fewer than the flank threshold** is the wrong way round here, and the ordering
   * matters: the probe limit must never be the reason the opponent stops before the streak triggers,
   * or the deadlock returns in a harder form. These are therefore kept equal by a test.
   */
  probeShotLimit: 3,
} as const;


/** Everything the planner needs to know about the current tactical situation. */
export interface Situation {
  /** Whether the player is visible at all this tick. */
  readonly canSeePlayer: boolean;
  /** Current range to the player, metres. */
  readonly rangeM: number;
  /** The opponent's own position, for the flank-arrival test. */
  readonly position: Vec3;
  /** Best predicted shot available right now, or `null` when none is worth taking. */
  readonly bestShot: PlateAssessment | null;
  /** True when the opponent's gun is destroyed. */
  readonly gunDisabled: boolean;
  /** True when the opponent cannot move. */
  readonly immobilised: boolean;
  /** True when the opponent has been destroyed. */
  readonly destroyed: boolean;
  /** Whether the player has ever been seen this battle. */
  readonly hasEverSeenPlayer: boolean;
}

/** A tactical decision, with the reason attached so the debug overlay can explain it. */
export interface IntentDecision {
  readonly intent: EngagementIntent;
  /** Short human-readable reason, shown in diagnostics. */
  readonly reason: string;
}

/**
 * Chooses what the opponent should do, updating its memory of the fight.
 *
 * Mutates `memory` because the streak, the flank commitment and the acquisition timer are all
 * genuinely stateful: they are the opponent's memory of the encounter, and clearing them is exactly
 * what `restart` has to do.
 */
export function chooseIntent(situation: Situation, memory: EngagementMemory): IntentDecision {
  if (situation.destroyed) {
    return { intent: 'disabled', reason: 'destroyed' };
  }

  // A destroyed gun is the one situation where moving cannot help. The opponent withdraws rather than
  // manoeuvring, because a driving target is easier for the player to hit and there is nothing left to
  // manoeuvre for. Checked before the sight test so a blind opponent with a dead gun still tries to
  // leave rather than sitting in the open waiting to be shot.
  if (situation.gunDisabled) {
    return { intent: 'withdraw', reason: 'gun destroyed' };
  }

  if (!situation.canSeePlayer) {
    // Nothing to be frustrated about while blind. Clearing the streak matters: the opponent should not
    // arrive at a flank having "remembered" three bounces from before it lost sight of the player.
    memory.ineffectiveStreak = 0;
    memory.flankSide = 0;
    memory.flankTicks = 0;
    memory.flankDestination = null;
    memory.probeStreak = 0;
    return { intent: 'search', reason: 'no line of sight' };
  }

  if (!situation.hasEverSeenPlayer) {
    memory.acquisitionTicksRemaining = Math.round(
      TACTIC_TUNING.acquisitionDelaySeconds * TICKS_PER_SECOND,
    );
  }

  memory.flankTicks += 1;


  // --- Range first: a bad angle at the wrong range is still a bad shot -------------------------------
  //
  // The one exception is an **in-progress flank**. A flank exists to reach a position at a better
  // angle, and it deliberately drives through ranges that are not the band it wants to fight in - that
  // is the whole point of going around. Cancelling it here meant the opponent could never complete one.
  //
  // Measured during V5 development: the opponent committed to a flank at 26 m, this check cancelled it
  // on the very next tick, `adjust-range` reversed instead, and the result was a permanent flap between
  // `flank` and `adjust-range` for the remaining thirty seconds of the fight. The flank destination sat
  // a steady 78 m away and the tank never moved toward it, because it was never allowed to. It looked
  // like an unreachable destination; it was really a commitment being cancelled every tick.
  //
  // A charging player is the case this check was written for, and it still applies: a flank that
  // *starts* inside the band is allowed to finish, but a flank is not *begun* inside the band, because
  // the check below runs before the flank is ever chosen.
  const outOfBand =
    situation.rangeM > TACTIC_TUNING.farRangeM || situation.rangeM < TACTIC_TUNING.nearRangeM;
  if (outOfBand && memory.flankSide === 0) {
    // Out of the band. Fix the range before worrying about the angle: closing from 120 m at a mediocre
    // aspect beats standing at 120 m at a perfect one.
    //
    // This check is deliberately *above* the flank logic. A player who drives straight at the opponent
    // reaches point-blank within seconds, and if the opponent kept flanking through that it would be
    // circling at knife-fighting range where its long gun cannot shoot at all. Measured during V5
    // development: with this check missing, a charging player drove straight past an opponent that had
    // correctly identified a 84 mm opening on the turret side and never fired a single shell.
    memory.ineffectiveStreak = 0;
    memory.probeStreak = 0;
    return { intent: 'adjust-range', reason: 'outside engagement band' };
  }

  // --- The flank commitment --------------------------------------------------------------------------
  if (memory.flankSide !== 0) {
    const timedOut =
      memory.flankTicks > Math.round(ENGAGEMENT_TUNING.flankTimeoutSeconds * TICKS_PER_SECOND);

    if (timedOut) {
      // The committed side did not work. Try the other one rather than repeating the same approach,
      // which is what made V4 look scripted.
      memory.flankSide = memory.flankSide === 1 ? -1 : 1;
      memory.flankTicks = 0;
      memory.flankDestination = null;
      return { intent: 'flank', reason: 'flank timed out, switching side' };
    }

    // A shot opened up mid-flank. Abandon the drive and take it: this is what stops the opponent from
    // driving past a perfectly good opportunity because it had already decided to reposition.
    if (situation.bestShot !== null) {
      memory.flankSide = 0;
      memory.flankTicks = 0;
      memory.ineffectiveStreak = 0;
      return { intent: 'engage', reason: 'shot opened while repositioning' };
    }

    // Arrived, but still no shot: the angle did not help. Restart the clock so the flank times out and
    // the other side is tried, rather than driving to the same spot again forever.
    if (
      memory.flankDestination !== null &&
      planarDistanceM(situation.position, memory.flankDestination) <
        ENGAGEMENT_TUNING.flankArrivalRadiusM
    ) {
      memory.flankTicks = Math.round(
        (ENGAGEMENT_TUNING.flankTimeoutSeconds + 1) * TICKS_PER_SECOND,
      );
      return { intent: 'flank', reason: 'flank destination reached without a shot' };
    }

    return { intent: 'flank', reason: 'committed to flank for a better angle' };
  }

  // --- Immobilised with a working gun -------------------------------------------------------------------
  if (situation.immobilised) {
    return {
      intent: 'hold-position',
      reason:
        situation.bestShot === null
          ? 'immobilised, no shot available'
          : 'immobilised, taking best shot',
    };
  }

  // --- A shot is available: take it ---------------------------------------------------------------------
  if (situation.bestShot !== null) {
    memory.ineffectiveStreak = 0;
    return {
      intent: 'engage',
      reason: `predicted ${Math.round(situation.bestShot.marginMm)} mm margin on ${situation.bestShot.region}`,
    };
  }

  // --- No shot available. Is this new, or the third time? -------------------------------------------------
  if (memory.ineffectiveStreak >= ENGAGEMENT_TUNING.ineffectiveThreshold) {
    memory.flankSide = nextFlankSide(memory);
    memory.flankTicks = 0;
    memory.flankDestination = null;
    memory.flankRethinkTicks = 0;
    // Reset the streak so the next attempt gets a full budget of evidence before it gives up too. This
    // is what turns "flank once" into "keep trying until something works", which is the difference
    // between a tactic and a single scripted manoeuvre.
    memory.ineffectiveStreak = 0;
    return { intent: 'flank', reason: 'repeated shots ineffective from this angle' };
  }

  // No predicted shot, and no evidence yet. Take one deliberate probe: a prediction is an estimate, and
  // the only way to find out whether it was too pessimistic is to fire. Bounded by `probeShotLimit` so
  // this stays a test rather than becoming a firing pattern, and so the flank below is always the thing
  // that ends the engagement — see the note on `probeShotLimit` for why the two are kept equal.
  if (memory.probeStreak < ENGAGEMENT_TUNING.probeShotLimit) {
    return { intent: 'probe', reason: 'testing whether the geometry is as hopeless as predicted' };
  }

  // Probes exhausted and still nothing to shoot. This is the same frustration as the streak case, so it
  // flanks too — reached only if probes were somehow not counted, and treating it as a flank is the safe
  // direction to fail in: the opponent moves rather than standing still.
  memory.flankSide = nextFlankSide(memory);
  memory.flankTicks = 0;
  memory.flankDestination = null;
  memory.ineffectiveStreak = 0;
  memory.probeStreak = 0;
  return { intent: 'flank', reason: 'no viable shot and probing exhausted' };
}

/**
 * Picks which side to flank around next.
 *
 * Alternates, starting from the battle's preferred side. The alternation is what makes two successive
 * flank attempts different rather than the opponent repeatedly failing the same way — and the
 * preferred opening side comes from the seeded profile, so a different seed opens the fight from the
 * other side and the player cannot memorise "it always goes left".
 */
export function nextFlankSide(memory: EngagementMemory): 1 | -1 {
  if (memory.flankSide === 0) {
    return memory.preferredFlankSide;
  }
  return memory.flankSide === 1 ? -1 : 1;
}

/**
 * Records the outcome of one of the opponent's own shots.
 *
 * Called by the simulation with the combat results produced by shells this opponent fired. This is the
 * feedback loop V4 entirely lacked, and it is why the flank trigger means anything: without it,
 * `ineffectiveStreak` could never leave zero.
 *
 * A shot that misses the vehicle entirely is **not** counted as ineffective. The opponent cannot tell
 * the difference between "bounced off" and "went past" from inside its tank, and counting misses as
 * armour failures would send it repositioning because its aim was slightly off — a different problem
 * with a different fix.
 */
export function recordShot(memory: EngagementMemory, penetrated: boolean): void {
  memory.shotsObserved += 1;
  if (penetrated) {
    memory.penetrations += 1;
    memory.ineffectiveStreak = 0;
    // A shell got through, so the opponent's pessimism was unfounded. Any standing suspicion about the
    // geometry is now answered, and it should stop probing.
    memory.probeStreak = 0;
    return;
  }
  memory.ineffectiveStreak = Math.min(
    ENGAGEMENT_TUNING.ineffectiveThreshold,
    memory.ineffectiveStreak + 1,
  );
  // Counted as a probe because a shot taken while the opponent believed it would fail is exactly what a
  // probe is. Tied to the same limit as the streak, so the two reach their thresholds together.
  memory.probeStreak = Math.min(ENGAGEMENT_TUNING.probeShotLimit, memory.probeStreak + 1);
}

/** Planar distance between two points, metres. Vertical is excluded because tanks fight on the plane. */
export function planarDistanceM(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * How far off the requested aspect the opponent currently is, degrees.
 *
 * Exported for the debug overlay and for tests that assert a flank actually *improved* the angle
 * rather than merely having been attempted.
 */
export function aspectErrorDeg(desiredRad: number, actualRad: number): number {
  return Math.abs(radToDeg(wrapAngle(actualRad - desiredRad)));
}
