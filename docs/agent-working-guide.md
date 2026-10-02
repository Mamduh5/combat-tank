# Agent Working Guide

Combat Tank is developed primarily by coding agents. This guide exists so that work done by
different agents, in different sessions, accumulates into one coherent game instead of a pile of
incompatible changes.

Read this before making changes. It is short on purpose.

---

## 1. Before you change anything

**Read, in this order:**

1. `README.md` — where the project is.
2. `docs/vision.md` — what the game is for, and the principles it will not violate.
3. `docs/version-plan.md` — **the version you are working on**, and its validation criteria.
4. `docs/technical-direction.md` — the boundaries your code must respect.
5. `docs/agent-working-guide.md` — this file.
6. `docs/open-decisions.md` — anything you are about to decide that is not yours to decide.
7. `docs/decisions/README.md` and the ADR index — constraints already recorded.
8. `docs/glossary.md` — the vocabulary to use.

**Then look at the code.** Before writing anything new, find the module that already owns the
concern. Extending a clear existing module is almost always better than adding a new one.

**Check the version's "explicitly deferred" list.** If your task is on it, stop and raise it with
the owner instead of implementing it.

---

## 2. Which documents are authoritative

| Question | Authoritative source |
| --- | --- |
| What are we building, and why? | `docs/vision.md` |
| What systems exist, and how certain are they? | `docs/gameplay-systems.md` |
| What is the next thing to build? | `docs/version-plan.md` |
| Where does code go, and what may it import? | `docs/technical-direction.md` + ADRs |
| How do I work here? | `docs/agent-working-guide.md` (this file) |
| What is *not* decided? | `docs/open-decisions.md` |
| What did we assume, and why? | `docs/assumptions.md` |
| What does this word mean? | `docs/glossary.md` |

**Code never overrides documentation.** If the code and a document disagree, that is a bug in one of
them. Determine which is wrong, fix it, and say so in your report. Do not silently "fix" the code to
match a stale document, and do not silently rewrite the document to match the code.

---

## 3. Recording decisions

**If you make a decision that constrains future work**, write an ADR in `docs/decisions/` using the
template, and add it to the index there. Decisions that qualify:

- Choosing or replacing a technology.
- Establishing a structural rule future code must follow.
- Choosing a gameplay model that affects data format or system boundaries.
- Rejecting an approach a future agent would otherwise retry.
- Setting a convention that would be expensive to change later.

**Do not** write an ADR for adding a feature the version plan already asked for, for tuning a
number, or for recording a future intention.

**If you are tempted to invent a product decision, you are about to do the wrong thing.** Vehicle
classes, shell rosters, progression shapes, battle modes, and monetisation are the owner's calls.
Add or reference an entry in `docs/open-decisions.md` and proceed with a clearly-labelled
provisional choice only if the current version cannot proceed without it — and say so explicitly in
your report.

**If an open decision is resolved**, update `docs/open-decisions.md` (status, date, decision) and
reference the ADR if one was written. Do not delete the entry; the record of what was undecided is
valuable.

---

## 4. Code conventions

These are defaults, not laws. Deviate only when the version's needs genuinely require it, and say
why in your report.

- **TypeScript strict mode**, always. No `any` in exported APIs; no non-null assertions without a
  comment explaining the invariant.
- **Naming:** `camelCase` for values and functions, `PascalCase` for types and classes,
  `UPPER_SNAKE_CASE` for module-level constants. One term per concept — if the glossary says
  *penetration*, do not also write *pierce power* in new code.
- **Units in names or explicit types.** `maxSpeedMps`, `armorThicknessMm`, `reloadSeconds`. Never a
  bare `speed` or `range` whose unit is a guess. Mixing millimetres and metres silently is a
  reliable way to produce a broken game.
- **Functions do one thing** and are small enough to test without elaborate fixtures.
- **No global mutable state** in the core. State belongs to a world/simulation object that is passed
  explicitly. This is what makes headless tests and replays possible.
- **Comments explain *why*, not *what*.** The code says what it does. If a comment restates the code,
  delete it.
- **Use the glossary's terms.** If you need a term the glossary lacks, add it rather than inventing
  a synonym in code.
- **Let the tools format and lint.** Do not hand-format around them.

### Hard boundaries (from ADR-0001, ADR-0002, ADR-0005)

- `src/core/**` must not import Babylon.js, Colyseus, or anything DOM- or Node-specific. This is
  checked by lint, and the check must fail the build.
- `src/core/**` must not use `Math.random()`. Randomness comes from the seeded RNG in
  `src/core/rng`.
- `src/core/**` must not read a wall clock (`Date.now()`, `performance.now()`). The core advances by
  fixed ticks only.
