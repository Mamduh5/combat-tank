# Version Plan

**Status:** Authoritative for what to build next. This is the execution contract for Combat Tank.

## How to read this plan

Each version states a **goal**, a **player-visible result**, the **systems introduced**, the **work
areas**, **validation criteria**, and what is **explicitly deferred**.

- **Versions are defined by scope, never by calendar time.** There are no estimates here. A version
  is done when its validation criteria pass.
- **Every version must leave the project runnable.** If a version cannot be started and played, it
  is not finished.
- **Passing the validation criteria is the minimum, not the goal.** Within a version's scope, aim for
  the most coherent and playable result the current systems allow. Scope defines *what* to build; it
  does not license building it as cheaply as possible. See ADR-0013.
- **The order is binding.** `docs/gameplay-systems.md` §13 shows the real technical dependencies.
  Reordering versions invalidates work.
- **Deferred lists are not a backlog of promises.** They say "not yet", not "eventually, quietly".
  Anything deferred must be re-justified in the version that needs it.

### The three milestones the plan must produce

| Milestone | Reached at | Meaning |
| --- | --- | --- |
| **Playable single-player tank prototype** | **end of V4** | One player drives, aims, and fights to a win condition |
| **Proper tactical tank game** | **end of V7** | Terrain, cover, spotting, and competent AI make positioning matter |
| **Multiplayer and persistence** | **end of V10 / V11** | Authoritative human battles, then a garage that gives them meaning |

Nothing in this plan requires those three things to be built simultaneously. Each milestone is a
runnable game on its own terms.

---

## V0 — Project Definition & Planning

**Status: complete** (this planning pass).

- **Goal:** establish what the game is, how it will be built, and what comes next.
- **Player-visible result:** none — documentation only.
- **Systems introduced:** none.
- **Work areas:** vision, systems overview, technical direction, this plan, the agent working guide,
  the open-decisions register, the glossary, and the ADR process.
- **Validation:** documents are internally consistent; the version ladder leads from nothing to a
  playable prototype to a tactical game to multiplayer and persistence; undecidable product
  questions are recorded as open decisions rather than answered silently.
- **Deferred:** all implementation.
- **Depends on:** nothing.

---

## V1 — Movement & Camera Sandbox

**Status: complete** (2026-10-01). See "V1 outcome" at the end of this section for what was
actually built and what changed from the plan.

**Goal:** prove that a tank can be driven and looked at, and that the core/client split works.

- **Player-visible result:** the player spawns in a placeholder tank on a simple terrain, drives it
  with WASD, rotates the hull, and orbits a third-person camera. The tank feels heavy.

- **Systems introduced**
  - Project scaffolding: TypeScript strict, Vite client, Vitest, ESLint with the core-purity rule.
  - `src/core/math` — vector maths and deterministic trigonometry.
  - `src/core/rng` — seeded PRNG; `Math.random()` banned in core.
  - `src/core/sim` — the fixed-timestep world and tick loop.
  - `src/core/vehicle` — kinematic tank locomotion: throttle, brake/reverse, hull traverse, ground
    sampling, slope behaviour.
  - `src/shared/vehicle-defs` — one placeholder vehicle definition, schema-validated.
  - `src/client/render` — Babylon scene, placeholder tank, lighting, basic sky/ground.
  - `src/client/camera` — third-person orbit camera with obstruction handling.
  - `src/client/input` — keyboard/mouse to `InputCommand`.
  - `src/client/ui` — minimal speed readout.
  - Rapier: terrain collider and downward ray casts for ground height/normal.
  - Developer commands: `typecheck`, `lint`, `test`, `dev`, `verify`.

- **Work areas**
  - Settle the locomotion question (OD-12) with a short spike comparing the kinematic model against
    Rapier's vehicle controller; record the outcome in an ADR.
  - Confirm OD-11 (single package) before scaffolding, and record it.
  - Choose and record the simulation tick rate.

- **Validation**
  - `npm run verify` passes: typecheck, lint, tests, all green.
  - A lint rule **fails the build** if `src/core` imports Babylon or Colyseus.
  - A unit test asserts the tick loop produces identical state for the same inputs across two runs
    (same seed).
  - A unit test asserts the vehicle accelerates, reverses, and turns at rates consistent with its
    data definition — not with hard-coded constants in code.
  - Manually: the tank accelerates with visible weight, cannot pivot instantly, drives on slopes
    without jitter or falling through terrain, and the camera does not clip into the ground.

- **Explicitly deferred:** turret and gun, firing, any damage, AI, other vehicles, any art beyond
  placeholders, any network code, and any UI beyond a speed readout.

- **Depends on:** V0.

### V1 outcome

