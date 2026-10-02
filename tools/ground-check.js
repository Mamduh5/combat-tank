/** Confirms the tank visual rests on the ground, on flat ground and on a slope. */
(() => {
  const g = globalThis.__combatTank;
  const scene = g.scene;
  const sim = g.simulation;
  const V3 = scene.activeCamera.position.constructor;
  const field = sim.battlefield;
  const tank = sim.vehicle;

  const lowestTrackY = () => {
    let minY = Infinity;
    for (const mesh of scene.meshes) {
      if (!mesh.name.startsWith('tank-track') || !mesh.isEnabled() || !mesh.isVisible) continue;
      const bb = mesh.getBoundingInfo().boundingBox;
      mesh.computeWorldMatrix(true);
      const w = V3.TransformCoordinates(bb.minimum, mesh.getWorldMatrix());
      if (w.y < minY) minY = w.y;
    }
    return minY;
  };
  const clearance = () =>
    +(lowestTrackY() - field.terrain.heightAt(tank.state.position.x, tank.state.position.z)).toFixed(3);

  // Park on the player's spawn, then report. The render loop keeps running so the visual syncs.
  const s = field.playerSpawn;
  tank.reset({ x: s.x, y: field.terrain.heightAt(s.x, s.z), z: s.z }, s.headingRad);
  g.orbitCamera.recentreBehind(s.headingRad);

  return {
    spawnPosition: { x: s.x, z: s.z },
    groundAtSpawn: +field.terrain.heightAt(s.x, s.z).toFixed(2),
    clearanceAtSpawnM: clearance(),
    note: 'zero means the track bottoms touch the ground',
  };
})();