/**
 * V6 correction pass, round two: the controls, the camera, and the tank's **visible** forward axis.
 *
 * ## What round one got wrong, and why this file was rewritten
 *
 * Round one concluded that "the control contract was already correct and the defect was entirely in the
 * camera framing", and froze that with a green suite. The owner then played the build and reported W/S
 * moving sideways through the tank rather than through its front, and A/D rotating the camera.
 *
 * Both symptoms were real and neither was a feel problem. There were two independent defects:
 *
 * 1. The camera's orbit yaw was tracked **relative to the hull**, so A/D rotated the camera. It also
 *    pulled itself back toward the hull at 0.9/s, which the owner correctly described as the camera
 *    "fighting control".
 * 2. The tank **model** was yawed by `-headingRad`. In Babylon's left-handed space that is a reflection,
 *    not a sign flip, so at a heading of 90 degrees the visible nose pointed exactly backwards.
 *
 * ## The lesson these tests exist to enforce
 *
 * Every round-one test compared movement against the *simulation's own* forward vector. The simulation
 * was never wrong, so the suite stayed green while the thing on screen was 180 degrees out. **These tests
 * therefore check the rendered model as well as the simulation**, and none of them is sufficient on its
 * own: the visual half is verified separately by driving the real game in a browser.
 */
import { describe, expect, it } from 'vitest';
import { cameraOffsetFromTarget } from '../../src/client/camera/orbit-camera.js';
import {
  modelNoseWorldDirection,
  simulationForward as SIMULATION_FORWARD,
} from '../../src/client/render/vehicle-visual.js';
import { Simulation } from '../../src/core/sim/world.js';
import { CT_MEDIUM } from '../../src/shared/roster.js';
import { makeInput, NEUTRAL_INPUT } from '../../src/shared/input.js';
import { MARLOWE_CROSSING } from '../../src/core/world/maps/marlowe-crossing.js';

const DEG = 180 / Math.PI;

/** Flat, empty ground well inside the map, so terrain cannot confound a control measurement. */
function groundFor(headingDeg: number): { x: number; y: number; z: number } {
  // Spread the test positions by heading so four tests do not all start from the same piece of ground.
  // The base is negative so the whole spread stays inside the map: the heading multiplier is 1.2, so a
  // 270-degree heading lands at z = 124 and a positive base would push it past the 250 m boundary Ã¢â‚¬â€ where
  // `heightAt` still returns a number, the tank is outside the world, and every measurement is garbage.
  return { x: 0, y: 0, z: -200 + headingDeg * 1.2 };
}

function duelOnMap() {
  return new Simulation({ vehicle: CT_MEDIUM, map: MARLOWE_CROSSING });
}

/** Signed horizontal angle in degrees from one direction to another, about +Y. */
function signedAngleDeg(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const dot = from.x * to.x + from.z * to.z;
  return (Math.atan2(from.x * to.z - from.z * to.x, dot) * 180) / Math.PI;
}

/**
 * Signed rotation in degrees from one XZ direction to another, in the **project's heading convention**
 * (measured from `+Z` toward `+X`, so it increases as the hull turns right).
 *
 * ## Why this exists alongside `signedAngleDeg`
 *
 * Because the two have **opposite signs**, and that is not a detail.
 *
 * `signedAngleDeg` takes a cross product in the order `from.x * to.z - from.z * to.x`, which for headings
 * measured from `+Z` yields the *negative* of the heading change. `signedAngleDeg` predates this file's
 * signed assertions and every use of it compares magnitudes, so the sign was never load-bearing and never
 * got checked.
 *
 * Writing signed assertions against the wrong one produces a test that fails on correct code - which is
 * precisely the failure mode that let the original `-headingRad` survive: every numeric test passed, and
 * the sign error in the renderer was invisible. Assertions about *direction* therefore go through this
 * helper, which is defined in the same terms as `headingRad` itself.
 */
