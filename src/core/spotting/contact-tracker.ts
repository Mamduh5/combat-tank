import { SPOTTING_TUNING, type Contact, type ContactEvent, type ContactState } from './spotting.js';
import type { Vec3 } from '../../shared/vec3.js';
import type { DetectionResult } from './spotting.js';

/**
 * Turns a stream of per-tick detection answers into a contact state and a short list of events.
 *
 * ## Why the state machine is separate from the detection test
 *
 * `evaluateDetection` answers one question about one instant: can this observer see that target right
 * now. That is not enough to drive an interface, and the gap is where spotting systems usually go
 * wrong. A vehicle crossing a treeline edge is invisible for two ticks and visible for two, and a
 * system that reported that literally would flicker the contact indicator four times a second. A player
 * would read the flicker as a bug, and would be right to.
 *
 * So the *test* stays instantaneous and honest, and this class adds only hysteresis and memory:
 *
 * - a **grace period** during which a lost target is still reported as detected, so ordinary occlusion
 *   does not register as a loss;
 * - a **memory** of the last known position, so a lost target is somewhere rather than nowhere;
 * - **events**, so the presentation layer can say "contact lost" once rather than inferring it.
 *
 * The property that makes this safe: none of it can make a target *more* visible than the test says.
 * The grace period only ever delays a loss; it never manufactures a detection. Concealment therefore
 * still works, and it works by keeping a target invisible long enough for the grace period to expire.
 */

/** Mutable state for one observer watching one target. */
interface TrackedContact {
  state: ContactState;
  /** Remembered position: live while detected, the last sighting while lost. */
  lastKnownPosition: Vec3 | null;
  /** Seconds the target has been continuously visible. */
  visibleSeconds: number;
  /** Seconds of grace remaining before a loss is declared. */
  graceRemainingSeconds: number;
  /** Seconds since the target last fired. Drives the "spotted because it fired" HUD state. */
  secondsSinceTargetFired: number;
  /** How concealed the observer is, in `[0, 1]`. `1` is fully exposed. */
  observerConcealment: number;
}

export class ContactTracker {
  private readonly state: TrackedContact = {
    state: 'undetected',
    lastKnownPosition: null,
    visibleSeconds: 0,
    graceRemainingSeconds: 0,
    secondsSinceTargetFired: Number.POSITIVE_INFINITY,
    observerConcealment: 1,
  };

  private readonly pending: ContactEvent[] = [];

  /** A read-only view of what is currently known. */
  get contact(): Contact {
    return {
      state: this.state.state,
      lastKnownPosition: this.state.lastKnownPosition,
      visibleSeconds: this.state.visibleSeconds,
    };
  }

  /** How concealed the observer currently is, in `[0, 1]`. `1` is fully exposed. */
  get observerConcealmentFactor(): number {
    return this.state.observerConcealment;
  }

  /** Seconds since the target last fired, for the HUD. */
  get secondsSinceTargetFired(): number {
    return this.state.secondsSinceTargetFired;
  }

  /** Takes every event produced since the last call. */
  drainEvents(): readonly ContactEvent[] {
    return this.pending.splice(0, this.pending.length);
  }

  /** Clears everything, for a restart. */
  reset(): void {
    this.state.state = 'undetected';
    this.state.lastKnownPosition = null;
    this.state.visibleSeconds = 0;
    this.state.graceRemainingSeconds = 0;
    this.state.secondsSinceTargetFired = Number.POSITIVE_INFINITY;
    this.pending.length = 0;
  }

  /**
   * Advances contact by one tick.
   *
   * @param detection this tick's answer from `evaluateDetection`
   * @param targetPosition where the target actually is, used only to refresh the remembered position
   * @param targetFiredThisTick whether the target fired this tick, for the reveal rule
   * @param observerConcealmentFactor how concealed the observer is, for the HUD
   * @param dtSeconds elapsed simulation time
   */
  update(
    detection: DetectionResult,
    targetPosition: Vec3,
    targetFiredThisTick: boolean,
    observerConcealmentFactor: number,
    dtSeconds: number,
  ): void {
    const s = this.state;
    s.observerConcealment = observerConcealmentFactor;
    s.secondsSinceTargetFired = targetFiredThisTick
      ? 0
      : s.secondsSinceTargetFired + dtSeconds;

    if (detection.detected) {
      this.acquire(targetPosition, dtSeconds);
      return;
    }

    // Not visible. The grace period decides whether that is a loss or merely an occlusion.
    if (s.graceRemainingSeconds > 0) {
      s.graceRemainingSeconds -= dtSeconds;
      return;
    }
    this.lose();
  }

  /** The target is visible: remember where, and note any transition into or back to detection. */
  private acquire(position: Vec3, dtSeconds: number): void {
    const s = this.state;
    s.lastKnownPosition = { x: position.x, y: position.y, z: position.z };
    s.visibleSeconds += dtSeconds;
    // The grace timer resets on every sighting, so a target flickering in and out of sight never
    // accumulates enough *continuous* absence to be declared lost.
    s.graceRemainingSeconds = SPOTTING_TUNING.lostGraceSeconds;

    if (s.state === 'undetected') {
      s.state = 'detected';
      this.pending.push({ kind: 'acquired', at: { ...position } });
    } else if (s.state === 'lost') {
      s.state = 'detected';
      s.visibleSeconds = 0;
      this.pending.push({ kind: 'reacquired', at: { ...position } });
    }
  }

  /** The target is not visible and the grace has run out. */
  private lose(): void {
    const s = this.state;
    if (s.state !== 'detected') {
      // Already lost, or never found. Nothing to report either way, and the remembered position is
      // kept regardless: "lost somewhere over there" is more useful to a player than "no idea at all".
      return;
    }
    s.state = 'lost';
    s.visibleSeconds = 0;
    if (s.lastKnownPosition !== null) {
      this.pending.push({ kind: 'lost', at: { ...s.lastKnownPosition } });
    }
  }
}

