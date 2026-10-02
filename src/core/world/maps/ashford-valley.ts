import type { BattlefieldData, MapZone } from '../battlefield.js';
import { ARENA_COVER, type ArenaCover } from '../terrain.js';
import type { Structure } from '../structures.js';
import type { ConcealmentZone } from '../concealment.js';

/**
 * **Ashford Valley** — the V6 battlefield.
 *
 * ## The design, stated as routes rather than as shapes
 *
 * A map is not a list of mounds; it is a set of questions. This one is built around five, and every
 * feature below exists to make one of them askable:
 *
 * 1. **"Do I cross the open lane?"** The middle of the valley is a flat firing lane, *The Cut*, about
 *    60 m across and completely bare. Crossing it is the fastest route between the two defensive
 *    positions and the most dangerous one. Concrete barriers at its edges let a player who has already
 *    committed somewhere hide while they cross.
 * 2. **"Can I stay hull-down?"** *Kestrel Ridge* runs along the west, high enough to see the whole
 *    valley but with a long back slope, so a tank on the far side shoots over cover rather than over
 *    its own track. The most valuable ground on the map, and the most exposed.
 * 3. **"Should I take the low road?"** *Millbrook Cut* is a depression running north-east, dug below
 *    the surrounding ground. It runs from behind the player's start to behind the outpost, and a
 *    vehicle in it is under the sight line of anything on the valley floor. Slow, a dead end if seen
 *    in it, and the way to reach the enemy's flank unseen.
 * 4. **"I lost sight of them — where will they reappear?"** Every route into the valley has exactly
 *    two places it can spill out: the *Culvert* gap in the north-west rocks, and the farm track past
 *    the red barn. Learning those two gaps is the map's real skill, and it is why the rocks and the
 *    barn are landmarks rather than symmetrical cover.
 * 5. **"Can I use those trees?"** *Ashford Wood* is heavy concealment on the high ground west; a scrub
 *    line along the southern approach is light concealment. Heavy trees hide a tank almost completely,
 *    light scrub only makes it harder. Approaching through the wood works, through the scrub does not.
 *
 * ## Why it is not symmetric
 *
 * The V4 arena was procedurally generated and so had no designer, and its symmetry is a consequence of
 * that. This map is deliberately lopsided: Kestrel Ridge and Millbrook Cut both favour the player's
 * side, while the enemy's side has the outpost and the barn but no equivalent high ground. Winning the
 * opening should be worth something, and the player should be able to see that it was.
 *
 * The effect is that there is no single dominant position, but there *is* a contested one. That is the
 * difference between a battlefield and a shooting range.
 */

/** Half-extent of the playable ground, metres. */
const HALF_SIZE_M = 235;

/**
 * Terrain features, authored.
 *
 * The procedural base supplies the large rolling shape, and these give the valley its floor, its walls
 * and its road. They use the existing `ArenaCover` radial bumps rather than a new feature type, because
 * a bump already blends into the ground with no seam, already has a slope limit a tank can drive, and
 * already feeds the height field the physics mesh is built from. A new primitive would have needed its
 * own collision, its own normal, and its own test for no gameplay gain.
 *
 * The long ridges are **chains of overlapping bumps** rather than one long one. A single wide bump is a
 * hill with a constant slope, which reads as a lump; a chain varies in height along its length, which
 * reads as a ridgeline you can crest and lose sight over. That difference is the whole of the
 * "cresting a ridge" experience, and it costs only more entries.
 */
