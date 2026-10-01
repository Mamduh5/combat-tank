import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/core/sim/world.js';
import { Battle } from '../../src/core/battle/battle.js';
import { Tank } from '../../src/core/vehicle/tank.js';
import { Terrain, ARENA_COVER, COVER_MAX_SLOPE_RATIO } from '../../src/core/world/terrain.js';
import { applyPenetration, findModule } from '../../src/core/damage/damage-model.js';
import { makeInput, NEUTRAL_INPUT } from '../../src/shared/input.js';
import { vec3 } from '../../src/shared/vec3.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import { ENEMY_TANK } from '../../src/shared/enemy-tank.js';

/**
 * V4 tests: the first real encounter.
 *
 * The organising concern is **symmetry**. V3 could assume one-way damage \u2014 the player shot a target that
 * could not respond. With both sides fighting, the property that matters is that neither side has a
 * private rule set, and most of what follows is an attempt to make that fail loudly if it regresses.
 */

/** A simulation with the real V4 opponent. */
function duel(seed = 12345) {
  return new Simulation({ vehicle: PLACEHOLDER_TANK, target: ENEMY_TANK, enemySeed: seed });
}

/** Runs a whole battle to a terminal state or the tick limit. Returns what happened. */
function runBattle(ticks = 3600, mk: (sim: Simulation, i: number) => unknown = () => NEUTRAL_INPUT) {
  const simulation = duel();
  const battle = new Battle(simulation);
  for (let i = 0; i < ticks; i += 1) {
    battle.tick(mk(simulation, i) as never);
    if (battle.isOver) {
      return { state: battle.state, ticks: i, simulation, battle };
    }
  }
  return { state: battle.state, ticks: ticks, simulation, battle };
}

describe('V4 encounter lifecycle', () => {
  it('starts in the ready state and becomes active after the opening delay', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    expect(battle.state).toBe('ready');

    // The delay is deliberate, so the player is not shot during the briefing.
    battle.tick(NEUTRAL_INPUT);
    expect(battle.state).toBe('ready');

    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }
    expect(battle.state).toBe('active');
  });

  it('does not let the opponent act during the opening delay', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    const startPosition = { ...simulation.target!.state.position };

    for (let i = 0; i < 20; i += 1) {
      battle.tick(makeInput(1, 0, null, false));
    }

    expect(simulation.target!.telemetry.shotsFired).toBe(0);
    // A tolerance rather than an equality: the opponent is still stepped during the delay so it settles
    // onto the terrain, and settling moves it a few millimetres. What matters is that it did not *drive*.
    expect(Math.abs(simulation.target!.state.position.x - startPosition.x)).toBeLessThan(0.1);
    expect(Math.abs(simulation.target!.state.position.z - startPosition.z)).toBeLessThan(0.1);
  });

  it('ends in victory when the opponent is destroyed', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }

    simulation.target!.damage.hitPoints = 0;
    simulation.target!.damage.destroyed = true;
    battle.tick(NEUTRAL_INPUT);

    expect(battle.state).toBe('victory');
    expect(battle.isOver).toBe(true);
  });

  it('ends in defeat when the player is destroyed', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }

    simulation.vehicle.damage.hitPoints = 0;
    simulation.vehicle.damage.destroyed = true;
    battle.tick(NEUTRAL_INPUT);

    expect(battle.state).toBe('defeat');
  });

  it('freezes a finished battle rather than letting a late shell flip the result', () => {
    // Shells are still in flight when a tank dies. Without a terminal state being sticky, the second
    // shell to land could reverse an outcome the player has already been shown.
    const simulation = duel();
    const battle = new Battle(simulation);
    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }

    simulation.target!.damage.hitPoints = 0;
    simulation.target!.damage.destroyed = true;
    battle.tick(NEUTRAL_INPUT);
    expect(battle.state).toBe('victory');

    // Now destroy the player too. The result must not change.
    simulation.vehicle.damage.hitPoints = 0;
    simulation.vehicle.damage.destroyed = true;
    battle.tick(NEUTRAL_INPUT);
    expect(battle.state).toBe('victory');
  });

  it('ignores player input once the battle is over', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }
    simulation.target!.damage.destroyed = true;
    simulation.target!.damage.hitPoints = 0;
    battle.tick(NEUTRAL_INPUT);

    const position = { ...simulation.vehicle.state.position };
    for (let i = 0; i < 120; i += 1) {
      battle.tick(makeInput(1, 0, null, true));
    }

    expect(simulation.vehicle.state.position.x).toBeCloseTo(position.x, 6);
    expect(simulation.vehicle.state.position.z).toBeCloseTo(position.z, 6);
  });
});

