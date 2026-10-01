# Glossary

Shared vocabulary for Combat Tank. Use these words consistently in code, comments, tests, and
design notes. If a term here conflicts with the meaning used in code, the code is wrong — or the
glossary needs updating through a decision record.

Terms marked **[later]** describe systems that are planned but not yet built. Do not treat them as
existing features.

---

## Vehicle & crew

**Hull** — the lower body of a tank. Its orientation is the tank's primary facing.

**Turret** — the rotatable upper body carrying the gun. Traverses independently of the hull,
limited by a maximum traverse rate.

**Gun / barrel** — the weapon mounted in the turret. Elevates and depresses within configured
limits, and recoils when fired.

**Muzzle** — the exit point of the barrel. Shells originate here.

**Hull traverse** — rotation of the hull itself, driven by the player.

**Turret traverse** — rotation of the turret relative to the hull. The turret's **world** heading is
`hull heading + turret local angle`, so turning the hull carries the turret with it mechanically while
its own local angle stays independent.

**Traverse arc** — how far the turret may rotate relative to its hull before hitting a mechanical
stop. Unlike traverse *rate*, it bounds where the turret can end up, not how fast it gets there.

**Trunnion** — the pivot the gun elevates about, mounted on the turret. The gun's orientation is
relative to it, and shells originate at the muzzle one barrel length along it.

**Gun elevation / depression** — the barrel's vertical angle relative to the turret's horizontal plane,
limited by the vehicle definition.

**Fire request** — a player (or AI) *asking* to fire. Not a command: the core refuses it while the gun
is reloading. See `InputCommand.fire`.

**Reload** — the interval after firing during which the gun cannot fire again. Owned by the
simulation core, not the client, so a shot can be refused authoritatively.

**Track** — the running gear. A damaged track can immobilise or slow a vehicle **[later]**.

**Module** — a damageable sub-system of a vehicle (track, engine, gun, turret traverse,
ammunition) **[later, V3]**.

**Crew** — named crew members who can be injured, killed, or replaced **[later, speculative]**.

**Vehicle class** — a high-level gameplay grouping such as light, medium, heavy, or tank destroyer.
The exact class system is **not decided** — see `docs/open-decisions.md` (OD-01).

---

## Ballistics & gunnery

**Shell** — a physical projectile fired from a gun. Travels over time; not an instant hitscan.
In V2 there is exactly one shell, the **test shell**, which is a placeholder and not an ammunition
type.

**Flight time** — the time between a shell leaving the muzzle and reaching its target. Non-zero by
design: it is why leading a moving target matters.

**Drop** — the vertical loss a shell accumulates during flight. At long range the player must aim above
the target to compensate.

**Impact record** — what V2 reports when a shell lands: position, surface normal, incoming direction,
impact velocity, and incidence angle. It answers **where and how** a shell hit. It deliberately carries
no penetration, ricochet or damage — that is V3's job to derive.

**Incidence angle** — the angle between a shell's direction of travel and the surface normal at impact.
**0° is a perpendicular hit; 90° is a grazing hit.** Computed from the *reversed* travel direction,
which is the detail most easily got backwards.

**Muzzle velocity** — the speed of a shell as it leaves the muzzle. Higher velocity means less
drop over a given distance and generally less time on target.

**Drag** — aerodynamic resistance slowing a shell in flight. **Not modelled in V2** (ADR-0010), so
long shots fall slightly short of a real shell.

**Penetration** — a shell's ability to defeat armor, expressed as a thickness in millimetres at
normal incidence.

**Normalization** — the increase in a shell's effective penetration when it strikes armor at an
angle rather than face-on.

**Effective thickness** — `armor thickness × normalization factor (angle)`. This is the value
compared against a shell's penetration to decide the outcome of an impact.

**Impact angle** — the angle between the shell's flight path and the surface normal of the armor it
strikes. Steep angles reduce effective thickness and can cause a ricochet.

**Ricochet** — a shell deflecting off a plate instead of penetrating it.

**Overmatch** — a shell with substantially greater thickness than the plate it strikes punching
through regardless of angle. **[later, not decided]**

**Aim / convergence** — the act of aligning the gun with a target, and any dispersion model that
represents the difficulty of doing so.

**Dispersion** — the random or modelled spread of impacts around the aim point, expressed as a
radius that grows with distance and vehicle movement **[later, V3+ tuning]**.

**Reload time** — the delay between shots. Central to the tactical rhythm of combat.

---

## Combat & battlefield

**Combat Tank (the game)** — this project.

**Armor** — a vehicle's protection, modelled as discrete plates with thickness, orientation, and
location.

**Plate** — one flat region of armor with a defined normal and thickness. Where a shell lands
determines which plate was struck and therefore how the impact resolves.

**Module damage** — damage to a vehicle sub-system rather than to the vehicle as a whole
**[later, V3]**.

**Repair** — restoring a destroyed module to a functional state during a battle **[later, V3+,
deferred in the first pass]**.

**Concealment / camouflage** — reduced detectability, from foliage, distance, or camouflage
netting **[later, V6]**.

**Spotting** — becoming aware of an enemy vehicle, by line of sight or by a teammate's report
**[later, V6]**.

**Line of sight (LOS)** — whether an unobstructed sight line exists between two points
**[later, V6]**.

**Cover** — terrain or structures that block line of sight and incoming fire.

**Flanking** — moving around an enemy's side or rear to exploit thinner armor and better angles.

**Skirmish** — a discrete battle with defined participants, spawns, and a win condition.

**Base / capture point** — a map objective that a team holds to influence the outcome
**[later, V6+; not in the first modes]**.

---

## Technical vocabulary

**Simulation core** — the headless, deterministic game logic package. Pure TypeScript; no
rendering, no network, no DOM.

**Headless** — runnable with no graphics output, for tests, servers, and AI-vs-AI simulations.

**Tick** — one fixed-step update of the simulation. Ticks are the unit of simulation time.

**Deterministic** — the same initial state and the same sequence of inputs produce the same
resulting state, on any machine. A prerequisite for trustworthy server authority and replays.

**Seed** — the initial value for the random number generator that drives dispersion, AI decisions,
and other chance effects. A battle is reproducible from its seed plus its input log.

**Fixed timestep** — advancing simulation time by a constant amount per tick, independent of the
render frame rate.

**Authoritative server** — a server that owns the true simulation state and validates player
actions, rather than trusting clients to report outcomes.

**Client prediction** — the client simulating its own tank immediately for responsiveness, then
reconciling with the server's authoritative result.

**Interpolation** — the client smoothly rendering remote tanks between authoritative snapshots
rather than snapping to them.

**Input log** — the recorded sequence of player and AI inputs for a battle, which combined with
the initial state reproduces the whole match.

**ADR** — Architecture Decision Record: a short document in `docs/decisions/` capturing a
decision, its context, and its consequences.

**Open decision** — a product or design question that has deliberately not been answered, recorded
in `docs/open-decisions.md`.
