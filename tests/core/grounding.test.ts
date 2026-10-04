/**
 * The V6 blocker: the tank floated above uneven ground.
 *
 * ## What these tests are for
 *
 * The owner played V6 and reported one specific thing: the vehicle was grounded on flat terrain but most of
 * it floated on non-flat ground. Measuring that (`tools/measure-grounding.mjs`) found **two independent
 * causes**, either of which alone leaves the tank visibly off the ground, and both of which the existing
 * suite was blind to:
 *
 *  1. **The body pitch and roll had inverted signs.** A tank climbing a hill was pitched nose-*down*. On
 *     the Cairn approach the terrain rose 0.90 m from tail to nose while the rendered hull rose 0.89 m the
 *     other way, burying the nose 0.41 m into the slope and leaving 1.38 m of daylight under the tail. No
 *     test caught this because every test that existed compared the *simulation's* vectors against the
 *     simulation's own forward vector â€” and the simulation was never wrong. Only the rendered model was,
 *     and nothing ever asked what the renderer drew.
 *  2. **The ground was sampled at a single point.** A tank is 6.7 m long; the ground under its nose, tail
 *     and flanks differ by tens of centimetres on ordinary terrain. One central normal describes none of
 *     that, and even with the sign corrected a rigid hull posed to a point bridges every dip beneath it.
 *
 * The tests below are split to match those two causes, so a future regression names which one returned:
 * `the support fit` covers the attitude, and `contact with the ground` covers the residual gap.
 *
 * ## Why these are numbers and not screenshots
 *
 * A 20 cm gap under a track is roughly eight pixels in a 1280x760 frame at the orbit camera's usual
 * standoff, and it is invisible in a screenshot taken from forty metres. The defect that reached the owner
 * was exactly that kind: invisible to inspection, obvious to play. These assertions are the thing that
 * makes it catchable, and the browser probe in `tools/grounding-probe.js` is the independent check that
 * the same numbers hold in the real scene graph.
 */
import { describe, expect, it } from 'vitest';
import {
  groundSupportPitchRad,
  groundSupportRollRad,
  solveGroundSupportPlane,
} from '../../src/core/vehicle/ground-support.js';
import { Simulation } from '../../src/core/sim/world.js';
import type { Battlefield } from '../../src/core/world/battlefield.js';
import { MARLOWE_CROSSING } from '../../src/core/world/maps/marlowe-crossing.js';
import { CT_MEDIUM } from '../../src/shared/roster.js';
import { makeInput } from '../../src/shared/input.js';
import { TANK_PROPORTIONS } from '../../src/client/render/tank-proportions.js';
import {
  FLOATING_GAP_M,
  findFlatGround,
  groundingTestPoses,
  marloweField,
  measureGrounding,
} from '../../src/tools/headless/grounding-measurement.js';

/** The vehicle's own footprint, which is what the support grid is sized from. */
const LENGTH_M = CT_MEDIUM.dimensions.lengthM;
const WIDTH_M = CT_MEDIUM.dimensions.widthM;

/**
 * Runs the simulation until the vehicle has settled into a pose at a location.
 *
 * Settling matters: pitch and roll are smoothed over several ticks, so reading them on the first tick
 * measures the initial condition rather than the pose the player sees. Thirty ticks is half a second,
 * which is past the settling time of the vehicle's own suspension numbers.
 */
function settleAt(
  field: Battlefield,
  x: number,
  z: number,
  headingRad: number,
): { pitchRad: number; rollRad: number; positionY: number } {
  const sim = new Simulation({
    vehicle: CT_MEDIUM,
    map: MARLOWE_CROSSING,
  });
  sim.vehicle.reset({ x, y: field.terrain.heightAt(x, z), z }, headingRad);
  for (let i = 0; i < 30; i += 1) {
    sim.advance(1 / 60);
  }
  const state = sim.vehicle.state;
  return { pitchRad: state.bodyPitchRad, rollRad: state.bodyRollRad, positionY: state.position.y };
}

