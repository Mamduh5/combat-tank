import type { BattlefieldData, MapZone } from '../battlefield.js';
import type { ArenaCover, LevelCorridor } from '../terrain.js';
import type { Structure } from '../structures.js';
import type { ConcealmentZone } from '../concealment.js';

/**
 * **Marlowe Crossing** — the V6 battlefield.
 *
 * ## What replaced what, and why
 *
 * The previous map was a mountain valley: a long ridge down one side, a cut down the other, and a floor
 * between them that was still sloped. It looked like a map from above and felt like driving on a
 * hillside almost everywhere. That is not fixed by making the terrain flat — it is a problem of
 * *proportion*. A map is enjoyable when most of its surface is comfortable and the difficult parts are
 * named places you choose to go to.
 *
 * So this one is a **rural railway battlefield**, and the design is stated as the four things a player
 * should be able to say out loud after thirty seconds:
 *
 * > *town side / railway / fields / elevated side*
 *
 * Those are not decoration. Each one is a route, and each produces a different fight.
 *
 * ## The four routes, and what each one costs you
 *
 * 1. **The town route** — through Marlowe village, between the cottages, the goods shed and the water
 *    tower. Short sight lines, hard cover on both flanks, and movement measured in metres. You will not
 *    get a long shot here. You will also not be shot from two hundred metres.
 * 2. **The railway route** — along the graded line, crossing at the level crossing. The fastest way
 *    across the map and the most exposed thing on it: the embankment is raised, the ground either side
 *    falls away, and there is nowhere to hide that does not read as a hiding place.
 * 3. **The field route** — south of the line, through open ground. This is where the tank finally
 *    accelerates, turns at speed, and takes a long shot. It is also where both sides can see each other
 *    coming, so it is the route that ends fights fastest and worst.
 * 4. **The elevated flank** — Cairn Height in the north-east. It overlooks the crossing and the eastern
 *    fields, and it costs a long exposed drive to reach. The trade is explicit: sight lines for travel.
 *
 * ## Why the railway is *graded* rather than drawn on
 *
 * The line is a `LevelCorridor` in the height field rather than a strip of meshes laid over the ground.
 * A real railway is cut and filled to hold a gentle gradient across country that is not level, and the
 * visible result — a cutting through a rise, an embankment across a hollow — is exactly what you get
 * here. It also means the crossing is genuinely flat and genuinely crossable, because the ground under
 * it is part of the same surface the vehicles drive on. See `LevelCorridor` in `terrain.ts`.
 *
 * ## The ground, stated as a driveability constraint
 *
 * The base terrain runs at 2.2 m amplitude across three ridge layers, which puts the worst procedurally
 * generated ground near 14 degrees — rolling country, not hillside. Every authored hill is a chain of
 * broad bumps whose steepest face is around 12 degrees, comfortably under the vehicle's 26 degree climb
 * limit, and the only deliberately steeper ground is at the map edge where it is framing rather than
 * route.
 *
 * These numbers are **measured, not asserted**. `tests/core/rural-railway-map.test.ts` samples real
 * gradients along every primary route, both spawns, the level crossing, and the approaches to cover, and
 * fails the build if any of them exceeds the vehicle's limits. The reason that test exists is that a
 * map which looks acceptable from above and is miserable to drive is exactly what this map replaced.
 */

/** Half-extent of the playable ground, metres. */
const HALF_SIZE_M = 250;

/**
 * Authored relief.
 *
 * **Every one of these is broad and gentle, and that is a measured property rather than an intention.**
 * The constraint is `|heightM| / radiusM`: `coverHeight` applies a smoothstep whose maximum slope is
 * `1.5 * height / radius`, so that ratio *is* the steepest face a bump can produce. Every feature below
 * sits near or below 0.08, which is about 7 degrees on its own.
 *
 * That per-feature number is not the whole story, and getting that wrong is what the first draft of this
 * map did. `coverHeight` **adds** every overlapping feature's contribution, so a chain of individually
 * gentle bumps is not gentle — it is as steep as the sum of their gradients at the point where their
 * slopes coincide. Overlap has to be budgeted for, not assumed away. The measurement tool exists because
 * of exactly this: the authored ratios all looked reasonable and the result was a 43 degree face.
 *
 * The shapes are chosen for tactical roles, not for scenery:
 *
 *  - **Cairn Height** is a chain of four bumps running north-east. Overlapping is the point — one wide
 *    bump reads as a lump, a chain reads as a ridge with a crest you can find hull-down ground on — but
 *    they are kept wide and low and spaced so their steep faces do not coincide. This is the map's only
 *    real high ground and the most exposed place on it to reach.
 *  - **The central swell** is the most important object in the list and the least impressive. A 3.6 m rise
 *    across 50 m looks like nothing from the air, but it sits between the two spawns and is tall enough
 *    to break a sight line between hulls at 1.42 m. It is what makes the opening a search rather than a
 *    free shot, and a tank crosses it without noticing it is there — which is the whole point.
 *  - **The hollows** are local depressions. They give a tank somewhere to be that is below the sight line
 *    of the ground around it, without the map ever becoming a trench network.
 */
