# 0001. Headless deterministic simulation core with thin client/server shells

- **Status:** Accepted (proposed at V0 planning; confirm at V1)
- **Date:** 2026-10-01
- **Affects:** The entire codebase, in every version.

## Context

Combat Tank must support an authoritative multiplayer server, AI opponents that are testable
without a human, thousands of simulated battles for balance validation, and reliable modification by
coding agents. A design that puts gameplay logic inside the Babylon.js client satisfies none of these
without a rewrite.

## Decision

All gameplay logic lives in `src/core`, a pure TypeScript module that has no dependency on Babylon.js,
Colyseus, the DOM, Node APIs, or wall-clock time. The client and the server are thin shells that
exchange `InputCommand`s and simulation snapshots with it.

## Consequences

**Positive**

- The same code runs for single player, multiplayer, and headless batch simulation.
- The server can be genuinely authoritative, because it runs the real rules rather than a reimplementation.
- Battles are testable without a renderer, which is what makes AI and balance validation practical.
- Module boundaries are explicit, which helps agents work on the codebase reliably.

**Negative / costs**

- Results must be read out of the core as snapshots rather than poked at directly, which is more
  plumbing than writing directly against a scene graph.
- Some conveniences of a framework-first design (scene-graph-driven gameplay, engine helpers) are
  deliberately given up.
- Every gameplay feature must be written twice in the sense of "core rule plus client presentation".

**Constraints it imposes**

- `src/core/**` imports nothing from `src/client/**`, `src/server/**`, Babylon, or Colyseus.
- The core advances only via explicit fixed-length ticks.
- Gameplay code receives `InputCommand` values; it never reads devices or sockets.
- Presentation code reads simulation state and never writes it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Gameplay inside the Babylon client | Server authority would require a rewrite; headless testing impossible |
| A framework/ECS handling both client and server | Adds a large abstraction before we know the shape of the simulation |
| Separate implementations of rules for client and server | Two implementations drift; the server's would be authoritative and the client's wrong |

## Verification

A lint rule fails the build if `src/core` imports a forbidden module. A headless battle test in V5+
proves the core runs with no renderer. `docs/agent-working-guide.md` §4 restates the constraint for
agents.
