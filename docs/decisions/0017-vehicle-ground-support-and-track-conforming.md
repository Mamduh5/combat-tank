# ADR-0017: The vehicle is presented on a fitted support plane, with a conforming track

- **Status:** accepted
- **Date:** 2026-10-02
- **Deciders:** Owner
- **Related:** ADR-0001 (headless core), ADR-0003 (data-driven vehicles), ADR-0007 (kinematic locomotion),
  ADR-0013 (versions define scope), ADR-0015 (prototype assets generated in-project)

## Context

The owner played V6 and reported one specific defect: **the tank was grounded on flat terrain, but most of
it floated on non-flat ground.** Everything else in V6 was accepted — controls, camera, aiming, the railway,
enemy discoverability.

The previous pass had already attempted a fix, described in the code as a contact-offset correction that
measured how far the model's geometry sat above its root origin. The owner's report was that this "solved
only static vertical placement".

### What measurement found

`tools/measure-grounding.mjs` was written to answer this with numbers rather than impressions. It measures,
at seven stations along each track, the signed gap between the rendered track's lower edge and the terrain
beneath it. It found **three independent causes**, and each was invisible to the existing suite.

**1. Body pitch and roll had inverted signs.** This was the largest contributor. On the Cairn approach the
terrain rose 0.901 m from tail to nose while the rendered hull rose 0.892 m the *other* way: the nose was
buried 0.41 m into the slope while 1.38 m of daylight showed under the tail. Across the surveyed surfaces,
**12 of 13 poses had the hull tilting opposite to the ground beneath them**, with the magnitude almost
exactly correct in every case — which is precisely why it read as "slightly off" rather than as an inverted
sign.

The cause was a double negation. The core decomposed the centre ground normal's forward component and
negated it, but a normal tilted back by a climb already has a *negative* forward component, so negating it
produced a positive pitch. Babylon composes `rotation` as `Ry(yaw) * Rx(pitch) * Rz(roll)`, and under that
composition a positive `rotation.x` swings the model's local `+Z` — its nose — **downward**. So a climbing
tank was pitched nose-down. Roll was inverted through the same route.

Nothing caught this because every existing test compared the *simulation's* vectors against the
simulation's own forward vector, and the simulation was never wrong. Only the rendered model was, and
nothing ever asked what the renderer drew.

**2. The ground was sampled at a single point.** A tank is 6.7 m long and 3.3 m wide; the terrain under its
nose, tail and flanks differs by tens of centimetres on ordinary ground. One central normal describes none
of that, and even with the sign corrected a rigid hull posed to a point bridges every dip beneath it.

**3. The visual origin and the simulation origin meant different things.** The simulation places the vehicle
origin at `groundHeight + rideHeightM`, and that origin is the **hull floor** — which genuinely does float.
The model's origin is the **track contact line**: the track slab is centred at `trackHeightM / 2`, so its
lower edge is at local y = 0. So drawing the model at `position.y` left the track bottoms a full ride height
(0.48 m) in the air on *every* surface. The contact offset the last pass added measured **zero** — correctly,
because the geometry really does reach local y = 0 — so it subtracted nothing and changed nothing.

## Decision

### The hull presents a fitted support plane

`solveGroundSupportPlane` fits a least-squares plane to a **3x3 grid of contact samples** spanning the track
footprint, aligned to the vehicle's own axes. Pitch and roll follow from its two gradients:

```
pitch = -atan(risePerMetreForward)     // nose-up is a negative rotation.x
roll  =  atan(risePerMetreRight)       // a positive rotation.z raises the right side
```

Because the grid is symmetric about its centre, the normal equations decouple exactly — `Σu`, `Σv` and `Σuv`
all vanish — so the intercept is the mean height and each gradient is an independent ratio. There is no
matrix to invert and no pivot to choose wrongly on degenerate ground.

### The track conforms to the ground beneath it

