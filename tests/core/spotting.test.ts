import { describe, expect, it } from 'vitest';
import { Battlefield } from '../../src/core/world/battlefield.js';
import { ASHFORD_VALLEY } from '../../src/core/world/maps/ashford-valley.js';
import { sampleConcealment, CONCEALMENT_FACTOR } from '../../src/core/world/concealment.js';
import { evaluateDetection, SPOTTING_TUNING, type SpottingSubject } from '../../src/core/spotting/spotting.js';
import { ContactTracker } from '../../src/core/spotting/contact-tracker.js';
import { vec3, type Vec3 } from '../../src/shared/vec3.js';

/**
 * V6 tests: spotting, detection and concealment.
 *
 * The requirement these protect is not "detection works" but that it is **legible**: a player who cannot
 * predict when they have been seen cannot make a decision about it. So the tests lean towards the
 * *edges* of each rule — just inside and just outside — because the edges are where a system becomes
 * unpredictable rather than merely wrong.
 */

const battlefield = new Battlefield(ASHFORD_VALLEY);

/** A subject standing at a point on the map, at the turret ring height a real vehicle would present. */
function subject(x: number, z: number, firedThisTick = false): SpottingSubject {
  return {
    id: 'test',
    position: vec3(x, battlefield.terrain.heightAt(x, z), z),
    eyeHeightM: 1.42,
    firedThisTick,
  };
}

/** Two vehicles looking at each other across a given separation on Ashford's own ground. */
function facing(apartM: number, bFired = false) {
  return evaluateDetection(battlefield, subject(0, 0), subject(0, apartM, bFired));
}

describe('detection', () => {
  it('sees a vehicle in the open at a sensible range', () => {
    // The baseline. A tank on open ground at 100 m must be visible, or the map carries no information
    // and every encounter becomes a guess.
    expect(facing(100).detected).toBe(true);
  });

  it('stops seeing a vehicle in the open beyond its range', () => {
    // The upper edge, and the number most likely to need rebalancing once a human has played. This test
    // is also the one that caught the observer-penalty bug: an unconditional multiplier had quietly
    // shortened *everyone*'s' range to 170 m, so the "visible" side of the boundary failed.
    const base = SPOTTING_TUNING.baseSightRangeM;
    const from = subject(0, 0);

    expect(evaluateDetection(battlefield, from, subject(0, base * 0.9)).detected).toBe(true);
    expect(evaluateDetection(battlefield, from, subject(0, base * 1.1)).detected).toBe(false);
  });

  it('loses a vehicle behind a building even at close range', () => {
    // Distance must not be the only thing that matters. A tank 30 m away on the far side of a
    // warehouse is not visible, and if it were, cover would be decoration.
    const barn = ASHFORD_VALLEY.structures.find((s) => s.id === 'red-barn')!;
    const result = evaluateDetection(
      battlefield,
      subject(barn.x - 30, barn.z),
      subject(barn.x + 30, barn.z),
    );

    expect(result.detected).toBe(false);
    expect(result.blockedByCover).toBe(true);
  });

  it('shortens detection in concealment, and the heavy kind hides more than the light kind', () => {
    // The relationship a player has to learn. "The wood hides me, the scrub does not" is only learnable
    // if the two are measurably different, so this asserts the ordering rather than exact numbers.
    const zones = ASHFORD_VALLEY.concealment;
    const wood = zones.find((z) => z.id === 'wood-core')!;
    const scrub = zones.find((z) => z.id === 'scrub-b')!;

    const inWood = sampleConcealment(zones, wood.x, wood.z);
    const inScrub = sampleConcealment(zones, scrub.x, scrub.z);

    expect(inWood.concealed).toBe(true);
    expect(inScrub.concealed).toBe(true);
    expect(inWood.factor).toBeLessThan(inScrub.factor);
    expect(CONCEALMENT_FACTOR.heavy).toBeLessThan(CONCEALMENT_FACTOR.light);
  });

  it('cannot see into heavy concealment from far off, but can from close to', () => {
    // Concealment has to actually *do* something, not merely shave a number that was already generous.
    const wood = ASHFORD_VALLEY.concealment.find((z) => z.id === 'wood-core')!;
    const target = subject(wood.x, wood.z);

    expect(evaluateDetection(battlefield, subject(wood.x + 150, wood.z), target).detected).toBe(false);
    expect(evaluateDetection(battlefield, subject(wood.x + 25, wood.z), target).detected).toBe(true);
  });

  it('fades concealment smoothly to the edge of a zone rather than with a visible line', () => {
    // A hard-edged disc draws a line on the ground where concealment stops, and a player reads that
    // line as a bug. The smoothstep falloff is what stops the line existing.
    const zones = ASHFORD_VALLEY.concealment;
    const wood = zones.find((z) => z.id === 'wood-core')!;

    const centre = sampleConcealment(zones, wood.x, wood.z).factor;
    const midway = sampleConcealment(zones, wood.x + wood.radiusM * 0.5, wood.z).factor;
    const nearEdge = sampleConcealment(zones, wood.x + wood.radiusM * 0.9, wood.z).factor;
    const outside = sampleConcealment(zones, wood.x + wood.radiusM * 1.5, wood.z).factor;

    expect(centre).toBeLessThan(midway);
    expect(midway).toBeLessThan(nearEdge);
    expect(nearEdge).toBeLessThan(outside);
    expect(outside).toBe(1);
  });

  it('reveals a vehicle that fires, past the range it could otherwise be seen at', () => {
    // The rule the V6 brief asks to be considered: hiding helps, but firing can reveal you. One number,
    // one sentence, tested at the edge so it cannot quietly grow.
    expect(facing(SPOTTING_TUNING.baseSightRangeM * 0.95, true).detected).toBe(true);
  });

  it('does not let a shot reveal a target across the whole map', () => {
    // The limit that keeps the rule from becoming a cheat. Without it a player could blind-fire at the
    // far corner and paint the enemy on the HUD, which is not a tactical decision.
    expect(facing(400, true).detected).toBe(false);
  });
});

