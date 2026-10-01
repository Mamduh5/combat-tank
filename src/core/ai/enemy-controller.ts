import { makeInput, type InputCommand } from '../../shared/input.js';
import { atan2, cos, sin, vec3, type Vec3, wrapAngle } from '../math/index.js';
import { Rng } from '../rng/index.js';
import type { Terrain } from '../world/terrain.js';
import type { Tank } from '../vehicle/tank.js';

/**
 * The V4 opponent's brain: one focused state machine, no general AI framework.
 *
 * ## The single most important property
 *
 * This controller **does not damage anything**. It produces an `InputCommand` — the exact same struct
 * the keyboard produces — and the enemy `Tank` is stepped with it through the same `step` call the
 * player's is. Every rule therefore applies to the opponent identically: its turret servos at the
 * vehicle's own rate, its gun obeys its own reload timer, its shells obey the same ballistics, and
 * its hits go through the same penetration and damage model as the player's.
 *
 * That is the difference between "an enemy that is dangerous" and "an enemy that is a damage timer".
 * The owner asked explicitly not to have the opponent call `takeDamage()` on a schedule, and this is
 * the structure that makes that structurally impossible rather than merely discouraged: there is no
 * path from this file to the damage model.
 *
 * ## Scope boundary — this is deliberately not V5 AI
 *
 * Four states, no planner, no memory beyond "where was the player last seen", no pathfinding graph, no
 * flanking solver, no cover scoring. Each state is a direct, readable policy. Sophisticated
 * autonomous AI is explicitly deferred; building the framework now would be building for versions
 * that have not specified what they need. See `docs/open-decisions.md` OD-08.
 *
 * ## Why it is deterministic
 *
 * Every random choice comes from a seeded `Rng`, never `Math.random` (ADR-0005). A seeded encounter
 * replays identically, which is what makes an AI behaviour bug reproducible instead of "it only
 * happens sometimes".
 */

/** Default seed for the opponent's aim scatter. Chosen once, recorded, and not varied per battle. */
const ENEMY_DEFAULT_SEED = 0x5eed1a4b;

/** What the opponent is currently doing. Exposed for diagnostics, tests and the HUD. */
export type EnemyState =
  /** No usable sight of the player: drive toward their last known position and look for them. */
  | 'searching'
  /** Visible but too far to fight well: close the distance. */
  | 'closing'
  /** Visible and in a sensible band: hold roughly still, aim, and shoot when lined up. */
  | 'engaging'
  /** Visible, but the hull is badly placed to present armour: pivot to a better facing. */
  | 'repositioning'
  /** Destroyed or immobilised: nothing. */
  | 'disabled';

