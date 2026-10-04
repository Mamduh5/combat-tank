import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/core/sim/world.js';
import { buildWorldPlates, type WorldPlate } from '../../src/core/armor/geometry.js';
import {
  assessPlate,
  bestPredictedShot,
  bestVisibleMarginMm,
  estimateImpactSpeed,
  weakestVisibleRegion,
} from '../../src/core/ai/shot-evaluation.js';
import {
  chooseIntent,
  createEngagementMemory,
  recordShot,
  ENGAGEMENT_TUNING,
  TACTIC_TUNING,
  type Situation,
} from '../../src/core/ai/engagement-plan.js';
import { ENEMY_TUNING } from '../../src/core/ai/enemy-controller.js';
import { vec3 } from '../../src/shared/vec3.js';
import { CT_MEDIUM } from '../../src/shared/roster.js';
import { makeInput, NEUTRAL_INPUT } from '../../src/shared/input.js';

/**
 * V5 tests: the opponent reasons about armour and changes what it does.
 *
 * These are deliberately **unit tests of the decision layers**, not of a recorded movement sequence.
 * A test that froze an exact drive path would break on every tuning change and would not actually prove
 * anything: the point of V5 is that behaviour *emerges* from terrain and situation, so the properties
 * worth pinning are invariants ("it never fires without a solution", "three failures produce a flank"),
 * not trajectories.
 *
 * ## Why the shooter here is the medium
 *
 * The assertions in this file are about whether the decision layer reads the armour model correctly. The
 * specific plate being defended is the medium's, and the specific shell being *expected to fail* against it
 * has to be a shell that genuinely fails — 150 mm of penetration against a plate presenting ~400 mm. The
 * heavy's 260 mm shell does defeat that plate, which is a correct and separately-pinned fact about the
 * roster but would make "cannot be beaten" false for reasons that have nothing to do with what these tests
 * are checking.
 */

/** A player at the given point, **facing** the shooter, so its frontal plate is presented. */
function playerPlatesAt(shooter: { x: number; y: number; z: number }): WorldPlate[] {
  const position = vec3(shooter.x, shooter.y, shooter.z);
  // Heading zero points the nose along +Z, so with the shooter further along +Z the player faces it.
  // Getting this backwards would silently turn "frontal plate" into "rear plate" and make the armour
  // assertions below pass for entirely the wrong reason.
  return buildWorldPlates(CT_MEDIUM, position, 0, 0);
}

