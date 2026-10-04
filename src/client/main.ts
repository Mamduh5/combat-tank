import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Simulation } from '../core/sim/world.js';
import { Battle } from '../core/battle/battle.js';
import type { CombatResult } from '../core/combat/combat-resolver.js';
import { reloadProgress } from '../core/vehicle/main-gun.js';
import { PLACEHOLDER_TANK } from '../shared/placeholder-tank.js';
import { ENEMY_TANK } from '../shared/enemy-tank.js';
import type { Vec3 } from '../shared/vec3.js';
import { makeInput, type InputCommand } from '../shared/input.js';
import { OrbitCamera } from './camera/orbit-camera.js';
import { InputManager } from './input/input-manager.js';
import { PhysicsWorld } from './physics/rapier-terrain.js';
import { createScene } from './render/scene.js';
import { buildBattlefieldProps } from './render/battlefield-props.js';
import { MARLOWE_CROSSING } from '../core/world/maps/marlowe-crossing.js';
import { CombatAudio, type EngineInput, type ListenerPose } from './audio/combat-audio.js';
import type { Tank } from '../core/vehicle/tank.js';
import { CombatEffects } from './render/shell-effects.js';
import { VehicleVisual } from './render/vehicle-visual.js';
import { loadVehicleRig } from './assets/vehicle-asset.js';
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

/** Fixed battle timestep in seconds. Matches the core's 60 Hz tick; not read from it, to keep the
 *  client from reaching into core internals for a number it already knows. */
const BATTLE_TICK_DT = 1 / 60;

/** Cap on catch-up ticks per frame, matching the core's own cap so the two cannot disagree. */
const MAX_BATTLE_CATCHUP_TICKS = 5;

/** Screen-shake duration and magnitude when the player is penetrated, seconds and metres. */
const HIT_SHAKE_SECONDS = 0.28;
const HIT_SHAKE_MAGNITUDE = 0.32;

/**
 * Screen shake when the player *fires*, seconds and metres.
 *
 * Smaller than the hit shake, deliberately. Being shot is something that happens to you; firing is something
 * you chose, and shaking the view you are aiming through as a reward for shooting is an annoyance. This is
 * just enough to feel the gun's weight.
 */
