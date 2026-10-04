/**
 * The V7 texture set.
 *
 * Each entry produces PNG files and declares how the game should use them. Keeping the definitions here —
 * rather than inside the tank builder or the environment builder — means the material library is a single
 * reviewable list, and adding a surface later is one entry rather than a hunt through three files.
 *
 * Sizes are chosen per surface by how close the player ever gets to it. The hull is inspected from a few
 * metres and deserves 512; ballast and brick are seen from tens of metres and do not; ground detail tiles
 * across hundreds of metres and is better as a small, heavily-repeated tile than as one large texture
 * that would either blur or waste memory. That is the whole of the "reasonable resolution, no unnecessary
 * memory" guidance, applied per surface.
 */

import {
  paint,
  mix,
  shade,
  fbm,
  normalMapFrom,
  metallicRoughnessFrom,
} from './texture-lib.mjs';

/** Deterministic hash shared with the noise field, so brick ids vary with position and course. */
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Texture resolution per category, in pixels. */
const RES = {
  /** Read at point-blank range: the player tank's own paint and its running gear. */
  closeUp: 512,
  /** Seen from tens of metres: buildings, trees, railway furniture. */
  midRange: 256,
  /** Tiled across large surfaces, so a small tile repeated many times beats one big map. */
  tiling: 256,
};

/**
 * War and weather on painted armour.
 *
 * Three layers, in order of scale, because that is how it happens on a real vehicle and the order is what
 * makes it legible:
 *
 *  1. **Panel shading.** Large, soft patches where one plate has faded differently from its neighbour.
 *  2. **Directional grime.** Streaks running downward from panel lines and fixtures, biased along -Y in
 *     texture space so grime falls the way gravity would.
 *  3. **Chipping.** Small, hard-edged bright specks where paint has worn through to bare metal at an edge.
 *
 * The paint colour itself is supplied per vehicle as a material `baseColorFactor` tint, so the player
 * tank's olive and the enemy's grey share one texture and stay visually consistent — the "coherent smaller
 * asset set" the brief asks for, rather than one texture per vehicle.
 */
export function tankPaint(baseRgb, size = RES.closeUp) {
  const [br, bg, bb] = baseRgb;
  const lighter = mix(baseRgb, [1, 1, 1], 0.16);
  const darker = shade(baseRgb, 0.72);

  const height = (u, v) => (fbm(u, v, 96, 17, 2) > 0.74 ? 1 : 0);

  const albedo = paint(size, (u, v) => {
    // Panel fade: very low frequency, so it reads as "this plate is a slightly different shade".
    const panel = fbm(u, v, 3, 91, 2);
    // Grime: stretched vertically, which is what a downward streak looks like once it has run.
    const streak = fbm(u, v * 0.22, 14, 55, 3);
    // Fine tooth of an orange-peel military finish.
    const tooth = fbm(u, v, 60, 7, 2);

    let rgb = mix(darker, lighter, panel * 0.75 + tooth * 0.25);
    // Grime only darkens, and only where the streak is strong: painting mud on uniformly would just look
    // like a darker paint job.
    rgb = mix(rgb, [br * 0.42, bg * 0.4, bb * 0.34], Math.max(0, streak - 0.52) * 1.5);

    if (height(u, v) === 1) {
      rgb = mix(rgb, [0.34, 0.33, 0.32], 0.72);
    }
    return rgb;
  });

  return {
    albedo,
    normal: normalMapFrom(size, height, 1.6),
    // Painted armour is dielectric: metalness near zero, roughness high and uneven. Bare metal showing
    // through a chip is slightly glossier, which the roughness map picks up.
    metallicRoughness: metallicRoughnessFrom(
      size,
      (u, v) => 0.78 + fbm(u, v, 40, 33, 2) * 0.16,
      () => 0.04,
    ),
  };
}

