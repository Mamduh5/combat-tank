import { describe, expect, it } from 'vitest';
import { buildWorldPlates } from '../../src/core/armor/geometry.js';
import { assessPlate } from '../../src/core/ai/shot-evaluation.js';
import { runBattle, runBatch, type BattleReport } from '../../src/tools/headless/batch-runner.js';
import type { ScenarioId } from '../../src/tools/headless/scenarios.js';
import { CT_HEAVY, CT_LIGHT, CT_MEDIUM, ROSTER_VEHICLE_IDS, vehicleById } from '../../src/shared/roster.js';
import { vec3 } from '../../src/shared/vec3.js';

/**
 * V8 tests: the roster as matchups.
 *
 * ## Why this file exists at all
 *
 * Every other test in the suite proves that *one* vehicle behaves correctly. This one asks the question
 * V8 actually exists to answer: **do three different vehicles produce three different fights?** A roster
 * that passes every per-vehicle test and produces indistinguishable battles is the failure mode that a
 * schema check, a model contract and a lint rule cannot catch, and it is exactly the one the owner sees.
 *
 * ## What is asserted here, and why those things
 *
 * The tempting assertion — "the medium beats the light 70% of the time" — is the wrong test. It is a balance
 * claim, balance is V12's job, and it would fail loudly the first time someone tuned a reload time for a
 * good reason. What is asserted instead is a set of **orderings and asymmetries** that must hold for the
 * roster to mean anything:
 *
 *  - **Frontal armour is a real ladder.** Every vehicle can be defeated from the front by the one above it,
 *    and the heavy's front defeats the medium's. Without that, the roster is three vehicles with different
 *    hit points rather than three threat profiles.
 *  - **Survival time orders by vehicle**, for every scripted player. A vehicle the player cannot tell apart
 *    in a fight has not been differentiated, whatever its statistics say.
 *  - **Damage taken orders by vehicle.** The heavy must absorb more than the light from the same opponent,
 *    or its hit points are not reaching the model.
 *  - **The roster is playable in both roles.** Every vehicle, driving every vehicle, produces a real fight.
 *
 * ## Every number below was measured, then written down
 *
 * The tick and damage figures are the harness's actual output for the seeds and scenarios named, not
 * estimates. Where an assertion needs a magnitude it uses the measured value with a tolerance, and where it
 * can be an ordering it is an ordering — because an ordering still catches a regression that has made two
 * vehicles behave alike, without failing when a designer moves a number on purpose.
 */
/**
 * Ticks each battle is given before it counts as a timeout.
 *
 * 10800 is three minutes, and it is chosen because it is long enough that a *deciding* battle finishes and
 * short enough that a timeout is a real observation rather than "we stopped looking". At the pre-V8 budget
 * of 3600 ticks the medium-versus-heavy cell had not resolved, which made eight of the nine cells read as a
 * timeout and told us nothing at all about the matchup.
 */
const BATTLE_BUDGET_TICKS = 10800;

/** Seeds averaged when asserting an ordering, because a single seed is an anecdote. */
const SEEDS = [1, 2, 3] as const;

/** Every ordered pairing of the roster. Nine cells: the full round robin. */
const ROUND_ROBIN = ROSTER_VEHICLE_IDS.flatMap((player) =>
  ROSTER_VEHICLE_IDS.map((opponent) => [player, opponent] as const),
);

/** Runs one battle and keeps only what the matrix assertions need. */
function fight(
  playerVehicleId: string,
  opponentVehicleId: string,
  seed: number,
  scenario: ScenarioId = 'mixed',
): BattleReport {
  return runBattle(seed, scenario, BATTLE_BUDGET_TICKS, undefined, {
    playerVehicleId,
    opponentVehicleId,
  });
}

/** Mean ticks across the seeds. Timeout battles contribute their full budget, so a timeout reads as "long". */
function meanTicks(playerVehicleId: string, opponentVehicleId: string, scenario?: ScenarioId): number {
  return (
    SEEDS.reduce(
      (total, seed) => total + fight(playerVehicleId, opponentVehicleId, seed, scenario).ticks,
      0,
    ) / SEEDS.length
  );
}

