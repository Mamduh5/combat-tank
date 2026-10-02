import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BATCH_OPTIONS,
  runBattle,
  runBatch,
  suspectReason,
  type BattleReport,
} from '../../src/tools/headless/batch-runner.js';
import { formatJson, formatSummary, formatUsage } from '../../src/tools/headless/report.js';
import { isScenarioId, playerScript, SCENARIOS } from '../../src/tools/headless/scenarios.js';
import { ASHFORD_VALLEY } from '../../src/core/world/maps/ashford-valley.js';
import { NEUTRAL_INPUT } from '../../src/shared/input.js';

/**
 * V5F tests: the headless batch runner.
 *
 * The runner is tooling, so what matters is that it is *trustworthy* rather than clever. A harness that
 * quietly produced the wrong numbers would be worse than no harness, because every later balance
 * decision would rest on it. These tests therefore cover three things: that a batch is reproducible, that
 * it reports what actually happened, and that it reports the failure modes that would otherwise be
 * invisible in an average.
 */

/** A battle budget short enough to keep the suite quick while still letting the opponent shoot. */
const SHORT_TICKS = 1800;

/** A plausible viewing context for a scripted player: enemy ahead, player facing it. */
const context = () => ({
  enemyPosition: { x: 0, y: 0, z: 60 },
  playerPosition: { x: 0, y: 0, z: 0 },
  playerHeadingRad: 0,
});

describe('the batch runner', () => {
  it('produces identical reports for identical options', () => {
    // The property the whole tool rests on. A batch exists to be replayed: a seed that looks wrong has
    // to still look wrong tomorrow, and that is only true if the batch is a pure function of its
    // options. Compared on the full report, not a summary, so a divergence in any field is caught.
    const options = { battles: 3, seedStart: 4242, scenario: 'parked' as const, maxTicks: SHORT_TICKS };

    expect(runBatch(options)).toEqual(runBatch(options));
  });

  it('replays a single battle exactly, seed for seed', () => {
    // The same ground one level down, pinning the specific claim the CLI makes when it tells a developer
    // to replay a flagged seed.
    expect(runBattle(7, 'mixed', SHORT_TICKS)).toEqual(runBattle(7, 'mixed', SHORT_TICKS));
  });

  it('gives different seeds genuinely different battles', () => {
    // The converse of the test above, and the one that catches a broken "reproducibility" that was really
    // a constant. If every seed produced the same fight, a sweep would look healthy and say nothing.
    expect(runBattle(1, 'mixed', SHORT_TICKS)).not.toEqual(runBattle(2, 'mixed', SHORT_TICKS));
  });

  it('reports a real fight rather than an empty result', () => {
    // Guards the failure mode where the harness works but fights nothing — for instance if the AI were
    // never ticked. Asserting on outcomes would be brittle across seeds, so this asserts on what must be
    // true of any fight: the opponent acts, and its firing obeys the reload timer.
    const battle = runBattle(3, 'parked', SHORT_TICKS);

    expect(battle.shellsFired).toBeGreaterThan(0);
    expect(battle.ticks).toBeGreaterThan(0);
    expect(battle.durationSeconds).toBeGreaterThan(0);
    expect(battle.enemyMaxHitPoints).toBeGreaterThan(0);
    // Reload is 5.2 s, so no battle can fire faster than that however the AI behaves. This is the same
    // invariant the V5 AI tests assert, re-checked here because the harness is what balance work reads.
    expect(battle.ticks).toBeGreaterThanOrEqual(battle.shellsFired * 5.2 * 60);
  });

  it('totals match the battles they were derived from', () => {
    // The aggregate is what a human actually reads, so it has to be arithmetically true of the rows above
    // it. A summary that drifts from its own data is worse than no summary.
    const report = runBatch({ battles: 3, seedStart: 11, scenario: 'parked', maxTicks: SHORT_TICKS });
    const sum = (pick: (b: BattleReport) => number): number =>
      report.battles.reduce((total, battle) => total + pick(battle), 0);

    expect(report.battles).toHaveLength(3);
    expect(report.totals.shellsFired).toBe(sum((b) => b.shellsFired));
    expect(report.totals.shellsStruck).toBe(sum((b) => b.shellsStruck));
    expect(report.totals.penetrations).toBe(sum((b) => b.penetrations));
    expect(report.totals.damageDealt).toBe(sum((b) => b.damageDealt));
    expect(
      report.outcomeCounts.victory +
        report.outcomeCounts.defeat +
        report.outcomeCounts.timeout,
    ).toBe(3);
  });

  it('never reports a penetration without a strike, or a strike without a shell', () => {
    // Combat invariants, asserted on the harness's own accounting. If these could be violated, the hit
    // and penetration rates in the report would be nonsense — and a rate is the number most likely to be
    // quoted out of context.
    const report = runBatch({ battles: 4, seedStart: 21, scenario: 'mixed', maxTicks: SHORT_TICKS });

    for (const battle of report.battles) {
      expect(battle.shellsStruck).toBeLessThanOrEqual(battle.shellsFired);
      expect(battle.penetrations).toBeLessThanOrEqual(battle.shellsStruck);
    }
  });

  it('echoes its options so a saved report says how it was generated', () => {
    // A report file with no provenance is close to useless a month later. The options belong in the report
    // rather than in something the caller has to remember to write down beside it.
    const report = runBatch({
      battles: 2,
      seedStart: 99,
      scenario: 'circling',
      maxTicks: SHORT_TICKS,
    });

    expect(report.options).toEqual({
      battles: 2,
      seedStart: 99,
      scenario: 'circling',
      maxTicks: SHORT_TICKS,
    });
  });

  it('applies its defaults when given nothing', () => {
    expect(runBatch().options).toEqual(DEFAULT_BATCH_OPTIONS);
  });
});

