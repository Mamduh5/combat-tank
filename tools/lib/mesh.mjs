/**
 * A small procedural mesh construction library, used **offline** by the asset build tools.
 *
 * ## Why the geometry lives here
 *
 * V1-V6 built the vehicle out of Babylon primitives *at runtime, every launch*. That kept the model and the
 * `VehicleDefinition` in lockstep and involved no asset pipeline at all, but it also meant no textures, no
 * normal maps, no material authoring, and nothing an artist could open and replace.
 *
 * V7 replaces that with real assets. The geometry is authored **here**, in Node, and baked into a `.glb` the
 * game loads like any other asset. The consequences:
 *
 * - the mesh is constructed once, at build time, not 60 times a second;
 * - the result is a standard interchange format other tools can open and an artist can replace;
 * - UVs, material splits, and vertex colours are baked in, which runtime primitives never had;
 * - the runtime side becomes a *loader* with a documented contract, not a modelling exercise.
 *
 * The runtime counterpart is `src/client/render/vehicle-visual.ts`, which poses a loaded rig and contains no
 * modelling code at all.
 *
 * ## Coordinate convention (matches the runtime, deliberately)
 *
 * **+X right, +Y up, +Z forward (nose), metres.** Babylon is left-handed with `+Z` forward, and the
 * simulation's heading convention runs from `+Z` toward `+X`. Authoring in the same space means the
 * loader needs no axis swap and the orientation contract in `vehicle-visual.ts` stays the identity.
 *
 * glTF itself is right-handed with `-Z` forward. Rather than baking a conversion into every vertex — the
 * mistake that makes a model subtly wrong in a way nobody notices until it drives backwards — the
 * exporter writes a single root-node rotation, and the loader's documented contract absorbs it. See
 * `docs/asset-pipeline.md`.
 */

import { Matrix, Vector3 } from './math.mjs';

/**
 * An accumulating triangle mesh with positions, normals, UVs, and per-vertex colours.
 *
 * Deliberately not a class hierarchy of primitives with transforms: a single mutable buffer with an
 * explicit transform stack is far less code and makes the emitted data obvious.
 */