- Gameplay code must not read keyboard, mouse, or network state directly. It receives
  `InputCommand`s.
- Presentation code must not modify simulation state. It reads snapshots and draws them.

If a change seems to require breaking one of these, that is a design problem, not a lint problem.
Raise it rather than working around the rule.

---

## 5. Testing expectations

**Every version must leave the project verifiable.** `npm run verify` (typecheck + lint + test) must
pass before a version is called done.

**Test the core, not the renderer.** The core is pure and testable; the client is not. Put effort in
proportion to that.

- **Pure logic** gets unit tests: armor normalization, penetration resolution, ballistics, movement
  curves, reload, match win conditions, RNG behaviour, definition validation.
- **Integration** gets headless simulation tests: run a full battle with no rendering and assert it
  terminates with a valid, correct result. These catch the bugs unit tests miss.
- **Determinism** gets a test wherever it is claimed: same seed and inputs must produce the same
  outcome. If a change breaks determinism, that is a serious regression, not a flaky test.
- **Boundaries** get a test or a lint rule: a vehicle added as data only; a client that lies being
  corrected by the server; AI not exceeding vehicle limits.

**A new feature without a test is unfinished**, unless it is pure presentation, in which case it
needs at minimum a typecheck and a note in the report of how it was verified manually.

**Prefer testing behaviour to implementation.** Assert that a sloped hit fails to penetrate, not
that a particular internal function was called.

**Do not weaken a test to make it pass.** A failing test is information. Fix the code, or record
that the expectation was wrong and why.

### Automated gates are necessary but not sufficient

`npm run verify` passing means the code is *sound*. It says nothing about whether the game is
*playable*.

This is not a theoretical concern. At the end of V3 every gate passed — typecheck, lint, 253 tests,
production build — while the game was visibly broken. The terrain was **entirely invisible**: every
ground triangle was wound so the renderer treated it as a back face and culled it, and the player saw
the tank floating in a void. The normals were *correct*, so no test inspecting geometry could have
caught it.

**Presentation work must be verified by looking at the running game.** Use `tools/shot.mjs` (see
`tools/README.md`) to render the build and capture a screenshot. Where a visual defect corresponds to
a testable property — winding, facing, placement, visibility — add a regression test so it cannot
return silently.

If your environment cannot render the game, **say so explicitly in your report** rather than claiming
visual quality was verified. An unverified claim is worse than a stated limitation.

---

## 6. Effort level within a version's scope

> **Version requirements define the feature boundary, not the desired effort level.** (ADR-0013)

Within the scope of a version, optimise for the quality of the player's experience, not for the
smallest implementation that technically satisfies the requirements.

This is a standing rule for all versions, not a one-off.

### What it means in practice

- **Scope boundaries still hold.** Do not add systems belonging to a later version. V3R added no AI,
  no battle flow, no new systems.
- **Effort within that scope is not minimised.** A version is done when the current version is as
  coherent, readable, intentional, and enjoyable as reasonably possible with what exists at this stage.
- **A placeholder must be a good placeholder.** It need not be a final asset, but it must communicate
  what the final asset will be. A box on two boxes is not an acceptable tank; a wedge hull with a
  visible gun, road wheels, and fenders is, and costs barely more.
- **Integration, presentation, usability, feel, and player comprehension are part of "done."** They
  are not polish for a later version.

### How to read scope language

These phrases mean **"do not spend effort on production assets yet"**:

- placeholder art is acceptable
- primitive geometry is acceptable
- final polish is deferred
- debug feedback is acceptable

They do **not** mean **"do the least work that passes the check."** Both readings fit the same sentence;
only one produces a playable game. When a requirement says "placeholder", read it as *a good
placeholder*, and ask what the player must be able to understand from it.

### Why this rule exists

V1 to V3 each satisfied their written criteria while producing something that looked like an engine
test. The requirement phrasing above was read as *minimum effort*, and the result was a tank with no
visible gun floating in a sky. ADR-0013 records this in full.

---

## 7. Not prematurely implementing the future

This is the failure mode the project is most exposed to, because the future is genuinely tempting.

**Rules:**

1. Work on **one version at a time**, and only its scope.
2. A version's "explicitly deferred" list is a hard boundary. Do not implement those items "while
   you're in there."
3. Do not build a **generic system** for a future version's needs. Build the smallest thing that
   satisfies the current version's criteria. Concretely: no ECS because V12 might be big; no research
   tree because V11 has one; no matchmaking because V10 will want it.
4. Do not add **dependencies** without a stated problem they solve. "It is commonly used" is not a
   problem.
5. If a current version genuinely cannot be completed without a future-version decision, **stop and
   ask**, rather than quietly designing that future system.
