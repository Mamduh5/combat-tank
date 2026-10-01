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
  type Situation,
} from '../../src/core/ai/engagement-plan.js';
import { vec3 } from '../../src/shared/vec3.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import { ENEMY_TANK } from '../../src/shared/enemy-tank.js';
import { NEUTRAL_INPUT } from '../../src/shared/input.js';

/**
 * V5 tests: the opponent reasons about armour and changes what it does.
 *
 * These are deliberately **unit tests of the decision layers**, not of a recorded movement sequence.
 * A test that froze an exact drive path would break on every tuning change and would not actually prove
 * anything: the point of V5 is that behaviour *emerges* from terrain and situation, so the properties
 * worth pinning are invariants ("it never fires without a solution", "three failures produce a flank"),
 * not trajectories.
 */

/** A player at the given point, **facing** the shooter, so its frontal plate is presented. */
function playerPlatesAt(shooter: { x: number; y: number; z: number }): WorldPlate[] {
  const position = vec3(shooter.x, shooter.y, shooter.z);
  // Heading zero points the nose along +Z, so with the shooter further along +Z the player faces it.
  // Getting this backwards would silently turn "frontal plate" into "rear plate" and make the armour
  // assertions below pass for entirely the wrong reason.
  return buildWorldPlates(PLACEHOLDER_TANK, position, 0, 0);
}

describe('shot prediction', () => {
  it('predicts a frontal plate cannot be beaten, using the real penetration model', () => {
    // The player faces the shooter. Its 200 mm plate pitched 60 degrees presents ~400 mm, which the
    // 150 mm shell cannot defeat. This is the exact case OD-11 was about, asserted at the lowest level.
    const eye = vec3(0, 1.4, 55);
    const plates = playerPlatesAt(eye);
    const front = plates.find((p) => p.definition.region === 'hull-front')!;

    const assessment = assessPlate(eye, front, ENEMY_TANK, true);

    expect(assessment.visible).toBe(true);
    expect(assessment.effectiveArmorMm).toBeGreaterThan(ENEMY_TANK.mainShell.nominalPenetrationMm);
    expect(assessment.marginMm).toBeLessThan(0);
    expect(assessment.predictedPenetration).toBe(false);
  });

  it('predicts a flank is penetrable, and prefers it over the front', () => {
    // Shot into the player's side rather than its nose. The prediction must follow the geometry, not the
    // plate's nominal thickness, which is the whole point of scoring by margin.
    //
    // The shooter has to be off to the side: from dead ahead the flank plates are edge-on and would be
    // scored at 90 degrees of incidence, which the ricochet rule already handles. Positioning is what
    // opens the flank, and the test has to respect that rather than assume it.
    const eye = vec3(40, 1.4, 0);
    const plates = playerPlatesAt(vec3(0, 1.4, 40));
    const front = plates.find((p) => p.definition.region === 'hull-front')!;
    const side = plates.find((p) => p.definition.region === 'hull-side')!;

    const frontShot = assessPlate(eye, front, ENEMY_TANK, true);
    const sideShot = assessPlate(eye, side, ENEMY_TANK, true);

    expect(sideShot.predictedPenetration).toBe(true);
    expect(sideShot.marginMm).toBeGreaterThan(frontShot.marginMm);
  });

  it('offers no shot when every plate is behind terrain', () => {
    // Visibility is per plate and enforced, so armour the opponent cannot see is not a candidate.
    const eye = vec3(0, 1.4, 55);
    const plates = playerPlatesAt(eye).map((p) => assessPlate(eye, p, ENEMY_TANK, false));

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
    const eye = vec3(40, 1.4, 0);
    const hidden = ['hull-side', 'hull-floor'];
    const assessments = playerPlatesAt(vec3(0, 1.4, 40)).map((p) =>
      assessPlate(eye, p, ENEMY_TANK, !hidden.includes(p.definition.region)),
    );

    const weakest = weakestVisibleRegion(assessments);
    expect(weakest).not.toBeNull();
    expect(hidden).not.toContain(weakest!.region);
  });

  it('estimates a descending shell as arriving faster, and credits it with that capability', () => {
    // Velocity scaling is real in the penetration model, so the estimate has to respect it or the
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
});

describe('the encounter as a whole', () => {
  it('stops firing at a frontal plate and physically goes around instead', () => {
    // The headline V5 behaviour, asserted end to end rather than through the planner. The opponent must
    // choose to reposition and move, not merely stop shooting.
    const simulation = new Simulation({ vehicle: PLACEHOLDER_TANK, target: ENEMY_TANK });
    const start = { ...simulation.target!.state.position };
    const intents = new Set<string>();

    for (let i = 0; i < 3600; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
      intents.add(simulation.enemyController!.diagnostics.intent);
    }

    expect(intents.has('flank')).toBe(true);
    expect(
      Math.hypot(
        simulation.target!.state.position.x - start.x,
        simulation.target!.state.position.z - start.z,
      ),
    ).toBeGreaterThan(8);
  });

  it('is reproducible from its seed, and restart clears its memory', () => {
    const simulation = new Simulation({
      vehicle: PLACEHOLDER_TANK,
      target: ENEMY_TANK,
      enemySeed: 4242,
    });
    const controller = simulation.enemyController!;

    for (let i = 0; i < 900; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
    }
    const firstX = simulation.target!.state.position.x;
    expect(controller.diagnostics.shotsObserved).toBeGreaterThan(0);

    controller.restart();

    // Restart must not leave the previous battle's frustration behind, or the new one opens by flanking.
    expect(controller.diagnostics.shotsObserved).toBe(0);
    expect(controller.diagnostics.ineffectiveStreak).toBe(0);

    for (let i = 0; i < 900; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
    }
    expect(simulation.target!.state.position.x).toBeCloseTo(firstX, 9);
  });
});
    // opponent would be systematically over-confident at range.
    expect(estimateImpactSpeed(800, 200)).toBeGreaterThan(estimateImpactSpeed(800, 20));
  });
});