/** Tuning for the opponent's behaviour. Prototype encounter values, not balance. */
export const ENEMY_TUNING = {
  /**
   * Distance band the opponent tries to fight at, metres.
   *
   * Below `nearRangeM` it backs off, because at point-blank neither vehicle can present its armour
   * and the duel degenerates into who reloads faster. Above `farRangeM` it closes, because its gun is
   * long and its reload is slow and it wants the shot to count.
   *
   * These were originally 42 / 22 / 78 with a firing floor of 14 m, and measurement showed the band
   * fighting itself: the opponent drove to 12.8 m, which was *inside* its own no-fire zone, so it
   * closed the distance and then declined to shoot from it. In a 15-second engagement it fired once.
   * The firing floor is now inside the movement band, so wherever the opponent drives to is somewhere
   * it is willing to engage from.
   */
  idealRangeM: 55,
  nearRangeM: 32,
  farRangeM: 90,

  /**
   * Closest range it will shoot from, metres.
   *
   * Deliberately **inside** `nearRangeM`, so backing off to respect the band does not also silence
   * the gun. A shot at 25 m is a perfectly reasonable shot; refusing it was an artifact of two
   * thresholds disagreeing, not a design intention.
   */
  minEngageRangeM: 24,
  /** Beyond this it will not fire at all, because the shot would be a long gamble. */
  maxEngageRangeM: 130,

  /**
   * Aim error cone, degrees. The opponent aims at a point jittered within this cone of the player.
   *
   * This is the single knob that decides whether the encounter feels fair. At zero the opponent is a
   * perfect shot and the player dies to a coin flip; at large values it cannot land anything and the
   * fight is trivial. 1.6 degrees is roughly a third of the hull's width at 40 m, so most shots land
   * on the vehicle and some meet armour that stops them. It is applied per shot from the seeded RNG,
   * so it is scatter rather than a permanent aim offset — the opponent has no persistent blind side.
   */
  aimErrorDeg: 1.6,

  /**
   * Fraction of a full turn demand used to steer the hull. Below 1.0 so the opponent turns with
   * visible weight rather than snapping onto its aim bearing.
   */
  hullTurnAuthority: 0.85,
  /** Fraction of full throttle. Deliberately not 1.0, so the opponent accelerates like a heavy tank. */
  throttleAuthority: 0.9,

  /**
   * Turret bearing tolerance, degrees. It fires only once its gun is within this of the player's
   * bearing, so shots are deliberate rather than sprayed while the turret slews.
   */
  fireBearingToleranceDeg: 1.8,

  /**
   * Extra seconds it waits after acquiring the player before the first shot.
   *
   * Without this the opponent fires the instant it comes into line of sight, and the player loses a
   * duel they had not started yet. It also models a real crew coming to the guns.
   *
   * Long enough to be a grace period, short enough that it is not the encounter. The first version was
   * 2.2 s and the opponent's first shot arrived at tick 750 of a 900-tick run — because most of that
   * was spent driving, not waiting, which is why the movement band was the thing to fix.
   */
  acquisitionDelaySeconds: 1.5,

  /**
   * Seconds it keeps searching for a player it has lost before giving up and driving to the arena
   * centre to look for them.
   */
  searchTimeoutSeconds: 6,

  /**
   * How long it keeps repositioning on a bearing before reconsidering, seconds. Bounds how long it
   * will spend turning purely for armour reasons.
   */
  repositionPatienceSeconds: 3.5,

  /** How close it drives to the last known player position before declaring the search over, metres. */
  searchArrivalRadiusM: 12,

  /**
   * How far off the direct bearing the opponent tries to stand, degrees.
   *
   * The single most important number in this controller, and it came from a measurement that failed.
   *
   * With the opponent pointing its hull straight at the player, the fight could not happen: the player's
   * frontal plate is pitched 60 degrees, so its effective thickness against a head-on shot is far beyond
   * the shell's 150 mm of penetration. Measured over 30 seconds of simulated combat, a stationary player
   * lost **zero** hit points however many shells the opponent fired. The enemy shot the player in the
   * face repeatedly and could not hurt it.
   *
   * Standing off to one side solves it from both ends at once: the opponent presents its flank to the
   * player's gun *and* opens the player's flank to its own. Both armour layouts then matter, and both
   * vehicles have to keep moving to hold the angle — which is the fight the version is for.
   *
   * Deliberately not a flanking *strategy*: it is one preferred bearing, held by steering the hull
   * toward it. No path planning, no evaluation of which side is better, no awareness that it is doing
   * this deliberately.
   */
  engagementBearingOffsetDeg: 58,

  /**
   * How long the opponent holds one orbit direction before considering the other.
   *
   * Swung periodically rather than held forever, so the fight drifts around the player instead of
   * settling into a fixed circle — and, more usefully, so the enemy does not always end up on the same
   * side, which would let a player learn one approach and reuse it forever.
   */
  orbitSwitchSeconds: 7,
} as const;

/** Mutable per-encounter controller state. Cleared by `restart`, never accumulated across battles. */
interface EnemyMemory {
  /** Where the player was last seen, or `null` if never seen. */
  lastKnownPosition: Vec3 | null;
  /** Ticks since the player was last visible. Large means lost. */
  ticksSinceSeen: number;
  /** Ticks remaining before the opponent is willing to shoot after acquiring the player. */
  acquisitionTicksRemaining: number;
  /** Ticks spent repositioning, used to bound that behaviour. */
  repositionTicks: number;
  /** True when the player has been seen at least once this battle. */
  hasEverSeenPlayer: boolean;
  /** Which way round the player the opponent is currently trying to stand: +1 or -1. */
  orbitDirection: 1 | -1;
}

