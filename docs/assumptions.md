# Planning Assumptions

**Status:** Reference. These are decisions made *during planning* without explicit owner
confirmation. They are recorded so they are visible and easy to overturn — not because they are
settled.

Each assumption states what was assumed, why, and what it would cost to be wrong. If the owner
disagrees with one, the assumption is simply struck and the affected documents updated; that is a
cheap operation **now** and an expensive one after V8 or V11.

---

## A-01 — Units and conventions
**Assumed:** distance in metres, armour thickness and penetration in millimetres, time in seconds,
speed in metres per second, angles in radians internally and degrees at the UI boundary.
**Why:** matches how the genre is normally discussed and discussed in the owner's brief, and keeps
unit mixing — a reliable source of silent bugs — visible in identifier names.
**Cost if wrong:** mechanical; a rename plus a sweep of conversion code.

## A-02 — Tank locomotion is kinematic, not a dynamic rigid body
**Assumed:** an explicit movement model in the core, using Rapier only for collision queries.
**Why:** handling should be a designed, tunable feel, and the server must reproduce it exactly.
**Cost if wrong:** contained — it is a V1 spike (OD-12) with a recorded alternative, and swapping
later means rewriting one module.
**Status: CONFIRMED during V1 implementation.** Recorded in ADR-0007, which also covers the related
finding that ground contact uses the analytic terrain rather than a mesh ray cast.

## A-03 — Determinism is a goal with a fallback, not a guarantee
**Assumed:** the project builds for client prediction, but will fall back to pure server authority
if cross-machine determinism cannot be achieved.
**Why:** Rapier's WASM build is documented as deterministic, but `Math.sin`/`Math.cos` are not, so
bit-exact cross-machine agreement is plausible but unproven.
**Cost if wrong:** reduced responsiveness in multiplayer, not a broken game. This is why the
fallback is acceptable.
**Status: still open (OD-10).** The core is built so the V9 test can answer it either way: the
deterministic trig module and the seeded RNG are in place and covered by tests.

## A-04 — Simulation tick of 60 Hz, network tick possibly lower
**Assumed:** the core steps at a fixed 60 Hz from V1; the network tick rate is decided at V9.
**Why:** fixing the core to the network rate would be premature; 60 Hz is a safe default that can be
lowered later.
**Cost if wrong:** trivial, since the core is tick-driven from the start.
**Status: CONFIRMED during V1 implementation.** Recorded in ADR-0008, which adds the frame-delta
clamp, the catch-up cap, and the once-per-frame input rule.

## A-05 — Direct WASD hull control
**Assumed:** W/S throttle and brake/reverse, A/D hull traverse, mouse for looking.
**Why:** it matches the owner's stated expectation, and the input layer is isolated enough to add an
assist later.
**Cost if wrong:** high while unlearned, but the fix is confined to the input layer.
**Status: CONFIRMED by the owner.** OD-02 is resolved; this is now a decision, not an assumption.

## A-06 — Placeholder-first art
**Assumed:** primitive geometry through at least V5, with visuals bound by id from the vehicle
definition.
**Why:** the owner's brief states gameplay correctness matters more than art, and the project must
not be blocked on assets.
**Cost if wrong:** a V12 art pass, which is planned for and budgeted for in the version plan.

## A-07 — Deterministic trig in the core
**Assumed:** polynomial approximations for sin/cos in `src/core/math`, rather than `Math.*`.
**Why:** `Math.sin`/`Math.cos` are explicitly called out as non-deterministic across platforms in
Rapier's own documentation, and the core needs to be reproducible.
**Cost if wrong:** very low accuracy loss over the ranges used; the code is small and isolated.
**Status: CONFIRMED during V1 implementation, with two corrections the tests forced.** The initial
`cos` polynomial had its coefficients shifted by one term, and the quadrant reduction ignored parity;
both produced smooth, plausible-looking, wrong functions. Accuracy is now asserted against `Math.*`
across the full range, which is exactly what a test that uses the platform implementation *is
allowed* to do while production code is not.