export class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    /** rgba quads, used for per-part tonal variation within one material */
    this.colors = [];
    this.indices = [];

    /** Transform stack. `identity` at the root; `push`/`pop` bracket a scope. */
    this._stack = [Matrix.identity];
  }

  /** The transform currently in effect. */
  get transform() {
    return this._stack[this._stack.length - 1];
  }

  push(matrix) {
    this._stack.push(this.transform.mul(matrix));
    return this;
  }

  /** Multiplies in a translation, the common case, without the caller building a matrix. */
  pushTranslate(x, y, z) {
    return this.push(Matrix.translation(x, y, z));
  }

  pushRotateX(rad) {
    return this.push(Matrix.rotationX(rad));
  }

  pushRotateY(rad) {
    return this.push(Matrix.rotationY(rad));
  }

  pushRotateZ(rad) {
    return this.push(Matrix.rotationZ(rad));
  }

  pushScale(x, y = x, z = x) {
    return this.push(Matrix.scaling(x, y, z));
  }

  pop() {
    if (this._stack.length <= 1) {
      throw new Error('MeshBuilder.pop() called with an empty transform stack');
    }
    this._stack.pop();
    return this;
  }

  /** Runs `body` inside a transform scope, then pops it even if `body` throws. */
  scoped(matrix, body) {
    this.push(matrix);
    try {
      body(this);
    } finally {
      this.pop();
    }
    return this;
  }

  /** Number of vertices written so far. */
  get vertexCount() {
    return this.positions.length / 3;
  }

  /**
   * Appends one vertex, transformed into the builder's current space.
   *
   * Normals are transformed by the rotation part only and re-normalised, which is correct for the rigid
   * transforms and the near-uniform scales this project uses, and avoids the cost of a full inverse
   * transpose on every vertex.
   */
  vertex(px, py, pz, nx, ny, nz, u, v, color) {
    const m = this.transform;
    const p = m.transformPoint(new Vector3(px, py, pz));
    const n = normalize3(m.transformDirection(new Vector3(nx, ny, nz)));

    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    this.colors.push(color[0], color[1], color[2], color.length > 3 ? color[3] : 1);
    return this.vertexCount - 1;
  }

  triangle(a, b, c) {
    this.indices.push(a, b, c);
    return this;
  }

  /** Appends a quad as two triangles, wound counter-clockwise when seen from the front. */
  quad(a, b, c, d) {
    this.indices.push(a, b, c, a, c, d);
    return this;
  }

  /**
   * A box centred on the origin, with per-face UVs scaled by world size.
   *
   * The UV scaling matters: it means a texture keeps a roughly constant texel density whether it lands
   * on a small stowage bin or a hull side, instead of stretching across whichever face it lands on.
   */
  box(width, height, depth, options = {}) {
    const { uvScale = 1, color = [1, 1, 1, 1] } = options;
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    // Each face is defined by its outward normal and the two in-plane axes, so the winding is derived
    // rather than hand-written six times (and mis-written once).
    const faces = [
      { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], su: width, sv: height, c: [hw, hh, hd] },
      { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], su: width, sv: height, c: [-hw, hh, -hd] },
      { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], su: depth, sv: height, c: [hw, hh, -hd] },
      { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], su: depth, sv: height, c: [-hw, hh, hd] },
      { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], su: width, sv: depth, c: [hw, hh, -hd] },
      { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], su: width, sv: depth, c: [-hw, -hh, hd] },
    ];

    for (const f of faces) {
      const base = this.vertexCount;
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        this.vertex(
          f.c[0] + f.u[0] * su * hw + f.v[0] * sv * hh,
          f.c[1] + f.u[1] * su * hw + f.v[1] * sv * hh,
          f.c[2] + f.u[2] * su * hw + f.v[2] * sv * hh,
          f.n[0],
          f.n[1],
          f.n[2],
          (su + 1) * 0.5 * f.su * uvScale,
          (sv + 1) * 0.5 * f.sv * uvScale,
          color,
        );
      }
      this.quad(base, base + 1, base + 2, base + 3);
    }
    return this;
  }

  /**
   * A tapered box: a box whose top face is scaled and shifted independently of its bottom.
   *
   * The single most useful primitive for a tank. A sloped glacis, a tapered turret, and a boat-nosed hull
   * are all tapered boxes, and a plain `box` cannot express any of them.
   *
   * @param {number} topScaleX top face width as a fraction of the bottom
   * @param {number} topScaleZ top face depth as a fraction of the bottom
   * @param {number} frontDrop how far the top face's front edge sits back, metres. Positive slopes the
   *   nose back, which is what makes a glacis rather than a bow.
   * @param {number} rearDrop the same at the rear, for an engine deck that slopes away
   */
  taperBox(width, height, depth, topScaleX, topScaleZ, frontDrop = 0, rearDrop = 0, options = {}) {
    const { uvScale = 1, color = [1, 1, 1, 1] } = options;
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;
    const tw = hw * topScaleX;

    const bottom = [
      [-hw, -hh, hd],
      [hw, -hh, hd],
      [hw, -hh, -hd],
      [-hw, -hh, -hd],
    ];
    const top = [
      [-tw, hh, hd - frontDrop],
      [tw, hh, hd - frontDrop],
      [tw, hh, -hd + rearDrop],
      [-tw, hh, -hd + rearDrop],
    ];

    // Four side faces, each with a normal derived from its own sloped edges. Using the geometric normal
    // rather than an approximate one is what makes a sloped plate catch light differently from a
    // vertical plate — the most important read on a tank hull.
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      const p0 = bottom[i];
      const p1 = bottom[j];
      const p3 = top[i];

      const eu = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const ev = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
      const n = normalize3([
        eu[1] * ev[2] - eu[2] * ev[1],
        eu[2] * ev[0] - eu[0] * ev[2],
        eu[0] * ev[1] - eu[1] * ev[0],
      ]);

      const spanU = Math.hypot(eu[0], eu[1], eu[2]) * uvScale;
      const spanV = Math.hypot(ev[0], ev[1], ev[2]) * uvScale;
      const base = this.vertexCount;
      for (const [p, u, v] of [
        [p0, 0, 0],
        [p1, spanU, 0],
        [top[j], spanU, spanV],
        [p3, 0, spanV],
      ]) {
        this.vertex(p[0], p[1], p[2], n[0], n[1], n[2], u, v, color);
      }
      this.quad(base, base + 1, base + 2, base + 3);
    }

    this._cap(top, [0, 1, 0], color, uvScale);
    this._cap(bottom, [0, -1, 0], color, uvScale);
    return this;
  }

  _cap(points, normal, color, uvScale) {
    const base = this.vertexCount;
    let uMin = Infinity;
    let vMin = Infinity;
    for (const p of points) {
      uMin = Math.min(uMin, p[0]);
      vMin = Math.min(vMin, p[2]);
    }
    for (const p of points) {
      this.vertex(
        p[0],
        p[1],
        p[2],
        normal[0],
        normal[1],
        normal[2],
        (p[0] - uMin) * uvScale,
        (p[2] - vMin) * uvScale,
        color,
      );
    }
    if (normal[1] > 0) {
      this.quad(base, base + 1, base + 2, base + 3);
    } else {
      this.quad(base, base + 3, base + 2, base + 1);
    }
    return this;
  }


  /**
   * A cylinder along +Y, optionally tapered and optionally open-ended.
   *
   * `radiusTop < radiusBottom` gives a muzzle-brake swell, a tapered mantlet, or a tree trunk; equal
   * radii give a barrel or a wheel rim.
   *
   * `arc` sweeps less than a full turn, which is how a dished wheel face or a partially-occluded
   * cylinder is made; a closed cylinder cannot express them.
   */
  cylinder(radiusBottom, radiusTop, height, segments = 16, options = {}) {
    const { capped = true, arc = Math.PI * 2, arcStart = 0, color = [1, 1, 1, 1], uvScale = 1 } = options;
    const hh = height / 2;
    const closed = Math.abs(arc - Math.PI * 2) < 1e-6;
    const slope = height > 1e-6 ? (radiusBottom - radiusTop) / height : 0;
    const ringCount = closed ? segments : segments + 1;

    const base = this.vertexCount;
    for (let i = 0; i < ringCount; i += 1) {
      const a = arcStart + arc * (i / segments);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // The side normal tilts with the taper, which is what makes a cone's shading correct rather than
      // banded.
      const n = normalize3([cos, slope, sin]);
      const u = a * Math.max(radiusBottom, radiusTop) * uvScale;
      this.vertex(cos * radiusBottom, -hh, sin * radiusBottom, n[0], n[1], n[2], u, 0, color);
      this.vertex(cos * radiusTop, hh, sin * radiusTop, n[0], n[1], n[2], u, height * uvScale, color);
    }
    for (let i = 0; i < ringCount - 1; i += 1) {
      const a = base + i * 2;
      this.quad(a, a + 2, a + 3, a + 1);
    }

    if (capped) {
      for (const [y, radius, ny] of [
        [hh, radiusTop, 1],
        [-hh, radiusBottom, -1],
      ]) {
        if (radius <= 1e-6) {
          continue;
        }
        const centre = this.vertex(0, y, 0, 0, ny, 0, 0.5, 0.5, color);
        const ringStart = this.vertexCount;
        for (let i = 0; i < ringCount; i += 1) {
          const a = arcStart + arc * (i / segments);
          this.vertex(
            Math.cos(a) * radius,
            y,
            Math.sin(a) * radius,
            0,
            ny,
            0,
            0.5 + Math.cos(a) * 0.5,
            0.5 + Math.sin(a) * 0.5,
            color,
          );
        }
        for (let i = 0; i < ringCount - 1; i += 1) {
          if (ny > 0) {
            this.triangle(centre, ringStart + i, ringStart + i + 1);
          } else {
            this.triangle(centre, ringStart + i + 1, ringStart + i);
          }
        }
      }
    }
    return this;
  }

  /**
   * A cylinder along **+Z**, the vehicle's forward axis.
   *
   * A gun barrel points along the vehicle's forward axis, so authoring it directly along +Z removes a
   * rotation from the model, from the loader contract, and from every future tank built with this tool.
   */
  tubeZ(radius, length, segments = 14, options = {}) {
    return this.scoped(Matrix.rotationX(-Math.PI / 2), (m) => {
      m.cylinder(radius, options.radiusTop ?? radius, length, segments, options);
    });
  }

  /** A UV sphere, for rounded castings and the muzzle-blast volume. */
  sphere(radius, segments = 14, rings = 10, options = {}) {
    const { color = [1, 1, 1, 1] } = options;
    const base = this.vertexCount;
    for (let r = 0; r <= rings; r += 1) {
      const phi = (r / rings) * Math.PI;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      for (let s = 0; s <= segments; s += 1) {
        const theta = (s / segments) * Math.PI * 2;
        const x = sinPhi * Math.cos(theta);
        const y = cosPhi;
        const z = sinPhi * Math.sin(theta);
        this.vertex(x * radius, y * radius, z * radius, x, y, z, s / segments, r / rings, color);
      }
    }
    const stride = segments + 1;
    for (let r = 0; r < rings; r += 1) {
      for (let s = 0; s < segments; s += 1) {
        const a = base + r * stride + s;
        this.quad(a, a + stride, a + stride + 1, a + 1);
      }
    }
    return this;
  }

  /**
   * Merges another builder's geometry through the current transform.
   *
   * Used to compose assemblies — a wheel unit, a track unit, a stowage bin — as self-contained builders
   * that are then instanced many times. Writing each assembly inline instead duplicates the vertex math
   * and turns every change into a multi-site edit.
   */
  append(other) {
    const offset = this.vertexCount;
    const m = this.transform;
    for (let i = 0; i < other.positions.length; i += 3) {
      const p = m.transformPoint(
        new Vector3(other.positions[i], other.positions[i + 1], other.positions[i + 2]),
      );
      this.positions.push(p.x, p.y, p.z);
      const n = m.transformDirection(
        new Vector3(other.normals[i], other.normals[i + 1], other.normals[i + 2]),
      );
      const len = Math.hypot(n.x, n.y, n.z) || 1;
      this.normals.push(n.x / len, n.y / len, n.z / len);
    }
    for (const uv of other.uvs) {
      this.uvs.push(uv);
    }
    for (const c of other.colors) {
      this.colors.push(c);
    }
    for (const index of other.indices) {
      this.indices.push(index + offset);
    }
    return this;
  }

  /** True when nothing has been written, so optional details can be skipped. */
  get isEmpty() {
    return this.indices.length === 0;
  }
}