**Delivered.** `npm run verify` passes (typecheck, lint, 105 tests) and `npm run build` produces a
bundle. The remaining manual step — driving the tank in a browser and judging its feel — is the one
thing automated checks cannot do, and is listed in the V1 report as outstanding.

**Validation criteria status**

| Criterion | Status | Evidence |
| --- | --- | --- |
| `npm run verify` green | **met** | typecheck, lint, 105 tests across 6 files |
| Lint fails the build on a core Babylon/Colyseus import | **met** | `tests/architecture/core-purity.test.ts` writes a violating file into `src/core` and asserts ESLint exits non-zero, for five separate violations, plus a clean-file control |
| Same seed and inputs produce identical state | **met** | `tests/core/determinism.test.ts` |
| Vehicle rates come from the data definition, not constants | **met** | `tests/core/locomotion.test.ts` runs several definitions and asserts the measured behaviour follows the data |
| Tank accelerates with visible weight | **partly met** | Numerically verified: ~4.5 s to top speed, weak coast deceleration, 1.9 s to full traverse. The *felt* quality still needs a human at the keyboard |
| Cannot pivot instantly | **met** | Asserted numerically: the first tick of a turn reaches under 10% of peak traverse rate |
| Drives on slopes without jitter or falling through | **met** | Ground contact uses the analytic surface, so there is no grid quantisation to jitter; asserted over 900 ticks of varied driving |
| Camera does not clip into the ground | **implemented, unverified by eye** | Ray-cast obstruction with immediate pull-in and slow release (ADR-0009 geometry); the numeric behaviour is tested, the visual result is not |

**What changed from the plan, and why**

1. **The plan called for "downward ray casts for ground height/normal".** Grounding instead uses the
   analytic terrain function; Rapier ray casts serve the camera and line-of-sight queries. A ray cast
   against a sampled mesh quantises height to the grid, which produces exactly the jitter the
   acceptance criteria forbid. Recorded in ADR-0007.
2. **The plan implied a Rapier heightfield collider.** A shared triangle mesh is used instead, built
   once and consumed by both the renderer and the physics world. Rapier's heightfield index-to-axis
   mapping is not inferable from its signature, and a wrong guess produces a silently rotated
   collider. Recorded in ADR-0009.
3. **Three ADRs were added** for decisions the plan asked to be settled during V1: OD-11 (ADR-0002),
   OD-12 (ADR-0007), and the tick rate (ADR-0008).
4. **The terrain had to be redesigned.** See the note below; this was a genuine bug, not a preference.

**Bugs the V1 tests caught, worth remembering**

- The deterministic `cos` polynomial was written with its coefficients shifted by one term, so it
  returned ~1.03 where it should return 0.71. It looked like a plausible smooth function.
- The `sin`/`cos` quadrant reduction ignored quadrant parity, making `sin(PI/2)` return 0.
- Terrain ridges were specified as 0.6–1.6 rad/m, a **4–10 m wavelength**. That is corrugated noise,
  not hills: unrepresentable by any practical collision grid, and near-vertical rather than drivable.
  Now specified as wavelengths in metres, with the gradient bound as a checkable constraint.

---

## V2 — Turret, Gun & Ballistics

**Status:** Implemented. Automated validation passes (172 tests). Subjective feel and visuals await
human playtest.

**Goal:** prove the gunnery loop — aim, fire, and watch a shell travel and land.

- **Player-visible result:** the player rotates the turret independently of the hull, elevates and
  depresses the gun within its limits, and fires. A shell leaves the muzzle, arcs, drops, and hits
  the ground. A reticle and range readout appear.

- **Systems introduced**
  - `src/core/vehicle/turret.ts` — turret traverse and gun elevation, both rate-limited and distinct.
  - `src/core/vehicle/main-gun.ts` — load state and the reload cycle; the core refuses a fire request.
  - `src/core/ballistics/shell.ts` — shell state, sub-stepped integration under gravity, lifetime.
  - `src/core/ballistics/impact.ts` — the V2→V3 impact contract.
  - `src/core/ballistics/flight-system.ts` — owns shells in flight, collects impacts.
  - `src/shared/vehicle-definition.ts` — turret, main gun and test shell parameters.
  - `src/shared/input.ts` — `aimPoint` and `fire` added to `InputCommand`.
  - `src/client/render/tank-visual.ts` — turret and barrel as separate transform nodes.
  - `src/client/render/shell-effects.ts` — shell, muzzle flash and impact marker placeholders.
  - `src/client/ui/hud.ts` — gun state, reload countdown and progress bar, turret offset.

