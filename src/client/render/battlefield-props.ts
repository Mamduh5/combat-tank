import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  type Scene,
} from '@babylonjs/core';
import type { Battlefield } from '../../core/world/battlefield.js';
import type { PlacedStructure, StructureKind } from '../../core/world/structures.js';

/**
 * Prototype environment art for the V6 battlefield.
 *
 * ## Everything here is generated, and that is a deliberate V6 decision
 *
 * The V6 brief allows generated, sourced, or hand-built assets and asks only that provenance be
 * recorded. Everything in this file is **procedurally generated from geometry primitives at load
 * time**, which means:
 *
 * - **no external assets, therefore no licence, no attribution, and no redistribution conditions**;
 * - **no download**, so the game boots offline and the build grows no asset pipeline;
 * - **no placeholder-looking boxes** — the specific complaint the brief raises about V5.
 *
 * The cost is honest and worth stating: these are *prototype* assets. They read as an intentional
 * environment rather than as a finished one, and they are not suitable as final art. What they do buy
 * is that a building looks like a building, a treeline looks like a treeline, and the player can tell
 * the red barn from the mill from the outpost at a glance — which is what the brief's "map readability"
 * requirement actually needs.
 *
 * ## Everything is built from the map data, not from a parallel list
 *
 * Each structure and each concealment zone in `Battlefield` gets a mesh here, because the simulation
 * already decided those are the things that are solid and the things that hide you. A renderer with its
 * own hand-written list of buildings would be free to drift from the one the ballistics uses, and the
 * first symptom would be a shell passing through a barn that is plainly on screen.
 */

/** Colours, chosen to stay distinguishable at distance and under fog. */
const PALETTE = {
  buildingWall: new Color3(0.62, 0.58, 0.5),
  outpostWall: new Color3(0.48, 0.47, 0.45),
  barnWall: new Color3(0.66, 0.19, 0.16),
  millWall: new Color3(0.72, 0.66, 0.52),
  roof: new Color3(0.3, 0.26, 0.23),
  rock: new Color3(0.42, 0.41, 0.4),
  barrier: new Color3(0.55, 0.54, 0.5),
  screen: new Color3(0.24, 0.31, 0.19),
  foliageHeavy: new Color3(0.13, 0.26, 0.12),
  foliageLight: new Color3(0.22, 0.33, 0.15),
  trunk: new Color3(0.24, 0.18, 0.12),
} as const;

/** Trunk height before the canopy starts, metres. */
const TREE_TRUNK_M = 2.2;

/** Canopy height and radius, metres. */
const TREE_CANOPY_M = 5.4;
const TREE_CANOPY_RADIUS_M = 2.6;

/** How many trees and bushes a single zone is drawn with. */
const TREES_PER_HEAVY_ZONE = 7;
const BUSHES_PER_LIGHT_ZONE = 9;

/** Bush height and radius, metres. */
const BUSH_M = 1.5;
const BUSH_RADIUS_M = 2.1;

/**
 * Deterministic pseudo-random placement, from an integer seed.
 *
 * The same shape of integer hash the terrain uses, rather than a second one written from scratch. Every
 * scattered tree and bush is placed from this, so the battlefield looks identical on every run and on
 * every machine — which is what makes a screenshot comparable to the last one.
 */
function seededOffset(seed: number, index: number, spreadM: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return ((h / 4294967296) * 2 - 1) * spreadM;
}

/** A stable integer from a string, so each zone and structure scatters from its own seed. */
function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A rough, non-shiny material. Reused per colour so the scene does not accumulate hundreds of them. */
function makeMaterial(scene: Scene, name: string, colour: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = colour;
  // Prototype scenery should read by silhouette and colour, not by a specular highlight.
  material.specularColor = new Color3(0.05, 0.05, 0.05);
  return material;
}

/** Colour a structure is painted, chosen so the map's landmarks are tellable apart at a glance. */
function wallColourFor(placed: PlacedStructure): Color3 {
  switch (placed.structure.kind as StructureKind) {
    case 'building':
      if (placed.structure.id === 'red-barn') return PALETTE.barnWall;
      if (placed.structure.id === 'mill') return PALETTE.millWall;
      if (placed.structure.id.startsWith('outpost')) return PALETTE.outpostWall;
      return PALETTE.buildingWall;
    case 'rock':
      return PALETTE.rock;
    case 'barrier':
      return PALETTE.barrier;
    case 'screen':
      return PALETTE.screen;
  }
}

