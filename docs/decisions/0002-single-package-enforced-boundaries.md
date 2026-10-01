# 0002. Single package with enforced module boundaries; no monorepo yet

- **Status:** Accepted (proposed at V0 planning; confirm before V1 scaffolding)
- **Date:** 2026-10-01
- **Affects:** Project layout, build configuration, developer commands.

## Context

The client and server will eventually be separate deployables, which usually argues for a workspace
monorepo. However, the project currently has no code, no server, and no deployment target. Monorepo
tooling adds workspace configuration, cross-package build ordering, and version management before
any of that is needed.

## Decision

Use a **single package** with one `package.json`, one `tsconfig.json`, and strict internal directory
boundaries (`src/core`, `src/shared`, `src/client`, `src/server`, `src/tools`). Revisit a monorepo at
V9, when a server must actually be built and deployed separately.

## Consequences

**Positive**

- One install, one typecheck, one test run, one lint run — the verification story stays simple.
- No workspace or inter-package build configuration to maintain during the versions that matter most.
- The core-to-shell boundary is enforced by lint and conventions rather than by package topology,
  which is sufficient while there is one repository and one team.

**Negative / costs**

- The client bundle must be prevented from importing server-only code, and vice versa. This needs an
  explicit lint rule and careful entry points.
- Server and client may eventually need different build targets and dependency sets, which a single
  package makes slightly less convenient.
- If the project later needs independent release cadence per component, a migration will be required.

**Constraints it imposes**

- Import boundaries are enforced mechanically, not by convention alone.
- Client-only and server-only dependencies must be clearly identified in `package.json`.
- This decision is revisited at V9 and must not be treated as permanent.

## Alternatives considered

| Option | Why not |
| --- | --- |
| npm/pnpm/yarn workspaces monorepo from the start | Real overhead with no current benefit; the deployable split does not exist yet |
| Separate repositories for client, server, and shared code | Version coordination and cross-repo changes are painful for a small project |
| Duplicating shared types between client and server | Guarantees drift |

## Verification

`docs/technical-direction.md` §3 documents the layout. Lint rules enforce the boundaries. This ADR
is explicitly flagged for review at V9.
