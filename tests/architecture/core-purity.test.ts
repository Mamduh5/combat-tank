import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Architecture guard tests.
 *
 * The boundaries in `docs/technical-direction.md` §3 and ADR-0001 are the most important structural
 * decision in this project, and a boundary that is only written down is a boundary that erodes.
 * These tests check it *mechanically*, so a violation fails the build instead of being noticed
 * months later — when the server can no longer be authoritative because gameplay moved into the
 * client.
 *
 * Two complementary checks run here:
 *  - the **lint configuration** is verified to actually fire on a violating file, so we know the
 *    `npm run lint` gate is real rather than a rule that silently matches nothing;
 *  - the **core source tree** is scanned directly, as an independent check that does not depend on
 *    ESLint being configured correctly.
 *
 * Deliberately not a test that merely greps the config file: a rule can be present in the config
 * and match nothing, which looks identical to a working rule until something actually violates it.
 */

const PROJECT_ROOT = process.cwd();
const CORE_DIR = join(PROJECT_ROOT, 'src', 'core');
const SHARED_DIR = join(PROJECT_ROOT, 'src', 'shared');
const ESLINT_BIN = join(PROJECT_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

/** Files that legitimately contain the banned patterns, with the reason they are exempt. */
const EXEMPT_CORE_FILES = new Set([join('math', 'trig.ts')]);

afterAll(() => {
  // Any temporary probe file left behind by a failed test would be a confusing artefact.
  for (const entry of readdirSync(CORE_DIR)) {
    if (entry.startsWith('purity-probe-')) {
      rmSync(join(CORE_DIR, entry), { force: true });
    }
  }
});

/** Recursively lists every `.ts` file under a directory, excluding test probe files. */
function listTypeScriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Probe files are created and deleted by the lint-gate tests below. Skipping them keeps the
    // scan from observing a probe mid-test and reporting a violation the scan did not cause.
    if (entry.startsWith('purity-probe-')) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listTypeScriptFiles(full));
    } else if (full.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** True when the file is exempt from the Math-transcendental ban. */
function isExempt(file: string): boolean {
  const relativePath = relative(CORE_DIR, file);
  for (const exempt of EXEMPT_CORE_FILES) {
    if (relativePath.endsWith(sep + exempt) || relativePath === exempt) {
      return true;
    }
  }
  return false;
}

/**
 * Removes comments from TypeScript source, leaving code only.
 *
 * Necessary because the core's own documentation *discusses* the banned constructs by name — the
 * `rng` module explains that `Math.random` is banned, and the smoothing helper explains that it
 * avoids `Math.exp`. A naive text scan flags those comments as violations, which would make the
 * guard impossible to satisfy without deleting the explanations that keep the rules comprehensible.
 *
 * This is a deliberately simple scanner, adequate for the shapes of comments in this project: block
 * comments, and line comments that are not inside a string. It is a guard against *code* violating
 * the boundary; ESLint remains the authoritative check.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Finds files under `dir` whose *code* matches any of the given patterns. */
function findViolations(dir: string, patterns: RegExp[], respectExemptions = false): string[] {
  const violations: string[] = [];
  for (const file of listTypeScriptFiles(dir)) {
    if (respectExemptions && isExempt(file)) {
      continue;
    }
    // Comments are stripped, but a *string literal* naming an import path still counts, because
    // dynamic `import('@babylonjs/...')` is a real way to break the boundary.
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of patterns) {
      if (pattern.test(code)) {
        violations.push(`${relative(PROJECT_ROOT, file)} matches ${pattern}`);
      }
    }
  }
  return violations;
}

