import type { ContactState } from '../../core/spotting/spotting.js';
import { radToDeg, wrapAngle } from '../../core/math/index.js';
import type { VehicleTelemetry } from '../../core/vehicle/vehicle-state.js';
import type { CombatResult } from '../../core/combat/combat-resolver.js';

/**
 * Minimal heads-up display.
 *
 * The V1 scope was a speed readout plus diagnostics; V2 adds the gunnery state. The elements exist
 * to make the simulation *legible* (vision principle P6): the player should be able to see that the
 * tank is heavy, that the turret is genuinely slewing rather than snapping, and that the gun is
 * reloading, without guessing.
 *
 * Text is written to the DOM only when it changes. Assigning `textContent` on a node the browser has
 * already laid out forces style recalculation, so a HUD updated every frame at 60 Hz is a measurable
 * cost for no benefit.
 *
 * Elements are looked up once and cached, and a missing element is tolerated rather than thrown, so
 * the HUD degrades instead of breaking the frame loop.
 */
export class Hud {
  private readonly speedValue: HTMLElement | null;
  private readonly gearValue: HTMLElement | null;
  private readonly traverseValue: HTMLElement | null;
  private readonly turretValue: HTMLElement | null;
  private readonly gunValue: HTMLElement | null;
  private readonly aimRange: HTMLElement | null;
  private readonly reloadFill: HTMLElement | null;
  private readonly hitPanel: HTMLElement | null;
  private readonly hitOutcome: HTMLElement | null;
  private readonly hitDetail: HTMLElement | null;
  private readonly hitMath: HTMLElement | null;
  private readonly hitDamage: HTMLElement | null;
  private readonly hitModule: HTMLElement | null;
  private readonly status: HTMLElement | null;
  private readonly hint: HTMLElement | null;
  /** Container for the developer diagnostics row, hidden unless debug mode is on. */
  private readonly debugRow: HTMLElement | null;
  /** The control that turns debug mode on and off, so its state can be reflected back. */
  private readonly debugToggle: HTMLElement | null;
  /** Centred shot-outcome banner and its supporting line. */
  private readonly banner: HTMLElement | null;
  private readonly bannerVerdict: HTMLElement | null;
  private readonly bannerSub: HTMLElement | null;
  /** Target status strip elements. */
  private readonly targetPanel: HTMLElement | null;
  private readonly targetName: HTMLElement | null;
  private readonly targetHp: HTMLElement | null;
  private readonly targetHpMax: HTMLElement | null;
  private readonly targetHpFill: HTMLElement | null;
  private readonly targetRange: HTMLElement | null;
  /** V6 contact readout, hidden until the player has seen the enemy at least once. */
  private readonly targetContact: HTMLElement | null;
  /** First-launch briefing, dismissed once the player starts playing. */
  private readonly briefing: HTMLElement | null;
  /** Incoming-hit banner: the player's own armour taking a hit. */
  private readonly incomingBanner: HTMLElement | null;
  private readonly incomingVerdict: HTMLElement | null;
  private readonly incomingSub: HTMLElement | null;
  /** End-of-battle overlay. */
  private readonly outcome: HTMLElement | null;
  private readonly outcomeTitle: HTMLElement | null;
  private readonly outcomeStats: HTMLElement | null;
  /** Persistent "press R to restart" prompt. */
  private readonly restartHint: HTMLElement | null;
  /** Player condition panel: own hit points and destroyed modules. */
  private readonly playerPanel: HTMLElement | null;
  private readonly playerHp: HTMLElement | null;
  private readonly playerHpFill: HTMLElement | null;
  private readonly playerStatus: HTMLElement | null;

  /** Remaining display time for the incoming-hit banner, seconds. */
  private incomingTimer = 0;

  /**
   * Seconds the outcome banner stays on screen, counted down by `tick`.
   *
   * Long enough to read comfortably, short enough that it is gone before the player lines up the next
   * shot. A banner that lingers becomes permanent furniture and stops being read as an event.
   */
  private bannerTimer = 0;

