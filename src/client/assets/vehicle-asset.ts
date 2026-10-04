/**
 * The V7 tank model pipeline.
 *
 * ## What this file is
 *
 * The replacement for "build the tank out of Babylon primitives at runtime". V1-V6 assembled a vehicle from
 * `MeshBuilder` calls every launch; that was the right placeholder-first choice, but it is not a pipeline,
 * and V7's brief asks for one. This loader reads a `.glb`, resolves the parts the simulation needs by
 * **name**, and hands back a rig whose contract is stated once and enforced here.
 *
 * ## The asset contract
 *
 * A vehicle model must satisfy all of the following. `docs/asset-pipeline.md` is the owner-facing copy of
 * this list; a model that fails any of it is rejected loudly rather than half-rendered.
 *
 * | Requirement | Value |
 * | --- | --- |
 * | Format | glTF 2.0 binary (`.glb`) |
 * | Units | metres |
 * | Up axis | +Y |
 * | Forward axis | +Z (the nose) |
 * | Hull origin | centre of the track contact line, on the vehicle centreline |
 * | Turret node | `Turret`, origin at the turret ring centre, rotates about **+Y** for traverse |
 * | Gun node | `Gun`, origin at the trunnion, pitches about **+X** for elevation |
 * | Muzzle node | `Muzzle`, an empty marker at the muzzle exit |
 * | Wheels | named `WheelL*`/`WheelR*`/`Sprocket*`/`Idler*`, spin about **+X** |
 * | Tracks | named `TrackL*`/`TrackR*`, each offset in **Y** to conform to the ground |
 * | Collision | the simulation's own armoured plates; the model never defines it |
 *
 * The node names are the load-bearing part of that table. They are resolved here by exact name, so a model
 * can change its geometry, materials, or proportions freely, but a renamed node is a *loud* failure rather
 * than a tank that silently loses its gun.
 *
 * ## Why axis and scale normalisation happens here, once
 *
 * The brief is explicit: "If the imported model has different axes, pivots, scale, or hierarchy, normalise
 * those cleanly rather than spreading special-case offsets throughout gameplay code." That is the whole
 * purpose of this class. `VehicleVisual` consumes a rig that is already in simulation space and contains no
 * knowledge of glTF whatsoever.
 *
 * The handedness fix deserves a specific note. Babylon's glTF loader, in a left-handed scene, applies a
 * 180Â° Y rotation and a âˆ’1 Z scale to convert glTF's right-handed convention into the engine's. Our exporter
 * *also* writes a 180Â° Y rotation on its root node, so the two compose. Rather than reason about that
 * composition and hope, the loader **verifies** the result: it measures where the muzzle sits relative to
 * the hull centre and checks that it is forward. If an asset or a loader change inverted the model, this
 * catches it immediately and says so, rather than the tank driving backwards and the mistake being found a
 * version later.
 */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { Axis } from '@babylonjs/core/Maths/math.axis.js';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import type { Scene } from '@babylonjs/core/scene.js';
import '@babylonjs/loaders/glTF/index.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import {
  formatModelContractProblems,
  validateVehicleModel,
  type VehicleModelProbe,
} from '../../shared/vehicle-model-contract.js';
import { assetUrl, VEHICLE_MODELS } from './asset-manifest.js';

/**
 * Node names the loader resolves. Declared as constants so a typo is a compile error rather than a silently
 * missing turret found at runtime, and so the contract has one authoritative spelling.
 */
export const VEHICLE_NODE_NAMES = {
  root: 'Tank',
  hull: 'Hull',
  turret: 'Turret',
  gun: 'Gun',
  muzzle: 'Muzzle',
} as const;

/** Prefixes for the repeating parts. A model may have any number of each. */
const WHEEL_PATTERN = /^(Wheel|Sprocket|Idler)([LR])(\d*)$/;
const TRACK_PATTERN = /^Track([LR])(\d+)$/;

/** One wheel or sprocket, spun about +X by distance travelled. */
export interface VehicleWheel {
  readonly node: TransformNode;
  /** Radius in metres, taken from the node's own bound rather than assumed. */
  readonly radiusM: number;
}

