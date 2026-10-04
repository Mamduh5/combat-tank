/**
 * A minimal 4x4 matrix and vector, for the **offline** asset build tools.
 *
 * Babylon has both, but these scripts run in Node before Babylon is ever loaded, and pulling the engine
 * into a build script to multiply four numbers would be a much heavier dependency than the arithmetic
 * warrants. Kept deliberately small: the tools only compose rigid transforms and uniform-ish scales.
 */

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

/**
 * A row-major 4x4 matrix stored as 16 numbers, matching glTF's column-major-on-the-wire convention via
 * `toColumnMajorArray` at export time.
 */
export class Matrix {
  constructor(m) {
    this.m = m;
  }

  static get identity() {
    return new Matrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  static translation(x, y, z) {
    return new Matrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  }

  static scaling(x, y, z) {
    return new Matrix([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
  }

  static rotationX(rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return new Matrix([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  }

  static rotationY(rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return new Matrix([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  }

  static rotationZ(rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return new Matrix([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  /** Matrix product. `this` is applied first, then `other`. */
  mul(other) {
    const a = this.m;
    const b = other.m;
    const out = new Array(16);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        out[row * 4 + col] =
          a[row * 4] * b[col] +
          a[row * 4 + 1] * b[4 + col] +
          a[row * 4 + 2] * b[8 + col] +
          a[row * 4 + 3] * b[12 + col];
      }
    }
    return new Matrix(out);
  }

  transformPoint(v) {
    const a = this.m;
    // The translation is read from `a[12..14]` — the **last row**, not the fourth column.
    //
    // This is the bug that produced three different contract violations on every vehicle at once, and it is
    // worth recording why it was so hard to see. `translation()` writes `[..., x, y, z, 1]` into indices
    // 12–14, and `mul()` composes row-major, so the whole module is row-major and internally consistent.
    // `transformPoint` was the single function that reached for `a[3], a[7], a[11]` — the fourth *column* —
    // as if the storage were column-major. For a rotation or a scale, all four of those entries are `0`, so
    // the bug is invisible. For a translation they are exactly the values being discarded.
    //
    // So `pushTranslate` silently did nothing, and every part of every generated model collapsed onto the
    // origin: the hull's authored lift above the track line vanished, the fenders' lateral offset vanished,
    // and the model came out both wider than its definition and sunk below its own origin. Every type check,
    // lint rule and unit test passed, because all of them were reading the *authored* numbers rather than the
    // *produced* vertices. `transformDirection` is correct and is deliberately left alone — it takes no
    // translation, so it never had the ambiguity.
    return new Vector3(
      a[0] * v.x + a[1] * v.y + a[2] * v.z + a[12],
      a[4] * v.x + a[5] * v.y + a[6] * v.z + a[13],
      a[8] * v.x + a[9] * v.y + a[10] * v.z + a[14],
    );
  }

  /**
   * Transforms a direction, ignoring translation.
   *
   * Rotation and scale are applied; the w component's translation term is deliberately excluded. Results
   * are re-normalised by callers that need unit normals.
   */
  transformDirection(v) {
    const a = this.m;
    return new Vector3(
      a[0] * v.x + a[1] * v.y + a[2] * v.z,
      a[4] * v.x + a[5] * v.y + a[6] * v.z,
      a[8] * v.x + a[9] * v.y + a[10] * v.z,
    );
  }

  /** glTF node matrices are column-major, i.e. the transpose of our row-major storage. */
  toColumnMajorArray() {
    const a = this.m;
    return [
      a[0], a[4], a[8], a[12],
      a[1], a[5], a[9], a[13],
      a[2], a[6], a[10], a[14],
      a[3], a[7], a[11], a[15],
    ];
  }
}
