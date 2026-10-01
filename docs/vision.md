# Game Vision

**Status:** Authoritative for product intent. This document describes what Combat Tank is *for*.
Any implementation that contradicts the principles here is wrong, even if it is well engineered.

---

## 1. What Combat Tank is

Combat Tank is a **3D tactical tank-combat game for PC** in which the player directly commands a
single tank on a battlefield, using position, armor geometry, and gunnery skill to defeat enemy
armored vehicles.

The player controls the tank from a **third-person perspective**. There is no squad of individual
soldiers to micromanage and no real-time action reflex requirement. The unit of play is the
**vehicle**, and the vehicle is a machine with real physical constraints: it has mass, it has
armor with thickness and angle, its turret rotates at a limited rate, its gun must reload, and its
engine produces a finite amount of power.

Combat Tank takes its *genre cues* from games in the tradition of World of Tanks. It is explicitly
**not a clone**. That means:

- We take the *idea* of slow, positional, vehicle-scale combat.
- We do not copy its content, branding, maps, vehicles, or exact formulas.
- We do not commit to its feature list, progression economy, or battle structure.
- We are free to make Combat Tank simpler, harder, slower, or stranger where that serves our
  design.

### The one-sentence pitch

> *A heavy machine on heavy ground: read the ground, angle your armor, and make every shot count.*

---

## 2. The experience we are trying to create

The target feeling is **deliberate, weighty tension** — the feeling of a hunter deciding when to
expose a flank, and a defender hearing a gun that is slightly closer than it was a moment ago.

Concretely, we want the player to experience:

1. **Weight.** A tank is not a person. It accelerates slowly, it keeps rolling, it cannot turn on a
   dime, and it cannot shoot while doing ninety percent of the things it might want to do.
2. **Reading the ground.** Where you are matters more than what you are. Hull orientation, slope,
   and cover are the primary defensive tools.
3. **Committing to a shot.** Firing reloads the gun, it announces your position, and it is only
   worth doing when the geometry works. Every shot is a decision with a cost.
4. **Anticipating the enemy.** The most satisfying moment is firing at a hull angle you *know* will
   defeat the shell, at a target who is still deciding what to do about you.
5. **Recovering from bad luck.** Being tracked, having your engine hit, or getting flanked should
   create problems to *solve*, not just a countdown to death.

### The feeling we are explicitly avoiding

- **Arcade action.** Instant hitscan, rocket-jump movement, and damage races. If Combat Tank
  becomes twitchy, the design has failed.
- **Stat-check combat.** A fight should not be decided by a spreadsheet before it begins.
- **Empty spectacle.** Loud, expensive visuals that carry no tactical meaning.
- **Content as the game.** A hundred vehicles with identical behaviour is one vehicle with a
  hundred skins.

---

## 3. Core gameplay principles

These are the load-bearing rules of the design. Feature work should be justified against them.

### P1 — Geometry is the core mechanic

Angle, distance, cover, and line of sight decide fights. A shot is not a damage roll; it is a
geometry problem that may be solved badly. Armor thickness is meaningful *because* of the angle it
is presented at.

### P2 — Committing costs time

Firing, repositioning, and turning are all slow. The game is about deciding what to spend your time
on while the clock and the reload timer run.

### P3 — Vehicles are machines, not health bars

A tank has parts. Damaging the right part is more interesting than reducing a pool. This is
progressive — the first combat loop is HP-based, and part damage arrives in V3.

### P4 — Knowledge beats reflexes

Knowing the enemy's vehicle, the map's routes, and what the other side can see should be worth
more than fast reactions. We design for the player who studies, not the player who twitches.

### P5 — Heavy is a feature, never a bug

If the controls feel heavy and a bit deliberate, that is success. We add assist and smoothing so
the weight is *communicated*, not so that it is *removed*.

### P6 — Legibility over realism

A player must be able to understand *why* they were hit and *why* their shot failed. Realistic
simulation that the player cannot read is worthless. We prefer clear models over accurate ones,
and we show the player the numbers that matter.

### P7 — Vehicles must feel genuinely different

Adding a tank must not require rewriting the game, and two tanks must not play the same with
different numbers. Different vehicles change *how you fight*, not just how long you survive.

### P8 — Prove the core before the periphery