  /**
   * Whether the diagnostics row is currently hidden.
   *
   * Starts **visible** because the first thing to verify is that the armour model is doing something
   * legible at all; hiding it by default would mean the numbers are never seen. Once the player has
   * confirmed the model works, one key press moves them out of the way permanently.
   */
  private debugHidden = false;

  private lastSpeedText = '';
  private lastGearText = '';
  private lastTraverseText = '';
  private lastTurretText = '';
  private lastGunText = '';
  private lastRangeText = '';
  private lastStatusText = '';
  private lastReloadPercent = -1;
  private lastReloading = false;

  constructor(root: Document = document) {
    this.speedValue = root.getElementById('speed-value');
    this.gearValue = root.getElementById('gear-value');
    this.traverseValue = root.getElementById('traverse-value');
    this.turretValue = root.getElementById('turret-value');
    this.gunValue = root.getElementById('gun-value');
    this.aimRange = root.getElementById('aim-range');
    this.reloadFill = root.getElementById('reload-fill');
    this.hitPanel = root.getElementById('hit-panel');
    this.hitOutcome = root.getElementById('hit-outcome');
    this.hitDetail = root.getElementById('hit-detail');
    this.hitMath = root.getElementById('hit-math');
    this.hitDamage = root.getElementById('hit-damage');
    this.hitModule = root.getElementById('hit-module');
    this.status = root.getElementById('hud-status');
    this.hint = root.getElementById('hud-hint');
    this.debugRow = root.getElementById('hit-math');
    this.debugToggle = root.getElementById('debug-toggle');
    this.banner = root.getElementById('combat-banner');
    this.bannerVerdict = root.getElementById('combat-verdict');
    this.bannerSub = root.getElementById('combat-sub');
    this.targetPanel = root.getElementById('hud-target');
    this.targetName = root.getElementById('target-name');
    this.targetHp = root.getElementById('target-hp');
    this.targetHpMax = root.getElementById('target-hp-max');
    this.targetHpFill = root.getElementById('target-hp-fill');
    this.targetRange = root.getElementById('target-range');
    this.targetContact = root.getElementById('target-contact');
    this.briefing = root.getElementById('hud-briefing');

    this.incomingBanner = root.getElementById('incoming-banner');
    this.incomingVerdict = root.getElementById('incoming-verdict');
    this.incomingSub = root.getElementById('incoming-sub');

    this.outcome = root.getElementById('hud-outcome');
    this.outcomeTitle = root.getElementById('outcome-title');
    this.outcomeStats = root.getElementById('outcome-stats');

    this.restartHint = root.getElementById('restart-hint');

    this.playerPanel = root.getElementById('hud-player');
    this.playerHp = root.getElementById('player-hp');
    this.playerHpFill = root.getElementById('player-hp-fill');
    this.playerStatus = root.getElementById('player-status');
  }

  /**
   * Per-frame housekeeping: ages out the outcome banner.
   *
   * A separate `tick` rather than folding the countdown into an update method, so the banner's
   * lifetime is driven by elapsed time and not by whether some particular readout happened to change
   * this frame.
   */
  tick(dtSeconds: number): void {
    // The incoming banner ages independently of the outgoing one: an incoming hit is worth showing for
    // longer, because the player has to notice it before it becomes a destroyed tank.
    if (this.incomingTimer > 0) {
      this.incomingTimer -= dtSeconds;
      if (this.incomingTimer <= 0) {
        this.incomingBanner?.classList.remove('show');
      }
    }

    if (this.bannerTimer <= 0) {
      return;
    }
    this.bannerTimer -= dtSeconds;
    if (this.bannerTimer <= 0) {
      this.bannerTimer = 0;
      this.banner?.classList.remove('show');
    }
  }

