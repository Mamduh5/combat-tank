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

## Addendum: being armour-aware is necessary and not sufficient

The three capabilities above were necessary. They were also, on their own, **not sufficient to make the
opponent competent**, and the reasons are worth recording separately because every one of them looked
like a tuning problem and none of them was.

Each was found by measuring the running simulation rather than by reading the code, and each is now
pinned by a test.

1. **The fire gate has to measure distance, not angle.** Gating firing on a *bearing* error means the
   permitted miss grows with range, so the same tolerance that is generous at 40 m is a guaranteed miss
   at 70 m. Measured against a parked player, a 4-degree gate allowed 4.3 m of lateral error at 48 m and
   5.6 m at 71 m, on a vehicle 3.3 m wide. The gunner was being told it was on target while pointing a
   full vehicle-width past the target. The gate is now a perpendicular miss distance, which is both the
   physically honest measure and the only one whose meaning does not change with range.

2. **A tank must stop moving before it can lay its gun.** The opponent was driving while it slewed, so
   station-keeping kept moving the aim point faster than a 24 deg/s turret could follow it. Measured
   best-achievable aim against a parked player: a **median 3.2 m off target, wider than the tank**.
   No tolerance value could have fixed that, because the target was running away by its own hand.
   Movement is now suspended until the gun is laid, which is also what a real crew does.

3. **Aiming must not be gated on being able to shoot.** Refusing to aim outside the firing band meant
   that inside that band the turret held a stale angle while the tank drove at 5.6 m/s, and the
   measured miss grew monotonically to **45 m over twelve seconds** while the opponent left the arena.
   A crew keeps the gun trained on the enemy while it manoeuvres, and the same is true here.

4. **Rules about the same distance must agree.** The planner's near band (32 m) and the gun's minimum
   range (24 m) were separate numbers that disagreed, leaving a range in which the opponent could shoot
   and had decided not to. Worse, the range check ran *above* the flank logic, so it cancelled an
   in-progress flank on the very next tick: the opponent flapped between `flank` and `adjust-range` for
   the rest of the fight with its flank destination a steady 78 m away, never moving toward it. A flank
   is now allowed to finish, and the bands are asserted against each other.

5. **Retreat by reversing, not by turning around.** Backing away with `steerToward` means turning the
   hull through 180 degrees and driving off with the tank's back to the enemy, spending the whole hull
   traverse rate and leaving the gun pointing at nothing. Measured: the opponent stood still for 120
   ticks while its hull swung round, then lost the engagement entirely. A tank that is too close backs
   up, keeping both the range and the facing.

6. **A restart has to rewind the random stream to where it was, not to the seed.** The constructor
   consumes one draw to pick a flank side. Reseeding without replaying that draw left the stream one
   ahead, so a "replayed" battle drew its first aim scatter from a different offset. Two runs matched on
   positions, hit points and shot counts for 228 ticks and then diverged in the gun's elevation alone -
   which is why the determinism test passed on positions and still failed. The controller now snapshots
   its post-construction generator state and restores it, and a test compares the barrel's orientation
   tick by tick rather than trusting a single final position.

The general lesson is the one the version plan already states: **passing the validation criteria is the
minimum.** Every one of the six defects above passed a code review, and most of them passed the
automated gates too. They were found by instrumenting the running fight and writing down what the
numbers were.
