import { assertValidVehicleDefinition } from '../vehicle-definition-schema.js';
import type { VehicleDefinition } from '../vehicle-definition.js';
import { vec3 } from '../vec3.js';

/**
 * **Vex** — the V8 light. The scout.
 *
 * ## Identity, in one line
 *
 * > Be somewhere else already.
 *
 * The light is the only vehicle in the roster that wins by not being where the gun is pointed. Everything
 * about it is tuned towards that: it is the fastest thing on the map by a factor of two, its turret comes
 * round in under two seconds for a quarter turn, and its hull changes direction faster than the medium's
 * gun can follow. What it cannot do is absorb a mistake — 620 hit points is under two heavy penetrations
 * and barely five of its own — so every advantage it has is rented against a very short loan.
 *
 * ## Why this is not just "fast"
 *
 * Speed alone is not an identity; it is a stat that makes a vehicle annoying. Three things have to be true
 * together for a light to be a *role* rather than a nuisance:
 *
 *  - **It must be able to choose not to fight.** The fast reload (3.2 s, the shortest in the roster) and
 *    quick turret mean it can take three shots and leave before the enemy's second lands. A slow-firing fast
 *    vehicle is just a bad medium.
 *  - **It must be punished for staying.** The armour is thin everywhere and the hull traverse, while fast,
 *    has the heaviest speed penalty in the roster at 0.45: turning at speed is exactly how a light dies,
 *    because the fast turn is what puts its thin flank in front of the gun it just missed.
 *  - **It must have somewhere to go.** The best climb limit in the roster, 34 degrees, means the routes the
 *    heavy cannot follow are the routes the light uses to disengage. Without that, mobility is only useful
 *    in open ground.
 *
 * ## Why its front plate is only 90 mm
 *
 * Because armour that stops a shot is armour that stops the light from moving, and a light that cannot be
 * shot is not a light. At 90 mm on a 24 degree slope the plate presents 99 mm — thin, but not trivially
 * thin. The medium's 150 mm shell defeats it comfortably; the light's own 135 mm defeats it only just. So
 * the light is killable in a frontal exchange, and the player's answer to a light is simply to shoot it
 * rather than out-turn it, which is the whole counter to a fast vehicle and is worth being able to do.
 *
 * ## These are our tanks
 *
 * A fictional vehicle in broadly recognisable light-tank design language, not a reproduction of any real
 * or commercial tank. No number here is a statistic from any historical machine. See
 * `docs/asset-provenance.md`.
 */
/**
 * The Vex's dimensions: 5.4 m long, 2.9 m wide, 1.0 m of hull height.
 *
 * The smallest vehicle in the roster by a clear margin — 19% shorter than the medium, 21% narrower than
 * the heavy. That size difference is load-bearing in three places at once: it is the silhouette the player
 * identifies at range, it is the difference between fitting down Marlowe Crossing's alley routes and not,
 * and it is what `validateRoster` checks when it refuses a roster of reskins.
 *
 * `tools/lib/tank-model.mjs` builds the light model from exactly these dimensions.
 */
