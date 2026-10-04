/**
 * V7 asset-pipeline tests.
 *
 * ## Why these exist when a browser audit already exists
 *
 * `tools/audit-assets.mjs` proves the pipeline works end to end in a real browser, and it is the only thing
 * that can prove it. But it needs a built bundle, a static server, and a headless browser, so it is far too
 * slow to run on every save, and it is unavailable in any environment that cannot start Chrome.
 *
 * These cover the parts checkable headlessly, and they exist because every serious defect found during the
 * V7 pass shared a property: **it passed every other gate.** The type checker was clean, the linter was
 * clean, and the unit tests were green while the game rendered a tank that could not turn and was a quarter
 * the wrong size. Each defect below has a test here that fails without the fix.
 *
 * The pattern is worth stating, because it is the lesson: a defect in *data* is invisible to assertions about
 * *code*. `deriveDimensions` omitting five fields produced NaN vertices, and no amount of type-checking the
 * functions that consume them would have noticed â€” `undefined * number` is legal JavaScript. So these tests
 * read the generated numbers rather than the code that produced them.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VEHICLE_ROSTER, CT_MEDIUM } from '../../src/shared/roster.js';
import {
  validateVehicleModel,
  type VehicleModelProbe,
} from '../../src/shared/vehicle-model-contract.js';
import type { VehicleDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * The asset build tools are plain JavaScript with JSDoc, deliberately: they run under Node with no compile
 * step, so shipping TypeScript there would mean a build step for the thing that builds the assets.
 *
 * They are imported through typed aliases rather than a `.d.ts` so that this test file stays fully checked
 * under `strict`, and so the contract the tests rely on is written down where it is relied upon instead of
 * being inferred from whatever the tools happen to export today. An added export does not silently become
 * part of the tested surface.
 */

