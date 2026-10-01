# 0006. No game-framework UI library in the client

- **Status:** Accepted (proposed at V0 planning; revisit in V11)
- **Date:** 2026-10-01
- **Affects:** `src/client/ui`, Babylon usage, future garage screens.

## Context

Babylon.js ships a capable, free UI system, and a separate UI framework would add a second rendering
and state concept. The project's UI needs are modest through V10 — a reticle, a reload indicator, a
status list, a results screen — and grow in V11 with the garage. The development philosophy explicitly
warns against introducing frameworks merely because they are available.

## Decision

Build the HUD with **Babylon's own GUI layer** and plain TypeScript, and do not adopt a separate UI
framework, component library, or front-end state manager in the client. Client-side state that the
UI needs is derived directly from simulation snapshots.

## Consequences

**Positive**

- One rendering stack and one state model, with no synchronisation layer between game state and UI
  state.
- No additional dependency, and no framework version to track.
- The UI stays a pure function of simulation state, which matches the core-purity rule in spirit.

**Negative / costs**

- Babylon's GUI is not a component framework. Building a multi-screen garage with lists, tabs, and
  forms in V11 will be more manual than using a UI framework.
- Accessibility of a canvas-drawn UI is limited compared with DOM-based UI.
- If the garage grows substantially, this decision may need revisiting.

**Constraints it imposes**

- UI code lives in `src/client/ui` and reads simulation snapshots; it does not hold gameplay state.
- UI must not be the source of truth for anything the server validates.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A web UI framework (React, Vue, Svelte) over the canvas | Two rendering systems, a state bridge, and a build complication for little gain at this stage |
| A game UI framework on top of Babylon | Solves a problem we do not have yet; revisit when the garage exists |
| DOM-based UI layered over the canvas | Same bridging cost as a framework, with worse integration |

## Verification

`package.json` should contain no UI framework dependency. Revisit explicitly at V11, when the garage
is built and the real requirements are known.