const FEATURES: readonly ArenaCover[] = [
  ...ARENA_COVER.filter((feature) => feature.id !== 'cover-ridge-centre'),
  // The cutting the centre ridge used to occupy is now the east wall of the valley, moved south and
  // made taller so it is a wall you fight along rather than a bump you drive over.
  { id: 'valley-wall-east', x: 74, z: 30, radiusM: 52, heightM: 7 },
  { id: 'valley-wall-east-north', x: 58, z: 84, radiusM: 40, heightM: 5.5 },

  // --- Kestrel Ridge: the contested high ground on the west -------------------------------
  // Gaps between the bumps are shallow, so the ridge reads as continuous from a distance and is
  // *crestable* from close up: driving up it exposes the hull over the lip for a few seconds at a time.
  { id: 'kestrel-1', x: -104, z: 96, radiusM: 34, heightM: 8.5 },
  { id: 'kestrel-2', x: -116, z: 44, radiusM: 38, heightM: 10 },
  { id: 'kestrel-3', x: -108, z: -12, radiusM: 36, heightM: 9.5 },
  { id: 'kestrel-4', x: -92, z: -66, radiusM: 32, heightM: 7.5 },
  // The back slope: a long ramp falling away west, so a tank behind the ridge is genuinely protected
  // rather than merely adjacent to a bump.
  { id: 'kestrel-backslope', x: -146, z: 20, radiusM: 46, heightM: 4 },

  // --- Millbrook Cut: the depression running north-east ------------------------------------
  // A chain of *negative* bumps, so the lane dips below the valley floor and a vehicle in it sits
  // under the sight line of anything on open ground.
  { id: 'millbrook-head', x: -30, z: 84, radiusM: 26, heightM: -4 },
  { id: 'millbrook-mid', x: 4, z: 58, radiusM: 24, heightM: -3.5 },
  { id: 'millbrook-mouth', x: 34, z: 36, radiusM: 22, heightM: -3 },
  // A lip at the mouth, so the cut has an exit: the moment of exposure when coming out of it.
  { id: 'millbrook-lip', x: 54, z: 18, radiusM: 20, heightM: 2.5 },

  // --- The Cut is deliberately left empty -----------------------------------------------
  // No features here on purpose. The open lane has to be open or the question "do I cross it?" has no
  // answer. The features above frame it rather than fill it.

  // --- The outpost: the enemy's side, lower and harder to argue about ----------------------
  { id: 'outpost-knoll', x: 128, z: -50, radiusM: 38, heightM: 5 },
  { id: 'outpost-approach', x: 96, z: -18, radiusM: 28, heightM: 2.5 },
  // A rocky shoulder south of it, which is what makes the barn route coverable.
  { id: 'barn-shoulder', x: 116, z: 22, radiusM: 30, heightM: 3.5 },

  // --- The north-west rocks: a landmark, and the first place a lost enemy reappears ---------
  { id: 'culvert-hill', x: -68, z: 118, radiusM: 30, heightM: 9 },
  { id: 'culvert-gap', x: -46, z: 96, radiusM: 22, heightM: 3 },
];

/**
 * Hard cover.
 *
 * Placed to answer the routes above rather than to look busy. The rule applied throughout: **a building
 * goes where a route passes it, not where a gap in the terrain needs filling.** Every structure below is
 * on a route, on a firing position, or somewhere a player will want to stop and look.
 *
 * Heights are chosen against the vehicle, not for looks. The player tank is 1.15 m of hull with the
 * turret ring at 1.42 m, so:
 *
 * - `blocksSight: true` structures are 4.5 m or taller, comfortably above a turret sight line, and they
 *   break a sight line between two vehicles sitting on the ground.
 * - `blocksSight: false` barriers are 1.2-1.4 m: tall enough to stop a shell, low enough that a tank
 *   can shoot over it. Those are the pieces that make crossing *The Cut* survivable rather than safe.
 */