/** Ticks in one second, for converting the second-denominated tuning above. */
const TICKS_PER_SECOND = 60;

/**
 * Drives one enemy tank.
 *
 * Constructed with the tanks it fights and the terrain they fight over, then asked for an input once
 * per tick. It holds no gameplay authority of its own.
 */
export class EnemyController {
  /** Current state, for diagnostics and tests. */
  state: EnemyState = 'searching';

  private readonly enemy: Tank;
  private readonly player: Tank;
  /** The terrain both vehicles drive over, used for the line-of-sight test. */
  private readonly terrain: Terrain;
  private readonly rng: Rng;
  private readonly memory: EnemyMemory = {
    lastKnownPosition: null,
    ticksSinceSeen: 0,
    acquisitionTicksRemaining: 0,
    repositionTicks: 0,
    hasEverSeenPlayer: false,
    orbitDirection: 1,
  };

  /** Distance to the player at the last tick, metres. Read by tests and the HUD. */
  lastRangeM = Number.POSITIVE_INFINITY;

  /** True when the player was visible at the last tick. */
  lastSawPlayer = false;

  /**
   * @param seed RNG seed for the opponent's aim scatter. Exposed so a test can reproduce a specific
   *   encounter exactly, and so the encounter's randomness is never ambient.
   */
  constructor(enemy: Tank, player: Tank, terrain: Terrain, seed = ENEMY_DEFAULT_SEED) {
    this.enemy = enemy;
    this.player = player;
    this.terrain = terrain;
    // The opponent's own generator, never a shared global, so its consumption of random numbers
    // cannot change the player's or the terrain's results (ADR-0005).
    this.rng = new Rng(seed);
  }

  /**
   * Clears everything the controller remembers.
   *
   * Called on restart. Without this a new encounter would begin holding the previous battle's last
   * known player position, which is exactly the stale state that makes a restart feel broken.
   */
  restart(): void {
    this.memory.lastKnownPosition = null;
    this.memory.ticksSinceSeen = 0;
    this.memory.acquisitionTicksRemaining = 0;
    this.memory.repositionTicks = 0;
    this.memory.hasEverSeenPlayer = false;
    this.memory.orbitDirection = 1;
    this.state = 'searching';
    this.lastRangeM = Number.POSITIVE_INFINITY;
    this.lastSawPlayer = false;
  }

  /**
   * Produces this tick's `InputCommand` for the opponent.
   *
   * @param dtSeconds the tick length, so timing-based behaviour is frame-rate independent. Line of
   *   sight is measured internally, from the same terrain the simulation measures it from, so the
   *   opponent's behaviour and the HUD's spotted indicator can never disagree.
   */
  think(dtSeconds: number): InputCommand {
    // A destroyed or immobilised opponent does nothing. It is still stepped by the simulation with
    // this neutral command, so it settles onto the ground as a wreck rather than hanging in the air,
    // but it expresses no intent.
    if (this.enemy.damage.destroyed || !this.canOperate()) {
      this.state = 'disabled';
      this.memory.ticksSinceSeen += 1;
      return makeInput(0, 0, null, false);
    }

    const eye = this.enemyAimEye();
    const playerCentre = this.playerAimPoint();
    const rangeM = distance(eye, playerCentre);
    this.lastRangeM = rangeM;

    const canSeePlayer = this.canSeePlayerNow();
    this.lastSawPlayer = canSeePlayer;

    if (canSeePlayer) {
      // A newly acquired player starts the acquisition delay. Re-acquiring a player who was merely
      // briefly lost does *not* restart it, or a player ducking behind cover would reset the
      // opponent's aim and it could never fire at all.
      if (!this.memory.hasEverSeenPlayer) {
        this.memory.acquisitionTicksRemaining = Math.round(
          ENEMY_TUNING.acquisitionDelaySeconds * TICKS_PER_SECOND,
        );
      }
      this.memory.lastKnownPosition = playerCentre;
      this.memory.ticksSinceSeen = 0;
      this.memory.hasEverSeenPlayer = true;
    } else {
      this.memory.ticksSinceSeen += 1;
    }

    this.memory.repositionTicks += 1;

    // Swing which side it circles to, on a slow timer. Ticks are counted rather than timed so the
    // behaviour is identical at any frame rate (ADR-0005).
    const orbitTicks = Math.round(ENEMY_TUNING.orbitSwitchSeconds * TICKS_PER_SECOND);
    if (this.memory.repositionTicks % orbitTicks === 0) {
      this.memory.orbitDirection = this.memory.orbitDirection === 1 ? -1 : 1;
    }

    const throttle = this.chooseThrottle(rangeM);
    const turn = this.chooseTurn(canSeePlayer);
    const aimPoint = this.chooseAimPoint(canSeePlayer, rangeM);
    const fire = this.chooseFire(canSeePlayer, rangeM, dtSeconds);

    this.updateState(canSeePlayer, rangeM);

    return makeInput(throttle, turn, aimPoint, fire);
  }

