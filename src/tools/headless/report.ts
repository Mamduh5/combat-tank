import type { BatchReport } from './batch-runner.js';
import { SCENARIOS } from './scenarios.js';

/**
 * Rendering a batch report for two audiences at once.
 *
 * The requirement is that the output be useful to a person reading a terminal **and** usable by a
 * machine, without maintaining two descriptions of the same run. The way this achieves that is by
 * keeping the text summary and the JSON structurally identical rather than merely related: every number
 * in the summary comes from the same report object that is serialised, so they cannot drift.
 *
 * Deliberately not a table renderer. Fixed-width columns look better and go wrong the moment a number
 * grows a digit, and the audience here is someone who wants to know which seeds to go and replay.
 */

/** A plain-text summary, for a terminal. */
export function formatSummary(report: BatchReport): string {
  const lines: string[] = [];
  const { options, totals, averages, outcomeCounts } = report;

  lines.push(
    `Combat Tank - headless battles   scenario=${options.scenario}  seeds=${seedRange(options.seedStart, options.battles)}  ` +
      `budget=${(options.maxTicks / 60).toFixed(0)}s`,
  );
  lines.push('');

  lines.push('  outcome      victory  defeat  timeout');
  lines.push(
    `  battles   ${pad(options.battles, 9)}${pad(outcomeCounts.victory, 8)}` +
      `${pad(outcomeCounts.defeat, 8)}${pad(outcomeCounts.timeout, 8)}`,
  );
  lines.push('');

  lines.push('  opponent shooting');
  lines.push(`    shells fired        ${totals.shellsFired}`);
  lines.push(`    struck the player   ${totals.shellsStruck}   (hit rate ${percent(totals.hitRate)})`);
  lines.push(`    penetrations        ${totals.penetrations}   (of strikes ${percent(totals.penetrationRate)})`);
  lines.push(`    damage dealt        ${totals.damageDealt}`);
  lines.push('');

  lines.push('  averages');
  lines.push(`    decided battle      ${averages.decidedDurationSeconds.toFixed(1)}s`);
  lines.push(`    damage dealt        ${averages.damageDealt}`);
  lines.push(`    seen, gun idle      ${averages.ticksSeenNotFiring} ticks`);
  lines.push('');

  lines.push('  per battle');
  lines.push('    seed    outcome   len     pen  dmg  hit  seen/idle  max range  ended in');
  for (const battle of report.battles) {
    lines.push(
      `    ${pad(battle.seed, 7)}${pad(battle.outcome, 10)}${pad(`${battle.durationSeconds.toFixed(1)}s`, 8)}` +
        `${pad(battle.penetrations, 5)}${pad(battle.damageDealt, 5)}${pad(battle.shellsStruck, 5)}` +
        `${pad(battle.ticksSeenNotFiring, 11)}${pad(`${battle.maxRangeM}m`, 11)}  ${battle.finalIntent}`,
    );
  }
  lines.push('');

  if (report.suspects.length === 0) {
    lines.push('  No seeds flagged. Every battle showed the opponent engaging.');
  } else {
    lines.push(`  ${report.suspects.length} seed(s) flagged - replay with: npm run sim -- --seed <n> --battles 1`);
    for (const suspect of report.suspects) {
      lines.push(`    seed ${suspect.seed} (${suspect.scenario}): ${suspect.reason}`);
    }
  }

  return lines.join('\n');
}

/** The full report as JSON, for piping into another tool. */
export function formatJson(report: BatchReport): string {
  return JSON.stringify(report, null, 2);
}

/** One-line usage text, printed on a bad argument or `--help`. */
export function formatUsage(): string {
  return [
    'Usage: npm run sim -- [options]',
    '',
    'Runs real headless battles - the same simulation, combat and AI the game uses, with no renderer.',
    '',
    'Options:',
    '  --battles <n>     How many battles to run. Default 10.',
    '  --seed <n>        First seed. Seeds are consecutive, so --battles 5 --seed 100 runs 100..104.',
    '  --scenario <s>    Player behaviour: ' + SCENARIOS.join(', ') + '.',
    '                   Default mixed (a scripted sequence of the others).',
    '  --ticks <n>       Tick budget per battle. Default 7200 (2 minutes at 60 Hz).',
    '  --seconds <n>     Same as --ticks, in seconds. Convenient to read.',
    '  --map <name>      Battlefield. Only ashford-valley in V6. Omit for the legacy V5 arena.',
    '  --json            Print the full report as JSON instead of a summary.',
    '  --help            This message.',
    '',
    'Examples:',
    '  npm run sim                                  10 mixed battles, seeds 1-10',
    '  npm run sim -- --battles 50 --seed 1000      a wider sweep from seed 1000',
    '  npm run sim -- --scenario parked              the frontal-armour case from ADR-0016',
    '  npm run sim -- --seed 4242 --battles 1        replay one seed exactly',
    '  npm run sim -- --battles 5 --json > r.json   save a report',
    '  npm run sim -- --map ashford-valley       the V6 battlefield',
  ].join('\n');
}

/** Renders `first..last`, or a single value when there is only one. */
function seedRange(seedStart: number, battles: number): string {
  if (battles <= 1) {
    return String(seedStart);
  }
  return `${seedStart}..${seedStart + battles - 1}`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/** Right-aligns into a fixed width, which is the only formatting the columns depend on. */
function pad(value: number | string, width: number): string {
  return String(value).padStart(width);
}

/** Re-exported so a caller can validate a scenario name without importing two modules. */
export { isScenarioId, type ScenarioId } from './scenarios.js';