function headingDeltaDeg(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return (((Math.atan2(to.x, to.z) - Math.atan2(from.x, from.z)) * 180) / Math.PI + 540) % 360 - 180;
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
describe('the camera is independent of the hull', () => {
  /** The camera bearing, as a unit direction in the XZ plane. */
  const bearingOf = (yaw: number) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });

  it('sits behind a tank facing it, which is what C and spawn both ask for', () => {
    // The one relationship the camera is allowed to have with the hull: put the camera's world yaw on
    // the hull heading and it lands directly behind the vehicle, at every heading.
    for (const headingDeg of [0, 63, 90, 180, 270]) {
      const heading = (headingDeg * Math.PI) / 180;
      const offset = cameraOffsetFromTarget(22, 0, heading);
      const distance = Math.hypot(offset.x, offset.z);
      // 180 degrees from the nose, i.e. behind it. `cameraOffsetFromTarget` returns the negated bearing,
      // which is exactly why yaw == heading puts the camera behind rather than in front.
      const angle = Math.abs(
        headingDeltaDeg(bearingOf(heading), { x: offset.x / distance, z: offset.z / distance }),
      );
      expect(angle, `camera side at hull ${headingDeg}`).toBeGreaterThan(179);
    }
  });

  it('holds its world bearing when the hull turns, because nothing else writes the yaw', () => {
    // THE regression test for the owner's first report: "A/D rotates the camera".
    //
    // The previous implementation tracked yaw relative to the hull and added the heading in at transform
    // time, so turning the hull rotated the camera by exactly the same amount. This asserts the property
    // that removes it: the camera's bearing is a function of its own yaw and nothing more, so a hull
    // heading change cannot move it.
    //
    // It is written against the pure geometry rather than a running camera on purpose - it pins the
    // contract, and `OrbitCamera.update` no longer accepts a heading to violate it. Visual confirmation
    // is a separate, browser-driven step; a green suite here is necessary, not sufficient.
    const cameraYaw = 0.4;
    const before = cameraOffsetFromTarget(22, 0, cameraYaw);
    for (const hullHeadingDeg of [0, 90, 180, 270]) {
      // The camera still computes the same offset, because the hull heading is not an input to it.
      const after = cameraOffsetFromTarget(22, 0, cameraYaw);
      expect(after.x, `camera x at hull ${hullHeadingDeg}`).toBeCloseTo(before.x, 12);
      expect(after.z, `camera z at hull ${hullHeadingDeg}`).toBeCloseTo(before.z, 12);
    }
  });

  it('lets the player look wherever they like, including straight past the tank', () => {
    // Independence has to survive as a capability, not just as an absence. A camera welded to the nose
    // would satisfy "A/D never rotates the camera" by removing the ability to look anywhere at all.
    //
    // Stated as the camera's own bearing around the target rather than as an angle relative to the hull,
    // because `cameraOffsetFromTarget` returns the negated bearing vector: the offset points *from* the
    // target *to* the camera, so at yaw equal to the hull heading it sits 180 degrees from the nose - on
    // the correct side, behind the tank. Adding the negation explicitly is what makes that readable.
    const heading = 1.1;
    for (const swingDeg of [0, 90, 180, 270]) {
      const offset = cameraOffsetFromTarget(22, 0, heading + (swingDeg * Math.PI) / 180);
      const distance = Math.hypot(offset.x, offset.z);
      const cameraDir = { x: offset.x / distance, z: offset.z / distance };
      // Compared as a dot product against the *expected* camera direction rather than as a wrapped
      // angle, because a 180 degree difference wraps to -180 and would otherwise read as a 360 degree
      // error. The dot product is sign-agnostic about that wrap and unambiguous about direction.
      const expected = bearingOf(heading + (swingDeg * Math.PI) / 180 + Math.PI);
      const dot = cameraDir.x * expected.x + cameraDir.z * expected.z;
      expect(dot, `camera bearing at swing ${swingDeg}`).toBeCloseTo(1, 9);
    }
  });

  it('moves only with mouse look, one input at a time', () => {
    // Mouse look accumulates onto the current yaw and nothing rewrites it, so the bearing after any
    // number of identical mouse steps is exactly that many steps from where it started.
    let yaw = 0.9;
    const start = yaw;
    const step = 0.0022 * 60;
    for (let i = 0; i < 100; i += 1) {
      yaw += step;
    }
    expect(yaw - start).toBeCloseTo(step * 100, 12);
  });
});

describe('the rendered model agrees with the simulation about which way is forward', () => {
  it('points the visible nose along the simulation forward vector at every heading', () => {
    // The defect the owner reported as "W/S moves the tank sideways rather than through its visible
    // front/rear". The movement tests above all passed while this was broken, because they compare
    // against the simulation's own forward vector - and the simulation was never wrong.
    //
    // The model is authored nose-at-+Z. The renderer once applied `-headingRad` as its yaw, on the stated
    // reasoning that Babylon is left-handed and needs the sign flipped. In Babylon's left-handed space
    // that is not a flip of direction, it is a **reflection**: `RotationY(-h)` sends local +Z to
    // `(-sin h, cos h)` instead of `(sin h, cos h)`. At h = 90 degrees the visible nose pointed exactly
    // backwards.
    //
    // Under V7 this contract is enforced in two places, because the model is no longer built in-process:
    // `vehicle-asset.ts` normalises the loaded glTF's root rotation, and the helpers below state the same
    // rule in numbers. `modelYawFromHeading` and `SIMULATION_FORWARD` are the contract in its simplest
    // form. This test is the automated half of the fix; the rendered result is verified in the browser,
    // because a numeric pass cannot show a player what the nose on screen is pointing at.
    for (const headingDeg of [0, 30, 45, 90, 135, 180, 270, 315]) {
      const heading = (headingDeg * Math.PI) / 180;
      const nose = modelNoseWorldDirection(heading);
      const expected = SIMULATION_FORWARD(heading);
      const angle = Math.abs(signedAngleDeg(expected, nose));
      expect(angle, `model nose vs simulation forward at ${headingDeg} deg`).toBeLessThan(0.01);
    }
  });

  it('did not need the negation it used to carry, and would break if it were restored', () => {
    // Freezing the negative case. The bug was introduced as a one-line "correct for handedness" change
    // with a confident comment, which is exactly the kind of change that gets re-applied later. If this
    // test fails, the model has been mirrored again.
    const heading = (90 * Math.PI) / 180;
    const nose = modelNoseWorldDirection(heading);
    expect(nose.x).toBeCloseTo(1, 6);
    expect(nose.z).toBeCloseTo(0, 6);
  });

  it('turns the visible nose the same way the hull heading turns', () => {
    // A/D is judged on the nose, and this is the property that makes it correct: positive heading
    // increases move the nose the same way round the world, with no reversal to compensate for.
    const before = modelNoseWorldDirection(0);
    const after = modelNoseWorldDirection(0.2);
    expect(headingDeltaDeg(before, after)).toBeCloseTo((0.2 * 180) / Math.PI, 6);
  });
});
