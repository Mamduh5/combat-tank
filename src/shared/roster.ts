/**
 * The V8 vehicle roster: three distinct tanks, and the rules for adding a fourth.
 *
 * ## What this file is for
 *
 * V7 proved a single vehicle could be added as data rather than code. V8 has to prove the harder claim: that
 * a **roster** works, that bots can drive any member of it, and that the whole thing is a pipeline a future
 * agent can follow without reverse-engineering the existing three.
 *
 * That means the roster cannot just be an array. An array with nothing behind it gives the player a choice
 * that silently does not work, and gives the next agent no way to find out *why* a new vehicle misbehaves.
 * So this module does four things, all of them small and all of them mechanical:
 *
 *  1. **Declares the roster**, in one place, in a stable order.
 *  2. **Validates every member** at module load, so a malformed vehicle stops the process rather than
 *     producing a tank that drives through walls.
 *  3. **Resolves ids to definitions**, throwing a clear error on an unknown id rather than returning
 *     `undefined` and letting a `TypeError` surface three systems later.
 *  4. **Rejects a roster that is not genuinely distinct.** This is the one that earns its keep.
 *
 * ## Why roster-level validation exists at all
 *
 * `validateVehicleDefinition` proves each vehicle is *internally* well formed. It cannot prove the roster is
 * *externally* meaningful, and the failure it cannot catch is precisely the one V8 exists to prevent: a
 * "heavy" that is the medium with one number changed. A tank that differs only in a stat is a skin, and a
 * roster of skins satisfies every existing gate — the schema passes, the model loads, the linter is clean,
 * and the owner sees three tanks that feel identical.
 *
 * So `validateRoster` asserts differences that only exist *between* vehicles:
 *
 *  - **Distinct ids and models.** Two vehicles sharing a `visualId` render as the same tank.
 *  - **Distinct silhouettes.** Different bounding dimensions. A 3 cm difference in length is a reskin.
 *  - **Distinct armour layouts.** Not merely different thicknesses on the same plate skeleton: a different
 *    set of regions, a different mount balance, or a genuinely different plate geometry. The brief asks for
 *    vehicles that differ in "frontal slope, side exposure, turret protection, rear vulnerability" — that is
 *    a statement about *layout*, so this is checked on layout.
 *  - **Distinct movement.** Different top speed, hull traverse rate, or climb limit.
 *  - **Distinct guns.** Different damage, penetration, reload, or muzzle velocity.
 *  - **Distinct audio.** At least one audible parameter differs, or the vehicles are interchangeable with
 *    the screen off.
 *
 * Every rule above is deliberately loose in its threshold and strict in its kind. "Different" is not
 * "different enough to be balanced" — that is V12's job, and this file says so rather than pretending.
 *
 * ## These are prototypes, not classes
 *
 * The three vehicles carry a `role` label because the player needs to be told something and a wall of
 * numbers is not a label. That label is **descriptive, not a taxonomy**: nothing in the code branches on
 * `role`, no vehicle gains or loses a capability because of it, and removing the field would not change a
 * single rule. OD-01 (whether Combat Tank should have formal vehicle classes) is still open and this roster
 * deliberately does not pre-empt it. See `docs/open-decisions.md`.
 */
/**
 * A short label describing what a vehicle is *for*, for the player-facing selector.
 *
 * Explicitly not a class. There is no union that a system switches on, no tier, no tree, and nothing in the
 * simulation reads it. It exists so the selector can say "front-heavy bruiser" instead of showing a
 * penetration figure, and it is the one place in V8 where product-shaped language appears — deliberately
 * confined to a string that no rule consumes.
 */
export type VehicleRoleLabel = 'generalist' | 'bruiser' | 'scout';

/**
 * A roster entry: the definition itself, plus the descriptive text the selector shows.
 *
 * Kept as a wrapper rather than putting the prose in `VehicleDefinition` because prose is presentation. The
 * simulation core has no use for "front-heavy bruiser" and should not have to carry it, and the client has no
 * use for `powertrain.driveForceN` when it is drawing a card. The definition is data; this is data about
 * how to present the data.
 */