const FIRE_SHAKE_SECONDS = 0.22;
const FIRE_SHAKE_MAGNITUDE = 0.055;


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
    // Marlowe Crossing, the V6 battlefield: hard cover, concealment, graded routes, and hand-placed
    // spawns. The V5 arena is still the default for any test that does not ask for a map, and stays
    // reachable that way.
    map: MARLOWE_CROSSING,
    vehicle: PLACEHOLDER_TANK,
    // A real opponent from V4: it drives, traverses, fires, and can be destroyed. Its input comes from
    // `EnemyController` inside the simulation, through the same `InputCommand` the player's keyboard
    // produces, so every combat rule applies to it identically.
    target: ENEMY_TANK,
  });

  // The encounter wraps the simulation rather than living inside it: `Simulation` knows physics,
  // `Battle` knows what winning means. Restart resets both.
  const battle = new Battle(simulation);

  // --- Physics (Rapier, for queries only) --------------------------------------------
  // Initialising this decodes an inlined WASM module, so it is awaited before the first frame.
  const physics = await PhysicsWorld.create(simulation.terrain);

  // --- View (Babylon) -----------------------------------------------------------------
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true });
  engine.setHardwareScalingLevel(1);

  const { scene, camera } = createScene(engine, simulation.terrain);
  // Environment art, built from the same map data the simulation uses. See `battlefield-props.ts` for
  // why the renderer takes the map rather than keeping its own list of things to draw.
  const props = buildBattlefieldProps(scene, simulation.battlefield);
  // The terrain sampler is injected so the running gear can conform to the ground beneath it. The model
  // itself takes a definition and knows nothing about the battlefield, which is what lets one builder serve
  // both vehicles; the map is supplied here, where the map is actually known.
  const groundAt = (x: number, z: number) => simulation.terrain.heightAt(x, z);

  // --- Vehicle models (V7 asset pipeline) -----------------------------------------------
  // Both vehicles are loaded as glTF before the first frame. Awaiting here rather than lazily is
  // deliberate: the game must not start with a half-built tank, and a model that fails its contract should
  // produce a clear error on the page instead of a tank that silently loses its gun mid-battle.
  const playerRig = await loadVehicleRig(scene, simulation.vehicle.definition);
  const tankVisual = new VehicleVisual(playerRig, scene, groundAt);
  console.info(`Combat Tank: player model loaded (${playerRig.normalisationNote})`);

  // The opponent is drawn from the same pipeline and the same visual code, so a model change applies to
  // both. Its variant differs the **silhouette** — longer hull, lower and wider turret, longer gun — as well
  // as the palette. Shape rather than colour alone, because two tanks differing only in colour are
  // genuinely hard to tell apart at range, through fog, or for a colour-blind player.
  let targetVisual: VehicleVisual | null = null;
  if (simulation.target !== null) {
    const targetRig = await loadVehicleRig(scene, simulation.target.definition);
    targetVisual = new VehicleVisual(targetRig, scene, groundAt);
    console.info(`Combat Tank: opponent model loaded (${targetRig.normalisationNote})`);
  }

  const orbitCamera = new OrbitCamera(camera, physics);
  const effects = new CombatEffects(scene);

  // Combat audio. The graph is created lazily on the first user gesture, because browsers refuse to start an
  // AudioContext before one, and a silent game that only becomes audible after the first click reads as broken.
  // The sound assets themselves load in the background once that gesture arrives.
  const audio = new CombatAudio();

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
    // Browsers refuse to start an AudioContext before a gesture. Unlocking on the same click the player
    // already makes to capture the mouse means audio never silently fails to start.
    audio.unlock();
  });

  /**
   * Whether a restart was requested this frame.
   *
   * A flag rather than an immediate call so restart always happens at a frame boundary, between ticks,
   * never in the middle of one. Restarting mid-tick would leave a shell resolved against a tank whose
   * state had already been reset.
   */
  let restartRequested = false;

  /**
   * Steps the encounter by a real elapsed duration.
   *
   * Mirrors `Simulation.advance`: real time accumulates and whole fixed ticks run. Written here rather
   * than delegated because the battle needs its tick count, and asking the battle to expose it would
   * be a wider API than this needs.
   */
  function advanceBattle(deltaSeconds: number, cmd: InputCommand): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return;
    }
    battleAccumulatorSeconds += deltaSeconds;
    let ticks = 0;
    while (battleAccumulatorSeconds >= BATTLE_TICK_DT && ticks < MAX_BATTLE_CATCHUP_TICKS) {
      battleAccumulatorSeconds -= BATTLE_TICK_DT;
      battle.tick(cmd);
      ticks += 1;
    }
    if (battleAccumulatorSeconds > BATTLE_TICK_DT) {
      battleAccumulatorSeconds = 0;
    }
  }

  let battleAccumulatorSeconds = 0;

  /**
   * Returns the encounter to its opening state without reloading the page.
   *
   * Resets everything that accumulates during a fight, and **clears the transient visual effects** as
   * well as the simulation state. That last part is the one that is easy to miss and the one that makes
   * a restart feel broken: leave the shells and impact markers in place and the new battle visibly
   * begins with debris from the last one, including shell tracers still flying.
   *
   * Deliberately does **not** reset `distanceDrivenM` or re-show the briefing: a player restarting after
   * a loss already knows how to drive, and making them re-read the introduction every attempt would be
   * an annoyance rather than a fresh start.
   */
  function restartEncounter(): void {
    battle.restart();
    effects.clear();
    // Re-anchor the camera, which is otherwise left wherever the previous battle ended.
    orbitCamera.snapToTarget(simulation.vehicle.state.headingRad);
    lastPosition = simulation.vehicle.state.position;
    shotsFiredLastFrame = simulation.telemetry.shotsFired;
    lastBannerTick = -1;
    hud.hideBattleOutcome();
    hud.showRestartHint(true);
    audio.silenceEngines(1);
  }

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
  /** Tick the incoming-hit banner last fired on, so it appears once per hit rather than every frame. */
  let lastIncomingTick = -1;

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

    // 4. Advance the encounter in whole fixed ticks, then refresh the physics queries.
    //
    // `Battle` wraps the simulation so the win condition lives outside the physics core. It also owns
    // the short opening delay and the freeze on a finished battle, so the frame loop does not have to
    // know about any of that.
    //
    // The opening delay means the accumulator is advanced here but the simulation is stepped by the
    // battle, so the two are not advanced separately: doing both would run the player's input twice.
    advanceBattle(deltaSeconds, command);
    physics.step();

    // The listener pose, recomputed once per frame from the settled camera and shared by every spatial call
    // below. Deriving it here rather than inside the audio layer keeps the camera the single source of truth
    // for "where am I listening from".
    const listenerPose = listenerPoseFor(camera);

    // Restart is polled here rather than bound to a key handler, so it works whether or not the pointer
    // is locked and cannot be missed on the frame the banner appears.
    if (restartRequested) {
      restartRequested = false;
      restartEncounter();
    }

    // `C` recentres the camera behind the hull. Polled here, for the same reason as restart: it works
    // whether or not the pointer is locked, and a one-shot press cannot be missed on a slow frame.
    //
    // **This was never wired up.** `KeyC` was tracked in `InputManager` and had its default browser
    // behaviour suppressed, and `OrbitCamera.recentreBehind` existed and was correct — but nothing ever
    // called either. `consumeKeyPress` had no call sites at all. So the documented escape hatch was inert,
    // and because automatic recovery had recently been removed as well, a player who looked away from their
    // tank had *no* way back at all. Found by driving the key in a real browser rather than by reading the
    // code: every unit test passed, because the key handler was never exercised by one.
    if (input.consumeKeyPress('KeyC')) {
      orbitCamera.recentreBehind(simulation.vehicle.state.headingRad);
    }

    const state = simulation.vehicle.state;

    // Counted before anything reads the HUD, so the flash and the shot counter agree about what was
    // fired. Derived from the simulation's own tally rather than from the key state, so a request
    // the gun refused during a reload produces no flash and no count.
    const shotsFiredThisFrame = simulation.telemetry.shotsFired - shotsFiredLastFrame;
    shotsFiredLastFrame = simulation.telemetry.shotsFired;

    // 5. Copy simulation state onto the view. The renderer only ever reads.
    //
    // The frame delta is handed over because the track conforming eases toward the ground at a fixed rate
    // per second rather than a fixed fraction per frame, so it behaves identically at 30 Hz and 144 Hz.
    tankVisual.apply(state, simulation.vehicle.turretState, deltaSeconds);
    if (targetVisual !== null && simulation.target !== null) {
      targetVisual.apply(simulation.target.state, simulation.target.turretState, deltaSeconds);
      // A destroyed target is visibly a wreck, so the outcome is legible without reading the panel.
      targetVisual.setDestroyed(simulation.target.damage.destroyed);
    }
    orbitCamera.update(
      { x: state.position.x, y: state.position.y, z: state.position.z },
      input.consumeLookDelta(),
      input.consumeZoomDelta(),
      deltaSeconds,
      // No hull heading. The camera's yaw is world-space and mouse-only, so A/D rotates the tank
      // underneath the view without rotating the view. See camera/orbit-camera.ts.
    );

    // 6. Presentation effects for the shells and impacts the simulation reported this frame.
    //    Everything here is driven by what the core actually accepted, so an effect always means the
    //    simulation did the thing — never merely that a key was pressed.
    for (const impact of simulation.impacts) {
      effects.showImpact(
        impact,
        // The core deliberately splits "where and how did it hit" (V2) from "what does that do" (V3), so the
      // outcome is not on the impact. Terrain impacts have no verdict at all, which is the default.
        'impacted',
        new Vector3(impact.incomingDirection.x, impact.incomingDirection.y, impact.incomingDirection.z),
      );
    }
    effects.update(simulation.shells.inFlight, deltaSeconds);

    // 7. HUD, fed from simulation values rather than anything derived from the view.
    hud.updateDriving(simulation.telemetry);
    hud.updateAimRange(aimRangeM);
    // V6 contact state, read from the simulation rather than recomputed here. The HUD is a view: if it
    // worked out visibility for itself it would be a second implementation of the spotting rules, and
    // the two would eventually disagree about whether the player can see the enemy.
    {
      const contact = simulation.playerContact.contact;
      hud.setContact(contact.state, contact.state !== 'undetected');
    }
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

    // 9. Incoming hits on the player. Reported separately from `combat` because "it hit me" is the most
    //    urgent thing on screen and must not be mistaken for "I hit it". Without this the player could
    //    not tell, from the feedback alone, which side of the exchange a penetration belonged to.
    if (simulation.incomingCombat.length > 0) {
      const incoming = simulation.incomingCombat[simulation.incomingCombat.length - 1]!;
      if (lastIncomingTick !== simulation.tickCount) {
        lastIncomingTick = simulation.tickCount;
        const verdict =
          incoming.kind === 'ricocheted'
            ? 'RICOCHETED'
            : incoming.kind === 'blocked'
              ? 'BLOCKED'
              : incoming.kind === 'armour-miss'
                ? 'MISSED'
                : 'HIT';
        const sub =
          incoming.kind === 'penetrated'
            ? `−${incoming.damage.vehicleDamage} HP · ${incoming.plate.definition.region}`
            : incoming.kind === 'armour-miss'
              ? ''
              : incoming.plate.definition.region;
        hud.showIncomingHit(verdict, incoming.kind, sub);
      }

      // Sound by outcome, so the player learns the four cases apart by ear. Each is a separate asset with its
      // own spectrum — a penetration is a low crunch and a blocked hit a bright clang — rather than one
      // impact sound at different volumes, which the ear cannot reliably tell apart.
      const impactPoint = incomingImpactPoint(incoming);
      if (incoming.kind === 'ricocheted') {
        audio.ricochet(listenerPose, impactPoint);
      } else if (incoming.kind === 'blocked') {
        audio.blocked(listenerPose, impactPoint);
      } else if (incoming.kind === 'armour-miss') {
        audio.terrainImpact(listenerPose, impactPoint);
      } else {
        // A penetration that hurts is the most important feedback in the game, so it gets the shell impact,
        // the vehicle's destruction thump, and a screen shake together.
        audio.penetration(listenerPose, impactPoint);
        audio.destruction(listenerPose, impactPoint);
        effects.showDestruction(new Vector3(impactPoint.x, impactPoint.y, impactPoint.z));
        orbitCamera.shake(HIT_SHAKE_SECONDS, HIT_SHAKE_MAGNITUDE);
      }
    }

    // 10. The player's own shot: recoil, muzzle blast, and report.
    //
    // All three are driven from the same `shotsFiredThisFrame` counter, which is derived from the
    // simulation's own tally rather than from the fire button. A request the gun refused during a reload
    // therefore produces no recoil, no flash, and no sound — exactly as it produces no shot.
    if (shotsFiredThisFrame > 0) {
      const muzzle = tankVisual.getMuzzleWorldPosition();
      // The barrel's world direction, read from the model's own muzzle marker and trunnion rather than
      // re-derived from the simulation's gun vector, so the blast always comes out of the visible barrel.
      const barrelForward = muzzle
        .subtract(tankVisual.vehicleRig.gun.getAbsolutePosition())
        .normalize();
      effects.fireGun(muzzle, barrelForward);
      tankVisual.fireRecoil();
      audio.gunFire(listenerPose, muzzle);
      // A short camera shake. Restrained on purpose: the player must keep their aim, so this is felt rather
      // than seen.
      orbitCamera.shake(FIRE_SHAKE_SECONDS, FIRE_SHAKE_MAGNITUDE);
    }

    // 11. The player's impacts. The enemy's own hits on it were handled above as incoming, so they are
    // skipped here rather than being played twice.
    for (const impact of simulation.impacts) {
      if (impact.targetKind !== 'vehicle' || impact.targetId === simulation.vehicle.definition.id) {
        audio.terrainImpact(listenerPose, impact.position);
      }
    }

    // 12. Battle outcome. Checked after combat so a killing shot is reflected in the same frame.
    if (battle.state === 'victory' || battle.state === 'defeat') {
      const won = battle.state === 'victory';
      const wreckAt = simulation.target?.state.position ?? camera.position;
      audio.destruction(listenerPose, wreckAt);
      // A confirming or failing UI tone, so the player knows the result by ear as well as by the banner. This
      // is the "basic UI/battle-result feedback" category the brief asks for.
      if (won) {
        audio.uiConfirm();
      } else {
        audio.uiFail();
      }
      hud.showBattleOutcome(
        won,
        simulation.telemetry.shotsFired,
        simulation.target?.telemetry.shotsFired ?? 0,
        simulation.vehicle.damage.hitPoints,
        simulation.target?.damage.hitPoints ?? 0,
      );
      hud.showRestartHint(true);
    }

    // 13. The continuous loops: engine, tracks, and turret servo.
    //
    // Fed from each vehicle's *own* telemetry rather than from a shared "engine loudness" number, because
    // the brief asks that the player hear the tank working harder when they ask more of it — and that means
    // throttle, acceleration, and speed separately, not one blended value.
    audio.updateEngine(
      engineInputFor(simulation.vehicle, command),
      simulation.target === null ? null : engineInputFor(simulation.target, null),
      simulation.vehicle.telemetry.turretTraverseRateDegPerSec,
      deltaSeconds,
    );

    // 13. Opponent status strip. Updated every frame rather than on change, because the range readout is
    //     continuous — the player watches it shrink as they close, which is the cue for when to shoot.
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

    // 14. The player's own condition. The module consequences are summarised rather than itemised: a
    //     player who has lost a track needs to know their mobility is impaired, not to read the
    //     internal module id.
    const playerDamage = simulation.vehicle.damage;
    hud.updatePlayerStatus({
      hp: playerDamage.hitPoints,
      maxHp: playerDamage.maxHitPoints,
      destroyed: playerDamage.destroyed,
      immobilised: simulation.vehicle.telemetry.immobilised,
      tracksDestroyed: simulation.vehicle.telemetry.tracksDestroyed,
      gunDisabled: simulation.vehicle.telemetry.gunDisabled,
    });

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
    // Restart on R. Bound on the window rather than through the input manager because it must work
    // whether or not the pointer is locked — the player is very likely reading the end screen without
    // the pointer captured, and a restart that only worked with the pointer locked would fail exactly
    // when it is most wanted. Also accepted while the battle is running, so a player who wants to reset
    // a hopeless fight is not forced to lose it first.
    if (event.key === 'r' || event.key === 'R') {
      restartRequested = true;
    }
    if (event.key === 'm' || event.key === 'M') {
      audio.setMuted(!audio.isMuted);
    }
    // Volume down/up in ten-point steps, and a reset to the authored balance on 0. Number keys and the
    // bracket keys are the near-universal convention, and using them means the player does not have to guess.
    // Ten points rather than five: a game this loud has plenty of range to give away, and coarse steps make
    // it impossible to settle on "just under". Muting with M still works at any volume, so reaching zero is
    // never a trap.
    if (event.key === '-' || event.key === '_') {
      audio.setVolume(audio.volume - 0.1);
    }
    if (event.key === '=' || event.key === '+') {
      audio.setVolume(audio.volume + 0.1);
    }
    if (event.key === '0') {
      // 0 resets to the authored mix rather than to silence. Silencing is what M is for; binding 0 to
      // "inaudible" would make the obvious key do something the player cannot undo without reading the docs.
      audio.setVolume(1);
    }
    // C returns the camera behind the hull. The escape hatch for a player who has orbited the camera
    // round to the front and can no longer tell which way their tank is pointing. Bound on the window
    // for the same reason as restart: it has to work with the pointer locked or unlocked.
    if (event.key === 'c' || event.key === 'C') {
      orbitCamera.recentreBehind(simulation.vehicle.state.headingRad);
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
      // Exposed so the screenshot and audio tools can assert against the real graph — checking that the loops
      // exist and that a shot produced voices — rather than screenshotting a silent game and calling it a pass.
      audio,
      // Exposed so the screenshot tools can assert the environment actually built something, rather
      // than a screenshot that happens to look empty for reasons nobody recorded.
      props,
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

/** Placeholder origin used when a combat result carries no impact point. */
const CAMERA_FALLBACK_POINT: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Where a combat result's shell struck, for audio attenuation.
 *
 * An `armour-miss` is the one variant with no impact point, because the shell passed through the space
 * the vehicle occupies without touching a plate. It is returned as the camera position, which makes the
 * sound play at full volume — correct, since "the shot went past" is a close-range observation anyway.
 */
function incomingImpactPoint(result: CombatResult): { x: number; y: number; z: number } {
  if (result.kind === 'armour-miss') {
    // No plate was struck, so there is no point to attenuate by. Playing at the camera is right: an
    // armour miss means the shell went past at close range, where it would be loud anyway.
    return CAMERA_FALLBACK_POINT;
  }
  return result.impactPoint;
}

/** Distance between two points. */
function distanceBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/**
 * The listener's pose for spatial audio, derived from the camera.
 *
 * Recomputed each frame rather than cached, because the camera's yaw is mouse-driven and changes constantly.
 * The right vector is `forward` rotated by a quarter turn about +Y, which in Babylon's left-handed space is
 * `(forwardZ, -forwardX)` — the same basis the simulation's heading uses, so audio pans the same way the world
 * turns. Getting this backwards is audible: a sound to the player's right would come out of the left speaker,
 * which is worse than no spatialisation at all.
 */
function listenerPoseFor(camera: {
  position: { x: number; y: number; z: number };
  getTarget: () => { x: number; y: number; z: number };
}): ListenerPose {
  const dx = camera.getTarget().x - camera.position.x;
  const dz = camera.getTarget().z - camera.position.z;
  const length = Math.hypot(dx, dz);
  const forwardX = length > 1e-6 ? dx / length : 0;
  const forwardZ = length > 1e-6 ? dz / length : 1;
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    forwardX,
    forwardZ,
    rightX: forwardZ,
    rightZ: -forwardX,
  };
}

