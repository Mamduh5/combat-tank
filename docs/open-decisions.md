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
- Technical questions (OD-10 to OD-12) are listed here for convenience but are settled by technical
  investigation, and are owned by `docs/technical-direction.md`.

---

## How urgent is each decision?

| Urgency | Meaning |
| --- | --- |
| **Blocking** | A version cannot start or finish without this. |
| **Shaping** | Work can proceed, but will need rework or a second pass. |
| **Deferred** | Nothing needs it yet. It is recorded so it is not forgotten. |

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
**Urgency:** blocking for V1 · **Status:** open

Does the player drive the hull directly (WASD = throttle and hull traverse), or with an
"accelerate toward where I'm looking" assist?

**Why it matters:** this is the single most important control decision in the game. It determines
how the camera, the input layer, and the AI interface relate. It is also a feel decision that is
expensive to change once players have learned it.

**Interim position:** direct control (WASD), matching the owner's stated expectation, with the
assist deferred until it is felt to be needed.

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
**Urgency:** blocking for V1 scaffolding · **Status:** open (technical)

One package with enforced internal boundaries, or a workspace monorepo with `packages/core`,
`packages/client`, and `packages/server`?

**Interim position:** single package, revisited at V9 when a server must be deployed separately. See
ADR-0002 and `docs/technical-direction.md` §1.

---

### OD-12 — Tank locomotion model
**Urgency:** blocking for V1 · **Status:** open (technical)

An explicit kinematic movement model in the core (recommended), or a Rapier dynamic rigid body /
vehicle controller?

**Why it matters:** it determines whether tank handling is a designed, designer-tunable feel or an
emergent property of a physics engine.

**Interim position:** kinematic model, decided by a short spike during V1 and recorded as an ADR.

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