describe('contact', () => {
  const seen: Vec3 = vec3(10, 0, 0);
  const elsewhere: Vec3 = vec3(50, 0, 0);
  const detected = { detected: true, rangeM: 10, effectiveRangeM: 200, blockedByCover: false };
  const hidden = { detected: false, rangeM: 10, effectiveRangeM: 200, blockedByCover: true };

  it('reports acquisition, loss and reacquisition, once each', () => {
    // The point of the state machine: a player has to be *told* when contact changes, because "I cannot
    // see it any more" is otherwise indistinguishable from "it is still there".
    const tracker = new ContactTracker();

    tracker.update(detected, seen, false, 1, 1 / 60);
    expect(tracker.contact.state).toBe('detected');
    expect(tracker.drainEvents().map((e) => e.kind)).toEqual(['acquired']);

    // Break contact for longer than the grace period.
    for (let i = 0; i < 200; i += 1) {
      tracker.update(hidden, elsewhere, false, 1, 1 / 60);
    }
    expect(tracker.contact.state).toBe('lost');
    expect(tracker.drainEvents().map((e) => e.kind)).toEqual(['lost']);

    tracker.update(detected, seen, false, 1, 1 / 60);
    expect(tracker.contact.state).toBe('detected');
    expect(tracker.drainEvents().map((e) => e.kind)).toEqual(['reacquired']);
  });

  it('does not report a loss for a momentary occlusion', () => {
    // The flicker problem, as a test. A vehicle crossing a treeline edge blinks out for a few ticks, and
    // a system that called that a loss each time would strobe the player's indicator.
    const tracker = new ContactTracker();
    tracker.update(detected, seen, false, 1, 1 / 60);
    tracker.drainEvents();

    for (let i = 0; i < 10; i += 1) {
      tracker.update(hidden, elsewhere, false, 1, 1 / 60);
    }

    expect(tracker.contact.state).toBe('detected');
    expect(tracker.drainEvents()).toHaveLength(0);
  });

  it('remembers where the target was last seen', () => {
    // "Lost somewhere over there" is only actionable if "there" is a position. A system that forgot the
    // last sighting would leave the player with nothing at all to reason about.
    const tracker = new ContactTracker();
    tracker.update(detected, seen, false, 1, 1 / 60);
    for (let i = 0; i < 200; i += 1) {
      tracker.update(hidden, elsewhere, false, 1, 1 / 60);
    }

    expect(tracker.contact.lastKnownPosition).toEqual(seen);
  });

  it('forgets everything on reset, so a restart cannot inherit contact', () => {
    const tracker = new ContactTracker();
    tracker.update(detected, seen, false, 1, 1 / 60);
    tracker.reset();

    expect(tracker.contact.state).toBe('undetected');
    expect(tracker.contact.lastKnownPosition).toBeNull();
    expect(tracker.drainEvents()).toHaveLength(0);
  });
});
