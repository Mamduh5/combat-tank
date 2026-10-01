import { makeInput, type InputCommand } from '../../shared/input.js';
import { atan2, cos, radToDeg, sin, vec3, type Vec3, wrapAngle } from '../math/index.js';
import { Rng } from '../rng/index.js';
import type { Terrain } from '../world/terrain.js';
import type { Tank } from '../vehicle/tank.js';
import { buildWorldPlates } from '../armor/geometry.js';
import {
  assessPlate,
  bestPredictedShot,
  bestVisibleMarginMm,
  weakestVisibleRegion,
  type PlateAssessment,
} from './shot-evaluation.js';
import {
  chooseFlankDestination,
  createSteeringMemory,
  steerToward,
  type SteeringMemory,
} from './navigation.js';
import {
  chooseIntent,
  createEngagementMemory,
  recordShot,
  ENGAGEMENT_TUNING,
  type EngagementIntent,
  type EngagementMemory,
} from './engagement-plan.js';

/**
 * The V5 opponent: a tank that tries to work out how to beat you.
 *
 * ## What is unchanged from V4, deliberately
 *
 * This controller **still does not damage anything**. It produces an `InputCommand` - the exact struct
 * the keyboard produces - and the enemy `Tank` is stepped with it through the same `step` call the
 * player's is. Its turret servos at its own rate, its gun obeys its own reload timer, its shells obey
 * the same ballistics, and its hits go through the same penetration model as the player's. There is no
 * path from this file to the damage model, and that is the property ADR-0014 exists to protect.
 *
 * Everything V5 adds is *decision-making*, which sits entirely above that line.
 *
 * ## What actually changed
 *
 * V4 had one policy: stand off at a fixed 58-degree bearing and shoot the hull centre. It could not
 * tell whether a shot worked. It fired five shells into a 400 mm frontal plate, watched five of them
 * bounce, and did the same thing again - because nothing recorded the outcome.
 *
 * V5 adds three capabilities, each in its own module so it can be tested on its own:
 *
 * - `shot-evaluation.ts` - would this shot work? Uses the real penetration model, before firing.
 * - `engagement-plan.ts` - given how my shooting has been going, what should I do?
 * - `navigation.ts` - how do I get there without getting stuck?
 *
 * ## The feedback loop is the whole point
 *
 * `observeCombat` is called by the simulation with the results of shells **this opponent fired**. It is
 * the capability V4 entirely lacked: the opponent now knows whether its shooting is working, so "three
 * bounces in a row" becomes a decision to change what it is doing rather than just an unpleasant number.
 *
 * This is deliberately a narrow channel. The controller is told *whether a shot penetrated*, nothing
 * about the players health, position or modules. It cannot cheat by reading the players damage state,
 * and it cannot hurt the player except by actually firing a real shell that gets through real armour.
 */

/** Default seed for the opponent's aim scatter. Chosen once, recorded, and not varied per battle. */
const ENEMY_DEFAULT_SEED = 0x5eed1a4b;

/** Ticks per second, for converting second-denominated tuning. Mirrors `TICK_HZ` (ADR-0008). */
const TICKS_PER_SECOND = 60;

/**
 * How far from its preferred range the opponent tolerates being before it corrects, metres.
 *
 * Small, because a tank that shuffles a couple of metres every tick looks nervous and gains nothing.
 * Set well below the range band width so the opponent settles inside it rather than drifting out of it.
 */
const STATION_KEEP_TOLERANCE_M = 4;

/**
 * Throttle the opponent applies while engaging and already within its preferred range.
 *
 * A deliberate, gentle forward creep rather than a hard stop. See the note in `chooseMovement`: this
 * single value is the difference between an opponent that trades shots with a charging player and one
 * the player can walk straight past untouched.
 */
const ENGAGING_CREEP_THROTTLE = 0.22;