const COVER_FEATURES: readonly ArenaCover[] = [
  // The central swell: breaks the opening sight line, costs nothing to drive over.
  { id: 'central-swell', x: -10, z: -5, radiusM: 50, heightM: 3.6 },

  // Cairn Height: the elevated flank, north-east.
  //
  // **These four numbers are the result of measuring, not of choosing.** The first draft had them taller
  // and further out, and the measurement tool reported a 43.8 degree face on the approach — undriveable.
  // Three causes, all worth recording because none is obvious:
  //
  //  - `coverHeight` *adds* every overlapping feature's contribution, so a chain of individually gentle
  //    bumps is not gentle. Three bumps within a radius of each other stacked into a cliff.
  //  - They also sat where the **edge rise** ramps up, so the boundary tilt compounded with the hill.
  //  - And the edge rise is a *ring*, so it compounds everywhere at a similar radius rather than only at
  //    the map's corners. That is why the first measurement found steep ground in eight separate places.
  //
  // The fix is lower, further in, and spaced so their steep faces do not coincide. Each bump is now near
  // a 0.07-0.08 height-to-radius ratio, which on its own is about 6 degrees.
  { id: 'cairn-approach', x: 92, z: -112, radiusM: 84, heightM: 5 },
  { id: 'cairn-shoulder', x: 152, z: -140, radiusM: 88, heightM: 6.5 },
  { id: 'cairn-crest', x: 212, z: -140, radiusM: 80, heightM: 5 },
  // Pulled in and lowered from the first draft. It sat almost on the map's edge, where the edge-rise
  // ring was already steep, and the two compounded into the map's worst ground. A ridge that ends in a
  // cliff at the boundary is not a landmark, it is a trap.
  { id: 'cairn-far', x: 236, z: -112, radiusM: 70, heightM: 2.5 },

  // Rolling ground: gentle, and mostly there to stop the fields reading as a table.
  { id: 'south-rise', x: 62, z: 176, radiusM: 92, heightM: 5 },
  { id: 'west-knoll', x: -192, z: -58, radiusM: 86, heightM: 6 },
  { id: 'east-knoll', x: 202, z: 102, radiusM: 82, heightM: 5 },

  // Hollows: somewhere to be below the sight line.
  { id: 'north-hollow', x: -92, z: -162, radiusM: 72, heightM: -4.5 },
  { id: 'south-hollow', x: -62, z: 132, radiusM: 66, heightM: -3.5 },
  { id: 'field-hollow', x: 172, z: 152, radiusM: 62, heightM: -3 },
];

/**
 * The graded routes, and the map's readability all at once.
 *
 * A railway, a town road through the village, a rural road across the fields, and one farm track. They
 * are `LevelCorridor`s, so each one is *graded ground the vehicles drive on* rather than a painted line.
 * That is what makes the level crossing flat and crossable, and what stops the railway from becoming the
 * exact problem this map was built to solve: there is no separate rail collider for a tank to catch on,
 * because the rails are drawn on ground that is already part of the drivable height field.
 *
 * The elevations are authored to a real railway's standard: the mainline falls 1.5 m over 600 m, about
 * 0.25 per cent, which is well inside what a tank can climb at speed. Where the line runs a metre or two
 * above the field to its south, the result reads as an embankment, which is what it should look like.
 *
 * The town road's elevation is pinned to the mainline's **at the crossing** (`2.05 m`). That single number
 * is what makes the level crossing flat rather than a step, and it is asserted by test — a crossing that
 * is a 40 cm lip is technically crossable and still feels broken.
 */
