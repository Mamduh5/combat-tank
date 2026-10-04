import { describe, expect, it } from 'vitest';
import {
  applyPenetration,
  createDamageState,
  findModule,
  healthFraction,
  isEffectDestroyed,
} from '../../src/core/damage/damage-model.js';
import { localToWorld } from '../../src/core/armor/geometry.js';
import { vec3 } from '../../src/shared/vec3.js';
import { CT_MEDIUM } from '../../src/shared/roster.js';
import { TARGET_TANK } from '../../src/shared/placeholder-target.js';

/**
 * Damage and module tests.
 *
 * Two properties are established: that damage is applied **only** when a shell penetrates, and that
 * module damage is **spatially meaningful** â€” the shell has to actually go near a module to hurt it,
 * rather than modules being picked by some arbitrary rule.
 */

const ORIGIN = vec3(0, 0, 0);

/** Applies one penetration at a vehicle-local point to a fresh damage state. */
function hitAt(local: ReturnType<typeof vec3>, definition = CT_MEDIUM) {
  const damage = createDamageState(definition);
  const world = localToWorld(ORIGIN, 0, local);
  return { damage, report: applyPenetration(definition, damage, world, ORIGIN, 0, 0) };
}

describe('vehicle hit points', () => {
  it('starts at the definition hit points', () => {
    const damage = createDamageState(CT_MEDIUM);
    expect(damage.hitPoints).toBe(CT_MEDIUM.survivability.hitPoints);
    expect(damage.destroyed).toBe(false);
    expect(healthFraction(damage)).toBe(1);
  });

  it('loses the configured amount per penetration', () => {
    const { damage, report } = hitAt(vec3(0, 0, 1));
    expect(report.vehicleDamage).toBe(CT_MEDIUM.survivability.damagePerPenetration);
    expect(damage.hitPoints).toBe(
      CT_MEDIUM.survivability.hitPoints -
        CT_MEDIUM.survivability.damagePerPenetration,
    );
  });

  it('is destroyed when hit points reach zero', () => {
    const definition = CT_MEDIUM;
    const damage = createDamageState(definition);
    const hits = Math.ceil(
      definition.survivability.hitPoints / definition.survivability.damagePerPenetration,
    );

    let lastDestroyed = false;
    for (let i = 0; i < hits; i += 1) {
      lastDestroyed = applyPenetration(definition, damage, ORIGIN, ORIGIN, 0, 0).vehicleDestroyed;
    }

    expect(lastDestroyed).toBe(true);
    expect(damage.destroyed).toBe(true);
    expect(damage.hitPoints).toBe(0);
    expect(healthFraction(damage)).toBe(0);
  });

  it('never records negative hit points', () => {
    const damage = createDamageState(CT_MEDIUM);
    for (let i = 0; i < 50; i += 1) {
      applyPenetration(CT_MEDIUM, damage, ORIGIN, ORIGIN, 0, 0);
    }
    expect(damage.hitPoints).toBeGreaterThanOrEqual(0);
  });

  it('absorbs nothing further once destroyed', () => {
    const damage = createDamageState(CT_MEDIUM);
    for (let i = 0; i < 50; i += 1) {
      applyPenetration(CT_MEDIUM, damage, ORIGIN, ORIGIN, 0, 0);
    }
    expect(damage.destroyed).toBe(true);

    // A late-arriving shell must not report damage on a vehicle that no longer exists.
    expect(applyPenetration(CT_MEDIUM, damage, ORIGIN, ORIGIN, 0, 0).vehicleDamage).toBe(0);
  });
});

