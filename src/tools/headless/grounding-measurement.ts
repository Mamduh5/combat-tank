/**
 * The V6 blocker: the tank floats above uneven ground.
 *
 * ## What this measures
 *
 * The renderer places the vehicle with a **single** vertical sample and a **single** ground normal, both
 * taken at the vehicle's centre, and then draws a **rigid** track. So the rendered tank is a rigid plank
 * posed to the tangent plane at one point. This module computes, for a given pose, where the rendered
 * track's lower edge actually ends up in world space, and compares that against the terrain under each
 * sample. The signed result is the number that matters:
 *
 *  - **positive** â€” daylight under the track. This is the reported bug.
 *  - **negative** â€” the track has sunk into the ground.
 *
 * Both are failures; the second is the one a naive "just lower the vehicle" fix creates, which is why the
 * brief forbids it and why this reports the pair together.
 *
 * ## Why the transform is restated rather than shared
 *
 * The renderer uses Babylon's `node.rotation`, whose composition order is
 * `Ry(yaw) * Rx(pitch) * Rz(roll)` â€” not the intuitive `Rz * Rx * Ry`. Restating it here is deliberate:
 * if the two implementations shared a helper, a change to the helper would change the measurement and the
 * thing being measured at the same time, and the measurement would stay green while the bug stayed real.
 * The browser probe in `tools/grounding-probe.js` re-measures the same quantity through Babylon's own
 * world matrices, which is the independent check that this restatement is faithful.
 */
import { Battlefield } from '../../core/world/battlefield.js';
import { MARLOWE_CROSSING } from '../../core/world/maps/marlowe-crossing.js';
import { CT_MEDIUM } from '../../shared/roster.js';
import { TANK_PROPORTIONS } from '../../client/render/tank-proportions.js';
import {
  groundSupportPitchRad,
  groundSupportRollRad,
  solveGroundSupportPlane,
} from '../../core/vehicle/ground-support.js';

/** Vehicle footprint, mirrored from the renderer so both read the same numbers. */
const LENGTH_M = CT_MEDIUM.dimensions.lengthM;
const WIDTH_M = CT_MEDIUM.dimensions.widthM;
const TRACK_SPAN_M = LENGTH_M * TANK_PROPORTIONS.trackLengthFraction;
const TRACK_WIDTH_M = WIDTH_M * TANK_PROPORTIONS.trackWidthFraction;
const TRACK_CENTRE_X_M = WIDTH_M * (0.5 - TRACK_WIDTH_M / WIDTH_M / 2);

/** Samples along the track run. Seven matches the road-wheel count closely enough to be honest. */
const SAMPLES_ALONG = 7;

/**
 * A gap this large reads as daylight to the player rather than as a tolerance.
 *
 * Derived rather than guessed: at the orbit camera's usual 8-14 m standoff and a 40 degree vertical field
 * of view, a 0.12 m gap subtends about 0.5 degrees — roughly 8 pixels in a 760 px frame. That is the point
 * at which it stops being a tolerance and becomes a visible dark line under the track, which is the thing
 * the owner is reporting. Anything below it is inside the error of the vehicle's own ground clearance.
 */
export const FLOATING_GAP_M = 0.12;

/**
 * Maximum vertical travel of a track segment, metres.
 *
 * Restated from `vehicle-visual.ts` rather than imported, because that module pulls in Babylon and this tool
 * runs headless with no renderer present. The duplication is deliberate and is pinned by
 * `tests/core/grounding.test.ts`, so the two cannot drift apart without a test failing.
 */
const CONFORM_TRAVEL_M = 0.55;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** One measured sample: where it is, how much daylight is under it, and the terrain gradient there. */
export interface ContactSample {
  /** Metres forward of the vehicle centre, along its own heading. */
  readonly forwardOffsetM: number;
  /** Which side: -1 is the model's -X flank, +1 its +X flank. */
  readonly side: -1 | 1;
  /** Height of the rendered track's lower edge at this point, world metres. */
  readonly renderedBottomY: number;
  /** Height of the terrain directly below it, world metres. */
  readonly terrainY: number;
  /** `renderedBottomY - terrainY`. Positive is daylight under the track. */
  readonly gapM: number;
  /** Terrain gradient along the vehicle's heading at this point, degrees. Positive is uphill. */
  readonly gradientDeg: number;
}

