import { assertValidVehicleDefinition } from './vehicle-definition-schema.js';
import type { VehicleDefinition } from './vehicle-definition.js';

/**
 * The V1 placeholder tank.
 *
 * This is a generic fictional vehicle, not a real tank. Combat Tank is not a simulator
 * (`docs/vision.md` §6), so the numbers are chosen to make movement *legible and fun to evaluate*,
 * not to reproduce any historical machine.
 *
 * Every value here is a tuning surface, and the comments explain what each one feels like. The
 * V1 validation criterion is that the simulation reads these values rather than constants of its
 * own, so changing `maxSpeedMps` here must visibly change how the vehicle drives.
 *
 * Sizing: a WWII-medium-tank silhouette, roughly 6.7 m long, 3.3 m wide, 2.4 m tall. Those are
 * also the dimensions the client builds its placeholder mesh from, so visual and collision agree.
 */
export const PLACEHOLDER_TANK: VehicleDefinition = {
  id: 'placeholder-medium',
  displayName: 'Placeholder Medium',
  visualId: 'placeholder-medium',

  dimensions: {
    lengthM: 6.7,
    widthM: 3.3,
    heightM: 1.15,
    groundClearanceM: 0.48,
  },

  powertrain: {
    massKg: 32_000,
    // 32_000 kg with 78_000 N gives ~2.4 m/s^2 of drive acceleration: brisk, but it takes
    // several seconds to reach top speed. That ramp is the main source of "weight" in V1.
    driveForceN: 78_000,
    maxSpeedMps: 11.1, // ~40 km/h
    // Reverse is roughly half of forward, as on a real tracked vehicle with one reverse gear.
    maxReverseSpeedMps: 5.0,
    // Strong brakes relative to drive force: a tank should stop decisively when you ask it to.
    brakeDecelMps2: 7.5,
    // Engine braking is weak, so releasing the throttle coasts rather than stopping. This is a
    // large part of why the vehicle reads as heavy.
    coastDecelMps2: 0.55,
  },

  traversal: {
    // Deliberately slow. A fast-rotating hull removes the need to plan a turn, which is exactly
    // the commitment the genre asks for (vision principle P2).
    hullTraverseDegPerSec: 26,
    // Time to reach full traverse is ~1.9 s, which is the difference between a tank and a top.
    hullTraverseAccelDegPerSec2: 14,
    // Rotating on the move is allowed but slower; at top speed traverse drops to ~70%.
    traverseSpeedPenalty: 0.3,
  },

  ground: {
    // Matches the terrain's typical gradient. Beyond this the vehicle stalls rather than climbing.
    maxClimbDeg: 26,
    // Descending is easier than climbing, so the vehicle can come down slopes it could not ascend.
    maxDescendDeg: 34,
    // Keeps ~40% of top speed at the climb limit: a hill visibly slows the tank as it steepens.
    climbSpeedRetention: 0.4,
    // Body height follows the ground quickly but not instantly, so cresting a ridge has a little
    // weight to it rather than snapping.
    suspensionStiffness: 14,
    suspensionDamping: 11,
  },

  turret: {
    // Faster than the hull, because a turret ring is lighter than the vehicle it sits on — but
    // still slow enough that a 90° swing takes real time. This is the number that most defines
    // whether the gun feels like a mechanism or like a mouse cursor.
    traverseDegPerSec: 32,
    // ~0.7 s to reach full traverse, so there is a visible ramp rather than an instant start.
    traverseAccelDegPerSec2: 45,
    // A deliberately generous arc. The owner asked for placeholder traverse characteristics and
    // explicitly said not to tune final balance yet, so this is wide enough not to surprise during
    // evaluation. The real traverse arc is a balance question for a later version.
    maxTraverseDeg: 200,
    // Height of the ring above the hull floor, which places the gun in world space.
    ringHeightM: 1.42,
  },

  mainGun: {
    // Limited elevation and depression, so some positions genuinely cannot be shot and some
    // targets can only be reached from a slope. Kept modest but real.
    maxElevationDeg: 15,
    maxDepressionDeg: 9,
    // ~2.2 s to swing through the full elevation arc, which is slow enough to feel mechanical.
    elevateRateDegPerSec: 11,
    // A long barrel, so the muzzle is clearly ahead of the hull and the shell appears to leave the
    // end of the gun rather than the middle of the tank.
    barrelLengthM: 4.2,
    // The tempo of the whole gunnery loop. Long enough that holding the trigger does nothing, short
    // enough that a player in a duel is not left waiting. A test default, not a balance decision.
    reloadSeconds: 4.5,
  },

  mainShell: {
    // Explicitly a placeholder test shell, not an ammunition type. See the note on
    // `TestShellDefinition` and OD-04.
    id: 'test-ballistic',
    displayName: 'Test Ballistic Shell',
    // Fast enough that drop is noticeable at a few hundred metres but not so fast that leading a
    // moving target becomes guesswork. Roughly 1.2 m of drop per 100 m at this speed.
    muzzleVelocityMps: 800,
    // Recorded for V3's penetration work; it does nothing in V2.
    massKg: 5,
    // Bounds the work one shot can cost and stops an upward shot flying forever.
    maxRangeM: 2500,
    maxLifetimeSeconds: 30,
    // Collision sampling interval. At 800 m/s a 60 Hz tick covers ~13 m, so without sub-stepping a
    // shell would pass straight through a hill. 1 m keeps the error below what the player or a
    // penetration calculation could notice.
    maxSubstepM: 1,
  },
};

// Validate at module load. A bad definition must stop the process, not produce a broken vehicle.
assertValidVehicleDefinition(PLACEHOLDER_TANK, PLACEHOLDER_TANK.id);

/** Ids of every vehicle available in V1. */
export const AVAILABLE_VEHICLE_IDS: readonly string[] = [PLACEHOLDER_TANK.id];