6. If you notice a future-version problem while working, **write it down** in your report or in
   `docs/open-decisions.md` and move on. Do not fix it now.

**The test for overreach:** does the project still contain exactly one version's worth of work, and
can the owner still understand what exists? If a subsystem has no version that asked for it, you
have probably built it too early.

---

## 8. Reporting completed work

Every agent ends its work with a report. Keep it factual and short. Include:

1. **What changed** — files added or modified, grouped by purpose.
2. **Which version's criteria are now met**, and which are not. Be explicit about anything left
   unfinished; do not claim a version is complete when it is not.
3. **How it was verified** — the exact commands run (`npm run verify`, headless runs, determinism
   tests) and their results, plus what you checked manually in the running game.
4. **Decisions taken** — anything a future agent must respect. State whether an ADR was written, and
   which one, or explain why no ADR was needed.
5. **Assumptions made** — anything chosen that the owner has not confirmed. Add durable ones to
   `docs/assumptions.md`.
6. **Problems found but not fixed** — including problems outside the current version's scope. These
   are valuable; do not hide them or quietly fix them out of scope.
7. **Open questions** — anything in `docs/open-decisions.md` that blocks or shapes your work.

**Never report work as done when it is not.** A precise report of a partial result is far more
useful than a confident overstatement, because the next agent — and the owner — will build on it.

---

## 9. Quick checklist

Before finishing any change:

- [ ] Work stayed inside the current version's scope.
- [ ] Nothing on the version's "explicitly deferred" list was implemented.
- [ ] Effort within that scope was **not** minimised — the current version is as coherent and playable as it can be (ADR-0013).
- [ ] Placeholders are *good* placeholders: a viewer can tell what they represent and where things are.
- [ ] `src/core` imports no rendering, network, or platform code, and uses no `Math.random()`.
- [ ] New core logic has unit tests; new systems have a headless test where practical.
- [ ] `npm run verify` passes.
- [ ] **The running game was looked at.** Presentation was verified by rendering, not by reading the drawing code (`tools/shot.mjs`), or the limitation was stated explicitly.
- [ ] The game still starts and previous behaviour still works.
- [ ] New terms were added to the glossary; new constraints to an ADR.
- [ ] Assumptions were recorded in `docs/assumptions.md`.
- [ ] Anything undecided was added to `docs/open-decisions.md` rather than silently decided.
- [ ] The report says what was verified, how, and what was not finished.

---

## V4 additions: working on the encounter

**The opponent is not a damage source.** If you are changing combat, the property to protect is that
`src/core/ai/enemy-controller.ts` has no path to the damage model. It emits an `InputCommand` and nothing
else. If you find yourself wanting to make the enemy "hit harder", change `ENEMY_TUNING.aimErrorDeg` or
its vehicle definition, never the resolver.

**`Simulation.tick` is symmetric now.** `shellObstacles()` contains both vehicles, and a shell skips the
obstacle whose id matches its own `shooterId`. When adding a third vehicle, extend the obstacle list
there and remember the self-exclusion is by id.

**`targetIsOpponent: false`** restores the V3 inert target. Use it in any test or tool that needs a
tank that stays exactly where it was put; a fighting opponent moves between setup and the shot, which
makes positional assertions meaningless.

**`slopeDegreesAlong` requires a unit direction.** It projects the gradient onto whatever vector it is
given, so `(4, 0)` reports four times the true slope. This caused a real, expensive misdiagnosis in V4:
a 29-degree slope read as 66 degrees, which made authored terrain look unusable and sent a tuning pass
the wrong way. Normalise the direction.

**Derived consequences beat stored consequences.** Track damage is computed from module state every
tick rather than accumulated as a "wear" value, precisely so a restart is exactly reversible. Follow
that pattern for any new damage effect.

**Visual verification is not optional.** V4's arena amplitude, spawn bias, camera distance and briefing
position were all wrong in ways every automated gate passed, and each was found by looking at a
screenshot or by measuring the running simulation. The terrain amplitude in particular was cut from 9 m
to 5 m because a probe measured the opponent spawning 14 m below the player on ground neither vehicle
could manoeuvre on. When something looks wrong, write a probe and measure before changing a constant.

## V5 additions: working on the opponent

**Measure the miss, do not infer it.** The single most expensive defect in V5 was a fire gate that
measured a *bearing* error, so the permitted miss grew with range — 4.3 m at 48 m on a 3.3 m-wide tank.
Nothing in the code or the tests said the gunnery was broken; only measuring the perpendicular distance
from the barrel ray to the target did. When judging whether the opponent can shoot, log how far it
missed by, not merely whether it fired.

