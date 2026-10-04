import { assertValidVehicleDefinition } from '../vehicle-definition-schema.js';
import type { VehicleDefinition } from '../vehicle-definition.js';
import { vec3 } from '../vec3.js';

/**
 * **Sabre** — the V8 medium. The generalist.
 *
 * ## Why this vehicle exists
 *
 * A roster needs a middle. Every role needs something it is a departure *from*, and without a generalist
 * the departure has nothing to be legible against: "the heavy is slow" means nothing until the player has
 * driven something that is not. Sabre is that baseline, and it is deliberately the vehicle whose numbers the
 * V7 encounter was already balanced around, so the first duel a returning player fights behaves like the one
 * they remember while the vehicle around it has changed.
 *
 * ## Identity, in one line
 *
 * > Nothing to hide and nothing to boast.
 *
 * Its front plate is sloped but not extreme, its sides are the thinnest thing about it, its gun reloads fast
 * enough to be relevant and hits hard enough to matter, and it turns at a rate that makes a reposition
 * possible. Every one of those numbers is deliberately unremarkable. A medium that is good at something is a
 * specialist; a medium that is bad at everything is not a vehicle, it is an absence of one.
 *
 * ## Where the numbers come from
 *
 * These are the V1 placeholder's handling and armour values, kept deliberately unchanged. That is a
 * considered decision rather than laziness: V7 was owner-approved with these numbers playing correctly, and
 * changing them would conflate two questions. "Does the roster work?" and "is the medium still the right
 * medium?" are separable, and this version answers the first. Retuning the whole roster once three distinct
 * vehicles can be compared is the right moment for the second, and it needs all three present to be
 * meaningful.
 *
 * ## These are our tanks
 *
 * A fictional vehicle in broadly recognisable tank design language, not a reproduction of any real or
 * commercial tank. Nothing here is modelled on a specific historical machine, and no number is a statistic
 * from one. See `docs/asset-provenance.md`.
 */

/**
 * The Sabre's dimensions: a 6.7 m hull, 3.3 m across the tracks, 1.15 m of hull height.
 *
 * These are also the dimensions `tools/lib/tank-model.mjs` builds the medium model from, so the rendered
 * model and the simulation's collision and armour geometry agree by construction rather than by a rescale
 * that happens to land close.
 */
