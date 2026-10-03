/**
 * `npm run grounding` — measures how far the **rendered** tank floats above the ground on Marlowe Crossing.
 *
 * ## Why this tool exists
 *
 * The owner played V6 and reported one specific thing: the tank is grounded on flat terrain but most of it
 * floats on non-flat ground. Flat ground was already fixed by a contact-offset correction, so the remaining
 * defect is entirely about *shape* — the vehicle's pose and its rigid track against a curved surface.
 *
 * That cannot be judged from a screenshot, because a 20 cm gap is invisible in a 1280x760 frame taken from
 * 40 m. It is also not caught by the test suite, because nothing in the suite asked where the drawn track
 * is relative to the ground. So this measures it directly, as a signed number, at the surfaces the brief
 * names: flat, slope, rolling, crest, depression, road-to-field, and the railway.
 *
 * ## How to read the output
 *
 * For each pose, three numbers matter:
 *
 *  - `max daylight` — the largest gap anywhere under the track run. **This is the owner's bug.** A value
 *    above roughly 0.12 m reads as visible daylight from a normal camera.
 *  - `deepest bite` — how far the track has sunk into the ground anywhere. Reported because the obvious
 *    fix for daylight is to lower the vehicle, and this is what that fix would cost. A fix that trades a
 *    float for a burial has not fixed anything.
 *  - `floating` — the share of samples with a gap large enough to read as floating. This distinguishes
 *    "one end lifts on a crest", which a player forgives, from "most of the run is off the ground", which
 *    is what was reported.
 *
 * ## Usage
 *
 * ```
 * node tools/measure-grounding.mjs
 * node tools/measure-grounding.mjs --json     machine-readable, for the test suite
 * ```
 */
import { createServer } from 'vite';
import { rmSync } from 'node:fs';

async function loadMeasurement() {
  const cacheDir = `node_modules/.vite-grounding-${process.pid}`;
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
    // A throwaway cache directory per run, for the reason documented in `measure-routes.mjs`: a stale Vite
    // transform cache would report the previous map while claiming to describe the current one.
    cacheDir,
  });
  try {
    return await server.ssrLoadModule('/src/tools/headless/grounding-measurement.ts');
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

async function main() {
  const module = await loadMeasurement();
  const report = module.reportGrounding();

  if (process.argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        report.readings.map((r) => ({
          label: r.label,
          headingDeg: +r.headingDeg.toFixed(2),
          pitchDeg: +r.pitchDeg.toFixed(2),
          rollDeg: +r.rollDeg.toFixed(2),
          maxGapM: +r.maxGapM.toFixed(4),
          maxBiteM: +r.maxBiteM.toFixed(4),
          meanGapM: +r.meanGapM.toFixed(4),
          floatingFraction: +r.floatingFraction.toFixed(4),
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${report.text}\n`);
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
