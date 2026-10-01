# ADR-0016: Solve ineffective armour with tactics, not thinner armour

**Status:** Accepted
**Version:** V5
**Supersedes:** the open question recorded as OD-11 in V4

## Context

V4 shipped a playable duel, and measurement produced one unacceptable result: **a player who parked
and presented their frontal armour could not be hurt.**

The player's frontal plate is 200 mm pitched at 60 degrees. Against the opponent's 150 mm of nominal
penetration that presents roughly 400 mm of effective armour, which the shell cannot beat at any angle.
A stationary player took **zero** damage however many shells the opponent fired, and V4 recorded this in
a test as a deliberate property rather than a defect, because deciding it was a product question.

The owner's resolution:

> Do not weaken frontal armour merely so an enemy firing from the front can reliably deal damage.
> A tank that presents a very strong frontal plate correctly should be difficult or potentially
> impossible to penetrate. The solution is not to make every armour surface vulnerable. The solution is
> for an intelligent opponent to recognise ineffective attacks and seek a better tactical solution.

## Decision

**No armour value changed in V5.** The frontal plate still stops 150 mm of penetration cleanly, and a
test asserts it still does.

The problem is solved entirely above the armour model, by three capabilities that did not exist in V4:

1. **The opponent predicts whether a shot will work, before firing it.**
   `src/core/ai/shot-evaluation.ts` calls the *real* `resolvePenetration` with the real shell and the
   real `PenetrationModel`, against every plate it can currently see, using each plate's actual world
   normal. It deliberately does not reimplement the armour maths: a second implementation is the most
   likely place for the AI and the simulation to disagree about what armour does, and the estimate is
   therefore correct by construction.

2. **The opponent remembers whether its shooting is working.**
   `Simulation` reports the results of shells the opponent fired back to its controller, via a channel
   that carries exactly one bit — *did this penetrate*. Not how much damage, not the player's remaining
   hit points, not the player's modules. The opponent cannot cheat, and it also cannot do the V4 thing
   of firing five shells into an invulnerable plate and never noticing.

3. **The opponent changes what it is doing when the answer is no.**
   `src/core/ai/engagement-plan.ts` keeps a short memory of recent shots. A penetration resets it. Three
   consecutive bounces or blocks mean the *geometry* is wrong, not the gun, so the opponent picks a side
   and commits to a flank: it drives to a position that presents the player's flank or rear, using
   `src/core/ai/navigation.ts` to pick a reachable standing place and to get there without getting stuck.

The principle recorded here is therefore a **gameplay principle, not a balance decision**: presenting
strong frontal armour is a real advantage, and it is not a permanent one against a mobile opponent that
is trying to win. The armour numbers remain explicitly temporary and may be balanced later.

## Consequences

**Good**

- Presenting frontal armour remains the correct answer to a head-on engagement. The player who does it is
  buying time, not winning.
- A stationary player who never moves is now defeated by an undamaged, mobile opponent.
- The armour model gained no special cases and lost no credibility. Nothing about it was bent to make the
  AI look competent.

**Bad, and genuinely instructive**

- The opponent must now be given the ability to *stop firing*. That in turn creates a deadlock that was
  not obvious in advance: an opponent that never fires at armour it has correctly identified as
  unpenetrable never observes a failure, so it never triggers a flank. The first V5 build reasoned its
  way into standing in front of an invulnerable tank forever — strictly worse than the V4 behaviour it
  replaced, because it had *decided* the shot was impossible and so never tested it. The resolution is
  the bounded `probe` intent: a prediction is an estimate, and estimates are confirmed by firing.
- Making the opponent armour-aware is **not** sufficient on its own. Three separate movement defects were
  found only by driving it, each of which quietly neutralised the tactics: an aim point re-rolled every
  tick so the turret could never converge, a station-keeping point defined relative to the hull's own
  heading so backing off spun the tank 180 degrees, and an engagement band the opponent walked out of
  while managing range. Every one of them passed a code review.

**Neutral**

- The AI's aim scatter is unchanged, so the opponent remains a fallible gunner. Making it superhuman
  would have hidden whether the positioning logic actually worked.