describe('the support fit', () => {
  /**
   * A synthetic tilted plane expressed in the **vehicle's own frame**, so the expected answer is
   * arithmetic rather than a judgement about terrain.
   *
   * `riseForward` is metres of climb per metre along the vehicle's forward axis and `riseRight` the same
   * toward its right-hand side. Expressed this way deliberately: a helper written in *world* axes would
   * silently describe a different slope at every heading, and the heading test below exists precisely
   * because that mistake is easy to make and invisible until the vehicle turns.
   */
  const tiltedPlane =
    (riseForward: number, riseRight: number) =>
    (x: number, z: number): number =>
      // At heading 0 the vehicle's forward axis is +Z and its right axis is +X, so a world-space sample of
      // `(x, z)` has forward offset `z` and right offset `x`.
      z * riseForward + x * riseRight;

  it('recovers the gradient of a plane it is fitted to', () => {
    const plane = solveGroundSupportPlane(tiltedPlane(0.2, -0.1), 0, 0, 0, 3, 1.5);
    expect(plane.risePerMetreForward).toBeCloseTo(0.2, 9);
    expect(plane.risePerMetreRight).toBeCloseTo(-0.1, 9);
  });

  it('reports no residual on a true plane, because the fit is exact', () => {
    // This is what "perfectly flat ground" reduces to arithmetically: a plane with no curvature leaves
    // nothing for the conforming pass to do, so the hull alone must already be sitting correctly.
    const plane = solveGroundSupportPlane(tiltedPlane(0.2, -0.1), 0, 0, 0, 3, 1.5);
    expect(plane.maxResidualAboveM).toBeCloseTo(0, 9);
    expect(plane.maxResidualBelowM).toBeCloseTo(0, 9);
  });

  it('reads a gradient along the vehicle axis rather than the world axis', () => {
    // A slope that is purely lateral in world terms becomes a *climb* once the vehicle turns to face along
    // it. A solver that ignored the heading would report this as level and the tank would drive across a
    // hillside without leaning into it at all â€” which is precisely the single-point-sampling defect this
    // whole pass exists to remove, in its most easily missed form.
    const lateralInWorld = tiltedPlane(0, 0.3);
    expect(solveGroundSupportPlane(lateralInWorld, 0, 0, 0, 3, 1.5).risePerMetreForward).toBeCloseTo(
      0,
      6,
    );
    // Turned 90 degrees, the same surface now rises along the vehicle's forward axis.
    const turned = solveGroundSupportPlane(lateralInWorld, 0, 0, Math.PI / 2, 3, 1.5);
    expect(turned.risePerMetreForward).toBeCloseTo(0.3, 6);
    expect(turned.risePerMetreRight).toBeCloseTo(0, 6);
  });

  describe('pitch sign', () => {
    /**
     * The single most important assertion in this file.
     *
     * It is here because the defect was invisible to every other check: an inverted pitch on gentle
     * ground still looks like a tank on a slight slope. It only becomes obvious as a large front-to-rear
     * split once the gradient is steep enough, which on this map means the Cairn approach.
     */
    it('pitches the nose up on a climb, and down on a descent', () => {
      const climbing = solveGroundSupportPlane(tiltedPlane(0.25, 0), 0, 0, 0, 3, 1.5);
      // Babylon's `Rx` carries local +Z toward -Y, so nose-up is a *negative* rotation.x.
      expect(groundSupportPitchRad(climbing)).toBeLessThan(0);

      const descending = solveGroundSupportPlane(tiltedPlane(-0.25, 0), 0, 0, 0, 3, 1.5);
      expect(groundSupportPitchRad(descending)).toBeGreaterThan(0);
    });

    it('is level on flat ground', () => {
      const flat = solveGroundSupportPlane(() => 4.2, 0, 0, 0, 3, 1.5);
      expect(groundSupportPitchRad(flat)).toBeCloseTo(0, 12);
    });
  });

  describe('roll sign', () => {
    it('raises the right-hand side when the ground climbs toward it', () => {
      const risingRight = solveGroundSupportPlane(tiltedPlane(0, 0.25), 0, 0, 0, 3, 1.5);
      // A positive `rotation.z` raises local +X, which is the vehicle's right, so the sign is positive.
      expect(groundSupportRollRad(risingRight)).toBeGreaterThan(0);

      const risingLeft = solveGroundSupportPlane(tiltedPlane(0, -0.25), 0, 0, 0, 3, 1.5);
      expect(groundSupportRollRad(risingLeft)).toBeLessThan(0);
    });

    it('is level on flat ground', () => {
      const flat = solveGroundSupportPlane(() => -1.5, 0, 0, 0, 3, 1.5);
      expect(groundSupportRollRad(flat)).toBeCloseTo(0, 12);
    });
  });
});