/** Dark structural steel: track links, sprockets, brackets. Worn, oily, and much glossier than paint. */
export function trackSteel(size = RES.closeUp) {
  const height = (u, v) => {
    // Track links are a repeating cleat pattern plus wear polish on the ground-contact band.
    const cleat = Math.abs(((u * 14) % 1) - 0.5) < 0.16 ? 1 : 0;
    return cleat * 0.7 + fbm(u, v, 22, 43, 3) * 0.3;
  };

  const albedo = paint(size, (u, v) => {
    const wear = fbm(u, v, 22, 43, 3);
    const rust = fbm(u, v, 9, 71, 3);
    let rgb = mix([0.13, 0.13, 0.14], [0.3, 0.29, 0.28], wear);
    // Rust blooms are the recognisable cue that this is *track* metal rather than generic dark grey.
    rgb = mix(rgb, [0.34, 0.19, 0.1], Math.max(0, rust - 0.55) * 1.6);
    return rgb;
  });

  return {
    albedo,
    normal: normalMapFrom(size, height, 2.4),
    // Bare steel, so genuinely metallic — this is the difference between "dark plastic" and "metal" under
    // the scene's single directional light.
    metallicRoughness: metallicRoughnessFrom(
      size,
      (u, v) => 0.34 + fbm(u, v, 30, 12, 2) * 0.42,
      () => 0.92,
    ),
  };
}


/** Road rubber: solid, slightly dusty, and much darker than the track steel it sits beside. */
export function rubber(size = RES.tiling) {
  const albedo = paint(size, (u, v) => {
    const grain = fbm(u, v, 48, 23, 3);
    const dust = fbm(u, v, 7, 88, 2);
    return mix([0.055, 0.055, 0.06], [0.2, 0.19, 0.17], grain * 0.45 + dust * 0.3);
  });
  return {
    albedo,
    normal: normalMapFrom(size, (u, v) => fbm(u, v, 48, 23, 3), 0.7),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.88, () => 0),
  };
}

/**
 * Weathered softwood, for sleepers, telegraph poles, fences, and barns.
 *
 * Grain runs along V. The builders orient a timber's V along its length, so a pole gets grain along the
 * pole and a sleeper gets grain along the sleeper, from one texture.
 */
export function timber(size = RES.tiling) {
  const height = (u, v) => {
    // Growth rings: a stretched sine warped by noise, which is the cheapest convincing wood there is.
    const warp = fbm(u, v, 5, 3, 3);
    const rings = Math.sin((v * 26 + warp * 3) * Math.PI) * 0.5 + 0.5;
    const split = fbm(u * 0.3, v * 6, 14, 61, 2) > 0.78 ? -0.5 : 0;
    return rings * 0.6 + 0.4 + split;
  };

  const albedo = paint(size, (u, v) => {
    const warp = fbm(u, v, 5, 3, 3);
    const rings = Math.sin((v * 26 + warp * 3) * Math.PI) * 0.5 + 0.5;
    const grey = fbm(u, v, 6, 19, 3);
    // A weathered sleeper is grey-brown and silvered, not fresh timber brown.
    const rgb = mix([0.19, 0.15, 0.11], [0.36, 0.32, 0.26], rings * 0.8);
    return mix(rgb, [0.33, 0.32, 0.3], Math.max(0, grey - 0.45) * 1.1);
  });

  return {
    albedo,
    normal: normalMapFrom(size, height, 1.1),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.92, () => 0),
  };
}

/**
 * Brickwork with mortar joints, for the village buildings.
 *
 * Laid in a running bond (alternate courses offset by half a brick), which is what stops a brick wall
 * reading as a grid — a regular grid is the strongest "this is a texture, not a wall" tell there is.
 */
export function brick(size = RES.midRange) {
  const courses = 12;
  const bricksPerCourse = 6;
  const mortar = 0.055;

  /** Brick-local coordinates, and whether the pixel falls in mortar rather than in a brick. */
  function cell(u, v) {
    const row = Math.floor(v * courses);
    const offset = row % 2 === 0 ? 0 : 0.5;
    const bx = (u * bricksPerCourse + offset) % 1;
    const by = (v * courses) % 1;
    const inMortar = bx < mortar || bx > 1 - mortar || by < mortar * 1.6 || by > 1 - mortar * 1.6;
    return { bx, by, inMortar, id: hash2(Math.floor(u * bricksPerCourse + offset), row, 5) };
  }

  const height = (u, v) => (cell(u, v).inMortar ? 0.25 : 0.85);
  const albedo = paint(size, (u, v) => {
    const c = cell(u, v);
    if (c.inMortar) {
      return mix([0.36, 0.34, 0.31], [0.46, 0.44, 0.4], fbm(u, v, 60, 9, 2));
    }
    // Per-brick colour variation. Without it a brick wall is one flat red field, which is exactly the
    // prototype look this pass exists to remove.
    const tint = mix([0.36, 0.16, 0.12], [0.52, 0.26, 0.18], c.id);
    return mix(tint, shade(tint, 1.25), fbm(u, v, 70, 27, 2) * 0.35);
  });

  return {
    albedo,
    // Strong: the recessed joints are the entire point of a brick normal map.
    normal: normalMapFrom(size, height, 3.2),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.94, () => 0),
  };
}

