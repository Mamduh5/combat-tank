/**
 * Builds every V7 asset: the two tank models, the texture set, and the sound set.
 *
 * Run with `npm run assets`. Output lands in `public/assets/` and is committed, because these are project
 * artefacts rather than build output â€” the game loads them at runtime, and an artist replacing one should be
 * able to do so without running Node.
 *
 * ## Why a build step at all
 *
 * Two reasons, and both are about the *pipeline* rather than the files:
 *
 *  1. **The generators are the provenance record.** `docs/asset-provenance.md` can say "generated in-project"
 *    and point at the exact code that chose each pixel and each waveform, which is a stronger claim than a
 *    licence file attached to a downloaded archive. Anyone can regenerate and diff.
 *  2. **Regeneration must be deterministic.** The whole texture and sound set is driven by an integer hash
 *    rather than `Math.random`, so re-running this produces byte-identical output and a change in the
 *    repository always means a change in the art, never noise.
 *
 * ## What is written
 *
 * ```
 * public/assets/
 *   models/ct-medium.glb        the player tank, textures embedded
 *   models/ct-heavy.glb         the enemy tank, textures embedded
 *   textures/*.png              shared environment and decal textures, loaded at runtime
 *   audio/*.wav                 the sound set, loaded at runtime
 * ```
 *
 * The tank models embed their own textures inside the GLB, because a vehicle that needs a second file to
 * render is a vehicle that can render half-finished. The environment textures are separate, because many
 * different meshes share them and duplicating them per model would be pure waste.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GltfBuilder, quaternionY } from './lib/gltf.mjs';
import { encodePng } from './lib/png.mjs';
import * as TEXTURES from './lib/textures.mjs';
import * as SOUNDS from './lib/sounds.mjs';
import { encodeWav, normalize, fadeEdges, makeSeamless } from './lib/wav.mjs';
import { buildTankModel } from './lib/tank-model.mjs';
import {
  tree,
  bush,
  hedgerow,
  rock,
  telegraphPole,
  crossingGate,
  signalPost,
  stationBuilding,
} from './lib/prop-models.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public', 'assets');

/** Sizes written per category, kept here so the report and the files cannot disagree. */
const report = [];
function record(kind, name, bytes, extra = '') {
  report.push({ kind, name, bytes, extra });
}

/** Every file this run produced, relative to `OUT`. Drives the orphan prune at the end. */
const writtenPaths = new Set();

/** Writes a file, creating its directory, and records it in the build report. */
function write(relativePath, buffer, kind, extra = '') {
  const full = join(OUT, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buffer);
  writtenPaths.add(relativePath.split(/[\\/]/).join('/'));
  record(kind, relativePath, buffer.length, extra);
  return full;
}

/**
 * Deletes anything in `OUT` that this run did not write.
 *
 * Run only after every asset has been built successfully, which is what makes it safe to write over the top
 * rather than wiping first. Its purpose is unchanged: a renamed texture must not leave an orphan behind that
 * still looks plausible in the manifest.
 */
function pruneOrphans() {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        // Remove directories left empty by the prune, deepest first, so the tree does not accumulate husks.
        if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
        continue;
      }
      const relative = full.slice(OUT.length + 1).split(/[\\/]/).join('/');
      if (!writtenPaths.has(relative)) {
        rmSync(full, { force: true });
        console.log(`  removed orphan ${relative}`);
      }
    }
  };
  walk(OUT);
}

/**
 * Rejects geometry containing NaN or Infinity before it can reach a `.glb`.
 *
 * This guard exists because of a bug that every other gate passed. Five proportion fields the hull builder read
 * were never supplied by `deriveDimensions`, so `widthM * undefined` produced NaN and 252 of the hull's 492
 * vertices were written as NaN. The file was a structurally valid GLB: it loaded, it parsed, it rendered, and
 * Babylon produced a *finite* bounding box from the 240 vertices that had survived. The tank was simply 26%
 * too short, and the only symptom a player would ever see was that it looked a bit small.
 *
 * The build reported success. Lint passed. TypeScript passed. Unit tests passed, because none of them read the
 * vertex data.
 *
 * A non-finite coordinate is not a rendering problem to be discovered downstream â€” it is a defect in the
 * source numbers, and the only place it can be caught cheaply is here, at the moment the numbers are written.
 * Failing the build is the correct outcome: a malformed asset must never ship because the pipeline was pleased
 * to emit a file.
 */
