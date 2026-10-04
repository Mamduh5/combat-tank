/**
 * The V7 recovery end-to-end probe: plays the shipping game and checks what a player would see and hear.
 *
 * ## Why this exists, and why it is not a unit test
 *
 * V7 shipped with a fully green suite and a game that showed no tank, a checkerboard ground, static noise, and
 * then stopped. Every one of those failures is invisible to a static check. This catches them because it does
 * the only thing that could: it **runs the real page, feeds it real input, and keeps it alive long enough for
 * lifecycle faults to fire**.
 *
 * It asserts *mechanical* facts only — is the tank drawn, is the terrain textured, does the frame counter
 * advance, does audio stay bounded. It cannot judge whether the tank looks good or the audio sounds good;
 * that is the owner's call, and a gate that pretended otherwise would be worse than none.
 *
 * Every check exists because its absence let a specific V7 defect through to a human.
 */
(async () => {
  /** Waits for `n` real animation frames, so the game's own loop advances. */
  const frames = (n) =>
    new Promise((resolve) => {
      let left = n;
      const tick = () => {
        left -= 1;
        if (left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  const g = globalThis.__combatTank;
  if (!g) return { bootOk: false, reason: '__combatTank never appeared' };
  const scene = g.scene;
  const camera = scene.activeCamera;
  const B = (v) => Number(Number(v).toFixed(3));

  const checks = [];
  /** Records one pass/fail with the numbers behind it, so a failure says what was wrong, not just that it was. */
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

  /**
   * Whether a vehicle is actually **drawn**, not merely present.
   *
   * V7's tank passed every scene-graph assertion — 36 meshes, enabled, visible, in frustum, materials ready —
   * and rendered nothing, because `LoadAssetContainerAsync` had never been told to add it to the scene, so
   * none of those meshes were in `scene.meshes` for the renderer to iterate. Membership is the whole question.
   */
  const drawnVehicle = (visual) => {
    if (!visual) return { present: false, drawnCount: 0 };
    const inScene = new Set(scene.meshes.map((m) => m.name));
    const smart = scene.getActiveMeshes();
    const active = new Set(smart.data.slice(0, smart.length).map((m) => m.name));
    const meshes = visual.meshes;
    let lo = null;
    let hi = null;
    for (const m of meshes) {
      if (!inScene.has(m.name)) continue;
      m.computeWorldMatrix(true);
      const b = m.getBoundingInfo().boundingBox;
      for (const c of [b.minimumWorld, b.maximumWorld]) {
        lo = lo === null ? [c.x, c.y, c.z] : [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
        hi = hi === null ? [c.x, c.y, c.z] : [Math.max(hi[0], c.x), Math.max(hi[1], c.y), Math.max(hi[2], c.z)];
      }
    }
    const size = lo && hi ? [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] : null;
    return {
      present: true,
      meshCount: meshes.length,
      inSceneCount: meshes.filter((m) => inScene.has(m.name)).length,
      drawnCount: meshes.filter((m) => active.has(m.name)).length,
      worldSize: size ? size.map(B) : null,
      /** A tank-sized vehicle; catches a 100x or 0.01x scale regression that bounds alone would not flag. */
      saneSize: Boolean(size && size[0] > 2 && size[0] < 15 && size[1] < 6),
    };
  };

  const report = { startedAt: new Date().toISOString(), bootOk: true, checks, phases: {} };
  const key = (code, type) =>
    window.dispatchEvent(new KeyboardEvent(type, { code, key: code.replace('Key', ''), bubbles: true }));

  // --- Vehicle, at boot -------------------------------------------------------------------
  const player0 = drawnVehicle(g.tankVisual);
  report.phases.playerAtBoot = player0;
  check('player tank meshes are in the scene', player0.inSceneCount === player0.meshCount,
    `${player0.inSceneCount}/${player0.meshCount}`);
  check('player tank is actually drawn', player0.drawnCount > 0, `${player0.drawnCount} active`);
  check('player tank is a sane size', player0.saneSize, JSON.stringify(player0.worldSize));

  // --- Terrain ----------------------------------------------------------------------------
  // The checkerboard was Babylon's missing-texture placeholder: the scene asked for `ground-albedo.png` while
  // the file was `ground-detail-albedo.png`, so every surface silently fell back. A texture that never becomes
  // ready renders as that placeholder, so readiness is the check that matters — not "a texture is assigned".
  const terrain = scene.getMeshByName('terrain');
  const terrainMat = terrain ? terrain.material : null;
  const albedo = terrainMat ? terrainMat.albedoTexture : null;
  const notReady = scene.textures.filter((t) => !t.isReady());
  check('terrain has a material', Boolean(terrainMat), terrainMat && terrainMat.name);
  check('terrain material is PBR', terrainMat && terrainMat.getClassName() === 'PBRMaterial',
    terrainMat && terrainMat.getClassName());
  check('terrain has an albedo texture', Boolean(albedo), albedo && albedo.name);
  check('terrain albedo texture actually loaded', Boolean(albedo && albedo.isReady()),
    albedo && `${albedo.name} ready=${albedo.isReady()}`);
  check('every scene texture is ready', notReady.length === 0, JSON.stringify(notReady.map((t) => t.name)));
  // Metals are mirrors: with no environment texture they render black, which is exactly how the tank looked
  // after its NaN normals were fixed but before the IBL was added.
  check('scene has an environment texture for PBR reflections', Boolean(scene.environmentTexture),
    scene.environmentTexture && scene.environmentTexture.name);
  // PART_OF_PROBE

  /**
   * Advances until `predicate` holds, or `maxMs` of wall-clock elapses.
   *
   * The reason this exists rather than a bare `sleep`: the headless software renderer runs at roughly 5 fps,
   * and the game's loop advances the simulation by a *clamped* delta per frame. So a wall-clock wait buys far
   * less simulated time than it appears to — 2.2 s of waiting produced only about half a second of ticks, and
   * a distance threshold chosen for 60 fps then fails against a tank that is behaving perfectly. The first
   * version of this probe made exactly that mistake and reported a false defect.
   *
   * Counting frames instead would have the opposite flaw: a check on "N frames elapsed" passes even if the
   * tank never moves. Polling for the actual effect, under a wall-clock ceiling so the probe can never hang,
   * is the version that means the same thing on any hardware.
   */
  const until = async (predicate, maxMs = 25_000) => {
    const deadline = performance.now() + maxMs;
    while (performance.now() < deadline) {
      if (predicate()) return true;
      await frames(1);
    }
    return false;
  };

  // --- Movement, steering, camera, aiming ---------------------------------------------------
  const posBefore = { ...g.simulation.vehicle.state.position };
  key('KeyW', 'keydown');
  // Assert on *distance covered*, not on a fixed time. A tank accelerating from rest covers very little in the
  // first fraction of a second, so a "did it move at least N metres" check polled against a short window
  // measures the acceleration ramp rather than the powertrain — and this probe's first version failed exactly
  // that way, reporting "0.308 m" for a tank that reached 3 m/s a moment later.
  //
  // Distance is the frame-rate-independent quantity here, which is what makes it safe to poll: at 4 fps the
  // simulation's clamped delta means a wall-clock wait buys far less simulated time than it looks like.
  const droveForward = await until(() => {
    const p = g.simulation.vehicle.state.position;
    return Math.hypot(p.x - posBefore.x, p.z - posBefore.z) > 3;
  });
  const posAfterW = { ...g.simulation.vehicle.state.position };
  key('KeyW', 'keyup');
  const moved = Math.hypot(posAfterW.x - posBefore.x, posAfterW.z - posBefore.z);
  const peakSpeed = g.simulation.vehicle.telemetry.speedMps;
  report.phases.drive = { movedM: B(moved), speedAtReleaseMps: B(peakSpeed) };
  check('W drives the tank forward', droveForward, `${B(moved)} m at ${B(peakSpeed)} m/s`);

  const headingBefore = g.simulation.vehicle.state.headingRad;
  key('KeyA', 'keydown');
  await until(() => Math.abs(g.simulation.vehicle.state.headingRad - headingBefore) > 0.09);
  key('KeyA', 'keyup');
  await frames(2);
  const turned = Math.abs(g.simulation.vehicle.state.headingRad - headingBefore);
  report.phases.steer = { turnedDeg: B((turned * 180) / Math.PI) };
  check('A turns the hull', turned > 0.05, `${B((turned * 180) / Math.PI)} deg`);

  const camBefore = [camera.position.x, camera.position.y, camera.position.z];
  key('KeyC', 'keydown');
  key('KeyC', 'keyup');
  const camMoved = await until(() => {
    const d = Math.hypot(
      camera.position.x - camBefore[0],
      camera.position.y - camBefore[1],
      camera.position.z - camBefore[2],
    );
    return d > 0.5;
  });
  report.phases.camera = { moved: camMoved };
  check('C moves the camera', camMoved, 're-centred');

  // Turret, through the game's own input hook. A headless browser cannot hold a pointer lock, but the code
  // path under test is the one the player's mouse feeds.
  //
  // The angle read is `turretState.localAngleRad` — turret relative to *hull*. That is the only reading that
  // actually proves the turret slewed: the hull is stationary here, but `telemetry.turretWorldHeadingRad` would
  // move for either cause, so a turret welded to its hull would pass a world-heading check. The first version
  // of this probe read a field that does not exist at all (`turretAngleDeg`) and reported `NaN -> NaN`, which is
  // the failure mode of asserting on a name nobody checked.
  const localAngle = () => g.simulation.vehicle.turretState.localAngleRad;
  const turret0 = localAngle();
  g.setInputFrame({ throttle: 0, steer: 0, aim: { x: 40, y: 0, z: 40 }, fire: false });
  const swungRight = await until(() => Math.abs(localAngle() - turret0) > 0.2);
  const turretRight = localAngle();
  g.setInputFrame({ throttle: 0, steer: 0, aim: { x: -40, y: 0, z: -40 }, fire: false });
  const swungLeft = await until(() => Math.abs(localAngle() - turretRight) > 0.2);
  const turret1 = localAngle();
  g.setInputFrame(null);
  await frames(4);
  const deg = (rad) => B((rad * 180) / Math.PI);
  report.phases.aim = {
    turretLocalFrom: deg(turret0),
    turretLocalAfterRight: deg(turretRight),
    turretLocalAfterLeft: deg(turret1),
    gunWorldHeadingDeg: deg(g.simulation.vehicle.telemetry.turretWorldHeadingRad),
  };
  // Both directions, not just "it moved": a servo that could only slew one way, or one that snapped to the
  // first command and ignored the second, would each pass a single-direction check.
  check(
    'aiming traverses the turret',
    swungRight && swungLeft,
    `${deg(turret0)} -> ${deg(turretRight)} -> ${deg(turret1)} deg`,
  );

  // --- Audio ---------------------------------------------------------------------------------
  // Unlocked the way a player unlocks it: the click that also captures the mouse.
  document.querySelector('canvas')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  g.audio.unlock();
  // Wait for the context to actually be running, rather than for a fixed span. A fixed span is a race that
  // passes on a fast machine and reports a phantom audio fault on a slow one.
  const audioRunning = await until(() => g.audio.context?.state === 'running', 15_000);
  // Then for the decode: `unlock()` resolves before the fetches finish, so a sound count read immediately
  // afterwards would be a count of nothing.
  await until(() => Object.keys(g.audio.sounds ?? {}).length >= 15, 20_000);
  const loadedSounds = Object.keys(g.audio.sounds ?? {});
  check('audio sounds decoded', loadedSounds.length >= 15, `${loadedSounds.length} loaded`);
  check('audio context is running', audioRunning, g.audio.context?.state);

  // --- Firing, and the voice ceiling ---------------------------------------------------------
  const shotsBefore = g.simulation.telemetry.shotsFired;
  g.setInputFrame({ throttle: 0, steer: 0, aim: { x: 0, y: 0, z: 1 }, fire: true });
  await until(() => g.simulation.telemetry.shotsFired > shotsBefore, 20_000);
  // Keep firing a moment longer and watch the ceiling while it is under load, because that is the condition
  // the V7 crash lived in: a burst claiming more voices than the cap allows.
  let peakVoicesUnderFire = 0;
  for (let i = 0; i < 30; i += 1) {
    peakVoicesUnderFire = Math.max(peakVoicesUnderFire, g.audio.activeVoiceCount);
    await frames(1);
  }
  g.setInputFrame(null);
  await frames(4);
  const shotsAfter = g.simulation.telemetry.shotsFired;
  report.phases.fire = { fired: shotsAfter - shotsBefore, peakVoicesUnderFire };
  check('firing produces shots', shotsAfter - shotsBefore >= 1, `${shotsAfter - shotsBefore}`);
  // The V7 crash presented as sources accumulating and then throwing. Both halves are checked: the live count
  // stays under the ceiling, and it returns to zero once the sounds finish — the second half being what proves
  // the `onended` cleanup is actually wired, which is the fix itself.
  check('one-shot voices stay within the ceiling', peakVoicesUnderFire <= g.audio.voiceCeiling,
    `peak ${peakVoicesUnderFire} of ${g.audio.voiceCeiling}`);
  // Released *before* this wait, or the gun is still firing and the count can never reach zero — a check that
  // could not pass however correct the audio code was.
  const voicesDrained = await until(() => g.audio.activeVoiceCount === 0, 20_000);
  check('voices are released after playing', voicesDrained, `${g.audio.activeVoiceCount} live`);

  // --- Continuous runtime ---------------------------------------------------------------------
  // The point of this stretch. A crash that only appears once assets, loops and effects have all been alive
  // together cannot fire in a process that exits after one frame.
  const duration = Number(globalThis.__CT_RUNTIME_MS ?? 62000);
  const frameStart = scene.getFrameId();
  const meshStart = scene.meshes.length;
  const cycle = [
    { throttle: 1, steer: 0.25, aim: { x: 0.2, y: 0, z: 1 }, fire: false },
    { throttle: 0.6, steer: -0.45, aim: { x: -0.5, y: 0.1, z: 0.6 }, fire: false },
    { throttle: -1, steer: 0.5, aim: { x: 0.4, y: -0.1, z: -0.9 }, fire: false },
    { throttle: 1, steer: 0, aim: { x: 0, y: 0, z: 1 }, fire: true },
  ];
  let idx = 0;
  const t0 = performance.now();
  let peakVoicesDuringPlay = 0;
  let peakSpeedDuringPlay = 0;
  while (performance.now() - t0 < duration) {
    g.setInputFrame(cycle[idx++ % cycle.length]);
    // Frames per input step, not milliseconds. The cycle exists to keep *inputs changing* while assets, loops
    // and effects are alive together, and how many input changes occur per wall-clock second is a property of
    // the renderer's speed rather than anything worth asserting on. Stepping per frame guarantees the
    // simulation genuinely advances through throttle, steering, aiming and firing at any frame rate.
    for (let step = 0; step < 6 && performance.now() - t0 < duration; step += 1) {
      peakVoicesDuringPlay = Math.max(peakVoicesDuringPlay, g.audio.activeVoiceCount);
      peakSpeedDuringPlay = Math.max(peakSpeedDuringPlay, Math.abs(g.simulation.vehicle.telemetry.speedMps));
      await frames(1);
    }
  }
  g.setInputFrame(null);
  const framesRun = scene.getFrameId() - frameStart;
  const elapsedS = Math.round((performance.now() - t0) / 1000);
  report.phases.runtime = {
    requestedMs: duration,
    actualMs: Math.round(performance.now() - t0),
    framesRun,
    inputSteps: idx,
    meshGrowth: scene.meshes.length - meshStart,
    shotsFired: g.simulation.telemetry.shotsFired,
    peakVoicesDuringPlay,
    peakSpeedDuringPlay: B(peakSpeedDuringPlay),
  };
  // A frozen frame counter means the render loop threw, which is the V7 crash in its most direct form. The bar
  // is absolute rather than proportional: even a very slow software renderer must produce dozens of frames in
  // a minute, and anything near zero is a dead loop.
  check('frame loop kept running', framesRun > 60, `${framesRun} frames in ${elapsedS}s`);
  // Without this, a loop that renders but ignores input entirely would pass every other check here.
  check('input reached the vehicle during play', peakSpeedDuringPlay > 0.5,
    `peak ${B(peakSpeedDuringPlay)} m/s`);
  check('scene did not accumulate meshes', scene.meshes.length - meshStart <= 8,
    `+${scene.meshes.length - meshStart}`);
  check('voices stayed bounded during play', peakVoicesDuringPlay <= g.audio.voiceCeiling,
    `peak ${peakVoicesDuringPlay} of ${g.audio.voiceCeiling}`);
  check('the gun still fired during play', g.simulation.telemetry.shotsFired > shotsAfter,
    `${g.simulation.telemetry.shotsFired - shotsAfter} more shots`);

  // --- Enemy still discoverable, combat still works ------------------------------------------
  // The opponent must still be findable after a minute of play. A game where the tank drives beautifully
  // while the enemy has vanished off the map is not playable, and nothing else here would notice.
  const targetPos = g.simulation.target?.state.position ?? null;
  report.phases.target = {
    exists: g.simulation.target !== null,
    destroyed: g.simulation.target ? g.simulation.target.damage.destroyed : null,
    playerHp: g.simulation.vehicle.damage.hitPoints,
    distanceFromPlayerM: targetPos
      ? B(Math.hypot(targetPos.x - g.simulation.vehicle.state.position.x,
        targetPos.z - g.simulation.vehicle.state.position.z))
      : null,
  };
  check('the opponent still exists', g.simulation.target !== null, 'target');
  check('the opponent is still alive to fight', g.simulation.target?.damage.destroyed === false,
    `hp ${g.simulation.target?.damage.hitPoints}`);
  check('the opponent is on the map, not infinitely far away',
    targetPos !== null && Math.hypot(targetPos.x - g.simulation.vehicle.state.position.x,
      targetPos.z - g.simulation.vehicle.state.position.z) < 2000,
    `${report.phases.target.distanceFromPlayerM} m away`);

  // --- Restart, then keep running ------------------------------------------------------------
  // Restart is where a scene-graph leak shows: assets reloaded on top of assets already in the scene, audio
  // nodes left running, meshes doubling every cycle. So the checks after it are about *counts*, not just liveness.
  const meshCountBeforeRestart = scene.meshes.length;
  key('KeyR', 'keydown');
  key('KeyR', 'keyup');
  // Wait for the world to actually reset rather than assuming a fixed delay was enough. The counter to watch is
  // the simulation's, not the vehicle's — `shotsFired` is fight-wide telemetry, so it only drops when the fight
  // really restarted rather than when a key was pressed.
  await until(() => g.simulation.telemetry.shotsFired < shotsAfter, 15_000);
  const beforeRestart = { ...g.simulation.vehicle.state.position };
  g.setInputFrame(cycle[0]);
  // Drive until the tank is genuinely moving again after the reset, rather than for a fixed span.
  const movedAfterRestart = await until(() => {
    const p = g.simulation.vehicle.state.position;
    return Math.hypot(p.x - beforeRestart.x, p.z - beforeRestart.z) > 2;
  }, 25_000);
  g.setInputFrame(null);
  const afterRestart = { ...g.simulation.vehicle.state.position };
  const restartMoved = Math.hypot(afterRestart.x - beforeRestart.x, afterRestart.z - beforeRestart.z);
  const framesAfterRestart = scene.getFrameId() - frameStart;
  const drawnAfterRestart = drawnVehicle(g.tankVisual).drawnCount;
  report.phases.restart = {
    movedM: B(restartMoved),
    totalFrames: framesAfterRestart,
    stillDrawn: drawnAfterRestart,
    meshGrowth: scene.meshes.length - meshCountBeforeRestart,
    shotsFiredAfterRestart: g.simulation.telemetry.shotsFired,
  };
  check('game still runs after restart', framesAfterRestart > framesRun, `${framesAfterRestart} frames`);
  check('the tank still drives after restart', movedAfterRestart, `${B(restartMoved)} m`);
  check('tank still drawn after restart', drawnAfterRestart > 0, `${drawnAfterRestart} meshes drawn`);
  // The leak check. A restart that reloads assets without disposing them leaves the scene quietly doubling;
  // a small allowance covers legitimate transient effect meshes.
  check('restart did not leak scene meshes', scene.meshes.length - meshCountBeforeRestart <= 8,
    `+${scene.meshes.length - meshCountBeforeRestart}`);
  // And the counter itself must have been rewound, which is what "restart" means.
  check('restart reset the shot counter', g.simulation.telemetry.shotsFired < shotsAfter,
    `${g.simulation.telemetry.shotsFired} of ${shotsAfter}`);

  report.failed = checks.filter((c) => !c.pass);
  report.passed = checks.every((c) => c.pass);
  report.endedAt = new Date().toISOString();
  return report;
})()
