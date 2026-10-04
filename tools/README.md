# Development tooling

Node scripts for driving the running game during development. **None of this ships.** Nothing under
`src/` imports these files, and they are not part of the Vite build.

## Why these exist

The V3R playability pass found several defects that every automated gate passed and that only looking
at the running game could find — most importantly terrain that was entirely invisible because of an
inverted triangle winding. Tests confirmed the normals were correct; only a screenshot showed that
nothing was being drawn.

Having a way to *see* the result turns presentation work from guesswork into iteration.

## `shot.mjs`

Drives the built game in headless Chrome and writes a PNG.

```
npm run build
npx vite preview --port 4173          # in another shell
node tools/shot.mjs shots/my-check --wait=13000
```

Options:

| Flag | Meaning |
|------|---------|
| *(first arg)* | output directory for the screenshot |
| `--wait=<ms>` | how long to let the page settle before capturing (default 9000) |
| `--url=<url>` | page to load (default `http://localhost:4173/`) |
| `--script=<file>` | JS evaluated in the page before capture |

Uses only Node built-ins and a locally installed Chrome or Edge, so it adds **no dependency** to the
project. A minimal DevTools-protocol client lives in `cdp.mjs`.

## `control-check.mjs`

```
npm run controls
```

Serves the built game, opens it, and drives the controls with **real keyboard and mouse events**, then
reports what actually happened to the player:

- which way the tank moved relative to where its **visible glacis mesh** pointed (W and S);
- which way the visible nose swung, and how far the camera moved, for A and D at four headings;
- whether the camera orbits without touching the hull, and whether the hull turns under a stationary camera;
- whether `C` recentres once and then detaches.

This exists because the automated control tests could not see the bug that made V6 unplayable. They compared
throttle direction against the simulation's own forward vector, and the simulation was never wrong: the
*rendered* tank was pointing 180 degrees away from it, and the camera was parented to the hull. A green suite
proved nothing about what the player sees.

It is evidence, not proof. The caveat at the bottom of this file applies here with more force: nothing in this
repository can judge feel.

## `measure-grounding.mjs`

```
npm run grounding
```

Measures the **rendered** tank's clearance above the terrain, at seven stations along each track, on thirteen
poses covering every surface the V6 brief names: flat, slope, rolling, crest, depression, road-to-field,
railway crossing, embankment, and three climbs.

This is how the uneven-ground float was diagnosed and how it is now gated. The report prints three numbers
per pose that matter:

- `max daylight under track` — the owner's bug. Above ~0.12 m it reads as a visible dark line.
- `deepest bite` — how far the track is buried. Reported separately because the obvious fix for daylight is
  to lower the vehicle until it clips, and that fix must be able to fail.
- `floating` — the share of the run with a gap large enough to read as floating, which distinguishes "one end
  lifts on a crest" from "most of the run is off the ground".

It also prints a **sign test** per axis: the terrain's own front-to-rear and left-to-right height difference
against the rendered hull's. This is the check that catches an inverted attitude, which no aggregate gap
number can — a body pitched the wrong way still looks plausible on gentle ground, and only becomes obvious
once the gradient is steep enough. Before the fix it failed on 12 of 13 poses.

## `grounding-shots.mjs`

```
npm run grounding-shots -- shots/grounding
```

Serves the built game, drives headless Chrome, and captures the same thirteen surfaces from a **low side
viewpoint** near wheel height, plus three driving sequences. Every capture reports its own measured gap, so
the index is a numeric record as well as a set of pictures.

Low and to the side is not a stylistic choice: a layout view from 200 m makes a 20 cm gap a fraction of a
pixel, and a view from behind hides the near track behind the far one, so a vehicle resting on one corner still
looks level. Only a low side view makes the contact line readable.

The driving sequences exist because the conforming's failure modes are both invisible in a still — a track
that snaps or that vibrates looks correct in every static frame and wrong in motion. Each drive reports the
worst gap over the run, the largest frame-to-frame change in it (the jitter figure), how far the vehicle
actually travelled, and a `moved` flag, so a drive that failed to move cannot be misread as a clean run.

## `measure-contact.mjs`

```
npm run contact
```

Prints the range and bearing between the two spawns, whether contact exists at spawn, the shortest drive that
opens line of sight, and a survey of candidate opponent spawns ranked by how quickly they would be found. This
is what the V6 spawn pair was measured with, rather than designed on paper.

## The runtime gate

```
npm run runtime           # full gate: build, boot the real page, play it for ~60s
npm run runtime:quick     # same, with a 15s play window, for a faster signal
```

This is the check that matters most, and it is the one V7 was missing. It builds the game, serves the real
bundle, opens a real browser, feeds the game real keyboard input, and then plays for a minute: movement,
steering, camera, turret traverse in both directions, audio unlock and decode, firing, voice accounting,
62 seconds of continuous play, and a restart followed by more play. It writes `runtime-report.json` and a
screenshot, and **exits non-zero** if any check fails, any request 404s, or the page throws.

That last part is the point. Every earlier harness here printed a report and exited 0, which makes it a
diagnostic rather than a gate — and a green diagnostic is exactly what V7 shipped alongside four defects a
player could see in ten seconds. It fails on three independent signals, because each catches things the others
cannot: the mechanical assertions, uncaught exceptions and unhandled rejections, and failed network requests.
The third exists because the checkerboard's eight 404s sat in the console the entire time, unremarked.

Two design points worth knowing before extending it:

- **Checks poll for their effect, they do not sleep for a fixed span.** The software renderer runs at ~4 fps and
  the game advances the simulation by a clamped delta per frame, so a wall-clock wait buys much less simulated
  time than it appears to. The first version of this probe asserted on distances after fixed waits and reported
  two false defects against a tank that was working perfectly. `until(predicate, maxMs)` polls and always has a
  ceiling, so a broken build fails instead of hanging.
- **It asserts mechanics, not taste.** Whether the tank *looks* right and the audio *sounds* right is the
  owner's call. A gate that claimed to judge those would be worse than no gate at all.

## In-page scripts

Passed with `--script`, evaluated in the page against `globalThis.__combatTank`, which exposes the
simulation, scene, HUD, and visuals for inspection.

| Script | Purpose |
|--------|---------|
| `probe.js` | dumps terrain, camera, vehicle, and mesh geometry as JSON |
| `inspect.js` | parks the camera beside the player's tank for silhouette review |
| `fire.js` | drives up and fires at the target, to check combat feedback |
| `ai-duel.js` | lets the V5 opponent fight a parked player and reports what it did |

The game also exposes `setInputFrame(frame)`, which overrides real input for a frame so firing can be
tested without a captured pointer. It is `null` during normal play.

Two diagnostics from the V7 recovery are kept rather than deleted, because they are cited from the source as
the *evidence* for a fix rather than as a claim about one: `webaudio-semantics-probe.js` establishes Web
Audio's buffer-assignment rules directly, and `audio-analysis.mjs` measures the shipped WAVs. Both findings
are now also asserted permanently — the voice ceiling and drain on every gate run — so these corroborate
rather than stand alone.

## Caveats

- Rendering runs through **SwiftShader** (software WebGL), so it is slow but visually representative.
- The harness cannot judge *feel* — weight, recoil, servo rates. Those still need a human at the
  keyboard.