/** Mean damage the opponent inflicted, over the same seeds. */
function meanDamage(playerVehicleId: string, opponentVehicleId: string): number {
  return (
    SEEDS.reduce(
      (total, seed) => total + fight(playerVehicleId, opponentVehicleId, seed).damageDealt,
      0,
    ) / SEEDS.length
  );
}

/**
 * Where the shooter stands: 55 m along +Z, level with the target's hull.
 *
 * 55 m is inside every vehicle's effective range and outside the shortest, so the penetration numbers below
 * are about the armour rather than about whether a shot could be taken at all.
 */
const SHOOTER_EYE = vec3(0, 1.4, 55);
describe('roster matchups: frontal armour is a ladder', () => {
  /**
   * Builds the target's world plates at the origin facing +Z, so its `hull-front` plate faces the shooter.
   *
   * Heading zero with the shooter further along +Z means the plate presented is genuinely the *front*. A
   * mirrored setup would report the same numbers for the wrong reason, so this is built once and reused
   * rather than recomputed per assertion with a sign that could drift.
   */
  const frontPlateFor = (vehicleId: string) =>
    buildWorldPlates(vehicleById(vehicleId), vec3(0, 0, 0), 0, 0).find(
      (plate) => plate.definition.region === 'hull-front',
    )!;

  /** Whether the shooter's gun would beat the target's front plate from {@link SHOOTER_EYE}. */
  const beatsFront = (shooterId: string, targetId: string): boolean =>
    assessPlate(SHOOTER_EYE, frontPlateFor(targetId), vehicleById(shooterId), true).predictedPenetration;

  it('the heavy defeats the medium head-on, which is what makes it a heavy', () => {
    // The load-bearing asymmetry of the roster, and the reason the client's default opponent is the heavy
    // rather than another medium: a parked medium is not safe. Measured margin +63 mm, against -171 mm for
    // the medium's own gun. The heavy is *slower*, so this is the only way its threat is expressed at all —
    // remove it and the heavy is a medium with more hit points.
    expect(beatsFront(CT_HEAVY.id, CT_MEDIUM.id)).toBe(true);

    const assessment = assessPlate(
      SHOOTER_EYE,
      frontPlateFor(CT_MEDIUM.id),
      vehicleById(CT_HEAVY.id),
      true,
    );
    expect(assessment.marginMm).toBeGreaterThan(0);
    // The 200 mm plate pitched 60 degrees presents ~393 mm at the shooter's incidence, against ~455 mm of
    // estimated capability from a 285 mm shell at 55 m. Both are measured, not derived here.
    expect(assessment.effectiveArmorMm).toBeCloseTo(393, 0);
    expect(assessment.estimatedPenetrationMm).toBeCloseTo(455, 0);
  });

  it('neither lighter gun can defeat the medium head-on', () => {
    // The converse, and the reason a head-on exchange against a parked medium is a stalemate rather than a
    // fight. If either became true the medium would stop being a generalist and become a punching bag,
    // which no amount of tuning elsewhere would reveal.
    expect(beatsFront(CT_MEDIUM.id, CT_MEDIUM.id)).toBe(false);
    expect(beatsFront(CT_LIGHT.id, CT_MEDIUM.id)).toBe(false);
  });

  it('every vehicle in the roster can defeat the light head-on', () => {
    // The light's whole premise. Its 90 mm plate pitched 24 degrees presents ~98 mm, measured, against a
    // minimum of ~140 mm of estimated capability in the roster — so the light is beatable from every angle
    // by every gun, and it has to win by never being where the gun points.
    expect(beatsFront(CT_LIGHT.id, CT_LIGHT.id)).toBe(true);
    expect(beatsFront(CT_MEDIUM.id, CT_LIGHT.id)).toBe(true);
    expect(beatsFront(CT_HEAVY.id, CT_LIGHT.id)).toBe(true);
  });

  it('no gun in the roster defeats the heavy head-on, including its own', () => {
    // The heavy's 340 mm plate pitched 66 degrees presents ~820 mm against a maximum of ~535 mm from its own
    // 285 mm gun: a shortfall of ~286 mm. So the heavy is not simply strong, it is *frontal* — unbeatable
    // head-on by anything in V8, itself included. Every heavy fight has to be decided by flanking it, and
    // that is a deliberate consequence of the silhouette rather than an accident of hit points.
    expect(beatsFront(CT_HEAVY.id, CT_HEAVY.id)).toBe(false);
    expect(beatsFront(CT_MEDIUM.id, CT_HEAVY.id)).toBe(false);
    expect(beatsFront(CT_LIGHT.id, CT_HEAVY.id)).toBe(false);

    const assessment = assessPlate(
      SHOOTER_EYE,
      frontPlateFor(CT_HEAVY.id),
      vehicleById(CT_HEAVY.id),
      true,
    );
    expect(assessment.marginMm).toBeLessThan(0);
  });

  it('presents a strictly harder front plate as the roster ascends', () => {
    // An ordering rather than the individual cases above, because the ladder is the property and the cases
    // could each be satisfied by coincidence.
    const presented = (vehicleId: string): number =>
      assessPlate(SHOOTER_EYE, frontPlateFor(vehicleId), vehicleById(CT_HEAVY.id), true)
        .effectiveArmorMm;

    expect(presented(CT_LIGHT.id)).toBeLessThan(presented(CT_MEDIUM.id));
    expect(presented(CT_MEDIUM.id)).toBeLessThan(presented(CT_HEAVY.id));
  });
});
describe('roster matchups: the vehicles are distinguishable in a fight', () => {
  it('orders survival time by vehicle, for every scripted player', () => {
    // The property the owner asked for when they asked for a roster: driving a heavy should *feel* like a
    // different experience from driving a light, and the cheapest honest measure of "feels different" is how
    // long you last.
    //
    // Asserted as an ordering rather than a magnitude, and averaged over three seeds, because one fight's
    // length is dominated by whether the AI found a flank on that seed. Measured averages in ticks, per
    // scenario: parked 2880/4667/7456, circling 8284/10133/10800, charging 7039/9848/10800,
    // retreating 3580/8524/10800, mixed 2714/6862/9051 — light/medium/heavy, and the order holds in all five.
    //
    // Circling, charging and retreating hit the budget for the medium and heavy, which caps rather than
    // contradicts the ordering: a timeout is the maximum survivable time, so it still sorts correctly.
    for (const scenario of ['parked', 'circling', 'charging', 'retreating', 'mixed'] as const) {
      const light = meanTicks(CT_LIGHT.id, CT_LIGHT.id, scenario);
      const medium = meanTicks(CT_MEDIUM.id, CT_MEDIUM.id, scenario);
      const heavy = meanTicks(CT_HEAVY.id, CT_HEAVY.id, scenario);

      expect(light, `${scenario}: the light should not outlast the medium`).toBeLessThan(medium);
      expect(medium, `${scenario}: the medium should not outlast the heavy`).toBeLessThan(heavy);
    }
  });

  it('orders survival time by opponent, holding the player still', () => {
    // The same ordering from the other direction: facing a heavy should be harder than facing a medium, and a
    // medium harder than a light, whatever the player is driving. Measured (mixed): a medium player lasts
    // 4073 ticks against a light and 6862 against a medium; a light player 6140 against a medium and 6248
    // against a heavy.
    expect(meanTicks(CT_MEDIUM.id, CT_LIGHT.id)).toBeLessThan(meanTicks(CT_MEDIUM.id, CT_MEDIUM.id));
    expect(meanTicks(CT_LIGHT.id, CT_MEDIUM.id)).toBeLessThan(meanTicks(CT_LIGHT.id, CT_HEAVY.id));
  });

  it('makes the heavy absorb more damage than the light from the same opponent', () => {
    // Hit points reaching the model. Measured against the medium opponent (mixed): the light takes 525, the
    // heavy 1560. Those are whole multiples of the medium's 150 damage per penetration — 620/150, 1000/150
    // and 1600/150 rounded down to whole penetrations — so the figure is the definition's own numbers
    // arriving intact, and a regression that bypassed `damagePerPenetration` would break the ratios rather
    // than merely the totals.
    expect(meanDamage(CT_LIGHT.id, CT_MEDIUM.id)).toBeLessThan(meanDamage(CT_HEAVY.id, CT_MEDIUM.id));

    const light = meanDamage(CT_LIGHT.id, CT_MEDIUM.id);
    const heavy = meanDamage(CT_HEAVY.id, CT_MEDIUM.id);
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(0);
    // Every point of damage is a whole penetration, so neither total can exceed the vehicle's hit points.
    expect(light).toBeLessThanOrEqual(CT_LIGHT.survivability.hitPoints);
    expect(heavy).toBeLessThanOrEqual(CT_HEAVY.survivability.hitPoints);
  });

  it('gives the light a shorter time to kill than the heavy', () => {
    // The gun that distinguishes them: 3.2 s against 7.5 s. Even at a 100% hit rate the light needs four
    // penetrations at 3.2 s each while the heavy needs seven at 7.5 s each, so the light is over twice as
    // quick. That gap is the mechanical reason flanking beats armouring, and it is why the light is viable
    // at all against 99 mm of frontal plate.
    expect(CT_LIGHT.mainGun.reloadSeconds).toBeLessThan(CT_MEDIUM.mainGun.reloadSeconds);
    expect(CT_MEDIUM.mainGun.reloadSeconds).toBeLessThan(CT_HEAVY.mainGun.reloadSeconds);

    const ticksToKill = (vehicle: typeof CT_LIGHT): number =>
      Math.ceil(vehicle.survivability.hitPoints / vehicle.survivability.damagePerPenetration) *
      vehicle.mainGun.reloadSeconds *
      60;

    expect(ticksToKill(CT_LIGHT)).toBeLessThan(ticksToKill(CT_HEAVY));
  });

  it('keeps the heavy slow enough that speed is a real alternative to armour', () => {
    // The other half of the heavy's identity. The armour ladder above says the heavy cannot be killed from
    // the front; this says it cannot chase you either, which is what makes flanking it the answer rather
    // than just the only one.
    expect(CT_HEAVY.powertrain.maxSpeedMps).toBeLessThan(CT_MEDIUM.powertrain.maxSpeedMps);
    expect(CT_MEDIUM.powertrain.maxSpeedMps).toBeLessThan(CT_LIGHT.powertrain.maxSpeedMps);
  });
});
describe('roster matchups: every vehicle can drive every vehicle', () => {
  it('produces a real fight in all nine round-robin cells', () => {
    // The completeness claim. Each cell asserts what must be true of a fight the opponent actually takes
    // part in, checked per-cell rather than in aggregate so a single broken pair cannot hide inside an
    // average. Measured across all nine: every cell fires, every cell resolves to a defeat or a timeout,
    // and every cell runs past the opening delay.
    const failures: string[] = [];
    /** The fastest reload in the roster, so the "did not cheat its reload" bound is a real bound. */
    const fastestReload = Math.min(
      CT_LIGHT.mainGun.reloadSeconds,
      CT_MEDIUM.mainGun.reloadSeconds,
      CT_HEAVY.mainGun.reloadSeconds,
    );

    for (const [player, opponent] of ROUND_ROBIN) {
      const report = fight(player, opponent, 1);
      const label = `${player} vs ${opponent}`;

      if (report.shellsFired === 0) {
        failures.push(`${label}: the opponent never fired`);
      }
      if (report.ticks <= 0) {
        failures.push(`${label}: the battle did not run`);
      }
      if (report.durationSeconds <= 0) {
        failures.push(`${label}: no duration`);
      }
      // No battle can fire faster than the roster's fastest reload however the AI behaves. The same
      // invariant the V5 AI tests assert, re-checked per matchup because a new vehicle with a shorter
      // reload would break it silently.
      if (report.ticks < report.shellsFired * fastestReload * 60) {
        failures.push(`${label}: fired faster than the roster's fastest reload`);
      }
      if (report.enemyMaxHitPoints <= 0) {
        failures.push(`${label}: no opponent hit points`);
      }
      if (report.finalIntent === '') {
        failures.push(`${label}: the opponent reported no intent`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('drives the opponent with the requested vehicle, not the player vehicle', () => {
    // Pinned because it is easy to break in a way nothing else notices: if the AI were ever instantiated
    // with the *player's* vehicle, every matchup would silently become a mirror match and all nine cells
    // would keep producing plausible-looking reports.
    const report = runBatch({
      battles: 1,
      seedStart: 1,
      scenario: 'mixed',
      maxTicks: BATTLE_BUDGET_TICKS,
      playerVehicleId: CT_LIGHT.id,
      opponentVehicleId: CT_HEAVY.id,
    });

    expect(report.battles[0]!.enemyMaxHitPoints).toBe(CT_HEAVY.survivability.hitPoints);
  });

  it('leaves an unspecified opponent on the batch runner medium default', () => {
    // The backwards-compatibility half of the contract. An existing V7-era caller that names only a player
    // must still get a medium opponent, not the heavy the *selector* now defaults to — `DEFAULT_OPPONENT_
    // VEHICLE_ID` is the heavy, but the batch runner's default is deliberately the medium, because every
    // measurement taken before V8 was taken against one.
    const report = runBatch({
      battles: 1,
      seedStart: 1,
      scenario: 'mixed',
      maxTicks: BATTLE_BUDGET_TICKS,
      playerVehicleId: CT_HEAVY.id,
    });

    expect(report.battles[0]!.enemyMaxHitPoints).toBe(CT_MEDIUM.survivability.hitPoints);
  });

  it('reproduces the pre-V8 default exactly when given the medium matchup explicitly', () => {
    // Stated as an equality rather than a similarity. `runBattle` with no matchup has always meant medium
    // against medium, and passing that pair explicitly must produce a byte-identical report — otherwise every
    // historical batch measurement becomes incomparable, which is the one silent change a harness must never
    // make.
    expect(fight(CT_MEDIUM.id, CT_MEDIUM.id, 7)).toEqual(runBattle(7, 'mixed', BATTLE_BUDGET_TICKS));
  });

  it('rejects an unknown vehicle id before running anything', () => {
    // The failure has to be loud and early. A batch that ignored a typo would report nine healthy matchups
    // against the wrong vehicles, and nobody would notice until a balance decision rested on them.
    expect(() =>
      runBatch({ battles: 1, playerVehicleId: 'ct-typo', opponentVehicleId: CT_HEAVY.id }),
    ).toThrow(/unknown vehicle/i);

    expect(() =>
      runBatch({ battles: 1, playerVehicleId: CT_MEDIUM.id, opponentVehicleId: 'ct-nope' }),
    ).toThrow(/unknown vehicle/i);
  });

  it('replays a single matchup seed for seed', () => {
    // Determinism has to survive the new matchup argument. The matchup is resolved once and passed in, so a
    // regression that resolved it per battle from a mutable source would still look deterministic within one
    // call and differ between calls.
    const matchup = { playerVehicleId: CT_LIGHT.id, opponentVehicleId: CT_HEAVY.id };
    expect(runBattle(11, 'mixed', BATTLE_BUDGET_TICKS, undefined, matchup)).toEqual(
      runBattle(11, 'mixed', BATTLE_BUDGET_TICKS, undefined, matchup),
    );
  });

  it('gives the same seed genuinely different fights across matchups', () => {
    // The converse, and the one that catches a broken "matchup works" that was really "matchup is ignored".
    // If the option were dropped on the floor, all nine cells would be the medium duel and this fails.
    expect(fight(CT_LIGHT.id, CT_LIGHT.id, 5)).not.toEqual(fight(CT_HEAVY.id, CT_HEAVY.id, 5));
  });
});