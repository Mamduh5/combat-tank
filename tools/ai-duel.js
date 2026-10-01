/**
 * Runs the built game forward with no player input and reports what the V5 opponent actually did.
 *
 * Exists because the automated gates can all pass while the fight is invisible: the opponent can be
 * firing, missing, repositioning and never touching the player, and nothing in the test output says so.
 * The numbers here are the ones a screenshot cannot show - how many shells it took, how many arrived,
 * and what the player did to it in return.
 */
(async () => {
  const g = globalThis.__combatTank;
  const sim = g.simulation;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Let the briefing and the opening engagement run with the player parked, which is the case the
  // opponent's armour awareness is supposed to handle.
  const samples = [];
  const startEnemyHp = sim.target.damage.hitPoints;
  const startPlayerHp = sim.vehicle.damage.hitPoints;

  for (let i = 0; i < 100; i += 1) {
    g.setInputFrame({ throttle: 0, steer: 0, aim: null, fire: false });
    await sleep(500);
    if (i % 20 === 19) {
      const d = sim.enemyController.diagnostics;
      samples.push({
        atSeconds: (i + 1) * 0.5,
        intent: d.intent,
        targetRegion: d.targetRegion,
        rangeM: +d.rangeM.toFixed(1),
        predictedMarginMm: Number.isFinite(d.predictedMarginMm) ? Math.round(d.predictedMarginMm) : null,
        shotsFired: sim.target.telemetry.shotsFired,
        shotsObserved: d.shotsObserved,
        penetrations: d.penetrations,
        playerHitPoints: sim.vehicle.damage.hitPoints,
      });
    }
  }

  return {
    samples,
    summary: {
      enemyShellsFired: sim.target.telemetry.shotsFired,
      shotsObservedByOpponent: sim.enemyController.diagnostics.shotsObserved,
      penetrations: sim.enemyController.diagnostics.penetrations,
      playerHitPoints: sim.vehicle.damage.hitPoints,
      playerDamageTaken: startPlayerHp - sim.vehicle.damage.hitPoints,
      enemyDamageTaken: startEnemyHp - sim.target.damage.hitPoints,
      enemyPosition: {
        x: +sim.target.state.position.x.toFixed(2),
        z: +sim.target.state.position.z.toFixed(2),
      },
    },
  };
})();
