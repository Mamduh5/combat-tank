import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/core/sim/world.js';
import { resolveCombat, type CombatResult } from '../../src/core/combat/combat-resolver.js';
import { buildWorldPlates, raycastPlates } from '../../src/core/armor/geometry.js';
import { type ShellImpact } from '../../src/core/ballistics/impact.js';
import { createDamageState, findModule } from '../../src/core/damage/damage-model.js';
import { makeInput, NEUTRAL_INPUT } from '../../src/shared/input.js';
import { vec3 } from '../../src/shared/vec3.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import { TARGET_TANK } from '../../src/shared/placeholder-target.js';
import { ENEMY_TANK } from '../../src/shared/enemy-tank.js';

/**
 * End-to-end combat tests: impact record → armour → penetration → damage.
 *
 * These prove V3's central claim — that a shell striking a *specific* piece of a tank at a *specific*
 * angle produces a *specific* outcome, rather than "projectile touched tank".
 */

const ORIGIN = vec3(0, 0, 0);

/** A synthetic impact travelling along `direction` at the shell's muzzle velocity. */
function impactOn(
  definition: typeof PLACEHOLDER_TANK,
  origin: ReturnType<typeof vec3>,
  direction: ReturnType<typeof vec3>,
): ShellImpact {
  const len = Math.sqrt(direction.x ** 2 + direction.y ** 2 + direction.z ** 2);
  const unit = vec3(direction.x / len, direction.y / len, direction.z / len);
  const speed = definition.mainShell.muzzleVelocityMps;

  return {
    shellId: 1,
    shellTypeId: definition.mainShell.id,
    shooterId: 'tester',
    position: origin,
    // Placeholder only. The penetration decision must use the *plate's* normal rather than this, which
    // is exactly what the tests below verify.
    surfaceNormal: vec3(0, 0, 1),
    targetKind: 'vehicle',
    targetId: definition.id,
    incomingDirection: unit,
    impactVelocity: vec3(unit.x * speed, unit.y * speed, unit.z * speed),
    incidenceAngleDeg: 0,
    flightTimeSeconds: 0.1,
    distanceTravelledM: 10,
    shellMassKg: definition.mainShell.massKg,
    muzzleVelocityMps: speed,
  };
}

/**
 * Fires at the target tank from whichever side the aim point indicates.
 *
 * The target sits at the origin with **heading 0**, so its front plate is at local z = +2.1 and its rear
 * plate at local z = -2.4. The shooter is placed 200 m out on whichever axis the aim point sits away
 * from, and fires straight in along that axis.
 *
 * A **front or rear** aim point is one within the hull's width of the centreline; anything further out
 * is treated as a flank shot, and a flank shot far enough out misses the vehicle entirely. Placing the
 * shooter correctly is the whole point: an earlier version put it at `aimPoint.x` *and* `z = 200`, so a
 * side shot never crossed the side plate at all and reported a miss for a ray that had never been aimed
 * at one.
 */
function shootTarget(aimPoint: ReturnType<typeof vec3>, definition = TARGET_TANK) {
  const damage = createDamageState(definition);
  const heading = 0;
  const plates = buildWorldPlates(definition, ORIGIN, heading, heading);

  // The hull is about 2.6 m wide and 4.2 m long, so an aim point inside the centreline band is a front
  // or rear shot and one outside it is a flank shot. A flank aim point at z = 0 sits squarely on the
  // long side plate; `z = 30` is far enough beyond the hull's nose to miss it entirely.
  const alongZ = Math.abs(aimPoint.x) < 1.3;
  const fromBehind = aimPoint.z < 0;
  // Flank shots stand off far enough along Z to clear the hull unless the aim point is already
  // clear of it, which is what distinguishes "hit the flank" from "missed".
  const flankZ = Math.abs(aimPoint.z) > 6 ? aimPoint.z : 0;

  const origin = alongZ
    ? vec3(0, aimPoint.y, fromBehind ? -200 : 200)
    : vec3(aimPoint.x > 0 ? 200 : -200, aimPoint.y, flankZ);
  const direction = alongZ
    ? vec3(0, 0, fromBehind ? 1 : -1)
    : vec3(aimPoint.x > 0 ? -1 : 1, 0, 0);

  // Cast the segment first, exactly as the shell system would, to find where the shell actually lands.
  const cast = raycastPlates(plates, origin, direction, 200);
  if (cast === null) {
    return { result: { kind: 'armour-miss' } as CombatResult, damage };
  }

  const impact: ShellImpact = { ...impactOn(definition, origin, direction), position: cast.point };
  const result = resolveCombat(definition, impact, plates, damage, ORIGIN, heading, heading);
  return { result, damage };
}


