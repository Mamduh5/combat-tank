import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
// `Vector3` is a type elsewhere in this file but a *value* in `measureContactOffset`, which calls
// `TransformCoordinates`. Imported as a value so both uses resolve; a type-only import type-checks
// everywhere else and then fails at exactly the one line that does real work.
import { Vector3 as Vector3Ctor } from '@babylonjs/core/Maths/math.vector.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import type { VehicleState } from '../../core/vehicle/vehicle-state.js';
import {
  TANK_PROPORTIONS,
  TANK_COLORS,
  TANK_DETAIL,
  OPPONENT_COLORS,
  makeMaterial,
  type TankPalette,
} from './tank-proportions.js';

/** Wreck tint. Cold and dark, so a destroyed tank reads as inert at a glance. */
const DESTROYED_TINT = new Color3(0.13, 0.13, 0.15);

/** Faint ember glow, so a wreck is still findable in shadow. */
const DESTROYED_GLOW = new Color3(0.1, 0.02, 0.01);

/**
 * How quickly a track segment closes on the ground beneath it, per second.
 *
 * Faster than the hull's ride height settles, deliberately. The hull is a heavy body and should look like
 * it has mass; the track is a lighter assembly and should look like it is already in contact. Making the
 * two rates equal is what produces the "settling into place" look that reads as a vehicle bouncing.
 */
const CONFORM_RATE_PER_SECOND = 22;

/**
 * Maximum vertical travel of a track segment from its authored height, metres.
 *
 * Just over the largest ground residual measured on Marlowe Crossing, so on real ground the limit never
 * binds and exists only to stop a spike beyond the surveyed surfaces from tearing a segment away from the
 * fender above it. A real suspension has finite travel for the same reason.
 */
const CONFORM_TRAVEL_M = 0.55;

/**
 * Eases a value toward its target at a fixed rate, independent of frame rate.
 *
 * `1 - exp(-rate * dt)` rather than a fixed fraction per frame, so the conforming looks the same at 30 Hz
 * and at 144 Hz. A per-frame constant would make the track snap instantly on a fast machine and crawl on a
 * slow one, which is the same class of bug as using a per-frame lerp for the simulation's own ride height.
 */