  /**
   * Updates the driving and gunnery readouts.
   *
   * Speed is shown in m/s to match the units used throughout the simulation, rather than km/h,
   * because the number on screen should be directly comparable to the vehicle definition.
   */
  updateDriving(telemetry: VehicleTelemetry): void {
    const speedText = telemetry.speedMps.toFixed(1);
    if (speedText !== this.lastSpeedText) {
      setText(this.speedValue, speedText);
      this.lastSpeedText = speedText;
    }

    const gearText = gearLabel(telemetry);
    if (gearText !== this.lastGearText) {
      setText(this.gearValue, gearText);
      this.lastGearText = gearText;
    }

    const traverseText = `HULL ${telemetry.traverseRateDegPerSec.toFixed(0)}°/s`;
    if (traverseText !== this.lastTraverseText) {
      setText(this.traverseValue, traverseText);
      this.lastTraverseText = traverseText;
    }

    // --- V2 gunnery -------------------------------------------------------------------
    // The reload indicator is the one thing the player cannot infer from the vehicle itself: a shot
    // refused during a reload is otherwise completely silent, and looks like a broken gun.
    const loaded = telemetry.gunLoadState === 'loaded';
    const gunText = loaded
      ? `GUN READY · ${telemetry.gunElevationDeg.toFixed(0)}°`
      : `RELOADING ${telemetry.reloadRemainingSeconds.toFixed(1)}s`;
    if (gunText !== this.lastGunText) {
      setText(this.gunValue, gunText);
      this.gunValue?.classList.toggle('reloading', !loaded);
      this.lastGunText = gunText;
    }

    // The turret's offset from the hull is what makes "the tank turned on its own" legible: it
    // shows how far the gun currently sits from the vehicle's nose.
    const offsetDeg = radToDeg(wrapAngle(telemetry.turretWorldHeadingRad - telemetry.headingRad));
    const offsetText = `TURRET ${offsetDeg.toFixed(0)}°`;
    if (offsetText !== this.lastTurretText) {
      setText(this.turretValue, offsetText);
      this.lastTurretText = offsetText;
    }
  }

  /**
   * Updates the reload progress bar.
   *
   * Driven by the core's own reload timer rather than by a client-side countdown, so the bar cannot
   * disagree with whether the gun will actually accept a shot.
   */
  updateReloadProgress(progress: number, reloading: boolean): void {
    const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    if (percent !== this.lastReloadPercent) {
      if (this.reloadFill !== null) {
        this.reloadFill.style.width = `${percent}%`;
      }
      this.lastReloadPercent = percent;
    }
    if (reloading !== this.lastReloading) {
      this.reloadFill?.classList.toggle('reloading', reloading);
      this.lastReloading = reloading;
    }
  }

  /**
   * Updates the aim range readout.
   *
   * This is the distance from the camera along its view direction to the terrain, which is the
   * information a gunner needs and the thing a V2 reticle will be built around. Passing `null`
   * shows a dash, which is the honest answer when the view is pointing at the sky.
   */
  updateAimRange(distanceM: number | null): void {
    const text = distanceM === null ? '--' : Math.round(distanceM).toString();
    if (text !== this.lastRangeText) {
      setText(this.aimRange, text);
      this.lastRangeText = text;
    }
  }

