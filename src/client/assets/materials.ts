/**
 * The V7 material library.
 *
 * ## What this replaces
 *
 * V6 built every surface as a `StandardMaterial` with a flat `Color3` and no specular. That is why the game
 * looked like a technical prototype: a tank, a brick wall, and a rubber track were all uniformly-lit shapes
 * differing only in hue, so nothing read as a *material*. The brief asks for the opposite — "things should
 * visually read as the materials they represent".
 *
 * ## Why `PBRMaterial`
 *
 * Physically-based rendering is not chosen for physical accuracy; it is chosen because it is the cheapest
 * way to get **materials** rather than colours. Three channels do most of the work:
 *
 * - **metallic** separates "this is paint or dirt, which diffuses" from "this is steel, which reflects".
 *   That single distinction is what makes the gun read as metal and the hull read as painted armour, under
 *   one light, with no special-casing.
 * - **roughness** decides how sharply the light catches. A worn track, a polished rail crown, and matte
 *   brickwork all respond differently to the same light, which is most of what "material" means.
 * - **a normal map** gives form — a mortar joint, a wood grain, a track cleat — that flat colour cannot.
 *
 * ## Texture budget
 *
 * The brief asks for reasonable resolution and no unnecessary memory. Concretely:
 *
 * - Textures are **shared**. One brick material serves every building on the map; one ballast material
 *   serves the whole railway. Nothing is duplicated per mesh.
 * - `Texture` objects are cached by URL *and* tiling, so one file at several scales is uploaded once.
 * - Anisotropic filtering is on everything. Marlowe is a long, shallow sight-line map viewed at grazing
 *   angles, where an unfiltered ground texture shimmers violently; this is the single highest-value texture
 *   setting in the scene.
 * - Ground and road textures tile, so one 256px tile covers hundreds of metres rather than a large map
 *   stretching across the level and either blurring or wasting memory.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { textureUrls } from './asset-manifest.js';

/** Tuning shared by every material, so surfaces are lit consistently across the scene. */
const GLOBAL = {
  /**
   * Anisotropic filtering level.
   *
   * High because Marlowe is a long, shallow sight-line map. At grazing angles a ground or road texture with
   * no anisotropic filtering shimmers as the camera moves, which is far more distracting than the small cost
   * of the extra samples.
   */
  anisotropy: 8,
  /** Ambient contribution. Non-zero so shadowed sides are not pure black, which reads as a rendering fault. */
  environmentIntensity: 0.55,
  /** Direct light intensity multiplier. */
  directIntensity: 1.0,
} as const;

/** Cache of loaded textures, keyed by URL and tiling. */
const textureCache = new Map<string, Texture>();

/** Loads, or reuses, one texture at a given tiling. */
function loadTexture(scene: Scene, url: string, uScale: number, vScale: number): Texture {
  const key = `${url}|${uScale}|${vScale}`;
  const cached = textureCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const texture = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
  texture.uScale = uScale;
  texture.vScale = vScale;
  // Wrapping is what makes a tiled surface work. The default clamp stretches the edge texels across
  // everything beyond the first tile, which on a 500 m ground plane is most of what the player sees.
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = GLOBAL.anisotropy;

  textureCache.set(key, texture);
  return texture;
}

/** How a surface behaves, beyond its texture. */
export interface MaterialSpec {
  /** Texture set name from `TEXTURE_SETS`. Omit for a plain coloured material. */
  readonly textureSet?: string;
  /** World-space size one tile covers, in metres. Larger means coarser detail. */
  readonly tileSizeM?: number;
  /** Base colour tint applied over the albedo. White leaves the texture untouched. */
  readonly tint?: Color3;
  /** 0 for paint, dirt, and vegetation; 1 for bare steel. Drives the whole material read. */
  readonly metallic?: number;
  /** Low for polished surfaces, high for matte ones. */
  readonly roughness?: number;
  /** How strongly the normal map perturbs the lighting. */
  readonly normalStrength?: number;
  /** Self-illumination, for signs and lamps that must stay readable in shadow. */
  readonly emissive?: Color3;
}