function assertFiniteGeometry(label, mesh) {
  const positions = mesh?.positions;
  if (!Array.isArray(positions)) {
    return;
  }
  for (let i = 0; i < positions.length; i += 1) {
    const value = positions[i];
    if (typeof value === 'number' && !Number.isFinite(value)) {
      // Report the vertex index rather than just "NaN found": the index is what makes the failure locatable,
      // since the mesh is assembled from a dozen separate box calls with no labels of its own.
      throw new Error(
        `build-assets: ${label} has a non-finite position (${String(value)}) at component ${i} ` +
          `(vertex ${Math.floor(i / 3)}, axis ${['x', 'y', 'z'][i % 3]}). ` +
          `This is almost always a dimension field read as undefined â€” check deriveDimensions in tank-model.mjs.`,
      );
    }
  }
}

/**
 * Registers one texture set (albedo / normal / metallic-roughness) and returns its three indices.
 *
 * Every material needs the same three, so this is the single place that knows the naming convention. It is
 * what lets the material list below read as a list of *surfaces* rather than as three times as many lines.
 */
function addTextureSet(gltf, name, set) {
  return {
    albedo: gltf.addTexture(encodePng(SIZE_OF(set.albedo), SIZE_OF(set.albedo), set.albedo, 3), {
      name: `${name}-albedo`,
    }),
    normal: gltf.addTexture(encodePng(SIZE_OF(set.normal), SIZE_OF(set.normal), set.normal, 3), {
      name: `${name}-normal`,
    }),
    metallicRoughness: gltf.addTexture(
      encodePng(SIZE_OF(set.metallicRoughness), SIZE_OF(set.metallicRoughness), set.metallicRoughness, 3),
      { name: `${name}-mr` },
    ),
  };
}

/** Square textures only, so the length of the buffer is the size. Asserted rather than assumed. */
function SIZE_OF(pixels) {
  const n = pixels.length / 3;
  const side = Math.round(Math.sqrt(n));
  if (side * side !== n) {
    throw new Error(`expected a square RGB texture, got ${n} pixels`);
  }
  return side;
}


/**
 * Every vehicle model, in one table.
 *
 * ## Why this is a table rather than three calls
 *
 * Adding a vehicle used to mean adding a `buildTankGlb` call, a `PAINTS` entry, a `write`, a `console.log`
 * and a manifest entry â€” five separate places to remember, and forgetting any one produced a *partial*
 * result rather than a failure. A model built but never registered simply does not load; a manifest entry
 * with no model behind it 404s. Both are the class of defect the V7 recovery pass was spent on.
 *
 * One table makes the roster the unit of work: a vehicle listed here is built, written, printed and
 * recorded together, or the build throws. Adding a fourth vehicle is one array entry.
 *
 * `vehicleId` is the `visualId` a `VehicleDefinition` carries to select this model, so it is spelled here
 * once rather than maintained in parallel in the runtime manifest.
 */
const VEHICLE_MODELS = [
  { variant: 'medium', file: 'models/ct-medium.glb', vehicleId: 'ct-medium' },
  { variant: 'heavy', file: 'models/ct-heavy.glb', vehicleId: 'ct-heavy' },
  { variant: 'light', file: 'models/ct-light.glb', vehicleId: 'ct-light' },
];

/**
 * Builds one tank model into a `.glb`.
 *
 * The node hierarchy written here is the **asset contract** the runtime loader depends on. If a name changes
 * in this function it must change in `src/client/render/vehicle-asset.ts` and in `docs/asset-pipeline.md`
 * together â€” which is why the names are written out literally rather than assembled from a template.
 *
 * @param {'medium'|'heavy'|'light'} variant
 * @param {number[]} paintRgb linear base-colour tint for the vehicle's paint
 */
