/**
 * Builds the V7 tank models: one shared builder producing both the player's tank and the enemy's, from a
 * parameter set rather than from two separate models.
 *
 * ## Why one builder with parameters
 *
 * The brief asks for "one proper player tank model" and says "a separate enemy model or meaningful model
 * variant is desirable if practical". A variant built by the *same* code with different numbers is
 * better than two hand-built models for a reason beyond effort: the two vehicles are then guaranteed to
 * share a silhouette *grammar* â€” the same glacis angle, the same wheel arrangement, the same detail
 * vocabulary â€” so they read as the same family of vehicle, and every future vehicle added in V8 inherits
 * that grammar instead of reinventing it.
 *
 * It is also what makes this a **pipeline** rather than two models: `buildTankModel(spec)` is the
 * contract, and adding a tank in V8 means writing a spec, not modelling.
 *
 * ## What is deliberately modelled, and why
 *
 * Each of these exists because without it the silhouette fails to read as a tank at combat range:
 *
 * - **A sloped glacis over a vertical lower plate.** The single strongest "this is the front" cue. A single
 *   tapered box reads as a boat bow; the two-part profile reads as armour.
 * - **A turret set back from the hull centre**, leaving the barrel to project forward of the nose. The
 *   vehicle needs a *visible gun*; a centred turret buries it inside the hull.
 * - **A bustle at the rear of the turret.** Gives the turret a direction from behind, so the player can see
 *   where their own gun points without checking the HUD.
 * - **Road wheels, sprocket, idler, and return rollers.** Turns a track slab into running gear, and the
 *   larger sprocket and idler at the ends give each track a definite front and back.
 * - **Fenders.** A horizontal line along the hull side that reads at distance and separates hull from
 *   tracks.
 * - **Stowage, hatch, cupola, exhaust.** Small parts that break up flat armour and stop the hull reading as
 *   a slab. Kept modest so they do not become decorative noise, which the brief warns against.
 *
 * ## Node hierarchy (this *is* the asset contract)
 *
 * ```
 * Tank                     root; the loader drives this with hull position and attitude
 *  â”œâ”€ Hull                 hull mesh
 *  â”œâ”€ Turret               rotates about Y for traverse; its origin is the turret ring centre
 *  â”‚   â”œâ”€ TurretMesh
 *  â”‚   â””â”€ Gun               pitches about X for elevation; its origin is the trunnion
 *  â”‚       â”œâ”€ GunMesh
 *  â”‚       â””â”€ Muzzle        an empty marker at the muzzle exit, for effects and audio
 *  â”œâ”€ WheelLâ€¦ / WheelRâ€¦    named wheel nodes, spun about X by distance travelled
 *  â”œâ”€ TrackL0â€¦N            track segments, offset vertically each frame to conform to the ground
 *  â””â”€ TrackR0â€¦N
 * ```
 *
 * Every one of those names is resolved by the runtime loader. They are strings in code, so they are
 * reviewable, testable, and documented in `docs/asset-pipeline.md` rather than being folklore.
 */

import { MeshBuilder } from './mesh.mjs';
import { Matrix } from './math.mjs';

/** Vertex-colour tints. A vertex tint multiplies the material's base colour, which is how one material
 *  gives a vehicle tonal variation between its plates without authoring several near-identical materials. */
const TINT = {
  hull: [1, 1, 1, 1],
  /** Slightly darker, so the hull sides and the turret do not read as one flat mass under flat lighting. */
  hullShade: [0.82, 0.82, 0.84, 1],
  turret: [0.95, 0.95, 0.97, 1],
  /** Bare metal: gun, mantlet, tracks. Tinted down so the steel is not brighter than the paint in daylight. */
  metal: [0.62, 0.62, 0.64, 1],
  darkMetal: [0.4, 0.4, 0.42, 1],
  rubber: [0.55, 0.55, 0.58, 1],
  detail: [0.7, 0.7, 0.72, 1],
};

/**
 * Builds one road wheel: a dished road wheel with a rubber tyre and a hub.
 *
 * Returned as its own builder so it can be instanced at several positions, which is what makes a run of
 * six identical wheels cost one mesh in the file rather than six.
 */
