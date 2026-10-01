import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import type { VehicleState } from '../../core/vehicle/vehicle-state.js';
import { TANK_PROPORTIONS, TANK_COLORS, makeMaterial } from './tank-proportions.js';

/** Wreck tint. Cold and dark, so a destroyed tank reads as inert at a glance. */
const DESTROYED_TINT = new Color3(0.13, 0.13, 0.15);

/** Faint ember glow, so a wreck is still findable in shadow. */
const DESTROYED_GLOW = new Color3(0.1, 0.02, 0.01);

/**
 * Placeholder tank, assembled from primitives.
 *
 * The mesh is built from the **vehicle definition's own dimensions**, not from constants, so
 * changing a tank's size in data visibly changes the model. That is the practical test of the
 * placeholder-first discipline: V12 replaces this with real art by changing what `visualId`
 * resolves to, and nothing in the simulation has to change.
 *
 * Silhouette: a lower hull, two track units, a turret block, and a gun barrel. The turret and the
 * barrel are **separate transform nodes** rather than parts of the hull mesh, because they rotate
 * independently of it. The mesh hierarchy mirrors the simulation's structure — hull, then turret, then
 * barrel — so the hull's rotation carries the turret automatically and the two can never disagree
 * about which way the gun is pointing.
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

export class TankVisual {
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
   * @param accent Optional body colour override, used to make the stationary target visually distinct
   *   from the player's own vehicle. Defaults to the standard hull olive.
   */
  constructor(scene: Scene, definition: VehicleDefinition, accent?: Color3) {
    const { lengthM, widthM, heightM } = definition.dimensions;
    const trackHeightM = TANK_PROPORTIONS.trackHeightFraction * heightM;
    const hullHeightM = heightM * 0.62;
    const roofHeightM = trackHeightM + hullHeightM;
    const bodyColor = accent ?? TANK_COLORS.hull;
    const turretColor = accent ? accent.scale(1.12) : TANK_COLORS.turret;

    this.root = new TransformNode('tank-root', scene);
    this.accent = accent;

    // Sloped front plate (glacis).
    //
    // A tapered box rather than a plain one, because orientation was the hardest thing to read about
    // the old model: a rectangular slab looks the same from every side, so the player could not tell
    // which way their tank was pointing without consulting the HUD. The taper gives the front a
    // distinct, unmistakable shape.
    //
    // Built as a custom wedge rather than a scaled primitive. A three-sided cylinder was tried first and
    // is the wrong tool: scaling it stretched the apex into a metre-long black spike that swallowed the
    // turret. A wedge needs the front face pulled *in* on two axes while the roof stays flat, which
    // `CreateCylinder` cannot express.
    const hull = buildGlacisHull(scene, 'tank-hull', {
      widthM: widthM * TANK_PROPORTIONS.hullWidthFraction,
      heightM: hullHeightM,
      lengthM: lengthM * 0.92,
      taperFraction: TANK_PROPORTIONS.glacisTaperFraction,
    });
    hull.position.y = roofHeightM - hullHeightM / 2;
    hull.material = makeMaterial(scene, 'tank-hull-mat', bodyColor);
    hull.parent = this.root;

    // Two track units flanking the hull, each with visible road wheels and a fender.
    const wheelRadiusM = TANK_PROPORTIONS.roadWheelRadiusFraction * trackHeightM;
    for (const side of [-1, 1] as const) {
      const track = MeshBuilder.CreateBox(
        `tank-track-${side}`,
        {
          width: widthM * TANK_PROPORTIONS.trackWidthFraction,
          height: trackHeightM,
          depth: lengthM * TANK_PROPORTIONS.trackLengthFraction,
        },
        scene,
      );
      track.position.set(
        side * widthM * (0.5 - TANK_PROPORTIONS.trackWidthFraction / 2),
        trackHeightM / 2,
        0,
      );
      track.material = makeMaterial(scene, `tank-track-mat-${side}`, TANK_COLORS.track);
      track.parent = this.root;

      // Road wheels, proud of the track face so they catch light and read individually.
      for (let i = 0; i < TANK_PROPORTIONS.roadWheelCount; i += 1) {
        const wheel = MeshBuilder.CreateCylinder(
          `tank-wheel-${side}-${i}`,
          { height: 0.12, diameter: wheelRadiusM * 2, tessellation: 10 },
          scene,
        );
        // Wheels are cylinders along Y; lay them along X to face outward from the hull's side.
        wheel.rotation.z = Math.PI / 2;
        const span = lengthM * TANK_PROPORTIONS.trackLengthFraction;
        const wheelCount = TANK_PROPORTIONS.roadWheelCount;
        // Spaced evenly from the rear of the track to the front, so the wheels span its full length.
        const offset =
          wheelCount <= 1 ? 0 : -span / 2 + (span / (wheelCount - 1)) * i;
        wheel.position.set(
          side * widthM * (0.5 - TANK_PROPORTIONS.trackWidthFraction / 2 + 0.06),
          wheelRadiusM + 0.06,
          offset,
        );
        wheel.material = makeMaterial(scene, `tank-wheel-mat-${side}-${i}`, TANK_COLORS.wheel);
        wheel.parent = this.root;
      }

      // Fender: a thin shelf over the track that gives the side profile a distinct top edge.
      const fender = MeshBuilder.CreateBox(
        `tank-fender-${side}`,
        {
          width: widthM * TANK_PROPORTIONS.trackWidthFraction + widthM * TANK_PROPORTIONS.fenderOverhangFraction,
          height: hullHeightM * TANK_PROPORTIONS.fenderThicknessFraction,
          depth: lengthM * TANK_PROPORTIONS.trackLengthFraction,
        },
        scene,
      );
      fender.position.set(
        side * widthM * (0.5 - TANK_PROPORTIONS.trackWidthFraction / 2),
        trackHeightM + (hullHeightM * TANK_PROPORTIONS.fenderThicknessFraction) / 2,
        0,
      );
      fender.material = makeMaterial(scene, `tank-fender-mat-${side}`, TANK_COLORS.fender);
      fender.parent = this.root;
    }

    // Turret block on its own node, so it can rotate independently of the hull. This is the visual
    // counterpart of the core's separation between hull heading and turret local angle: the mesh
    // hierarchy mirrors the simulation's, which is why the two can never disagree.
    const turretHeightM = TANK_PROPORTIONS.turretHeightFraction * heightM;

    // Turret ring.
    //
    // Positioned at the **hull roof**, not at `definition.turret.ringHeightM`. That data field is the
    // height of the gun trunnion in the simulation — 1.42 m for this vehicle — while the hull roof
    // stands at 1.77 m, because the hull body sits on top of the tracks. Placing the turret at the
    // ring height therefore buried the lower half of it inside the hull, which is why the vehicle read
    // as a flat slab with a box sunk into it rather than as a hull with a turret on top.
    //
    // The simulated muzzle is unaffected: it comes from the core's own geometry, not from this node.
    const hullRoofM = trackHeightM + hullHeightM;
    this.turretNode = new TransformNode('tank-turret-node', scene);
    this.turretNode.position.y = hullRoofM;
    this.turretNode.parent = this.root;

    // Turret set back from the hull centre so the barrel projects forward of the nose instead of
    // being swallowed by the turret block. At the original centre offset the gun was invisible from
    // every angle, which left the vehicle looking like an armoured box with no weapon.
    const turretOffsetZ = -lengthM * TANK_PROPORTIONS.turretRearwardOffsetFraction;

    const turret = MeshBuilder.CreateBox(
      'tank-turret',
      {
        width: widthM * TANK_PROPORTIONS.turretWidthFraction,
        height: turretHeightM,
        depth: lengthM * TANK_PROPORTIONS.turretLengthFraction,
      },
      scene,
    );
    turret.position.set(0, turretHeightM / 2, turretOffsetZ);
    turret.material = makeMaterial(scene, 'tank-turret-mat', turretColor);
    turret.parent = this.turretNode;

    // The barrel gets its own pivot node, so elevation is a rotation about the trunnion rather than
    // a repositioning of the mesh. The pivot sits partway up the turret face, where a real gun
    // trunnion is, so the barrel emerges from the turret rather than from its roof.
    this.barrelNode = new TransformNode('tank-barrel-node', scene);
    this.barrelNode.position.set(0, turretHeightM * 0.55, turretOffsetZ);
    this.barrelNode.parent = this.turretNode;

    this.barrel = MeshBuilder.CreateCylinder(
      'tank-barrel',
      {
        height: definition.mainGun.barrelLengthM,
        diameter: TANK_PROPORTIONS.barrelRadiusM * 2,
        tessellation: 12,
      },
      scene,
    );
    // Cylinders are built along Y in Babylon; lay it along +Z so it points forward, and offset it by
    // half its length so the pivot is at the trunnion rather than the barrel's midpoint.
    this.barrel.rotation.x = Math.PI / 2;
    this.barrel.position.z = definition.mainGun.barrelLengthM / 2;
    this.barrel.material = makeMaterial(scene, 'tank-barrel-mat', TANK_COLORS.barrel);
    this.barrel.parent = this.barrelNode;

    // Muzzle swell at the tip. Purely visual: it makes the gun read as a gun at range, where a plain
    // cylinder of even thickness is indistinguishable from a pole.
    const muzzle = MeshBuilder.CreateCylinder(
      'tank-muzzle',
      {
        height: TANK_PROPORTIONS.barrelRadiusM * 2.4,
        diameter: TANK_PROPORTIONS.barrelRadiusM * 2 * TANK_PROPORTIONS.muzzleRadiusFraction,
        tessellation: 12,
      },
      scene,
    );
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.z = definition.mainGun.barrelLengthM - TANK_PROPORTIONS.barrelRadiusM * 1.2;
    muzzle.material = makeMaterial(scene, 'tank-muzzle-mat', TANK_COLORS.barrel);
    muzzle.parent = this.barrelNode;
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
    this.root.position.set(state.position.x, state.position.y, state.position.z);

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
