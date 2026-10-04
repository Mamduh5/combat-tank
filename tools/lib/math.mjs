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
    return new Vector3(
      a[0] * v.x + a[1] * v.y + a[2] * v.z + a[3],
      a[4] * v.x + a[5] * v.y + a[6] * v.z + a[7],
      a[8] * v.x + a[9] * v.y + a[10] * v.z + a[11],
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
