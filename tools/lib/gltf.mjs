/**
 * A glTF 2.0 `.glb` writer.
 *
 * ## Why write glTF by hand instead of adding a dependency
 *
 * V7 needs the game to load a real, standard 3D asset format. The obvious route is a library, but the
 * subset of glTF this project emits is small and fully specified: a node hierarchy, indexed triangle
 * meshes with POSITION/NORMAL/TEXCOORD_0/COLOR_0, and PBR materials with base-colour, metallic-roughness,
 * and normal textures. Writing that directly is a few hundred lines with no dependency, no lockfile
 * churn, and no risk of a transitive package's licence mattering — which the brief treats as a real
 * constraint, not a formality.
 *
 * The output is a genuine `.glb`, openable in any glTF viewer, and loadable by Babylon's stock
 * `SceneLoader`. That is the point: it proves the *pipeline*, not a bespoke format.
 *
 * ## What is deliberately not emitted
 *
 * Skins, animations, morph targets, cameras, and lights. V7's tank is rigid with separately-transformed
 * parts driven by the simulation; adding an animation system here would be inventing a V8 concern.
 *
 * ## The handedness fix, in one place
 *
 * The models are authored in Babylon's left-handed space (+Z forward). glTF is right-handed with -Z
 * forward, so a naive export drives the tank backwards. Rather than rewriting every vertex, the exporter
 * emits one root node carrying a 180-degree Y rotation. That single node is the entire conversion, it is
 * visible to anyone opening the file, and the runtime loader's documented contract accounts for it.
 */

import { Matrix } from './math.mjs';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** glTF component types used here. */
const COMPONENT = {
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
};

/** glTF buffer-view targets. */
const TARGET = {
  ARRAY_BUFFER: 34962,
  ELEMENT_ARRAY_BUFFER: 34963,
};

/**
 * Accumulates the binary buffer and the JSON document, then serialises both into one `.glb`.
 */
export class GltfBuilder {
  constructor(options = {}) {
    this.asset = {
      version: '2.0',
      generator: options.generator ?? 'combat-tank asset pipeline',
    };

    /** @type {Buffer[]} */
    this._chunks = [];
    this._byteLength = 0;

    this.meshes = [];
    this.nodes = [];
    this.materials = [];
    this.textures = [];
    this.images = [];
    this.samplers = [];

    this.bufferViews = [];
    this.accessors = [];

    this.sceneRoots = [];
  }

  /**
   * Appends raw bytes to the binary buffer, 4-byte aligned as glTF requires.
   *
   * @returns {number} the index of the created bufferView
   */
  _appendBufferView(bytes, target) {
    const padding = (4 - (this._byteLength % 4)) % 4;
    if (padding > 0) {
      this._chunks.push(Buffer.alloc(padding));
      this._byteLength += padding;
    }
    const byteOffset = this._byteLength;
    this._chunks.push(bytes);
    this._byteLength += bytes.length;
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
    return this.bufferViews.length - 1;
  }

  /** Registers an image, embedded in the binary chunk rather than referenced as a separate file. */
  addTexture(pngBytes, options = {}) {
    const bufferView = this._appendBufferView(pngBytes, undefined);
    this.images.push({ bufferView, mimeType: 'image/png', name: options.name });

    // One sampler shared by every texture. `repeat` wrapping with trilinear mipmaps: the project tiles
    // textures across large surfaces, and mipmaps are what stop a minified ballast or bark texture from
    // aliasing into noise at distance.
    if (this.samplers.length === 0) {
      this.samplers.push({
        magFilter: 9729, // LINEAR
        minFilter: 9987, // LINEAR_MIPMAP_LINEAR
        wrapS: 10497, // REPEAT
        wrapT: 10497,
      });
    }
    this.textures.push({ source: this.images.length - 1, sampler: 0, name: options.name });
    return this.textures.length - 1;
  }

