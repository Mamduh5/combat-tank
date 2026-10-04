/**
 * Vehicle definition schema (ADR-0003).
 *
 * A vehicle is **data**. Adding a tank in a later version must mean adding a data file, not
 * editing gameplay code, and every handling number the simulation uses must come from here rather
 * than from a constant buried in a system.
 *
 * The schema covers what the simulation actually reads, and nothing more. The turret, main gun and
 * test shell arrived in V2; armour, survivability and modules arrive in V3 — each one added at the
 * version that has a system reading it, because a field nothing reads is a field that only drifts
 * out of date.
 *
 * Units are part of the field name (`Mps`, `Deg`, `Kg`, `M`, `Sec`, `Mm`) so a value's unit is always
 * visible at the call site. `docs/assumptions.md` A-01 fixes the unit conventions.
 */
import type { Vec3 } from './vec3.js';

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
  /**
   * Nominal penetration against vertical armour at `PenetrationModel.referenceVelocityMps`, in
   * millimetres of armour (A-01).
   *
   * Added in V3 as the shell's capability against a vehicle. It is deliberately the *only* capability
   * number: a real shell's penetration depends on its own construction in ways a single figure cannot
   * express, and V3 has no armour model to tune against yet. See ADR-0012.
   */
  readonly nominalPenetrationMm: number;
  /**
   * How well the shell resists angle, in `[0, 1]`.
   *
   * **0** means the shell gets no benefit from its own normalisation: a sloped hit costs it exactly
   * what the geometry costs. **1** means full normalisation, so an angled hit is as capable as a flat
   * one and only the ricochet rule protects the armour. Values between blend the two.
   *
   * A single scalar for V3 rather than a per-angle curve. The owner asked for the minimum coherent
   * version, and a curve would be a balance surface with nothing yet to balance against.
   */
  readonly normalization: number;
}

/**
 * Where a plate is mounted on the vehicle.
 *
 * A hull plate turns with the hull; a turret plate turns with the turret, which is what makes "shoot
 * the turret face" a distinct outcome from "shoot the hull front" even when both are square-on.
 */
export type ArmorMount = 'hull' | 'turret';

/**
 * A single armour plate.
 *
 * Modelled as an oriented slab with a *thickness*, positioned in **vehicle local space**. That shape
 * was chosen over curved or multi-faceted hulls because it is:
 *
 *  - **legible.** A designer can read a plate list and picture the vehicle, which is what makes the
 *    armour model learnable (vision principle P6) rather than a black box.
 *  - **exactly testable.** Ray-versus-oriented-box has a closed-form solution, so hit resolution has
 *    no sampling rate and no tunnelling ambiguity.
 *  - **cheap.** A dozen slab tests per impact is nothing, and it runs in the simulation core with no
 *    dependency on the render or physics meshes (ADR-0007).
 *
 * The cost is that compound-sloped armour is not representable. That is a V3 prototype trade recorded
 * in ADR-0012, and a finer representation can replace this without changing how penetration is
 * computed from the result.
 */
export interface ArmorPlate {
  /** Unique within a vehicle. Referenced by the HUD and by tests. */
  readonly id: string;
  /**
   * Region label such as `hull-front` or `turret-side`.
   *
   * A free-form string rather than an enum on purpose: the set of regions a future vehicle wants is
   * not decided, and a closed union would need editing every time one is added.
   */
  readonly region: string;
  /** Whether this plate follows the hull or the turret. */
  readonly mount: ArmorMount;
  /** Nominal armour thickness in millimetres (A-01). */
  readonly thicknessMm: number;
  /**
   * Centre of the plate's **outer surface**, in vehicle local space, metres.
   *
   * Vehicle local space has its origin at the centre of the hull floor, +Z forward, +X right,
   * +Y up. Stated here because every plate position depends on it.
   */
  readonly centerM: Vec3;
  /** Plate width across its surface, metres. */
  readonly widthM: number;
  /** Plate height along its surface, metres. */
  readonly heightM: number;
  /** Tilt about the vertical axis, degrees. Positive turns the face to the right. */
  readonly yawDeg: number;
  /** Tilt about the plate's own horizontal axis, degrees. Positive leans the top back. */
  readonly pitchDeg: number;
}

/**
 * What damaging a module does, at prototype scope.
 *
 * The effects are deliberately coarse. V3 exists to prove that penetrating a specific place can
 * affect a specific thing, not to simulate a tank. `none` means the module takes damage and nothing
 * else happens yet, which is the honest state for a consequence that would meaningfully expand the
 * version.
 */
export type ModuleEffect = 'engine' | 'track' | 'gun' | 'ammunition' | 'none';

/** A damageable sub-system with a position, so a hit near it can plausibly damage it. */
export interface ModuleDefinition {
  readonly id: string;
  /** Human-readable name for the HUD and debug output. */
  readonly label: string;
  /** Module hit points. At zero the module is destroyed. */
  readonly hitPoints: number;
  /** Centre of the module in vehicle local space, metres. Same origin as plates. */
  readonly centerM: Vec3;
  /**
   * How far from the module's centre a penetration still counts, metres.
   *
   * This is what gives module damage **spatial meaning**: the shell has to actually go near the
   * engine to hurt it. A sphere rather than a region test because it is simple, symmetric, and cannot
   * be configured into a nonsensical overlapping mess.
   */
  readonly radiusM: number;
  /** Consequence once this module is destroyed. */
  readonly effect: ModuleEffect;
}