- **What actually shipped, and where it differs from the plan above**
  - Shell collision uses the **analytic terrain**, not Rapier casts. Rapier is reserved for vehicle
    queries. Rationale in [ADR-0010](decisions/0010-analytic-ballistics-without-drag.md); this also
    strengthened rather than changed [ADR-0007](decisions/0007-kinematic-tank-locomotion.md).
  - The plan named `src/shared/vehicle-defs` (plural directory). The existing single
    `src/shared/vehicle-definition.ts` was extended instead, matching the V1 convention.
  - **No calibre field.** The owner asked not to introduce abstractions for ammunition no version
    needs, so there is one generic test shell and no calibre/armour-type taxonomy.
  - `Vec3` moved from `src/core/math/vec3.ts` to `src/shared/vec3.ts`, because `InputCommand` now
    carries an aim point and both the core and the shells must read it. One definition avoids two
    structurally identical types that are not assignable to each other; the dependency direction
    (core → shared) is unchanged.

- **Work areas completed**
  - Impact data contract defined: position, surface normal, incoming direction, impact velocity, and a
    precomputed incidence angle. A test asserts the record has **not** grown a damage field, so the
    V2/V3 boundary stays visible.
  - Units and conventions recorded in the glossary.

- **Validation**
  - `tests/core/turret.test.ts` (19) — traverse does not snap, respects rate and arc limits; elevation
    and depression clamp; hull rotation carries the turret without changing its local angle; a fixed
    world aim point is re-served when the hull turns under it; a turret slower than the hull visibly
    lags.
  - `tests/core/ballistics.test.ts` (22) — non-zero flight time; drop follows `0.5·g·t²`; flight time
    and distance increase together; higher muzzle altitude means a longer shot; no tunnelling; range
    and lifetime expiry; impact-contract completeness; identical launches give identical results.
  - `tests/core/gun.test.ts` (15) — reload timing matches the definition; firing is refused while
    reloading without resetting the timer; held fire is rate-limited to one shot per reload; shells
    spawn at the muzzle along the barrel; end-to-end firing through `Simulation`.
  - `tests/data/vehicle-definition.test.ts` (28) — V2 sections validate, and broken gun/turret/shell
    data is rejected.
  - Full suite: **172 passing across 9 files**; `npm run verify`, production build pass.

- **Explicitly deferred, as instructed:** penetration, ricochet, damage, hit points, armour, module
  damage, destruction, enemies, AI, spotting, multiplayer, progression, the ammunition roster (OD-04
  remains open), and any polished VFX.

- **Known limitations:** no aerodynamic drag (ADR-0010), so long shots fall slightly short of a real
  shell; no self-hit or friendly-fire rules; the gunnery HUD readouts are placeholders.

- **Pending human verification:** turret slew feel, gun elevation feel, whether the muzzle flash and
  impact marker are readable, and whether the aim range readout is legible while moving.

- **Depends on:** V1 (locomotion, camera, input, tick loop, vehicle definitions).

---

## V3 — Armor, Penetration & Damage

**Status:** Implemented. 253 automated tests pass; subjective readability awaits human playtest.

**Goal:** make armor mean something. This is the version that turns a shooting gallery into the genre.

- **Player-visible result:** a stationary target tank sits ahead of the player. Shooting it reports which
  plate was struck, at what angle, and whether the shell **penetrated**, was **blocked**, or
  **ricocheted** — with damage, target HP, and any module knocked out shown on a hit-feedback panel. A
  destroyed target visibly becomes a wreck and can no longer move or fire.

- **Systems introduced**
  - `src/core/armor/geometry.ts` — plates as oriented slabs in vehicle local space; closed-form
    ray-versus-box hit resolution.
  - `src/core/armor/penetration.ts` — effective armour, normalisation, ricochet, penetration verdict.
  - `src/core/damage/damage-model.ts` — hit points, spatial module damage, destruction.
  - `src/core/combat/combat-resolver.ts` — the V2 impact record → armour → damage path.
  - `src/shared/placeholder-target.ts` — the stationary test target, as a **separate data file**.
  - `src/client/render/tank-visual.ts` — turret/barrel nodes and a wreck tint.
  - `src/client/ui/hud.ts` — the hit-feedback panel.

- **Owner decisions applied**
  - **360° turret traverse** for the generic placeholder. The data model still supports a restricted
    arc, and `TARGET_TANK` uses a 90° casemate-style limit so that capability stays exercised.
  - **No projectile drag.** ADR-0010 stands, unchanged.
  - **OD-04 remains open.** One generic test shell, evolved with `nominalPenetrationMm` and
    `normalization`. No AP/HE/APCR taxonomy.

- **What differs from the plan above**
  - Module damage covers **engine, both tracks, gun, and ammunition**, at prototype scope. Engine and
    vehicle destruction disable movement; gun damage disables firing; ammunition damage is state only,
    with its explosion deferred. The plan's "removes it from the simulation" was *not* done — keeping
    the wreck present is needed for V4, and the owner explicitly limited destruction to a state change.
  - A V2 `makeInput` / schema change: **zero top speed is now valid**, because the test target does not
    drive. A schema that forbids static vehicles would block any future emplacement.
  - The plan's `src/shared/vehicle-defs` directory was not created; the existing single
    `vehicle-definition.ts` was extended, matching V1/V2.

