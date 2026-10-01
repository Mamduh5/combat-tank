import { assertValidVehicleDefinition } from './vehicle-definition-schema.js';
import type { VehicleDefinition } from './vehicle-definition.js';
import { PLACEHOLDER_TANK } from './placeholder-tank.js';
import { vec3 } from './vec3.js';

/**
 * The V4 opponent: a second tank that fights back.
 *
 * ## What changed from the V3 test target
 *
 * The V3 target was deliberately inert — it sat still and took fire so the armour model could be
 * verified by hand. V4 needs a real opponent, so this vehicle is defined as a **moving, aiming,
 * firing** tank, stepped through the same `Tank` class, the same `InputCommand` interface and the
 * same `ShellFlightSystem` as the player's vehicle. Nothing about it bypasses a gameplay rule; the
 * only difference is that its input comes from `EnemyController` instead of a keyboard.
 *
 * ## Why it is a separate data file
 *
 * The same argument as `placeholder-target.ts`, and it is the property ADR-0003 exists to prove:
 * adding a fighting vehicle means adding **data**. No gameplay code changes when this file appears.
 *
 * ## Design intent for the encounter
 *
 * These are **prototype encounter values**, not balance. They are tuned so the first duel is
 * survivable but not trivial, and they will change once the owner has actually played it. The
 * reasoning behind each is recorded inline so a later tuning pass knows what it is adjusting rather
 * than having to re-derive it.
 *
 * Three choices matter most:
 *
 *  - **It moves.** A stationary opponent is a shooting gallery, not a fight. It has roughly two
 *    thirds of the player's top speed, so it can close, disengage and reposition — enough that the
 *    player has to think about where the enemy will be, without it outrunning them.
 *  - **Its front is sloped, not slab.** The V3 target's flat 220 mm front bounced everything and
 *    taught the player to circle. An opponent that is hard to kill head-on but straightforward to
 *    kill from the flank keeps that lesson while still threatening them.
 *  - **It is slightly tougher than the player** (900 vs 1000 HP) at the same damage per shot. A clean
 *    duel runs very slightly in the enemy's favour, which rewards the player for positioning rather
 *    than trading. That asymmetry is intentional and prototype-only; see OD-09.
 */