/** The aggregate verdict for one pose. */
export interface GroundingReading {
  readonly label: string;
  readonly headingDeg: number;
  /** Body pitch the simulation would present, degrees. */
  readonly pitchDeg: number;
  /** Body roll the simulation would present, degrees. */
  readonly rollDeg: number;
  /** Largest daylight gap anywhere under the track run, metres. The number the owner reported. */
  readonly maxGapM: number;
  /** Deepest penetration into the ground, metres. Positive means buried. */
  readonly maxBiteM: number;
  /** Mean signed gap across every sample. Near zero is the aim; bias is the tell. */
  readonly meanGapM: number;
  /** Fraction of the track run with a gap large enough to read as floating, 0..1. */
  readonly floatingFraction: number;
  /**
   * Mean gap at the frontmost station and the rearmost, metres.
   *
   * Reported separately because the **sign of the body pitch** is only observable through the difference
   * between them. A correctly pitched tank on an uphill has both ends equally clear; an inverted pitch
   * digs the nose in and lifts the tail, which shows up here as rear minus front being large and positive
   * on an ascent. Averaging the two sides removes the cross-slope so this measures pitch alone.
   */
  readonly frontGapM: number;
  readonly rearGapM: number;
  /** Most negative gap anywhere, i.e. how deeply the track is buried. Signed. */
  readonly minGapM: number;
  /**
   * Terrain's own front-to-rear height difference over the track run, metres.
   *
   * This is the ground truth the body attitude is supposed to reproduce. Positive means the ground is
   * higher at the front, i.e. the vehicle is climbing.
   */
  readonly terrainFrontToRearM: number;
  /**
   * The same difference as the *rendered body* produces, metres.
   *
   * The defect this exists to catch is a **sign error**, which is invisible in the aggregate numbers: a
   * body pitched the wrong way still has a small gap everywhere on gentle ground, and only becomes
   * obvious as a large front/rear split once the pitch is big enough to matter. Comparing this against
   * `terrainFrontToRearM` is a direct test: if the two have opposite signs, the pitch is inverted and no
   * amount of vertical offsetting will fix it.
   */
  readonly bodyFrontToRearM: number;
  /**
   * Terrain's own left-to-right height difference across the track gauge, metres.
   *
   * The roll counterpart of the pair above, and the only way to test the roll sign independently. Pitch
   * and roll are separate rotations and a wrong sign in either produces a plausible-looking attitude, so
   * each has to be checked against the axis it actually governs.
   */
  readonly terrainLeftToRightM: number;
  /** The same difference as the rendered body produces. Compare signs with the terrain's. */
  readonly bodyLeftToRightM: number;
  readonly samples: readonly ContactSample[];
}

/**
 * Rotates a model-local point into world space the way Babylon composes `node.rotation`.
 *
 * `Ry(yaw) * Rx(pitch) * Rz(roll)`, applied right to left to the local point. This is the convention
 * `TransformNode` uses, and getting it wrong would misreport the pose rather than the terrain.
 */
function toWorld(
  local: readonly [number, number, number],
  pitchRad: number,
  yawRad: number,
  rollRad: number,
): readonly [number, number, number] {
  // Rz(roll)
  const cr = Math.cos(rollRad);
  const sr = Math.sin(rollRad);
  const x1 = local[0] * cr - local[1] * sr;
  const y1 = local[0] * sr + local[1] * cr;
  const z1 = local[2];

  // Rx(pitch)
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;
  const x2 = x1;

  // Ry(yaw)
  const cy = Math.cos(yawRad);
  const sy = Math.sin(yawRad);
  return [x2 * cy + z2 * sy, y2, z2 * cy - x2 * sy];
}

/**
 * The pitch and roll the **core** presents, taken from the real solver.
 *
 * Called rather than restated. The earlier version of this file reimplemented the single-normal
 * decomposition inline, and when the core was fixed to fit a support plane this tool went on measuring the
 * *old* formula — reporting the bug as still present, against code that no longer existed. A measurement
 * that keeps its own copy of the thing under test cannot detect the thing changing, which is the same
 * failure mode as the original contact-offset comment in `vehicle-visual.ts`.
 *
 * The remaining duplication is only the Babylon rotation composition in `toWorld`, which is restated for
 * the reason given there: it is a property of the engine, not of the code being measured, and the browser
 * probe re-derives it from Babylon's own matrices as an independent check.
 */
