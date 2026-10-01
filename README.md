# Combat Tank

**Combat Tank** is a 3D tactical tank-combat game for PC. The player directly controls a tank
from a third-person perspective on a battlefield where positioning, hull and turret orientation,
armor angle, penetration, and knowledge of the enemy matter more than reflex speed.

It is inspired by the *style* of games like World of Tanks. It is **not** a clone of them, and it
does not attempt to reproduce their content, branding, or exact mechanics.

---

## Project status

> **Stage: V3 — Armor, Penetration & Damage. Implemented (2026-10-01).**
> A stationary target tank now stands ahead of you. Shooting it reports **which plate** was struck, **at
> what angle**, and whether the shell **penetrated**, was **blocked**, or **ricocheted** — with damage,
> target HP, and any module knocked out shown on screen. Where you shoot genuinely matters: the sloped
> front stops shells, the flank does not, and the thin rear reaches the engine.
>
> Automated validation passes (253 tests). Subjective readability still awaits human playtest.
>
> **V1** (movement and camera) and **V2** (turret, gun, ballistics) remain complete and unchanged; their
> subjective feel items are recorded as *pending product playtest*.
>
> **V4 has not been started.** The target does not move, aim, or fire — it is a shooting target, not an
> opponent.

Current capabilities: heavy rate-limited driving and hull traverse; an independent rate-limited turret
with a full 360° ring; a gun with elevation/depression limits and a reload cycle; shells with travel
time and gravity drop; a data-driven armour model where **where you hit decides the outcome**;
deterministic penetration, ricochet and damage; spatially-meaningful module damage; and a hit-feedback
panel showing the numbers behind every verdict.

There is **no armour quality, dispersion, crew, fire, enemies that fight back, AI, or multiplayer** —
those are later versions by design.

---

## Running it

Requires **Node.js 22.12 or newer**.

```bash
npm install     # install dependencies
npm run dev     # start the game at http://localhost:5173
```

Click the window to capture the mouse, then drive.

### Controls

| Input | Action |
| --- | --- |
| `W` / `S` | Drive forward / reverse |
| `A` / `D` | Rotate the hull |
| Mouse | Aim the turret and camera — **never turns the hull** |
| Left mouse button | Fire (the gun must be loaded) |
| Mouse wheel | Zoom in / out |
| `Esc` | Release the mouse cursor |

Arrow keys mirror WASD. The camera, hull, and turret are three separate systems: you can look one way,
drive another, and have the gun trained somewhere else entirely. The mouse aims the **turret**, which
slews toward the point under the cursor at a limited rate rather than snapping to it — and if you spin
the hull faster than the turret can traverse, the gun genuinely lags behind.

**To test armour**, drive around the target tank rather than firing at it head-on from the start: it
faces the same way you do, so its rear is toward you at the beginning.