  /**
   * Whether the opponent can still drive and shoot.
   *
   * Checked separately from `damage.destroyed` so a crippled tank reports a distinct `disabled`
   * state — "wrecked" and "immobilised but still shooting" are different things to the player.
   */
  private canOperate(): boolean {
    return !this.enemy.telemetry.immobilised && !this.enemy.telemetry.gunDisabled;
  }

  /**
   * Forward/backward demand for this tick.
   *
   * Deliberately simple and readable rather than clever: close when too far, back off when too close,
   * otherwise hold station. Holding station means a small throttle rather than exactly zero, because a
   * tank with the throttle at zero on a slope rolls, and an opponent that drifts downhill while
   * "holding" looks broken. This value just fights the slope.
   */
  private chooseThrottle(rangeM: number): number {
    const authority = ENEMY_TUNING.throttleAuthority;

    if (!this.lastSawPlayer && this.memory.lastKnownPosition === null) {
      // Nothing known at all: drive toward the arena centre, which is where the encounter is
      // designed to happen and therefore the best place to start looking.
      return authority * 0.6;
    }

    if (this.lastSawPlayer || this.memory.lastKnownPosition !== null) {
      if (rangeM > ENEMY_TUNING.farRangeM) {
        return authority;
      }
      if (rangeM < ENEMY_TUNING.nearRangeM) {
        return -authority * 0.8;
      }
    }

    // In the band: creep forward a little so the opponent keeps pressing rather than parking. Slow
    // enough to still be shooting from a near-stop, which is the posture its reload cycle suits.
    return authority * 0.25;
  }

