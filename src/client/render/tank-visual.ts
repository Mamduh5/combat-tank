import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import type { VehicleState } from '../../core/vehicle/vehicle-state.js';
import { TANK_PROPORTIONS, TANK_COLORS, makeMaterial } from './tank-proportions.js';

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

  constructor(scene: Scene, definition: VehicleDefinition) {
    const { lengthM, widthM, heightM } = definition.dimensions;
    const trackHeightM = TANK_PROPORTIONS.trackHeightFraction * heightM;
    const hullHeightM = heightM * 0.62;
    const roofHeightM = trackHeightM + hullHeightM;

    this.root = new TransformNode('tank-root', scene);

    const hull = MeshBuilder.CreateBox(
      'tank-hull',
      { width: widthM * 0.82, height: hullHeightM, depth: lengthM * 0.92 },
      scene,
    );
    hull.position.y = roofHeightM - hullHeightM / 2;
    hull.material = makeMaterial(scene, 'tank-hull-mat', TANK_COLORS.hull);
    hull.parent = this.root;

    // Two track units flanking the hull.
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
    }

    // Turret block on its own node, so it can rotate independently of the hull. This is the visual
    // counterpart of the core's separation between hull heading and turret local angle: the mesh
    // hierarchy mirrors the simulation's, which is why the two can never disagree.
    const turretHeightM = TANK_PROPORTIONS.turretHeightFraction * heightM;
    this.turretNode = new TransformNode('tank-turret-node', scene);
    this.turretNode.position.y = definition.turret.ringHeightM;
    this.turretNode.parent = this.root;

    const turret = MeshBuilder.CreateBox(
      'tank-turret',
      {
        width: widthM * TANK_PROPORTIONS.turretWidthFraction,
        height: turretHeightM,
        depth: lengthM * TANK_PROPORTIONS.turretLengthFraction,
      },
      scene,
    );
    turret.position.set(0, turretHeightM / 2, -lengthM * 0.05);
    turret.material = makeMaterial(scene, 'tank-turret-mat', TANK_COLORS.turret);
    turret.parent = this.turretNode;

    // The barrel gets its own pivot node, so elevation is a rotation about the trunnion rather than
    // a repositioning of the mesh. The pivot sits at the same ring height the core uses for the gun,
    // so the drawn barrel and the simulated muzzle cannot drift apart.
    this.barrelNode = new TransformNode('tank-barrel-node', scene);
    this.barrelNode.position.set(0, 0, -lengthM * 0.05);
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