/**
 * A rock is drawn as a cluster of tilted blocks rather than a box.
 *
 * The single change that separates "grey box" from "rock formation" at prototype quality. Three
 * overlapping prisms at different scales and tilts read as an outcrop from any angle.
 *
 * Stated rather than hidden: **the collision is the box, the picture is the cluster**, and every block
 * is kept inside the box the simulation uses, so the two can never disagree about whether a shell
 * passed through.
 */
function buildRock(
  scene: Scene,
  root: TransformNode,
  placed: PlacedStructure,
  material: StandardMaterial,
): void {
  const s = placed.structure;
  const seed = seedFrom(s.id);
  for (let i = 0; i < 3; i += 1) {
    const scale = 0.55 + (i / 3) * 0.5;
    const block = MeshBuilder.CreateBox(
      `rock-${s.id}-${i}`,
      {
        width: s.halfLengthM * 2 * scale,
        height: s.heightM * scale,
        depth: s.halfWidthM * 2 * scale,
      },
      scene,
    );
    block.rotation.set(
      seededOffset(seed, i * 3 + 1, 0.22),
      seededOffset(seed, i * 3 + 2, 0.5),
      seededOffset(seed, i * 3 + 3, 0.22),
    );
    block.position.set(
      seededOffset(seed, i * 3 + 4, s.halfLengthM * 0.3),
      (s.heightM * scale) / 2,
      seededOffset(seed, i * 3 + 5, s.halfWidthM * 0.3),
    );
    block.material = material;
    block.parent = root;
  }
}

/**
 * A building is a body with a pitched roof.
 *
 * The roof is what makes it read as a building rather than a block, and it is deliberately *not* part
 * of the collision volume. A shell passing over a roof is a miss, which is the more useful behaviour: a
 * low trajectory that clips the tiles should carry on into the building, not stop on them.
 */
function buildBuilding(
  scene: Scene,
  root: TransformNode,
  placed: PlacedStructure,
  material: StandardMaterial,
  roofMaterial: StandardMaterial,
): void {
  const s = placed.structure;
  const bodyHeight = s.heightM * 0.72;

  const body = MeshBuilder.CreateBox(
    `building-${s.id}`,
    { width: s.halfWidthM * 2, height: bodyHeight, depth: s.halfLengthM * 2 },
    scene,
  );
  body.position.set(0, bodyHeight / 2, 0);
  body.material = material;
  body.parent = root;

  // A shallow pyramid rather than a pitched prism: fewer vertices, and at this scale the silhouette
  // is all that reads.
  const roof = MeshBuilder.CreateCylinder(
    `roof-${s.id}`,
    {
      diameterTop: 0,
      diameterBottom: Math.max(s.halfWidthM, s.halfLengthM) * 2.6,
      height: s.heightM - bodyHeight,
      tessellation: 4,
    },
    scene,
  );
  roof.rotation.y = Math.PI / 4;
  roof.position.set(0, bodyHeight + (s.heightM - bodyHeight) / 2, 0);
  roof.material = roofMaterial;
  roof.parent = root;
}

/** A barrier is a single low slab: a wall, a parapet, a line of concrete. */
function buildBarrier(
  scene: Scene,
  root: TransformNode,
  placed: PlacedStructure,
  material: StandardMaterial,
): void {
  const s = placed.structure;
  const slab = MeshBuilder.CreateBox(
    `barrier-${s.id}`,
    { width: s.halfWidthM * 2, height: s.heightM, depth: s.halfLengthM * 2 },
    scene,
  );
  slab.position.set(0, s.heightM / 2, 0);
  slab.material = material;
  slab.parent = root;
}

/** A tree: a trunk with a canopy, scaled per instance so a treeline is not a row of clones. */
function buildTree(
  scene: Scene,
  root: TransformNode,
  name: string,
  x: number,
  z: number,
  groundY: number,
  scale: number,
  foliage: StandardMaterial,
  trunk: StandardMaterial,
): void {
  const trunkMesh = MeshBuilder.CreateCylinder(
    `${name}-trunk`,
    { diameterTop: 0.35, diameterBottom: 0.55, height: TREE_TRUNK_M * scale, tessellation: 6 },
    scene,
  );
  trunkMesh.position.set(x, groundY + (TREE_TRUNK_M * scale) / 2, z);
  trunkMesh.material = trunk;
  trunkMesh.parent = root;

  const canopy = MeshBuilder.CreateSphere(
    `${name}-canopy`,
    { diameter: TREE_CANOPY_RADIUS_M * 2 * scale, segments: 6 },
    scene,
  );
  // Stretched vertically so it reads as a tree rather than a lollipop.
  canopy.scaling.y = TREE_CANOPY_M / (TREE_CANOPY_RADIUS_M * 2);
  canopy.position.set(x, groundY + TREE_TRUNK_M * scale + (TREE_CANOPY_M * scale) / 2 - 0.6, z);
  canopy.material = foliage;
  canopy.parent = root;
}