export const CT_LIGHT: VehicleDefinition = {
  id: 'ct-light',
  displayName: 'Vex',
  visualId: 'ct-light',

  dimensions: {
    lengthM: 5.4,
    widthM: 2.9,
    heightM: 1.0,
    // Higher off the ground than anything else in the roster, and that is not a styling choice: a light
    // vehicle on short suspension has to clear the ground it spends its life on, and the extra clearance
    // is why it can cross terrain that stops a heavy dead.
    groundClearanceM: 0.44,
  },

  powertrain: {
    // 14 t. Less than a third of the heavy's mass, which is what makes the drive force below worth
    // anything: the same force on this mass is nearly four times the acceleration.
    massKg: 14_000,
    // 49 kN on 14 t is **3.5 m/s^2**, against the medium's 2.44 and the heavy's 1.85. The light is not
    // described as "the heavy but faster" anywhere in this file; it is described as a light vehicle that
    // happens to be quick, and the acceleration is what that means.
    driveForceN: 49_000,
    // 16.5 m/s (~59 km/h). More than twice the heavy's top speed and half again the medium's. On
    // Marlowe Crossing's 400 m of open ground that is the difference between choosing where to fight and
    // having the position chosen for you.
    maxSpeedMps: 16.5,
    // Reverse at almost half of forward, and the *only* vehicle in the roster whose reverse is worth
    // using: at 8.0 m/s the light reverses away faster than the medium can drive forward, which is what
    // makes "shoot and reverse" a real tactic on this vehicle rather than a bad habit.
    maxReverseSpeedMps: 8.0,
    // The strongest brakes in the roster. Combined with the low mass this is what lets a light stop
    // inside the distance it covered in two seconds, which is the mechanical basis for disengaging.
    brakeDecelMps2: 10.5,
    // The weakest engine braking: the light stops when you tell it to and not otherwise.
    coastDecelMps2: 0.9,
  },

  traversal: {
    // 42 deg/s, against the medium's 26 and the heavy's 14. A quarter turn in 2.1 seconds. This is the
    // second half of the light's identity: it can leave a position it has just been shot at.
    hullTraverseDegPerSec: 42,
    // And it reaches that rate in under a second, so the fast turn is available immediately rather than
    // after a ramp — which matters, because the moment a light most wants to turn is the moment it most
    // wants to turn *now*.
    hullTraverseAccelDegPerSec2: 36,
    // 0.45, the heaviest penalty in the roster and the light's most important number after its speed.
    // At top speed the hull turns at 23 deg/s — still quicker than the medium's turret. The consequence is
    // that a light driving fast across an enemy's front presents its flank at 23 deg/s, and 90 mm is not
    // much armour to present at anything. Speed and turning are not independent skills here; they are one
    // risk.
    traverseSpeedPenalty: 0.45,
  },

  ground: {
    // The best climb in the roster by eight degrees, and eight degrees is a lot here. The medium stalls at
    // 26 and the heavy at 18, so the 28–34 band is terrain the light crosses and the others cannot. That
    // band is where the light's disengagement actually happens.
    maxClimbDeg: 34,
    // Descending is easier, as for every vehicle, and the light's is the most generous in the roster.
    maxDescendDeg: 42,
    // Retains the most speed on a climb: 0.6, against the medium's 0.4. A light climbing a steep bank
    // arrives at the top with most of its speed intact, which is what makes those routes usable at all.
    climbSpeedRetention: 0.6,
    // The stiffest, best-damped suspension in the roster. A light hull does not wallow; it skips, and it
    // settles the instant it lands. This is visible in the track conforming and in how the body pitches.
    suspensionStiffness: 22,
    suspensionDamping: 15,
  },

  turret: {
    // 48 deg/s, the fastest in the roster by half again. A quarter turn in under two seconds. Against the
    // medium's 32 and the heavy's 16, this is the third system saying the same thing the speed says:
    // the light gets its gun onto a target sooner than anything can stop it getting it there.
    traverseDegPerSec: 48,
    // Very quick off the mark, so a small correction is nearly instant.
    traverseAccelDegPerSec2: 75,
    maxTraverseDeg: 360,
    // The lowest ring in the roster at 1.15 m, so the light's eye — and therefore what it can see over —
    // is the lowest. It is the best vehicle across open ground and the worst one behind cover, and that is
    // a real trade the player has to make rather than a strict improvement.
    ringHeightM: 1.15,
  },
mainGun: {
    // The highest elevation and depression in the roster. A light on high ground can shoot down into a
    // valley position a heavy's gun physically cannot reach, and can depress into a hull-down arc the
    // medium has to expose itself to match. Gun arc is a mobility-adjacent advantage here, which is an
    // unusual and deliberate pairing: the fast vehicle is also the one that can use awkward ground.
    maxElevationDeg: 20,
    maxDepressionDeg: 11,
    // The fastest elevation in the roster, consistent with the fastest turret: the light's whole
    // gunnery loop is built to be started and abandoned quickly.
    elevateRateDegPerSec: 17,
    // 3.2 m, the shortest barrel. Visually this is a stubby gun on a small turret, which is half of why
    // the light reads as a different vehicle at 200 m rather than a smaller version of the medium.
    barrelLengthM: 3.2,
    // **3.2 s, the shortest reload in the roster.** Against the medium's 4.5 and the heavy's 7.5 this is
    // the light's one offensive weapon: it can put three shells into a target and be gone before the
    // enemy's second shot arrives. The tactical cost is that each shell is weak (135 mm, 105 damage), so
    // the light's burst only kills if every shot lands.
    reloadSeconds: 3.2,
  },

  mainShell: {
    // The same generic test shell type as every other vehicle — V8 introduces no ammunition roster (OD-04).
    // Only the capability numbers differ, which is the smallest honest change that makes the gun feel
    // like a different gun.
    id: 'test-ballistic',
    displayName: 'Test Ballistic Shell',
    // The fastest muzzle velocity in the roster at 880 m/s. Almost flat trajectory, so the light's shots
    // arrive where they were aimed even at range — which matters, because a light that has to lead a
    // target it is also trying to outrun has no time to be wrong twice.
    muzzleVelocityMps: 880,
    massKg: 3,
    maxRangeM: 2500,
    maxLifetimeSeconds: 30,
    maxSubstepM: 1,

    // 135 mm nominal. Enough for the light to defeat its own 90 mm front plate (barely) and the heavy's
    // 150 mm flank, and not remotely enough for the heavy's 340 mm glacis. The light therefore *cannot*
    // win a frontal fight against the heavy — its entire tactical identity is built on never having one.
    nominalPenetrationMm: 135,
    // The worst normalisation in the roster at 0.42. Sloped armour hurts the light more than anything
    // else in the game, which is why it is most vulnerable to exactly the vehicles it is trying to avoid.
    normalization: 0.42,
  },

  survivability: {
    // 620 HP, the lowest in the roster by a wide margin. At the light's own 105 damage that is six hits to
    // kill itself; at the heavy's 260 it is **two and a half**. A light that takes a heavy shell in the
    // flank is a light that has one shot of grace before it dies.
    hitPoints: 620,
    // The lightest hit in the roster. Even a perfectly placed light shell is a quarter of a medium's
    // health, so the light has to be *right*, not merely close.
    damagePerPenetration: 105,
    // A third module layout, and the smallest. The light carries no ammunition module and no separate
    // transmission — a vehicle this size has no room for either, and that absence is a weakness in its
    // own right: every subsystem the light has is concentrated into fewer, more exposed volumes. Two of
    // the four modules are the tracks, so a flank hit has a real chance of taking mobility *and* the
    // crew compartment in the same exchange.
    modules: [
      {
        id: 'engine',
        label: 'Engine',
        // The most fragile engine in the roster at 140 HP. A light cannot afford to trade hits.
        hitPoints: 140,
        // Rear-mounted and tight against the tail, so it is reached through the rear plate — the same
        // layout idea as the medium, but in a much smaller vehicle, which means the rear plate is a
        // proportionally larger share of the whole.
        centerM: vec3(0, 0.45, -1.75),
        radiusM: 0.85,
        effect: 'engine',
      },
      {
        id: 'track-left',
        label: 'Left track',
        // 85 HP against the medium's 120 and the heavy's 170. Two light penetrations through the flank
        // immobilise a light, which is the mechanical form of "mistakes are punished".
        hitPoints: 85,
        centerM: vec3(-1.1, 0.3, 0),
        radiusM: 0.8,
        effect: 'track',
      },
      {
        id: 'track-right',
        label: 'Right track',
        hitPoints: 85,
        centerM: vec3(1.1, 0.3, 0),
        radiusM: 0.8,
        effect: 'track',
      },
      {
        id: 'gun',
        label: 'Gun',
        // The most fragile gun in the roster at 95 HP. On the light the gun is not the vehicle's
        // identity the way it is on the heavy — it is the tool the vehicle uses to leave — so losing it
        // costs the light its exit rather than its argument.
        hitPoints: 95,
        centerM: vec3(0, 1.15, 0.35),
        radiusM: 0.85,
        effect: 'gun',
      },
    ],
  },
// --- Armour ---------------------------------------------------------------------------------
  //
  // A third layout, and the one that differs most from the other two. Both the medium and the heavy are
  // "sloped front, vertical sides, thin rear" vehicles with different numbers; the light is "thin and
  // near-vertical everywhere, but tall and narrow", which is a different shape of argument:
  //
  //  1. **Almost no slope anywhere.** `pitchDeg: 24` on the front against the medium's 60 and the heavy's
  //     66. There is very little effective-armour bonus to be had from geometry on this vehicle, which is
  //     exactly why it cannot afford to trade shots: there is no angle it can present that matters.
  //  2. **A narrow, tall hull side.** 2.0 m of plate height on a 2.9 m wide vehicle, against the heavy's
  //     1.35 m on 3.5 m. The light's flank is a bigger target than the heavy's, which is the price of
  //     being small and light on a shared suspension.
  //  3. **The floor is the softest in the roster at 14 mm.** 30 mm on the heavy. A light driving over a
  //     ridge at 16.5 m/s presents its underside to anything in front of it, and the model is thin enough
  //     down there that a shot arriving slightly low goes straight through.
  armor: [
    // Front: thin, and only gently sloped. 90 / cos(24) = 99 mm, so it is roughly what it says.
    {
      id: 'light-hull-front',
      region: 'hull-front',
      mount: 'hull',
      thicknessMm: 90,
      // Set well back on a much shorter hull: at 1.75 m forward of centre on a 5.4 m vehicle, this plate
      // sits noticeably behind the nose, which is the light's single clearest visual read — it looks like
      // a tank built around a small fighting compartment with a lot of hull in front of the gun.
      centerM: vec3(0, 0.7, 1.75),
      widthM: 1.9,
      heightM: 1.3,
      yawDeg: 0,
      pitchDeg: 24,
    },
    // Sides: 38 mm vertical. Anything that penetrates a light does so through here, which is why two track
    // penetrations immobilise it.
    {
      id: 'light-hull-left',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 38,
      centerM: vec3(-1.15, 0.6, 0),
      widthM: 3.6,
      // The tall-and-narrow read described above.
      heightM: 2.0,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'light-hull-right',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 38,
      centerM: vec3(1.15, 0.6, 0),
      widthM: 3.6,
      heightM: 2.0,
      yawDeg: 90,
      pitchDeg: 0,
    },
    // Rear: 28 mm, the thinnest plate in the roster. A light has no room to protect anything, and this
    // is the clearest statement of that.
    {
      id: 'light-hull-rear',
      region: 'hull-rear',
      mount: 'hull',
      thicknessMm: 28,
      centerM: vec3(0, 0.6, -1.95),
      widthM: 1.9,
      heightM: 2.0,
      yawDeg: 180,
      pitchDeg: 0,
    },
    // Floor: 14 mm. See above — the softest underside in the game.
    {
      id: 'light-hull-floor',
      region: 'hull-floor',
      mount: 'hull',
      thicknessMm: 14,
      centerM: vec3(0, 0, 0),
      widthM: 1.9,
      heightM: 3.6,
      yawDeg: 0,
      pitchDeg: -90,
    },
// --- Turret: small, upright, and thin -------------------------------------------------------
    // A narrow, tall, near-vertical turret with a stubby gun. The one thing about it that is *not* thin is
    // the front at 65 mm: proportionally the light's best-protected plate after its hull front, because a
    // small turret can afford to concentrate what protection it has on the face the enemy shoots at.
    {
      id: 'light-turret-front',
      region: 'turret-front',
      mount: 'turret',
      thicknessMm: 65,
      centerM: vec3(0, 0.35, 0.85),
      widthM: 1.5,
      heightM: 1.15,
      yawDeg: 0,
      // Only 15 degrees of slope: an almost flat face on a small vehicle, which reads as fragile at a
      // glance and is why the light's turret face is one of the few places a medium can hurt it head-on.
      pitchDeg: 15,
    },
    {
      id: 'light-turret-left',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 30,
      centerM: vec3(-0.78, 0.35, -0.1),
      widthM: 1.6,
      heightM: 1.15,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'light-turret-right',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 30,
      centerM: vec3(0.78, 0.35, -0.1),
      widthM: 1.6,
      heightM: 1.15,
      yawDeg: 90,
      pitchDeg: 0,
    },
    {
      id: 'light-turret-rear',
      region: 'turret-rear',
      mount: 'turret',
      thicknessMm: 26,
      centerM: vec3(0, 0.35, -0.85),
      widthM: 1.5,
      heightM: 1.15,
      yawDeg: 180,
      pitchDeg: 0,
    },
  ],

  penetration: {
    referenceVelocityMps: 880,
    ricochetThresholdDeg: 75,
  },

  // The light's audio identity: higher, thinner, and busier.
  //
  // The mirror image of the heavy's. The same shared engine recording, pitched up 34%, stops sounding like
  // a heavy diesel and starts sounding like a small high-revving engine under load — which is what a light
  // vehicle should sound like, and it costs no additional assets. The track layer is the *quietest* in the
  // roster, which is the detail that sells it: there is genuinely less metal down there.
  audio: {
    enginePitchScale: 1.34,
    // Slightly quieter than the reference. Not a ducking trick — the engine is small, and a small engine
    // at speed should not be the loudest thing in the player's own cockpit.
    engineGainScale: 0.9,
    // The quietest track layer in the roster. Combined with the highest speed in the game, the result is a
    // thin, busy sound that fades out completely when the light stops — which is a cue in itself.
    trackGainScale: 0.75,
    // A quiet gun. A light's shell is a small shell, and making it as loud as the heavy's would tell the
    // player its gun is bigger when the opposite is true.
    gunGainScale: 0.78,
    // And a higher one: a small-bore gun reports sharp and bright rather than deep, which is the other
    // half of why the three vehicles are separable with the screen off.
    gunPitchScale: 1.22,
    // The loudest servo in the roster, and the only vehicle whose turret is audible while stationary.
    // 48 deg/s means the light is constantly slewing, and a loud servo on a fast turret is a sound the
    // player will come to associate with "I am in the light".
    turretGainScale: 1.35,
  },
};

// Validate at module load. A bad definition must stop the process, not produce a broken vehicle.
assertValidVehicleDefinition(CT_LIGHT, CT_LIGHT.id);