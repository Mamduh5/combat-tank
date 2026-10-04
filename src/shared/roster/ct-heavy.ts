import { assertValidVehicleDefinition } from '../vehicle-definition-schema.js';
import type { VehicleDefinition } from '../vehicle-definition.js';
import { vec3 } from '../vec3.js';

/**
 * **Anvil** â€” the V8 heavy. The bruiser.
 *
 * ## Identity, in one line
 *
 * > Front armour decides the argument.
 *
 * The heavy is not "the medium but tougher". Every one of its numbers says the same thing, and they say it
 * through three independent systems at once: its **front** is nearly unpenetrable at a frontal engagement,
 * its **movement** is slow and expensive, and its **gun** is slow to reload but hits like the argument is
 * already over. That coherence is the whole design. A vehicle that is merely tougher is a stat block; a
 * vehicle whose armour, mobility and firepower all point at one tactical idea is a role.
 *
 * ## The three costs, stated honestly
 *
 *  - **Everything takes longer.** Hull traverse is roughly half the medium's, turret traverse is barely
 *    half, and the gun reloads in 7.5 s against the medium's 4.5. In a duel that is a third fewer shots.
 *  - **It cannot chase.** Top speed is 7.2 m/s against the light's 16.5. If the enemy keeps moving, the
 *    heavy does not get a second engagement; it gets the one it has.
 *  - **It cannot disengage either.** Slow traverse plus slow speed means backing out of a bad angle is a
 *    multi-second commitment. Once Anvil is pointed at something, it stays pointed at it.
 *
 * Those three costs are the same cost seen from three angles, and they compound. That is intentional: the
 * heavy is meant to feel like a decision rather than a choice.
 *
 * ## Why its front plate is 340 mm
 *
 * Because it is the only shot the heavy reliably wins, and a role needs a reliable answer. At 340 mm on a
 * 66Â° slope the plate presents **836 mm** of effective armour to a square-on hit, which no shell in the
 * roster defeats â€” the heavy's own 285 mm gun included. A frontal engagement against Anvil is a stalemate
 * by construction, which forces the fight to move to geometry: the flank, where the 150 mm side plate gives
 * up 150 mm and everything works again.
 *
 * This is the "solve armour by tactics, not by thinning armour" principle (ADR-0016) applied to a vehicle
 * rather than to a shot. The heavy does not become formidable because its numbers went up; it becomes
 * formidable because a position in front of it is a position worth having.
 *
 * ## These are our tanks
 *
 * A fictional vehicle in broadly recognisable heavy-tank design language, not a reproduction of any real or
 * commercial tank. No number here is a statistic from any historical machine. See
 * `docs/asset-provenance.md`.
 */
/**
 * The Anvil's dimensions: 7.6 m long, 3.5 m wide, and â€” the important one â€” 1.2 m of **hull** height.
 *
 * The hull is the tallest in the roster, and that is a gameplay fact rather than a cosmetic one: `ringHeightM`
 * below is measured from the hull floor, so a taller hull puts the turret ring and therefore the gun higher
 * in the world. That matters because the spotting system uses the ring height as the vehicle's eye, and the
 * HUD and AI both read it. A taller heavy can see over a berm a light cannot, which is part of why a position
 * in front of it is worth taking.
 *
 * These are the same dimensions `tools/lib/tank-model.mjs` builds the heavy model from, so the rendered
 * model and the simulation agree by construction.
 */
