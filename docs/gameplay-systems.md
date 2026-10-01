# Gameplay Systems Overview

**Status:** Authoritative for system scope. This document describes the systems Combat Tank
**intends** to have. **Nothing described here is implemented yet.**

Each system carries a confidence tier. The tier states how settled the design is and how soon it is
expected — not how interesting it is.

| Tier | Meaning |
| --- | --- |
| **Core** | Load-bearing. Must exist for the game to be the game. Sequenced early. |
| **Planned** | We are confident we want it. Sequenced after the Core is proven. |
| **Speculative** | We might want it. No design work has been done. Do not build. |

The authoritative sequencing lives in `docs/version-plan.md`. This document answers *what the
systems are*, not *when to build them*.

---

## 1. Vehicle control and movement

**Tier: Core** · V1

The player commands one tank: hull, turret, and gun.

- **Driving** — forward, reverse, and turning, with distinct forward and reverse performance.
- **Heavy handling** — acceleration, braking, and turning are rate-limited and mass-influenced. A
  tank should feel like it is pushing against something.
- **Hull traverse** — the hull rotates under player control, at a limited rate.
- **Turret traverse** — the turret rotates independently, at a *different* and usually slower rate
  than the hull. The player can never instantly aim.
- **Gun elevation and depression** — limited vertical range, so some positions are un-hittable
  and some enemies are only hittable from a slope.
- **Surface and slope interaction** — terrain grade affects speed, and in later versions affects
  firing arcs and the ability to climb.

**Design intent:** the player should constantly trade mobility against aim. Moving to get a better
angle costs the reload time they are relying on.

**Not decided:** whether the player drives the hull directly or uses a "drive toward a point"
assist. See `docs/open-decisions.md` (OD-02).

---

## 2. Camera and situational awareness

**Tier: Core** · V1, extended in V2

- **Third-person combat camera** — orbits the vehicle; the primary way the player reads the
  battlefield.
- **Aiming relationship** — the camera and the gun are conceptually linked while aiming but not
  rigidly welded, so the player must still aim with the vehicle.
- **Aiming reticle and range** — the player must be able to read where the gun points and roughly
  how far the target is. Legibility principle P6.
- **Obstruction handling** — the camera must not be permanently stuck inside terrain or buildings.

**Later (Planned):** a precision/sniper aiming mode that narrows FOV for fine aim, at the cost of
peripheral awareness.

**Speculative:** free-look, cockpit/interior view, replay cameras.

---

## 3. Gunnery, ballistics, and firing

**Tier: Core** · V2

- **Firing** — the player fires the main gun; the gun has a reload time afterwards.
- **Projectile shells** — shells are **real travelling projectiles**, not instant hitscan rays.
- **Ballistics** — shells have a muzzle velocity and are affected by gravity, so long shots must
  be aimed above the target and lead moving targets.
- **Time of flight** — the delay between firing and impact is a real, exploitable tactical
  property. A shot can miss a target that has since moved.
- **Impact resolution** — an impact produces a position, an impact normal, and an impact angle,
  which feed the armor model.
- **Ammunition types** — different shells behave differently.

**Planned ammunition concepts** (exact set is **not decided** — see OD-04):
- *Armor-piercing* — reliable flat trajectory, good penetration, low post-penetration effect.
- *High-velocity* — very fast, minimal drop, flatter trajectory, lower penetration per calibre.
- *Explosive* — large-calibre, slower, more blast and splash effect, weaker per-round penetration.

**Not decided:** whether dispersion is random-per-shot, deterministic-per-target, or a hybrid.
Randomness has consequences for reproducibility and fairness. See OD-05.

---

## 4. Armor and damage

**Tier: Core** · V3

This is the system that makes the genre the genre. It is the highest-priority system after
movement and ballistics.

- **Armor as plates** — a vehicle's protection is a set of oriented plates, each with a thickness
  and a location (hull front, hull side, turret front, track, and so on).
- **Impact angle matters** — a shell hitting a plate face-on presents its full thickness; the same
  shell hitting at a steep angle presents a *greater effective thickness*.
- **Effective thickness** — the comparison value used against a shell's penetration. Thin armor at
  a bad angle can defeat a shell that would defeat thick armor head-on.
- **Penetration outcome** — a hit either penetrates (and does damage) or fails to penetrate. A
  non-penetrating hit is a *real outcome the player should understand*, not a fudge.
