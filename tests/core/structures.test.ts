import { describe, expect, it } from 'vitest';
import {
  placeStructures,
  structureAsObstacle,
  structureContains,
  structureHitSegment,
  type Structure,
} from '../../src/core/world/structures.js';
import { Battlefield } from '../../src/core/world/battlefield.js';
import { MARLOWE_CROSSING } from '../../src/core/world/maps/marlowe-crossing.js';
import { vec3 } from '../../src/shared/vec3.js';
import { SPOTTING_TUNING } from '../../src/core/spotting/spotting.js';

/**
 * V6 tests: hard cover.
 *
 * The property that matters most here is the one the V6 brief states as a requirement rather than a
 * nicety: **the simulation and the presentation must agree about what blocks a shot.** A structure that
 * exists only in the renderer is the failure these tests exist to prevent, so several of them assert
 * against a structure the map really contains rather than a synthetic one.
 */

/** A flat test world, so geometry assertions are about the structure and not about terrain. */
function flatBattlefield(structures: readonly Structure[]): Battlefield {
  return new Battlefield({
    id: 'test',
    displayName: 'Test',
    terrain: { seed: 1, halfSizeM: 200, amplitudeM: 0, edgeRiseM: 0 },
    structures,
    concealment: [],
    zones: [],
    playerSpawn: { x: 0, z: 0, headingRad: 0 },
    enemySpawn: { x: 0, z: 0, headingRad: 0 },
  });
}

const WALL: Structure = {
  id: 'wall',
  kind: 'building',
  x: 0,
  z: 0,
  halfLengthM: 5,
  halfWidthM: 1,
  heightM: 6,
  yawRad: 0,
  blocksSight: true,
};