- **Validation** — **253 tests across 12 files**, typecheck, lint and production build all pass.
  - `tests/core/armor.test.ts` (43) — geometry, effective armour, normalisation, ricochet, region
    selection, turret mounting.
  - `tests/core/damage.test.ts` (15) — hit points, spatial module hits, destruction, determinism.
  - `tests/integration/combat.test.ts` (18) — front/side/rear outcomes, damage only on penetration,
    module hits through the real layout, and the full path through `Simulation`.
  - Numeric assertions are **hand-computed**, not snapshots. See the bug below for why that matters.

- **Bugs found and fixed during implementation**
  - **Plate normal inverted.** Positive pitch pointed the plate normal into the vehicle, mirroring every
    incidence angle while the plate still looked correct in the data.
  - **Left/right plate normals swapped** in both vehicle data files.
  - **Wrong plate scored.** The combat resolver re-cast a ray from the impact point, so it scored shots
    against the plate *behind* the one struck — a hull-front shot was judged against the turret above it.
    This produced entirely plausible but wrong numbers, and is the reason ADR-0012 insists on
    hand-computed test values.

- **Known limitations:** no armour quality or materials; one normal per plate, so compound slopes are
  several plates; damage does not scale with penetration margin; ricochet is a single binary decision
  with no multi-bounce; target is stationary by design.

- **Pending human verification:** whether the armour model is understandable from the hit panel, whether
  the three outcomes are readable at a glance, whether penetrating/blocked/ricocheted feel distinct, and
  whether the wreck tint reads clearly. Carried forward from earlier versions: movement feel, camera
  feel, camera obstruction, turret slew feel, gun elevation feel, muzzle/impact readability, aiming HUD
  readability.

- **Depends on:** V2 (ballistics, impact resolution, vehicle definitions).

---

## V3R — Playable Prototype Quality Pass

**Status: complete.** Not a new feature version. A refinement pass over V1–V3, prompted by the owner
playing the result and finding it read as an engine test rather than a tank game.

**Goal:** make the existing game present itself as a coherent tank-combat prototype, without adding
any V4 systems.

**Scope discipline:** no AI, no battle flow, no moving opponents, no return fire, no spotting, no
victory logic. V1–V3 systems were reused, not replaced.

### Defects found by playing, which every automated gate had passed

- **The terrain was invisible.** Every ground triangle was wound so the renderer classified it as a
  back face and culled it; the player saw the tank floating in a void with slivers of landscape on
  the horizon. The *normals* were correct, so no geometry test could catch it. Fixed in the renderer
  (`sideOrientation`) with the geometry left conventional, and pinned by
  `tests/core/terrain-grid.test.ts`.
- **The target was unreachable and invisible.** Placed 60 m ahead at the player's own height, it ended
  up 12.6 m below the player on a valley floor behind a hill. Now placed by a scored search requiring
  line of sight, similar elevation, and driveable ground. Pinned by `tests/core/spawn-placement.test.ts`.
- **The player spawned on a ridge crest.** The spawn scan optimised for locally flat ground, which is
  satisfied by the top of a cliff. Now optimises for consistent surroundings.
- **The camera sat level with the hull**, so the player's own vehicle occluded the aim point.
- **The turret was buried inside the hull** — it was placed at the gun trunnion height (1.42 m) rather
  than the hull roof (1.77 m).
- **The gun was invisible**: a 4.2 m barrel rendered 18 cm thick, hidden inside the turret block.
- **The barrel's bounding box lay on the wrong axis**, which is why it never appeared where expected.
- **On flat terrain the target was placed 63° off-axis**, because every candidate scored identically
  and the first sampled won.
- **`Math.hypot` in core code** — a determinism violation (ADR-0005), caught by the existing lint rule.

### Improvements delivered

- **Environment:** sky gradient dome, distance haze, height-banded terrain colour, range markers at
  50/100/150 m, a proving-ground identity.
- **Vehicles:** sloped glacis hull, visible road wheels, fenders, a readable gun with a muzzle swell,
  lighter higher-contrast palette, and a distinct accent colour for the target so the player can tell
  the two vehicles apart at range.
- **Camera:** raised target height, increased distance, steeper default pitch.
- **HUD:** a centred, colour-coded outcome banner (PENETRATED / BLOCKED / RICOCHET / MISS) with the
  verdict where the player was already looking; a target status strip with a proportional HP bar and
  range; armour arithmetic demoted to a diagnostics row toggled with **F**; layout collisions fixed.
- **First launch:** a short briefing naming the objective, dismissed on first movement.

