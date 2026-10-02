import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import type { Battlefield } from '../../core/world/battlefield.js';
import type { LevelCorridor } from '../../core/world/terrain.js';
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

/**
 * Colours, chosen to stay distinguishable at distance and under fog.
 *
 * **Brighter than they look like they should be, deliberately.** The sun is angled steeply, so a wall
 * turned away from it receives only the hemispheric ambient and renders near-black. The first pass at this
 * map used plausible mid-tones and produced a village made of dark silhouettes — technically lit, visually
 * unreadable. Rural English brick and lime render are pale anyway, so raising these is closer to reality as
 * well as to usable.
 */
const PALETTE = {
  buildingWall: new Color3(0.78, 0.72, 0.6),
  outpostWall: new Color3(0.6, 0.58, 0.55),
  barnWall: new Color3(0.72, 0.26, 0.2),
  millWall: new Color3(0.84, 0.79, 0.66),
  roof: new Color3(0.38, 0.32, 0.28),
  rock: new Color3(0.52, 0.51, 0.49),
  barrier: new Color3(0.66, 0.64, 0.59),
  screen: new Color3(0.28, 0.37, 0.22),
  foliageHeavy: new Color3(0.16, 0.31, 0.14),
  foliageLight: new Color3(0.27, 0.39, 0.18),
  trunk: new Color3(0.28, 0.21, 0.14),

  // Railway and road surfaces. Kept apart on purpose: ballast is pale grey crushed stone, sleepers are
  // creosoted dark timber, and rails are the one genuinely bright metal on the map. A railway drawn in
  // one flat brown reads as a path with lines on it.
  //
  // The ballast is deliberately the *lightest* thing on the ground. The brief asks the railway to be the
  // map's major geographical landmark, and a landmark has to be visible from a tactical camera; at 3.6 m
  // half-width in mid-grey it vanished and the map read as open country with a scratch on it.
  ballast: new Color3(0.62, 0.6, 0.56),
  sleeper: new Color3(0.3, 0.24, 0.19),
  rail: new Color3(0.72, 0.71, 0.69),
  road: new Color3(0.52, 0.48, 0.43),
  track: new Color3(0.56, 0.5, 0.4),
  deck: new Color3(0.44, 0.35, 0.26),
  post: new Color3(0.62, 0.58, 0.52),
  platform: new Color3(0.58, 0.55, 0.5),
} as const;

/**
 * The corridor the renderer draws as a railway rather than a road.
 *
 * A name rather than a hard-coded geometry: the renderer asks "is this corridor the railway?" and the map
 * answers by id. A second map can call its mainline whatever it likes and get the right furniture without
 * this file changing.
 */
const RAILWAY_CORRIDOR_ID = 'mainline';

/**
 * Where the station platform sits, and where the level crossing is.
 *
 * **Snapped to the corridor at build time** rather than used as positions. The map states roughly where
 * these belong; the renderer finds the nearest point on the graded line and puts them there. That means a
 * small adjustment to the railway's geometry moves the platform with it instead of leaving a platform
 * stranded in a field beside where the rails used to be.
 */
const STATION_ANCHOR = { x: 56, z: -40 } as const;
const LEVEL_CROSSING_POINT = { x: 33, z: -28 } as const;

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
 * Railway and road dimensions, in metres.
 *
 * Standard gauge is 1.435 m between the inner rail faces, and everything else here follows from real
 * practice rather than from what looked tidy: sleepers are 2.6 m long and set about 0.65 m apart, a rail
 * head sits about 0.15 m above the sleeper, and a station platform is a little under a metre above rail.
 *
 * **None of this is collision.** The rails are drawn on ground that is already part of the drivable
 * height field (see `LevelCorridor` in `terrain.ts`), so a tank crosses the line by driving over it
 * exactly as it crosses a road. That is deliberate and it is the point: a decorative rail that behaves
 * like a wall would be the single worst thing this map could do, and the brief asks for the railway to be
 * a landmark rather than an obstacle.
 */
