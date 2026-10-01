/**
 * Screenshot harness for visual review.
 *
 * Drives the running game in headless Chrome and writes a PNG, so presentation work can be judged by
 * **looking at it** rather than by reading the code that draws it.
 *
 * Usage: node tools/shot.mjs <outDir> [--script=file.js] [--wait=ms] [--url=...]
 *
 * A development tool, not part of the game: nothing here is bundled and nothing in `src/` imports it.
 * Uses only Node built-ins and a local Chrome or Edge, so it adds no dependency to the project.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CDP } from './cdp.mjs';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const PORT = 9333;
const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? 'shots';
const scriptArg = args.find((a) => a.startsWith('--script='));
const waitArg = args.find((a) => a.startsWith('--wait='));
const url = args.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://localhost:4173/';
const settleMs = Number(waitArg?.slice(7) ?? 9000);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('No Chrome or Edge found.');
}

mkdirSync(outDir, { recursive: true });

const chrome = spawn(
  findChrome(),
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.cwd(), '.chrome-profile')}`,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

async function main() {
  let targets = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await fetchJson('/json/list');
      if (targets.length) break;
    } catch {
      /* endpoint not up yet */
    }
    await sleep(250);
  }
  if (!targets?.length) throw new Error('Chrome debugging endpoint never came up.');

  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Collect page errors, so a blank screenshot is never mistaken for a rendering bug.
  const errors = [];
  cdp.onRaw = (text) => {
    if (!text.includes('exceptionThrown') && !text.includes('entryAdded')) return;
    for (const m of text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      errors.push(m[1].slice(0, 300));
    }
  };

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send('Page.navigate', { url });
  await sleep(settleMs);

  if (scriptArg) {
    const res = await cdp.send('Runtime.evaluate', {
      expression: readFileSync(scriptArg.slice(9), 'utf8'),
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      console.log('SCRIPT ERROR: ' + JSON.stringify(res.exceptionDetails).slice(0, 600));
    } else if (res.result?.value !== undefined) {
      console.log('SCRIPT RESULT: ' + JSON.stringify(res.result.value).slice(0, 3000));
    }
    await sleep(800);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const name = join(outDir, 'shot.png');
  writeFileSync(name, Buffer.from(shot.data, 'base64'));
  console.log('WROTE ' + name);
  if (errors.length) {
    console.log('PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 12).join('\n'));
  }

  cdp.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED: ' + e.message);
  chrome.kill();
  process.exit(1);
});