function roadWheel(radius, width) {
  const m = new MeshBuilder();
  // The tyre: a disc with a rounded outer shoulder. A flat cylinder reads as a coin edge; the chamfer is
  // what makes it read as a wheel sitting in a track.
  m.scoped(Matrix.rotationZ(Math.PI / 2), (b) => {
    b.cylinder(radius, radius, width, 16, { color: TINT.rubber });
  });
  // The hub, slightly proud of the tyre on the outer face.
  m.scoped(Matrix.rotationZ(Math.PI / 2), (b) => {
    b.pushTranslate(0, width * 0.5 + 0.02, 0);
    b.cylinder(radius * 0.42, radius * 0.42, 0.06, 12, { color: TINT.metal });
  });
  // Three bolt bosses around the hub, the detail that makes a wheel read as a manufactured part rather
  // than a smooth disc. Each is placed on its own angle around the wheel's axis.
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2;
    m.scoped(Matrix.rotationZ(Math.PI / 2), (wheel) => {
      wheel.pushRotateY(a);
      wheel.pushTranslate(0, width * 0.5 + 0.03, radius * 0.24);
      wheel.cylinder(0.03, 0.03, 0.05, 6, { color: TINT.darkMetal });
      wheel.pop();
      wheel.pop();
    });
  }
  return m;
}

/**
 * Builds the hull: sloped glacis over a vertical lower plate, sponsons, fenders, and an engine deck.
 */