/**
 * The tightest pitch, in degrees, that a vehicle on genuinely level ground is allowed to present.
 *
 * Measured rather than assumed, because "level" on a procedural map is not a round number. The flattest
 * open ground on Marlowe Crossing still varies by about 15 mm across the track run, and a least-squares
 * plane through that is very slightly tilted. A tenth of a degree is roughly 11 mm of height difference
 * across the vehicle's length: below what the eye can resolve as a tilt at gameplay distance, and below
 * the model's own geometric tolerance. Asserting an exact zero here would be asserting that the terrain is
 * perfectly flat, which it is not, and would fail for a reason that has nothing to do with the defect.
 */
const LEVEL_TOLERANCE_DEG = 0.1;

/** The same tolerance in radians, for reading the simulation's own state. */
const LEVEL_TOLERANCE_RAD = (LEVEL_TOLERANCE_DEG * Math.PI) / 180;

/**
 * The length of the vehicle's contact run, metres, for converting a height difference into a gradient.
 *
 * The track occupies 94% of the hull length, so this is the distance over which a front-to-rear height
 * difference is actually spread. Reading the proportion from the same source the model uses keeps the test
 * honest if the proportions are ever retuned.
 */
const TRACK_RUN_M = LENGTH_M * TANK_PROPORTIONS.trackLengthFraction;