describe('hard cover', () => {
  it('stops a shell travelling into it', () => {
    // The headline V6 guarantee, stated as a test: a shell does not pass through a building.
    const [placed] = placeStructures([WALL], () => 0);
    const hit = structureHitSegment(placed!, vec3(-20, 2, 0), vec3(20, 2, 0));

    expect(hit).not.toBeNull();
    // Entered at the near short face, x = -halfWidthM, not the far one.
    expect(hit!.point.x).toBeCloseTo(-WALL.halfWidthM, 6);
  });

  it('does not stop a shell that passes beside it', () => {
    const [placed] = placeStructures([WALL], () => 0);
    // Well outside the 5 m half-length, which runs along Z at yaw 0.
    expect(structureHitSegment(placed!, vec3(-20, 2, 8), vec3(20, 2, 8))).toBeNull();
  });

  it('reports the face it entered through, so a ricochet has a normal', () => {
    const [placed] = placeStructures([WALL], () => 0);
    const hit = structureHitSegment(placed!, vec3(-20, 2, 0), vec3(20, 2, 0));

    // Approaching from -X, the surface normal must point back at the shooter.
    expect(hit!.normal.x).toBeCloseTo(-1, 6);
    expect(hit!.normal.z).toBeCloseTo(0, 6);
  });

  it('is missed by a shot passing over the top', () => {
    // The height test is what makes a building a *tall* building. Without it, a 6 m wall would stop a
    // shell lobbed over it from a ridge, which is the opposite of what a wall is for.
    const [placed] = placeStructures([WALL], () => 0);
    expect(structureHitSegment(placed!, vec3(-20, 20, 0), vec3(20, 20, 0))).toBeNull();
  });

  it('stops shells at barrier height but lets sight over the top', () => {
    // The distinction the V6 brief asks for, and the reason `blocksSight` is a flag rather than a
    // height threshold. A waist-high barrier is cover against a shell and not against a sight line,
    // and collapsing the two would force a choice between two genuinely different pieces of cover.
    const barrier: Structure = { ...WALL, id: 'barrier', heightM: 1.3, blocksSight: false };
    const battlefield = flatBattlefield([barrier]);
    const from = vec3(-20, 2, 0);
    const to = vec3(20, 2, 0);

    // A shell at turret height is stopped...
    expect(structureHitSegment(battlefield.structures[0]!, from, to)).not.toBeNull();
    // ...but the same line of sight is clear, because a turret sight line clears 1.3 m.
    expect(battlefield.hasLineOfSight(from, to).clear).toBe(true);
  });

  it('rotates its footprint with its yaw, so a wall can sit at an angle', () => {
    // Yaw is what stops the map being a grid of axis-aligned boxes, and it has to affect both the
    // collision and the sight test or a rotated wall would be a lie in one of them.
    const angled: Structure = { ...WALL, id: 'angled', yawRad: Math.PI / 2 };
    const [placed] = placeStructures([angled], () => 0);

    // Yaw swaps the axes: the 5 m length now runs along X...
    const alongX = structureHitSegment(placed!, vec3(-20, 2, 0), vec3(20, 2, 0));
    expect(alongX).not.toBeNull();
    expect(alongX!.point.x).toBeCloseTo(-WALL.halfLengthM, 6);

    // ...and only the 1 m width faces along Z.
    const alongZ = structureHitSegment(placed!, vec3(0, 2, -20), vec3(0, 2, 20));
    expect(alongZ).not.toBeNull();
    expect(alongZ!.point.z).toBeCloseTo(-WALL.halfWidthM, 6);
  });

  it('sits on the ground the battlefield actually has, not a flat plane', () => {
    // A structure's height test is relative to the ground beneath it. Resolving that height at
    // construction rather than per ray is what keeps a wall on a hill from having a floating bottom.
    // Asserted against a real building on real terrain, which is the case that matters: a graded rail
    // corridor puts the station on ground a couple of metres above the field beside it.
    const battlefield = new Battlefield(MARLOWE_CROSSING);
    const station = battlefield.structures.find((s) => s.structure.id === 'station');

    expect(station).toBeDefined();
    const expected = battlefield.terrain.heightAt(station!.structure.x, station!.structure.z);
    expect(station!.groundHeightM).toBeCloseTo(expected, 9);
  });

  it('reports whether a point is inside a footprint', () => {
    const [placed] = placeStructures([WALL], () => 0);
    expect(structureContains(placed!, 0, 0)).toBe(true);
    // Along the 5 m half-length: inside, then outside.
    expect(structureContains(placed!, 0, 4)).toBe(true);
    expect(structureContains(placed!, 0, 6)).toBe(false);
    // Across the 1 m half-width: outside.
    expect(structureContains(placed!, 2, 0)).toBe(false);
  });

  it('adapts a structure to the shell obstacle contract, with a distinguishable id', () => {
    // The shell system identifies obstacles by id, so a wall sharing a namespace with a tank would
    // either be excluded by the shooter's own id or be mistaken for a vehicle in the combat report.
    const [placed] = placeStructures([WALL], () => 0);
    const obstacle = structureAsObstacle(placed!);

    expect(obstacle.vehicleId).not.toBe(WALL.id);
    expect(obstacle.vehicleId).toContain(WALL.id);
    expect(obstacle.hitSegment(vec3(-20, 2, 0), vec3(20, 2, 0))).not.toBeNull();
  });
});

