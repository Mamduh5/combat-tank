/**
 * V6 correction pass: the driving controls and the camera framing they are read through.
 *
 * The owner played the build and reported W driving backwards and A/D swapped. The temptation was to
 * swap two signs; measuring first showed the control contract was **already correct** and the defect was
 * entirely in the camera framing. These tests pin both halves of that finding, because either half alone
 * would let a future change reintroduce the symptom - by "fixing" the wrong sign, or by reverting the
 * camera follow.
 */
import { describe, expect, it } from 'vitest';
import { cameraOffsetFromTarget } from '../../src/client/camera/orbit-camera.js';
import { Simulation } from '../../src/core/sim/world.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import { makeInput, NEUTRAL_INPUT } from '../../src/shared/input.js';
import { ASHFORD_VALLEY } from '../../src/core/world/maps/ashford-valley.js';

const DEG = 180 / Math.PI;

/** Flat, empty ground well inside the map, so terrain cannot confound a control measurement. */
function groundFor(headingDeg: number): { x: number; y: number; z: number } {
  // Spread the test positions by heading so four tests do not all start from the same piece of ground.
  return { x: 0, y: 0, z: -200 + headingDeg * 1.2 };
}

function duelOnMap() {
  return new Simulation({ vehicle: PLACEHOLDER_TANK, map: ASHFORD_VALLEY });
}

/** Signed horizontal angle in degrees from one direction to another, about +Y. */
function signedAngleDeg(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const dot = from.x * to.x + from.z * to.z;
  return (Math.atan2(from.x * to.z - from.z * to.x, dot) * 180) / Math.PI;
}

const forwardOf = (headingRad: number) => ({ x: Math.sin(headingRad), z: Math.cos(headingRad) });

/** Where a tank travelled, as a unit direction, over a fixed drive. */
function driveAndMeasure(
  headingDeg: number,
  throttle: number,
  ticks: number,
): { distanceM: number; angleDeg: number } {
  const simulation = duelOnMap();
  const tank = simulation.vehicle;
  const heading = (headingDeg * Math.PI) / 180;
  tank.reset(groundFor(headingDeg), heading);

  const before = { x: tank.state.position.x, z: tank.state.position.z };
  for (let i = 0; i < ticks; i += 1) {
    simulation.tick(makeInput(throttle, 0, null, false));
  }
  const moved = { x: tank.state.position.x - before.x, z: tank.state.position.z - before.z };
  const distanceM = Math.hypot(moved.x, moved.z);
  return {
    distanceM,
    angleDeg:
      distanceM > 0.01
        ? signedAngleDeg(forwardOf(heading), { x: moved.x / distanceM, z: moved.z / distanceM })
        : Number.NaN,
  };
}