### Known limitations after V3R

- The hull wedge is custom geometry; no compound slopes or turret mantlet.
- No impact debris or dust — impacts are marked, not dramatised.
- Aiming is camera-relative with a centre reticle; no separate desired-vs-actual gun indicator.
- Feel (movement weight, servo rates) still needs a human at the keyboard.

---

## V4 — Single-Player Combat Loop

**Milestone: playable single-player tank prototype.**

**Goal:** turn systems into a game. A battle has a start, a fight, and a result.

- **Player-visible result:** the player fights a complete battle against one or more enemy tanks on
  a bounded map, sees a battle timer and score, wins or loses, sees a results screen, and can start
  another battle.

- **Systems introduced**
  - `src/core/match` — match lifecycle (setup, running, concluded), a **win condition**
    (elimination, with a time-limit fallback), team assignment, and a result record.
  - `src/core/vehicle` — target vehicles placed at spawn points.
  - `src/core/ai` — the **minimum** AI needed to be an opponent: drive toward the enemy, turn the
    turret, and fire when roughly aimed. Deliberately unsophisticated; depth is V5 and V7.
  - `src/core/world` — a bounded test map with defined spawn points.
  - `src/client/ui` — battle timer, team status list, score, end-of-battle results screen, restart.
  - `src/client/main` — a game-state flow: menu → battle → results → menu.

- **Work areas**
  - This AI exists to be *shootable and beatable*, not smart. Keep it minimal and honest about it.
  - Make the loss condition as real as the win condition; a prototype that cannot lose is untestable.

- **Validation**
  - A headless integration test runs a complete battle with no rendering and asserts it terminates
    with a valid result and no errors.
  - A test asserts the match cannot end without a result, and that a time limit produces one even
    if nobody is destroyed.
  - Manual: the player can win, can lose, and can restart into a fresh, behaving-identically battle.

- **Explicitly deferred:** sophisticated AI, multiple maps, spotting and line-of-sight rules,
  concealment, additional battle modes, progression, and all persistence.

- **Depends on:** V3 (damage, destruction), V2 (ballistics), V1 (locomotion).

---

## V5 — Autonomous AI Opponents

**Goal:** make the game genuinely playable and testable alone, with bots that behave believably
enough to be worth fighting.

- **Player-visible result:** the player fights a battle against several AI tanks that navigate the
  map, hunt the player, take up firing positions, and miss in ways that look human. Difficulty is
  selectable.

- **Systems introduced**
  - `src/core/ai` — a **navigation** system: a navigation graph or waypoint structure over the map,
    path following, and stuck detection and recovery.
  - `src/core/ai` — target selection and **aiming** that respects turret traverse rate, barrel
    elevation limits, shell drop, and target lead.
  - `src/core/ai` — firing decisions that respect reload state and line of sight.
  - `src/tools/headless` — a batch battle runner (`npm run sim`) that plays full battles with no
    rendering and emits a machine-readable match report.
  - `src/client/ui` — enemy health indicators and a difficulty selection.

- **Work areas**
  - **AI must use the same `InputCommand` interface as the player.** An AI that reads state the
    player cannot, or fires without traverse time, invalidates every test that uses it.
  - Stuck detection matters more than clever tactics at this stage: a bot wedged against a rock
    makes the game feel broken.
  - Use headless batches to sanity-check balance before the player ever sees it.

- **Validation**
  - A headless battle completes with a valid report: duration, per-vehicle damage dealt and taken,
    shots fired, hits, and penetrations.
  - A test asserts AI never exceeds vehicle data limits (traverse rate, gun elevation, reload) —
    AI cannot cheat.
  - A test asserts AI vehicles do not become permanently stuck, over a long headless batch.
  - A determinism test asserts two runs of the same seeded battle produce identical reports.
  - Manual: bots use the map, take cover-ish positions, and the difficulty setting visibly changes
    their competence without changing their rules.

- **Explicitly deferred:** flanking, deliberate retreat, coordinated behaviour, squad tactics, and
  learned behaviour.

- **Depends on:** V4 (match structure, test map), V3 (armor and damage, which the AI must respect).

---

## V6 — Battlefield & Terrain Tactics

**Goal:** make the map matter. Space, cover, and knowledge should decide fights.

- **Player-visible result:** the player fights on a purpose-built map with hills, structures, cover,
  and at least two routes to the enemy. Vehicles must be spotted before they can be shot, and hiding
  genuinely works.

- **Systems introduced**
  - `src/core/world` — real map data: heightfield terrain, structures and obstacles, cover
    placement, and at least two flanking routes per spawn pair.
  - `src/core/world` — **line of sight**: visibility queries using Rapier ray casts against terrain
    and structures.
  - `src/core/world` — **spotting** rules: distance-dependent detectability, and team-wide sharing
    of contacts.
  - `src/core/world` — spawn point selection that keeps players out of the enemy's initial view.
  - Terrain effects on movement (grade resistance) and on firing (barrel elevation limits).
  - `src/client/ui` — minimap with known contacts, and enemy indicators that respect spotting.
  - `src/client/render` — terrain and structure placeholders, adequate to read the space.