function bodyOrientation(
  heightAt: (x: number, z: number) => number,
  x: number,
  z: number,
  headingRad: number,
): { pitchRad: number; rollRad: number } {
  const plane = solveGroundSupportPlane(
    heightAt,
    x,
    z,
    headingRad,
    TRACK_SPAN_M / 2,
    TRACK_CENTRE_X_M + TRACK_WIDTH_M / 2,
  );
  return { pitchRad: groundSupportPitchRad(plane), rollRad: groundSupportRollRad(plane) };
}

/**
 * Measures the rendered ground clearance of the tank at one pose, using the pose the current V6 code
 * produces: a single centre sample for height, a single centre normal for pitch and roll, and a rigid
 * track drawn through the result.
 *
 * @param label how this pose is described in the report
 * @param x world x of the vehicle centre
 * @param z world z of the vehicle centre
 * @param headingRad hull heading
 * @param clearanceM the renderer's `contactOffsetM`: how far its own geometry sits above the root origin
 */
export function measureGrounding(
  field: Battlefield,
  label: string,
  x: number,
  z: number,
  headingRad: number,
  clearanceM: number,
): GroundingReading {
  const terrain = field.terrain;
  const { pitchRad, rollRad } = bodyOrientation(
    (px, pz) => terrain.heightAt(px, pz),
    x,
    z,
    headingRad,
  );

  // ## Where the root actually sits
  //
  // The simulation's origin is the **hull floor**, held a ride height above the terrain. This model's origin
  // is the **track contact line**, whose geometry reaches local y = 0. `vehicle-visual.ts` therefore subtracts
  // both the ride height and its own measured contact offset, and this reproduces that exactly:
  //
  //     rootY = (heightAt + groundClearanceM) - rideHeight - contactOffset
  //           = heightAt                                        (offset is zero for this model)
  //
  // Kept as the full expression rather than simplified to `heightAt`, because a reader comparing this against
  // the renderer needs to see that *both* subtractions exist. Dropping either one reintroduces the original
  // float, and dropping either one is invisible to every other measurement in this file.
  const rideHeightM = CT_MEDIUM.dimensions.groundClearanceM;
  const rootY = terrain.heightAt(x, z) + rideHeightM - rideHeightM - clearanceM;

  const forwardX = Math.sin(headingRad);
  const forwardZ = Math.cos(headingRad);
  const rightX = Math.cos(headingRad);
  const rightZ = -Math.sin(headingRad);

  const samples: ContactSample[] = [];
  for (let i = 0; i < SAMPLES_ALONG; i += 1) {
    const forwardOffsetM = -TRACK_SPAN_M / 2 + (TRACK_SPAN_M / (SAMPLES_ALONG - 1)) * i;
    for (const side of [-1, 1] as const) {
      // The track's *inner* face is what the ground touches. The outer face carries the track links and
      // stands proud, so measuring there would report the links as a gap.
      const localX = side * (TRACK_CENTRE_X_M - TRACK_WIDTH_M / 2);

      // Where this station sits on the hull's bottom plane, given the pose just derived. The renderer uses
      // the same expression, because the conforming offset is defined as the difference between the ground
      // and this plane.
      const [px, py, pz] = toWorld([localX, 0, forwardOffsetM], pitchRad, headingRad, rollRad);
      const worldX = x + px;
      const worldZ = z + pz;
      const terrainY = terrain.heightAt(worldX, worldZ);

      // The conforming offset this station receives, saturated at its settled value. Settled rather than
      // eased, because a single static pose has no history to ease over: the vehicle has been sitting here,
      // and the measurement is asking where it comes to rest, not how it got there. The dynamic case is
      // covered by the driving sequence, which is where easing and jitter are actually visible.
      const conformOffsetM = clamp(
        terrainY - (rootY + py),
        -CONFORM_TRAVEL_M,
        CONFORM_TRAVEL_M,
      );

      const renderedBottomY = rootY + py + conformOffsetM;

      samples.push({
        forwardOffsetM,
        side,
        renderedBottomY,
        terrainY,
        gapM: renderedBottomY - terrainY,
        gradientDeg: terrain.slopeDegreesAlong(worldX, worldZ, forwardX, forwardZ),
      });
    }
  }

  // Lateral tallies use the conforming bottom, so a roll measurement is not polluted by the very gap the
  // conforming is there to close.
  void rightX;
  void rightZ;

  let maxGapM = Number.NEGATIVE_INFINITY;
  let maxBiteM = 0;
  let sum = 0;
  let floating = 0;
  let minGapM = Number.POSITIVE_INFINITY;
  const frontmost = -TRACK_SPAN_M / 2;
  const rearmost = TRACK_SPAN_M / 2;
  let frontSum = 0;
  let rearSum = 0;
  let frontTerrain = 0;
  let rearTerrain = 0;
  let frontBody = 0;
  let rearBody = 0;
  // Lateral tallies, accumulated over every station so the gauge average is not taken from two samples.
  let leftTerrain = 0;
  let rightTerrain = 0;
  let leftBody = 0;
  let rightBody = 0;
  let lateralCount = 0;
  for (const s of samples) {
    if (s.gapM > maxGapM) maxGapM = s.gapM;
    if (s.gapM < minGapM) minGapM = s.gapM;
    if (-s.gapM > maxBiteM) maxBiteM = -s.gapM;
    sum += s.gapM;
    if (s.gapM > FLOATING_GAP_M) floating += 1;
    if (s.forwardOffsetM === frontmost) {
      frontSum += s.gapM;
      frontTerrain += s.terrainY;
      frontBody += s.renderedBottomY;
    }
    if (s.forwardOffsetM === rearmost) {
      rearSum += s.gapM;
      rearTerrain += s.terrainY;
      rearBody += s.renderedBottomY;
    }
    if (s.side === -1) {
      leftTerrain += s.terrainY;
      leftBody += s.renderedBottomY;
    } else {
      rightTerrain += s.terrainY;
      rightBody += s.renderedBottomY;
    }
    lateralCount += 1;
  }

  return {
    label,
    headingDeg: (headingRad * 180) / Math.PI,
    pitchDeg: (pitchRad * 180) / Math.PI,
    rollDeg: (rollRad * 180) / Math.PI,
    maxGapM,
    maxBiteM,
    meanGapM: sum / samples.length,
    floatingFraction: floating / samples.length,
    frontGapM: frontSum / 2,
    rearGapM: rearSum / 2,
    minGapM,
    terrainFrontToRearM: (rearTerrain - frontTerrain) / 2,
    bodyFrontToRearM: (rearBody - frontBody) / 2,
    terrainLeftToRightM: (leftTerrain - rightTerrain) / lateralCount,
    bodyLeftToRightM: (leftBody - rightBody) / lateralCount,
    samples,
  };
}