const STRUCTURES: readonly Structure[] = [
  // --- The outpost: the enemy's position, and the most valuable building on the map ----------
  { id: 'outpost-main', kind: 'building', x: 134, z: -62, halfLengthM: 13, halfWidthM: 9, heightM: 7, yawRad: 0.2, blocksSight: true },
  { id: 'outpost-shed', kind: 'building', x: 116, z: -68, halfLengthM: 8, halfWidthM: 6, heightM: 4.5, yawRad: -0.4, blocksSight: true },
  { id: 'outpost-wall', kind: 'barrier', x: 122, z: -46, halfLengthM: 16, halfWidthM: 0.8, heightM: 1.4, yawRad: 0.1, blocksSight: false },

  // --- The red barn: the landmark on the eastern approach ---------------------------------
  // Deliberately the most visually distinct structure on the map, because it is what a player uses to
  // orient after losing sight of an enemy.
  { id: 'red-barn', kind: 'building', x: 124, z: 30, halfLengthM: 11, halfWidthM: 7, heightM: 6.5, yawRad: -0.15, blocksSight: true },
  { id: 'barn-wall', kind: 'barrier', x: 106, z: 20, halfLengthM: 12, halfWidthM: 0.8, heightM: 1.3, yawRad: -0.5, blocksSight: false },

  // --- The north-west rocks: the other reappearance point ----------------------------------
  { id: 'culvert-rock-a', kind: 'rock', x: -74, z: 112, halfLengthM: 9, halfWidthM: 7, heightM: 6, yawRad: 0.4, blocksSight: true },
  { id: 'culvert-rock-b', kind: 'rock', x: -60, z: 104, halfLengthM: 6, halfWidthM: 5, heightM: 4.5, yawRad: -0.7, blocksSight: true },
  { id: 'culvert-rock-c', kind: 'rock', x: -84, z: 100, halfLengthM: 5, halfWidthM: 4, heightM: 3.5, yawRad: 1.1, blocksSight: true },

  // --- The Cut: barriers at the edges, so a committed cross is coverable --------------------
  // All `blocksSight: false`. A barrier you can shoot over but not through is what makes the decision
  // "do I cross the open lane?" a decision rather than a formality.
  { id: 'cut-barrier-n', kind: 'barrier', x: 12, z: 14, halfLengthM: 14, halfWidthM: 0.9, heightM: 1.3, yawRad: 0.35, blocksSight: false },
  { id: 'cut-barrier-s', kind: 'barrier', x: 22, z: -14, halfLengthM: 12, halfWidthM: 0.9, heightM: 1.3, yawRad: -0.25, blocksSight: false },
  { id: 'cut-barrier-w', kind: 'barrier', x: -18, z: 2, halfLengthM: 11, halfWidthM: 0.9, heightM: 1.2, yawRad: 1.3, blocksSight: false },
  { id: 'cut-islets', kind: 'barrier', x: 30, z: 4, halfLengthM: 7, halfWidthM: 2.5, heightM: 1.4, yawRad: 0.8, blocksSight: false },

  // --- Kestrel Ridge: hard cover *on* the high ground --------------------------------------
  // A tank holding the ridge needs somewhere to fight from. Without these, holding the ridge means
  // sitting in the open on the most exposed ground on the map, and no rational player takes it.
  { id: 'kestrel-bunker', kind: 'building', x: -112, z: 20, halfLengthM: 9, halfWidthM: 7, heightM: 5.5, yawRad: 0.3, blocksSight: true },
  { id: 'kestrel-wall-n', kind: 'barrier', x: -96, z: 66, halfLengthM: 13, halfWidthM: 0.9, heightM: 1.3, yawRad: -0.2, blocksSight: false },
  { id: 'kestrel-wall-s', kind: 'barrier', x: -94, z: -40, halfLengthM: 12, halfWidthM: 0.9, heightM: 1.3, yawRad: 0.5, blocksSight: false },
  { id: 'kestrel-screen', kind: 'screen', x: -104, z: -22, halfLengthM: 15, halfWidthM: 1.2, heightM: 3.4, yawRad: 0.1, blocksSight: true },

  // --- Millbrook Cut: cover *in* the depression ---------------------------------------------
  // The cut is meant to be survivable, not safe. These give a vehicle in it somewhere to stop.
  { id: 'millbrook-shed', kind: 'building', x: 2, z: 62, halfLengthM: 6, halfWidthM: 5, heightM: 4, yawRad: 0.9, blocksSight: true },
  { id: 'millbrook-wall', kind: 'barrier', x: 20, z: 44, halfLengthM: 9, halfWidthM: 0.9, heightM: 1.2, yawRad: 0.6, blocksSight: false },

  // --- The mill at the head of the cut: the landmark that names the route --------------------
  { id: 'mill', kind: 'building', x: -36, z: 92, halfLengthM: 7, halfWidthM: 6, heightM: 8.5, yawRad: -0.3, blocksSight: true },
];

