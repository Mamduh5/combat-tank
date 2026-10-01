# 0012 — Closed-form armour geometry and a three-step penetration model

**Status:** Accepted
**Date:** 2026-10-01
**Decided in:** V3
**Review by:** V4 — when dispersion arrives; V12 if art replaces placeholder geometry
**Related:** ADR-0001, ADR-0003, ADR-0005, ADR-0007, ADR-0010

## Context

V3's requirement was that **where a projectile hits matters**, and that it be testable against
hand-computed cases rather than against whatever the implementation happens to print. Armour
interaction is exactly the code that produces plausible-but-wrong numbers: a transposed vector or a sign
slip yields results that still look reasonable and still pass a casual eyeball.

Three things had to be chosen: how armour is *represented*, how a shell's angle against a plate becomes
a verdict, and how much of the result is random.

## Decision

### Armour is oriented slabs, in vehicle local space

Each plate is a box with a thickness, a position, a size, and a yaw and pitch — not a curved hull, not a
mesh. Hit resolution is ray-versus-oriented-box in closed form.

**Why:** it is exactly testable (no sampling rate, no tunnelling ambiguity), legible (a designer reads a
plate list and pictures the vehicle), and cheap enough to run every sub-step in the core. It needs no
dependency on the render or physics meshes, so armour cannot disagree with what is drawn (ADR-0007).

**Accepted cost:** compound-sloped armour is not representable. A plate has one normal, so a real
vehicle's multi-facet glacis becomes several plates. That is a V3 prototype trade; a finer
representation can replace this without changing how penetration is computed from the result.

### Penetration is three steps, in order

1. **Effective armour** — `nominal / cos θ`. At 0° this is exactly the nominal thickness; at 60° it is
   twice as much. Geometrically true: the shell travels further through the material.
2. **Normalisation** — the shell's `normalization ∈ [0,1]` cancels that fraction of the penalty:
   `nominalPenetration × (1 + normalization × (1/cos θ − 1))`. At 0 it pays the full geometric
   penalty; at 1 the angle cancels entirely, so only ricochet protects sloped armour.
3. **Ricochet** — above `ricochetThresholdDeg`, the shell deflects and penetration is never computed.

Ricochet is checked **first**, before any trigonometry, because a shell at 85° should not be handed a
meaningless effective thickness to compare against. Velocity then scales capability linearly against
`referenceVelocityMps`.

**Why not World of Tanks' formulas:** the owner asked for something understandable and tunable, not a
reproduction of another game's proprietary model. These are three lines whose behaviour at any angle can
be reasoned about without running code, and every parameter is data.

### No randomness

Penetration is **deterministic**. Damage is a fixed amount per penetration. The owner allowed randomised
penetration but preferred deterministic fixed values absent a gameplay reason.

**Why:** a fixed number keeps V3 reproducible and its tests exact, and dispersion (OD-05) is the
mechanism that should add variance. Randomness here too would make shots unpredictable for no gameplay
gain, and would collide with the determinism question (OD-10) for no benefit.

### The impact record is reused, not recomputed

The shell system already resolved which plate was struck: the impact's position is where the shell met
the surface, and its normal is that plate's normal. The combat resolver reads that rather than casting
a second ray.

**This was a real bug, found by testing.** The first implementation re-cast a ray from the impact point
along the travel direction. That ray passes straight through the plate that was hit and lands on
whatever is behind it, so a shot at a sloped hull front was scored against the turret plate rising behind
it — a plausible-looking result for entirely the wrong plate. The resolver now identifies the plate from
the recorded impact position, with a tolerance so a genuine miss cannot be scored against the nearest
plate.

## Consequences

**Good**

- Every rule is data in the vehicle definition, so a different vehicle is a different file (ADR-0003).
- The three outcomes — penetrated, blocked, ricocheted — are distinguishable without a log, which is what
  the hit-feedback panel renders.
- Reproducible across machines, which the multiplayer design depends on (ADR-0001, ADR-0005).
- Hand-computable. The tests assert values like "200 mm at 60° presents 400 mm", not snapshots.

**Accepted costs**

- No armour-quality or material modelling. Every plate resists purely by thickness and angle — enough to
  make angle matter, not enough to make two identical-thickness plates behave differently. Material
  systems are deferred.
- One normal per plate, as above.
- Damage does not scale with penetration margin: a shell that barely got through costs the same as one
  that went deep. Recorded on `VehicleSurvivability.damagePerPenetration`.
- Ricochet is a single binary decision at the first impact, with no multi-bounce simulation. The owner
  explicitly did not require one for V3.

## Verification

`tests/core/armor.test.ts` (43 tests) asserts perpendicular penetration against known thicknesses, that
effective armour doubles at 60° and equals half-thickness-at-60° to head-on-thickness, monotonic
increase with angle, the normalisation extremes and interpolation between them, the ricochet boundary,
plate selection by region, turret plates following turret heading, and that shell geometry cannot tunnel.

`tests/core/damage.test.ts` (15) and `tests/integration/combat.test.ts` (18) cover damage application,
spatial module hits, destruction, determinism, and the full impact-to-damage path.

Every numeric assertion is a hand-computed value rather than a snapshot of current output, because a
snapshot would have recorded the plate-normal bug as correct.