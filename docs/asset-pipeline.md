# Asset pipeline

Every model, texture and sound in the game is **generated in-project** by `tools/build-assets.mjs`. Nothing
is downloaded, imported, or licensed (ADR-0015). This document describes what is produced and, more
importantly, the contract the runtime relies on — because the contract is the part that has to survive someone
replacing these assets with real art later.

## Commands

| Command | What it does |
| --- | --- |
| `npm run assets` | Regenerates everything under `public/assets/`. Deterministic: two runs produce byte-identical files. |
| `npm run assets:audit` | Boots the real game in a headless browser and asserts the pipeline end to end. See [Verification](#verification). |
| `npm run verify` | Typecheck, lint and unit tests. Fast; runs on every save. |
| `npm run verify:browser` | Build, then run the browser audit. Slow; run before owner review. |

## Output

62 files, about 6.2 MB: 3 models, 41 textures (albedo / normal / packed metallic-roughness sets), 17 WAV
sounds at 22.05 kHz mono, and `manifest.json` recording what exists and where it came from.

## The coordinate contract

**Metres, Y-up, +Z forward (nose), +X right.** This is the convention the simulation uses for a hull heading
and the one Babylon wants, so the loader needs no axis swap and the orientation helpers in
`vehicle-visual.ts` stay the identity.

glTF itself is right-handed with −Z forward. Rather than baking that conversion into every vertex — the
mistake that produces a model subtly wrong in a way nobody notices until it drives backwards — the exporter
writes **one rotation on one node**, and the loader's contract absorbs it. The asset tests assert that no node
other than `Tank` carries a rotation, so a change that starts baking per-vertex conversion fails the suite.

## The node contract

A model must define these nodes, or `loadVehicleRig` throws and the game refuses to start. Loud by design: a
tank missing its gun should say so, not render with the turret fused to the hull.

| Node | Purpose |
| --- | --- |
| `Tank` | Root. The renderer poses only this. |
| `Hull` | Hull body. Its extent is what the loader scales against. |
| `Turret` | Turret. Rotated by traverse. |
| `Gun` | Barrel. Child of `Turret`; elevation is a child rotation. |
| `Muzzle` | Empty marker at the muzzle. Effects and audio read its world position. |
| `WheelL0…`, `SprocketL`, `IdlerL`, … | Spun by distance ÷ radius. Radius is measured from the node's own bound. |
| `TrackL0…` | Offset vertically each frame to follow the ground. |

## What the loader normalises, and why it lives there

`src/client/assets/vehicle-asset.ts` is the only file that knows glTF exists. `VehicleVisual` consumes an
already-normalised rig and contains no asset knowledge at all. The brief asks for exactly this: *"normalise
those cleanly rather than spreading special-case offsets throughout gameplay code."*

### Handedness — a `Tank` node for the renderer, and `TankModel` beneath it

This is the subtle one, and it was found by reading a rendered node's world matrix back in a browser rather
than by any test.

Babylon's glTF loader attaches a **rotation quaternion** to the model's root to convert glTF's right-handed
convention into Babylon's left-handed one. Babylon's rule is that a non-null `rotationQuaternion` *replaces*
`rotation` — Euler angles are not composed with it, they are ignored.

So a renderer assigning `root.rotation.y` on that node writes into a field nothing reads, and the tank drives
around the map at a fixed orientation no matter how the player steers. The assignment type-checks, the value
is correct, and no assertion fails.

The fix is structural: the loaded root keeps its quaternion and is reparented under a fresh `Tank` node,
which the renderer drives with plain Euler angles. The two compose the way the format intends, and the
gameplay code never learns about glTF.

A 180° correction is composed into the model's **quaternion**, not the driver's Euler angles, for the same
reason from the other side: `VehicleVisual.apply()` assigns `root.rotation.y` from the hull heading every
frame, so a correction written there would be overwritten by the next frame.

### Scale

The hull's extent is measured and compared against `VehicleDefinition.dimensions.lengthM`, which the
simulation already treats as authoritative for collision and armour. A mismatch of more than 2% is corrected.

The measurement is always recorded in `normalisationNote`, whether or not a correction was applied. A loader
that stays silent when it decides nothing is wrong cannot be distinguished from one that failed to measure
anything — which is precisely the bug this file once had, and why the number is reported unconditionally.

### Two Babylon behaviours worth knowing

Both are invisible in the types and both cost real debugging time.

1. **A glTF node carrying geometry becomes an `AbstractMesh`, not a `TransformNode`.** So hull, turret, gun,
   wheels and tracks all arrive in `container.meshes`, and only the empty `Tank` root arrives in
   `container.transformNodes`. Searching `transformNodes` alone finds the root and nothing else, and reports
   "no hull node named 'Hull'" for a model that plainly has one.
2. **A part's geometry is a leaf, not a subtree.** `container.meshes.filter((m) => m.parent === hull)` — the
   obvious way to measure a part — returns nothing for the hull, because the hull mesh's parent is the model
   root. That made the scale normalisation silently measure zero, skip its correction, and report
   "none needed", while the model rendered 26% too small.

## Verification

Three layers, because they catch different things.

**`npm run verify`** — fast and headless. `tests/tools/asset-pipeline.test.ts` reads the generated *numbers*,
not the code that produced them: no NaN coordinates, every proportion present, hull length matching the
definition, the node contract satisfied, the handedness rotation isolated to one node, and the manifest
matching what is on disk.

This layer exists because of a specific bug. `deriveDimensions` returned only its derived values, so five
proportions the hull builder read were `undefined`; `widthM * undefined` is NaN; and 252 of the hull's 492
vertices were written as NaN. The resulting GLB was structurally valid, loaded without error, and rendered —
Babylon computed a finite bounding box from the 240 vertices that survived. The only symptom was a tank that
looked slightly small. TypeScript, ESLint and every existing test passed.

A defect in *data* is invisible to assertions about *code*, which is why these tests read the file.

**`npm run assets`** — the build itself rejects non-finite geometry before writing, naming the vertex and the
likely cause. It also no longer wipes its output directory first: validation throws partway through, and
emptying the tree beforehand left the game fetching truncated files and reporting `Unexpected magic`, which
points at the runtime rather than at the build step that broke.

**`npm run assets:audit`** — the real game, in headless Chrome. 31 assertions against the live scene graph:
the rig resolved, scale matches the definition, **the hull's world forward agrees with the simulation's to
within 2.5°**, PBR materials and normal maps are actually applied, the terrain has its detail texture, and the
audio graph builds with all 17 buffers decoded.

That orientation check is the one thing nothing else can do. `tests/client/controls.test.ts` compares helper
functions to each other and never looks at a loaded mesh; a screenshot of a mirrored tank still looks like a
tank. Only reading a rendered node's world matrix back proves it.

## Replacing these assets

The pipeline exists to make the assets replaceable, so this is the intended path for real art:

1. Author in **metres, Y-up, +Z forward**, with the node names in the table above.
2. Put the handedness conversion on one root rotation, or export +Z forward directly and adjust.
3. Drop the file in `public/assets/models/` and point the vehicle's `visualId` at it in
   `src/client/assets/asset-manifest.ts`.
4. Run `npm run assets:audit`.

Nothing in `src/core` or `src/client/render` needs to change. That is the test of whether the pipeline is
doing its job.

## Known limitations

- **The models are prototypes.** Primitive topology, no animation rig, low triangle counts. They are not
  production assets and must not be described as such.
- **Vertex colours carry the tonal variation** between plates, not textures. A real model would drive that
  from albedo maps and vertex AO.
- **There is no LOD system.** At 976 triangles per vehicle this is not yet a problem; real models will need one.
- **The prop library is generated but not yet instanced.** `props.glb` is built, validated and shipped, and
  `battlefield-props.ts` still constructs its geometry directly from map data. Connecting the two is
  straightforward and affects neither collision nor the Marlowe Crossing layout.
- **No skeletal animation.** Recoil, track scroll and wheel spin are all transform manipulation, which is
  correct for a tracked vehicle but would be replaced by authored clips if the models gained skeletons.