/** Tuning for the opponent's driving and gunnery. Prototype values, not balance. */
export const ENEMY_TUNING = {
  /**
   * Aim error cone, degrees.
   *
   * The opponent's "skill" knob, and it is applied at the aim point rather than by editing the
   * penetration result — so a scattered shot that misses does so because the *shell* missed, with real
   * drop and travel time, exactly as a player's miss does.
   *
   * 1.6 degrees is roughly a third of the hull's width at 40 m, so most shots land on the vehicle and
   * some meet armour that stops them. Deliberately **not** reduced in V5: the tactical layer decides
   * *where* to shoot, but the opponent is still a human gunner with a human's scatter, and making it
   * superhuman would paper over whether the positioning logic works.
   */
  aimErrorDeg: 1.6,

  /** Fraction of a full turn demand used to steer the hull, so it turns with visible weight. */
  hullTurnAuthority: 0.85,
  /** Fraction of full throttle, so the opponent accelerates like the heavy vehicle it is. */
  throttleAuthority: 0.9,

  /** Closest range it will shoot from, metres. Inside `nearRangeM` so backing off never silences it. */
  minEngageRangeM: 24,
  /** Beyond this it will not fire at all, because the shot would be a long gamble. */
  maxEngageRangeM: 130,

  /**
   * Turret bearing tolerance, degrees.
   *
   * How far the gun may be from the targets bearing and still count as "on target". Consulted only by
   * the intents that shoot at all, so a generous value costs the opponent nothing when it has no
   * solution - and that is the point.
   *
   * It was 1.8 degrees in V4, which turns out to be far too tight to survive a fast-closing target.
   * Measured during V5 development against a player driving straight at the opponent: the turret slewed
   * from 1 to 45 degrees tracking the player perfectly well, and because the bearing swept slightly
   * faster than the turrets 24 deg/s could turn, the error stayed roughly constant. The gun was always
   * "on target" by the gunners eye and never by the gate, so the opponent fired nothing at all.
   *
   * Measured after the range-control fix: at five degrees the opponent took eleven shots at a parked player
   * pointed at the vehicle rather than merely near it. Combined with aimErrorDeg this is a gunner who
   * takes reasonable shots rather than one waiting for a perfect one.
   */
  fireBearingToleranceDeg: 2.2,

  /**
   * Range the flank planner tries to end up at, metres.
   *
   * Inside the engagement band and comfortably inside its own maximum engagement range, so a completed
   * flank always arrives at a position the gun is willing to shoot from. This was a real V4 bug in a
   * different form — the movement band and the firing floor disagreed, and the opponent drove to a
   * range it then declined to shoot at — and keeping one number for "where I want to fight" is what
   * prevents the two from drifting apart again.
   */
  preferredRangeM: 55,

  /** Seconds it keeps searching for a lost player before driving to the arena centre to look. */
  searchTimeoutSeconds: 6,
  /** How close it drives to the last known player position before declaring the search over. */
  searchArrivalRadiusM: 12,
} as const;

/**
 * A snapshot of what the opponent is thinking, for the debug overlay and for tests.
 *
 * The brief asks for this explicitly, and the reason is worth stating: **an AI that behaves wrongly
 * otherwise just looks stupid.** During V5 development the steering oscillation described in
 * `navigation.ts` was invisible from behaviour alone — the tank simply "did not seem to be going
 * anywhere" — and only a destination-versus-position readout made the cause obvious in seconds.
 *
 * Exposed as a plain data record so the client can render it without the core knowing anything about
 * rendering, and so a test can assert on *why* a decision was made rather than only that one was.
 */
export interface EnemyDiagnostics {
  /** What the opponent is currently trying to do. */
  readonly intent: EngagementIntent;
  /** Human-readable reason for that intent. The single most useful line when debugging. */
  readonly reason: string;
  /** The armour region currently being aimed at, or `null` when no shot is available. */
  readonly targetRegion: string | null;
  /** Predicted penetration margin on the chosen shot, mm. Negative means the armour wins. */
  readonly predictedMarginMm: number;
  /** Best margin available among visible plates, even when it is negative. `-Infinity` when blind. */
  readonly bestVisibleMarginMm: number;
  /** The thinnest plate currently visible, which is what the flank planner steers toward. */
  readonly weakestVisibleRegion: string | null;
  /** Where the opponent is driving, or `null` when it is holding position. */
  readonly destination: Vec3 | null;
  /** Which flank side is committed, or `0` when not flanking. */
  readonly flankSide: 1 | -1 | 0;
  /** Consecutive non-penetrating shots recorded. */
  readonly ineffectiveStreak: number;
  /** True when the opponent currently sees the player. */
  readonly hasLineOfSight: boolean;
  /** True when the steering layer has detected impassable ground ahead. */
  readonly avoiding: boolean;
  /** Range to the player, metres. */
  readonly rangeM: number;
  /** Shots the opponent has observed the result of this battle. */
  readonly shotsObserved: number;
  /** How many of those got through. */
  readonly penetrations: number;
}


/**
 * Drives one enemy tank.
 *
 * Constructed with the tanks it fights and the terrain they fight over, then asked for an input once
 * per tick. It holds no reference to the simulation, the renderer, or the damage model — only to two
 * `Tank` objects and a `Terrain`.
 *
 * ## Determinism
 *
 * Every random choice comes from a seeded `Rng`, never `Math.random` (ADR-0005), so a given seed
 * replays an encounter exactly. That is what turns "the AI does something odd" into a bug report with
 * a number attached to it.
 */