/**
 * Creates one PBR material from a spec.
 *
 * Exported because a caller occasionally needs a surface the library does not have — a wreck's scorched
 * hull, a burning vehicle — and the alternative is reaching into Babylon's material API at a call site, which
 * spreads shading decisions across the codebase.
 */
export function makeSurfaceMaterial(scene: Scene, name: string, spec: MaterialSpec): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.environmentIntensity = GLOBAL.environmentIntensity;
  material.directIntensity = GLOBAL.directIntensity;

  if (spec.emissive !== undefined) {
    material.emissiveColor = spec.emissive;
    // An emissive surface should not be dimmed by lighting, or a sign reads as dim at night.
    material.disableLighting = true;
  }

  if (spec.textureSet !== undefined) {
    const urls = textureUrls(spec.textureSet);
    // World-space tiling: one tile per `tileSizeM` metres, so a wall and a road of different sizes get the
    // same *physical* feature size rather than the same number of repeats. A brick tile is authored at a
    // realistic course height, so the tile size has to match or the bricks come out the wrong size on screen.
    const repeats = 1 / (spec.tileSizeM ?? 2);

    material.albedoTexture = loadTexture(scene, urls.albedo, repeats, repeats);
    material.bumpTexture = loadTexture(scene, urls.normal, repeats, repeats);
    material.bumpTexture.level = spec.normalStrength ?? 1;
    // glTF packs roughness into green and metalness into blue, and Babylon reads the same channels when told
    // to. One file therefore serves both, which is why each set is three files and not four.
    material.metallicTexture = loadTexture(scene, urls.metallicRoughness, repeats, repeats);
    material.useRoughnessFromMetallicTextureGreen = true;
    material.useMetallnessFromMetallicTextureBlue = true;
    // The texture drives metallic and roughness per texel, so the caller's scalars become multipliers rather
    // than constants — which is what lets worn paint and bare metal coexist in one material.
    material.metallic = spec.metallic ?? 1;
    material.roughness = spec.roughness ?? 1;
  } else {
    material.metallic = spec.metallic ?? 0;
    material.roughness = spec.roughness ?? 0.85;
  }

  material.albedoColor = spec.tint ?? Color3.White();
  return material;
}

/**
 * The named surfaces the game uses.
 *
 * Each entry answers three questions at once: what is it made of, how big is its texture detail in metres,
 * and how does it respond to light. Keeping them here rather than inline at each call site is what makes the
 * battlefield read as one coherent set of materials — and this is the single file an art pass would edit.
 *
 * The `tileSizeM` values are the non-obvious part, and they matter more than the colours. A brick texture
 * authored with twelve courses across the tile has to be mapped at roughly the real course height, or the
 * bricks on screen are the size of shopping bags. Likewise ballast: mapped at 1.5 m per tile, a player
 * standing beside a rail sees chips roughly the size of real ones.
 */
