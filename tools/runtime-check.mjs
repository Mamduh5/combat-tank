/**
 * The V7 runtime gate: runs the shipping page in a real browser, plays it, and reports what happened.
 *
 * ## Why this exists separately from every other gate
 *
 * V7 shipped with a fully green suite while the game showed no player tank, a checkerboard ground, static
 * noise, and then crashed after about five seconds. The reason is structural, not accidental: every existing
 * gate is a **static** check — type correctness, unit behaviour, scene-graph shape, asset decodability — and
 * every one of those four failures is invisible to a static check. A tank can exist in the graph and be
 * invisible on screen; a texture can decode and render as a fallback checkerboard; a WAV can decode and
 * sound like static; and a lifecycle fault cannot fire in a process that exits after one frame.
 *
 * So this gate is deliberately the opposite: it runs the real page, feeds it real input, and keeps it alive
 * long enough for time-based faults to appear. It measures, it does not judge. It cannot tell whether the
 * tank *looks* good or the audio *sounds* good — that is the owner's call — but it can and does catch
 * obviously broken runtime state, which is what every gate before it missed.
 *
 * Usage: `node tools/runtime-check.mjs [outDir] [--runtime-ms=62000]`
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'shots/runtime';
const RUNTIME_MS = Number(process.argv.find((a) => a.startsWith('--runtime-ms='))?.slice(13) ?? 62000);

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

/** Ports to try. Not one fixed port: a preview server can bind and still be unreachable on this machine. */
const CANDIDATE_PORTS = [4173, 4321, 4400, 4500, 4600, 4700];
const CDP_PORT = 9339;
const PROFILE = join(ROOT, '.chrome-profile-runtime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error(`No Chrome or Edge found. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
}

async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    for (const host of ['localhost', '[::1]', '127.0.0.1']) {
      try {
        const res = await fetch(`http://${host}:${port}/index.html`);
        if (res.ok) return true;
        seen.push(`${host} -> ${res.status}`);
      } catch (e) {
        seen.push(`${host} -> ${e.cause?.code ?? e.message}`);
      }
    }
    await sleep(300);
  }
  throw new Error(`No server answered on any port. Tried:\n  ${seen.slice(0, 6).join('\n  ')}`);
}

