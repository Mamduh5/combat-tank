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
};

// Validate at module load. A bad definition must stop the process, not produce a broken vehicle.
assertValidVehicleDefinition(PLACEHOLDER_TANK, PLACEHOLDER_TANK.id);

/** Ids of every vehicle available in V1. */
export const AVAILABLE_VEHICLE_IDS: readonly string[] = [PLACEHOLDER_TANK.id];
