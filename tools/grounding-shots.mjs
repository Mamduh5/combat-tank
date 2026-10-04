/**
 * Captures the V6 grounding pass: every surface the brief names, from a low side viewpoint.
 *
 * ## Why this file exists and why it is not `tour.js`
 *
 * `tour.js` answers "does the map read as a coherent place". This one answers a much narrower and much
 * harder question: **is the tank touching the ground here?** Those need different cameras. A layout view
 * from 200 m makes a 20 cm gap under a track completely invisible â€” a fraction of a pixel â€” so every view
 * here sits low and to the side, near wheel height, where the contact line is actually readable. A
 * screenshot taken from the gameplay camera would have passed with the original bug still present.
 *
 * Each view also reports its own measured gap, so the index is a numeric record as well as a set of
 * pictures. If a view ever disagrees with its number, the number is what the tests gate on and the picture
 * is what a human reads, and both are written out.
 *
 * ## The surfaces
 *
 * Taken from `grounding-measurement.ts`'s own pose list rather than chosen here, so the screenshots and the
 * automated assertions look at the same places. A screenshot pass that surveyed different ground from the
 * test suite could pass while the tested ground stayed broken.
 *
 * Usage: `node tools/grounding-shots.mjs [outDir] [--boot=ms]`
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { CDP } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const CANDIDATE_PORTS = [4331, 4410, 4510, 4610, 4710, 4810, 4910];
const CDP_PORT = 9344;
const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'shots/grounding';

/** Milliseconds to let the page boot before the first capture. Software rendering is slow. */
const BOOT_MS = Number(
  process.argv.slice(2).find((a) => a.startsWith('--boot='))?.slice('--boot='.length) ?? 20000,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('No Chrome or Edge found.');
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    for (const host of ['localhost', '[::1]', '127.0.0.1']) {
      try {
        const response = await fetch(`http://${host}:${port}/index.html`);
        seen.push(`${host} -> ${response.status}`);
        if (response.ok) return true;
      } catch (error) {
        seen.push(`${host} -> ${error.cause?.code ?? error.message}`);
      }
    }
    await sleep(300);
  }
  process.stderr.write(`preview server never answered on ${port}: ${seen.join(', ')}\n`);
  return false;
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

/** Polls for the game rather than sleeping a fixed time: `__combatTank` exists exactly when it is ready. */
async function waitForGame(cdp, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: 'typeof globalThis.__combatTank',
      returnByValue: true,
    });
    if (probe.result?.value === 'object') return true;
    await sleep(300);
  }
  return false;
}

