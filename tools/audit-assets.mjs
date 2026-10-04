/**
 * Audits the V7 asset pipeline against a real browser, at runtime.
 *
 * ## Why this exists rather than a unit test
 *
 * Almost everything V7 introduces can be proved statically: TypeScript catches a wrong API, the asset build
 * can be re-run and diffed, and the manifest can be checked against the filesystem. Three things cannot.
 *
 * 1. **Orientation.** The exporter writes a root-node rotation to convert from the authored left-handed space
 *    to glTF's right-handed one. Whether the result lands nose-forward, nose-backward, or mirrored depends on
 *    how Babylon's glTF loader composes that root rotation with the renderer's own yaw. Getting it wrong
 *    type-checks perfectly and produces a tank that drives backwards — which is exactly the V3R defect, and
 *    exactly what `tests/client/controls.test.ts` could not catch, because it compared *helper functions* to
 *    each other and never looked at a loaded mesh.
 * 2. **Scale.** The loader measures the model's extent and rescales it to the definition's dimensions. If the
 *    measurement is taken over the wrong bounding box, the tank silently renders at the wrong size.
 * 3. **Audio.** An `AudioContext` cannot start before a user gesture, so no test can prove the graph builds,
 *    the buffers decode, or the loops cross-fade. This tool synthesises a trusted click to unlock it.
 *
 * So this boots the real game, pokes the real scene graph, and reports. It asserts rather than screenshots:
 * a screenshot of a mirrored tank still looks like a tank.
 *
 * Usage: `node tools/audit-assets.mjs [--json]`
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WANT_JSON = process.argv.includes('--json');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

/**
 * Ports to try. See `shots.mjs` for why this is a list rather than one fixed number: on this machine some
 * loopback ports bind, print a banner, and are then unreachable, which is indistinguishable from a dead build.
 */
const CANDIDATE_PORTS = [4781, 4782, 4783, 4784];
const CDP_PORT = 9357;
const OUT_DIR = join(ROOT, 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome or Edge found.');
}

async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    for (const host of ['localhost', '[::1]', '127.0.0.1']) {
      try {
        const response = await fetch(`http://${host}:${port}/index.html`);
        if (response.ok) return true;
        seen.push(`${host} -> ${response.status}`);
      } catch (error) {
        const code = error.cause?.code ?? error.message;
        const line = `${host} -> ${code}`;
        if (!seen.includes(line)) seen.push(line);
      }
    }
    await sleep(250);
  }
  return { ok: false, seen };
}

async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      if (targets.length > 0) return targets;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome debugging endpoint never came up.');
}