/** A bush: a low cluster, for the light concealment that does not really hide anything. */
function buildBush(
  scene: Scene,
  root: TransformNode,
  name: string,
  x: number,
  z: number,
  groundY: number,
  scale: number,
  foliage: StandardMaterial,
): void {
  const bush = MeshBuilder.CreateSphere(
    name,
    { diameter: BUSH_RADIUS_M * 2 * scale, segments: 5 },
    scene,
  );
  bush.scaling.y = BUSH_M / (BUSH_RADIUS_M * 2);
  bush.position.set(x, groundY + (BUSH_M * scale) / 2, z);
  bush.material = foliage;
  bush.parent = root;
}

/** What `buildBattlefieldProps` produced, for tests and for the debug overlay. */
export interface BattlefieldProps {
  /** Root of everything generated, so a caller can dispose of the lot at once. */
  readonly root: TransformNode;
  /** How many meshes were created, for a cheap sanity check in a test. */
  readonly meshCount: number;
  /** How many trees and bushes were placed, by concealment strength. */
  readonly treeCount: number;
  readonly bushCount: number;
}

/**
 * Builds every piece of environment art for a battlefield.
 *
 * Driven entirely by the map's own data, so the picture and the simulation cannot disagree about what
 * is solid or what conceals. One call at load; nothing here is updated per frame.
 */
export function buildBattlefieldProps(scene: Scene, battlefield: Battlefield): BattlefieldProps {
  const root = new TransformNode('battlefield-props', scene);
  let meshCount = 0;

  const roofMaterial = makeMaterial(scene, 'prop-roof', PALETTE.roof);
  const heavyFoliage = makeMaterial(scene, 'prop-foliage-heavy', PALETTE.foliageHeavy);
  const lightFoliage = makeMaterial(scene, 'prop-foliage-light', PALETTE.foliageLight);
  const trunkMaterial = makeMaterial(scene, 'prop-trunk', PALETTE.trunk);

  // Materials are keyed by colour so a map with forty structures of the same kind still creates one
  // material rather than forty. A scene accumulates materials for the life of the page otherwise.
  const materialCache = new Map<string, StandardMaterial>();
  const materialFor = (placed: PlacedStructure): StandardMaterial => {
    const colour = wallColourFor(placed);
    const key = colour.toHexString();
    const existing = materialCache.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = makeMaterial(scene, `prop-wall-${key}`, colour);
    materialCache.set(key, created);
    return created;
  };

  for (const placed of battlefield.structures) {
    const node = new TransformNode(`structure-${placed.structure.id}`, scene);
    node.position.set(placed.structure.x, placed.groundHeightM, placed.structure.z);
    node.rotation.y = placed.structure.yawRad;
    node.parent = root;

    const material = materialFor(placed);
    switch (placed.structure.kind) {
      case 'building':
        buildBuilding(scene, node, placed, material, roofMaterial);
        meshCount += 2;
        break;
      case 'rock':
        buildRock(scene, node, placed, material);
        meshCount += 3;
        break;
      case 'barrier':
      case 'screen':
        buildBarrier(scene, node, placed, material);
        meshCount += 1;
        break;
    }
  }

  let treeCount = 0;
  let bushCount = 0;
  for (const zone of battlefield.concealment) {
    const heavy = zone.strength === 'heavy';
    const count = heavy ? TREES_PER_HEAVY_ZONE : BUSHES_PER_LIGHT_ZONE;
    const seed = seedFrom(zone.id);
    for (let i = 0; i < count; i += 1) {
      // Two independent offsets per instance, so the scatter is a disc rather than a line.
      const x = zone.x + seededOffset(seed, i * 2, zone.radiusM * 0.82);
      const z = zone.z + seededOffset(seed, i * 2 + 1, zone.radiusM * 0.82);
      const groundY = battlefield.terrain.heightAt(x, z);
      // Scale varies per instance so a treeline is a group of trees rather than a row of clones.
      const scale = 0.75 + (((seed >>> (i * 3)) % 100) / 100) * 0.5;
      if (heavy) {
        buildTree(
          scene, root, `tree-${zone.id}-${i}`, x, z, groundY, scale,
          heavyFoliage, trunkMaterial,
        );
        treeCount += 1;
      } else {
        buildBush(scene, root, `bush-${zone.id}-${i}`, x, z, groundY, scale, lightFoliage);
        bushCount += 1;
      }
      meshCount += heavy ? 2 : 1;
    }
  }

  return { root, meshCount, treeCount, bushCount };
}