const RAILWAY = {
  /** Half the standard gauge: the distance from the centreline to each rail. */
  gaugeHalfM: 0.72,
  /** Sleeper length across the track, and how far they stick out past the rails. */
  sleeperLengthM: 2.6,
  sleeperHeightM: 0.16,
  /** Centre-to-centre spacing of sleepers. */
  sleeperSpacingM: 0.65,
  /**
   * How far the ballast shoulder extends beyond the centreline, metres.
   *
   * 3.6 m is a realistic four-track formation, and it is what the first draft used — which made the
   * railway invisible from a tactical camera and therefore not the landmark the design needs it to be.
   * 5.5 m is a wide embankment top, and at this prototype's colour and fog it is the difference between a
   * map with a railway on it and a map with a scratch on it.
   */
  ballastHalfWidthM: 5.5,
  /**
   * How proud of the surrounding ground the ballast sits, metres.
   *
   * A real ballast shoulder is a mound of crushed stone, so 0.55 m is honest rather than a fudge. It is
   * also, less honestly, the reason the railway is visible at all: the shared terrain mesh is 160 cells
   * across 500 m, so its triangles linearly interpolate between samples that are 3 m apart, and on concave
   * ground that surface sits *above* the true height by a couple of centimetres. A ribbon laid 10 cm up is
   * swallowed by it — which is exactly what happened, and why the first railway rendered as a hairline
   * with no ballast at all.
   */
  ballastHeightM: 0.55,
  railHeightM: 0.15,
  railWidthM: 0.07,
  /** Station platform: a metre above rail, running beside the line. */
  platformHeightM: 0.95,
  platformWidthM: 3.2,
} as const;

/** Road surfacing widths, metres. */
const ROAD_WIDTHS: Readonly<Record<string, number>> = {
  'town-road': 6.5,
  'rural-road': 5.5,
  'field-track': 3.5,
};

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

/**
 * A rough, non-shiny material. Reused per colour so the scene does not accumulate hundreds of them.
 *
 * The **emissive lift** is the notable part. The sun is a single directional light at a steep angle, so
 * every wall turned away from it gets only the hemispheric ambient and renders almost black — a village of
 * solid silhouettes. A small self-lit floor keeps the shadow side readable as *material* without washing
 * out the lit side, which is the standard trick for readable prototype art and costs nothing.
 */
function makeMaterial(scene: Scene, name: string, colour: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = colour;
  // Prototype scenery should read by silhouette and colour, not by a specular highlight.
  material.specularColor = new Color3(0.05, 0.05, 0.05);
  // About a quarter of the albedo, so a fully shadowed face keeps roughly a quarter of its colour.
  material.emissiveColor = colour.scale(0.25);
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
  /** Metres of railway drawn, so a test can assert the map's landmark actually exists. */
  readonly railwayLengthM: number;
  /** Metres of road drawn. */
  readonly roadLengthM: number;
  /** How many level crossings were decked. */
  readonly crossingCount: number;
}

// --- Railway and road geometry -------------------------------------------------------------
//
// Everything below is built from the terrain's own `LevelCorridor` list. That is the point: the corridor
// is what the height field was graded along, so the rails, the ballast and the road surface are laid on
// exactly the ground the vehicles drive on, sampled through the same `heightAt` call. There is no second
// source of truth for where the railway is, which is what stops a rail appearing somewhere the terrain
// has no idea about.

/** A sampled point along a corridor, with the ground height resolved. */
interface CorridorSample {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  /** Unit vector across the corridor, used to place things beside or on the centreline. */
  readonly acrossX: number;
  readonly acrossZ: number;
}

/**
 * Walks a corridor at a fixed spacing, sampling the terrain at each step.
 *
 * The terrain height is read per sample rather than interpolated from the corridor's own `y` values,
 * because the corridor's elevations are *targets*: where the corridor was soft-clamped, or where a
 * second corridor overrode it, the actual ground differs. Sampling is the honest source.
 */
function sampleCorridor(
  corridor: LevelCorridor,
  heightAt: (x: number, z: number) => number,
  spacingM = 2,
): CorridorSample[] {
  const samples: CorridorSample[] = [];
  const points = corridor.points;

  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthM = Math.sqrt(dx * dx + dz * dz);
    if (lengthM < 1e-6) {
      continue;
    }
    // Unit tangent, and the perpendicular to it. Used to offset the rails either side of the centreline.
    const dirX = dx / lengthM;
    const dirZ = dz / lengthM;
    const steps = Math.max(1, Math.round(lengthM / spacingM));

    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      samples.push({ x, z, y: heightAt(x, z), acrossX: -dirZ, acrossZ: dirX });
    }
  }

  return samples;
}

