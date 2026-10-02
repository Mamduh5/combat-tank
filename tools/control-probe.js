/**
 * Browser-side control verification, driven by the same events a player's keyboard and mouse produce.
 *
 * ## Why this exists and why it is not a test
 *
 * The owner played V6 and reported that A/D rotated the camera, that W/S moved the tank sideways through
 * its hull rather than through its front and rear, and that A/D swung the visible nose the wrong way.
 * Every automated control test passed while all three were true, because they all compared movement
 * against the simulation's own forward vector. The simulation was never wrong. The **rendered tank** was,
 * and the **camera** was parented to the hull.
 *
 * So this drives the real page with real `KeyboardEvent`s and real `mousemove`s, then measures three
 * things only observable on screen:
 *
 *   1. where the tank actually moved, relative to where the **visible glacis mesh** is pointing;
 *   2. where the camera actually ended up, relative to where it started;
 *   3. whether hull heading and camera bearing move independently of each other.
 *
 * ## The visible nose is read from geometry, not from a source helper
 *
 * `visibleNose()` finds the `tank-glacis` mesh and asks which end of it lies further along a candidate
 * direction. That is deliberately independent of `modelNoseWorldDirection`: if both came from the same
 * function the probe would only be confirming that a function agrees with itself, which is exactly the
 * mistake that let the original bug through.
 *
 * Pointer lock cannot be granted in headless Chrome, and `InputManager.onMouseMove` deliberately ignores
 * unlocked movement (unlocked `movementX` jumps when the cursor re-enters the window). So
 * `document.pointerLockElement` is stubbed for the duration and real `mousemove` events are dispatched with
 * explicit `movementX`. Everything downstream of the input layer is the shipping code path.
 */