export class EnemyController {
  private readonly enemy: Tank;
  private readonly player: Tank;
  private readonly terrain: Terrain;
  private readonly rng: Rng;

  /** What the opponent remembers about the fight. Cleared on restart. */
  private readonly memory: EngagementMemory;

  /** Anti-oscillation state for the steering layer. Cleared on restart. */
  private steering: SteeringMemory = createSteeringMemory();

  /** Where the player was last seen, or `null`. */
  private lastKnownPosition: Vec3 | null = null;
  /** Ticks since the player was last visible. */
  private ticksSinceSeen = 0;
  /** True when the player has been seen at least once this battle. */
  private hasEverSeenPlayer = false;

  /**
   * The flank side this battle opens from, drawn once from the seed.
   *
   * Fixed for the whole battle so the opening is consistent, but different between seeds so two fights
   * do not open identically. This is the main "several fights are not identical" lever, and it varies
   * *which approach is taken* without varying whether the approach is a good one.
   */
  private readonly preferredFlankSide: 1 | -1;

  /** Where the current flank is driving, or `null` when not flanking. */
  private flankDestination: Vec3 | null = null;

  /** Distance to the player at the last tick, metres. Read by tests and the HUD. */
  lastRangeM = Number.POSITIVE_INFINITY;

  /** True when the player was visible at the last tick. */
  lastSawPlayer = false;

  /** Diagnostics from the last tick, for the debug overlay and for tests. */
  diagnostics: EnemyDiagnostics = emptyDiagnostics();

  /**
   * @param seed RNG seed for the opponent's aim scatter and flank preference. Exposed so a test can
   *   reproduce a specific encounter exactly, and so the encounter's randomness is never ambient.
   */
  constructor(enemy: Tank, player: Tank, terrain: Terrain, seed = ENEMY_DEFAULT_SEED) {
    this.enemy = enemy;
    this.player = player;
    this.terrain = terrain;

    // The opponent's own generator, never a shared global, so its consumption of random numbers cannot
    // change the player's or the terrain's results (ADR-0005).
    this.rng = new Rng(seed);

    this.preferredFlankSide = this.rng.chance(0.5) ? 1 : -1;
    this.memory = createEngagementMemory(this.preferredFlankSide);
  }

  /**
   * Clears everything the controller remembers.
   *
   * Called on restart. Without this a new encounter would begin holding the previous battle's shot
   * history — including a full "three ineffective shots" streak — so it would open by immediately
   * flanking. That is exactly the stale state that makes a restart feel broken.
   *
   * The RNG is deliberately **not** reseeded, so the random stream continues and an encounter stays
   * reproducible from construction alone rather than from the moment of the restart.
   */
  restart(): void {
    const fresh = createEngagementMemory(this.preferredFlankSide);
    this.memory.ineffectiveStreak = fresh.ineffectiveStreak;
    this.memory.shotsObserved = fresh.shotsObserved;
    this.memory.penetrations = fresh.penetrations;
    this.memory.flankSide = fresh.flankSide;
    this.memory.flankTicks = fresh.flankTicks;
    this.memory.acquisitionTicksRemaining = fresh.acquisitionTicksRemaining;
    this.memory.flankRethinkTicks = fresh.flankRethinkTicks;
    this.memory.flankDestination = fresh.flankDestination;
    this.memory.probeStreak = fresh.probeStreak;

    this.steering = createSteeringMemory();
    this.lastKnownPosition = null;
    this.ticksSinceSeen = 0;
    this.hasEverSeenPlayer = false;
    this.flankDestination = null;
    this.lastRangeM = Number.POSITIVE_INFINITY;
    this.lastSawPlayer = false;
    this.diagnostics = emptyDiagnostics();
  }

  /**
   * Reports the outcome of a shot this opponent fired at the player.
   *
   * ## The narrowness of this channel is the point
   *
   * The controller is told **only whether a shell penetrated**. It is not told how much damage it did,
   * what the player's hit points are, or whether the player's modules are damaged. It therefore cannot
   * infer the player's remaining strength, cannot choose to focus fire based on what it has already
   * achieved, and cannot cheat its way to a kill.
   *
   * That is enough to solve the problem V4 had. "My shots are bouncing" is information a gunner can
   * plainly observe — sparks off the plate, the distinctive report — and it is all the opponent needs
   * to know that its angle is wrong.
   *
   * Called by the simulation once per tick, once per shell this vehicle fired that struck the player.
   *
   * @param penetrated whether the shell got through the player's armour
   */
  observeCombat(penetrated: boolean): void {
    recordShot(this.memory, penetrated);
  }


