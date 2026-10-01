/**
 * Vehicle definition schema (ADR-0003).
 *
 * A vehicle is **data**. Adding a tank in a later version must mean adding a data file, not
 * editing gameplay code, and every handling number the simulation uses must come from here rather
 * than from a constant buried in a system.
 *
 * The schema covers what the simulation actually reads, and nothing more. Armour plates, hit points
 * and modules are named in `docs/technical-direction.md` §8 as part of the eventual shape, but they
 * are added in V3 when there is something to consume them — a field nothing reads is a field that
 * only drifts out of date. V2 added the turret, main gun and test shell sections for the same reason:
 * each one is read by a system that exists.
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
  /** Height of the hull itself, excluding the turret, which is positioned separately. */
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

/**
 * Turret rotation, independent of the hull.
 *
 * The turret is mounted on the hull, so its **world** heading is `hull heading + local angle`. It
 * stores the *local* angle and the limits that apply to it, because those are the mechanically
 * meaningful constraints: a real turret ring has limited travel relative to its own hull, and that
 * limit is what stops it slewing freely all the way round.
 */
export interface VehicleTurret {
  /** Peak turret rotation rate relative to the hull, degrees per second. */
  readonly traverseDegPerSec: number;
  /**
   * How quickly the turret reaches that rate, degrees per second squared.
   *
   * A turret is lighter than a hull and slews faster, but it is still a multi-tonne mechanism. This
   * is what stops the whole vehicle snapping to the cursor, which the owner called out as the
   * behaviour to avoid.
   */
  readonly traverseAccelDegPerSec2: number;
  /**
   * Maximum travel either side of the hull's forward axis, degrees.
   *
   * A generous arc rather than a realistic one, so the player is not surprised by a hard stop
   * during evaluation. The final traverse arc is a balance question, not a V2 one.
   */
  readonly maxTraverseDeg: number;
  /** Height of the turret ring above the hull floor, metres. Places the gun in world space. */
  readonly ringHeightM: number;
}

/** The main gun: orientation limits and the reload cycle. */
export interface VehicleMainGun {
  /** Maximum elevation above the horizontal, degrees. Positive is up. */
  readonly maxElevationDeg: number;
  /** Maximum depression below the horizontal, degrees. Positive is down. */
  readonly maxDepressionDeg: number;
  /**
   * How fast the barrel raises and lowers, degrees per second.
   *
   * Deliberately a single rate for both directions. Elevation gear on a real tank is often
   * asymmetric, but modelling that adds a parameter nothing currently benefits from; it is trivial
   * to split into two later if balance calls for it.
   */
  readonly elevateRateDegPerSec: number;
  /** Barrel length from the trunnion to the muzzle, metres. Sets where shells are born. */
  readonly barrelLengthM: number;
  /** Time from firing to the gun being loaded again, seconds. */
  readonly reloadSeconds: number;
}

/**
 * A single generic ballistic shell.
 *
 * **This is a test shell, not an ammunition design.** The owner deferred the ammunition roster
 * (OD-04) until penetration and armour behaviour can be judged meaningfully, so V2 deliberately has
 * exactly one shell and no AP/HE/APCR taxonomy. The fields are shaped so that future types can be
 * added as data, but nothing here should be read as a balance decision: the velocity and mass are
 * engineering defaults chosen to make ballistic behaviour obvious and easy to test.
 *
 * Penetration, ricochet, damage and shell-type behaviour are **V3 and later** and are deliberately
 * absent — see `docs/gameplay-systems.md` §3.
 */
export interface TestShellDefinition {
  /** Identifier for the shell type. Referenced when reporting what was fired. */
  readonly id: string;
  /** Human-readable name for debug output. Not a design name. */
  readonly displayName: string;
  /** Speed at the muzzle, metres per second. */
  readonly muzzleVelocityMps: number;
  /** Mass, kilograms. Recorded on the impact result for V3 to use; unused in V2. */
  readonly massKg: number;
  /**
   * Maximum distance the shell may travel before it is discarded, metres.
   *
   * Without this a shell fired upward would fly forever. It also bounds the work a single shot can
   * cost, which matters once a server is simulating many of them.
   */
  readonly maxRangeM: number;
  /** Maximum time the shell may exist, seconds. A backstop against `maxRangeM`. */
  readonly maxLifetimeSeconds: number;
  /**
   * Largest distance the shell may travel between collision samples, metres.
   *
   * A fast shell covers many metres in one 60 Hz tick, so a single sample per tick would let it
   * tunnel straight through a hill. Sub-stepping at this spacing bounds how far it can pass the
   * surface undetected. See `src/core/ballistics/shell.ts`.
   */
  readonly maxSubstepM: number;
}

export interface VehicleDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly dimensions: VehicleDimensions;
  readonly powertrain: VehiclePowertrain;
  readonly traversal: VehicleTraversal;
  readonly ground: VehicleGroundInteraction;
  readonly turret: VehicleTurret;
  readonly mainGun: VehicleMainGun;
  /** The single generic test shell this vehicle fires in V2. */
  readonly mainShell: TestShellDefinition;
  /**
   * Id of the mesh the client should build. Referenced by id, not embedded, so placeholder
   * geometry can be replaced with real art without touching the data model.
   */
  readonly visualId: string;
}

