/**
 * Turning one parsed model into two, three, or N independent live vehicles.
 *
 * ## The invariant this module exists to enforce
 *
 * A vehicle **definition** may be shared. A vehicle **instance** may not.
 *
 * That is not a style preference. V8's roster made it reachable: the rig cache was keyed by
 * `scene:modelPath` and stored live, scene-parented, mutable rigs, so asking for the same vehicle
 * twice returned the *same* `TransformNode`s. In a mirror matchup both `VehicleVisual`s then wrote to
 * one root node each frame. The opponent's `apply()` ran second and won, so the single shared tank
 * was drawn on the *enemy's* spawn while the camera followed the *player's* simulated hull to bare
 * ground. The owner saw both tanks disappear.
 *
 * The failure was silent because a shared rig is not a *broken* rig. Both sides reported healthy world
 * matrices, `isVisible`, `isEnabled`, a valid contract and a plausible mesh count. Nothing was wrong
 * except that the two vehicles were the same vehicle.
 *
 * So the split is made structural rather than by discipline:
 *
 * ```
 * ct-medium definition
 *        |
 *        +-- parsed model source  (cached, immutable, off-scene)
 *               |
 *               +-- Player Sabre   hull/turret/gun/meshes/materials  <- live instance
 *               +-- Enemy  Sabre   hull/turret/gun/meshes/materials  <- live instance
 * ```
 *
 * Sharing stops at the source. Geometry is shared deliberately, because Babylon reference-counts vertex
 * buffers: a second tank costs one node per part, not another copy of the model, and disposing one
 * instance cannot free buffers the other is still drawing. Everything that is *mutated* at runtime --
 * transforms, materials, the wreck tint, the texture offsets the track scroll advances -- is per instance.
 *
 * ## Why this is its own file
 *
 * Because the invariant is worth testing without a network. Instantiation takes a parsed template and
 * returns a rig; nothing about it needs glTF, a contract check, or a `.glb`. The tests can therefore build
 * a contract-shaped template out of primitives and assert the ownership properties directly, instead of
 * asserting them only through a live browser session where a failure is a screenshot nobody can diff.
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Material } from '@babylonjs/core/Materials/material.js';

/**
 * Node names an instance resolves. One authoritative spelling, shared with the loader and the contract.
 */
export const VEHICLE_NODE_NAMES = {
  root: 'Tank',
  hull: 'Hull',
  turret: 'Turret',
  gun: 'Gun',
  muzzle: 'Muzzle',
} as const;

/**
 * Prefixes for the repeating parts. A model may have any number of each.
 *
 * Exported because the loader's contract probe resolves the same parts from the *template*, while
 * instantiation resolves them from each *clone*. Two copies of this pattern is two chances to spell the
 * wheel naming two ways, and the resulting failure is a tank with no spinning wheels.
 */
export const WHEEL_PATTERN = /^(Wheel|Sprocket|Idler)([LR])(\d*)$/;
export const TRACK_PATTERN = /^Track([LR])(\d+)$/;

/** One wheel or sprocket, spun about +X by distance travelled. */
export interface VehicleWheel {
  readonly node: TransformNode;
  /** Radius in metres, taken from the node's own bound rather than assumed. */
  readonly radiusM: number;
}

/** One track segment, offset vertically each frame to follow the ground. */
export interface VehicleTrackSegment {
  readonly node: TransformNode;
  /** Which side of the vehicle this segment is on: -1 left, +1 right. */
  readonly side: number;
  /** The node's authored Y, so the conforming pass measures a residual against a known baseline. */
  readonly authoredY: number;
  /** Half the segment's height: the distance from the node's centre down to its contact face. */
  readonly halfHeightM: number;
}

/** Thrown when a template cannot be turned into a rig. Loud by design. */
export class VehicleRigError extends Error {
  constructor(message: string) {
    super(`Combat Tank: vehicle rig rejected - ${message}`);
    this.name = 'VehicleRigError';
  }
}

/**
 * A loaded vehicle, resolved into the parts the renderer drives.
 *
 * ## This is a live instance, not a shared asset
 *
 * Everything reachable from here is owned by exactly one `VehicleVisual` and by nothing else. The
 * immutable model -- the parsed geometry, the definition, the decoded texture data -- is shared, but
 * that sharing happens *behind* this object, in the template, and never through it.
 *
 * A `VehicleRig` is therefore safe to hold for the lifetime of one encounter and to dispose without
 * coordinating with anybody: two tanks of the same type have two rigs, and freeing one frees only that
 * one's nodes, materials and texture wrappers.
 */