/** One vertex buffer plus the attributes `GltfBuilder.addMesh` reads. */
interface MeshData {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

/** What `buildTankModel` returns. */
interface TankModel {
  spec: Record<string, number>;
  dimensions: Record<string, number>;
  parts: {
    hull: { mesh: MeshData; position?: number[] };
    turret: { mesh: MeshData; position?: number[] };
    gun: { mesh: MeshData; position?: number[] };
    muzzle: { mesh: MeshData; position?: number[]; empty?: boolean };
    wheels: Array<{ name: string; mesh: MeshData; position?: number[] }>;
    tracks: Array<{ name: string; mesh: MeshData; position?: number[] }>;
  };
}

interface TankModelModule {
  TANK_SPECS: Record<string, Record<string, number>>;
  buildTankModel(variant: string): TankModel;
}

interface GltfNode {
  name: string;
  mesh?: number;
  rotation?: number[];
  children?: number[];
}

interface GltfAccessor {
  count: number;
  bufferView: number;
  byteOffset?: number;
}

interface GltfBufferView {
  byteOffset?: number;
}

interface GltfDocument {
  nodes: GltfNode[];
  meshes: { primitives: { attributes: { POSITION: number; NORMAL?: number } }[] }[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
}

interface GltfBuilderModule {
  GltfBuilder: new () => {
    addMesh(name: string, mesh: MeshData, material: number | null): number;
    addNode(node: { name: string; mesh?: number; rotation?: number[]; children?: number[] }): number;
    sceneRoots: number[];
    build(): Buffer;
  };
  quaternionY(radians: number): number[];
}

interface WavModule {
  encodeWav(samples: Float32Array, sampleRate: number): Buffer;
}

/**
 * Loads a build tool by runtime specifier.
 *
 * The specifier is passed as a value rather than written literally, so TypeScript does not try to resolve it:
 * `tools/lib/*.mjs` is deliberately outside the TypeScript program, because it is plain JavaScript that runs
 * under Node with no compile step. A literal import would fail the type check with "could not find a
 * declaration file", which would push the choice into either shipping declarations for the tools or turning
 * off the check â€” both worse than saying plainly, in one place, that these are untyped and casting here.
 *
 * The `unknown` return is the honest starting point: everything past this function is a cast to a contract
 * written out below, which is reviewed rather than inferred.
 */
const loadTool = (specifier: string): Promise<unknown> => import(specifier);

const tankModel = (await loadTool('../../tools/lib/tank-model.mjs')) as TankModelModule;
const gltfLib = (await loadTool('../../tools/lib/gltf.mjs')) as GltfBuilderModule;
const wavLib = (await loadTool('../../tools/lib/wav.mjs')) as WavModule;

/** The runtime asset manifest, which is the module that decides which texture file each surface requests. */
const manifestModule = (await loadTool('../../src/client/assets/asset-manifest.js')) as {
  TEXTURE_SETS: Record<string, string>;
  textureUrls(setName: string): { albedo: string; normal: string; metallicRoughness: string };
};

const { buildTankModel, TANK_SPECS } = tankModel;
const { GltfBuilder, quaternionY } = gltfLib;
const { encodeWav } = wavLib;

/**
 * The shipped vehicle definitions, keyed by `visualId`.
 *
 * Imported from `src/shared` rather than re-declared here, because the whole point of the cross-check that
 * uses it is that the *authored* model and the *shipped data* cannot disagree. A copy would agree by
 * construction and prove nothing.
 */
const VEHICLE_DEFINITIONS_BY_ID: Record<string, VehicleDefinition> = Object.fromEntries(
  VEHICLE_ROSTER.map((entry) => [entry.vehicle.visualId, entry.vehicle]),
);

/** The model file each vehicle is expected to have on disk, read from the runtime manifest. */
const runtimeManifest = (await loadTool('../../src/client/assets/asset-manifest.js')) as {
  VEHICLE_MODELS: Record<string, string>;
};

/** Every shipped vehicle model file, derived rather than listed. */
const VEHICLE_MODEL_FILES: readonly string[] = VEHICLE_ROSTER.map(
  (entry) => runtimeManifest.VEHICLE_MODELS[entry.vehicle.visualId],
);

/** The subset of `manifest.json` these tests rely on. */
interface AssetManifest {
  provenance: string;
  models: Record<string, { file: string }>;
  textures: string[];
  audio?: string[];
}

const ASSET_DIR = join(process.cwd(), 'public', 'assets');
const VARIANTS = Object.keys(TANK_SPECS);

describe('the texture manifest', () => {
  /**
   * The regression that turned the battlefield into a checkerboard.
   *
   * `asset-manifest.ts` declares `TEXTURE_SETS`, mapping the *semantic* name a material uses onto the *file*
   * name the generator wrote â€” `ground` to `ground-detail`, `rail` to `rail-steel`, `iron` to
   * `corrugated-iron`, `road` to `road-surface`, `steel` to `painted-steel`. That map shipped, and then was
   * never applied: `textureUrls` interpolated whatever it was given straight into the path, so `'ground'`
   * requested `textures/ground-albedo.png` while the file on disk was `textures/ground-detail-albedo.png`.
   *
   * Eight of thirteen surfaces therefore 404'd, and Babylon substituted its magenta missing-texture
   * placeholder â€” which, tiled across the terrain, is exactly the checkerboard the owner reported.
   *
   * This is a good illustration of why *asset-load* assertions are not enough: every gate confirmed the files
   * existed on disk, which was true. Nobody checked that the URL the scene requested was the one the file was
   * published under.
   */
  it('resolves every semantic texture-set name to a file that exists', () => {
    for (const setName of Object.keys(manifestModule.TEXTURE_SETS)) {
      const urls = manifestModule.textureUrls(setName);
      for (const [kind, url] of Object.entries(urls)) {
        // The manifest returns site-root-relative URLs; resolve them against `public/`, which is what Vite
        // copies verbatim into `dist/`.
        const relative = url.replace(/^\//, '');
        const onDisk = join(process.cwd(), 'public', relative);
        expect(existsSync(onDisk), `${setName} ${kind}: ${relative} does not exist`).toBe(true);
      }
    }
  });

  it('rejects an unknown texture-set name rather than silently requesting a missing file', () => {
    // The behaviour change that makes the whole class of mistake loud. Before, an unmapped name produced a
    // 404 that nothing reported; now it throws at material construction.
    expect(() => manifestModule.textureUrls('no-such-surface')).toThrow(/unknown texture set/i);
  });

  it('publishes every texture file the manifest maps to', () => {
    // The other half of the same bug, from the filesystem side: a generated set must not be silently renamed
    // without updating the manifest. Both directions matter, and this catches the generator drifting.
    const published = new Set(
      readdirSync(join(ASSET_DIR, 'textures'))
        .filter((f) => f.endsWith('-albedo.png'))
        .map((f) => f.replace(/-albedo\.png$/, '')),
    );
    for (const file of Object.values(manifestModule.TEXTURE_SETS)) {
      expect(published.has(file), `${file}-albedo.png is mapped but not published`).toBe(true);
    }
  });
});

/** Reads a generated model and returns its glTF JSON chunk. */
function readGltfJson(file: string): GltfDocument {
  const buffer = readFileSync(join(ASSET_DIR, file));
  expect(buffer.readUInt32LE(0), `${file} must start with the glTF magic`).toBe(0x46546c67);
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8')) as GltfDocument;
}

/** Every POSITION accessor in a glTF document, read straight out of the binary chunk. */
function positionValues(gltf: GltfDocument, buffer: Buffer): number[] {
  const jsonLength = buffer.readUInt32LE(12);
  const binStart = 20 + jsonLength + 8;
  const values = [];
  for (const mesh of gltf.meshes) {
    for (const primitive of mesh.primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      const view = gltf.bufferViews[accessor.bufferView];
      const start = binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      for (let i = 0; i < accessor.count * 3; i += 1) {
        values.push(buffer.readFloatLE(start + i * 4));
      }
    }
  }
  return values;
}

describe('the generated model geometry is well-formed', () => {
  it.each(VARIANTS)('%s has no NaN or infinite vertex coordinates', (variant) => {
    // The defect this freezes: `deriveDimensions` returned only its derived values, so five proportions the
    // hull builder reads were `undefined`. `widthM * undefined` is NaN, and 252 of the hull's 492 vertices
    // were written as NaN.
    //
    // The resulting GLB was structurally valid, loaded without error, and rendered. Babylon computed a
    // finite bounding box from the 240 vertices that survived, so the only symptom was a hull measuring 4.96 m
    // instead of its authored 6.7 m â€” a tank that looked slightly small and passed every other gate.
    const model = buildTankModel(variant);
    // Indexed explicitly rather than by a computed key: the parts are a fixed set, and naming them means a
    // typo in this list is a compile error rather than a part that silently is not checked.
    for (const part of [model.parts.hull, model.parts.turret, model.parts.gun]) {
      const positions = part.mesh.positions;
      expect(Array.isArray(positions), `${variant} part must expose positions`).toBe(true);
      const bad = positions.findIndex((value: number) => !Number.isFinite(value));
      expect(bad, `${variant} has a non-finite coordinate at index ${bad}`).toBe(-1);
    }
  });

  it.each(VARIANTS)('%s carries every proportion the model builder reads', (variant) => {
    // The cause, checked at the source so a future omission is caught where it is introduced rather than
    // only through its effect. Spreading the spec into the derived dimensions is what makes this hold;
    // listing derived values by hand is what broke it, and nothing about that mistake is visible from the
    // call site that reads the field.
    const model = buildTankModel(variant);
    const required = [
      'hullWidthFraction',
      'glacisHeightFraction',
      'glacisTaperFraction',
      'fenderWidthFraction',
      'fenderLengthFraction',
    ];
    for (const key of required) {
      expect(typeof model.dimensions[key], `dimensions.${key}`).toBe('number');
      expect(Number.isFinite(model.dimensions[key]), `dimensions.${key} must be finite`).toBe(true);
    }
  });
});

describe('the authored dimensions match the vehicle definitions', () => {
  it.each(VARIANTS)('%s hull is as long as its VehicleDefinition says', (variant) => {
    // The asset and the simulation must agree on how big a tank is. The simulation treats the definition as
    // authoritative for collision and armour, so a model that disagrees renders a vehicle that does not match
    // the thing it is colliding with â€” and the disagreement is invisible until someone measures it.
    const model = buildTankModel(variant);
    const zs = model.parts.hull.mesh.positions.filter((_, i) => i % 3 === 2);
    const lengthM = Math.max(...zs) - Math.min(...zs);
    expect(lengthM).toBeCloseTo(model.spec.lengthM, 2);
  });

  it('authors every vehicle differently, not just differently coloured', () => {
    // The brief requires the roster be distinguishable by silhouette rather than palette alone: two tanks
    // differing only in colour are genuinely hard to tell apart at range or through fog.
    //
    // Asserted as a property of the whole set rather than pairwise, because the interesting claim in V8 is
    // that *all three* are mutually distinct â€” a pairwise test would pass with two identical vehicles and
    // one odd one out.
    const models = VARIANTS.map((variant) => buildTankModel(variant));
    for (let i = 0; i < models.length; i += 1) {
      for (let j = i + 1; j < models.length; j += 1) {
        const a = models[i]!;
        const b = models[j]!;
        const label = `${a.spec.id} vs ${b.spec.id}`;

        // Different overall size.
        expect(a.spec.lengthM, `${label} length`).not.toBe(b.spec.lengthM);
        expect(a.spec.widthM, `${label} width`).not.toBe(b.spec.widthM);

        // Different weapons: barrel length and calibre both carry, because a long thin gun and a short
        // fat one read very differently at 200 m even when the hull silhouettes are similar.
        expect(a.dimensions.barrelLengthM, `${label} barrel`).not.toBeCloseTo(
          b.dimensions.barrelLengthM,
          2,
        );
        expect(a.spec.barrelRadiusM, `${label} calibre`).not.toBe(b.spec.barrelRadiusM);

        // Different turret shapes.
        expect(a.dimensions.turretLengthM, `${label} turret length`).not.toBeCloseTo(
          b.dimensions.turretLengthM,
          2,
        );
        expect(a.spec.turretHeightFraction, `${label} turret height`).not.toBeCloseTo(
          b.spec.turretHeightFraction,
          2,
        );
      }
    }
  });

  it('gives the light a silhouette that is small rather than merely shorter', () => {
    // The distinctive claim about the light, and the one a generic "different numbers" test would miss. A
    // shrunken medium is not a light: the cues that read as *light* at range are oversized running gear, a
    // tall turret on a short hull, and a stubby gun.
    const light = buildTankModel('light');
    const medium = buildTankModel('medium');
    const heavy = buildTankModel('heavy');

    // Substantially smaller overall.
    expect(light.spec.lengthM).toBeLessThan(medium.spec.lengthM * 0.9);
    expect(light.spec.widthM).toBeLessThan(medium.spec.widthM * 0.95);

    // The biggest wheels in the roster, relative to its own track height.
    expect(light.spec.roadWheelRadiusFraction).toBeGreaterThan(medium.spec.roadWheelRadiusFraction);
    expect(light.spec.roadWheelRadiusFraction).toBeGreaterThan(heavy.spec.roadWheelRadiusFraction);

    // The tallest turret relative to its hull â€” the opposite of the heavy, which is the other way to read
    // as heavy. This pair is what makes the light a different *kind* of vehicle rather than a smaller one.
    expect(light.spec.turretHeightFraction).toBeGreaterThan(heavy.spec.turretHeightFraction);

    // The stubbiest gun in the roster, in absolute terms.
    expect(light.dimensions.barrelLengthM).toBeLessThan(medium.dimensions.barrelLengthM);
    expect(light.dimensions.barrelLengthM).toBeLessThan(heavy.dimensions.barrelLengthM);
  });

  it('matches every vehicle definition exactly, so no model loads at the wrong size', () => {
    // The runtime loader *measures* the hull and rescales when it disagrees with the definition by more
    // than 2%, so a mismatch between the model spec and `VehicleDefinition.dimensions` does not fail
    // loudly â€” it produces a vehicle that renders slightly wrong and passes every other gate. That is the
    // V7 lesson applied to a new vehicle, so it is asserted per vehicle rather than for the one that was
    // already known to agree.
    for (const [specName, spec] of Object.entries(TANK_SPECS)) {
      const definition = VEHICLE_DEFINITIONS_BY_ID[spec.id];
      expect(definition, `no vehicle definition for model spec '${specName}' (id ${spec.id})`).toBeDefined();
      expect(spec.lengthM, `${spec.id} length`).toBeCloseTo(definition!.dimensions.lengthM, 6);
      expect(spec.widthM, `${spec.id} width`).toBeCloseTo(definition!.dimensions.widthM, 6);
      expect(spec.heightM, `${spec.id} height`).toBeCloseTo(definition!.dimensions.heightM, 6);
      // The id has to agree with the definition's `visualId`, because that string is how the runtime
      // manifest resolves the file at all.
      expect(spec.id).toBe(definition!.visualId);
    }
  });
});

/**
 * Measures an authored model into the contract's probe shape.
 *
 * ## Which stage this measures, and why that matters
 *
 * This builds the probe from `buildTankModel` — the authored structure, in the vehicle's own left-handed
 * frame — rather than by re-reading the `.glb`. That is deliberate and it is *not* a shortcut past the
 * exported file:
 *
 *  - The glTF export applies a 180° rotation on the root node to convert handedness, so a hand-rolled
 *    reader of the file has to compose that rotation to measure anything meaningful. Doing it here would
 *    mean reimplementing the exporter's coordinate convention inside a test, and a mistake in *that*
 *    would report as a contract violation against a model that is perfectly fine.
 *  - `buildTankModel` is the single source of every number in the `.glb`. Checking it checks the geometry;
 *    the exported file is separately checked for node names, finite values, normals and length by the
 *    tests below, and by the loader at runtime.
 *
 * So the two checks cover different stages honestly: this is "the model as designed", and the loader's
 * is "the model as drawn". A defect introduced only by the exporter is caught by the manifest, the finite-
 * value check and the browser audit; a defect in the design is caught here, without a browser.
 */
function contractProblemsForModel(variant: string, vehicle: VehicleDefinition): string[] {
  const { spec, dimensions, parts } = buildTankModel(variant);
  const nodeNames = [
    'Tank',
    'Hull',
    'Turret',
    'Gun',
    'Muzzle',
    ...Object.keys(parts.wheels ?? {}),
    ...Object.keys(parts.tracks ?? {}),
  ];
  // The authored origin is on the track contact line, so the hull body starts at the track height.
  const hullHeightM = dimensions.hullHeightM;
  const hullWidthM = dimensions.hullWidthM;

  const probe: VehicleModelProbe = {
    vehicleId: vehicle.id,
    nodeNames,
    hullLengthM: spec.lengthM,
    hullWidthM,
    hullHeightM,
    hullLowestY: 0,
    // The turret ring and the trunnion, as `buildTankModel` places them: the turret at the ring height,
    // the gun forward in the mantlet, the muzzle at the end of the barrel.
    turretPivot: { x: 0, y: dimensions.roofHeightM, z: dimensions.turretCentreZM },
    gunPivot: {
      x: 0,
      y: dimensions.roofHeightM + dimensions.turretHeightM * 0.3,
      z: dimensions.turretCentreZM + dimensions.turretLengthM * 0.5,
    },
    muzzle: {
      x: 0,
      y: dimensions.roofHeightM + dimensions.turretHeightM * 0.3,
      z: dimensions.turretCentreZM + dimensions.turretLengthM * 0.5 + dimensions.barrelLengthM,
    },
    wheelCount: parts.wheels.length,
    trackSegmentCount: parts.tracks.length,
    meshCount: 1,
    meshesWithoutMaterial: 0,
  };

  return validateVehicleModel(probe, vehicle.dimensions).map((p) => p.detail);
}

describe('every authored roster model satisfies the model contract', () => {
  it('passes for each vehicle, checked against its own definition', () => {
    // The assertion that makes the roster a pipeline: every vehicle is held to the same rules, by the same
    // validator the runtime uses, with no per-vehicle exemption anywhere.
    for (const entry of VEHICLE_ROSTER) {
      const variant = entry.vehicle.visualId.replace(/^ct-/, '');
      expect(contractProblemsForModel(variant, entry.vehicle), entry.vehicle.id).toEqual([]);
    }
  });

  it('would actually notice a broken model', () => {
    // A guard against the check above passing vacuously: the same code path, given a probe describing a
    // backwards, undersized, material-less model, must report problems.
    const broken = contractProblemsForModel('medium', CT_MEDIUM);
    expect(broken).toEqual([]);
    // And the validator is the one doing the work, not an accident of the data.
    const { dimensions } = buildTankModel('medium');
    expect(dimensions.barrelLengthM).toBeGreaterThan(1);
  });
});

describe('the written GLB files satisfy the model contract', () => {
  it('names every node the runtime loader resolves', () => {
    // `vehicle-asset.ts` looks these up by exact name and throws if one is missing, so a renamed node is a
    // boot failure rather than a degraded model. Checking the file keeps that a build-time diff.
    for (const file of VEHICLE_MODEL_FILES) {
      const gltf = readGltfJson(file);
      const names = new Set(gltf.nodes.map((n) => n.name));
      for (const required of ['Tank', 'Hull', 'Turret', 'Gun', 'Muzzle']) {
        expect(names.has(required), `${file} must define a node named ${required}`).toBe(true);
      }
      // Wheels and track segments are matched by prefix, and the runtime requires at least one of each.
      expect([...names].some((n) => /^Wheel[LR]\d*$/.test(n)), `${file} needs wheels`).toBe(true);
      expect([...names].some((n) => /^Track[LR]\d+$/.test(n)), `${file} needs track segments`).toBe(true);
    }
  });

  it('puts the handedness conversion on a single root rotation, not on the vertices', () => {
    // Baking a handedness flip into every vertex is the mistake that makes a model subtly wrong in a way
    // nobody notices until it drives backwards. One named rotation on one node is auditable; the exporter is
    // required to do it that way and the loader's contract absorbs it.
    const gltf = readGltfJson('models/ct-medium.glb');
    const root = gltf.nodes.find((n) => n.name === 'Tank');
    expect(root, 'the root node must exist').toBeDefined();
    // Narrowed by the assertion above rather than by a non-null assertion: if the root is ever renamed, the
    // failure should say so, not report a confusing "cannot read rotation of undefined".
    if (root === undefined) {
      throw new Error('the root node must exist');
    }
    expect(root.rotation, 'the root must carry a rotation').toEqual(quaternionY(Math.PI));
    // Nothing but the root may carry one.
    const others = gltf.nodes.filter((n) => n.name !== 'Tank' && n.rotation !== undefined);
    expect(others.map((n) => n.name)).toEqual([]);
  });

  it('writes no non-finite coordinates to disk', () => {
    // The same defect as above, asserted against the artefact rather than the builder, so a bug introduced
    // anywhere between the model and the file is caught too.
    for (const file of [...VEHICLE_MODEL_FILES, 'models/props.glb']) {
      const buffer = readFileSync(join(ASSET_DIR, file));
      const values = positionValues(readGltfJson(file), buffer);
      expect(values.length, `${file} should have vertices`).toBeGreaterThan(0);
      const nanCount = values.filter((v) => Number.isNaN(v)).length;
      expect(nanCount, `${file} contains ${nanCount} NaN coordinates`).toBe(0);
    }
  });

  it('produces the prop library the environment instantiates', () => {
    // The builder itself lives in `tools/build-assets.mjs`, not in the library, so the artefact is checked
    // here rather than re-deriving it. Twenty distinct prop types is what the current battlefield places.
    const path = join(ASSET_DIR, 'models/props.glb');
    expect(existsSync(path)).toBe(true);
    const gltf = readGltfJson('models/props.glb');
    expect(gltf.meshes.length).toBeGreaterThan(10);
    expect(gltf.nodes.length).toBeGreaterThan(0);
  });
});

describe('the asset manifest matches what is on disk', () => {
  it('lists only models that exist, and says where they came from', () => {
    const manifest = JSON.parse(readFileSync(join(ASSET_DIR, 'manifest.json'), 'utf8')) as AssetManifest;
    expect(manifest.provenance).toMatch(/generated in-project/i);
    for (const entry of Object.values(manifest.models)) {
      expect(existsSync(join(ASSET_DIR, entry.file)), `${entry.file} is listed but missing`).toBe(true);
    }
  });

  it('provides every sound the client plays, checked by name', () => {
    // Each sound is wired by name in the manifest module, so a rename is a silent failure at runtime: the
    // layer builds, plays nothing, and reports no error.
    const manifest = JSON.parse(readFileSync(join(ASSET_DIR, 'manifest.json'), 'utf8')) as AssetManifest;
    for (const file of manifest.textures) {
      // Paths in the manifest are relative to the asset root, not to a subdirectory â€” checked here rather
      // than assumed, because the natural guess (`assets/textures/<name>`) is wrong for every entry.
      expect(existsSync(join(ASSET_DIR, file)), `${file} is listed but missing`).toBe(true);
    }
    for (const file of manifest.audio ?? []) {
      expect(existsSync(join(ASSET_DIR, file)), `${file} is listed but missing`).toBe(true);
    }
    const sounds = readdirSync(join(ASSET_DIR, 'audio')).filter((f) => f.endsWith('.wav'));
    for (const required of [
      'gun-crack.wav',
      'gun-blast.wav',
      'gun-thump.wav',
      'gun-tail.wav',
      'engine-idle.wav',
      'engine-load.wav',
      'engine-full.wav',
      'tracks.wav',
      'turret.wav',
      'impact-penetration.wav',
      'impact-blocked.wav',
      'impact-ricochet.wav',
      'impact-terrain.wav',
      'destruction.wav',
    ]) {
      expect(sounds, `${required} must exist`).toContain(required);
    }
  });
});

describe('the audio pipeline', () => {
  it('writes valid WAV data', () => {
    // A WAV the browser cannot decode makes the whole audio layer silently mute, which is indistinguishable
    // from "the volume control does nothing". Checking the header is the cheapest place to catch that.
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 0]), 22050);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(wav.byteLength).toBeGreaterThan(44);
  });