/** Limewashed plaster over rubble, for the station building and rendered house walls. */
export function plaster(size = RES.midRange) {
  const albedo = paint(size, (u, v) => {
    const mottle = fbm(u, v, 5, 41, 3);
    const grime = fbm(u, v, 2, 13, 2);
    // Rain staining, stretched vertically so it runs downward from the eaves.
    const stain = Math.max(0, fbm(u, v * 0.35, 7, 66, 3) - 0.5) * 1.4;
    const rgb = mix([0.62, 0.59, 0.53], [0.78, 0.75, 0.69], mottle);
    return mix(rgb, [0.42, 0.39, 0.33], Math.min(0.7, stain + grime * 0.18));
  });
  return {
    albedo,
    normal: normalMapFrom(size, (u, v) => fbm(u, v, 26, 41, 3), 1.0),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.9, () => 0),
  };
}

/**
 * Railway ballast: crushed granite chips.
 *
 * Built from discrete cells with per-cell brightness rather than as smooth noise, because ballast's
 * defining visual is *individual angular stones* with dark gaps between them — a soft noise field reads as
 * gravelly mud instead.
 */
export function ballast(size = RES.tiling) {
  const cells = 22;
  const height = (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    // Distance to a per-cell jittered centre, so chips are irregular polygons rather than circles.
    const jx = hash2(ix, iy, 2) * 0.6 + 0.2;
    const jy = hash2(ix, iy, 3) * 0.6 + 0.2;
    return Math.max(0, 0.9 - Math.hypot(x - ix - jx, y - iy - jy) * 2.4);
  };

  const albedo = paint(size, (u, v) => {
    const grit = fbm(u, v, 80, 31, 2);
    // Grey granite, with oil-stained warmth in the gaps between stones.
    const stone = mix([0.2, 0.2, 0.21], [0.46, 0.45, 0.44], grit);
    return mix([0.11, 0.1, 0.09], stone, height(u, v));
  });

  return {
    albedo,
    normal: normalMapFrom(size, height, 3.6),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.96, () => 0),
  };
}

/** Painted, slightly flaked steel for telegraph poles, railings, and station furniture. */
export function paintedSteel(size = RES.tiling) {
  const albedo = paint(size, (u, v) => {
    const flake = fbm(u, v, 12, 77, 3);
    const dirt = fbm(u, v, 4, 15, 2);
    let rgb = mix([0.24, 0.26, 0.22], [0.32, 0.34, 0.29], flake);
    // Flaked paint showing rust underneath — the cue that a pole has stood outdoors for decades.
    rgb = mix(rgb, [0.35, 0.21, 0.12], Math.max(0, flake - 0.62) * 2.0);
    return mix(rgb, [0.26, 0.24, 0.2], dirt * 0.3);
  });
  return {
    albedo,
    normal: normalMapFrom(size, (u, v) => fbm(u, v, 12, 77, 3), 1.2),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.72, () => 0.15),
  };
}

/**
 * Bare rail head steel: polished on the crown, rusty on the web.
 *
 * A single uniform "metal" texture would make the rails read as painted pipes. The contrast between the
 * bright running surface and the dark corroded sides is what makes a rail look like a rail.
 */
export function railSteel(size = RES.tiling) {
  /** 1 on the polished crown, falling off above and below it. */
  const crown = (v) => Math.max(0, 1 - Math.min(1, Math.abs(v - 0.32) * 4.5));

  const albedo = paint(size, (u, v) => {
    const rust = fbm(u, v, 10, 29, 3);
    const rgb = mix([0.24, 0.15, 0.1], [0.36, 0.21, 0.13], rust);
    // The crown is polished bright by wheels.
    return mix(rgb, [0.62, 0.63, 0.64], crown(v) * 0.85);
  });

  return {
    albedo,
    normal: normalMapFrom(size, (u, v) => fbm(u, v, 16, 29, 3), 1.0),
    metallicRoughness: metallicRoughnessFrom(
      size,
      (u, v) => 0.75 - crown(v) * 0.55,
      () => 0.85,
    ),
  };
}

