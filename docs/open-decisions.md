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
| OD-04 | Ammunition roster | shaping (V3/V4) | open |
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

**Impact on the codebase:** `InputCommand` carries only `throttle` and `turn`; the camera rig is
fully independent of hull heading; `tests/core/locomotion.test.ts` asserts that a vehicle with no
turn input does not change heading at all, even while moving.

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

**Interim position:** one generic shell type for V2/V3, with the data model already carrying
per-shell penetration, velocity, and damage parameters so types can be added as data.

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

### OD-08 — Battle modes
**Urgency:** shaping (needed in V7) · **Status:** open

Which battle modes ship, and in what order? Elimination, base capture, and a limited-spawn variant
are candidates.

**Why it matters:** modes drive map design, win conditions, and AI objectives.

**Interim position:** a single elimination mode through V6, a second mode in V7.

---

### OD-09 — AI sophistication ceiling
**Urgency:** deferred · **Status:** open

How far does AI go? Rule-based behaviours, designer-authored behaviour trees, or adaptive difficulty
that reads player skill?

**Why it matters:** adaptive difficulty changes the game's relationship with the player, and is a
design position, not just a technical one.

**Interim position:** rule-based AI through V7, with a difficulty setting that changes tuning
parameters but not rules.

---

### OD-10 — Client prediction vs. pure server authority
**Urgency:** blocking for V9 · **Status:** open (technical)

Should the client predict the local vehicle's movement and reconcile with the server, or should the
client render server state only?

**Why it matters:** prediction is what makes an authoritative server feel responsive; it also
requires cross-machine determinism, which is a design goal but not yet a proven fact.

**Interim position:** build for prediction, gate it behind a determinism test, and fall back to pure
server authority if the test cannot be made to pass. See `docs/technical-direction.md` §4.2.

---

### OD-11 — Single package vs. monorepo
**Urgency:** was blocking for V1 scaffolding · **Status:** RESOLVED, 2026-10-01 (ADR-0002)

One package with enforced internal boundaries, or a workspace monorepo with `packages/core`,
`packages/client`, and `packages/server`?

**Decision: single package**, with the core/client boundary enforced mechanically by ESLint and by an
architecture test rather than by package topology. Revisit at V9, when a server must be built and
deployed separately.

**Impact:** `src/core`, `src/shared`, `src/client` in one `package.json`; `npm run verify` runs
typecheck, lint and tests as a single gate.

---

### OD-12 — Tank locomotion model
**Urgency:** was blocking for V1 · **Status:** RESOLVED, 2026-10-01 (ADR-0007)

An explicit kinematic movement model in the core (recommended), or a Rapier dynamic rigid body /
vehicle controller?

**Decision: kinematic model in the core.** Rapier is used for collision *queries* — the terrain
mesh, camera obstruction, and the line-of-sight test V6 needs — but never to decide how a tank
drives. Grounding uses the analytic terrain function rather than a ray cast against the collision
mesh, because a mesh query quantises height to the grid and produces visible jitter.

**Impact:** `src/core/vehicle/locomotion.ts` holds the movement model with no physics dependency;
every handling value comes from the vehicle definition.

---

### OD-13 — Target frame rate and hardware target
**Urgency:** shaping (needed for V12) · **Status:** open

What frame rate and hardware should the game hold, and what is the supported battle size?

**Why it matters:** it is a performance requirement, and an agent should not invent it.

**Interim position:** assume a 60 fps target on a mid-range PC with a small battle size, and treat
this as provisional until the owner confirms.

---

### OD-14 — Platform, distribution, and monetisation
**Urgency:** deferred · **Status:** open

Is Combat Tank a free-to-play game, a premium purchase, or a game with any monetisation at all? Is
it distributed via Steam, a website, or elsewhere? PC only, or console later?

**Why it matters:** it constrains accounts, progression, the economy, and the technology choices
(OD-11 in particular).

**Interim position:** PC only, no monetisation of any kind, no platform-specific work.
`docs/vision.md` §6 records this as a deliberate non-goal for now.

---

## Questions deliberately *not* asked yet

These are open-ended areas where premature questions are themselves a mistake. They are listed so no
agent assumes an omission was an oversight.

- Crew, crew skills, and wounded crew.
- Cosmetics, skins, and achievements.
- Modding and user-generated content.
- Nations/factions and faction-specific technology.
- Sound-based detection as a spotting mechanic.
- Any form of ranked play, seasons, or skill matchmaking.
- Specific historical vehicle likenesses or real-world names.