describe('flagging a suspicious battle', () => {
  /** A complete, plausible battle record, so each test changes exactly one thing. */
  const healthy = (over: Partial<BattleReport> = {}): BattleReport => ({
    seed: 1,
    scenario: 'parked',
    outcome: 'defeat',
    ticks: 3600,
    durationSeconds: 60,
    enemyHitPoints: 100,
    enemyMaxHitPoints: 900,
    playerHitPoints: 0,
    damageDealt: 900,
    shellsFired: 6,
    shellsStruck: 6,
    penetrations: 5,
    ticksSeenNotFiring: 300,
    longestStallTicks: 40,
    maxRangeM: 55,
    ticksByIntent: { engage: 3600 },
    finalIntent: 'engage',
    ...over,
  });

  it('does not flag a fight the opponent simply lost', () => {
    // The bar is deliberately high. A hard fight is a good fight, and flagging one would train everyone to
    // ignore the list — which is the same as not having it.
    expect(suspectReason(healthy())).toBeNull();
  });

  it('flags an opponent that saw the player and never fired for half a minute', () => {
    // The exact signature of the defect that shipped in V5: the fire gate could not be satisfied, so the
    // opponent stood there aiming at something it would not shoot at. A stall this long cannot be slow
    // convergence.
    expect(suspectReason(healthy({ longestStallTicks: 1801 }))).toMatch(/did not fire/);
  });

  it('does not flag a stall short enough to be slow convergence', () => {
    // Laying a gun takes a few seconds. A threshold that flagged those would flag every battle.
    expect(suspectReason(healthy({ longestStallTicks: 600 }))).toBeNull();
  });

  it('flags an opponent that never fired at all', () => {
    expect(suspectReason(healthy({ shellsFired: 0, shellsStruck: 0, penetrations: 0 }))).toBe(
      'never fired',
    );
  });

  it('flags repeated firing that never lands a shell', () => {
    // Some misses are the point of a fallible gunner. Every shell missing is an aim solution that is
    // wrong, which is a different and more serious thing.
    expect(suspectReason(healthy({ shellsFired: 9, shellsStruck: 0, penetrations: 0 }))).toMatch(
      /struck the player with none/,
    );
  });

  it('does not judge a hit rate from a handful of shells', () => {
    // Below the sample floor the same record would be a bad inference rather than a real finding.
    expect(suspectReason(healthy({ shellsFired: 2, shellsStruck: 0, penetrations: 0 }))).toBeNull();
  });

  it('surfaces suspects from a batch, each naming a seed that exists in it', () => {
    // The reason the list exists: a developer needs a seed they can go and replay.
    const report = runBatch({ battles: 3, seedStart: 1, scenario: 'parked', maxTicks: SHORT_TICKS });

    for (const suspect of report.suspects) {
      expect(report.battles.some((battle) => battle.seed === suspect.seed)).toBe(true);
      expect(suspect.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('scenarios', () => {
  it('recognises exactly the scenarios it declares', () => {
    for (const scenario of SCENARIOS) {
      expect(isScenarioId(scenario)).toBe(true);
    }
    expect(isScenarioId('nonsense')).toBe(false);
  });

  it('gives every scenario a script that obeys the input contract', () => {
    // A script returning a malformed command would fail deep inside the simulation with an error that
    // looks like a gameplay bug. The bounds are the ones the player itself is held to.
    for (const scenario of SCENARIOS) {
      const script = playerScript(scenario);
      for (const tick of [0, 1, 59, 600, 5000]) {
        const input = script(tick, context());
        expect(Number.isFinite(input.throttle)).toBe(true);
        expect(Math.abs(input.throttle)).toBeLessThanOrEqual(1);
        expect(Number.isFinite(input.turn)).toBe(true);
        expect(Math.abs(input.turn)).toBeLessThanOrEqual(1);
        // No script ever asks to fire, so every shell in a batch belongs to the opponent and a
        // measurement of its behaviour is not muddied by the harness's own gunnery. An aim *point* is a
        // different matter: the turret is still a servo the player would have, and aiming it is a
        // movement a real player does.
        expect(input.fire).toBe(false);
      }
    }
  });

  it('gives a parked player no input at all', () => {
    expect(playerScript('parked')(0, context())).toEqual(NEUTRAL_INPUT);
  });

  it('steers the hull toward the opponent, not just the turret', () => {
    // A regression test for a measurement that was quietly measuring the wrong thing, and the subtlest
    // thing this harness got wrong. In this game the aim point servos the *turret*; it does not move the
    // tank. The first version of `charging` supplied only an aim point, so the player accelerated in a
    // straight line, passed the opponent on the third second and drove off into unbounded terrain — all
    // twenty seeds finishing 183 m apart, which measured a footrace and called it a charge.
    //
    // So the scenario has to command `turn`, and it has to do so *relative to the hull's own heading*.
    // Pointed the wrong way, the demand must be large; already lined up, it must be near zero.
    const script = playerScript('charging');

    const facing = script(0, {
      enemyPosition: { x: 0, y: 0, z: 60 },
      playerPosition: { x: 0, y: 0, z: 0 },
      playerHeadingRad: 0,
    });
    const facingAway = script(0, {
      enemyPosition: { x: 0, y: 0, z: 60 },
      playerPosition: { x: 0, y: 0, z: 0 },
      playerHeadingRad: Math.PI,
    });

    expect(Math.abs(facing.turn)).toBeLessThan(0.01);
    expect(Math.abs(facingAway.turn)).toBe(1);
    expect(facing.throttle).toBe(1);
  });

  it('reverses away from the opponent when retreating', () => {
    // The same separation of concerns, inverted. A retreat that reversed while pointing at the enemy would
    // close the range, which is the opposite of the scenario.
    const input = playerScript('retreating')(0, context());
    expect(input.throttle).toBeLessThan(0);
  });

  it('changes what a mixed battle is doing over its course', () => {
    // If the mixed script did one thing throughout, it would be a different scenario wearing the right
    // name, and the default batch would quietly stop being the varied one it is documented to be.
    const script = playerScript('mixed');
    const throttles = new Set<number>();
    for (let tick = 0; tick < 6000; tick += 1) {
      throttles.add(script(tick, context()).throttle);
    }
    expect(throttles.size).toBeGreaterThan(1);
  });
});

describe('the report', () => {
  it('serialises to JSON and back unchanged', () => {
    // The machine-readable path has to carry the same data as the text one. A lossy JSON output would make
    // `--json` a worse source of truth than the terminal it is meant to improve on.
    const report = runBatch({ battles: 2, seedStart: 5, scenario: 'circling', maxTicks: SHORT_TICKS });

    expect(JSON.parse(formatJson(report))).toEqual(report);
  });

  it('summarises a batch into something readable', () => {
    const report = runBatch({ battles: 2, seedStart: 5, scenario: 'parked', maxTicks: SHORT_TICKS });
    const text = formatSummary(report);

    expect(text).toContain('headless battles');
    expect(text).toContain('parked');
    // Every seed appears, so a reader can go straight to the row they care about.
    for (const battle of report.battles) {
      expect(text).toContain(String(battle.seed));
    }
  });

  it('documents every scenario the parser accepts', () => {
    // A usage line that omits a valid scenario is how a working flag ends up looking broken.
    const usage = formatUsage();
    for (const scenario of SCENARIOS) {
      expect(usage).toContain(scenario);
    }
  });
});

describe('V6: the harness on a battlefield', () => {
  it('fights the same battle twice on a map, identically', () => {
    // The determinism guarantee has to hold on the V6 map too, not only on the legacy arena. Ashford
    // Valley is the world the player actually plays in, so a seed that reproduces there is the one
    // worth being able to hand to someone.
    const options = {
      battles: 2,
      seedStart: 4242,
      scenario: 'mixed' as const,
      maxTicks: SHORT_TICKS,
      map: ASHFORD_VALLEY,
    };
    expect(runBatch(options)).toEqual(runBatch(options));
  });

  it('produces a different fight on a different map from the same seed', () => {
    // The converse, and the one that would catch a `--map` flag that was accepted and then ignored.
    // Cover, terrain and spawns all differ, so the battles cannot coincide.
    const onMap = runBattle(7, 'mixed', SHORT_TICKS, ASHFORD_VALLEY);
    const onArena = runBattle(7, 'mixed', SHORT_TICKS);
    expect(onMap).not.toEqual(onArena);
  });

  it('keeps damaging the player on the authored map, so no fight can stall forever', () => {
    // The V6 question the harness has to answer about a new map: could two tanks spend a whole
    // budget unable to affect each other? On a map full of hard cover, easily - and the failure looks
    // healthy in every other metric, because both vehicles are intact and nothing threw.
    //
    // Measured on Ashford Valley: every seed lands roughly 5-6 penetrating shells in the first two
    // minutes, which is most of the player's 1000 hit points. A budget long enough to kill is therefore
    // long enough to prove the fight is progressing, and the assertion below is on *damage dealt*
    // rather than on a decision, because it is the honest signal: a battle that damages nothing has
    // stalled, whether or not the clock eventually ran out.
    //
    // 18000 ticks = five minutes. Chosen because it comfortably exceeds the measured ~190 s needed to
    // destroy a parked player, with room to spare, so a seed that deals no damage has genuinely failed
    // rather than merely been cut short.
    const report = runBatch({
      battles: 3,
      seedStart: 1,
      maxTicks: 18000,
      scenario: 'parked',
      map: ASHFORD_VALLEY,
    });
    // Every seed, not the batch in aggregate: one seed working would hide five that do not.
    for (const battle of report.battles) {
      expect(battle.damageDealt).toBeGreaterThan(0);
    }
  });

  it('leaves the combat rules intact on the V6 map', () => {
    // The V6 brief is explicit that the V4/V5 combat experience must survive the terrain work. The
    // cheapest honest check is that a battle on the new map still produces penetrations: a map that
    // silently stopped letting shells through would satisfy every structural test and fail the game.
    const report = runBatch({
      battles: 4,
      // Five minutes, for the same measured reason as the test above.
      maxTicks: 18000,
      scenario: 'parked',
      map: ASHFORD_VALLEY,
    });
    expect(report.totals.penetrations).toBeGreaterThan(0);
  });
});
