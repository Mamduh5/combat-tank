# 0005. No `Math.sin`/`Math.cos` in the simulation core; own deterministic math

- **Status:** Accepted (proposed at V0 planning; implement in V1)
- **Date:** 2026-10-01
- **Affects:** `src/core/math`, `src/core/rng`, all trigonometry in gameplay.

## Context

Rapier's documentation states that its WASM build is cross-platform deterministic, but the same
documentation warns that JavaScript's `Math.sin` and `Math.cos` are **not** cross-platform
deterministic. Combat Tank needs the same seed and the same inputs to produce the same result on
different machines, for replayable bugs, meaningful headless balance testing, and the client
prediction that V9 depends on.

## Decision

The simulation core uses its own deterministic implementations of the trigonometric functions it
needs, written as polynomial approximations in `src/core/math`. `Math.sin` and `Math.cos` must not
be called from `src/core`. All randomness comes from a seeded PRNG in `src/core/rng`;
`Math.random()` is likewise banned from the core.

## Consequences

**Positive**

- Gameplay results depend on inputs and seed, not on the host's floating-point transcendentals.
- Battles are reproducible from `(seed, input log)`, which makes bugs replayable and balance tests
  meaningful.
- This is the mitigation that makes the V9 determinism test plausible.

**Negative / costs**

- Hand-written approximations are slightly less accurate than the platform's, and must be bounded
  to the ranges the game actually uses.
- A small amount of extra code exists purely for this purpose.
- The rule must be enforced by tooling, or it will be violated by an agent in a hurry.

**Constraints it imposes**

- No `Math.sin`, `Math.cos`, `Math.tan`, or `Math.random()` in `src/core`.
- No wall-clock reads in the core; time advances by fixed ticks only.
- Lint rules enforce both the import boundary and the banned-function list.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Use `Math.*` and accept non-determinism | Defeats replay, weakens balance testing, and undermines client prediction |
| Restrict determinism to gameplay-critical paths only | The boundary is hard to draw reliably; partial determinism is hard to debug |
| Seek an existing deterministic math library | Adds a dependency for a small, well-understood need |

## Verification

A lint rule fails the build on banned functions in `src/core`. V1 and V5 include determinism tests:
the same seed and inputs must produce identical state across runs.
