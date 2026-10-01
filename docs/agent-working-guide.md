# Agent Working Guide

Combat Tank is developed primarily by coding agents. This guide exists so that work done by
different agents, in different sessions, accumulates into one coherent game instead of a pile of
incompatible changes.

Read this before making changes. It is short on purpose.

---

## 1. Before you change anything

**Read, in this order:**

1. `README.md` — where the project is.
2. `docs/vision.md` — what the game is for, and the principles it will not violate.
3. `docs/version-plan.md` — **the version you are working on**, and its validation criteria.
4. `docs/technical-direction.md` — the boundaries your code must respect.
5. `docs/agent-working-guide.md` — this file.
6. `docs/open-decisions.md` — anything you are about to decide that is not yours to decide.
7. `docs/decisions/README.md` and the ADR index — constraints already recorded.
8. `docs/glossary.md` — the vocabulary to use.

**Then look at the code.** Before writing anything new, find the module that already owns the
concern. Extending a clear existing module is almost always better than adding a new one.

**Check the version's "explicitly deferred" list.** If your task is on it, stop and raise it with
the owner instead of implementing it.

---

## 2. Which documents are authoritative

| Question | Authoritative source |
| --- | --- |
| What are we building, and why? | `docs/vision.md` |
| What systems exist, and how certain are they? | `docs/gameplay-systems.md` |
| What is the next thing to build? | `docs/version-plan.md` |
| Where does code go, and what may it import? | `docs/technical-direction.md` + ADRs |
| How do I work here? | `docs/agent-working-guide.md` (this file) |
| What is *not* decided? | `docs/open-decisions.md` |
| What did we assume, and why? | `docs/assumptions.md` |
| What does this word mean? | `docs/glossary.md` |

**Code never overrides documentation.** If the code and a document disagree, that is a bug in one of
them. Determine which is wrong, fix it, and say so in your report. Do not silently "fix" the code to
match a stale document, and do not silently rewrite the document to match the code.

---

## 3. Recording decisions

**If you make a decision that constrains future work**, write an ADR in `docs/decisions/` using the
template, and add it to the index there. Decisions that qualify:

- Choosing or replacing a technology.
- Establishing a structural rule future code must follow.
- Choosing a gameplay model that affects data format or system boundaries.
- Rejecting an approach a future agent would otherwise retry.
- Setting a convention that would be expensive to change later.

**Do not** write an ADR for adding a feature the version plan already asked for, for tuning a
number, or for recording a future intention.

**If you are tempted to invent a product decision, you are about to do the wrong thing.** Vehicle
classes, shell rosters, progression shapes, battle modes, and monetisation are the owner's calls.
Add or reference an entry in `docs/open-decisions.md` and proceed with a clearly-labelled
provisional choice only if the current version cannot proceed without it — and say so explicitly in
your report.

**If an open decision is resolved**, update `docs/open-decisions.md` (status, date, decision) and
reference the ADR if one was written. Do not delete the entry; the record of what was undecided is
valuable.

---

## 4. Code conventions

These are defaults, not laws. Deviate only when the version's needs genuinely require it, and say
why in your report.

- **TypeScript strict mode**, always. No `any` in exported APIs; no non-null assertions without a
  comment explaining the invariant.
- **Naming:** `camelCase` for values and functions, `PascalCase` for types and classes,
  `UPPER_SNAKE_CASE` for module-level constants. One term per concept — if the glossary says
  *penetration*, do not also write *pierce power* in new code.
- **Units in names or explicit types.** `maxSpeedMps`, `armorThicknessMm`, `reloadSeconds`. Never a
  bare `speed` or `range` whose unit is a guess. Mixing millimetres and metres silently is a
  reliable way to produce a broken game.
- **Functions do one thing** and are small enough to test without elaborate fixtures.
- **No global mutable state** in the core. State belongs to a world/simulation object that is passed
  explicitly. This is what makes headless tests and replays possible.
- **Comments explain *why*, not *what*.** The code says what it does. If a comment restates the code,
  delete it.
- **Use the glossary's terms.** If you need a term the glossary lacks, add it rather than inventing
  a synonym in code.
- **Let the tools format and lint.** Do not hand-format around them.

### Hard boundaries (from ADR-0001, ADR-0002, ADR-0005)

- `src/core/**` must not import Babylon.js, Colyseus, or anything DOM- or Node-specific. This is
  checked by lint, and the check must fail the build.
- `src/core/**` must not use `Math.random()`. Randomness comes from the seeded RNG in
  `src/core/rng`.