const ROUTES: readonly LevelCorridor[] = [
  {
    id: 'mainline',
    points: [
      { x: -300, y: 2.9, z: -55 },
      { x: -160, y: 2.6, z: -44 },
      { x: -20, y: 2.2, z: -34 },
      { x: 120, y: 1.8, z: -18 },
      { x: 300, y: 1.4, z: 4 },
    ],
    // A rail bed is about 14 m wide including ballast shoulders.
    halfWidthM: 7,
    // A generous blend, so the embankment is a slope over 30 m rather than a bank over 7.
    blendM: 30,
  },
  {
    id: 'town-road',
    points: [
      { x: 30, y: 3.4, z: -300 },
      { x: 31, y: 2.8, z: -150 },
      // The crossing. The same height the mainline is at here, so the two surfaces meet flat.
      { x: 33, y: 2.05, z: -28 },
      { x: 35, y: 1.9, z: 40 },
      { x: 38, y: 2.2, z: 150 },
      { x: 42, y: 2.8, z: 300 },
    ],
    halfWidthM: 5,
    blendM: 18,
  },
  {
    id: 'rural-road',
    points: [
      { x: -300, y: 2.0, z: 135 },
      { x: -120, y: 1.75, z: 120 },
      { x: 60, y: 1.55, z: 106 },
      { x: 300, y: 1.4, z: 88 },
    ],
    halfWidthM: 4.5,
    blendM: 16,
  },
  {
    // A farm track off the rural road to a farm crossing in the west. Its only job is to give the
    // western approach a second way in, so the rail line is not the sole artery on that side.
    id: 'field-track',
    points: [
      { x: -120, y: 1.75, z: 120 },
      { x: -138, y: 2.15, z: 40 },
      { x: -150, y: 2.42, z: -8 },
      { x: -158, y: 2.59, z: -44 },
    ],
    halfWidthM: 3.5,
    blendM: 14,
  },
];

/**
 * Where the level crossing is, in world space.
 *
 * Stated once and exported, because three separate consumers need to agree on it exactly: the crossing
 * deck the renderer draws, the test that measures whether it is flat and crossable, and the map zone that
 * names it for the debug overlay. Three hand-typed copies of a coordinate is three chances to be wrong.
 */
export const LEVEL_CROSSING = { x: 33, z: -28 } as const;

/**
 * Hard cover.
 *
 * Everything here is solid to shells and, unless marked otherwise, to sight. It is one list in the core,
 * read by the ballistics system, by line of sight, and by the renderer, so a wall cannot exist in the
 * picture and not in the simulation.
 *
 * The layout follows the village rather than decorating it. Cottages line the town road with gaps between
 * them you can put a tank through, the goods shed and the water tower close the eastern approach, and the
 * farm buildings are placed to break the long sight line across the northern fields rather than to sit
 * where they would be tidy.
 *
 * **Nothing is placed on a route.** The town road corridor, the railway, and the rural road are all kept
 * clear, and there is a test asserting it — a wall across the main artery of a map is a bug that looks
 * exactly like level design until you try to drive through it.
 */