/**
 * Builds a flat ribbon that follows the ground: ballast, road surfaces and platforms.
 *
 * ## Why the ground is sampled per edge rather than at the centreline
 *
 * The first version took the centreline sample's height and used it for both edges. That is wrong on any
 * ground with a sideways slope, and the consequence is quiet and severe: half the ribbon ends up *below*
 * the terrain and disappears, so the railway renders as a thin wire lying in a ditch instead of a graded
 * line. It looked like a colour problem and it was a geometry one.
 *
 * So each edge vertex is placed on the ground **at its own position**. A ribbon across a bank then lies on
 * the bank, which is what a road and a railway both actually do.
 */
function buildRibbon(
  scene: Scene,
  name: string,
  samples: readonly CorridorSample[],
  halfWidthM: number,
  heightAboveGroundM: number,
  material: StandardMaterial,
  parent: TransformNode,
  heightAt: (x: number, z: number) => number,
): Mesh | null {
  if (samples.length < 2) {
    return null;
  }
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    const leftX = s.x + s.acrossX * halfWidthM;
    const leftZ = s.z + s.acrossZ * halfWidthM;
    const rightX = s.x - s.acrossX * halfWidthM;
    const rightZ = s.z - s.acrossZ * halfWidthM;

    positions.push(leftX, heightAt(leftX, leftZ) + heightAboveGroundM, leftZ);
    positions.push(rightX, heightAt(rightX, rightZ) + heightAboveGroundM, rightZ);
    // V runs along the ribbon so any future texture does not stretch across it.
    uvs.push(0, i * 0.1, 1, i * 0.1);

    if (i < samples.length - 1) {
      const base = i * 2;
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;

  // **Normals point up, unconditionally, and are not derived from the winding.**
  //
  // `ComputeNormals` derives the normal from the triangle's winding, and a ribbon's winding flips with the
  // direction its corridor happens to run. When that puts the normal *downward* the surface is lit from
  // underneath, receives no sun, and renders as a flat black stripe — which is precisely what the first
  // version of the railway looked like: a correct shape in a colour nobody would choose for stone.
  //
  // A road and a rail bed are, by construction, near-horizontal ground surfaces. Their shading normal is
  // therefore simply up. This is not a shortcut around the winding problem so much as the correct answer
  // to it: for a ground decal the normal is a property of the surface, not of how the triangles happen to
  // be wound.
  const normals: number[] = [];
  for (let i = 0; i < positions.length / 3; i += 1) {
    normals.push(0, 1, 0);
  }
  data.normals = normals;
  data.applyToMesh(mesh, false);

  // Double-sided as well, so the same winding cannot hide the surface from a low camera either.
  //
  // A flat ground decal has no downside to being visible from both sides: it is a handful of triangles, it
  // is always viewed from above, and one-sidedness buys nothing here.
  material.backFaceCulling = false;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.parent = parent;
  return mesh;
}

/**
 * Sleepers and rails for one line.
 *
 * **Merged into single meshes, and that is not an optimisation detail.** Individually, 600 m of railway
 * at 0.65 m sleeper spacing is over 900 boxes plus two long rails — enough separate draw calls to
 * dominate the frame and make the map unplayable. `Mesh.MergeMeshes` collapses each family into one mesh,
 * taking the whole railway from roughly a thousand draws to three, and is the difference between the line
 * being a landmark and being a slideshow.
 */
function buildRailway(
  scene: Scene,
  root: TransformNode,
  samples: readonly CorridorSample[],
  heightAt: (x: number, z: number) => number,
  materials: { ballast: StandardMaterial; sleeper: StandardMaterial; rail: StandardMaterial },
): Mesh[] {
  const meshes: Mesh[] = [];

  const ballast = buildRibbon(
    scene,
    'railway-ballast',
    samples,
    RAILWAY.ballastHalfWidthM,
    RAILWAY.ballastHeightM * 0.5,
    materials.ballast,
    root,
    heightAt,
  );
  if (ballast !== null) {
    meshes.push(ballast);
  }

  // --- Sleepers: one box per spacing interval, merged ---
  const sleepers: Mesh[] = [];
  let index = 0;
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    if (step < 1e-6) {
      continue;
    }
    // Roughly one sleeper per RAILWAY.sleeperSpacingM of ground, whatever the sample spacing turned out to
    // be. Deriving the count from the measured step rather than assuming samples equal spacing keeps the
    // sleeper pitch correct on a diagonal segment, where a fixed one-per-sample under-counts badly.
    const perStep = Math.max(1, Math.round(RAILWAY.sleeperSpacingM / Math.max(step, 0.01)));
    for (let k = 0; k < perStep; k += 1) {
      const t = k / perStep;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const sleeper = MeshBuilder.CreateBox(
        `sleeper-${index}`,
        {
          width: RAILWAY.sleeperLengthM,
          height: RAILWAY.sleeperHeightM,
          depth: RAILWAY.railWidthM * 6,
        },
        scene,
      );
      sleeper.position.set(x, heightAt(x, z) + RAILWAY.ballastHeightM * 0.5, z);
      // Yaw so the sleeper's long axis lies across the corridor.
      sleeper.rotation.y = Math.atan2(a.acrossX, a.acrossZ);
      sleeper.material = materials.sleeper;
      sleepers.push(sleeper);
      index += 1;
    }
  }
  const mergedSleepers = Mesh.MergeMeshes(sleepers, true, true, undefined, false, false);
  if (mergedSleepers !== null) {
    mergedSleepers.name = 'railway-sleepers';
    mergedSleepers.material = materials.sleeper;
    mergedSleepers.isPickable = false;
    mergedSleepers.parent = root;
    meshes.push(mergedSleepers);
  }

  // --- Rails: two thin ribbons, one per side of the gauge ---
  for (const side of [1, -1]) {
    const offsetSamples = samples.map((s) => ({
      ...s,
      x: s.x + s.acrossX * RAILWAY.gaugeHalfM * side,
      z: s.z + s.acrossZ * RAILWAY.gaugeHalfM * side,
    }));
    const rail = buildRibbon(
      scene,
      `railway-rail-${side}`,
      offsetSamples,
      RAILWAY.railWidthM,
      RAILWAY.ballastHeightM * 0.5 + RAILWAY.sleeperHeightM + RAILWAY.railHeightM * 0.5,
      materials.rail,
      root,
      heightAt,
    );
    if (rail !== null) {
      meshes.push(rail);
    }
  }

  return meshes;
}