function buildTankGlb(variant, paintRgb) {
  const { spec, dimensions, parts } = buildTankModel(variant);
  const gltf = new GltfBuilder({ generator: 'combat-tank asset pipeline (tools/build-assets.mjs)' });

  // --- Materials -------------------------------------------------------------------------
  // Three textured materials plus one plain, not one per part. Paint covers hull and turret and is tinted per
  // vehicle; steel covers tracks, running gear, and the gun; rubber covers tyres; dark metal covers fittings.
  const paint = addTextureSet(gltf, 'tank-paint', TEXTURES.tankPaint(paintRgb));
  const steel = addTextureSet(gltf, 'track-steel', TEXTURES.trackSteel());
  const rubber = addTextureSet(gltf, 'rubber', TEXTURES.rubber());

  // metallicFactor/roughnessFactor of 1 mean "read them from the map". The texture carries per-texel
  // variation â€” chipped paint is rougher than bare metal â€” which a scalar could not express.
  const matPaint = gltf.addMaterial({
    name: 'tank-paint',
    baseColorFactor: [1, 1, 1, 1],
    baseColorTexture: paint.albedo,
    normalTexture: paint.normal,
    metallicRoughnessTexture: paint.metallicRoughness,
    metallicFactor: 1,
    roughnessFactor: 1,
  });
  const matSteel = gltf.addMaterial({
    name: 'track-steel',
    baseColorTexture: steel.albedo,
    normalTexture: steel.normal,
    metallicRoughnessTexture: steel.metallicRoughness,
    metallicFactor: 1,
    roughnessFactor: 1,
  });
  const matRubber = gltf.addMaterial({
    name: 'rubber',
    baseColorTexture: rubber.albedo,
    normalTexture: rubber.normal,
    metallicRoughnessTexture: rubber.metallicRoughness,
    metallicFactor: 1,
    roughnessFactor: 1,
  });

  // --- Meshes ----------------------------------------------------------------------------
  // Validated before anything is written. See assertFiniteGeometry: malformed vertex data produces a file
  // that loads cleanly and renders wrong, which is the least detectable kind of asset bug there is.
  assertFiniteGeometry('hull', parts.hull.mesh);
  assertFiniteGeometry('turret', parts.turret.mesh);
  assertFiniteGeometry('gun', parts.gun.mesh);
  assertFiniteGeometry('wheel', parts.wheels[0].mesh);
  assertFiniteGeometry('track', parts.tracks[0].mesh);

  const meshHull = gltf.addMesh('hull', parts.hull.mesh, matPaint);
  const meshTurret = gltf.addMesh('turret', parts.turret.mesh, matPaint);
  const meshGun = gltf.addMesh('gun', parts.gun.mesh, matSteel);

  // Wheels and track segments each reuse one mesh across every instance. Eight wheels costing one mesh
  // instead of eight is the difference between a model and a prototype at poly-count level, and it is why
  // the wheel and segment meshes are built once and referenced repeatedly.
  const meshWheel = gltf.addMesh('wheel', parts.wheels[0].mesh, matRubber);
  const meshTrack = gltf.addMesh('track', parts.tracks[0].mesh, matSteel);

  // --- Nodes -----------------------------------------------------------------------------
  // `Hull` sits at the origin: the centre of the track contact line, on the vehicle's own centreline. That
  // is the contract â€” the loader places this node straight at the simulation's hull position, and no offset
  // math exists anywhere in gameplay code.
  const hullNode = gltf.addNode({ name: 'Hull', mesh: meshHull, translation: parts.hull.position });
  const turretNode = gltf.addNode({ name: 'Turret', mesh: meshTurret, translation: parts.turret.position });
  const gunNode = gltf.addNode({ name: 'Gun', mesh: meshGun, translation: parts.gun.position });

  // The muzzle marker: an empty node at the barrel's exit, carrying no mesh. Effects and the gun report read
  // its world position rather than re-deriving "somewhere near the end of the barrel" in gameplay code.
  const muzzleNode = gltf.addNode({ name: 'Muzzle', translation: parts.muzzle.position });

  const wheelNodes = parts.wheels.map((w) =>
    gltf.addNode({ name: w.name, mesh: meshWheel, translation: w.position }),
  );
  const trackNodes = parts.tracks.map((t) =>
    gltf.addNode({ name: t.name, mesh: meshTrack, translation: t.position }),
  );

  // Parenting expresses the mechanical relationships the simulation already models: `Gun` is a child of
  // `Turret`, `Muzzle` of `Gun`, so rotating the turret carries the gun and the muzzle with it
  // automatically. Rotating the hull then carries the whole vehicle.
  gltf.nodes[gunNode].children = [muzzleNode];
  gltf.nodes[turretNode].children = [gunNode];

  // The handedness node: one rotation on one node is the entire authored-space â†’ glTF-space conversion, and
  // the loader's documented contract accounts for it. Baking it into every vertex instead would make the
  // file harder to read and impossible to verify by eye.
  const root = gltf.addNode({
    name: 'Tank',
    children: [hullNode, turretNode, ...wheelNodes, ...trackNodes],
    rotation: quaternionY(Math.PI),
  });
  gltf.sceneRoots.push(root);

  return {
    glb: gltf.build(),
    spec,
    dimensions,
    stats: {
      meshes: gltf.meshes.length,
      nodes: gltf.nodes.length,
      triangles: gltf.accessors.reduce(
        (sum, a) => sum + (a.type === 'SCALAR' ? a.count / 3 : 0),
        0,
      ),
    },
  };
}