  /**
   * Produces this tick's `InputCommand` for the opponent.
   *
   * The pipeline, in order, is **sense → assess → decide → act**. Each stage lives in its own module,
   * so a wrong decision can be attributed to a specific stage rather than to "the AI".
   *
   * @param dtSeconds the tick length, so timing-based behaviour is frame-rate independent. Line of
   *   sight is measured internally, from the same terrain the simulation measures it from, so the
   *   opponent's behaviour and the HUD's spotted indicator can never disagree.
   */
  think(dtSeconds: number): InputCommand {
    const destroyed = this.enemy.damage.destroyed;
    const gunDisabled = this.enemy.telemetry.gunDisabled;
    const immobilised = this.enemy.telemetry.immobilised;

    // --- Sense -------------------------------------------------------------------------------
    const eye = this.enemyAimEye();
    const playerCentre = this.playerAimPoint();
    const rangeM = distance(eye, playerCentre);
    this.lastRangeM = rangeM;

    const canSeePlayer = this.terrain.hasLineOfSight(eye, playerCentre);
    this.lastSawPlayer = canSeePlayer;

    if (canSeePlayer) {
      // The acquisition grace period is armed by the planner, which owns that policy and sets it only
      // on the *first* sighting. Deliberately not re-armed here on re-acquisition: a player ducking
      // behind cover must not reset the opponent's aim, or it could never fire at all.
      this.lastKnownPosition = playerCentre;
      this.ticksSinceSeen = 0;
      this.hasEverSeenPlayer = true;
    } else {
      this.ticksSinceSeen += 1;
    }

    // --- Assess ------------------------------------------------------------------------------
    // Every plate is assessed against real line of sight and the real penetration model. This is what
    // turns "shoot at the tank" into "shoot at the thinnest thing I can see, if it will work".
    const assessments = this.assessTargetPlates(eye, canSeePlayer);
    const bestShot = canSeePlayer ? bestPredictedShot(assessments) : null;

    // --- Decide ------------------------------------------------------------------------------
    const decision = chooseIntent(
      {
        canSeePlayer,
        rangeM,
        position: this.enemy.state.position,
        bestShot,
        gunDisabled,
        immobilised,
        destroyed,
        hasEverSeenPlayer: this.hasEverSeenPlayer,
      },
      this.memory,
    );
    this.memory.flankDestination = this.flankDestination;

    // --- Act ---------------------------------------------------------------------------------
    const movement = this.chooseMovement(decision.intent, rangeM, canSeePlayer, dtSeconds);
    const aimPoint = this.chooseAimPoint(decision.intent, bestShot, canSeePlayer, rangeM);
    const fire = this.chooseFire(decision.intent, bestShot, rangeM, dtSeconds);

    this.updateDiagnostics(decision, bestShot, assessments, movement.avoiding, rangeM);

    return makeInput(movement.throttle, movement.turn, aimPoint, fire);
  }

  /**
   * Assesses every plate on the player as a target, from this tick's gun position.
   *
   * Visibility is tested **per plate**, not once for the vehicle. That distinction matters: a player
   * presenting a frontal plate with its engine deck just visible over a rise should be shot at the
   * engine, and a single vehicle-wide line-of-sight boolean cannot tell those situations apart. It is
   * also what stops the opponent reasoning about armour it cannot actually see.
   */
  private assessTargetPlates(eye: Vec3, vehicleVisible: boolean): PlateAssessment[] {
    const plates = this.playerPlates();
    const assessments: PlateAssessment[] = [];

    for (const plate of plates) {
      // Per-plate sight test from the gun to the plate itself, not to the hull centre. Fewer samples
      // and a smaller margin than the vehicle-wide test: this is asking "can I see this plate", and a
      // plate peeking over a rise should count as visible even when the hull behind it is not.
      const visible = vehicleVisible && this.terrain.hasLineOfSight(eye, plate.center, 16, 0.35);
      assessments.push(assessPlate(eye, plate, this.enemy.definition, visible));
    }
    return assessments;
  }

  /** The player's armour plates in world space, reflecting its current hull and turret headings. */
  private playerPlates() {
    return buildWorldPlates(
      this.player.definition,
      this.player.state.position,
      this.player.state.headingRad,
      this.player.state.headingRad + this.player.turretState.localAngleRad,
    );
  }