- **Work areas**
  - Map authoring format: how a map is described as data, and how terrain and navigation data stay
    consistent with each other.
  - Balance the map so no single position is dominant; verify with headless batches, not by feel
    alone.
  - Spotting must be cheap enough for a server to run for every participant later (V9).

- **Validation**
  - Tests for line of sight: a vehicle behind a hill is not visible; one in the open at close range
    is; distance increases detectability range.
  - A test asserts a contact detected by one team member is visible to that whole team.
  - A test asserts spawns never place a vehicle inside the enemy's view at battle start.
  - Manual: the player experiences at least one flanking approach and at least one successful
    ambush from concealment.

- **Explicitly deferred:** destructible structures, camouflage nets, foliage and bushes as visual
    cover, weather and time of day, base objectives, and additional maps.

- **Depends on:** V5 (AI navigation must work over the new terrain), V4 (match structure), V1–V3.

---

## V7 — Tactical Team Skirmish

**Milestone: a proper tactical tank game (solo + AI).**

**Goal:** make positioning, cover, and flanking matter for both sides.

- **Player-visible result:** the player fights a team battle in which AI teammates and enemies use
  cover, flank, retreat when hurt, and contest objectives. Winning requires plan and execution, not
  reflexes.

- **Systems introduced**
  - `src/core/ai` — **cover selection**: scoring candidate positions by exposure to known enemies.
  - `src/core/ai` — **repositioning** and **retreat** behaviour when damaged or outmatched.
  - `src/core/ai` — **flanking** behaviour that seeks angles defeating the target's frontal armor
    (possible precisely because armour is plate-based data from V3).
  - `src/core/match` — team structure and a second **battle mode** (base capture, or a
    elimination variant with limited spawns).
  - `src/core/ai` — AI awareness of team contacts, so team play is not player-only.
  - `src/client/ui` — team status with per-vehicle state.

- **Work areas**
  - Tactical AI is an emergent-property problem: unit-test the individual decisions, and validate
    the *behaviour* through headless batch statistics.
  - Watch for AI that is unbeatable because it never makes a human error. Some imperfection is
    required for the game to be fun.

- **Validation**
  - Headless batch tests show AI using cover: a measurable share of AI vehicles spend time in
    positions that block enemy line of sight.
  - A test asserts a damaged AI vehicle retreats or seeks cover rather than trading to the death
    indefinitely.
  - A test asserts the second battle mode reaches a valid result in a headless run.
  - Manual: an experienced player can win by out-positioning a nominally stronger vehicle, as
    required by `docs/vision.md` §7.

- **Explicitly deferred:** multiplayer, progression, crew, advanced camouflage, destructible cover.

- **Depends on:** V6 (map, line of sight, spotting), V5 (AI foundation), V3 (plate data enables
  flanking logic).

---

## V8 — Vehicle Roster & Progression Hooks

**Goal:** prove vehicles are genuinely different and that adding one is cheap.

- **Player-visible result:** the player chooses from a small roster of tanks before a battle, and each
  handles and fights differently. A vehicle can be added by writing a data file.

- **Systems introduced**
  - `src/shared/vehicle-defs` — a **complete, validated** vehicle definition schema, plus a
    catalogue with meaningfully different characteristics (at minimum a fast light tank, a
    generalist medium tank, and a slow heavy tank). This is a first pass at the class question, not a
    commitment to it (OD-01).
  - `src/shared/vehicle-defs` — visual binding by id, so placeholder meshes are swappable.
  - `src/core/vehicle` — handling differences must emerge from data: acceleration, top speed, reverse
    speed, hull traverse, and turret traverse all read from the definition.
  - `src/client/ui` — a **pre-battle vehicle selection** screen.
  - `src/core/match` — battle setup that applies progression modifiers to the chosen vehicle.

- **Work areas**
  - **P7 is the acceptance test here:** a player should tell the vehicles apart by feel, not by
    reading a stat line.
  - Progression *modifiers* enter as a data hook (a multiplier, or an unlocked module slot). No
    economy, no currency, no research tree — that is V11, and depends on decisions the owner has not
    made (OD-03).
  - Use headless batches to check that no vehicle is strictly dominant.

- **Validation**
  - A test proves a new vehicle can be added by **adding a data file only**, with no code change.
  - A test proves an invalid definition (impossible armour, negative mass, missing field) fails
    validation loudly at load time with a useful message.
  - Unit tests per vehicle confirm handling values match their definitions.
  - Headless batch results show varied outcomes; no vehicle wins every match.
  - Manual: the player can tell the three vehicles apart within a minute of driving each.