/** One track segment, offset vertically each frame to follow the ground. */
export interface VehicleTrackSegment {
  readonly node: TransformNode;
  /** Which side of the vehicle this segment is on: âˆ’1 left, +1 right. */
  readonly side: number;
  /** The node's authored Y, so the conforming pass measures a residual against a known baseline. */
  readonly authoredY: number;
  /** Half the segment's height: the distance from the node's centre down to its contact face. */
  readonly halfHeightM: number;
}

/** A loaded vehicle, resolved into the parts the renderer drives. */
export interface VehicleRig {
  /** Root node. The renderer sets its position and rotation from simulation state and nothing else. */
  readonly root: TransformNode;
  readonly hull: TransformNode;
  readonly turret: TransformNode;
  readonly gun: TransformNode;
  readonly muzzle: TransformNode;
  readonly wheels: readonly VehicleWheel[];
  readonly tracks: readonly VehicleTrackSegment[];
  /** Every mesh, so destruction tinting and shadow settings can be applied in one pass. */
  readonly meshes: readonly AbstractMesh[];
  /** Human-readable note about what the loader had to correct, for the debug overlay and the log. */
  readonly normalisationNote: string;
}

/** Thrown when a model cannot satisfy the contract. Loud by design. */
export class VehicleAssetError extends Error {
  constructor(message: string) {
    super(`Combat Tank: vehicle asset rejected - ${message}`);
    this.name = 'VehicleAssetError';
  }
}
const rigCache = new Map<string, Promise<VehicleRig>>();

/**
 * Loads and validates a vehicle model.
 *
 * @param scene the scene to load into
 * @param definition the vehicle whose `visualId` selects the model
 */
export function loadVehicleRig(scene: Scene, definition: VehicleDefinition): Promise<VehicleRig> {
  const relativePath = VEHICLE_MODELS[definition.visualId as keyof typeof VEHICLE_MODELS];
  if (relativePath === undefined) {
    return Promise.reject(
      new VehicleAssetError(
        `no model is registered for visualId '${definition.visualId}'. Add it to VEHICLE_MODELS in ` +
          `asset-manifest.ts â€” that map is the vehicle-to-model binding, and V8 depends on it being data.`,
      ),
    );
  }

  // Scene-scoped cache. Keyed by scene id because a rig holds Babylon nodes bound to one scene, and reusing
  // them across scenes would silently reparent live meshes.
  const cacheKey = `${scene.uniqueId}:${relativePath}`;
  const cached = rigCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const promise = loadUncached(scene, relativePath, definition).catch((error: unknown) => {
    // A failed load must not poison the cache: a transient network error should be retryable.
    rigCache.delete(cacheKey);
    throw error;
  });
  rigCache.set(cacheKey, promise);
  return promise;
}
/**
 * The meshes that make up a part: the node itself if Babylon fused it into a mesh, plus its descendants.
 *
 * `container.meshes.filter((m) => m.parent === node)` looks equivalent and is not. Babylon turns a glTF
 * node that carries geometry into an `AbstractMesh`, and a part like the hull is a *leaf* — it has no
 * child nodes at all, because the hull is one mesh. Its only parent is the model root. So the "meshes
 * directly under the hull" list comes back empty, and everything measured from it is zero.
 *
 * That is not a harmless edge case. It made the scale normalisation silently do nothing: it measured a hull
 * length of 0, skipped its correction, and reported "none needed" — so a model 26% shorter than the
 * simulation's own collision box rendered without a word of complaint, and every type check passed.
 *
 * Module scope rather than local to `loadUncached`, because the model-contract probe needs it too, and
 * there is no reason for two measurements of "the meshes under this node" to be able to disagree.
 */
const meshesOf = (node: TransformNode): AbstractMesh[] => {
  const isMesh = (n: TransformNode): n is AbstractMesh =>
    (n as unknown as { getTotalVertices?: unknown }).getTotalVertices !== undefined;
  const found: AbstractMesh[] = [];
  if (isMesh(node)) {
    found.push(node);
  }
  found.push(...node.getChildMeshes(false).filter((m): m is AbstractMesh => isMesh(m)));
  return found;
};

