# 0009. Renderer and physics share one terrain mesh; collision uses a trimesh

- **Status:** Accepted
- **Date:** 2026-10-01
- **Affects:** `src/core/world/terrain-grid.ts`, `src/client/render/scene.ts`,
  `src/client/physics/rapier-terrain.ts`, and all future map work.

## Context

V1 needs the visible terrain and the collision terrain to be the same surface. Two independent
samplings of the same height function can disagree, and the symptom — a tank hovering over a hill or
a camera clipping through ground — reads as a terrain bug rather than as two samplings drifting
apart.

This ADR also settles a Rapier-specific trap discovered during V1 implementation.

## Decision

**One geometry source.** `src/core/world/terrain-grid.ts` samples the analytic terrain into a
vertex/index buffer. Both the Babylon mesh and the Rapier collider are built from that same buffer.
The render mesh is 160 cells; the collision mesh is 128, because collision does not need visual
fidelity and a static trimesh's cost scales with triangle count.

**A trimesh, not a heightfield.** Rapier's `ColliderDesc.heightfield(nrows, ncols, heights, scale)`
takes a flat height array whose index-to-axis mapping is not evident from its signature. Getting it
wrong produces a collider that is quietly rotated or mirrored, and the resulting terrain looks
plausible while disagreeing with the simulation by tens of metres. `ColliderDesc.trimesh(vertices,
indices)` takes explicit vertices and explicit triangle indices, so there is no convention to infer.
It also has the useful property of matching the rendered mesh exactly, which is what camera
obstruction needs.

**Terrain wavelengths are a design constraint.** The ridge layers are specified as wavelengths in
metres, not angular frequency, because a sine layer's steepest gradient is
`amplitude * 2*PI / wavelength`. The first implementation used frequencies of 0.6–1.6 rad/m — a
wavelength of 4–10 m — which produced corrugated noise no practical collision grid could represent,
and slopes that were near-vertical rather than drivable. Wavelengths (340/170/95 m) make the intent
legible and the gradient bound checkable.

## Consequences

**Positive**

- The visible and collision surfaces cannot drift apart; they are the same buffer.
- No Rapier heightfield convention to infer or get wrong.
- The wavelength-as-design-constraint rule makes "is this terrain drivable?" a calculation rather
  than a judgement call.
- V6 maps can be authored as geometry and will get collision for free.

**Negative / costs**

- The collision mesh is a triangle soup, so Rapier builds a BVH for it. A 128-cell static mesh
  (~33k triangles) is cheap, but much larger maps will need the resolution revisited.
- Sampling error means the collision surface is approximate. It is bounded by the shortest
  wavelength divided by the cell size, currently under 0.2 m.
- Grounding the vehicle still uses the analytic surface rather than the mesh (ADR-0007), so there
  are two representations of the ground by design. The integration test pins them together.

**Constraints it imposes**

- Terrain geometry is generated once and shared; nothing may sample the height function independently
  for rendering or collision.
- New terrain features must remain representable on a single-valued height surface. Overhangs and
  multi-level geometry need a different approach, expected no earlier than V6.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Rapier `heightfield` | Index-to-axis mapping is not inferable from the signature; a wrong guess is silent |
| Separate meshes for rendering and collision | Two independent samplings, free to disagree, with a failure mode that looks like a terrain bug |
| Grounding the vehicle against the collision mesh | Quantised to the grid, producing the jitter V1's acceptance criteria forbid |
| Collision queries against the analytic function only | Not possible for arbitrary rays; V2 shells and V6 line of sight need a general collider |

## Verification

`tests/integration/client-boot.test.ts` drives the real `PhysicsWorld` and asserts the collider's
sampled heights match the analytic surface to within 0.5 m, that normals point upward, that a ridge
blocks line of sight, and that a driven vehicle never ends up below the collision surface.