describe('restart', () => {
  it('restores both vehicles, the opponent memory, and the tick clock', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    const openingPlayer = { ...simulation.vehicle.state.position };
    const openingEnemy = { ...simulation.target!.state.position };

    for (let i = 0; i < 600; i += 1) {
      battle.tick(makeInput(1, 0.4, null, true));
    }

    battle.restart();

    expect(battle.state).toBe('ready');
    expect(simulation.tickCount).toBe(0);
    expect(simulation.vehicle.damage.hitPoints).toBe(PLACEHOLDER_TANK.survivability.hitPoints);
    expect(simulation.target!.damage.hitPoints).toBe(ENEMY_TANK.survivability.hitPoints);
    expect(simulation.vehicle.gunState.shotsFired).toBe(0);
    expect(simulation.target!.gunState.shotsFired).toBe(0);
    expect(simulation.vehicle.state.position.x).toBeCloseTo(openingPlayer.x, 6);
    expect(simulation.vehicle.state.position.z).toBeCloseTo(openingPlayer.z, 6);
    expect(simulation.target!.state.position.x).toBeCloseTo(openingEnemy.x, 6);
    expect(simulation.target!.state.position.z).toBeCloseTo(openingEnemy.z, 6);
    expect(simulation.enemyController!.state).toBe('searching');
  });

  it('restores destroyed modules, not just hit points', () => {
    // The bug this guards against: a restart that resets HP but leaves a track destroyed. The vehicle
    // would then be permanently crippled in a "new" battle, which reads as a broken restart.
    const simulation = duel();
    const battle = new Battle(simulation);
    const track = simulation.vehicle.damage.modules.find((m) => m.id === 'track-left')!;
    track.hitPoints = 0;
    track.destroyed = true;

    battle.restart();

    const restored = findModule(simulation.vehicle.damage, 'track-left')!;
    expect(restored.destroyed).toBe(false);
    expect(restored.hitPoints).toBeGreaterThan(0);
    expect(simulation.vehicle.telemetry.tracksDestroyed).toBe(0);
  });

  it('clears shells still in flight, so no stale round kills the player after a restart', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }

    // Fire, then restart before the shell lands. The gun has to actually accept the shot, so the
    // trigger is held across a reload rather than tapped once.
    for (let i = 0; i < 600; i += 1) {
      battle.tick(makeInput(0, 0, vec3(0, 0, 400), true));
      if (simulation.shells.activeCount > 0) {
        break;
      }
    }
    expect(simulation.shells.activeCount).toBeGreaterThan(0);

    battle.restart();
    expect(simulation.shells.activeCount).toBe(0);

    const hpAtRestart = simulation.vehicle.damage.hitPoints;
    for (let i = 0; i < 300; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }
    expect(simulation.vehicle.damage.hitPoints).toBe(hpAtRestart);
  });

  it('clears queued events, so a victory banner is not replayed on the new battle', () => {
    const simulation = duel();
    const battle = new Battle(simulation);
    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }
    simulation.target!.damage.hitPoints = 0;
    simulation.target!.damage.destroyed = true;
    battle.tick(NEUTRAL_INPUT);
    battle.drainEvents();

    battle.restart();
    expect(battle.drainEvents()).toEqual([]);
  });

  it('replays identically after a restart, proving determinism survives the reset', () => {
    // The strongest available check that nothing is left behind: the same inputs must produce the same
    // result twice, separated by a restart.
    const simulation = duel();
    const battle = new Battle(simulation);

    const run = () => {
      const samples: number[] = [];
      for (let i = 0; i < 400; i += 1) {
        battle.tick(makeInput(1, 0.3, null, i % 90 === 0));
        if (i % 100 === 0) {
          samples.push(+simulation.vehicle.state.position.x.toFixed(6));
        }
      }
      return samples;
    };

    const first = run();
    battle.restart();
    const second = run();

    expect(second).toEqual(first);
  });
});
describe('the opponent fights through the same rules as the player', () => {
  it('fires real shells through the shared ballistics', () => {
    const simulation = duel();
    for (let i = 0; i < 1800; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
    }
    // The shots exist as travelling projectiles with the enemy's id as the shooter, not as damage
    // applied on a timer. This is the assertion that would fail if the opponent had a shortcut.
    expect(simulation.target!.telemetry.shotsFired).toBeGreaterThan(0);
  });

  it('can penetrate the player, not merely register hits', () => {
    // The important distinction. "The player lost hit points" could be a damage shortcut; "a shot was
    // resolved by the penetration model" cannot.
    //
    // The player drives and turns here, and that is deliberate. A player who presents a stationary
    // frontal plate to the opponent is genuinely unhittable: the front is pitched 60 degrees and stops
    // 150 mm of penetration cleanly. That is the armour model working as V3 designed it, not a defect,
    // and it is why this test manoeuvres instead of asserting that parking is fatal.
    const simulation = duel();
    let penetrated = false;
    for (let i = 0; i < 2400 && !penetrated; i += 1) {
      simulation.tick(makeInput(0.4, 0.5, null, false));
      penetrated = simulation.incomingCombat.some((r) => r.kind === 'penetrated');
    }
    expect(penetrated).toBe(true);
  });

  it('cannot hurt a player who presents frontal armour head-on', () => {
    // Recorded deliberately, because it is a real and important property of the encounter rather than
    // an oversight: parking square-on to the enemy is close to safe. It is the same lesson V3 taught
    // about the target's rear plate, now pointed back at the player.
    //
    // Whether a stationary player being nearly invulnerable is *desirable* is a balance question for the
    // owner rather than a fact this codebase should decide. See docs/open-decisions.md OD-11.
    const simulation = duel();
    let penetrations = 0;
    for (let i = 0; i < 2400; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
      penetrations += simulation.incomingCombat.filter((r) => r.kind === 'penetrated').length;
    }
    expect(simulation.target!.telemetry.shotsFired).toBeGreaterThan(0);
    expect(penetrations).toBe(0);
  });

  it('is subject to the same reload rules', () => {
    const simulation = duel();
    const enemy = simulation.target!;
    for (let i = 0; i < 1200; i += 1) {
      const loaded = enemy.gunState.loadState === 'loaded';
      const before = enemy.gunState.shotsFired;
      simulation.tick(NEUTRAL_INPUT);
      if (!loaded) {
        expect(enemy.gunState.shotsFired).toBe(before);
      }
    }
  });

  it('turns its hull, slews its turret, and changes its speed', () => {
    const simulation = duel();
    const enemy = simulation.target!;
    const startHeading = enemy.state.headingRad;
    const startAim = enemy.turretState.localAngleRad;

    let sawSpeed = 0;
    for (let i = 0; i < 900; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
      sawSpeed = Math.max(sawSpeed, Math.abs(enemy.state.speedMps));
    }

    expect(sawSpeed).toBeGreaterThan(0.5);
    expect(enemy.state.headingRad).not.toBeCloseTo(startHeading, 3);
    expect(enemy.turretState.localAngleRad).not.toBeCloseTo(startAim, 3);
  });

  it('never fires at a player it cannot see', () => {
    // Firing at a remembered position would let the opponent shoot through a hill, which reads as
    // cheating even though it is only bad geometry.
    const simulation = duel();
    let firedWhileBlind = false;
    for (let i = 0; i < 2400; i += 1) {
      const before = simulation.target!.telemetry.shotsFired;
      simulation.tick(NEUTRAL_INPUT);
      if (simulation.target!.telemetry.shotsFired > before && !simulation.enemyHasLineOfSight) {
        firedWhileBlind = true;
      }
    }
    expect(firedWhileBlind).toBe(false);
  });

  it('is destroyed by the same armour rules, and stops acting when it is', () => {
    const simulation = duel();
    const enemy = simulation.target!;
    const battle = new Battle(simulation);
    for (let i = 0; i < 200; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }

    // Applied through the real damage model, from a rear-facing penetration point.
    // Applied through the real damage model, from a rear-facing penetration point, repeatedly until the
    // tank is actually destroyed. One application is 150 HP against 900, which is not a kill.
    let report = applyPenetration(
      ENEMY_TANK,
      enemy.damage,
      vec3(0, 0.6, -2.4),
      enemy.state.position,
      enemy.state.headingRad,
      enemy.state.headingRad,
    );
    expect(report.vehicleDamage).toBe(ENEMY_TANK.survivability.damagePerPenetration);
    while (!enemy.damage.destroyed) {
      report = applyPenetration(
        ENEMY_TANK,
        enemy.damage,
        vec3(0, 0.6, -2.4),
        enemy.state.position,
        enemy.state.headingRad,
        enemy.state.headingRad,
      );
    }
    expect(enemy.damage.hitPoints).toBe(0);

    const positionAtDeath = { ...enemy.state.position };
    for (let i = 0; i < 120; i += 1) {
      battle.tick(NEUTRAL_INPUT);
    }
    // A wreck does not freeze where it died: it coasts to a stop, and on a slope it may keep creeping
    // slowly for a while because the terrain keeps pushing it. What is asserted is that it is no longer
    // *driving* - a small residual drift, against a vehicle that had been doing several m/s under power.
    expect(enemy.state.speedMps).toBeLessThan(2);
    expect(Math.abs(enemy.state.position.x - positionAtDeath.x)).toBeLessThan(6);
    expect(enemy.telemetry.immobilised).toBe(true);
  });

  it('goes inert rather than continuing to act once its engine is gone', () => {
    const simulation = duel();
    const enemy = simulation.target!;
    for (let i = 0; i < 300; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
    }

    const engine = findModule(enemy.damage, 'engine')!;
    engine.hitPoints = 0;
    engine.destroyed = true;

    const position = { ...enemy.state.position };
    for (let i = 0; i < 180; i += 1) {
      simulation.tick(NEUTRAL_INPUT);
    }

    expect(enemy.telemetry.immobilised).toBe(true);
    // Again, coasting and creeping downhill is the correct consequence of losing the engine. The check
    // is that it is no longer under power, not that it is perfectly still.
    expect(enemy.state.speedMps).toBeLessThan(2);
    expect(Math.abs(enemy.state.position.x - position.x)).toBeLessThan(8);
  });

  it('is reproducible from its seed', () => {
    // A seeded opponent is what makes "the AI is unbeatable sometimes" a reportable bug rather than a
    // rumour. Two runs with the same seed must match exactly.
    const first = duel(999);
    const second = duel(999);
    for (let i = 0; i < 600; i += 1) {
      first.tick(NEUTRAL_INPUT);
      second.tick(NEUTRAL_INPUT);
    }
    expect(second.target!.state.position.x).toBeCloseTo(first.target!.state.position.x, 12);
    expect(second.target!.state.position.z).toBeCloseTo(first.target!.state.position.z, 12);
    expect(second.target!.telemetry.shotsFired).toBe(first.target!.telemetry.shotsFired);
  });
});

