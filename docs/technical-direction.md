# Technical Direction

**Status:** Authoritative for architecture. This is a **proposal for review**, not a description of
existing code. No game code exists yet.

The technology stack named by the owner (TypeScript, Babylon.js, Rapier, Colyseus) is **kept
unchanged**. This document's job is to decide *how these pieces are organised* so they do not
tightly couple, and to state which decisions are still provisional.

---

## 1. Executive summary

The single most important architectural decision in this project:

> **Put all gameplay in a pure, headless, deterministic simulation core. Make the client a
> *viewer* of that core and the server its *authority*. Neither may leak into the other.**

Everything else follows. It is proposed because the project has four hard requirements that a naive
"Babylon.js game with a server bolted on later" would violate:

1. **Multiplayer must be authoritative.** If combat logic lives inside the render client, the client
   can lie. Moving the logic to a shared core is the only way a server can own it.
2. **AI must be testable.** Battles must run with no graphics and no human, many times over, to
   validate balance and catch regressions. That requires a headless core.
3. **The project is agent-developed.** A codebase with crisp boundaries and no sprawling global
   mutable state is far more reliable to modify than a coupled one.
4. **Determinism is needed** for reproducible bugs, replayable battles, and trustworthy tests.

**Current recommendation:** a **single package** with strictly enforced internal module boundaries,
**not** a monorepo. A monorepo (`packages/client`, `packages/server`, `packages/shared`) adds
workspace tooling, cross-package build config, and versioning overhead the project does not need
until there is a server to deploy separately. The boundary that matters — core vs. shell — is
enforceable with lint rules and import conventions inside one package.

This is a proposal; the monorepo-vs-single-package question is recorded as **OD-11**.

---

## 2. Responsibilities of each technology

| Technology | Owns | Must never own |
| --- | --- | --- |
| **TypeScript** | All logic, types, and build-time correctness | — |
| **Babylon.js** | Rendering, camera, materials, meshes, effects, input capture, UI | Any rule that decides gameplay outcomes |
| **Rapier 3D** | Collision geometry, ray/shape casts, terrain collision, body integration, debug visualisation | Health, damage, penetration, match rules, AI decisions |
| **Colyseus** | Rooms, transport, state replication, server lifecycle, matchmaking plumbing | Any gameplay rule not already in the core |
| **Node.js** | Server hosting, tooling, headless simulation, static asset serving | — |

### The critical boundary

| Question | Owner | Not |
| --- | --- | --- |
| Did this shell penetrate this plate? | `core` | Rapier or Babylon |
| Is the AI allowed to shoot right now? | `core` | Babylon |
| Has team A won? | `core` | Colyseus |
| Where do I draw the tank? | Babylon | — |
| What shape is the terrain collider? | Rapier | — |
| How do I get a snapshot to the client? | Colyseus | — |

---

## 3. Proposed repository structure

A **proposal** to be reviewed before V1 scaffolding is created. Directories are created only when
the version needing them begins.

```
combat-tank/
├─ README.md
├─ docs/                         # This documentation (authoritative)
├─ src/
│  ├─ core/                      # PURE SIMULATION. No Babylon, no Colyseus, no DOM.
│  │  ├─ math/                   # Vectors, deterministic trig, fixed-step helpers
│  │  ├─ sim/                    # World, tick loop, entity registry
│  │  ├─ vehicle/                # Vehicle state, movement, turret/gun dynamics
│  │  ├─ ballistics/             # Shells, integration, time of flight
│  │  ├─ armor/                  # Plates, normalization, penetration resolution
│  │  ├─ damage/                 # HP, modules, destruction
│  │  ├─ ai/                     # AI controllers, behaviours
│  │  ├─ match/                  # Match lifecycle, win conditions, scoring
│  │  ├─ world/                  # Map data, spawn points, line-of-sight queries
│  │  └─ rng/                    # Seeded, deterministic random source
│  ├─ shared/                    # Types and pure helpers used by core + shells
│  │  ├─ protocol/               # Network message and state schemas (V9+)
│  │  └─ vehicle-defs/           # Data-driven vehicle definitions + validation
│  ├─ client/                    # Babylon shell (V1+)
│  │  ├─ render/                 # Scene, meshes, materials, effects
│  │  ├─ camera/                 # Camera rig and collision
│  │  ├─ input/                  # Keyboard/mouse → input commands
│  │  ├─ ui/                     # HUD, reticle, results screens
│  │  ├─ net/                    # Colyseus client (V9+)
│  │  └─ main.ts                 # Client entry point
│  ├─ server/                    # Colyseus / Node shell (V9+)
│  │  ├─ rooms/                  # Room definitions, state schema
│  │  ├─ net/                    # Transport wiring, validation
│  │  └─ main.ts                 # Server entry point
│  └─ tools/                     # Headless runners, simulation harnesses
│     └─ headless/               # Batch battle runner (V5+)
├─ assets/                       # Models, textures, audio (placeholder-first)
├─ tests/                        # Automated tests (mirroring src/ structure)
├─ package.json
├─ tsconfig.json
└─ vite.config.ts
```