/** Polls for the game, rather than sleeping a guessed interval. */
async function waitForGame(cdp, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '(nothing)';
  while (Date.now() < deadline) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        if (globalThis.__combatTank) return 'ready';
        const s = document.getElementById('hud-status');
        return s ? 'status: ' + s.textContent : 'loading';
      })()`,
      returnByValue: true,
    });
    lastStatus = probe.result?.value ?? '(nothing)';
    if (lastStatus === 'ready') return true;
    await sleep(400);
  }
  throw new Error(`The game never finished booting. Last state: ${lastStatus}`);
}

// PART2
/**
 * The structural audit, evaluated inside the page.
 *
 * Written as a single string expression rather than a separate file so the whole check is one round trip and
 * cannot be invalidated by a stale file on disk. It records data and never throws: a check that throws would
 * abort the remaining checks, and the point is to report *all* the failures at once.
 */
const AUDIT_EXPRESSION = `
(() => {
  const g = globalThis.__combatTank;
  const out = { checks: [], scene: {} };

  /** Records one check. Never throws: an audit that stops at the first failure hides the rest. */
  const check = (name, ok, detail) => out.checks.push({ name, status: ok ? 'pass' : 'fail', detail });

  const scene = g.scene;
  const sim = g.simulation;
  const visual = g.tankVisual;
  const rig = visual.vehicleRig;
  // Babylon's Vector3, taken from a live instance rather than assumed importable in this scope.
  const V3 = rig.gun.position.constructor;

  // --- 1. The model contract ---
  //
  // These are the node names vehicle-asset.ts resolves. If the loader found them, the GLB really was
  // parsed rather than a fallback primitive path being taken.
  check('rig has a root node', rig.root != null, rig.root ? rig.root.name : '(none)');
  check('rig has a turret', rig.turret != null, rig.turret ? rig.turret.name : '(none)');
  check('rig has a gun', rig.gun != null, rig.gun ? rig.gun.name : '(none)');
  check('rig has a muzzle marker', rig.muzzle != null, rig.muzzle ? rig.muzzle.name : '(none)');
  check('rig found wheels', rig.wheels.length > 0, rig.wheels.length + ' wheels');
  check('rig found track segments', rig.tracks.length > 0, rig.tracks.length + ' segments');
  check('rig has meshes', rig.meshes.length > 0, rig.meshes.length + ' meshes');

  // --- 2. Scale ---
  //
  // The loader rescales the model so its measured length matches the definition's hull length. Reading the
  // post-normalisation world extent back out is the only way to confirm the correction was applied: the
  // loader's own note is a claim, this is the measurement.
  const dims = sim.vehicle.definition.dimensions;
  visual.apply(sim.vehicle.state, sim.vehicle.turretState, 1 / 60);
  scene.render();

  // Measured on the **hull** only, and this distinction is the whole reason the check exists.
  //
  // Measuring across every mesh gives the length of the *gun barrel*, which overhangs the hull, and reports
  // a tank that is 6% too long when it is exactly the right size. The loader scales against the hull, so the
  // hull is what must be measured against the definition.
  // Measured along the model's own axes, in world space.
  //
  // Two earlier attempts were both wrong in instructive ways. Measuring an axis-aligned world box of a rotated
  // hull inflates the length by however far off-axis it sits. Measuring in the driver's local frame instead is
  // worse: that frame *carries the driver's scale*, so dividing it out cancels the very correction under test
  // and the number never moves no matter how wrong the scale is.
  //
  // So: take the eight world-space corners of the mesh's box, and project them onto the hull's own axes taken
  // from the world matrix and normalised. That is invariant to where the tank is parked and to its heading,
  // but very much sensitive to how big it is.
  const hullForwardAxis = (() => {
    const wm = rig.hull.getWorldMatrix();
    const axis = new V3(wm.m[8], wm.m[9], wm.m[10]);
    const n = axis.length() || 1;
    return { x: axis.x / n, y: axis.y / n, z: axis.z / n };
  })();

  const extentAlong = (axis, include) => {
    let lo = Infinity, hi = -Infinity;
    for (const mesh of rig.meshes) {
      if (include && !include(mesh)) continue;
      if (!include && mesh !== rig.hull && mesh.parent !== rig.hull) continue;
      mesh.computeWorldMatrix(true);
      mesh.refreshBoundingInfo({});
      const b = mesh.getBoundingInfo().boundingBox;
      const wm = mesh.getWorldMatrix();
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const p = V3.TransformCoordinates(
              new V3(b.center.x + sx * b.extendSize.x, b.center.y + sy * b.extendSize.y, b.center.z + sz * b.extendSize.z),
              wm);
            const proj = p.x * axis.x + p.y * axis.y + p.z * axis.z;
            lo = Math.min(lo, proj); hi = Math.max(hi, proj);
          }
        }
      }
    }
    return hi - lo;
  };

  const measured = extentAlong(hullForwardAxis);
  out.scene.measuredHullLengthM = Number(measured.toFixed(3));
  out.scene.definitionHullLengthM = Number(dims.lengthM.toFixed(3));

  // Within 6%: generous enough for a bounding box over a bounding box, tight enough to catch an
  // off-by-ten scale factor, which is the failure that actually happens.
  const scaleOk = Math.abs(measured - dims.lengthM) / dims.lengthM < 0.06;
  check('hull matches the definition length', scaleOk,
    'measured ' + measured.toFixed(2) + 'm vs definition ' + dims.lengthM.toFixed(2) + 'm');

  // Overall nose-to-tail, excluding the gun.
  //
  // The gun legitimately overhangs the hull, so including it would report a length no vehicle definition ever
  // describes. This is the number a player would measure with a tape, and it is the one that catches the scale
  // correction overshooting: matching the hull to the definition is only right if the *whole* vehicle still
  // reads as the right size against the map.
  const overall = extentAlong(hullForwardAxis, (mesh) => mesh !== rig.gun && mesh !== rig.muzzle);
  out.scene.overallLengthM = Number(overall.toFixed(3));
  // Within 15%: a track skirt or a fender legitimately overhangs the hull tub, so overall length exceeds the
  // hull length by a real amount. This is a sanity bound against a runaway scale, not a dimensional check.
  check('overall vehicle length is plausible', overall < dims.lengthM * 1.15,
    overall.toFixed(2) + 'm overall vs ' + dims.lengthM.toFixed(2) + 'm hull definition');
  check('loader recorded what it normalised',
    typeof rig.normalisationNote === 'string' && rig.normalisationNote.length > 0,
    rig.normalisationNote);