/**
 * Builds the environment prop library into a `.glb`.
 *
 * Every prop is built **once** at its natural size and instanced by the runtime. That matters at Marlowe's
 * scale: the map places hundreds of trees, bushes, and rocks, and unique geometry for each would be both a
 * larger file and far more draw calls than the scene can afford. The runtime uses thin instances for
 * repeated props and ordinary instances for one-offs.
 *
 * Per-instance variation comes from the runtime's own scale and rotation plus the seeded jitter these meshes
 * are authored with â€” not from duplicating geometry.
 */
function buildPropsGlb() {
  const gltf = new GltfBuilder({ generator: 'combat-tank asset pipeline (tools/build-assets.mjs)' });

  // One texture per surface family, shared across every prop that uses it. This is the "coherent smaller asset
  // set" the brief asks for, rather than a random mixture of unrelated materials.
  const foliageTex = addTextureSet(gltf, 'foliage', TEXTURES.foliage());
  const stoneTex = addTextureSet(gltf, 'stone', TEXTURES.stone());
  const timberTex = addTextureSet(gltf, 'timber', TEXTURES.timber());
  const railTex = addTextureSet(gltf, 'rail', TEXTURES.railSteel());
  const ironTex = addTextureSet(gltf, 'painted-steel', TEXTURES.paintedSteel());
  const brickTex = addTextureSet(gltf, 'brick', TEXTURES.brick());

  const textured = (name, tex, extra = {}) =>
    gltf.addMaterial({
      name,
      baseColorTexture: tex.albedo,
      normalTexture: tex.normal,
      metallicRoughnessTexture: tex.metallicRoughness,
      // 1/1 means "read them from the map": the texture carries per-texel variation a scalar cannot.
      metallicFactor: 1,
      roughnessFactor: 1,
      ...extra,
    });

  const mats = {
    foliage: textured('foliage', foliageTex),
    // A darker tint rather than a second texture: canopy lobes read as separate masses under one directional
    // light, which is what stops a tree looking like a green ball. Equivalent here, half the memory.
    foliageDark: textured('foliage-dark', foliageTex, { baseColorFactor: [0.72, 0.74, 0.72, 1] }),
    stone: textured('stone', stoneTex),
    timber: textured('timber', timberTex),
    rail: textured('rail-steel', railTex),
    iron: textured('painted-steel', ironTex),
    brick: textured('brick', brickTex),
    plain: gltf.addMaterial({
      name: 'plain-painted',
      baseColorFactor: [0.85, 0.85, 0.87, 1],
      metallicFactor: 0.1,
      roughnessFactor: 0.7,
    }),
    red: gltf.addMaterial({
      name: 'signal-red',
      baseColorFactor: [0.85, 0.2, 0.15, 1],
      metallicFactor: 0.05,
      roughnessFactor: 0.7,
    }),
    dark: gltf.addMaterial({
      name: 'dark-metal',
      baseColorFactor: [0.24, 0.24, 0.26, 1],
      metallicFactor: 0.6,
      roughnessFactor: 0.55,
    }),
    glass: gltf.addMaterial({
      name: 'window-glass',
      baseColorFactor: [0.16, 0.19, 0.21, 1],
      metallicFactor: 0.35,
      roughnessFactor: 0.22,
    }),
    door: gltf.addMaterial({
      name: 'door',
      baseColorFactor: [0.35, 0.42, 0.4, 1],
      metallicFactor: 0.05,
      roughnessFactor: 0.65,
    }),
    chimney: textured('chimney-brick', brickTex, { baseColorFactor: [0.86, 0.84, 0.82, 1] }),
  };

  // --- Prop meshes ----------------------------------------------------------------------
  // A few size variants each, because a treeline of one identical tree reads as wallpaper. Four is enough
  // for the eye to stop seeing the repeat while costing four meshes rather than four hundred.
  const nodes = [];
  const add = (name, mesh, material) => {
    nodes.push(gltf.addNode({ name, mesh: gltf.addMesh(name, mesh, material) }));
  };

  for (let i = 0; i < 4; i += 1) {
    add(`tree-${i}`, tree(5.4 + i * 0.9, 2.4 + i * 0.35, i * 7 + 1), i % 2 === 0 ? mats.foliage : mats.foliageDark);
  }
  for (let i = 0; i < 3; i += 1) {
    add(`bush-${i}`, bush(1.4 + i * 0.3, i * 5 + 2), mats.foliageDark);
  }
  for (let i = 0; i < 4; i += 1) {
    add(`rock-${i}`, rock(0.6 + i * 0.45, i * 11 + 3), mats.stone);
  }
  for (let i = 0; i < 3; i += 1) {
    add(`hedge-${i}`, hedgerow(6 + i * 2, 1.5 + i * 0.2, i * 3 + 5), mats.foliageDark);
  }

  // Railway and crossing furniture.
  add('telegraph-a', telegraphPole(7.4, 0), mats.timber);
  add('telegraph-b', telegraphPole(7.0, 1), mats.timber);
  add('crossing-gate', crossingGate(), mats.plain);
  add('signal-post', signalPost(6.2), mats.iron);

  // The station building, plus a separate roof mesh so the runtime can use the roofing-iron material on it
  // and the brick material on the walls â€” two materials on one building is what stops it reading as a block.
  add('station-walls', stationBuilding(9, 6.5, 3.6), mats.brick);
  add('station-trim', stationBuilding(9, 6.5, 3.6), mats.iron);

  const root = gltf.addNode({ name: 'Props', children: nodes });
  gltf.sceneRoots.push(root);

  return { glb: gltf.build(), stats: { meshes: gltf.meshes.length, nodes: nodes.length } };
}

