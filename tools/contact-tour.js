/**
 * Walks the player through the three contact states and reports each transition, for a screenshot.
 *
 * The V6 brief asks for detecting, losing and reacquiring an opponent, and for that to be readable
 * while playing. "Readable" is a presentation claim, so it needs a picture and not just a state.
 *
 * Each stage parks the player's tank at a known place, waits for the simulation to notice, and records
 * what the HUD would be showing. The last state is left on screen for the screenshot.
 */
(async () => {
  const g = globalThis.__combatTank;
  const sim = g.simulation;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const place = (x, z, heading) => sim.vehicle.reset({ x, y: 0, z }, heading);
  const record = (when) => {
    const c = sim.playerContact.contact;
    log.push({
      when,
      state: c.state,
      concealment: sim.playerConcealment.strongestZoneId,
      rangeM: +Math.hypot(
        sim.target.state.position.x - sim.vehicle.state.position.x,
        sim.target.state.position.z - sim.vehicle.state.position.z,
      ).toFixed(1),
    });
  };
  // Enough ticks for the contact tracker to notice, at 60 Hz.
  const settle = async () => {
    for (let i = 0; i < 30; i += 1) {
      await sleep(50);
    }
  };

  const enemy = sim.target;
  // Stage 1 - detected. Open ground in the middle of the valley, enemy close and in the open.
  place(-20, 0, 0);
  enemy.reset({ x: -20, y: 0, z: -60 }, Math.PI);
  await settle();
  record('1. open ground, enemy 60 m ahead');

  // Stage 2 - lost. Put the enemy behind the outpost main building, out of sight from the valley floor.
  place(10, -20, 0);
  enemy.reset({ x: 134, y: 0, z: -62 }, 0);
  await settle();
  record('2. enemy moved behind the outpost');

  // Stage 3 - reacquired. Bring the enemy back into the open, closer.
  place(10, -20, 0);
  enemy.reset({ x: 10, y: 0, z: -80 }, 0);
  await settle();
  record('3. enemy back in the open, 60 m ahead');

  return { log, finalState: sim.playerContact.contact.state };
})();