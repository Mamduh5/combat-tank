/**
 * `npm run sim` - the headless batch battle runner.
 *
 * ## Why this file is JavaScript and the runner is not
 *
 * The runner itself is TypeScript in `src/tools/headless/`, because it is game code: it imports the
 * simulation, the battle and the AI, and it is covered by the same typecheck and tests as everything
 * else. This file only does the three things that genuinely need Node - parse `process.argv`, load
 * TypeScript, print to stdout - and none of that belongs in the game's source tree.
 *
 * The split is also what keeps the project honest. There is no second battle model hiding in a script:
 * `src/tools/headless/batch-runner.ts` runs the same `Simulation`, `Battle` and `EnemyController` the
 * browser does, and nothing in `src/` imports anything from `tools/`.
 *
 * TypeScript is loaded through Vite rather than compiled separately, so `npm run sim` needs no build
 * step and no extra dependency. Vite is already a dependency of the project.
 *
 * Usage: node tools/sim.mjs [options]   (or `npm run sim -- [options]`)
 */
import { createServer } from 'vite';

/** Ticks per second, used only to convert the friendlier `--seconds` option. */
const TICKS_PER_SECOND = 60;

/**
 * Parses the command line.
 *
 * Returns either a request to run, or a message to print instead. Failing loudly on a bad argument is
 * deliberate: a batch that silently ran with a default the caller did not intend would produce numbers
 * that look valid and describe the wrong experiment, which is worse than refusing to start.
 */
function parseArgs(argv, defaults, scenarios, isScenarioId, usage, maps) {
  const options = { ...defaults };
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        return { kind: 'usage' };
      case '--json':
        // A flag, not a mode that short-circuits parsing. Treating it as one meant `npm run sim -- --json
        // --battles 50` silently ran ten battles, which is precisely the "valid numbers describing the
        // wrong experiment" failure this parser exists to prevent.
        json = true;
        break;
      case '--battles':
        options.battles = readNumber(argv, ++i, '--battles');
        break;
      case '--seed':
        options.seedStart = readNumber(argv, ++i, '--seed');
        break;
      case '--ticks':
        options.maxTicks = readNumber(argv, ++i, '--ticks');
        break;
      case '--seconds':
        options.maxTicks = readNumber(argv, ++i, '--seconds') * TICKS_PER_SECOND;
        break;
      case '--map': {
        // The only map V6 ships. Named rather than defaulted, so a future second map is an
        // intentional addition and so a saved report says which world produced it.
        const name = argv[++i];
        if (name !== 'ashford-valley') {
          return {
            kind: 'error',
            message: `--map must be ashford-valley (got "${name ?? 'nothing'}"). ` +
              'Omit --map entirely to run the legacy V5 arena.',
          };
        }
        options.map = maps.ashfordValley;
        break;
      }
      case '--scenario': {
        const name = argv[++i];
        if (name === undefined || !isScenarioId(name)) {
          return {
            kind: 'error',
            message: `--scenario must be one of: ${scenarios.join(', ')}` +
              (name === undefined ? '' : ` (got "${name}")`),
          };
        }
        options.scenario = name;
        break;
      }
      default:
        return { kind: 'error', message: `Unknown option: ${arg}\n\n${usage}` };
    }
  }

  if (options.battles < 1) {
    return { kind: 'error', message: '--battles must be at least 1.' };
  }
  if (options.maxTicks < 1) {
    return { kind: 'error', message: '--ticks (or --seconds) must be at least 1.' };
  }

  return { kind: 'run', options, json };
}

/** Reads the value after a flag, or returns a clear error rather than `NaN` propagating into a run. */
function readNumber(argv, index, flag) {
  const raw = argv[index];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw new Error(`${flag} needs a number (got ${raw === undefined ? 'nothing' : `"${raw}"`}).`);
  }
  return value;
}

/**
 * The batch runner is loaded through Vite rather than imported statically.
 *
 * A static `import` of a `.ts` path is resolved by **Node**, before Vite ever runs, and Node cannot
 * execute TypeScript — it resolved `/src/...` against the filesystem root and threw
 * `ERR_MODULE_NOT_FOUND`. `ssrLoadModule` is Vite's own loader, so the path is resolved against the
 * project root and the TypeScript is transformed on the way in.
 *
 * The modules are loaded here rather than at the top of the file for the same reason: `--help` should
 * not pay for starting a Vite server.
 */
async function loadRunner() {
  const server = await createServer({
    server: {
      middlewareMode: true,
      // Nothing here is served or hot-reloaded; the server exists only to transform TypeScript. Leaving
      // the HMR websocket enabled opened a fixed port (24678), so a second `npm run sim` while another
      // was still shutting down failed with "Port 24678 is already in use" — a harness fault that looked
      // like a crash in the game code.
      hmr: false,
      ws: false,
    },
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const [runner, report, scenarios, maps] = await Promise.all([
      server.ssrLoadModule('/src/tools/headless/batch-runner.ts'),
      server.ssrLoadModule('/src/tools/headless/report.ts'),
      server.ssrLoadModule('/src/tools/headless/scenarios.ts'),
      server.ssrLoadModule('/src/core/world/maps/ashford-valley.ts'),
    ]);
    return { ...runner, ...report, ...scenarios, ...maps };
  } finally {
    // Closed as soon as the modules are loaded: the code is fully evaluated by then, and a lingering
    // server would keep the process alive after the results were printed.
    await server.close();
  }
}

async function main() {
  const loaded = await loadRunner();
  const { runBatch, formatJson, formatSummary, formatUsage, DEFAULT_BATCH_OPTIONS, SCENARIOS, isScenarioId } =
    loaded;

  let parsed;
  try {
    parsed = parseArgs(
      process.argv.slice(2),
      DEFAULT_BATCH_OPTIONS,
      SCENARIOS,
      isScenarioId,
      formatUsage(),
      { ashfordValley: loaded.ASHFORD_VALLEY },
    );
  } catch (error) {
    process.stdout.write(`${error.message}\n\n${formatUsage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.kind === 'usage') {
    process.stdout.write(`${formatUsage()}\n`);
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = 2;
    return;
  }

  const report = runBatch(parsed.options);
  process.stdout.write(parsed.json ? `${formatJson(report)}\n` : `${formatSummary(report)}\n`);
}

await main();

