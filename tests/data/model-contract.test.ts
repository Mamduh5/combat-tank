/**
 * V8 model-contract tests.
 *
 * ## Why these exist alongside the runtime check
 *
 * The loader validates every roster vehicle at load time, and the asset pipeline test validates every
 * shipped `.glb`. Those are the two callers that keep production honest. This file exists for the third
 * thing: **proving the validator would notice.**
 *
 * A validator that returns an empty array for everything is indistinguishable from a validator that is
 * correct, in exactly the same way a green test suite is. Every rule below is therefore pinned with a
 * deliberately malformed probe, so each has a test that fails if the rule is removed or weakened. This is
 * the same reasoning the V7 asset tests were written on: a defect in *data* is invisible to assertions
 * about *code*, and a defect in a *validator* is invisible to assertions that only ever feed it good data.
 */

import { describe, expect, it } from 'vitest';
import {
  formatModelContractProblems,
  validateVehicleModel,
  VEHICLE_MODEL_CONTRACT,
  type VehicleModelProbe,
} from '../../src/shared/vehicle-model-contract.js';
import { CT_LIGHT, CT_MEDIUM } from '../../src/shared/roster.js';

/** Dimensions every probe is checked against. */
const EXPECTED = { lengthM: 6.7, widthM: 3.3, heightM: 1.15 };

/**
 * A mutable draft of a probe.
 *
 * `VehicleModelProbe` is `readonly` because it is a *measurement* â€” the contract takes it as read-only so
 * nothing can adjust a result to make it pass. The tests need the opposite, so they build this type and
 * convert at the point of use. Splitting the two keeps the production type honest and the tests simple.
 */
type ProbeDraft = { -readonly [K in keyof VehicleModelProbe]: VehicleModelProbe[K] };

/**
 * A probe that satisfies every rule, used as the base for each mutation.
 *
 * Written out rather than derived from a real model, so the values are obviously correct at a glance and a
 * change to the contract does not silently move the baseline out from under the tests.
 */
function soundProbe(): ProbeDraft {
  return {
    vehicleId: 'probe',
    nodeNames: [
      'Tank',
      'Hull',
      'Turret',
      'Gun',
      'Muzzle',
      'WheelL0',
      'WheelR0',
      'WheelL1',
      'WheelR1',
      'TrackL0',
      'TrackL1',
      'TrackL2',
      'TrackL3',
      'TrackR0',
      'TrackR1',
      'TrackR2',
      'TrackR3',
    ],
    hullLengthM: 6.7,
    hullWidthM: 2.4,
    hullHeightM: 1.15,
    hullLowestY: 0,
    turretPivot: { x: 0, y: 1.15, z: -0.3 },
    gunPivot: { x: 0, y: 1.35, z: 1.4 },
    muzzle: { x: 0, y: 1.35, z: 5.7 },
    wheelCount: 4,
    trackSegmentCount: 8,
    meshCount: 20,
    meshesWithoutMaterial: 0,
  };
}

const rules = (probe: ProbeDraft): string[] =>
  validateVehicleModel(probe, EXPECTED).map((p) => p.rule);

describe('a sound model satisfies the contract', () => {
  it('reports nothing for a well-formed probe', () => {
    expect(validateVehicleModel(soundProbe(), EXPECTED)).toEqual([]);
  });

  it('accepts a hull width narrower than the definition, because tracks are not hull', () => {
    // The cross-section rule has to be loose. `dimensions.widthM` is the vehicle across its tracks; the
    // hull mesh's bounding box is the body between them, which is roughly a quarter narrower on every
    // vehicle in the roster. A tolerance at the length threshold would reject every correct model.
    const probe = soundProbe();
    probe.hullWidthM = 1.9;
    expect(rules(probe)).toEqual([]);
  });

  it('rejects a hull that is far too wide, which means the wrong model was built', () => {
    const probe = soundProbe();
    probe.hullWidthM = 6.6;
    expect(rules(probe)).toContain('hull-width');
  });
});

