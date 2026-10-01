import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Scene } from '@babylonjs/core/scene.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import type { Engine } from '@babylonjs/core/Engines/engine.js';
import type { Terrain } from '../../core/world/terrain.js';
import { buildTerrainGrid } from '../../core/world/terrain-grid.js';
import { computeVertexNormals } from './mesh-utils.js';

/**
 * Babylon scene construction: camera, lighting, sky, and the terrain surface.
 *
 * Babylon is the **view** and nothing more (`docs/technical-direction.md` §6). Nothing in this file
 * decides a gameplay outcome; it reads simulation state and draws it.
 *
 * Art is deliberately placeholder. `docs/vision.md` principle P8 requires that the project not be
 * blocked on final artwork, so the terrain is an untextured mesh with a height-based colour ramp.
 * Real assets are a V12 task, and the vehicle's `visualId` binding is what will make that a data
 * change rather than a rewrite.
 */

/** Visual tuning. Separated from logic so look can be adjusted without touching behaviour. */
export const SCENE_TUNING = {
  /** Far clip plane, metres. Beyond the play area, so it never clips visibly. */
  cameraMaxZ: 900,
  /** Field of view in radians. Slightly narrow, which compresses distance a little. */
  cameraFovRad: 0.86,
  /** Near clip plane, metres. Small enough to avoid clipping the hull at close camera range. */
  cameraMinZ: 0.35,

  /**
   * Sky, as a vertical gradient rather than a single clear colour.
   *
   * A flat fill gave the player no horizon: the terrain simply stopped, and with the ground and sky
   * both washed out there was nothing to judge distance against. The gradient puts a paler band at the
   * horizon and a deeper blue overhead, which is what makes the ground read as *ground* rather than
   * as an absence of geometry.
   */
  skyZenith: new Color4(0.35, 0.51, 0.72, 1),
  skyHorizon: new Color4(0.71, 0.78, 0.8, 1),
  /** Colour the terrain fades toward with distance, matched to the horizon band so they meet cleanly. */
  hazeColor: new Color3(0.71, 0.78, 0.8),

  /**
   * Height bands for the terrain ramp, from lowest ground to highest.
   *
   * Chosen to give the landscape readable structure with no textures: dark olive in the low ground,
   * through a dry mid green, to pale tan on the ridges. Values are placeholder art direction, not a
   * terrain classification system.
   */
  groundBands: [
    new Color3(0.21, 0.25, 0.16),
    new Color3(0.29, 0.34, 0.2),
    new Color3(0.38, 0.43, 0.25),
    new Color3(0.47, 0.48, 0.31),
    new Color3(0.55, 0.53, 0.39),
    new Color3(0.62, 0.59, 0.47),
  ] as const,

  /** Sun direction and intensity. Angled so hull faces and slopes catch different light. */
  sunDirection: new Vector3(-0.55, -0.78, 0.3),
  sunIntensity: 1.25,
  ambientIntensity: 0.62,
  /** Colour bounced up from the ground onto the underside of the hull. */
  ambientGroundColor: new Color3(0.3, 0.32, 0.24),
  /**
   * Range marker colour.
   *
   * A warm orange that appears nowhere else in the scene, so the posts read as man-made range
   * furniture rather than as terrain features, and stay legible against green ground at distance.
   */
  rangeMarkerColor: new Color3(0.86, 0.44, 0.16),
} as const;

/** Grid resolution of the rendered terrain mesh. Finer than the collision heightfield. */
const TERRAIN_RENDER_CELLS = 160;

export interface SceneBundle {
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  readonly terrainMesh: Mesh;
  /** Proving-ground furniture. Decoration only: no collision, picking, or gameplay effect. */
  readonly rangeMarkers: readonly Mesh[];
}

/** Exponential-squared fog density. Tuned so the far edge of the play area hazes out, not nearby ground. */
const FOG_DENSITY = 0.0042;

