import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Simulation } from '../core/sim/world.js';
import { PLACEHOLDER_TANK } from '../shared/placeholder-tank.js';
import { OrbitCamera } from './camera/orbit-camera.js';
import { InputManager } from './input/input-manager.js';
import { PhysicsWorld } from './physics/rapier-terrain.js';
import { createScene } from './render/scene.js';
import { TankVisual } from './render/tank-visual.js';
import { Hud } from './ui/hud.js';

/**
 * Client entry point for **V1 — Movement & Camera Sandbox**.
 *
 * This file is the whole client: create the simulation, create the view, and pump one into the
 * other each frame. It contains no gameplay rules, which is the point of ADR-0001 — every rule
 * lives in `src/core`, so the same simulation can later run headless or on a server.
 *
 * The frame loop is deliberately simple and ordered:
 *   1. measure real elapsed time,
 *   2. read input into an `InputCommand`,
 *   3. advance the simulation by whole fixed ticks,
 *   4. copy simulation state onto the scene graph,
 *   5. render.
 *
 * Input is read *once* per frame and applied to every tick that frame runs, so a slow frame
 * produces more ticks with the same input rather than skipping simulation time.
 */

/**
 * Longest real frame the simulation will accept, in seconds.
 *
 * A longer frame is a stall (tab restore, breakpoint, garbage collection). Feeding a multi-second
 * delta into the accumulator would trigger the catch-up cap and drop time in a way that looks like
 * a teleport. Clamping keeps the vehicle continuous.
 */
const MAX_FRAME_DELTA_SECONDS = 0.25;

/** Hide the control hint once the player has driven far enough to have clearly understood it. */
const HINT_HIDE_DISTANCE_M = 25;

/** How far the aim ray is cast before giving up, metres. Comfortably beyond the play area. */
const MAX_AIM_RANGE_M = 700;

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('render-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Combat Tank: #render-canvas is missing from the page.');
  }

  const hud = new Hud();

  // --- Simulation (headless core) ----------------------------------------------------
  const simulation = new Simulation({ vehicle: PLACEHOLDER_TANK });

  // --- Physics (Rapier, for queries only) --------------------------------------------
  // Initialising this decodes an inlined WASM module, so it is awaited before the first frame.
  const physics = await PhysicsWorld.create(simulation.terrain);

  // --- View (Babylon) -----------------------------------------------------------------
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true });
  engine.setHardwareScalingLevel(1);

  const { scene, camera } = createScene(engine, simulation.terrain);
  const tankVisual = new TankVisual(scene, simulation.vehicle.definition);
  const orbitCamera = new OrbitCamera(camera, physics);

  const input = new InputManager(canvas);
  input.setLockListener((locked) => {
    hud.setStatus(locked ? '' : 'Click to capture mouse');
  });

  // Clicking the canvas captures the mouse, which is what makes mouse-look work.
  canvas.addEventListener('click', () => {
    input.requestPointerLock();
  });

  // --- Frame loop ----------------------------------------------------------------------
  let lastFrameTimeMs = performance.now();
  let distanceDrivenM = 0;
  let lastPosition = simulation.vehicle.state.position;

  engine.runRenderLoop(() => {
    // 1. Real elapsed time, clamped so a stall cannot teleport the vehicle.
    const nowMs = performance.now();
    const rawDeltaSeconds = (nowMs - lastFrameTimeMs) / 1000;
    lastFrameTimeMs = nowMs;
    const deltaSeconds = Math.min(rawDeltaSeconds, MAX_FRAME_DELTA_SECONDS);

    // 2. Input -> a single command for this frame.
    const command = input.readDrivingInput(deltaSeconds);

    // 3. Advance the simulation in whole fixed ticks, then refresh the physics queries.
    simulation.advance(deltaSeconds, command);
    physics.step();

    const state = simulation.vehicle.state;

    // 4. Copy simulation state onto the view. The renderer only ever reads.
    tankVisual.apply(state);
    orbitCamera.update(
      { x: state.position.x, y: state.position.y, z: state.position.z },
      input.consumeLookDelta(),
      input.consumeZoomDelta(),
      deltaSeconds,
    );

    // 5. HUD, fed from simulation values rather than anything derived from the view.
    hud.updateDriving(simulation.telemetry);
    hud.updateAimRange(measureAimRange(physics, camera.position, camera.getTarget()));

    // Accumulate distance driven, and retire the control hint once the player is moving.
    distanceDrivenM += Math.hypot(
      state.position.x - lastPosition.x,
      state.position.z - lastPosition.z,
    );
    lastPosition = state.position;
    if (distanceDrivenM > HINT_HIDE_DISTANCE_M) {
      hud.hideHint();
    }

    input.endFrame();
    scene.render();
  });

  // Keep the canvas sized to its container, including on window resize.
  window.addEventListener('resize', () => {
    engine.resize();
  });

  // Expose the pieces for debugging from the browser console. Read-only by convention: mutating
  // simulation state from here would bypass the input interface the core is designed around.
  Object.assign(globalThis, { __combatTank: { simulation, physics, orbitCamera, input, hud } });

  hud.setStatus('');
}

/**
 * Measures how far the view direction travels before reaching terrain, for the aim readout.
 *
 * Casts from the camera along its own forward direction. Returns `null` when the view points above
 * the horizon, which is a real answer rather than a failure.
 */
function measureAimRange(
  physics: PhysicsWorld,
  cameraPosition: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): number | null {
  const dx = target.x - cameraPosition.x;
  const dy = target.y - cameraPosition.y;
  const dz = target.z - cameraPosition.z;

  if (Math.hypot(dx, dy, dz) < 1e-6) {
    return null;
  }
  if (dy > 0) {
    // Looking upward: the ray will not reach the ground, so there is no range to report.
    return null;
  }

  const hit = physics.raycast(
    { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z },
    { x: dx, y: dy, z: dz },
    MAX_AIM_RANGE_M,
  );
  return hit === null ? null : hit.distanceM;
}

bootstrap().catch((error: unknown) => {
  // A failure here means the game cannot start at all, so report it on the page rather than only
  // in the console: a blank canvas with a silent error is the hardest kind of bug to report.
  const message = error instanceof Error ? error.message : String(error);
  const status = document.getElementById('hud-status');
  if (status !== null) {
    status.textContent = `Startup failed: ${message}`;
    status.classList.add('error');
  }
  console.error('Combat Tank failed to start:', error);
});

