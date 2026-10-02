/**
 * Measures the gradients on a battlefield's primary routes, and fails if any of them is too steep.
 *
 * ## Why this exists as its own tool rather than as eyeballing
 *
 * The previous V6 map looked acceptable from above and was miserable to drive: too much of the playable
 * surface was steep enough that ordinary movement felt like climbing. Nothing in a screenshot catches
 * that, because a 20-degree slope photographed from 150 m up reads as gentle shading. Catching it needs a
 * *number*, and the number has to be sampled along the route a player would actually take rather than at
 * a few hand-picked points.
 *
 * So this walks each named route at a fixed stride, measures the steepest sustained gradient in each
 * direction using the simulation's own `slopeDegreesAlong`, and compares it against the vehicle's own
 * climb and descent limits. Those limits are read from the vehicle definition rather than hard-coded
 * here, so a vehicle that can climb steeper automatically makes the check less strict — which is the
 * correct coupling: the question is "can this tank do it", not "is the number small".
 *
 * ## Usage
 *
 * ```
 * node tools/measure-routes.mjs            the V6 battlefield
 * node tools/measure-routes.mjs --json     machine-readable, for a test or a CI check
 * ```
 *
 * Exits non-zero when a route exceeds a limit, so it works as a gate and not only as a report.
 */
import { createServer } from 'vite';
import { rmSync } from 'node:fs';

/** Where a route is sampled, and why it matters. */
const ROUTES = [
  {
    id: 'field-route',
    from: { x: -125, z: 80 },
    to: { x: 120, z: 130 },
    role: "The player's opening drive across the southern fields. The map's main artery.",
  },
  {
    id: 'railway-route',
    from: { x: -160, z: -44 },
    to: { x: 120, z: -18 },
    role: 'Along the graded mainline. Should be almost level — that is the point of grading it.',
  },
  {
    id: 'crossing-approach',
    from: { x: 33, z: 130 },
    to: { x: 33, z: -28 },
    role: 'The town road down to the level crossing. Includes the crossing itself.',
  },
  {
    id: 'town-route',
    from: { x: 33, z: -28 },
    to: { x: 20, z: -100 },
    role: 'Into the village. Tight, but it still has to be driveable.',
  },
  {
    id: 'cairn-approach',
    from: { x: 33, z: -28 },
    to: { x: 165, z: -165 },
    role: 'Up onto the elevated flank. The longest climb on the map and the one most likely to be wrong.',
  },
  {
    id: 'spawn-to-crossing',
    from: { x: -125, z: 80 },
    to: { x: 33, z: -28 },
    role: 'The opening approach a player is most likely to take. If this is steep, nothing else matters.',
  },
  {
    id: 'enemy-to-crossing',
    from: { x: 65, z: -55 },
    to: { x: 33, z: -28 },
    role: "The opponent's opening approach, measured from the place the AI will start driving.",
  },
];

/** Points a route must be passable through, sampled as a small disc around each. */
const GATEWAYS = [
  { id: 'player-spawn', x: -125, z: 80, radiusM: 12, role: 'The player must be able to drive off their spawn.' },
  { id: 'enemy-spawn', x: 65, z: -55, radiusM: 12, role: 'The opponent must be able to drive off theirs.' },
  { id: 'level-crossing', x: 33, z: -28, radiusM: 14, role: 'The railway must be crossable, not a wall.' },
  { id: 'village-approach', x: 33, z: -100, radiusM: 12, role: 'The town route must not dead-end in a building.' },
  { id: 'cairn-crest', x: 200, z: -186, radiusM: 14, role: 'The elevated flank has to be occupiable.' },
  { id: 'field-centre', x: -20, z: 130, radiusM: 20, role: 'The open fields must actually be open ground.' },
];

/** Samples per metre. Fine enough to catch a short steep step, coarse enough to be quick. */
const STRIDE_M = 2;

async function loadCore() {
  const cacheDir = `node_modules/.vite-measure-${process.pid}`;
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
    // A throwaway cache directory, deleted on the way out.
    //
    // This is not tidiness. Vite caches transformed modules on disk, and a measurement tool that reports
    // yesterday's terrain after today's map edit is worse than no tool at all: it silently contradicts
    // the file it claims to be describing. That happened while tuning this map — an `edgeRiseM` change
    // produced byte-identical output, which was the only evidence that the cache was stale. A unique
    // cache directory per run makes that failure impossible.
    cacheDir,
  });
  try {
    const [terrainMod, mapMod, vehicleMod] = await Promise.all([
      server.ssrLoadModule('/src/core/world/terrain.ts'),
      server.ssrLoadModule('/src/core/world/maps/marlowe-crossing.ts'),
      server.ssrLoadModule('/src/shared/placeholder-tank.ts'),
    ]);
    return { ...terrainMod, ...mapMod, ...vehicleMod };
  } finally {
    // Closed as soon as the modules are evaluated: the code is fully loaded by then, and a lingering
    // server would keep the process alive after the results have been printed.
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

/** Steepest sustained gradient along a straight line, in each direction. */
function measureRoute(terrain, route) {
  const dx = route.to.x - route.from.x;
  const dz = route.to.z - route.from.z;
  const lengthM = Math.sqrt(dx * dx + dz * dz);
  // Unit direction. `slopeDegreesAlong` projects onto the gradient directly, so a non-unit direction
  // reports a gradient scaled by its length — the exact silent error documented on that function.
  const dirX = dx / lengthM;
  const dirZ = dz / lengthM;
  const steps = Math.max(1, Math.ceil(lengthM / STRIDE_M));

  let climbDeg = 0;
  let descentDeg = 0;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = route.from.x + dx * t;
    const z = route.from.z + dz * t;
    const up = terrain.slopeDegreesAlong(x, z, dirX, dirZ);
    const down = terrain.slopeDegreesAlong(x, z, -dirX, -dirZ);
    if (up > climbDeg) climbDeg = up;
    if (down > descentDeg) descentDeg = down;
  }

  return { ...route, lengthM: Math.round(lengthM), climbDeg, descentDeg };
}

