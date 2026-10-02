import { describe, expect, it } from 'vitest';
import { Terrain, type LevelCorridor } from '../../src/core/world/terrain.js';
import { Battlefield } from '../../src/core/world/battlefield.js';
import { MARLOWE_CROSSING } from '../../src/core/world/maps/marlowe-crossing.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import { SPOTTING_TUNING } from '../../src/core/spotting/spotting.js';

/**
 * V6 battlefield correction: the rural railway map, and the graded corridors it is built on.
 *
 * ## What these tests exist to prevent
 *
 * The previous V6 map was rejected by the owner for one reason: too much of the playable surface was
 * steep, so driving a tank felt like fighting a mountainside. Nothing in a screenshot catches that. A 20
 * degree slope seen from 150 m up is gentle shading.
 *
 * So the property is asserted as **measurement**, on the real map, against the real vehicle's own limits:
 * every primary route, both spawns, the level crossing and the approaches to cover are walked and sampled,
 * and the steepest sustained gradient on each is compared with what the tank can actually climb. A comment
 * promising the map is gentle is worth nothing; these are the numbers.
 *
 * The companion tool `tools/measure-routes.mjs` does the same walk and prints it, so the same evidence is
 * available when tuning rather than only when the build runs.
 */

/** A corridor under test, on ground that is deliberately not level. */
const TEST_CORRIDOR: LevelCorridor = {
  id: 'test-corridor',
  points: [
    { x: -200, y: 0, z: 0 },
    { x: 200, y: 0, z: 0 },
  ],
  halfWidthM: 10,
  blendM: 40,
};

/** Terrain with a corridor graded across it, and otherwise gently rolling ground. */
function terrainWithCorridor(corridor: LevelCorridor, amplitudeM = 4): Terrain {
  return new Terrain({
    seed: 7,
    halfSizeM: 400,
    amplitudeM,
    edgeRiseM: 0,
    bowlDepthM: 0,
    levelCorridors: [corridor],
  });
}

