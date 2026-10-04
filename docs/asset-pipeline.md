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

63 files, about 7.2 MB: **3 vehicle models** (`ct-medium`, `ct-heavy`, `ct-light`), environment props, 41
textures (albedo / normal / packed metallic-roughness sets), 17 WAV sounds at 22.05 kHz mono, and
`manifest.json` recording what exists and where it came from.

## The vehicle model contract

V7 had a node list and threw when one was missing. That was real, but it was **partial**, and the gap is exactly
what V8 runs into: adding a *second and third* vehicle is only safe if every vehicle is held to the same standard,
and "the loader throws if `Turret` is missing" says nothing about whether a vehicle's hull origin is on the
ground, whether its muzzle points forward, or whether its width matches the definition it claims to be.

So the contract is stated **as data** in `src/shared/vehicle-model-contract.ts`, and the checks are **pure
functions over a plain probe** — numbers and names, with no Babylon types anywhere. That split is the design:

- the **client** builds a probe from the loaded rig and validates it, so a malformed asset fails at load naming
  the vehicle and the rule;
- the **asset tests** build a probe from the generated `.glb` and run the same checks headlessly, so a malformed
  asset is a build failure rather than something only a browser discovers.

One implementation, two callers. A contract checked in two places is a contract that will disagree.

### The rules

| Rule | What it catches |
| --- | --- |
| `missing-node` | A model the runtime cannot rig. Fails the game at boot. |
| `no-meshes` | An empty asset that loads cleanly and renders nothing. |
| `hull-length` (2%) | A model the loader would silently rescale. |
| `hull-width` / `hull-height` | A model built from the wrong spec or the wrong units. |
| `origin-above-ground` | A model whose origin is not on the track contact line, so it sinks into terrain. |
| `turret-pivot-off-centre` | A turret that slews about the wrong point, so aim and the reticle disagree. |
| `forward-axis` / `minimum-muzzle-reach` | A tank facing backwards — which looks like a tank in a screenshot. |
| `materials` | A mesh destruction cannot tint, so it reads as unharmed when the vehicle is destroyed. |
| `wheels` / `track-segments` | Running gear too sparse to conform to terrain. |

### Why width and height are bounded differently

An engineering decision taken in V8 and pinned by `tests/data/model-contract.test.ts`, because the naive version
of this check produced two false failures in a row.

`widthM` is the vehicle **across its tracks**, so it is an absolute ceiling: nothing on the hull may exceed it
laterally, and the bound is a hard `1.0` plus `crossSectionSlackFraction`.

`heightM` is the **structural** hull, roof to floor. But the hull assembly legitimately carries parts that stand
proud of that line — spare track links on the fenders, a stowage bin, exhaust and headlamp housings, the mudguard
lip. Measured against the structural height, those details fail a rule about structure. So height is bounded at
`hullAssemblyMaxHeightFraction` (1.35) instead.

That allowance is not design room, and the test says so: the roster's own hulls sit between 0.77 and 0.97 of the
bound *with* detail in place, while a genuinely mis-scaled model is wrong by a large factor and is caught by
`hull-length` at 2%. Two full orders of magnitude separate "has a stowage bin" from "is the wrong size", and
1.35 sits inside that gap rather than at its edge.

### The float slack

`crossSectionSlackFraction` is `1e-6`, and it exists for one measured reason: a hull constructed at *exactly*
`widthM * 0.5` per side measured `3.5000000000000004` m against a `3.5` m definition and was rejected by a bare
`> 1.0`. The two halves of the test keep it honest — it must stay at or below `1e-6`, and it must stay below
`lengthToleranceFraction`, so it can never grow into a licence to absorb real scale errors.

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

Four layers, because they catch different things. The property that matters is that **each layer can fail when
the others pass** — several defects below were found by exactly one of them.

**1. `npm run verify` — fast and headless.** `tests/tools/asset-pipeline.test.ts` reads the generated
*numbers*, not the code that produced them: no NaN coordinates, every proportion present, hull length and
cross-section matching the definition, the node contract satisfied, the handedness rotation isolated to one
node, and the manifest matching what is on disk. `tests/data/model-contract.test.ts` validates a probe built
from `buildTankModel` against `src/shared/vehicle-model-contract.ts` — **the same validator the runtime loader
uses**, not a reimplementation.

This layer exists because of a specific bug. `deriveDimensions` returned only its derived values, so five
proportions the hull builder read were `undefined`; `widthM * undefined` is NaN; and 252 of the hull's 492
vertices were written as NaN. The resulting GLB was structurally valid, loaded without error, and rendered —
Babylon computed a finite bounding box from the 240 vertices that survived. The only symptom was a tank that
looked slightly small. TypeScript, ESLint and every existing test passed.

A defect in *data* is invisible to assertions about *code*, which is why these tests read the file.