function buildHull(d) {
  const m = new MeshBuilder();
  const { lengthM, widthM, trackHeightM, hullHeightM, roofHeightM } = d;
  const glacisHeight = hullHeightM * d.glacisHeightFraction;

  // Lower hull tub: the body between the tracks, sitting above the track line.
  //
  // Centred on `trackHeightM * 0.5`, which put the tub's *underside* at
  // `trackHeightM * 0.5 - hullHeightM / 2` — negative, so the hull hung below its own origin and through the
  // terrain. The tub sits **on top of** the track unit: its underside is at `trackHeightM` and it rises from
  // there. One subtraction, and the geometry is right by construction for any spec.
  m.pushTranslate(0, trackHeightM + hullHeightM * 0.5, 0);
  m.taperBox(widthM * d.hullWidthFraction, hullHeightM, lengthM, 0.98, 0.97, 0, 0, {
    color: TINT.hullShade,
    uvScale: 0.4,
  });
  m.pop();

  // Upper glacis: the sloped front plate, the single most important "this is the front" cue. Separate from
  // the tub, because a real hull has a vertical lower plate with a sloped glacis above it, and that
  // two-part profile catches light as two distinct surfaces. A single taper reads as a boat bow.
  const glacisDepth = glacisHeight * 2.2;
  // Centred so the glacis's **bottom front edge** sits exactly on the nose. Previously the box was centred
  // near the nose, which put its bottom front corner 0.27 m in front of it and made the hull 7.10 m long
  // against a 6.70 m definition — a 6% overshoot the contract is right to reject.
  m.pushTranslate(0, roofHeightM - glacisHeight * 0.5, lengthM * 0.5 - glacisDepth * 0.5);
  m.taperBox(
    widthM * d.hullWidthFraction,
    glacisHeight,
    glacisDepth,
    0.94,
    0.42,
    glacisHeight * 0.42,
    0,
    { color: TINT.hull, uvScale: 0.4 },
  );
  m.pop();

  // Front plate below the glacis: vertical, narrower, tucked under it.
  //
  // Placed so its front face is flush with the nose. The 0.34 m plate used to be *centred* on a point just
  // behind the nose, which pushed its front face 0.12 m past it and made the hull 6.95 m long on a 6.70 m
  // definition. Half the plate's depth is the setback, so the offset is derived rather than guessed at.
  m.pushTranslate(
    0,
    trackHeightM + (hullHeightM - glacisHeight) * 0.5,
    lengthM * 0.5 - 0.17,
  );
  m.box(widthM * d.hullWidthFraction * 0.9, hullHeightM - glacisHeight, 0.34, {
    color: TINT.hullShade,
    uvScale: 0.4,
  });
  m.pop();

  // Sponsons over the tracks: the upper hull is wider than the tub, overhanging the running gear. This is
  // what produces the characteristic stepped tank profile from the side.
  m.pushTranslate(0, roofHeightM - hullHeightM * 0.16, -lengthM * 0.06);
  m.taperBox(widthM * 0.97, hullHeightM * 0.32, lengthM * 0.74, 0.99, 0.98, 0, 0, {
    color: TINT.hull,
    uvScale: 0.4,
  });
  m.pop();

  // Engine deck: the rear of the hull, sloping down toward the tail.
  m.pushTranslate(0, roofHeightM - hullHeightM * 0.2, -lengthM * 0.31);
  m.taperBox(widthM * 0.82, hullHeightM * 0.22, lengthM * 0.34, 0.96, 0.94, 0, hullHeightM * 0.1, {
    color: TINT.hullShade,
    uvScale: 0.4,
  });
  m.pop();

  // Fenders: a thin shelf along each side above the tracks. Reads at any distance, and separates the hull
  // from the running gear in a way a single slab silhouette does not.
  for (const side of [-1, 1]) {
    // Inset so the fender's *outer* edge lands on the vehicle's width, not its centre. The centre used to be
    // placed at `widthM * 0.5 - widthM * 0.02` and then given a half-width of its own on top, which pushed the
    // outer edge to 1.749 m on a 1.650 m half-width — the hull came out 6% wider than the definition.
    // Deriving the centre from the half-width means the shelf overhangs the track (which is the point) while
    // the vehicle stays exactly as wide as its own collision box.
    const fenderHalfWidth = (widthM * d.fenderWidthFraction) / 2;
    const fenderCentre = side * (widthM * 0.5 - fenderHalfWidth);
    m.pushTranslate(fenderCentre, roofHeightM - hullHeightM * 0.1, 0);
    m.box(widthM * d.fenderWidthFraction, hullHeightM * 0.05, lengthM * d.fenderLengthFraction, {
      color: TINT.hullShade,
      uvScale: 0.5,
    });
    m.pop();
    // A mudguard lip, so the fender is not a floating plate. Inset by its own half-width for the same reason.
    m.pushTranslate(side * (widthM * 0.5 - 0.02), roofHeightM - hullHeightM * 0.16, 0);
    m.box(0.04, hullHeightM * 0.14, lengthM * d.fenderLengthFraction, { color: TINT.darkMetal });
    m.pop();
  }

  // Exhaust stub and its armoured cover at the rear left.
  m.pushTranslate(-widthM * 0.28, roofHeightM - 0.1, -lengthM * 0.44);
  m.box(0.5, 0.2, 0.34, { color: TINT.darkMetal, uvScale: 1.2 });
  m.pop();
  m.pushTranslate(-widthM * 0.28, roofHeightM + 0.05, -lengthM * 0.47 + 0.21);
  m.box(0.56, 0.1, 0.42, { color: TINT.detail, uvScale: 1.2 });
  m.pop();

  // Spare track links along the fender tops. The strongest single "this is a real vehicle" cue available
  // at prototype quality, for two boxes' worth of geometry.
  //
  // Sits on the fender, so it is placed at the fender's own top rather than at a fraction of hull height
  // above the tracks. `hullHeightM * 0.98` and `* 1.0` put both the links and the stowage box's top edge
  // above `roofHeightM`, which is the height the whole vehicle is supposed to reach — the hull then measured
  // 1.76 m against a 1.15 m definition. Deriving the height from the fender keeps them *on* it.
  const fenderTopM = roofHeightM - hullHeightM * 0.075;
  // Half the link's own height, so its underside sits on the fender rather than its centre being placed
  // there. The links used to be positioned at fixed metre offsets above the fender, which pushed them a
  // fifth of a metre above the roofline and made the hull 1.40 m tall against a 1.15 m definition.
  const linkHeight = 0.12;
  for (let i = 0; i < 3; i += 1) {
    m.pushTranslate(widthM * 0.44, fenderTopM + linkHeight * 0.5, -lengthM * 0.12 + i * 0.7);
    m.box(0.34, linkHeight, 0.62, { color: TINT.darkMetal, uvScale: 1.4 });
    m.pop();
  }
  // Placed by its own half-width so its outer face lands on the vehicle's side, rather than by a
  // position plus a fixed size. Centred at `widthM * 0.44` with a 0.42 m width it reached 1.662 m on a
  // 1.650 m half-width, which is the last 0.6% that kept `hull-width` failing.
  // Stowage bin, also seated on the fender by its own half-height rather than by a fixed offset. It is the
  // tallest thing on the hull, so leaving it proud of the roofline is what kept the hull 1.40 m tall on a
  // 1.15 m definition.
  const stowHalfWidth = 0.42 / 2;
  const stowHeight = 0.3;
  m.pushTranslate(-(widthM * 0.5 - stowHalfWidth), fenderTopM + stowHeight * 0.5, lengthM * 0.16);
  m.box(0.42, stowHeight, 0.5, { color: TINT.detail, uvScale: 1.1 });
  m.pop();

  // Headlamps at the nose, and the towing eyes at the rear.
  for (const side of [-1, 1]) {
    m.pushTranslate(
      side * widthM * 0.3,
      roofHeightM - glacisHeight * 0.55,
      lengthM * 0.5 - glacisHeight * 0.55,
    );
    m.cylinder(0.11, 0.11, 0.1, 10, { color: TINT.detail });
    m.pop();
    // Towing eyes at the rear. Set *into* the tail rather than hanging off it: the eyes used to be centred
    // `lengthM * 0.5 + 0.06` behind the origin, which put their rear face 0.13 m beyond the hull on every
    // vehicle in the roster. Inset by half their own depth so the outermost face lands on the tail.
    m.pushTranslate(side * widthM * 0.32, trackHeightM + 0.16, -lengthM * 0.5 + 0.07);
    m.box(0.1, 0.16, 0.14, { color: TINT.darkMetal });
    m.pop();
  }

  return m;
}