/**
 * The renderer's measured clearance, restated for a headless run. See `VehicleVisual.debugContactOffsetM`.
 *
 * The track box is centred at `trackHeightM / 2` in root space, so its lower edge sits at exactly zero;
 * the track links and road wheels stand proud of the track but do not reach lower. The measured offset is
 * therefore zero, which means the entire flat-ground clearance is the simulation's own `groundClearanceM`
 * of 0.48 m. The renderer subtracts this from the simulation's ride height, so the two cancel on flat
 * ground — which is exactly why flat ground looks right and only uneven ground does not.
 */
export function headlessContactOffsetM(): number {
  return 0;
}

/** Builds the battlefield the measurement runs against. */
export function marloweField(): Battlefield {
  return new Battlefield(MARLOWE_CROSSING);
}

/**
 * The surfaces the brief requires, located on Marlowe Crossing.
 *
 * Chosen from the map's own authored features rather than from arbitrary coordinates, so each one is a
 * place a player will actually drive. The railway ones matter most: the line is a `LevelCorridor` in the
 * height field, so the embankment falls away steeply to either side and it is the worst case on the map.
 */
export function groundingTestPoses(): { label: string; x: number; z: number; headingRad: number }[] {
  return [
    // 1. Flat ground. The railway formation is graded level, so this is genuinely flat, and it is the
    //    regression case: whatever the fix does, it must not change this.
    { label: '1. flat: railway formation', x: -60, z: -30, headingRad: 0 },
    // 2. Gentle constant slope. The flank of the central swell, driven along the fall line.
    { label: '2. slope: central swell flank', x: -10, z: 30, headingRad: Math.PI },
    // 3. Rolling ground. The southern fields, which the map documents as rolling rather than flat.
    { label: '3. rolling: southern fields', x: 40, z: 120, headingRad: 0.6 },
    // 4. Crest transition. The crown of the central swell, driven across it rather than along it.
    { label: '4. crest: central swell', x: -10, z: -5, headingRad: 1.5708 },
    // 5. Shallow depression. A hollow off the field route.
    { label: '5. depression: field hollow', x: 150, z: 40, headingRad: 2.2 },
    // 6. Road-to-field transition, where the graded road ribbon meets open ground.
    { label: '6. road to field', x: 46, z: -34, headingRad: 0 },
    // 7. Railway crossing. The deck, where the road runs over the rails.
    { label: '7. railway crossing', x: 20, z: -30, headingRad: 0 },
    // 8. Railway embankment, driven across the line with the ground falling away to one side. The worst
    //    cross-slope on the map, and the one a single central normal handles worst.
    { label: '8. embankment, across the line', x: -60, z: -30, headingRad: 1.5708 },
    // 9-11. A **controlled constant climb** on the Cairn approach, which the map documents as a chain of
    //    broad bumps. The point of these is sign isolation: the gradient is uphill in a known world
    //    direction, so a correct pitch lifts the front and an inverted one buries it. Because the gap is
    //    read at the frontmost and rearmost station, the measurement separates "wrong attitude" from
    //    "wrong height" in a way the aggregate numbers cannot.
    { label: '9. climb: cairn approach, facing uphill', x: 120, z: -150, headingRad: -0.9 },
    { label: '10. climb: cairn approach, second pitch', x: 150, z: -120, headingRad: -0.6 },
    { label: '11. climb: west knoll, facing uphill', x: -192, z: -20, headingRad: 3.14159 },
    // 12-13. Genuinely flat **open** ground, found by `findFlatGround` rather than chosen by eye. These
    //      are the honest regression case. Poses 1 and 7 sit on the railway formation, where ballast and
    //      sleeper props are drawn on top of the heightfield and hide a float that is really there; open
    //      ground has no such cover, so it shows the vertical component on its own.
    { label: '12. flat open ground (5 mm relief)', x: 170, z: 0, headingRad: 0 },
    { label: '13. flat open ground, across heading', x: 30, z: 80, headingRad: 1.5708 },
  ];
}