/** Steepest gradient found anywhere in a disc around a point. */
function measureDisc(terrain, gateway) {
  let worstDeg = 0;
  let worstAt = { x: gateway.x, z: gateway.z };
  const ringSteps = 48;
  const radialSteps = Math.max(2, Math.ceil(gateway.radiusM / STRIDE_M));

  // Sampled from a spiral in eight directions, so the measurement does not depend on the world axes
  // happening to line up with the hill. Measuring only along +X would pass a slope facing any other way.
  for (let r = 0; r <= radialSteps; r += 1) {
    const radius = (r / radialSteps) * gateway.radiusM;
    const steps = r === 0 ? 1 : ringSteps;
    for (let i = 0; i < steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      const x = gateway.x + Math.cos(a) * radius;
      const z = gateway.z + Math.sin(a) * radius;
      for (let d = 0; d < 8; d += 1) {
        const bearing = (d / 8) * Math.PI * 2;
        const deg = terrain.slopeDegreesAlong(x, z, Math.cos(bearing), Math.sin(bearing));
        if (deg > worstDeg) {
          worstDeg = deg;
          worstAt = { x, z };
        }
      }
    }
  }

  return { ...gateway, worstDeg, worstAt };
}

/**
 * Steepest gradient over a grid of the whole map, and how much of it exceeds the limit.
 *
 * ## Why this exists
 *
 * `coverHeight` sums every feature's contribution, so overlapping bumps **add**. Four individually gentle
 * features in a chain — each comfortably inside a driveable ratio — can produce a face twice as steep as
 * any of them alone. That is exactly what happened on the first draft of Cairn Height, and it is
 * invisible to inspection: each bump is authored to look reasonable and the result is a cliff.
 *
 * A whole-map sweep is the honest way to answer "how much of this battlefield is a hillside", which is
 * the question the owner rejected the previous map on. The headline number is `steepFraction`: the share
 * of the playable surface steeper than a comfortable driving gradient. A good rural map keeps this in
 * single digits; a mountain map is most of the map.
 */
function steepnessMap(terrain, climbLimit) {
  const half = terrain.halfSizeM;
  const stepM = 10;
  const steps = Math.floor((half * 2) / stepM);

  let total = 0;
  let tooSteep = 0;
  let comfortable = 0;
  // Every sample above the limit, so the report can name where the map is still a hillside rather than
  // only how much of it is. A percentage with no locations is a number nobody can act on.
  const steepSpots = [];

  for (let row = 0; row <= steps; row += 1) {
    const z = -half + row * stepM;
    for (let col = 0; col <= steps; col += 1) {
      const x = -half + col * stepM;
      // Steepest gradient in any of eight directions from this point.
      let deg = 0;
      for (let d = 0; d < 8; d += 1) {
        const bearing = (d / 8) * Math.PI * 2;
        const measured = terrain.slopeDegreesAlong(x, z, Math.cos(bearing), Math.sin(bearing));
        if (measured > deg) deg = measured;
      }
      total += 1;
      // "Comfortable" is deliberately well under the limit: a face at 25 degrees is technically climbable
      // and still feels like a wall. This is the number that tracks the felt experience rather than the
      // stated capability.
      if (deg <= 14) comfortable += 1;
      if (deg > climbLimit) {
        tooSteep += 1;
        steepSpots.push({ x, z, deg });
      }
    }
  }

  steepSpots.sort((a, b) => b.deg - a.deg);

  // Cluster the steep samples so the report names hills rather than listing 200 grid points. Two samples
  // belong to the same patch when they are within one grid step of each other.
  const clusters = [];
  for (const spot of steepSpots) {
    const near = clusters.find(
      (c) => Math.abs(c.x - spot.x) <= stepM && Math.abs(c.z - spot.z) <= stepM,
    );
    if (near) {
      near.count += 1;
      if (spot.deg > near.deg) {
        near.deg = spot.deg;
        near.x = spot.x;
        near.z = spot.z;
      }
    } else {
      clusters.push({ x: spot.x, z: spot.z, deg: spot.deg, count: 1 });
    }
  }

  return {
    stepM,
    samples: total,
    worstDeg: clusters.length > 0 ? clusters[0].deg : 0,
    worstAt: clusters.length > 0 ? { x: clusters[0].x, z: clusters[0].z } : { x: 0, z: 0 },
    steepFraction: tooSteep / total,
    comfortableFraction: comfortable / total,
    steepPatches: clusters
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map((c) => ({ x: c.x, z: c.z, deg: c.deg, samples: c.count })),
  };
}

