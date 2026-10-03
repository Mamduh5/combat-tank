import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * Placeholder tank proportions and materials, kept apart from the geometry that consumes them.
 *
 * Every proportion is a *fraction of the vehicle definition's dimensions* rather than an absolute
 * measurement. That is deliberate: it means the same proportions hold for a small light tank and a
 * large heavy one, so adding a vehicle in V8 does not require a new model. Only a couple of details are
 * absolute, because they are silhouette cues with no gameplay meaning.
 *
 * These are tuning surfaces. Adjusting a proportion here changes the model for every vehicle, which
 * is the desired behaviour while every vehicle is a placeholder.
 *
 * Several values were revised during the V3R playability pass. The earlier model was a plain box on two
 * darker boxes: recognisable as *something*, but not unmistakably a tank, and with no visible road
 * wheels, fenders, or sloped front to give it a direction at a glance.
 */
export const TANK_PROPORTIONS = {
  /** Fraction of hull length taken by the track units. */
  trackLengthFraction: 0.94,
  /** Track height as a fraction of hull height. */
  trackHeightFraction: 0.92,
  /** Fraction of hull width taken by each track. */
  trackWidthFraction: 0.28,
  /** Turret length as a fraction of hull length. */
  turretLengthFraction: 0.5,
  /** Turret width as a fraction of hull width. */
  turretWidthFraction: 0.66,
  /** Turret height above the hull roof, as a fraction of hull height. */
  turretHeightFraction: 0.62,
  /** Barrel height above the hull roof, as a fraction of hull height. */
  barrelHeightFraction: 0.38,
  /** Barrel length as a fraction of hull length. */
  barrelLengthFraction: 0.72,
  /**
   * Barrel radius, metres. A silhouette detail with no gameplay meaning in V1.
   *
   * Raised from 0.09 m during the V3R pass. A 4.2 m gun rendered 18 cm thick was effectively a line
   * one pixel wide at combat range, so the vehicle had no *visible* weapon despite having a barrel
   * node — the single most important silhouette cue on a tank was the one thing missing.
   */
  barrelRadiusM: 0.17,

  /**
   * Muzzle thickness relative to the barrel's radius.
   *
   * A visible swell at the tip. It reads as a gun rather than a pipe and gives the eye something to
   * track when the player watches where their gun is pointing.
   */
  muzzleRadiusFraction: 1.45,

  /**
   * Taper of the hull's front plate, as a fraction of hull length.
   *
   * The single most useful silhouette change: a sloped glacis reads as "this is the front" from any
   * angle, where a square box front read as a slab with no orientation.
   */
  glacisTaperFraction: 0.16,

  /**
   * How far the turret sits back from the hull centre, as a fraction of hull length.
   *
   * The turret has to leave room for the gun to extend forward of the hull nose. Sitting it at the
   * centre — as it originally did — buried the barrel inside the turret block, so the vehicle had no
   * visible gun at all and did not read as a tank.
   */
  turretRearwardOffsetFraction: 0.12,

  /**
   * Fraction of hull width the hull body occupies between the tracks.
   *
   * Was 0.82, which made the hull wider than the gap between the track units, so the tracks were
   * hidden behind it and the vehicle read as a single slab. Narrowing the body leaves the tracks
   * visible on both flanks, which is most of what makes it read as tracked.
   */
  hullWidthFraction: 0.6,

  /**
   * Number of road wheels shown along each track.
   *
   * Purely visual, but wheels are what make a box on two boxes read as a *tracked* vehicle rather
   * than a vehicle with two dark skirts.
   */
  roadWheelCount: 5,
  /** Road wheel radius as a fraction of track height. */
  roadWheelRadiusFraction: 0.26,

  /**
   * Fender overhang, as a fraction of hull width.
   *
   * A thin shelf along the top of each track. It breaks the long unbroken side profile and gives the
   * hull a distinct top edge, which is most of what makes a silhouette legible at range.
   */
  fenderOverhangFraction: 0.1,
  /** Fender thickness as a fraction of hull height. */
  fenderThicknessFraction: 0.045,
} as const;

/**
 * Placeholder colours. Replaced by real materials in V12.
 *
 * The values are lighter and less saturated than V1's, because the previous near-black hull against
 * dark tracks had almost no internal contrast: the vehicle read as one silhouette with no readable
 * structure. Separating hull, turret, track, and wheel tones makes the parts distinguishable.
 */
export const TANK_COLORS = {
  hull: new Color3(0.42, 0.45, 0.34),
  track: new Color3(0.24, 0.24, 0.25),
  turret: new Color3(0.48, 0.51, 0.38),
  barrel: new Color3(0.3, 0.31, 0.27),
  /** Road wheels, slightly lighter than the track frame so the wheels read individually. */
  wheel: new Color3(0.34, 0.34, 0.33),
  /** Fenders, matching the hull so the top edge reads as one continuous shape. */
  fender: new Color3(0.39, 0.42, 0.32),
} as const;

