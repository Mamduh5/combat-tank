/**
 * Mesh construction helpers shared by the client renderers.
 *
 * Extracted from `scene.ts` so the terrain builder reads as terrain construction rather than as
 * index-buffer arithmetic, and so the same routine can build the placeholder tank's geometry
 * later without duplicating it.
 */

/**
 * Accumulates per-vertex normals from face normals.
 *
 * A standard area-weighted accumulation: for each triangle, compute the cross product of its edge
 * vectors and add that face normal to all three of its vertices, then normalise. Smoother and more
 * robust than using a single face's normal per vertex, which produces visible faceting on the
 * terrain at grazing angles — exactly the angles the player looks at in a third-person camera.
 *
 * @param positions flat xyz triples
 * @param indices   flat vertex-index triples
 * @returns         flat xyz triples, one normal per vertex
 */
export function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  normals.fill(0);

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const abx = positions[b]! - positions[a]!;
    const aby = positions[b + 1]! - positions[a + 1]!;
    const abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!;
    const acy = positions[c + 1]! - positions[a + 1]!;
    const acz = positions[c + 2]! - positions[a + 2]!;

    // Cross product of the edge vectors gives an area-weighted face normal.
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.sqrt(normals[i]! ** 2 + normals[i + 1]! ** 2 + normals[i + 2]! ** 2);
    if (len > 1e-9) {
      normals[i] = normals[i]! / len;
      normals[i + 1] = normals[i + 1]! / len;
      normals[i + 2] = normals[i + 2]! / len;
    } else {
      // Degenerate vertex: point straight up rather than emitting NaN, which would make the whole
      // mesh disappear.
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
  }

  return normals;
}