/**
 * Builds the turret: a tapered body, a rear bustle, a cupola, and a mantlet.
 *
 * The bustle matters more than its size suggests: it makes the turret's facing legible from directly
 * behind, which is where the third-person camera spends most of its time.
 */
function buildTurret(d) {
  const m = new MeshBuilder();
  const { turretLengthM, turretWidthM, turretHeightM } = d;

  // Main body, tapering toward the roof and slightly toward the front.
  m.taperBox(turretWidthM, turretHeightM * 0.72, turretLengthM, 0.82, 0.88, turretHeightM * 0.14, 0, {
    color: TINT.turret,
    uvScale: 0.55,
  });

  // Bustle: a lower box at the rear. Its rear face is what the player looks at most of the time.
  m.pushTranslate(0, turretHeightM * 0.1, -turretLengthM * 0.5);
  m.taperBox(turretWidthM * 0.92, turretHeightM * 0.44, turretLengthM * 0.5, 0.94, 0.9, 0, 0, {
    color: TINT.turret,
    uvScale: 0.55,
  });
  m.pop();

  // Cupola: a low drum on the left of the roof, with a hatch on top.
  m.pushTranslate(-turretWidthM * 0.22, turretHeightM * 0.44, turretLengthM * 0.02);
  m.cylinder(turretWidthM * 0.2, turretWidthM * 0.19, turretHeightM * 0.24, 12, { color: TINT.turret });
  m.pop();
  m.pushTranslate(-turretWidthM * 0.22, turretHeightM * 0.58, turretLengthM * 0.02);
  m.cylinder(turretWidthM * 0.17, turretWidthM * 0.15, 0.07, 12, { color: TINT.detail, uvScale: 1.5 });
  m.pop();

  // Vision blocks around the cupola, which is what stops the roof reading as a flat plate.
  for (let i = 0; i < 3; i += 1) {
    const a = -0.5 + i * 0.5;
    m.pushTranslate(
      -turretWidthM * 0.22 + Math.sin(a) * turretWidthM * 0.19,
      turretHeightM * 0.5,
      turretLengthM * 0.02 + Math.cos(a) * turretWidthM * 0.19,
    );
    m.box(0.1, 0.06, 0.14, { color: TINT.darkMetal });
    m.pop();
  }

  // Loader's hatch on the right of the roof.
  m.pushTranslate(turretWidthM * 0.2, turretHeightM * 0.44, turretLengthM * 0.06);
  m.cylinder(turretWidthM * 0.16, turretWidthM * 0.15, 0.07, 12, { color: TINT.detail, uvScale: 1.5 });
  m.pop();

  // Mantlet: the collar where the gun leaves the turret. A thickened ring around the barrel, which is what
  // stops the gun looking like a pipe pushed into a box.
  m.pushTranslate(0, turretHeightM * 0.3, turretLengthM * 0.5 - turretHeightM * 0.06);
  m.scoped(Matrix.rotationX(Math.PI / 2), (b) => {
    b.cylinder(turretHeightM * 0.42, turretHeightM * 0.36, turretHeightM * 0.34, 14, {
      color: TINT.metal,
      uvScale: 0.8,
    });
  });
  m.pop();

  // Turret stowage: a rack and a couple of boxes on the bustle roof. Modest, and deliberately so â€” the
  // brief warns against excessive decorative noise.
  m.pushTranslate(0, turretHeightM * 0.3, -turretLengthM * 0.5);
  m.box(turretWidthM * 0.7, 0.06, turretLengthM * 0.36, { color: TINT.darkMetal, uvScale: 1.2 });
  m.pop();
  m.pushTranslate(turretWidthM * 0.2, turretHeightM * 0.42, -turretLengthM * 0.46);
  m.box(turretWidthM * 0.3, 0.22, turretLengthM * 0.22, { color: TINT.detail, uvScale: 1.3 });
  m.pop();

  return m;
}

