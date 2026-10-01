import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Simulation } from '../core/sim/world.js';
import { reloadProgress } from '../core/vehicle/main-gun.js';
import { PLACEHOLDER_TANK } from '../shared/placeholder-tank.js';
import { TARGET_TANK } from '../shared/placeholder-target.js';
import type { Vec3 } from '../shared/vec3.js';
import { makeInput } from '../shared/input.js';
import { OrbitCamera } from './camera/orbit-camera.js';
import { InputManager } from './input/input-manager.js';
import { PhysicsWorld } from './physics/rapier-terrain.js';
import { createScene } from './render/scene.js';
import { TARGET_ACCENT } from './render/tank-proportions.js';
import { ShellEffects } from './render/shell-effects.js';
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
  const simulation = new Simulation({
    vehicle: PLACEHOLDER_TANK,
    // The stationary test target. It does not move, aim, or fire — it exists so armour, penetration
    // and damage can be tested by hand. V4 is where a real opponent arrives.
    target: TARGET_TANK,
  });

  // --- Physics (Rapier, for queries only) --------------------------------------------
  // Initialising this decodes an inlined WASM module, so it is awaited before the first frame.
  const physics = await PhysicsWorld.create(simulation.terrain);

  // --- View (Babylon) -----------------------------------------------------------------
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true });
  engine.setHardwareScalingLevel(1);

  const { scene, camera } = createScene(engine, simulation.terrain);
  const tankVisual = new TankVisual(scene, simulation.vehicle.definition);
  const orbitCamera = new OrbitCamera(camera, physics);
  const effects = new ShellEffects(scene);

  // The stationary test target, drawn from the same visual code as the player's tank, so a change to
  // the placeholder model applies to both and nothing about rendering the target is special-cased.
  // The one difference is the accent colour: two identical olive tanks on an olive field left the
  // player unable to tell which vehicle was theirs at combat range.
  const targetVisual =
    simulation.target === null
      ? null
      : new TankVisual(scene, simulation.target.definition, TARGET_ACCENT);

  const input = new InputManager(canvas);
  input.setLockListener((locked) => {
    hud.setStatus(locked ? '' : 'Click to capture mouse');
  });

  // Synthetic input override, used by the screenshot harness to exercise firing without a pointer
  // lock. Absent in normal play: `inputFrame` is null and the real input manager is read as usual.
  // Exposed deliberately — without it, the combat feedback path can only be verified by hand with a
  // captured pointer, which is exactly the kind of thing that goes untested.
  let inputFrame: { throttle: number; steer: number; aim: { x: number; y: number; z: number }; fire: boolean } | null =
    null;

  // Clicking the canvas captures the mouse, which is what makes mouse-look work. Firing is bound to
  // holding the left button and is handled in InputManager, so the click that grabs the mouse does
  // not also shoot.
  canvas.addEventListener('click', () => {
    input.requestPointerLock();
  });

  // --- Frame loop ----------------------------------------------------------------------
  let lastFrameTimeMs = performance.now();
  let distanceDrivenM = 0;
  let lastPosition = simulation.vehicle.state.position;
  let shotsFiredLastFrame = 0;
  /**
   * Simulation tick the centred outcome banner last fired on.
   *
   * Tracked so the banner appears once per resolved shot rather than on every frame the result is
   * still present in the simulation's combat log.
   */
  let lastBannerTick = -1;

  engine.runRenderLoop(() => {
    // 1. Real elapsed time, clamped so a stall cannot teleport the vehicle.
    const nowMs = performance.now();
    const rawDeltaSeconds = (nowMs - lastFrameTimeMs) / 1000;
    lastFrameTimeMs = nowMs;
    const deltaSeconds = Math.min(rawDeltaSeconds, MAX_FRAME_DELTA_SECONDS);

    // 2. Where the player is looking, resolved from the camera's own view ray. This is what makes
    //    the mouse aim the *gun* while leaving the hull alone.
    const aim = resolveAimPoint(physics, camera.position, camera.getTarget());
    const aimRangeM = aim === null ? null : distanceBetween(camera.position, aim);

    // 3. Input -> a single command for this frame. The synthetic override, when present, replaces the
    //    real input manager entirely so the harness exercises the same downstream path a player does.
    const command =
      inputFrame === null
        ? input.readDrivingInput(deltaSeconds, aim)
        : makeInput(inputFrame.throttle, inputFrame.steer, inputFrame.aim, inputFrame.fire);

    // 4. Advance the simulation in whole fixed ticks, then refresh the physics queries.
    simulation.advance(deltaSeconds, command);
    physics.step();

    const state = simulation.vehicle.state;

    // Counted before anything reads the HUD, so the flash and the shot counter agree about what was
    // fired. Derived from the simulation's own tally rather than from the key state, so a request
    // the gun refused during a reload produces no flash and no count.
    const shotsFiredThisFrame = simulation.telemetry.shotsFired - shotsFiredLastFrame;
    shotsFiredLastFrame = simulation.telemetry.shotsFired;

    // 5. Copy simulation state onto the view. The renderer only ever reads.
    tankVisual.apply(state, simulation.vehicle.turretState);
    if (targetVisual !== null && simulation.target !== null) {
      targetVisual.apply(simulation.target.state, simulation.target.turretState);
      // A destroyed target is visibly a wreck, so the outcome is legible without reading the panel.
      targetVisual.setDestroyed(simulation.target.damage.destroyed);
    }
    orbitCamera.update(
      { x: state.position.x, y: state.position.y, z: state.position.z },
      input.consumeLookDelta(),
      input.consumeZoomDelta(),
      deltaSeconds,
    );

    // 6. Presentation effects for the shells and impacts the simulation reported this frame.
    //    Muzzle flashes are driven by shots the core actually accepted, so a flash always means a
    //    round was fired, never merely that the button was pressed.
    for (const impact of simulation.impacts) {
      effects.showImpact(impact);
    }
    if (shotsFiredThisFrame > 0) {
      const muzzle = simulation.vehicle.gunPivotPosition;
      effects.showMuzzleFlash(muzzle);
    }
    effects.update(simulation.shells.inFlight, deltaSeconds);

    // 7. HUD, fed from simulation values rather than anything derived from the view.
    hud.updateDriving(simulation.telemetry);
    hud.updateAimRange(aimRangeM);
    const reloading = simulation.telemetry.gunLoadState === 'reloading';
    hud.updateReloadProgress(
      reloadProgress(simulation.vehicle.gunState, simulation.vehicle.definition.mainGun.reloadSeconds),
      reloading,
    );

    // 8. Hit feedback, from the most recent combat outcome. Only rewritten when a shell actually
    //    resolved, so the panel keeps showing the last shot rather than flickering every frame.
    //
    //    The last resolved tick is tracked so the centred banner fires **once per shot**. Without it
    //    the banner re-triggers on every frame the result is still present in `simulation.combat`,
    //    which pins it permanently on screen instead of flashing for a moment.
    if (simulation.combat.length > 0) {
      const outcome = simulation.combat[simulation.combat.length - 1]!;
      hud.updateHitFeedback(
        outcome,
        simulation.target?.damage.hitPoints ?? 0,
        outcome.kind === 'penetrated' ? outcome.damage.modulesDestroyed : [],
      );

      if (lastBannerTick !== simulation.tickCount) {
        lastBannerTick = simulation.tickCount;
        // The armour-miss case carries neither plate nor damage, so it is handled separately rather
        // than through a nested conditional that would not preserve the discriminant narrowing.
        if (outcome.kind === 'armour-miss') {
          hud.showCombatBanner('MISS', 'miss', '');
        } else {
          const verdict =
            outcome.kind === 'ricocheted' ? 'RICOCHET' : outcome.kind.toUpperCase();
          const sub =
            outcome.kind === 'penetrated'
              ? `−${outcome.damage.vehicleDamage} HP · ${outcome.plate.definition.region}`
              : outcome.plate.definition.region;
          hud.showCombatBanner(verdict, outcome.kind, sub);
        }
      }
    }

    // 9. Target status strip. Updated every frame rather than on change, because the range readout is
    //    continuous — the player watches it shrink as they close, which is the cue for when to shoot.
    if (simulation.target !== null) {
      const t = simulation.target;
      const dx = t.state.position.x - state.position.x;
      const dz = t.state.position.z - state.position.z;
      hud.updateTargetStatus({
        name: t.definition.displayName,
        hp: t.damage.hitPoints,
        maxHp: t.definition.survivability.hitPoints,
        rangeM: Math.hypot(dx, dz),
        destroyed: t.damage.destroyed,
      });
    } else {
      hud.updateTargetStatus(null);
    }

    hud.tick(deltaSeconds);

    // Accumulate distance driven, and retire the first-launch guidance once the player is moving.
    distanceDrivenM += Math.hypot(
      state.position.x - lastPosition.x,
      state.position.z - lastPosition.z,
    );
    lastPosition = state.position;
    if (distanceDrivenM > HINT_HIDE_DISTANCE_M) {
      hud.hideHint();
      hud.hideBriefing();
    }

    input.endFrame();
    scene.render();
  });

  // Keep the canvas sized to its container, including on window resize.
  window.addEventListener('resize', () => {
    engine.resize();
  });

  // Diagnostics toggle. Bound here rather than in the input system because it is a developer
  // affordance for inspecting the armour model, not a gameplay input, and it must work whether or
  // not the pointer is locked.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'f' || event.key === 'F') {
      hud.toggleDebug();
    }
  });

  // The on-screen toggle is a convenience for anyone without the keyboard shortcut to hand.
  document.getElementById('debug-toggle')?.addEventListener('click', () => hud.toggleDebug());

  // Expose the pieces for debugging from the browser console. Read-only by convention: mutating
  // simulation state from here would bypass the input interface the core is designed around. `scene`
  // is included because visual problems are almost always diagnosed by inspecting the graph — which
  // meshes exist, where they are, whether anything is enabled.
  Object.assign(globalThis, {
    __combatTank: {
      simulation,
      physics,
      orbitCamera,
      input,
      hud,
      scene,
      tankVisual,
      targetVisual,
      /** Lets the screenshot harness drive the game without a captured pointer. */
      setInputFrame: (frame: typeof inputFrame) => {
        inputFrame = frame;
      },
    },
  });

  hud.setStatus('');
}