  /**
   * Converts the chosen intent into throttle and turn demands.
   *
   * Every intent maps to a *destination*, and then a single steering function turns that destination
   * into driving commands. That indirection is deliberate: the tactical layer never has to know
   * anything about slopes or obstacles, and the navigation layer never has to know anything about
   * armour. Adding a new intent means choosing a destination, not writing a new driving routine.
   */
  private chooseMovement(
    intent: EngagementIntent,
    rangeM: number,
    canSeePlayer: boolean,
    dtSeconds: number,
  ): { throttle: number; turn: number; avoiding: boolean } {
    switch (intent) {
      case 'flank':
        return this.driveTo(this.updateFlankDestination(), dtSeconds);

      case 'search': {
        // Go to the last known position, then to the arena centre. Searching is the one behaviour that
        // must not require sight of the target, or the opponent would freeze precisely when it has lost
        // the player and most needs to go and look for them.
        const lostTicks = Math.round(ENEMY_TUNING.searchTimeoutSeconds * TICKS_PER_SECOND);
        const target =
          this.lastKnownPosition !== null && this.ticksSinceSeen <= lostTicks
            ? this.lastKnownPosition
            : ARENA_CENTRE;
        return this.driveTo(target, dtSeconds);
      }

      case 'adjust-range': {
        // Close or back off. Two different destinations, because "get further away" and "get closer"
        // are opposite actions and using one formula for both is how an opponent ends up driving
        // *toward* the player it is trying to escape.
        if (rangeM > ENEMY_TUNING.preferredRangeM) {
          return this.driveTo(this.playerAimPoint(), dtSeconds);
        }
        // Retreat directly away from the player, not along the hull's own heading. Steering along the
        // heading is tempting because it keeps the gun pointing sensibly, but it only opens the range
        // if the player happens to be behind — and by definition here they are in front, so it would
        // drive the opponent straight into them.
        const awayBearing = bearingRad(this.enemy.state.position, this.playerAimPoint()) + Math.PI;
        return this.driveTo(
          pointFrom(this.enemy.state.position, awayBearing, ENEMY_TUNING.preferredRangeM),
          dtSeconds,
        );
      }

      case 'withdraw':
        // Drive away toward open ground: nothing to shoot at on the way, and no corner to be trapped in.
        return this.driveTo(ARENA_CENTRE, dtSeconds);

      case 'hold-position':
      case 'probe':
      case 'engage': {
        // Hold a useful fighting station rather than driving at the player.
        //
        // This is where the flanks pay off. The planner picked a spot that opens the player's weak
        // armour, and once there the opponent must *stay* there: driving at the player would put its own
        // frontal plate into the exchange and undo the whole manoeuvre.
        if (canSeePlayer) {
          const station = this.holdStation(rangeM);
          if (station !== null) {
            return this.driveTo(station, dtSeconds, 0.35);
          }
        }
        // At the preferred range, so do not correct — but do not become a statue either.
        //
        // Measured during V5 development: with a hard zero throttle here, a player who simply drove
        // straight at the opponent could cross the whole engagement band without ever being fired at.
        // The reason is not the gun, it is the geometry: a *stationary* shooter has no parallax, so the
        // bearing to an approaching tank sweeps faster and faster and the turret's 24 deg/s cannot catch
        // it. Creeping forward keeps both vehicles moving, which is what keeps the bearing trackable
        // and the exchange two-sided.
        //
        // But **only when it has a shot**. A tank with nothing worth firing at has no reason to close,
        // and doing so anyway is worse than useless: measured against a parked player, creeping from
        // 55 m simply walked the opponent into its own minimum range within ~20 seconds, at which point
        // it retreated, reopened, and repeated — thrashing forever without ever holding the angle it had
        // driven out to take. Movement is earned by having a solution.
        return {
          throttle: intent === 'engage' ? ENGAGING_CREEP_THROTTLE : 0,
          turn: 0,
          avoiding: false,
        };
      }

      case 'disabled':
        return { throttle: 0, turn: 0, avoiding: false };
    }
  }

  /**
   * A point that would put the opponent at its preferred range, or `null` when it is already close enough.
   *
   * ## Why the point is measured along the *player's* bearing, not the hull's
   *
   * The obvious implementation — "a point N metres ahead of (or behind) my own hull" — is wrong, and
   * measurably so. Used to back off, it asks the tank to drive toward a point behind itself, so the
   * steering layer dutifully turns the hull through 180 degrees and drives there. Against a stationary
   * player the range then grew monotonically, 44 m to 103 m over about eighteen seconds, until the
   * opponent walked out of its own engagement band, lost line of sight, and began searching. It spent
   * the entire fight managing range and never once managed an angle.
   *
   * Measuring along the line between the two vehicles removes the problem entirely: "close the distance"
   * and "open the distance" become a single forward-or-reverse move that leaves the hull pointing where
   * it was, which is what keeps the turret able to track.
   *
   * @param rangeM current range to the player
   */
  private holdStation(rangeM: number): Vec3 | null {
    const error = rangeM - ENEMY_TUNING.preferredRangeM;
    if (Math.abs(error) < STATION_KEEP_TOLERANCE_M) {
      return null;
    }
    // Toward the player when too far, away when too close. Bounded so one correction never overshoots
    // into the far side of the band.
    const travel = error > 0 ? Math.min(error, 12) : -Math.min(-error, 12);
    return pointFrom(
      this.enemy.state.position,
      bearingRad(this.enemy.state.position, this.playerAimPoint()),
      travel,
    );
  }