/**
 * Builds the gun barrel: a tapered tube with a fume extractor and a muzzle brake.
 *
 * The fume extractor (the fat collar partway along) is the detail that makes a barrel read as a *cannon*
 * rather than as a pipe: it is where the eye expects the shape to break, and a plain constant-radius tube
 * has nothing to catch the light along its length.
 */
function buildGun(d) {
  const m = new MeshBuilder();
  const { barrelLengthM, barrelRadiusM } = d;

  // The tube itself, tapering slightly toward the muzzle as a real barrel does.
  m.tubeZ(barrelRadiusM, barrelLengthM, 14, {
    radiusTop: barrelRadiusM * 0.82,
    color: TINT.metal,
    uvScale: 0.7,
  });

  // Fume extractor, at roughly a third of the barrel's length.
  m.pushTranslate(0, 0, barrelLengthM * 0.18);
  m.tubeZ(barrelRadiusM * 1.55, barrelLengthM * 0.1, 14, { color: TINT.metal, uvScale: 1.2 });
  m.pop();

  // Muzzle brake: a swollen, vented tip. This is what visually terminates the gun, and a barrel that just
  // stops in mid-air reads as unfinished.
  m.pushTranslate(0, 0, barrelLengthM * 0.5);
  m.tubeZ(barrelRadiusM * 1.5, barrelLengthM * 0.09, 14, { color: TINT.metal, uvScale: 1.2 });
  m.pop();

  // A collar where the barrel meets the mantlet.
  m.pushTranslate(0, 0, -barrelLengthM * 0.5 + barrelLengthM * 0.06);
  m.tubeZ(barrelRadiusM * 1.25, barrelLengthM * 0.05, 14, { color: TINT.darkMetal });
  m.pop();

  return m;
}

/**
 * Builds one track segment: a slab with cleats on its outer face.
 *
 * Segments are separate nodes rather than one mesh because the runtime moves each one vertically to follow
 * the ground beneath it. That conforming was a V6 fix and must survive the asset change â€” the brief is
 * explicit that grounding behaviour is preserved.
 */
function trackSegment(spanM, widthM, heightM) {
  const m = new MeshBuilder();
  m.box(widthM, heightM, spanM * 1.04, { color: TINT.metal, uvScale: 1.6 });
  // Cleats along the outer face. Their protrusion is what makes a moving track read as a track.
  const cleats = 3;
  for (let i = 0; i < cleats; i += 1) {
    m.pushTranslate(widthM * 0.5 + 0.015, 0, -spanM * 0.5 + (spanM * (i + 0.5)) / cleats);
    m.box(0.05, heightM * 0.4, spanM / cleats * 0.55, { color: TINT.darkMetal, uvScale: 2.2 });
    m.pop();
  }
  // The inner guide horns, which is what actually rides the road wheels.
  m.pushTranslate(0, -heightM * 0.5 + 0.03, 0);
  m.box(widthM * 0.3, 0.07, spanM * 0.5, { color: TINT.darkMetal, uvScale: 2 });
  m.pop();
  return m;
}

/**
 * The parameter set both vehicles are built from.
 *
 * These are **proportions**, not absolute measurements, wherever a proportion will do â€” the same discipline
 * the old runtime builder used, so a spec expresses a shape rather than a list of hard-coded dimensions.
 * Absolute values appear only where something is a silhouette cue with no proportional meaning.
 *
 * Three entries, and they differ **in kind rather than in degree**, which is the property V8 exists to
 * establish. `medium` is a compact, well-sloped tank with a rounded turret. `heavy` is longer, lower and
 * wider with a flatter turret and a much longer gun. `light` is none of those things: it is *small*, on
 * visibly oversized road wheels, with a tall little turret set forward and a stubby gun.
 *
 * **Silhouette, not colour, is the primary identification channel** — two tanks differing only in paint
 * are genuinely hard to tell apart at range, through fog, or for a colour-blind player, so the proportions
 * here are load-bearing rather than decorative.
 *
 * ## These are our tanks
 *
 * Fictional vehicles in broadly recognisable tank design language. Nothing here reproduces a specific
 * real or commercial tank, and no proportion is a statistic from a real vehicle. See
 * `docs/asset-provenance.md`.
 */