describe('graded corridors', () => {
  it('leaves ground outside its reach completely untouched', () => {
    // The single most important property, and the one a careless implementation breaks. The offset is
    // added to the natural height on every sample, so a version returning the corridor's height rather
    // than its *difference* would double the terrain everywhere — turning the whole map into a hill while
    // every corridor-specific test still passed. That bug happened; this is its regression test.
    const bare = new Terrain({ seed: 7, halfSizeM: 400, amplitudeM: 4, edgeRiseM: 0 });
    const graded = terrainWithCorridor(TEST_CORRIDOR);

    for (const [x, z] of [[-200, 120], [0, 150], [180, -90], [150, 120], [-180, -160]]) {
      expect(graded.heightAt(x, z), `at ${x},${z}`).toBeCloseTo(bare.heightAt(x, z), 9);
    }
  });

  it('holds the ground level along the centreline, whatever the natural terrain does', () => {
    // The feature's whole purpose. Without it a railway drawn over undulating ground is a ride.
    //
    // Amplitude 2 m rather than something larger, and that choice is deliberate. The corridor's cut depth is
    // soft-clamped to 4 m so a badly authored line cannot build a cliff, and on terrain with a 6 m amplitude
    // the clamp — not the grading — is what limits the result. At 2 m the clamp stays out of the way and this
    // measures the grading. The clamp's own behaviour is asserted separately, below.
    const bare = new Terrain({ seed: 7, halfSizeM: 400, amplitudeM: 2, edgeRiseM: 0 });
    const graded = terrainWithCorridor(TEST_CORRIDOR, 2);

    let bareSpread = 0;
    let gradedSpread = 0;
    for (let x = -190; x <= 190; x += 2) {
      bareSpread = Math.max(bareSpread, Math.abs(bare.heightAt(x, 0)));
      gradedSpread = Math.max(gradedSpread, Math.abs(graded.heightAt(x, 0)));
    }

    // The premise: the natural ground really is uneven along this line.
    expect(bareSpread).toBeGreaterThan(0.5);
    // And the corridor removes most of that.
    expect(gradedSpread).toBeLessThan(bareSpread * 0.4);
  });

  it('flattens the centreline far more than the ground beside it', () => {
    // The comparison that isolates the corridor's own effect. On and just off the line the underlying
    // terrain is the same, so any difference in flatness is the grading and nothing else.
    const terrain = terrainWithCorridor(TEST_CORRIDOR, 6);

    const spread = (z: number): number => {
      let worst = 0;
      for (let x = -180; x <= 180; x += 4) {
        worst = Math.max(worst, Math.abs(terrain.heightAt(x, z)));
      }
      return worst;
    };

    // Off the corridor's reach entirely, so this is pure natural terrain.
    expect(spread(400)).toBeGreaterThan(spread(0));
  });

  it('eases back to natural ground, and does so without a step', () => {
    // Sampled finely across the blend band. A discontinuity here would be felt as a jolt when driving off
    // the railway, and would also break `slopeDegreesAlong`, which is what the AI navigates with.
    const bare = new Terrain({ seed: 7, halfSizeM: 400, amplitudeM: 6, edgeRiseM: 0 });
    const graded = terrainWithCorridor(TEST_CORRIDOR, 6);

    let previous = graded.heightAt(0, 0);
    for (let z = 0.5; z <= 80; z += 0.5) {
      const h = graded.heightAt(0, z);
      // Converged on natural ground by the outer edge of the blend. The tolerance is centimetres because
      // the smoothstep is asymptotically, not exactly, zero there.
      if (z >= TEST_CORRIDOR.halfWidthM + TEST_CORRIDOR.blendM) {
        expect(Math.abs(h - bare.heightAt(0, z)), `at z=${z}`).toBeLessThan(0.02);
      }
      // Never jumps: the natural terrain itself changes slowly here, so any large step is a crease.
      expect(Math.abs(h - previous), `step at z=${z}`).toBeLessThan(0.35);
      previous = h;
    }
  });

  it('cannot be authored into a wall, however far off the natural ground it is placed', () => {
    // A corridor 20 m below the surrounding ground would, with the falloff alone, build a 20 m bank. The
    // soft clamp is what stops that, and this is the test that justifies its existence.
    const deep: LevelCorridor = {
      ...TEST_CORRIDOR,
      points: [
        { x: -200, y: -20, z: 0 },
        { x: 200, y: -20, z: 0 },
      ],
    };
    const terrain = terrainWithCorridor(deep, 6);
    const bare = new Terrain({ seed: 7, halfSizeM: 400, amplitudeM: 6, edgeRiseM: 0 });

    // The cut is real: the ground sits below the same ground without the corridor.
    const cut = bare.heightAt(0, 0) - terrain.heightAt(0, 0);
    expect(cut).toBeGreaterThan(1);
    // But bounded, whatever was asked for.
    expect(cut).toBeLessThanOrEqual(4.01);

    // And it never becomes unclimbable, measured across the crossing direction.
    for (let z = -60; z <= 60; z += 2) {
      expect(terrain.slopeDegreesAlong(0, z, 0, 1), `at z=${z}`).toBeLessThan(
        PLACEHOLDER_TANK.ground.maxClimbDeg,
      );
    }
  });

  it('resolves crossing corridors to the stronger one rather than compounding them', () => {
    // Where the town road meets the railway. Compounding would build a crease at the junction, which is
    // the most visible possible place for one.
    const terrain = new Terrain({
      seed: 7,
      halfSizeM: 400,
      amplitudeM: 3,
      edgeRiseM: 0,
      levelCorridors: [
        TEST_CORRIDOR,
        { id: 'cross', points: [{ x: 0, y: 0, z: -200 }, { x: 0, y: 0, z: 200 }], halfWidthM: 8, blendM: 30 },
      ],
    });

    // The junction is level to within a few centimetres, in every direction, and does not crease: the
    // steepest gradient anywhere across it is a couple of degrees.
    for (let ring = 0; ring <= 6; ring += 1) {
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        const x = Math.cos(a) * ring;
        const z = Math.sin(a) * ring;
        expect(terrain.slopeDegreesAlong(x, z, Math.cos(a), Math.sin(a)), `at ${x},${z}`).toBeLessThan(5);
      }
    }
  });
});