- **Explicitly deferred:** the full garage, currency, experience, research trees, module purchase,
  crew, and any monetisation. Also more than a handful of vehicles.

- **Depends on:** V7 (a mode worth choosing a vehicle for), V3 (armor data), V1 (movement data).

---

## V9 — Authoritative Multiplayer Foundation

**Goal:** make a server the sole authority of a battle. Nothing here is about fun; it is about
trustworthy architecture.

- **Player-visible result:** a headless server runs battles. A client connects to it, joins a battle,
  drives, shoots, and sees other players. The local game and the networked game run the *same*
  simulation.

- **Systems introduced**
  - `src/server` — a Colyseus server with a room per battle, hosting the simulation core on a fixed
    network tick.
  - `src/shared/protocol` — the message and state schema: input commands up, snapshots and events
    down.
  - `src/server` — **input validation**: the server rejects impossible inputs (firing while
    reloading, teleporting, exceeding traverse rates).
  - `src/client/net` — the Colyseus client: connect, join, send inputs, receive snapshots.
  - `src/client` — **client-side prediction** for the local vehicle, with **server reconciliation**,
    and **interpolation** for remote vehicles.
  - `npm run server` developer command.
  - A **determinism test**: the same battle, run on server and client from the same seed and input
    log, produces identical state.

- **Work areas**
  - **Settle OD-10 and OD-11** here if not already settled, and record the outcome in an ADR.
  - Bots must run on the server inside the same core, filling the same slots as humans. A match with
    one human and seven bots is the target case.
  - Tick-rate choice: simulation tick versus network tick. Document the decision.
  - Hard requirement: **the client must never be trusted for a combat outcome.** If a client claims
    a hit, the server decides.

- **Validation**
  - A test asserts the server rejects invalid inputs — a scripted client firing during reload is
    corrected, not obeyed.
  - The determinism test passes: identical seed and inputs produce identical state on client and
    server.
  - An integration test starts a server, connects a client, runs a short battle, and asserts both
    reach the same result.
  - A test asserts a client lying about its position is reconciled to the server's truth.
  - Manual: two browser windows on one machine join the same battle and see each other move and
    fight correctly.

- **Explicitly deferred:** matchmaking, ranked play, reconnection, spectators, more than a handful of
  participants per side, and any progression persistence.

- **Depends on:** V8 (vehicle selection travels over the network), V5 (bots run server-side), V4
  (match lifecycle), and all of V1–V3 (simulation logic must already be in the core).

---

## V10 — Playable Multiplayer Battles

**Milestone: human multiplayer.**

**Goal:** let real people fight each other, at a deliberately modest scale.

- **Player-visible result:** the player joins a multiplayer battle with other people and bots filling
  the remaining slots, on a map and mode from V6/V7, and fights real opponents.

- **Systems introduced**
  - `src/server` — room creation and joining, with a **small fixed number of participants per
    side**. The first supported size is deliberately modest; larger battles are a later problem.
  - `src/server` — bot backfill so a room always fills to a playable state.
  - `src/client/net` — join/leave flow, connection-state UI, and clear failure messages.
  - `src/client/ui` — a minimal online battle browser or room list.
  - Basic abuse handling: rate limiting and input sanity checks on the server.

- **Work areas**
  - **Latency handling is the real work here**, not matchmaking. Verify prediction and
    reconciliation feel correct under real network conditions; if they do not, fall back to pure
    server authority (OD-10) rather than shipping something that feels broken.
  - Bots in mixed lobbies must not be unfair to either side.
  - Keep the supported battle size small. Do not design for 15v15 here.

- **Validation**
  - An integration test runs a full battle with simulated clients and bots and asserts a valid,
    consistent result on all parties.
  - A test asserts the server sustains its tick rate under the supported participant count.
  - Manual: two players on separate machines complete a battle, agree on who won, and neither sees a
    visible desync.
  - Manual: a player who disconnects is handled gracefully (dropped, replaced by a bot, or the room
    continues) without corrupting the match.

- **Explicitly deferred:** ranked ladders, skill matchmaking, reconnection, spectators, cross-region
  hosting, large battles, and progression rewards.

- **Depends on:** V9 (authoritative server), V7 (team battle modes), V6 (maps).

---

## V11 — Garage, Progression & Accounts

**Milestone: a persistent game.**

**Goal:** give battles a reason to return, outside the battle.

- **Player-visible result:** the player has a persistent profile with a garage of owned vehicles,
  earns experience and currency from battles, spends them on upgrades and unlocks, and sees
  statistics about their record.