/** Survivability: hit points, penetrating damage, and the modules that take part. */
export interface VehicleSurvivability {
  readonly hitPoints: number;
  /**
   * Damage applied per successful penetration, hit points.
   *
   * A **fixed** value on purpose. The owner allowed randomised penetration but preferred
   * deterministic fixed values absent a gameplay reason, and a fixed number keeps V3 reproducible
   * and its tests exact.
   */
  readonly damagePerPenetration: number;
  readonly modules: readonly ModuleDefinition[];
}

/**
 * How penetration and ricochet are resolved.
 *
 * Deliberately separate from both the shell and the vehicle, because the *rules* belong to neither:
 * the shell carries capability, the vehicle carries resistance, and this carries the rules that
 * compare them.
 */
export interface PenetrationModel {
  /**
   * Speed at which a shell's nominal penetration applies unchanged, m/s.
   *
   * Penetration scales with the ratio of impact speed to this, so a shell that has dropped over a long
   * flight arrives with slightly less than its quoted capability.
   */
  readonly referenceVelocityMps: number;
  /**
   * Incidence angle at or above which a shell ricochets instead of penetrating, degrees.
   *
   * A **temporary engineering value**, not a balance decision. It is data rather than a constant so
   * that tuning it later is an edit to a vehicle file and not a code change.
   */
  readonly ricochetThresholdDeg: number;
}

/**
 * How a vehicle sounds, as differences from the shared V7 audio family.
 *
 * ## Why this is on the vehicle at all
 *
 * The brief for V8 asks for modest per-vehicle differences in "engine character, track character and gun
 * report", and says a shared audio family with parameter differences is acceptable at this stage. Recording
 * those parameters **on the vehicle** rather than in a client-side table keyed by id is deliberate: a second
 * map keyed by vehicle is a second source of truth about a vehicle, and the two drift. One vehicle, one
 * definition, one place to change how it sounds.
 *
 * Everything here is a **multiplier on the shared recording**, never a new file. The V7 audio set is
 * deliberately small (17 synthesised WAVs); recording a distinct engine note per vehicle would multiply that
 * by the roster for no gameplay benefit at this stage, and would make `npm run assets` the bottleneck for
 * adding a tank. What actually differs between vehicles is *character*, and character is largely a matter of
 * pitch, weight and how much low end there is — which is what these numbers control.
 *
 * Only the client consumes this today. It lives in `shared` anyway, because it is vehicle content rather than
 * audio-engine policy: the moment a server wanted to describe a vehicle to a client it would already be
 * there, and `VehicleDefinition` is the one place that says "everything about this vehicle".
 */
export interface VehicleAudioProfile {
  /**
   * Engine loop pitch, as a multiplier on the shared recording.
   *
   * Below 1 is deeper and slower-revving; above 1 is lighter and more urgent. Bounded to a range where the
   * result still reads as the same engine rather than as a different synthesiser: pushing `playbackRate`
   * far shifts every partial and turns a heavy into a chipmunk.
   */
  readonly enginePitchScale: number;
  /** Engine level, as a multiplier on the shared mix. */
  readonly engineGainScale: number;
  /**
   * Track loop level, as a multiplier.
   *
   * A heavy's tracks are louder simply because there is more of them being dragged; a light's are a
   * higher, thinner sound that nearly disappears at low speed.
   */
  readonly trackGainScale: number;
  /** Gun report level, as a multiplier. The main loudness difference between calibres. */
  readonly gunGainScale: number;
  /** Gun report pitch, as a multiplier. A bigger gun is a lower report with more body. */
  readonly gunPitchScale: number;
  /** Turret servo level, as a multiplier. A light turret is audible; a heavy one is a low groan. */
  readonly turretGainScale: number;
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
  /** The single generic test shell this vehicle fires in V2/V3. */
  readonly mainShell: TestShellDefinition;
  /** Hit points, penetrating damage, and module layout. Added in V3. */
  readonly survivability: VehicleSurvivability;
  /** Armour plate layout. Added in V3. */
  readonly armor: readonly ArmorPlate[];
  /** The rules for comparing shell capability against armour resistance. Added in V3. */
  readonly penetration: PenetrationModel;
  /**
   * Id of the mesh the client should build. Referenced by id, not embedded, so placeholder
   * geometry can be replaced with real art without touching the data model.
   */
  readonly visualId: string;

  /**
   * Per-vehicle audio character, added in V8. Multipliers on the shared V7 audio family.
   *
   * Required rather than optional on purpose. An absent profile would mean a silent default and a class of
   * vehicle that is quietly identical to another in every respect the player can hear, which is exactly the
   * "different skins" outcome V8 exists to rule out. Making it required also means adding a vehicle forces
   * the question "how does this sound?" to be answered rather than skipped.
   */
  readonly audio: VehicleAudioProfile;
}