async function loadUncached(scene: Scene, relativePath: string, definition: VehicleDefinition): Promise<VehicleRig> {
  const url = assetUrl(relativePath);
  const container = await LoadAssetContainerAsync(url, scene);

  /**
   * Hands the loaded nodes to the scene. Without this the model exists and is never drawn.
   *
   * `LoadAssetContainerAsync` parses and *constructs* everything â€” meshes, materials, the node hierarchy â€”
   * but deliberately does **not** register it with the scene. The loader's contract is that the caller
   * decides when and where the assets go, so that a model can be loaded once and instanced in several
   * places, or held off-screen until it is needed.
   *
   * Forgetting the call is silent and total. Every node reports sane world positions, valid materials, and
   * correct bounds; `isEnabled()` and `isVisible()` are both true; the frustum test passes; the material
   * compiles. None of that matters, because Babylon's `_evaluateActiveMeshes` iterates `scene.meshes`, and a
   * container's meshes are not in that list. They are built, measured, posed, and skipped every single frame.
   *
   * This is why V7 reported a fully working tank â€” 36 meshes, every asset contract satisfied, the scale
   * normalisation note confirming a correct 6.70 m hull against a 6.7 m definition â€” while the player saw no
   * tank at all. Every assertion the gates made was true, and none of them asked the only question that
   * mattered: *is it in the scene?*
   */
  container.addAllToScene();

  /**
   * Every node in the container, whatever list Babylon filed it under.
   *
   * This is not tidiness, it is a bug that was caught in the browser and could not be caught by any type
   * check. Babylon's glTF loader turns a glTF node that carries a mesh into an `AbstractMesh`, and one that
   * does not into a `TransformNode`. So the hull, turret, gun, wheels and tracks â€” every part with visible
   * geometry â€” arrive in `container.meshes`, and only the empty `Tank` root arrives in `container.transformNodes`.
   * Searching `transformNodes` alone therefore finds the root and *nothing else*, and the loader reports
   * "no hull node named 'Hull'" for a model that plainly has one.
   *
   * `AbstractMesh` extends `TransformNode`, so the union is a plain `TransformNode[]` and every part of the
   * contract below works identically on either. The name is authoritative and unique either way.
   */
  const allNodes: readonly TransformNode[] = [...container.transformNodes, ...container.meshes];

  const require = (name: string, kind: string): TransformNode => {
    const node = allNodes.find((n) => n.name === name);
    if (node === undefined) {
      const present = allNodes
        .map((n) => n.name)
        .slice(0, 12)
        .join(', ');
      throw new VehicleAssetError(
        `${relativePath} has no ${kind} node named '${name}'. The contract requires one â€” see ` +
          `docs/asset-pipeline.md. Nodes the model does define: ${present}`,
      );
    }
    return node;
  };

  const gltfRoot = require(VEHICLE_NODE_NAMES.root, 'root');
  const hull = require(VEHICLE_NODE_NAMES.hull, 'hull');
  const turret = require(VEHICLE_NODE_NAMES.turret, 'turret');
  const gun = require(VEHICLE_NODE_NAMES.gun, 'gun');
  const muzzle = require(VEHICLE_NODE_NAMES.muzzle, 'muzzle');
  // Wheels and tracks, gathered by prefix and sorted by name so the order is stable between loads. Stability
  // matters: the wheel-spin pass indexes into this array, and a reordering would shuffle which wheel turns
  // at which rate â€” a bug that looks like one wheel is broken rather than like an ordering problem.
  const wheels: VehicleWheel[] = [];
  for (const node of allNodes) {
    if (WHEEL_PATTERN.test(node.name)) {
      // Radius measured from the node's own bound rather than from asset metadata: the mesh is the authority
      // for how big the part actually is, and the spin rate is `distance / radius`.
      const reach = meshesOf(node).reduce(
        (max, m) => Math.max(max, m.getBoundingInfo().boundingBox.extendSize.x, m.getBoundingInfo().boundingBox.extendSize.z),
        0,
      );
      wheels.push({ node, radiusM: Math.max(0.05, reach) });
    }
  }
  wheels.sort((a, b) => a.node.name.localeCompare(b.node.name));

  const tracks: VehicleTrackSegment[] = [];
  for (const node of allNodes) {
    const match = TRACK_PATTERN.exec(node.name);
    if (match === null) {
      continue;
    }
    const height = meshesOf(node).reduce(
      (max, m) => Math.max(max, m.getBoundingInfo().boundingBox.extendSize.y),
      0.1,
    );
    tracks.push({
      node,
      side: match[1] === 'L' ? -1 : 1,
      authoredY: node.position.y,
      halfHeightM: height,
    });
  }
  tracks.sort((a, b) => a.node.name.localeCompare(b.node.name));

  if (wheels.length === 0) {
    throw new VehicleAssetError(`${relativePath} defines no wheels (expected names like 'WheelL0').`);
  }
  if (tracks.length === 0) {
    throw new VehicleAssetError(`${relativePath} defines no track segments (expected names like 'TrackL0').`);
  }
  // --- Facing ---------------------------------------------------------------------------
  // Measured rather than assumed, in the driver's frame â€” the same frame the renderer will drive, so the
  // correction and the check cannot disagree about which way "forward" means.

  const notes: string[] = [];

  /**
   * The node the renderer actually poses.
   *
   * This exists for a reason that cost a browser session to find. The glTF loader attaches a **rotation
   * quaternion** to the model's root to convert glTF's right-handed convention into Babylon's left-handed
   * one. Babylon's rule is that `rotationQuaternion`, when non-null, *replaces* `rotation` entirely â€” the
   * Euler angles are not combined with it, they are ignored. So a renderer that sets `root.rotation.y` on
   * that node every frame writes into a field nothing reads, and the tank drives around the map at a fixed
   * orientation no matter which way the player steers.
   *
   * Nothing catches this: the value is assigned, TypeScript accepts the assignment, and no assertion fails.
   * It type-checked perfectly and was only visible by reading a rendered node's world matrix back.
   *
   * So the loaded root is kept intact as a *child*, carrying its quaternion where it belongs, and a fresh
   * `Tank` node is placed above it for the renderer to drive with plain Euler angles. The two compose the
   * way the format intends, and the orientation contract in `vehicle-visual.ts` needs no knowledge of glTF.
   */
  const driver = new TransformNode(VEHICLE_NODE_NAMES.root, scene);
  gltfRoot.parent = driver;
  // Named so the scene graph stays readable: two nodes called 'Tank' would make a bug report useless.
  gltfRoot.name = 'TankModel';

  /**
   * Facing correction, composed into the model's own quaternion.
   *
   * Babylon's glTF conversion leaves the model facing âˆ’Z: it rotates to undo glTF's right-handed âˆ’Z-forward
   * convention, which lands exactly opposite the +Z-forward convention the renderer drives with. So the
   * correction has to be another 180Â° about Y.
   *
   * It is applied to `gltfRoot.rotationQuaternion` rather than to `driver.rotation.y`, and that distinction is
   * load-bearing. `VehicleVisual.apply()` assigns `root.rotation.y` from the hull heading *every frame*, so a
   * correction written there would be overwritten by the next frame and the tank would still face backwards.
   * Composing into the quaternion puts the fix in the one place the renderer never writes to.
   *
   * Order is immaterial here and deliberately so: both rotations are 180Â° about +Y, and composing two of them
   * is the identity whichever way round they are multiplied.
   */
  driver.computeWorldMatrix(true);
  gun.computeWorldMatrix(true);
  muzzle.computeWorldMatrix(true);
  const driverInv = driver.getWorldMatrix().clone().invert();
  const gunInDriver = Vector3.TransformCoordinates(gun.getAbsolutePosition(), driverInv);
  const muzzleInDriver = Vector3.TransformCoordinates(muzzle.getAbsolutePosition(), driverInv);
  const noseZ = muzzleInDriver.z - gunInDriver.z;

  if (noseZ < 0) {
    const halfTurn = Quaternion.RotationAxis(Axis.Y, Math.PI);
    gltfRoot.rotationQuaternion = gltfRoot.rotationQuaternion === null
      ? halfTurn
      : halfTurn.multiply(gltfRoot.rotationQuaternion);
    notes.push('model faced -Z after loading; composed a 180Â° correction into the model root');
  }

  // --- Scale normalisation --------------------------------------------------------------
  // If the asset were authored in centimetres or inches, everything downstream would be wrong by a constant
  // factor â€” which reads as "the tank is the wrong size" rather than as a bug. Measuring the hull against
  // the `VehicleDefinition`, which the simulation already treats as authoritative for collision and armour,
  // and correcting to it keeps the model and the simulation in agreement.
  const hullMeshes = meshesOf(hull);
  for (const mesh of hullMeshes) {
    mesh.computeWorldMatrix(true);
    // Explicit, because the bounding info may have been computed against a world matrix that did not yet
    // include the scale this loop is about to read it through.
    mesh.refreshBoundingInfo({});
  }
  const hullLength = hullMeshes.reduce(
    (max, m) => Math.max(max, m.getBoundingInfo().boundingBox.extendSize.z * 2),
    0,
  );
  const expectedLength = definition.dimensions.lengthM;

  // The measurement is always recorded, not only when a correction is applied. A loader that stays silent
  // when it decides nothing is wrong cannot be distinguished from a loader that failed to measure anything â€”
  // which is exactly the bug this file had, and exactly why the number belongs in the note unconditionally.
  notes.push(`hull measured ${hullLength.toFixed(2)} m against a ${expectedLength} m definition`);

  if (hullLength > 0.01) {
    const scale = expectedLength / hullLength;
    // Only correct a *meaningful* mismatch. A couple of percent is the difference between a hull mesh and an
    // overall vehicle length, not an authoring error, and scaling by it would shrink the tank for no reason.
    if (Math.abs(scale - 1) > 0.02) {
      // Scaled on the driver rather than the glTF root, for the same reason as the rotation above: the
      // driver's scale is what composes with the model's own, and the renderer never touches the root's.
      driver.scaling.scaleInPlace(scale);
      notes.push(`scaled by ${scale.toFixed(3)}`);
    }
  }

  // Everything the file declares is parented under the model's own root, so disposing the rig is a single
  // call and no part can escape. Iterating `allNodes` rather than `container.transformNodes` matters here as
  // everywhere else: every part with geometry is an AbstractMesh, not a TransformNode.
  for (const node of allNodes) {
    if (node !== gltfRoot && node.parent === null) {
      node.parent = gltfRoot;
    }
  }

  // --- The model contract -------------------------------------------------------------------
  // Checked *after* normalisation, so what is validated is what will actually be drawn: the facing
  // correction has been composed and any scale correction applied. Checking before would validate the
  // asset as authored rather than the asset as used, and the two differ by exactly the operations most
  // likely to be wrong.
  //
  // The rules themselves live in `src/shared/vehicle-model-contract.ts` so the asset tests can run the same
  // checks headlessly over the generated `.glb`. This is the second caller, not the second implementation.
  const problems = validateVehicleModel(
    probeRig(driver, container, hull, turret, gun, muzzle, definition),
    definition.dimensions,
  );
  if (problems.length > 0) {
    throw new VehicleAssetError(
      `${relativePath} does not satisfy the vehicle model contract:\n` +
        formatModelContractProblems(problems) +
        `\n\nSee docs/model-contract.md for each rule and why it exists.`,
    );
  }

  return {
    root: driver,
    hull,
    turret,
    gun,
    muzzle,
    wheels,
    tracks,
    meshes: container.meshes,
    normalisationNote: notes.length === 0 ? 'none needed' : notes.join('; '),
  };
}

