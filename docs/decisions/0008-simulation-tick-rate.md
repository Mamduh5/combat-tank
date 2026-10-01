# 0008. Simulation runs at a fixed 60 Hz tick, independent of frame rate

- **Status:** Accepted
- **Date:** 2026-10-01
- **Affects:** `src/core/sim/world.ts`, the client frame loop, future netcode.

## Context

The project needs simulation results that depend on the player's inputs rather than on the
machine's graphics card, and — from V9 — that a client and a server can agree on. Both require
simulation time to advance in fixed steps, so the question is what the step size should be and where
it is allowed to come from.

## Decision

The core advances in **fixed ticks of 1/60 s** (`TICK_DT_SECONDS`). The render loop measures real
elapsed time, accumulates it, and runs as many whole ticks as fit. Rendering may happen at any rate.

Two supporting rules:

- A real frame delta is **clamped to 0.25 s** before it reaches the accumulator, and the number of
  catch-up ticks per frame is **capped at 5**. Both prevent a stall (tab restore, breakpoint, GC
  pause) from turning into a burst of simulation that takes longer than a frame, which would cause
  the next frame to be even later — a spiral.
- Input is read **once per frame** and applied to every tick that frame runs. A slow frame therefore
  produces more ticks with the same input, rather than silently discarding simulation time.

The *network* tick rate is deliberately not fixed here. V9 may replicate at 20–30 Hz while the client
renders at 60 fps; keeping the two separate is why the core is tick-driven from V1 rather than being
written against a frame callback.

## Consequences

**Positive**

- A 30 Hz laptop and a 144 Hz monitor drive identically, which is the property that makes
  "multiplayer feels wrong" diagnosable rather than mysterious.
- Headless tests can advance the simulation with a synthetic delta and get identical results.
- The tick rate becomes a single constant that can be retuned without touching any system.

**Negative / costs**

- Up to five ticks of work can occur in one frame during a stall, which is a small but real cost.
- Simulation time can diverge slightly from wall-clock time after a long stall, because the backlog
  is dropped. This is a deliberate trade: continuous motion matters more than exact elapsed time.

**Constraints it imposes**

- Gameplay rates are expressed per tick or per second, never per frame.
- Nothing in the core may read a wall clock; the delta is always supplied by the caller.
- Code that needs smoothing must derive its factor from `dt` (see `smoothingFactor` in
  `src/core/math/vec3.ts`), not from a per-frame constant.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Variable timestep driven by frame delta | Makes results depend on the machine; breaks determinism and replays |
| Tie the tick rate to the network rate from the start | The network does not exist until V9; fixing it now would be premature |
| A much lower tick rate (e.g. 20 Hz) to save CPU | V1 has one vehicle; the cost is trivial, and revisiting it later would change movement feel |

## Verification

`tests/core/determinism.test.ts` asserts that 1200 single ticks and 120 frames of 10 ticks produce
byte-identical state, that `advance` runs only whole ticks, and that a huge delta is capped rather
than replayed.