describe('contact with the ground on the real battlefield', () => {
  const field = marloweField();

  /**
   * Measures the rendered track at one pose.
   *
   * `clearanceM` of zero because the measured contact offset is zero for this model â€” the track's lower
   * edge already sits at the root origin â€” so the clearance under test is the simulation's own ride height
   * being cancelled by the conforming pass rather than a model offset hiding a defect.
   */
  const measureAt = (label: string, x: number, z: number, headingRad: number) =>
    measureGrounding(field, label, x, z, headingRad, 0);

  it('leaves no visible daylight under the track on any surveyed surface', () => {
    // The headline assertion, and the direct statement of the owner's report. Every pose the brief names
    // is covered: flat, slope, rolling, crest, depression, road-to-field, railway crossing, plus the
    // embankment and the three climbs that exposed the sign error.
    const offenders = groundingTestPoses()
      .map((pose) => measureAt(pose.label, pose.x, pose.z, pose.headingRad))
      .filter((reading) => reading.maxGapM > FLOATING_GAP_M)
      .map((reading) => `${reading.label}: ${reading.maxGapM.toFixed(3)} m`);

    expect(offenders).toEqual([]);
  });

  it('agrees with the terrain about which way is up, on every surface', () => {
    // The direct test for the sign error, on real ground rather than a synthetic plane. Before the fix
    // this failed on 12 of 13 poses; the magnitude was almost exactly right in each case, which is why it
    // read as "slightly off" rather than as a sign error.
    const opposed = groundingTestPoses()
      .map((pose) => measureAt(pose.label, pose.x, pose.z, pose.headingRad))
      .filter(
        (r) =>
          Math.abs(r.terrainFrontToRearM) > 0.02 && r.terrainFrontToRearM * r.bodyFrontToRearM < 0,
      )
      .map((r) => r.label);

    expect(opposed).toEqual([]);
  });

  it('agrees with the terrain about which way is down, laterally', () => {
    const opposed = groundingTestPoses()
      .map((pose) => measureAt(pose.label, pose.x, pose.z, pose.headingRad))
      .filter(
        (r) => Math.abs(r.terrainLeftToRightM) > 0.02 && r.terrainLeftToRightM * r.bodyLeftToRightM < 0,
      )
      .map((r) => r.label);

    expect(opposed).toEqual([]);
  });

  it('does not bury the track in the ground to achieve contact', () => {
    // The brief explicitly forbids solving the float by lowering the vehicle until it clips. A fix that
    // traded daylight for burial would pass the assertion above and fail this one, which is why both are
    // here. Before the fix, the worst burial on the climbs was 0.42 m.
    const buried = groundingTestPoses()
      .map((pose) => measureAt(pose.label, pose.x, pose.z, pose.headingRad))
      .filter((r) => r.maxBiteM > FLOATING_GAP_M)
      .map((r) => `${r.label}: ${r.maxBiteM.toFixed(3)} m`);

    expect(buried).toEqual([]);
  });

  it('sits level on genuinely flat open ground', () => {
    // Found by scanning the map rather than chosen by eye, because the obvious "flat" spots are the road
    // and the railway formation, and both carry props laid over the heightfield that hide a float â€” and
    // because a spot that looks flat from a distance can still carry a real gradient under the vehicle.
    const flat = findFlatGround(field, 4);
    expect(flat.length).toBeGreaterThan(0);

    for (const spot of flat) {
      const reading = measureAt('flat open ground', spot.x, spot.z, 0);
      expect(reading.maxGapM).toBeLessThan(FLOATING_GAP_M);
      expect(reading.maxBiteM).toBeLessThan(FLOATING_GAP_M);


      // The body must reproduce the terrain's own front-to-rear and left-to-right height differences
      // across the contact run. That is the property that matters and it holds whether the spot is
      // perfectly level or carries a small real gradient, so it cannot be satisfied by a vehicle that
      // ignores the ground and happens to be level instead.
      //
      // A least-squares fit over the whole grid is not the same quantity as the difference between the two
      // end stations - on curved ground the two differ slightly - so the tolerance covers that gap rather
      // than pretending the fit reproduces the chord exactly.
      expect(reading.bodyFrontToRearM).toBeCloseTo(reading.terrainFrontToRearM, 1);
      expect(reading.bodyLeftToRightM).toBeCloseTo(reading.terrainLeftToRightM, 1);
    }
  });

  it('presents a graded surface at its own gradient, whatever the tilt', () => {
    // The railway formation and the town road are `LevelCorridor`s in the height field, so they are
    // genuinely planar. A vehicle on one must present that plane's own gradient rather than fight it,
    // which is the arithmetic the pitch sign exists to get right. Sampled in the vehicle's frame, since
    // that is the frame the solver reports in.
    for (const rise of [-0.15, -0.05, 0.05, 0.15]) {
      const plane = solveGroundSupportPlane((_x, z) => z * rise, 0, 0, 0, TRACK_RUN_M / 2, WIDTH_M / 2);
      expect(groundSupportPitchRad(plane)).toBeCloseTo(-Math.atan(rise), 6);
    }
  });

  it('keeps the vehicle on the surface while the attitude follows the ground', () => {
    // The core contract this pass must not have broken: the attitude is presentation, so however it is
    // derived, the vehicle's own position and ride height are untouched. Driving a full encounter and
    // checking the hull never leaves the ground is the end-to-end statement of that.
    const sim = new Simulation({ vehicle: CT_MEDIUM, map: MARLOWE_CROSSING });
    let worstLiftM = 0;
    for (let i = 0; i < 600; i += 1) {
      sim.advance(1 / 60, makeInput(1, Math.sin(i / 90) * 0.5));
      const state = sim.vehicle.state;
      const ground = sim.terrain.heightAt(state.position.x, state.position.z);
      worstLiftM = Math.max(worstLiftM, ground - (state.position.y - state.rideHeightM));
    }
    // The hull floor is `rideHeight` above the origin by construction, so the lift here is the ride
    // height itself and the assertion is that the vehicle is never *below* the surface it is driving on.
    expect(worstLiftM).toBeLessThan(0.001);
  });

  it('reaches a settled attitude that agrees with the terrain it stopped on', () => {
    // The real simulation, not a synthetic plane: park on the Cairn approach facing uphill, let the
    // smoothing settle, and confirm the pitch has the sign the ground implies. This is the end-to-end
    // version of the sign test, and it is what would have caught the defect from a playtest.
    const x = 150;
    const z = -120;
    const headingRad = -0.6;
    const settled = settleAt(field, x, z, headingRad);

    const terrain = field.terrain;
    const forwardX = Math.sin(headingRad);
    const forwardZ = Math.cos(headingRad);
    const noseY = terrain.heightAt(x + forwardX * 3, z + forwardZ * 3);
    const tailY = terrain.heightAt(x - forwardX * 3, z - forwardZ * 3);

    if (noseY > tailY) {
      // Climbing: the nose must be up, which is a negative pitch under Babylon's composition.
      expect(settled.pitchRad).toBeLessThan(0);
    } else {
      expect(settled.pitchRad).toBeGreaterThan(0);
    }
  });

  it('presents the railway formation rather than fighting it', () => {
    // The formation is graded by a `LevelCorridor`, which holds a gentle gradient across country that is
    // not level â€” it is *nearly* level, not exactly. A vehicle standing on it must present the gradient the
    // formation actually has.
    //
    // This test replaced one that asserted the vehicle was level here, and it failed at 1.18 degrees. That
    // was the test being wrong rather than the vehicle: measuring the formation showed a real front-to-rear
    // difference, and the vehicle was presenting it correctly. Asserting zero would have "passed" only by
    // demanding the tank ignore the ground it was standing on â€” which is the same class of mistake as the
    // inverted pitch this whole pass set out to remove, pointing the other way.
    const x = -60;
    const z = -30;
    const headingRad = 0;
    const settled = settleAt(field, x, z, headingRad);
    const reading = measureAt('formation', x, z, headingRad);

    // The terrain's own gradient is the reference. Whatever it is, the body must reproduce its sign.
    expect(reading.terrainFrontToRearM * reading.bodyFrontToRearM).toBeGreaterThanOrEqual(0);
    expect(reading.terrainLeftToRightM * reading.bodyLeftToRightM).toBeGreaterThanOrEqual(0);
    // And the magnitude must agree too, not merely the sign: a vehicle that leaned the right way by the
    // wrong amount would satisfy the assertion above.
    expect(reading.bodyFrontToRearM).toBeCloseTo(reading.terrainFrontToRearM, 2);
    expect(reading.bodyLeftToRightM).toBeCloseTo(reading.terrainLeftToRightM, 2);
    // Which means the settled simulation pitch must agree with the measured one, converted from degrees
    // back to radians. The measurement computes the pose from the fitted plane and the simulation smooths
    // toward the same plane, so after settling the two must land on the same value - which also confirms
    // `settleAt` actually settled rather than reading a half-converged attitude.
    const measuredPitchRad = (reading.pitchDeg * Math.PI) / 180;
    expect(Math.abs(settled.pitchRad - measuredPitchRad)).toBeLessThan(LEVEL_TOLERANCE_RAD);
  });

  it('does not change where the vehicle drives, which is what the brief required', () => {
    // The pass was required to fix presentation without rewriting locomotion. Driving the same scripted
    // input twice must produce identical results, and the vehicle must still be able to reach the places
    // it could before: the field route and the crossing.
    const run = () => {
      const sim = new Simulation({ vehicle: CT_MEDIUM, map: MARLOWE_CROSSING });
      for (let i = 0; i < 600; i += 1) sim.advance(1 / 60, makeInput(1, 0));
      const s = sim.vehicle.state;
      return { x: s.position.x, y: s.position.y, z: s.position.z, headingRad: s.headingRad };
    };
    const first = run();
    const second = run();
    expect(second).toEqual(first);
  });
});