/**
 * Where the range markers stand, measured along +Z from the origin.
 *
 * These are the distances the player is likely to engage at, so seeing a marker pass the hull is a
 * direct read-out of range without any UI. 50/100/150 m spans short, medium, and long shots.
 */
const RANGE_MARKER_DISTANCES_M = [50, 100, 150] as const;

/** Lateral offset of each post pair from the firing line, metres. */
const RANGE_MARKER_SIDES = [-14, 14] as const;

/** Height of a range post, metres. */
const RANGE_MARKER_HEIGHT_M = 2.6;

/** Builds the scene, camera, lighting, sky, and terrain mesh. */
export function createScene(engine: Engine, terrain: Terrain): SceneBundle {
  const scene = new Scene(engine);

  // A plain free camera: the orbit rig drives its transform directly each frame, so no built-in
  // camera controls are attached. Attaching them would fight the orbit logic.
  const camera = new UniversalCamera('main', new Vector3(0, 12, -18), scene);
  camera.minZ = SCENE_TUNING.cameraMinZ;
  camera.maxZ = SCENE_TUNING.cameraMaxZ;
  camera.fov = SCENE_TUNING.cameraFovRad;
  camera.inputs.clear();

  // Built after the camera, because the dome tracks the camera's position each frame.
  applySkyGradient(scene, camera);

  // A directional sun for shape, and a hemispheric fill so the underside of the hull is not black.
  const sun = new DirectionalLight('sun', SCENE_TUNING.sunDirection, scene);
  sun.intensity = SCENE_TUNING.sunIntensity;

  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
  ambient.intensity = SCENE_TUNING.ambientIntensity;
  ambient.diffuse = new Color3(0.75, 0.8, 0.85);
  ambient.groundColor = SCENE_TUNING.ambientGroundColor;

  const terrainMesh = buildTerrainMesh(scene, terrain);
  const rangeMarkers = buildRangeMarkers(scene, terrain);

  // Distance haze, so far terrain fades into the horizon instead of ending abruptly. This is what
  // lets the player judge range without a map: nearby ground is saturated, distant ground is not.
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = SCENE_TUNING.hazeColor;
  scene.fogDensity = FOG_DENSITY;

  return { scene, camera, terrainMesh, rangeMarkers };
}

/**
 * Paints the sky as a vertical gradient on a large inverted sphere.
 *
 * A single clear colour leaves no horizon, so the terrain simply stops against a flat wall of colour.
 *
 * The sphere is **large rather than camera-locked**. `infiniteDistance` was the obvious choice and it
 * does translate the dome with the camera, but it does not rescale it: a 2 m sphere sitting exactly at
 * the camera's position sits inside the near plane and fills the entire frame, hiding the world
 * behind a flat wash of sky. Sizing the dome comfortably inside the far plane and following the camera
 * each frame gives the same "always at infinity" behaviour with geometry the depth buffer can
 * actually reason about.
 */