export const TANK_SPECS = {
  medium: {
    id: 'ct-medium',
    name: 'Sabre (CT Medium)',
    lengthM: 6.7,
    widthM: 3.3,
    heightM: 1.15,
    trackWidthFraction: 0.27,
    hullWidthFraction: 0.6,
    hullHeightFraction: 0.6,
    glacisHeightFraction: 0.44,
    glacisTaperFraction: 0.2,
    fenderWidthFraction: 0.1,
    fenderLengthFraction: 0.66,
    turretLengthFraction: 0.46,
    turretWidthFraction: 0.62,
    turretHeightFraction: 0.58,
    turretRearwardOffsetFraction: 0.05,
    barrelLengthFraction: 0.62,
    barrelRadiusM: 0.085,
    roadWheelCount: 6,
    roadWheelRadiusFraction: 0.33,
    sprocketRadiusFraction: 0.38,
    trackSegmentCount: 8,
  },
  heavy: {
    id: 'ct-heavy',
    name: 'Anvil (CT Heavy)',
    lengthM: 7.6,
    widthM: 3.5,
    heightM: 1.2,
    trackWidthFraction: 0.28,
    hullWidthFraction: 0.58,
    hullHeightFraction: 0.56,
    glacisHeightFraction: 0.36,
    glacisTaperFraction: 0.16,
    fenderWidthFraction: 0.1,
    fenderLengthFraction: 0.62,
    // Lower and longer than the player's: the read is "bigger and slower", not "the same tank, repainted".
    turretLengthFraction: 0.58,
    turretWidthFraction: 0.7,
    turretHeightFraction: 0.44,
    turretRearwardOffsetFraction: 0.02,
    barrelLengthFraction: 0.78,
    barrelRadiusM: 0.105,
    roadWheelCount: 7,
    roadWheelRadiusFraction: 0.29,
    sprocketRadiusFraction: 0.34,
    trackSegmentCount: 9,
  },

  /**
   * Vex, the light. **Smallest silhouette in the roster, and deliberately the odd one out.**
   *
   * The medium and the heavy are both long, low, and heavy-looking, and differ in proportion. The light
   * differs in *kind*, on four axes at once, because a vehicle that is merely a shrunken medium is not a
   * light — it is a medium that got smaller, and the player reads it as one:
   *
   *  - **A narrow hull on visibly large road wheels.** `roadWheelRadiusFraction: 0.42` against the
   *    medium's 0.33 puts the running gear's diameter up near the hull's own height, which is the cue
   *    that says "light" before any other feature is read.
   *  - **A small, upright turret set well forward.** `turretHeightFraction: 0.72` is the *highest* turret
   *    in the roster on the *shortest* hull, so the turret reads as a tall little box rather than a
   *    flattened one — the opposite of the heavy's low slab.
   *  - **A short, thin gun on a short hull.** 3.2 m, the stubbiest weapon here, against a 5.4 m vehicle.
   *  - **Long fenders over big wheels** (`fenderLengthFraction: 0.78`), which is the silhouette cue that
   *    survives at range when the turret is only a few pixels tall.
   *
   * The dimensions here must match `CT_LIGHT.dimensions` exactly. The runtime loader measures the hull
   * and rescales to the definition when they disagree by more than 2%, so a mismatch does not break — it
   * silently produces a light that is the wrong size, which is the failure mode the V7 audit exists to
   * catch. `tests/tools/asset-pipeline.test.ts` asserts they agree.
   */
  light: {
    id: 'ct-light',
    name: 'Vex (CT Light)',
    lengthM: 5.4,
    widthM: 2.9,
    heightM: 1.0,
    trackWidthFraction: 0.26,
    // Narrow hull between the tracks: a light vehicle has no width to spare, and showing more running
    // gear is the point of the silhouette.
    hullWidthFraction: 0.52,
    // The tallest hull body in the roster, because the wheels are carrying the height. A light vehicle
    // looks tall because it is perched, not because it is big.
    hullHeightFraction: 0.72,
    // A shallow glacis, matching `CT_LIGHT`'s 24-degree front plate. The model and the armour model
    // agree because a tank that looks sloped and is not is a lie the player pays for.
    glacisHeightFraction: 0.3,
    glacisTaperFraction: 0.24,
    fenderWidthFraction: 0.11,
    fenderLengthFraction: 0.78,
    turretLengthFraction: 0.42,
    turretWidthFraction: 0.58,
    turretHeightFraction: 0.72,
    // Forward-set turret, because a light puts its crew and gun where the armour is thinnest and relies on
    // not being there when it is shot at.
    turretRearwardOffsetFraction: -0.04,
    barrelLengthFraction: 0.59,
    barrelRadiusM: 0.07,
    // Big wheels, few of them. Five large wheels read as light in a way that six small ones never do.
    roadWheelCount: 5,
    roadWheelRadiusFraction: 0.42,
    sprocketRadiusFraction: 0.4,
    trackSegmentCount: 7,
  },
};

