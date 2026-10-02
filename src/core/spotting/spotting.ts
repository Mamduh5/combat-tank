import type { Vec3 } from '../../shared/vec3.js';
import type { Battlefield } from '../world/battlefield.js';

/**
 * Spotting: knowing where the other tank is, and knowing when you have stopped knowing.
 *
 * ## What this is, and what it deliberately is not
 *
 * V5 had a boolean: the opponent could see the player or it could not, and it drove one decision. V6
 * gives the *player* the same information, plus the part that makes terrain matter — **losing** contact
 * and having to go and find it again.
 *
 * This is not a clone of any existing game's formula. It is one legible rule with a small number of
 * terms, because a detection model a player cannot predict is not a tactical system, it is a dice roll
 * with extra steps:
 *
 * > A vehicle is detected when it is within detection range and has line of sight, and is not concealed
 * > enough to matter. Firing gives it away regardless of where it is.
 *
 * ## The three states
 *
 * - **undetected** — never seen this battle.
 * - **detected** — currently visible; the position is live.
 * - **lost** — was visible, is not now, and the last known position is remembered. This is the state
 *   that makes "where might it reappear?" a question the map can answer, which is the whole of the
 *   "I lost sight of the enemy" experience in the V6 brief.
 *
 * Losing contact is **sticky for a moment**. A target that steps behind a wall for two ticks has not
 * been lost, it has been occluded; without the grace period a vehicle crossing a treeline edge would
 * strobe the contact indicator, which reads as a bug rather than as concealment.
 */

/** Tuning for the spotting system. Prototype values, and deliberately few of them. */
export const SPOTTING_TUNING = {
  /**
   * How far a vehicle in the open can be seen, metres.
   *
   * The most consequential number in the system and the one most likely to want rebalancing once a
   * human has actually played. Set a little beyond the V5 engagement band's far edge so that on open
   * ground nothing changes for the opponent: at 130 m the V5 opponent was already refusing to shoot
   * because the shot was a long gamble, so seeing a target there changes what the player knows without
   * changing what the AI can do about it.
   */
  baseSightRangeM: 200,

  /**
   * How long contact is held through a brief occlusion, seconds.
   *
   * Long enough to walk behind a barrier without flickering the indicator, short enough that genuinely
   * turning a corner counts as losing the target. 1.2 s is about the time to cross a 5 m building, which
   * is the case this exists for.
   */
  lostGraceSeconds: 1.2,

  /**
   * How long a vehicle stays "spotted" after firing, seconds.
   *
   * A shell in flight is a muzzle flash and a noise, and a crew that has just shot knows roughly where
   * it came from. This is that, reduced to one number and one sentence. See `evaluateDetection` for
   * why the rule is ordered the way it is — it is the one part of this system worth arguing about.
   */
  fireRevealSeconds: 2.5,

  /**
   * How much shorter the *observer's* effective range is when the observer is itself concealed.
   *
   * A tank in a wood is not just harder to see, it is also looking out through foliage. Modelled as a
   * small penalty rather than the full concealment factor, because the two situations are not symmetric
   * and pretending they are would make the wood somewhere you can shoot from freely.
   *
   * Applied as a fraction of the concealment **actually present**, not as a flat multiplier. The first
   * version multiplied unconditionally and so quietly shortened *everyone's* sight range to 170 m on
   * open ground — a rule nobody intended, not one anybody could learn, and one a test caught rather than
   * a playtest would have.
   */
  observerConcealmentPenalty: 0.85,
} as const;

/** What one side knows about the other. */
export type ContactState = 'undetected' | 'detected' | 'lost';

/** A transition worth telling the player about. */
export type ContactEventKind =
  /** First sight of the enemy this battle. */
  | 'acquired'
  /** Contact broken. The last known position is remembered from now on. */
  | 'lost'
  /** Seen again after having been lost. */
  | 'reacquired';

/** Something the player needs to be told about, drained once per frame by the presentation layer. */
export interface ContactEvent {
  readonly kind: ContactEventKind;
  /** Where the target was, or was last seen, at the moment of the event. */
  readonly at: Vec3;
}