**A moving shooter cannot lay its gun.** If the tank is repositioning while its turret slews, the aim
point moves faster than any finite traverse rate can follow, and the measured best achievable miss
exceeds the vehicle's own size. Suspend movement until the gun is on target. That is a real property of
the simulation, not a bug to tune away.

**Never gate aiming on being able to fire.** The turret must stay trained on the enemy while the tank
manoeuvres, or it is pointing at a stale position the moment the range becomes shootable. The genuinely
wasteful case is not knowing where the enemy is, which is what line of sight is for.

**Two rules must not disagree about the same distance.** The planner's engagement band and the gun's
minimum range were independent numbers (32 m and 24 m), leaving a dead zone in between; and the range
check ran above the flank logic, so it cancelled in-progress flanks every tick. When a distance appears
in more than one place, assert the relationship in a test.

**A restart must rewind state, not reset it to a seed.** The `EnemyController` constructor consumes a
random draw, so `rng.reseed(seed)` alone leaves the stream one draw ahead and a "replayed" battle fires
its first shot with different scatter. The controller snapshots its post-construction generator state
and restores that. More generally: comparing a single final position is a weak determinism check, since
a divergence in one field can hide until it reaches something you happen to assert. Compare the state
you care about on every tick.

**Retreating is not driving.** Using `steerToward` to back away turns the hull through 180 degrees,
spending the whole hull traverse rate and pointing the tank's back at the enemy. `reverseFrom` backs up
instead, keeping both the range and the facing.

## V5F additions: working on the harness

**`npm run sim` is the fastest way to answer a behavioural question.** Run several seeded battles against
a scripted player and read the numbers. It is not slower than reasoning about the code — it is faster,
because the questions worth asking ("does it ever fire?", "does it lose the player?", "how often does a
shell actually reach the target?") are questions about *emergent* behaviour, and emergent behaviour is
exactly what reading the code cannot tell you. See `docs/harness.md`.

**A measurement can be wrong in a way that looks entirely healthy.** The first `charging` scenario
supplied an aim point and expected the player to charge. In this game the aim point servos the *turret*
and does not move the hull, so the player drove in a straight line, passed the opponent on the third
second and left the map — and the batch reported a perfectly plausible, completely meaningless 183 m
separation. When a number looks odd, check that it measures what its name claims before concluding the
game is broken. A twenty-seed sweep producing *identically* wrong results is the tell: real emergent
behaviour varies, a bug does not.

**Harness bugs present as game bugs.** The runner's first version failed on any second invocation with
"Port 24678 is already in use", because Vite's HMR websocket was enabled on a server that exists only to
transform TypeScript. Know the difference between your tooling failing and the thing under test failing,
or you will spend an afternoon debugging the game for a fault in the measuring instrument.

**Do not tune the AI to make a batch look better.** A sweep flagged seeds where the opponent saw the
player for 93 seconds without firing. Measuring the obvious fix showed it roughly triples damage against a
stationary player and roughly halves it against a fleeing one — a real trade-off, not a defect. The
correct outcome was to record it (OD-15) and leave it, because the version's gameplay objective had
already been signed off. A batch that reports an uncomfortable truth is working; silencing it is not.

## V6 additions: working on the battlefield

**One map description, three consumers.** Terrain, hard cover and concealment are data in the core, and
the ballistics, the line-of-sight test and the renderer all read that same data. The reason to insist on
one description is not tidiness: a building that exists only in the renderer produces a player watching a
shell pass through a wall, and an opponent shooting through one. The renderer cannot be allowed its own
list, because the first symptom of drift is a bug that looks like a physics problem.

**`blocksSight` is a flag, not a height.** A waist-high barrier that stops shells and not sight is
different cover from a building, and collapsing the two forces a choice between two genuinely different
pieces of cover. The test that pins it is worth keeping: the same line, stopped as a shell and clear as
sight.

**Authored spawns beat a terrain scan.** V4 scanned for a "consistent" opening and it was how the
encounter ended up on a plateau with the opponent nowhere in sight. On a designed map, where the fight
starts is a level-design decision. Keep the scan as the fallback for a map that does not say, or every
pre-existing test silently moves.

**The batch harness finds map defects the eye cannot.** `npm run sim -- --map ashford-valley` found
spawns 266 m apart on a map with a 200 m sight range: neither tank could see the other, so the opponent
searched for five minutes and fired nothing. Every screenshot looked fine. Before changing AI behaviour
in response to a surprising batch result, check whether the *map* is the thing that is wrong.

**A test at a rule's boundary catches what a playtest will not.** The spotting observer-penalty rule
multiplied unconditionally and quietly shortened everyone's sight range to 170 m on open ground. No
screenshot showed it and no playtest would reliably have; a test asserting the range boundary did,
immediately.