function segmentEasingFactor(ratePerSecond: number, deltaSeconds: number): number {
  return 1 - Math.exp(-ratePerSecond * Math.max(0, deltaSeconds));
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * The V4 prototype tank model: a low/mid-poly vehicle assembled procedurally.
 *
 * ## Asset provenance Ã¢â‚¬â€ created in-project, no external files
 *
 * Every mesh here is generated in code from the vehicle definition's own dimensions. Nothing is
 * imported, downloaded, or licensed. That was a deliberate choice for the first real-asset version:
 * sourcing a model would have introduced redistribution questions and a licence to track, and the
 * point of this version is to establish *that* the game looks like it contains tanks. When production
 * art replaces this, it will be loaded by `visualId` and nothing in the simulation changes Ã¢â‚¬â€ that is
 * the property ADR-0003 promised, and this file is where it gets exercised.
 *
 * ## What makes it read as a tank
 *
 * The V3R model was boxes: a tapered hull, two slabs for tracks, a block for a turret. That was a
 * legible improvement on a bare box, but at combat range it still read as geometry standing in for a
 * tank. The specific features that carry recognition, each added for a reason:
 *
 *  - **A sloped upper glacis and a vertical lower plate**, so the hull front has a *shape* rather than
 *    being a flat face. This is the single strongest silhouette cue for "this is the front".
 *  - **A tapered, faceted turret with a cast mantlet**, giving the turret a distinct top outline
 *    instead of a cube, plus a rear bustle that overhangs Ã¢â‚¬â€ which is what makes a turret look like a
 *    turret rather than a lid.
 *  - **Track links**, visible as a repeated pattern along each track's outer face, so the running gear
 *    reads as *tracked* rather than as a dark skirt. Wheels alone were not enough at range.
 *  - **Return rollers, drive sprocket and idler** at the ends of each track, which give each track unit
 *    a definite front and back.
 *  - **Fenders over the tracks**, catching light along the top edge.
 *  - **A mantlet and muzzle brake** at the barrel's root and tip.
 *
 * ## Two distinguishable variants
 *
 * The opponent uses a different **silhouette**, not just a different colour: a longer, lower hull and a
 * rounded, cast-looking turret against the player's slab-sided turret and shorter hull. Colour alone
 * was the V3R approach and it is not enough Ã¢â‚¬â€ at range, in fog, or for a colour-blind player, two tanks
 * of different colours in the same shape are genuinely hard to tell apart. A shape difference is
 * legible at any distance and in any lighting.
 *
 * ## Hierarchy
 *
 * The turret and barrel are **separate transform nodes**, mirroring the simulation's structure Ã¢â‚¬â€ hull,
 * then turret, then barrel Ã¢â‚¬â€ so rotating the hull carries the turret automatically and the two can
 * never disagree about which way the gun is pointing.
 */

/**
 * The subset of turret and gun state the renderer needs.
 *
 * A structural subset rather than the core's `TurretState`, so the client depends on the two angles
 * it draws rather than on the servo internals it has no business knowing about.
 */
export interface TurretVisualState {
  /** Turret angle relative to the hull, radians. */
  readonly localAngleRad: number;
  /** Gun elevation above the turret's horizontal plane, radians. Positive is up. */
  readonly elevationRad: number;
}

/**
 * Which of the two prototype vehicles to build.
 *
 * The distinction is a **silhouette** difference rather than a recolour, for the reason given on
 * `TankVisual`. Both are generated from the same builder; the variant selects proportions and which
 * detail parts are included, so adding a third vehicle later is a new entry here rather than new code.
 */
export type TankVariant = 'player' | 'opponent';

/**
 * Silhouette and palette differences between the two vehicles.
 *
 * Kept as data rather than branching through the builder, so the builder stays one piece of logic and
 * the "what makes these two look different" decision is readable in one place.
 *
 * The opponent is **longer and lower with a rounded turret**: a longer hull, a shallower turret, and a
 * bustle that overhangs further. Those three differences change the outline from every angle, which is
 * what makes the two tellable apart at 60 m through fog.
 */
const VARIANT_SPECS: Record<TankVariant, VariantSpec> = {
  player: {
    // Compact hull, taller slab-sided turret with a flat roof and a pronounced rear bustle.
    hullLengthScale: 1,
    turretLengthScale: 1,
    turretHeightScale: 1,
    turretTaper: 0.62,
    bustleLengthM: 0.5,
    /** Player: flat-topped, straight-sided turret. */
    turretFacets: 6,
    palette: TANK_COLORS,
  },
  opponent: {
    // Longer hull, lower turret, and a wider taper so the turret reads as rounded rather than slab.
    hullLengthScale: 1.1,
    turretLengthScale: 1.08,
    turretHeightScale: 0.82,
    turretTaper: 0.44,
    bustleLengthM: 0.85,
    /** Fewer facets reads as a cast/rounded turret; the player's 6 reads as welded and angular. */
    turretFacets: 8,
    palette: OPPONENT_COLORS,
  },
};

interface VariantSpec {
  readonly hullLengthScale: number;
  readonly turretLengthScale: number;
  readonly turretHeightScale: number;
  /** How much the turret narrows toward its top, as a fraction. Higher is more sloped. */
  readonly turretTaper: number;
  /** How far the turret's rear overhangs the hull, metres. */
  readonly bustleLengthM: number;
  readonly turretFacets: number;
  readonly palette: TankPalette;
}

export class TankVisual {
  /**
   * How far the tank's own geometry sits above the root origin, in metres.
   *
   * Measured once from the track meshes after they are built, rather than held as a constant in the
   * proportions table. The constant is what this replaces: it went stale the moment a proportion
   * changed and nothing failed, the tank simply floated. Measuring it means the visual rests on its
   * tracks whatever shape the vehicle is.
   */
  private contactOffsetM = 0;

  /**
   * The track units, as ordered segments that can be moved to the ground individually.
   *
   * One entry per side, each holding that side's segment nodes in tail-to-nose order. The nodes carry the
   * track slab, its links, the fender above it and whichever road wheels and rollers fall within their span,
   * so moving a node moves that whole piece of running gear onto the terrain beneath it.
   */
  private readonly trackSegments: {
    readonly side: -1 | 1;
    /** Longitudinal length of one segment, metres. */
    readonly span: number;
    readonly nodes: TransformNode[];
  }[] = [];

  /**
   * Smoothed vertical offset currently applied to each segment node, metres.
   *
   * Parallel to `trackSegments`, flattened. Kept between frames so the conforming can be eased rather than
   * snapped: the ground under a segment can change by tens of centimetres between two frames at speed, and
   * a track that teleports to meet it reads as a glitch rather than as a vehicle following the ground.
   */
  private readonly segmentOffsetsM: number[] = [];

  /**
   * Each segment node's authored height, captured at construction, in root-local metres.
   *
   * The conforming pass offsets from these rather than from the node's live position, so offsets cannot
   * accumulate frame over frame into a drift. Paired index-for-index with `segmentOffsetsM`.
   */
  private baseSegmentY: number[] = [];

  /**
   * Terrain height sampler, or null when this visual has no ground to conform to.
   *
   * Injected rather than imported: the model is built from a `VehicleDefinition` and knows nothing about
   * the battlefield, which is what lets the same builder serve both vehicles and any future map. A null
   * sampler leaves the vehicle in its rigid authored pose, so construction and any headless use stay total.
   */
  private groundAt: ((x: number, z: number) => number) | null = null;

  /** Lateral offset of each track unit's centreline from the vehicle centreline, metres. */
  private trackCentreXM = 0;

  /**
   * Half the track slab's height, metres: the distance from a segment node's centre down to the contact line.
   *
   * Recorded at construction because the conforming pass measures its residual against the track's *lower
   * edge* while the nodes it moves are positioned at the slab's centre.
   */
  private trackHalfHeightM = 0;

  /** Root node. Position and rotation are set from simulation state each frame. */
  readonly root: TransformNode;

  private readonly turretNode: TransformNode;
  private readonly barrelNode: TransformNode;
  private readonly barrel: Mesh;
  /**
   * Body colour override, when this vehicle was built with one.
   *
   * Retained so the destruction tint can be undone correctly: without it, an accented vehicle would
   * revert to the standard olive when undestroyed, silently changing its identity.
   */
  private readonly accent: Color3 | undefined;
  /** Cached so the destruction tint is only recomputed when it actually changes. */
  private destroyed = false;

  /**
   * @param variant Which vehicle this is. The opponent is built with a different silhouette, not just a
   *   different colour, because two tanks of different colours in the same shape are genuinely hard to
   *   tell apart at range or for a colour-blind player. A shape difference is legible always.
   * @param accent Optional body colour override, layered on top of the variant's own palette.
   */
  constructor(
    scene: Scene,
    definition: VehicleDefinition,
    variant: TankVariant = 'player',
    accent?: Color3,
    /**
     * Terrain height sampler used to conform the running gear to the ground.
     *
     * Optional so the model can still be built without a battlefield â€” for a unit test, or a preview. When
     * absent the vehicle keeps its rigid authored pose, which is the old behaviour and is correct for a
     * vehicle being inspected in isolation.
     */
    groundAt?: (x: number, z: number) => number,
  ) {
    const spec = VARIANT_SPECS[variant];
    const palette = spec.palette;
    this.groundAt = groundAt ?? null;
    const { widthM, heightM } = definition.dimensions;
    const lengthM = definition.dimensions.lengthM * spec.hullLengthScale;

    const trackHeightM = TANK_PROPORTIONS.trackHeightFraction * heightM;
    const hullHeightM = heightM * 0.62;
    const roofHeightM = trackHeightM + hullHeightM;
    const bodyColor = accent ?? palette.hull;
    const turretColor = accent ? accent.scale(1.12) : palette.turret;

    this.root = new TransformNode('tank-root', scene);
    this.accent = accent;

    // --- Hull: sloped glacis with a vertical lower plate --------------------------------
    // Two pieces rather than one tapered wedge. A single taper slopes the *whole* front, which reads as
    // a boat bow; a real tank has a vertical or near-vertical lower plate with a sloped upper glacis
    // above it, and that two-part profile is a much stronger "this is a tank" cue than the taper alone.
    const hullBodyWidthM = widthM * TANK_PROPORTIONS.hullWidthFraction;

    // Upper glacis: the sloping plate, running from the roof down and forward.
    const glacis = buildGlacisHull(scene, 'tank-glacis', {
      widthM: hullBodyWidthM,
      heightM: hullHeightM * GLACIS_HEIGHT_FRACTION,
      lengthM: lengthM * 0.92,
      taperFraction: TANK_PROPORTIONS.glacisTaperFraction,
    });
    glacis.position.y = roofHeightM - (hullHeightM * GLACIS_HEIGHT_FRACTION) / 2;
    glacis.material = makeMaterial(scene, 'tank-glacis-mat', bodyColor);
    glacis.parent = this.root;

    // Lower plate: vertical, narrower, tucked under the glacis. Present mostly at the nose, which is
    // what makes the profile read as two distinct surfaces catching light differently.
    const lowerPlate = MeshBuilder.CreateBox(
      'tank-lower-plate',
      {
        width: hullBodyWidthM * LOWER_PLATE_WIDTH_FRACTION,
        height: hullHeightM * (1 - GLACIS_HEIGHT_FRACTION),
        depth: lengthM * LOWER_PLATE_DEPTH_FRACTION,
      },
      scene,
    );
    lowerPlate.position.set(
      0,
      roofHeightM - hullHeightM + (hullHeightM * (1 - GLACIS_HEIGHT_FRACTION)) / 2,
      lengthM * (0.92 / 2) - (lengthM * LOWER_PLATE_DEPTH_FRACTION) / 2,
    );
    lowerPlate.material = makeMaterial(scene, 'tank-lower-plate-mat', bodyColor.scale(0.86));
    lowerPlate.parent = this.root;

    // --- Running gear -------------------------------------------------------------------
    const wheelRadiusM = TANK_PROPORTIONS.roadWheelRadiusFraction * trackHeightM;
    const trackSpan = lengthM * TANK_PROPORTIONS.trackLengthFraction;
    const trackWidthM = widthM * TANK_PROPORTIONS.trackWidthFraction;
    const trackCentreX = widthM * (0.5 - trackWidthM / widthM / 2);
    // Recorded on the instance because the conforming pass runs long after construction and needs to know
    // where each track unit sits laterally, and how deep its slab is.
    this.trackCentreXM = trackCentreX;
    this.trackHalfHeightM = trackHeightM / 2;

    for (const side of [-1, 1] as const) {
      // The track is built as **segments** rather than one rigid box, and each is parented to its own node
      // so it can be moved to the ground beneath it every frame.
      //
      // This is the part that makes the vehicle sit on the terrain rather than over it. A single rigid box
      // can only ever touch a curved surface along one line, so on anything but flat ground it either
      // bridges a dip or buries itself in a rise; measured, that was up to 1.39 m of daylight under the
      // tail on the Cairn approach. Segments let the track follow the ground along its whole run, which is
      // the difference between "a rigid board hovering over the landscape" and "a vehicle resting on it".
      //
      // Each segment is a `TransformNode` carrying a slab of track, so the visual track is still only a
      // handful of draw calls rather than one per link.
      const segmentCount = TANK_DETAIL.trackSegmentCount;
      const segmentSpan = trackSpan / segmentCount;
      this.trackSegments.push({ side, span: segmentSpan, nodes: [] });

      for (let i = 0; i < segmentCount; i += 1) {
        const segmentZ = -trackSpan / 2 + segmentSpan * (i + 0.5);
        const node = new TransformNode(`tank-track-node-${side}-${i}`, scene);
        node.position.set(side * trackCentreX, trackHeightM / 2, segmentZ);
        node.parent = this.root;

        const slab = MeshBuilder.CreateBox(
          `tank-track-${side}-${i}`,
          // A touch of overlap between neighbours, so a conforming segment that moves down over a dip
          // cannot open a visible seam along the top of the track. Overlapping is invisible; a gap is not.
          { width: trackWidthM, height: trackHeightM, depth: segmentSpan * 1.04 },
          scene,
        );
        slab.position.set(0, 0, 0);
        slab.material = makeMaterial(scene, `tank-track-mat-${side}-${i}`, palette.track);
        slab.parent = node;

        this.trackSegments[this.trackSegments.length - 1]!.nodes.push(node);
      }

      // Which track segment a part at longitudinal position `z` belongs to, so it rides with the track
      // rather than being left behind on the hull. A part keeps the *local* offset it had within the
      // rigid model, so nothing shifts along the track â€” only up and down, with its segment.
      const segments = this.trackSegments[this.trackSegments.length - 1]!;
      const localZIn = (z: number) => z + trackSpan / 2;
      const nodeFor = (z: number) => {
        const index = Math.min(
          segmentCount - 1,
          Math.max(0, Math.floor(localZIn(z) / segmentSpan)),
        );
        const node = segments.nodes[index]!;
        // Where the part sits relative to its segment node, so re-parenting does not move it.
        return { node, offsetZ: z - (node.position.z as number) };
      };

      // Drive sprocket (rear) and idler (front), larger than the road wheels.
      //
      // These are what give the vehicle a readable *orientation* from its running gear alone: without
      // them both ends of the track look identical and the tank has no visible front.
      const sprocketRadiusM = TANK_DETAIL.sprocketRadiusFraction * trackHeightM;
      for (const [name, z] of [
        ['sprocket', -trackSpan / 2 + sprocketRadiusM * 0.4],
        ['idler', trackSpan / 2 - sprocketRadiusM * 0.4],
      ] as const) {
        const end = MeshBuilder.CreateCylinder(
          `tank-${name}-${side}`,
          { height: trackWidthM * 0.92, diameter: sprocketRadiusM * 2, tessellation: 12 },
          scene,
        );
        end.rotation.z = Math.PI / 2;
        const host = nodeFor(z);
        end.position.set(0, trackHeightM * 0.05, host.offsetZ);
        end.material = makeMaterial(scene, `tank-${name}-mat-${side}`, palette.wheel);
        end.parent = host.node;
      }

      // Road wheels, proud of the track face so they catch light and read individually.
      //
      // Each wheel rides its own track segment, which is the visual suspension: over a crest the middle
      // wheels drop with the dip under them while the end wheels stay up on the rise, so the vehicle
      // articulates instead of presenting one rigid line to the ground.
      const wheelCount = TANK_PROPORTIONS.roadWheelCount;
      for (let i = 0; i < wheelCount; i += 1) {
        const wheel = MeshBuilder.CreateCylinder(
          `tank-wheel-${side}-${i}`,
          { height: 0.12, diameter: wheelRadiusM * 2, tessellation: 10 },
          scene,
        );
        // Cylinders are built along Y; lay them along X to face outward from the hull's side.
        wheel.rotation.z = Math.PI / 2;
        const offset = wheelCount <= 1 ? 0 : -trackSpan / 2 + (trackSpan / (wheelCount - 1)) * i;
        const host = nodeFor(offset);
        // `trackHeightM * 0.5` is the segment node's own height, so this preserves the original wheel
        // height above the track slab.
        wheel.position.set(
          side * (trackWidthM * 0.5 + 0.03),
          wheelRadiusM + 0.06 - trackHeightM * 0.5,
          host.offsetZ,
        );
        wheel.material = makeMaterial(scene, `tank-wheel-mat-${side}-${i}`, palette.wheel);
        wheel.parent = host.node;
      }

      // Return rollers, high on the track face. Their absence is why a run of road wheels alone still
      // reads as a wheeled vehicle with a skirt rather than as a tank.
      const rollerRadiusM = TANK_DETAIL.returnRollerRadiusFraction * trackHeightM;
      for (let i = 0; i < TANK_DETAIL.returnRollerCount; i += 1) {
        const f = (i + 1) / (TANK_DETAIL.returnRollerCount + 1);
        const roller = MeshBuilder.CreateCylinder(
          `tank-roller-${side}-${i}`,
          { height: 0.1, diameter: rollerRadiusM * 2, tessellation: 8 },
          scene,
        );
        roller.rotation.z = Math.PI / 2;
        const z = -trackSpan / 2 + trackSpan * f;
        const host = nodeFor(z);
        roller.position.set(
          side * (trackWidthM * 0.5 + 0.02),
          trackHeightM - rollerRadiusM - trackHeightM * 0.5,
          host.offsetZ,
        );
        roller.material = makeMaterial(scene, `tank-roller-mat-${side}-${i}`, palette.wheel.scale(0.9));
        roller.parent = host.node;
      }

      // Track links along the outer face.
      //
      // The single most effective addition to the running gear. Without them the track is a smooth dark
      // slab, and at range the eye reads a *skirt*; a repeated link pattern is what reads as a track.
      // One mesh with all the links baked into it rather than one mesh per link, so a full vehicle adds
      // two draw calls rather than thirty.
      //
      // The links are parented to the **segments** rather than to the hull, so they follow the track down
      // into a dip. Links left on the hull would be the one part of the running gear still hovering over
      // the ground the track is resting on, which is exactly the artefact this pass exists to remove.
      const linkCount = TANK_DETAIL.trackLinkCount;
      const linkHeightM = trackHeightM * TANK_DETAIL.trackLinkHeightFraction;
      const linkSpacing = trackSpan / linkCount;
      for (let i = 0; i < linkCount; i += 1) {
        const z = -trackSpan / 2 + linkSpacing * (i + 0.5);
        const host = nodeFor(z);
        // Push alternating links slightly further out, giving the track a visible rhythm rather than a
        // perfectly flat banded strip.
        const out = TANK_DETAIL.trackLinkDepthM * (i % 2 === 0 ? 1 : 0.55);
        const link = MeshBuilder.CreateBox(
          `tank-link-${side}-${i}`,
          {
            width: TANK_DETAIL.trackLinkDepthM,
            height: linkHeightM,
            depth: linkSpacing * 0.72,
          },
          scene,
        );
        link.position.set(
          side * (trackWidthM * 0.5 + out),
          0,
          host.offsetZ,
        );
        link.material = makeMaterial(scene, `tank-link-mat-${side}-${i}`, palette.track.scale(1.5));
        link.parent = host.node;
      }

      // Fender over the top of the track: catches light along the vehicle's top edge and breaks the
      // long unbroken flank.
      //
      // One fender per segment, so the shelf over the tracks follows them. A single rigid fender spanning
      // the whole run would float clear of a dipping middle and intersect a rising end.
      for (let i = 0; i < segmentCount; i += 1) {
        const node = segments.nodes[i]!;
        const fender = MeshBuilder.CreateBox(
          `tank-fender-${side}-${i}`,
          {
            width: trackWidthM + widthM * TANK_DETAIL.fenderOverhangFraction * 2,
            height: trackHeightM * TANK_DETAIL.fenderThicknessFraction,
            depth: segmentSpan * 1.04,
          },
          scene,
        );
        fender.position.set(0, trackHeightM * 0.5 + 0.02, 0);
        fender.material = makeMaterial(scene, `tank-fender-mat-${side}-${i}`, palette.fender);
        fender.parent = node;
      }
    }

    // --- Turret -------------------------------------------------------------------------
    // Ring collar between hull and turret: reads as the turret sitting *on* the hull rather than
    // intersecting it.
    const ringRadiusM = widthM * TANK_DETAIL.turretRingRadiusFraction;
    const ring = MeshBuilder.CreateCylinder(
      'tank-turret-ring',
      { height: hullHeightM * 0.16, diameter: ringRadiusM * 2, tessellation: 16 },
      scene,
    );
    ring.position.y = roofHeightM - hullHeightM * 0.06;
    ring.material = makeMaterial(scene, 'tank-ring-mat', palette.track.scale(1.2));
    ring.parent = this.root;

    this.turretNode = new TransformNode('tank-turret-node', scene);
    this.turretNode.position.y = roofHeightM;
    this.turretNode.parent = this.root;

    const turretHeightM = TANK_PROPORTIONS.turretHeightFraction * heightM * spec.turretHeightScale;
    const turretLengthM = definition.dimensions.lengthM * TANK_PROPORTIONS.turretLengthFraction * spec.turretLengthScale;
    const turretWidthM = widthM * TANK_PROPORTIONS.turretWidthFraction;
    // Sit the turret back from the hull centre so the gun has room to extend past the nose.
    const turretOffsetZ = -definition.dimensions.lengthM * TANK_PROPORTIONS.turretRearwardOffsetFraction;

    // Faceted, tapered turret rather than a box: `tessellation` gives the polygon count and the taper
    // narrows it toward the roof, so it reads as a cast turret with a distinct top outline. The variant
    // changes both, which is what makes the two vehicles' silhouettes differ.
    const turret = MeshBuilder.CreateCylinder(
      'tank-turret',
      {
        height: turretHeightM,
        diameterTop: turretWidthM * spec.turretTaper,
        diameterBottom: turretWidthM,
        tessellation: spec.turretFacets,
      },
      scene,
    );
    turret.scaling.z = turretLengthM / turretWidthM;
    turret.position.set(0, turretHeightM / 2, turretOffsetZ);
    turret.rotation.y = Math.PI / spec.turretFacets;
    turret.material = makeMaterial(scene, 'tank-turret-mat', turretColor);
    turret.parent = this.turretNode;

    // Rear bustle: a box overhanging the back of the turret. This overhang is a strong recognition cue
    // and, more practically, it makes the turret's *facing* obvious from behind \u2014 the player can see
    // which way their own gun points without checking the HUD.
    const bustle = MeshBuilder.CreateBox(
      'tank-bustle',
      {
        width: turretWidthM * 0.82,
        height: turretHeightM * 0.62,
        depth: spec.bustleLengthM,
      },
      scene,
    );
    bustle.position.set(
      0,
      turretHeightM * 0.42,
      turretOffsetZ - turretLengthM * 0.5 - spec.bustleLengthM * 0.5,
    );
    bustle.material = makeMaterial(scene, 'tank-bustle-mat', turretColor.scale(0.92));
    bustle.parent = this.turretNode;

    // --- Gun ---------------------------------------------------------------------------
    // The barrel gets its own pivot node, so elevation is a rotation about the trunnion rather than a
    // repositioning of the mesh. The pivot sits partway up the turret face, where a real gun trunnion
    // is, so the barrel emerges from the turret rather than from its roof.
    this.barrelNode = new TransformNode('tank-barrel-node', scene);
    this.barrelNode.position.set(0, turretHeightM * 0.55, turretOffsetZ);
    this.barrelNode.parent = this.turretNode;

    const barrelLengthM = definition.mainGun.barrelLengthM;
    const barrelRadiusM = TANK_PROPORTIONS.barrelRadiusM;

    this.barrel = MeshBuilder.CreateCylinder(
      'tank-barrel',
      { height: barrelLengthM, diameter: barrelRadiusM * 2, tessellation: 12 },
      scene,
    );
    // Cylinders are built along Y in Babylon; lay it along +Z so it points forward, and offset by half
    // its length so the pivot is at the trunnion rather than at the barrel's midpoint.
    this.barrel.rotation.x = Math.PI / 2;
    this.barrel.position.z = barrelLengthM / 2;
    this.barrel.material = makeMaterial(scene, 'tank-barrel-mat', palette.barrel);
    this.barrel.parent = this.barrelNode;

    // Mantlet: the collar where the barrel meets the turret. Without it the barrel appears to sprout
    // from a flat face, which is the detail that most makes a model read as assembled rather than
    // designed.
    const mantlet = MeshBuilder.CreateCylinder(
      'tank-mantlet',
      {
        height: barrelLengthM * TANK_DETAIL.mantletLengthFraction,
        diameter: barrelRadiusM * 2 * TANK_DETAIL.mantletRadiusScale,
        tessellation: 12,
      },
      scene,
    );
    mantlet.rotation.x = Math.PI / 2;
    mantlet.position.z = barrelLengthM * TANK_DETAIL.mantletLengthFraction * 0.5;
    mantlet.material = makeMaterial(scene, 'tank-mantlet-mat', palette.turret.scale(0.95));
    mantlet.parent = this.barrelNode;

    // Muzzle brake: the swollen tip that ends the gun. Purely visual, but it stops a 4.2 m barrel
    // reading as an even-ended pole and gives the eye something to track when watching where the gun
    // points.
    const brakeLengthM = barrelLengthM * TANK_DETAIL.muzzleBrakeLengthFraction;
    const muzzle = MeshBuilder.CreateCylinder(
      'tank-muzzle',
      {
        height: brakeLengthM,
        diameter: barrelRadiusM * 2 * TANK_DETAIL.muzzleBrakeRadiusScale,
        tessellation: 12,
      },
      scene,
    );
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.z = barrelLengthM - brakeLengthM / 2;
    muzzle.material = makeMaterial(scene, 'tank-muzzle-mat', palette.barrel);
    muzzle.parent = this.barrelNode;

    // Measure the ground-contact offset now that every track mesh exists, with the root still
    // at the origin so the reading is in root-local space.
    this.contactOffsetM = this.measureContactOffset();
    this.baseSegmentY = this.measureSegmentBaseY();
  }

  /**
   * Writes simulation state onto the transform.
   *
   * The *only* place simulation state reaches the scene graph, and strictly one-way: the renderer
   * reads state and never writes it (ADR-0001). Pitch and roll come from the core's already-smoothed
   * values, so slope behaviour is simulated rather than faked here.
   *
   * Hull, turret and barrel are set from three separate pieces of simulation state, which is what
   * makes the independence visible: the hull follows its own heading, the turret its own local angle,
   * and the barrel its own elevation. Nothing here derives one from another.
   */
  apply(state: VehicleState, turret: TurretVisualState, deltaSeconds = 1 / 60): void {
    // ## Where the hull sits, and why this is not `position.y`
    //
    // The simulation places the vehicle origin at `groundHeight + rideHeightM`, and `rideHeightM`
    // converges on the definition's `groundClearanceM` of 0.48 m. That is a sensible place for a vehicle
    // *origin* — it is the hull floor, and a hull floor does float above the ground. But this model's origin
    // is at the **track contact line**: the track slab is centred at `trackHeightM / 2` and its lower edge
    // therefore sits at local y = 0. So drawing the model at `position.y` puts the track bottoms 0.48 m in
    // the air, and that is the flat-ground float the last pass tried to correct with a contact offset.
    //
    // The offset it measured was zero — correctly, because the geometry really does reach local y = 0 —
    // so subtracting it changed nothing. The error was never in the model's shape; it was in reading a
    // hull-floor origin as though it were a contact-line origin.
    //
    // So the visual is placed at the ground, and the ride height is dropped. `contactOffsetM` still
    // subtracts, and is still measured rather than hard-coded, because a model authored with its origin
    // above the contact line would need it and a future one might.
    this.root.position.set(
      state.position.x,
      state.position.y - state.rideHeightM - this.contactOffsetM,
      state.position.z,
    );

    // ## Why the heading is applied **positively**
    //
    // This was `-state.headingRad`, on the reasoning that Babylon is left-handed and therefore needs
    // the sign flipped. That reasoning is wrong, and the comment recorded it as settled fact, which is
    // exactly what let it survive: every automated test compared movement against the *simulation's own*
    // forward vector, and the simulation was never wrong. Only the rendered tank was.
    //
    // The model is authored with its nose at local **+Z** (glacis front face, idler, and muzzle all sit
    // at +Z). The simulation's forward vector is `(sin h, cos h)`. Checked against Babylon's own
    // `Matrix.RotationY`, `RotationY(+h)` maps local +Z to exactly `(sin h, cos h)`, while
    // `RotationY(-h)` maps it to `(-sin h, cos h)` - the nose reflected across the X axis rather than
    // rotated.
    //
    // The consequence was not a subtle misalignment. At h = 90 degrees the visible nose pointed **exactly
    // backwards**, 180 degrees out, and the error grew linearly with heading in between. So the tank
    // appeared to move sideways instead of through its own front, and A/D appeared to swing the nose the
    // wrong way. Both of the owner's control reports, and both invisible to vector-only tests, which is
    // why this pass verifies the rendered model rather than the vector again.
    //
    // Positive heading makes the model's local axes coincide with the simulation's own basis: local +Z
    // becomes forward, and local +X becomes `(cos h, -sin h)`, the simulation's right axis.
    this.root.rotation.set(
      state.bodyPitchRad,
      hullVisualYawRad(state.headingRad),
      state.bodyRollRad,
    );

    // ## Why the track is conformed *after* the root is posed
    //
    // Order matters and is not incidental. The conforming pass measures where the hull's bottom plane sits
    // at each station, which it can only know once the root's pitch, roll and position are final. Running
    // it first would offset the segments against last frame's attitude and leave a visible lag between the
    // hull's tilt and the track's contact â€” the vehicle would look like it were steering before it leaned.
    this.conformTracksToGround(state, deltaSeconds);

    // The turret's *local* angle, positively, for the same reason it was previously negated. Because it
    // is a child of the hull, the hull's rotation is inherited automatically, so rotating the hull
    // carries the turret with it - which is what a real turret ring does. The gun's world bearing then
    // works out as `hull heading + local angle`, matching `gunDirection` in the core exactly.
    this.turretNode.rotation.y = turret.localAngleRad;

    // Elevation is a pitch about the barrel's own pivot. The barrel node already carries the
    // cylinder's lay-flat rotation on the mesh, so only the elevation is applied here.
    this.barrelNode.rotation.x = -turret.elevationRad;
  }

  /**
   * Tints the vehicle to show it has been destroyed.
   *
   * Deliberately crude Ã¢â‚¬â€ a dark, cold body. The owner asked for the state to be *visibly
   * distinguishable* and explicitly not for destruction effects, so this is a colour swap rather than
   * smoke, fire, or a wreck model.
   *
   * Only runs on a change, because it walks every material in the vehicle.
   */
  setDestroyed(destroyed: boolean): void {
    if (this.destroyed === destroyed) {
      return;
    }
    this.destroyed = destroyed;

    for (const mesh of this.root.getChildMeshes(false)) {
      const material = mesh.material;
      if (material instanceof StandardMaterial) {
        material.diffuseColor = destroyed ? DESTROYED_TINT : this.baseTintFor(mesh.name);
        material.emissiveColor = destroyed ? DESTROYED_GLOW : DESTROYED_GLOW.scale(0);
      }
    }
  }

  /** The undamaged colour for a named part, so the tint can be undone. */
  private baseTintFor(meshName: string): Color3 {
    if (meshName.includes('turret')) {
      return this.accent ? this.accent.scale(1.12) : TANK_COLORS.turret;
    }
    if (meshName.includes('barrel')) {
      return TANK_COLORS.barrel;
    }
    // Wheels and fenders keep their own tones; only the main body swaps to the accent.
    if (meshName.includes('wheel')) {
      return TANK_COLORS.wheel;
    }
    if (meshName.includes('fender')) {
      return TANK_COLORS.fender;
    }
    return this.accent ?? TANK_COLORS.hull;
  }

  /**
   * Measures how far the built geometry sits above the root origin, by reading the track meshes.
   *
   * Called once at the end of construction, with the root still at the origin, so the bounding boxes are
   * already in root-local space and the answer needs no matrix work of our own. Deliberate: the first
   * attempt at this measurement, in the browser, hand-rolled a world-to-local transform and reported a
   * clearance of -32 metres, which would have sent me to fix a model that was perfectly fine.
   *
   * Only the tracks are considered, because they are what meets the ground. A gun barrel dipping below
   * the track line on a slope is a gun over a crest, not a vehicle in a hole.
   */
  private measureContactOffset(): number {
    let lowest = Infinity;
    for (const mesh of this.root.getChildMeshes()) {
      if (!mesh.name.startsWith('tank-track-')) {
        continue;
      }
      const bounds = mesh.getBoundingInfo().boundingBox;
      mesh.computeWorldMatrix(true);
      const world = Vector3Ctor.TransformCoordinates(bounds.minimum, mesh.getWorldMatrix());
      if (world.y < lowest) {
        lowest = world.y;
      }
    }
    return Number.isFinite(lowest) ? lowest : 0;
  }

  /**
   * The resting height of every track segment node, in root-local space, before any conforming.
   *
   * Measured rather than remembered. The conforming pass needs to know where each segment *would* sit if
   * the vehicle were perfectly rigid, so that it can be moved by the difference between that and the
   * ground. Storing the authored position means a change to a proportion in `tank-proportions.ts` cannot
   * silently invalidate the conforming, which is the same reasoning behind `measureContactOffset`.
   */
  private measureSegmentBaseY(): number[] {
    const base: number[] = [];
    for (const segments of this.trackSegments) {
      for (const node of segments.nodes) {
        base.push(node.position.y as number);
      }
    }
    return base;
  }

  /**
   * Moves each track segment to the ground beneath it.
   *
   * ## What this is for
   *
   * The hull presents the fitted support plane, which is the *average* of the ground under the vehicle.
   * That is the right attitude and the wrong shape: a plane through a rolling landscape is a chord, so it
   * floats over every dip and buries itself in every rise. Measured across Marlowe Crossing, the residual
   * was up to 0.52 m of daylight even after the attitude was corrected, and it was this residual â€” not the
   * attitude â€” that produced the owner's report of a vehicle "most of which floats" on non-flat ground.
   *
   * So each segment is offset vertically by the local difference between the ground beneath it and the
   * hull's own bottom plane. The hull stays rigid, which is correct: real tanks have a rigid hull. Only the
   * running gear conforms, which is also correct: real tracks do.
   *
   * ## Why it is smoothed, and why it is clamped
   *
   * **Smoothed** because the target changes by tens of centimetres between frames at driving speed, and a
   * track that jumps to meet the ground reads as a rendering fault rather than as contact. The easing is
   * derived from the elapsed time so the behaviour is identical at 30 Hz and at 144 Hz â€” the same rule the
   * core follows for ride height.
   *
   * **Clamped** because a real suspension has finite travel. Without a limit, a sharp crest would drag a
   * segment far enough up to detach it visually from the fender above it. The travel is a little over the
   * largest residual measured on the map, so on real ground it never binds and only a spike beyond the
   * survey would be limited.
   *
   * ## What it deliberately does not do
   *
   * It does not change `state.position`, the hull's pitch or roll, or anything the simulation reads. The
   * renderer reads simulation state and never writes it (ADR-0001); this is presentation only.
   */
  private conformTracksToGround(state: VehicleState, deltaSeconds: number): void {
    const terrain = this.groundAt;
    if (terrain === null) {
      return;
    }

    const forwardX = Math.sin(state.headingRad);
    const forwardZ = Math.cos(state.headingRad);
    const rightX = Math.cos(state.headingRad);
    const rightZ = -Math.sin(state.headingRad);

    // How fast a segment is allowed to close on the ground. Fast enough to keep up with the terrain at
    // speed, slow enough that cresting a rise reads as the track being pulled down over it.
    const ease = segmentEasingFactor(CONFORM_RATE_PER_SECOND, deltaSeconds);

    // Where the track's lower edge sits at the vehicle's centre, before any conforming. The root has
    // already been lowered by `contactOffsetM`, so this is the *nominal* contact line: the height at which
    // the track would rest if the vehicle were perfectly rigid and the ground beneath it perfectly flat.
    const rootBottomY = this.root.position.y;

    // The vehicle's world position, which the per-segment ground samples are taken around. Taken from the
    // state rather than from `this.root.position` because the conforming runs after the root is posed, and
    // this must describe the same point the simulation considers the vehicle's centre.
    const x = state.position.x;
    const z = state.position.z;

    let index = 0;
    for (const segments of this.trackSegments) {
      for (let i = 0; i < segments.nodes.length; i += 1) {
        const node = segments.nodes[i]!;
        const baseY = this.baseSegmentY[index]!;
        const localZ = node.position.z as number;
        const localX = segments.side * this.trackCentreXM;

        // Where this segment sits in the world, given the pose the root has just been given.
        const worldX = x + forwardX * localZ + rightX * localX;
        const worldZ = z + forwardZ * localZ + rightZ * localX;

        const groundY = terrain(worldX, worldZ);

        // ## Why the residual, and not the full height, is what the segment moves by
        //
        // The root has already been lowered by `contactOffsetM`, which places the *nominal* track contact
        // line on the ground at the vehicle's centre. What is left is the difference between that nominal
        // line and the ground under this particular station: the residual. An earlier version of this pass
        // offset by the whole ground-to-plane distance, which dragged every segment down by the full ride
        // height and left the tracks hanging a metre below the hull — the vehicle stopped floating and
        // started coming apart, and every gap measurement still read zero because it only ever looked at the
        // track against the ground, never the track against the hull.
        //
        // `nominalBottomY` is where this station's track bottom sits under the current root transform with
        // no conforming at all, so the residual is exactly the correction needed.
        // `baseY` is the segment node's authored height, which is half the track height: the node sits at the
        // middle of the slab, so the slab's lower edge is `baseY - trackHeight / 2` above the root. The
        // residual therefore has to be measured from the *lower edge*, not from the node's centre — comparing
        // the ground against the node centre would leave every segment sitting half a track height too high.
        const nominalBottomY =
          rootBottomY + (baseY - this.trackHalfHeightM) - Math.sin(state.bodyPitchRad) * localZ
          + Math.sin(state.bodyRollRad) * localX;

        // Positive means the ground is above the nominal track line, so the segment must rise to meet it.
        const target = clamp(groundY - nominalBottomY, -CONFORM_TRAVEL_M, CONFORM_TRAVEL_M);

        const current = this.segmentOffsetsM[index] ?? 0;
        const next = current + (target - current) * ease;
        this.segmentOffsetsM[index] = next;
        node.position.y = baseY + next;
        index += 1;
      }
    }
  }


  /** Enables shadow receiving on every part. */
  setShadowsEnabled(enabled: boolean): void {
    for (const mesh of this.root.getChildMeshes()) {
      mesh.receiveShadows = enabled;
    }
  }

  /**
   * The measured ground-contact offset, for the grounding probe.
   *
   * Read-only and deliberately narrow. This exists because the V6 grounding investigation needed to know
   * the renderer's *actual* offset rather than a restatement of it â€” a probe that recomputes the value it
   * is investigating cannot detect the value being wrong, which is precisely the failure the last pass
   * had. Everything else about the vehicle stays private.
   */
  debugContactOffsetM(): number {
    return this.contactOffsetM;
  }

  /** World position of the barrel, used by the aim readout. */
  getBarrelWorldPosition(): Vector3 {
    return this.barrel.getAbsolutePosition();
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}

/** Re-exported so callers can reach the tuning without a second import. */
export { TANK_PROPORTIONS };

/**
 * The model's nose direction as a unit vector in **model-local space**.
 *
 * Local `+Z`, because that is where the visible front of the tank is: the glacis front face, the idler
 * wheel, and the muzzle all sit at `+Z`. This constant exists so the orientation contract below is stated
 * in one place instead of being re-derived (and re-mis-derived) by each consumer.
 */
const MODEL_NOSE_LOCAL = new Vector3Ctor(0, 0, 1);

/**
 * The yaw the **renderer** applies to the hull, from the simulation's heading.
 *
 * ## This one function is the whole orientation contract
 *
 * Both `TankVisual.apply` and `modelNoseWorldDirection` read it, so the thing that is drawn and the thing
 * that is measured cannot drift apart. That matters because this is exactly how the bug happened: the
 * renderer negated the heading, the tests compared against the simulation, and nothing ever asked the
 * renderer what it was doing.
 *
 * It is the identity, and that is the point. The model is authored nose-at-`+Z` and Babylon's
 * left-handed `Matrix.RotationY(h)` maps local `+Z` to `(sin h, cos h)` â€” which is already the simulation's
 * forward vector. No sign correction is required, and the previous `-headingRad` was not a correction but
 * a reflection.
 *
 * If this ever needs a non-identity value, the model is what should move, not the locomotion: the
 * simulation's forward vector is what the vehicle actually drives along, and the brief is explicit that
 * locomotion must not be bent to match a rendering.
 */
export function hullVisualYawRad(headingRad: number): number {
  return headingRad;
}

/**
 * Where the **rendered** tank's nose points, for a hull heading.
 *
 * ## Why this function exists at all
 *
 * Because a vector-only test cannot catch that class of bug, and this one shipped through a fully green
 * suite. Every existing control test compared movement against the *simulation's* forward vector, which
 * was always correct; nothing compared that against what the player could see. At a heading of 90 degrees
 * the visible nose pointed exactly backwards, so W drove the tank out of its own tail and A/D swung the
 * nose the wrong way â€” and every numeric assertion still passed.
 *
 * Computed with Babylon's own matrix rather than by restating `sin`/`cos`, so this measures the actual
 * engine convention instead of re-asserting the algebra that produced the mistake.
 *
 * @param headingRad the simulation's hull heading
 * @returns a unit direction in world space
 */
export function modelNoseWorldDirection(headingRad: number): { x: number; y: number; z: number } {
  const nose = Vector3Ctor.TransformNormal(MODEL_NOSE_LOCAL, Matrix.RotationY(hullVisualYawRad(headingRad)));
  return { x: nose.x, y: nose.y, z: nose.z };
}

/**
 * The simulation's forward vector for a hull heading, as a unit direction.
 *
 * Restated from `tank.ts`'s integration step rather than imported from it, on purpose: the point of the
 * comparison is that these two *independent* expressions agree. A shared helper would make the test
 * tautological.
 */
export function simulationForward(headingRad: number): { x: number; y: number; z: number } {
  return { x: Math.sin(headingRad), y: 0, z: Math.cos(headingRad) };
}

/**
 * Fraction of the hull's height occupied by the sloped upper glacis.
 *
 * The remainder is the vertical lower plate. Roughly 60/40 is what produces the two-part profile that
 * reads as a tank: a near-vertical face at the nose with a distinct slope above it.
 */
const GLACIS_HEIGHT_FRACTION = 0.6;


/** Lower plate width as a fraction of the hull body's width. Narrower, so it tucks under the glacis. */
const LOWER_PLATE_WIDTH_FRACTION = 0.86;

/** Lower plate depth as a fraction of hull length. Short, so it affects only the nose profile. */
const LOWER_PLATE_DEPTH_FRACTION = 0.1;


/** Dimensions for the hull wedge. */
interface GlacisDimensions {
  readonly widthM: number;
  readonly heightM: number;
  readonly lengthM: number;
  /** How far the front face is pulled in from the full width and height, as a fraction. */
  readonly taperFraction: number;
}

/**
 * Builds the hull as a wedge with a sloped front plate and a flat roof.
 *
 * Eight vertices: four at the rear at full width and height, four at the front pulled inward by the
 * taper. The roof therefore slopes down toward the nose while staying flat across its width, which is
 * the shape that makes a tank's front readable from any angle.
 *
 * Hand-built rather than assembled from a primitive because no `MeshBuilder` shape offers this: a box
 * cannot taper, and scaling a cone or prism distorts it into something else entirely.
 */
function buildGlacisHull(scene: Scene, name: string, dims: GlacisDimensions): Mesh {
  const { widthM: w, heightM: h, lengthM: l, taperFraction: taper } = dims;
  const frontW = w * (1 - taper);
  const frontH = h * (1 - taper);
  const rearZ = l / 2;
  const frontZ = l / 2;

  // Rear quad at full size, front quad pulled in. Order matches the face list below.
  const positions = [
    // rear (full width, full height, at -Z)
    -w / 2, -h / 2, -rearZ,
    w / 2, -h / 2, -rearZ,
    w / 2, h / 2, -rearZ,
    -w / 2, h / 2, -rearZ,
    // front (tapered, at +Z)
    -frontW / 2, -frontH / 2, frontZ,
    frontW / 2, -frontH / 2, frontZ,
    frontW / 2, frontH / 2, frontZ,
    -frontW / 2, frontH / 2, frontZ,
  ];

  // Wound so each face is front-facing when viewed from outside, matching the terrain material's
  // clockwise front-face convention. Verified by `tests/client/tank-visual.test.ts`.
  const indices = [
    // rear face, outward normal -Z
    0, 2, 1, 0, 3, 2,
    // front face, outward normal +Z
    4, 5, 6, 4, 6, 7,
    // roof
    3, 7, 6, 3, 6, 2,
    // underside
    0, 1, 5, 0, 5, 4,
    // left flank
    0, 4, 7, 0, 7, 3,
    // right flank
    1, 2, 6, 1, 6, 5,
  ];

  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = [];
  VertexData.ComputeNormals(positions, indices, vertexData.normals);
  vertexData.applyToMesh(mesh, false);
  return mesh;
}