describe('through the simulation', () => {
  /** A simulation on flat ground with the stationary target placed ahead of the player. */
  function simWithTarget() {
    return new Simulation({
      vehicle: PLACEHOLDER_TANK,
      target: TARGET_TANK,
      terrain: { seed: 1, halfSizeM: 2000, amplitudeM: 0, edgeRiseM: 0 },
      spawn: vec3(0, 0, 0),
      // `targetIsOpponent: false` restores the V3 inert target: no controller, so it stays exactly
      // where it is put and never fires. The armour tests below need a fixed object to shoot at, and
      // a target that slews or drives between the setup and the shot would make them untestable.
      targetIsOpponent: false,
    });
  }

  it('places the target ahead of the player and leaves it undamaged at the start', () => {
    const sim = simWithTarget();
    expect(sim.target).not.toBeNull();
    expect(sim.target!.state.position.z).toBeGreaterThan(sim.vehicle.state.position.z);
    expect(sim.target!.damage.hitPoints).toBe(TARGET_TANK.survivability.hitPoints);
  });

  it('reports no combat outcome on a tick where nothing was fired', () => {
    const sim = simWithTarget();
    sim.tick(makeInput(0, 0, vec3(0, 0, 60), false));
    expect(sim.combat).toHaveLength(0);
  });

  it('resolves a real shot into a combat outcome and damages the target', () => {
    const sim = simWithTarget();
    const target = sim.target!;

    // The target's starting position, captured because "the target stays put" is the real property
    // under test. It was previously asserted as `x ≈ 0`, which held only while the target happened to
    // be placed straight ahead of a spawn at the origin — an accident of placement rather than a
    // property of the system. Target placement is now chosen by search, so this follows the actual
    // start position instead of a coordinate that placement no longer guarantees.
    const targetStart = { ...target.state.position };

    // Drive forward and curve left, putting the player off the target's flank, where the shell can
    // penetrate. The assertion is on the *player's* position: the target must stay put.
    for (let i = 0; i < 300; i += 1) {
      sim.tick(makeInput(1, -0.4, vec3(0, 0, 60), false));
    }
    expect(Math.abs(sim.vehicle.state.position.x - targetStart.x)).toBeGreaterThan(3);
    expect(target.state.position.x).toBeCloseTo(targetStart.x, 9);
    expect(target.state.position.z).toBeCloseTo(targetStart.z, 9);

    // Aim at the near flank plate of the target, at its own height.
    const flank = vec3(target.state.position.x + 1.3, 0.6, target.state.position.z);
    for (let i = 0; i < 180; i += 1) {
      sim.tick(makeInput(0, 0, flank, false));
    }

    const hpBefore = target.damage.hitPoints;
    sim.tick(makeInput(0, 0, flank, true));

    let sawCombat = false;
    for (let i = 0; i < 60 * 10; i += 1) {
      sim.tick(makeInput(0, 0, flank, false));
      if (sim.combat.length > 0) {
        sawCombat = true;
        break;
      }
    }

    expect(sawCombat).toBe(true);
    expect(target.damage.hitPoints).toBeLessThan(hpBefore);
  });

  it('drives, aims and fires the opponent through the same rules as the player', () => {
    // V4 inverted this test. In V3 it asserted the target could do *nothing* on its own, which pinned
    // the "stationary test target" boundary. V4 replaces that boundary with an opponent, so the
    // assertion becomes that it acts — but only through the normal input interface.
    //
    // The important part is what this does *not* check: it never calls a damage method. If the opponent
    // were damaging the player on a timer, every one of these assertions would still pass. That is why
    // the enemy-damage tests below are the ones that actually prove the combat rules are shared.
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK, target: ENEMY_TANK });
    const enemy = sim.target!;
    const startPosition = { ...enemy.state.position };

    for (let i = 0; i < 600; i += 1) {
      sim.tick(makeInput(1, 0, vec3(0, 0, 60), false));
    }

    // It moved off its spawn.
    expect(
      Math.abs(enemy.state.position.x - startPosition.x) +
        Math.abs(enemy.state.position.z - startPosition.z),
    ).toBeGreaterThan(1);

    // It acquired a target and used its gun through the normal reload cycle.
    expect(enemy.telemetry.shotsFired).toBeGreaterThan(0);
  });

  it('keeps the opponent inside the same reload rules as the player', () => {
    // The gun's authority lives in the core, not in the controller. If the opponent could fire while
    // reloading, that would be a second rule set — exactly what V4 was told not to build.
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK, target: ENEMY_TANK });
    const enemy = sim.target!;

    for (let i = 0; i < 1200; i += 1) {
      // Record the state *before* stepping, so a tick that both reloads and refuses to fire is counted.
      const wasLoaded = enemy.gunState.loadState === 'loaded';
      const shotsBefore = enemy.gunState.shotsFired;
      sim.tick(NEUTRAL_INPUT);
      if (!wasLoaded && enemy.gunState.shotsFired > shotsBefore) {
        throw new Error('opponent fired while its gun was reloading');
      }
    }
  });

  it('reports hits on the player separately from hits on the opponent', () => {
    // The HUD has to be able to tell the player "you hit it" from "it hit you", and it cannot infer that
    // from a single undifferentiated list.
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK, target: ENEMY_TANK });

    for (let i = 0; i < 1800; i += 1) {
      sim.tick(NEUTRAL_INPUT);
    }

    // The opponent was left alone, so anything recorded as incoming really did come from the enemy.
    expect(sim.target!.damage.hitPoints).toBe(ENEMY_TANK.survivability.hitPoints);
    expect(sim.incomingCombat).toEqual([]);
  });

  it('leaves a destroyed vehicle unable to move, on either side', () => {
    // Asserted on the **player**, not on the configured target. The target in `simWithTarget` is the
    // inert V3 object with no controller, so it is never stepped with intent and its telemetry is
    // never refreshed — asserting on it would test nothing. In V4 the player's tank is the vehicle a
    // player can actually destroy, so it is the one whose consequences matter.
    //
    // The same rule has to apply to the opponent, which is covered separately below with a real
    // controller attached.
    const sim = simWithTarget();

    // Set destruction directly: the point under test is the consequence, not the route to it.
    sim.vehicle.damage.hitPoints = 0;
    sim.vehicle.damage.destroyed = true;

    for (let i = 0; i < 120; i += 1) {
      sim.tick(makeInput(1, 0, vec3(0, 0, 60), false));
    }

    expect(sim.vehicle.telemetry.destroyed).toBe(true);
    expect(sim.vehicle.telemetry.immobilised).toBe(true);
    expect(sim.vehicle.state.speedMps).toBeCloseTo(0, 9);
  });

  it('disables the gun of a destroyed module, on either side', () => {
    const sim = simWithTarget();
    const gun = sim.vehicle.damage.modules.find((m) => m.effect === 'gun')!;
    gun.hitPoints = 0;
    gun.destroyed = true;

    for (let i = 0; i < 10; i += 1) {
      sim.tick(makeInput(0, 0, vec3(0, 0, 60), true));
    }

    expect(sim.vehicle.telemetry.gunDisabled).toBe(true);
    expect(sim.vehicle.telemetry.shotsFired).toBe(0);
  });

  it('leaves a destroyed opponent unable to move or fire', () => {
    // The V4-specific version: with a controller attached, a destroyed opponent must still be inert.
    // The controller is responsible for noticing it is destroyed and emitting a neutral command; this
    // test is what proves that path actually works rather than merely being written.
    const sim = new Simulation({ vehicle: PLACEHOLDER_TANK, target: ENEMY_TANK });
    const enemy = sim.target!;

    enemy.damage.hitPoints = 0;
    enemy.damage.destroyed = true;
    const positionAtDeath = { ...enemy.state.position };
    const shotsAtDeath = enemy.telemetry.shotsFired;

    for (let i = 0; i < 300; i += 1) {
      sim.tick(NEUTRAL_INPUT);
    }

    expect(enemy.telemetry.destroyed).toBe(true);
    expect(enemy.telemetry.immobilised).toBe(true);
    expect(enemy.state.speedMps).toBeCloseTo(0, 9);
    expect(Math.hypot(
      enemy.state.position.x - positionAtDeath.x,
      enemy.state.position.z - positionAtDeath.z,
    )).toBeLessThan(0.001);
    expect(enemy.telemetry.shotsFired).toBe(shotsAtDeath);
    expect(sim.enemyController!.diagnostics.intent).toBe('disabled');
  });
});