  /**
   * Picks, refreshes, or abandons the current flank destination.
   *
   * Recomputed on a timer rather than every tick. Chasing a fresh destination each tick as the player
   * drives produces a tank that never commits to an approach — the destination always moves before the
   * opponent reaches it. Reconsidering every second and a half lets a flank actually complete while
   * still adapting to the player.
   */
  private updateFlankDestination(): Vec3 {
    const ticks = Math.round(ENGAGEMENT_TUNING.flankRethinkSeconds * TICKS_PER_SECOND);
    this.memory.flankRethinkTicks -= 1;

    if (this.flankDestination !== null && this.memory.flankRethinkTicks > 0) {
      return this.flankDestination;
    }

    const side = this.memory.flankSide === 0 ? this.preferredFlankSide : this.memory.flankSide;
    const choice = chooseFlankDestination(
      this.terrain,
      this.enemy.definition,
      this.enemy.state.position,
      this.player.state.position,
      this.player.state.headingRad,
      side,
      ENEMY_TUNING.preferredRangeM,
    );

    // No candidate at all (every point on the arc was off-arena). Fall back to driving at the player
    // rather than standing still: a smaller change of position beats none.
    this.flankDestination =
      choice?.position ??
      pointFrom(
        this.enemy.state.position,
        this.enemy.state.headingRad,
        ENEMY_TUNING.preferredRangeM,
      );

    this.memory.flankRethinkTicks = ticks;
    return this.flankDestination;
  }

  /** Drives toward a destination, with a reduced throttle authority for gentle station-keeping. */
  private driveTo(
    destination: Vec3,
    dtSeconds: number,
    throttleScale = 1,
  ): { throttle: number; turn: number; avoiding: boolean } {
    const decision = steerToward(
      this.terrain,
      this.enemy.definition,
      this.enemy.state.position,
      this.enemy.state.headingRad,
      destination,
      this.steering,
      dtSeconds,
      ENEMY_TUNING.hullTurnAuthority,
      ENEMY_TUNING.throttleAuthority * throttleScale,
    );
    return { throttle: decision.throttle, turn: decision.turn, avoiding: decision.avoiding };
  }


  /**
   * The world point the opponent's gun is trained on, or `null` to hold the current orientation.
   *
   * This is the field that makes the opponent obey the same aiming rules as the player: it names a
   * point and the turret's own servo — with the vehicle's real traverse rate and acceleration — does
   * the rest. The controller never sets a turret angle directly.
   *
   * Two deliberate design choices:
   *
   *  - **It aims at a chosen plate, not the hull centre.** That is the whole of the aim-point work in
   *    V5: `bestShot` names a specific region the maths says will work, and the gun goes there. The
   *    scatter below is then applied *around that point*, so the opponent is aiming at the player's
   *    exposed flank and missing by a metre or so, rather than aiming at the hull and hoping.
   *  - **The scatter is per shot, not a permanent offset.** It is drawn from the seeded RNG each tick,
   *    so the opponent has no fixed blind side a player could learn.
   */
  private chooseAimPoint(
    intent: EngagementIntent,
    bestShot: PlateAssessment | null,
    canSeePlayer: boolean,
    rangeM: number,
  ): Vec3 | null {
    // Out of the engagement band it does not even try to aim, so it turns and drives first and settles
    // the gun once it is somewhere worth shooting from.
    if (rangeM > ENEMY_TUNING.maxEngageRangeM || rangeM < ENEMY_TUNING.minEngageRangeM) {
      return null;
    }

    // Flanking, searching and repositioning have no plate to shoot at: the opponent is driving, and
    // slewing the gun onto a target it is not going to shoot from would only waste traverse.
    if (
      intent === 'flank' ||
      intent === 'search' ||
      intent === 'adjust-range' ||
      intent === 'withdraw'
    ) {
      return canSeePlayer ? this.playerAimPoint() : null;
    }

    const base = bestShot === null ? this.playerAimPoint() : this.plateAimPoint(bestShot);
    // Scatter is applied only when the gun is genuinely on target, not continuously. See
    // `applyAimScatter` for why that distinction turned out to matter.
    const onTarget = this.gunBearingErrorDeg(base) <= ENEMY_TUNING.fireBearingToleranceDeg;
    return onTarget ? this.applyAimScatter(base) : base;
  }

