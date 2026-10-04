/**
 * Measures the V6 opening: where the opponent is relative to the player, and how hard it is to see.
 *
 * ## The question
 *
 * The owner reported they could not find the enemy. That report is authoritative player-facing evidence, but
 * it arrived while the controls were also broken, so the honest response is to measure rather than assume:
 * is the *opening geometry* independently too hard, separate from the control bugs?
 *
 * This module answers that with plain geometry through the real `Battlefield.hasLineOfSight`:
 *
 *  - the range and bearing from the player spawn to the opponent spawn, and whether contact exists at all;
 *  - the shortest drive from the player spawn that opens line of sight, aimed at the opponent;
 *  - a survey of candidate opponent spawns, scored by how quickly contact would open from them.
 *
 * ## Why the survey exists
 *
 * Moving the opponent spawn is the obvious lever, but "visible at spawn" and "quickly found" are different
 * goals and moving to satisfy one can quietly break the other. A position visible from the spawn but behind
 * the central swell is no better than an invisible one if the only approach is a wide arc. So candidates are
 * ranked on **approach distance**, not on visibility alone.
 *
 * Output is a formatted string rather than JSON, because this is a diagnostic to be *read* while tuning and a
 * table of aligned numbers beats a wall of keys.
 */
import { Battlefield } from '../../core/world/battlefield.js';
import { MARLOWE_CROSSING } from '../../core/world/maps/marlowe-crossing.js';
import { CT_MEDIUM } from '../../shared/roster.js';
import { CT_HEAVY } from '../../shared/roster.js';
import { Simulation } from '../../core/sim/world.js';
import { evaluateDetection } from '../../core/spotting/spotting.js';
import { NEUTRAL_INPUT } from '../../shared/input.js';

/** Degrees per radian, for readable output. */
const DEG = 180 / Math.PI;

/** Simulation ticks per second, matching the core's fixed tick (ADR-0008). */
const TICKS_PER_SECOND = 60;

/**
 * How high above the ground both tanks are "seen" from, metres.
 *
 * The turret ring height, because that is where a gunner's eye sits and therefore the height the spotting
 * system actually reasons about. Using the hull floor instead would overstate occlusion by a metre and make
 * every candidate look worse than it plays.
 */
const EYE_HEIGHT_M = CT_MEDIUM.turret.ringHeightM;

/** A speed used only to convert a drive distance into a rough number of seconds, m/s. */
const REFERENCE_SPEED_MPS = 6;

/** Half the playable map, so the survey never proposes a point outside the world. */
const MAP_HALF_M = 250;

/** Line of sight is sampled this many times along the ray, finer than the game's own default on purpose. */
const LOS_STEPS = 64;

function eyeAt(field: Battlefield, x: number, z: number): { x: number; y: number; z: number } {
  return { x, y: field.terrain.heightAt(x, z) + EYE_HEIGHT_M, z };
}

