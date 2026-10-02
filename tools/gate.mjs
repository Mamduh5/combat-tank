/**
 * Runs the project's verification gates and writes a single report.
 *
 * ## Why this exists
 *
 * Each gate can be run on its own, but two practical problems made that unreliable: a foreground
 * `tsc` on this machine regularly outlives the shell integration's patience, and a silently empty output
 * file is indistinguishable from a gate that passed. That is a bad failure mode for a tool whose whole job
 * is to tell you whether the build is sound.
 *
 * So this spawns each gate as a child process, waits for it properly, and records an explicit pass/fail
 * with its output. A missing or empty result can never be read as success.
 *
 * Usage: `node tools/gate.mjs [--only=typecheck,lint,test]`
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GATES = [
  // The local binaries are invoked directly rather than through `npx`.
  //
  // `npx` resolves and (re-)installs packages, which adds seconds and a network check to every gate and
  // can hang outright in a sandboxed shell. Every one of these already exists in `node_modules`, so
  // `process.execPath` plus the package's own entry point gets a deterministic, offline, fast result.
  { id: 'typecheck', label: 'TypeScript', bin: 'typescript/bin/tsc', args: ['--noEmit', '--pretty', 'false'] },
  { id: 'lint', label: 'ESLint', bin: 'eslint/bin/eslint.js', args: ['.'] },
  { id: 'test', label: 'Vitest', bin: 'vitest/vitest.mjs', args: ['run', '--reporter=dot'] },
];

const only = process.argv
  .filter((a) => a.startsWith('--only='))
  .flatMap((a) => a.slice('--only='.length).split(','))
  .filter(Boolean);

function run(gate) {
  return new Promise((resolve) => {
    // Resolved against `node_modules` explicitly rather than left bare: a bare specifier would be
    // looked up on the module search path, which does not include it, and fails with a bare
    // MODULE_NOT_FOUND that says nothing about which gate broke.
    const entry = fileURLToPath(new URL(`../node_modules/${gate.bin}`, import.meta.url));
    const child = spawn(process.execPath, [entry, ...gate.args], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => resolve({ ...gate, code: -1, output: `spawn failed: ${error.message}` }));
    child.on('close', (code) => resolve({ ...gate, code, output }));
  });
}

const selected = only.length > 0 ? GATES.filter((g) => only.includes(g.id)) : GATES;
const results = [];
for (const gate of selected) {
  process.stdout.write(`running ${gate.id}...\n`);
  results.push(await run(gate));
}

const lines = [];
let failed = 0;
for (const result of results) {
  const pass = result.code === 0;
  if (!pass) {
    failed += 1;
  }
  lines.push(`=== ${result.id}: ${pass ? 'PASS' : `FAIL (exit ${result.code})`} ===`);
  lines.push(result.output.trim() === '' ? '(no output)' : result.output.trimEnd());
  lines.push('');
}
lines.push(`RESULT: ${failed === 0 ? 'ALL GATES PASS' : `${failed} GATE(S) FAILED`}`);

writeFileSync('.tmp-gate-report.txt', `${lines.join('\n')}\n`, 'utf8');
process.exitCode = failed === 0 ? 0 : 1;