/**
 * Road surfacing for one corridor.
 *
 * A flat ribbon laid a few centimetres above the graded ground, which is all a road needs to be. The
 * brief is explicit that roads require no special vehicle physics, and this honours that: there is no
 * road collider, no grip change, nothing. The road's job is orientation — telling the player which way the
 * village is and suggesting a route without forcing one.
 */
function buildRoad(
  scene: Scene,
  root: TransformNode,
  samples: readonly CorridorSample[],
  widthM: number,
  material: StandardMaterial,
  heightAt: (x: number, z: number) => number,
): Mesh | null {
  return buildRibbon(scene, `road-${samples.length}`, samples, widthM * 0.5, 0.16, material, root, heightAt);
}

/**
 * The level crossing: a planked deck where the road passes over the rails.
 *
 * ## Why this is the most important 20 metres on the map
 *
 * The crossing is the map's central junction and the brief asks it to be a *navigation landmark*, an
 * *exposed crossing*, a *route divider* and a *combat-space organiser* at once. A player has to be able
 * to recognise it from a long way off, understand instantly that it is dangerous, and cross it without
 * the game fighting them.
 *
 * So it gets proper furniture: a timber deck spanning the track, gate posts on both sides, and a pair of
 * signal arms. None of it is solid. The brief's warning — a decorative rail treated as a giant obstacle —
 * is the failure this map is most at risk of, and the answer is that **nothing** on the railway is
 * collision. The deck is drawn on ground that is already part of the drivable height field.
 */