**Rules the above encodes:**

- `src/core/**` must never import from `src/client/**`, `src/server/**`, Babylon, Colyseus, or
  anything browser- or Node-specific. This is the rule that keeps the project honest, and it is
  mechanically checkable (see §7).
- `src/shared/**` may be imported by core and shells, but must stay pure and dependency-light.
- Shells may import core. Core may never import shells.
- `src/tools/**` may import both, because its job is to drive the core headlessly.

---

## 4. The simulation core in detail

### 4.1 The tick loop

Simulation time advances in **fixed steps**. This is not an optimisation; it is a correctness
requirement, because it makes results depend on the *inputs* rather than on the machine's frame rate.

- A **tick** is one fixed update, e.g. 1/60 s.
- Rendering interpolates between ticks; it never drives simulation time.
- A headless runner advances ticks as fast as the CPU allows, so minutes of battle take far less
  than real time.

**Proposed starting tick rate: 60 Hz.** The *network* tick rate in V9 may be lower (e.g. 20–30 Hz)
while the client still renders at 60 fps. That split is a V9 decision — but the core must be
tick-driven **from V1**, so the choice stays open.

### 4.2 Determinism, and the one real threat to it

Rapier's WASM build is documented as cross-platform deterministic. However, the same Rapier
documentation warns that JavaScript's `Math.sin` and `Math.cos` are **not** cross-platform
deterministic.

Therefore:

- **All gameplay math uses our own deterministic trigonometry** (`src/core/math`), implemented as
  polynomial approximations rather than `Math.*` transcendentals. (ADR-0005.)
- All randomness comes from a **seeded PRNG** owned by the core (`src/core/rng`). `Math.random()`
  is banned in the core and should be banned by lint rule.
- The core is stepped by fixed timestep, never by wall-clock time.

**Practical benefit:** a battle is reproducible from `(seed, input log)`, so bugs are replayable and
AI-vs-AI balance tests are meaningful.

**Honest caveat:** bit-exact determinism across machines is **not yet proven** in this project. It
is a design goal with a mitigation plan, and V9's criteria include a determinism test that must pass
before multiplayer relies on it. If it proves unachievable, the fallback is server-authoritative
simulation with **no** client prediction — costing responsiveness but keeping the game correct. That
fallback is recorded as **OD-10**.

### 4.3 State ownership

The core owns all mutable gameplay state. Shells own only presentation state (meshes, camera, UI).

- The core exposes **immutable snapshots** for rendering — read-only views of vehicle transforms
  and statuses.
- The client never writes vehicle state. It sends **input commands** and renders what the core
  reports.
- In single player, the client hosts a local core instance. In multiplayer (V9+), the server hosts
  it. **The same core code runs in both** — that is the entire point.

### 4.4 Input command interface

One input type serves players and AI alike. This is what makes "AI uses the same rules" true by
construction rather than by convention.

```
InputCommand {
  throttle      : -1..1      // forward / reverse
  turn          : -1..1      // hull traverse request
  turretTraverse: -1..1      // turret rotation request
  gunElevate    : -1..1      // gun elevation request
  fire          : boolean    // request to fire (validated by the core)
  aimPoint      : Vec3?      // desired aim point
}
```

The core converts these into rate-limited, mass-influenced motion. Neither the player nor an AI can
bypass this interface, and nothing in the network protocol will ever let a client *assert* a hit, a
kill, or a position.

---

## 5. Physics: what Rapier does and does not do

Rapier is used for **geometry and collision queries**, not for gameplay rules.

**Rapier is responsible for:**
- Terrain and structure colliders.
- Ray and shape casts for shell impact detection and line-of-sight queries.
- Rigid-body integration where physical pushback is genuinely needed (e.g. vehicle-vs-vehicle).
- A debug renderer, so the collision world can be inspected while developing.