export const MATERIALS = {
  /** Terrain and fields. Tiled tightly, matte, and low-contrast so it does not fight the vehicles. */
  ground: { textureSet: 'ground', tileSizeM: 6, metallic: 0, roughness: 1, normalStrength: 0.8 },
  /** Road surfacing. Darker and smoother than the ground, so a road reads as a road from the air. */
  road: { textureSet: 'road', tileSizeM: 4, metallic: 0, roughness: 0.95, normalStrength: 0.7 },
  /** Railway ballast. Coarse tile, strong normals — the texture's whole job is to look like crushed stone. */
  ballast: { textureSet: 'ballast', tileSizeM: 1.6, metallic: 0, roughness: 1, normalStrength: 1.3 },
  /** Rail head: bright and polished on the crown, rusty at the sides. Genuinely metallic. */
  rail: { textureSet: 'rail', tileSizeM: 1.2, metallic: 1, roughness: 0.55, normalStrength: 0.8 },
  /** Weathered timber: sleepers, telegraph poles, fences. */
  timber: { textureSet: 'timber', tileSizeM: 2.4, metallic: 0, roughness: 0.95, normalStrength: 1.0 },
  /** Brick, mapped at roughly real course height so the bricks are brick-sized on screen. */
  brick: { textureSet: 'brick', tileSizeM: 1.4, metallic: 0, roughness: 0.95, normalStrength: 1.1 },
  /** Limewashed plaster, for the station and rendered house walls. */
  plaster: { textureSet: 'plaster', tileSizeM: 2.2, metallic: 0, roughness: 0.92, normalStrength: 0.8 },
  /** Foliage, for canopies and hedgerows. Very matte. */
  foliage: { textureSet: 'foliage', tileSizeM: 3, metallic: 0, roughness: 1, normalStrength: 1.1 },
  /** Bark, for tree trunks. */
  bark: { textureSet: 'timber', tileSizeM: 1.6, metallic: 0, roughness: 0.95, normalStrength: 1.2 },
  /** Fieldstone rubble, for plinths and rocks. */
  stone: { textureSet: 'stone', tileSizeM: 1.2, metallic: 0, roughness: 0.95, normalStrength: 1.2 },
  /** Thatch, for barn roofs. */
  thatch: { textureSet: 'thatch', tileSizeM: 2, metallic: 0, roughness: 1, normalStrength: 1.4 },
  /** Corrugated roofing iron — the only structural material that is genuinely metallic. */
  iron: { textureSet: 'iron', tileSizeM: 1.8, metallic: 1, roughness: 0.6, normalStrength: 1.5 },
  /** Painted steel for railings and station furniture. */
  paintedSteel: { textureSet: 'steel', tileSizeM: 1.8, metallic: 0.4, roughness: 0.7, normalStrength: 1.0 },
  /** Rubber, for tyres. */
  rubber: { textureSet: 'rubber', tileSizeM: 1, metallic: 0, roughness: 0.88, normalStrength: 0.7 },

  // --- Untextured surfaces -------------------------------------------------------------
  // A few surfaces need no texture and would only look worse with one. They live here so that every material
  // in the game is reachable from this one map — which is what makes it a *library* rather than a helper plus
  // a pile of exceptions.

  /** Bare structural steel: brackets, hatches, gun fittings. */
  darkMetal: { metallic: 0.85, roughness: 0.55, tint: new Color3(0.3, 0.3, 0.32) },
  /** Signal red. Bright enough to read at range, without being arcade-coloured. */
  signalRed: { metallic: 0.1, roughness: 0.6, tint: new Color3(0.62, 0.13, 0.1) },
  /** Glass and lenses. Low roughness so the sun catches them. */
  glass: { metallic: 0.5, roughness: 0.12, tint: new Color3(0.1, 0.13, 0.16) },
  /** Warm off-white, for lettering and pale trim. */
  lettering: { metallic: 0, roughness: 0.7, tint: new Color3(0.85, 0.84, 0.78) },
  /**
   * A scorched wreck surface.
   *
   * Almost black and almost matte, and deliberately *not* the flat tint V6 used. A wreck has to read as burnt
   * rather than as "painted dark", and the difference is carried by roughness: scorched armour is duller and
   * greyer in its highlights than intact paint, because what is left is bare oxidised steel.
   */
  charredHull: { metallic: 0.55, roughness: 0.92, tint: new Color3(0.11, 0.1, 0.1) },
} as const;

/** The material library, as consumed by the renderer. */
export type MaterialLibrary = { [K in keyof typeof MATERIALS]: PBRMaterial };

/** Builds every named material for a scene, keyed by the name used in `MATERIALS`. */
export function createMaterialLibrary(scene: Scene): MaterialLibrary {
  // Built through a mutable record rather than an object literal so the mapped type is satisfied without a
  // cast at every key: `MATERIALS` is `as const`, and an index signature cannot be produced from it.
  const library: Record<string, PBRMaterial> = {};
  for (const [name, spec] of Object.entries(MATERIALS)) {
    library[name] = makeSurfaceMaterial(scene, `mat-${name}`, spec as MaterialSpec);
  }
  return library as MaterialLibrary;
}