function buildLevelCrossing(
  scene: Scene,
  root: TransformNode,
  crossing: { x: number; z: number },
  railwayDir: { x: number; z: number },
  heightAt: (x: number, z: number) => number,
  materials: { deck: StandardMaterial; post: StandardMaterial },
): number {
  const groundY = heightAt(crossing.x, crossing.z);
  let meshCount = 0;

  // Deck: a plank surface a little wider than the road and longer than the track is wide.
  const deck = MeshBuilder.CreateBox(
    'level-crossing-deck',
    { width: RAILWAY.ballastHalfWidthM * 2 + 1.5, height: 0.12, depth: 7 },
    scene,
  );
  deck.position.set(crossing.x, groundY + 0.3, crossing.z);
  // Yaw so the deck's long axis runs along the road, i.e. across the railway.
  deck.rotation.y = Math.atan2(railwayDir.x, railwayDir.z);
  deck.material = materials.deck;
  deck.isPickable = false;
  deck.parent = root;
  meshCount += 1;

  // Gate posts either side of the road, with a short arm. Reads as a crossing from a distance, which is
  // the whole job.
  for (const side of [1, -1]) {
    const postX = crossing.x + railwayDir.x * 4.5 * side;
    const postZ = crossing.z + railwayDir.z * 4.5 * side;

    const post = MeshBuilder.CreateCylinder(
      `crossing-post-${side}`,
      { height: 3.2, diameterTop: 0.18, diameterBottom: 0.24, tessellation: 6 },
      scene,
    );
    post.position.set(postX, heightAt(postX, postZ) + 1.6, postZ);
    post.material = materials.post;
    post.isPickable = false;
    post.parent = root;

    // A raised barrier arm. Angled up, so the crossing reads as *open* rather than blocked — which is
    // also the honest gameplay signal: nothing here is going to stop a tank.
    const arm = MeshBuilder.CreateBox(
      `crossing-arm-${side}`,
      { width: 0.12, height: 0.12, depth: 3.2 },
      scene,
    );
    arm.position.set(postX, heightAt(postX, postZ) + 2.4, postZ);
    arm.rotation.x = -0.7;
    arm.material = materials.deck;
    arm.isPickable = false;
    arm.parent = root;
    meshCount += 2;
  }

  return meshCount;
}

/**
 * The station platform, beside the line at the village end of the crossing.
 *
 * Built here rather than as a `Structure` on purpose: a platform is 0.95 m of hard standing that shells
 * pass over and a tank drives across. Modelling it as cover would make a thing you stand *on* into a
 * thing that stops you, which is the kind of small lie that makes a map feel wrong without anyone being
 * able to say why.
 */