- **Ricochet** — at sufficiently steep angles a shell can be deflected rather than stopped by
  thickness. Purely cosmetic ricochets must be avoided.
- **Vehicle hit points** — the baseline pool that penetration damage depletes.
- **Module damage** — hits can damage specific sub-systems:
  - *Track* — immobilisation or severe mobility loss.
  - *Engine* — power loss.
  - *Gun* — reload penalty or failure to fire.
  - *Turret traverse* — slower aiming.
  - *Ammunition* — potential secondary detonation (explicitly optional; not committed).
- **Destruction** — reaching zero hit points destroys the vehicle and ends its participation.
- **Repair** — restoring a damaged module. Committed as a concept, **not** committed as a
  consumable-item economy. See OD-06.

**Design intent (principle P6):** after every hit, the player should be able to say *why* it
worked. The hit-feedback UI exists to serve this.

**Not decided:** overmatch rules, module HP partitioning, spall, and whether repairs are
player-consumed or map-based. See OD-06 and OD-07.

---

## 5. Battlefield, terrain, and cover

**Tier: Core** (basic terrain) V1 · **Planned** (tactical terrain) V6

- **Terrain** — height, slope, and surface. Terrain affects movement, line of sight, and firing
  arcs.
- **Structures and obstacles** — cover that blocks or exposes.
- **Open areas and lanes** — designed spaces where a fast vehicle is exposed and a slow one is
  protected.
- **Routes and flanking paths** — a map should offer at least one alternative approach, so that
  being flanked is a consequence of a choice rather than an arbitrary event.
- **Spawn points** — defined team and neutral areas, so spawns are never inside the enemy's
  view.

**Planned:** destructible structures, elevated firing positions, deliberate chokepoints, and
per-map asymmetry.

**Speculative:** weather, time of day affecting visibility, and fully dynamic terrain damage.

---

## 6. Visibility, spotting, and concealment

**Tier: Planned** · V6

- **Line of sight** — a vehicle is visible when an unobstructed sight line exists between it and a
  point the opponent can see.
- **Distance-based detectability** — smaller and more concealed vehicles are harder to see far
  away.
- **Team spotting** — a vehicle detected by a teammate is revealed to the whole team. This is what
  makes coordination matter even when players are not talking.
- **Concealment** — terrain, foliage, and later camouflage nets reduce detectability.

**Design intent:** this is what makes a map a tactical space rather than a shooting gallery.

**Speculative:** active camouflage consumables, and audio-only detection.

---

## 7. Battle and match structure

**Tier: Core** (minimal) V4 · **Planned** (modes) V6–V7

- **A battle has a beginning and an end** — the match must have a win condition and a result.
- **Teams** — a minimum of two sides from V4 onward.
- **Round flow** — spawn, fight, conclude, report.
- **Battle modes** (not decided which ship — see OD-08):
  - *Team deathmatch-style* — eliminate the enemy team.
  - *Base capture* — hold map objectives; control beats kills.
  - *Encounter / duel* — small, focused fights.

**Constraint:** Combat Tank grows toward multiplayer; it does not start there. A battle must be
fully playable with AI on both sides before any human multiplayer exists.

---

## 8. AI opponents

**Tier: Core** (existence) V5 · **Planned** (tactics) V7 · **Speculative** (learning) — see OD-09

AI is a first-class system, not a placeholder. It exists so the game is playable alone, and so the
game can be tested automatically.

Behaviour capability, in the order we intend to build it:

1. **Navigate** — follow a route over terrain without getting stuck.
2. **Acquire** — notice a visible enemy.
3. **Aim** — turn hull and turret toward the target, accounting for traversal rates.
4. **Fire** — respect reload time and shell ballistics.
5. **Use cover** — prefer positions that limit the enemy's ability to shoot back.
6. **Reposition** — move when the current position is bad.
7. **Retreat** — disengage when badly damaged.
8. **Flank** — seek an angle that defeats the enemy's frontal armor.

AI must run **entirely inside the simulation core** on the same rules as the player — same input
interface, same physics, same armor rules. An AI that cheats is worse than no AI, because it makes
the game untestable.

**AI as a test harness (Core):** a headless AI-vs-AI battle that runs to completion and produces a
resulting match report is one of the most valuable automated tests in the project.

**Speculative:** behaviour learned from recorded human play, adaptive difficulty that reads player
skill, and designer-authored behaviour trees.

---

## 9. Multiplayer and networking

**Tier: Planned** · foundations V9, playable battles V10