  /**
 * Updates the hit-feedback panel with the outcome of the player's most recent shot.
 *
 * The owner asked that the player be able to distinguish penetrated, blocked, and ricocheted **without
 * inspecting logs**. So the three outcomes get distinct wording *and* distinct colours, and the panel
 * explains *why* in the terms the armour model actually uses — which plate, at what angle, what effective
 * thickness, against how much shell capability. That is the panel that makes the model learnable
 * (vision principle P6), and it doubles as the debugging surface.
 *
 * @param result the combat outcome, or `null` for a shot that missed the vehicle entirely
 * @param targetHp target hit points after the hit, for the damage readout
 * @param modulesDestroyed modules knocked out by this shot, if any
 */
  updateHitFeedback(
    result: CombatResult | null,
    targetHp: number,
    modulesDestroyed: readonly string[] = [],
  ): void {
    if (result === null || result.kind === 'armour-miss') {
      this.showOutcome('MISS', null);
      setText(this.hitDamage, '—');
      setText(this.hitModule, '');
      setText(this.hitDetail, '');
      setText(this.hitMath, '');
      return;
    }

    const p = result.penetration;
    const plate = result.plate.definition;
    const section = plate.region.toUpperCase();

    // The verdict and the armour section: what the player needs in order to decide what to do next.
    // The verdict is the only line at headline size, because distinguishing these three outcomes is
    // the entire point of the feedback (vision principle P6).
    this.showOutcome(result.kind.toUpperCase(), result.kind);
    setText(this.hitDetail, section);

    // Secondary: what it cost. Damage is what the player acts on, so it sits above the shell
    // arithmetic rather than being buried beneath it.
    setText(
      this.hitDamage,
      result.kind === 'penetrated' ? `-${result.damage.vehicleDamage} HP · ${targetHp} left` : 'no damage',
    );
    setText(
      this.hitModule,
      modulesDestroyed.length > 0 ? `destroyed: ${modulesDestroyed.join(', ')}` : '',
    );

    // Tertiary: the armour arithmetic. Kept because the model is the point of V3 and the numbers are
    // worth learning, but held in a subordinate row so they inform without competing with the verdict.
    setText(
      this.hitMath,
      `${plate.thicknessMm}mm @ ${p.incidenceAngleDeg.toFixed(0)}° → ${p.effectiveArmorMm.toFixed(0)}mm`,
    );
  }

  /**
   * Shows the headline outcome in its own colour, revealing the panel if it was hidden.
   *
   * Extracted because this sequence was previously written out in each branch of the outcome
   * selection, where the copies had already begun to drift apart.
   */
  private showOutcome(label: string, kind: 'penetrated' | 'blocked' | 'ricocheted' | null): void {
    setText(this.hitOutcome, label);
    if (this.hitOutcome !== null) {
      this.hitOutcome.classList.remove('penetrated', 'blocked', 'ricocheted');
      if (kind !== null) {
        this.hitOutcome.classList.add(kind);
      }
    }
    this.hitPanel?.classList.remove('hidden');
  }

  /**
   * Toggles the developer diagnostics row.
   *
   * The armour arithmetic is worth having but is not what the player needs in the moment of firing.
   * Behind a toggle the primary verdict stays readable while the numbers remain one key press away
   * for anyone learning the model or diagnosing a shot.
   */
  toggleDebug(): void {
    this.debugHidden = !this.debugHidden;
    this.debugRow?.classList.toggle('hidden', this.debugHidden);
    this.debugToggle?.classList.toggle('active', !this.debugHidden);
  }

  /**
   * Shows the shot outcome as a large centred banner.
   *
   * Separate from the corner panel on purpose. The corner panel is where the player looks when they
   * want detail; the banner is where they are already looking when the shot lands. Both show the same
   * verdict in the same colour, so the two never disagree and the player only has to learn one
   * vocabulary.
   */
  showCombatBanner(verdict: string, kind: string, sub: string): void {
    if (this.bannerVerdict !== null) {
      this.bannerVerdict.textContent = verdict;
      this.bannerVerdict.className = `verdict ${kind}`;
    }
    setText(this.bannerSub, sub);
    this.banner?.classList.add('show');
    this.bannerTimer = BANNER_HOLD_SECONDS;
  }

