globalThis.__tourAt = 'barn';
/**
 * Parks the camera at a named place on the battlefield, for a screenshot.
 *
 * The V6 brief requires looking at the map rather than reading the code, and *where the camera stands*
 * decides what a screenshot proves. One view of the player's own tank cannot show whether the low road
 * exists, whether the ridge gives hull-down positions, or whether the concealment is where the data
 * says it is. So the viewpoint is chosen deliberately, per question.
 *
 * ## Why the render loop is stopped
 *
 * The orbit rig re-derives the camera transform from the player's tank on every frame, so a script that
 * merely calls ``setTarget`` has its work overwritten before the next frame is presented - and the
 * screenshot is taken after that frame. The first version of this script produced a picture of a
 * hillside for exactly that reason, and it looked like a terrain bug rather than a camera bug.
 *
 * Stopping the loop, positioning the camera, and rendering one frame explicitly is therefore the only
 * way to hold a viewpoint. It also freezes the simulation, which is what a screenshot wants anyway.
 *
 * The place is read from `globalThis.__tourAt`, which the ``tools/tour-<name>.js`` wrappers set.
 */
(() => {
  const g = globalThis.__combatTank;
  const scene = g.scene;
  const camera = scene.activeCamera;
  const field = g.simulation.battlefield;
  const engine = scene.getEngine();

  const PLACES = {
    // The whole valley from high above the north-west. The question: can a player read this map at all?
    overview: { x: -240, y: 165, z: 210, look: { x: 30, y: 0, z: -10 } },
    // Kestrel Ridge looking east at the outpost: is the contested high ground worth having?
    ridge: { x: -150, y: 72, z: 40, look: { x: 120, y: 0, z: -50 } },
    // The outpost from the open ground south-west: do the buildings read as buildings?
    outpost: { x: 40, y: 46, z: 24, look: { x: 132, y: 2, z: -60 } },
    // The red barn, the map's landmark: recognisable as an orientation cue?
    barn: { x: 66, y: 34, z: 68, look: { x: 124, y: 2, z: 30 } },
    // Ashford Wood: does the heavy concealment look like a wood a tank would hide in?
    wood: { x: -16, y: 40, z: 46, look: { x: -108, y: 2, z: 26 } },
    // Millbrook Cut from the north: is the low road actually below the valley's sight line?
    cut: { x: -4, y: 40, z: 122, look: { x: 52, y: -2, z: 28 } },
    // Across The Cut at low altitude: is the open lane as exposed as the data claims?
    thecut: { x: -70, y: 24, z: 2, look: { x: 90, y: 0, z: -12 } },
  };

  const name = globalThis.__tourAt ?? 'overview';
  const place = PLACES[name] ?? PLACES.overview;

  // Stop the loop first, so nothing overwrites the camera below.
  if (engine && typeof engine.stopRenderLoop === 'function') {
    engine.stopRenderLoop();
  }

  // Distance haze is right when playing and wrong when surveying: exponential fog is right when you are
  // looking at a tank and wrong when you are trying to see a 400 m battlefield, where it eats the map.
  if (scene.fogMode !== 0) {
    scene.fogDensity = 0.0002;
  }

  camera.position.set(place.x, place.y, place.z);
  // ``setTarget`` needs a real Vector3 - it calls ``subtract`` on the argument, so a plain object throws
  // a TypeError that reads like a Babylon bug rather than a bad call. Babylon is bundled rather than
  // global, so the constructor is borrowed from an object the scene already owns.
  const Vector3Ctor = camera.position.constructor;
  camera.setTarget(new Vector3Ctor(place.look.x, place.look.y, place.look.z));

  if (engine && typeof engine.beginFrame === 'function') {
    engine.beginFrame();
  }
  scene.render();
  if (engine && typeof engine.endFrame === 'function') {
    engine.endFrame();
  }

  return {
    place: name,
    known: Object.prototype.hasOwnProperty.call(PLACES, name),
    groundUnderCamera: +field.terrain.heightAt(place.x, place.z).toFixed(2),
    cameraAltitude: place.y,
    loopStopped: true,
  };
})();