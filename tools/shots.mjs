/**
 * Captures the V6 battlefield's representative views, end to end.
 *
 * ## Why one script rather than a shell pipeline
 *
 * The screenshot step needs three things alive at once: a production build, a static server on it, and a
 * headless browser pointed at it. Running those by hand from a shell means waiting for a port that may not
 * come up, and a server that dies silently produces an empty picture rather than an error — which is
 * exactly the failure this harness exists to prevent (the V3R pass once "verified" a screenshot of
 * nothing at all).
 *
 * So this owns all three: it serves, it shoots, and it writes a machine-readable index so a missing view
 * is a missing file rather than a missing thought.
 *
 * ## What a screenshot can and cannot prove
 *
 * It proves the map *looks* coherent — that the railway reads as a railway, that the village reads as a
 * village, that the tank is the right size against them. It cannot prove the tank can drive between any
 * two of these places, that the sight lines match the simulation, or that the gradients are kind to the
 * vehicle. Those are `tools/measure-routes.mjs` and the test suite; this script deliberately reports the
 * tank's ground gap at each view so a floating or buried hull is caught in the same pass.
 *
 * Usage: `node tools/shots.mjs [outDir] [--only=name,name]`
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

/**
 * Ports to try, in order.
 *
 * Not a single fixed port. This machine reserves some loopback ports: a preview server started on 4190
 * binds successfully, prints its "Local:" banner, and is then unreachable on every address family — while
 * 4321 works perfectly. The symptom is a server that claims to be up and cannot be reached, which is
 * indistinguishable from a broken build unless the port itself is suspected.
 *
 * So the tool starts a server, checks it is actually answering, and moves on if not. Cheap, and it makes
 * the harness work on whatever machine it lands on.
 */
const CANDIDATE_PORTS = [4321, 4400, 4500, 4600, 4700, 4800, 4900];
const FIRST_PORT = Number(process.env.SHOTS_PORT ?? CANDIDATE_PORTS[0]);
const CDP_PORT = 9333;
const OUT =
  // `slice(2)`, not the whole argv: argv[0] is the node executable and argv[1] this script, so scanning
  // from zero picks `node.exe` as the output directory and fails with a baffling mkdir EEXIST.
  process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'shots';
const only = process.argv
  .slice(2)
  .filter((a) => a.startsWith('--only='))
  .flatMap((a) => a.slice('--only='.length).split(','))
  .filter(Boolean);

/**
 * The views, grouped by the question they answer rather than by the thing they point at.
 *
 * Grouping by question is the whole discipline of a screenshot pass: the failure mode is collecting views
 * that answer nothing, and naming the question is what stops that.
 */
const VIEWS = [
  { name: 'overview', group: 'layout', question: 'Is the railway readable as a landmark from above?' },
  { name: 'layout', group: 'layout', question: 'Can the map be described as town / railway / fields / elevated side?' },
  { name: 'railway', group: 'railway', question: 'Does the graded line read as a railway?' },
  { name: 'crossing', group: 'railway', question: 'Does the level crossing read as a crossing, from the road?' },
  { name: 'station', group: 'railway', question: 'Does the railway read as a place, with a platform and a building?' },
  { name: 'tankAtRailway', group: 'grounding', question: 'Is the tank grounded on the railway, at the right scale?' },
  { name: 'town', group: 'town', question: 'Do the village buildings read as buildings with short sight lines?' },
  { name: 'tankInVillage', group: 'grounding', question: 'Is the tank grounded between the cottages?' },
  { name: 'tankAtStation', group: 'grounding', question: 'Is the tank grounded beside the station?' },
  { name: 'fields', group: 'fields', question: 'Is there open ground a tank can manoeuvre and fire across?' },
  { name: 'road', group: 'fields', question: 'Does the town road read as a route to the crossing?' },
  { name: 'cairn', group: 'elevation', question: 'Does the elevated flank overlook the map without being a wall?' },
  { name: 'tankOnHill', group: 'grounding', question: 'Is the tank grounded on a real hill?' },
  { name: 'playerspawn', group: 'spawns', question: 'Does the opening view frame the tank and the direction of play?' },
  { name: 'enemyspawn', group: 'spawns', question: 'Does the opponent open on sensible ground with routes available?' },
  { name: 'cover', group: 'combat', question: 'Is there cover on the flanks of the town road?' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long to let the page boot before parking the camera. Overridable for a quick single-view check. */
const SETTLE_MS = Number(
  process.argv.slice(2).find((a) => a.startsWith('--settle='))?.slice('--settle='.length) ?? 8000,
);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome or Edge found.');
}

/**
 * Waits for the static server to answer on `port`, or gives up.
 *
 * Fetches `localhost` first. Vite's preview server binds to whatever `localhost` resolves to, which on this
 * machine is IPv6 `::1`, while a request to `127.0.0.1` gets an outright connection refusal. Both families
 * are tried anyway, because which one wins is a property of the machine rather than of the server.
 */
async function waitForServer(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    for (const host of ['localhost', '[::1]', '127.0.0.1']) {
      try {
        const response = await fetch(`http://${host}:${port}/index.html`);
        seen.push(`${host} -> ${response.status}`);
        if (response.ok) return true;
      } catch (error) {
        // Recorded rather than swallowed: "the server never answered" with no reason attached is the least
        // useful error message available, and this one cost a full debugging cycle to diagnose.
        const code = error.cause?.code ?? error.message;
        if (!seen.includes(`${host} -> ${code}`)) seen.push(`${host} -> ${code}`);
      }
    }
    await sleep(250);
  }
  return { ok: false, seen };
}

