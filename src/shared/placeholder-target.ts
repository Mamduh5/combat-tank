import { PLACEHOLDER_TANK } from './placeholder-tank.js';
import { vec3 } from './vec3.js';
import type { VehicleDefinition } from './vehicle-definition.js';

/**
 * The V3 test target: a stationary tank to shoot at.
 *
 * This exists so the player can validate armour, penetration and damage by hand. It is deliberately
 * **not an opponent**: it does not move, aim, fire, or decide anything. That boundary is the whole
 * point — V4 is where a fighting enemy arrives, and nothing here should make that version's job easier
 * by quietly doing part of it.
 *
 * It is a **separate data file**, not a variant of the player's tank, because that is the proof that
 * vehicles really are data: this vehicle exists purely by being described differently. If a future game
 * needs a casemate-style vehicle with a restricted turret arc and a fixed gun, this is the shape that
 * change would take.
 *
 * ## Armour differences, and why they matter
 *
 * The target is deliberately **not** the same tank. It has a thicker, less sloped front plate and a thin,
 * flat rear, which produces the outcomes the version needs to be demonstrable:
 *
 *  - front plate: **blocked** at close range — the shell bounces off
 *  - side plate: **penetrated** — the obvious flank shot works
 *  - rear plate: **penetrated**, and reaches the engine module
 *
 * A target with the player's own armour would let the player conclude that aiming does not matter,
 * which is the opposite of what V3 exists to teach.
 */

/** Stationary-target variant of the placeholder tank's handling numbers. */
export const TARGET_TANK: VehicleDefinition = {
  ...PLACEHOLDER_TANK,

  id: 'placeholder-target',
  displayName: 'Target Tank',

  // Held still by the simulation rather than by zero power, so the turret and gun still work and the
  // vehicle still settles onto the ground properly.
  powertrain: {
    ...PLACEHOLDER_TANK.powertrain,
    maxSpeedMps: 0,
    maxReverseSpeedMps: 0,
  },

  turret: {
    ...PLACEHOLDER_TANK.turret,
    // A casemate-style restriction, kept deliberately so the model's ability to express a limited gun
    // arc is exercised rather than only ever being configured at 360°.
    maxTraverseDeg: 90,
  },

  survivability: {
    ...PLACEHOLDER_TANK.survivability,
    // Fewer hit points than the player's tank, so the target can be destroyed within a sensible number
    // of penetrating shots during a single test session.
    hitPoints: 700,
    damagePerPenetration: 150,
    modules: [
      {
        id: 'engine',
        label: 'Engine',
        hitPoints: 150,
        // Directly behind the rear plate, so a rear shot reaches it and a front shot does not.
        centerM: vec3(0, 0.5, -2.4),
        radiusM: 1.1,
        effect: 'engine',
      },
      {
        id: 'track-left',
        label: 'Left track',
        hitPoints: 100,
        centerM: vec3(-1.35, 0.35, 0),
        radiusM: 1,
        effect: 'track',
      },
      {
        id: 'track-right',
        label: 'Right track',
        hitPoints: 100,
        centerM: vec3(1.35, 0.35, 0),
        radiusM: 1,
        effect: 'track',
      },
      {
        id: 'gun',
        label: 'Gun',
        hitPoints: 120,
        // In the turret, so it follows the turret's heading.
        centerM: vec3(0, 1.42, 0.4),
        radiusM: 1.1,
        effect: 'gun',
      },
    ],
  },

  armor: [
    // Thicker and far less sloped than the player's front plate: this is the plate that stops shots,
    // and it is meant to. A pitch of 25° presents much less thickness than the player's 60°.
    {
      id: 'target-hull-front',
      region: 'hull-front',
      mount: 'hull',
      thicknessMm: 220,
      centerM: vec3(0, 0.85, 2.1),
      widthM: 2.4,
      heightM: 1.5,
      yawDeg: 0,
      pitchDeg: 25,
    },
    // Sides are thin and vertical, so the flank is the reliable shot. Each faces outward: the left plate
    // sits at -X and its normal points -X.
    {
      id: 'target-hull-left',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 50,
      centerM: vec3(-1.3, 0.6, 0),
      widthM: 4.2,
      heightM: 1.2,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'target-hull-right',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 50,
      centerM: vec3(1.3, 0.6, 0),
      widthM: 4.2,
      heightM: 1.2,
      yawDeg: 90,
      pitchDeg: 0,
    },
    // Very thin and flat, and sits over the engine: the reward for getting behind.
    {
      id: 'target-hull-rear',
      region: 'hull-rear',
      mount: 'hull',
      thicknessMm: 30,
      centerM: vec3(0, 0.6, -2.4),
      widthM: 2.4,
      heightM: 1.2,
      yawDeg: 180,
      pitchDeg: 0,
    },
    // --- Turret ------------------------------------------------------------------------
    // Thin everywhere. The turret on this target is deliberately not a second front plate, so the
    // player's lesson is about the hull's layout rather than "always shoot the turret".
    {
      id: 'target-turret-front',
      region: 'turret-front',
      mount: 'turret',
      thicknessMm: 120,
      centerM: vec3(0, 0.35, 1.05),
      widthM: 2,
      heightM: 0.95,
      yawDeg: 0,
      pitchDeg: 20,
    },
    {
      id: 'target-turret-left',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 40,
      centerM: vec3(-1.05, 0.35, -0.15),
      widthM: 2.1,
      heightM: 0.95,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'target-turret-right',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 40,
      centerM: vec3(1.05, 0.35, -0.15),
      widthM: 2.1,
      heightM: 0.95,
      yawDeg: 90,
      pitchDeg: 0,
    },
    {
      id: 'target-turret-rear',
      region: 'turret-rear',
      mount: 'turret',
      thicknessMm: 35,
      centerM: vec3(0, 0.35, -1.25),
      widthM: 2,
      heightM: 0.95,
      yawDeg: 180,
      pitchDeg: 0,
    },
  ],

  penetration: {
    referenceVelocityMps: PLACEHOLDER_TANK.penetration.referenceVelocityMps,
    ricochetThresholdDeg: PLACEHOLDER_TANK.penetration.ricochetThresholdDeg,
  },
};