describe('core purity (ADR-0001)', () => {
  it('contains no rendering or networking imports anywhere under src/core', () => {
    const violations = findViolations(CORE_DIR, [
      /from\s+['"]@babylonjs\//,
      /from\s+['"]colyseus/,
      /from\s+['"]@colyseus\//,
      /require\(\s*['"]@babylonjs\//,
    ]);
    expect(violations).toEqual([]);
  });

  it('contains no platform imports (node builtins, DOM globals) in src/core', () => {
    const violations = findViolations(CORE_DIR, [
      /from\s+['"]node:/,
      /from\s+['"]fs['"]/,
      /\bdocument\./,
      /\bwindow\./,
      /\bnavigator\./,
      /\blocalStorage\b/,
    ]);
    expect(violations).toEqual([]);
  });

  it('uses no Math.random or wall-clock reads in src/core (ADR-0005)', () => {
    const violations = findViolations(CORE_DIR, [
      /Math\s*\.\s*random/,
      /Date\s*\.\s*now/,
      /performance\s*\.\s*now/,
    ]);
    expect(violations).toEqual([]);
  });

  it('uses the core trig module rather than Math transcendentals in src/core', () => {
    // Only `trig.ts` may define the replacements; everything else must go through src/core/math.
    const violations = findViolations(
      CORE_DIR,
      [/Math\s*\.\s*sin/, /Math\s*\.\s*cos/, /Math\s*\.\s*tan/, /Math\s*\.\s*atan2/, /Math\s*\.\s*exp/],
      true,
    );
    expect(violations).toEqual([]);
  });

  it('lets the core import from shared, but not the reverse', () => {
    // A cycle between core and shared would mean the boundary has leaked. Asserting the direction
    // documents the intended dependency graph as an executable fact.
    const violations = findViolations(SHARED_DIR, [/from\s+['"][^'"]*\/core\//]);
    expect(violations).toEqual([]);
  });

  it('exercises at least one core file, so the scan cannot pass by finding nothing', () => {
    // Guards against the whole suite silently passing because the path is wrong and zero files
    // were read, which is the most likely way this test could lie.
    expect(listTypeScriptFiles(CORE_DIR).length).toBeGreaterThan(5);
  });
});

describe('the lint gate is real', () => {
  /**
   * Writes a temporary file into `src/core` and runs ESLint against it.
   *
   * The file must live inside `src/core`, because the rule is scoped by path — that scoping is
   * precisely what is being tested. The file is removed in a `finally`, so a lint failure still
   * cleans up rather than leaving a probe that would break the next run's typecheck.
   */
  function lintProbe(source: string): { exitCode: number; output: string } {
    const target = join(CORE_DIR, 'purity-probe.ts');
    writeFileSync(target, source, 'utf8');

    try {
      const output = execFileSync(process.execPath, [ESLINT_BIN, target], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { exitCode: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: failure.status ?? 1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    } finally {
      rmSync(target, { force: true });
    }
  }

  it('fails when src/core imports Babylon', () => {
    const result = lintProbe(
      "import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';\nexport const v = new Vector3();\n",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/@babylonjs/);
  });

  it('fails when src/core imports Colyseus', () => {
    const result = lintProbe("import { Room } from 'colyseus';\nexport const r = null as unknown as Room;\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/colyseus/);
  });

  it('fails when src/core uses Math.random', () => {
    const result = lintProbe('export const roll = (): number => Math.random();\n');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/Math\.random/);
  });

  it('fails when src/core uses Math.sin instead of the core trig module', () => {
    const result = lintProbe('export const s = (x: number): number => Math.sin(x);\n');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/deterministic/);
  });

  it('fails when src/core reads a wall clock', () => {
    const result = lintProbe('export const now = (): number => Date.now();\n');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/Date\.now/);
  });

  it('accepts a legitimate core file, proving the rule is not rejecting everything', () => {
    const result = lintProbe(
      "import { sin } from '../math/trig.js';\nexport const s = (x: number): number => sin(x);\n",
    );
    expect(result.exitCode).toBe(0);
  });
});

describe('project layout', () => {
  it('has the expected directory structure', () => {
    expect(relative(PROJECT_ROOT, CORE_DIR).split(sep).join('/')).toBe('src/core');
    expect(relative(PROJECT_ROOT, SHARED_DIR).split(sep).join('/')).toBe('src/shared');
  });

  it('leaves no temporary probe files behind', () => {
    const leftovers = readdirSync(CORE_DIR).filter((entry) => entry.startsWith('purity-probe-'));
    expect(leftovers).toEqual([]);
  });
});