describe('the map says one thing and the simulation agrees', () => {
  const battlefield = new Battlefield(MARLOWE_CROSSING);

  it('blocks a sight line through the station, and names the building that did it', () => {
    // Placed deliberately: a building the map claims is hard cover must actually break a sight line
    // between two vehicles at ground level. This is the test that would fail if cover were renderer
    // decoration and the simulation still believed in open ground.
    //
    // Asserted on a *flat* world carrying the real station building, rather than on the map's own
    // ground. On the real terrain the surrounding relief can block the line first, and the test would
    // then pass for the wrong reason — reporting "blocked" while never consulting the structure at all,
    // which is precisely the confusion this suite exists to prevent.
    const station = MARLOWE_CROSSING.structures.find((s) => s.id === 'station')!;
    const flat = flatBattlefield([station]);
    const result = flat.hasLineOfSight(
      vec3(station.x - 40, 2, station.z),
      vec3(station.x + 40, 2, station.z),
    );

    expect(result.clear).toBe(false);
    expect(result.blockedBy).toBe('structure');
    expect(result.blockerId).toBe('station');
  });

  it('leaves a clear sight line across the open fields', () => {
    // The counterpart, and the reason the map leaves its southern half bare. A map where every line of
    // sight is blocked is a map where nobody ever sees anyone, which is not a battlefield either.
    const from = vec3(-60, battlefield.terrain.heightAt(-60, 60) + 1.42, 60);
    const to = vec3(60, battlefield.terrain.heightAt(60, 60) + 1.42, 60);
    expect(battlefield.hasLineOfSight(from, to).clear).toBe(true);
  });

  it('hides a vehicle in the north hollow from one on the fields beside it', () => {
    // The hollows exist so there is somewhere to be *below* the sight line of the ground around them.
    // If a tank in one were visible from the field beside it, the feature would be decorative.
    const inHollow = vec3(-92, battlefield.terrain.heightAt(-92, -162) + 1.42, -162);
    const onField = vec3(-92, battlefield.terrain.heightAt(-92, -95) + 1.42, -95);
    expect(battlefield.hasLineOfSight(onField, inHollow).clear).toBe(false);
  });

  it('starts with the two sides in sight of each other, at a range that is actually playable', () => {
    // ## This assertion was inverted in this correction pass, and the reason is the point
    //
    // It previously asserted the spawns had **no** line of sight, on the reasoning that mutual blindness is a
    // tactical opening rather than a standoff. The owner played the build and reported being unable to find
    // the enemy at all. Measurement then showed the design was worse than a standoff:
    //
    //   - the opponent spawned **233 m** away, past the 200 m base sight range, so even a clear view could
    //     not produce contact;
    //   - driving straight at it revealed it **nowhere** within 200 m.
    //
    // So the opening was a search with no guarantee of a result, on a 500x500 m map, with no compass and no
    // marker. Hiding the only opponent at match start is defensible when there are many of them; for a
    // prototype containing exactly one it only creates wandering.
    //
    // The brief is explicit that the goal is "I know where the fight is", not "spend several minutes locating
    // one tank". So the property is now inverted: contact exists at spawn, and at a range inside the spotting
    // band rather than a free point-blank shot. The findability details are pinned in
    // `rural-railway-map.test.ts`; this test keeps the map and the simulation agreeing about it.
    const a = battlefield.playerSpawn;
    const b = battlefield.enemySpawn;
    const from = vec3(a.x, battlefield.terrain.heightAt(a.x, a.z) + 1.42, a.z);
    const to = vec3(b.x, battlefield.terrain.heightAt(b.x, b.z) + 1.42, b.z);

    const rangeM = Math.hypot(b.x - a.x, b.z - a.z);
    expect(battlefield.hasLineOfSight(from, to).clear, 'the opening must offer contact').toBe(true);
    // Inside spotting range, so the view is actionable, and not so close it is a coin-flip.
    expect(rangeM).toBeLessThan(SPOTTING_TUNING.baseSightRangeM);
    expect(rangeM).toBeGreaterThan(90);
  });

  it('puts a low wall that shells stop at on the map, as well as one sight passes over', () => {
    // The `blocksSight` distinction is only learnable if both kinds exist somewhere a player will meet
    // them. Asserted against the real map rather than synthetic walls, so deleting one of the pairs is
    // a test failure rather than a silent loss of a mechanic from the level design.
    const sightBlocking = MARLOWE_CROSSING.structures.filter((s) => s.blocksSight && s.kind === 'barrier');
    const seeOver = MARLOWE_CROSSING.structures.filter((s) => !s.blocksSight);

    expect(sightBlocking.length).toBeGreaterThan(0);
    expect(seeOver.length).toBeGreaterThan(0);
  });
});