describe('the driving contract', () => {
  it('drives along the hull nose for every heading, and never the other way', () => {
    // The claim the whole V6 correction rested on, and the one worth freezing: measured in the running
    // game, +1 throttle moved the tank 0 degrees off its own nose at headings of 0, 90, 180 and 270.
    // The controls were never reversed, and a future "fix" that flipped a sign would break this.
    for (const headingDeg of [0, 90, 180, 270]) {
      const { distanceM, angleDeg } = driveAndMeasure(headingDeg, 1, 30);
      expect(distanceM, `distance at ${headingDeg}`).toBeGreaterThan(0.01);
      expect(Math.abs(angleDeg), `angle off nose at ${headingDeg}`).toBeLessThan(1);
    }
  });

  it('reverses along the hull tail', () => {
    for (const headingDeg of [0, 180]) {
      const { distanceM, angleDeg } = driveAndMeasure(headingDeg, -1, 30);
      expect(distanceM, `reverse distance at ${headingDeg}`).toBeGreaterThan(0.01);
      expect(Math.abs(angleDeg), `reverse angle at ${headingDeg}`).toBeGreaterThan(179);
    }
  });

  it('turns the hull right for a positive turn demand, from any heading', () => {
    // Signed, so it cannot pass by accident. A mirrored *camera* rather than a mirrored input is exactly
    // the failure this pass exists to fix, and a test that only checked "the heading changed" would pass.
    for (const headingDeg of [0, 90, 180, 270]) {
      const simulation = duelOnMap();
      const tank = simulation.vehicle;
      tank.reset(groundFor(headingDeg), (headingDeg * Math.PI) / 180);

      for (let i = 0; i < 20; i += 1) {
        simulation.tick(makeInput(0, 1, null, false));
      }
      const delta = ((tank.state.headingRad * DEG - headingDeg + 540) % 360) - 180;
      expect(delta, `+turn from ${headingDeg}`).toBeGreaterThan(0.5);
    }
  });

  it('turns the hull left for a negative turn demand', () => {
    const simulation = duelOnMap();
    const tank = simulation.vehicle;
    tank.reset(groundFor(0), 0);
    for (let i = 0; i < 20; i += 1) {
      simulation.tick(makeInput(0, -1, null, false));
    }
    const delta = ((tank.state.headingRad * DEG + 540) % 360) - 180;
    expect(delta).toBeLessThan(-0.5);
  });

  it('holds position when no driving input is given', () => {
    // If this fails, every other measurement here is contaminated by drift.
    const simulation = duelOnMap();
    const tank = simulation.vehicle;
    const start = groundFor(0);
    tank.reset(start, 0);
    for (let i = 0; i < 60; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
    }
    expect(
      Math.hypot(tank.state.position.x - start.x, tank.state.position.z - start.z),
    ).toBeLessThan(0.5);
  });
});

describe('the camera framing the controls are read through', () => {
  it('sits directly behind the hull when the player has not swung it', () => {
    // The defect. The orbit was world-fixed, so on the shipped map - whose player spawn faces 63 degrees,
    // not zero - the camera opened looking 63 degrees away from where the tank pointed, and the offset was
    // unbounded once the mouse moved. W then genuinely drove away from the camera, which is the report the
    // owner gave: W felt like reverse, and A/D appeared swapped, because from the tank's nose side they
    // are.
    for (const headingDeg of [0, 63, 90, 180, 270]) {
      const heading = (headingDeg * Math.PI) / 180;
      // worldYawRad is the hull heading plus the player's swing around it, which is zero at rest.
      const offset = cameraOffsetFromTarget(22, 0, heading);
      const distance = Math.hypot(offset.x, offset.z);
      const angle = Math.abs(
        signedAngleDeg(forwardOf(heading), { x: offset.x / distance, z: offset.z / distance }),
      );
      expect(angle, `camera side at hull ${headingDeg}`).toBeGreaterThan(179);
    }
  });

  it('puts the camera in front only when the player deliberately swings it round', () => {
    // Independence from the hull is the control model, and it has to survive the fix. A camera welded to
    // the nose would satisfy "W is always away from the camera" by removing the player's ability to look
    // anywhere, which is not a fix.
    const heading = 1.1;
    const swung = cameraOffsetFromTarget(22, 0, heading + Math.PI);
    const distance = Math.hypot(swung.x, swung.z);
    const angle = Math.abs(
      signedAngleDeg(forwardOf(heading), { x: swung.x / distance, z: swung.z / distance }),
    );
    expect(angle).toBeLessThan(1);
  });

  it('swings the camera with the hull, so the relationship is always recoverable', () => {
    // The property that makes a free orbit safe: rotating the hull rotates the camera with it, so the
    // angle between them cannot drift without bound.
    const rest = cameraOffsetFromTarget(22, 0, 1.1);
    const turned = cameraOffsetFromTarget(22, 0, 1.1 + 0.7);
    expect(rest.x).not.toBeCloseTo(turned.x, 3);
    expect(rest.z).not.toBeCloseTo(turned.z, 3);
  });
});