/** Can a tank at (x, z) see a tank at (targetX, targetZ) on this battlefield? */
function canSee(field: Battlefield, x: number, z: number, targetX: number, targetZ: number): boolean {
  return field.hasLineOfSight(eyeAt(field, x, z), eyeAt(field, targetX, targetZ), LOS_STEPS, 0.6).clear;
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

/** Signed degrees from one bearing to another, in the project's heading convention. Exported so the
 *  launcher and the report use the identical function rather than two that could disagree. */
export function bearingDeltaDeg(fromRad: number, toRad: number): number {
  return (((toRad - fromRad) * DEG + 540) % 360) - 180;
}

/**
 * The shortest straight-line drive from a start point that opens line of sight to a target.
 *
 * Aimed straight at the target, because that is what a player told to "go and find the fight" does. Returns
 * `null` if the approach does not open contact within `maxMetres`.
 */
function approachDistance(
  field: Battlefield,
  fromX: number,
  fromZ: number,
  targetX: number,
  targetZ: number,
  maxMetres = 200,
): number | null {
  const bearing = Math.atan2(targetX - fromX, targetZ - fromZ);
  for (let metres = 0; metres <= maxMetres; metres += 5) {
    const x = fromX + Math.sin(bearing) * metres;
    const z = fromZ + Math.cos(bearing) * metres;
    if (Math.abs(x) > MAP_HALF_M || Math.abs(z) > MAP_HALF_M) {
      return null;
    }
    if (canSee(field, x, z, targetX, targetZ)) {
      return metres;
    }
  }
  return null;
}

/** One surveyed opponent position, with the numbers that decide whether it is a good spawn. */
interface Candidate {
  readonly x: number;
  readonly z: number;
  /** Straight-line range from the player spawn. */
  readonly rangeM: number;
  /** How far off the player spawn's own heading this lies, degrees. */
  readonly headingOffsetDeg: number;
  /** Whether the player can see it from the spawn without moving. */
  readonly visibleAtSpawn: boolean;
  /** Shortest drive toward it that opens contact, metres. */
  readonly approachM: number | null;
}

/**
 * Surveys the map for opponent positions the player could actually find.
 *
 * The bearing filter is the important part. A candidate 150 m away but 120 degrees off the player's opening
 * heading is technically "findable" and practically a wild goose chase, so only positions within a modest arc
 * of where the player is already looking are considered. The arc is generous (60 degrees either side) because
 * the opening framing deliberately includes the level crossing and the village, which both lie off the
 * spawn's exact heading.
 */
function surveyCandidates(
  field: Battlefield,
  player: { x: number; z: number; headingRad: number },
): Candidate[] {
  const found: Candidate[] = [];
  for (let x = -MAP_HALF_M; x <= MAP_HALF_M; x += 20) {
    for (let z = -MAP_HALF_M; z <= MAP_HALF_M; z += 20) {
      const rangeM = distance(player.x, player.z, x, z);
      // Outside the spotting band the fight cannot start at all; inside it, too close is a muzzle duel.
      if (rangeM < 100 || rangeM > 190) {
        continue;
      }
      const bearing = Math.atan2(x - player.x, z - player.z);
      const headingOffsetDeg = Math.abs(bearingDeltaDeg(player.headingRad, bearing));
      if (headingOffsetDeg > 60) {
        continue;
      }
      found.push({
        x,
        z,
        rangeM,
        headingOffsetDeg,
        visibleAtSpawn: canSee(field, player.x, player.z, x, z),
        approachM: approachDistance(field, player.x, player.z, x, z),
      });
    }
  }
  return found;
}

/**
 * Produces the full report as a formatted string.
 *
 * Exported as a pure text-producing function so the Node launcher can print it, and so a test could assert on
 * a substring of the same output the developer reads.
 */
export function reportContactOpening(): string {
  const field = new Battlefield(MARLOWE_CROSSING);
  const player = MARLOWE_CROSSING.playerSpawn;
  const enemy = MARLOWE_CROSSING.enemySpawn;

  const lines: string[] = [];
  const openingRange = distance(player.x, player.z, enemy.x, enemy.z);
  const bearingToEnemy = Math.atan2(enemy.x - player.x, enemy.z - player.z);

  lines.push('=== Marlowe Crossing: the opening ===');
  lines.push(
    `player spawn   (${player.x}, ${player.z})  heading ${(player.headingRad * DEG).toFixed(1)} deg`,
  );
  lines.push(`enemy spawn    (${enemy.x}, ${enemy.z})`);
  lines.push(`range          ${openingRange.toFixed(1)} m`);
  lines.push(
    `bearing to enemy ${(bearingToEnemy * DEG).toFixed(1)} deg, ` +
      `${bearingDeltaDeg(player.headingRad, bearingToEnemy).toFixed(1)} deg off the opening heading`,
  );
  lines.push(`visible at spawn  ${canSee(field, player.x, player.z, enemy.x, enemy.z)}`);

  const authoredApproach = approachDistance(field, player.x, player.z, enemy.x, enemy.z);
  lines.push(
    authoredApproach === null
      ? 'approach        none within 200 m of driving straight at it'
      : `approach        ${authoredApproach} m of driving straight at it ` +
          `(~${(authoredApproach / REFERENCE_SPEED_MPS).toFixed(1)} s at ${REFERENCE_SPEED_MPS} m/s)`,
  );

  // The point of the survey: is there anywhere better to start the fight?
  const candidates = surveyCandidates(field, player);
  lines.push('');
  lines.push(
    `=== candidate opponent spawns (100-190 m, within 60 deg of the opening heading): ${candidates.length} found`,
  );
  lines.push(`visible from the player's spawn without moving: ${candidates.filter((c) => c.visibleAtSpawn).length}`);

  const ranked = [...candidates].sort((a, b) => {
    // Ranked by how soon contact opens, then by how squarely it sits in the opening frame.
    const approachA = a.approachM ?? Number.POSITIVE_INFINITY;
    const approachB = b.approachM ?? Number.POSITIVE_INFINITY;
    if (approachA !== approachB) return approachA - approachB;
    return a.headingOffsetDeg - b.headingOffsetDeg;
  });

  lines.push('');
  lines.push('  x     z    range  offset  visible  approach');
  for (const c of ranked.slice(0, 12)) {
    lines.push(
      `  ${String(c.x).padStart(4)} ${String(c.z).padStart(4)}` +
        `   ${c.rangeM.toFixed(0).padStart(4)}m` +
        `   ${c.headingOffsetDeg.toFixed(0).padStart(4)}deg` +
        `   ${c.visibleAtSpawn ? '  yes  ' : '   no  '}` +
        `   ${c.approachM === null ? 'none' : `${c.approachM}m`}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Can the player see a tank at (x, z) from the player spawn?
 *
 * Exported so the spawn comparison in the launcher uses the identical test rather than a second
 * implementation of "visible", which is how two tools end up disagreeing about the same map.
 */
export function canSeePair(x: number, z: number): boolean {
  const field = new Battlefield(MARLOWE_CROSSING);
  const player = MARLOWE_CROSSING.playerSpawn;
  return canSee(field, player.x, player.z, x, z);
}

/**
 * What the player is actually *told* about the enemy in the first seconds, tick by tick.
 *
 * ## Why this exists
 *
 * A screenshot of the opening frame showed the opponent plainly in view while the HUD read `CONTACT LOST`.
 * Those cannot both be right, and the difference matters: the brief asks for "I know where the fight is", and
 * the contact readout is how a player is told. So this runs the real `Simulation` - real spotting, real
 * concealment, real contact tracker - with **no player input at all**, and reports the timeline.
 *
 * This is deliberately not the line-of-sight test above. Visibility and *detection* are different systems:
 * concealment can hide a target that is geometrically in plain sight, and the contact tracker adds a grace
 * period so occlusion does not flicker the indicator. Only running the simulation settles which one the
 * player experiences.
 *
 * @returns seconds and contact state, plus the range and detection flag at each sample
 */
export function reportOpeningContact(secondsToWatch = 12, sampleEverySeconds = 2): string {
  const simulation = new Simulation({
    vehicle: CT_MEDIUM,
    target: CT_HEAVY,
    map: MARLOWE_CROSSING,
  });

  const lines: string[] = [];
  lines.push('=== what the player is told, with no input at all ===');
  lines.push('(real Simulation: spotting + concealment + contact tracker)');
  lines.push('');

  const totalTicks = secondsToWatch * TICKS_PER_SECOND;
  const sampleTicks = Math.max(1, Math.round(sampleEverySeconds * TICKS_PER_SECOND));
  const eye = CT_MEDIUM.turret.ringHeightM;

  lines.push('   t     state         range  detected  player');
  let lastState = '';

  for (let tick = 0; tick <= totalTicks; tick += 1) {
    if (tick % sampleTicks === 0) {
      const target = simulation.target!;
      const rangeM = Math.hypot(
        target.state.position.x - simulation.vehicle.state.position.x,
        target.state.position.z - simulation.vehicle.state.position.z,
      );
      // The same call the simulation itself makes, with the same subject shape, rather than a local
      // reimplementation - if the two disagreed, this report would be measuring something else.
      // `firedThisTick: false` because this is a standing observation, not a shot.
      const detection = evaluateDetection(
        simulation.battlefield,
        { id: 'player', position: simulation.vehicle.state.position, eyeHeightM: eye, firedThisTick: false },
        { id: 'opponent', position: target.state.position, eyeHeightM: eye, firedThisTick: false },
      );
      lines.push(
        `  ${(tick / TICKS_PER_SECOND).toFixed(0).padStart(3)}s` +
          `  ${simulation.playerContact.contact.state.padEnd(12)}` +
          `  ${rangeM.toFixed(0).padStart(4)}m` +
          `  ${(detection.detected ? 'yes' : 'no').padStart(8)}` +
          `  ${simulation.playerConcealment.concealed ? 'hidden' : '  open'}`,
      );
      lastState = simulation.playerContact.contact.state;
    }
    simulation.tick(NEUTRAL_INPUT);
  }

  lines.push('');
  lines.push(
    `final contact state: ${lastState}. 'undetected' throughout means the player is never told where the` +
      ' fight is, however visible the enemy looks in a screenshot.',
  );
  return `${lines.join('\n')}\n`;
}
