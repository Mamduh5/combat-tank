/**
 * The vehicle model contract, stated once and checked mechanically.
 *
 * ## Why this file exists
 *
 * V7 established a contract for vehicle models â€” a node list, a coordinate convention, a set of pivots â€”
 * and enforced the node list by throwing from the loader when one was missing. That was a real improvement
 * over Babylon primitives, but the enforcement was **partial**, and the gap is the one V8 runs into
 * immediately: adding a *second and third* vehicle to the same pipeline is only safe if every vehicle in
 * the roster is held to the same standard, and "the loader throws if `Turret` is missing" says nothing about
 * whether the third vehicle's hull origin is on the ground, whether its muzzle points forward, or whether its
 * width matches the definition it claims to be.
 *
 * So the contract is stated here as **data**, and the checks are **pure functions over a plain probe**.
 * That split is the whole design:
 *
 *  - The client builds a probe from the loaded rig and validates it, so a malformed asset fails at load
 *    with a message naming the vehicle and the rule.
 *  - The asset tests build a probe from the generated `.glb` and validate the same thing headlessly, so a
 *    malformed asset is a build failure rather than something only a browser can discover.
 *
 * One implementation, two callers. A contract checked in two places is a contract that will disagree.
 *
 * ## What a probe is, and why it is not a mesh
 *
 * `VehicleModelProbe` is **numbers and names**, with no Babylon types anywhere. That is what makes the checks
 * testable in a plain Node test, and what stops a second caller reimplementing the contract against the
 * scene graph because it "only needs the bounding box".
 *
 * ## These are our tanks
 *
 * The contract describes integration requirements for a fictional vehicle in broadly recognisable tank
 * design language. It says nothing about what a model looks like, and no rule here is derived from a real
 * or commercial tank. See `docs/asset-provenance.md`.
 */

/**
 * A machine-readable description of one loaded vehicle model.
 *
 * Everything here is measured from the asset itself, never from what the caller expected. All coordinates
 * are in **vehicle local space**: metres, +Y up, +Z forward (the nose), +X right, origin at the centre of
 * the track contact line on the vehicle's centreline.
 */
export interface VehicleModelProbe {
  /** Id of the vehicle this model was loaded for, used only to make failures readable. */
  readonly vehicleId: string;

  /** Every node name present in the asset, so required names can be checked. */
  readonly nodeNames: readonly string[];

  /** Hull extent along the vehicle's own Z axis, metres. */
  readonly hullLengthM: number;
  /** Hull extent along X, metres. */
  readonly hullWidthM: number;
  /** Hull extent along Y, metres. */
  readonly hullHeightM: number;

  /**
   * Height of the lowest hull vertex above the model origin, metres.
   *
   * The contract puts the origin on the track contact line, so this must be approximately zero. A model
   * authored sitting on the origin with its tracks *below* it produces a tank whose tracks sink into the
   * terrain â€” a grounding bug no bounding-box test catches, because the box is the right size.
   */
  readonly hullLowestY: number;

  /** Turret pivot position in vehicle local space, metres. */
  readonly turretPivot: { x: number; y: number; z: number };
  /** Gun pivot (trunnion) position in vehicle local space, metres. */
  readonly gunPivot: { x: number; y: number; z: number };
  /** Muzzle marker position in vehicle local space, metres. */
  readonly muzzle: { x: number; y: number; z: number };

  /** Number of wheel/sprocket/idler nodes found. */
  readonly wheelCount: number;
  /** Number of track segment nodes found. */
  readonly trackSegmentCount: number;

  /** Meshes with no material assigned. Destruction tints meshes, so a material-less mesh cannot be tinted. */
  readonly meshesWithoutMaterial: number;
  /** Total mesh count, so "no meshes at all" and "all meshes are fine" can be told apart. */
  readonly meshCount: number;
}
/**
 * The rules a vehicle model has to satisfy, as data.
 *
 * Exported rather than inlined so a test can assert the contract itself has not been quietly weakened, and
 * so the documentation and the code cannot drift into describing different things.
 */
