/**
 * Concealment: ground that makes a vehicle harder to see, and therefore harder to detect.
 *
 * ## Gameplay concealment and scenery are deliberately different things
 *
 * A bush that reduces your detection range but is not labelled as such is a lie the player cannot
 * detect. A bush that reduces detection range but is not *drawn* is worse. So this module has exactly
 * one concept, `ConcealmentZone`, and the renderer is expected to draw every zone in this list. Props
 * that are purely decorative are **not** put here — they live in the renderer's own scatter and are
 * documented as decorative, so the distinction is intentional rather than accidental.
 *
 * ## The effect is on detection, never on physics or damage
 *
 * Concealment does not stop shells, does not stop a vehicle driving through, and does not change what
 * the armour model does. It changes one number: how far away something can be and still be seen. That
 * keeps the rule legible — "I am in the bushes, they cannot see me from that ridge" — and keeps it
 * impossible for concealment to quietly become invulnerability.
 */

/** How a zone affects detection, expressed so a player can learn it. */
export type ConcealmentStrength =
  /**
   * Light: brush and scrub. Shortens the range at which a vehicle inside is detected, but does not hide
   * it. A vehicle in light cover at 200 m is harder to see than one in the open, and still visible.
   */
  | 'light'
  /**
   * Heavy: dense trees and a full treeline. A vehicle inside is not detected at all beyond a short
   * distance, which is what makes a treeline a usable approach route.
   */
  | 'heavy';

/** The detection multiplier each strength applies. See `SpottingTuning`. */
export const CONCEALMENT_FACTOR: Readonly<Record<ConcealmentStrength, number>> = Object.freeze({
  light: 0.72,
  heavy: 0.4,
});

/**
 * One area of concealment, on the ground plane.
 *
 * A **disc** rather than a polygon. Concealment is applied to a point — "how concealed is the vehicle
 * standing *here*" — and a disc makes that a distance comparison with no geometry to get wrong. Making
 * it a polygon would buy nothing a disc cannot express for a prototype and would cost a containment test
 * on a hot path.
 *
 * The falloff from the centre matters. A hard-edged disc produces a visible line on the ground where
 * concealment stops, which players read as a bug. A smooth falloff means the approach to a treeline is
 * progressively more concealed, which is both truer and more useful tactically.
 */
export interface ConcealmentZone {
  /** Stable id, used by tests and by the renderer. */
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Radius the zone fades out over, metres. */
  readonly radiusM: number;
  /** How strongly it conceals. */
  readonly strength: ConcealmentStrength;
  /**
   * Whether this also blocks line of sight outright, metres of effective height.
   *
   * `0` for ordinary vegetation, which conceals without being opaque. A dense treeline is given a small
   * value so it *also* breaks sight at eye level, which is what makes a treeline something you can move
   * behind rather than merely something you are harder to see in.
   */
  readonly blocksSightHeightM: number;
}

/** How concealed a point is: the combined factor, from 1 (fully visible) down to 0 (invisible). */
export interface ConcealmentSample {
  /** Multiplier on detection range. `1` is open ground. */
  readonly factor: number;
  /** Whether the point is inside any zone at all, for feedback and for tests. */
  readonly concealed: boolean;
  /** Id of the strongest zone affecting the point, or `null` on open ground. */
  readonly strongestZoneId: string | null;
  /** Effective sight-blocking height from vegetation, metres. Zero on open ground. */
  readonly blocksSightHeightM: number;
}

/** Open ground: a sample that says "nothing here conceals you". */
export const OPEN_GROUND: ConcealmentSample = Object.freeze({
  factor: 1,
  concealed: false,
  strongestZoneId: null,
  blocksSightHeightM: 0,
});

/**
 * How concealed the ground is at a point.
 *
 * Zones **combine by taking the strongest**, not by multiplying. Multiplying would make a vehicle
 * standing where two light zones overlap essentially invisible, which is not what overlapping brush
 * does. The strongest zone winning is also the easier rule to explain: "you are concealed by whatever
 * you are hiding in".
 */
export function sampleConcealment(
  zones: readonly ConcealmentZone[],
  x: number,
  z: number,
): ConcealmentSample {
  let bestFactor = 1;
  let strongestId: string | null = null;
  let blocksSightHeightM = 0;

  for (const zone of zones) {
    const dx = x - zone.x;
    const dz = z - zone.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance >= zone.radiusM) {
      continue;
    }

    // Smooth falloff to the edge, so approaching a treeline is progressively more concealed rather
    // than crossing an invisible line. `t` is 1 at the centre and 0 at the rim.
    const t = 1 - distance / zone.radiusM;
    const smooth = t * t * (3 - 2 * t);
    const zoneFactor = 1 - (1 - CONCEALMENT_FACTOR[zone.strength]) * smooth;

    if (zoneFactor < bestFactor) {
      bestFactor = zoneFactor;
      strongestId = zone.id;
    }
    // Sight blocking is likewise strongest in the middle of the zone.
    const zoneBlocks = zone.blocksSightHeightM * smooth;
    if (zoneBlocks > blocksSightHeightM) {
      blocksSightHeightM = zoneBlocks;
    }
  }

  if (strongestId === null) {
    return OPEN_GROUND;
  }
  return { factor: bestFactor, concealed: true, strongestZoneId: strongestId, blocksSightHeightM };
}