export interface RosterEntry {
  readonly vehicle: VehicleDefinition;
  /** One-line identity, written for a player who has not read the numbers. */
  readonly tagline: string;
  /**
   * The one thing this vehicle is good at, in the player's terms.
   *
   * Not a stat and not a claim of superiority — "takes a hit and keeps going" is the heavy's advantage even
   * though it is also its cost.
   */
  readonly strength: string;
  /** The one thing that will cost this vehicle a fight, stated honestly. */
  readonly weakness: string;
  /** Descriptive label only. See {@link VehicleRoleLabel}. */
  readonly role: VehicleRoleLabel;
}

/**
 * Every vehicle the player may drive or fight, in a stable presentation order.
 *
 * The order is the order the selector shows, and it is deliberate: **medium, heavy, light**. Starting with
 * the generalist means the default first impression is the vehicle that behaves most like the V7 tank the
 * owner already knows, and the two identities either side of it are read as deliberate departures from it
 * rather than as the baseline. Ordering by role instead would open the game on a vehicle whose weaknesses
 * are hardest to explain to someone who has never played.
 */
export const VEHICLE_ROSTER: readonly RosterEntry[] = [
  {
    vehicle: CT_MEDIUM,
    role: 'generalist',
    tagline: 'Nothing to hide and nothing to boast.',
    strength: 'Adaptable — it takes a position, trades, and disengages without needing a plan.',
    weakness: 'Nothing about it wins a fight on its own.',
  },
  {
    vehicle: CT_HEAVY,
    role: 'bruiser',
    tagline: 'Front armour decides the argument.',
    strength: 'Holds positions the others cannot, and survives being punished for holding them.',
    weakness: 'Repositioning is expensive. Once it commits, it is committed.',
  },
  {
    vehicle: CT_LIGHT,
    role: 'scout',
    tagline: 'Be somewhere else already.',
    strength: 'Relocates faster than anything shoots, and brings its gun round quickest.',
    weakness: 'Mistakes are punished. There is no margin anywhere on it.',
  },
];

/** Ids of every roster vehicle, in the same order as {@link VEHICLE_ROSTER}. */
export const ROSTER_VEHICLE_IDS: readonly string[] = VEHICLE_ROSTER.map((entry) => entry.vehicle.id);

/**
 * The vehicle the player drives when they have not chosen.
 *
 * The medium, because it is the vehicle whose behaviour is already balanced against the V7 encounter. It is
 * a default, not a recommendation — the selector is one keypress away.
 */
export const DEFAULT_PLAYER_VEHICLE_ID = CT_MEDIUM.id;
/**
 * Returns the roster entry with this id, or throws.
 *
 * Throwing rather than returning `null` is the point. Every caller here is a *selector* — a choice made once
 * and then relied upon for the whole encounter — so an unknown id is a programming error or a corrupt
 * stored choice, not a state to handle. A `null` return would push that decision into three call sites, where
 * one of them would eventually forget it.
 *
 * @throws Error naming the unknown id and the ids that do exist.
 */
export function rosterEntry(vehicleId: string): RosterEntry {
  const found = VEHICLE_ROSTER.find((entry) => entry.vehicle.id === vehicleId);
  if (found === undefined) {
    throw new Error(
      `Unknown vehicle id '${vehicleId}'. Roster ids: ${ROSTER_VEHICLE_IDS.join(', ')}. ` +
        `Add the vehicle to VEHICLE_ROSTER in roster.ts rather than passing an unrecognised id around.`,
    );
  }
  return found;
}

/** The definition for a roster id. Shorthand for `rosterEntry(id).vehicle`. */
export function vehicleById(vehicleId: string): VehicleDefinition {
  return rosterEntry(vehicleId).vehicle;
}