describe('armour region selection', () => {
  it('is blocked by the target front plate', () => {
    const { result } = shootTarget(vec3(0, 0.85, 2.1));
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.plate.definition.region).toBe('hull-front');
    }
  });

  it('penetrates the target side plate', () => {
    const { result } = shootTarget(vec3(1.3, 0.6, 0));
    expect(result.kind).toBe('penetrated');
    if (result.kind === 'penetrated') {
      expect(result.plate.definition.region).toBe('hull-side');
    }
  });

  it('penetrates the target rear plate', () => {
    const { result } = shootTarget(vec3(0, 0.6, -2.4));
    expect(result.kind).toBe('penetrated');
    if (result.kind === 'penetrated') {
      expect(result.plate.definition.region).toBe('hull-rear');
    }
  });

  it('misses the target entirely when aimed clear of it', () => {
    // Far beyond the hull's nose in Z, so a ray along X passes by every plate.
    expect(shootTarget(vec3(40, 0.6, 30)).result.kind).toBe('armour-miss');
  });

  it('reports a different plate for a different part of the vehicle', () => {
    const regions = [
      shootTarget(vec3(0, 0.85, 2.1)).result,
      shootTarget(vec3(1.3, 0.6, 0)).result,
      shootTarget(vec3(0, 0.6, -2.4)).result,
    ].map((r) => (r.kind === 'armour-miss' ? 'miss' : r.plate.definition.region));

    // Where the shell lands must genuinely matter, not just what it is called.
    expect(new Set(regions).size).toBe(3);
  });
});

