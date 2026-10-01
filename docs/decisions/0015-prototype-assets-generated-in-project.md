# ADR-0015: Prototype assets are generated in-project

- **Status:** Accepted
- **Date:** 2026-10-01
- **Deciders:** Owner
- **Related:** ADR-0003 (data-driven vehicles), ADR-0013 (versions define scope)

## Context

V1\u2013V3R used primitive placeholders: boxes and cylinders built from the vehicle definition's own
dimensions, resolved by `visualId`. That satisfied the project's placeholder-first discipline, but by
V3R the vehicles read as *geometry standing in for tanks* rather than as tanks \u2014 a real shortfall the
screenshot pass made obvious.

V4 is the first version to introduce genuine prototype assets, and that raised a question the earlier
versions deferred: where do they come from?

Sourcing a model raises licensing and redistribution questions immediately. A tank model downloaded
from an asset library carries terms that must be checked, recorded, and complied with in every build
that ships it. For a prototype whose entire purpose is to be replaced later, that is a poor trade: the
licence obligations outlive the asset.

## Decision

**Every V4 asset is generated in code, in-project, with no external files.**

The tank model, the arena, and all audio are constructed at runtime from code. Nothing is imported,
downloaded, or licensed. This is recorded in the source files themselves, not only here.

## Consequences

**Good**

- No licence to track, no redistribution risk, no binary assets to version.
- The models are *tuned* rather than commissioned. A silhouette problem is fixed by changing a number
  and re-running, not by a modelling session.
- Assets stay consistent with the simulation: both read the same `VehicleDefinition`, so a change to a
  vehicle's dimensions is visible in the model immediately.

**Bad, and accepted**

- These are **not** production assets. They are prototypes with placeholder topology, flat materials and
  no texture detail, and they must not be described otherwise.
- Hand-authored modelling, texturing, and animation all remain ahead. Replacing this with real art is
  a later version's work, and it will be a real cost rather than a swap.
- Procedural geometry cannot be as good as an artist's work. Some of what V4 establishes is therefore
  the *pipeline* \u2014 two distinguishable variants behind a `visualId` \u2014 rather than the final look.