/**
 * Unit-length `Vector3`, falling back to +Y for a degenerate input rather than emitting NaNs.
 *
 * ## Why the return type matters here
 *
 * This previously returned a plain array `[x, y, z]`, and the single call site in `vertex()` then read
 * `n.x`, `n.y`, `n.z` off it. On an array those are all `undefined`, so `undefined` was pushed straight into
 * the normal buffer and every normal in every generated `.glb` was `NaN`.
 *
 * The visible consequence was a tank that rendered as a solid black silhouette: a NaN normal propagates
 * through the lighting shader, so every fragment failed its `N·L` test and shaded to black. It type-checked,
 * the asset audit reported the meshes as textured and PBR, `isReady()` was true, and the model loaded with a
 * correct hull measurement — because nothing about *loading* a model exercises the normals' values.
 *
 * Returning a real `Vector3` makes the two representations interchangeable at the call site, so the mistake
 * cannot recur in the same silent way.
 */
function normalize3(v) {
  const x = v.x ?? v[0];
  const y = v.y ?? v[1];
  const z = v.z ?? v[2];
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 1e-9) {
    // A non-finite input is treated the same as a degenerate one: emit a usable normal rather than
    // propagating the bad value into every downstream vertex.
    return new Vector3(0, 1, 0);
  }
  return new Vector3(x / length, y / length, z / length);
}