/**
 * Gameplay concealment.
 *
 * Two strengths, and the difference between them is the whole point of the system: **heavy** hides a
 * tank well enough that an approach through it can work, **light** only makes a tank harder to pick out.
 * A player who learns "the wood is real cover, the scrub is not" has learned something transferable and
 * true, which is the goal. A single strength would make every bush the same decision.
 *
 * `blocksSightHeightM` is zero for scrub and small for the wood, so the treeline can be moved *behind*
 * rather than merely approached through. Scrub conceals without being opaque, which is why running
 * through it and stopping in it are different decisions.
 */
const CONCEALMENT: readonly ConcealmentZone[] = [
  // --- Ashford Wood: heavy, on the western high ground ------------------------------------
  // The approach route. Three overlapping discs so the wood has an irregular edge rather than reading
  // as one perfect circle, and heavy sight-blocking in the middle so it can be fought from inside.
  { id: 'wood-north', x: -92, z: 72, radiusM: 30, strength: 'heavy', blocksSightHeightM: 3.2 },
  { id: 'wood-core', x: -104, z: 34, radiusM: 34, strength: 'heavy', blocksSightHeightM: 3.6 },
  { id: 'wood-south', x: -88, z: -4, radiusM: 28, strength: 'heavy', blocksSightHeightM: 3.0 },
  { id: 'wood-lower', x: -70, z: -34, radiusM: 24, strength: 'heavy', blocksSightHeightM: 2.6 },

  // --- The southern scrub line: light, along the low approach -----------------------------
  // Deliberately the *wrong* kind of cover, placed on the route a player will try first. It shortens
  // detection range but does not hide, so a tank crossing it is still seen from the ridge. Learning
  // that the scrub is not enough is a real tactical lesson and costs nothing to teach.
  { id: 'scrub-a', x: -40, z: -62, radiusM: 22, strength: 'light', blocksSightHeightM: 0 },
  { id: 'scrub-b', x: -8, z: -76, radiusM: 26, strength: 'light', blocksSightHeightM: 0 },
  { id: 'scrub-c', x: 28, z: -66, radiusM: 24, strength: 'light', blocksSightHeightM: 0 },

  // --- Riverside thickets in the cut: heavy, and the reason the low road is viable -----------
  { id: 'cut-thicket-w', x: -18, z: 66, radiusM: 20, strength: 'heavy', blocksSightHeightM: 2.8 },
  { id: 'cut-thicket-e', x: 22, z: 44, radiusM: 18, strength: 'heavy', blocksSightHeightM: 2.4 },

  // --- Light brush around the outpost, so the enemy's ground is not sterile ----------------
  { id: 'outpost-brush', x: 112, z: -34, radiusM: 22, strength: 'light', blocksSightHeightM: 0 },
  { id: 'barn-brush', x: 108, z: 44, radiusM: 20, strength: 'light', blocksSightHeightM: 0 },

  // --- The north-west copse: the approach to the culvert ----------------------------------
  { id: 'copse', x: -58, z: 106, radiusM: 22, strength: 'heavy', blocksSightHeightM: 2.4 },
];

