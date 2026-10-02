/**
 * Parks the camera at a named place on Marlowe Crossing, for a screenshot.
 *
 * ## One script, many viewpoints
 *
 * The viewpoint is read from `location.hash` rather than baked into the file, so a tour is
 * `--url=http://localhost:4173/#town` with this one script, instead of a dozen near-identical copies.
 * Those copies had already drifted apart — the same seven viewpoints existed in seven files, and editing
 * one left six lying about the map.
 *
 * ## Why the render loop is stopped
 *
 * The orbit rig re-derives the camera transform from the player's tank every frame, so a script that merely
 * calls `setTarget` has its work overwritten before the next frame is presented — and the screenshot is
 * taken after that frame. The first version of this script produced a picture of a hillside for exactly that
 * reason, and it looked like a terrain bug rather than a camera bug.
 *
 * Stopping the loop, positioning the camera, and rendering one frame explicitly is the only way to hold a
 * viewpoint. It also freezes the simulation, which is what a screenshot wants anyway.
 */
(() => {
  const g = globalThis.__combatTank;

  // Report rather than throw when the game has not finished booting. A thrown TypeError here reads as
  // "the renderer is broken" to anything downstream, when it actually means the page loaded faster than the
  // simulation — so the distinction is made explicitly and cheaply.
  if (g === undefined || g === null || g.scene === undefined) {
    return { error: 'the game has not finished booting', combatTank: typeof g };
  }

  const scene = g.scene;
  const camera = scene.activeCamera;
  const sim = g.simulation;
  const field = sim.battlefield;
  const engine = scene.getEngine();
  const Vector3Ctor = camera.position.constructor;

  /**
   * Every viewpoint, and the question each one answers.
   *
   * Heights are chosen for a **gameplay** camera, not a survey one. The brief asks that the map read as
   * coherent from normal camera height, so most views sit between 6 and 20 m — roughly where the orbit
   * camera actually puts the player — rather than looking down from 200 m. Two high views are kept for
   * layout questions, and are labelled as such.
   */
  const PLACES = {
    // --- Layout, from high up ---
    overview: {
      x: -330, y: 250, z: 330, look: { x: 20, y: 0, z: -40 },
      note: 'The whole battlefield. Is the railway readable as a landmark from above?',
    },
    layout: {
      x: 40, y: 420, z: 420, look: { x: 0, y: 0, z: -30 },
      note: 'Straight down. Town side / railway / fields / elevated side.',
    },

    // --- The railway ---
    railway: {
      x: -120, y: 14, z: -92, look: { x: 90, y: 3, z: -30 },
      note: 'Along the graded line. Does it read as a railway, and as a level one?',
    },
    crossing: {
      x: 12, y: 9, z: -6, look: { x: 46, y: 3, z: -34 },
      note: 'The level crossing from the road. Deck, gates, and the road running over the rails.',
    },
    station: {
      x: 78, y: 12, z: -66, look: { x: 46, y: 5, z: -36 },
      note: 'The station and its platform. Does the railway read as a place?',
    },

    // --- The town ---
    town: {
      x: 4, y: 16, z: -128, look: { x: 52, y: 4, z: -70 },
      note: 'Into Marlowe village. Hard cover, short sight lines, buildings that look like buildings.',
    },

    // --- The fields and the roads ---
    fields: {
      x: -140, y: 12, z: 190, look: { x: 20, y: 1, z: 60 },
      note: 'Across the open fields. Is there room to manoeuvre and take a long shot?',
    },
    road: {
      x: 33, y: 10, z: 90, look: { x: 33, y: 3, z: -20 },
      note: 'Down the town road to the crossing. Does the route read as a route?',
    },

    // --- The elevated flank ---
    cairn: {
      x: 60, y: 26, z: -70, look: { x: 170, y: 12, z: -160 },
      note: 'Up onto Cairn Height. Does it overlook the map without being a wall?',
    },

    // --- Spawns ---
    playerspawn: {
      x: -125, y: 14, z: 150, look: { x: -110, y: 2, z: 70 },
      park: { x: -125, z: 80, heading: 2.2 },
      note: "The player's opening view. Does it frame the tank and say which way the map goes?",
    },
    enemyspawn: {
      x: 65, y: 12, z: -105, look: { x: 60, y: 2, z: -50 },
      park: { x: 65, z: -55, heading: -0.85, enemy: true },
      note: "The opponent's opening position. Open ground with routes available, or a trap?",
    },

    // --- The tank in the scenery ---
    tankAtRailway: {
      x: -46, y: 8, z: -6, look: { x: -26, y: 2, z: -36 },
      park: { x: -30, z: -30, heading: 1.4 },
      note: 'The tank standing on the railway. Grounded, and the rails at the right scale.',
    },
    tankAtStation: {
      x: 40, y: 9, z: -20, look: { x: 60, y: 4, z: -42 },
      park: { x: 58, z: -34, heading: 2.9 },
      note: 'The tank beside the station. Does the building read as a building at ground level?',
    },
    tankInVillage: {
      x: 26, y: 9, z: -54, look: { x: 48, y: 4, z: -78 },
      park: { x: 44, z: -62, heading: 1.9 },
      note: 'The tank in the village street. Cover on both sides, short sight lines.',
    },
    tankOnHill: {
      x: 130, y: 22, z: -104, look: { x: 165, y: 8, z: -150 },
      park: { x: 160, z: -142, heading: 2.6 },
      note: 'The tank on the elevated flank. Grounded on a real hill, not floating.',
    },

    // --- Combat through cover ---
    cover: {
      x: -4, y: 11, z: -34, look: { x: 34, y: 4, z: -60 },
      park: { x: 30, z: -46, heading: 0.4, enemy: true },
      note: 'Looking down the town road from the crossing. Cover on the flanks, the village beyond.',
    },
  };

  const name = (location.hash || '#overview').slice(1);
  const place = PLACES[name] ?? PLACES.overview;
  const known = Object.prototype.hasOwnProperty.call(PLACES, name);

  // Optionally move a tank first, so a view can show it in context rather than wherever it happened to
  // stop. Reset rather than teleport: that puts it on the terrain and lets it settle onto the ground.
  if (place.park) {
    const tank = place.park.enemy ? sim.target : sim.vehicle;
    tank.reset(
      { x: place.park.x, y: field.terrain.heightAt(place.park.x, place.park.z), z: place.park.z },
      place.park.heading,
    );
    // Settle the suspension so the hull rests on the ground rather than mid-drop.
    for (let i = 0; i < 30; i += 1) {
      sim.advance(1 / 60);
    }
  }

  // Stop the loop first, so nothing overwrites the camera below.
  if (engine && typeof engine.stopRenderLoop === 'function') {
    engine.stopRenderLoop();
  }

  // Distance haze is right when playing and wrong when surveying: exponential fog is right when you are
  // looking at a tank and wrong when you are trying to see a 500 m battlefield, where it eats the map.
  if (scene.fogMode !== 0) {
    scene.fogDensity = 0.0002;
  }

  camera.position.set(place.x, place.y, place.z);
  // `setTarget` needs a real Vector3 — it calls `subtract` on the argument, so a plain object throws a
  // TypeError that reads like a Babylon bug rather than a bad call.
  camera.setTarget(new Vector3Ctor(place.look.x, place.look.y, place.look.z));

  if (engine && typeof engine.beginFrame === 'function') {
    engine.beginFrame();
  }
  scene.render();
  if (engine && typeof engine.endFrame === 'function') {
    engine.endFrame();
  }

  // How far the tank's hull sits from the ground beneath it. A tank hovering or tilted wrongly is easy
  // to miss in a screenshot's composition and obvious in this number, which is why it is reported rather
  // than assumed.
  const hull = sim.vehicle.state.position;
  const groundY = field.terrain.heightAt(hull.x, hull.z);

  return {
    place: name,
    known,
    note: place.note,
    groundUnderCamera: +field.terrain.heightAt(place.x, place.z).toFixed(2),
    cameraAltitude: place.y,
    tankGapM: +(hull.y - groundY).toFixed(3),
    loopStopped: true,
  };
})();
