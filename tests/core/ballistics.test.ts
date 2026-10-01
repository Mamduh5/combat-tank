import { describe, expect, it } from 'vitest';
import {
  createShell,
  GRAVITY_MPS2,
  stepShell,
  type ShellState,
} from '../../src/core/ballistics/shell.js';
import { computeIncidenceAngleDeg } from '../../src/core/ballistics/impact.js';
import { ShellFlightSystem } from '../../src/core/ballistics/flight-system.js';
import { Terrain } from '../../src/core/world/terrain.js';
import { vec3 } from '../../src/shared/vec3.js';
import { PLACEHOLDER_TANK } from '../../src/shared/placeholder-tank.js';
import type { TestShellDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * Ballistics tests.
 *
 * Two things are established here, and they are the whole point of V2:
 *
 *  1. **A shell is a real travelling object.** It takes time to arrive and it drops under gravity, so
 *     range and leading are genuine considerations rather than decoration on an instant hit.
 *  2. **The flight is deterministic and reproducible**, because the scheme depends on a server and
 *     client being able to agree about where a shell is (ADR-0001, ADR-0005).
 *
 * These are sanity checks on a physically coherent model, not a ballistics research suite. The
 * tolerances are loose relative to the model's real accuracy, chosen to catch *structural* errors — a
 * wrong sign, a missing gravity term, a shell that never lands — rather than to police integration
 * error.
 */

const SHELL = PLACEHOLDER_TANK.mainShell;
const DT = 1 / 60;

/**
 * A shell with the range limit lifted, for tests that are about ballistics rather than the range cap.
 *
 * The shipped test shell is limited to 2500 m, and a level shot from 400 m needs over 7000 m of
 * travel before it reaches the ground — so it correctly *expires* rather than landing. That is the
 * right behaviour and has its own test below, but it would mask every other assertion here.
 */
const LONG_RANGE_SHELL: TestShellDefinition = {
  ...SHELL,
  maxRangeM: 50_000,
  maxLifetimeSeconds: 600,
};

/** Perfectly flat terrain, so a shot's behaviour is a pure function of its launch conditions. */
const FLAT = new Terrain({ seed: 1, halfSizeM: 2000, amplitudeM: 0, edgeRiseM: 0 });

/** Runs a shell until it impacts or expires, up to a tick budget. */
function fly(
  shell: ShellState,
  definition: TestShellDefinition = LONG_RANGE_SHELL,
  terrain: Terrain = FLAT,
  maxTicks = 3600,
) {
  for (let i = 0; i < maxTicks; i += 1) {
    const result = stepShell(shell, definition, terrain, DT);
    if (result.kind !== 'flying') {
      return result;
    }
  }
  return { kind: 'flying' as const };
}

/** Fires a shell horizontally from a height above flat ground. */
function fireHorizontal(altitudeM: number, direction = vec3(0, 0, 1), shell = LONG_RANGE_SHELL) {
  return createShell(1, shell, vec3(0, altitudeM, 0), direction, 'tester');
}

describe('projectile travel', () => {
  it('takes a non-zero time to reach the ground, rather than hitting instantly', () => {
    const result = fly(fireHorizontal(50));

    expect(result.kind).toBe('impacted');
    if (result.kind === 'impacted') {
      // A hitscan shot would report zero flight time. This is the assertion that proves V2 is not
      // quietly an instant-hit game.
      expect(result.impact.flightTimeSeconds).toBeGreaterThan(0.1);
      expect(result.impact.distanceTravelledM).toBeGreaterThan(0);
    }
  });

  it('drops below the muzzle, so long shots need aiming above the target', () => {
    const shell = fireHorizontal(50);
    const result = fly(shell);

    expect(result.kind).toBe('impacted');
    if (result.kind === 'impacted') {
      // The reported impact sits exactly on the surface. The shell's own `position` is left at the
      // last pre-impact sample, up to one sub-step above the ground, so the impact record is the
      // authoritative answer rather than the shell's leftover position.
      expect(result.impact.position.y).toBeCloseTo(0, 6);
      // A meaningful flight: this is the shot that has to be aimed above a target.
      expect(result.impact.flightTimeSeconds).toBeGreaterThan(0.3);
    }
  });

  it('follows projectile motion: height loss grows with the square of time', () => {
    // Drop after time t is 0.5*g*t^2. Sampling at two times catches a missing, doubled or
    // sign-flipped gravity term.
    const sampleDropAfter = (seconds: number): number => {
      const s = createShell(1, SHELL, vec3(0, 1000, 0), vec3(0, 0, 1), 'tester');
      for (let i = 0; i < Math.round(seconds / DT); i += 1) {
        stepShell(s, SHELL, FLAT, DT);
      }
      return 1000 - s.position.y;
    };

    const drop1 = sampleDropAfter(1);
    const drop2 = sampleDropAfter(2);

    expect(drop1).toBeGreaterThan(0.1);
    // Doubling the time should quadruple the drop, within the integration's accuracy.
    expect(drop2 / drop1).toBeCloseTo(4, 1);
    // And the absolute value matches the closed-form answer.
    expect(drop1).toBeCloseTo(0.5 * GRAVITY_MPS2, 1);
  });

  it('loses vertical speed at the gravitational rate', () => {
    const shell = createShell(1, SHELL, vec3(0, 1000, 0), vec3(0, 0, 1), 'tester');
    for (let i = 0; i < 60; i += 1) {
      stepShell(shell, SHELL, FLAT, DT);
    }
    // After one second, a shell fired level is falling at very nearly g.
    expect(0 - shell.velocity.y).toBeCloseTo(GRAVITY_MPS2, 1);
  });

  it('keeps horizontal speed constant, since there is no drag in V2', () => {
    const shell = createShell(1, SHELL, vec3(0, 1000, 0), vec3(0, 0, 1), 'tester');
    for (let i = 0; i < 60; i += 1) {
      stepShell(shell, SHELL, FLAT, DT);
    }
    // Recorded as a known limitation in ADR-0010: a real shell would have slowed noticeably.
    expect(shell.velocity.z).toBeCloseTo(SHELL.muzzleVelocityMps, 6);
  });

  it('takes longer to reach a greater distance', () => {
    const near = fly(fireHorizontal(50));
    const far = fly(fireHorizontal(400));

    expect(near.kind).toBe('impacted');
    expect(far.kind).toBe('impacted');
    if (near.kind === 'impacted' && far.kind === 'impacted') {
      expect(far.impact.distanceTravelledM).toBeGreaterThan(near.impact.distanceTravelledM);
      expect(far.impact.flightTimeSeconds).toBeGreaterThan(near.impact.flightTimeSeconds);
    }
  });

  it('lands further along its path when fired from a higher height, at the same aim', () => {
    const low = fly(fireHorizontal(20));
    const high = fly(fireHorizontal(400));

    expect(low.kind).toBe('impacted');
    expect(high.kind).toBe('impacted');
    if (low.kind === 'impacted' && high.kind === 'impacted') {
      // A level shot from higher up has further to fall, so it travels further before landing. This
      // is exactly why a gunner must hold over a distant target.
      expect(high.impact.distanceTravelledM).toBeGreaterThan(low.impact.distanceTravelledM * 2);
    }
  });

  it('does not tunnel through terrain at high speed', () => {
    // A shell at 800 m/s covers ~13 m per tick. Without sub-stepping it would pass straight through the
    // ground and be reported as still flying well below the surface.
    const shell = fireHorizontal(30);
    let everBelowSurface = false;

    for (let i = 0; i < 600; i += 1) {
      if (stepShell(shell, SHELL, FLAT, DT).kind !== 'flying') {
        break;
      }
      if (shell.position.y < -0.001) {
        everBelowSurface = true;
      }
    }

    expect(everBelowSurface).toBe(false);
  });
});

describe('impact contract', () => {
  it('reports everything V3 will need to compute penetration', () => {
    const result = fly(fireHorizontal(60));
    expect(result.kind).toBe('impacted');
    if (result.kind !== 'impacted') {
      return;
    }

    const impact = result.impact;
    // Where it hit, and what it hit.
    expect(Number.isFinite(impact.position.x)).toBe(true);
    expect(impact.targetKind).toBe('terrain');
    expect(impact.targetId).toBeNull();
    expect(impact.shellTypeId).toBe(SHELL.id);
    expect(impact.shooterId).toBe('tester');

    // A unit surface normal, pointing up out of flat ground.
    const normalLength = Math.sqrt(
      impact.surfaceNormal.x ** 2 + impact.surfaceNormal.y ** 2 + impact.surfaceNormal.z ** 2,
    );
    expect(normalLength).toBeCloseTo(1, 6);
    expect(impact.surfaceNormal.y).toBeGreaterThan(0.9);

    // A unit direction of travel, and the velocity it came from.
    const dirLength = Math.sqrt(
      impact.incomingDirection.x ** 2 +
        impact.incomingDirection.y ** 2 +
        impact.incomingDirection.z ** 2,
    );
    expect(dirLength).toBeCloseTo(1, 6);
    expect(impact.impactVelocity.z).toBeGreaterThan(0);

    // The quantities a consumer would otherwise have to recompute.
    expect(impact.incidenceAngleDeg).toBeGreaterThan(0);
    expect(impact.incidenceAngleDeg).toBeLessThan(90);
    expect(impact.flightTimeSeconds).toBeGreaterThan(0);
    expect(impact.distanceTravelledM).toBeGreaterThan(0);
    expect(impact.shellMassKg).toBe(SHELL.massKg);
    expect(impact.muzzleVelocityMps).toBe(SHELL.muzzleVelocityMps);
  });

  it('carries no penetration, damage or armour verdict', () => {
    // The V2/V3 boundary is a contract, so it is worth asserting the impact record has not quietly
    // grown a damage field. V3 decides what a hit *means*; V2 only reports where and how.
    const result = fly(fireHorizontal(60));
    expect(result.kind).toBe('impacted');
    if (result.kind !== 'impacted') {
      return;
    }

    expect(Object.keys(result.impact).sort()).toEqual(
      [
        'distanceTravelledM',
        'flightTimeSeconds',
        'impactVelocity',
        'incidenceAngleDeg',
        'incomingDirection',
        'muzzleVelocityMps',
        'position',
        'shooterId',
        'shellId',
        'shellMassKg',
        'shellTypeId',
        'surfaceNormal',
        'targetId',
        'targetKind',
      ].sort(),
    );
  });

  it('gives a shallower incidence for a steeper impact', () => {
    // A shell fired level arrives at a shallow angle to the ground: high incidence angle. Fired steeply
    // down it arrives near head-on: low incidence angle.
    const level = fly(fireHorizontal(200));
    const steep = fly(
      createShell(1, LONG_RANGE_SHELL, vec3(0, 200, 0), vec3(0, -0.7, 0.7), 'tester'),
    );

    expect(level.kind).toBe('impacted');
    expect(steep.kind).toBe('impacted');
    if (level.kind === 'impacted' && steep.kind === 'impacted') {
      expect(steep.impact.incidenceAngleDeg).toBeLessThan(level.impact.incidenceAngleDeg);
    }
  });
});

describe('computeIncidenceAngleDeg', () => {
  it('is zero for a shell driving straight into the surface', () => {
    expect(computeIncidenceAngleDeg(vec3(0, -1, 0), vec3(0, 1, 0))).toBeCloseTo(0, 6);
  });

  it('is 90 degrees for a shell grazing along the surface', () => {
    expect(computeIncidenceAngleDeg(vec3(1, 0, 0), vec3(0, 1, 0))).toBeCloseTo(90, 6);
  });

  it('never leaves the range a consumer would expect, for any downward shot', () => {
    // Guards the sign convention, which is the mistake this function is most likely to make.
    //
    // Only downward-travelling directions are sampled. A shell heading *upward* is reversed to
    // downward for the measurement and would legitimately give an angle above 90 — but such a shell
    // never produces a ground impact, so it is outside the contract this function serves.
    for (let i = 0; i <= 180; i += 1) {
      const a = (i / 180) * Math.PI;
      // Sweeps from straight down (a = 0) to straight up (a = 180), passing through level.
      const dir = vec3(Math.sin(a), -Math.cos(a), 0);

      const angle = computeIncidenceAngleDeg(dir, vec3(0, 1, 0));
      expect(angle).toBeGreaterThanOrEqual(0);
      // The measured angle is `90 - elevation`, so an upward shot legitimately exceeds 90. What must
      // never happen is a value outside [0, 180] or a sign flip, which is what the bounds check for.
      expect(angle).toBeLessThanOrEqual(180.000001);
    }
  });

  it('stays within [0, 90] for every shot that descends toward the ground', () => {
    // The range that actually matters for ground impacts. A shell meeting terrain can only arrive
    // within this quarter, because it is by definition travelling downward.
    for (let i = 0; i <= 90; i += 1) {
      const a = (i / 90) * (Math.PI / 2);
      const dir = vec3(Math.sin(a), -Math.cos(a), 0);
      const angle = computeIncidenceAngleDeg(dir, vec3(0, 1, 0));
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThanOrEqual(90.000001);
    }
  });
});

describe('shell lifetime', () => {
  it('expires on range rather than flying forever', () => {
    // A shot fired almost straight up would otherwise never come down within any sane tick budget.
    const shell = createShell(1, SHELL, vec3(0, 10, 0), vec3(0, 1, 0), 'tester');
    const result = fly(shell, SHELL, FLAT, 60 * 120);

    expect(result.kind).toBe('expired');
    if (result.kind === 'expired') {
      expect(result.reason).toBe('range');
    }
  });

  it('expires on lifetime when the range is generous', () => {
    // A shell too slow to reach its range limit before its clock runs out.
    const slow: TestShellDefinition = {
      ...LONG_RANGE_SHELL,
      muzzleVelocityMps: 5,
      maxRangeM: 1_000_000,
      maxLifetimeSeconds: 2,
    };
    const shell = createShell(1, slow, vec3(0, 500, 0), vec3(1, 0, 0), 'tester');
    const result = fly(shell, slow, FLAT, 60 * 10);

    expect(result.kind).toBe('expired');
    if (result.kind === 'expired') {
      expect(result.reason).toBe('lifetime');
    }
  });
});

describe('ballistic determinism', () => {
  it('produces identical results for identical launches', () => {
    const run = (): string => {
      const shell = createShell(1, LONG_RANGE_SHELL, vec3(0, 120, 0), vec3(0.2, 0.3, 0.9), 'tester');
      const result = fly(shell);
      if (result.kind !== 'impacted') {
        return `unexpected:${result.kind}`;
      }
      const i = result.impact;
      return [i.position.x, i.position.y, i.position.z, i.flightTimeSeconds, i.incidenceAngleDeg]
        .map((v) => v.toPrecision(17))
        .join('|');
    };

    // The whole multiplayer design depends on two machines agreeing about this.
    expect(run()).toBe(run());
  });

  it('lands in the same place regardless of how the flight is chunked', () => {
    // The same elapsed simulated time delivered in different frame sizes must agree closely, though
    // not bit-for-bit, because the integration paths genuinely differ.
    const stepUntilDone = (dt: number, ticks: number): ReturnType<typeof fly> => {
      const shell = createShell(1, LONG_RANGE_SHELL, vec3(0, 120, 0), vec3(0, 0, 1), 'tester');
      let result: ReturnType<typeof fly> = { kind: 'flying' };
      for (let i = 0; i < ticks && result.kind === 'flying'; i += 1) {
        result = stepShell(shell, LONG_RANGE_SHELL, FLAT, dt);
      }
      return result;
    };

    const fine = stepUntilDone(1 / 60, 600);
    const coarse = stepUntilDone(1 / 30, 300);

    expect(fine.kind).toBe('impacted');
    expect(coarse.kind).toBe('impacted');
    if (fine.kind === 'impacted' && coarse.kind === 'impacted') {
      expect(fine.impact.position.z).toBeCloseTo(coarse.impact.position.z, 0);
      expect(fine.impact.flightTimeSeconds).toBeCloseTo(coarse.impact.flightTimeSeconds, 0);
    }
  });
});

describe('ShellFlightSystem', () => {
  it('tracks shells in flight and reports each impact exactly once', () => {
    const system = new ShellFlightSystem();
    system.spawn(LONG_RANGE_SHELL, vec3(0, 100, 0), vec3(0, 0, 1), 'tester');
    expect(system.activeCount).toBe(1);

    let impactCount = 0;
    for (let i = 0; i < 600; i += 1) {
      impactCount += system.step(LONG_RANGE_SHELL, FLAT, DT).length;
    }

    expect(impactCount).toBe(1);
    // The shell is removed when it lands, so it is not re-reported every frame afterwards.
    expect(system.activeCount).toBe(0);
  });

  it('gives every shell a unique id', () => {
    const system = new ShellFlightSystem();
    const a = system.spawn(LONG_RANGE_SHELL, vec3(0, 100, 0), vec3(0, 0, 1), 'tester');
    const b = system.spawn(LONG_RANGE_SHELL, vec3(0, 100, 0), vec3(0, 0, 1), 'tester');
    expect(a.id).not.toBe(b.id);
  });

  it('holds several shells at once, so a rapid reload cycle is representable', () => {
    const system = new ShellFlightSystem();
    for (let i = 0; i < 4; i += 1) {
      system.spawn(LONG_RANGE_SHELL, vec3(0, 100 + i * 40, 0), vec3(0, 0, 1), 'tester');
    }
    expect(system.activeCount).toBe(4);
    expect(system.inFlight).toHaveLength(4);

    system.clear();
    expect(system.activeCount).toBe(0);
  });
});