**2. `npm run assets`** — the build itself rejects non-finite geometry before writing, naming the vertex and
the likely cause. It also no longer wipes its output directory first: validation throws partway through, and
emptying the tree beforehand left the game fetching truncated files and reporting `Unexpected magic`, which
points at the runtime rather than at the build step that broke.

**3. `npm run assets:audit`** — the real game, in headless Chrome, **walking the whole roster**. It boots once
and then re-points the running game at each vehicle through the same `selectVehicle` path the player's selector
uses, running ~39 checks per vehicle and finishing with a mesh count that proves the previous encounter was
disposed. It asserts rather than screenshots: a screenshot of a mirrored tank still looks like a tank.

Per vehicle it checks: the rig resolved (root, turret, gun, muzzle, wheels, track segments, meshes); scale and
orientation, including that **the hull's world forward agrees with the simulation's to within 2.5°**; the turret
pivot is over the hull rather than beside it; the running gear reaches the model origin; the muzzle is at the
far end of the barrel; PBR materials, albedo and normal maps are actually applied; then a driving pass that runs
the real `Simulation` for 240 ticks and confirms the vehicle **reached a fraction of its own top speed**,
**travelled forwards rather than backwards**, fired, resolved impacts, and that the wreck visual applies and
clears without throwing.

Several of those are per-vehicle in a way the rest are not, and that is the point. Hull width, hull height and
top speed are all compared against the vehicle's **own definition**, so they travel when a vehicle is added
instead of needing a new constant. A hard-coded "moved more than 5 m" is meaningful for the medium and
meaningless for the heavy, which covers a quarter of that in four seconds.

That orientation check is the one thing nothing else can do. `tests/client/controls.test.ts` compares helper
functions to each other and never looks at a loaded mesh; a screenshot of a mirrored tank still looks like a
tank. Only reading a rendered node's world matrix back proves it.

**4. The audit walks the roster through the real switching path, and that is not incidental.** A defect where
disposal frees meshes while a cache still references them produces an *invisible* tank — no exception, no type
error, no failed unit test. V8 shipped exactly that bug, and the only reason it was caught is that the audit
visits a second vehicle. An audit that built a fresh scene per vehicle would be structurally unable to see it.

## Adding a vehicle

The whole point of V8. This is the complete procedure; nothing outside the listed files needs to change.

**1. Write the definition.** Create `src/shared/roster/<your-id>.ts` exporting a `VehicleDefinition`. This is
where all vehicle identity lives — dimensions, powertrain, traversal, turret, gun, shell, survivability, armour
plates, modules, destruction behaviour, the `audio` profile, and `visualId`. Copy the nearest existing vehicle as
a starting point; the field-by-field meaning is in `src/shared/vehicle-definition.ts`.

**2. Register it.** Add it to `VEHICLE_ROSTER` in `src/shared/roster.ts` with its `role`, `tagline`, `strength`
and `weakness` — the text the selector shows. Export it. That is the only registry.

At import, `src/shared/roster.ts` schema-checks every definition *and* runs `validateRoster`, which rejects a
roster that is not genuinely distinct: shared ids or models, similar silhouettes, shared armour layouts, identical
movement, identical guns, or identical audio. **A vehicle that differs from another only in a stat number will
fail this**, by design — that is a skin, not a roster member.

**3. Give it a model.** Add a spec to `SPECS` in `tools/lib/tank-model.mjs` keyed by the same id, and a paint in
`tools/build-assets.mjs`. The builder derives absolute dimensions from the spec's proportions, so a new vehicle
is a block of fractions rather than a model.

One invariant to get right: **`heightM` is the whole vehicle**, and `hullHeightFraction` is the hull's *share* of
it — the track unit takes the remainder. Getting this backwards produces a vehicle 60% too tall, which is
exactly the defect V8 hit. Where a part is positioned relative to an edge, derive the offset from the part's own
half-size; a fixed offset stops being correct the moment a dimension changes.

**4. Point at the model.** Add the entry to `VEHICLE_MODELS` in `src/client/assets/asset-manifest.ts`. This is
the vehicle-to-model binding and it is data, not code.

**5. Verify.** `npm run verify`, then `npm run assets && npm run assets:audit`. The contract runs at load, so a
model that does not satisfy it fails the game at boot with a message naming the vehicle and the rule — and the
audit reports the measured numbers to compare against your definition.

Nothing in `src/core` or `src/client/render` changes. That is the test of whether the pipeline is doing its job.

## Replacing these assets with real art

The pipeline exists to make the assets replaceable, so this is the intended path:

1. Author in **metres, Y-up, +Z forward**, with the node names in the table above.
2. Put the handedness conversion on one root rotation, or export +Z forward directly and adjust.
3. Drop the file in `public/assets/models/` and point the vehicle's `visualId` at it in
   `src/client/assets/asset-manifest.ts`.
4. Run `npm run assets:audit`.

Nothing in `src/core` or `src/client/render` needs to change. That is the test of whether the pipeline is doing
its job.

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