/**
 * Resolves a spec's proportions into the absolute dimensions the builders actually use.
 *
 * ## `heightM` is the whole vehicle, and this is where that is honoured
 *
 * `spec.heightM` is the vehicle's **total** height, ground to hull roof — the `VehicleDefinition` says so
 * explicitly ("height of the hull itself, excluding the turret"), and the contract checks the loaded mesh
 * against it. Two independent readings existed here, and they disagreed:
 *
 *  - `trackHeightM` was set to `spec.heightM`, treating it as the height of the *track unit alone*, and then
 *    the hull was stacked on top (`roofHeightM = trackHeightM + hullHeightM`). That produced a vehicle
 *    1.84 m tall against a 1.15 m definition — 60% over, on every vehicle in the roster.
 *  - `hullHeightFraction` already existed and is only meaningful if the hull is a *share* of the total. At
 *    0.6 the hull is three fifths and the running gear the remaining two fifths, which is what gives the
 *    stepped hull-over-tracks silhouette the whole design is built around.
 *
 * So the track unit takes the remainder. `roofHeightM` now lands exactly on `spec.heightM` by construction,
 * for any spec, rather than by coincidence.
 */
function deriveDimensions(spec) {
  const hullHeightM = spec.heightM * spec.hullHeightFraction;
  // The track unit fills the height the hull does not. Also the ground clearance the tracks imply, which is
  // what the running gear is placed against.
  const trackHeightM = spec.heightM - hullHeightM;
  const trackWidthM = spec.widthM * spec.trackWidthFraction;
  const wheelRadiusM = trackHeightM * spec.roadWheelRadiusFraction;

  return {
    // Every authored proportion is carried through, not just the ones derived below.
    //
    // `buildHull` reads `d.hullWidthFraction`, `d.glacisHeightFraction`, `d.glacisTaperFraction`,
    // `d.fenderWidthFraction` and `d.fenderLengthFraction`. Listing the derived values individually left all
    // five `undefined`, so `widthM * undefined` was NaN and those boxes were emitted with NaN vertices â€” 252 of
    // the hull's 492. The GLB still loaded, and Babylon still produced a *finite* bounding box from the
    // surviving vertices, so the result was a hull that measured 4.96 m instead of its authored 6.7 m. The
    // runtime normaliser then "corrected" it by 1.35x, which stretched the tracks and turret along with it and
    // left a tank 9.6 m long driving around a map built for 6.7 m vehicles.
    //
    // Nothing type-checked, linted, or unit-tested its way to a failure: `undefined * number` is a perfectly
    // legal JavaScript expression. Spreading the spec makes the class of bug impossible â€” a proportion the
    // model builder uses cannot be forgotten, because it is the same object.
    ...spec,
    lengthM: spec.lengthM,
    widthM: spec.widthM,
    trackHeightM,
    hullHeightM,
    roofHeightM: trackHeightM + hullHeightM,
    trackWidthM,
    /** Lateral offset of each track unit's centreline from the vehicle centreline. */
    trackCentreXM: (spec.widthM - trackWidthM) * 0.5 - wheelRadiusM * 0.12,
    trackSpanM: spec.lengthM * 0.9,
    turretLengthM: spec.lengthM * spec.turretLengthFraction,
    turretWidthM: spec.widthM * spec.turretWidthFraction,
    turretHeightM: spec.heightM * spec.turretHeightFraction * 2.2,
    turretCentreZM: -spec.lengthM * spec.turretRearwardOffsetFraction,
    barrelLengthM: spec.lengthM * spec.barrelLengthFraction,
    barrelRadiusM: spec.barrelRadiusM,
    wheelRadiusM,
    spec,
  };
}

