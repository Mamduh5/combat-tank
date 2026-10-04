import type { Vec3 } from '../../shared/vec3.js';
import type { GunLoadState } from './main-gun.js';

/**
 * Mutable simulation state for one vehicle.
 *
 * This is a plain data record rather than a class so that it can be inspected, copied, and
 * compared in tests without any behaviour attached, and so a future server can serialise it
 * directly. All mutation happens in `Tank.step`.
 */
export interface VehicleState {
  /** World position of the hull floor centre. */
  position: Vec3;
  /** Hull heading in radians, measured from +Z toward +X. */
  headingRad: number;
  /** Signed speed along the hull's forward axis, m/s. Negative is reverse. */
  speedMps: number;
  /** Current hull traverse rate, degrees/second. Ramps toward the requested rate. */
  traverseRateDegPerSec: number;
  /** Smoothed body pitch in radians, for presenting the hull on slopes. */
  bodyPitchRad: number;
  /** Smoothed body roll in radians, for presenting the hull on slopes. */
  bodyRollRad: number;
  /** Smoothed ride height above the terrain surface, metres. */
  rideHeightM: number;
  /** Ground gradient ahead of the vehicle, in degrees. Positive is uphill. */
  slopeDeg: number;
  /** True while the vehicle is being held by a gradient steeper than it can climb. */
  stalled: boolean;
  /** Unit ground normal under the vehicle, used for presenting hull orientation. */
  groundNormal: Vec3;
}

/** Construction parameters for a vehicle's initial state. */
export interface VehicleInit {
  readonly position: Vec3;
  readonly headingRad: number;

  /**
   * Identity of *this* vehicle instance, added in V8.
   *
   * Distinct from `VehicleDefinition.id`, which names a vehicle **type**. The shell system uses this to
   * stop a shell striking the vehicle that fired it, and the combat resolver uses it to route a hit to
   * the right tank, so it must be unique among the vehicles present in one battle.
   *
   * It cannot simply be the definition id, and V8 is the version that proved why. "Medium vs medium" is
   * an explicitly required matchup, and with two vehicles sharing an id every shell the opponent fired
   * was excluded from colliding with the player by its own self-exclusion rule: the shells passed
   * straight through, landed 165 m past, and the opponent's combat-feedback loop never received a
   * result — so it probed forever and never flanked. Nothing about that reads as an id collision from
   * the outside; it presents as an AI that has stopped working.
   *
   * Optional, defaulting to the definition id, because the overwhelming majority of callers construct a
   * single vehicle and have no reason to think about this. `Simulation` supplies a distinct value for
   * the opponent, which is the only place two of them coexist.
   */
  readonly instanceId?: string;
}

/**
 * Per-step diagnostics for a vehicle.
 *
 * Exposed as a field rather than a return value because tests, the HUD, and the AI that arrives
 * in V5 all need to read *why* the vehicle is doing what it is doing, and returning it from
 * `step` would tempt callers to act on it as if it were authoritative.
 */
export interface VehicleTelemetry {
  readonly speedMps: number;
  readonly requestedThrottle: number;
  readonly requestedTurn: number;
  readonly headingRad: number;
  readonly traverseRateDegPerSec: number;
  readonly slopeDeg: number;
  /** True when the climb penalty, rather than the drive force, is what limits speed. */
  readonly tractionLimited: boolean;
  readonly stalled: boolean;
  /** Longitudinal acceleration actually applied this tick, m/s^2. Negative when slowing. */
  readonly accelMps2: number;
  /** Height of the terrain directly under the vehicle, metres. */
  readonly groundHeightM: number;

  // --- V2 gunnery ---------------------------------------------------------------------
  // Reported separately from the hull so a consumer can tell "the vehicle turned" from "the turret
  // turned". The two are independent, and conflating them is exactly the behaviour the owner asked to
  // avoid.
  /** Turret world heading, radians. Equals the hull heading plus the turret's local angle. */
  readonly turretWorldHeadingRad: number;
  /** Current turret traverse rate, degrees/second, signed. */
  readonly turretTraverseRateDegPerSec: number;
  /** Gun elevation above the turret's horizontal plane, degrees. Positive is up. */
  readonly gunElevationDeg: number;
  /** Current gun elevation rate, degrees/second, signed. */
  readonly gunElevateRateDegPerSec: number;
  /** Whether the main gun is loaded or reloading. */
  readonly gunLoadState: GunLoadState;
  /** Seconds until the gun is loaded again. Zero while loaded. */
  readonly reloadRemainingSeconds: number;
  /** Shots actually fired, as opposed to shots requested. */
  readonly shotsFired: number;

  // --- V3 damage ------------------------------------------------------------------------
  /** Remaining vehicle hit points. Zero once destroyed. */
  readonly hitPoints: number;
  /** True once the vehicle has been destroyed. */
  readonly destroyed: boolean;
  /**
   * True when a destroyed engine or track module prevents the vehicle driving.
   *
   * Reported separately from `destroyed` so the HUD can say *why* a wreck will not move, which is
   * more useful than a generic "disabled".
   */
  readonly immobilised: boolean;
  /** True when a destroyed gun module prevents the vehicle firing. */
  readonly gunDisabled: boolean;

  // --- V4 track condition -------------------------------------------------------------------
  /**
   * How many of the vehicle's two tracks are destroyed, in `[0, 2]`.
   *
   * Reported rather than inferred from `immobilised`, because the two mean different things: `0` and
   * `1` both still drive, but `1` drags and veers. The HUD needs that distinction to warn the player
   * that their mobility is compromised, and the opponent's controller uses it to decide that a
   * damaged player is worth pressing rather than avoiding.
   */
  readonly tracksDestroyed: number;
}