export const ENEMY_TANK: VehicleDefinition = {
  ...PLACEHOLDER_TANK,

  id: 'enemy-medium',
  displayName: 'Enemy Medium',
  // The `visualId` is what the client resolves to a model, so the opponent is visually distinct
  // without the renderer needing to know anything about roles.
  visualId: 'enemy-medium',

  powertrain: {
    ...PLACEHOLDER_TANK.powertrain,
    // ~66% of the player's 8.4 m/s. Fast enough to reposition deliberately, slow enough that a
    // player who commits to an angle can hold it.
    maxSpeedMps: 5.6,
    maxReverseSpeedMps: 2.6,
  },

  traversal: {
    ...PLACEHOLDER_TANK.traversal,
    hullTraverseDegPerSec: 22,
    hullTraverseAccelDegPerSec2: 12,
  },

  turret: {
    ...PLACEHOLDER_TANK.turret,
    // Slower than the player's 32 deg/s. This is the single most important number for how the duel
    // *feels*: a slower enemy turret means the player can out-manoeuvre it with the mouse, which is
    // what makes fighting it fun rather than frustrating. It also means a circling player can keep
    // the enemy permanently behind its traverse rate.
    traverseDegPerSec: 24,
    traverseAccelDegPerSec2: 34,
    // 360 degrees, so the opponent can genuinely fight from any orientation. A restricted arc would
    // make it exploitable in a way that reads as a bug rather than as a design.
    maxTraverseDeg: 360,
  },

  mainGun: {
    ...PLACEHOLDER_TANK.mainGun,
    // Longer than the player's: it rewards the opponent for keeping its distance, which gives the
    // player a reason to close rather than trade shots across an open field.
    barrelLengthM: 4.6,
    // Slightly longer reload. Combined with the slower turret this means the opponent's shots come
    // in slow, spaced bursts — the player gets time to react, reposition, and take a shot of their
    // own. A faster-firing opponent was deliberately avoided: with the same penetration model and
    // the player's 1000 HP it would kill an inattentive player in well under ten seconds, which
    // reads as unfair rather than difficult.
    reloadSeconds: 5.2,
  },

  survivability: {
    ...PLACEHOLDER_TANK.survivability,
    // 900 HP at 150 damage per penetration is 6 clean hits.
    //
    // Measured, not chosen. At 1050 HP a flanking player landed 600 damage in 60 simulated seconds and
    // the opponent was still alive, so a duel ran past two minutes. Six penetrations is long enough to
    // require two or three positioning attempts without demanding pixel-perfect aim.
    hitPoints: 900,
    damagePerPenetration: 150,
    modules: [
      // Rear-mounted engine, so the player's V3 lesson (shoot the back) carries over and still
      // works. Destroying it immobilises the enemy, which is a real tactical payoff.
      {
        id: 'engine',
        label: 'Engine',
        hitPoints: 150,
        centerM: vec3(0, 0.5, -2.4),
        radiusM: 1.1,
        effect: 'engine',
      },
      // Tracks on both flanks. This is now a gameplay consequence rather than telemetry: a destroyed
      // track slows and destabilises the enemy (see the mobility handling in `Tank`).
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
        hitPoints: 130,
        centerM: vec3(0, 1.42, 0.4),
        radiusM: 1.1,
        effect: 'gun',
      },
      // No ammunition module. It existed on the player's tank to record a state the V3 damage model
      // had no consequence for; giving the enemy one would imply a cook-off system V4 does not have.
      // Recorded honestly as absent rather than simulated as inert.
    ],
  },

  armor: [
    // Sloped front, thinner than the player's 200 mm but far better angled than the V3 target's
    // flat 220 mm. At 150 mm nominal penetration this is *hard* to defeat head-on and easy from the
    // flank — the encounter's central positional tension.
    {
      id: 'enemy-hull-front',
      region: 'hull-front',
      mount: 'hull',
      thicknessMm: 150,
      centerM: vec3(0, 0.85, 2.1),
      widthM: 2.4,
      heightM: 1.5,
      yawDeg: 0,
      pitchDeg: 52,
    },
    // Vertical and thin: the reliable shot, exactly as on the player's tank. The flank is the answer,
    // and finding it is the player's job.
    {
      id: 'enemy-hull-left',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 60,
      centerM: vec3(-1.3, 0.6, 0),
      widthM: 4.2,
      heightM: 1.2,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'enemy-hull-right',
      region: 'hull-side',
      mount: 'hull',
      thicknessMm: 60,
      centerM: vec3(1.3, 0.6, 0),
      widthM: 4.2,
      heightM: 1.2,
      yawDeg: 90,
      pitchDeg: 0,
    },
    // Thin rear over the engine: the reward for getting behind.
    {
      id: 'enemy-hull-rear',
      region: 'hull-rear',
      mount: 'hull',
      thicknessMm: 40,
      centerM: vec3(0, 0.6, -2.4),
      widthM: 2.4,
      heightM: 1.2,
      yawDeg: 180,
      pitchDeg: 0,
    },
    {
      id: 'enemy-hull-floor',
      region: 'hull-floor',
      mount: 'hull',
      thicknessMm: 20,
      centerM: vec3(0, 0, 0),
      widthM: 2.4,
      heightM: 4.2,
      yawDeg: 0,
      pitchDeg: -90,
    },
    // Turret face sloped and thick enough to be a real obstacle, but thinner than the player's, so a
    // player who wins the turret duel is rewarded.
    {
      id: 'enemy-turret-front',
      region: 'turret-front',
      mount: 'turret',
      thicknessMm: 130,
      centerM: vec3(0, 0.35, 1.05),
      widthM: 2,
      heightM: 0.95,
      yawDeg: 0,
      pitchDeg: 45,
    },
    {
      id: 'enemy-turret-left',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 50,
      centerM: vec3(-1.05, 0.35, -0.15),
      widthM: 2.1,
      heightM: 0.95,
      yawDeg: -90,
      pitchDeg: 0,
    },
    {
      id: 'enemy-turret-right',
      region: 'turret-side',
      mount: 'turret',
      thicknessMm: 50,
      centerM: vec3(1.05, 0.35, -0.15),
      widthM: 2.1,
      heightM: 0.95,
      yawDeg: 90,
      pitchDeg: 0,
    },
    {
      id: 'enemy-turret-rear',
      region: 'turret-rear',
      mount: 'turret',
      thicknessMm: 45,
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

// Validate at module load, exactly as the player's vehicle does. A malformed opponent must stop the
// process at import rather than surface as an inexplicable combat outcome three systems later.
assertValidVehicleDefinition(ENEMY_TANK, ENEMY_TANK.id);

