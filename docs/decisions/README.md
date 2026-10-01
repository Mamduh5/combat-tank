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
| [0002](0002-single-package-enforced-boundaries.md) | Single package with enforced module boundaries; no monorepo yet | Accepted (settles OD-11) | 2026-10-01 | **V9** — revisit when a server is deployed separately |
| [0003](0003-data-driven-vehicle-definitions.md) | Data-driven vehicle definitions with a validated schema | Accepted | 2026-10-01 | V8 |
| [0004](0004-server-authoritative-multiplayer.md) | Server-authoritative multiplayer; clients never assert combat outcomes | Accepted | 2026-10-01 | V9 |
| [0005](0005-deterministic-math-in-core.md) | No `Math.sin`/`Math.cos` in the simulation core; own deterministic math | Accepted | 2026-10-01 | V9 |
| [0006](0006-no-game-framework-ui.md) | No game-framework UI library in the client | Accepted | 2026-10-01 | **V11** — revisit when the garage exists |
| [0007](0007-kinematic-tank-locomotion.md) | Kinematic tank locomotion; Rapier for queries, not for driving | Accepted (settles OD-12) | 2026-10-01 | V2 |
| [0008](0008-simulation-tick-rate.md) | Fixed 60 Hz simulation tick, independent of frame rate | Accepted | 2026-10-01 | **V9** — revisit for the network tick |
| [0009](0009-shared-terrain-geometry.md) | Renderer and physics share one terrain mesh; collision uses a trimesh | Accepted | 2026-10-01 | V6 — revisit for authored maps |
| [0010](0010-analytic-ballistics-without-drag.md) | Shells are point masses under constant gravity, sub-stepped, with no drag | Accepted | 2026-10-01 | V3 — revisit when penetration exists |
| [0011](0011-turret-is-a-servo-on-an-aim-point.md) | Turret servos toward a world aim point; rate limits live in vehicle data | Accepted | 2026-10-01 | V9 — revisit for client prediction |
| [0012](0012-closed-form-armour-and-penetration.md) | Armour as oriented slabs; deterministic three-step penetration model | Accepted | 2026-10-01 | V4 — revisit when dispersion arrives |
| [0013](0013-versions-define-scope-not-effort.md) | **Version requirements define scope, not effort level** | Accepted | 2026-10-01 | Standing — applies to every version |

ADR-0007, ADR-0008 and ADR-0009 were written during **V1 implementation** and record engineering
decisions made on evidence rather than waiting for owner approval, per the delegation of technical
authority. ADR-0001 to ADR-0006 remain proposals carried over from the V0 planning pass; the owner
has since confirmed that ordinary engineering decisions are the implementing agent's to make, so they
stand as accepted.

**ADR-0010 and ADR-0011 were written during V2.** Two findings changed the plan rather than merely
implementing it:

- The turret rate limiter needed a **stopping limit** as well as a distance limit, because a distance
  limit alone produces a visible oscillation as the turret overshoots and hunts back. This was found
  by a test, and is the main reason V2's turret code is shaped the way it is.
- V2 introduced a **second consumer of the analytic terrain height** (shell collision) besides the
  vehicle. That strengthened the case for ADR-0007 rather than changing it, so ADR-0007's status is
  unchanged and its review date stands.

ADR-0010 records the **deliberate absence of aerodynamic drag**. That omission is a decision with a
stated cost — long shots fall slightly short of a real shell — not an oversight, and V3 explicitly
confirmed it should stay omitted for now.

**ADR-0012 was written during V3** and records the armour representation, the three-step penetration
model, and the decision to keep penetration deterministic. Its most important content is a **bug that
testing caught**: the first combat resolver re-cast a ray from the impact point, and so scored shots
against whichever plate lay *behind* the one actually struck. A sloped hull front was being judged
against the turret plate rising above it, producing entirely plausible but wrong penetration numbers.
That is the exact failure mode ADR-0012 exists to prevent, and it is why its tests assert hand-computed
values rather than snapshots of whatever the code happened to produce.

> **Still undecided and therefore not recorded here:** OD-10 (client prediction vs. pure server
> authority). That one depends on whether cross-machine determinism proves achievable, which is a V9
> question with real consequences for how the game feels. It will get its own ADR when the V9
> determinism test answers it.

**ADR-0013 was written during the V3R playability pass** and is the most consequential entry in this
index, because it changes how every future version is *approached* rather than how it is architected.

V1 to V3 each met their acceptance criteria while the game was, to a player, broken: the terrain was
invisible due to an inverted triangle winding, the camera sat level with the hull, the test target was
buried 12.6 m below the player and out of sight, and the vehicles were boxes with no visible gun. Every
automated gate passed throughout, because a winding error produces correct normals and is invisible to
any test that inspects geometry rather than pixels.

The requirement phrases that permitted this — "placeholder art is acceptable", "debug feedback is
acceptable", "implement the minimum coherent system" — were read as *do the least work that passes the
check*. ADR-0013 states the intended reading: **a placeholder must still be a good placeholder, and a
prototype must still communicate the intended game.** Future agents should treat integration,
presentation, usability, feel, and player comprehension as part of completing a feature, and should
expect to verify presentation work by looking at the running game rather than by reading the code that
draws it.

### What each ADR settles

| Open decision | Settled by | Outcome |
| --- | --- | --- |
| OD-02 driving model | Owner decision (not an ADR) | Direct WASD hull control |
| OD-11 single package vs. monorepo | ADR-0002 | Single package, revisit at V9 |
| OD-12 tank locomotion | ADR-0007 | Kinematic model in the core |
| OD-10 client prediction | *open* | Gated on the V9 determinism test |