  /**
   * Adds a PBR material.
   *
   * @param {object} spec
   * @param {number[]} [spec.baseColorFactor] linear RGBA tint
   * @param {number} [spec.metallicFactor] 0 for painted/dielectric, 1 for bare metal
   * @param {number} [spec.roughnessFactor] 1 for matte paint, lower for polished steel
   * @param {number[]} [spec.baseColorTexture] texture indices from `addTexture`
   */
  addMaterial(spec) {
    const pbr = {
      baseColorFactor: [...(spec.baseColorFactor ?? [1, 1, 1, 1])],
      metallicFactor: spec.metallicFactor ?? 0,
      roughnessFactor: spec.roughnessFactor ?? 0.85,
    };

    if (spec.baseColorTexture !== undefined) {
      pbr.baseColorTexture = { index: spec.baseColorTexture, texCoord: 0 };
    }
    // glTF packs occlusion in red, roughness in green, metalness in blue of one texture, so the pair is
    // emitted as a single texture index and the runtime reads only the channels it needs.
    if (spec.metallicRoughnessTexture !== undefined) {
      pbr.metallicRoughnessTexture = { index: spec.metallicRoughnessTexture, texCoord: 0 };
    }

    const material = {
      name: spec.name,
      pbrMetallicRoughness: pbr,
      doubleSided: spec.doubleSided ?? false,
    };
    if (spec.normalTexture !== undefined) {
      material.normalTexture = { index: spec.normalTexture, texCoord: 0, scale: spec.normalScale ?? 1 };
    }
    if (spec.emissiveFactor !== undefined) {
      material.emissiveFactor = spec.emissiveFactor;
    }

    this.materials.push(material);
    return this.materials.length - 1;
  }