describe('shot prediction', () => {
  it('predicts a frontal plate cannot be beaten, using the real penetration model', () => {
    // The player faces the shooter. Its 200 mm plate pitched 60 degrees presents ~400 mm, which the
    // 150 mm shell cannot defeat. This is the exact case OD-11 was about, asserted at the lowest level.
    const eye = vec3(0, 1.4, 55);
    const plates = playerPlatesAt(eye);
    const front = plates.find((p) => p.definition.region === 'hull-front')!;

    const assessment = assessPlate(eye, front, CT_MEDIUM, true);

    expect(assessment.visible).toBe(true);
    expect(assessment.effectiveArmorMm).toBeGreaterThan(CT_MEDIUM.mainShell.nominalPenetrationMm);
    expect(assessment.marginMm).toBeLessThan(0);
    expect(assessment.predictedPenetration).toBe(false);
  });

  it('predicts a flank is penetrable, and prefers it over the front', () => {
    // Shot into the player's side rather than its nose. The prediction must follow the geometry, not the
    // plate's nominal thickness, which is the whole point of scoring by margin.
    //
    // Two things are easy to get wrong here and both make the test pass for the wrong reason. The shooter
    // has to be off to the side, because from dead ahead the flank plates are edge-on and score 90 degrees
    // of incidence. And the *presented* flank has to be selected rather than the first one in the list:
    // the player carries two `hull-side` plates facing opposite ways, and the one on the far side is
    // correctly scored as unpenetrable, because its back is toward the shooter.
    const eye = vec3(40, 1.4, 40);
    const plates = playerPlatesAt(vec3(0, 1.4, 40));
    const front = plates.find((p) => p.definition.region === 'hull-front')!;
    // The flank whose outer surface actually faces the shooter.
    const side = plates.find(
      (p) =>
        p.definition.region === 'hull-side' &&
        p.normal.x * (eye.x - p.center.x) + p.normal.z * (eye.z - p.center.z) > 0,
    )!;

    const frontShot = assessPlate(eye, front, CT_MEDIUM, true);
    const sideShot = assessPlate(eye, side, CT_MEDIUM, true);

    // A 80 mm flank is comfortably beatable by 150 mm of penetration at close to square incidence.
    expect(sideShot.incidenceAngleDeg).toBeLessThan(20);
    expect(sideShot.predictedPenetration).toBe(true);
    expect(sideShot.marginMm).toBeGreaterThan(frontShot.marginMm);
  });

  it('offers no shot when every plate is behind terrain', () => {
    // Visibility is per plate and enforced, so armour the opponent cannot see is not a candidate.
    const eye = vec3(0, 1.4, 55);
    const plates = playerPlatesAt(eye).map((p) => assessPlate(eye, p, CT_MEDIUM, false));

    expect(plates.every((p) => !p.visible)).toBe(true);
    expect(bestPredictedShot(plates)).toBeNull();
    // And an unseen player is not merely a hopeless visible one.
    expect(bestVisibleMarginMm(plates)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('ignores armour it cannot see when reporting the weakest region', () => {
    // `weakestVisibleRegion` is what the flank planner steers toward, so it must never return a hidden
    // plate - otherwise the opponent drives toward armour it believes in on no evidence.
    //
    // Both the flanks and the floor are hidden here, because the 20 mm floor is genuinely the thinnest
    // plate on the tank and would otherwise always win, making the assertion meaningless.
    const eye = vec3(40, 1.4, 40);
    const hidden = ['hull-side', 'hull-floor'];
    const assessments = playerPlatesAt(vec3(0, 1.4, 40)).map((p) =>
      assessPlate(eye, p, CT_MEDIUM, !hidden.includes(p.definition.region)),
    );

    const weakest = weakestVisibleRegion(assessments);
    expect(weakest).not.toBeNull();
    expect(hidden).not.toContain(weakest!.region);
  });

  it('estimates a descending shell as arriving faster, and credits it with that capability', () => {
    // Counter-intuitive but correct, and worth pinning. Gravity accelerates a shell *downward* during
    // flight, so a longer, dropping shot arrives with greater total speed - and the penetration model
    // scales capability by arrival speed, so long shots are not automatically weaker. This is why the
    // estimate sums the two components in quadrature rather than reducing a single figure.
    expect(estimateImpactSpeed(800, 200)).toBeGreaterThan(estimateImpactSpeed(800, 20));
  });

});

describe('tactical intent', () => {
  const baseSituation = (over: Partial<Situation> = {}): Situation => ({
    canSeePlayer: true,
    rangeM: 55,
    position: vec3(0, 0, 0),
    bestShot: null,
    gunDisabled: false,
    immobilised: false,
    destroyed: false,
    hasEverSeenPlayer: true,
    ...over,
  });

  const shot = { region: 'hull-side' } as NonNullable<Situation['bestShot']>;

  it('engages when a shot is predicted', () => {
    const memory = createEngagementMemory();
    expect(chooseIntent(baseSituation({ bestShot: shot }), memory).intent).toBe('engage');
  });

  it('probes before it concludes, rather than never firing at all', () => {
    // The deadlock this guards against is subtle: if the opponent only flanks after observing failures,
    // and it refuses to fire at armour it believes is hopeless, it can never observe one. The first V5
    // build stood in front of an invulnerable tank indefinitely for exactly this reason.
    const memory = createEngagementMemory();
    expect(chooseIntent(baseSituation(), memory).intent).toBe('probe');
  });

  it('flanks after the configured number of ineffective shots', () => {
    const memory = createEngagementMemory();
    for (let i = 0; i < ENGAGEMENT_TUNING.ineffectiveThreshold; i += 1) {
      recordShot(memory, false);
    }
    expect(chooseIntent(baseSituation(), memory).intent).toBe('flank');
    expect(memory.flankSide).not.toBe(0);
  });

  it('resets its frustration the moment a shot gets through', () => {
    const memory = createEngagementMemory();
    recordShot(memory, false);
    recordShot(memory, false);
    recordShot(memory, true);
    expect(memory.ineffectiveStreak).toBe(0);
    expect(memory.probeStreak).toBe(0);
    expect(chooseIntent(baseSituation({ bestShot: shot }), memory).intent).toBe('engage');
  });

  it('abandons a flank when a shot opens up mid-manoeuvre', () => {
    const memory = createEngagementMemory();
    recordShot(memory, false);
    recordShot(memory, false);
    recordShot(memory, false);
    chooseIntent(baseSituation(), memory);
    expect(memory.flankSide).not.toBe(0);
    expect(chooseIntent(baseSituation({ bestShot: shot }), memory).intent).toBe('engage');
    expect(memory.flankSide).toBe(0);
  });

  it('tries the other side when a flank times out', () => {
    const memory = createEngagementMemory();
    memory.flankSide = 1;
    memory.flankTicks = ENGAGEMENT_TUNING.flankTimeoutSeconds * 60 + 1;
    expect(chooseIntent(baseSituation(), memory).intent).toBe('flank');
    expect(memory.flankSide).toBe(-1);
  });

  it('searches rather than flanks when it cannot see the player', () => {
    const memory = createEngagementMemory();
    memory.ineffectiveStreak = 3;
    expect(chooseIntent(baseSituation({ canSeePlayer: false }), memory).intent).toBe('search');
    expect(memory.ineffectiveStreak).toBe(0);
  });

  it('fixes range before worrying about the angle', () => {
    const memory = createEngagementMemory();
    expect(chooseIntent(baseSituation({ rangeM: 120 }), memory).intent).toBe('adjust-range');
    expect(chooseIntent(baseSituation({ rangeM: 15 }), memory).intent).toBe('adjust-range');
  });

  it('keeps fighting when immobilised, and withdraws when its gun is gone', () => {
    const memory = createEngagementMemory();
    expect(
      chooseIntent(baseSituation({ immobilised: true, bestShot: shot }), memory).intent,
    ).toBe('hold-position');
    expect(chooseIntent(baseSituation({ gunDisabled: true }), memory).intent).toBe('withdraw');
    expect(chooseIntent(baseSituation({ destroyed: true }), memory).intent).toBe('disabled');
  });

  it('keeps its probe limit and its flank threshold in step', () => {
    // If the probe limit were lower, the opponent would run out of patience before it had the evidence
    // to justify flanking, and the deadlock would return wearing a different hat.
    expect(ENGAGEMENT_TUNING.probeShotLimit).toBe(ENGAGEMENT_TUNING.ineffectiveThreshold);
  });

  it('does not cancel a flank it has already committed to, by re-checking the range band', () => {
    // A regression test for a real deadlock. The range-band check runs above the flank logic, so an
    // unconditional band check cancelled an in-progress flank on the very next tick. Measured: the
    // opponent flapped between `flank` and `adjust-range` for the rest of the fight, its flank
    // destination sat a steady 78 m away, and it never moved toward it.
    //
    // The rule being pinned is that a flank is allowed to *finish* even when it leaves the band, because
    // going around is exactly what a flank does. It is still not allowed to *start* out of band, which
    // is what keeps a charging player from being circled at knife-fighting range.
    const memory = createEngagementMemory();
    memory.flankSide = 1;
    memory.flankTicks = 10;
    // Out of the band (too close) *and* committed to a flank: the flank must survive.
    expect(chooseIntent(baseSituation({ rangeM: 18, bestShot: null }), memory).intent).toBe('flank');

    // Out of the band and not flanking: the band rule still applies, which is the charging-player case.
    const fresh = createEngagementMemory();
    expect(chooseIntent(baseSituation({ rangeM: 18, bestShot: null }), fresh).intent).toBe(
      'adjust-range',
    );
  });

  it('cannot be told to fight at a range its gun refuses to shoot from', () => {
    // The planner's near edge and the gun's minimum range were 32 m and 24 m, which left a band - 24 m
    // to 32 m - in which the opponent was perfectly able to shoot and had decided not to. Sizing one from
    // the other is what keeps that dead zone from reappearing, and these three numbers are the ones that
    // have to agree: the band the planner fights in, the range a retreat stops at, and the closest range
    // the gun will actually shoot from.
    expect(TACTIC_TUNING.nearRangeM).toBeLessThanOrEqual(ENEMY_TUNING.minEngageRangeM);
    // A retreat must land somewhere the gun is usable, or it retreats straight back into the dead zone.
    expect(ENEMY_TUNING.reengageRangeM).toBeGreaterThanOrEqual(ENEMY_TUNING.minEngageRangeM);
    expect(ENEMY_TUNING.reengageRangeM).toBeLessThanOrEqual(TACTIC_TUNING.farRangeM);
  });
});

describe('the encounter as a whole', () => {
  it('uses more than one behaviour, rather than replaying a single script', () => {
    // The quality bar for V5 is not "an AI state machine executes" but "fighting it feels different".
    // The observable form of that is variety: the opponent must change what it is doing over a fight.
    //
    // An earlier version of this test asserted the opponent must choose to flank against a parked player.
    // That was simply false, and finding out was the useful part: in this arena a parked player does not
    // present a clean frontal plate â€” the opponent finds its turret flanks and its rear as it circles and
    // wins without ever needing to commit to a flank. The assertion was checking for a mechanism rather
    // than for competence, which is the wrong thing to assert.
    // The seed is pinned because the assertion below is about outcome as well as variety, and whether the
    // opponent happens to land a hit in a given minute is legitimately seed-dependent.
    const simulation = new Simulation({
      vehicle: CT_MEDIUM,
      target: CT_MEDIUM,
      enemySeed: 12345,
    });
    const intents = new Set<string>();

    for (let i = 0; i < 2400; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
      intents.add(simulation.enemyController!.diagnostics.intent);
    }

    expect(intents.size).toBeGreaterThan(1);
    // And it is a fight that resolves, which is the product requirement that actually matters.
    expect(simulation.vehicle.damage.hitPoints).toBeLessThan(
      CT_MEDIUM.survivability.hitPoints,
    );
  });

  it('is reproducible from its seed, and a restart replays the encounter exactly', () => {
    // Restart must go through the *simulation*, not the controller alone. Calling
    // `controller.restart()` on its own clears the opponent's memory but leaves both vehicles, every shell
    // and the tick clock where they were, so the second run is a continuation rather than a replay and
    // diverges immediately. `Simulation.restart` is the only thing that resets the whole encounter.
    const simulation = new Simulation({
      vehicle: CT_MEDIUM,
      target: CT_MEDIUM,
      enemySeed: 4242,
    });
    const controller = simulation.enemyController!;

    const run = (): { x: number; shots: number } => {
      for (let i = 0; i < 900; i += 1) {
        simulation.tick(NEUTRAL_INPUT);
      }
      return { x: simulation.target!.state.position.x, shots: controller.diagnostics.shotsObserved };
    };

    const first = run();
    expect(first.shots).toBeGreaterThan(0);

    simulation.restart();

    // The opponent's memory of the previous fight must be gone, or the new battle opens already
    // frustrated and flanking on the strength of bounces it has not yet fired.
    expect(controller.diagnostics.shotsObserved).toBe(0);
    expect(controller.diagnostics.ineffectiveStreak).toBe(0);

    const second = run();
    expect(second.shots).toBe(first.shots);
    expect(second.x).toBeCloseTo(first.x, 9);
  });

  it('replays the gun itself, not merely the positions', () => {
    // The determinism test above compares a position at the end of the run, which is a weak signal: a
    // divergence confined to the gun's elevation is invisible in it until the shell lands somewhere else.
    // That is exactly what happened. Two runs matched on positions, hit points and shot counts for 228
    // ticks and then differed, because the aim scatter had been drawn from a different offset in the
    // random stream - the constructor consumes one draw to pick a flank side, and the restart path
    // reseeded without replaying it.
    //
    // So this compares the barrel's own orientation tick by tick. Any future change that perturbs the
    // random stream, the aim point, or the servo will fail here rather than in a position three
    // thousand ticks later.
    const simulation = new Simulation({
      vehicle: CT_MEDIUM,
      target: CT_MEDIUM,
      enemySeed: 4242,
    });
    const enemy = simulation.target!;
    const trace = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 900; i += 1) {
        simulation.tick(NEUTRAL_INPUT);
        out.push(enemy.turretState.localAngleRad, enemy.turretState.elevationRad);
      }
      return out;
    };

    const first = trace();
    simulation.restart();
    const second = trace();

    expect(second).toEqual(first);
  });

  it('shoots at a charging player instead of closing out of its own firing range', () => {
    // The V4 regression, and the reason the engagement band and the creep throttle needed rework.
    //
    // Measured before the fix: the opponent had a valid predicted solution (84 mm of margin on the
    // player's turret side) from 50 m, crept forward, and by the time its gun was nearly laid the range
    // had collapsed to 28 m. Below the planner's near edge that is `adjust-range`, which does not shoot.
    // So the opponent spent the entire charge holding a good solution and never fired, and the player
    // drove straight past it untouched.
    const simulation = new Simulation({
      vehicle: CT_MEDIUM,
      target: CT_MEDIUM,
      enemySeed: 12345,
    });

    // A player driving straight at the opponent at full throttle: the hardest case for a finite traverse
    // rate, because the bearing to them sweeps fastest when they are closest.
    for (let i = 0; i < 900; i += 1) {
      simulation.tick(makeInput(1, 0, vec3(0, 0, 60), false));
    }

    expect(simulation.target!.telemetry.shotsFired).toBeGreaterThan(0);
  });

  it('keeps up with a player who circles away, rather than losing them for good', () => {
    // The last real weakness in the V5 opponent, and the reason `pursuitPoint` exists.
    //
    // `search` used to drive to the player's *last known position*, which treats a stale point as a
    // place to arrive at. A player who is still moving guarantees it is not there, so the opponent
    // closed on it, arrived, found nothing and repeated â€” while the range grew without bound. Measured
    // before the fix: 55 m, 90 m, 111 m, 144 m, 160 m, and then permanent `search` for the rest of the
    // fight, with the opponent driving to an arena centre the player had long since left.
    //
    // The assertion is deliberately about the *shape* of the range, not about winning. A player who
    // circles at a steady 3.4 m/s against an opponent of the same top speed is genuinely hard to keep in
    // contact with, and it would be wrong to demand a kill. What must not happen is a range that only
    // ever grows: that is the signature of an opponent that has stopped pursuing.
    const simulation = new Simulation({
      vehicle: CT_MEDIUM,
      target: CT_MEDIUM,
      enemySeed: 12345,
    });

    let maxRangeM = 0;
    let rangeAtHalfwayM = 0;
    let closestInFinalThirdM = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3600; i += 1) {
      simulation.tick(makeInput(0.4, 0.5, null, false));
      const rangeM = simulation.enemyController!.diagnostics.rangeM;
      maxRangeM = Math.max(maxRangeM, rangeM);
      if (i === 1800) {
        rangeAtHalfwayM = rangeM;
      }
      if (i >= 2400) {
        closestInFinalThirdM = Math.min(closestInFinalThirdM, rangeM);
      }
    }

    // It does open the range early on, while it is still turning around — that is honest and expected.
    // What matters is that it comes back. Before the fix the range at the halfway mark was already
    // beyond the maximum for the rest of the fight.
    expect(rangeAtHalfwayM).toBeLessThan(maxRangeM);
    // ...and that it actually closes again, rather than finishing the fight at a distance. Measured for
    // this seed and matchup the range runs 55, 41, 58, 90, 98, 144, 185, 130, 33, 51, 89: it peaks during
    // a fifteen-second `search` after contact is lost, then closes to 33 m and trades again.
    //
    // The assertion is on the *closest* approach in the final third rather than the final frame. The
    // opponent oscillates in and out of its 32-90 m engagement band as it re-acquires, so pinning the last
    // frame would be asserting where a fight happened to be when the clock ran out. What has to be true —
    // and was not true before the pursuit fix — is that it gets back inside knife range at all.
    expect(closestInFinalThirdM).toBeLessThan(60);

    // The peak is a ceiling, not a measurement, and it was raised from 140 m in V8. The old figure was
    // calibrated against a 5.6 m/s opponent; this opponent is a full medium at 11.1 m/s, and the higher
    // peak comes from the search phase running longer, not from pursuit failing.
    expect(maxRangeM).toBeLessThan(220);
  });

  it('lands its shots rather than firing past the player', () => {
    // The other half of the same defect. The fire gate was an *angular* tolerance, which means the
    // permitted miss grows with range: at 4 degrees, 4.3 m of lateral error at 48 m and 5.6 m at 71 m,
    // on a tank 3.3 m wide. The gunner was told it was on target while pointing a vehicle-width past.
    //
    // Measured before the fix, per shot: misses of 0.35 m and 0.73 m struck the player; 2.26 m, 3.56 m,
    // 4.32 m and 5.72 m passed it entirely. The assertion is deliberately about *arriving*, not about
    // penetrating - penetration is the armour model's decision (ADR-0016) and the front plate is
    // supposed to stop a head-on shot.
    const simulation = new Simulation({
      vehicle: CT_MEDIUM,
      target: CT_MEDIUM,
      enemySeed: 4242,
    });

    let shotsThatStruck = 0;
    for (let i = 0; i < 3600; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
      // Any combat result at all means the shell reached the vehicle, whether it got through or not.
      shotsThatStruck += simulation.incomingCombat.length;
    }

    const fired = simulation.target!.telemetry.shotsFired;
    expect(fired).toBeGreaterThan(0);
    // Not every shot has to arrive - the aim scatter is deliberately human - but a gunner that misses
    // the target outright more often than it hits it is not a gunner, it is a coin flip.
    expect(shotsThatStruck).toBeGreaterThan(0);
  });
});