function main() {
  const json = process.argv.includes('--json');
  return loadCore().then((core) => {
    const terrain = new core.Terrain(core.MARLOWE_CROSSING.terrain);
    const vehicle = core.PLACEHOLDER_TANK;
    const climbLimit = vehicle.ground.maxClimbDeg;
    const descendLimit = vehicle.ground.maxDescendDeg;

    const routes = ROUTES.map((r) => measureRoute(terrain, r));
    const gateways = GATEWAYS.map((g) => measureDisc(terrain, g));

    // Where on the map is the ground actually steep? Sampled on a grid rather than inferred from the
    // authored features, because the two disagree in a way that matters: `coverHeight` *adds* every
    // feature's contribution, so two overlapping gentle bumps are not gentle, they are steep. A hill
    // built from a chain has to be budgeted for that, and this is the number that catches it.
    const grid = steepnessMap(terrain, climbLimit);

    // A route fails when the tank *cannot* climb it. That bound is the vehicle's own limit rather than
    // a taste judgement, which is what keeps this a measurement instead of a preference.
    const failures = [
      ...routes
        .filter((r) => r.climbDeg > climbLimit)
        .map((r) => `${r.id}: climbs ${r.climbDeg.toFixed(1)}deg, limit ${climbLimit}deg`),
      ...routes
        .filter((r) => r.descentDeg > descendLimit)
        .map((r) => `${r.id}: descends ${r.descentDeg.toFixed(1)}deg, limit ${descendLimit}deg`),
      ...gateways
        .filter((g) => g.worstDeg > climbLimit)
        .map((g) => `${g.id}: ${g.worstDeg.toFixed(1)}deg within ${g.radiusM}m, limit ${climbLimit}deg`),
    ];

    const result = {
      map: core.MARLOWE_CROSSING.id,
      limits: { climbDeg: climbLimit, descendDeg: descendLimit },
      routes,
      gateways,
      steepness: grid,
      failures,
      pass: failures.length === 0,
    };

    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : format(result));
    process.exitCode = result.pass ? 0 : 1;
  });
}

function format(result) {
  const lines = [];
  lines.push(`Route gradients — ${result.map}`);
  lines.push(`vehicle limits: climb ${result.limits.climbDeg}deg, descend ${result.limits.descendDeg}deg`);
  lines.push('');
  lines.push('ROUTES (steepest sustained gradient along the line)');
  lines.push('  route                 length   climb   descend  verdict');
  for (const r of result.routes) {
    const verdict = r.climbDeg > result.limits.climbDeg ? 'UNDRIVEABLE' : 'ok';
    lines.push(
      `  ${r.id.padEnd(20)} ${String(r.lengthM).padStart(5)}m  ${r.climbDeg.toFixed(1).padStart(5)}  ${r.descentDeg.toFixed(1).padStart(7)}  ${verdict}`,
    );
  }
  lines.push('');
  lines.push('GATEWAYS (steepest gradient anywhere in the disc)');
  for (const g of result.gateways) {
    const verdict = g.worstDeg > result.limits.climbDeg ? 'UNDRIVEABLE' : 'ok';
    lines.push(
      `  ${g.id.padEnd(20)} r=${String(g.radiusM).padStart(3)}m  ${g.worstDeg.toFixed(1).padStart(5)}deg  at (${g.worstAt.x.toFixed(0)}, ${g.worstAt.z.toFixed(0)})  ${verdict}`,
    );
  }
  lines.push('');
  const s = result.steepness;
  lines.push('WHOLE MAP (grid of the playable surface)');
  lines.push(`  worst gradient anywhere     ${s.worstDeg.toFixed(1)}deg at (${s.worstAt.x.toFixed(0)}, ${s.worstAt.z.toFixed(0)})`);
  lines.push(`  comfortable (<= 14deg)     ${(s.comfortableFraction * 100).toFixed(1)}% of the map`);
  lines.push(`  steeper than the climb limit ${(s.steepFraction * 100).toFixed(1)}% of the map`);
  if (s.steepPatches.length > 0) {
    lines.push('  steepest patches (why the map is not yet fully gentle):');
    for (const p of s.steepPatches) {
      lines.push(`    (${String(p.x).padStart(4)}, ${String(p.z).padStart(4)})  ${p.deg.toFixed(1)}deg  ${p.samples} samples`);
    }
  }
  lines.push('');
  lines.push(result.pass ? 'PASS — every route is within the vehicle limits.' : 'FAIL');
  for (const f of result.failures) {
    lines.push(`  ${f}`);
  }
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
