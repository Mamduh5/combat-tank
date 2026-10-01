# 0010 — Analytic ballistics without drag

**Status:** Accepted
**Date:** 2026-10-01
**Decided in:** V2
**Review by:** V3 — when penetration and post-impact ballistics exist
**Related:** ADR-0005, ADR-0007, ADR-0009

## Context

V2 introduces the first real projectile: a shell that leaves the muzzle, travels, drops under gravity,
and lands. The owner required a **real travelling projectile**, not hitscan, and asked for a model
"physically coherent enough to support later gameplay" without building a ballistics research suite.

Several models were possible:

- **Hitscan.** Rejected outright by the owner. It removes travel time and drop, which are the two
  things that make range and leading matter.
- **Instant ray plus a drop offset** (hit-scan at an adjusted range). Cheaper, but it fakes the flight
  and makes leading a moving target impossible.
- **Full 6-DOF rigid-body ballistics** with drag, spin stabilisation, and aerodynamic coefficients.
  Realistic, and far beyond what V2 can evaluate or balance.
- **Point-mass integration under constant gravity**, sub-stepped for collision.

## Decision

Shells are **point masses integrated per tick under constant gravity**, with no aerodynamic drag.

Integration is semi-implicit Euler:

```
velocity.y -= g * dt
position  += velocity * dt
```

per fixed 60 Hz tick, in the simulation core, with `g = 9.81 m/s²`.

The trajectory is **sub-stepped** so no sample is more than `maxSubstepM` from the previous one. At
800 m/s a shell covers roughly 13 m in one tick; without sub-stepping it would pass through a hill and
be reported as still flying on the far side. The sub-step interval is data, not a constant, so a faster
shell can be sampled more finely without editing code.

Ground intersection **bisects within the crossing sub-step** so the impact lands on the surface rather
than wherever the step happened to end, and reports the analytic surface normal.

## Consequences

**Good**

- Travel time and drop are real and emerge from the model rather than being special-cased.
- The integrator uses only addition and multiplication, so it stays bit-identical across JavaScript
  engines, which the multiplayer design depends on (ADR-0005).
- It is cheap. A few sub-steps per shell per tick, proportional to distance rather than to shell count.
- It is easy to reason about, which is what made the V2 sanity checks writable.

**Accepted costs**

- **No drag.** A real shell loses a substantial fraction of its velocity to air resistance, which
  changes how much it drops. Modelling it properly needs a drag coefficient, a reference area and air
  density — exactly the physics package the owner asked not to build for V2. The practical effect is
  that long shots in V2 fall slightly short of where a real shell would, and the discrepancy grows
  with range. **This is a deliberate, recorded omission, not an oversight.**
- **No spin stabilisation, no wind, no temperature or air-density variation.** All are real effects
  that a later version may want, none of which V2 evaluates.
- Accuracy is adequate, not excellent: over a ten-second flight the integration error is centimetres.
  That is fine for a blunt projectile in a game.

Adding drag later touches only the velocity update in `stepShell`. The impact contract does not change,
because it already reports the velocity *at* impact rather than at the muzzle — which is precisely the
field a drag calculation would need.

## Alternatives recorded

- *Hitscan:* rejected by the owner as incompatible with V2's goal.
- *6-DOF rigid body:* rejected as disproportionate to V2; nothing in V2 could tune its parameters.
- *Analytic closed-form trajectory plus a root find:* attractive for determinism, but it does not
  compose with terrain intersection and would need solving per shot against a surface the core already
  samples numerically. The tick-integrated model reuses the same terrain query the vehicle uses.

## Verification

- `tests/core/ballistics.test.ts` asserts drop follows `0.5·g·t²` to within the integrator's accuracy,
  that vertical speed changes at `g`, that flight time and distance increase together, that a shell
  does not tunnel through terrain, and that identical launches produce bit-identical results.
- The absence of drag is asserted explicitly rather than left implicit, so it stays a recorded
  decision if someone later adds drag.