function applySkyGradient(scene: Scene, camera: UniversalCamera): void {
  const dome = MeshBuilder.CreateSphere(
    'sky',
    { diameter: SKY_DOME_DIAMETER_M, segments: 24, sideOrientation: Mesh.BACKSIDE },
    scene,
  );
  dome.isPickable = false;
  dome.applyFog = false;
  // Scenery, not an obstacle: it must never be hit by a ray cast or counted as world geometry.
  dome.alwaysSelectAsActiveMesh = true;

  const material = new StandardMaterial('sky-mat', scene);
  // Unlit and self-illuminated: the sky is a backdrop and must not darken when the sun is behind it.
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();

  // Vertex colours carry the gradient, interpolated across the sphere from zenith to horizon.
  const positions = dome.getVerticesData(VertexBuffer.PositionKind)!;
  const indices = dome.getIndices()!;
  const colors = new Float32Array((positions.length / 3) * 4);
  const zenith = SCENE_TUNING.skyZenith;
  const horizon = SCENE_TUNING.skyHorizon;
  const radius = SKY_DOME_DIAMETER_M * 0.5;

  for (let i = 0; i < positions.length / 3; i += 1) {
    // Normalised height on the sphere: 0 at the nadir, 1 at the zenith.
    const t = Math.min(1, Math.max(0, positions[i * 3 + 1]! / radius * 0.5 + 0.5));
    // Bias the blend so the pale horizon band stays tight to the skyline and the zenith stays deep.
    const blend = Math.pow(t, 0.45);
    colors[i * 4] = horizon.r + (zenith.r - horizon.r) * blend;
    colors[i * 4 + 1] = horizon.g + (zenith.g - horizon.g) * blend;
    colors[i * 4 + 2] = horizon.b + (zenith.b - horizon.b) * blend;
    colors[i * 4 + 3] = 1;
  }

  const vertexData = new VertexData();
  vertexData.positions = positions as unknown as number[];
  vertexData.indices = indices as unknown as number[];
  vertexData.colors = colors as unknown as number[];
  vertexData.applyToMesh(dome, false);

  dome.material = material;

  // Track the camera every frame so the dome is always centred on the viewer and never approached.
  scene.onBeforeRenderObservable.add(() => {
    dome.position.copyFrom(camera.globalPosition);
  });
}

/**
 * Sky dome diameter, metres.
 *
 * Comfortably inside `cameraMaxZ` (900) so the dome is never clipped by the far plane, and far larger
 * than the play area so it reads as being beyond everything the player can reach.
 */
const SKY_DOME_DIAMETER_M = 1600;

/**
 * Builds the visible terrain surface.
 *
 * Uses the shared grid from `src/core/world/terrain-grid.js` — the same vertex buffer the Rapier
 * collider is built from — so what the player sees and what the camera collides with are the same
 * surface by construction rather than by two independent samplings agreeing.
 *
 * The colour ramp was reworked during the V3R playability pass. A single green-to-brown ramp over the
 * terrain's full height range produced one flat green expanse: there was no way to judge distance,
 * slope, or where the ground ended, so the world read as a featureless void. Height is now mapped
 * through several distinct bands, and distance from the camera fades the ground toward the horizon
 * colour, which is what gives the landscape depth.
 */
function buildTerrainMesh(scene: Scene, terrain: Terrain): Mesh {
  const grid = buildTerrainGrid(terrain, TERRAIN_RENDER_CELLS);

  const colors = new Float32Array(grid.colors.length);
  const range = grid.colors;
  for (let i = 0; i < grid.samples * grid.samples; i += 1) {
    const t = range[i * 4]!;
    const band = terrainBandColor(t);
    colors[i * 4] = band.r;
    colors[i * 4 + 1] = band.g;
    colors[i * 4 + 2] = band.b;
    colors[i * 4 + 3] = 1;
  }

  const mesh = new Mesh('terrain', scene);
  const vertexData = new VertexData();
  vertexData.positions = grid.positions as unknown as number[];
  vertexData.indices = grid.indices as unknown as number[];
  vertexData.colors = colors as unknown as number[];
  vertexData.normals = computeVertexNormals(grid.positions, grid.indices) as unknown as number[];
  vertexData.applyToMesh(mesh, false);

  const material = new StandardMaterial('terrain-mat', scene);
  material.diffuseColor = Color3.White();
  // No specular: a shiny untextured plane reads as plastic and makes slopes harder to judge.
  material.specularColor = Color3.Black();

  // Present the ground's upward-facing triangles to the renderer as front faces.
  //
  // `buildTerrainGrid` winds the grid the way a right-handed cross product calls upward-facing, which
  // is what gives correct *normals* for lighting and for the physics ray casts. Babylon is
  // left-handed and defaults to the opposite winding, so those triangles were classified as back faces
  // and culled: the ground was invisible and the player saw the tank floating in a void, with the
  // terrain reduced to slivers along the horizon.
  //
  // Two earlier states confirm the diagnosis. Reversing the winding in the grid made the ground appear
  // but lit it from underneath, because the normals then pointed down — so the geometry is right and
  // only the renderer's facing convention is wrong. Correcting it here rather than in the shared grid
  // keeps the collision and lighting data conventional and confines the left-handedness workaround to
  // the renderer that needs it.
  material.sideOrientation = Material.ClockWiseSideOrientation;

  mesh.material = material;
  mesh.receiveShadows = true;

  return mesh;
}

