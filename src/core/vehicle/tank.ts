import { NEUTRAL_INPUT, type InputCommand } from '../../shared/input.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import {
  atan,
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
import { createDamageState, isEffectDestroyed, type DamageState } from '../damage/damage-model.js';
import type { VehicleInit, VehicleState, VehicleTelemetry } from './vehicle-state.js';

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
  readonly state: VehicleState;

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
  readonly turretState: TurretState;

  /** Load state and reload timer. The core owns these so a shot can be refused authoritatively. */
  readonly gunState: MainGunState;

  /**
   * Hit points and module state. Added in V3.
   *
   * Held on the vehicle rather than in a separate registry so a vehicle carries everything about
   * itself, which is what a server will need to serialise and a client will need to render.
   */
  readonly damage: DamageState;

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

  constructor(definition: VehicleDefinition, init: VehicleInit) {
    this.definition = definition;
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

    // --- 0. Damage consequences ----------------------------------------------------------
    // Read before anything else, because a destroyed vehicle must not drive or shoot. The input is
    // zeroed rather than the steps skipped, so every downstream system still runs and the vehicle
    // settles onto the ground instead of hanging in the air.
    const immobilised = this.damage.destroyed || isEffectDestroyed(this.damage, 'engine');
    const mobilityScale = immobilised ? 0 : 1;
    const effectiveInput: InputCommand = immobilised ? NEUTRAL_INPUT : input;

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

    // Accelerate toward the solution's target at the solution's rate, then clamp to the
    // definition's absolute forward/reverse limits. A single tick can never overshoot.
    const nextSpeed = moveToward(
      state.speedMps,
      solution.targetSpeedMps,
      Math.abs(solution.accelMps2) * dtSeconds,
    );
    state.speedMps = clamp(nextSpeed, -powertrain.maxReverseSpeedMps, powertrain.maxSpeedMps);
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
      effectiveInput.turn *
      traversal.hullTraverseDegPerSec *
      (1 - traversal.traverseSpeedPenalty * speedFraction) *
      mobilityScale;

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
    // Visual only. It does not feed back into movement, so a smoothing choice here can never
    // change where the vehicle actually goes.
    const normal = terrain.normalAt(nextX, nextZ);
    state.groundNormal = normal;
    this.updateBodyOrientation(normal, dtSeconds);

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
    };
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
   * The ground normal is decomposed in the hull's own frame: the component along the heading gives
   * pitch, the component along the right axis gives roll.
   */
  private updateBodyOrientation(groundNormal: Vec3, dtSeconds: number): void {
    const state = this.state;
    const forwardX = sin(state.headingRad);
    const forwardZ = cos(state.headingRad);

    const forwardComponent = groundNormal.x * forwardX + groundNormal.z * forwardZ;
    const rightComponent = groundNormal.x * forwardZ - groundNormal.z * forwardX;

    const targetPitch = -atan(forwardComponent);
    const targetRoll = atan(rightComponent);

    // A blend of the definition's stiffness and damping, so the same two numbers govern both ride
    // height and attitude and cannot drift apart.
    const { suspensionStiffness, suspensionDamping } = this.definition.ground;
    const blend = smoothingFactor((suspensionStiffness * suspensionDamping) / 10, dtSeconds);

    state.bodyPitchRad += (targetPitch - state.bodyPitchRad) * blend;
    state.bodyRollRad += (targetRoll - state.bodyRollRad) * blend;
  }
}


