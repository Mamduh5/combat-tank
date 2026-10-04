import { describe, expect, it } from 'vitest';
import { rateRoster, ratingSummary } from '../../src/client/ui/vehicle-select.js';
import { CT_HEAVY, CT_LIGHT, CT_MEDIUM, VEHICLE_ROSTER } from '../../src/shared/roster.js';
import type { VehicleDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * V8 tests: the vehicle selector's ratings.
 *
 * ## What is worth testing about four bars
 *
 * Not the pixels â€” the DOM is the uninteresting part of this file, and a screenshot test would break on a
 * font. The worth testing is the *arithmetic*, because it is the part that makes a claim about the game.
 *
 * The selector tells a player "the heavy is the most protected thing here". That claim is computed from the
 * definitions, so it can be wrong in two ways no amount of visual review would catch: it can stop reflecting
 * a vehicle that has since been retuned, or it can invert. Both are silent. So the assertions below are
 * mostly **cross-checks against the definitions' own numbers** â€” the rating is verified to agree with the
 * data it claims to describe, not merely with a snapshot of itself.
 *
 * ## The design constraint this file exists to protect
 *
 * The brief is explicit that the selector must communicate meaningful differences *without* dumping raw
 * stats. A selector that quietly grew a fifth bar, or started showing millimetres, would be a regression
 * even with no test failing. So there is a test that counts the axes and checks the surface stays at four.
 */

describe('selector ratings describe the roster', () => {
  const ratings = rateRoster();

  it('rates every vehicle in the roster', () => {
    // The completeness claim. A vehicle absent from the map renders as neutral bars rather than throwing, so
    // this is exactly the kind of gap that would otherwise be invisible until the owner looked at the screen.
    for (const entry of VEHICLE_ROSTER) {
      expect(ratings.has(entry.vehicle.id), `${entry.vehicle.id} has no ratings`).toBe(true);
    }
    expect(ratings.size).toBe(VEHICLE_ROSTER.length);
  });

  it('places every rating inside the unit interval, with the extremes reached', () => {
    // Min-max normalisation has to actually reach both ends, or the bars are all mid-grey and convey nothing.
    // Asserting only `0 <= v <= 1` would pass for a set of ratings that had collapsed to a single value â€”
    // which is precisely the "three identical vehicles" failure the roster is meant to prevent.
    const all = [...ratings.values()];

    for (const rating of all) {
      for (const value of Object.values(rating)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }

    // Each axis is normalised independently, so each reaches 0 and 1 somewhere in the roster.
    for (const key of ['protection', 'mobility', 'firepower', 'handling'] as const) {
      const axis = all.map((r) => r[key]);
      expect(Math.min(...axis), `${key} has no weakest vehicle`).toBe(0);
      expect(Math.max(...axis), `${key} has no strongest vehicle`).toBe(1);
    }
  });
it('makes the heavy the most protected and the light the least', () => {
    // The headline claim the selector makes, checked against the definitions rather than against itself. The
    // heavy has 1600 hit points and a 340 mm plate pitched 66 degrees; the light has 620 and a 90 mm plate
    // pitched 24 degrees. The rating agreeing with those numbers is the point.
    expect(ratings.get(CT_HEAVY.id)!.protection).toBe(1);
    expect(ratings.get(CT_LIGHT.id)!.protection).toBe(0);
    expect(ratings.get(CT_MEDIUM.id)!.protection).toBeGreaterThan(0);
    expect(ratings.get(CT_MEDIUM.id)!.protection).toBeLessThan(1);
  });

  it('makes the light the most mobile and the heavy the least', () => {
    // Both terms of the mobility score point the same way â€” the light reaches 13.4 m/s with 42 deg/s of hull
    // traverse against the heavy's 7.2 m/s and 14 deg/s â€” so this is not one statistic cancelling the other
    // and leaving the rating to decide the outcome.
    expect(ratings.get(CT_LIGHT.id)!.mobility).toBe(1);
    expect(ratings.get(CT_HEAVY.id)!.mobility).toBe(0);
    expect(ratings.get(CT_MEDIUM.id)!.mobility).toBeGreaterThan(0);
    expect(ratings.get(CT_MEDIUM.id)!.mobility).toBeLessThan(1);
  });

  it('orders protection and mobility in opposite directions', () => {
    // The property that makes the roster a choice rather than a ranking. If protection and mobility moved
    // together, the selector would be describing one axis twice and the player would have nothing to weigh.
    const heavy = ratings.get(CT_HEAVY.id)!;
    const light = ratings.get(CT_LIGHT.id)!;

    expect(heavy.protection - light.protection).toBeGreaterThan(heavy.mobility - light.mobility);
  });

  it('agrees with the definitions when a vehicle is retuned', () => {
    // The test that matters most, and the reason the rating is computed rather than authored.
    //
    // Hand-written bars would pass every other test in this file and could then be wrong forever. Here, a
    // vehicle given enormous hit points *is* rated as the most protected with no other edit â€” which is the
    // property that makes the selector trustworthy as the roster grows past three vehicles.
    const inflated: VehicleDefinition = {
      ...CT_LIGHT,
      id: 'ct-test-turtle',
      displayName: 'Turtle',
      survivability: { ...CT_LIGHT.survivability, hitPoints: 5000 },
    };
    const tuned = rateRoster([
      ...VEHICLE_ROSTER,
      { vehicle: inflated, role: 'scout', strength: 'x', tagline: 'test', weakness: 'test' },
    ]);

    expect(tuned.get(inflated.id)!.protection).toBe(1);
    // And it pushes the previous champion down the scale rather than the two tying at the top, which is what
    // makes the normalisation relative rather than absolute.
    expect(tuned.get(CT_HEAVY.id)!.protection).toBeLessThan(1);
  });

  it('does not divide by zero when every vehicle is identical', () => {
    // A roster of one is a legitimate state during development, and two vehicles that genuinely match on an
    // axis is legitimate too. NaN would render as a bar of zero width with no explanation.
    const solo = rateRoster([VEHICLE_ROSTER[0]!]);
    const only = solo.get(VEHICLE_ROSTER[0]!.vehicle.id)!;

    for (const key of ['protection', 'mobility', 'firepower', 'handling'] as const) {
      expect(Number.isFinite(only[key]), `${key} is not finite for a one-vehicle roster`).toBe(true);
      // With nothing to compare against, "average" is the only honest answer.
      expect(only[key]).toBe(0.5);
    }
  });

  it('keeps the bar count at four, so the surface cannot quietly grow', () => {
    // A guard on the brief rather than on the code. The requirement is a *small* set of meaningful
    // characteristics rather than every raw statistic, and the cheapest way to keep that true is to notice
    // the moment a fifth one appears.
    expect(Object.keys(ratings.get(CT_MEDIUM.id)!).sort()).toEqual([
      'firepower',
      'handling',
      'mobility',
      'protection',
    ]);
  });

  it('is deterministic, so the bars cannot change between two openings of the menu', () => {
    // Trivial-looking, and worth it: `rateRoster` runs once per selector construction, and a non-deterministic
    // version would show the player different numbers each time they opened it.
    expect(rateRoster()).toEqual(rateRoster());
  });
});

describe('selector rating summaries', () => {
  it('describes every axis in words for a screen reader', () => {
    // The bar markup is `aria-hidden`, so this text is the only thing a screen-reader user hears. It has to
    // name all four axes, and it has to survive being read aloud â€” hence the spelled-out scale.
    const summary = ratingSummary({
      protection: 1,
      mobility: 0,
      firepower: 0.505,
      handling: 0,
    });

    expect(summary).toContain('Protection 100 out of 100');
    expect(summary).toContain('mobility 0');
    expect(summary).toContain('firepower 51');
    expect(summary).toContain('handling 0');
  });
});
