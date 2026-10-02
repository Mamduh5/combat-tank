/**
 * Measures how far apart the two tanks start, and how much of the map the player can see from the spawn.
 *
 * ## Why this is measured rather than designed on paper
 *
 * The owner could not find the enemy. Two causes are tangled in that report: the controls made the game
 * unplayable, and the opening may *independently* place the opponent too far away or out of sight. This
 * script separates them by asking a purely geometric question, with the controls removed entirely:
 *
 * > standing at the player spawn, at what range and bearing does the opponent become visible, and what is
 * > the shortest drive that opens line of sight to it?
 *
 * It answers that for the authored spawn pair and then surveys candidate opponent positions, using the real
 * `Battlefield.hasLineOfSight` so a spot that looks clear on paper but sits behind a cottage or the central
 * swell is rejected rather than assumed.
 *
 * ## Structure
 *
 * A thin `.mjs` launcher plus a TypeScript module under `src/tools/headless/`, exactly like `tools/sim.mjs`
 * and `batch-runner.ts`. The measuring logic is TypeScript because it imports the game's own battlefield
 * and so belongs under the same typecheck and module boundary rules as everything else. This file only does
 * the things that genuinely need Node: load TypeScript, and print.
 *
 * Usage: `node tools/measure-contact.mjs`
 */
import { createServer } from 'vite';


/**
 * Loads a TypeScript module by its project-root path.
 *
 * `ssrLoadModule` is Vite's own loader, so paths resolve against the project root and the TypeScript is
 * transformed on the way in. One shared server for all three modules rather than one per call, because
 * starting a server is the expensive part and these all need the same transform pipeline.
 */
async function withModules(paths, use) {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const loaded = await Promise.all(paths.map((p) => server.ssrLoadModule(p)));
    return use(...loaded);
  } finally {
    // Closed as soon as the modules are loaded: they are fully evaluated by then, and a lingering server
    // would keep the process alive after the report has printed.
    await server.close();
  }
}

const loadContactMeasurement = () =>
  withModules(['/src/tools/headless/contact-measurement.ts'], (m) => m);
const loadBatchRunner = () => withModules(['/src/tools/headless/batch-runner.ts'], (m) => m);
const loadMap = () => withModules(['/src/core/world/maps/marlowe-crossing.ts'], (m) => m);

const { reportContactOpening, reportOpeningContact, canSeePair, bearingDeltaDeg } =
  await loadContactMeasurement();
process.stdout.write(reportContactOpening());
process.stdout.write(reportOpeningContact());

// A/B check of the spawn change, so the correction is justified by measurement rather than by argument.
//
// The correction pass moved the opponent from (65, -55) to (-10, -10) so the player can see it. The side
// effect to rule out is that the opponent can no longer *win* against a player who parks: at 146 m it sits
// outside its own 130 m firing band, and if its closing or flanking search fails it may simply hold.
//
// Both spawn pairs are run through the real opponent controller, on the real map, against the same seeds.
// If the old pair wins and the new one does not, the move has traded findability for a stalled fight and has
// to be reconsidered - which is exactly what this measurement exists to catch.
const { runBattle } = await loadBatchRunner();
const { MARLOWE_CROSSING } = await loadMap();

/**
 * Candidate opponent spawns, with the player's spawn held fixed.
 *
 * The previous pair is included as the baseline the V6 build actually shipped: if the new spawn cannot beat
 * it on the ADR-0016 case, the findability gain is not worth the cost and the move has to be reconsidered.
 *
 * The bearing heading for each candidate is computed to face the player, so every candidate opens on the
 * opponent's strongest frontal armour rather than on its flank.
 */
const SPAWN_PAIRS = (() => {
  const player = MARLOWE_CROSSING.playerSpawn;
  const facing = (x, z) => Math.atan2(player.x - x, player.z - z);
  const candidates = [
    { label: 'previous  (65, -55)', x: 65, z: -55 },
    { label: 'swell top  (-10, -10)', x: -10, z: -10 },
    { label: 'swell foot (-40, 10)', x: -40, z: 10 },
    { label: 'north road (10, -60)', x: 10, z: -60 },
    { label: 'east field (-30, -80)', x: -30, z: -80 },
    { label: 'village (40, -60)', x: 40, z: -60 },
    { label: 'approach (-70, -30)', x: -70, z: -30 },
    { label: 'west field (-30, -30)', x: -30, z: -30 },
    { label: 'line side (-50, -30)', x: -50, z: -30 },
    { label: 'swell west (-30, -10)', x: -30, z: -10 },
  ];
  return candidates.map((c) => ({ ...c, heading: facing(c.x, c.z) }));
})();

/** Five minutes of simulated time: the same budget the AI harness tests use. */
const COMPARISON_TICKS = 18000;

function compareSpawns() {
  const out = ['', '=== can the opponent still defeat a parked player? ==='];
  out.push('(parked player presenting frontal armour, 300 s budget - the ADR-0016 case)');
  out.push('');

  out.push('  spawn                 range  offset  seen  dmg/seeds  pen  closest  outcome');

  for (const pair of SPAWN_PAIRS) {
    // A fresh map object per seed, with only the enemy spawn overridden. Spreading the authored map and
    // replacing one field keeps everything else - terrain, structures, concealment - exactly as shipped, so
    // the only variable between the runs is the spawn under test.
    const damage = [];
    const penetrations = [];
    const closest = [];
    const outcomes = [];
    for (const seed of [1, 2, 3]) {
      const battle = runBattle(
        seed,
        'parked',
        COMPARISON_TICKS,
        { ...MARLOWE_CROSSING, enemySpawn: { x: pair.x, z: pair.z, headingRad: pair.heading } },
      );
      damage.push(battle.damageDealt);
      penetrations.push(battle.penetrations);
      closest.push(battle.maxRangeM);
      outcomes.push(battle.outcome === 'victory' ? 'V' : battle.outcome === 'defeat' ? 'D' : 't');
    }
    const range = Math.hypot(pair.x - MARLOWE_CROSSING.playerSpawn.x, pair.z - MARLOWE_CROSSING.playerSpawn.z);
    // Findability, measured with the same helpers as the survey above so the two columns agree.
    const offsetDeg = Math.abs(
      bearingDeltaDeg(
        MARLOWE_CROSSING.playerSpawn.headingRad,
        Math.atan2(pair.x - MARLOWE_CROSSING.playerSpawn.x, pair.z - MARLOWE_CROSSING.playerSpawn.z),
      ),
    );
    const seen = canSeePair(pair.x, pair.z) ? 'yes' : ' no';
    out.push(
      `  ${pair.label.padEnd(20)} ${range.toFixed(0).padStart(4)}m` +
        `  ${offsetDeg.toFixed(0).padStart(4)}d` +
        `  ${seen.padStart(4)} ` +
        `  ${damage.join('/').padStart(9)}` +
        `  ${penetrations.reduce((a, b) => a + b, 0).toString().padStart(3)}` +
        `  ${Math.min(...closest).toFixed(0).padStart(6)}m` +
        `  ${outcomes.join('')}`,
    );
  }
  return out.join('\n');
}

process.stdout.write(compareSpawns());
