/**
 * Environment prop models for Marlowe Crossing.
 *
 * ## Scope discipline
 *
 * The brief is explicit: "Priority should go to things the player regularly sees from normal camera height.
 * Do not spend large effort improving objects that are barely visible." So this file builds the things a
 * player passes at 5-40 m — trees, hedgerows, rocks — and leaves buildings and railway furniture to
 * `structure-models.mjs`, because a well-detailed tree 300 m away is worth less than a plain one 6 m away.
 *
 * ## Collision
 *
 * Nothing here creates collision. The battle's structures and obstacles come from `src/core/world` and
 * Rapier, and the brief forbids visual assets reintroducing invisible collision problems. These meshes are
 * decoration only; where a prop stands where something solid should be, the core's structure list is the
 * authority. That separation is why this file can be replaced wholesale without touching the simulation.
 */

import { MeshBuilder } from './mesh.mjs';
import { Matrix } from './math.mjs';

const TINT = {
  bark: [1, 1, 1, 1],
  barkDark: [0.68, 0.68, 0.7, 1],
  leaf: [1, 1, 1, 1],
  leafDark: [0.72, 0.74, 0.72, 1],
  stone: [1, 1, 1, 1],
  stoneDark: [0.7, 0.7, 0.72, 1],
};

/**
 * A tree: a tapered trunk with a few limbs and a canopy built from overlapping spheres.
 *
 * Several offset spheres rather than one, because a single sphere canopy is the clearest "this is a
 * placeholder" tell in a landscape — the eye reads a sphere as a ball, not as foliage. Overlapping,
 * differently-scaled masses give an irregular silhouette that reads as a crown.
 */
export function tree(heightM, radiusM, seed = 0) {
  const m = new MeshBuilder();
  const trunkHeight = heightM * 0.42;

  // A slight lean, so no two trees stand identically.
  m.scoped(Matrix.rotationZ(((seed % 7) - 3) * 0.012), (b) => {
    b.pushTranslate(0, trunkHeight * 0.5, 0);
    b.cylinder(radiusM * 0.19, radiusM * 0.1, trunkHeight, 8, { color: TINT.bark, uvScale: 1.6 });
    b.pop();
  });

  // Two or three limbs reaching up into the crown.
  const limbs = 2 + (seed % 2);
  for (let i = 0; i < limbs; i += 1) {
    const a = (i / limbs) * Math.PI * 2 + seed * 0.7;
    m.scoped(Matrix.rotationZ(Math.cos(a) * 0.5), (b) => {
      b.scoped(Matrix.rotationX(Math.sin(a) * 0.5), (c) => {
        c.pushTranslate(
          Math.cos(a) * radiusM * 0.3,
          trunkHeight * 0.9,
          Math.sin(a) * radiusM * 0.3,
        );
        c.cylinder(radiusM * 0.08, radiusM * 0.03, heightM * 0.3, 6, { color: TINT.barkDark });
      });
    });
  }

  // The crown: four overlapping masses at deterministic offsets, so every tree is irregular.
  const lobes = [
    { x: 0, y: heightM * 0.68, z: 0, s: 1.0 },
    { x: radiusM * 0.5, y: heightM * 0.56, z: radiusM * 0.3, s: 0.72 },
    { x: -radiusM * 0.42, y: heightM * 0.6, z: -radiusM * 0.35, s: 0.66 },
    { x: radiusM * 0.1, y: heightM * 0.82, z: -radiusM * 0.25, s: 0.58 },
  ];
  lobes.forEach((lobe, i) => {
    const jitter = 0.85 + (((seed + i * 13) % 5) / 5) * 0.3;
    m.pushTranslate(lobe.x, lobe.y, lobe.z);
    m.sphere(radiusM * lobe.s * jitter, 9, 7, { color: i === 0 ? TINT.leaf : TINT.leafDark });
    m.pop();
  });

  return m;
}

/**
 * A bush: two or three low masses.
 *
 * Deliberately simpler and lower than a tree. These are the light concealment the map places along field
 * edges, seen mostly from above at the third-person camera's height — detail spent here is detail spent on
 * something the player looks past.
 */
export function bush(radiusM, seed = 0) {
  const m = new MeshBuilder();
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2 + seed;
    const r = radiusM * (0.4 + ((seed + i) % 3) * 0.12);
    m.pushTranslate(Math.cos(a) * radiusM * 0.4, radiusM * 0.45, Math.sin(a) * radiusM * 0.4);
    m.sphere(r, 7, 5, { color: i === 0 ? TINT.leaf : TINT.leafDark });
    m.pop();
  }
  // A few twigs poking out of the mass, which stops it reading as a green ball.
  for (let i = 0; i < 3; i += 1) {
    const a = seed + i * 2.1;
    m.pushTranslate(Math.cos(a) * radiusM * 0.5, radiusM * 0.5, Math.sin(a) * radiusM * 0.5);
    m.cylinder(0.03, 0.015, radiusM * 0.7, 5, { color: TINT.barkDark });
    m.pop();
  }
  return m;
}