  /**
   * Hull turn demand.
   *
   * With a visible player it turns the hull toward them, but only when the bearing error is large
   * enough to be worth the manoeuvre. That threshold is the difference between an opponent that
   * constantly rotates (and so never presents a stable flank) and one that settles into a facing and
   * fights from it — which is what makes flanking it a viable strategy.
   *
   * Without a sighting it turns toward the last known position, or the centre when it has none.
   */
  private chooseTurn(canSeePlayer: boolean): number {
    const target = this.steeringTarget(canSeePlayer);
    if (target === null) {
      return 0;
    }

    // With a visible player, steer toward a bearing *offset* from the direct line rather than the line
    // itself. This is what makes the opponent a real combatant rather than a stationary gun: it circles
    // to present a flank, and in doing so presents the player's flank to its own gun.
    //
    // Swapped periodically so it does not settle into one predictable side.
    const offsetRad =
      (ENEMY_TUNING.engagementBearingOffsetDeg * Math.PI) / 180 * this.memory.orbitDirection;
    const bearingToTarget =
      bearingRad(this.enemy.state.position, target) + (canSeePlayer ? offsetRad : 0);
    const errorRad = wrapAngle(bearingToTarget - this.enemy.state.headingRad);
    const errorDeg = errorRad * (180 / Math.PI);

    // Inside this, the hull is already usefully pointed and turning would only spoil the shot.
    const settleToleranceDeg = 12;

    if (Math.abs(errorDeg) < settleToleranceDeg) {
      return 0;
    }

    return Math.sign(errorDeg) * ENEMY_TUNING.hullTurnAuthority;
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
   *  - **The aim point is scattered** by the seeded RNG within `aimErrorDeg`, re-rolled per shot. This
   *    is the opponent's "skill" knob, and it is applied at the aim point rather than by editing the
   *    penetration result, so a scattered shot that misses does so because the *shell* missed, with
   *    real drop and travel time, exactly as a player's miss does.
   *  - **It aims at the hull's mid-height**, which is the largest target and so the most honest
   *    approximation of "aiming at the tank" available without a model of weak points.
   */
  private chooseAimPoint(canSeePlayer: boolean, rangeM: number): Vec3 | null {
    const aimAt = canSeePlayer ? this.playerAimPoint() : this.memory.lastKnownPosition;
    if (aimAt === null) {
      return null;
    }

    // Out of the engagement band the opponent does not even try to aim, so it turns and drives first
    // and settles the gun once it is in a position worth shooting from.
    if (rangeM > ENEMY_TUNING.maxEngageRangeM || rangeM < ENEMY_TUNING.minEngageRangeM) {
      return null;
    }

    // Scattered in the horizontal plane only. A vertical component would mostly produce shots that
    // sail over or under the hull at these ranges, which reads as the opponent missing for no reason.
    const scatterRad = (ENEMY_TUNING.aimErrorDeg * Math.PI) / 180;
    const scatterAngle = this.rng.range(0, Math.PI * 2);
    const scatterRadius = scatterRad * Math.sqrt(this.rng.nextFloat());

    // Convert the angular scatter into a world offset at the target's range, so the same angular
    // tolerance means the same *physical* accuracy at every distance, as a real gunner's does.
    const dx = (aimAt.x - this.enemy.state.position.x);
    const dz = (aimAt.z - this.enemy.state.position.z);
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
   * Every condition here is a *permission*, not an outcome. The gun can still refuse, because
   * `tryFire` is the only thing that actually fires and it checks the reload timer itself. This is the
   * opponent's gunnery policy: shoot when the shot is worth taking.
   *
   * Conditions, in the order they matter:
   *  1. the player must actually be **visible** — firing at a remembered position would let the
   *     opponent shoot the player through a hill, which reads as cheating even though it is only bad
   *     geometry;
   *  2. the range must be worth a shot;
   *  3. the gun must be **loaded** — checked here as well as in the core, so the opponent does not
   *     spam a fire request it knows will be refused;
   *  4. the **turret must actually be on target**, within `fireBearingToleranceDeg`. This is what
   *     makes the opponent track the player with its turret instead of firing wherever it happens to
   *     be pointing, and it is why its shots arrive a beat after the player ducks behind cover;
   *  5. the acquisition delay must have elapsed.
   */
  private chooseFire(canSeePlayer: boolean, rangeM: number, dtSeconds: number): boolean {
    if (!canSeePlayer) {
      return false;
    }
    if (rangeM < ENEMY_TUNING.minEngageRangeM || rangeM > ENEMY_TUNING.maxEngageRangeM) {
      return false;
    }
    if (this.enemy.gunState.loadState !== 'loaded') {
      return false;
    }
    if (this.memory.acquisitionTicksRemaining > 0) {
      this.memory.acquisitionTicksRemaining -= Math.max(
        1,
        Math.round(dtSeconds * TICKS_PER_SECOND),
      );
      return false;
    }

    const bearingToPlayer = bearingRad(this.enemy.state.position, this.playerAimPoint());
    const gunBearing = this.enemy.turretState.localAngleRad + this.enemy.state.headingRad;
    const bearingErrorDeg = Math.abs(wrapAngle(bearingToPlayer - gunBearing) * (180 / Math.PI));

    return bearingErrorDeg <= ENEMY_TUNING.fireBearingToleranceDeg;
  }

  /**
   * Updates the reported state label.
   *
   * Computed *after* the decisions, from the same inputs, so the label always describes the command
   * that was just issued rather than being a separate guess about what the opponent is doing.
   */
  private updateState(canSeePlayer: boolean, rangeM: number): void {
    if (this.enemy.damage.destroyed || !this.canOperate()) {
      this.state = 'disabled';
      return;
    }

    if (!canSeePlayer) {
      // Lost the player: go to the last known position, then give up on it and search.
      const lostTicks = Math.round(ENEMY_TUNING.searchTimeoutSeconds * TICKS_PER_SECOND);
      this.state =
        this.memory.lastKnownPosition === null || this.memory.ticksSinceSeen > lostTicks
          ? 'searching'
          : 'closing';
      return;
    }

    if (rangeM > ENEMY_TUNING.farRangeM || rangeM < ENEMY_TUNING.nearRangeM) {
      this.state = 'closing';
      return;
    }

    // In the band. Reported as repositioning when the hull is badly off the bearing to the player and
    // the opponent has been working on it for a while — the case where it would otherwise sit with its
    // rear toward a player it cannot bring its gun round to quickly.
    const bearingErrorDeg = Math.abs(
      wrapAngle(bearingRad(this.enemy.state.position, this.playerAimPoint()) - this.enemy.state.headingRad) *
        (180 / Math.PI),
    );
    const repositionTicks = Math.round(ENEMY_TUNING.repositionPatienceSeconds * TICKS_PER_SECOND);
    this.state =
      bearingErrorDeg > 60 && this.memory.repositionTicks < repositionTicks
        ? 'repositioning'
        : 'engaging';
  }

  /** Where the hull steers toward: the player, their last known position, or the arena centre. */
  private steeringTarget(canSeePlayer: boolean): Vec3 | null {
    if (canSeePlayer) {
      return this.playerAimPoint();
    }
    if (this.memory.lastKnownPosition !== null) {
      // Close the last known position before giving up, so a search ends somewhere useful.
      const lostTicks = Math.round(ENEMY_TUNING.searchTimeoutSeconds * TICKS_PER_SECOND);
      return this.memory.ticksSinceSeen <= lostTicks ? this.memory.lastKnownPosition : ARENA_CENTRE;
    }
    return ARENA_CENTRE;
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
   * The point on the player's hull that the opponent aims at.
   *
   * Half the hull height up from the floor, not the trunnion: the hull presents the larger target, and
   * aiming at it is what makes the opponent dangerous to a player who is only exposing their hull.
   */
  private playerAimPoint(): Vec3 {
    const p = this.player.state.position;
    return vec3(p.x, p.y + this.player.definition.dimensions.heightM * 0.5, p.z);
  }

  /**
   * Whether the opponent can actually see the player right now, measured between its gun and the
   * player's hull.
   *
   * Deliberately the same test the simulation uses for its own line-of-sight reporting, recomputed
   * here from the controller's own eye and aim points. The alternative was to accept a `canSeePlayer`
   * flag from the caller, which creates two sources of truth: the HUD's spotted indicator and the
   * opponent's behaviour could disagree, and the player would watch the opponent react to something it
   * cannot see. Both now ask the same terrain the same question at the same moment.
   */
  private canSeePlayerNow(): boolean {
    return this.terrain.hasLineOfSight(this.enemyAimEye(), this.playerAimPoint());
  }
}

/** The centre of the arena, used as a last-resort place to search. */
const ARENA_CENTRE: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Compass bearing from one ground point to another, radians, in the vehicle heading frame.
 *
 * The core's own deterministic `atan2` (ADR-0005), with the world axes mapped into the vehicle's
 * heading frame: +Z is a bearing of zero and +X is +90 degrees.
 */
function bearingRad(from: Vec3, to: Vec3): number {
  return atan2(to.x - from.x, to.z - from.z);
}

/** Euclidean distance between two points. */
function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}




