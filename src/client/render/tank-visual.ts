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
 * Silhouette: a lower hull, two track units, a turret block, and a stub gun barrel. The barrel is
 * geometry only — there is no gun, no aiming and no firing in V1. The turret inherits the hull's
 * heading, because independent turret traverse is V2 work and modelling an unused independent angle
 * now would be building ahead of the version that needs it.
 */

export class TankVisual {
  /** Root node. Position and rotation are set from simulation state each frame. */
  readonly root: TransformNode;

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

    // Turret block on the hull roof, set slightly rearward as on most real layouts.
    const turretHeightM = TANK_PROPORTIONS.turretHeightFraction * heightM;
    const turret = MeshBuilder.CreateBox(
      'tank-turret',
      {
        width: widthM * TANK_PROPORTIONS.turretWidthFraction,
        height: turretHeightM,
        depth: lengthM * TANK_PROPORTIONS.turretLengthFraction,
      },
      scene,
    );
    turret.position.set(0, roofHeightM + turretHeightM / 2, -lengthM * 0.05);
    turret.material = makeMaterial(scene, 'tank-turret-mat', TANK_COLORS.turret);
    turret.parent = this.root;

    // Stub barrel: silhouette only, no gun logic in V1.
    this.barrel = MeshBuilder.CreateCylinder(
      'tank-barrel',
      {
        height: lengthM * TANK_PROPORTIONS.barrelLengthFraction,
        diameter: TANK_PROPORTIONS.barrelRadiusM * 2,
        tessellation: 12,
      },
      scene,
    );
    // Cylinders are built along Y in Babylon; lay it along +Z so it points forward.
    this.barrel.rotation.x = Math.PI / 2;
    this.barrel.position.set(
      0,
      roofHeightM + TANK_PROPORTIONS.barrelHeightFraction * heightM,
      lengthM * TANK_PROPORTIONS.turretLengthFraction * 0.5 +
        lengthM * TANK_PROPORTIONS.barrelLengthFraction * 0.42,
    );
    this.barrel.material = makeMaterial(scene, 'tank-barrel-mat', TANK_COLORS.barrel);
    this.barrel.parent = this.root;
  }

  /**
   * Writes simulation state onto the transform.
   *
   * The *only* place simulation state reaches the scene graph, and strictly one-way: the renderer
   * reads state and never writes it (ADR-0001). Pitch and roll come from the core's already-smoothed
   * values, so slope behaviour is simulated rather than faked here.
   */
  apply(state: VehicleState): void {
    this.root.position.set(state.position.x, state.position.y, state.position.z);

    // Babylon is left-handed, so the heading is negated to turn the same way the simulation's
    // heading increases. Stated explicitly because getting it backwards is the classic
    // "steering is inverted" bug.
    this.root.rotation.set(state.bodyPitchRad, -state.headingRad, state.bodyRollRad);
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
