import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Scene } from '@babylonjs/core/scene.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
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
  skyColor: new Color4(0.52, 0.62, 0.72, 1),
  groundLowColor: new Color3(0.24, 0.3, 0.2),
  groundHighColor: new Color3(0.46, 0.47, 0.36),
  sunDirection: new Vector3(-0.55, -0.78, 0.3),
  sunIntensity: 1.15,
  ambientIntensity: 0.55,
} as const;

/** Grid resolution of the rendered terrain mesh. Finer than the collision heightfield. */
const TERRAIN_RENDER_CELLS = 160;

export interface SceneBundle {
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  readonly terrainMesh: Mesh;
}

/** Builds the scene, camera, lighting, and terrain mesh. */
export function createScene(engine: Engine, terrain: Terrain): SceneBundle {
  const scene = new Scene(engine);
  scene.clearColor = SCENE_TUNING.skyColor;

  // A plain free camera: the orbit rig drives its transform directly each frame, so no built-in
  // camera controls are attached. Attaching them would fight the orbit logic.
  const camera = new UniversalCamera('main', new Vector3(0, 12, -18), scene);
  camera.minZ = SCENE_TUNING.cameraMinZ;
  camera.maxZ = SCENE_TUNING.cameraMaxZ;
  camera.fov = SCENE_TUNING.cameraFovRad;
  camera.inputs.clear();

  // A directional sun for shape, and a hemispheric fill so the underside of the hull is not black.
  const sun = new DirectionalLight('sun', SCENE_TUNING.sunDirection, scene);
  sun.intensity = SCENE_TUNING.sunIntensity;

  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
  ambient.intensity = SCENE_TUNING.ambientIntensity;
  ambient.diffuse = new Color3(0.75, 0.8, 0.85);
  ambient.groundColor = new Color3(0.22, 0.24, 0.2);

  const terrainMesh = buildTerrainMesh(scene, terrain);

  return { scene, camera, terrainMesh };
}

/**
 * Builds the visible terrain surface.
 *
 * Uses the shared grid from `src/core/world/terrain-grid.js` — the same vertex buffer the Rapier
 * collider is built from — so what the player sees and what the camera collides with are the same
 * surface by construction rather than by two independent samplings agreeing.
 */
function buildTerrainMesh(scene: Scene, terrain: Terrain): Mesh {
  const grid = buildTerrainGrid(terrain, TERRAIN_RENDER_CELLS);

  // Expand the ramp index stored per vertex into the green-brown range the placeholder art uses.
  const colors = new Float32Array(grid.colors.length);
  for (let i = 0; i < grid.samples * grid.samples; i += 1) {
    const t = grid.colors[i * 4]!;
    colors[i * 4] = SCENE_TUNING.groundLowColor.r + (SCENE_TUNING.groundHighColor.r - SCENE_TUNING.groundLowColor.r) * t;
    colors[i * 4 + 1] = SCENE_TUNING.groundLowColor.g + (SCENE_TUNING.groundHighColor.g - SCENE_TUNING.groundLowColor.g) * t;
    colors[i * 4 + 2] = SCENE_TUNING.groundLowColor.b + (SCENE_TUNING.groundHighColor.b - SCENE_TUNING.groundLowColor.b) * t;
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
  mesh.material = material;
  mesh.receiveShadows = true;

  return mesh;
}

