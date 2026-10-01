# 0007. Kinematic tank locomotion; Rapier is for queries, not for driving

- **Status:** Accepted (settles OD-12)
- **Date:** 2026-10-01
- **Affects:** `src/core/vehicle/**`, `src/client/physics/**`

## Context

The version plan required settling OD-12 during V1: should the tank be driven by an explicit model
in the core, or by Rapier's rigid-body `DynamicRayCastVehicleController` (a port of Bullet's
`btRaycastVehicle`)? Both are defensible, so the choice was made against the project's own
requirements rather than by preference.

The requirements that decide it:

1. Tank handling is a *designed feel*. Vision principle P5 says heavy is a feature, and the handling
   numbers (top speed, reverse speed, hull traverse rate, time to full traverse) must be values a
   designer sets and a player learns.
2. The server must reproduce a player's movement exactly from V9 onward.
3. Rapier's vehicle controller is a **car** model: engine force, brake force, steering angle. Tanks
   steer by differential track speed and have no steering wheel.
4. The vehicle controller derives steering from wheel suspension ray-casts, which makes behaviour
   sensitive to contact ordering and to what else is touching the vehicle.

## Decision

Tank locomotion is an **explicit kinematic model** in `src/core/vehicle`, integrated by the core on
its own fixed tick. Drive acceleration comes from the vehicle definition's `driveForceN / massKg`;
speed is rate-limited toward a gradient-dependent limit; hull traverse ramps toward a requested
rate. Rapier is used only for **collision queries** — the terrain mesh, camera obstruction ray
casts, and the line-of-sight test V6 will need.

A second, smaller decision follows from the same reasoning: the vehicle's **ground contact uses the
analytic terrain function**, not a downward ray cast against the collision mesh. A ray cast against a
sampled mesh quantises the height to the grid, which shows up as visible jitter as the vehicle crosses
cells — precisely what the V1 acceptance criterion forbids. The analytic function is exact and costs
one function call.

## Consequences

**Positive**

- Every handling number lives in the vehicle definition and is directly tunable (ADR-0003).
- Movement is cheap and predictable, which matters when a server simulates many tanks.
- The model is fully covered by unit tests with no physics engine involved.
- The core stays free of any physics dependency, so its tests need no WASM.

**Negative / costs**

- Vehicle-versus-vehicle pushback and getting pushed by explosions are not handled; there is no
  rigid body to react. This must be added deliberately later, most likely as an explicit
  displacement response in the core rather than by reintroducing a solver.
- Terrain features the analytic function cannot express (overhangs, bridges, multi-level geometry)
  need a different grounding approach when V6 introduces authored maps.

**Constraints it imposes**

- The core contains no physics-engine code. Rapier appears only under `src/client`.
- Movement must remain expressible from a `VehicleDefinition` alone.
- Grounding must come from an exact surface query, not a sampled one.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Rapier `DynamicRayCastVehicleController` | A car model; handling is emergent rather than designed, and is contact-order sensitive |
| Rapier dynamic rigid body with track forces | Same objections, plus tuning a tank through friction coefficients is far less legible than setting a traverse rate |
| Query the collision mesh for ground height | Quantised to the grid, producing the jitter V1 explicitly forbids |

## Verification

`tests/core/locomotion.test.ts` runs the same simulation code against several vehicle definitions and
asserts the measured behaviour follows the data — a hard-coded top speed or acceleration would fail
those tests. The agreement between the analytic surface and the collision mesh is asserted in
`tests/integration/client-boot.test.ts`.