- **Systems introduced**
  - A **garage** screen: owned vehicles, configuration, and statistics.
  - **Accounts** and persistent storage on the server, with the client authenticated.
  - **Experience and currency**, awarded at the end of a battle and spent in the garage.
  - **Vehicle unlocks** and a progression structure (research tree, module tree, or flat list —
    OD-03).
  - **Upgrades and modules** that modify a vehicle definition, using the V8 modifier hook.
  - `src/client/ui` — garage screens and a post-battle rewards summary.
  - **Statistics**: per-vehicle and per-player records.

- **Work areas**
  - Persistence is the first version storing data we cannot regenerate; schema migration and data
    integrity matter from the first release, not later.
  - The progression structure must be a **decision the owner makes** (OD-03), not something to
    invent here. Build the storage and reward plumbing; leave the shape of the tree open.
  - Anti-cheat for progression: rewards are computed **on the server** from server-side battle
    results, never reported by the client.

- **Validation**
  - An integration test covers the full loop: server-validated battle result → rewards granted →
    currency spent → upgrade applied → the vehicle performs differently in the next battle.
  - A test asserts a client cannot grant itself currency or experience by sending a message.
  - A test asserts persistence survives a server restart.
  - Manual: a returning player sees their garage, vehicles, and statistics as they left them.

- **Explicitly deferred:** crew, cosmetics and skins, achievements, monetisation of any kind,
  premium vehicles, trading, and clans.

- **Depends on:** V10 (server-authoritative battles as the reward source), V8 (vehicle definitions
  and modifier hooks).

---

## V12 — Content, Balance & Release Polish

**Goal:** turn a working game into a shippable one.

- **Player-visible result:** the game looks and feels like a finished product, holds a stable frame
  rate in a real battle, has sound, and runs as a build a stranger can install.

- **Systems introduced**
  - **Content scale**: more vehicles and more maps, added as data.
  - **Audio**: engine, tracks, turret traverse, gun fire, impacts, ricochets, and UI. Gun-report
    positioning designed as a tactical cue, per `docs/gameplay-systems.md` §12.
  - **Visual pass**: real materials and lighting replacing placeholders, without touching the core.
  - **Performance**: profiling and optimisation so a full battle holds a stable frame rate.
  - **Polish**: settings, control rebinding, options, and a proper main menu.
  - **Distribution**: a build a non-developer can install and run.
  - An accessibility and options pass, to the extent the owner defines scope for it.

- **Work areas**
  - **Art replacement must not require core changes.** This is the practical test of the V1
    placeholder-first discipline and the V8 visual-binding design. If swapping a model requires
    editing gameplay code, an earlier version failed.
  - Balance with headless batches as the primary tool; playtesting as confirmation.
  - Do not add new *systems* here. V12 executes and scales what already exists.

- **Validation**
  - A full battle holds an agreed target frame rate with the supported participant count. The target
    is an owner decision, not an agent decision.
  - A full playthrough is possible end-to-end — account → garage → battle → results → rewards →
    garage — with no placeholder geometry visible.
  - The build installs and runs on a machine that has never run the project.
  - All of `docs/vision.md` §7 success criteria are demonstrably met.

- **Explicitly deferred:** anything not already listed — crew, monetisation, large battles, modding,
  additional nations. These would need their own versions and an owner decision.

- **Depends on:** V11 (garage and progression), V10 (multiplayer), and the content hooks from V8.

---

## Appendix A — Milestone traceability

| Milestone | Version | What is demonstrably true at the end |
| --- | --- | --- |
| Nothing → planned | V0 | The project is planned and the sequence is agreed |
| **Playable single-player tank prototype** | **V4** | One player drives, aims, fights armour, and wins or loses a complete battle |
| Tactical foundation | V5–V6 | Bots that navigate, and a map where cover and spotting matter |
| **Proper tactical tank game** | **V7** | Team play with cover, flanking, retreat, and multiple modes |
| Content extensibility | V8 | Vehicles are data; a roster exists; the player chooses |
| **Multiplayer foundation** | **V9** | A server is the authority; prediction and reconciliation work |
| **Human multiplayer battles** | **V10** | Real players fight real players |
| **Persistence** | **V11** | Accounts, garage, progression, statistics |
| Shippable | V12 | Content, audio, performance, distribution |

## Appendix B — What is deliberately not in any version

These are absent because no version's completion criteria require them. They are not promises; each
would need a new version and an owner decision.

- Crew members, crew skills, wounded-crew mechanics.
- Monetisation of any kind, premium vehicles, or any store.
- Large-scale battles (10v10 and beyond).
- Ranked ladders, seasons, and skill-based matchmaking.
- Modding or user-generated content.
- Multiple nations/factions with distinct technology trees.
- Console or mobile platforms.
- Sound-based detection as a spotting mechanic (audio arrives in V12, but detection by sound is not
  planned).