describe('every contract rule has a test that fails without it', () => {
  it('missing-node', () => {
    const probe = soundProbe();
    probe.nodeNames = probe.nodeNames.filter((n) => n !== 'Gun');
    expect(rules(probe)).toContain('missing-node');
  });

  it('hull-length', () => {
    // Beyond the loader's own 2% rescale threshold, which is what makes this worth reporting rather than
    // silently correcting.
    const probe = soundProbe();
    probe.hullLengthM = 5.6;
    expect(rules(probe)).toContain('hull-length');
  });

  it('origin-above-ground', () => {
    const probe = soundProbe();
    probe.hullLowestY = -0.4;
    expect(rules(probe)).toContain('origin-above-ground');
  });

  it('turret-pivot-off-centre', () => {
    const probe = soundProbe();
    probe.turretPivot = { x: 0.6, y: 1.15, z: -0.3 };
    expect(rules(probe)).toContain('turret-pivot-off-centre');
  });

  it('turret-pivot-at-or-below-hull', () => {
    const probe = soundProbe();
    probe.turretPivot = { x: 0, y: -0.2, z: -0.3 };
    expect(rules(probe)).toContain('turret-pivot-at-or-below-hull');
  });

  it('forward-axis â€” the model is authored facing -Z', () => {
    // The rule whose absence is most costly and least visible: a backwards tank looks exactly like a
    // forwards tank in a screenshot, and drives backwards.
    const probe = soundProbe();
    probe.muzzle = { x: 0, y: 1.35, z: -2.0 };
    expect(rules(probe)).toContain('forward-axis');
  });

  it('muzzle-reach â€” the marker is buried inside the mantlet', () => {
    const probe = soundProbe();
    probe.muzzle = { x: 0, y: 1.35, z: 1.6 };
    expect(rules(probe)).toContain('muzzle-reach');
  });

  it('muzzle-below-trunnion', () => {
    const probe = soundProbe();
    probe.muzzle = { x: 0, y: 0.2, z: 5.7 };
    expect(rules(probe)).toContain('muzzle-below-trunnion');
  });

  it('wheels', () => {
    const probe = soundProbe();
    probe.wheelCount = 2;
    expect(rules(probe)).toContain('wheels');
  });

  it('track-segments â€” one per side satisfies the loader but disables track conforming', () => {
    const probe = soundProbe();
    probe.trackSegmentCount = 2;
    expect(rules(probe)).toContain('track-segments');
  });

  it('no-meshes', () => {
    const probe = soundProbe();
    probe.meshCount = 0;
    expect(rules(probe)).toContain('no-meshes');
  });

  it('materials â€” a mesh with no material cannot be darkened on destruction', () => {
    const probe = soundProbe();
    probe.meshesWithoutMaterial = 1;
    expect(rules(probe)).toContain('materials');
  });
});

describe('failures are reported usefully', () => {
  it('names the vehicle, the rule and the measurement', () => {
    const probe = soundProbe();
    probe.hullLengthM = 5.6;
    probe.muzzle = { x: 0, y: 1.35, z: -2 };
    const message = formatModelContractProblems(validateVehicleModel(probe, EXPECTED));

    expect(message).toContain('probe:');
    expect(message).toContain('[hull-length]');
    expect(message).toContain('[forward-axis]');
    // The measured number is in the message, because "the hull is the wrong size" is not actionable while
    // "the hull measures 5.60 m against a 6.7 m definition" is.
    expect(message).toContain('5.60 m');
    expect(message).toContain('6.7 m');
  });

  it('reports every problem rather than only the first', () => {
    // Stopping at the first failure would make fixing a malformed model a game of whack-a-mole, one error
    // message per rebuild.
    const probe = soundProbe();
    probe.nodeNames = probe.nodeNames.filter((n) => n !== 'Muzzle');
    probe.wheelCount = 0;
    probe.trackSegmentCount = 0;
    probe.meshesWithoutMaterial = 3;
    expect(rules(probe)).toEqual(
      expect.arrayContaining(['missing-node', 'wheels', 'track-segments', 'materials']),
    );
  });
});