/** What the observer currently knows. */
export interface Contact {
  readonly state: ContactState;
  /** The live position while detected; the last seen position while lost. `null` when undetected. */
  readonly lastKnownPosition: Vec3 | null;
  /** Seconds the target has been continuously visible. Zero when not currently detected. */
  readonly visibleSeconds: number;
}

/** One vehicle, as spotting sees it. The minimum this system needs and nothing more. */
export interface SpottingSubject {
  readonly id: string;
  readonly position: Vec3;
  /** Height at which this vehicle presents its most visible point — the turret ring, in practice. */
  readonly eyeHeightM: number;
  /**
   * Whether this vehicle fired during the current tick.
   *
   * Read from the simulation's own shell spawn rather than inferred. The spotting system has no idea
   * what a gun is; it is told a vehicle became conspicuous, which keeps this module free of any
   * knowledge of ballistics and makes the rule trivially auditable.
   */
  readonly firedThisTick: boolean;
}

/** The result of asking "can I see them right now". */
export interface DetectionResult {
  readonly detected: boolean;
  /** Distance at which detection was evaluated, metres. */
  readonly rangeM: number;
  /** The range within which detection would have succeeded, after concealment. */
  readonly effectiveRangeM: number;
  /** Whether line of sight was what failed, as opposed to distance. */
  readonly blockedByCover: boolean;
}

/** Eye position for a subject: its hull position raised by the height it presents at. */
function eyeOf(subject: SpottingSubject): Vec3 {
  return {
    x: subject.position.x,
    y: subject.position.y + subject.eyeHeightM,
    z: subject.position.z,
  };
}

/**
 * Evaluates whether `observer` can detect `target` at this instant.
 *
 * Pure apart from the battlefield it is handed, so a test can place two vehicles deliberately and assert
 * the answer without running a battle.
 */
export function evaluateDetection(
  battlefield: Battlefield,
  observer: SpottingSubject,
  target: SpottingSubject,
): DetectionResult {
  const observerEye = eyeOf(observer);
  const targetEye = eyeOf(target);

  const dx = targetEye.x - observerEye.x;
  const dy = targetEye.y - observerEye.y;
  const dz = targetEye.z - observerEye.z;
  const rangeM = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Concealment shortens the distance at which the target can be picked out. The observer's own
  // concealment shortens it a little further, but only *in proportion to how concealed the observer
  // actually is* — a flat penalty would apply to a tank standing in the open too, which is how the
  // first version of this rule ended up silently giving every vehicle 170 m of sight range.
  const targetConcealment = battlefield.concealmentAt(target.position.x, target.position.z);
  const observerConcealment = battlefield.concealmentAt(observer.position.x, observer.position.z);
  const observerPenalty =
    1 - (1 - observerConcealment.factor) * SPOTTING_TUNING.observerConcealmentPenalty;
  const effectiveRangeM = SPOTTING_TUNING.baseSightRangeM * targetConcealment.factor * observerPenalty;

  const lineOfSight = battlefield.hasLineOfSight(observerEye, targetEye);

  // Firing gives a vehicle away whatever else is true, and it is ordered *before* the range and
  // line-of-sight tests on purpose. A shell fired from behind a building is still a noise the other crew
  // heard, so a system that required sight in order to hear would refuse to reward the one action a
  // player takes precisely because they cannot see. A player who fires at a noise and gets the enemy
  // back is being told the truth; a player who fires to *reveal* a target they cannot see would be
  // cheating, and this rule does not permit that, because the target has to be within `effectiveRangeM`
  // of the shot being reported — the reveal is short-ranged, not map-wide.
  const revealedByFiring = target.firedThisTick && rangeM <= effectiveRangeM * FIRE_REVEAL_RANGE_SCALE;

  return {
    detected: revealedByFiring || (lineOfSight.clear && rangeM <= effectiveRangeM),
    rangeM,
    effectiveRangeM,
    blockedByCover: !lineOfSight.clear,
  };
}

/**
 * How much further a shot can be heard than a vehicle can be seen, as a multiple of sight range.
 *
 * A muzzle flash carries further than a silhouette, but not to the far side of the map. At 1.6, a
 * vehicle firing in the open is spotted at up to 320 m — well past its own concealment-adjusted sight
 * range from a concealed observer, so peeking out to fire is a real risk — and no further.
 */
const FIRE_REVEAL_RANGE_SCALE = 1.6;
