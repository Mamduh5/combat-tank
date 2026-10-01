# ADR-0014: The opponent is a player, not a damage source

- **Status:** Accepted
- **Date:** 2026-10-01
- **Deciders:** Owner
- **Related:** ADR-0001 (headless core), ADR-0003 (data-driven vehicles), ADR-0005 (determinism), ADR-0013 (versions define scope)

## Context

V3R ended with a stationary target: a tank the player could shoot to verify armour, penetration and
damage by hand. It was deliberately inert, and the plan said V4 was where a fighting enemy arrives.

The obvious way to build a fighting enemy is to let the opponent's code call something like
`player.takeDamage()` on a schedule. That is cheap, and it is wrong. It produces an opponent that
cannot be evaded, cannot be outmanoeuvred, and cannot be beaten by aiming, because aiming would have
no relationship to whether the player was hit. The combat systems V2 and V3 exist to demonstrate would
sit unused on one side of the fight.

The alternative risk is building a general AI framework: a behaviour tree, a planner, a navigation mesh,
a utility scorer. That is a large piece of engineering aimed at a version that has not specified what it
needs, and it would be hard to delete later.

## Decision

**The opponent is a full vehicle driven through the same input interface as the player.**

`EnemyController` produces an `InputCommand` - the same struct `InputManager` builds from the keyboard -
and `Simulation.tick` steps the enemy `Tank` with it through the same `Tank.step` call the player's
vehicle uses. There is no path from the controller to the damage model. Its turret servos at the
vehicle's own rate, its gun obeys its own reload timer in the core, its shells are integrated by the
same ballistics, and its hits are resolved by the same penetration and damage model as the player's.

The controller is a single state machine with four behaviours - search, close, engage, reposition - and
no planner, no memory beyond "where did I last see the player", and no pathfinding.

## Consequences

**Good**

- Symmetry is structural rather than aspirational. There is no damage shortcut to remove later, because
  none was added.
- Every existing system is exercised on both sides, which is what makes them real.
- The opponent is bounded: deleting `src/core/ai/` and passing neutral input returns the game to a
  firing range.
- A seeded RNG makes an encounter reproducible, so "the AI is unbeatable sometimes" becomes a bug
  report with a number attached.

**Bad, and accepted**

- The opponent cannot flank intelligently, choose cover, or plan. It holds a preferred bearing and
  drives. Sophisticated AI remains open work (OD-08).
- The controller is a third consumer of `InputCommand`, and the interface must now stay stable for a
  future server-side opponent as well as the local one.
- Because the enemy's gun tracks the player through its turret, a player who never moves and keeps
  presenting frontal armour is very hard to hit. That is the armour model behaving correctly, but it
  makes a passive player nearly safe, and whether that is acceptable is an open balance question
  (OD-11) rather than something this ADR settles.