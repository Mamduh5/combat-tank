/**
 * Drives the built game in a real browser and reports what the controls actually do to the player.
 *
 * ## Why this exists separately from the test suite
 *
 * V6 shipped with a fully green control suite and controls the owner described as unplayable. The suite was
 * not wrong, it was **insufficient**: it compared throttle direction against the simulation's own forward
 * vector, so it could never see that the *rendered* tank pointed 180 degrees away from it, and it asserted
 * a camera behaviour (hull-relative orbit with automatic recovery) that was itself the defect.
 *
 * This drives the shipping page with real keyboard and mouse events and reports, per check, where the tank
 * went relative to where its visible nose pointed, how far the hull heading changed, and how far the camera
 * bearing and position changed. It owns its server and browser for the same reason `shots.mjs` does: a
 * server that dies quietly produces an empty result rather than an error.
 *
 * A green result here is still not a substitute for a human at the keyboard. It is evidence, not proof.
 *
 * Usage: `node tools/control-check.mjs [outDir]`
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ports to try, in order.
 *
 * Not a single fixed port: a preview server can bind successfully and still be unreachable on every address
 * family on this machine. The server is started, checked, and abandoned if it does not actually answer,
 * which turns an invisible network quirk into a skip to the next candidate instead of a blank result.
 */
const CANDIDATE_PORTS = [4321, 4400, 4500, 4600, 4700, 4800, 4900];
const FIRST_PORT = Number(process.env.SHOTS_PORT ?? CANDIDATE_PORTS[0]);
const CDP_PORT = 9334;
const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'shots/controls';

/**
 * How long the in-page probe may take.
 *
 * Sized above the probe's worst case (roughly twenty multi-second key holds) so that a timeout means the
 * page stopped responding rather than that the script is simply thorough.
 */
const PROBE_TIMEOUT_MS = 420000;

/** Chrome from the usual install locations. Throws with the searched list if none is found. */
function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No Chrome or Edge found. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
}

/** Waits for the static server to answer, trying both address families. */
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
 * A fixed delay is a guess, and a wrong guess produces a "the game never booted" report that reads like a
 * defect rather than a timing mistake. `__combatTank` only exists once the simulation, physics and scene are
 * all built, so polling for it waits for exactly the thing being needed.
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
  mkdirSync(OUT, { recursive: true });

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

  // The server is confirmed before Chrome starts: on a software renderer Chrome saturates the CPU for
  // several seconds, and a health-check fetch competing with it times out and reports a blunt failure that
  // reads exactly like "the server never started".
  let chrome = null;
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
        `--user-data-dir=${join(ROOT, '.chrome-profile-controls')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--window-size=1280,760',
        // Software rendering: no GPU here, but WebGL still has to work for anything to draw.
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

    await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });
    const booted = await waitForGame(cdp);
    if (!booted) {
      throw new Error('Game never booted; the page reports the reason in #hud-status.');
    }

    // A short settle, so the first frames are drawn and the world is fully built before anything is driven.
    await sleep(2500);

    const script = readFileSync(join(ROOT, 'tools/control-probe.js'), 'utf8');
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression: script, awaitPromise: true, returnByValue: true },
      // Long, and deliberately so: the probe holds real keys for seconds each because a software renderer
      // advances only a few simulation ticks per frame. Sized above the probe's own worst case so a
      // timeout here means "the page stopped responding", not "the script is thorough".
      PROBE_TIMEOUT_MS,
    );

    const report = result.exceptionDetails
      ? { error: JSON.stringify(result.exceptionDetails).slice(0, 600) }
      : (result.result?.value ?? null);

    writeFileSync(
      join(OUT, 'control-report.json'),
      `${JSON.stringify({ report, pageErrors }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(OUT, 'server.log'), serverLog.join(''), 'utf8');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'final-frame.png'), Buffer.from(shot.data, 'base64'));

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (pageErrors.length > 0) {
      process.stdout.write(`\npage errors:\n  ${[...new Set(pageErrors)].slice(0, 10).join('\n  ')}\n`);
    }
    cdp.close();
  } finally {
    chrome?.kill();
    server.kill();
  }

  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error.stack ?? error.message}\n`);
  process.exit(1);
});