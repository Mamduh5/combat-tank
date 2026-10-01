# 0011 — The turret is a servo on an aim point, not a set of angles

**Status:** Accepted
**Date:** 2026-10-01
**Decided in:** V2
**Review by:** V9 — when client prediction needs to predict turret motion
**Related:** ADR-0003, ADR-0004, ADR-0007

## Context

The owner's requirement for V2 was explicit: hull movement, turret aiming, gun orientation and firing
must be **separate systems**, and the tank "must not behave like a character whose entire body instantly
points wherever the mouse looks."

Two interfaces for aiming were possible.

**Angles.** The input carries a desired turret heading and a desired gun elevation directly. Simple to
implement and to reason about.

**A world point.** The input carries a point the operator wants the gun trained on, and the turret works
out the bearing and elevation for itself.

## Decision

`InputCommand` carries an **`aimPoint: Vec3 | null`**, not a pair of angles. `null` means "no new aim
request" and the turret holds its current orientation.

The turret and gun are **rate-limited servos**. Each tick they compute the bearing and elevation from
the trunnion to the aim point, clamp the target to their mechanical limits, and rotate toward it at a
rate bounded by the vehicle definition. They never snap and never exceed their rate limit.

The rate limit has two parts, and **both are required**:

1. The distance limit — never move further in a tick than the distance remaining.
2. The stopping limit — `sqrt(2 · acceleration · remaining)`, the fastest rate from which the mechanism
   can still decelerate to rest exactly on the target.

The stopping limit was found the hard way. With only the distance limit, the turret arrives at full
speed, sails past the target, and then hunts back and forth around it — a visible oscillation. This
was caught by a test during V2 development, not by inspection, and is asserted against in
`tests/core/turret.test.ts`.

## Consequences

**Good**

- **Rate limits live in vehicle data**, not in the caller. A different tank gets different traverse
  behaviour by changing numbers, which is the whole point of ADR-0003.
- **The AI gets the identical interface.** A V5 bot supplies a target's world position through the same
  field a human's cursor ray fills. There is no second aiming path that could drift from the player's.
- **The client's input handling stays trivial.** It resolves a ray against terrain and passes a point.
  It does not need to know about the turret ring, the hull heading, or the traverse arc.
- **A fixed world aim point is meaningful.** The player can aim at a spot and drive the hull anywhere;
  the turret servos to keep the gun on it.

**Accepted costs**

- The turret *chases* the aim point rather than being positioned at it, so under fast hull rotation the
  gun can visibly lag. **This is correct behaviour**, not a defect — it is what makes the turret a
  mechanism rather than a cursor — but it is a feel question that needs human playtesting.
- A degenerate aim point (directly above or below the trunnion) has no meaningful bearing, so horizontal
  aim is held rather than snapping somewhere arbitrary.
- The input field carries three floats rather than two. Over a network this is slightly larger than an
  angle pair, which matters only at V9 scale.

## Alternatives recorded

- *Angles in the input:* rejected because it pushes the mechanical limits into the client, and the client
  is the part least entitled to decide what the vehicle can physically do. A malicious or buggy client
  would also be asserting a turret position directly.
- *An aim ray (origin + direction) instead of a point:* rejected for now because it defers the "what is
  being aimed at" decision to the core, which does not yet have targets. A point is also directly
  usable by the V5 AI. Easy to change later if the point proves insufficient.