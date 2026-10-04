/**
 * Procedural texture generation, run **at build time** and written out as PNG files.
 *
 * ## What this is for
 *
 * V6's vehicles and buildings were flat `Color3` values. That reads as a prototype because a painted
 * steel plate, a rubber track pad, weathered timber, and brick do not look like each other, and a single
 * flat colour cannot say which is which. The brief asks for materials that "visually read as the
 * materials they represent", which needs actual texture detail, not just better hues.
 *
 * Sourcing textures externally was rejected: the brief forbids unclear provenance, and a coherent set
 * beats a random mixture of unrelated free assets anyway (ADR-0015 already established that in-project
 * generation is this project's position). So the textures are generated here, once, and committed as
 * ordinary PNG files under `assets/textures/`.
 *
 * **That distinction matters.** The runtime loads files from disk, it does not call into this code. The
 * files are swappable for an artist's work without touching a line of game code — which is what makes
 * them assets rather than more procedural drawing. The generators stay in the repository as their
 * provenance record: anyone can regenerate them and see exactly how each pixel was chosen.
 *
 * ## How they are authored
 *
 * Each generator is a small height/noise field evaluated over a square, then converted to a colour. That
 * ordering is deliberate: real surfaces are *forms* (a weld seam, a wood grain, a brick course) that
 * happen to be a certain colour, and generating form first means the colour variation follows the form
 * instead of being unrelated noise layered on top of it.
 *
 * Value noise rather than per-pixel randomness, because a random field has no structure to read at all;
 * tiling value noise gives grain, cloud, and mottling at a scale the eye recognises as material.
 */

import { encodePng } from './png.mjs';

/**
 * Deterministic 32-bit hash to [0, 1). The project's own, because `Math.random()` would make every
 * regenerated asset differ and be unreviewable in a diff.
 */
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Tiling value noise at `frequency` cells across the unit square.
 *
 * Tiling matters: every texture here is applied to surfaces that repeat (a hull side, a ballast bed, a
 * brick wall), so a seam would read as a hard line down the middle of the model.
 */
function valueNoise(u, v, frequency, seed) {
  const x = u * frequency;
  const y = v * frequency;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const wrap = (n) => ((n % frequency) + frequency) % frequency;

  const a = hash2(wrap(x0), wrap(y0), seed);
  const b = hash2(wrap(x0 + 1), wrap(y0), seed);
  const c = hash2(wrap(x0), wrap(y0 + 1), seed);
  const d = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);

  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * A square RGB image, filled by a per-pixel callback.
 *
 * The callback returns `[r, g, b]` in 0-1. Centralised so every generator shares the same iteration,
 * the same tiling semantics, and the same clamping rule — the alternative is nine near-copies of a
 * nested loop, each with its own off-by-one.
 */
export function paint(size, fn) {
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const rgb = fn(x / size, y / size, x, y);
      const i = (y * size + x) * 3;
      pixels[i] = Math.max(0, Math.min(255, Math.round(rgb[0] * 255)));
      pixels[i + 1] = Math.max(0, Math.min(255, Math.round(rgb[1] * 255)));
      pixels[i + 2] = Math.max(0, Math.min(255, Math.round(rgb[2] * 255)));
    }
  }
  return pixels;
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function shade(rgb, factor) {
  return [rgb[0] * factor, rgb[1] * factor, rgb[2] * factor];
}

/**
 * Derives a tangent-space normal map from a height field, by central differences.
 *
 * This is why form comes first in every generator: the height field already exists, so a normal map is
 * nearly free from it. A normal map is what makes a brick wall catch light on its mortar joints and a
 * track pad read as a raised cleat, which flat colour cannot do at any texture resolution.
 *
 * @param {(u:number,v:number)=>number} height returns 0-1
 */
export function normalMapFrom(size, height, strength) {
  const pixels = new Uint8Array(size * size * 3);
  const step = 1 / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const dx = (height(u + step, v) - height(u - step, v)) * strength;
      const dy = (height(u, v + step) - height(u, v - step)) * strength;
      // Surface normal (-dx, -dy, 1) normalised and encoded into 0-1.
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 3;
      pixels[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      pixels[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      pixels[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
    }
  }
  return pixels;
}

/**
 * A metallic-roughness map in glTF's packing: **G = roughness, B = metalness**, R left for occlusion.
 *
 * Emitting both channels in one texture is what glTF's `metallicRoughnessTexture` expects, so a material
 * costs one upload instead of two.
 */
export function metallicRoughnessFrom(size, roughness, metalness) {
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 3;
      pixels[i] = 0;
      pixels[i + 1] = Math.max(0, Math.min(255, Math.round(roughness(x / size, y / size) * 255)));
      pixels[i + 2] = Math.max(0, Math.min(255, Math.round(metalness(x / size, y / size) * 255)));
    }
  }
  return pixels;
}

export { encodePng, valueNoise };

/** Summed octaves of value noise. Three is enough for a surface; more only costs build time. */
export function fbm(u, v, baseFrequency, seed, octaves = 3) {
  let total = 0;
  let amplitude = 1;
  let norm = 0;
  let frequency = baseFrequency;
  for (let o = 0; o < octaves; o += 1) {
    total += valueNoise(u, v, frequency, seed + o * 101) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / norm;
}