- `src/core/**` must not read a wall clock (`Date.now()`, `performance.now()`). The core advances by
  fixed ticks only.
- Gameplay code must not read keyboard, mouse, or network state directly. It receives
  `InputCommand`s.
- Presentation code must not modify simulation state. It reads snapshots and draws them.

If a change seems to require breaking one of these, that is a design problem, not a lint problem.
Raise it rather than working around the rule.

---

## 5. Testing expectations

**Every version must leave the project verifiable.** `npm run verify` (typecheck + lint + test) must
pass before a version is called done.

**Test the core, not the renderer.** The core is pure and testable; the client is not. Put effort in
proportion to that.

- **Pure logic** gets unit tests: armor normalization, penetration resolution, ballistics, movement
  curves, reload, match win conditions, RNG behaviour, definition validation.
- **Integration** gets headless simulation tests: run a full battle with no rendering and assert it
  terminates with a valid, correct result. These catch the bugs unit tests miss.
- **Determinism** gets a test wherever it is claimed: same seed and inputs must produce the same
  outcome. If a change breaks determinism, that is a serious regression, not a flaky test.
- **Boundaries** get a test or a lint rule: a vehicle added as data only; a client that lies being
  corrected by the server; AI not exceeding vehicle limits.

**A new feature without a test is unfinished**, unless it is pure presentation, in which case it
needs at minimum a typecheck and a note in the report of how it was verified manually.

**Prefer testing behaviour to implementation.** Assert that a sloped hit fails to penetrate, not
that a particular internal function was called.

**Do not weaken a test to make it pass.** A failing test is information. Fix the code, or record
that the expectation was wrong and why.

---

## 6. Not prematurely implementing the future

This is the failure mode the project is most exposed to, because the future is genuinely tempting.

**Rules:**

1. Work on **one version at a time**, and only its scope.
2. A version's "explicitly deferred" list is a hard boundary. Do not implement those items "while
   you're in there."
3. Do not build a **generic system** for a future version's needs. Build the smallest thing that
   satisfies the current version's criteria. Concretely: no ECS because V12 might be big; no research
   tree because V11 has one; no matchmaking because V10 will want it.
4. Do not add **dependencies** without a stated problem they solve. "It is commonly used" is not a
   problem.
5. If a current version genuinely cannot be completed without a future-version decision, **stop and
   ask**, rather than quietly designing that future system.
6. If you notice a future-version problem while working, **write it down** in your report or in
   `docs/open-decisions.md` and move on. Do not fix it now.

**The test for overreach:** does the project still contain exactly one version's worth of work, and
can the owner still understand what exists? If a subsystem has no version that asked for it, you
have probably built it too early.

---

## 7. Reporting completed work

Every agent ends its work with a report. Keep it factual and short. Include:

1. **What changed** — files added or modified, grouped by purpose.
2. **Which version's criteria are now met**, and which are not. Be explicit about anything left
   unfinished; do not claim a version is complete when it is not.
3. **How it was verified** — the exact commands run (`npm run verify`, headless runs, determinism
   tests) and their results, plus what you checked manually in the running game.
4. **Decisions taken** — anything a future agent must respect. State whether an ADR was written, and
   which one, or explain why no ADR was needed.
5. **Assumptions made** — anything chosen that the owner has not confirmed. Add durable ones to
   `docs/assumptions.md`.
6. **Problems found but not fixed** — including problems outside the current version's scope. These
   are valuable; do not hide them or quietly fix them out of scope.
7. **Open questions** — anything in `docs/open-decisions.md` that blocks or shapes your work.

**Never report work as done when it is not.** A precise report of a partial result is far more
useful than a confident overstatement, because the next agent — and the owner — will build on it.

---

## 8. Quick checklist

Before finishing any change:

- [ ] Work stayed inside the current version's scope.
- [ ] Nothing on the version's "explicitly deferred" list was implemented.
- [ ] `src/core` imports no rendering, network, or platform code, and uses no `Math.random()`.
- [ ] New core logic has unit tests; new systems have a headless test where practical.
- [ ] `npm run verify` passes.
- [ ] The game still starts and previous behaviour still works.
- [ ] New terms were added to the glossary; new constraints to an ADR.
- [ ] Assumptions were recorded in `docs/assumptions.md`.
- [ ] Anything undecided was added to `docs/open-decisions.md` rather than silently decided.
- [ ] The report says what was verified, how, and what was not finished.
