import { NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import {
  clamp,
  cos,
  degToRad,
  radToDeg,
  sin,
  smoothingFactor,
  vec3,
  wrapAngle,
  type Vec3,
} from '../math/index.js';
import {
  groundSupportPitchRad,
  groundSupportRollRad,
  solveGroundSupportPlane,
  type GroundSupportPlane,
} from './ground-support.js';
import type { Terrain } from '../world/terrain.js';
import { LongitudinalModel, moveToward } from './locomotion.js';
import {
  createMainGunState,
  trunnionPosition,
  tryFire,
  updateMainGun,
  type MainGunState,
} from './main-gun.js';
import { createTurretState, gunDirection, updateTurret, type TurretState } from './turret.js';
import {
  createDamageState,
  findModule,
  isEffectDestroyed,
  type DamageState,
} from '../damage/damage-model.js';
import type { VehicleInit, VehicleState, VehicleTelemetry } from './vehicle-state.js';

/** Module ids for the two tracks. Both player and enemy definitions use these. */
const TRACK_LEFT_MODULE_ID = 'track-left';
const TRACK_RIGHT_MODULE_ID = 'track-right';

/** Both tracks intact: full performance, no pull. */
const INTACT_TRACKS = { speedScale: 1, turnScale: 1, turnBias: 0 } as const;

/**
 * Both tracks destroyed: no movement at all.
 *
 * `turnScale` and `turnBias` are both zero, so the vehicle also cannot rotate on the spot. A tank that
 * cannot move but can still spin is not immobilised in any way that matters.
 */
const DESTROYED_TRACKS = { speedScale: 0, turnScale: 0, turnBias: 0 } as const;

/**
 * One track dragging.
 *
 * `speedScale: 0.55` — a one-track tank moves at barely half speed. Large enough to be obvious, small
 * enough that it is still a usable weapon platform rather than a monument.
 *
 * `turnBias: +/-0.3` — a persistent pull of 30% of full traverse, toward the destroyed side. Applied
 * to the *demand*, so a player holding the opposite direction fights it and the vehicle still moves
 * the way they ask; releasing the controls lets the drag take over. This is the behaviour that makes
 * track damage a handicap to correct rather than a control the game takes away.
 *
 * `turnScale: 0.75` — steering authority drops, because a dragging track resists turning.
 */
const LEFT_TRACK_DRAG = { speedScale: 0.55, turnScale: 0.75, turnBias: -0.3 } as const;
const RIGHT_TRACK_DRAG = { speedScale: 0.55, turnScale: 0.75, turnBias: 0.3 } as const;

export type { VehicleInit, VehicleState, VehicleTelemetry } from './vehicle-state.js';
export type { MainGunState, GunLoadState } from './main-gun.js';
export type { TurretState } from './turret.js';

/**
 * Width of the play-area boundary speed taper, in metres.
 *
 * Over this distance the permitted speed falls linearly from the vehicle's top speed to zero. Large
 * enough that the deceleration is gradual and readable, small enough that the player never notices
 * being "in a restricted zone" rather than simply running out of ground.
 */
const PLAY_AREA_TAPER_M = 14;

/**
 * Half the vehicle's length used as the forward extent of the ground-support grid, as a fraction of the
 * definition's length.
 *
 * Slightly under half, because the tracks do not occupy the full hull length: `TANK_PROPORTIONS` puts the
 * track run at 0.94 of the hull, and the nose and tail of the hull overhang it. Sampling the full hull
 * length would let those overhangs — which never touch the ground — pull the fitted plane around and tilt
 * a vehicle whose running gear is sitting level.
 */
const GROUND_SUPPORT_HALF_LENGTH_FRACTION = 0.5 * 0.94;

/**
 * Half the vehicle's width used as the lateral extent of the ground-support grid, as a fraction of the
 * definition's width.
 *
 * The full width, because the tracks do span it: the outer face of each track unit reaches the vehicle's
 * full width, and the ground under those outer faces is what the player sees meeting the tank.
 */
const GROUND_SUPPORT_HALF_WIDTH_FRACTION = 0.5;

/**
 * A single tank: hull, kinematic locomotion, turret, gun, and damage state.
 *
 * The vehicle owns its own mutable state as plain fields, and `step` is the only thing that
 * changes them. There is no global state anywhere in the core, which is what lets the same class
 * run inside a test, inside the browser client, and later inside an authoritative server.
 *
 * The hull, turret and gun are three **separate systems** with separate state, which is the property
 * V2 exists to establish. The hull is driven by the player (OD-02, direct WASD — the hull is never
 * turned toward the camera or the aim point); the turret is a rate-limited servo on an aim point; the
 * gun elevates within its own limits and fires only when loaded. The vehicle ties them together by
 * stepping them in order each tick, and by refusing to let any one of them shortcut another.
 *
 * V3 adds **damage state**, which feeds back into locomotion and firing: a destroyed vehicle can do
 * neither, and certain destroyed modules impair specific capabilities. That feedback is what makes
 * the armour model observable rather than a number in a log.
 */
export class Tank {
  readonly definition: VehicleDefinition;

  /**
   * Identity of this particular vehicle within a battle, added in V8.
   *
   * Equal to `definition.id` unless the simulation gave it something else, which it does for the opponent
   * so that two identical vehicles can fight each other. See `VehicleInit.instanceId` for why a shared
   * id is not merely untidy but silently disables half the combat model.
   */
  readonly instanceId: string;

  state: VehicleState;

  /** Most recent step's diagnostics. Read by tests, the HUD, and the AI arriving in V5. */
  telemetry: VehicleTelemetry;

  private readonly longitudinal: LongitudinalModel;

  /**
   * Turret and gun orientation.
   *
   * Held separately from the hull's state rather than folded into it, because they are separate
   * systems with separate rules: the hull is driven, the turret is a servo, and the gun has limits
   * the turret does not. Keeping them apart is what stops a future change from accidentally making
   * the whole vehicle behave like a character that turns to face the cursor.
   */
  turretState: TurretState;

  /** Load state and reload timer. The core owns these so a shot can be refused authoritatively. */
  gunState: MainGunState;

  /**
   * Hit points and module state. Added in V3.
   *
   * Held on the vehicle rather than in a separate registry so a vehicle carries everything about
   * itself, which is what a server will need to serialise and a client will need to render.
   */
  damage: DamageState;

  /**
   * A shot requested this tick that the gun accepted, or `null`.
   *
   * Drained by the simulation world each tick. A request is only ever set when the gun was loaded,
   * so consuming it cannot produce a shot the core would not permit.
   */
  private pendingShot: { origin: Vec3; direction: Vec3 } | null = null;

  /**
   * Hard boundary on the play area, set from the terrain on the first step.
   *
   * Held on the vehicle rather than read from the terrain each tick so the movement code has a
   * single, obvious place where the world ends.
   */
  private playAreaHalfSizeM = Number.POSITIVE_INFINITY;

  /**
   * The terrain this vehicle was last stepped against.
   *
   * Held rather than passed into `updateBodyOrientation` because that method already runs inside `step`,
   * which is handed the terrain. `Terrain` is supplied per call by the simulation rather than injected at
   * construction, so caching it here is the only way the presentation code can reach the ground without
   * threading a second parameter through the step signature. It is refreshed every tick, so it can never
   * be stale relative to the vehicle's own position.
   */
  private terrain: Terrain;

  /**
   * The ground plane fitted beneath the vehicle on the most recent step, in the vehicle's own frame.
   *
   * Exposed read-only because the renderer needs it to conform the track elements to the ground: the hull
   * presents the plane's average, and the per-track and per-wheel offsets are the plane's residuals. The
   * core fits it and the renderer draws it, which keeps the geometry in one place and the policy in
   * another.
   */
  private supportPlane: GroundSupportPlane = {
    risePerMetreForward: 0,
    risePerMetreRight: 0,
    centreHeightM: 0,
    maxResidualAboveM: 0,
    maxResidualBelowM: 0,
  };

  constructor(definition: VehicleDefinition, init: VehicleInit) {
    this.definition = definition;
    // Defaults to the definition id, so a lone vehicle behaves exactly as it always has and nothing
    // outside `Simulation` has to think about instance identity at all.
    this.instanceId = init.instanceId ?? definition.id;
    // Replaced on the first `step`, which every caller makes before reading anything. Seeded with a
    // sampler that reports flat ground so construction stays total and cannot throw on a null.
    this.terrain = { heightAt: () => 0 } as unknown as Terrain;
    this.longitudinal = new LongitudinalModel(definition);
    this.turretState = createTurretState();
    this.gunState = createMainGunState();
    this.damage = createDamageState(definition);

    this.state = {
      position: init.position,
      headingRad: wrapAngle(init.headingRad),
      speedMps: 0,
      traverseRateDegPerSec: 0,
      bodyPitchRad: 0,
      bodyRollRad: 0,
      rideHeightM: definition.dimensions.groundClearanceM,
      slopeDeg: 0,
      stalled: false,
      groundNormal: vec3(0, 1, 0),
    };

    this.telemetry = {
      speedMps: 0,
      requestedThrottle: 0,
      requestedTurn: 0,
      headingRad: this.state.headingRad,
      traverseRateDegPerSec: 0,
      slopeDeg: 0,
      tractionLimited: false,
      stalled: false,
      accelMps2: 0,
      groundHeightM: 0,
      turretWorldHeadingRad: init.headingRad,
      turretTraverseRateDegPerSec: 0,
      gunElevationDeg: 0,
      gunElevateRateDegPerSec: 0,
      gunLoadState: 'loaded',
      reloadRemainingSeconds: 0,
      shotsFired: 0,
      hitPoints: this.damage.hitPoints,
      destroyed: false,
      immobilised: false,
      gunDisabled: false,
      tracksDestroyed: 0,
    };
  }

  /**
   * Returns this vehicle to its opening state in place.
   *
   * Added in V4 for encounter restart. Every piece of mutable state is rebuilt: position and heading,
   * all locomotion, the turret and gun servos, the reload cycle, the shot counter, and the full damage
   * state including every module.
   *
   * **In place rather than by constructing a new `Tank`**, for the same reason `Simulation.restart`
   * resets in place: the renderer, the HUD and the AI hold references to this object, and replacing it
   * would leave them pointing at a tank that is no longer simulated.
   *
   * Reassigning `this.state` wholesale is deliberate. Partially resetting fields is how a restart ends
   * up with one stale value — a turret left slewed, a module left destroyed — and those bugs are
   * genuinely hard to see, because the vehicle mostly behaves correctly.
   */
  reset(position: Vec3, headingRad: number): void {
    const definition = this.definition;

    this.state = {
      position,
      headingRad: wrapAngle(headingRad),
      speedMps: 0,
      traverseRateDegPerSec: 0,
      bodyPitchRad: 0,
      bodyRollRad: 0,
      rideHeightM: definition.dimensions.groundClearanceM,
      slopeDeg: 0,
      stalled: false,
      groundNormal: vec3(0, 1, 0),
    };

    this.turretState = createTurretState();
    this.gunState = createMainGunState();
    this.damage = createDamageState(definition);
    this.pendingShot = null;

    // The learned play-area bound is retained: it is a property of the terrain, not of the vehicle's
    // condition, and recomputing it would cost a terrain query per reset.
    this.telemetry = {
      speedMps: 0,
      requestedThrottle: 0,
      requestedTurn: 0,
      headingRad: wrapAngle(headingRad),
      traverseRateDegPerSec: 0,
      slopeDeg: 0,
      tractionLimited: false,
      stalled: false,
      accelMps2: 0,
      groundHeightM: position.y,
      turretWorldHeadingRad: wrapAngle(headingRad),
      turretTraverseRateDegPerSec: 0,
      gunElevationDeg: 0,
      gunElevateRateDegPerSec: 0,
      gunLoadState: 'loaded',
      reloadRemainingSeconds: 0,
      shotsFired: 0,
      hitPoints: definition.survivability.hitPoints,
      destroyed: false,
      immobilised: false,
      gunDisabled: false,
      tracksDestroyed: 0,
    };
  }

  /** Hull forward direction on the horizontal plane. */
  get forwardDirection(): Vec3 {
    return vec3(sin(this.state.headingRad), 0, cos(this.state.headingRad));
  }

  /** World position of the gun's pivot, which is where the barrel is mounted. */
  get gunPivotPosition(): Vec3 {
    return trunnionPosition(this.state.position, this.definition.turret.ringHeightM);
  }

  /**
   * The ground plane fitted beneath the vehicle, for the renderer to conform the running gear to.
   *
   * Read-only by contract: the core owns the fit, and the renderer only reads it. Exposing the plane
   * rather than the raw samples is deliberate — the renderer needs the *residual* of each element against
   * this plane, and handing it nine raw heights would invite it to re-fit a second, slightly different
   * plane and draw a hull that disagrees with the attitude the core chose.
   */
  get groundSupport(): GroundSupportPlane {
    return this.supportPlane;
  }

  /** The terrain this vehicle was last stepped against, so the renderer can sample under its own geometry. */
  get ground(): Terrain {
    return this.terrain;
  }

  /**
   * Takes the shot requested this tick, if any, and clears it.
   *
   * Returns `null` when no shot was accepted. The simulation world calls this exactly once per
   * tick, before creating shells, so a request cannot be consumed twice.
   */
  takePendingShot(): { origin: Vec3; direction: Vec3 } | null {
    const shot = this.pendingShot;
    this.pendingShot = null;
    return shot;
  }

  /**
   * Advances the vehicle by exactly one fixed tick.
   *
   * Ordering matters and is deliberate: sample the ground, solve longitudinal motion, apply
   * traverse, integrate position from the *updated* heading, then settle onto the ground. Reading
   * the heading before traverse would make turning lag the movement by a tick.
   */
  step(input: InputCommand, terrain: Terrain, dtSeconds: number): void {
    const { traversal, ground, dimensions, powertrain } = this.definition;
    const state = this.state;

    // Cached for the presentation code, which needs the ground but is not part of the step signature.
    this.terrain = terrain;

    // --- 0. Damage consequences ----------------------------------------------------------
    // Read before anything else, because a destroyed vehicle must not drive or shoot. The input is
    // zeroed rather than the steps skipped, so every downstream system still runs and the vehicle
    // settles onto the ground instead of hanging in the air.
    const immobilised = this.damage.destroyed || isEffectDestroyed(this.damage, 'engine');

    // --- V4: track damage has a gameplay consequence -----------------------------------
    // Before V4 a destroyed track was recorded and displayed but changed nothing about how the
    // vehicle drove, so module damage was telemetry rather than gameplay. A broken track now has a
    // coherent, readable effect:
    //
    //   - **both tracks destroyed** -> immobilised. The vehicle cannot move at all.
    //   - **one track destroyed**  -> *dragging*: reduced top speed, reduced traverse, and a
    //     constant pull to one side, so the vehicle veers and needs correcting.
    //
    // The veer is the part that makes it feel like damage rather than a slower vehicle. A tank with
    // one track out very visibly does not go where it is pointed, which communicates the state
    // without the player having to read a HUD line — and it creates a real tactical consequence,
    // because a damaged tank circling for a flank shot will miss its approach.
    const trackState = this.evaluateTracks();
    const mobilityScale = immobilised ? 0 : trackState.speedScale;
    const effectiveInput: InputCommand = immobilised ? NEUTRAL_INPUT : input;

    // The pull is added to the traverse demand, not multiplied into it, so it survives the hull's
    // own acceleration ramp and is visible as a persistent bias rather than a single kick.
    const trackBias = immobilised ? 0 : trackState.turnBias;

    // Learn the play area on the first tick. The Terrain instance is supplied per call, so this is
    // re-read only when it could plausibly have changed.
    if (this.playAreaHalfSizeM === Number.POSITIVE_INFINITY) {
      this.playAreaHalfSizeM = terrain.halfSizeM;
    }

    // --- 1. Ground gradient along the direction of travel --------------------------
    // Taken on the horizontal plane: slope resistance should reflect the gradient the vehicle is
    // driving into, not its full three-dimensional orientation.
    const slopeDeg = terrain.slopeDegreesAlong(
      state.position.x,
      state.position.z,
      sin(state.headingRad),
      cos(state.headingRad),
    );
    state.slopeDeg = slopeDeg;

    // --- 2. Longitudinal motion -----------------------------------------------------
    const solution = this.longitudinal.solve(state.speedMps, effectiveInput.throttle, slopeDeg);

    // A dragging track caps achievable speed below the definition's own maximum, so the cap is
    // applied to the *target* rather than by re-scaling the powertrain. That keeps every downstream
    // reading — telemetry, the HUD, the AI's sense of whether the vehicle is moving — consistent with
    // what actually happens, instead of reporting a top speed the vehicle can never reach.
    const speedCapMps = powertrain.maxSpeedMps * trackState.speedScale;
    const reverseCapMps = powertrain.maxReverseSpeedMps * trackState.speedScale;
    const cappedTargetMps = clamp(solution.targetSpeedMps, -reverseCapMps, speedCapMps);

    // Accelerate toward the solution's target at the solution's rate, then clamp to the
    // definition's absolute forward/reverse limits. A single tick can never overshoot.
    const nextSpeed = moveToward(
      state.speedMps,
      cappedTargetMps,
      Math.abs(solution.accelMps2) * dtSeconds,
    );
    state.speedMps = clamp(nextSpeed, -reverseCapMps, speedCapMps);
    state.stalled = solution.stalled;

    // --- 3. Hull traverse -------------------------------------------------------------
    // The requested rate falls off with speed, and the actual rate ramps toward it. The ramp is
    // what prevents an instant pivot, which is the difference between a tank and a swivel
    // (vision principle P5).
    const speedFraction =
      powertrain.maxSpeedMps > 0
        ? Math.min(1, Math.abs(state.speedMps) / powertrain.maxSpeedMps)
        : 0;
    const requestedRate =
      (effectiveInput.turn * mobilityScale * trackState.turnScale + trackBias) *
      traversal.hullTraverseDegPerSec *
      (1 - traversal.traverseSpeedPenalty * speedFraction);

    state.traverseRateDegPerSec = moveToward(
      state.traverseRateDegPerSec,
      requestedRate,
      traversal.hullTraverseAccelDegPerSec2 * dtSeconds,
    );
    state.headingRad = wrapAngle(
      state.headingRad + degToRad(state.traverseRateDegPerSec) * dtSeconds,
    );

    // --- 4. Integrate position using the updated heading -----------------------------
    let nextX = state.position.x + sin(state.headingRad) * state.speedMps * dtSeconds;
    let nextZ = state.position.z + cos(state.headingRad) * state.speedMps * dtSeconds;

    // Keep the vehicle inside the play area.
    //
    // The terrain's rising rim discourages driving out, but it is a gentle slope and a vehicle at
    // full speed will simply climb over it, so it needs a real guard.
    //
    // The guard is a *speed taper* over the last few metres, not a position clamp. Clamping the
    // position would leave speed intact, so the vehicle would re-accelerate against the wall every
    // tick and the speed would oscillate — the classic symptom of a broken boundary. Tapering the
    // target speed to zero at the edge means the vehicle coasts to a stop there and stays stopped,
    // which also reads as the terrain resisting the vehicle rather than an invisible plane.
    const boundarySpeedCap = this.boundarySpeedCapMps(state.position.x, state.position.z);
    if (boundarySpeedCap < Math.abs(state.speedMps)) {
      state.speedMps = moveToward(
        state.speedMps,
        Math.sign(state.speedMps) * boundarySpeedCap,
        powertrain.brakeDecelMps2 * dtSeconds,
      );
    }

    nextX = state.position.x + sin(state.headingRad) * state.speedMps * dtSeconds;
    nextZ = state.position.z + cos(state.headingRad) * state.speedMps * dtSeconds;

    // Hard backstop, in case a single tick would otherwise carry the vehicle past the limit. The
    // taper above should make this unreachable; it exists so no future change can leak the world.
    const limitM = this.playAreaHalfSizeM;
    if (nextX > limitM || nextX < -limitM || nextZ > limitM || nextZ < -limitM) {
      nextX = clamp(nextX, -limitM, limitM);
      nextZ = clamp(nextZ, -limitM, limitM);
      state.speedMps = 0;
    }

    // --- 5. Settle onto the ground ----------------------------------------------------
    // Exponential approach rather than a hard set, so cresting a ridge has some weight to it and
    // the hull does not snap to every small undulation. Derived from dt, so the settling rate is
    // identical at 30 Hz and 144 Hz.
    const groundHeight = terrain.heightAt(nextX, nextZ);
    state.rideHeightM +=
      (dimensions.groundClearanceM - state.rideHeightM) * smoothingFactor(ground.suspensionStiffness, dtSeconds);
    state.position = vec3(nextX, groundHeight + state.rideHeightM, nextZ);

    // --- 6. Body orientation for presentation ----------------------------------------
    // Visual only. It does not feed back into movement, so a smoothing choice here can never change
    // where the vehicle actually goes. The normal is still recorded on the state for anything that wants
    // the surface direction; the attitude itself is fitted from the support area rather than from it.
    state.groundNormal = terrain.normalAt(nextX, nextZ);
    this.updateBodyOrientation(dtSeconds);

    // --- 7. Turret, gun, and the reload cycle -----------------------------------------
    // Runs *after* the hull has been updated, so the turret is mounted on the heading the vehicle
    // finished this tick with, not the one it started with. That ordering is why rotating the hull
    // carries the turret with it, and why the turret can lag if the hull turns faster than it slews.
    const trunnion = trunnionPosition(state.position, this.definition.turret.ringHeightM);
    updateTurret(
      this.turretState,
      this.definition,
      state.headingRad,
      trunnion,
      input.aimPoint,
      dtSeconds,
    );
    updateMainGun(this.gunState, dtSeconds);

    // A fire request is a *request*. `tryFire` refuses it while reloading and returns the muzzle
    // position only when the shot actually happens. The world spawns the shell from this; the
    // vehicle does not know or care what happens to it afterwards.
    //
    // A destroyed gun module stops it firing entirely, and a destroyed vehicle cannot fire at all.
    // Both are prototype consequences of V3 module damage; the underlying damage state is what
    // matters, and these are the cheapest visible proofs that a specific module was hit.
    const canFire =
      !this.damage.destroyed &&
      !isEffectDestroyed(this.damage, 'gun') &&
      effectiveInput.fire;
    const muzzle = canFire
      ? tryFire(this.gunState, this.definition, trunnion, this.turretState, state.headingRad)
      : null;
    this.pendingShot =
      muzzle === null
        ? null
        : { origin: muzzle, direction: gunDirection(this.turretState, state.headingRad) };

    this.telemetry = {
      speedMps: state.speedMps,
      requestedThrottle: effectiveInput.throttle,
      requestedTurn: effectiveInput.turn,
      headingRad: state.headingRad,
      traverseRateDegPerSec: state.traverseRateDegPerSec,
      slopeDeg,
      tractionLimited: solution.tractionLimited,
      stalled: solution.stalled,
      accelMps2: solution.accelMps2,
      groundHeightM: groundHeight,
      turretWorldHeadingRad: this.turretState.localAngleRad + state.headingRad,
      turretTraverseRateDegPerSec: this.turretState.traverseRateDegPerSec,
      gunElevationDeg: radToDeg(this.turretState.elevationRad),
      gunElevateRateDegPerSec: this.turretState.elevateRateDegPerSec,
      gunLoadState: this.gunState.loadState,
      reloadRemainingSeconds: this.gunState.reloadRemainingSeconds,
      shotsFired: this.gunState.shotsFired,
      hitPoints: this.damage.hitPoints,
      destroyed: this.damage.destroyed,
      immobilised,
      gunDisabled: isEffectDestroyed(this.damage, 'gun'),
      // Derived from the same `trackState` the movement code used this tick, so the HUD can never
      // report a track condition that differs from the one being applied.
      tracksDestroyed: this.tracksDestroyed(),
    };
  }

  /**
   * Reads the track modules and derives how badly the vehicle can move.
   *
   * Deliberately a pure function of current damage rather than an accumulating "wear" value. A wear
   * model would drift with time and would need its own state, reset rules and tuning; deriving the
   * consequence directly from which tracks are destroyed makes it exactly reversible on restart and
   * impossible for the displayed state and the applied state to disagree.
   *
   * The two tracks are distinguished by module **id** rather than by a `track` effect flag, because
   * `ModuleEffect` deliberately says nothing about which side a module is on. Both vehicles define
   * `track-left` and `track-right`, and the *side* determines which way the vehicle pulls.
   *
   * Pull direction is in the vehicle's own frame: a destroyed **left** track drags the vehicle to the
   * left, which is a negative traverse demand under the project's convention (positive turns right).
   * It is applied to the traverse rate, so the vehicle visibly crabs around a corner rather than
   * simply being slower.
   */
  private evaluateTracks(): { speedScale: number; turnScale: number; turnBias: number } {
    const left = findModule(this.damage, TRACK_LEFT_MODULE_ID);
    const right = findModule(this.damage, TRACK_RIGHT_MODULE_ID);
    const leftLost = left === null || left.destroyed;
    const rightLost = right === null || right.destroyed;

    if (!leftLost && !rightLost) {
      return INTACT_TRACKS;
    }
    if (leftLost && rightLost) {
      return DESTROYED_TRACKS;
    }

    // One track dragging. Scale is a fraction of full performance; the bias is the veer, in the same
    // units as the player's `turn` axis, so it composes with real steering input rather than
    // overriding it — the player can steer out of the drag, which is what makes it a handicap rather
    // than a hard lock.
    return leftLost ? LEFT_TRACK_DRAG : RIGHT_TRACK_DRAG;
  }

  /** Number of destroyed tracks, in `[0, 2]`. */
  private tracksDestroyed(): number {
    let count = 0;
    for (const module of this.damage.modules) {
      if (module.effect === 'track' && module.destroyed) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Speed the vehicle is permitted within the play-area boundary taper, in m/s.
   *
   * Returns the vehicle's top speed in open ground, tapering linearly to zero across the last
   * `PLAY_AREA_TAPER_M` metres before the edge. A linear taper is deliberate: it is monotonic, so
   * the vehicle can never re-accelerate against the boundary, and it produces the gentle
   * "the ground is getting difficult" feel that suits a tank more than hitting an invisible wall.
   */
  private boundarySpeedCapMps(x: number, z: number): number {
    const limitM = this.playAreaHalfSizeM;
    if (!Number.isFinite(limitM)) {
      return this.definition.powertrain.maxSpeedMps;
    }

    const distanceToEdgeM = limitM - Math.max(Math.abs(x), Math.abs(z));
    if (distanceToEdgeM >= PLAY_AREA_TAPER_M) {
      return this.definition.powertrain.maxSpeedMps;
    }
    if (distanceToEdgeM <= 0) {
      return 0;
    }
    return this.definition.powertrain.maxSpeedMps * (distanceToEdgeM / PLAY_AREA_TAPER_M);
  }

  /**
   * Updates the smoothed pitch and roll used to present the hull on a slope.
   *
   * Replaced in the V6 grounding pass. This used to decompose a **single** ground normal taken at the
   * vehicle's centre, and measurement showed that was wrong twice over: the sign of each axis was
   * inverted relative to Babylon's rotation composition, and one central sample cannot describe a
   * 6.7 m x 3.3 m footprint on rolling ground. It now fits a plane to a grid of contact samples spanning
   * the track area and derives both angles from that plane's gradients. See `ground-support.ts` for the
   * fit and the derivation of the signs.
   *
   * Still presentation only. Nothing here feeds back into movement, so the smoothing choice cannot change
   * where the vehicle actually goes.
   */
  private updateBodyOrientation(dtSeconds: number): void {
    const state = this.state;
    const { lengthM, widthM } = this.definition.dimensions;

    // The support grid spans the **track** area rather than the full hull, because the tracks are what
    // meets the ground. Using the hull length would let the overhanging glacis and the rear overhang pull
    // the fitted plane around and tilt a vehicle that is sitting perfectly level on its running gear.
    const plane = solveGroundSupportPlane(
      (px, pz) => this.terrain.heightAt(px, pz),
      state.position.x,
      state.position.z,
      state.headingRad,
      lengthM * GROUND_SUPPORT_HALF_LENGTH_FRACTION,
      widthM * GROUND_SUPPORT_HALF_WIDTH_FRACTION,
    );
    this.supportPlane = plane;

    const targetPitch = groundSupportPitchRad(plane);
    const targetRoll = groundSupportRollRad(plane);

    // A blend of the definition's stiffness and damping, so the same two numbers govern both ride
    // height and attitude and cannot drift apart.
    const { suspensionStiffness, suspensionDamping } = this.definition.ground;
    const blend = smoothingFactor((suspensionStiffness * suspensionDamping) / 10, dtSeconds);

    state.bodyPitchRad += (targetPitch - state.bodyPitchRad) * blend;
    state.bodyRollRad += (targetRoll - state.bodyRollRad) * blend;
  }
}