A plane through a rolling landscape is a chord: it floats over every dip and buries itself in every rise.
So the rigid track box is replaced by **eight segments per side**, each on its own node, and each is offset
every frame by the difference between the ground under it and the hull's nominal track line. The offset is
eased at a fixed rate **per second** rather than per frame, so the behaviour is identical at 30 Hz and 144 Hz,
and clamped to 0.55 m of travel, which is more than the largest residual on the map.

The track links, the road wheels, the return rollers, the sprocket and idler, and the fenders are all
parented to their segment, so the whole running gear articulates together. The **hull stays rigid**, which is
correct: real tanks have a rigid hull, and real tracks.

### The renderer drops the ride height

The visual root is placed at `state.position.y - state.rideHeightM - contactOffsetM`. The ride height is
dropped because this model's origin is the contact line rather than the hull floor; the contact offset is
still measured rather than hard-coded, because a model authored with its origin above the contact line would
need it.

## Consequences

- Worst daylight under the track, across thirteen surveyed surfaces: **1.393 m → 0.025 m**. Worst while
  driving at 6 m/s: **0.116 m**. Worst frame-to-frame change in that gap: **0.030 m**.
- Poses where the hull tilts opposite to the ground: **12 of 13 → 0 of 13**.
- Locomotion is untouched. `position`, `heading`, `speed` and the traverse rates are unchanged, and the
  vehicle drives identically under the same input. The conforming is presentation-only and reads simulation
  state without ever writing it (ADR-0001).

### What was deliberately *not* done

No tracked-vehicle suspension simulator. One plane for the hull, per-segment offsets for the running gear,
no force, no spring, no wheel-level dynamics. The brief asked for a convincing prototype and this is one.

The map was not flattened, the vehicle was not shrunk, no visible track geometry was removed, and the camera
was not moved to hide a gap.

### Two mistakes worth recording

Both were caught only by looking at the running game, and both produced *clean numbers* while the model was
visibly broken — which is the most dangerous kind of measurement error there is.

**Measuring the wrong thing.** The first conforming implementation offset each segment by the full
ground-to-plane distance rather than the residual, which dragged the tracks a metre below the hull. The
vehicle stopped floating and started coming apart, and **every gap measurement still read zero**, because
they only ever compared the track against the terrain. Nothing compared the track against the *hull*. The
browser harness now also reports a cohesion figure — the fender-to-track overlap, measured per station — and
that is the check that would have caught it.

**A stationary vehicle reporting perfect contact.** The first driving harness set its input through
`setInputFrame`, which only feeds the real render loop, while the harness stepped the simulation itself. The
override was ignored, the tank never moved, and it reported a flawless zero gap on every frame. The harness
now reports `travelledM` and a `moved` flag, so a drive that failed to move cannot be read as a clean run.

### The tolerance that was measured rather than assumed

`FLOATING_GAP_M` is 0.12 m, derived rather than guessed: at the orbit camera's usual standoff and a 40 degree
vertical field of view, that subtends roughly eight pixels in a 760-pixel frame. It is the point at which a gap
stops being a tolerance and becomes a visible dark line under the track. Burial is measured and gated
separately, because the obvious fix for daylight is to lower the vehicle until it clips, and a fix that
trades a float for a burial has not fixed anything.

## Alternatives rejected

- **Lowering the vehicle globally until it touches.** Explicitly forbidden, and wrong: it buries the hull in
  every dip while still bridging every crest. It also cannot fix the inverted attitude.
- **Flattening Marlowe Crossing.** The map was accepted by the owner and is measured to be drivable.
- **Sampling more points but keeping one rigid body.** Fixes the attitude but leaves the chord problem, which
  measured 0.52 m of daylight on its own after the sign was corrected.
- **Raising the camera.** Hides the gap from one angle and is not a fix.
- **A full suspension solver.** Not needed for a convincing prototype, and it would put vehicle dynamics in
  the presentation layer.

