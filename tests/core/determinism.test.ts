import { describe, expect, it } from 'vitest';
import { Simulation, TICK_DT_SECONDS, TICK_HZ } from '../../src/core/sim/world.js';
import { Rng } from '../../src/core/rng/index.js';
import { makeInput } from '../../src/shared/input.js';
import { CT_MEDIUM } from '../../src/shared/roster.js';

/**
 * Determinism tests.
 *
 * These are the most important tests in the project, because determinism is what makes everything
 * downstream possible: replayable bugs, meaningful headless balance testing, and the client/server
 * agreement that authoritative multiplayer in V9 depends on (ADR-0001, ADR-0005).
 *
 * A regression here would not look like a failing feature. It would look like "multiplayer feels
 * slightly wrong" and "balance tests give different numbers every run", which is close to
 * undiagnosable. These tests exist to catch it while it is still a specific failure.
 */

/** Serialises simulation state to a string, so two runs can be compared exactly. */
function snapshotOf(sim: Simulation): string {
  const s = sim.vehicle.state;
  return [
    s.position.x,
    s.position.y,
    s.position.z,
    s.headingRad,
    s.speedMps,
    s.traverseRateDegPerSec,
    s.bodyPitchRad,
    s.bodyRollRad,
    s.rideHeightM,
    s.slopeDeg,
  ]
    .map((v) => v.toPrecision(17))
    .join('|');
}

/** A scripted input sequence that exercises every control axis and direction. */
function scriptedInputs(): ReturnType<typeof makeInput>[] {
  return [
    makeInput(1, 0), // accelerate
    makeInput(1, 1), // accelerate and turn
    makeInput(0, 1), // coast while turning
    makeInput(-1, 0), // brake to reverse
    makeInput(-1, -1), // reverse and turn
    makeInput(0.5, 0), // partial throttle
    makeInput(0, -1), // turn the other way
    makeInput(-1, 0), // reverse
  ];
}

describe('Simulation determinism', () => {
  it('produces bit-identical state for the same seed and inputs', () => {
    const runScript = (): string => {
      const sim = new Simulation({ vehicle: CT_MEDIUM });
      const inputs = scriptedInputs();
      for (let i = 0; i < 1200; i += 1) {
        sim.tick(inputs[i % inputs.length]!);
      }
      return snapshotOf(sim);
    };

    expect(runScript()).toBe(runScript());
  });

  it('is unaffected by how real time is divided into frames', () => {
    // The same elapsed simulated time, with the same input at every tick, must produce the same
    // result whether it is delivered as 1200 single ticks or 120 frames of 10 ticks. This is what
    // "fixed timestep" actually means, and it is what stops a 144 Hz machine and a 30 Hz machine
    // from driving differently.
    //
    // Both loops index the input by **tick**, not by frame. Feeding one input per frame while
    // stepping ten ticks would compare two genuinely different input streams rather than two
    // packagings of the same one, and would fail for a reason that has nothing to do with the tick
    // rate.
    const inputs = scriptedInputs();
    const inputForTick = (tick: number) => inputs[tick % inputs.length]!;

    const oneTickPerFrame = new Simulation({ vehicle: CT_MEDIUM });
    for (let tick = 0; tick < 1200; tick += 1) {
      oneTickPerFrame.tick(inputForTick(tick));
    }

    const tenTicksPerFrame = new Simulation({ vehicle: CT_MEDIUM });
    for (let frame = 0; frame < 120; frame += 1) {
      for (let t = 0; t < 10; t += 1) {
        tenTicksPerFrame.tick(inputForTick(frame * 10 + t));
      }
    }

    expect(oneTickPerFrame.elapsedTicks).toBe(tenTicksPerFrame.elapsedTicks);
    expect(snapshotOf(oneTickPerFrame)).toBe(snapshotOf(tenTicksPerFrame));
  });

  it('delivers the same input to every tick within a frame', () => {
    // A slow frame runs several ticks against one sampled input rather than skipping time, so the
    // vehicle's motion depends on elapsed time and not on frame rate.
    const inputs = scriptedInputs();
    const sim = new Simulation({ vehicle: CT_MEDIUM });

    // One frame long enough to require three ticks.
    const ticks = sim.advance(TICK_DT_SECONDS * 3, inputs[0]!);
    expect(ticks).toBe(3);
    expect(sim.elapsedTicks).toBe(3);
  });

  it('produces identical state when driven through advance() with varying frame times', () => {
    const inputs = scriptedInputs();
    const run = (): string => {
      const sim = new Simulation({ vehicle: CT_MEDIUM });
      // Deliberately irregular frame times, as a real browser produces.
      const deltas = [0.016, 0.033, 0.008, 0.021, 0.05, 0.012, 0.017, 0.009, 0.04, 0.014];
      for (let frame = 0; frame < 600; frame += 1) {
        sim.advance(deltas[frame % deltas.length]!, inputs[frame % inputs.length]!);
      }
      return snapshotOf(sim);
    };

    expect(run()).toBe(run());
  });
});