(() => {
  const g = globalThis.__combatTank;
  if (!g) {
    return { error: 'game has not booted' };
  }

  const scene = g.scene;
  const sim = g.simulation;
  const camera = g.orbitCamera;
  const canvas = document.getElementById('render-canvas');

  const DEG = 180 / Math.PI;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Waits `n` animation frames, so the game's own render loop actually runs a step. */
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

  /** Signed degrees from one XZ direction to another, in the project's heading convention. */
  const headingDeltaDeg = (from, to) =>
    ((((Math.atan2(to.x, to.z) - Math.atan2(from.x, from.z)) * DEG + 540) % 360) - 180);

  /** Simulation's forward vector for the current heading. */
  const simForward = () => {
    const h = sim.vehicle.state.headingRad;
    return { x: Math.sin(h), z: Math.cos(h) };
  };

  const cameraPosition = () => {
    const p = scene.activeCamera.position;
    return { x: p.x, y: p.y, z: p.z };
  };

  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  /** The camera's bearing around the tank: which side of the vehicle it is on. */
  const cameraBearing = () => {
    const t = sim.vehicle.state.position;
    const p = scene.activeCamera.position;
    return Math.atan2(p.x - t.x, p.z - t.z);
  };

  const bearingDir = (bearing) => ({ x: Math.sin(bearing), z: Math.cos(bearing) });

  const cameraMovedDeg = (before) =>
    Number(headingDeltaDeg(bearingDir(before), bearingDir(cameraBearing())).toFixed(3));

  const headingMovedDeg = (beforeHeading) =>
    Number(
      headingDeltaDeg(
        { x: Math.sin(beforeHeading), z: Math.cos(beforeHeading) },
        simForward(),
      ).toFixed(2),
    );

  const report = [];
  const record = (name, data) => report.push({ name, ...data });

  return (async () => {
// --- Pointer-lock stub ----------------------------------------------------------------
    // Headless Chrome will not grant pointer lock, and the input layer ignores unlocked movement on
    // purpose. Stubbed so real `mousemove` events reach the look handler; nothing else is changed.
    const originalLock = Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement');
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      configurable: true,
      get() {
        return canvas;
      },
    });

    /**
     * Where the **visible** nose points, read off the glacis mesh's own world-space geometry.
     *
     * The glacis is a wedge whose tapered end is the front, and it is not symmetric about its own centreline
     * once it has been placed on sloping ground: body pitch and roll tilt it, and the corner vertices sit
     * 1.6 m off the centreline. So the nose is measured as the **axis**: the midpoint of the front group of
     * vertices relative to the midpoint of the rear group. Averaging pairs the measurement up with the
     * lateral offset instead of reading one corner's bearing, which is what produced a spurious 15 degree
     * error before this was fixed.
     *
     * Deliberately independent of `modelNoseWorldDirection` in the source: if both came from the same
     * function the probe would only be confirming that a function agrees with itself, which is exactly how
     * the original bug passed every test.
     */
    const visibleNose = () => {
      const mesh = scene.getMeshByName('tank-glacis');
      if (!mesh) {
        return null;
      }
      const positions = mesh.getVerticesData('position');
      const world = mesh.getWorldMatrix().m;
      // Babylon stores row-major, so element (row, col) is world[row * 4 + col].
      const project = (x, y, z) => ({
        x: x * world[0] + y * world[4] + z * world[8] + world[12],
        z: x * world[2] + y * world[6] + z * world[10] + world[14],
      });

      const candidate = simForward();
      // Group by which end of the wedge each vertex belongs to, along the candidate direction.
      const front = [];
      const rear = [];
      let best = -Infinity;
      let nearest = Infinity;
      const projected = [];
      for (let i = 0; i < positions.length; i += 3) {
        const p = project(positions[i], positions[i + 1], positions[i + 2]);
        const along = p.x * candidate.x + p.z * candidate.z;
        projected.push({ p, along });
        if (along > best) best = along;
        if (along < nearest) nearest = along;
      }
      // The wedge's two ends are well separated along its own axis; take the vertices in the outer fifth
      // of that range at each end so a single corner cannot define the group.
      for (const { p, along } of projected) {
        if (along > best - (best - nearest) * 0.2) front.push(p);
        if (along < nearest + (best - nearest) * 0.2) rear.push(p);
      }
      const mean = (list) => ({
        x: list.reduce((s, p) => s + p.x, 0) / list.length,
        z: list.reduce((s, p) => s + p.z, 0) / list.length,
      });
      const frontMid = mean(front);
      const rearMid = mean(rear);
      return {
        // Nose axis: rear midpoint -> front midpoint.
        front: { x: frontMid.x - rearMid.x, z: frontMid.z - rearMid.z },
        // Rear axis, for the reverse check.
        rear: { x: rearMid.x - frontMid.x, z: rearMid.z - frontMid.z },
      };
    };

    /**
     * Presses a key for `ms`, exactly as a player would.
     *
     * The holds are long on purpose. Under SwiftShader this page runs at a few frames per second, and the
     * frame loop advances the simulation by at most `MAX_BATTLE_CATCHUP_TICKS` (5 ticks, ~83 ms) per frame,
     * so a second of wall clock buys a fraction of a second of simulated time. A short hold therefore
     * measures the input smoothing ramp rather than the control, which is how the first run of this probe
     * reported W travelling 0.62 m and a hull turn of 0.7 degrees. Long enough for the smoothed axis to
     * reach full deflection and the vehicle to actually build up speed.
     */
    const holdKey = async (code, ms) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await sleep(ms);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await sleep(150);
    };

    /** Moves the mouse while "pointer locked", which is the only way look input is honoured. */
    const moveMouse = async (dx, dy = 0, steps = 12) => {
      for (let i = 0; i < steps; i += 1) {
        const event = new MouseEvent('mousemove', { bubbles: true });
        Object.defineProperty(event, 'movementX', { value: dx / steps });
        Object.defineProperty(event, 'movementY', { value: dy / steps });
        window.dispatchEvent(event);
        await frames(1);
      }
      await sleep(150);
    };

    /** Places the tank on open ground at a heading and parks the opponent far away. */
    const placeAt = async (headingDeg) => {
      const heading = (headingDeg * Math.PI) / 180;
      const x = -40 + (headingDeg / 90) * 30;
      const z = 150;
      sim.vehicle.reset({ x, y: sim.battlefield.terrain.heightAt(x, z), z }, heading);
      if (sim.target) {
        sim.target.reset({ x: 210, y: sim.battlefield.terrain.heightAt(210, -210), z: -210 }, 0);
      }
      camera.snapToTarget(heading);
      await frames(3);
    };

    await frames(5);

    // A. Baseline: does the visible nose agree with simulation forward, at several headings?
    for (const headingDeg of [0, 45, 90, 135, 180, 270]) {
      await placeAt(headingDeg);
      const nose = visibleNose();
      if (!nose) {
        if (originalLock) {
          Object.defineProperty(Document.prototype, 'pointerLockElement', originalLock);
        }
        return { error: 'tank-glacis mesh not found in the scene' };
      }
      const fwd = simForward();
      record('visible-nose-vs-simulation', {
        headingDeg,
        // 0 means the mesh's front end points exactly where the simulation says forward is.
        noseMinusSimDeg: Number(headingDeltaDeg(fwd, { x: nose.front.x, z: nose.front.z }).toFixed(2)),
        // True when the front of the mesh is genuinely the end furthest along the forward direction.
        frontIsFurthestEnd:
          nose.front.x * fwd.x + nose.front.z * fwd.z > nose.rear.x * fwd.x + nose.rear.z * fwd.z,
      });
    }

    // B. W: the tank must travel through its visible front, and the camera must not be dragged with it.
    await placeAt(0);
    let camPos = cameraPosition();
    let camBear = cameraBearing();
    let start = { ...sim.vehicle.state.position };
    await holdKey('KeyW', 6000);
    let moved = { x: sim.vehicle.state.position.x - start.x, z: sim.vehicle.state.position.z - start.z };
    let len = Math.hypot(moved.x, moved.z);
    const wDir = { x: moved.x / len, z: moved.z / len };
    let nose = visibleNose();
    record('W-drives-through-the-visible-front', {
      distanceM: Number(len.toFixed(2)),
      // 0 means W moved the tank exactly along its visible nose.
      movedDegVsVisibleNose: Number(headingDeltaDeg(nose.front, wDir).toFixed(2)),
      movedDegVsSimForward: Number(headingDeltaDeg(simForward(), wDir).toFixed(2)),
      cameraMovedDeg: cameraMovedDeg(camBear),
      cameraMovedM: Number(distance(camPos, cameraPosition()).toFixed(3)),
    });

    // C. S: the tank must travel through its visible rear.
    await placeAt(0);
    start = { ...sim.vehicle.state.position };
    await holdKey('KeyS', 6000);
    moved = { x: sim.vehicle.state.position.x - start.x, z: sim.vehicle.state.position.z - start.z };
    len = Math.hypot(moved.x, moved.z);
    const sDir = { x: moved.x / len, z: moved.z / len };
    nose = visibleNose();
    record('S-drives-through-the-visible-rear', {
      distanceM: Number(len.toFixed(2)),
      // 0 means S moved the tank exactly along its visible tail.
      movedDegVsVisibleRear: Number(headingDeltaDeg(nose.rear, sDir).toFixed(2)),
    });

    // D/E. A and D: the visible nose swings left/right and the camera does not move at all.
    for (const [code, label, expectedSign] of [
      ['KeyA', 'A-turns-nose-left', -1],
      ['KeyD', 'D-turns-nose-right', 1],
    ]) {
      for (const headingDeg of [0, 90, 180, 270]) {
        await placeAt(headingDeg);
        camPos = cameraPosition();
        camBear = cameraBearing();
        const noseBefore = visibleNose();
        const headingBefore = sim.vehicle.state.headingRad;

        await holdKey(code, 4000);

        const noseAfter = visibleNose();
        record(label, {
          headingDeg,
          // Positive is clockwise from above, i.e. to the player's right.
          hullHeadingDeltaDeg: headingMovedDeg(headingBefore),
          noseSwingDeg: Number(headingDeltaDeg(noseBefore.front, noseAfter.front).toFixed(2)),
          signCorrect: Math.sign(headingMovedDeg(headingBefore)) === expectedSign,
          // The assertion that matters most: steering the hull must not rotate the camera.
          cameraMovedDeg: cameraMovedDeg(camBear),
          cameraMovedM: Number(distance(camPos, cameraPosition()).toFixed(3)),
        });
      }
    }

    // F. Mouse look moves the camera and leaves the hull completely alone.
    await placeAt(0);
    camBear = cameraBearing();
    const headingBeforeLook = sim.vehicle.state.headingRad;
    await moveMouse(600, 0);
    record('mouse-orbits-camera-only', {
      cameraMovedDeg: cameraMovedDeg(camBear),
      // Looking around must never turn the hull.
      hullHeadingChangedDeg: headingMovedDeg(headingBeforeLook),
    });

    // G. Deliberately look away from the tank, then turn the hull: the camera must not budge at all.
    // This is the exact scenario the owner hit, and the one the removed 0.9/s recovery used to spoil.
    await moveMouse(900, 0);
    camBear = cameraBearing();
    camPos = cameraPosition();
    const headingBeforeTurn = sim.vehicle.state.headingRad;
    await holdKey('KeyD', 4000);
    record('hull-turns-under-a-stationary-camera', {
      cameraMovedDeg: cameraMovedDeg(camBear),
      cameraMovedM: Number(distance(camPos, cameraPosition()).toFixed(3)),
      hullHeadingDeltaDeg: headingMovedDeg(headingBeforeTurn),
    });

    // H. C recentres once behind the hull, then detaches and never follows again.
    for (const headingDeg of [0, 63, 90, 180, 270]) {
      await placeAt(headingDeg);
      await moveMouse(800, 0);
      const bearBeforeRecentre = cameraBearing();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));
      await sleep(200);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true }));
      await frames(3);

      const bearAfterRecentre = cameraBearing();
      const headingAtRecentre = sim.vehicle.state.headingRad;
      // 180 degrees from the nose means the camera is directly behind the tank.
      const behindNoseDeg = Math.abs(
        headingDeltaDeg(
          { x: Math.sin(headingAtRecentre), z: Math.cos(headingAtRecentre) },
          bearingDir(bearAfterRecentre),
        ),
      );
      const posAfterRecentre = cameraPosition();

      // Now confirm it is independent again, rather than having latched onto the hull.
      await holdKey('KeyA', 4000);
      record('C-recentres-once-then-detaches', {
        headingDeg,
        snapJumpDeg: Number(
          headingDeltaDeg(bearingDir(bearBeforeRecentre), bearingDir(bearAfterRecentre)).toFixed(2),
        ),
        cameraBehindNoseDeg: Number(behindNoseDeg.toFixed(2)),
        cameraMovedAfterRecentreDeg: cameraMovedDeg(bearAfterRecentre),
        cameraMovedAfterRecentreM: Number(distance(posAfterRecentre, cameraPosition()).toFixed(3)),
        hullTurnedAfterRecentreDeg: headingMovedDeg(headingAtRecentre),
      });
    }

    if (originalLock) {
      Object.defineProperty(Document.prototype, 'pointerLockElement', originalLock);
    }

    return { checks: report };
    // __PROBE_BODY__
  })();
})();