export interface VehicleRig {
  /** The vehicle this instance was instantiated from. Carried for diagnostics and the debug surface. */
  readonly vehicleId: string;
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

/**
 * The immutable half of a vehicle model: parsed once, shared by every live instance of that vehicle.
 *
 * Deliberately narrow: a template root to clone, the id the instance should report, and the loader's
 * note. No transforms, no scene parenting, no mutable presentation state -- because everything a rig
 * exposes is exactly what must not be shared.
 */
export interface VehicleSource {
  /**
   * The parsed model root, kept **out of the scene** so it is never drawn and never evaluated.
   *
   * A tank-shaped blueprint: it holds the geometry and node hierarchy, costs nothing to keep resident,
   * and can be instantiated any number of times.
   */
  readonly templateRoot: TransformNode;
  /** The definition this model was loaded for, carried through so instances report the right id. */
  readonly vehicleId: string;
  /** The loader's own record of what it corrected, surfaced on every instance. */
  readonly normalisationNote: string;
}

/**
 * Builds one live rig from a shared source.
 *
 * The clone is what makes two tanks of one type independent: separate driver node, separate turret,
 * separate gun, separate mesh instances, separate materials, separate texture wrappers. Geometry is
 * deliberately *not* cloned -- Babylon shares the vertex buffers between a mesh and its clone and
 * reference-counts them, so a mirror matchup costs a node per part rather than a second model.
 *
 * @param source the cached, immutable model to instantiate from
 * @returns a rig owned by the caller and by nobody else
 */
export function instantiateVehicleRig(source: VehicleSource): VehicleRig {
  const driver = cloneSubtree(source.templateRoot);
  if (driver === null) {
    throw new VehicleRigError('cloning the loaded model produced no root node.');
  }

  // Parts are resolved *on the clone*, by name, exactly as the loader resolves them on the template.
  // Cloning is per-node (see `cloneSubtree`), so the contract names survive verbatim and a part can
  // never be silently taken from the shared template, which would reintroduce the original bug.
  const nodes: readonly TransformNode[] = [
    driver,
    ...driver.getDescendants(false).filter((n): n is TransformNode => n instanceof TransformNode),
  ];
  const requirePart = (name: string, kind: string): TransformNode => {
    const node = nodes.find((n) => n.name === name);
    if (node === undefined) {
      throw new VehicleRigError(`the cloned model has no ${kind} node named '${name}'.`);
    }
    return node;
  };
  const hull = requirePart(VEHICLE_NODE_NAMES.hull, 'hull');
  const turret = requirePart(VEHICLE_NODE_NAMES.turret, 'turret');
  const gun = requirePart(VEHICLE_NODE_NAMES.gun, 'gun');
  const muzzle = requirePart(VEHICLE_NODE_NAMES.muzzle, 'muzzle');

  const meshes = nodes.filter(isMesh);
  for (const mesh of meshes) {
    mesh.material = cloneMaterialForInstance(mesh.material);
  }

  const wheels: VehicleWheel[] = [];
  for (const node of nodes) {
    if (WHEEL_PATTERN.test(node.name)) {
      // Measured from the node's own bound rather than assumed: the mesh is the authority for how big
      // the part is, and the spin rate is `distance / radius`.
      const reach = meshesOf(node).reduce(
        (max, m) =>
          Math.max(
            max,
            measuredExtent(m).x,
            measuredExtent(m).z,
          ),
        0,
      );
      wheels.push({ node, radiusM: Math.max(0.05, reach) });
    }
  }
  // Sorted so the order is stable between loads. The wheel-spin pass walks this array, and an
  // unstable order would shuffle which wheel turns at which rate.
  wheels.sort((a, b) => a.node.name.localeCompare(b.node.name));

  const tracks: VehicleTrackSegment[] = [];
  for (const node of nodes) {
    const match = TRACK_PATTERN.exec(node.name);
    if (match === null) {
      continue;
    }
    const height = meshesOf(node).reduce((max, m) => Math.max(max, measuredExtent(m).y), 0.1);
    tracks.push({
      node,
      side: match[1] === 'L' ? -1 : 1,
      authoredY: node.position.y,
      halfHeightM: height,
    });
  }
  tracks.sort((a, b) => a.node.name.localeCompare(b.node.name));

  return {
    vehicleId: source.vehicleId,
    root: driver,
    hull,
    turret,
    gun,
    muzzle,
    wheels,
    tracks,
    meshes,
    normalisationNote: source.normalisationNote,
  };
}

/** Narrows a node to a mesh, without importing the class for what is only a type distinction. */
function isMesh(node: TransformNode): node is AbstractMesh {
  return typeof (node as unknown as { getTotalVertices?: unknown }).getTotalVertices === 'function';
}

/**
 * Clones a node and its whole subtree, **preserving every node's name**.
 *
 * ## Why this is not `root.clone(name, null, false)`
 *
 * Babylon's `Node.clone` does not copy names down the hierarchy -- it qualifies each descendant with
 * the *new* root's name. Cloning `Tank` as `Tank2` yields `Tank2.TankModel.Hull`, not `Hull`.
 *
 * That single behaviour breaks the asset contract, which resolves parts **by exact name**: `Hull`,
 * `Turret`, `Gun`, `Muzzle`. Every tank would be rejected with "the cloned model has no hull node",
 * and the failure looks like a broken model rather than a naming convention nobody documented. It is
 * also invisible to a test that checks node *identity* -- the clone works, it is just not findable.
 *
 * So the subtree is cloned node by node, each with its own name and its own cloned parent, which is
 * both more code and the only thing that keeps one code path (name lookup) working for templates and
 * instances alike.
 *
 * Geometry is deliberately *not* duplicated: Babylon shares vertex buffers between a mesh and its
 * clone and reference-counts them, so a second tank costs a node per part, not a second model.
 */
function cloneSubtree(root: TransformNode): TransformNode | null {
  const cloneOf = new Map<TransformNode, TransformNode>();

  // Breadth-first from the root, so a node's cloned parent always exists before the node is visited.
  const queue: TransformNode[] = [root];
  let clone: TransformNode | null = null;
  while (queue.length > 0) {
    const node = queue.shift() as TransformNode;
    const parent = node.parent;
    const parentClone = parent instanceof TransformNode ? (cloneOf.get(parent) ?? null) : null;
    const nodeClone = node.clone(node === root ? VEHICLE_NODE_NAMES.root : node.name, parentClone, true);
    if (nodeClone === null) {
      continue;
    }
    cloneOf.set(node, nodeClone);
    if (node === root) {
      clone = nodeClone;
    }
    queue.push(...node.getChildren().filter((c): c is TransformNode => c instanceof TransformNode));
  }
  return clone;
}

/**
 * The meshes that make up a part: the node itself if Babylon fused it into a mesh, plus its descendants.
 *
 * This is a verbatim restatement of the loader's own `meshesOf`, and it has to be. A glTF node that
 * carries geometry becomes an `AbstractMesh`, so a part like a road wheel is a **leaf**: it has no child
 * nodes at all. Asking only for child meshes therefore returns an empty list for the very nodes whose
 * size matters most, every measurement reduces to nothing, and the wheel radius falls through to its
 * floor while the audit reports a tank whose wheels are 5 cm across.
 *
 * Two copies of this is a hazard, but one shared helper would have to live in the loader and then the
 * loader would import from the module it owns, which inverts the dependency. The duplication is
 * deliberate and both sides carry the reasoning.
 */
function meshesOf(node: TransformNode): readonly AbstractMesh[] {
  const found: AbstractMesh[] = [];
  if (isMesh(node)) {
    found.push(node);
  }
  found.push(...node.getChildMeshes(false).filter((m): m is AbstractMesh => isMesh(m)));
  return found;
}

/**
 * A mesh's local half-extents, with the bounding info forced up to date first.
 *
 * ## Why this is not just `getBoundingInfo()`
 *
 * A freshly cloned mesh has never been through a render pass, so its cached bounding info is still the
 * zero-sized default that `AbstractMesh` starts with. Reading it directly yields an extent of 0 for
 * every part, which made every wheel radius collapse to its 0.05 m floor and every track segment to a
 * 0.1 m default -- a tank whose running gear is animated from numbers that describe nothing.
 *
 * This is a bug the instantiation split introduced and the live audit caught: the loader had always
 * measured against a model that had been in the scene and rendered, so its numbers were real. Clones
 * have not. `computeWorldMatrix(true)` followed by `refreshBoundingInfo()` is what the loader already
 * does before measuring, and instantiation now does the same for the same reason.
 */
function measuredExtent(mesh: AbstractMesh): { x: number; y: number; z: number } {
  mesh.computeWorldMatrix(true);
  mesh.refreshBoundingInfo({});
  return mesh.getBoundingInfo().boundingBox.extendSize;
}

/**
 * Clones a material, and every texture on it, so this instance can be mutated and disposed alone.
 *
 * Textures are cloned too, and not merely for tidiness. Two separate leaks converge here:
 *
 * 1. `VehicleVisual.dispose` calls `root.dispose(false, true)`, which frees each mesh's material **and
 *    that material's textures**. A shared material therefore does not merely look wrong, it is freed out
 *    from under the other tank -- which is requirement 8 of the roster retest.
 * 2. The track scroll advances `vOffset` on the albedo and bump maps every frame a vehicle moves. A
 *    shared texture means the player's tracks scroll the enemy's too.
 *
 * Cloning a Babylon texture reuses the already-decoded source, so this costs a wrapper per slot rather
 * than a re-download, and the shared immutable data stays shared.
 */
function cloneMaterialForInstance(material: Material | null): Material | null {
  if (material === null) {
    return null;
  }
  const cloner = (material as { clone?: (name: string) => Material }).clone;
  if (cloner === undefined) {
    return material;
  }
  const instance = cloner.call(material, `${material.name}-instance`);
  const record = instance as unknown as Record<string, unknown>;
  for (const [slot, value] of Object.entries(record)) {
    // Every texture slot on a Babylon material ends in `Texture` (albedoTexture, bumpTexture,
    // metallicTexture, ...). Matching the suffix rather than listing slots keeps a newly-read glTF slot
    // covered automatically instead of silently staying shared.
    if (!slot.endsWith('Texture')) {
      continue;
    }
    const texture = value as { clone?: () => unknown } | null | undefined;
    if (texture === null || texture === undefined || typeof texture.clone !== 'function') {
      continue;
    }
    record[slot] = texture.clone();
  }
  return instance;
}