/**
 * Builds the proving-ground furniture: range markers along the firing line.
 *
 * The prototype had no landmarks at all, so the player had no reference for how far they had driven
 * or how far the target was. These are deliberately plain — painted posts at fixed ranges along the
 * line the player starts on — but they turn an undifferentiated field into somewhere recognisable as a
 * firing range, and they give the eye something to measure distance against.
 *
 * They are decoration with no gameplay effect: no collision, no picking, no interaction. Real
 * structures belong to the authored maps in V6, not here.
 */
function buildRangeMarkers(scene: Scene, terrain: Terrain): Mesh[] {
  const meshes: Mesh[] = [];

  const postMat = new StandardMaterial('range-post-mat', scene);
  postMat.diffuseColor = SCENE_TUNING.rangeMarkerColor;
  postMat.specularColor = Color3.Black();
  postMat.emissiveColor = SCENE_TUNING.rangeMarkerColor.scale(0.35);

  for (const range of RANGE_MARKER_DISTANCES_M) {
    // A pair of posts flanking the line, so the marker reads as a gate to drive through rather than
    // as an arbitrary object in the field.
    for (const side of RANGE_MARKER_SIDES) {
      const x = side;
      const z = range;
      const y = terrain.heightAt(x, z);

      const post = MeshBuilder.CreateCylinder(
        `range-post-${range}-${side}`,
        { height: RANGE_MARKER_HEIGHT_M, diameterTop: 0.35, diameterBottom: 0.5, tessellation: 6 },
        scene,
      );
      post.position.set(x, y + RANGE_MARKER_HEIGHT_M * 0.5, z);
      post.material = postMat;
      post.isPickable = false;
      post.applyFog = true;
      meshes.push(post);

      // A bright cap, visible from much further out than the post itself.
      const cap = MeshBuilder.CreateCylinder(
        `range-cap-${range}-${side}`,
        { height: 0.7, diameter: 0.8, tessellation: 6 },
        scene,
      );
      cap.position.set(x, y + RANGE_MARKER_HEIGHT_M, z);
      cap.material = postMat;
      cap.isPickable = false;
      meshes.push(cap);
    }
  }

  return meshes;
}

/**
 * Colour for a normalised terrain height, across several distinct bands.
 *
 * Deliberately piecewise rather than a smooth gradient. A smooth two-colour ramp across a 20 m height
 * range varies so little between adjacent slopes that the whole landscape reads as one flat tone.
 * Distinct bands give the eye something to measure against, so a ridge reads as high ground and a
 * valley floor reads as low.
 *
 * `t` is the vertex's position within this terrain's own height range, not an absolute elevation, so
 * the bands always span the landscape whatever the seed produces.
 */
function terrainBandColor(t: number): { r: number; g: number; b: number } {
  const bands = SCENE_TUNING.groundBands;
  const scaled = Math.min(0.9999, Math.max(0, t)) * (bands.length - 1);
  const index = Math.floor(scaled);
  const fraction = scaled - index;
  const low = bands[index]!;
  const high = bands[Math.min(bands.length - 1, index + 1)]!;
  return {
    r: low.r + (high.r - low.r) * fraction,
    g: low.g + (high.g - low.g) * fraction,
    b: low.b + (high.b - low.b) * fraction,
  };
}