### Developer commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the client with hot reload |
| `npm run build` | Typecheck, then produce a production bundle in `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | TypeScript only |
| `npm run lint` | ESLint, including the core-purity rules |
| `npm test` | Vitest suite |
| `npm run sim` | **Headless batch battles** — real AI fights with no renderer, plus an aggregate report |
| `npm run verify` | **typecheck + lint + test** — the gate a version must pass |

### Layout

```
src/core/     Pure simulation. No Babylon, no Colyseus, no DOM, no wall clock.
src/shared/   Types and data used by both the core and the client.
src/client/   Babylon renderer, camera, input, HUD, Rapier queries.
tests/        Mirrors src/. Includes architecture guards.
docs/         The authoritative design and planning documents.
```

The core/client boundary is enforced rather than merely documented: ESLint fails the build if
`src/core` imports rendering or networking code, and `tests/architecture/core-purity.test.ts` verifies
that the rule actually fires.


---

## Documentation index

| Document | Purpose | Authority |
| --- | --- | --- |
| [`docs/vision.md`](docs/vision.md) | What the game is, the experience it targets, what it is deliberately *not* | **Authoritative** for product intent |
| [`docs/gameplay-systems.md`](docs/gameplay-systems.md) | The major gameplay systems, tiered by how certain they are | **Authoritative** for system scope |
| [`docs/technical-direction.md`](docs/technical-direction.md) | Proposed technical structure and boundaries | **Authoritative** for architecture; proposals are labelled as such |
| [`docs/version-plan.md`](docs/version-plan.md) | The V0 → V12 development ladder, with scope-based completion criteria | **Authoritative** for what to build next |
| [`docs/agent-working-guide.md`](docs/agent-working-guide.md) | How coding agents are expected to work in this repository | **Authoritative** for process |
| [`docs/open-decisions.md`](docs/open-decisions.md) | Product questions that need the owner's answer | **Authoritative** for what is *undecided* |
| [`docs/glossary.md`](docs/glossary.md) | Shared domain vocabulary | Reference |
| [`docs/decisions/README.md`](docs/decisions/README.md) | How architectural decisions are recorded (ADR process) | **Authoritative** for decision records |
| [`docs/assumptions.md`](docs/assumptions.md) | Planning assumptions made without owner confirmation | Reference; revisit when the owner decides |
| [`docs/harness.md`](docs/harness.md) | How to use `npm run sim`, and how to read what it prints | Reference |

**Conflict rule:** if two documents disagree, the more specific one wins for its subject matter
(architecture beats vision on *how*; vision beats architecture on *what*). If a conflict is still
unclear, it is an open decision — add it to `docs/open-decisions.md` rather than picking silently.

---

## The version ladder at a glance

Versions are defined by **scope and completion criteria, never by calendar time**.

| Version | Name | Ends with |
| --- | --- | --- |
| **V0** | Project Definition & Planning | Documents that define the game and the plan |
| **V1** | Movement & Camera Sandbox | ✅ A drivable tank on placeholder terrain |
| **V2** | Turret, Gun & Ballistics | Shells fly, arc, and hit things |
| **V3** | Armor, Penetration & Damage | Shells are *stopped* by armor, or are not |
| **V4** | Single-Player Combat Loop | **Playable single-player tank prototype** |
| **V5** | Autonomous AI Opponents | A solo player fights thinking bots |
| **V6** | Battlefield & Terrain Tactics | A real map where cover and angles matter |
| **V7** | Tactical Team Skirmish | **Tactical tank game**, solo + AI teams |
| **V8** | Vehicle Roster & Progression Hooks | Several distinct vehicles, data-driven |
| **V9** | Authoritative Multiplayer Foundation | A headless server owns the truth |
| **V10** | Playable Multiplayer Battles | **Human multiplayer battles** |
| **V11** | Garage, Progression & Accounts | **Persistent game** with a garage |
| **V12** | Content, Balance & Release Polish | A shippable, balanced, distributable game |

Full detail, including what each version explicitly defers and the outcome of the versions already
built, is in [`docs/version-plan.md`](docs/version-plan.md).

---

## Technology direction (proposed, not yet applied)

| Concern | Choice |
| --- | --- |
| Language | TypeScript (strict) |
| 3D rendering | Babylon.js |
| Physics & collision | Rapier 3D (`@dimforge/rapier3d-compat`) |
| Multiplayer / server | Colyseus on Node.js |
| Build tooling | Vite (client), Node tooling (server) |
| Tests | Vitest |

The architecture that keeps these from tangling is a **pure, headless simulation core** that knows
nothing about rendering or the network, with the client and the server as two thin shells around
it. See [`docs/technical-direction.md`](docs/technical-direction.md), and the decision records in
[`docs/decisions/`](docs/decisions/README.md) for the reasoning behind each structural choice.

---

## Working rules in one paragraph

Combat Tank is developed primarily by coding agents. Every version must stay runnable. Work is
driven by [`docs/version-plan.md`](docs/version-plan.md), not by invented side quests. Do not
build a system that a *later* version needs until a *current* version's completion criteria require
it. When a decision is made that future agents must respect, it goes into
`docs/decisions/`. When a question genuinely needs the owner, it goes into
`docs/open-decisions.md`. Read [`docs/agent-working-guide.md`](docs/agent-working-guide.md) before
making changes.