**Rapier is explicitly NOT responsible for:**
- Deciding whether a shell penetrated.
- Deciding damage.
- Driving AI decisions.
- Advancing simulation time.

### Vehicle movement — a proposal to be settled by a V1 spike

Rapier ships a `DynamicRayCastVehicleController` (a port of Bullet's `btRaycastVehicle`): a chassis
rigid body with wheel ray-casts, engine force, braking, and steering. It is a reasonable starting
point, but it is a **car** controller, and a tank is not a car — tanks steer by differential track
speed, and the genre demands specific designer-facing numbers (top speed, reverse speed, hull
traverse rate, power-to-weight).

**Proposed approach:** implement tank locomotion in the core as an **explicit kinematic model**
(forward/reverse acceleration curves, a separate hull traverse rate, slope resistance) integrated by
the core on its own tick, using Rapier only for **collision queries** — casting rays downward to
sample ground height and normal, and casting to detect blocking geometry.

**Why this is the recommendation:**
- Tank handling is a *designed feel*, and it must be expressed in units a designer can reason about
  and a server can reproduce exactly.
- A dynamic rigid-body vehicle makes weight emergent but hard to control, and adds sensitivity to
  contact ordering.
- It keeps the authoritative simulation cheap — a server simulating many tanks needs a predictable,
  inexpensive movement model.

**The alternative** — a Rapier dynamic body driven by track forces, or the vehicle controller — is
legitimate, and is recorded as open technical question **OD-12**, to be settled by a spike during
V1. This document does not pretend the choice is free.

---

## 6. Rendering: Babylon.js

Babylon is a **view**. It is deliberately the least authoritative part of the project.

- **Placeholder-first.** V1–V5 ship with primitive geometry (boxes, cylinders) and flat colours.
  Nothing blocks on final art (principle P8 in `docs/vision.md`).
- **Visual ↔ data mapping.** A `VehicleVisual` binding maps a vehicle definition to meshes, so
  replacing a placeholder with a real model is a data change, not a code change.
- **Camera.** A rig in `src/client/camera` with occlusion handling, plus a later aiming mode.
- **Input.** Keyboard and mouse are captured into `InputCommand` objects and handed to the core.
  Gameplay code must never read input devices directly.
- **Materials and effects.** Particles, tracers, smoke, and impact decals are presentation only.
  They are triggered by simulation events and must never feed back into simulation.
- **Physics debug view.** Rapier's debug rendering is exposed behind a toggle, because seeing the
  collision world is the fastest way to diagnose "the shell went through the hill" bugs.

**Explicitly rejected for now:** a game framework or ECS library layered on top of Babylon. Babylon
is already a large dependency; adding a second abstraction layer costs more than it saves at this
stage. Revisit only if `src/core` becomes unmanageably large, and record an ADR if we do.

---

## 7. Multiplayer: Colyseus, V9 and later

Colyseus is a Node.js framework for authoritative game servers, with schema-based state
replication, rooms, and matchmaking. It fits Combat Tank because the same simulation core the client
already runs locally can be hosted by the server — only the *authority* changes.

**The model:**

- One Colyseus **room** per battle.
- The room owns a simulation core instance and steps it on a fixed network tick.
- Clients send **`InputCommand`** messages. The server validates and applies them.
- The server broadcasts **state snapshots**; clients render them, interpolating remote vehicles and
  predicting their own.
- Bots are simulated inside the same core, on the same tick, as ordinary participants.

**Client prediction and reconciliation.** The player should feel the weight of the tank
immediately, which argues for predicting local input on the client. But prediction must reconcile
against an authoritative server, which requires the same deterministic core on both ends. This is
exactly why the core is designed as it is — and exactly why the determinism caveat in §4.2 matters.
If determinism cannot be achieved, we drop prediction (OD-10).

**Not part of V9/V10:** ranked queues, skill matchmaking, reconnection, spectators, and horizontal
scaling. Colyseus supports them; we are not building them yet.

---

## 8. Data-driven vehicle definitions

Vehicles must be **data, not code**. Adding a tank should mean adding a data file, not editing
systems (principle P7).

A vehicle definition is a validated data structure covering the characteristics named in
`docs/gameplay-systems.md`: size, mass, armor layout, engine power, max and reverse speed, hull and
turret traverse rates, gun calibre, reload time, shell velocity, penetration, accuracy, gun
elevation/depression limits, hit points, and visibility characteristics.

**Requirements:**
- Definitions live as data (JSON or TS modules) under `src/shared/vehicle-defs/`.
- They are **validated at load time** against a schema, with clear errors. A typo in an armour value
  must fail loudly at startup, not silently produce a broken tank.
- The **armor layout** is data too: named plates, each with thickness, dimensions, and a local
  position/orientation on the hull or turret. The armor system reads this data; it hard-codes no
  specific tank.
- Presentation (mesh, colour, sound) is referenced **by id** from the definition, so a placeholder
  can be swapped for real art without touching the data model.

This is ADR-0003.

---

## 9. Testing and developer commands

**Testing strategy** (details in `docs/agent-working-guide.md`):

- **Unit tests** for pure core logic: armor normalization, penetration resolution, ballistics, RNG,
  vehicle movement curves, match win conditions.
- **Headless integration tests**: run a full AI-vs-AI battle in the core with no rendering and
  assert it terminates with a valid result. This is the workhorse test from V5 onward.
- **Determinism tests**: run the same seeded battle twice and assert identical outcomes (and, in V9,
  identical across a client and server run).
- **Client smoke tests**: typecheck/build the client and, where valuable, assert the scene
  initialises — kept light, since a real engine is hard to unit test.

**Developer commands** the project should expose from the start (exact names may change):

| Purpose | Shape of the command |
| --- | --- |
| Install | `npm install` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Test | `npm test` |
| Run the game locally | `npm run dev` |
| Run a headless battle | `npm run sim` (batch battle runner, V5+) |
| Run the server | `npm run server` (V9+) |
| Full verification | `npm run verify` (typecheck + lint + test) |

**Rule:** a version is not complete until `npm run verify` passes **and** the game still starts. This
keeps every version runnable, as the development philosophy requires.

---

## 10. Tooling choices and their justification

Added only where they earn their place. "Don't introduce unnecessary frameworks merely because they
are available" is a binding constraint.

| Tool | Purpose | Why |
| --- | --- | --- |
| **Vite** | Client dev server and build | Fast, minimal, standard for a TypeScript + WebGL client |
| **Vitest** | Unit and integration tests | Shares Vite's config; runs the same TypeScript directly; no extra transform layer |
| **TypeScript strict mode** | Type safety across core and shells | The primary correctness tool for agent-written code |
| **ESLint** (minimal) | Enforce core purity; ban `Math.random()` in core | The boundaries in §3 must be mechanically enforced, not merely documented |

**Deliberately not adopted yet:** a state-management library, a UI framework, an ECS library, a
physics abstraction wrapper, a logging framework, an asset pipeline, and monorepo tooling. Each
should be proposed with a concrete problem it solves.

`@dimforge/rapier3d-compat` (the WASM-inlined build) is preferred over the plain package so Rapier
loads without a separate `.wasm` fetch step, which keeps both the browser client and the Node
headless runner simple.

---

## 11. Key risks and how the structure mitigates them

| Risk | Impact | Mitigation in this structure |
| --- | --- | --- |
| Gameplay logic leaks into the client | Server can't be authoritative; cheats become trivial | Core-purity rule (§3) enforced by lint; shells can only send inputs |
| Cross-platform non-determinism | Prediction/reconciliation breaks | Deterministic math + seeded RNG (§4.2); determinism test gates V9; no-prediction fallback (OD-10) |
| Headless AI testing is impossible | Balance and regressions go unnoticed | Core has no rendering dependency; batch runner in `src/tools` |
| Coupling to physics-engine quirks | Gameplay becomes non-portable and non-testable | Rapier used for queries only; all rules live in the core |
| Agent-written code drifts in style | Growing unreliability | Conventions in the agent guide; strict TS; boundary lint rules; ADRs |
| Premature infrastructure | Wasted effort before the game exists | Monorepo, ECS, and frameworks explicitly deferred, with reasons |

---

## 12. Open technical questions

Summarised here for convenience; owned in `docs/open-decisions.md`.

| ID | Question | Proposed default | Settled when |
| --- | --- | --- | --- |
| OD-10 | Client prediction vs. pure server authority | Prediction, gated on determinism | V9 spike |
| OD-11 | Single package vs. monorepo | Single package | Before V1 scaffolding |
| OD-12 | Kinematic tank locomotion vs. Rapier vehicle controller | Kinematic, via a V1 spike | V1 |

All other open questions in the register are **product/design** questions, not technical ones, and
are owned by the project owner.