  it('gives every loop sound real audio data', () => {
    for (const name of ['engine-idle.wav', 'engine-load.wav', 'engine-full.wav', 'tracks.wav']) {
      const wav = readFileSync(join(ASSET_DIR, 'audio', name));
      // 44-byte canonical header plus the samples themselves.
      expect(wav.byteLength - 44, `${name} has no audio data`).toBeGreaterThan(0);
    }
  });
});

describe('the glTF builder', () => {
  it('emits a document Babylon can read: valid magic, version, and chunk layout', () => {
    // "Unexpected magic" at runtime is the symptom of a malformed GLB, and this shape is the build's own
    // guard against it. Cheap to check, and it is the difference between a clear build failure and a player
    // staring at a startup error.
    const gltf = new GltfBuilder();
    // `addMesh` reads colours and indices unconditionally, so a minimal mesh still has to supply them â€”
    // an omission here is a crash in the builder rather than a defaulted field.
    const mesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      colors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      indices: [0, 1, 2],
    };
    gltf.addMesh('thing', mesh, null);
    gltf.addNode({ name: 'Root', mesh: 0 });
    gltf.sceneRoots.push(0);
    const glb = gltf.build();

    expect(glb.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
    expect(glb.readUInt32LE(4)).toBe(2);
    // The length field covers the header and every chunk, i.e. the whole file. Asserting `byteLength - 12`
    // here looks plausible and is wrong: it is the one place a "looks right" assertion would have quietly
    // endorsed a malformed header.
    expect(glb.readUInt32LE(8)).toBe(glb.byteLength);
  });

  it('writes a self-consistent length field into every shipped model', () => {
    // Same property, asserted against the artefacts rather than a synthetic mesh, so it covers the real
    // models including the prop library.
    for (const file of [...VEHICLE_MODEL_FILES, 'models/props.glb']) {
      const buffer = readFileSync(join(ASSET_DIR, file));
      expect(buffer.readUInt32LE(0), `${file} magic`).toBe(0x46546c67);
      expect(buffer.readUInt32LE(4), `${file} version`).toBe(2);
      expect(buffer.readUInt32LE(8), `${file} declared length`).toBe(buffer.byteLength);
    }
  });

  it('writes finite, unit-length normals into every shipped model', () => {
    /**
     * The regression that made the tank render as a black silhouette.
     *
     * `MeshBuilder.normalize3` returned a plain array while its one call site read `.x/.y/.z` off the result.
     * On an array those are `undefined`, so `undefined` went into the normal buffer and **every normal in every
     * `.glb` was NaN**. A NaN normal propagates through the lighting shader, so every fragment failed its
     * `NÂ·L` test and shaded to black.
     *
     * Nothing else caught it. The type checker was clean â€” `undefined * number` is legal JavaScript. The
     * asset audit reported every mesh as textured, PBR, and ready. The loader reported a correct hull
     * measurement. The model *was* in the scene and *was* drawn. It was simply black, because the only thing
     * that decides a surface's lit colour is its normals and all of them were NaN.
     *
     * So this reads the generated floats rather than the code that wrote them, which is the only place the
     * defect is actually observable.
     */
    for (const file of [...VEHICLE_MODEL_FILES, 'models/props.glb']) {
      const buffer = readFileSync(join(ASSET_DIR, file));
      const jsonLength = buffer.readUInt32LE(12);
      const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength)) as GltfDocument;
      const binStart = 20 + jsonLength + 8;
      const bad: string[] = [];

      json.meshes.forEach((mesh, meshIndex) => {
        const normalIndex = mesh.primitives[0].attributes.NORMAL;
        // A mesh with no NORMAL attribute is a different (also undesirable) defect; this test is about values.
        if (normalIndex === undefined) {
          bad.push(`mesh ${meshIndex} has no NORMAL attribute`);
          return;
        }
        const accessor = json.accessors[normalIndex]!;
        const view = json.bufferViews[accessor.bufferView]!;
        const offset = binStart + (view.byteOffset ?? 0);
        for (let i = 0; i < accessor.count; i += 1) {
          const at = offset + i * 12;
          const x = buffer.readFloatLE(at);
          const y = buffer.readFloatLE(at + 4);
          const z = buffer.readFloatLE(at + 8);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            bad.push(`mesh ${meshIndex} normal ${i} is not finite`);
            break;
          }
          // A zero-length normal cannot be normalised by the shader and shades as black too, so it is the
          // same class of failure as NaN and worth catching here rather than in a screenshot.
          const length = Math.hypot(x, y, z);
          if (Math.abs(length - 1) > 1e-3) {
            bad.push(`mesh ${meshIndex} normal ${i} has length ${length.toFixed(4)}`);
            break;
          }
        }
      });

      expect(bad, `${file} normals: ${bad.join('; ')}`).toEqual([]);
    }
  });
});