const STRUCTURES: readonly Structure[] = [
  // --- The station, beside the crossing ---------------------------------------------------
  {
    id: 'station',
    kind: 'building',
    x: 56,
    z: -40,
    halfLengthM: 9,
    halfWidthM: 3.5,
    heightM: 7,
    yawRad: 0.06,
    blocksSight: true,
  },
  {
    id: 'goods-shed',
    kind: 'building',
    x: 76,
    z: -43,
    halfLengthM: 7,
    halfWidthM: 4,
    heightM: 6.5,
    yawRad: -0.04,
    blocksSight: true,
  },
  {
    // The tallest thing near the crossing and the map's best landmark: you can see the water tower from
    // most of the northern half, which is what makes the village findable from the fields.
    id: 'water-tower',
    kind: 'building',
    x: 45,
    z: -47,
    halfLengthM: 2.6,
    halfWidthM: 2.6,
    heightM: 12,
    yawRad: 0,
    blocksSight: true,
  },
  {
    id: 'signal-box',
    kind: 'building',
    x: 26,
    z: -40,
    halfLengthM: 3,
    halfWidthM: 2.4,
    heightM: 5.5,
    yawRad: 0.1,
    blocksSight: true,
  },

  // --- Village, north of the line --------------------------------------------------------
  { id: 'cottage-1', kind: 'building', x: 18, z: -66, halfLengthM: 4.5, halfWidthM: 3.5, heightM: 6, yawRad: 0.08, blocksSight: true },
  { id: 'cottage-2', kind: 'building', x: 45, z: -73, halfLengthM: 5, halfWidthM: 3.5, heightM: 6.5, yawRad: -0.05, blocksSight: true },
  { id: 'cottage-3', kind: 'building', x: 67, z: -70, halfLengthM: 4.5, halfWidthM: 3.5, heightM: 6, yawRad: 0.12, blocksSight: true },
  { id: 'cottage-4', kind: 'building', x: 26, z: -93, halfLengthM: 4.5, halfWidthM: 3.5, heightM: 6, yawRad: -0.08, blocksSight: true },
  { id: 'cottage-5', kind: 'building', x: 55, z: -99, halfLengthM: 5, halfWidthM: 3.5, heightM: 6.5, yawRad: 0.04, blocksSight: true },
  { id: 'cottage-6', kind: 'building', x: 78, z: -95, halfLengthM: 4.5, halfWidthM: 3.5, heightM: 6, yawRad: -0.1, blocksSight: true },
  {
    // A chapel tower: the second landmark, visible from the village approach rather than the fields,
    // which is what makes it useful for telling "I am in the town" from "I am near the town".
    id: 'chapel',
    kind: 'building',
    x: 14,
    z: -113,
    halfLengthM: 4.5,
    halfWidthM: 3.5,
    heightM: 9,
    yawRad: 0,
    blocksSight: true,
  },
  {
    id: 'farmhouse',
    kind: 'building',
    x: 13,
    z: -79,
    halfLengthM: 5.5,
    halfWidthM: 4,
    heightM: 6.5,
    yawRad: -0.06,
    blocksSight: true,
  },
  {
    id: 'farm-barn',
    kind: 'building',
    x: -8,
    z: -85,
    halfLengthM: 8,
    halfWidthM: 5,
    heightM: 7,
    yawRad: 0.03,
    blocksSight: true,
  },
  { id: 'farm-silo', kind: 'building', x: -1, z: -74, halfLengthM: 2.5, halfWidthM: 2.5, heightM: 14, yawRad: 0, blocksSight: true },

  // --- Walls --------------------------------------------------------------------------------
  // Low, and deliberately *not* sight-blocking. A garden wall stops a shell and does nothing else, and
  // having both kinds of wall on this map is what teaches the distinction the `blocksSight` flag exists
  // to carry.
  { id: 'wall-village-a', kind: 'barrier', x: 31, z: -58, halfLengthM: 10, halfWidthM: 0.6, heightM: 1.6, yawRad: 0.02, blocksSight: false },
  { id: 'wall-village-b', kind: 'barrier', x: 61, z: -85, halfLengthM: 9, halfWidthM: 0.6, heightM: 1.6, yawRad: 1.55, blocksSight: false },
  { id: 'wall-yard', kind: 'barrier', x: 14, z: -88, halfLengthM: 7, halfWidthM: 0.6, heightM: 1.6, yawRad: 1.57, blocksSight: false },
  { id: 'wall-station-yard', kind: 'barrier', x: 66, z: -33, halfLengthM: 6, halfWidthM: 0.6, heightM: 1.5, yawRad: 1.5, blocksSight: false },

  // --- The crossing's cover ------------------------------------------------------------------
  // Placed to the *sides* of the road, never on it. The crossing is meant to be the most exposed place
  // on the map, and the way to make that readable rather than merely punishing is to give both banks
  // something to hide behind — so committing to the crossing is a decision with a plan behind it.
  { id: 'crossing-wall-west', kind: 'barrier', x: 18, z: -22, halfLengthM: 6, halfWidthM: 0.8, heightM: 1.9, yawRad: 0.1, blocksSight: true },
  { id: 'crossing-wall-east', kind: 'barrier', x: 50, z: -20, halfLengthM: 6, halfWidthM: 0.8, heightM: 1.9, yawRad: -0.1, blocksSight: true },

  // --- Hedgerows ------------------------------------------------------------------------------
  // Field boundaries. Sight-blocking, because a hedgerow you can see through is not a hedgerow.
  { id: 'hedge-village', kind: 'screen', x: 47, z: -119, halfLengthM: 17, halfWidthM: 0.9, heightM: 2.4, yawRad: 0.02, blocksSight: true },
  { id: 'hedge-fields-west', kind: 'screen', x: -96, z: 131, halfLengthM: 20, halfWidthM: 0.9, heightM: 2.2, yawRad: 0.06, blocksSight: true },
  { id: 'hedge-fields-east', kind: 'screen', x: 121, z: 131, halfLengthM: 18, halfWidthM: 0.9, heightM: 2.2, yawRad: -0.04, blocksSight: true },

  // --- Outlying farms --------------------------------------------------------------------------
  { id: 'west-farm-barn', kind: 'building', x: -166, z: 40, halfLengthM: 9, halfWidthM: 5.5, heightM: 7, yawRad: 0.05, blocksSight: true },
  { id: 'west-farmhouse', kind: 'building', x: -143, z: 62, halfLengthM: 6, halfWidthM: 4, heightM: 6.5, yawRad: -0.04, blocksSight: true },
  { id: 'east-farm-barn', kind: 'building', x: 141, z: 71, halfLengthM: 8.5, halfWidthM: 5, heightM: 7, yawRad: -0.06, blocksSight: true },
  { id: 'east-farmhouse', kind: 'building', x: 163, z: 49, halfLengthM: 6, halfWidthM: 4, heightM: 6.5, yawRad: 0.05, blocksSight: true },
  { id: 'east-silo', kind: 'building', x: 129, z: 49, halfLengthM: 2.5, halfWidthM: 2.5, heightM: 13, yawRad: 0, blocksSight: true },

  // --- Stone: outcrops and field walls --------------------------------------------------------
  { id: 'outcrop-west', kind: 'rock', x: -96, z: -150, halfLengthM: 4.5, halfWidthM: 3.5, heightM: 4.5, yawRad: 0.4, blocksSight: true },
  { id: 'outcrop-cairn', kind: 'rock', x: 186, z: -156, halfLengthM: 5, halfWidthM: 4, heightM: 5, yawRad: -0.3, blocksSight: true },
  { id: 'outcrop-east', kind: 'rock', x: 216, z: -31, halfLengthM: 4, halfWidthM: 3, heightM: 4, yawRad: 0.8, blocksSight: true },
  { id: 'outcrop-south', kind: 'rock', x: -216, z: 156, halfLengthM: 4.5, halfWidthM: 3.5, heightM: 4.5, yawRad: 0.2, blocksSight: true },
  { id: 'outcrop-fields', kind: 'rock', x: -32, z: 176, halfLengthM: 3.5, halfWidthM: 3, heightM: 3.5, yawRad: -0.5, blocksSight: true },
];

