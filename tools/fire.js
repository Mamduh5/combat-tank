(async () => {
  const g = globalThis.__combatTank;
  const sim = g.simulation;
  const t = sim.target.state.position;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const aim = { x: t.x, y: t.y + 1.0, z: t.z - 2.6 };
  const dist = () => Math.hypot(t.x - sim.vehicle.state.position.x, t.z - sim.vehicle.state.position.z);

  // Hold position and let the turret finish slewing onto the target's rear.
  g.setInputFrame({ throttle: 0, steer: 0, aim, fire: false });
  for (let i = 0; i < 60; i += 1) await sleep(50);

  const before = { hp: sim.target.damage.hitPoints, turret: +sim.telemetry.turretWorldHeadingRad.toFixed(2), dist: +dist().toFixed(1) };

  // Fire repeatedly until something resolves, re-aiming each time because the turret keeps moving.
  let last = null;
  for (let shot = 0; shot < 12 && sim.combat.length === 0; shot += 1) {
    g.setInputFrame({ throttle: 0, steer: 0, aim, fire: true });
    await sleep(120);
    g.setInputFrame({ throttle: 0, steer: 0, aim, fire: false });
    for (let i = 0; i < 40; i += 1) {
      await sleep(40);
      if (sim.combat.length > 0) break;
    }
  }
  last = sim.combat[sim.combat.length - 1];

  return {
    before,
    shotsFired: sim.telemetry.shotsFired,
    hp: sim.target.damage.hitPoints,
    outcome: last ? last.kind : 'none',
  };
})()