## A-08 — One shell type until the ammunition roster is decided
**Assumed:** a single generic shell for V2/V3, with the data model already parameterised per shell.
**Why:** the owner's brief named shell types as examples, not commitments (OD-04).
**Cost if wrong:** low, because types are data.
**Status: HELD during V2, deliberately.** The owner confirmed in the V2 brief that OD-04 must *not* be
forced. The shipped shell is named `test-ballistic` / "Test Ballistic Shell", and its data carries a
`maxSubstepM` and a `massKg` that are engineering parameters rather than design commitments. A test
asserts the id and display name stay generic, so a temporary value cannot quietly harden into a
permanent taxonomy. Penetration, ricochet and shell-specific behaviour remain V3 work.

## A-09 — V2 tuning values are engineering defaults, not balance
**Assumed:** turret traverse rate, gun elevation/depression limits, elevation rate, reload duration and
muzzle velocity are placeholders chosen to make the systems observable and testable.
**Why:** the owner stated explicitly that V2 should not tune final vehicle balance, and that
placeholder characteristics should be reasonable and stored in vehicle data.
**Cost if wrong:** a tuning pass. Every one of these values lives in `src/shared/placeholder-tank.ts`
as data, not as a constant in a system, so changing them is an edit to one file with no code change.
**Status: assumption, not a decision.** Do not cite these numbers as design intent, and do not let a
later version inherit them as defaults without re-checking them against the player's experience.

## A-10 — V3 armour, penetration and damage values are placeholders
**Assumed:** plate thicknesses, the ricochet threshold, shell normalisation, vehicle hit points, module
hit points, and per-penetration damage are engineering defaults that make the systems observable and
testable.
**Why:** the owner stated V3 is not final balance, and that a stationary damageable target is acceptable
and required for validation. There is no armour-quality model and no dispersion yet, so these numbers
have nothing meaningful to be balanced against.
**Cost if wrong:** a tuning pass with no code change — every one of these lives in vehicle data.
**Status: assumption, not a decision.** The armour numbers in `placeholder-tank.ts` and
`placeholder-target.ts` are **invented**, not statistics for any real vehicle. `docs/vision.md` §6 is
explicit that Combat Tank is not a simulator. Do not cite them as tank specifications.
**Explicitly not modelled:** armour quality or materials, dispersion (OD-05), overmatch, spall, crew,
fire and ammunition detonation.

## A-09 — Track and engine are the first damageable modules
**Assumed:** V3 implements those two, with the module system designed to accept more.
**Why:** they produce the most legible, gameplay-visible failure states ("it cannot move now"), which
supports principle P6.
**Cost if wrong:** low; other modules are data additions.

## A-10 — Elimination is the first win condition
**Assumed:** a single elimination mode with a time limit for V4/V6, with a second mode in V7.
**Why:** it is the simplest condition that fully exercises the match lifecycle (OD-08).
**Cost if wrong:** low; the match system is designed around a pluggable win condition.

## A-11 — Small multiplayer battles
**Assumed:** a small fixed number of participants per side in V10, not 15v15.
**Why:** the owner's brief explicitly asks not to design the first multiplayer version around large
scale, and Colyseus state replication cost grows with participant count.
**Cost if wrong:** significant rework; this is the assumption most worth confirming with the owner
before V10.

## A-12 — No monetisation, PC only
**Assumed:** no store, no premium currency, no platform-specific work.
**Why:** the owner's brief frames progression as long-term and does not mention monetisation, and
`docs/vision.md` §6 lists it as a non-goal.
**Cost if wrong:** large, but reversing it early is far cheaper than reversing it after V11
(OD-14).

## A-13 — Node.js as the server runtime
**Assumed:** the Colyseus server runs on Node.js.
**Why:** it is the ecosystem the owner's brief names, and it is Colyseus's primary target.
**Cost if wrong:** moderate; the core is runtime-agnostic, but the server shell would be rewritten.

## A-14 — Headless simulation is a first-class test path
**Assumed:** from V5, `src/tools/headless` can run complete battles with no rendering and produce
machine-readable reports.
**Why:** it is the only practical way to validate AI and balance without a human playing every match.
**Cost if wrong:** high in rework; this is why the core is designed without a rendering dependency
from V1.

---

## Assumptions that are explicitly *not* made

For the avoidance of doubt, planning did **not** assume: a vehicle class taxonomy, a progression
tree shape, a final shell roster, a battle mode list, a frame-rate target, a distribution platform,
a monetisation model, crew systems, or a final AI approach. These are in
`docs/open-decisions.md`.