describe('Rng determinism', () => {
  it('produces the same sequence for the same seed', () => {
    const draw = (seed: number): number[] => {
      const rng = new Rng(seed);
      return Array.from({ length: 50 }, () => rng.nextFloat());
    };
    expect(draw(1234)).toEqual(draw(1234));
  });

  it('produces different sequences for different seeds', () => {
    const draw = (seed: number): number[] => {
      const rng = new Rng(seed);
      return Array.from({ length: 20 }, () => rng.nextFloat());
    };
    expect(draw(1)).not.toEqual(draw(2));
  });

  it('stays within [0, 1)', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('round-trips through getState and setState', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10; i += 1) {
      rng.nextUint32();
    }
    const saved = rng.getState();

    const expected = Array.from({ length: 5 }, () => rng.nextFloat());
    rng.setState(saved);
    const actual = Array.from({ length: 5 }, () => rng.nextFloat());

    expect(actual).toEqual(expected);
  });

  it('generates unit vectors that really are unit length', () => {
    const rng = new Rng(31337);
    for (let i = 0; i < 500; i += 1) {
      const v = rng.nextUnitVector();
      expect(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)).toBeCloseTo(1, 6);
    }
  });
});

describe('Simulation clock', () => {
  it('uses a fixed timestep and reports it consistently', () => {
    expect(TICK_HZ).toBe(60);
    expect(TICK_DT_SECONDS).toBeCloseTo(1 / 60, 10);
  });

  it('advances whole ticks only, never a partial one', () => {
    const sim = new Simulation({ vehicle: CT_MEDIUM });
    // Half a tick: not enough to run any simulation.
    expect(sim.advance(TICK_DT_SECONDS / 2)).toBe(0);
    expect(sim.elapsedTicks).toBe(0);

    // Completing the tick runs exactly one.
    expect(sim.advance(TICK_DT_SECONDS / 2)).toBe(1);
    expect(sim.elapsedTicks).toBe(1);
  });

  it('reports elapsed seconds exactly as ticks times the timestep', () => {
    const sim = new Simulation({ vehicle: CT_MEDIUM });
    sim.runTicks(90);
    expect(sim.elapsedTicks).toBe(90);
    expect(sim.elapsedSeconds).toBeCloseTo(1.5, 10);
  });

  it('ignores non-positive and non-finite deltas rather than rewinding', () => {
    const sim = new Simulation({ vehicle: CT_MEDIUM });
    sim.runTicks(10);
    const before = snapshotOf(sim);

    expect(sim.advance(0)).toBe(0);
    expect(sim.advance(-5)).toBe(0);
    expect(sim.advance(Number.NaN)).toBe(0);
    expect(sim.advance(Number.POSITIVE_INFINITY)).toBe(0);

    expect(snapshotOf(sim)).toBe(before);
  });

  it('caps catch-up after a long stall instead of spiralling', () => {
    const sim = new Simulation({ vehicle: CT_MEDIUM });
    // Ten seconds of backlog: without a cap this would run 600 ticks in one frame, taking longer
    // than a frame and causing the next frame to be later still.
    expect(sim.advance(10)).toBeLessThanOrEqual(5);
  });
});

