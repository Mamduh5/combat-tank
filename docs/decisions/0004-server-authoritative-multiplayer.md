# 0004. Server-authoritative multiplayer; clients never assert combat outcomes

- **Status:** Accepted (proposed at V0 planning; implement in V9)
- **Date:** 2026-10-01
- **Affects:** `src/server`, `src/shared/protocol`, `src/client/net`, progression rewards in V11.

## Context

`docs/vision.md` principle P10 treats cheat-resistance as a design value rather than a later patch.
A client that decides its own hits, positions, or rewards cannot be corrected after the fact.

## Decision

The server owns the simulation and is the sole authority on combat outcomes. Clients send
**intents** (`InputCommand`) and receive **state snapshots and events**. A client that claims a hit,
a kill, a position, or a reward is ignored or corrected. Server-side validation rejects impossible
inputs such as firing during reload or exceeding traverse rates.

## Consequences

**Positive**

- Cheating is structurally difficult rather than merely discouraged.
- The simulation is consistent for every participant, which is a precondition for competitive play.
- Bots and humans occupy the same slots, so mixed battles are natural.
- Progression rewards in V11 can be computed from server-side results and cannot be forged.

**Negative / costs**

- The player depends on network latency, which is why client prediction is planned (and why its
  determinism dependency is called out as OD-10).
- The server must run the full simulation for every participant, which caps the practical battle
  size and server cost.
- Development requires running two processes, which is more friction than a purely local game.

**Constraints it imposes**

- No network message may carry a gameplay *result*; only intents and identifiers.
- Reward and progression state is server-owned from V11 onward.
- The protocol must be versioned once it exists, so old clients cannot desync a room silently.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Client-authoritative with server-side sanity checks | Leaves the decisive values on an untrusted machine |
| Peer-to-peer | No authority at all; contradicts P10 |
| Pure server authority with no prediction | Safe but potentially unplayable under latency; kept as the documented fallback (OD-10) |

## Verification

V9 validation requires a test that a client firing during reload is corrected by the server, and a
test that a client lying about its position is reconciled. V11 requires a test that a client cannot
grant itself currency.