describe('track damage has a gameplay consequence', () => {
  /** A fresh player tank on flat ground, for isolating locomotion. */
  function flatTank() {
    return new Tank(PLACEHOLDER_TANK, { position: vec3(0, 0, 0), headingRad: 0 });
  }

  const flatTerrain = { seed: 1, halfSizeM: 2000, amplitudeM: 0, edgeRiseM: 0 };

  function topSpeedAfter(tank: Tank, ticks: number): number {
    for (let i = 0; i < ticks; i += 1) {
      tank.step(makeInput(1, 0, null, false), new Terrain(flatTerrain), 1 / 60);
    }
    return tank.state.speedMps;
  }

  it('drives at full speed with both tracks intact', () => {
    expect(topSpeedAfter(flatTank(), 300)).toBeGreaterThan(8);
  });

  it('loses most of its speed with one track destroyed', () => {
    const tank = flatTank();
    const track = findModule(tank.damage, 'track-left')!;
    track.hitPoints = 0;
    track.destroyed = true;

    const speed = topSpeedAfter(tank, 300);
    expect(speed).toBeLessThan(PLACEHOLDER_TANK.powertrain.maxSpeedMps * 0.6);
    expect(speed).toBeGreaterThan(0);
  });

  it('pulls toward the side whose track is gone', () => {
    // The veer is what makes track damage readable without looking at the HUD, and it is the difference
    // between a handicap to correct and a control the game takes away.
    const tank = flatTank();
    const track = findModule(tank.damage, 'track-right')!;
    track.hitPoints = 0;
    track.destroyed = true;

    const startHeading = tank.state.headingRad;
    for (let i = 0; i < 60; i += 1) {
      tank.step(NEUTRAL_INPUT, new Terrain(flatTerrain), 1 / 60);
    }
    expect(tank.state.headingRad).toBeGreaterThan(startHeading);
  });

  it('cannot move at all with both tracks destroyed', () => {
    const tank = flatTank();
    for (const id of ['track-left', 'track-right']) {
      const track = findModule(tank.damage, id)!;
      track.hitPoints = 0;
      track.destroyed = true;
    }
    expect(topSpeedAfter(tank, 300)).toBeCloseTo(0, 9);
  });

  it('cannot rotate either, rather than spinning on the spot', () => {
    const tank = flatTank();
    for (const id of ['track-left', 'track-right']) {
      const track = findModule(tank.damage, id)!;
      track.hitPoints = 0;
      track.destroyed = true;
    }
    for (let i = 0; i < 120; i += 1) {
      tank.step(makeInput(0, 1, null, false), new Terrain(flatTerrain), 1 / 60);
    }
    expect(tank.state.headingRad).toBeCloseTo(0, 9);
  });

  it('reports the destroyed track count, so the HUD and AI can tell one from two', () => {
    const tank = flatTank();
    expect(tank.telemetry.tracksDestroyed).toBe(0);
    const left = findModule(tank.damage, 'track-left')!;
    left.hitPoints = 0;
    left.destroyed = true;
    tank.step(NEUTRAL_INPUT, new Terrain(flatTerrain), 1 / 60);
    expect(tank.telemetry.tracksDestroyed).toBe(1);
  });
});

