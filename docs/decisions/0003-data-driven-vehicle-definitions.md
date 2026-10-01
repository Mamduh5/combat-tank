# 0003. Data-driven vehicle definitions with a validated schema

- **Status:** Accepted (proposed at V0 planning; implement in V1, prove in V8)
- **Date:** 2026-10-01
- **Affects:** `src/shared/vehicle-defs`, `src/core/vehicle`, `src/core/armor`, `src/client/render`.

## Context

`docs/vision.md` principle P7 requires that vehicles feel genuinely different and that adding one
must not require rewriting the game. Armor in particular is highly vehicle-specific: plate
thicknesses, positions, and orientations differ per tank, and hard-coding them would make V3 a
version about editing code.

## Decision

A vehicle is **data**: a definition containing mass, dimensions, armour layout, engine power, top and
reverse speed, hull and turret traverse rates, gun parameters, hit points, module definitions, and
visual binding ids. Definitions are **validated at load time** against a schema and fail loudly on
invalid data. The armour layout is a list of named plates, each with thickness, dimensions, and a
local transform.

## Consequences

**Positive**

- Adding a vehicle is a data change; the V8 acceptance criterion is that it requires no code change.
- Balance can be tuned without touching logic.
- The server and client read identical definitions, so there is no chance of them disagreeing.
- Visual placeholders can be replaced with real models by changing a referenced id.

**Negative / costs**

- A schema and a validation layer must exist before the first vehicle is added.
- Designers work with data files rather than code, which requires discipline to keep them meaningful.
- Poorly designed data can encode nonsense combinations; the validator is the only defence.

**Constraints it imposes**

- No gameplay code may hard-code values for a specific vehicle.
- A vehicle definition that fails validation must prevent startup, not degrade silently.
- Presentation references visuals by id and may not influence gameplay values.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Vehicles as TypeScript classes with fields | Adding or tuning a vehicle becomes a code change, and validation is ad hoc |
| Vehicle stats in an external spreadsheet or database | Not versionable alongside the code, and unavailable to the headless runner |
| A generic "armour value" per facing instead of plates | Loses the location-and-angle mechanic that the genre depends on |

## Verification

V8 includes a test that adds a vehicle by data file only, and a test that invalid definitions fail
loudly. `docs/gameplay-systems.md` §5 and `docs/version-plan.md` V3 and V8 depend on this.
