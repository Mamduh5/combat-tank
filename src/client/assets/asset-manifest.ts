/**
 * Where assets live, and how they are referenced.
 *
 * ## Why assets live in `public/` and not in `src/`
 *
 * Vite serves `public/` at the site root and copies it verbatim into `dist/`. Assets there are therefore
 * *files the game fetches at runtime* rather than modules it imports — which is the whole point. An imported
 * module would be bundled and executed; a fetched `.glb` is an asset that can be opened in Blender, replaced
 * by an artist, or swapped between builds without recompiling anything.
 *
 * `import.meta.env.BASE_URL` is prepended because the game may be served from a sub-path, and an absolute
 * `/assets/...` would 404 there. Building the URLs through this one function means there is a single place to
 * change if the layout ever moves.
 *
 * ## Provenance
 *
 * Every file referenced here is **generated in-project** by `tools/build-assets.mjs`. Nothing is downloaded
 * and nothing is licensed. See `docs/asset-provenance.md`.
 */

/**
 * The base URL assets are served from.
 *
 * Read defensively rather than typed as non-optional. `import.meta.env` is populated by Vite, but a unit test
 * running under plain `vitest`, or any tool that imports this module outside a bundle, can see an object
 * without it — and an asset manifest that throws on import would take the whole client down rather than
 * failing one texture.
 */
const BASE_URL: string =
  typeof import.meta !== 'undefined' &&
  typeof (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.BASE_URL ===
    'string'
    ? (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL
    : '/';

export const ASSET_BASE = `${BASE_URL}assets/`;

/** Joins a path under `assets/` onto the base URL. */
export function assetUrl(relativePath: string): string {
  return `${ASSET_BASE}${relativePath.replace(/^\/+/, '')}`;
}

/**
 * The model file for each vehicle variant.
 *
 * Keyed by the `visualId` a `VehicleDefinition` carries, so choosing a vehicle's appearance is a data change
 * (`ADR-0003`) rather than a code change. That is the property V8 needs in order to add a tank by editing
 * one object, and it is why this map exists at all rather than the loader taking a literal filename.
 */
export const VEHICLE_MODELS = {
  'ct-medium': 'models/ct-medium.glb',
  'ct-heavy': 'models/ct-heavy.glb',
  'ct-light': 'models/ct-light.glb',
} as const;

/** The shared environment prop library. One file, instanced many times at runtime. */
export const PROP_MODEL = 'models/props.glb';

/**
 * Texture sets, by surface name.
 *
 * Each surface is three files — albedo, tangent-space normal, and a packed metallic-roughness map — because
 * those three together are what makes a surface read as *its material* rather than as a coloured shape.
 * Albedo alone gives the hue; the normal map gives the form (a brick joint, a track cleat, a wood grain); the
 * metallic-roughness map decides whether it responds to the light like paint or like steel.
 *
 * The packing is glTF's: **G = roughness, B = metalness**. One file instead of two, so a material costs one
 * upload rather than two.
 */
export const TEXTURE_SETS = {
  ground: 'ground-detail',
  ballast: 'ballast',
  road: 'road-surface',
  rail: 'rail-steel',
  steel: 'painted-steel',
  timber: 'timber',
  brick: 'brick',
  plaster: 'plaster',
  foliage: 'foliage',
  thatch: 'thatch',
  iron: 'corrugated-iron',
  stone: 'stone',
  rubber: 'rubber',
  /** Tree bark reuses the timber set rather than shipping a near-identical fourth wood texture. */
  bark: 'timber',
} as const;

/** The short names a `MaterialSpec.textureSet` may use. Typed so an unknown one is a compile error. */
export type TextureSetName = keyof typeof TEXTURE_SETS;

/**
 * The three files that make up one texture set.
 *
 * ## Why the set name is resolved here, and not at the call site
 *
 * `TEXTURE_SETS` maps the *semantic* name a material refers to (`ground`, `rail`, `iron`) onto the *file*
 * name the generator wrote (`ground-detail`, `rail-steel`, `corrugated-iron`). Two names, not one, is
 * deliberate: a surface is "the ground" whether its texture is a detailed ground or a flat colour, and
 * renaming an asset should not require editing every material spec that used it.
 *
 * V7 shipped this map and then never applied it. `textureUrls` interpolated whatever it was given straight
 * into the path, so `'ground'` requested `textures/ground-albedo.png` while the file on disk was
 * `textures/ground-detail-albedo.png`. Every ground, road, rail, iron, and steel surface in the game therefore
 * 404'd, and Babylon substituted its magenta missing-texture placeholder — which, tiled across the terrain,
 * is exactly the checkerboard the owner reported. An unknown set name now throws rather than silently
 * requesting a file that does not exist.
 */
export function textureUrls(setName: string): {
  albedo: string;
  normal: string;
  metallicRoughness: string;
} {
  const file = (TEXTURE_SETS as Record<string, string | undefined>)[setName];
  if (file === undefined) {
    throw new Error(
      `Combat Tank: unknown texture set '${setName}'. Known sets: ${Object.keys(TEXTURE_SETS).join(', ')}. ` +
        `Add it to TEXTURE_SETS in asset-manifest.ts rather than passing a file name straight through.`,
    );
  }
  return {
    albedo: assetUrl(`textures/${file}-albedo.png`),
    normal: assetUrl(`textures/${file}-normal.png`),
    metallicRoughness: assetUrl(`textures/${file}-mr.png`),
  };
}

/**
 * Every sound the game can play, by category.
 *
 * The brief requires the player to distinguish four impact outcomes, three engine states, and a destruction
 * from a reload by ear alone. That is only possible if each is a *separate* file with a *distinct*
 * spectrum — so the list is the audio contract, and `docs/audio-design.md` explains what each one is for.
 *
 * `engine-idle` / `engine-load` / `engine-full` are three loops cross-faded by throttle and speed rather
 * than one loop with its pitch raised. Pitch alone gives a rising tone; cross-fading gives a rising *load*,
 * which is what the brief actually asks the player to hear.
 */
export const SOUNDS = {
  /** The main gun, in four layers so the runtime can place each differently. */
  gunCrack: 'audio/gun-crack.wav',
  gunBlast: 'audio/gun-blast.wav',
  gunThump: 'audio/gun-thump.wav',
  /** Arrives late and is mostly low; the delay is most of why a distant gun sounds distant. */
  gunTail: 'audio/gun-tail.wav',

  /** Shell impacts, one file per outcome. Timbre differs, not just loudness. */
  penetration: 'audio/impact-penetration.wav',
  blocked: 'audio/impact-blocked.wav',
  ricochet: 'audio/impact-ricochet.wav',
  terrain: 'audio/impact-terrain.wav',

  destruction: 'audio/destruction.wav',

  /** Loops. */
  engineIdle: 'audio/engine-idle.wav',
  engineLoad: 'audio/engine-load.wav',
  engineFull: 'audio/engine-full.wav',
  tracks: 'audio/tracks.wav',
  turret: 'audio/turret.wav',

  /** One-shots. */
  gunMechanism: 'audio/gun-mechanism.wav',
  uiConfirm: 'audio/ui-confirm.wav',
  uiFail: 'audio/ui-fail.wav',
} as const;