export const CT_MEDIUM: VehicleDefinition = {
  id: 'ct-medium',
  displayName: 'Sabre',
  visualId: 'ct-medium',

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
    // **360° for this placeholder**, per the owner's V3 decision. The data model still supports a
    // restricted arc, because a future casemate-style vehicle will genuinely need one; the decision
    // was that this generic tank should not have an arbitrary stop, not that the concept goes away.
    maxTraverseDeg: 360,
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

    // --- V3 penetration capability ------------------------------------------------------
    // Added when armour existed, so there was something for a penetration number to mean. Against
    // 100 mm of vertical armour this penetrates comfortably; against the 200 mm sloped front plate it
    // does not, which is what makes aiming matter.
    nominalPenetrationMm: 150,

    // Partial normalisation. At 1.0 an angled hit would cost this shell nothing, and only ricochet
    // would protect sloped armour; at 0.0 it would pay the full geometric penalty. Sitting in between
    // is what produces the intended lesson: sloping helps, but it is not invulnerable.
    normalization: 0.5,
  },

  survivability: {
    // Temporary placeholder values. Not final balance, and not statistics for any real vehicle.
    hitPoints: 1000,
    // Fixed per penetration, deliberately. See the note on `damagePerPenetration`.
    damagePerPenetration: 150,
    modules: [
      {
        id: 'engine',
        label: 'Engine',
        hitPoints: 200,
        // Rear of the hull, so it is reached through the rear plate — a real consequence of layout.
        centerM: vec3(0, 0.5, -2.4),
        radiusM: 1.1,
        effect: 'engine',
      },
      {
        id: 'track-left',
        label: 'Left track',
        hitPoints: 120,
        centerM: vec3(-1.35, 0.35, 0),
        radiusM: 1,
        effect: 'track',
      },
      {
        id: 'track-right',
        label: 'Right track',
        hitPoints: 120,
        centerM: vec3(1.35, 0.35, 0),
        radiusM: 1,
        effect: 'track',
      },
      {
        id: 'gun',
        label: 'Gun',
        hitPoints: 150,
        // In the turret, so it follows the turret's heading and is hit by shooting the turret face.
        centerM: vec3(0, 1.42, 0.4),
        radiusM: 1.1,
        effect: 'gun',
      },
      {
        id: 'ammunition',
        label: 'Ammunition',
        hitPoints: 100,
        // Amidships on the left. Damage state only in V3; the explosion is deferred, so the effect is
        // recorded honestly as 'none' rather than pretending something happens.
        centerM: vec3(-0.7, 0.5, -0.2),
        radiusM: 0.9,
        effect: 'ammunition',
      },
    ],
  },

  armor: [
    // --- Hull ---------------------------------------------------------------------------
    // Sloped front. `pitchDeg: 60` leans it back, which presents more thickness to a head-on shot
    // and is the single most important thing to understand about this layout.
    {
      id: 'hull-front',
      region: 'hull-front',
      mount: 'hull',
      thicknessMm: 200,
      centerM: vec3(0, 0.85, 2.1),
      widthM: 2.4,
      heightM: 1.5,
      yawDeg: 0,
      pitchDeg: 60,
    },
    // Sides are vertical, thinner, and therefore the easy place to penetrate. Each faces **outward**:
    // the left plate sits at -X and its normal points -X. `yawDeg: -90` turns the plate's local +Z
    // normal onto world -X.
    {
      id: 'hull-left',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 80,
      centerM: vec3(-1.3, 0.6, 0),
      widthM: 4.2,
      heightM: 1.2,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'hull-right',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 80,
      centerM: vec3(1.3, 0.6, 0),
      widthM: 4.2,
      heightM: 1.2,
      yawDeg: 90,
      pitchDeg: 0,
    },
    // Rear is thin and vertical, and sits over the engine.
    {
      id: 'hull-rear',
      region: 'hull-rear',
      mount: 'hull',
      thicknessMm: 50,
      centerM: vec3(0, 0.6, -2.4),
      widthM: 2.4,
      heightM: 1.2,
      yawDeg: 180,
      pitchDeg: 0,
    },
    // Floor plate, so shooting slightly down at a close target is not a free shot.
    {
      id: 'hull-floor',
      region: 'hull-floor',
      mount: 'hull',
      thicknessMm: 20,
      centerM: vec3(0, 0, 0),
      widthM: 2.4,
      heightM: 4.2,
      // Lying flat: the plate's own Y axis becomes the vehicle's Z, so "pitch 90" lays it down.
      yawDeg: 0,
      pitchDeg: -90,
    },
    // --- Turret ------------------------------------------------------------------------
    // Face is sloped and thick; sides and rear are not. The classic profile.
    {
      id: 'turret-front',
      region: 'turret-front',
      mount: 'turret',
      thicknessMm: 180,
      centerM: vec3(0, 0.35, 1.05),
      widthM: 2,
      heightM: 0.95,
      yawDeg: 0,
      pitchDeg: 55,
    },
    {
      id: 'turret-left',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 70,
      centerM: vec3(-1.05, 0.35, -0.15),
      widthM: 2.1,
      heightM: 0.95,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'turret-right',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 70,
      centerM: vec3(1.05, 0.35, -0.15),
      widthM: 2.1,
      heightM: 0.95,
      yawDeg: 90,
      pitchDeg: 0,
    },
    {
      id: 'turret-rear',
      region: 'turret-rear',
      mount: 'turret',
      thicknessMm: 60,
      centerM: vec3(0, 0.35, -1.25),
      widthM: 2,
      heightM: 0.95,
      yawDeg: 180,
      pitchDeg: 0,
    },
  ],

  penetration: {
    // The speed at which nominal penetration applies unchanged. Set to the test shell's muzzle
    // velocity so a close-range shot penetrates exactly as quoted.
    referenceVelocityMps: 800,
    // Temporary engineering value. A shell arriving at 75° or steeper deflects instead of biting.
    ricochetThresholdDeg: 75,
  },

  // Every multiplier is exactly 1.0, which is the point: **Sabre is the reference the other two are
  // described against.** The heavy's engine is 0.72× this one and the light's is 1.34× it, and those
  // numbers are only meaningful because there is a defined baseline to be relative to. Changing one of
  // these changes what "neutral" sounds like for the whole roster, which is worth knowing before anyone
  // tunes it — see the note on `VehicleAudioProfile`.
  audio: {
    enginePitchScale: 1.0,
    engineGainScale: 1.0,
    trackGainScale: 1.0,
    gunGainScale: 1.0,
    gunPitchScale: 1.0,
    turretGainScale: 1.0,
  },
};

// Validate at module load. A bad definition must stop the process, not produce a broken vehicle.
assertValidVehicleDefinition(CT_MEDIUM, CT_MEDIUM.id);