  /**
   * Updates the target status strip, or hides it when there is no target.
   *
   * The panel exists because a stationary opponent is easy to lose track of: without it, "did that
   * shell land?" and "how much is left?" both require the player to remember what they saw.
   */
  updateTargetStatus(
    target: { name: string; hp: number; maxHp: number; rangeM: number; destroyed: boolean } | null,
  ): void {
    if (target === null) {
      this.targetPanel?.classList.add('hidden');
      return;
    }

    this.targetPanel?.classList.remove('hidden');
    this.targetPanel?.classList.toggle('destroyed', target.destroyed);

    setText(this.targetName, target.destroyed ? `${target.name} — DESTROYED` : target.name);
    setText(this.targetHp, target.hp.toString());
    setText(this.targetHpMax, `/ ${target.maxHp}`);
    setText(this.targetRange, `${Math.round(target.rangeM)} m`);

    // The bar is what makes "nearly dead" legible at a glance; the number alone does not, because a
    // player glancing at a readout does not compute the fraction.
    const fraction = target.maxHp > 0 ? target.hp / target.maxHp : 0;
    if (this.targetHpFill !== null) {
      this.targetHpFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      this.targetHpFill.classList.toggle('hurt', fraction <= 0.5 && fraction > 0.25);
      this.targetHpFill.classList.toggle('critical', fraction <= 0.25);
    }
  }
  /**
   * Shows what the player currently knows about the enemy: in contact, or contact lost.
   *
   * Added in V6 with the spotting system. Deliberately one word and one colour. The V6 brief asks
   * for the player to be able to tell whether an enemy is detected, when it is lost, and when it is
   * reacquired - and all three of those are answerable from this line plus the moment it changes. A bar,
   * a percentage or a timer would be more information and less usable, because a player mid-fight
   * reads a shape, not a number.
   *
   * Hidden entirely before first contact: "no contact" against an enemy the player has never seen
   * is not information, it is noise, and it would sit on screen for the whole approach.
   *
   * @param state the current contact state
   * @param everSeen whether the enemy has been seen at all this battle
   */
  setContact(state: ContactState, everSeen: boolean): void {
    const element = this.targetContact;
    if (element === null) {
      return;
    }
    if (!everSeen || state === 'undetected') {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    if (state === 'lost') {
      setText(element, 'CONTACT LOST');
      element.dataset.state = 'lost';
    } else {
      setText(element, 'IN CONTACT');
      element.dataset.state = 'detected';
    }
  }


  /**
   * Shows that the *player* has been hit, as distinct from a shot they took.
   *
   * Separate from `showCombatBanner` and positioned on the **opposite side** of the screen. The player
   * reads the two differently: an outgoing result is information ("did my shot work?"), an incoming one
   * is a warning ("I am being hurt"). Putting them in the same place and style would mean the player
   * has to read the text to tell which one happened — exactly the confusion V4 has to remove, because
   * both sides now fire.
   *
   * Red and held for longer than an outgoing banner: an incoming hit that flashes for a moment is easy
   * to miss, and missing it means missing the information that the player is about to die.
   */
  showIncomingHit(verdict: string, kind: string, sub: string): void {
    setText(this.incomingVerdict, verdict);
    if (this.incomingVerdict !== null) {
      this.incomingVerdict.className = `verdict incoming ${kind}`;
    }
    setText(this.incomingSub, sub);
    this.incomingBanner?.classList.add('show');
    this.incomingTimer = INCOMING_HOLD_SECONDS;
  }

  /**
   * Updates the player's own condition: hit points, and what has been knocked out.
   *
   * Added in V4 because the player is now destructible. The own-vehicle panel is the player's most
   * important readout — more important than speed — and it is placed bottom-left opposite the enemy
   * panel so the two conditions can be compared at a glance without the eyes travelling.
   *
   * Module damage is summarised rather than itemised: a player who has lost a track needs to know their
   * mobility is impaired, not to read the internal id of the module.
   */
  updatePlayerStatus(status: {
    hp: number;
    maxHp: number;
    destroyed: boolean;
    immobilised: boolean;
    tracksDestroyed: number;
    gunDisabled: boolean;
  } | null): void {
    if (status === null) {
      this.playerPanel?.classList.add('hidden');
      return;
    }

    this.playerPanel?.classList.remove('hidden');
    this.playerPanel?.classList.toggle('critical', status.destroyed);
    setText(this.playerHp, status.hp.toString());

    const fraction = status.maxHp > 0 ? status.hp / status.maxHp : 0;
    if (this.playerHpFill !== null) {
      this.playerHpFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      this.playerHpFill.classList.toggle('hurt', fraction <= 0.5 && fraction > 0.25);
      this.playerHpFill.classList.toggle('critical', fraction <= 0.25);
    }

    // Worst status first: a destroyed vehicle is more urgent to report than a damaged track.
    const notes: string[] = [];
    if (status.destroyed) {
      notes.push('DESTROYED');
    } else {
      if (status.immobilised) {
        notes.push('IMMOBILISED');
      }
      if (status.gunDisabled) {
        notes.push('GUN DISABLED');
      }
      if (status.tracksDestroyed === 1) {
        notes.push('TRACK DRAGGING');
      } else if (status.tracksDestroyed >= 2) {
        notes.push('TRACKS DESTROYED');
      }
    }
    setText(this.playerStatus, notes.length > 0 ? notes.join(' \u00b7 ') : 'ALL SYSTEMS OK');
    this.playerStatus?.classList.toggle('warn', notes.length > 0);
    this.playerStatus?.classList.toggle('bad', status.destroyed || status.immobilised);
  }

  /**
   * Shows the end-of-battle screen.
   *
   * Carries a short stat line rather than just a verdict, because the first thing a player wants to know
   * after a fight is how it went: shots fired, shots taken, and what each side had left. It turns "I lost"
   * into information the player can act on, which is the difference between a loss and a mystery.
   */
  showBattleOutcome(
    won: boolean,
    playerShots: number,
    opponentShots: number,
    playerHp: number,
    opponentHp: number,
  ): void {
    setText(this.outcomeTitle, won ? 'ENEMY DESTROYED' : 'DESTROYED');
    this.outcomeTitle?.classList.toggle('won', won);
    this.outcomeTitle?.classList.toggle('lost', !won);
    setText(
      this.outcomeStats,
      `Your shots: ${playerShots}   \u00b7   Its shots: ${opponentShots}\n` +
        `Your hull: ${Math.max(0, playerHp)} HP   \u00b7   Enemy: ${Math.max(0, opponentHp)} HP`,
    );
    this.outcome?.classList.add('show');
  }

  /** Hides the end-of-battle screen, for a restart. */
  hideBattleOutcome(): void {
    this.outcome?.classList.remove('show');
  }

  /** Shows or hides the "press R to restart" prompt. */
  showRestartHint(visible: boolean): void {
    this.restartHint?.classList.toggle('show', visible);
  }

  /** Dismisses the first-launch briefing. Called once the player has clearly started playing. */
  hideBriefing(): void {
    this.briefing?.classList.add('hidden');
  }

  /** Sets the status line. `isError` tints it, for startup failures. */
  setStatus(message: string, isError = false): void {
    if (message === this.lastStatusText) {
      return;
    }
    setText(this.status, message);
    this.status?.classList.toggle('error', isError);
    this.lastStatusText = message;
  }

  /** Fades the control hint once the player has clearly started driving. */
  hideHint(): void {
    this.hint?.classList.add('hidden');
  }
}

/** Shows the control hint again, e.g. after resetting. */
export function showHint(hud: Hud): void {
  hud.setStatus('Click to capture mouse');
}

/**
 * How long the centred outcome banner stays visible, seconds.
 *
 * Long enough to read at a glance while the tank is still moving, short enough to be gone before the
 * player lines up the next shot.
 */
const BANNER_HOLD_SECONDS = 2.4;

/**
 * How long the incoming-hit banner stays up, seconds.
 *
 * Longer than an outgoing result. The player has to act on an incoming hit — move, turn, use cover — so
 * it needs to be readable while they are doing that, whereas an outgoing result is information they can
 * absorb at leisure.
 */
const INCOMING_HOLD_SECONDS = 3.2;

/** Derives a gear-style label from current speed and throttle, for a quick read of intent. */
function gearLabel(telemetry: VehicleTelemetry): string {
  if (telemetry.stalled) {
    return 'STALL';
  }
  if (telemetry.speedMps > 0.15) {
    return 'DRIVE';
  }
  if (telemetry.speedMps < -0.15) {
    return 'REV';
  }
  if (Math.abs(telemetry.requestedThrottle) > 0.05) {
    return telemetry.requestedThrottle > 0 ? 'DRIVE' : 'REV';
  }
  return 'N';
}

function setText(element: HTMLElement | null, text: string): void {
  if (element !== null && element.textContent !== text) {
    element.textContent = text;
  }
}