/**
 * The default opponent for a given player vehicle.
 *
 * Always a **different** vehicle from the player, and never itself. A light player facing a light opponent
 * is the least informative duel in the roster — it tells the player nothing about either vehicle's identity
 * because the mirror image of a scout fight is a scout fight. Pairing is data here too, so a future agent
 * changing the roster cannot accidentally produce a self-duel by leaving a field unset.
 *
 * The pairings are hand-chosen rather than derived from a rule like "next in the list", because "what makes
 * an interesting duel" is a design judgement:
 *
 *  - medium vs heavy — the positional duel. The heavy's front refuses the shell; the answer is the flank.
 *  - medium vs light — the pressure duel. The light is faster than anything aimed at it and must choose to
 *    stop shooting long enough to be hit.
 *  - heavy vs light — the asymmetric extreme. The light cannot hurt the heavy head-on at all, so it has to
 *    never be where the heavy gun is pointed; the heavy has to find it.
 *
 * Mirrors fall back to the heavy, which is the most forgiving opponent for an unpaired vehicle.
 */
export function defaultOpponentFor(playerVehicleId: string): string {
  switch (playerVehicleId) {
    case CT_MEDIUM.id:
      return CT_HEAVY.id;
    case CT_HEAVY.id:
      return CT_LIGHT.id;
    case CT_LIGHT.id:
      return CT_MEDIUM.id;
    default:
      return CT_HEAVY.id;
  }
}

/** One problem found in the roster, described so it can be acted on. */
export interface RosterProblem {
  /** Which rule was broken. */
  readonly rule: string;
  /** Which vehicles it involves. */
  readonly vehicles: readonly string[];
  /** What is wrong, in one sentence. */
  readonly detail: string;
}
/**
 * Checks that the roster is genuinely a roster.
 *
 * Runs at module load, next to the per-vehicle schema check, and **throws** rather than returning a result.
 * The difference matters: an invalid vehicle definition is a mistake in one file and is reported with a
 * label; an invalid *roster* is a mistake in this file or in how two files relate, and every consumer would
 * inherit it. Failing at import is the only moment at which no battle has been built on the bad assumption.
 *
 * @returns an empty array when the roster is sound.
 */