/**
 * Resolves the player's aim into a world point on the terrain.
 *
 * The camera's view ray is the aim ray. The gun servos toward whatever this returns, which is what
 * makes mouse movement aim the *turret* while the hull stays exactly where the player last drove it.
 *
 * Falls back to a point at `MAX_AIM_RANGE_M` along the view direction when the ray does not hit
 * terrain, so aiming at the sky still produces a sensible, distant aim point rather than nothing.
 * A `null` return means the view direction is degenerate, which is not a state the player can
 * normally produce.
 */
function resolveAimPoint(
  physics: PhysicsWorld,
  cameraPosition: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): Vec3 | null {
  const dx = target.x - cameraPosition.x;
  const dy = target.y - cameraPosition.y;
  const dz = target.z - cameraPosition.z;
  const length = Math.hypot(dx, dy, dz);

  if (length < 1e-6) {
    return null;
  }

  const hit = physics.raycast(
    { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z },
    { x: dx, y: dy, z: dz },
    MAX_AIM_RANGE_M,
  );

  if (hit !== null) {
    return { x: hit.point.x, y: hit.point.y, z: hit.point.z };
  }

  // No terrain in the way: aim at the far end of the ray, at the height of whatever is under it, so
  // the gun has something concrete to servo toward instead of holding its last angle.
  const ux = dx / length;
  const uy = dy / length;
  const uz = dz / length;
  const farX = cameraPosition.x + ux * MAX_AIM_RANGE_M;
  const farZ = cameraPosition.z + uz * MAX_AIM_RANGE_M;
  const groundY = physics.groundHeightAt(farX, farZ);

  return {
    x: farX,
    // If the far point is below ground the ray is heading into a hill we did not hit, so clamp to the
    // surface rather than driving the gun underground.
    y: groundY === null ? cameraPosition.y + uy * MAX_AIM_RANGE_M : Math.max(groundY.point.y, cameraPosition.y + uy * MAX_AIM_RANGE_M),
    z: farZ,
  };
}

/** Distance between two points. */
function distanceBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
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