Combat correctness comes before content, art, progression, and infrastructure. A small number of
tanks that fight well beats a large catalogue of tanks that do not.

### P9 — Solo-playable at all times

The game must be testable and enjoyable without other humans present. AI is a first-class citizen,
not a stopgap.

### P10 — Cheating must be structurally hard

Authoritative combat is a design value, not a later security patch. Clients request; servers
decide.

---

## 4. Important gameplay versus optional features

This distinction is the most important thing for future agents to get right. It is restated
operationally in `docs/version-plan.md`.

### Tier 1 — Load-bearing (the game does not exist without these)

| System | Why it is load-bearing |
| --- | --- |
| Tank movement with weight | Without it there is no tank |
| Independent hull & turret control | This *is* the tank-combat control fantasy |
| Gun aiming, elevation, and firing | Without it there is no combat |
| Projectile ballistics with drop | Makes range and lead a real skill |
| Armor thickness, angle, and penetration | This *is* the genre's core interaction |
| Damage and vehicle destruction | Without a win condition there is no game |
| A battlefield with terrain and cover | Without space, position means nothing |
| A camera the player can read | The player must understand the 3D situation |
| Match structure with a win condition | Turns systems into a game |
| AI opponents | Makes the game testable and solo-playable |

### Tier 2 — Important, sequenced after Tier 1 is proven

Vehicle roster variety, part damage and repair, AI tactical depth (cover, flanking, retreat),
multiple battle modes, spotting and line-of-sight rules, concealment, map objectives,
client/server netcode hardening, a garage and progression shell.

### Tier 3 — Optional and genuinely uncertain

Destructible environment, crew and wounded crew members, research trees, cosmetics, achievements,
replays, larger battle sizes, multiple nations, premium/special vehicles, monetisation of any
kind, modding.

### The rule for agents

**A feature does not become Tier 1 because it is fun to build.** It becomes Tier 1 when a version
in the plan says so, and the owner has agreed. Everything else waits. See
`docs/open-decisions.md` for the items whose tier is not yet settled.

---

## 5. Long-term direction

Where Combat Tank is heading, assuming the early versions succeed:

1. **Tactical depth first.** Reliable armor, ballistics, and map geometry, with AI that genuinely
   uses them.
2. **Then breadth.** A roster of vehicles that each play differently, on a handful of well-made
   maps, across several battle modes.
3. **Then shared play.** Server-authoritative team battles at a modest scale, with bots filling
   empty slots so matches always work.
4. **Then a reason to return.** A garage, progression, and statistics that give battles a
   persistent frame.
5. **Then scale and polish.** More content, better performance, and a distributable build.

The long-term shape is a **team-based vehicle tactical game** that happens to have excellent solo
play. Both halves must stay viable; neither is allowed to starve the other.

---

## 6. What this project is explicitly not trying to do yet

To prevent scope drift, Combat Tank is **not** currently trying to be:

- **A World of Tanks clone.** Different game, different content, no attempt at parity.
- **A vehicle collection game.** A large catalogue of near-identical tanks is a failure mode we
  accept the risk of.
- **A hardcore simulation.** Full physics fidelity of real tanks, shell spall, torsion bars, and
  ammunition racks are explicitly out of scope for the foreseeable future.
- **An esports title.** No ranked ladders, seasons, or anti-cheat arms race is planned for the
  foreseeable future.
- **A live-service game.** No always-on server requirement, no energy timers, no pay-to-win.
- **A physics sandbox.** Rapier is a tool. It is not the game's identity, and gameplay must not be
  defined in terms of what the physics engine happens to do.
- **A content-complete product before the combat works.** The order of versions in
  `docs/version-plan.md` is binding.
- **An engine project.** We are building a game. Infrastructure must earn its place by unblocking
  a current version's completion criteria.

---

## 7. Success criteria for the vision

Combat Tank's vision is being delivered when:

- A new player can drive a tank, take a shot, understand why it bounced, and understand why they
  were hit — without a wall of tutorial text.
- An experienced player can win a fight they should lose by out-positioning a better vehicle.
- A player can tell two vehicles apart by how they behave, not by reading a stat line.
- Two players can fight each other online and neither can trivially cheat.
- Someone can play a full match alone, against bots, and be satisfied.

The first three land across V1–V7. The last two land in V10 and V11.