/**
 * Assembles a complete tank and returns its parts, keyed by the names the loader expects.
 *
 * The origin is at the **centre of the track contact line**, on the vehicle's own centreline: local +Z is
 * the nose, +X is right, +Y is up. That is the asset contract's coordinate half, and it is the same
 * convention the simulation uses, so the loader needs no axis conversion at all.
 *
 * @returns {{spec: object, dimensions: object, parts: object}} in authored space
 */
export function buildTankModel(variant) {
  const spec = TANK_SPECS[variant];
  if (spec === undefined) {
    throw new Error(`buildTankModel: unknown variant '${variant}'`);
  }
  const d = deriveDimensions(spec);

  const hullMesh = buildHull(d);
  const turretMesh = buildTurret(d);
  const gunMesh = buildGun(d);

  // --- Running gear ----------------------------------------------------------------------
  const wheel = roadWheel(d.wheelRadiusM, d.trackWidthM * 0.8);
  const sprocket = new MeshBuilder();
  sprocket.scoped(Matrix.rotationZ(Math.PI / 2), (b) => {
    b.cylinder(
      d.wheelRadiusM * spec.sprocketRadiusFraction,
      d.wheelRadiusM * spec.sprocketRadiusFraction,
      d.trackWidthM * 0.55,
      14,
      { color: TINT.metal, uvScale: 1 },
    );
  });

  const parts = {
    hull: { mesh: hullMesh, position: [0, 0, 0] },
    turret: {
      mesh: turretMesh,
      // The turret ring centre: the pivot the simulation's traverse actually rotates about.
      position: [0, d.roofHeightM, d.turretCentreZM],
    },
    gun: {
      mesh: gunMesh,
      // The trunnion: the pivot the simulation's elevation pitches about, sitting forward in the mantlet.
      position: [0, d.turretHeightM * 0.3, d.turretLengthM * 0.5],
      parent: 'turret',
    },
    muzzle: {
      // An empty marker at the muzzle exit. Effects and the gun report both need this point, and reading
      // it from the model rather than re-deriving it in gameplay code is the point of having a contract.
      position: [0, 0, d.barrelLengthM],
      parent: 'gun',
      empty: true,
    },
    wheels: [],
    tracks: [],
  };

  // Wheels: road wheels plus a sprocket and an idler per side, arranged along the track run.
  const wheelSpan = d.trackSpanM - d.wheelRadiusM * 2;
  for (const side of [-1, 1]) {
    const sideName = side < 0 ? 'L' : 'R';
    for (let i = 0; i < spec.roadWheelCount; i += 1) {
      const t = spec.roadWheelCount === 1 ? 0.5 : i / (spec.roadWheelCount - 1);
      parts.wheels.push({
        name: `Wheel${sideName}${i}`,
        mesh: wheel,
        position: [side * d.trackCentreXM, d.wheelRadiusM, -wheelSpan * 0.5 + wheelSpan * t],
        spinAxis: 'x',
      });
    }
    // Sprocket at the front, idler at the rear. Larger than the road wheels, which is what gives each track
    // a definite front and back â€” the reason a tank's orientation is readable from its running gear alone.
    parts.wheels.push({
      name: `Sprocket${sideName}`,
      mesh: sprocket,
      position: [side * d.trackCentreXM, d.wheelRadiusM * spec.sprocketRadiusFraction, d.trackSpanM * 0.5],
      spinAxis: 'x',
    });
    parts.wheels.push({
      name: `Idler${sideName}`,
      mesh: sprocket,
      position: [side * d.trackCentreXM, d.wheelRadiusM * spec.sprocketRadiusFraction, -d.trackSpanM * 0.5],
      spinAxis: 'x',
    });
  }

  // Track segments. Separate nodes, because the runtime offsets each one vertically to follow the ground:
  // the V6 grounding behaviour the brief requires be preserved.
  const segmentSpan = d.trackSpanM / spec.trackSegmentCount;
  for (const side of [-1, 1]) {
    const sideName = side < 0 ? 'L' : 'R';
    for (let i = 0; i < spec.trackSegmentCount; i += 1) {
      parts.tracks.push({
        name: `Track${sideName}${i}`,
        mesh: trackSegment(segmentSpan, d.trackWidthM, d.trackHeightM * 0.92),
        position: [
          side * d.trackCentreXM,
          d.trackHeightM * 0.46,
          -d.trackSpanM * 0.5 + segmentSpan * (i + 0.5),
        ],
        side,
        span: segmentSpan,
      });
    }
  }

  return { spec, dimensions: d, parts };
}