  /**
   * How far the gun is from a world point in bearing, degrees.
   *
   * Factored out because both the aim point and the fire decision need the same measurement, and the
   * two must not drift apart: if the gun were judged on-target for firing but the aim point were chosen
   * by a different rule, the opponent would shoot at wherever its barrel happened to be pointing.
   */
  private gunBearingErrorDeg(aimAt: Vec3): number {
    const bearingToTarget = bearingRad(this.enemy.state.position, aimAt);
    const gunBearing = this.enemy.turretState.localAngleRad + this.enemy.state.headingRad;
    return Math.abs(radToDeg(wrapAngle(bearingToTarget - gunBearing)));
  }

  /**
   * The world point corresponding to an assessed plate.
   *
   * Recomputed from the assessment's plate id rather than reusing the point the assessment measured,
   * because the player's turret may have moved between the assessment and the aim request. Re-deriving
   * keeps the aim point and the plate the shot was predicted against describing the same surface.
   */
  private plateAimPoint(assessment: PlateAssessment): Vec3 {
    const match = this.playerPlates().find((plate) => plate.definition.id === assessment.plateId);
    // The plate cannot vanish between assessment and aim, so this is unreachable in practice; falling
    // back to the hull centre keeps the function total rather than throwing mid-tick.
    return match?.center ?? this.playerAimPoint();
  }

  /**
   * Displaces an aim point by a random amount inside the aim-error cone.
   *
   * ## Why this is applied at the moment of firing and not every tick
   *
   * Re-rolling the scatter on every tick — which is what V4 did — is wrong once the turret actually has
   * to *reach* the aim point, and the failure it causes is subtle enough to be worth recording.
   *
   * The aim point is a world position, and the turret servos toward it at a finite rate. If the point
   * itself jitters by up to the full error cone every tick, the turret is not tracking the player; it is
   * chasing a target that teleports around it. It therefore never converges, and since the fire gate
   * requires the gun to be on target, the opponent **never fires at all**.
   *
   * Measured during V5 development: the opponent tracked a charging player from 50 m to 28 m, slewing its
   * turret 0 to 34 degrees, and fired zero shells in the entire engagement. It looked like a targeting
   * problem and was really a convergence problem.
   *
   * Applying the scatter only once the gun is already on target fixes it and is also the more faithful
   * model: the gunner steadies on the target, then the shot goes where it goes. The error is applied to
   * the shell's actual flight, so a scattered shot still misses for real reasons — real drop, real
   * travel time — exactly as a player's miss does.
   */
  private applyAimScatter(aimAt: Vec3): Vec3 {
    // Scattered in the horizontal plane only: a vertical component would mostly produce shots sailing over
    // or under the hull at these ranges, which reads as the opponent missing for no reason.
    const scatterRad = (ENEMY_TUNING.aimErrorDeg * Math.PI) / 180;
    const scatterAngle = this.rng.range(0, Math.PI * 2);
    const scatterRadius = scatterRad * Math.sqrt(this.rng.nextFloat());

    const dx = aimAt.x - this.enemy.state.position.x;
    const dz = aimAt.z - this.enemy.state.position.z;
    const planarDistance = Math.sqrt(dx * dx + dz * dz);
    const scale = planarDistance > 0.001 ? (scatterRadius * planarDistance) / scatterRad : 0;

    return vec3(
      aimAt.x + cos(scatterAngle) * scale,
      aimAt.y,
      aimAt.z + sin(scatterAngle) * scale,
    );
  }