/**
 * A hedgerow: a long, low, irregular mass.
 *
 * A run of overlapping lobes along its length rather than one stretched box, because hedgerows are the map's
 * visual lines — they read as field boundaries — and a straight box makes them read as walls.
 */
export function hedgerow(lengthM, heightM, seed = 0) {
  const m = new MeshBuilder();
  const lobes = Math.max(3, Math.round(lengthM / 1.4));
  for (let i = 0; i < lobes; i += 1) {
    const t = i / (lobes - 1);
    const x = -lengthM * 0.5 + lengthM * t;
    // A wandering centreline and a varying height: hedges are not extruded.
    const wobble = Math.sin(t * 7 + seed) * 0.22;
    const h = heightM * (0.82 + Math.sin(t * 11 + seed * 2) * 0.18);
    m.pushTranslate(x, h * 0.5, wobble * heightM);
    m.sphere(heightM * 0.62, 8, 6, { color: i % 2 === 0 ? TINT.leaf : TINT.leafDark });
    m.pop();
  }
  // A low earth bank along the base, which is what a real hedgerow is planted on.
  m.pushTranslate(0, heightM * 0.1, 0);
  m.box(lengthM, heightM * 0.22, heightM * 0.5, { color: TINT.stoneDark, uvScale: 1.2 });
  m.pop();
  return m;
}

/**
 * A rock: an irregular faceted mass.
 *
 * Faceted rather than smooth on purpose. A smooth sphere reads as a ball; a rock needs flat planes meeting at
 * edges, because that is what catches the directional light and gives it a shape.
 */
export function rock(radiusM, seed = 0) {
  const m = new MeshBuilder();
  const rings = 4;
  const segments = 7;
  const base = m.vertexCount;
  for (let r = 0; r <= rings; r += 1) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const theta = (s / segments) * Math.PI * 2;
      const jitter = 0.72 + (((seed + r * 31 + s * 17) % 7) / 7) * 0.5;
      const x = Math.sin(phi) * Math.cos(theta) * radiusM * jitter;
      const y = Math.cos(phi) * radiusM * jitter * 0.72;
      const z = Math.sin(phi) * Math.sin(theta) * radiusM * jitter;
      m.vertex(x, y + radiusM * 0.4, z, x, y, z, s / segments, r / rings, TINT.stone);
    }
  }
  const stride = segments + 1;
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = base + r * stride + s;
      m.quad(a, a + stride, a + stride + 1, a + 1);
    }
  }
  return m;
}

/**
 * A telegraph pole: a tapered timber with cross-arms, insulators, and short wire stubs.
 *
 * The insulators are the detail that identifies it. A plain pole with a crossbar could be anything; a row of
 * small pale insulators on a bracket says "telegraph line" instantly, and the poles run alongside the
 * railway, which is exactly where a player expects to find them.
 */
export function telegraphPole(heightM, seed = 0) {
  const m = new MeshBuilder();
  const armCount = 2 + (seed % 2);

  m.pushTranslate(0, heightM * 0.5, 0);
  m.cylinder(0.13, 0.09, heightM, 8, { color: [1, 1, 1, 1], uvScale: 1.4 });
  m.pop();

  for (let i = 0; i < armCount; i += 1) {
    const y = heightM * (0.82 - i * 0.09);
    m.pushTranslate(0, y, 0);
    m.box(1.5, 0.1, 0.11, { color: [0.85, 0.85, 0.87, 1], uvScale: 1.6 });
    m.pop();
    for (const x of [-0.6, -0.2, 0.2, 0.6]) {
      m.pushTranslate(x, y + 0.09, 0);
      m.cylinder(0.035, 0.05, 0.09, 7, { color: [0.5, 0.52, 0.5, 1] });
      m.pop();
    }
    // A diagonal brace, which is what makes a crossarm look engineered rather than drawn.
    m.pushTranslate(0, y - 0.18, 0);
    m.scoped(Matrix.rotationZ(0.5), (b) => {
      b.box(0.5, 0.06, 0.08, { color: [0.85, 0.85, 0.87, 1] });
    });
    m.pop();
  }

  // Wire stubs reaching toward the next pole. Short, because they repeat along a run at runtime.
  for (let i = 0; i < armCount; i += 1) {
    const y = heightM * (0.82 - i * 0.09);
    m.pushTranslate(0, y + 0.12, 0);
    m.scoped(Matrix.rotationX(Math.PI / 2), (b) => {
      b.cylinder(0.012, 0.012, 3.2, 4, { color: [0.25, 0.25, 0.27, 1] });
    });
    m.pop();
  }
  return m;
}

/**
 * A level-crossing gate: a barrier arm on a post with a counterweight and a target disc.
 *
 * Modelled because the crossing is one of the few places on the map where the player stops and looks, and a
 * crossing with no gates reads as a road that happens to cross rails.
 */
