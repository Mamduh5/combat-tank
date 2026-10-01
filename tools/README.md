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
