(() => {
  const g = globalThis.__combatTank;
  const scene = g.scene;
  const d = g.simulation.vehicle.definition;
  const info = (name) => {
    const m = scene.meshes.find((x) => x.name === name);
    if (!m) return null;
    const bb = m.getBoundingInfo().boundingBox;
    const ext = bb.maximum.subtract(bb.minimum);
    return { size: [Number(ext.x.toFixed(2)), Number(ext.y.toFixed(2)), Number(ext.z.toFixed(2))], min: bb.minimum.asArray().map((n) => Number(n.toFixed(2))) };
  };
  return { dims: d.dimensions, barrelLengthM: d.mainGun.barrelLengthM, ringHeightM: d.turret.ringHeightM, hull: info('tank-hull'), turret: info('tank-turret'), barrel: info('tank-barrel'), fenderL: info('tank-fender--1'), wheelL: info('tank-wheel---1-0'), trackL: info('tank-track--1') };
})()