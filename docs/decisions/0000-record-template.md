# NNNN. Decision Title

- **Status:** Proposed | Accepted | Superseded by NNNN | Rejected
- **Date:** YYYY-MM-DD
- **Affects:** which versions or which parts of the codebase
- **Supersedes:** NNNN (if applicable)

## Context

What forced a decision to be made? What was true about the project, the platform, or the
constraints at the time? Two or three sentences, concrete and specific.

## Decision

State the decision in the active voice: "The simulation core runs at a fixed 60 Hz tick and
contains no rendering code." Be precise enough that a future agent can tell whether a piece of
code violates it.

## Consequences

**Positive**

- What this makes possible.

**Negative / costs**

- What this makes harder, slower, or more expensive. A decision with no costs is usually a
  decision that was not examined.

**Constraints it imposes**

- The rules future code must follow, stated as checkable statements.

## Alternatives considered

| Option | Why not |
| --- | --- |

## Verification

How can a future agent confirm this decision is still being honoured? Name the test, the lint
rule, the directory, or the file to look at. If there is no way to check it, say so honestly.
