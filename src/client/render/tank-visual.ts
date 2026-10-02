import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
// `Vector3` is a type elsewhere in this file but a *value* in `measureContactOffset`, which calls
// `TransformCoordinates`. Imported as a value so both uses resolve; a type-only import type-checks
// everywhere else and then fails at exactly the one line that does real work.
import { Vector3 as Vector3Ctor } from '@babylonjs/core/Maths/math.vector.js';
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
 * The V4 prototype tank model: a low/mid-poly vehicle assembled procedurally.
 *
 * ## Asset provenance — created in-project, no external files
 *
 * Every mesh here is generated in code from the vehicle definition's own dimensions. Nothing is
 * imported, downloaded, or licensed. That was a deliberate choice for the first real-asset version:
 * sourcing a model would have introduced redistribution questions and a licence to track, and the
 * point of this version is to establish *that* the game looks like it contains tanks. When production
 * art replaces this, it will be loaded by `visualId` and nothing in the simulation changes — that is
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
 *    instead of a cube, plus a rear bustle that overhangs — which is what makes a turret look like a
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
 * was the V3R approach and it is not enough — at range, in fog, or for a colour-blind player, two tanks
 * of different colours in the same shape are genuinely hard to tell apart. A shape difference is
 * legible at any distance and in any lighting.
 *
 * ## Hierarchy
 *
 * The turret and barrel are **separate transform nodes**, mirroring the simulation's structure — hull,
 * then turret, then barrel — so rotating the hull carries the turret automatically and the two can
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
  ) {
    const spec = VARIANT_SPECS[variant];
    const palette = spec.palette;
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

    for (const side of [-1, 1] as const) {
      const track = MeshBuilder.CreateBox(
        `tank-track-${side}`,
        { width: trackWidthM, height: trackHeightM, depth: trackSpan },
        scene,
      );
      track.position.set(side * trackCentreX, trackHeightM / 2, 0);
      track.material = makeMaterial(scene, `tank-track-mat-${side}`, palette.track);
      track.parent = this.root;

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
        end.position.set(side * trackCentreX, trackHeightM * 0.55, z);
        end.material = makeMaterial(scene, `tank-${name}-mat-${side}`, palette.wheel);
        end.parent = this.root;
      }

      // Road wheels, proud of the track face so they catch light and read individually.
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
        wheel.position.set(
          side * (trackCentreX + trackWidthM * 0.5 + 0.03),
          wheelRadiusM + 0.06,
          offset,
        );
        wheel.material = makeMaterial(scene, `tank-wheel-mat-${side}-${i}`, palette.wheel);
        wheel.parent = this.root;
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
        roller.position.set(
          side * (trackCentreX + trackWidthM * 0.5 + 0.02),
          trackHeightM - rollerRadiusM,
          -trackSpan / 2 + trackSpan * f,
        );
        roller.material = makeMaterial(scene, `tank-roller-mat-${side}-${i}`, palette.wheel.scale(0.9));
        roller.parent = this.root;
      }

      // Track links along the outer face.
      //
      // The single most effective addition to the running gear. Without them the track is a smooth dark
      // slab, and at range the eye reads a *skirt*; a repeated link pattern is what reads as a track.
      // One mesh with all the links baked into it rather than one mesh per link, so a full vehicle adds
      // two draw calls rather than thirty.
      const linkCount = TANK_DETAIL.trackLinkCount;
      const linkHeightM = trackHeightM * TANK_DETAIL.trackLinkHeightFraction;
      const linkSpacing = trackSpan / linkCount;
      const linkBoxes: number[] = [];
      for (let i = 0; i < linkCount; i += 1) {
        const z = -trackSpan / 2 + linkSpacing * (i + 0.5);
        // Push alternating links slightly further out, giving the track a visible rhythm rather than a
        // perfectly flat banded strip.
        const out = TANK_DETAIL.trackLinkDepthM * (i % 2 === 0 ? 1 : 0.55);
        linkBoxes.push(
          side * (trackCentreX + trackWidthM * 0.5 + out),
          trackHeightM * 0.5,
          z,
          TANK_DETAIL.trackLinkDepthM,
          linkHeightM,
          linkSpacing * 0.72,
        );
      }
      const links = MeshBuilder.CreateBox(
        `tank-links-${side}`,
        { width: 1, height: 1, depth: 1 },
        scene,
      );
      applyBoxInstances(links, linkBoxes);
      links.material = makeMaterial(scene, `tank-links-mat-${side}`, palette.track.scale(1.5));
      links.parent = this.root;

      // Fender over the top of the track: catches light along the vehicle's top edge and breaks the
      // long unbroken flank.
      const fender = MeshBuilder.CreateBox(
        `tank-fender-${side}`,
        {
          width: trackWidthM + widthM * TANK_DETAIL.fenderOverhangFraction * 2,
          height: trackHeightM * TANK_DETAIL.fenderThicknessFraction,
          depth: trackSpan * 0.98,
        },
        scene,
      );
      fender.position.set(side * trackCentreX, trackHeightM + 0.02, 0);
      fender.material = makeMaterial(scene, `tank-fender-mat-${side}`, palette.fender);
      fender.parent = this.root;
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
  apply(state: VehicleState, turret: TurretVisualState): void {
    // Drop the visual by however far its own geometry sits above the root origin, so the tracks rest on
    // the ground instead of hovering above it.
    //
    // Measured in the running game, this was an 0.86 m float. The simulation places the vehicle origin
    // at ground + `groundClearanceM` (0.48 m), but the mesh is modelled around the hull rather than
    // around the track contact, so the track bottoms sat a further 0.38 m above that. Nothing in the
    // core was wrong — a vehicle origin a little above the ground is a sensible place for one — and the
    // mismatch was purely in how the renderer read it.
    this.root.position.set(
      state.position.x,
      state.position.y - this.contactOffsetM,
      state.position.z,
    );

    // Babylon is left-handed, so the heading is negated to turn the same way the simulation's
    // heading increases. Stated explicitly because getting it backwards is the classic
    // "steering is inverted" bug.
    this.root.rotation.set(state.bodyPitchRad, -state.headingRad, state.bodyRollRad);

    // The turret's *local* angle, negated for the same handedness reason. Because it is a child of
    // the hull, the hull's rotation is inherited automatically — rotating the hull carries the
    // turret with it, which is what a real turret ring does.
    this.turretNode.rotation.y = -turret.localAngleRad;

    // Elevation is a pitch about the barrel's own pivot. The barrel node already carries the
    // cylinder's lay-flat rotation on the mesh, so only the elevation is applied here.
    this.barrelNode.rotation.x = -turret.elevationRad;
  }

  /**
   * Tints the vehicle to show it has been destroyed.
   *
   * Deliberately crude — a dark, cold body. The owner asked for the state to be *visibly
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
      if (!mesh.name.startsWith('tank-track')) {
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

  /** Enables shadow receiving on every part. */
  setShadowsEnabled(enabled: boolean): void {
    for (const mesh of this.root.getChildMeshes()) {
      mesh.receiveShadows = enabled;
    }
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

/**
 * Bakes a set of boxes into one mesh.
 *
 * Used for the track links, where the alternative is one `CreateBox` call per link per side: 28 extra
 * meshes per vehicle, each with its own transform to update and its own draw call. Writing the vertices
 * directly produces a single mesh with the same result, which is the difference between a vehicle that
 * costs a handful of draw calls and one that costs sixty.
 *
 * @param boxes flat `[x, y, z, width, height, depth]` per box, six numbers each
 */
function applyBoxInstances(mesh: Mesh, boxes: readonly number[]): void {
  const count = boxes.length / 6;
  const positions = new Float32Array(count * 24 * 3);
  const indices = new Uint32Array(count * 36);
  let vertex = 0;
  let element = 0;

  for (let b = 0; b < count; b += 1) {
    const cx = boxes[b * 6]!;
    const cy = boxes[b * 6 + 1]!;
    const cz = boxes[b * 6 + 2]!;
    const hw = boxes[b * 6 + 3]! / 2;
    const hh = boxes[b * 6 + 4]! / 2;
    const hd = boxes[b * 6 + 5]! / 2;

    // Eight corners, in the same order the indices below expect.
    const corners: readonly (readonly [number, number, number])[] = [
      [-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd],
      [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd],
    ];
    for (const [dx, dy, dz] of corners) {
      positions[vertex * 3] = cx + dx;
      positions[vertex * 3 + 1] = cy + dy;
      positions[vertex * 3 + 2] = cz + dz;
      vertex += 1;
    }

    // Twelve triangles per box, wound so every face points outward. Written as a fixed list rather than
    // generated, because a generated winding is exactly the kind of thing that silently produces an
    // inside-out mesh that still "works" and merely looks wrong.
    const faces = [
      0, 2, 1, 0, 3, 2, // -Z
      4, 5, 6, 4, 6, 7, // +Z
      3, 7, 6, 3, 6, 2, // +Y
      0, 1, 5, 0, 5, 4, // -Y
      0, 4, 7, 0, 7, 3, // -X
      1, 2, 6, 1, 6, 5, // +X
    ];
    const base = b * 8;
    for (const corner of faces) {
      indices[element] = base + corner;
      element += 1;
    }
  }

  const vertexData = new VertexData();
  vertexData.positions = positions as unknown as number[];
  vertexData.indices = indices as unknown as number[];
  vertexData.normals = [];
  VertexData.ComputeNormals(
    positions as unknown as number[],
    indices as unknown as number[],
    vertexData.normals,
  );
  vertexData.applyToMesh(mesh, false);
}

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
