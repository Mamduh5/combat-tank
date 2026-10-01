# ADR-0013: Version requirements define scope, not effort

- **Status:** Accepted
- **Date:** 2026-10-01
- **Supersedes:** none
- **Related:** `docs/vision.md` (P8), ADR-0001, ADR-0006

## Context

V1 through V3 were each delivered as a working system that satisfied their written acceptance
criteria. Every automated gate passed at each step: typecheck clean, lint clean, a growing test suite,
production build succeeding.

Playing the result told a different story. The game looked and felt like a rendering and physics test
harness. Concretely, at the end of V3:

- The terrain was **entirely invisible**. Every ground triangle was wound so the renderer classified
  it as a back face and culled it. The player saw the tank apparently floating in a void, with the
  landscape reduced to slivers along the horizon. The terrain's *normals* were correct, so no test
  that checked geometry could have found this — only looking at the running game could.
- The camera sat almost level with the hull, so the player's own vehicle occluded the ground they
  were aiming at.
- The test target was placed 60 m ahead at the player's own height, which on the procedural terrain
  put it 12.6 m below the player on a valley floor, hidden behind the lip of the hill. The player had
  no indication a target existed at all.
- The vehicles were boxes on darker boxes. They read as *something*, but not unmistakably as tanks:
  no visible gun, no road wheels, no way to tell front from back.
- The environment was a single flat green expanse with no horizon, no depth cues, and no landmarks.

None of these were bugs against a stated requirement. Each was the **minimum implementation that
technically satisfied** its version's criteria.

The underlying cause was ambiguity in how the requirements had been written. Phrases like *"placeholder
art is acceptable"*, *"primitive geometry is acceptable"*, *"debug feedback is acceptable"*, and
*"implement the minimum coherent system"* were intended to mean *defer final production assets*. They
were read and acted on as *do the least work necessary for the checkbox to pass*.

Both readings are consistent with the same sentence. Only one of them produces a playable game.

## Decision

**Version requirements define the feature boundary, not the desired effort level.**

Within the scope of a version, optimise for the quality of the player's experience, not for the
smallest implementation that technically satisfies the requirements.

Concretely, this means:

- Scope boundaries still hold. Do not add systems belonging to a later version, however tempting.
- Effort within that scope is *not* minimised. A version is finished when the current version is as
  coherent, readable, intentional, and enjoyable as reasonably possible with the systems and assets
  available at that stage.
- A placeholder must be a **good placeholder**. It does not need to be a final asset, but it must
  communicate what the final asset is going to be.
- Integration, presentation, usability, feel, and player comprehension are part of completing a
  feature, not polish to be added afterwards.
- Scope phrases mean what they say. *"Placeholder art is acceptable"* means do not spend effort on
  production assets yet — **not** do the least work that passes the check.

### What this does not mean

- It is not permission to expand scope. V3R added no AI, no battle flow, no new systems.
- It is not a requirement to reach final production quality now. The tanks are still primitives.
- It does not replace the automated gates. Typecheck, lint, and tests remain mandatory. They are
  necessary and, as the terrain winding shows, **not sufficient**.

## Consequences

**Automated verification is necessary but not sufficient.** Every gate passed while the game was
visibly broken. Presentation work must be verified by looking at the running result. The project now
carries a screenshot harness (`tools/`) for exactly this purpose, and visual defects get regression
tests where the property is testable.

**"Acceptable" needs an owner.** Requirements should state *what must be true of the player's
experience*, not only what may be deferred. Where a requirement says "placeholder", it should also say
what the placeholder must achieve.

**Effort estimates need revisiting.** A version scoped as "minimum coherent system" is not a
predictable unit of work. Adding presentation and integration effort is real work and should be
planned as such rather than absorbed silently at the end.

**Review must include playing.** A change is not done because it passes CI. It is done when the
game presents itself correctly to someone who has not read the source.

## Notes

`tools/shot.mjs` was added during V3R specifically so presentation could be iterated on with evidence
rather than guesswork. See `tools/README.md`. Its existence is a direct consequence of this decision:
the terrain winding defect was found by rendering the game, not by testing it.