export function validateRoster(roster: readonly RosterEntry[]): RosterProblem[] {
  const problems: RosterProblem[] = [];

  const report = (rule: string, vehicles: readonly string[], detail: string): void => {
    problems.push({ rule, vehicles, detail });
  };

  const ids = new Set<string>();
  const visuals = new Set<string>();
  for (const entry of roster) {
    const id = entry.vehicle.id;
    if (ids.has(id)) {
      report('unique-id', [id], `two roster entries share the id '${id}'`);
    }
    ids.add(id);

    if (visuals.has(entry.vehicle.visualId)) {
      report(
        'distinct-model',
        [id],
        `visualId '${entry.vehicle.visualId}' is used by more than one vehicle, so they render identically`,
      );
    }
    visuals.add(entry.vehicle.visualId);
  }

  // Pairwise, so every message names exactly the two vehicles at fault rather than "the roster".
  for (let i = 0; i < roster.length; i += 1) {
    for (let j = i + 1; j < roster.length; j += 1) {
      const a = roster[i]!.vehicle;
      const b = roster[j]!.vehicle;
      const pair = [a.id, b.id];

      if (!differsInSilhouette(a, b)) {
        report(
          'distinct-silhouette',
          pair,
          `bounding dimensions are the same to within 15%: ${describeDimensions(a)} vs ${describeDimensions(b)}`,
        );
      }
      if (!differsInArmorLayout(a, b)) {
        report(
          'distinct-armour-layout',
          pair,
          'armour layouts are equivalent — the brief requires differing in slope, exposure, turret ' +
            'protection or weak regions, not merely in thickness',
        );
      }
      if (!differsInMovement(a, b)) {
        report('distinct-movement', pair, 'top speed, hull traverse rate and climb limit are all the same');
      }
      if (!differsInGun(a, b)) {
        report('distinct-gun', pair, 'damage, penetration, reload and muzzle velocity are all the same');
      }
/**
 * True when the two armour layouts are different *shapes*, not the same shape with different numbers.
 *
 * Three independent ways to differ, any one of which is enough:
 *
 *  1. **A different set of named regions.** A vehicle whose front plate is `hull-glacis` rather than
 *     `hull-front` is describing a different part of itself, and the HUD's region readout changes with it.
 *  2. **A different hull/turret plate balance.** A casemate with no turret side plates and a hull with two
 *     is a different arrangement, and it changes which shots exist at all.
 *  3. **A genuinely different plate geometry** — front slope, compared only where both vehicles have a hull
 *     front. Slope is the classic case: the same plate at 60 degrees and at 24 degrees presents entirely
 *     different effective armour to the same shell, so identical thickness at a different angle is a
 *     different vehicle, and identical angle at a different thickness is not.
 *
 * Thickness on its own is explicitly **not** sufficient, and that is the whole point of this function.
 * Changing five plates from 200 mm to 220 mm while leaving every plate in place produces a roster that
 * passes every other gate in the project and feels like one tank in three colours.
 */
function differsInArmorLayout(a: VehicleDefinition, b: VehicleDefinition): boolean {
  const regionsA = new Set(a.armor.map((plate) => plate.region));
  const regionsB = new Set(b.armor.map((plate) => plate.region));
  for (const region of regionsA) {
    if (!regionsB.has(region)) {
      return true;
    }
  }
  for (const region of regionsB) {
    if (!regionsA.has(region)) {
      return true;
    }
  }

  const turretCount = (v: VehicleDefinition): number =>
    v.armor.filter((plate) => plate.mount === 'turret').length;
  if (turretCount(a) !== turretCount(b)) {
    return true;
  }

  const frontA = a.armor.find((plate) => plate.region === 'hull-front');
  const frontB = b.armor.find((plate) => plate.region === 'hull-front');
  return frontA !== undefined && frontB !== undefined && Math.abs(frontA.pitchDeg - frontB.pitchDeg) > 2;
}

/**
 * True when the two vehicles drive differently.
 *
 * Three independent handles, because a vehicle can be distinct in handling without being distinct in speed:
 * a tracked scout that tops out at the same rate but turns twice as fast is a different driving experience,
 * and so is one that is equally quick everywhere and simply cannot climb the bank.
 */
function differsInMovement(a: VehicleDefinition, b: VehicleDefinition): boolean {
  const speedDiffers =
    Math.abs(a.powertrain.maxSpeedMps - b.powertrain.maxSpeedMps) > 0.2 ||
    Math.abs(a.powertrain.maxReverseSpeedMps - b.powertrain.maxReverseSpeedMps) > 0.2;
  const traverseDiffers =
    Math.abs(a.traversal.hullTraverseDegPerSec - b.traversal.hullTraverseDegPerSec) > 0.5;
  const climbDiffers = Math.abs(a.ground.maxClimbDeg - b.ground.maxClimbDeg) > 0.5;
  return speedDiffers || traverseDiffers || climbDiffers;
}

/** True when the two vehicles shoot differently, by any of the four numbers that make a gun feel different. */
function differsInGun(a: VehicleDefinition, b: VehicleDefinition): boolean {
  return (
    a.survivability.damagePerPenetration !== b.survivability.damagePerPenetration ||
    a.mainShell.nominalPenetrationMm !== b.mainShell.nominalPenetrationMm ||
    a.mainGun.reloadSeconds !== b.mainGun.reloadSeconds ||
    a.mainShell.muzzleVelocityMps !== b.mainShell.muzzleVelocityMps
  );
}

/** True when the two vehicles are distinguishable with the screen off. */
function differsInAudio(a: VehicleDefinition, b: VehicleDefinition): boolean {
  const pa = a.audio;
  const pb = b.audio;
  return (
    pa.enginePitchScale !== pb.enginePitchScale ||
    pa.trackGainScale !== pb.trackGainScale ||
    pa.gunGainScale !== pb.gunGainScale ||
    pa.gunPitchScale !== pb.gunPitchScale ||
    pa.turretGainScale !== pb.turretGainScale
  );
}

// --- Load-time enforcement ------------------------------------------------------------
//
// Every vehicle is schema-checked in its own module, so a malformed one stops the process at its own
// import. The roster checks cannot live there: they are about relationships *between* vehicles, so they are
// enforced here, where the whole roster is in scope. Together they mean a broken roster cannot reach the
// simulation.
for (const entry of VEHICLE_ROSTER) {
  assertValidVehicleDefinition(entry.vehicle, entry.vehicle.id);
}

const rosterProblems = validateRoster(VEHICLE_ROSTER);
if (rosterProblems.length > 0) {
  const detail = rosterProblems
    .map((problem) => `  - [${problem.rule}] ${problem.vehicles.join(' vs ')}: ${problem.detail}`)
    .join('\n');
  throw new Error(`The V8 vehicle roster is not a roster:\n${detail}`);
}
      if (!differsInAudio(a, b)) {
        report('distinct-audio', pair, 'the two vehicles are indistinguishable by ear');
      }
    }
  }

  return problems;
}