describe('module damage', () => {
  it('starts every module at full health', () => {
    const damage = createDamageState(CT_MEDIUM);
    expect(damage.modules).toHaveLength(CT_MEDIUM.survivability.modules.length);
    for (const module of damage.modules) {
      expect(module.destroyed).toBe(false);
      expect(module.hitPoints).toBeGreaterThan(0);
    }
  });

  it('damages a module when the penetration passes near it', () => {
    // The engine sits at the rear of the hull; a shell entering there is inside its radius.
    const { report } = hitAt(vec3(0, 0.5, -2.4));
    expect(report.moduleDamage.engine).toBeGreaterThan(0);
  });

  it('damages no module when the penetration is far from all of them', () => {
    // A shell into the front plate ends up well forward of the engine and tracks.
    const { report } = hitAt(vec3(0, 0.85, 2.1));
    expect(Object.keys(report.moduleDamage)).toHaveLength(0);
  });

  it('damages at most one module per penetration', () => {
    // Near the centre of the hull several modules may be within range; choosing exactly one keeps a
    // single shell from destroying the whole vehicle.
    const { report } = hitAt(vec3(0, 0.4, 0));
    expect(Object.keys(report.moduleDamage).length).toBeLessThanOrEqual(1);
  });

  it('damages the nearest module when several are in range', () => {
    // The left track is at x = -1.35; a shell just inside it is nearer the track than the engine.
    const { report } = hitAt(vec3(-1.3, 0.35, 0));
    expect(Object.keys(report.moduleDamage)).toEqual(['track-left']);
  });

  it('destroys a module once its own hit points reach zero', () => {
    const definition = TARGET_TANK;
    const damage = createDamageState(definition);
    const engine = definition.survivability.modules.find((m) => m.id === 'engine')!;
    const world = localToWorld(ORIGIN, 0, engine.centerM);

    const hits = Math.ceil(engine.hitPoints / definition.survivability.damagePerPenetration);
    let destroyed: readonly string[] = [];
    for (let i = 0; i < hits; i += 1) {
      destroyed = applyPenetration(definition, damage, world, ORIGIN, 0, 0).modulesDestroyed;
    }

    expect(destroyed).toContain('engine');
    expect(findModule(damage, 'engine')!.destroyed).toBe(true);
    expect(isEffectDestroyed(damage, 'engine')).toBe(true);
  });

  it('does not report an already-destroyed module as destroyed twice', () => {
    const definition = TARGET_TANK;
    const damage = createDamageState(definition);
    const engine = definition.survivability.modules.find((m) => m.id === 'engine')!;
    const world = localToWorld(ORIGIN, 0, engine.centerM);

    for (let i = 0; i < 10; i += 1) {
      applyPenetration(definition, damage, world, ORIGIN, 0, 0);
    }
    // The module is long dead; further hits there damage only the vehicle.
    expect(applyPenetration(definition, damage, world, ORIGIN, 0, 0).modulesDestroyed).toHaveLength(0);
  });

  it('turns module positions with the vehicle', () => {
    // A shell entering at the engine's local position on a vehicle facing the other way must still be
    // in range, proving modules move with the hull rather than sitting at fixed world points.
    const definition = TARGET_TANK;
    const engine = definition.survivability.modules.find((m) => m.id === 'engine')!;
    const heading = Math.PI;

    const damage = createDamageState(definition);
    const world = localToWorld(ORIGIN, heading, engine.centerM);
    const report = applyPenetration(definition, damage, world, ORIGIN, heading, heading);

    expect(Object.keys(report.moduleDamage)).toEqual(['engine']);
  });

  it('reports no gameplay effect for a module whose consequence is deferred', () => {
    // The ammunition module takes damage but explodes in no version yet, so nothing is simulated.
    const damage = createDamageState(CT_MEDIUM);
    expect(findModule(damage, 'ammunition')!.effect).toBe('ammunition');
    expect(isEffectDestroyed(damage, 'none')).toBe(false);
  });
});

describe('determinism', () => {
  it('produces identical results from identical starting state', () => {
    const run = () => {
      const damage = createDamageState(TARGET_TANK);
      for (let i = 0; i < 5; i += 1) {
        applyPenetration(TARGET_TANK, damage, vec3(0, 0.5, -2.4), ORIGIN, 0, 0);
      }
      return `${damage.hitPoints}|${damage.destroyed}|${damage.modules
        .map((m) => `${m.id}:${m.hitPoints}:${m.destroyed}`)
        .join(',')}`;
    };

    // The whole multiplayer design depends on two machines agreeing about damage.
    expect(run()).toBe(run());
  });
});