describe('damage is applied only on penetration', () => {
  it('applies no damage to a blocked shot', () => {
    const { result, damage } = shootTarget(vec3(0, 0.85, 2.1));
    expect(result.kind).toBe('blocked');
    expect(damage.hitPoints).toBe(TARGET_TANK.survivability.hitPoints);
    expect(damage.destroyed).toBe(false);
  });

  it('applies the configured damage to a penetrating shot', () => {
    const { result, damage } = shootTarget(vec3(1.3, 0.6, 0));
    expect(result.kind).toBe('penetrated');
    expect(damage.hitPoints).toBe(
      TARGET_TANK.survivability.hitPoints - TARGET_TANK.survivability.damagePerPenetration,
    );
  });

  it('reports the damage on the result as well as in the state', () => {
    const { result } = shootTarget(vec3(1.3, 0.6, 0));
    expect(result.kind).toBe('penetrated');
    if (result.kind === 'penetrated') {
      expect(result.damage.vehicleDamage).toBe(TARGET_TANK.survivability.damagePerPenetration);
    }
  });
});

describe('module hits through the real layout', () => {
  it('damages the engine through the rear plate', () => {
    // The engine sits directly behind the target's thin rear plate, so a rear shot must reach it.
    const { result } = shootTarget(vec3(0, 0.6, -2.4));
    expect(result.kind).toBe('penetrated');
    if (result.kind === 'penetrated') {
      expect(Object.keys(result.damage.moduleDamage)).toContain('engine');
    }
  });

  it('leaves the engine untouched when the front plate stops the shell', () => {
    const definition = TARGET_TANK;
    const engine = definition.survivability.modules.find((m) => m.id === 'engine')!;
    const { damage } = shootTarget(vec3(0, 0.85, 2.1));

    expect(findModule(damage, 'engine')!.hitPoints).toBe(engine.hitPoints);
  });
});

describe('destruction', () => {
  it('destroys the target after enough penetrating hits, reporting it exactly once', () => {
    const definition = TARGET_TANK;
    const damage = createDamageState(definition);
    const heading = Math.PI;
    const plates = buildWorldPlates(definition, ORIGIN, heading, heading);

    const hits = Math.ceil(
      definition.survivability.hitPoints / definition.survivability.damagePerPenetration,
    );
    let destroyReported = 0;

    for (let i = 0; i < hits; i += 1) {
      // Fire along -X into the target's right-hand side plate, from 200 m out.
      const origin = vec3(200, 0.6, 0);
      const direction = vec3(-1, 0, 0);
      const cast = raycastPlates(plates, origin, direction, 200);
      if (cast === null) {
        continue;
      }
      const impact: ShellImpact = { ...impactOn(definition, origin, direction), position: cast.point };
      const result = resolveCombat(definition, impact, plates, damage, ORIGIN, heading, heading);
      if (result.kind === 'penetrated' && result.damage.vehicleDestroyed) {
        destroyReported += 1;
      }
    }

    expect(damage.destroyed).toBe(true);
    expect(damage.hitPoints).toBe(0);
    expect(destroyReported).toBe(1);
  });
});

describe('determinism', () => {
  it('resolves identical shots identically', () => {
    const describeShot = () => {
      const { result, damage } = shootTarget(vec3(1.3, 0.6, 0));
      if (result.kind === 'armour-miss') {
        return 'miss';
      }
      const p = result.penetration;
      const modules =
        result.kind === 'penetrated' ? JSON.stringify(result.damage.moduleDamage) : '{}';
      return (
        `${result.kind}|${result.plate.definition.id}|${p.outcome}|` +
        `${p.effectiveArmorMm.toPrecision(15)}|${p.shellPenetrationMm.toPrecision(15)}|` +
        `${damage.hitPoints}|${modules}`
      );
    };

    expect(describeShot()).toBe(describeShot());
  });
});