/** Waits for the browser's debugging endpoint. */
async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      if (targets.length > 0) return targets;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome debugging endpoint never came up.');
}

/**
 * Waits for the game to finish booting, by polling rather than by sleeping.
 *
 * A fixed delay is a guess, and a guess that is wrong produces a screenshot of a blank page — which looks
 * exactly like a rendering bug. The game exposes `__combatTank` only once the simulation, the physics
 * world and the scene all exist, so polling for it is both the correct signal and the honest one: the
 * harness waits for the thing it actually needs.
 */
async function waitForGame(cdp, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: 'typeof globalThis.__combatTank',
      returnByValue: true,
    });
    if (probe.result?.value === 'object') return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  const views = only.length > 0 ? VIEWS.filter((v) => only.includes(v.name)) : VIEWS;
  mkdirSync(OUT, { recursive: true });

  // --- Static server and browser, both owned by this process ---
  //
  // The server is started, checked, and if the port turns out to be dead on this machine, killed and
  // retried on the next one. The output is teed rather than discarded: a preview server that fails to start
  // produces an empty picture rather than an error, and an empty picture looks exactly like a rendering
  // bug — which is the confusion this harness exists to remove.
  const serverLog = [];
  let port = null;
  let server = null;
  const attempts = [FIRST_PORT, ...CANDIDATE_PORTS].filter(
    (p, i, all) => p === FIRST_PORT || all.indexOf(p) < i,
  );

  for (const candidate of attempts) {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(candidate)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (c) => serverLog.push(c.toString()));
    child.stderr.on('data', (c) => serverLog.push(c.toString()));

    const probe = await waitForServer(candidate);
    if (probe === true) {
      port = candidate;
      server = child;
      break;
    }
    serverLog.push(`port ${candidate} did not answer: ${probe.seen.join(', ')}\n`);
    child.kill();
  }

  // **The server is confirmed before the browser starts.** Chrome initialising on a software renderer
  // saturates the CPU for several seconds, and a health-check fetch competing with it times out and
  // reports the blunt `fetch failed` — which reads exactly like "the server never started". Spawning them
  // in sequence costs two seconds and removes a false failure.
  let chrome = null;
  const index = [];
  const pageErrors = [];

  try {
    if (port === null || server === null) {
      throw new Error(
        `Preview server never answered on any of ${attempts.join(', ')}.\n${serverLog.join('')}`,
      );
    }

    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${join(ROOT, '.chrome-profile-shots')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--window-size=1280,760',
        // Software rendering: this machine has no GPU, but WebGL still has to work for anything to draw.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const targets = await waitForCdp();
    const page = targets.find((t) => t.type === 'page') ?? targets[0];
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    cdp.onRaw = (text) => {
      // Both kinds of evidence. An uncaught exception is one failure mode; a rejected promise inside the
      // bootstrap is another, and it leaves the game half-built with nothing on screen and no exception
      // event at all. `consoleAPICalled` catches the second, which is otherwise invisible.
      if (text.includes('exceptionThrown')) {
        for (const m of text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          pageErrors.push(`exception: ${m[1].slice(0, 200)}`);
        }
      }
      if (text.includes('consoleAPICalled') && /"type"\s*:\s*"(error|warning)"/.test(text)) {
        for (const m of text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          pageErrors.push(`console: ${m[1].slice(0, 200)}`);
        }
      }
    };

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // The tour script is read once and evaluated per view, with the viewpoint selected by URL fragment.
    const script = readFileSync(join(ROOT, 'tools/tour.js'), 'utf8');

    for (const view of views) {
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/#${view.name}` });

      const booted = await waitForGame(cdp);
      if (!booted) {
        // The client already reports a startup failure into `#hud-status`; this reads that rather than
        // dumping the whole page, because the status line is where the actual reason is written and
        // everything else is static HUD markup that says nothing.
        const detail = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const status = document.getElementById('hud-status');
            return JSON.stringify({
              status: status ? status.textContent : '(no status element)',
              hasCombatTank: typeof globalThis.__combatTank,
              canvas: (() => {
                const c = document.getElementById('render-canvas');
                return c ? c.width + 'x' + c.height : 'missing';
              })(),
            });
          })()`,
          returnByValue: true,
        });
        index.push({ ...view, file: null, info: { error: 'game never booted', detail: detail.result?.value } });
        process.stdout.write(`${view.name}: never booted — ${detail.result?.value}\n`);
        continue;
      }

      // A short settle after boot, so the first frames are drawn and the world is fully rendered.
      await sleep(SETTLE_MS);

      const result = await cdp.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
      });

      const info = result.exceptionDetails
        ? { error: JSON.stringify(result.exceptionDetails).slice(0, 400) }
        : (result.result?.value ?? null);

      await sleep(600);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT, `${view.group}-${view.name}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));

      index.push({ ...view, file, info });
      process.stdout.write(`${file}  ${JSON.stringify(info)}\n`);
    }

    cdp.close();
  } finally {
    chrome?.kill();
    server.kill();
  }

  writeFileSync(
    join(OUT, 'index.json'),
    `${JSON.stringify({ views: index, pageErrors }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(OUT, 'server.log'), serverLog.join(''), 'utf8');
  process.stdout.write(`\ncaptured ${index.length} views into ${OUT}\n`);
  if (pageErrors.length > 0) {
    process.stdout.write(`page errors:\n  ${[...new Set(pageErrors)].slice(0, 10).join('\n  ')}\n`);
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