function describeDimensions(v: VehicleDefinition): string {
  return `${v.dimensions.lengthM}x${v.dimensions.widthM}x${v.dimensions.heightM} m`;
}

/**
 * True when the two vehicles are a visible size apart.
 *
 * 15% is chosen from the roster's own spread rather than from taste: the medium is 6.7 m and the light
 * 5.4 m, a 19% difference in length, and the heavy is 7.6 m long and 3.5 m wide against the light's 2.9 m.
 * A threshold below the smallest real difference in the roster would let two vehicles that *are* the same
 * size through; one above the largest would reject genuinely distinct silhouettes. It is deliberately a lower
 * bound — the point is to catch a copied definition, not to arbitrate proportion.
 */
function differsInSilhouette(a: VehicleDefinition, b: VehicleDefinition): boolean {
  const longest = Math.max(a.dimensions.lengthM, b.dimensions.lengthM);
  const widest = Math.max(a.dimensions.widthM, b.dimensions.widthM);
  const tallest = Math.max(a.dimensions.heightM, b.dimensions.heightM);
  const lengthDiffers = Math.abs(a.dimensions.lengthM - b.dimensions.lengthM) / longest > 0.15;
  const widthDiffers = Math.abs(a.dimensions.widthM - b.dimensions.widthM) / widest > 0.15;
  const heightDiffers = Math.abs(a.dimensions.heightM - b.dimensions.heightM) / tallest > 0.15;
  return lengthDiffers || widthDiffers || heightDiffers;
}

/**
 * The opponent the player fights when they have not chosen one.
 *
 * The heavy, and the reasoning is about what the *first* duel teaches. Against a medium the encounter
 * replays the V7 experience, where the winning tactic is already known. Against the heavy it does not: the
 * front plate refuses the shell, the answer has to be positional, and the player learns the game's central
 * lesson from battle one rather than from a tutorial.
 */
export const DEFAULT_OPPONENT_VEHICLE_ID = CT_HEAVY.id;

import { assertValidVehicleDefinition } from './vehicle-definition-schema.js';
import type { VehicleDefinition } from './vehicle-definition.js';
import { CT_MEDIUM } from './roster/ct-medium.js';
import { CT_HEAVY } from './roster/ct-heavy.js';
import { CT_LIGHT } from './roster/ct-light.js';

export { CT_MEDIUM } from './roster/ct-medium.js';
export { CT_HEAVY } from './roster/ct-heavy.js';
export { CT_LIGHT } from './roster/ct-light.js';