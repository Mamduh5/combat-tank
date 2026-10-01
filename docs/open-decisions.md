## OD-08: The opponent had no real AI framework (V4 position)

- **Status:** Closed in V5
- **Raised:** V4

### What V4 recorded

V4's opponent was a single state machine with four behaviours, driven through the shared `InputCommand`
interface (ADR-0014). It could not plan, path, score cover, flank intelligently, or remember anything
about the fight beyond the player's last known position. That was a deliberate scope boundary: a general
AI framework built then would have been aimed at a version that had not specified what it needed.

The specific capability V4 measured as missing was **choosing an angle deliberately**. It held one
preferred bearing and circled; it did not decide that the player's rear was exposed and go there.

### What V5 changed

Option 3 was taken - the same option the owner chose for OD-11 - and the framework concern turned out to
be the wrong worry. What V5 needed was not a general framework but three narrow capabilities, each in a
module small enough to be obviously correct:

- `shot-evaluation.ts` predicts a shot using the real penetration model, before firing.
- `engagement-plan.ts` remembers whether shooting has been working and picks an intent.
- `navigation.ts` chooses a reachable position and drives there without getting stuck.

There is still no AI framework, no behaviour tree and no utility scorer, and the controller remains a
single `InputCommand` producer with no path to the damage model. What changed is that it now has a reason
to choose an angle and evidence to choose it on.

The remaining gap is genuine and recorded as **OD-13** below.

---

## OD-11: A stationary player presenting frontal armour could not be hurt

- **Status:** **Resolved in V5 by decision, not by balance change**
- **Raised:** V4
- **Decision:** ADR-0016

The owner resolved this explicitly:

> Do not weaken frontal armour merely so an enemy firing from the front can reliably deal damage.
> The solution is for an intelligent opponent to recognise ineffective attacks and seek a better tactical
> solution.

**No armour value changed.** The player's frontal plate still stops 150 mm of penetration cleanly, and a
test asserts it. What changed is that the opponent now predicts whether a shot will work before taking
it, is told whether its own shells got through, and flanks after repeated failure.

V5 asserts the *inverse* of V4's test: a player who parks is now defeated by an undamaged mobile
opponent, and the opponent fires substantially fewer shells than a V4 opponent did - because it is no
longer paying a five-second reload for shots it knows will bounce.

This establishes the gameplay **principle**: frontal armour is a real advantage that is not a permanent
one. The numbers remain temporary and may be balanced later.

---

## OD-12: Immobilised vehicles have no rolling resistance

- **Status:** Open - deferred, handling rather than AI
- **Raised:** V5

Found by measurement while writing V5's AI tests, and it is a pre-existing gap in the locomotion model
rather than anything the opponent does.

A vehicle whose engine or tracks are destroyed has **no rolling resistance at all**. Measured: a
destroyed tank crossing flat ground held 3.46 m/s and lost 0.01 m/s of it over two seconds. It does not
coast to a stop; it rolls, indefinitely, at whatever speed it happened to be doing when it broke.

This matters beyond realism. A wreck that keeps rolling looks powered, so two V4 tests asserted
`speedMps < 2` as a proxy for "is it still under power" - and those assertions were passing for the wrong
reason, because the wreck only slowed when it happened to die on a slope. The V5 tests now assert the
opponent's *intent* and commanded movement instead, which is the property actually meant.

Left open because it is a handling change with consequences for every vehicle, not just the opponent, and
it deserves to be made deliberately rather than as a side effect of AI work.

---

## OD-13: The opponent loses a circling player

- **Status:** **Closed in V5**
- **Raised:** V5

Found by scripted testing, and the clearest remaining weakness in the AI.

Against a player circling steadily, the opponent acquired a target, fired occasionally, and then let the
range grow monotonically - measured 45 m, then 94 m, then 141 m, then 165 m - until it lost line of
sight entirely and spent the remainder of the fight in `search`, driving to an arena centre the player
is no longer at.

The cause was that `search` treated the last known position as a place to visit rather than a heading to
pursue, and `adjust-range` could not catch a target that is not approaching. It was a gap in *pursuit*,
not in the tactical layer V5 was built around, which is why it survived a version whose stated goal was
that fighting the opponent should feel meaningfully different from fighting V4's.

**What closed it.** `EnemyController.pursuitPoint` extrapolates the player's last known motion instead
of revisiting the stale position, so the destination runs away at the player's own speed and the
opponent spends the approach closing rather than arriving. Measured over a full minute against a
circling player, the range now peaks at 116 m and returns to 18 m, with penetrations on every seed
tested, against a previous 160 m and permanent `search`.

The extrapolation is deliberately crude - constant velocity over a four-second horizon, no proper
intercept. A real solution needs map data that does not exist until V6, so this is a provisional shape
rather than a finished one; it is tracked there rather than reopened here.

---

## OD-14: V5's stated scope was not delivered in full

- **Status:** **Closed in V5F by owner decision** - scope confirmed as met
- **Raised:** V5