  /**
   * Adds an indexed triangle mesh.
   *
   * Indices are widened to `UNSIGNED_INT` beyond 65536 vertices. Babylon and every WebGL2 target accept
   * 32-bit indices, and choosing per mesh would mean two code paths through the exporter and the
   * runtime for no measurable gain at these poly counts.
   */
  addMesh(name, mesh, material) {
    const positions = Buffer.from(new Float32Array(mesh.positions).buffer);
    const normals = Buffer.from(new Float32Array(mesh.normals).buffer);
    const uvs = Buffer.from(new Float32Array(mesh.uvs).buffer);
    const colors = Buffer.from(new Float32Array(mesh.colors).buffer);
    const vertexCount = mesh.positions.length / 3;
    const indicesArray =
      vertexCount > 65535 ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
    const indices = Buffer.from(indicesArray.buffer);

    const positionView = this._appendBufferView(positions, TARGET.ARRAY_BUFFER);
    const normalView = this._appendBufferView(normals, TARGET.ARRAY_BUFFER);
    const uvView = this._appendBufferView(uvs, TARGET.ARRAY_BUFFER);
    const colorView = this._appendBufferView(colors, TARGET.ARRAY_BUFFER);
    const indexView = this._appendBufferView(indices, TARGET.ELEMENT_ARRAY_BUFFER);

    // glTF *requires* min/max on POSITION accessors; loaders use them to build bounds without reading
    // the whole buffer, so they are computed here rather than left to the runtime.
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], mesh.positions[i + axis]);
        max[axis] = Math.max(max[axis], mesh.positions[i + axis]);
      }
    }

    this.accessors.push({
      bufferView: positionView,
      componentType: COMPONENT.FLOAT,
      count: vertexCount,
      type: 'VEC3',
      min,
      max,
    });
    const positionAccessor = this.accessors.length - 1;

    this.accessors.push({
      bufferView: normalView,
      componentType: COMPONENT.FLOAT,
      count: vertexCount,
      type: 'VEC3',
    });
    const normalAccessor = this.accessors.length - 1;

    this.accessors.push({
      bufferView: uvView,
      componentType: COMPONENT.FLOAT,
      count: mesh.uvs.length / 2,
      type: 'VEC2',
    });
    const uvAccessor = this.accessors.length - 1;

    this.accessors.push({
      bufferView: colorView,
      componentType: COMPONENT.FLOAT,
      count: mesh.colors.length / 4,
      type: 'VEC4',
    });
    const colorAccessor = this.accessors.length - 1;

    this.accessors.push({
      bufferView: indexView,
      componentType:
        indicesArray instanceof Uint32Array ? COMPONENT.UNSIGNED_INT : COMPONENT.UNSIGNED_SHORT,
      count: mesh.indices.length,
      type: 'SCALAR',
    });
    const indexAccessor = this.accessors.length - 1;

    this.meshes.push({
      name,
      primitives: [
        {
          attributes: {
            POSITION: positionAccessor,
            NORMAL: normalAccessor,
            TEXCOORD_0: uvAccessor,
            COLOR_0: colorAccessor,
          },
          indices: indexAccessor,
          material,
          mode: 4, // TRIANGLES
        },
      ],
    });
    return this.meshes.length - 1;
  }


  /**
   * Adds a node, optionally with a local transform and children.
   *
   * @param {object} spec
   * @param {string} spec.name node name. The runtime loader resolves parts **by name**, so these
   *   strings are part of the documented asset contract rather than decoration — see
   *   `docs/asset-pipeline.md`.
   */
  addNode(spec) {
    const node = { name: spec.name };
    if (spec.mesh !== undefined) {
      node.mesh = spec.mesh;
    }
    if (spec.children !== undefined && spec.children.length > 0) {
      node.children = spec.children;
    }
    if (spec.matrix !== undefined) {
      node.matrix = spec.matrix.toColumnMajorArray();
    } else {
      const t = spec.translation ?? [0, 0, 0];
      const r = spec.rotation ?? [0, 0, 0, 1];
      const s = spec.scale ?? [1, 1, 1];
      // glTF omits identity components, and writing them all would inflate the file for no information.
      if (t[0] !== 0 || t[1] !== 0 || t[2] !== 0) {
        node.translation = t;
      }
      if (r[0] !== 0 || r[1] !== 0 || r[2] !== 0 || r[3] !== 1) {
        node.rotation = r;
      }
      if (s[0] !== 1 || s[1] !== 1 || s[2] !== 1) {
        node.scale = s;
      }
    }
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  /** Serialises the accumulated document and buffer into a single `.glb` file. */
  build() {
    const bin = Buffer.concat(this._chunks, this._byteLength);

    const json = {
      asset: this.asset,
      scene: 0,
      scenes: [{ nodes: this.sceneRoots, name: 'Scene' }],
      nodes: this.nodes,
      meshes: this.meshes,
      materials: this.materials,
      accessors: this.accessors,
      bufferViews: this.bufferViews,
      buffers: [{ byteLength: bin.length }],
    };
    if (this.textures.length > 0) {
      json.textures = this.textures;
      json.images = this.images;
      json.samplers = this.samplers;
    }

    // GLB chunk payloads must be 4-byte aligned; the JSON chunk is space-padded and the binary chunk
    // zero-padded, exactly as the specification requires.
    const jsonText = JSON.stringify(json);
    const jsonPad = (4 - (Buffer.byteLength(jsonText) % 4)) % 4;
    const jsonBytes = Buffer.from(jsonText + ' '.repeat(jsonPad), 'utf8');
    const binPad = (4 - (bin.length % 4)) % 4;
    const binBytes = bin.length > 0 ? Buffer.concat([bin, Buffer.alloc(binPad)]) : null;

    const totalLength = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0);
    const out = Buffer.alloc(totalLength);

    let offset = 0;
    out.writeUInt32LE(GLB_MAGIC, offset);
    out.writeUInt32LE(2, offset + 4);
    out.writeUInt32LE(totalLength, offset + 8);
    offset += 12;

    out.writeUInt32LE(jsonBytes.length, offset);
    out.writeUInt32LE(CHUNK_JSON, offset + 4);
    jsonBytes.copy(out, offset + 8);
    offset += 8 + jsonBytes.length;

    if (binBytes) {
      out.writeUInt32LE(binBytes.length, offset);
      out.writeUInt32LE(CHUNK_BIN, offset + 4);
      binBytes.copy(out, offset + 8);
    }

    return out;
  }
}

/** Quaternion (x, y, z, w) for a rotation about +Y, for the root handedness node. */
export function quaternionY(rad) {
  return [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
}

/**
 * The rotation mapping the authored left-handed, +Z-forward model into glTF's right-handed,
 * -Z-forward convention.
 *
 * Exported rather than inlined so the exporter's forward contract and the runtime loader's inverse
 * contract are recognisably two halves of one decision, documented in `docs/asset-pipeline.md`.
 */
export const AUTHORED_TO_GLTF_HANDEDNESS = Matrix.rotationY(Math.PI);