describe('the battlefield is drivable', () => {
  const battlefield = new Battlefield(MARLOWE_CROSSING);
  const terrain = battlefield.terrain;
  const { maxClimbDeg, maxDescendDeg } = PLACEHOLDER_TANK.ground;

  /** Steepest sustained gradient along a straight line, in each direction. */
  function worstGradient(from: { x: number; z: number }, to: { x: number; z: number }) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lengthM = Math.sqrt(dx * dx + dz * dz);
    // Unit direction. `slopeDegreesAlong` projects onto the gradient directly, so a non-unit direction
    // reports a gradient scaled by its length.
    const dirX = dx / lengthM;
    const dirZ = dz / lengthM;
    let climb = 0;
    let descend = 0;
    for (let i = 0; i <= 60; i += 1) {
      const t = i / 60;
      climb = Math.max(climb, terrain.slopeDegreesAlong(from.x + dx * t, from.z + dz * t, dirX, dirZ));
      descend = Math.max(
        descend,
        terrain.slopeDegreesAlong(from.x + dx * t, from.z + dz * t, -dirX, -dirZ),
      );
    }
    return { climb, descend };
  }

  /**
   * Steepest gradient anywhere within a radius of a point.
   *
   * Sampled on a spiral in eight directions rather than along one axis, because a slope facing any
   * direction other than the one sampled reads as flat. A spawn that is gentle along +X and a cliff
   * facing north is not a usable spawn, and only a direction-agnostic measurement notices.
   */
  function worstGradientNear(x: number, z: number, radiusM: number): number {
    let worst = 0;
    const rings = Math.max(2, Math.ceil(radiusM / 2));
    for (let r = 0; r <= rings; r += 1) {
      const radius = (r / rings) * radiusM;
      const steps = r === 0 ? 1 : 32;
      for (let i = 0; i < steps; i += 1) {
        const a = (i / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * radius;
        const pz = z + Math.sin(a) * radius;
        for (let d = 0; d < 8; d += 1) {
          const bearing = (d / 8) * Math.PI * 2;
          worst = Math.max(
            worst,
            terrain.slopeDegreesAlong(px, pz, Math.cos(bearing), Math.sin(bearing)),
          );
        }
      }
    }
    return worst;
  }

  /** The primary routes, in the terms the map's design is written in. */
  const ROUTES = [
    { id: 'field route', from: { x: -125, z: 80 }, to: { x: 120, z: 130 } },
    { id: 'railway route', from: { x: -160, z: -44 }, to: { x: 120, z: -18 } },
    { id: 'crossing approach', from: { x: 33, z: 130 }, to: { x: 33, z: -28 } },
    { id: 'town route', from: { x: 33, z: -28 }, to: { x: 20, z: -100 } },
    { id: 'elevated flank', from: { x: 33, z: -28 }, to: { x: 165, z: -165 } },
    { id: 'the player opening approach', from: { x: -125, z: 80 }, to: { x: 33, z: -28 } },
    // Now measured from the opponent's current spawn rather than the previous (65, -55), which this pass moved
  // because it was 233 m away and invisible. Kept as a route so the opening approach stays drivable.
  { id: 'the opponent opening approach', from: { x: -30, z: -10 }, to: { x: 33, z: -28 } },
  ] as const;

  it.each(ROUTES)('can be driven along the $id', ({ id, from, to }) => {
    const { climb, descend } = worstGradient(from, to);
    expect(climb, `climb along the ${id}`).toBeLessThan(maxClimbDeg);
    expect(descend, `descent along the ${id}`).toBeLessThan(maxDescendDeg);
  });

  it('keeps the primary routes comfortably gentle, not merely passable', () => {
    // The weaker assertion above only proves the map is not impossible. This one states the product
    // requirement: **most ordinary movement should happen on flat or gently rolling ground.** A route at
    // the vehicle's limit is technically drivable and still feels like a mountainside, which is the exact
    // complaint the previous map drew.
    const COMFORTABLE_DEG = 18;
    for (const route of ROUTES) {
      const { climb } = worstGradient(route.from, route.to);
      expect(climb, `${route.id} is too steep to feel like ordinary driving`).toBeLessThan(
        COMFORTABLE_DEG,
      );
    }
  });

  it.each([
    { id: 'the player spawn', x: MARLOWE_CROSSING.playerSpawn.x, z: MARLOWE_CROSSING.playerSpawn.z, r: 12 },
    { id: 'the opponent spawn', x: MARLOWE_CROSSING.enemySpawn.x, z: MARLOWE_CROSSING.enemySpawn.z, r: 12 },
    { id: 'the level crossing', x: 33, z: -28, r: 14 },
    { id: 'the village approach', x: 33, z: -100, r: 12 },
    { id: 'the field centre', x: -20, z: 130, r: 20 },
  ])('leaves the ground around $id flat enough to manoeuvre on', ({ x, z, r }) => {
    expect(worstGradientNear(x, z, r)).toBeLessThan(maxClimbDeg);
  });

  it('leaves the level crossing genuinely flat, so the railway is a road and not a kerb', () => {
    // The specific promise of a graded crossing. A lip of even 40 cm is crossable and still feels broken,
    // and the town road's elevation is pinned to the mainline's at this point precisely to guarantee it.
    //
    // Asserted as a gradient rather than as a height difference: what the player feels is the slope, and a
    // slope is what a tank actually has to climb. Three degrees is a driveway, not a kerb.
    for (let ring = 0; ring <= 12; ring += 2) {
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        const x = 33 + Math.cos(a) * ring;
        const z = -28 + Math.sin(a) * ring;
        expect(terrain.slopeDegreesAlong(x, z, Math.cos(a), Math.sin(a)), `at ${x},${z}`).toBeLessThan(3);
      }
    }
  });

  it('is mostly gentle ground, which is the property the previous map failed', () => {
    // Swept over the whole playable surface. This is the number the owner's complaint actually refers to,
    // and it is asserted on the map rather than asserted in a comment.
    const COMFORTABLE_DEG = 14;
    const half = terrain.halfSizeM;
    let comfortable = 0;
    let total = 0;
    for (let x = -half; x <= half; x += 10) {
      for (let z = -half; z <= half; z += 10) {
        total += 1;
        if (worstGradientNear(x, z, 0) <= COMFORTABLE_DEG) {
          comfortable += 1;
        }
      }
    }
    // The measured value on the current map is about 72%. Asserted well below the rejected map's profile
    // rather than at the exact figure, so an ordinary terrain tweak does not break the build — but a
    // regression back to "most of this is a hillside" does.
    expect(comfortable / total).toBeGreaterThan(0.6);
  });
});