`docs/version-plan.md` originally scoped V5 as several AI tanks, a difficulty selector, and a headless
batch runner. The owner has since confirmed the scope, which removes the ambiguity this entry existed to
resolve.

- **One opponent is the V5 requirement.** Multiple simultaneous opponents were **optional architectural
  validation, not a completion blocker**, and are deferred to the version where battlefield and team scale
  actually require them. The 1v2 case was never a V5 deliverable.
- **No difficulty selector.** Deferred, not incomplete. Difficulty levels are a player-facing product
  decision that has not been designed, and inventing Easy/Normal/Hard parameters merely to satisfy an old
  planning line would be worse than leaving it open.
- **The headless batch runner shipped in V5F.** `npm run sim`, implemented in `src/tools/headless/`, was
  the one genuinely owed item and it is now complete. See `docs/harness.md`.

V5's gameplay objective is accepted as complete. Nothing in this entry is outstanding work.

---

## OD-15: The opponent shoots far less at a player who is running away

- **Status:** Open - known trade-off, not a defect
- **Raised:** V5F
- **Found by:** `npm run sim -- --scenario retreating` (see `docs/harness.md`)

The V5 opponent stops moving while its gun is coming around, so that the aim point stops moving and a
finite turret traverse rate can actually reach it. Against a parked player that is exactly right, and it
is what made the frontal-armour case work at all. Against a player who is *fleeing* it is the wrong call,
because a moving shooter has a trackable aim point and a stationary one does not.

Measured over eight battles per scenario, seeds 1-8, changing nothing but this rule:

| scenario       | settle the gun | move while slewing |
| -------------- | -------------- | ------------------ |
| parked player  | ~6 pen/battle  | ~1 pen/battle      |
| fleeing player | ~2.5 pen/battle | ~5.8 pen/battle   |

The fleeing case is not a failure of will. The gun *does* converge - measured minimum miss distance
0.11 m, comfortably inside the 1.2 m fire gate - but only for about **one tick in six thousand**, because
a target withdrawing at close to the opponent's own top speed sweeps the bearing faster than 24 deg/s can
follow. The batch harness reports these seeds as "saw the player and did not fire", which is the honest
description.

**Why this is recorded rather than fixed.** The rule is a deliberate trade-off, not an oversight, and the
parked case is the one the owner decided the version around (ADR-0016) and the one a human player actually
produces. Removing the rule to favour fleeing targets would undo the fix for the defect that shipped in
V5. Doing both needs the opponent to determine *which* situation it is in before choosing whether to
hold - a real piece of AI design, with its own failure modes, that should be measured rather than
rushed into a version whose gameplay objective is already signed off.

**Where it should be picked up.** It is an AI-behaviour question, not a map question, so it does not
belong to V6's terrain and spotting work. It belongs to the next pass that revisits the opponent.


# Open Decisions

**Status:** Authoritative for what is *not* decided.

These are product and design questions that Combat Tank deliberately has not answered yet. They are
recorded here so that no agent has to invent an answer, and so the owner can see exactly what needs
a decision.

**Rules for agents:**

- Do not silently answer any of these. If a version cannot proceed without an answer, ask.
- If you make a **temporary** choice to unblock work, label it clearly as provisional, keep it
  minimal, and note it in your report and in `docs/assumptions.md`.
- When the owner answers, update the **Status** and **Decision** fields here. Do not delete the entry
  — the record of what was open is itself useful.

### Escalation: what needs the owner, and what does not

The owner has delegated ordinary engineering decisions to the implementing agent. Escalate **only**
when a choice materially affects player-facing gameplay, game rules, controls or feel, product scope,
progression, monetisation, platform or distribution, visual direction, or major content direction.

Do **not** escalate: monorepo versus single package, internal boundaries, physics strategy,
determinism technique, lint or tooling configuration, test framework, build tooling, or anything
already covered by an ADR. Decide these on evidence, simplicity and maintainability, and record the
result in `docs/decisions/`.

---

## How urgent is each decision?

| Urgency | Meaning |
| --- | --- |
| **Blocking** | A version cannot start or finish without this. |
| **Shaping** | Work can proceed, but will need rework or a second pass. |
| **Deferred** | Nothing needs it yet. It is recorded so it is not forgotten. |

## Summary

| ID | Question | Urgency | Status |
| --- | --- | --- | --- |
| OD-01 | Vehicle class system | shaping (V8) | open |
| OD-02 | Driving control model | — | **resolved** — direct WASD |
| OD-03 | Progression structure | shaping (V11) | open |
| OD-04 | Ammunition roster | shaping (V3/V4) | open — **deliberately not decided in V2** |
| OD-05 | Dispersion model | shaping (V3) | open |
| OD-06 | Repair and module recovery | deferred | open |
| OD-07 | Module damage depth | shaping (V3) | open |
| OD-08 | Battle modes | shaping (V7) | open |
| OD-09 | AI sophistication ceiling | deferred | open |
| OD-10 | Client prediction vs. server authority | blocking (V9) | open — gated on the determinism test |
| OD-11 | Single package vs. monorepo | — | **resolved** — single package (ADR-0002) |
| OD-12 | Tank locomotion model | — | **resolved** — kinematic (ADR-0007) |
| OD-13 | Target frame rate and hardware | shaping (V12) | open |
| OD-14 | Platform, distribution, monetisation | deferred | open |