export const VEHICLE_MODEL_CONTRACT = {
  /** Nodes that must exist by exact name. The loader resolves each of these by name. */
  requiredNodes: ['Tank', 'Hull', 'Turret', 'Gun', 'Muzzle'] as const,

  /** At least this many wheel nodes across the vehicle. */
  minimumWheels: 4,

  /**
   * At least this many track segments across the vehicle.
   *
   * One is technically enough to satisfy the loader, and one is also useless: the V6 track conforming
   * offsets each segment independently, so a single segment per side means the running gear cannot follow
   * uneven ground at all and the whole grounding pass silently stops applying.
   */
  minimumTrackSegments: 4,

  /**
   * How far the hull's measured length may differ from `dimensions.lengthM`, as a fraction.
   *
   * 2% because that is the threshold the runtime loader itself corrects at. Above it the loader *rescales*
   * the model to fit, which hides a dimension mismatch instead of reporting it â€” so this check has to fire
   * before that correction does, and this file is the earlier gate.
   */
  lengthToleranceFraction: 0.02,

  /**
   * Tolerance on hull width and height against the definition, as a fraction.
   *
   * Much wider than the length tolerance, on purpose. `dimensions.widthM` describes the vehicle *across its
   * tracks*, while the hull mesh's own bounding box is the hull body between them â€” narrower by construction,
   * by roughly a quarter on every vehicle in the roster. Comparing them at the length tolerance would report
   * every correctly-built model as broken.
   *
   * What this catches is the failure that actually happens: a model authored in the wrong units or from
   * the wrong spec, which is wrong by a large factor rather than by a small one.
   */
  /**
   * Smallest fraction of the definition's cross-section the hull body may occupy.
   *
   * Set by the models rather than by taste. `dimensions.widthM` is the vehicle **across its tracks**; the
   * hull mesh's own bounding box is the body **between** them. The authored hull is 52–60% of the overall
   * width across the roster, so 0.35 leaves real headroom while still catching a model built from the wrong
   * spec — a light hull measured against a medium definition is 0.40 of the medium's width and would pass
   * here, but it is 5.4 m against 6.7 m and the length rule catches it.
   */
  crossSectionMinFraction: 0.35,

  /**
   * Largest fraction of the definition's cross-section the hull body may occupy: 1.0.
   *
   * A hull cannot be wider than the vehicle carrying it, so this is a hard upper bound rather than a
   * tolerance. It is what catches a model authored in centimetres or otherwise at the wrong scale, which is
   * the failure this whole file exists to make loud.
   *
   * ## The slack below is float error, not design room
   *
   * This was compared with a bare `> 1.0`, and the heavy was rejected at 3.50 m against a 3.50 m definition.
   * The model is *exactly* right: the hull's half-width is derived from `widthM * 0.5`, and the two cancel to
   * 1.0 in real arithmetic. They do not cancel exactly in floating point — the measured extent comes from
   * transformed vertex coordinates accumulated through a chain of matrix multiplies, and the result was
   * 3.5000000000000004.
   *
   * So the bound now carries {@link crossSectionSlackFraction}. A millionth of the vehicle's width is about
   * three nanometres, far below any geometry a person can author and far below what the renderer resolves,
   * and it exists purely so that an exact construction is not reported as a violation. Anything genuinely
   * wrong — a model at the wrong scale, which is metres rather than nanometres — still fails by miles.
   */
  crossSectionMaxFraction: 1.0,

  /**
   * Tolerance added to {@link crossSectionMaxFraction} to absorb floating-point error, as a fraction.
   *
   * Applied as `fraction > crossSectionMaxFraction + crossSectionSlackFraction`, so it only ever loosens the
   * upper bound and never the lower one. `1e-6` sits many orders of magnitude below any real authoring
   * difference while being far above the ~1e-16 relative error that produced the original failure.
   */
  crossSectionSlackFraction: 1e-6,

  /** How far the hull's lowest vertex may sit below the origin, metres. */
  groundOffsetToleranceM: 0.05,

  /** How far off the vehicle's centreline the turret pivot may sit laterally, metres. */
  turretPivotLateralToleranceM: 0.05,

  /** The muzzle must be at least this far ahead of the gun pivot, metres. */
  minimumMuzzleReachM: 0.5,
} as const;