async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      if (targets.length) return targets;
    } catch {
      /* endpoint not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome debugging endpoint never came up.');
}

let chrome = null;
let server = null;
async function main() {
  mkdirSync(OUT, { recursive: true });

  // A stale profile from a killed run can make Chrome fail to open its debug port.
  rmSync(PROFILE, { recursive: true, force: true });

  let port = null;
  for (const candidate of CANDIDATE_PORTS) {
    // Spawned through `process.execPath` and the local vite entry rather than through `npx`, because on
    // Windows `spawn` cannot resolve the `.cmd` shim `npx` is installed as.
    server = spawn(
      process.execPath,
      [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(candidate), '--strictPort'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    try {
      await waitForServer(candidate);
      port = candidate;
      break;
    } catch {
      server.kill();
      server = null;
    }
  }
  if (port === null) throw new Error('vite preview would not start on any candidate port.');

  chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1280,760',
      // Software rendering: no GPU here, but WebGL still has to work for anything to draw.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      // Without this the AudioContext stays `suspended` under automation and every measurement of the
      // output signal reads zero — which would make a genuinely corrupt mix look like silence.
      '--autoplay-policy=no-user-gesture-required',
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
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  /**
   * Every URL the page tried to fetch that did not come back 2xx.
   *
   * Captured at the network layer rather than inferred from the console, because the console only reports
   * "Failed to load resource: 404" with no URL attached — which is exactly why the previous gates could say
   * the assets were present (true on disk) while the scene was rendering a missing-texture placeholder.
   */
  const failedRequests = [];
  const problems = [];
  cdp.onRaw = (text) => {
    // Every URL the page tried to fetch that did not come back 2xx. Captured at the network layer rather
    // than inferred from the console, because the console only reports "Failed to load resource: 404" with
    // no URL attached — which is exactly why the previous gates could report the assets present (true on
    // disk) while the scene rendered a missing-texture placeholder.
    if (text.includes('Network.responseReceived') && /"status":\s*[45]\d\d/.test(text)) {
      for (const m of text.matchAll(/"url"\s*:\s*"([^"]*)"/g)) {
        failedRequests.push(m[1].slice(0, 300));
      }
    }
    // Four separate channels, because they fail differently: uncaught exceptions, unhandled promise
    // rejections, console errors/warnings, and the browser's own log — which is where WebGL and
    // audio-context failures land, and which is a different channel from `console.error` entirely.
    if (text.includes('exceptionThrown') || text.includes('unhandledRejection') || text.includes('entryAdded')) {
      for (const m of text.matchAll(/"(?:text|description|value)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        const line = m[1].replace(/\\n/g, ' ').slice(0, 400);
        if (line.trim()) problems.push(line);
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

  // Wait for the game to expose itself before evaluating, so a probe reporting "never booted" means boot
  // actually failed rather than that the probe was impatient.
  let booted = false;
  for (let i = 0; i < 80; i += 1) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'Boolean(globalThis.__combatTank)',
      returnByValue: true,
    });
    if (r.result?.value === true) { booted = true; break; }
    await sleep(500);
  }

  const probeFile = process.argv.find((a) => a.startsWith('--probe='))?.slice(8) ?? 'tools/runtime-probe.js';
  const script = readFileSync(join(ROOT, probeFile), 'utf8');
  let report;
  if (!booted) {
    report = { bootOk: false, reason: 'globalThis.__combatTank never appeared' };
  } else {
    const res = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `globalThis.__CT_RUNTIME_MS = ${RUNTIME_MS};\n(${script})`,
        awaitPromise: true,
        returnByValue: true,
      },
      // Generous, because the probe holds the game alive for `RUNTIME_MS` under a software renderer. Sized
      // above the probe's own budget so a timeout here means the page stopped responding.
      RUNTIME_MS + 180000,
    );
    if (res.exceptionDetails) {
      // The probe throwing is itself the finding — a rejected promise during play *is* the crash.
      report = {
        bootOk: true,
        probeThrew: true,
        exception: JSON.stringify(res.exceptionDetails).slice(0, 2000),
      };
    } else {
      report = res.result?.value ?? { bootOk: true, empty: true };
    }
  }

  // A screenshot of whatever state the page is in now. If the game crashed, this is often a blank or
  // frozen canvas — which is itself evidence.
  let shotOk = false;
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'runtime-final.png'), Buffer.from(shot.data, 'base64'));
    shotOk = true;
  } catch (e) {
    problems.push(`screenshot failed: ${e.message}`);
  }

  const summary = { report, failedRequests: [...new Set(failedRequests)], problems: [...new Set(problems)] };

  /**
   * The gate's verdict.
   *
   * Two independent ways to fail, both of which V7's gates missed:
   *
   * 1. **Any check failed.** The probe asserts mechanical facts about what is drawn, loaded, running, and
   *    bounded. A failure there is a defect a player would notice.
   * 2. **Any uncaught exception, unhandled rejection, or failed request.** V7's missing-texture 404s were
   *    sitting in the console the whole time, unremarked, and they were the checkerboard. A gate that only
   *    looked at assertions could not see them.
   *
   * Console *performance* warnings from the software renderer are excluded: they are the harness's GPU, not the
   * game's, and treating them as failures would make the gate unusable.
   */
  const isFailure = (line) =>
    !/GL Driver Message|GPU stall due to ReadPixels|Failed to load resource/.test(line);
  const hardProblems = summary.problems.filter(isFailure);
  const failedRequestsNotFavicon = summary.failedRequests.filter((u) => !/favicon\.ico$/.test(u));
  summary.verdict = {
    passed:
      Boolean(report?.passed) &&
      hardProblems.length === 0 &&
      failedRequestsNotFavicon.length === 0,
    failedChecks: report?.failed ?? [{ name: 'probe did not run', pass: false }],
    uncaughtOrRejected: hardProblems,
    failedRequests: failedRequestsNotFavicon,
    ignoredPerformanceWarnings: summary.problems.length - hardProblems.length,
  };

  writeFileSync(join(OUT, 'runtime-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`\nwrote ${join(OUT, 'runtime-report.json')}${shotOk ? ` and ${join(OUT, 'runtime-final.png')}` : ''}\n`);

  cdp.close();

  // A gate that always exits 0 is a report, not a gate. The exit code is what makes this usable from a
  // pipeline, and it is the difference between "we looked" and "we checked".
  if (!summary.verdict.passed) {
    process.exitCode = 1;
    process.stderr.write('\nRUNTIME GATE FAILED\n');
    for (const c of summary.verdict.failedChecks) {
      process.stderr.write(`  FAIL ${c.name}${c.detail ? ` (${c.detail})` : ''}\n`);
    }
    for (const p of summary.verdict.uncaughtOrRejected) {
      process.stderr.write(`  PAGE ${p.slice(0, 160)}\n`);
    }
    for (const u of summary.verdict.failedRequests) {
      process.stderr.write(`  REQUEST ${u}\n`);
    }
  }
}

main()
  .catch((error) => {
    process.stderr.write(`FAILED: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    chrome?.kill();
    server?.kill();
    // Give the children a moment to die before Node exits, so a killed preview server does not outlive the
    // run and hold the port for the next one.
    setTimeout(() => process.exit(process.exitCode ?? 0), 800);
  });