/**
 * Accent colour for the stationary target.
 *
 * The V3 target was the same olive as the player's tank, so at 100 m the player could not tell which
 * vehicle was theirs. A warm, desaturated red-brown appears nowhere in the terrain palette, which
 * makes the two vehicles distinguishable at a glance without any UI marker.
 */
export const TARGET_ACCENT = new Color3(0.52, 0.3, 0.22);

/**
 * A colour set that a tank model can be painted from.
 *
 * Named by *part* rather than by colour, so the opponent can use a different palette without the
 * builder knowing anything about values, and so a future vehicle can supply its own without touching
 * this file.
 */
export interface TankPalette {
  readonly hull: Color3;
  readonly track: Color3;
  readonly turret: Color3;
  readonly barrel: Color3;
  readonly wheel: Color3;
  readonly fender: Color3;
}

/**
 * The opponent's palette: a weathered, lighter-value scheme.
 *
 * Chosen to differ from the player's olive in **value** as well as hue, not merely in hue. A
 * lighter grey-tan opponent against a darker green player keeps both readable against the terrain's
 * mid-greens and against each other, and survives the fog the arena uses for depth.
 */
export const OPPONENT_COLORS: TankPalette = {
  hull: new Color3(0.46, 0.42, 0.36),
  track: new Color3(0.24, 0.22, 0.2),
  turret: new Color3(0.5, 0.46, 0.39),
  barrel: new Color3(0.3, 0.28, 0.24),
  wheel: new Color3(0.33, 0.3, 0.27),
  fender: new Color3(0.44, 0.4, 0.34),
};

/**
 * Detail parts that make a primitive tank read as a machine.
 *
 * Every value here is a **visual** choice with no gameplay meaning, grouped so they can be tuned as a
 * set while iterating on how the vehicle reads at range.
 */
export const TANK_DETAIL = {
  /**
   * Number of raised track links along the outer face of each track unit.
   *
   * The most effective single addition to the running gear. V3R had visible road wheels, but the track
   * itself was a smooth dark slab, which at range reads as a skirt rather than as a track. A repeated
   * link pattern along the outer face is what makes the eye read "tracked".
   *
   * 14 per side establishes the rhythm without the count becoming visible as banding.
   */
  trackLinkCount: 14,

  /**
   * Number of independently-positioned segments along each track.
   *
   * The V6 grounding pass added these so the track can follow the terrain instead of hovering over it. The
   * count is the trade between fidelity and cost, and the two ends of that trade are both visible:
   *
   *  - **Too few** and the track is still effectively a rigid board. The residual over Marlow Crossing's
   *    rolling ground is a few centimetres between neighbouring samples, so a segment spanning more than
   *    about 1.6 m starts visibly bridging the dips it is meant to be resting in.
   *  - **Too many** and the segments read as a caterpillar: each is a discrete box, and at a distance the
   *    steps between them are more noticeable than the gap the conforming is closing.
   *
   * Eight gives 0.79 m segments on this vehicle, which follows the surveyed surfaces closely while still
   * reading as one continuous band at combat range. Twelve is the point where extra segments stop helping
   * and start costing, and it also costs a node transform per element per frame.
   */
  trackSegmentCount: 8,
  /** Link height as a fraction of track height. Low and wide, so the pattern reads at a glancing angle. */
  trackLinkHeightFraction: 0.3,
  /** Link protrusion from the track face, metres. A silhouette cue, not a texture. */
  trackLinkDepthM: 0.06,

  /**
   * Return rollers above the road wheels along each track.
   *
   * The second feature that reads as running gear rather than as a row of wheels.
   */
  returnRollerCount: 3,
  /** Return roller radius as a fraction of track height. */
  returnRollerRadiusFraction: 0.17,

  /**
   * Drive sprocket and idler radius as a fraction of track height.
   *
   * Larger than the road wheels and set at the two ends of the track, which gives each track unit a
   * definite front and back — the reason a tank's orientation is readable from its running gear alone.
   */
  sprocketRadiusFraction: 0.38,

  /** Fender thickness as a fraction of hull height. */
  fenderThicknessFraction: 0.05,
  /** Fender overhang beyond the track's outer face, as a fraction of hull width. */
  fenderOverhangFraction: 0.06,

  /** Mantlet radius as a multiple of the barrel radius. The collar where barrel meets turret. */
  mantletRadiusScale: 2.6,
  /** Mantlet length as a fraction of the barrel length. */
  mantletLengthFraction: 0.12,

  /** Muzzle brake radius as a multiple of the barrel radius. The swollen tip that ends the gun. */
  muzzleBrakeRadiusScale: 1.5,
  /** Muzzle brake length as a fraction of the barrel length. */
  muzzleBrakeLengthFraction: 0.09,

  /** Turret ring collar radius as a fraction of hull width. Sits between hull and turret. */
  turretRingRadiusFraction: 0.17,
} as const;

/** Creates a matte material. Specular highlights on untextured primitives look like plastic. */
export function makeMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  return material;
}