/** One contract violation, described so it can be acted on without reading the rules. */
export interface ModelContractProblem {
  /** Which rule was broken. Matches the bracketed tag in the reported message. */
  readonly rule: string;
  /** What is wrong, with the measured value and the expected one. */
  readonly detail: string;
}
/**
 * Checks a measured model against the contract.
 *
 * Pure: numbers in, problems out. It never touches a scene, a file, or the network, which is what lets the
 * same function run at load time in the browser and in a headless test over a generated `.glb`.
 *
 * @returns an empty array when the model satisfies the contract.
 */
export function validateVehicleModel(
  probe: VehicleModelProbe,
  expected: { lengthM: number; widthM: number; heightM: number },
): ModelContractProblem[] {
  const problems: ModelContractProblem[] = [];
  const add = (rule: string, detail: string): void => {
    problems.push({ rule, detail: `${probe.vehicleId}: ${detail}` });
  };

  // --- Nodes -------------------------------------------------------------------------------
  const names = new Set(probe.nodeNames);
  for (const required of VEHICLE_MODEL_CONTRACT.requiredNodes) {
    if (!names.has(required)) {
      add(
        'missing-node',
        `required node '${required}' is absent. The runtime resolves it by this exact name and throws ` +
          `without it.`,
      );
    }
  }

  // --- Size --------------------------------------------------------------------------------
  if (
    Math.abs(probe.hullLengthM - expected.lengthM) / expected.lengthM >
    VEHICLE_MODEL_CONTRACT.lengthToleranceFraction
  ) {
    add(
      'hull-length',
      `hull measures ${probe.hullLengthM.toFixed(2)} m along Z but the definition says ${expected.lengthM} m. ` +
        `That is past the ` +
        `${(VEHICLE_MODEL_CONTRACT.lengthToleranceFraction * 100).toFixed(0)}% tolerance, so the loader ` +
        `would rescale the whole model and the vehicle would render at the wrong size.`,
    );
  }
  for (const [measured, expectedM, label] of [
    [probe.hullWidthM, expected.widthM, 'width'],
    [probe.hullHeightM, expected.heightM, 'height'],
  ] as const) {
    const fraction = measured / expectedM;
    // The upper bound carries a slack term so that a hull constructed at *exactly* the definition's width is
    // not reported as too wide; see `crossSectionSlackFraction`.
    if (fraction > VEHICLE_MODEL_CONTRACT.crossSectionMaxFraction + VEHICLE_MODEL_CONTRACT.crossSectionSlackFraction) {
      add(
        `hull-${label}`,
        `the hull's ${label} is ${measured.toFixed(2)} m, wider than the ${expectedM} m the definition ` +
          `gives the whole vehicle. That is what a model authored in the wrong units looks like.`,
      );
    } else if (fraction < VEHICLE_MODEL_CONTRACT.crossSectionMinFraction) {
      add(
        `hull-${label}`,
        `the hull's ${label} is only ${measured.toFixed(2)} m against a ${expectedM} m definition — below ` +
          `the ${VEHICLE_MODEL_CONTRACT.crossSectionMinFraction} floor. The hull body sits between the ` +
          `tracks and is legitimately narrower, but not this much: this is probably the wrong model.`,
      );
    }
  }

  // --- Origin and pivots -------------------------------------------------------------------
  if (probe.hullLowestY < -VEHICLE_MODEL_CONTRACT.groundOffsetToleranceM) {
    add(
      'origin-above-ground',
      `the hull's lowest vertex is ${Math.abs(probe.hullLowestY).toFixed(3)} m below the origin. The ` +
        `contract puts the origin on the track contact line, so tracks this far below it sink into terrain.`,
    );
  }
  if (Math.abs(probe.turretPivot.x) > VEHICLE_MODEL_CONTRACT.turretPivotLateralToleranceM) {
    add(
      'turret-pivot-off-centre',
      `the turret pivot is ${probe.turretPivot.x.toFixed(3)} m off the vehicle's centreline. It rotates ` +
        `about this point, so an offset pivot makes the turret swing wide of the hull as it traverses.`,
    );
  }
  if (probe.turretPivot.y <= probe.hullLowestY) {
    add(
      'turret-pivot-at-or-below-hull',
      `the turret pivot sits at y=${probe.turretPivot.y.toFixed(3)} m, at or below the hull's underside, ` +
        `so the turret would sweep through the hull floor.`,
    );
  }

  // --- Forward axis and muzzle -------------------------------------------------------------
  // The most important geometric rule in the contract, and the one whose failure is invisible in a
  // screenshot: a tank facing backwards looks exactly like a tank facing forwards until somebody drives it.
  if (probe.muzzle.z <= probe.gunPivot.z) {
    add(
      'forward-axis',
      `the muzzle (z=${probe.muzzle.z.toFixed(3)}) is not ahead of the gun pivot ` +
        `(z=${probe.gunPivot.z.toFixed(3)}). The model must be authored facing +Z, not -Z.`,
    );
  }
  if (probe.muzzle.z - probe.gunPivot.z < VEHICLE_MODEL_CONTRACT.minimumMuzzleReachM) {
    add(
      'muzzle-reach',
      `the muzzle is only ${(probe.muzzle.z - probe.gunPivot.z).toFixed(2)} m ahead of the trunnion. It ` +
        `belongs at the end of the barrel, at least ${VEHICLE_MODEL_CONTRACT.minimumMuzzleReachM} m out.`,
    );
  }
  if (probe.muzzle.y < probe.gunPivot.y - 0.5) {
    add(
      'muzzle-below-trunnion',
      `the muzzle is ${(probe.gunPivot.y - probe.muzzle.y).toFixed(2)} m below the trunnion.`,
    );
  }

  // --- Running gear ------------------------------------------------------------------------
  if (probe.wheelCount < VEHICLE_MODEL_CONTRACT.minimumWheels) {
    add(
      'wheels',
      `only ${probe.wheelCount} wheel nodes; at least ${VEHICLE_MODEL_CONTRACT.minimumWheels} are required ` +
        `for the running gear to read as a tracked vehicle.`,
    );
  }
  if (probe.trackSegmentCount < VEHICLE_MODEL_CONTRACT.minimumTrackSegments) {
    add(
      'track-segments',
      `only ${probe.trackSegmentCount} track segment nodes; at least ` +
        `${VEHICLE_MODEL_CONTRACT.minimumTrackSegments} are required for the V6 track conforming to have ` +
        `any effect.`,
    );
  }

  // --- Materials and destruction ----------------------------------------------------------
  if (probe.meshCount === 0) {
    add('no-meshes', 'the asset contains no meshes, so there is nothing to render.');
  }
  if (probe.meshesWithoutMaterial > 0) {
    add(
      'materials',
      `${probe.meshesWithoutMaterial} of ${probe.meshCount} meshes have no material. Destruction tints ` +
        `meshes, so a material-less mesh cannot be darkened when the vehicle is destroyed and will read as ` +
        `unharmed.`,
    );
  }

  return problems;
}

/** Renders contract problems as one throwable message naming every rule that failed. */
export function formatModelContractProblems(problems: readonly ModelContractProblem[]): string {
  return problems.map((p) => `  - [${p.rule}] ${p.detail}`).join('\n');
}