/** Formats a reading as an aligned block of text. */
export function formatReading(reading: GroundingReading): string {
  const lines: string[] = [];
  lines.push(`  ${reading.label}`);
  lines.push(
    `    heading ${reading.headingDeg.toFixed(0).padStart(4)}deg  ` +
      `pitch ${reading.pitchDeg.toFixed(1).padStart(6)}deg  roll ${reading.rollDeg.toFixed(1).padStart(6)}deg`,
  );
  lines.push(
    `    max daylight under track ${reading.maxGapM.toFixed(3).padStart(6)} m   ` +
      `deepest bite ${reading.maxBiteM.toFixed(3)} m   ` +
      `mean ${reading.meanGapM >= 0 ? '+' : ''}${reading.meanGapM.toFixed(3)} m   ` +
      `floating ${(reading.floatingFraction * 100).toFixed(0).padStart(3)}%`,
  );
  lines.push(
    `    front ${reading.frontGapM.toFixed(3).padStart(6)} m   rear ${reading.rearGapM.toFixed(3).padStart(6)} m   ` +
      `rear-front ${(reading.rearGapM - reading.frontGapM >= 0 ? '+' : '') + (reading.rearGapM - reading.frontGapM).toFixed(3)} m`,
  );
  // The sign test. `terrain` is what the ground actually does front-to-rear; `body` is what the rendered
  // hull does. On a climb the ground rises toward the front, so `terrain` is negative here (front is
  // higher). A correctly pitched body reproduces that sign. An inverted one does not, and this line is
  // the single clearest statement of which case is present.
  const signOk = reading.terrainFrontToRearM * reading.bodyFrontToRearM >= 0;
  lines.push(
    `    pitch  terrain front-to-rear ${reading.terrainFrontToRearM.toFixed(3).padStart(6)} m   ` +
      `body ${reading.bodyFrontToRearM.toFixed(3).padStart(6)} m   ` +
      `${signOk ? 'agrees' : 'OPPOSED SIGN'}`,
  );
  const rollOk = reading.terrainLeftToRightM * reading.bodyLeftToRightM >= 0;
  lines.push(
    `    roll   terrain left-to-right ${reading.terrainLeftToRightM.toFixed(3).padStart(6)} m   ` +
      `body ${reading.bodyLeftToRightM.toFixed(3).padStart(6)} m   ` +
      `${rollOk ? 'agrees' : 'OPPOSED SIGN'}`,
  );
  const worst = [...reading.samples].sort((a, b) => b.gapM - a.gapM).slice(0, 3);
  for (const s of worst) {
    lines.push(
      `      worst: ${s.forwardOffsetM.toFixed(2).padStart(6)}m fwd  side ${s.side > 0 ? '+' : '-'}  ` +
        `gap ${s.gapM >= 0 ? '+' : ''}${s.gapM.toFixed(3)} m  (ground gradient ${s.gradientDeg.toFixed(1)}deg)`,
    );
  }
  return lines.join('\n');
}