/**
 * Writes the shared environment textures the game loads at runtime.
 *
 * Separate PNG files rather than embedded in the prop GLB because many different meshes share them â€” the
 * ground, the roads, the ballast, and the buildings all use the same handful. Embedding per model would
 * duplicate several megabytes for no benefit.
 */
function buildSharedTextures() {
  const sets = {
    'ground-detail': TEXTURES.groundDetail(),
    ballast: TEXTURES.ballast(),
    'road-surface': TEXTURES.roadSurface(),
    'rail-steel': TEXTURES.railSteel(),
    'painted-steel': TEXTURES.paintedSteel(),
    timber: TEXTURES.timber(),
    brick: TEXTURES.brick(),
    plaster: TEXTURES.plaster(),
    foliage: TEXTURES.foliage(),
    thatch: TEXTURES.thatch(),
    'corrugated-iron': TEXTURES.corrugatedIron(),
    stone: TEXTURES.stone(),
    rubber: TEXTURES.rubber(),
  };

  for (const [name, set] of Object.entries(sets)) {
    write(`textures/${name}-albedo.png`, encodePng(SIZE_OF(set.albedo), SIZE_OF(set.albedo), set.albedo, 3), 'texture', 'albedo');
    write(`textures/${name}-normal.png`, encodePng(SIZE_OF(set.normal), SIZE_OF(set.normal), set.normal, 3), 'texture', 'normal');
    write(
      `textures/${name}-mr.png`,
      encodePng(SIZE_OF(set.metallicRoughness), SIZE_OF(set.metallicRoughness), set.metallicRoughness, 3),
      'texture',
      'metallicRoughness',
    );
  }

  // The two signs Marlowe needs. Their own files because they carry text, and text baked into a shared
  // tiling texture would be unreadable at any useful repeat.
  write('textures/sign-marlowe.png', encodePng(256, 256, TEXTURES.signBoard('MARLOWE CROSSING'), 3), 'texture', 'station nameboard');
  write('textures/sign-stop.png', encodePng(256, 256, TEXTURES.signBoard('STOP'), 3), 'texture', 'crossing sign');
}