  /**
   * Whether to request a shot this tick.
   *
   * Every condition here is a *permission*, not an outcome. The gun can still refuse, because `tryFire`
   * is the only thing that actually fires and it checks the reload timer itself.
   *
   * Conditions, in the order they matter:
   *  1. there must be a **predicted shot worth taking**, or the intent must be a deliberate `probe`.
   *     This is the V5 change: the opponent no longer fires merely because the player is in front of it.
   *     If the maths says every visible plate will stop the shell, it stops wasting five-second reloads
   *     on them and repositions instead — which is what makes presenting strong frontal armour a losing
   *     plan rather than a permanent one.
   *  2. the **intent** must be one that involves fighting from where it is; a flanking opponent saves
   *     its reload for the shot it is driving into position for;
   *  3. the range must be worth a shot;
   *  4. the gun must be **loaded**, checked here as well as in the core so the opponent does not spam
   *     a fire request it knows will be refused;
   *  5. the **turret must actually be on target**, within `fireBearingToleranceDeg`;
   *  6. the acquisition grace period must have elapsed.
   */
  private chooseFire(
    intent: EngagementIntent,
    bestShot: PlateAssessment | null,
    rangeM: number,
    dtSeconds: number,
  ): boolean {
    const probing = intent === 'probe';

    if (intent !== 'engage' && intent !== 'hold-position' && !probing) {
      return false;
    }
    // The line that makes frontal armour a losing plan rather than a wall. A probe is the single
    // exception, and it is a bounded one: the planner only asks for it while it still has no evidence,
    // and one shot is enough to get some.
    if (bestShot === null && !probing) {
      return false;
    }
    if (rangeM < ENEMY_TUNING.minEngageRangeM || rangeM > ENEMY_TUNING.maxEngageRangeM) {
      return false;
    }
    if (this.enemy.gunState.loadState !== 'loaded') {
      return false;
    }

    if (this.memory.acquisitionTicksRemaining > 0) {
      this.memory.acquisitionTicksRemaining -= Math.max(1, Math.round(dtSeconds * TICKS_PER_SECOND));
      return false;
    }

    const aimAt = bestShot === null ? this.playerAimPoint() : this.plateAimPoint(bestShot);
    return this.gunBearingErrorDeg(aimAt) <= ENEMY_TUNING.fireBearingToleranceDeg;
  }

  /**
   * The opponent's gun pivot in world space — the point its line of sight is measured from.
   *
   * Uses the real trunnion height from the vehicle definition, so on sloping ground the opponent sees
   * over low cover exactly as far as its gun physically could.
   */
  private enemyAimEye(): Vec3 {
    const p = this.enemy.state.position;
    return vec3(p.x, p.y + this.enemy.definition.turret.ringHeightM, p.z);
  }

  /**
   * A generic point on the player's hull: half the hull height up from the floor.
   *
   * Used as a fallback aim point and as a search target, never as the preferred aim point when a
   * specific plate has been identified.
   */
  private playerAimPoint(): Vec3 {
    const p = this.player.state.position;
    return vec3(p.x, p.y + this.player.definition.dimensions.heightM * 0.5, p.z);
  }

  /** Publishes this tick's reasoning for the debug overlay and for tests. */
  private updateDiagnostics(
    decision: { intent: EngagementIntent; reason: string },
    bestShot: PlateAssessment | null,
    assessments: readonly PlateAssessment[],
    avoiding: boolean,
    rangeM: number,
  ): void {
    const weakest = weakestVisibleRegion(assessments);
    this.diagnostics = {
      intent: decision.intent,
      reason: decision.reason,
      targetRegion: bestShot?.region ?? null,
      predictedMarginMm: bestShot?.marginMm ?? Number.NEGATIVE_INFINITY,
      bestVisibleMarginMm: bestVisibleMarginMm(assessments),
      weakestVisibleRegion: weakest?.region ?? null,
      destination: this.flankDestination,
      flankSide: this.memory.flankSide,
      ineffectiveStreak: this.memory.ineffectiveStreak,
      hasLineOfSight: this.lastSawPlayer,
      avoiding,
      rangeM,
      shotsObserved: this.memory.shotsObserved,
      penetrations: this.memory.penetrations,
    };
  }
}

/** The centre of the arena, used as a last-resort place to search or withdraw to. */
const ARENA_CENTRE: Vec3 = { x: 0, y: 0, z: 0 };

/** A blank diagnostics record, used before the first tick and after a restart. */
function emptyDiagnostics(): EnemyDiagnostics {
  return {
    intent: 'search',
    reason: 'not yet started',
    targetRegion: null,
    predictedMarginMm: Number.NEGATIVE_INFINITY,
    bestVisibleMarginMm: Number.NEGATIVE_INFINITY,
    weakestVisibleRegion: null,
    destination: null,
    flankSide: 0,
    ineffectiveStreak: 0,
    hasLineOfSight: false,
    avoiding: false,
    rangeM: Number.POSITIVE_INFINITY,
    shotsObserved: 0,
    penetrations: 0,
  };
}

/** A point at a given bearing and distance from an origin. */
function pointFrom(from: Vec3, bearing: number, distanceM: number): Vec3 {
  return vec3(from.x + sin(bearing) * distanceM, from.y, from.z + cos(bearing) * distanceM);
}

/** Euclidean distance between two points. */
function distance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Compass bearing from one ground point to another, radians, in the vehicle heading frame.
 *
 * The core's own deterministic `atan2` (ADR-0005), with the world axes mapped into the vehicle's
 * heading frame: +Z is a bearing of zero and +X is +90 degrees.
 */
function bearingRad(from: Vec3, to: Vec3): number {
  return atan2(to.x - from.x, to.z - from.z);
}