/**
 * Foliage: a clumped leaf mass, for tree canopies and hedgerows.
 *
 * Clumped rather than uniformly noisy, because a canopy's read is *masses* of leaves with shadow between
 * them. A uniform fine noise field looks like green static at any distance; large soft clumps with a few
 * bright highlights look like foliage catching light.
 */
export function foliage(size = RES.midRange) {
  const albedo = paint(size, (u, v) => {
    const clump = fbm(u, v, 10, 37, 3);
    const leaf = fbm(u, v, 34, 83, 2);
    let rgb = mix([0.11, 0.19, 0.08], [0.28, 0.4, 0.15], clump * 0.7 + leaf * 0.3);
    // Sun-bleached highlights on the upper clumps, which gives a canopy volume instead of a green mass.
    return mix(rgb, [0.42, 0.5, 0.22], Math.max(0, clump - 0.62) * 1.5);
  });
  return {
    albedo,
    // Only slight: a canopy's detail should not look like crumpled paper.
    normal: normalMapFrom(size, (u, v) => fbm(u, v, 18, 37, 3), 1.6),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.95, () => 0),
  };
}

/**
 * Ground detail: dry grass, mud, and bare earth, blended by a low-frequency mask.
      () => 0.85,
    ),
  };
}

/**
 * Ground detail: dry grass, mud, and bare earth, blended by a low-frequency mask.
 *
 * Marlowe's terrain already carries a height-based colour ramp from V6. This adds the *material* read the
 * ramp cannot: patchy mud where vehicles have been, dry straw-coloured grass elsewhere, and grain at a
 * scale the eye can resolve from the tank.
 */
export function groundDetail(size = RES.tiling) {
  const albedo = paint(size, (u, v) => {
    const patch = fbm(u, v, 4, 101, 3);
    const blade = fbm(u, v, 26, 53, 3);
    const mud = Math.max(0, fbm(u, v, 3, 199, 2) - 0.55) * 2.2;
    const grass = mix([0.24, 0.29, 0.13], [0.44, 0.45, 0.22], blade);
    const earth = mix([0.24, 0.18, 0.12], [0.34, 0.26, 0.18], blade * 0.6);
    const rgb = mix(grass, earth, Math.min(1, patch * 0.8 + mud));
    // Scattered stones and dry stalks, kept sparse so it does not turn to noise.
    return blade > 0.82 ? mix(rgb, [0.5, 0.47, 0.4], 0.5) : rgb;
  });
  return {
    albedo,
    normal: normalMapFrom(size, (u, v) => fbm(u, v, 26, 53, 3), 1.1),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.98, () => 0),
  };
}

/** Tarmac and compacted dirt for the roads. */
export function roadSurface(size = RES.tiling) {
  const albedo = paint(size, (u, v) => {
    const aggregate = fbm(u, v, 44, 73, 3);
    const wear = fbm(u, v, 5, 8, 3);
    let rgb = mix([0.13, 0.13, 0.13], [0.26, 0.25, 0.24], aggregate * 0.7);
    // Dust and dried mud encroaching at the edges of the carriageway.
    return mix(rgb, [0.34, 0.29, 0.22], Math.max(0, wear - 0.5) * 1.4);
  });
  return {
    albedo,
    normal: normalMapFrom(size, (u, v) => fbm(u, v, 44, 73, 3), 0.9),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.93, () => 0),
  };
}

/** Wrapped straw for the barns' thatched detail. */
export function thatch(size = RES.tiling) {
  const height = (u, v) => fbm(u, v * 0.25, 30, 91, 3);
  const albedo = paint(size, (u, v) => {
    const strand = fbm(u, v * 0.22, 34, 91, 3);
    return mix([0.36, 0.29, 0.13], [0.6, 0.5, 0.24], strand);
  });
  return {
    albedo,
    normal: normalMapFrom(size, height, 2.0),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.97, () => 0),
  };
}