/**
 * Writes the sound set.
 *
 * Each category the brief asks for is its own file, named for the category rather than the instance, so the
 * runtime's audio table maps one-to-one onto what is on disk. That mapping is what makes the provenance
 * record checkable: every sound the game can play is a file in this list.
 */
function buildAudio() {
  const fire = SOUNDS.gunFire();

  // One-shots: normalised, then edge-faded. The fade matters more than it looks â€” a hard start on a
  // transient is an audible click, and a gun report that clicks sounds like a UI bug rather than a weapon.
  const oneShots = {
    'gun-crack': fire.crack,
    'gun-blast': fire.blast,
    'gun-thump': fire.thump,
    'gun-tail': fire.tail,
    'impact-penetration': SOUNDS.armourPenetration(),
    'impact-blocked': SOUNDS.armourBlocked(),
    'impact-ricochet': SOUNDS.ricochet(),
    'impact-terrain': SOUNDS.terrainImpact(),
    destruction: SOUNDS.vehicleDestroyed(),
    turret: SOUNDS.turretTraverse(),
    'gun-mechanism': SOUNDS.gunMechanism(),
    'ui-confirm': SOUNDS.uiConfirm(),
    'ui-fail': SOUNDS.uiFail(),
  };
  for (const [name, samples] of Object.entries(oneShots)) {
    write(
      `audio/${name}.wav`,
      encodeWav(fadeEdges(normalize(samples, 0.95), SOUNDS.SAMPLE_RATE), SOUNDS.SAMPLE_RATE),
      'audio',
      'one-shot',
    );
  }

  // Loops: made seamless, then normalised to a *lower* peak than the one-shots. A loop plays continuously, so
  // its peak effectively is its average loudness â€” matching the one-shots would make the engine louder than
  // a gun shot, which is exactly the balance error that makes a game sound wrong.
  const loops = {
    'engine-idle': SOUNDS.engineLoop(0),
    'engine-load': SOUNDS.engineLoop(0.5),
    'engine-full': SOUNDS.engineLoop(1),
    tracks: SOUNDS.trackLoop(),
  };
  for (const [name, samples] of Object.entries(loops)) {
    const seamless = makeSeamless(samples, SOUNDS.SAMPLE_RATE, name.startsWith('engine') ? 0.2 : 0.12);
    write(`audio/${name}.wav`, encodeWav(normalize(seamless, 0.55), SOUNDS.SAMPLE_RATE), 'audio', 'loop');
  }
}

// --- Entry point ------------------------------------------------------------------------------

/**
 * Paint tints, one per vehicle.
 *
 * The player is olive drab; the opponent is a flat neutral grey. Distinct, but not garish: the brief asks
 * for enemy identification to stay "readable without requiring bright arcade colors over the entire model",
 * and the *silhouette* difference carries most of that job. A green tank and a grey tank also happen to be
 * the two colours a military vehicle is actually painted, which keeps the whole thing coherent.
 */