- **Authoritative server** — the server runs the simulation and decides the truth. Clients send
  *intents*, never results.
- **Rooms / matches as server entities** — one server process instance per battle.
- **Bots as first-class participants** — bots and humans occupy the same slot, so a match can
  always be filled.
- **Scale discipline** — start with a small fixed number of participants per side. Large battles
  are a later, separate problem.

**Explicitly not planned yet:** ranked ladders, matchmaking skill ratings, reconnection mid-match,
cross-region latency mitigation, spectator mode, and anti-cheat beyond server authority.

**Known design tension (important):** authoritative server play conflicts with the desire for
responsive, weighty local control. The reconciliation approach is an open technical question —
see OD-10.

---

## 10. Progression, garage, and persistence

**Tier: Planned** · V11

The persistent layer *outside* a battle.

- **Garage** — a screen where the player owns and configures vehicles.
- **Owned tanks and unlocks** — earning access to vehicles.
- **Upgrades and modules** — purchasable or researched improvements to a vehicle.
- **Experience and currency** — awarded from battles, spent in the garage.
- **Technology / research tree** — a progression structure. Explicitly **not decided** whether
  this is a tech tree, a module tree, or a flat list. See OD-03.
- **Statistics** — per-vehicle and per-player records.
- **Accounts** — identity and persistence of the above.
- **Cosmetics and achievements** — lowest priority in this tier.

**Sequencing principle:** the combat experience is proven in V1–V10 before any of this. A garage
built around a combat model we later change is wasted work.

**Speculative:** crew members, crew skills, premium vehicles, monetisation of any kind.

---

## 11. UI, HUD, and feedback

**Tier: Core** (minimal) V2–V4 · **Planned** (full) V6+

The UI exists to make the simulation legible (principle P6), not to decorate it.

**Core elements:**
- Aiming reticle and range.
- Vehicle status: hit points, and later per-module status.
- Gun status: reload progress, ammunition.
- Speed and throttle indication — needed to sell weight.
- **Hit feedback:** whether the shot penetrated, bounced, or missed, and roughly where.
- **Damage taken feedback:** which part was hit and what it cost.

**Planned:** minimap, team status list, battle timer and score, damage log, post-battle results
screen, settings and control rebinding.

**Explicitly not planned:** a real-time x-ray damage view, and elaborate animated UI.

---

## 12. Audio

**Tier: Speculative** · addressed in V12

Engine, track, turret traverse, gun fire, shell impact, and ricochet sounds are a large part of
tactics — a player locates enemies by gun report. Audio is therefore valuable, but it is not
required to prove the combat model, so it is deferred. Gun-report positioning is a genuine
tactical mechanic that should be designed deliberately when audio arrives.

---

## 13. System dependency summary

The order below reflects genuine technical dependency, not preference.

```
movement ──► camera ──► aiming
                          │
                          ├──► ballistics ──► hit detection ──► armor/penetration ──► damage
                          │                                                    │
                          │                                              destruction
                          └──► reload/firing                              │
                                                                           ▼
map/terrain ──────────────────────────────────────────────────────► match outcome
   │                                                                    │
   └──► LOS/concealment ──► AI ────────────────────────────────────────►┘
                                        │
                                     match structure ──► progression ──► content scale
```

Every arrow above is a real dependency: later systems read state produced by earlier ones. This is
why `docs/version-plan.md` cannot be reordered arbitrarily.

---

## 14. Quick reference — system to version

| System | Tier | First version |
| --- | --- | --- |
| Vehicle control and movement | Core | V1 |
| Camera and awareness | Core | V1 |
| Terrain (basic) | Core | V1 |
| Gun elevation / firing | Core | V2 |
| Ballistics and projectiles | Core | V2 |
| Hit feedback UI | Core | V2 |
| Hit points and destruction | Core | V3 |
| Match structure and win condition | Core | V4 |
| AI navigation and basic combat | Core | V5 |
| Tactical terrain, cover, routes | Core | V6 |
| Line of sight and spotting | Planned | V6 |
| AI tactical depth | Planned | V7 |
| Multiple battle modes | Planned | V7 |
| Vehicle data pipeline / roster | Planned | V8 |
| Authoritative server | Planned | V9 |
| Human multiplayer matches | Planned | V10 |
| Garage and progression | Planned | V11 |
| Content scale and polish | Planned | V12 |
| Crew, audio, destructibles, monetisation | Speculative | Undecided |