/**
 * The single opponent has to be findable.
 *
 * ## Why this is a test and not a preference
 *
 * The previous V6 opening was authored deliberately: both tanks spawned without line of sight, on the
 * reasoning that mutual blindness is a tactical opening rather than a standoff. The owner played it and could
 * not find the enemy at all. Measuring it against the real `Battlefield.hasLineOfSight` showed the design was
 * far worse than "no line of sight" — the opponent was **233 m** away, past the 200 m base sight range, and
 * driving straight at it revealed it nowhere within 200 m.
 *
 * So the opening geometry was independently broken, quite apart from the control bugs, and it needed
 * correcting on its own evidence. These tests pin the corrected property so a later map tweak cannot quietly
 * restore a search with no guarantee of a result.
 *
 * `tools/measure-contact.mjs` prints the same survey for tuning.
 */
describe('the opponent is findable from the opening', () => {
  const field = new Battlefield(MARLOWE_CROSSING);
  const player = MARLOWE_CROSSING.playerSpawn;
  const enemy = MARLOWE_CROSSING.enemySpawn;

  /** Turret-roof eye height on both tanks, matching what the spotting system reasons about. */
  const eye = (x: number, z: number) => ({
    x,
    y: field.terrain.heightAt(x, z) + PLACEHOLDER_TANK.turret.ringHeightM,
    z,
  });

  const openingRange = Math.hypot(enemy.x - player.x, enemy.z - player.z);
  const bearingToEnemy = Math.atan2(enemy.x - player.x, enemy.z - player.z);

  it('starts inside the spotting band, so the view is immediately actionable', () => {
    // Beyond `baseSightRangeM` (200 m) the opening view cannot produce contact at all, which is precisely how
    // the previous 233 m spawn failed. Asserted against the tuning constant rather than a copied literal so
    // the two cannot drift apart.
    //
    // The upper bound is deliberately the spotting band and *not* the opponent's 130 m firing limit. A
    // separation it cannot shoot across is still a perfectly good opening: the player can see it, range it and
    // close, and gets a few seconds to decide how to do that. Pinning it to the AI's own band would make
    // every future decision about that limit silently constrain the map as well, which is the coupling this
    // test is trying to avoid.
    expect(openingRange, 'the opponent must start within spotting range').toBeLessThan(
      SPOTTING_TUNING.baseSightRangeM,
    );
    // And not so close that the opening is a muzzle duel with no chance to react.
    expect(openingRange).toBeGreaterThan(90);
  });

  it('gives the player time to react before the first shot is likely', () => {
    // The one risk of making the opponent visible at spawn is an unavoidable opening hit. At 146 m the player
    // has roughly two seconds of the opponent's approach before it is inside its own firing band, and the
    // opponent still has to traverse its turret. Asserted as a range rather than as a simulation of the
    // opponent's behaviour, because the thing being guaranteed is *map geometry*, not AI timing — the AI is
    // explicitly out of scope for this pass.
    expect(openingRange).toBeGreaterThan(120);
  });

  it('is already visible to the player at spawn, with no driving required', () => {
    // The property the owner asked for: "I know where the fight is", not "spend several minutes locating one
    // tank". Measured through the same `hasLineOfSight` the simulation uses, so a cottage or swell that would
    // genuinely block the view fails this rather than being argued away.
    expect(
      field.hasLineOfSight(eye(player.x, player.z), eye(enemy.x, enemy.z), 64, 0.6).clear,
      'the opponent must be visible from the player spawn',
    ).toBe(true);
  });

  it('sits within the arc the player is already facing at spawn', () => {
    // Visible but off to one side would still be a hunt. 30 degrees is generous: the opening heading frames
    // the level crossing and the village, so a little lateral offset is intended and fine.
    const offsetDeg = ((((bearingToEnemy - player.headingRad) * 180) / Math.PI + 540) % 360) - 180;
    expect(Math.abs(offsetDeg), 'the opponent must be within the opening frame').toBeLessThan(30);
  });

  it('faces the player, so the opening is a duel rather than an ambush', () => {
    // Now that contact exists at spawn this matters in a way it did not before: an opponent broadside to the
    // player hands them the flank for free, and one facing away gives the player an unanswered first shot.
    // Facing the player presents the strongest frontal armour, which is the point the original spawn pair
    // was also trying to make - it just could not deliver it through 233 m of intervening ground.
    const bearingToPlayer = Math.atan2(player.x - enemy.x, player.z - enemy.z);
    const facingErrDeg =
      Math.abs(((((bearingToPlayer - enemy.headingRad) * 180) / Math.PI + 540) % 360) - 180);
    expect(facingErrDeg, 'the opponent must face the player').toBeLessThan(5);
  });

  it('can close from its spawn to inside its own firing band', () => {
    // ## The property that a findability-only check would have missed
    //
    // Two candidate spawns satisfied every visibility test above - visible at 146 m, 2 degrees off the
    // opening heading - and both scored **zero damage** against a parked player across every seed. Both sat
    // on the central swell, and an opponent perched there cannot manoeuvre against a player at its foot: it
    // holds at long range and the fight never starts.
    //
    // That is a findable opening which is not a playable one, and it was found by running the real opponent
    // controller rather than by reasoning about the map. `tools/measure-contact.mjs` prints the comparison.
    //
    // What is asserted here is the cheap geometric proxy: the ground from the opponent's spawn to the
    // player's own position must be drivable, so closing is possible at all. This is not the AI's decision to
    // make - the AI is out of scope for this pass - but a spawn the opponent physically cannot leave is a
    // map bug rather than a tactics problem.
    const steps = 20;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const x = enemy.x + (player.x - enemy.x) * t;
      const z = enemy.z + (player.z - enemy.z) * t;
      const dirX = (player.x - enemy.x) / openingRange;
      const dirZ = (player.z - enemy.z) / openingRange;
      expect(
        field.terrain.slopeDegreesAlong(x, z, dirX, dirZ),
        `closing gradient at ${x.toFixed(0)},${z.toFixed(0)}`,
      ).toBeLessThan(PLACEHOLDER_TANK.ground.maxClimbDeg);
    }
  });
});