/** Corrugated roofing iron, for the barns and station outsheds. */
export function corrugatedIron(size = RES.tiling) {
  const height = (u) => Math.sin(u * Math.PI * 2 * 22) * 0.5 + 0.5;
  const albedo = paint(size, (u, v) => {
    const rust = fbm(u, v, 8, 17, 3);
    // Rust bleeding downward from fixing points.
    const streak = Math.max(0, fbm(u * 0.4, v, 12, 45, 3) - 0.5) * 1.5;
    let rgb = mix([0.3, 0.31, 0.32], [0.42, 0.43, 0.44], height(u));
    return mix(rgb, [0.4, 0.22, 0.12], Math.min(0.85, Math.max(0, rust - 0.45) * 1.6 + streak * 0.5));
  });
  return {
    albedo,
    normal: normalMapFrom(size, height, 3.0),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.68, () => 0.55),
  };
}

/** Fieldstone rubble, for the farm buildings' plinths and the rocks scattered across Marlowe. */
export function stone(size = RES.midRange) {
  const cells = 9;
  const height = (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const jx = hash2(ix, iy, 61) * 0.5 + 0.25;
    const jy = hash2(ix, iy, 62) * 0.5 + 0.25;
    return Math.max(0, 1 - Math.hypot(x - ix - jx, y - iy - jy) * 1.5);
  };
  const albedo = paint(size, (u, v) => {
    const grit = mix([0.32, 0.31, 0.29], [0.52, 0.5, 0.46], fbm(u, v, 44, 13, 3));
    // Moss in the shaded joints, which is what stops a rubble wall reading as grey cubes.
    const moss = Math.max(0, fbm(u, v, 7, 88, 3) - 0.6) * 1.8;
    return mix(mix([0.2, 0.2, 0.18], grit, height(u, v)), [0.22, 0.28, 0.14], moss);
  });
  return {
    albedo,
    normal: normalMapFrom(size, height, 3.0),
    metallicRoughness: metallicRoughnessFrom(size, () => 0.95, () => 0),
  };
}

/**
 * A painted board with block lettering: the station nameboard, and the crossing's warning sign.
 *
 * A 5x7 block font is drawn directly into the pixels rather than using a canvas font. Canvas text
 * rendering differs between the build machine and the browser, between platforms, and between font
 * versions, so signage generated that way would be a non-reproducible asset — it would change on
 * regeneration without anything in the repository having changed. Fixed pattern glyphs cannot.
 */
export function signBoard(label, options = {}) {
  const size = options.size ?? 256;
  const pixels = new Uint8Array(size * size * 3);
  const border = Math.round(size * 0.05);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 3;
      const edge = x < border || y < border || x >= size - border || y >= size - border;
      // Traditional dark-green enamel sign with a pale border, weathered unevenly.
      const wear = fbm(x / size, y / size, 9, 5, 2);
      const base = edge ? [196, 190, 176] : [16, 44, 32];
      const tint = edge ? 0.88 + wear * 0.2 : 0.82 + wear * 0.34;
      pixels[i] = base[0] * tint;
      pixels[i + 1] = base[1] * tint;
      pixels[i + 2] = base[2] * tint;
    }
  }

  const text = label.toUpperCase();
  const cell = Math.max(1, Math.floor(((size - border * 2) * 0.92) / (text.length * 6 - 1)));
  const textWidth = text.length * 6 * cell - cell;
  const originX = Math.floor((size - textWidth) / 2);
  const originY = Math.floor((size - 7 * cell) / 2);

  for (let c = 0; c < text.length; c += 1) {
    const glyph = BLOCK_FONT[text[c]];
    if (glyph === undefined) {
      continue;
    }
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row][col] !== '#') {
          continue;
        }
        for (let dy = 0; dy < cell; dy += 1) {
          for (let dx = 0; dx < cell; dx += 1) {
            const px = originX + (c * 6 + col) * cell + dx;
            const py = originY + row * cell + dy;
            if (px < 0 || py < 0 || px >= size || py >= size) {
              continue;
            }
            const i = (py * size + px) * 3;
            pixels[i] = 216;
            pixels[i + 1] = 212;
            pixels[i + 2] = 198;
          }
        }
      }
    }
  }
  return pixels;
}

/**
 * A 5x7 block font as `#`/`.` rows.
 *
 * Only the characters Marlowe's signage needs. A full font would be a hundred lines of data for two signs
 * that say "MARLOWE CROSSING" and "STOP".
 */
const BLOCK_FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
};

export { RES };