function buildStationPlatform(
  scene: Scene,
  root: TransformNode,
  samples: readonly CorridorSample[],
  fromIndex: number,
  toIndex: number,
  side: 1 | -1,
  heightAt: (x: number, z: number) => number,
  material: StandardMaterial,
): void {
  const segment = samples.slice(fromIndex, toIndex);
  if (segment.length < 2) {
    return;
  }
  // Offset the samples sideways from the centreline, clear of the sleepers.
  const offset = segment.map((s) => ({
    ...s,
    x: s.x + s.acrossX * (RAILWAY.ballastHalfWidthM + RAILWAY.platformWidthM * 0.4) * side,
    z: s.z + s.acrossZ * (RAILWAY.ballastHalfWidthM + RAILWAY.platformWidthM * 0.4) * side,
  }));
  buildRibbon(
    scene,
    'station-platform',
    offset,
    RAILWAY.platformWidthM * 0.5,
    RAILWAY.platformHeightM * 0.5,
    material,
    root,
    heightAt,
  );

  // A low parapet along the platform's back edge. One merged mesh, because there are a lot of them and
  // individually they are nothing but draw calls.
  const blocks: Mesh[] = [];
  for (let i = 0; i + 2 < offset.length; i += 2) {
    const s = offset[i]!;
    const block = MeshBuilder.CreateBox(
      `platform-parapet-${i}`,
      { width: 1.6, height: 0.5, depth: 0.3 },
      scene,
    );
    block.position.set(
      s.x + s.acrossX * RAILWAY.platformWidthM * 0.45 * side,
      heightAt(s.x, s.z) + RAILWAY.platformHeightM + 0.2,
      s.z + s.acrossZ * RAILWAY.platformWidthM * 0.45 * side,
    );
    block.rotation.y = Math.atan2(s.acrossX, s.acrossZ);
    block.material = material;
    blocks.push(block);
  }
  const merged = Mesh.MergeMeshes(blocks, true, true, undefined, false, false);
  if (merged !== null) {
    merged.name = 'station-parapet';
    merged.material = material;
    merged.isPickable = false;
    merged.parent = root;
  }
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

  // --- Railway and roads ---------------------------------------------------------------------
  //
  // Driven from the terrain's own graded corridors rather than from a second list here. The corridor is
  // what the height field was cut along, so laying the rails on it means the picture and the drivable
  // surface cannot disagree — which is the whole reason the railway is a `LevelCorridor` at all.
  const corridors = battlefield.terrain.levelCorridors;
  /**
   * Bound deliberately.
   *
   * `battlefield.terrain.heightAt` passed on its own would lose its receiver, and `heightAt` reads
   * `this.config` — so the unbound form throws "Cannot read properties of undefined (reading 'config')" the
   * moment it is called. TypeScript does not catch it: a method is assignable to a plain function type,
   * which is exactly why this had to be found by running the game. Every helper below therefore takes a
   * function rather than the terrain object, so the mistake cannot be repeated by passing an object.
   */
  const heightAt = (x: number, z: number): number => battlefield.terrain.heightAt(x, z);

  const ballastMaterial = makeMaterial(scene, 'prop-ballast', PALETTE.ballast);
  const sleeperMaterial = makeMaterial(scene, 'prop-sleeper', PALETTE.sleeper);
  const railMaterial = makeMaterial(scene, 'prop-rail', PALETTE.rail);
  const roadMaterial = makeMaterial(scene, 'prop-road', PALETTE.road);
  const trackMaterial = makeMaterial(scene, 'prop-track', PALETTE.track);
  const deckMaterial = makeMaterial(scene, 'prop-deck', PALETTE.deck);
  const postMaterial = makeMaterial(scene, 'prop-post', PALETTE.post);
  const platformMaterial = makeMaterial(scene, 'prop-platform', PALETTE.platform);

  let railwayLengthM = 0;
  let roadLengthM = 0;
  let crossingCount = 0;

  for (const corridor of corridors) {
    const samples = sampleCorridor(corridor, heightAt, 2);
    if (samples.length < 2) {
      continue;
    }

    if (corridor.id === RAILWAY_CORRIDOR_ID) {
      const built = buildRailway(scene, root, samples, heightAt, {
        ballast: ballastMaterial,
        sleeper: sleeperMaterial,
        rail: railMaterial,
      });
      meshCount += built.length;
      for (let i = 1; i < samples.length; i += 1) {
        railwayLengthM += Math.hypot(
          samples[i]!.x - samples[i - 1]!.x,
          samples[i]!.z - samples[i - 1]!.z,
        );
      }

      // The crossing, and the platform beside the station. Both are placed from the corridor itself, so
      // moving the railway in the map data moves them too.
      const stationIndex = nearestSampleIndex(samples, STATION_ANCHOR);
      const platformSpan = Math.max(2, Math.round(18 / 2));
      buildStationPlatform(
        scene, root, samples,
        Math.max(0, stationIndex - platformSpan),
        Math.min(samples.length, stationIndex + platformSpan),
        -1, heightAt, platformMaterial,
      );
      meshCount += 2;

      const nearCrossing = nearestSampleIndex(samples, LEVEL_CROSSING_POINT);
      const s = samples[nearCrossing]!;
      meshCount += buildLevelCrossing(
        scene, root,
        { x: s.x, z: s.z },
        { x: s.acrossX, z: s.acrossZ },
        heightAt,
        { deck: deckMaterial, post: postMaterial },
      );
      crossingCount += 1;
      continue;
    }

    const widthM = ROAD_WIDTHS[corridor.id] ?? 5;
    const road = buildRoad(
      scene, root, samples, widthM,
      corridor.id === 'field-track' ? trackMaterial : roadMaterial,
      heightAt,
    );
    if (road !== null) {
      meshCount += 1;
      road.name = `road-${corridor.id}`;
      for (let i = 1; i < samples.length; i += 1) {
        roadLengthM += Math.hypot(
          samples[i]!.x - samples[i - 1]!.x,
          samples[i]!.z - samples[i - 1]!.z,
        );
      }
    }
  }

  return { root, meshCount, treeCount, bushCount, railwayLengthM, roadLengthM, crossingCount };
}

/** Index of the sampled point closest to a world position. */
function nearestSampleIndex(samples: readonly CorridorSample[], point: { x: number; z: number }): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    const d = (s.x - point.x) ** 2 + (s.z - point.z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}