/**
 * Measures a loaded rig into the plain, Babylon-free shape the contract is checked against.
 *
 * Every position is read through the **driver's inverse world matrix**, which is the frame the renderer
 * poses: local +Z is the nose, +X right, +Y up, origin at the track contact line. Measuring in any other
 * frame would test the loader's own coordinate conversion rather than the asset, and a conversion bug would
 * then present as a contract violation pointing at the wrong file.
 */
function probeRig(
  driver: TransformNode,
  container: { meshes: readonly AbstractMesh[]; transformNodes: readonly TransformNode[] },
  hull: TransformNode,
  turret: TransformNode,
  gun: TransformNode,
  muzzle: TransformNode,
  definition: VehicleDefinition,
): VehicleModelProbe {
  driver.computeWorldMatrix(true);
  const toLocal = driver.getWorldMatrix().clone().invert();
  const local = (node: TransformNode): { x: number; y: number; z: number } => {
    node.computeWorldMatrix(true);
    const p = Vector3.TransformCoordinates(node.getAbsolutePosition(), toLocal);
    return { x: p.x, y: p.y, z: p.z };
  };

  const hullMeshes = meshesOf(hull);
  // The eight corners of every hull mesh's world bounding box, pushed through the inverse driver matrix.
  //
  // **Why corners and not `minimumWorld`/`maximumWorld`.** A bounding box in world space is axis-aligned to
  // the *world*, but the model is not axis-aligned to the world: the hull is a sloped box, and its world AABB
  // is strictly larger than the hull on every axis that is not aligned with a world axis. That is how the
  // contract came to report a 3.56 m hull width for a 3.3 m vehicle, and a hull "0.345 m below the origin"
  // for a model whose origin is on the track contact line — two failures, both manufactured by the
  // measurement, neither of which existed in the asset.
  //
  // Transforming the corners into the driver's frame first gives an extent in the *vehicle's* own axes,
  // which is what the contract is written about. This is the same technique the live asset audit uses for
  // its scale check, deliberately: two measurements of the same thing that cannot drift apart.
  const corners: { x: number; y: number; z: number }[] = [];
  for (const mesh of hullMeshes) {
    mesh.computeWorldMatrix(true);
    mesh.refreshBoundingInfo({});
    const box = mesh.getBoundingInfo().boundingBox;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const p = Vector3.TransformCoordinates(
            new Vector3(
              box.center.x + sx * box.extendSize.x,
              box.center.y + sy * box.extendSize.y,
              box.center.z + sz * box.extendSize.z,
            ),
            mesh.getWorldMatrix(),
          );
          corners.push(Vector3.TransformCoordinates(p, toLocal));
        }
      }
    }
  }

  const minX = corners.length > 0 ? Math.min(...corners.map((c) => c.x)) : 0;
  const maxX = corners.length > 0 ? Math.max(...corners.map((c) => c.x)) : 0;
  const minY = corners.length > 0 ? Math.min(...corners.map((c) => c.y)) : 0;
  const maxY = corners.length > 0 ? Math.max(...corners.map((c) => c.y)) : 0;
  const minZ = corners.length > 0 ? Math.min(...corners.map((c) => c.z)) : 0;
  const maxZ = corners.length > 0 ? Math.max(...corners.map((c) => c.z)) : 0;

  /**
   * Every node the contract may look for, including the ones the loader created for itself.
   *
   * `container.transformNodes` and `container.meshes` are the *file's* nodes. The `Tank` node the contract
   * requires is not one of them: it is the driver node this loader puts above the glTF root, and it never
   * enters the container. So the roster of node names taken from the container alone is always missing
   * `Tank`, and every vehicle was rejected by its own contract for a node that was present and correct.
   *
   * The model root is included too, under the name it was renamed to. A probe that reports only some of the
   * names in the scene is worse than one that reports none, because it looks like an exhaustive answer.
   */
  const nodeNames = [
    driver.name,
    ...container.transformNodes.map((n) => n.name),
    ...container.meshes.map((m) => m.name),
  ];

  // Meshes, and which of them are actually renderable.
  //
  // The count is over `container.meshes`, but a mesh is only *drawn* if it carries geometry. The muzzle
  // marker is a glTF node with no mesh, and Babylon still files it in `container.meshes` as an empty
  // `Mesh` — which is why this used to report "1 of 36 meshes have no material" on a file in which every
  // single mesh has one. That is a measurement counting an invisible node, and the contract rule it tripped
  // is right to ask the question in the first place: destruction tints meshes, so it must only consider the
  // ones a player can see.
  //
  // `getTotalVertices` is the test used elsewhere in this file to tell a real mesh from an empty node,
  // deliberately rather than by name or by parenting.
  const drawableMeshes = container.meshes.filter((mesh) => {
    const getTotalVertices = (mesh as unknown as { getTotalVertices?: () => number }).getTotalVertices;
    return getTotalVertices !== undefined && getTotalVertices.call(mesh) > 0;
  });

  return {
    vehicleId: definition.id,
    nodeNames,
    hullLengthM: Number.isFinite(maxZ - minZ) ? maxZ - minZ : 0,
    hullWidthM: Number.isFinite(maxX - minX) ? maxX - minX : 0,
    hullHeightM: Number.isFinite(maxY - minY) ? maxY - minY : 0,
    hullLowestY: Number.isFinite(minY) ? minY : 0,
    turretPivot: local(turret),
    gunPivot: local(gun),
    muzzle: local(muzzle),
    wheelCount: countByName(nodeNames, /^(Wheel|Sprocket|Idler)[LR]\d*$/),
    trackSegmentCount: countByName(nodeNames, /^Track[LR]\d+$/),
    meshCount: drawableMeshes.length,
    meshesWithoutMaterial: drawableMeshes.filter((m) => m.material === null).length,
  };
}