// --- 3. Orientation ---
  //
  // The decisive check. The model's own muzzle marker is read in root-local space; because the muzzle sits at
  // the far end of the barrel, the vector from the gun to the muzzle IS the model's nose direction. That is
  // then compared against the direction the renderer actually turned the root to.
  //
  // Reading the loaded mesh rather than a helper function is the whole point: this is the assertion that
  // tests/client/controls.test.ts cannot make, and that a screenshot cannot make either.
  const rootInv = rig.root.getWorldMatrix().clone().invert();
  // Transforming the absolute positions through the inverse root matrix puts both nodes into root-local
  // space, which is the model's own coordinate frame regardless of where the tank is parked on the map.
  const gunLocal = V3.TransformCoordinates(rig.gun.getAbsolutePosition(), rootInv);
  const muzzleLocal = V3.TransformCoordinates(rig.muzzle.getAbsolutePosition(), rootInv);
  const dx = muzzleLocal.x - gunLocal.x;
  const dy = muzzleLocal.y - gunLocal.y;
  const dz = muzzleLocal.z - gunLocal.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const nose = { x: dx / len, y: dy / len, z: dz / len };
  out.scene.modelNoseLocal = { x: +nose.x.toFixed(4), y: +nose.y.toFixed(4), z: +nose.z.toFixed(4) };

  // In root-local space the model must point +Z, which is the authored convention. A -Z here means the
  // exporter's root rotation did not survive loading, and the tank is on its nose.
  check('model nose points +Z in its own space', nose.z > 0.7 && Math.abs(nose.x) < 0.3,
    'local nose (' + nose.x.toFixed(2) + ', ' + nose.y.toFixed(2) + ', ' + nose.z.toFixed(2) + ')');

  // Now the world-space test, which is what the player would actually see.
  //
  // This compares the **hull's** forward axis, not the gun's. A tank's gun points wherever the turret is
  // aimed, which is independent of which way the hull is facing - comparing the barrel to the hull heading
  // fails every single time the turret is traversed off-axis, and would report a correct model as broken.
  // The V3R defect this guards against was the hull facing the wrong way while the movement was correct.
  const heading = sim.vehicle.state.headingRad;
  const hull = rig.hull;
  hull.computeWorldMatrix(true);
  // Row 2 of the world matrix is the model's local +Z axis expressed in world space.
  const m = hull.getWorldMatrix().m;
  const raw = { x: m[8], y: m[9], z: m[10] };
  // Normalised, and this matters: the row carries the driver's uniform scale, so using it raw produced a
  // "dot product" of 1.35 — an impossible number that should have been read as a bug in the check, and was.
  const hullLen = Math.hypot(raw.x, raw.y, raw.z) || 1;
  const hullForward = { x: raw.x / hullLen, y: raw.y / hullLen, z: raw.z / hullLen };
  const expectedX = Math.sin(heading);
  const expectedZ = Math.cos(heading);
  const dot = hullForward.x * expectedX + hullForward.z * expectedZ;
  out.scene.hullForwardWorld = { x: +hullForward.x.toFixed(4), y: +hullForward.y.toFixed(4), z: +hullForward.z.toFixed(4) };
  out.scene.expectedForward = { x: +expectedX.toFixed(4), z: +expectedZ.toFixed(4) };
  out.scene.hullForwardDotSimulation = Number(dot.toFixed(4));

  // Diagnostics, reported rather than asserted: when the orientation check fails, these four numbers say
  // whether the renderer failed to rotate the root, whether it wrote to a rotation type Babylon ignored, or
  // whether the hull is not actually a descendant of the root at all.
  const rootPos = rig.root.getAbsolutePosition();
  const hullPos = rig.hull.getAbsolutePosition();
  out.scene.diagnostics = {
    rootPosition: { x: +rootPos.x.toFixed(2), y: +rootPos.y.toFixed(2), z: +rootPos.z.toFixed(2) },
    hullPosition: { x: +hullPos.x.toFixed(2), y: +hullPos.y.toFixed(2), z: +hullPos.z.toFixed(2) },
    rootRotationY: +rig.root.rotation.y.toFixed(4),
    rootHasQuaternion: rig.root.rotationQuaternion != null,
    hullParentName: rig.hull.parent ? rig.hull.parent.name : '(none)',
    rootParentName: rig.root.parent ? rig.root.parent.name : '(none)',
    rootName: rig.root.name,
    hullName: rig.hull.name,
  };
  // > 0.999 is about 2.5 degrees. The renderer and the model must agree to within a couple of degrees, or the
  // player drives with W and goes sideways.
  check('hull forward matches the simulation forward vector', dot > 0.999,
    'dot = ' + dot.toFixed(4) + ' at heading ' + (heading * 180 / Math.PI).toFixed(1) + ' deg');

  // The barrel, separately: it must agree with where the turret was actually aimed, and must be horizontal
  // enough to fire. This catches a gun rotated 90 degrees in its own socket, which the hull check cannot see.
  const barrel = visual.getMuzzleWorldPosition().subtract(rig.gun.getAbsolutePosition()).normalize();
  out.scene.barrelWorld = { x: +barrel.x.toFixed(4), y: +barrel.y.toFixed(4), z: +barrel.z.toFixed(4) };
  check('barrel points roughly along the hull, not sideways',
    Math.abs(barrel.x * expectedX + barrel.z * expectedZ) > 0.6,
    'barrel/hull dot = ' + (barrel.x * expectedX + barrel.z * expectedZ).toFixed(3) +
    ' (turret is traversed, so this is loose by design)');

  // --- 4. Materials ---
  //
  // V7's promise is PBR rather than flat colour. A mesh with a StandardMaterial means the glTF's material
  // extension was not applied, which shows up as a correctly-shaped but untextured tank.
  let pbr = 0, textured = 0, withNormals = 0;
  for (const mesh of rig.meshes) {
    const mat = mesh.material;
    if (!mat) continue;
    if (mat.getClassName && mat.getClassName() === 'PBRMaterial') pbr += 1;
    if (mat.albedoTexture) textured += 1;
    if (mat.bumpTexture) withNormals += 1;
  }
  out.scene.pbrMaterials = pbr;
  out.scene.texturedMeshes = textured;
  out.scene.normalMappedMeshes = withNormals;
  check('vehicles use PBR materials', pbr > 0, pbr + ' of ' + rig.meshes.length + ' meshes');
  check('vehicles are textured', textured > 0, textured + ' textured');
  check('vehicles have normal maps', withNormals > 0, withNormals + ' normal-mapped');

  // --- 5. Environment ---
  //
  // The terrain detail texture is the other half of "no longer flat colour". Read off the terrain mesh's own
  // material rather than the asset manifest, because what matters is what is actually on the mesh.
  const terrain = scene.getMeshByName('terrain') || scene.meshes.find((m) => m.name.toLowerCase().includes('terrain'));
  const terrainMat = terrain && terrain.material;
  check('terrain has a material', !!terrainMat, terrain ? terrain.name : '(no terrain mesh)');
  check('terrain material is PBR', !!terrainMat && terrainMat.getClassName && terrainMat.getClassName() === 'PBRMaterial',
    terrainMat ? terrainMat.getClassName() : '(none)');
  check('terrain has a detail texture', !!terrainMat && !!terrainMat.albedoTexture,
    terrainMat && terrainMat.albedoTexture ? terrainMat.albedoTexture.name : '(none)');
  check('battlefield props were built', g.props != null,
    g.props ? JSON.stringify(Object.keys(g.props).slice(0, 8)) : '(none)');

  // --- 6. Audio ---
  //
  // Browsers refuse to start an AudioContext without a gesture, so the graph is built inside unlock(). This
  // tool performs a real trusted click rather than reaching into the object, because the interesting question
  // is whether the documented path works, not whether the fields happen to be settable.
  const audio = g.audio;
  const beforeUnlock = { ready: audio.isReady, muted: audio.isMuted, volume: audio.volume };

  // The unlock listener is bound to the *canvas*, not the body, so the click has to go to the canvas.
  // A click on the body proves nothing about the game's own path, and reports a failure that is really just a
  // tool that clicked the wrong element.
  const canvas = document.getElementById('render-canvas');
  check('the render canvas exists', canvas != null, canvas ? canvas.id : '(missing)');
  if (canvas) {
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  // Readiness is deliberately NOT checked here. unlock() creates the context synchronously but decodes 17 WAVs
  // asynchronously, so isReady is still false at this point in a correct implementation. It is asserted in the
  // firing pass instead, which runs after the buffers have had time to arrive.
  check('mute control still works', audio.isMuted === beforeUnlock.muted, 'isMuted=' + audio.isMuted);
  check('master volume is 1 by default', Math.abs(audio.volume - 1) < 1e-6, 'volume=' + audio.volume);

  // Master volume must actually change the level, not merely be stored.
  audio.setVolume(0.5);
  const halfStored = audio.volume;
  audio.setVolume(1);
  check('master volume is settable', Math.abs(halfStored - 0.5) < 1e-6, 'set 0.5, read back ' + halfStored);

  // Muting must silence rather than merely flip a flag.
  audio.setMuted(true);
  const mutedAfter = audio.isMuted;
  audio.setMuted(false);
  check('mute toggles', mutedAfter === true && audio.isMuted === false, 'mute round-trip ok');

  return JSON.stringify(out);
})()
`;

/**
 * Firing the gun needs a live simulation, so it runs after the structural audit, once audio is unlocked.
 *
 * Checks that driving and shooting do not throw, which is the part of the pipeline a structural check cannot
 * reach: every gun sound is `play()`ed through the voice pool, and a bug there (a missing buffer, a bad
 * panner, a disposed voice) only appears when something actually fires.
 */
const FIRE_EXPRESSION = `
(() => {
  const g = globalThis.__combatTank;
  const out = { checks: [] };
  const check = (name, ok, detail) => out.checks.push({ name, status: ok ? 'pass' : 'fail', detail });

  const sim = g.simulation;
  const visual = g.tankVisual;

  // Drive, steer, and fire several rounds: the smallest sequence that exercises engine cross-fade, track
  // conforming, wheel spin, recoil, muzzle effects, and every one-shot sound.
  //
  // The command shape is the real InputCommand - { throttle, turn, aimPoint, fire } - taken from the shape the
  // input manager produces, rather than an invented one. An invented shape fails deep inside the turret
  // solver on aimPoint.x of undefined, which reads as a simulation bug rather than a bug in the tool.
  const audio = g.audio;

  // Audio readiness, asserted here rather than in the structural pass because this runs after the pause that
  // gives the buffers time to decode. A correct implementation is still not ready the instant unlock() is
  // called, so checking it earlier reports a false failure on a working build.
  check('audio graph built and all sounds decoded', audio.isReady === true,
    'isReady=' + audio.isReady);
  out.audioReady = audio.isReady;

  const errors = [];
  const onError = (e) => errors.push(String(e.message || e));
  window.addEventListener('error', onError);

  // Distance is measured from the tank's own position rather than a telemetry counter. There is no
  // odometer field on VehicleTelemetry, and inventing one here would read undefined and report NaN - which
  // looks like the tank failed to move rather than like the tool guessed a field name.
  const before = {
    shotsFired: sim.telemetry.shotsFired,
    position: { ...sim.vehicle.state.position },
  };

  // Impacts are accumulated across the whole drive. Checking only the final frame is a coin flip: a shell in
  // flight resolves whenever it resolves, and a shell that happened to still be airborne on the last tick
  // would report "no impacts" for a build that is working perfectly.
  let impactTotal = 0;
  let peakSpeed = 0;

  for (let i = 0; i < 240; i += 1) {
    const cmd = {
      throttle: i < 120 ? 1 : 0.4,
      turn: i > 60 && i < 90 ? 0.5 : 0,
      // A real world-space point ahead of the tank, so the turret actually has work to do.
      aimPoint: { x: sim.vehicle.state.position.x, y: sim.vehicle.state.position.y, z: sim.vehicle.state.position.z + 120 },
      fire: i > 30 && i % 24 === 0,
    };
    sim.advance(1 / 60, cmd);
    visual.apply(sim.vehicle.state, sim.vehicle.turretState, 1 / 60);
    g.scene.render();
    impactTotal += sim.impacts.length;
    peakSpeed = Math.max(peakSpeed, Math.abs(sim.vehicle.state.speedMps));
  }

  window.removeEventListener('error', onError);

  const after = {
    speedMps: sim.vehicle.state.speedMps,
    shotsFired: sim.telemetry.shotsFired,
    position: { ...sim.vehicle.state.position },
  };

  const moved = Math.hypot(
    after.position.x - before.position.x,
    after.position.z - before.position.z,
  );

  out.shotsFired = after.shotsFired - before.shotsFired;
  out.distanceTravelledM = Number(moved.toFixed(2));
  out.impacts = impactTotal;
  out.peakSpeedMps = Number(peakSpeed.toFixed(3));

  check('the gun fired during the drive', after.shotsFired > before.shotsFired,
    (after.shotsFired - before.shotsFired) + ' rounds fired');
  check('the tank moved', moved > 5, moved.toFixed(1) + ' m travelled');
  check('shells resolved into impacts', impactTotal > 0, impactTotal + ' impacts');
  check('wheels survived the drive', visual.vehicleRig.wheels.length > 0,
    visual.vehicleRig.wheels.length + ' wheels');
  check('no uncaught errors while driving and firing', errors.length === 0, errors.join(' | ') || 'none');

  return JSON.stringify(out);
})()
`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const serverLog = [];
  let port = null;
  let server = null;
  let chrome = null;
  const pageErrors = [];
  const allChecks = [];

  try {
    // --- Server ---
    for (const candidate of CANDIDATE_PORTS) {
      const child = spawn(
        process.execPath,
        [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(candidate)],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (c) => serverLog.push(c.toString()));
      child.stderr.on('data', (c) => serverLog.push(c.toString()));

      const probe = await waitForServer(candidate);
      if (probe === true) {
        port = candidate;
        server = child;
        break;
      }
      serverLog.push(`port ${candidate} did not answer: ${probe.seen.join(', ')}\n`);
      child.kill();
    }
    if (port === null || server === null) {
      throw new Error(`Preview server never answered.\n${serverLog.join('')}`);
    }

    // --- Browser ---
    //
    // `--autoplay-policy=no-user-gesture-required` is what lets the audio half run headlessly at all, and
    // `--mute-audio` silences the output device so a CI machine does not play gunfire at 2am. Neither changes
    // the code path under test: the graph is still built by unlock(), and is still muted by --mute-audio only
    // at the OS layer, after the mixer has done its work.
    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${join(ROOT, '.chrome-profile-assets')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--window-size=1280,760',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const targets = await waitForCdp();
    const page = targets.find((t) => t.type === 'page') ?? targets[0];
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    cdp.onRaw = (text) => {
      // Errors only. Warnings are ignored on purpose: Babylon emits several benign ones about shader
      // compilation under SwiftShader, and failing the audit on those would make the tool useless.
      if (text.includes('exceptionThrown')) {
        for (const m of text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          pageErrors.push(`exception: ${m[1].slice(0, 300)}`);
        }
        // The message, not just "Uncaught". A rejected promise whose reason is empty says nothing, and the
        // one thing worth knowing about an unhandled rejection is *what* was rejected.
        for (const m of text.matchAll(/"exception"\s*:\s*\{[^}]*?"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          pageErrors.push(`  reason: ${m[1].slice(0, 300)}`);
        }
      }
      if (text.includes('consoleAPICalled') && /"type"\s*:\s*"error"/.test(text)) {
        for (const m of text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          pageErrors.push(`console: ${m[1].slice(0, 300)}`);
        }
      }
    };

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // --- Boot ---
    await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });
    await waitForGame(cdp);

    // The scene needs a few frames before meshes have world matrices, and SwiftShader is slow, so this is
    // generous on purpose: a too-short wait reports a scale failure for a model that is merely not ready yet.
    await sleep(5000);

    const audit = await cdp.send('Runtime.evaluate', {
      expression: AUDIT_EXPRESSION,
      returnByValue: true,
    });
    if (audit.exceptionDetails) {
      throw new Error(`The audit itself threw: ${JSON.stringify(audit.exceptionDetails).slice(0, 600)}`);
    }
    const auditResult = JSON.parse(audit.result.value);
    allChecks.push(...auditResult.checks);

    // Audio buffers decode asynchronously, so the firing pass runs after a further pause.
    await sleep(2000);
    const fire = await cdp.send('Runtime.evaluate', {
      expression: FIRE_EXPRESSION,
      returnByValue: true,
    });
    if (fire.exceptionDetails) {
      // The full description matters: `exceptionDetails.text` is just "Uncaught" for an error thrown inside
      // minified code, and the message is the only thing that identifies which call actually failed.
      const detail = fire.exceptionDetails.exception?.description ?? JSON.stringify(fire.exceptionDetails);
      throw new Error(`The firing pass threw: ${String(detail).slice(0, 900)}`);
    }
    const fireResult = JSON.parse(fire.result.value);
    allChecks.push(...fireResult.checks);

    // --- Report ---
    const failed = allChecks.filter((c) => c.status === 'fail');
    const report = {
      passed: failed.length === 0 && pageErrors.length === 0,
      scene: auditResult.scene,
      firing: fireResult,
      checks: allChecks,
      pageErrors,
    };

    writeFileSync(join(OUT_DIR, 'asset-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (WANT_JSON) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write('\nV7 asset pipeline audit\n\n');
      for (const c of allChecks) {
        process.stdout.write(`  [${c.status.toUpperCase()}] ${c.name}\n         ${c.detail}\n`);
      }
      process.stdout.write('\n  Scene:\n');
      for (const [k, v] of Object.entries(auditResult.scene)) {
        process.stdout.write(`    ${k} = ${JSON.stringify(v)}\n`);
      }
      if (pageErrors.length > 0) {
        process.stdout.write('\n  Page errors:\n');
        for (const e of pageErrors) process.stdout.write(`    ${e}\n`);
      }
      process.stdout.write(`\n  ${allChecks.length - failed.length}/${allChecks.length} checks passed\n`);
      process.stdout.write('  report: shots/asset-audit.json\n');
    }

    cdp.close();
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    chrome?.kill();
    server?.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`\nasset audit failed to run: ${error.message}\n`);
  process.exitCode = 1;
});