export const CT_HEAVY: VehicleDefinition = {
  id: 'ct-heavy',
  displayName: 'Anvil',
  visualId: 'ct-heavy',

  dimensions: {
    lengthM: 7.6,
    widthM: 3.5,
    heightM: 1.2,
    // A heavy sits lower over the ground in proportion to its mass, and the extra clearance is a
    // handling cost: this is the number the track-conforming code reads to keep the hull off the terrain.
    groundClearanceM: 0.52,
  },

  powertrain: {
    // 52 t. Deliberately a little over 50 so the mass reads as a different order rather than a nudged one.
    massKg: 52_000,
    // 96 kN on 52 t is **1.85 m/s^2**, against the medium's 2.44 and the light's 3.51. That is the whole
    // heavy in one number: it does not accelerate like a different tank, it accelerates like a heavier one.
    driveForceN: 96_000,
    // 7.2 m/s (~26 km/h). Slow enough that the light can leave, and the player notices when it does.
    maxSpeedMps: 7.2,
    // Reverse barely over 40% of forward. A tracked vehicle with one reverse gear is already
    // disadvantaged going backwards; making it worse is what makes "retreat" a decision, not a manoeuvre.
    maxReverseSpeedMps: 3.0,
    // Brakes are strong in absolute terms but weak relative to the mass, so a heavy takes longer to stop
    // from speed than the medium does. Overbraking it would erase the feeling entirely.
    brakeDecelMps2: 6.0,
    // Very low coast deceleration. The heavy coasts a long way once the throttle is released, which is
    // the clearest single expression of "this is heavy" in the whole definition.
    coastDecelMps2: 0.3,
  },

  traversal: {
    // 14Â°/s against the medium's 26. A quarter turn is over six seconds. This is not a vehicle that
    // re-aims; it is a vehicle that commits to an angle and lives with it.
    hullTraverseDegPerSec: 14,
    // Slow to spool up as well as slow at full rate, so even a small correction is a decision.
    hullTraverseAccelDegPerSec2: 7,
    // The heaviest penalty in the roster: at top speed the hull turns at barely half its rate. Trying to
    // rotate while driving a heavy is how a heavy player ends up crossing a field sideways.
    traverseSpeedPenalty: 0.55,
  },

  ground: {
    // The worst climb in the roster by eight degrees. Combined with the slow acceleration this is a
    // vehicle that gets *stuck* on Marlowe Crossing's bank approaches rather than merely slowing on them.
    maxClimbDeg: 18,
    maxDescendDeg: 26,
    // At the climb limit it retains more speed than the medium relative to its own top speed, which is
    // not a contradiction: it is already so slow that losing another 45% of 7.2 m/s is 4 m/s, and a
    // vehicle that cannot accelerate cannot use the retention anyway.
    climbSpeedRetention: 0.55,
    // The softest suspension in the roster and the least damped. A heavy hull follows the ground slowly
    // and rocks over bumps, which is visible in the model and felt through the camera.
    suspensionStiffness: 8,
    suspensionDamping: 8,
  },

  turret: {
    // 16Â°/s against the medium's 32. Barely half. A 90Â° swing takes five and a half seconds, which is
    // long enough that a circling medium can stay behind it â€” and that is the heavy's intended weakness,
    // paid for deliberately rather than accidentally.
    traverseDegPerSec: 16,
    traverseAccelDegPerSec2: 18,
    // Full ring. The heavy is slow, not restricted: a vehicle this slow would be unplayable *and*
    // frustrating if its traverse arc were also limited, because the player could not even look at the
    // threat they are being flanked by.
    maxTraverseDeg: 360,
    // 1.72 m, the highest in the roster. The hull floor plus this is what the spotting system uses as the
    // heavy's eye height, so it sees over cover the light cannot see over.
    ringHeightM: 1.72,
  },

  mainGun: {
    // Slower elevation than anything else in the roster. Firing at a distant light is a commitment to
    // hold the gun on target while it comes round, which is most of why the heavy cannot chase.
    maxElevationDeg: 13,
    maxDepressionDeg: 7,
    elevateRateDegPerSec: 8,
    // The longest barrel in the roster at 5.9 m, against a 7.6 m hull. Visually this is the single
    // clearest silhouette cue that the vehicle is the heavy one, and it is also what gives the gun the
    // flattest trajectory of the three.
    barrelLengthM: 5.9,
    // **7.5 s.** The heaviest number in the roster and the heavy's sharpest cost: in a two-minute duel the
    // heavy gets sixteen shots where the medium gets twenty-six and the light gets forty. Against a light
    // that simply avoids being hit, the heavy can run out of time.
    reloadSeconds: 7.5,
  },

  mainShell: {
    // Still the generic test shell â€” V8 explicitly does not introduce an ammunition roster (OD-04). What
    // differs between vehicles is the shell's *capability numbers*, not its type, which is the smallest
    // honest change that produces genuinely different gun behaviour.
    id: 'test-ballistic',
    displayName: 'Test Ballistic Shell',
    // Slightly slower than the medium's 800 m/s. A heavy shell in this model is a bigger, slower
    // projectile: more drop over distance, which rewards the heavy for fighting at close range.
    muzzleVelocityMps: 760,
    massKg: 12,
    maxRangeM: 2500,
    maxLifetimeSeconds: 30,
    maxSubstepM: 1,

    // 285 mm nominal: enough to defeat every plate in the roster from the flank and rear, and not enough
    // to defeat the heavy's own 340 mm frontal plate. That asymmetry is what makes the flank the answer
    // to the heavy rather than a formality.
    //
    // **285 and not 260**, for a measured reason. At 260 the heavy's gun against a parked medium's glacis
    // came out at 400.1 mm of penetration against 400 mm of plate — a 0.1 mm margin on a comparison that
    // also loses a few percent to shell drop over any real distance. It read as "the heavy can kill a
    // parked medium" in the model and as "it cannot" in the simulation, which is the worst possible
    // disagreement. 285 puts ~38 mm between them at the muzzle, which is a decision rather than a coin.
    nominalPenetrationMm: 285,
    // Better normalisation than the medium's 0.5, which is what lets it work against sloped armour at all.
    // Without this the heavy's advantage would evaporate on exactly the surfaces it is designed around.
    normalization: 0.62,
  },

  survivability: {
    // 1600 HP against the medium's 1000 and the light's 620. At 260 damage per penetration that is just
    // over six clean hits to kill â€” comparable to the medium's 1000/150, so the heavy is not simply
    // "harder to kill", it is harder to kill *and* slower to do it to.
    hitPoints: 1600,
    // The heaviest hit in the roster. One penetration is 260, which is 26% of a medium's entire
    // survivability: a heavy that lands two shots on a light wins outright.
    damagePerPenetration: 260,
    // A deliberately **different module layout** from the other two, not the same five modules with
    // bigger numbers. The heavy has no ammunition module â€” a vehicle this size would carry its rounds
    // where the rear plate protects them, and an ammunition module whose effect is 'ammunition', which V8
    // does not simulate, is a module that exists only to be looked at. What the heavy has instead is a
    // **single central transmission** between the tracks, which is a real consequence of a single-engine,
    // torque-tube layout and gives the flank shots the light relies on something to actually break.
    modules: [
      {
        id: 'transmission',
        label: 'Transmission',
        hitPoints: 300,
        // Centred between the tracks and slightly forward of the engine, so a flank shot reaches it and a
        // frontal one does not. Its whole purpose is to make the heavy's flank weakness bite.
        centerM: vec3(0, 0.45, -0.6),
        radiusM: 1.2,
        effect: 'engine',
      },
      {
        id: 'track-left',
        label: 'Left track',
        // Tougher than the medium's 120. A heavy that can absorb track damage without losing mobility is a
        // heavy that keeps fighting from the position it earned, which is the fantasy.
        hitPoints: 170,
        centerM: vec3(-1.45, 0.35, 0),
        radiusM: 1.05,
        effect: 'track',
      },
      {
        id: 'track-right',
        label: 'Right track',
        hitPoints: 170,
        centerM: vec3(1.45, 0.35, 0),
        radiusM: 1.05,
        effect: 'track',
      },
      {
        id: 'gun',
        label: 'Gun',
        // The heaviest gun module in the roster. Losing it on a heavy ends the exchange entirely, which
        // is the correct severity for the vehicle whose whole identity is its gun.
        hitPoints: 200,
        centerM: vec3(0, 1.72, 0.5),
        radiusM: 1.15,
        effect: 'gun',
      },
    ],
  },

  // --- Armour ---------------------------------------------------------------------------------
  //
  // The layout is the heavy's identity, so these are not the medium's plates with larger numbers. The three
  // differences that matter, in the order a player meets them:
  //
  //  1. **The front is a different shape, not a thicker version of the same one.** 340 mm at `pitchDeg: 66`,
  //     against the medium's 200 mm at 60. The angle is the larger half of the difference: 66 degrees
  //     presents `1 / cos 66 = 2.46x` the nominal thickness, so the plate is worth 836 mm to a square-on
  //     shot.
  //  2. **The sides are the weak point, and they are weak on purpose.** 150 mm vertical, where the medium's
  //     are 80. They are the thinnest thing on the vehicle *relative to its own front*, which is what makes
  //     flanking it correct rather than merely possible.
  //  3. **The rear is a different size and a different exposure.** A wide, near-vertical 80 mm plate over
  //     the engine, set further back than the medium's, so a shot that just clears the hull side does not
  //     also catch the rear.
  armor: [
    // Front: the shot-stopper. See the effective-armour arithmetic in the file header.
    {
      id: 'heavy-hull-front',
      region: 'hull-front',
      mount: 'hull',
      thicknessMm: 340,
      // Slightly further forward than the medium's, matching the longer hull.
      centerM: vec3(0, 0.95, 2.6),
      widthM: 2.8,
      heightM: 1.7,
      yawDeg: 0,
      pitchDeg: 66,
    },
    // Sides: vertical and comparatively thin. 150 mm defeats the medium's shell and the light's, which is
    // what makes the flank the answer, but it is nothing like what the front presents.
    {
      id: 'heavy-hull-left',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 150,
      centerM: vec3(-1.45, 0.65, 0),
      widthM: 5.2,
      heightM: 1.35,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'heavy-hull-right',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 150,
      centerM: vec3(1.45, 0.65, 0),
      widthM: 5.2,
      heightM: 1.35,
      yawDeg: 90,
      pitchDeg: 0,
    },
    // Rear: wide, near-vertical, over the engine. The reward for getting behind a heavy.
    {
      id: 'heavy-hull-rear',
      region: 'hull-rear',
      mount: 'hull',
      thicknessMm: 80,
      centerM: vec3(0, 0.65, -3.0),
      widthM: 2.8,
      heightM: 1.35,
      yawDeg: 180,
      pitchDeg: 0,
    },
    // Floor: thicker than the others', so shooting down at a heavy from high ground is not free.
    {
      id: 'heavy-hull-floor',
      region: 'hull-floor',
      mount: 'hull',
      thicknessMm: 30,
      centerM: vec3(0, 0, 0),
      widthM: 2.8,
      heightM: 5.2,
      yawDeg: 0,
      pitchDeg: -90,
    },
// --- Turret: thicker than the hull's sides, and sloped on the face --------------------------
    // The turret is the heavy's second line. 280 mm at 58 degrees presents 528 mm, so shooting a heavy's
    // turret face head-on also fails — the heavy does not present a soft spot at eye level either.
    {
      id: 'heavy-turret-front',
      region: 'turret-front',
      mount: 'turret',
      thicknessMm: 280,
      centerM: vec3(0, 0.45, 1.35),
      widthM: 2.4,
      heightM: 1.05,
      yawDeg: 0,
      pitchDeg: 58,
    },
    {
      id: 'heavy-turret-left',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 160,
      centerM: vec3(-1.25, 0.45, -0.2),
      widthM: 2.4,
      heightM: 1.05,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'heavy-turret-right',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 160,
      centerM: vec3(1.25, 0.45, -0.2),
      widthM: 2.4,
      heightM: 1.05,
      yawDeg: 90,
      pitchDeg: 0,
    },
    // The turret rear is the thickest part of the turret: 190 mm, thicker than the hull's rear plate. On a
    // vehicle this size that is deliberate — the turret rear is the exposed part of the fighting
    // compartment, and it is where a heavy's crew is most vulnerable to a following shot.
    {
      id: 'heavy-turret-rear',
      region: 'turret-rear',
      mount: 'turret',
      thicknessMm: 190,
      centerM: vec3(0, 0.45, -1.55),
      widthM: 2.4,
      heightM: 1.05,
      yawDeg: 180,
      pitchDeg: 0,
    },
  ],

  penetration: {
    referenceVelocityMps: 760,
    ricochetThresholdDeg: 75,
  },

  // The heavy's audio identity: lower, louder, and heavier everywhere.
  //
  // `enginePitchScale: 0.72` is the main one. The shared V7 engine recording is a mid-tone loop; dropping
  // its pitch by nearly a third turns the same recording into something that reads as a large slow diesel
  // under load, without a single new sample. It is bounded above 0.5 in the schema because below that the
  // loop stops sounding like an engine at all and starts sounding like a slowed tape.
  audio: {
    enginePitchScale: 0.72,
    // Louder, because there is more of it.
    engineGainScale: 1.15,
    // The heaviest track sound in the roster: more metal being dragged over more ground.
    trackGainScale: 1.3,
    // A bigger gun is a louder gun. This is the single most audible difference between the heavy and the
    // others, and it is heard from the moment the shell leaves the barrel.
    gunGainScale: 1.35,
    // ...and a lower one. 0.78 is the difference between a crack and a thump, and it is why a heavy firing
    // across a valley sounds like an event rather than a shot.
    gunPitchScale: 0.78,
    // A quiet, low servo groan. The heavy's turret moves at 16 deg/s, so it is both slower and quieter
    // than the others; a loud servo on a slow turret would suggest agility the vehicle does not have.
    turretGainScale: 0.7,
  },
};

// Validate at module load. A bad definition must stop the process, not produce a broken vehicle.
assertValidVehicleDefinition(CT_HEAVY, CT_HEAVY.id);