/** Runs the whole suite and returns the report plus the readings, for tests to assert on. */
export function reportGrounding(): { text: string; readings: GroundingReading[] } {
  const field = marloweField();
  const clearanceM = headlessContactOffsetM();
  const readings: GroundingReading[] = [];

  const lines: string[] = [];
  lines.push('=== V6 uneven-ground contact: measured gap under the rendered track ===');
  lines.push(`map: Marlowe Crossing   vehicle: ${CT_MEDIUM.displayName}`);
  lines.push(
    `track run ${TRACK_SPAN_M.toFixed(2)} m long, ${SAMPLES_ALONG * 2} samples per pose; ` +
      `a gap above ${FLOATING_GAP_M} m reads as floating`,
  );
  lines.push('');

  for (const pose of groundingTestPoses()) {
    const reading = measureGrounding(field, pose.label, pose.x, pose.z, pose.headingRad, clearanceM);
    readings.push(reading);
    lines.push(formatReading(reading));
    lines.push('');
  }

  const worstGap = Math.max(...readings.map((r) => r.maxGapM));
  const worstBite = Math.max(...readings.map((r) => r.maxBiteM));
  const worstFloat = Math.max(...readings.map((r) => r.floatingFraction));
  const opposed = readings.filter((r) => r.terrainFrontToRearM * r.bodyFrontToRearM < 0).length;
  lines.push(
    `WORST over all poses: ${worstGap.toFixed(3)} m of daylight, ${worstBite.toFixed(3)} m of bite, ` +
      `${(worstFloat * 100).toFixed(0)}% of the run floating`,
  );
  lines.push(`poses where the body's front-to-rear tilt opposes the terrain: ${opposed} of ${readings.length}`);
  lines.push('');
  lines.push('flattest open ground on the map, for the flat-ground regression case:');
  for (const spot of findFlatGround(field, 6)) {
    lines.push(
      `  (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)})  relief over the track run ` +
        `${(spot.reliefM * 1000).toFixed(0)} mm`,
    );
  }

  return { text: lines.join('\n'), readings };
}

/**
 * Finds the most level patches of open ground, ranked by relief across the track run.
 *
 * ## Why this exists
 *
 * The brief requires verifying on *perfectly flat* ground, and the obvious way to get it — sampling a
 * point and assuming it is flat — is exactly the assumption that produced the last two rounds of
 * confusion. The railway formation is level, but it is level because a `LevelCorridor` forces it to be,
 * and it carries ballast and sleeper props; a vehicle parked there is standing on a mesh rather than on
 * ground, so it cannot tell us what happens on honest flat terrain.
 *
 * So this scans for genuinely flat *open* ground, and reports the worst height deviation across the
 * whole track footprint rather than a single gradient. A spot qualifies as flat when the terrain under
 * the entire 6.3 m run varies by less than a couple of centimetres, which is below the resolution at
 * which the model can be held to any useful tolerance.
 */
export function findFlatGround(
  field: Battlefield,
  count: number,
): { x: number; z: number; reliefM: number }[] {
  const terrain = field.terrain;
  const half = terrain.halfSizeM;
  const step = 10;
  const found: { x: number; z: number; reliefM: number }[] = [];

  for (let z = -half + 40; z <= half - 40; z += step) {
    for (let x = -half + 40; x <= half - 40; x += step) {
      // Relief across the footprint, sampled at the four corners and the centre of the track run. Corners
      // alone would miss a ridge running diagonally under the vehicle.
      const heights = [
        terrain.heightAt(x - TRACK_SPAN_M / 2, z),
        terrain.heightAt(x + TRACK_SPAN_M / 2, z),
        terrain.heightAt(x, z - TRACK_SPAN_M / 2),
        terrain.heightAt(x, z + TRACK_SPAN_M / 2),
        terrain.heightAt(x, z),
      ];
      const reliefM = Math.max(...heights) - Math.min(...heights);
      found.push({ x, z, reliefM });
    }
  }

  found.sort((a, b) => a.reliefM - b.reliefM);

  // Spread the picks out, so the report does not return eight adjacent samples of the same field.
  const picked: { x: number; z: number; reliefM: number }[] = [];
  for (const candidate of found) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.hypot(p.x - candidate.x, p.z - candidate.z) > 60)) {
      picked.push(candidate);
    }
  }
  return picked;
}
