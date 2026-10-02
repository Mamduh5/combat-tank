/**
 * Reports what the V6 battlefield actually contains, from the running game.
 *
 * Exists because "the environment art loaded without throwing" and "the environment is on the map and
 * matches the simulation" are different claims, and only the second one is the one that matters. Every
 * number here is read from the same objects the simulation uses, so a disagreement between the picture
 * and the physics is visible rather than merely suspected.
 */
(() => {
  const g = globalThis.__combatTank;
  const sim = g.simulation;
  const field = sim.battlefield;
  const props = g.props;

  const structures = field.structures.map((s) => ({
    id: s.structure.id,
    kind: s.structure.kind,
    blocksSight: s.structure.blocksSight,
    heightM: s.structure.heightM,
  }));

  const concealment = field.concealment.map((z) => ({
    id: z.id,
    strength: z.strength,
    radiusM: z.radiusM,
  }));

  return {
    map: { id: field.id, name: field.displayName, halfSizeM: field.halfSizeM },
    terrain: {
      minHeightM: round(minOver(field.terrain), 2),
      maxHeightM: round(maxOver(field.terrain), 2),
    },
    structures: {
      count: structures.length,
      blockingSight: structures.filter((s) => s.blocksSight).length,
      list: structures,
    },
    concealment: { count: concealment.length, list: concealment },
    zones: field.zones.map((z) => ({ id: z.id, role: z.role })),
    spawns: { player: field.playerSpawn, enemy: field.enemySpawn },
    props: {
      meshes: props?.meshCount ?? 0,
      trees: props?.treeCount ?? 0,
      bushes: props?.bushCount ?? 0,
    },
    terrainProfile: profileAlong(field.terrain, -220, 220, 0, 40),
    contact: sim.playerContact.contact.state,
    playerConcealment: sim.playerConcealment.concealed
      ? sim.playerConcealment.strongestZoneId
      : null,
  };
})();

/** Ground height along a line, so a viewpoint can be chosen above it rather than guessed. */
function profileAlong(terrain, fromX, toX, z, step) {
  const out = [];
  for (let x = fromX; x <= toX; x += step) {
    out.push([x, Math.round(terrain.heightAt(x, z))]);
  }
  return out;
}

/** Highest and lowest ground on the map, sampled on a coarse grid. Enough to prove relief exists. */
function minOver(terrain) {
  let min = Infinity;
  for (let x = -220; x <= 220; x += 20) {
    for (let z = -220; z <= 220; z += 20) {
      min = Math.min(min, terrain.heightAt(x, z));
    }
  }
  return min;
}

function maxOver(terrain) {
  let max = -Infinity;
  for (let x = -220; x <= 220; x += 20) {
    for (let z = -220; z <= 220; z += 20) {
      max = Math.max(max, terrain.heightAt(x, z));
    }
  }
  return max;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