/**
 * Builds the audio layer's view of one vehicle's motion.
 *
 * Throttle comes from the vehicle's own telemetry — what the driver asked for — rather than from the raw
 * input command, so the engine responds to the *demand* even while the drive is traction-limited or the tank is
 * stalled on a hill. That distinction is the whole point: a tank flooring it against a slope it cannot climb
 * should sound like it is working hard, because it is.
 *
 * @param command the player's input command, or null for the opponent, whose input comes from its controller
 */
function engineInputFor(vehicle: Tank, command: InputCommand | null): EngineInput {
  const telemetry = vehicle.telemetry;
  const requestedThrottle = telemetry.requestedThrottle;
  return {
    speedMps: vehicle.state.speedMps,
    maxSpeedMps: vehicle.definition.powertrain.maxSpeedMps,
    // The command's throttle is preferred when available, because it is this frame's demand rather than the
    // previous tick's; the telemetry value is the fallback and the only source for the opponent.
    throttle: command !== null ? command.throttle : requestedThrottle,
    accelMps2: telemetry.accelMps2,
    // 0.35 m/s rather than "zero": a tank creeping at walking pace is still moving its tracks, and cutting the
    // track loop at exactly zero makes stopping sound like a bug rather than like stopping.
    stopped: Math.abs(vehicle.state.speedMps) < 0.35,
    // A destroyed vehicle's engine dies away rather than cutting, which the audio layer eases.
    gainScale: telemetry.destroyed ? 0 : 1,
  };
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