/**
 * Named places.
 *
 * Descriptive only — no gameplay reads these yet. They exist so the debug overlay and the map tools can
 * name what the player is looking at, which is worth more than it sounds: "Millbrook Cut" in an overlay
 * is how a designer talks about the map, and it is the vocabulary V6's own notes will use.
 */
const ZONES: readonly MapZone[] = [
  { id: 'kestrel-ridge', x: -106, z: 20, radiusM: 46, role: 'Contested high ground. Hull-down positions on the west slope.' },
  { id: 'the-cut', x: 8, z: 0, radiusM: 34, role: 'Open firing lane. Fast, exposed, coverable at the edges.' },
  { id: 'millbrook-cut', x: 6, z: 62, radiusM: 40, role: 'The low road. Below the sight line, slow, a flank route.' },
  { id: 'the-outpost', x: 126, z: -52, radiusM: 34, role: 'Enemy position. Buildings, cover, the barn route behind it.' },
  { id: 'the-culvert', x: -66, z: 106, radiusM: 30, role: 'North-west reappearance point. Gap between the rocks.' },
  { id: 'ashford-wood', x: -92, z: 40, radiusM: 46, role: 'Heavy concealment. The western approach.' },
  { id: 'southern-scrub', x: 0, z: -70, radiusM: 44, role: 'Light concealment. Not enough to hide in.' },
];

/**
 * The assembled map.
 *
 * Spawns are placed by hand, which is a change worth noting. V4 scanned the terrain for a "consistent"
 * spot, which is how the encounter ended up on a plateau with the opponent nowhere in sight. On an
 * authored map the spawn *is* a design decision: the player starts behind the wood looking down the
 * valley, the opponent starts in the outpost looking back up it. Neither can see the other at the
 * opening, which is the correct opening for a map with this many routes — the fight starts with both
 * tanks looking for the other rather than trading shots across open ground.
 *
 * Headings face each other roughly, so a player who drives straight forward meets the enemy rather than
 * the map edge.
 */
export const ASHFORD_VALLEY: BattlefieldData = {
  id: 'ashford-valley',
  displayName: 'Ashford Valley',
  terrain: {
    seed: 20261001,
    halfSizeM: HALF_SIZE_M,
    // Lower than V4's 5 m. The valley's shape now comes from the authored features below, and the
    // procedural base only has to supply large rolling ground; letting it also supply tactical relief
    // made the authored features fight the noise instead of sitting on it.
    amplitudeM: 3.5,
    edgeRiseM: 30,
    cover: FEATURES,
    // The shallow dish that kept the V4 encounter near the middle. Kept, because every route on this
    // map is described relative to the middle of the valley.
    bowlDepthM: 2.5,
  },
  structures: STRUCTURES,
  concealment: CONCEALMENT,
  zones: ZONES,
  // **Spawns, and why they are closer than the map is wide.**
  //
  // The first draft put these 266 m apart and the encounter never started. Measured, not guessed: with
  // the opponent 266 m away and a 200 m sight range it could not see the player, so it searched -
  // ``seen, gun idle: 0``, ``final intent: search``, zero shells fired, for five minutes. The batch
  // harness caught it as "no penetration" long before anyone looked at a screenshot, which is exactly
  // what it is for.
  //
  // Two tanks that cannot see each other and will not move toward each other is not a tactical opening,
  // it is a standoff. The player starts behind the wood on the western high ground and the opponent holds
  // the outpost, roughly 190 m apart: outside comfortable spotting, inside the band where the opponent
  // closes to investigate, and with the ridge and the outpost between them so the opening is still a search
  // rather than a free shot.
  playerSpawn: { x: -104, z: 4, headingRad: 1.1 },
  enemySpawn: { x: 96, z: -40, headingRad: Math.PI - 0.35 },
};

/** Every authored map, for tools that want to enumerate them. One map in V6, deliberately. */
export const MAPS: readonly BattlefieldData[] = [ASHFORD_VALLEY];

