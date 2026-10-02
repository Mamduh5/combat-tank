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

## `measure-contact.mjs`

```
npm run contact
```

Prints the range and bearing between the two spawns, whether contact exists at spawn, the shortest drive that
opens line of sight, and a survey of candidate opponent spawns ranked by how quickly they would be found. This
is what the V6 spawn pair was measured with, rather than designed on paper.

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

## Caveats

- Rendering runs through **SwiftShader** (software WebGL), so it is slow but visually representative.
- The harness cannot judge *feel* — weight, recoil, servo rates. Those still need a human at the
  keyboard.