describe('the contract itself is not weaker than the roster requires', () => {
  it('accepts both shipped vehicles against their own definitions', () => {
    // A guard against the contract being tightened into rejecting real content: whatever the rules, the
    // vehicles that ship have to pass them.
    for (const vehicle of [CT_MEDIUM, CT_LIGHT]) {
      const probe = soundProbe();
      probe.vehicleId = vehicle.id;
      probe.hullLengthM = vehicle.dimensions.lengthM;
      probe.hullWidthM = vehicle.dimensions.widthM * 0.75;
      probe.hullHeightM = vehicle.dimensions.heightM;
      expect(validateVehicleModel(probe, vehicle.dimensions)).toEqual([]);
    }
  });

  it('keeps its tolerances inside documented bounds', () => {
    // A contract whose tolerances drift upward stops being a contract. These are the numbers the loader's
    // own behaviour depends on, so a change to one of them changes what "correct" means.
    expect(VEHICLE_MODEL_CONTRACT.lengthToleranceFraction).toBeLessThanOrEqual(0.02);
    expect(VEHICLE_MODEL_CONTRACT.groundOffsetToleranceM).toBeLessThanOrEqual(0.05);
    expect(VEHICLE_MODEL_CONTRACT.turretPivotLateralToleranceM).toBeLessThanOrEqual(0.05);
    expect(VEHICLE_MODEL_CONTRACT.minimumWheels).toBeGreaterThanOrEqual(4);
    expect(VEHICLE_MODEL_CONTRACT.minimumTrackSegments).toBeGreaterThanOrEqual(4);
  });

  it('keeps the float slack far below any real authoring difference', () => {
    // V8 engineering decision, pinned. The slack exists because an exactly-constructed hull measured
    // 3.5000000000000004 m against a 3.5 m definition and was rejected by a bare `> 1.0`. So it must exist
    // and be small.
    //
    // Both halves matter. The upper bound keeps it at 1e-6, which is ~3 nm on a 3.5 m vehicle — orders of
    // magnitude below anything a person can model, and above the ~1e-16 relative error that caused the
    // failure. The lower bound is the one that stops this being a licence to loosen: if it ever grew past
    // the length tolerance it would start absorbing genuine scale errors, which is the one job this file
    // exists to do.
    const slack = VEHICLE_MODEL_CONTRACT.crossSectionSlackFraction;
    expect(slack).toBeGreaterThan(0);
    expect(slack).toBeLessThanOrEqual(1e-6);
    expect(slack).toBeLessThan(VEHICLE_MODEL_CONTRACT.lengthToleranceFraction);
  });

  it('bounds hull height generously enough for protruding detail, but not for a wrong-scale model', () => {
    // V8 engineering decision, pinned. Height and width are bounded differently on purpose: width is a hard
    // ceiling at the vehicle's own width, while the hull assembly may carry stowage, spare track links and
    // exhaust housings that stand proud of the structural hull.
    //
    // These four assertions are the decision. The allowance must be enough for detail, small enough that a
    // mis-scaled vehicle still fails, and — the part most likely to be broken by a well-meaning future
    // change — it must never become so large that the height rule stops catching anything. 1.35 against a
    // rule that fails at 1.02 on length leaves a wide gap for detail and a narrow one for scale errors.
    const max = VEHICLE_MODEL_CONTRACT.hullAssemblyMaxHeightFraction;
    expect(max).toBeGreaterThanOrEqual(1.2);
    expect(max).toBeLessThanOrEqual(1.35);

    // A hull whose stowage stands a third proud of the structural hull is still a valid vehicle...
    const withStowage = soundProbe();
    withStowage.hullHeightM = withStowage.hullHeightM * max;
    expect(validateVehicleModel(withStowage, CT_MEDIUM.dimensions)).toEqual([]);

    // ...but a model built at the wrong scale is not, and the height rule is part of what catches it.
    const wrongScale = soundProbe();
    wrongScale.hullHeightM = wrongScale.hullHeightM * max * 1.01;
    expect(validateVehicleModel(wrongScale, CT_MEDIUM.dimensions).map((p) => p.rule)).toContain(
      'hull-height',
    );
  });

  it('still refuses a hull wider than its vehicle, detail notwithstanding', () => {
    // The companion to the rule above, and the reason the two bounds differ. A stowage bin that overhangs
    // the hull is normal; a hull that is wider than the tracks carrying it is a model at the wrong scale, and
    // the width rule must say so without the height allowance softening it.
    const tooWide = soundProbe();
    tooWide.hullWidthM = CT_MEDIUM.dimensions.widthM * 1.01;
    expect(validateVehicleModel(tooWide, CT_MEDIUM.dimensions).map((p) => p.rule)).toContain(
      'hull-width',
    );
  });
});
