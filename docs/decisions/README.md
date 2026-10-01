# Decision Records (ADRs)

This folder records decisions that **future coding agents must respect**. It is deliberately small.
Most work does not need an ADR; only decisions that are hard to reverse, surprising, or
constrain how code is written later.

## When an ADR is required

Write an ADR when:

- A technology is chosen or replaced (for example, replacing Rapier physics for custom code).
- A structural rule is established that future code must not violate (for example, "the
  simulation core must never import Babylon").
- A gameplay model is chosen that affects data format or system boundaries (for example, "armor is
  modelled as discrete plates with normals, not as a single HP-per-facing-value").
- Something is deliberately rejected, and a future agent would reasonably wonder why.
- A convention is established that would be expensive to change later (naming, module layout,
  tick rate, unit conventions).

**No ADR is needed** for: adding a feature described in the version plan, tuning a value, fixing a
bug, or writing tests.

## When an ADR is *not* allowed to be

An ADR does not record "we might do X later". Speculative work belongs in the version plan's
*deferred* lists or in `docs/open-decisions.md`. Do not commit the project to architecture for
systems that are two or more versions away.

## Format

Files are named `NNNN-short-slug.md`, numbered sequentially from `0001`, and use the template in
[`0000-record-template.md`](0000-record-template.md).

## Index

| # | Decision | Status | Date | Review |
| --- | --- | --- | --- | --- |
| [0001](0001-headless-simulation-core.md) | Headless deterministic simulation core with thin client/server shells | Accepted | 2026-10-01 | V1 |
| [0002](0002-single-package-enforced-boundaries.md) | Single package with enforced module boundaries; no monorepo yet | Accepted | 2026-10-01 | **V9** — revisit when a server is deployed separately |
| [0003](0003-data-driven-vehicle-definitions.md) | Data-driven vehicle definitions with a validated schema | Accepted | 2026-10-01 | V8 |
| [0004](0004-server-authoritative-multiplayer.md) | Server-authoritative multiplayer; clients never assert combat outcomes | Accepted | 2026-10-01 | V9 |
| [0005](0005-deterministic-math-in-core.md) | No `Math.sin`/`Math.cos` in the simulation core; own deterministic math | Accepted | 2026-10-01 | V9 |
| [0006](0006-no-game-framework-ui.md) | No game-framework UI library in the client | Accepted | 2026-10-01 | **V11** — revisit when the garage exists |

> The ADRs above were **written during the V0 planning pass** and describe the proposed direction.
> They are marked Accepted on the strength of `docs/technical-direction.md`, but they have not yet
> been confirmed by the owner. If the owner rejects any of them, the ADR must be updated or
> superseded — not silently ignored. Two of them (0002 and 0006) are explicitly time-boxed to a
> later version rather than being permanent.

> **Not yet decided, and therefore not yet recorded here:** OD-10 (client prediction vs. pure server
> authority) and OD-12 (kinematic vs. dynamic locomotion). Both are open technical questions in
> `docs/open-decisions.md` and will get their own ADRs when the V1 spike and the V9 determinism test
> settle them.