/** Loads the pose list from the measurement module, so both agree on where the surfaces are. */
async function loadPoses() {
  const cacheDir = `node_modules/.vite-grounding-shots-${process.pid}`;
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
    cacheDir,
  });
  try {
    const mod = await server.ssrLoadModule('/src/tools/headless/grounding-measurement.ts');
    return mod.groundingTestPoses();
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

/**
 * The pose script evaluated in the page for each view.
 *
 * Parks the tank, settles it, then places the camera **low and to the side** relative to the hull rather
 * than behind it. A side view is what makes a contact line readable: from behind, the two tracks overlap
 * and the near one hides the far one, so a vehicle resting on one corner still looks level. From the side,
 * a track lifted clear of the ground is unmistakable.
 *
 * The camera height is measured from the terrain rather than hard-coded in world space, so the same script
 * works on a hillside and in a hollow. Two metres is roughly turret height â€” the height the player actually
 * sees the tank from â€” and low enough that a gap under the track reads as a visible band, not a hairline.
 *
 * The gap is measured from the **real track vertices** through Babylon's own world matrix, not restated
 * from the transform, so this is an independent check on the headless measurement rather than a repeat of
 * it.
 */
const poseScript = `
(() => {
  const g = globalThis.__combatTank;
  if (!g || !g.scene) return { error: 'the game has not finished booting' };

  const scene = g.scene;
  const sim = g.simulation;
  const field = sim.battlefield;
  const tank = sim.vehicle;
  const engine = scene.getEngine();
  const camera = scene.activeCamera;
  const V3 = camera.position.constructor;
  const cfg = JSON.parse(decodeURIComponent(location.hash.slice(1) || '{}'));

  tank.reset({ x: cfg.x, y: field.terrain.heightAt(cfg.x, cfg.z), z: cfg.z }, cfg.heading);
  for (let i = 0; i < 40; i += 1) sim.advance(1 / 60);
  g.playerVisual.apply(tank.state, tank.turretState, 1 / 60);

  // The contact line is the track's *lowest* point, so each segment contributes one gap: its lowest
  // rendered vertex against the terrain directly beneath it. Taking the max over every vertex instead
  // would report the top of the track slab, roughly 1.08 m up, and call it daylight under the vehicle.
  const gaps = [];
  for (const mesh of scene.meshes) {
    if (!mesh.name.startsWith('tank-track-') || !mesh.isEnabled() || !mesh.isVisible) continue;
    mesh.computeWorldMatrix(true);
    const matrix = mesh.getWorldMatrix();
    const positions = mesh.getVerticesData('position');
    if (!positions) continue;
    const world = new V3();
    let lowestY = Infinity;
    let lowestX = 0;
    let lowestZ = 0;
    for (let i = 0; i < positions.length; i += 3) {
      world.set(positions[i], positions[i + 1], positions[i + 2]);
      const p = V3.TransformCoordinates(world, matrix);
      if (p.y < lowestY) { lowestY = p.y; lowestX = p.x; lowestZ = p.z; }
    }
    if (Number.isFinite(lowestY)) gaps.push(lowestY - field.terrain.heightAt(lowestX, lowestZ));
  }

  // ## The cohesion check, which the gap check above does not cover
  //
  // A vehicle can have every track segment perfectly on the ground and still look broken, if the hull is
  // no longer attached to them. That is exactly what the first version of this pass did: the gap
  // measurement read zero at every station while the tracks hung well below the hull, because the only
  // thing being compared was the track against the *terrain*. Nothing compared the track to the *hull*.
  //
  // Measured per station rather than as two global extremes. Taking the lowest hull vertex anywhere and the
  // highest track vertex anywhere and subtracting them reports a huge "gap" on any steep slope, because the
  // hull is legitimately metres above the tail's track top when the tank is pitched — a correct pose being
  // misread as a defect. What matters is whether the assembly directly above each track segment is still
  // joined to it, so each station is compared against the structure at that same longitudinal position.
  //
  // Both sides are read from real world-space vertices, so no geometry is re-derived here.
  let hullToTrackGapM = 0;
  {
    // The hull's lowest rendered vertex at each end of the vehicle, and the track's highest vertex at the
    // same ends. Sampling only the two ends is deliberate: the middle of the hull is always well clear of
    // the tracks on a real tank, so only the extremities can reveal a detachment.
    const h = cfg.heading;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    // The **fender** is the lowest part of the hull-side assembly, and it is a child of each track segment,
    // so it moves with the track. Comparing against it — rather than against the glacis, which sits a full
    // track-height higher and is joined to the fender by the hull's own structure — is what actually tests
    // whether the running gear is still attached to the vehicle. Before this pass the fender was a single
    // rigid mesh on the hull while the tracks moved independently, which is precisely how the two came
    // apart.
    const hullMeshes = scene.meshes.filter(
      (m) => /tank-fender/.test(m.name) && m.isEnabled() && m.isVisible,
    );
    const trackMeshes = scene.meshes.filter(
      (m) => m.name.startsWith('tank-track-') && m.isEnabled() && m.isVisible,
    );

    let worst = Number.NEGATIVE_INFINITY;
    for (const station of [-3.15, 3.15]) {
      const stationX = cfg.x + fx * station;
      const stationZ = cfg.z + fz * station;

      // Lowest fender vertex near this station: the fender is the lowest part of the hull-side assembly.
      let hullY = Infinity;
      for (const mesh of hullMeshes) {
        mesh.computeWorldMatrix(true);
        const positions = mesh.getVerticesData('position');
        if (!positions) continue;
        const world = new V3();
        for (let i = 0; i < positions.length; i += 3) {
          world.set(positions[i], positions[i + 1], positions[i + 2]);
          const p = V3.TransformCoordinates(world, mesh.getWorldMatrix());
          const along = (p.x - stationX) * fx + (p.z - stationZ) * fz;
          if (Math.abs(along) > 1.6) continue;
          if (p.y < hullY) hullY = p.y;
        }
      }

      // Highest track vertex near this station. A negative result means the fender overlaps the track, which is correct:
      let trackY = -Infinity;
      for (const mesh of trackMeshes) {
        mesh.computeWorldMatrix(true);
        const positions = mesh.getVerticesData('position');
        if (!positions) continue;
        const world = new V3();
        for (let i = 0; i < positions.length; i += 3) {
          world.set(positions[i], positions[i + 1], positions[i + 2]);
          const p = V3.TransformCoordinates(world, mesh.getWorldMatrix());
          const along = (p.x - stationX) * fx + (p.z - stationZ) * fz;
          if (Math.abs(along) > 1.6) continue;
          if (p.y > trackY) trackY = p.y;
        }
      }

      if (Number.isFinite(hullY) && Number.isFinite(trackY)) {
        // they are joined by design.
        //
        worst = Math.max(worst, hullY - trackY);
      }
    }
    hullToTrackGapM = Number.isFinite(worst) ? +worst.toFixed(3) : 0;
  }


  // Low and to the side, relative to the hull's own heading.
  const h = cfg.heading;
  const sideX = Math.cos(h);
  const sideZ = -Math.sin(h);
  const dist = cfg.dist ?? 11;
  const groundAtTank = field.terrain.heightAt(cfg.x, cfg.z);
  camera.position.set(cfg.x + sideX * dist, groundAtTank + (cfg.height ?? 2.0), cfg.z + sideZ * dist);
  camera.setTarget(new V3(cfg.x, groundAtTank + 0.9, cfg.z));

  if (scene.fogMode !== 0) scene.fogDensity = 0.0004;
  if (engine && typeof engine.stopRenderLoop === 'function') engine.stopRenderLoop();
  if (engine && typeof engine.beginFrame === 'function') engine.beginFrame();
  scene.render();
  if (engine && typeof engine.endFrame === 'function') engine.endFrame();

  const s = tank.state;
  return {
    label: cfg.label,
    pitchDeg: +((s.bodyPitchRad * 180) / Math.PI).toFixed(2),
    rollDeg: +((s.bodyRollRad * 180) / Math.PI).toFixed(2),
    maxGapM: gaps.length ? +Math.max(...gaps).toFixed(3) : null,
    maxBiteM: gaps.length ? +Math.min(...gaps).toFixed(3) : null,
    // Positive means daylight between the tracks and the hull: the vehicle has come apart.
    hullToTrackGapM,
  };
})()
`;


/**
 * The driving script: drives the vehicle across uneven ground and captures frames along the way.
 *
 * ## Why a sequence and not more stills
 *
 * The brief is explicit that a single static screenshot is not enough, and it is right for a specific
 * reason: the conforming eases toward the ground over several frames, so its two failure modes are both
 * invisible in a still. A track that **snaps** rather than eases looks correct in every still and wrong in
 * motion, and a track that **oscillates** around the ground looks correct in a still and wrong in motion.
 * Neither can be seen without watching it move.
 *
 * So this drives the vehicle with a real input command — the same `setInputFrame` path a player's keyboard
 * takes — steps the simulation and the renderer together, and captures at intervals. It reports two numbers
 * per frame: the worst gap, and the **frame-to-frame change in that gap**, which is the jitter measurement.
 *
 * The jitter number is what distinguishes "the track is following the ground" from "the track is
 * vibrating". A gap that stays under a few centimetres while its frame-to-frame delta stays small is
 * contact; a gap that oscillates between two values while the mean stays low is vibration.
 */
const driveScript = `
(async () => {
  const g = globalThis.__combatTank;
  if (!g || !g.scene) return { error: 'the game has not finished booting' };

  const scene = g.scene;
  const sim = g.simulation;
  const field = sim.battlefield;
  const tank = sim.vehicle;
  const engine = scene.getEngine();
  const camera = scene.activeCamera;
  const V3 = camera.position.constructor;
  const cfg = JSON.parse(decodeURIComponent(location.hash.slice(1) || '{}'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const start = { x: cfg.x, z: cfg.z, heading: cfg.heading };
  tank.reset({ x: start.x, y: field.terrain.heightAt(start.x, start.z), z: start.z }, start.heading);
  for (let i = 0; i < 40; i += 1) sim.advance(1 / 60);

  // A real InputCommand rather than a direct state write, so the drive goes through the same locomotion
  // path a player's keyboard does. setInputFrame is deliberately *not* used here: it only feeds the real
  // render loop, and this script steps the simulation itself, so an override would be ignored and the tank
  // would sit still while reporting a perfectly clean gap on every frame — a green result for a vehicle
  // that never moved, which is the most expensive kind of wrong measurement.
  //
  // The field names are the core's own (turn, aimPoint), not the input manager's, because this bypasses
  // the input manager. Guessing them wrong throws inside the turret solver rather than at the boundary, which
  // is how an earlier version of this script reported three failed drives as three clean ones.
  const drive = { throttle: 1, turn: cfg.steer ?? 0, aimPoint: null, fire: false };

  const frames = [];
  let previousWorstGap = null;

  for (let frame = 0; frame < cfg.frames; frame += 1) {
    // One fixed 60 Hz tick plus one render, which is exactly what the real frame loop does per frame.
    sim.advance(1 / 60, drive);
    g.playerVisual.apply(tank.state, tank.turretState, 1 / 60);
    // The contact line is each segment's LOWEST vertex, so the gap is measured per segment rather
    // than over every vertex. Taking the max over all of them would report the top of the track slab —
    // about 1.08 m up — and call it daylight under the vehicle, which is the mistake this script made
    // before and which read as a 1.08 m failure on a vehicle that was actually perfectly grounded.
    let worstGap = -Infinity;
    for (const mesh of scene.meshes) {
      if (!mesh.name.startsWith('tank-track-') || !mesh.isEnabled() || !mesh.isVisible) continue;
      mesh.computeWorldMatrix(true);
      const matrix = mesh.getWorldMatrix();
      const positions = mesh.getVerticesData('position');
      if (!positions) continue;
      const world = new V3();
      let lowestY = Infinity;
      let lowestX = 0;
      let lowestZ = 0;
      for (let i = 0; i < positions.length; i += 3) {
        world.set(positions[i], positions[i + 1], positions[i + 2]);
        const p = V3.TransformCoordinates(world, matrix);
        if (p.y < lowestY) { lowestY = p.y; lowestX = p.x; lowestZ = p.z; }
      }
      if (Number.isFinite(lowestY)) {
        const gap = lowestY - field.terrain.heightAt(lowestX, lowestZ);
        if (gap > worstGap) worstGap = gap;
      }
    }

    frames.push({
      frame,
      speedMps: +tank.state.speedMps.toFixed(2),
      worstGapM: +worstGap.toFixed(3),
      jitterM: previousWorstGap === null ? 0 : +(worstGap - previousWorstGap).toFixed(4),
      pitchDeg: +((tank.state.bodyPitchRad * 180) / Math.PI).toFixed(2),
    });
    previousWorstGap = worstGap;

    if (frame % cfg.captureEvery === 0) {
      const s = tank.state;
      const h = s.headingRad;
      const groundHere = field.terrain.heightAt(s.position.x, s.position.z);
      camera.position.set(
        s.position.x + Math.cos(h) * 12,
        groundHere + 2.6,
        s.position.z - Math.sin(h) * 12,
      );
      camera.setTarget(new V3(s.position.x, groundHere + 0.8, s.position.z));
      if (scene.fogMode !== 0) scene.fogDensity = 0.0004;
      scene.render();
      await sleep(30);
    }
  }

  const gaps = frames.map((f) => f.worstGapM);
  const jitters = frames.map((f) => Math.abs(f.jitterM));
  const travelledM = +Math.hypot(
    tank.state.position.x - start.x,
    tank.state.position.z - start.z,
  ).toFixed(1);
  const topSpeedMps = Math.max(...frames.map((f) => Math.abs(f.speedMps)));
  return {
    label: cfg.label,
    frames: frames.length,
    maxGapM: +Math.max(...gaps).toFixed(3),
    meanGapM: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3),
    // The jitter figure the brief asks about: the largest single-frame change in the worst gap.
    maxJitterM: +Math.max(...jitters).toFixed(4),
    topSpeedMps,
    travelledM,
    // Asserted in the report so a drive that failed to move cannot be read as a clean run. A vehicle that
    // never left its start point reports a beautiful zero gap every frame, and without this flag that would
    // look like the best possible result rather than the worst.
    moved: travelledM > 5,
    series: frames.filter((f) => f.frame % 6 === 0),
  };
})()
`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const poses = await loadPoses();

  // Serve the built game with `preview`, so the captured bundle is the production build rather than a
  // dev-mode transform of it.
  let port = null;
  let server = null;
  for (const candidate of CANDIDATE_PORTS) {
    server = spawn('npx', ['vite', 'preview', '--port', String(candidate)], {
      cwd: ROOT,
      stdio: 'ignore',
      shell: true,
    });
    if (await waitForServer(candidate)) {
      port = candidate;
      break;
    }
    server.kill();
    server = null;
  }
  if (port === null) throw new Error('could not start a preview server on any candidate port');

  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(ROOT, '.chrome-profile-grounding')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1280,760',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const index = [];
  const driveResults = [];
  const pageErrors = [];

  try {
    const targets = await waitForCdp();
    const page = targets.find((t) => t.type === 'page') ?? targets[0];
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    cdp.onRaw = (text) => {
      if (!text.includes('exceptionThrown')) return;
      for (const m of text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        pageErrors.push(m[1].slice(0, 200));
      }
    };

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const pose of poses) {
      const cfg = {
        label: pose.label,
        x: pose.x,
        z: pose.z,
        heading: pose.headingRad,
        dist: 11,
        height: 2.0,
      };
      await cdp.send('Page.navigate', {
        url: `http://localhost:${port}/#${encodeURIComponent(JSON.stringify(cfg))}`,
      });

      if (!(await waitForGame(cdp))) {
        index.push({ label: pose.label, file: null, info: { error: 'game never booted' } });
        process.stdout.write(`${pose.label}: never booted\n`);
        continue;
      }
      // The boot wait is paid once, for the first view. Later views navigate inside an already-warm page,
      // and software rendering makes a per-view wait expensive enough to be worth avoiding.
      if (index.length === 0) await sleep(BOOT_MS);

      const result = await cdp.send('Runtime.evaluate', {
        expression: poseScript,
        awaitPromise: true,
        returnByValue: true,
      });
      const info = result.exceptionDetails
        ? { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
        : (result.result?.value ?? null);

      await sleep(500);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const slug = pose.label
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
      const file = join(OUT, `${slug}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));

      index.push({ label: pose.label, file, info });
      process.stdout.write(`${file}  ${JSON.stringify(info)}\n`);
    }

    // --- The driving sequences ------------------------------------------------------------
    //
    // Stills cannot show whether the conforming eases or vibrates, so a few drives are run as well. Each
    // crosses genuinely uneven ground and reports the worst gap and the worst frame-to-frame change in it
    // over the whole run.
    //
    // Routes are chosen to cross a feature rather than to sit on one: the crest drive goes *over* the
    // central swell, which is where a snapping track is most obvious, and the field drive runs along the
    // rolling ground the map documents as its main artery.
    const DRIVES = [
      {
        label: 'drive: over the central swell',
        x: -10,
        z: 40,
        heading: Math.PI,
        steer: 0,
        frames: 150,
        captureEvery: 25,
      },
      {
        label: 'drive: across the rolling fields',
        x: -60,
        z: 110,
        heading: 0.5,
        steer: 0.25,
        frames: 150,
        captureEvery: 25,
      },
      {
        label: 'drive: up the cairn approach',
        x: 110,
        z: -120,
        heading: -0.7,
        steer: 0.1,
        frames: 150,
        captureEvery: 25,
      },
    ];

    for (const drive of DRIVES) {
      await cdp.send('Page.navigate', {
        url: `http://localhost:${port}/#${encodeURIComponent(JSON.stringify(drive))}`,
      });
      if (!(await waitForGame(cdp))) {
        driveResults.push({ label: drive.label, error: 'game never booted' });
        continue;
      }

      const result = await cdp.send('Runtime.evaluate', {
        expression: driveScript,
        awaitPromise: true,
        returnByValue: true,
        // Generous: this steps the simulation several hundred times under a software renderer, which
        // legitimately takes minutes, and a timeout sized for the shortest call would abandon a real run.
        timeoutMs: 600000,
      });
      const info = result.exceptionDetails
        ? { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
        : (result.result?.value ?? null);

      // One frame at the end of the drive, showing where it finished.
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const slug = drive.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
      const file = join(OUT, `${slug}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));

      driveResults.push({ label: drive.label, file, info });
      process.stdout.write(
        `${file}  ${JSON.stringify(info === null ? null : { ...info, series: undefined })}\n`,
      );
    }

    cdp.close();
  } finally {
    chrome?.kill();
    server?.kill();
  }

  writeFileSync(
    join(OUT, 'index.json'),
    `${JSON.stringify({ views: index, drives: driveResults, pageErrors: [...new Set(pageErrors)] }, null, 2)}\n`,
    'utf8',
  );
  const worstGap = Math.max(...index.map((v) => v.info?.maxGapM ?? -Infinity));
  const worstDriveGap = Math.max(...driveResults.map((d) => d.info?.maxGapM ?? -Infinity));
  const worstJitter = Math.max(...driveResults.map((d) => d.info?.maxJitterM ?? 0));
  process.stdout.write(`\ncaptured ${index.length} stills and ${driveResults.length} drives into ${OUT}\n`);
  process.stdout.write(`worst daylight, parked: ${worstGap.toFixed(3)} m\n`);
  process.stdout.write(`worst daylight, driving: ${worstDriveGap.toFixed(3)} m\n`);
  process.stdout.write(`worst frame-to-frame change in that gap: ${worstJitter.toFixed(4)} m\n`);
  if (pageErrors.length > 0) {
    process.stdout.write(`page errors:\n  ${[...new Set(pageErrors)].slice(0, 8).join('\n  ')}\n`);
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error.stack ?? error.message}\n`);
  process.exit(1);
});