const PAINTS = {
  medium: [0.29, 0.33, 0.19],
  heavy: [0.34, 0.34, 0.33],
  light: [0.36, 0.31, 0.24],
};

function main() {
  // The output directory is **not** wiped first.
  //
  // Wiping looked tidier and was actively harmful: the build validates geometry as it goes, so a validation
  // failure partway through threw *after* the directory had been emptied. That left a tree containing only
  // the assets built before the failure and none of the ones after â€” which the game then reports as
  // "Unexpected magic" when it fetches a truncated or absent model, an error that points at the runtime
  // rather than at the build step that actually broke.
  //
  // Writing over the top is just as correct for the stated goal (a renamed texture cannot leave an orphan),
  // because orphans are removed by the prune at the end, which only runs once every asset has been written.
  mkdirSync(OUT, { recursive: true });
  writtenPaths.clear();

  // One loop over the whole roster. Used to be three blocks of copy-pasted build/write/log, which meant
  // adding a vehicle meant remembering every one of those steps and getting a *partial* result when you
  // forgot: a model built but never registered simply does not load, and a manifest entry with no model
  // behind it 404s. Both are exactly the class of defect the V7 recovery pass spent its time on.
    for (const model of VEHICLE_MODELS) {
    const built = buildTankGlb(model.variant, PAINTS[model.variant]);
    write(model.file, built.glb, 'model', `${built.stats.triangles} triangles, ${built.stats.nodes} nodes`);
    console.log(
      `  ${model.file.padEnd(22)} ${built.stats.triangles} triangles  ` +
        `${built.stats.meshes} meshes  ${built.stats.nodes} nodes`,
    );
  }

  const props = buildPropsGlb();
  write('models/props.glb', props.glb, 'model', `${props.stats.nodes} prop types`);
  console.log(`  props.glb      ${props.stats.nodes} prop types  ${props.stats.meshes} meshes`);

  buildSharedTextures();
  buildAudio();

  // A machine-readable manifest. The loader could hard-code its asset list, but a manifest means it
  // discovers what exists, so a missing asset is a build-time diff rather than a runtime 404.
  //
  // Built from `VEHICLE_MODELS` rather than written out, so the manifest cannot claim a model this run
  // did not produce. The old hand-written version listed `ct-medium` against a vehicle id of
  // `placeholder-medium`, which was accurate for V7 and silently wrong the moment the roster was renamed â€”
  // exactly the kind of drift a generated index exists to make impossible.
  const manifest = {
    generatedBy: 'tools/build-assets.mjs',
    provenance: 'Generated in-project. No external assets. See docs/asset-provenance.md.',
    models: {
      ...Object.fromEntries(
        VEHICLE_MODELS.map((model) => [model.vehicleId, { file: model.file, vehicleId: model.vehicleId }]),
      ),
      props: { file: 'models/props.glb' },
    },
    textures: [...new Set(report.filter((r) => r.kind === 'texture').map((r) => r.name))],
    audio: [...new Set(report.filter((r) => r.kind === 'audio').map((r) => r.name))],
  };
  // Routed through `write` rather than `writeFileSync` so it joins `writtenPaths` and survives the orphan
  // prune. The manifest is written last, on purpose: it is the index of what this run produced, so it should
  // not exist at all if the run did not finish.
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  write('manifest.json', manifestBytes, 'manifest', `${Object.keys(manifest.models).length} models`);

  const bytesOf = (kind) => report.filter((r) => r.kind === kind).reduce((s, r) => s + r.bytes, 0);
  const totalBytes = report.reduce((sum, r) => sum + r.bytes, 0);
  console.log(
    `\n  ${report.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB total` +
      `  (${(bytesOf('model') / 1024).toFixed(0)} KB models,` +
      ` ${(bytesOf('texture') / 1024 / 1024).toFixed(2)} MB textures,` +
      ` ${(bytesOf('audio') / 1024 / 1024).toFixed(2)} MB audio)`,
  );
  console.log(`  output: ${OUT}`);

  // Last, so a failure anywhere above leaves the previous good assets intact rather than a half-written tree.
  pruneOrphans();
}



main();