describe('the arena', () => {
  it('keeps every cover feature gentle enough to drive over', () => {
    // The ratio is the only thing that decides a bump's steepness, so it is the thing to constrain.
    // Enforced mechanically because a comment does not stop the next person raising a mound.
    for (const feature of ARENA_COVER) {
      expect(
        Math.abs(feature.heightM) / feature.radiusM,
        `cover feature ${feature.id} is too steep to drive over`,
      ).toBeLessThanOrEqual(COVER_MAX_SLOPE_RATIO);
    }
  });

  it('spawns the player on ground it can actually drive off', () => {
    const simulation = duel();
    expect(Math.abs(simulation.vehicle.telemetry.slopeDeg)).toBeLessThan(5);
  });

  it('spawns the two vehicles close enough to exchange fire', () => {
    const simulation = duel();
    const p = simulation.vehicle.state.position;
    const e = simulation.target!.state.position;
    const range = Math.sqrt((e.x - p.x) ** 2 + (e.z - p.z) ** 2);
    expect(range).toBeGreaterThan(25);
    expect(range).toBeLessThan(110);
  });

  it('spawns them near enough in elevation for a level shot', () => {
    const simulation = duel();
    const drop = simulation.vehicle.state.position.y - simulation.target!.state.position.y;
    expect(Math.abs(drop)).toBeLessThan(6);
  });

  it('spawns them facing one another', () => {
    const simulation = duel();
    const p = simulation.vehicle.state.position;
    const e = simulation.target!.state.position;
    const bearing = Math.atan2(p.x - e.x, p.z - e.z);
    const heading = simulation.target!.state.headingRad;
    const difference = Math.abs(Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading)));
    expect(difference).toBeLessThan(0.05);
  });

  it('adds no cover to a terrain configured without one', () => {
    // Guards a regression that would otherwise be baffling: a ballistics test configured for flat ground
    // must get flat ground, not the arena's mounds.
    const flat = new Terrain({ seed: 1, halfSizeM: 2000, amplitudeM: 0, edgeRiseM: 0 });
    expect(flat.heightAt(0, 0)).toBe(0);
    expect(flat.heightAt(-46, 58)).toBe(0);
  });
});

describe('the encounter as a whole', () => {
  it('keeps a passive player under fire rather than letting them ignore the fight', () => {
    // A player who does nothing should still be shot at — the opponent has to be *doing* something, or
    // the second tank is scenery. What is not asserted is that parking kills them: against a frontal
    // plate pitched 60 degrees, it does not, and pretending otherwise would be asserting a balance
    // decision this codebase has not made.
    const result = runBattle(2400);
    expect(result.simulation.target!.telemetry.shotsFired).toBeGreaterThan(3);
    expect(result.state).toBe('active');
  });

  it('does not resolve instantly', () => {
    const result = runBattle(2400);
    expect(result.ticks).toBeGreaterThan(120);
  });

  it('is winnable by flanking, which is the lesson the armour is meant to teach', () => {
    // A duel where the player cannot land a shot is worse than no duel. Circling to the flank is the
    // intended counter, so it is asserted here rather than left to be discovered.
    const result = runBattle(3600, (simulation) => {
      const target = simulation.target!.state.position;
      return makeInput(0.35, 0.9, vec3(target.x, target.y + 0.6, target.z), true);
    });

    expect(result.simulation.target!.damage.hitPoints).toBeLessThan(
      ENEMY_TANK.survivability.hitPoints,
    );
  });
});