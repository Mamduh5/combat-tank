/**
 * Measures the **rendered** tank's ground contact, through Babylon's own world matrices.
 *
 * ## Why this exists alongside the headless tool
 *
 * `grounding-measurement.ts` restates the renderer's transform so it can run without a browser. A
 * restatement is exactly the kind of thing that can be subtly wrong and still produce confident numbers,
 * so this probe measures the *actual* scene graph instead: it reads the real track mesh vertices, puts
 * them through Babylon's real world matrix, and compares the result with the real terrain.
 *
 * If these two disagree, the headless tool is lying and the fix gets built on a false measurement. If
 * they agree, the headless number is trustworthy enough to gate a test on.
 *
 * Usage: `node tools/shot.mjs shots/grounding --script=tools/grounding-probe.js`
 */
(() => {
  const g = globalThis.__combatTank;
  if (!g || !g.scene) {
    return { error: 'the game has not finished booting' };
  }

  const scene = g.scene;
  const sim = g.simulation;
  const terrain = sim.battlefield.terrain;
  const tank = sim.vehicle;
  const V3 = scene.activeCamera.position.constructor;

  /**
   * Reads the real world-space position of the track's lowest point, station by station.
   *
   * Built from the mesh's own vertices rather than from a bounding box, because a bounding box is axis
   * aligned in *local* space and would report the corner of the track rather than the point of it that is
   * nearest the ground once the hull is pitched and rolled.
   */
  const trackStations = () => {
    const out = [];
    for (const mesh of scene.meshes) {
      if (!mesh.name.startsWith('tank-track-') || !mesh.isEnabled() || !mesh.isVisible) continue;
      mesh.computeWorldMatrix(true);
      const matrix = mesh.getWorldMatrix();
      const positions = mesh.getVerticesData('position');
      if (!positions) continue;

      // Group this track's vertices by their local Z into seven bands, and take the lowest world Y in
      // each. Local Z is the track's long axis, so the bands are stations along the run.
      const bands = new Array(7).fill(null).map(() => ({ minY: Infinity, x: 0, z: 0 }));
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        minZ = Math.min(minZ, positions[i + 2]);
        maxZ = Math.max(maxZ, positions[i + 2]);
      }
      const spanZ = Math.max(1e-6, maxZ - minZ);

      const world = new V3();
      for (let i = 0; i < positions.length; i += 3) {
        const band = Math.min(6, Math.floor(((positions[i + 2] - minZ) / spanZ) * 7));
        world.set(positions[i], positions[i + 1], positions[i + 2]);
        const transformed = V3.TransformCoordinates(world, matrix);
        if (transformed.y < bands[band].minY) {
          bands[band].minY = transformed.y;
          bands[band].x = transformed.x;
          bands[band].z = transformed.z;
        }
      }
      out.push({ name: mesh.name, bands });
    }
    return out;
  };

  /** The lowest world Y of the hull, so a track fix that buries the body would show here. */
  const hullLowestY = () => {
    let minY = Infinity;
    for (const mesh of scene.meshes) {
      if (!mesh.name.startsWith('tank-hull') && !mesh.name.startsWith('tank-glacis')) continue;
      if (!mesh.isEnabled() || !mesh.isVisible) continue;
      mesh.computeWorldMatrix(true);
      const bb = mesh.getBoundingInfo().boundingBox;
      const w = V3.TransformCoordinates(bb.minimum, mesh.getWorldMatrix());
      minY = Math.min(minY, w.y);
    }
    return minY;
  };


  const measure = (label, x, z, headingRad) => {
    tank.reset({ x, y: terrain.heightAt(x, z), z }, headingRad);
    // Let the suspension and the smoothed body orientation settle, exactly as `tour.js` does.
    for (let i = 0; i < 30; i += 1) sim.advance(1 / 60);
    // One explicit apply so `tankVisual` has copied the settled state onto the scene graph.
    g.tankVisual.apply(tank.state, tank.turretState);

    const gaps = [];
    for (const track of trackStations()) {
      for (const band of track.bands) {
        if (band.minY === Infinity) continue;
        gaps.push({
          name: track.name,
          x: band.x,
          z: band.z,
          gapM: band.minY - terrain.heightAt(band.x, band.z),
          // The heightfield is not always the surface the player sees: the road, the ballast and the
          // sleepers are separate meshes laid over it. So the same point is also measured against
          // whatever is actually drawn, and the difference between the two is reported.
          visibleGapM: band.minY - visibleSurfaceY(band.x, band.z),
        });
      }
    }
    const state = tank.state;
    const hullY = hullLowestY();
    let maxGap = -Infinity;
    let maxBite = 0;
    let sum = 0;
    let visMax = -Infinity;
    let visMin = Infinity;
    for (const gap of gaps) {
      maxGap = Math.max(maxGap, gap.gapM);
      maxBite = Math.max(maxBite, -gap.gapM);
      visMax = Math.max(visMax, gap.visibleGapM);
      visMin = Math.min(visMin, gap.visibleGapM);
      sum += gap.gapM;
    }
    return {
      label,
      pitchDeg: +((state.bodyPitchRad * 180) / Math.PI).toFixed(2),
      rollDeg: +((state.bodyRollRad * 180) / Math.PI).toFixed(2),
      maxGapM: +maxGap.toFixed(3),
      maxBiteM: +maxBite.toFixed(3),
      meanGapM: +(sum / gaps.length).toFixed(3),
      // Measured against the drawn surface, which is the only version of this the player can see.
      visibleMaxGapM: +visMax.toFixed(3),
      visibleMinGapM: +visMin.toFixed(3),
      hullFloorAboveGroundM: +(hullY - terrain.heightAt(state.position.x, state.position.z)).toFixed(3),
    };
  };

  /**
   * The highest drawn surface at a point, measured against the **rendered** terrain triangle mesh.
   *
   * This is the check that keeps the measurement honest. The analytic heightfield is not always what the
   * player sees: it is a continuous function, while what is drawn is a 200-cell triangulated mesh laid
   * over the road ribbon, the railway ballast and the sleepers. On concave ground the drawn surface sits
   * slightly *above* the analytic height, and anything laid on it — a road, a rail bed — is a separate
   * mesh again. A vehicle parked on the road is resting on one of those, not on the sampled heightfield.
   *
   * `physics.groundHeightAt` is used because it ray-casts the same trimesh the renderer draws
   * (`terrain-grid.ts` builds both from one vertex set precisely so they cannot disagree), so this measures
   * the real surface rather than a reconstruction of it. It is the one honest answer to "what is under
   * this point on screen".
   */
  const visibleSurfaceY = (x, z) => {
    const hit = g.physics.groundHeightAt(x, z);
    const analytic = terrain.heightAt(x, z);
    // The analytic height is the floor: the drawn mesh can only ever sit at or above it by a little, and
    // a ray that somehow returns below it is a miss rather than a measurement.
    return hit === null ? analytic : Math.max(analytic, hit.point.y);
  };

  const poses = [
    ['flat: railway formation', -60, -30, 0],
    ['slope: central swell flank', -10, 30, Math.PI],
    ['rolling: southern fields', 40, 120, 0.6],
    ['crest: central swell', -10, -5, 1.5708],
    ['depression: field hollow', 150, 40, 2.2],
    ['road to field', 46, -34, 0],
    ['railway crossing', 20, -30, 0],
    ['embankment, across the line', -60, -30, 1.5708],
  ];

  return {
    vehicleContactOffsetM: g.tankVisual.debugContactOffsetM(),
    groundClearanceM: tank.definition.dimensions.groundClearanceM,
    readings: poses.map(([label, x, z, h]) => measure(label, x, z, h)),
  };
})();
