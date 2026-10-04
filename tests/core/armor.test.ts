import { describe, expect, it } from 'vitest';
import {
  buildWorldPlates,
  localToWorld,
  raycastPlates,
} from '../../src/core/armor/geometry.js';
import { effectiveArmorMm, resolvePenetration } from '../../src/core/armor/penetration.js';
import { type Vec3, vec3 } from '../../src/shared/vec3.js';
import { CT_MEDIUM } from '../../src/shared/roster.js';
import type { ArmorPlate, VehicleDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * Armour geometry and penetration tests.
 *
 * These matter most in V3, because armour arithmetic is exactly the kind of code that produces
 * **plausible but wrong** numbers: a transposed vector or a sign slip yields results that still look
 * reasonable and still pass a casual eyeball. So most assertions are against **hand-computed values**,
 * not against whatever the implementation happens to print.
 */

const MODEL = CT_MEDIUM.penetration;
const SHELL = CT_MEDIUM.mainShell;

/** A vehicle with a single flat plate facing +Z, for isolating the maths from any real layout. */
function flatPlate(overrides: Partial<ArmorPlate> = {}): VehicleDefinition {
  return {
    ...CT_MEDIUM,
    armor: [
      {
        id: 'test-plate',
        region: 'test',
        mount: 'hull',
        thicknessMm: 100,
        centerM: vec3(0, 0, 5),
        widthM: 4,
        heightM: 4,
        yawDeg: 0,
        pitchDeg: 0,
        ...overrides,
      },
    ],
  };
}

describe('localToWorld', () => {
  it('places a local point forward of the origin when facing +Z', () => {
    expect(localToWorld(vec3(0, 0, 0), 0, vec3(0, 1, 3))).toEqual(vec3(0, 1, 3));
  });

  it('rotates a forward offset to the right for a 90-degree heading', () => {
    // Heading 90Â° means facing +X, so local +Z must map to world +X.
    const world = localToWorld(vec3(0, 0, 0), Math.PI / 2, vec3(0, 0, 2));
    expect(world.x).toBeCloseTo(2, 9);
    expect(world.z).toBeCloseTo(0, 9);
  });

  it('offsets by the vehicle origin', () => {
    const world = localToWorld(vec3(10, 5, -3), 0, vec3(0, 0, 1));
    expect(world.x).toBeCloseTo(10, 9);
    // The local point has no vertical offset, so only the origin's height applies.
    expect(world.y).toBeCloseTo(5, 9);
    expect(world.z).toBeCloseTo(-2, 9);
  });
});

describe('plate raycasting', () => {
  it('hits a square-on plate exactly at its front face', () => {
    const plates = buildWorldPlates(flatPlate(), vec3(0, 0, 0), 0, 0);
    // The plate's outer surface is at z = 5 and its thickness runs inward to z = 4.9, so a shell
    // approaching from z > 5 must stop at 5, not at the inner face.
    const hit = raycastPlates(plates, vec3(0, 0, 10), vec3(0, 0, -1), 100);

    expect(hit).not.toBeNull();
    expect(hit!.point.z).toBeCloseTo(5, 6);
  });

  it('reports the plate normal pointing back at the shooter', () => {
    const plates = buildWorldPlates(flatPlate(), vec3(0, 0, 0), 0, 0);
    const hit = raycastPlates(plates, vec3(0, 0, 0), vec3(0, 0, 1), 100);

    // The plate faces +Z, so its outward normal is +Z, opposing the incoming shell.
    expect(hit!.plate.normal.z).toBeCloseTo(1, 6);
    expect(hit!.plate.normal.x).toBeCloseTo(0, 6);
    expect(hit!.plate.normal.y).toBeCloseTo(0, 6);
  });

  it('misses when the ray passes beside the plate', () => {
    const plates = buildWorldPlates(flatPlate({ widthM: 2 }), vec3(0, 0, 0), 0, 0);
    // 10 m off to the side, well outside a 2 m wide plate.
    expect(raycastPlates(plates, vec3(10, 0, 0), vec3(0, 0, 1), 100)).toBeNull();
  });

  it('misses when the ray passes above the plate', () => {
    const plates = buildWorldPlates(flatPlate({ heightM: 1 }), vec3(0, 0, 0), 0, 0);
    expect(raycastPlates(plates, vec3(0, 5, 0), vec3(0, 0, 1), 100)).toBeNull();
  });

  it('misses when the ray stops short of the plate', () => {
    const plates = buildWorldPlates(flatPlate(), vec3(0, 0, 0), 0, 0);
    // Only 3 m of range to a plate 5 m away.
    expect(raycastPlates(plates, vec3(0, 0, 0), vec3(0, 0, 1), 3)).toBeNull();
  });

  it('does not register a hit from behind, only from the front face', () => {
    // A shell that has already passed the outer surface must not register on the back face, or a ray
    // starting inside the vehicle would appear to hit it.
    const plates = buildWorldPlates(flatPlate({ thicknessMm: 100 }), vec3(0, 0, 0), 0, 0);
    // Starting at z = 4 (behind the plate's inner face at z = 4.9) and travelling away from it.
    expect(raycastPlates(plates, vec3(0, 0, 4.95), vec3(0, 0, -1), 100)).toBeNull();
  });

  it('selects the nearest plate when several are along the ray', () => {
    const near = flatPlate({ id: 'near', centerM: vec3(0, 0, 3) });
    const far = flatPlate({ id: 'far', centerM: vec3(0, 0, 8) });
    const plates = buildWorldPlates(
      { ...near, armor: [...near.armor, ...far.armor] },
      vec3(0, 0, 0),
      0,
      0,
    );

    const hit = raycastPlates(plates, vec3(0, 0, 0), vec3(0, 0, 1), 100);
    expect(hit!.plate.definition.id).toBe('near');
  });

  it('follows the turret heading for turret-mounted plates', () => {
    // A turret plate 5 m ahead, with the turret turned 90Â°, must move to the side. This proves the
    // mount is respected and turret plates are not simply bolted to the hull.
    const definition = flatPlate({ mount: 'turret' });
    const forward = buildWorldPlates(definition, vec3(0, 0, 0), 0, 0)[0]!;
    const turned = buildWorldPlates(definition, vec3(0, 0, 0), 0, Math.PI / 2)[0]!;

    expect(forward.center.z).toBeCloseTo(5, 6);
    expect(forward.center.x).toBeCloseTo(0, 6);
    expect(turned.center.x).toBeCloseTo(5, 6);
  });

  it('raises turret plates to the ring height', () => {
    const definition = flatPlate({ mount: 'turret', centerM: vec3(0, 0, 5) });
    const plate = buildWorldPlates(definition, vec3(0, 0, 0), 0, 0)[0]!;
    expect(plate.center.y).toBeCloseTo(CT_MEDIUM.turret.ringHeightM, 6);
  });

  it('does not raise hull plates', () => {
    const definition = flatPlate({ mount: 'hull', centerM: vec3(0, 0, 5) });
    const plate = buildWorldPlates(definition, vec3(0, 0, 0), 0, 0)[0]!;
    expect(plate.center.y).toBeCloseTo(0, 6);
  });
});

describe('effective armour', () => {
  it('equals the nominal thickness for a perpendicular hit', () => {
    expect(effectiveArmorMm(100, 0)).toBeCloseTo(100, 6);
  });

  it('doubles at 60 degrees, the textbook case', () => {
    // cos(60Â°) = 0.5, so the shell travels twice as far through the plate.
    expect(effectiveArmorMm(100, 60)).toBeCloseTo(200, 6);
  });

  it('is unchanged by half the nominal thickness at 60 degrees', () => {
    // The relationship is linear in nominal thickness: 50 mm at 60Â° presents the same 100 mm that
    // 100 mm does head-on. This is what makes sloping interchangeable with adding plate.
    expect(effectiveArmorMm(50, 60)).toBeCloseTo(100, 6);
  });

  it('rises monotonically with angle', () => {
    let previous = 0;
    for (let deg = 0; deg <= MODEL.ricochetThresholdDeg - 1; deg += 5) {
      const value = effectiveArmorMm(100, deg);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('stays finite at 90 degrees, where cosine is zero', () => {
    // The ricochet rule should prevent this being reached in play, but a direct call must not produce
    // Infinity, which would poison any arithmetic downstream of it.
    expect(Number.isFinite(effectiveArmorMm(100, 90))).toBe(true);
  });
});

describe('penetration outcomes', () => {
  it('penetrates a thin plate shot square on', () => {
    const result = resolvePenetration(SHELL, MODEL, 50, 0, 800);
    expect(result.outcome).toBe('penetrated');
    expect(result.nominalArmorMm).toBe(50);
    expect(result.effectiveArmorMm).toBeCloseTo(50, 6);
  });

  it('is blocked by a plate thicker than its penetration square on', () => {
    const result = resolvePenetration(SHELL, MODEL, 400, 0, 800);
    expect(result.outcome).toBe('blocked');
    expect(result.penetrationMarginMm).toBeLessThan(0);
  });

  it('penetrates square on but is blocked at a steeper angle, for the same plate', () => {
    // The single most important property of the model: identical shell, identical plate, different
    // outcome purely from angle.
    //
    // Hand-computed at 60 degrees: geometric factor 1/cos(60Â°) = 2, so 120 mm presents 240 mm, while
    // a half-normalised 150 mm shell reaches 150 Ã— (1 + 0.5 Ã— (2 âˆ’ 1)) = 225 mm. 225 < 240, blocked.
    const squareOn = resolvePenetration(SHELL, MODEL, 120, 0, 800);
    const angled = resolvePenetration(SHELL, MODEL, 120, 60, 800);

    expect(squareOn.outcome).toBe('penetrated');
    expect(squareOn.effectiveArmorMm).toBeCloseTo(120, 6);
    expect(squareOn.shellPenetrationMm).toBeCloseTo(150, 6);

    expect(angled.outcome).toBe('blocked');
    expect(angled.effectiveArmorMm).toBeCloseTo(240, 6);
    expect(angled.shellPenetrationMm).toBeCloseTo(225, 6);
  });

  it('reports the margin that decided the outcome', () => {
    const result = resolvePenetration(SHELL, MODEL, 120, 30, 800);
    expect(result.penetrationMarginMm).toBeCloseTo(
      result.shellPenetrationMm - result.effectiveArmorMm,
      9,
    );
  });

  it('penetrates less as the shell gets slower', () => {
    const fast = resolvePenetration(SHELL, MODEL, 150, 0, 800);
    const slow = resolvePenetration(SHELL, MODEL, 150, 0, 400);

    expect(slow.shellPenetrationMm).toBeCloseTo(fast.shellPenetrationMm / 2, 6);
    // A slow shell can still beat a thin plate, so the model must not simply refuse.
    expect(resolvePenetration(SHELL, MODEL, 40, 0, 400).outcome).toBe('penetrated');
    expect(resolvePenetration(SHELL, MODEL, 40, 0, 100).outcome).toBe('blocked');
  });

  it('applies nominal penetration unchanged at the reference velocity', () => {
    const result = resolvePenetration(SHELL, MODEL, 100, 0, MODEL.referenceVelocityMps);
    expect(result.shellPenetrationMm).toBeCloseTo(SHELL.nominalPenetrationMm, 6);
  });
});

describe('normalisation', () => {
  it('gives no benefit at zero degrees, whatever the normalisation value', () => {
    // At 0 degrees the geometric factor is 1, so there is no penalty to cancel.
    for (const n of [0, 0.5, 1]) {
      const result = resolvePenetration({ ...SHELL, normalization: n }, MODEL, 100, 0, 800);
      expect(result.shellPenetrationMm).toBeCloseTo(SHELL.nominalPenetrationMm, 6);
    }
  });

  it('cancels none of the angle penalty at normalisation 0', () => {
    const result = resolvePenetration({ ...SHELL, normalization: 0 }, MODEL, 100, 45, 800);
    expect(result.shellPenetrationMm).toBeCloseTo(SHELL.nominalPenetrationMm, 6);
  });

  it('cancels the whole angle penalty at normalisation 1', () => {
    // Fully normalised: the shell's capability and the plate's resistance are both scaled by the same
    // geometric factor, so the angle cancels out of the comparison and only the ricochet rule protects
    // steeply sloped armour.
    //
    // Asserted as an *outcome* and a margin, because "the ratio is unchanged" is the actual property. At
    // 45Â° the factor is 1/cos(45Â°) â‰ˆ 1.4142, so a 200 mm plate presents 282.8 mm and the shell reaches
    // 150 Ã— 1.4142 â‰ˆ 212.1 mm â€” still blocked, exactly as it is head-on.
    const shell = { ...SHELL, normalization: 1 };
    const headOn = resolvePenetration(shell, MODEL, 200, 0, 800);
    const angled = resolvePenetration(shell, MODEL, 200, 45, 800);

    expect(headOn.outcome).toBe('blocked');
    expect(angled.outcome).toBe('blocked');

    // The invariant is the **ratio** of capability to resistance, not the raw numbers: both scale by
    // the geometric factor, so a 200 mm plate presenting 282.8 mm against a 212.1 mm shell is the same
    // 0.75 ratio as 200 against 150 head-on. The margin itself *does* grow, and must not be asserted
    // to be constant.
    const ratio = (r: typeof headOn) => r.shellPenetrationMm / r.effectiveArmorMm;
    expect(ratio(angled)).toBeCloseTo(ratio(headOn), 6);
    expect(ratio(headOn)).toBeCloseTo(150 / 200, 6);

    // A plate the shell can beat head-on is still beatable at an angle.
    expect(resolvePenetration(shell, MODEL, 100, 0, 800).outcome).toBe('penetrated');
    expect(resolvePenetration(shell, MODEL, 100, 45, 800).outcome).toBe('penetrated');
  });

  it('cancels exactly half the penalty at normalisation 0.5', () => {
    // At 60 degrees the geometric factor is 2, so a half-normalised shell gets 1 + 0.5 Ã— (2 âˆ’ 1) = 1.5.
    const result = resolvePenetration({ ...SHELL, normalization: 0.5 }, MODEL, 100, 60, 800);
    expect(result.shellPenetrationMm).toBeCloseTo(SHELL.nominalPenetrationMm * 1.5, 6);
  });

  it('interpolates monotonically between the extremes', () => {
    const at60 = (n: number) =>
      resolvePenetration({ ...SHELL, normalization: n }, MODEL, 100, 60, 800).shellPenetrationMm;

    expect(at60(0)).toBeLessThan(at60(0.25));
    expect(at60(0.25)).toBeLessThan(at60(0.5));
    expect(at60(0.5)).toBeLessThan(at60(0.75));
    expect(at60(0.75)).toBeLessThan(at60(1));
  });

  it('clamps a normalisation value outside [0, 1]', () => {
    // Above 1 a shell would *gain* capability from an angled hit, which is not a thing. The shell is
    // validated at load, but the resolver must not depend on that having happened.
    const over = resolvePenetration({ ...SHELL, normalization: 5 }, MODEL, 100, 60, 800);
    const clamped = resolvePenetration({ ...SHELL, normalization: 1 }, MODEL, 100, 60, 800);
    expect(over.shellPenetrationMm).toBeCloseTo(clamped.shellPenetrationMm, 9);

    const under = resolvePenetration({ ...SHELL, normalization: -2 }, MODEL, 100, 60, 800);
    const zero = resolvePenetration({ ...SHELL, normalization: 0 }, MODEL, 100, 60, 800);
    expect(under.shellPenetrationMm).toBeCloseTo(zero.shellPenetrationMm, 9);
  });

  it('still lets sloping defeat a fully normalised shell, through ricochet', () => {
    const result = resolvePenetration({ ...SHELL, normalization: 1 }, MODEL, 100, 80, 800);
    expect(result.outcome).toBe('ricocheted');
  });
});

describe('ricochet', () => {
  it('penetrates just below the threshold', () => {
    const result = resolvePenetration(SHELL, MODEL, 20, MODEL.ricochetThresholdDeg - 1, 800);
    expect(result.outcome).not.toBe('ricocheted');
  });

  it('ricochets exactly at the threshold', () => {
    const result = resolvePenetration(SHELL, MODEL, 20, MODEL.ricochetThresholdDeg, 800);
    expect(result.outcome).toBe('ricocheted');
  });

  it('ricochets above the threshold however thin the plate is', () => {
    // Even a 1 mm plate deflects at a severe angle: the rule is about the impact, not the armour.
    expect(resolvePenetration(SHELL, MODEL, 1, 85, 800).outcome).toBe('ricocheted');
  });

  it('reports the nominal thickness, not an inflated value, on a ricochet', () => {
    // A shell that never engaged the plate did not meet its effective thickness. Reporting the huge
    // geometric value here would be misleading rather than informative.
    const result = resolvePenetration(SHELL, MODEL, 100, 85, 800);
    expect(result.effectiveArmorMm).toBeCloseTo(100, 6);
    expect(result.shellPenetrationMm).toBe(0);
  });

  it('never penetrates when ricocheting, however capable the shell is', () => {
    const monster = { ...SHELL, nominalPenetrationMm: 100000, normalization: 1 };
    expect(resolvePenetration(monster, MODEL, 1, 80, 800).outcome).toBe('ricocheted');
  });
});

describe('real armour layouts', () => {
  /** The player's tank at the origin, so plate geometry can be probed directly. */
  function probe(from: Vec3, to: Vec3) {
    const plates = buildWorldPlates(CT_MEDIUM, vec3(0, 0, 0), 0, 0);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return raycastPlates(plates, from, vec3(dx / len, dy / len, dz / len), len);
  }

  it('presents a much larger impact angle at the sloped front than at the flat side', () => {
    const front = probe(vec3(0, 0.85, 40), vec3(0, 0.85, 0))!;
    const side = probe(vec3(40, 0.6, 0), vec3(0, 0.6, 0))!;

    // Shooting from +X meets the right-hand plate.
    expect(front.plate.definition.id).toBe('hull-front');
    expect(side.plate.definition.id).toBe('hull-right');

    const frontAngle = incidenceBetween(front.plate.normal, vec3(0, 0, -1));
    const sideAngle = incidenceBetween(side.plate.normal, vec3(-1, 0, 0));
    // The sloped front presents 60Â° to a level shot; the flat side presents 0Â°.
    expect(frontAngle).toBeCloseTo(60, 3);
    expect(sideAngle).toBeCloseTo(0, 6);
  });

  it('blocks a level shot at the sloped front plate but penetrates the thin rear', () => {
    const front = probe(vec3(0, 0.85, 40), vec3(0, 0.85, 0))!;
    const rear = probe(vec3(0, 0.6, -40), vec3(0, 0.6, 0))!;

    expect(front.plate.definition.region).toBe('hull-front');
    expect(rear.plate.definition.region).toBe('hull-rear');

    const frontResult = resolvePenetration(
      SHELL,
      MODEL,
      front.plate.definition.thicknessMm,
      incidenceBetween(front.plate.normal, vec3(0, 0, -1)),
      800,
    );
    const rearResult = resolvePenetration(
      SHELL,
      MODEL,
      rear.plate.definition.thicknessMm,
      incidenceBetween(rear.plate.normal, vec3(0, 0, 1)),
      800,
    );

    // Hand-computed: the front plate is 200 mm at 60Â°, so it presents 400 mm against a 225 mm shell.
    expect(frontResult.effectiveArmorMm).toBeCloseTo(400, 3);
    expect(frontResult.outcome).toBe('blocked');

    // The rear plate is a flat 50 mm, which the shell goes straight through.
    expect(rearResult.effectiveArmorMm).toBeCloseTo(50, 6);
    expect(rearResult.outcome).toBe('penetrated');
  });

  it('gives front, side and rear three different nominal thicknesses', () => {
    const front = probe(vec3(0, 0.85, 40), vec3(0, 0.85, 0))!;
    const side = probe(vec3(40, 0.6, 0), vec3(0, 0.6, 0))!;
    const rear = probe(vec3(0, 0.6, -40), vec3(0, 0.6, 0))!;

    expect(front.plate.definition.thicknessMm).toBeGreaterThan(side.plate.definition.thicknessMm);
    expect(side.plate.definition.thicknessMm).toBeGreaterThan(rear.plate.definition.thicknessMm);
  });

  it('selects a turret plate when firing above the hull roof', () => {
    expect(probe(vec3(0, 2.2, 40), vec3(0, 2.2, 0))!.plate.definition.mount).toBe('turret');
  });

  it('selects a hull plate when firing at hull height', () => {
    expect(probe(vec3(0, 0.6, 40), vec3(0, 0.6, 0))!.plate.definition.mount).toBe('hull');
  });

  it('gives every plate a unique id', () => {
    const ids = CT_MEDIUM.armor.map((plate) => plate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every plate a positive thickness and non-zero extent', () => {
    for (const plate of CT_MEDIUM.armor) {
      expect(plate.thicknessMm).toBeGreaterThan(0);
      expect(plate.widthM).toBeGreaterThan(0);
      expect(plate.heightM).toBeGreaterThan(0);
    }
  });
});

/**
 * Angle in degrees between the **reversed** travel direction and a surface normal.
 *
 * Reversing is the V2 convention (`computeIncidenceAngleDeg`): a shell meets a surface along the line it
 * came from, so 0Â° means driving straight in. Measuring against the forward direction instead reports
 * 180Â° âˆ’ incidence, which looks plausible and is the mirror image of the truth.
 */
function incidenceBetween(normal: Vec3, travelDirection: Vec3): number {
  const reversed = vec3(-travelDirection.x, -travelDirection.y, -travelDirection.z);
  return angleBetween(normal, reversed);
}

/** Plain angle between two unit vectors, degrees. */
function angleBetween(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}