/**
 * Concealment.
 *
 * Two strengths with a measurable difference, placed for a reason rather than scattered:
 *
 *  - **Heavy** is Marlowe Wood, a single dense pocket north-east of the village. Approaching through it
 *    genuinely works, and it is the only place on the map where that is true.
 *  - **Light** is scrub, hedgerow thickening and the village edge. It makes you *harder* to see without
 *    hiding you, which is the difference a player has to be able to feel.
 *
 * Every zone here is drawn by the renderer from this same list. Nothing that reduces your detection range
 * exists anywhere else in the game.
 */
const CONCEALMENT: readonly ConcealmentZone[] = [
  {
    id: 'marlowe-wood',
    x: 150,
    z: -190,
    radiusM: 52,
    strength: 'heavy',
    // A dense wood also breaks sight outright, which is what makes it a place to move *behind* rather
    // than merely somewhere you are hard to see.
    blocksSightHeightM: 3.5,
  },
  { id: 'willow-bank', x: 62, z: -176, radiusM: 34, strength: 'light', blocksSightHeightM: 0 },
  { id: 'village-approach', x: 30, z: -152, radiusM: 38, strength: 'light', blocksSightHeightM: 0 },
  { id: 'scrub-west', x: -110, z: 20, radiusM: 30, strength: 'light', blocksSightHeightM: 0 },
  { id: 'scrub-east', x: 150, z: 10, radiusM: 30, strength: 'light', blocksSightHeightM: 0 },
  { id: 'scrub-south', x: 10, z: 190, radiusM: 32, strength: 'light', blocksSightHeightM: 0 },
  { id: 'scrub-station', x: 78, z: -18, radiusM: 26, strength: 'light', blocksSightHeightM: 0 },
];

/**
 * Named places.
 *
 * These exist so the map can be talked about — by tools, by tests, and by the debug overlay — in the
 * same four words the player uses. The ids deliberately match the routes above: `mainline` is both the
 * railway corridor and the zone that names it.
 */