function countByName(names: readonly string[], pattern: RegExp): number {
  let count = 0;
  for (const name of names) {
    if (pattern.test(name)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Resolves a wheel's radius, for the spin-rate calculation.
 *
 * Exported separately because the spin rate is `distance / radius`, and taking the radius from the wrong
 * node â€” the root's, or the turret's â€” produces wheels that turn at a plausible but wrong rate.
 */
export function wheelRadiusM(wheel: VehicleWheel): number {
  return wheel.radiusM;
}

/** Clears the rig cache. Only for tests and for a hard reload that must not reuse live nodes. */
export function clearVehicleRigCache(): void {
  rigCache.clear();
}

/**
 * Forgets one cached rig, so the next `loadVehicleRig` for it builds a fresh one.
 *
 * ## Why disposing a visual must call this
 *
 * The cache exists so two vehicles sharing a model (a player and an opponent on the same definition) reuse
 * one set of meshes rather than loading it twice. But `VehicleVisual.dispose` frees those meshes — and the
 * cache kept handing out the *disposed* rig to the next caller.
 *
 * That is precisely the bug V8's roster made reachable, and it is why the audit reports "0 meshes" for the
 * second and third vehicle in the walk: the rig was cached, disposed with the previous encounter, and then
 * served again, so the tank existed as a set of destroyed Babylon nodes. Before V8 there was exactly one
 * vehicle and one encounter, so nothing ever asked for a rig twice and the cache could not be wrong.
 *
 * The failure mode is nasty precisely because it is quiet: no exception, no type error, and a vehicle that
 * renders nothing. So disposal and caching are now explicitly linked — a rig is a *shared* resource, and a
 * shared resource cannot be freed while something still holds a reference to it.
 */
export function releaseVehicleRig(scene: Scene, relativePath: string): void {
  rigCache.delete(`${scene.uniqueId}:${relativePath}`);
}

/**
 * Releases the cached rig for a vehicle, by the `visualId` its definition carries.
 *
 * The counterpart to `loadVehicleRig` from the caller's side: disposal happens in `VehicleVisual`, which
 * knows nothing about the manifest or the cache, so the two are joined here rather than in either of them.
 * `main.ts` calls this alongside `visual.dispose()` when an encounter is torn down.
 */
export function releaseVehicleRigFor(scene: Scene, definition: VehicleDefinition): void {
  const relativePath = VEHICLE_MODELS[definition.visualId as keyof typeof VEHICLE_MODELS];
  if (relativePath !== undefined) {
    releaseVehicleRig(scene, relativePath);
  }
}