---

## Product and design decisions

### OD-01 — Vehicle class system
**Urgency:** shaping (needed in V8) · **Status:** open

Should Combat Tank have formal vehicle classes (light / medium / heavy / tank destroyer), and if
so, what are they and what are they *for*?

**Why it matters:** classes determine the shape of the vehicle data model, the progression structure
(OD-03), and how the roster is balanced. Getting this wrong means reworking V8 and V11.

**Options:** formal named classes with distinct roles; a continuous stat space with no classes;
classes for gameplay but not for progression.

**Interim position:** V8 introduces three *distinct vehicles* (fast, generalist, slow) to prove the
data model, explicitly without committing to a class taxonomy.

---

### OD-02 — Driving control model
**Urgency:** was blocking for V1 · **Status:** RESOLVED by owner, 2026-10-01

Does the player drive the hull directly (WASD = throttle and hull traverse), or with an
"accelerate toward where I'm looking" assist?

**Decision: direct WASD hull control.**
- W = drive forward
- S = reverse
- A/D = rotate the hull
- Mouse = camera and aiming direction
- Turret orientation is independent of hull orientation
- The hull is **never** automatically driven or rotated toward the camera or aim direction
- No driving assists unless explicitly introduced later

**Impact on the codebase:** `InputCommand` carries `throttle`, `turn`, `aimPoint` and `fire`; the camera
rig is fully independent of hull heading; `tests/core/locomotion.test.ts` asserts that a vehicle with no
turn input does not change heading at all, even while moving.

**V2 update:** `InputCommand` gained `aimPoint` and `fire` (ADR-0011). The mouse still never turns the
hull: it produces a world aim point, and the *turret* servos toward it. `tests/core/turret.test.ts`
asserts that rotating the hull carries the turret's world heading without changing its local angle, and
that the hull does not chase the aim point.

---

### OD-03 — Progression structure
**Urgency:** shaping (needed in V11) · **Status:** open

What is the shape of progression: a research tree, a module/upgrade tree, a flat unlock list, or
something else? And what does progression *do* — unlock vehicles, improve the ones you have, or
both?

**Why it matters:** it determines the persistence model, the garage UI, and the economy. Building
it before the combat model is stable is wasted work.

**Interim position:** V8 introduces only a *modifier hook* (a multiplier or unlocked module slot on
a vehicle definition). No economy is built until this is answered.

---

### OD-04 — Ammunition roster
**Urgency:** shaping (needed in V3/V4) · **Status:** open

Which shell types exist, and what does each do?

**Why it matters:** penetration values, ballistics, and the armour model all interact with the shell
roster. The owner's brief named armor-piercing, high-velocity, and explosive as *examples*, not a
commitment.

**Interim position (updated after V2):** one generic **test shell** ships in V2, and the owner explicitly
instructed that this decision must **not** be forced during V2. The roster should be decided once
penetration and armour behaviour exist and can be judged meaningfully.

The interim shape shipped is narrower than originally planned: `TestShellDefinition` carries
`muzzleVelocityMps`, `massKg`, `maxRangeM`, `maxLifetimeSeconds` and `maxSubstepM`. It deliberately does
**not** carry penetration or damage, because V2 has no armour model to balance them against — a
penetration number written now would be an invented constant that later gets "tuned" around.

A test asserts the shell's id and display name stay generic, so a placeholder cannot quietly harden into
a commitment. When this decision is taken, expect the data model to gain penetration, explosive payload
and post-penetration effect fields, and `maxRangeM`/`maxSubstepM` to move from "engineering defaults" to
tuned values.

---

### OD-05 — Dispersion model
**Urgency:** shaping (needed in V3) · **Status:** open

Is shot dispersion random per shot, deterministic per target, or a hybrid? Does it grow with
distance, with vehicle movement, or both?

**Why it matters:** randomness affects fairness, reproducibility, and how the game *feels*. It also
interacts with determinism (OD-10) and with the seeded RNG.

**Interim position:** seeded random dispersion from the core RNG, growing with distance and vehicle
movement, with an accuracy value in the vehicle definition.

---

### OD-06 — Repair and module recovery
**Urgency:** deferred · **Status:** open

How is a damaged module recovered — a player-triggered repair consuming an in-battle item, a field
repair action with a delay, or not at all?

**Why it matters:** it affects the damage model's shape and the battle economy.

**Interim position:** no repair in the first pass. Damage is permanent for the duration of a battle.

---

### OD-07 — Module damage depth
**Urgency:** shaping (needed in V3) · **Status:** open

Which modules are damageable, how is their health partitioned, and what are the failure modes?
Track and engine are proposed first; gun, turret traverse, and ammunition are candidates.

**Why it matters:** it determines the data model for the vehicle definition and the feedback UI.

**Interim position:** track and engine only in V3, with the module system designed so more can be
added as data.

---

#