const ZONES: readonly MapZone[] = [
  { id: 'level-crossing', x: LEVEL_CROSSING.x, z: LEVEL_CROSSING.z, radiusM: 26, role: 'The level crossing. Fast, flat, and completely exposed.' },
  { id: 'marlowe-village', x: 42, z: -78, radiusM: 52, role: 'The town route. Cottages, hard cover, short sight lines.' },
  { id: 'the-fields', x: -20, z: 130, radiusM: 90, role: 'The field route. Open, fast, long firing lines.' },
  { id: 'cairn-height', x: 165, z: -165, radiusM: 70, role: 'The elevated flank. Sight lines for travel.' },
  { id: 'marlowe-wood', x: 150, z: -190, radiusM: 52, role: 'Heavy concealment. The only real hiding place.' },
  { id: 'mainline', x: 0, z: -30, radiusM: 60, role: 'The railway. A graded route and a route divider.' },
];

/**
 * The assembled map.
 *
 * ## Why the spawns are where they are
 *
 * Both are on gentle ground, both face roughly toward the middle of the map, and neither can see the
 * other — the central swell is what breaks that line, and it is asserted by test.
 *
 * The distance is the one number with a hard constraint on it. The first Ashford Valley draft put its
 * spawns 266 m apart on a map with a 200 m sight range; neither tank could see the other, so the opponent
 * searched for five minutes and fired nothing, and every screenshot looked fine. Two tanks that cannot
 * see each other and will not move toward each other is not a tactical opening, it is a standoff. These
 * are about 230 m apart — outside comfortable spotting, inside the band where the opponent closes to
 * investigate, and with the swell, the village and the line between them.
 *
 * The player's spawn is in the western fields looking north-east, which frames the level crossing and the
 * village water tower in the initial camera: two landmarks, one of them twelve metres tall, saying "that
 * way" before a single input is read.
 */
export const MARLOWE_CROSSING: BattlefieldData = {
  id: 'marlowe-crossing',
  displayName: 'Marlowe Crossing',
  terrain: {
    seed: 20261010,
    halfSizeM: HALF_SIZE_M,
    /**
     * 1.5 m, and this number is the map's single most important one.
     *
     * The base surface is three sine layers at 340, 170 and 95 m. The shortest sets the scale: its own
     * steepest gradient is `1.5 * 2*PI / 95`, about 5.7 degrees, and the worst case where all three
     * combine is around 9. That is **gently rolling country**, and it is a deliberate move away from
     * 3.5 m on the rejected valley — which was the direct cause of "fighting continuously on a
     * mountainside", because that number sets the steepness of the ground *everywhere*, including on the
     * fields the player is meant to accelerate across.
     *
     * Lowering it does not flatten the map. Everything interesting on this map comes from the authored
     * features below, because those can be placed deliberately and are budgeted for how they overlap.
     * Noise cannot be, and noise at this scale is precisely the wrong tool for a farmland map.
     */
    amplitudeM: 1.5,
    /**
     * 9 m of edge rise, framing rather than containing.
     *
     * **Cut from 20 m, then from 12 m, and both cuts came from measurement rather than taste.** The edge
     * rise is a smoothstep over the outer 38% of the map's radius, so its steepest gradient sits on a
     * *ring* at about 0.81 of the half-size and is roughly `1.5 * edgeRiseM / (0.38 * halfSizeM)`. At
     * 20 m that ring was about 19 degrees on its own, and because it is a ring it passes within 200 m of
     * the map's centre — so it compounded with Cairn Height and with the base ridge layers to produce
     * the map's worst face. At 9 m the ring is about 6.5 degrees: enough to frame the horizon and to
     * stop the world looking like a table, and no longer an obstacle.
     */
    edgeRiseM: 9,
    cover: COVER_FEATURES,
    /**
     * A shallow dish, kept small.
     *
     * This exists for one reason: it nudges both tanks back toward the middle of the map instead of letting
     * one settle in a corner. At 1.2 m it is deep enough to do that over the 90 m bowl radius and far too
     * shallow to be a feature a player notices as terrain.
     */
    bowlDepthM: 1.2,
    levelCorridors: ROUTES,
  },
  structures: STRUCTURES,
  concealment: CONCEALMENT,
  zones: ZONES,
  // The southern fields, west side, facing north-east toward the crossing and the village.
  playerSpawn: { x: -125, z: 80, headingRad: 2.2 },
  // North of the line, east of the village, on open ground with the route back to the crossing available.
  enemySpawn: { x: 65, z: -55, headingRad: -0.85 },
};

/** Every authored map, for tools that want to enumerate them. One map in V6, deliberately. */
export const MAPS: readonly BattlefieldData[] = [MARLOWE_CROSSING];
