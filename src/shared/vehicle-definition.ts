/**
 * Vehicle definition schema (ADR-0003).
 *
 * A vehicle is **data**. Adding a tank in a later version must mean adding a data file, not
 * editing gameplay code, and every handling number the simulation uses must come from here rather
 * than from a constant buried in a system.
 *
 * The V1 slice of the schema covers only what the movement sandbox needs. Armour plates, the gun,
 * hit points and modules are named in `docs/technical-direction.md` §8 as part of the eventual
 * shape, but they are added in V2/V3 when there is something to consume them — a field nothing
 * reads is a field that only drifts out of date.
 *
 * Units are part of the field name (`Mps`, `Deg`, `Kg`, `M`, `Sec`) so a value's unit is always
 * visible at the call site. `docs/assumptions.md` A-01 fixes the unit conventions.
 */

/** Hull dimensions and ride height, in metres. */
export interface VehicleDimensions {
  /** Length, nose to tail. */
  readonly lengthM: number;
  /** Width across the tracks. */
  readonly widthM: number;
  /** Height of the hull, excluding the turret (V2). */
  readonly heightM: number;
  /** Distance from the ground to the hull floor. */
  readonly groundClearanceM: number;
}

/** Engine and mass. */
export interface VehiclePowertrain {
  readonly massKg: number;
  /**
   * Peak drive force in newtons, applied while throttle is held.
   *
   * Expressed as a force rather than an acceleration so that mass and power stay independently
   * meaningful: acceleration is derived as `driveForceN / massKg`, which is what makes a heavy
   * vehicle feel heavy instead of merely having a different top speed.
   */
  readonly driveForceN: number;
  /** Top forward speed in m/s on the flat. */
  readonly maxSpeedMps: number;
  /** Top reverse speed in m/s on the flat. Reverse is deliberately slower than forward. */
  readonly maxReverseSpeedMps: number;
  /** Deceleration in m/s^2 when the throttle opposes the current direction of travel. */
  readonly brakeDecelMps2: number;
  /** Deceleration in m/s^2 when the throttle is released. */
  readonly coastDecelMps2: number;
}

/** Hull rotation. */
export interface VehicleTraversal {
  /** Peak hull rotation rate in degrees per second. */
  readonly hullTraverseDegPerSec: number;
  /**
   * How quickly the hull reaches that peak rate, in degrees per second squared.
   *
   * This is what stops a tank pivoting instantly (vision principle P5) and is felt as the
   * difference between a heavy vehicle and a turret on a swivel.
   */
  readonly hullTraverseAccelDegPerSec2: number;
  /** Multiplier applied to traverse rate at top speed, in `[0, 1]`. */
  readonly traverseSpeedPenalty: number;
}

/** How the vehicle interacts with ground. */
export interface VehicleGroundInteraction {
  /** Steepest climbable gradient in degrees. Beyond this the vehicle stalls. */
  readonly maxClimbDeg: number;
  /** Steepest descent the vehicle can hold without sliding, in degrees. */
  readonly maxDescendDeg: number;
  /**
   * Fraction of speed retained at `maxClimbDeg`, in `[0, 1]`.
   *
   * A gradient costs speed; a pure stall threshold would make hills binary, which feels worse than
   * a climb that visibly slows the tank as it steepens.
   */
  readonly climbSpeedRetention: number;
  /** How quickly the visual body follows the ground, in units of 1/second. Higher is stiffer. */
  readonly suspensionStiffness: number;
  /** Visual pitch/roll smoothing, in units of 1/second. Higher is tighter to the ground. */
  readonly suspensionDamping: number;
}

export interface VehicleDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly dimensions: VehicleDimensions;
  readonly powertrain: VehiclePowertrain;
  readonly traversal: VehicleTraversal;
  readonly ground: VehicleGroundInteraction;
  /**
   * Id of the mesh the client should build. Referenced by id, not embedded, so placeholder
   * geometry can be replaced with real art without touching the data model.
   */
  readonly visualId: string;
}