export function crossingGate() {
  const m = new MeshBuilder();
  m.pushTranslate(0, 0.75, 0);
  m.cylinder(0.09, 0.08, 1.5, 8, { color: [0.9, 0.9, 0.92, 1] });
  m.pop();
  // The arm, with a counterweight so it is visibly a mechanism and not a floating bar.
  m.scoped(Matrix.rotationZ(Math.PI / 2), (b) => {
    b.pushTranslate(0, 0, 0.5);
    b.box(2.6, 0.14, 0.12, { color: [1, 1, 1, 1], uvScale: 1.5 });
  });
  m.pop();
  m.scoped(Matrix.rotationZ(Math.PI / 2), (b) => {
    b.pushTranslate(0, 0, -0.35);
    b.box(0.5, 0.18, 0.18, { color: [0.5, 0.5, 0.52, 1] });
  });
  m.pop();
  // The red target disc, which is what a driver reads from a distance.
  m.pushTranslate(1.9, 0.78, 0.08);
  m.scoped(Matrix.rotationX(Math.PI / 2), (b) => {
    b.cylinder(0.22, 0.22, 0.05, 10, { color: [0.85, 0.2, 0.15, 1] });
  });
  m.pop();
  return m;
}

/**
 * A railway signal post: a post with a semaphore arm, angled down to mean "stop".
 *
 * A vertical read at distance, and one of the few silhouettes on the map that is unmistakably railway.
 * Deliberately tall and thin, because that is what makes it legible from 150 m.
 */
export function signalPost(heightM) {
  const m = new MeshBuilder();
  m.pushTranslate(0, heightM * 0.5, 0);
  m.cylinder(0.11, 0.08, heightM, 8, { color: [0.88, 0.88, 0.9, 1], uvScale: 1.4 });
  m.pop();
  m.pushTranslate(0.45, heightM * 0.86, 0);
  m.scoped(Matrix.rotationZ(-0.6), (b) => {
    b.pushTranslate(0.3, 0, 0);
    b.box(1.2, 0.18, 0.05, { color: [0.9, 0.2, 0.16, 1], uvScale: 1.6 });
  });
  m.pop();
  m.pushTranslate(0, heightM * 0.86, 0.12);
  m.box(0.26, 0.3, 0.2, { color: [0.25, 0.25, 0.27, 1] });
  m.pop();
  // A ladder, which is the detail that gives the post scale.
  for (let i = 0; i < 6; i += 1) {
    m.pushTranslate(-0.16, 0.4 + i * (heightM * 0.11), 0);
    m.box(0.3, 0.04, 0.04, { color: [0.7, 0.7, 0.72, 1] });
    m.pop();
  }
  return m;
}

/**
 * A station building: brick walls, a pitched roof, a chimney, a door, and windows.
 *
 * Modelled as an assembly rather than one box, because the pitch of the roof and the recess of the windows are
 * what make a building read as a building rather than as a block. The brief asks for improved "station
 * structures" specifically, and the station is a landmark the player is meant to recognise.
 */
export function stationBuilding(widthM, depthM, wallHeightM) {
  const m = new MeshBuilder();
  const roofPitch = 0.42;

  m.pushTranslate(0, wallHeightM * 0.5, 0);
  m.box(widthM, wallHeightM, depthM, { color: [1, 1, 1, 1], uvScale: 0.5 });
  m.pop();

  // Two pitched slabs meeting at a ridge.
  const roofDepth = depthM * 0.62;
  m.pushTranslate(0, wallHeightM + roofPitch * depthM * 0.22, 0);
  for (const side of [-1, 1]) {
    m.scoped(Matrix.rotationX(side * Math.atan(roofPitch)), (b) => {
      b.pushTranslate(0, 0, (side * roofDepth) / 4);
      b.box(widthM * 1.06, 0.14, roofDepth, { color: [0.9, 0.9, 0.92, 1], uvScale: 1.1 });
    });
  }
  m.pop();

  // Chimney, offset from the ridge so the building is not a symmetric block.
  m.pushTranslate(widthM * 0.28, wallHeightM + roofPitch * depthM * 0.3, 0);
  m.box(0.6, 1.4, 0.6, { color: [0.8, 0.78, 0.76, 1], uvScale: 1.4 });
  m.pop();
  m.pushTranslate(widthM * 0.28, wallHeightM + roofPitch * depthM * 0.3 + 0.78, 0);
  m.box(0.76, 0.16, 0.76, { color: [0.7, 0.68, 0.66, 1] });
  m.pop();

  // Door and windows on the platform face, standing proud so they catch a shadow edge.
  m.pushTranslate(0, 1.05, depthM * 0.5 + 0.02);
  m.box(1.0, 2.1, 0.1, { color: [0.35, 0.42, 0.4, 1], uvScale: 1.4 });
  m.pop();
  for (const x of [-widthM * 0.32, widthM * 0.32]) {
    m.pushTranslate(x, wallHeightM * 0.6, depthM * 0.5 + 0.02);
    m.box(0.9, 1.2, 0.1, { color: [0.18, 0.2, 0.22, 1] });
    m.pop();
    m.pushTranslate(x, wallHeightM * 0.6, depthM * 0.5 + 0.07);
    m.box(1.0, 0.06, 0.06, { color: [0.9, 0.88, 0.84, 1] });
    m.pop();
  }
  return m;
}
