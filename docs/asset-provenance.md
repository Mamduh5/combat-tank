# Asset provenance

**Every asset in this project is generated in-project by code. Nothing is downloaded, imported, sampled,
recorded, or licensed from anywhere.**

This is recorded here rather than only in ADR-0015 because the practical question is not "what did we decide"
but "can I ship this, and can a stranger check the answer without reading an architecture decision record".

## The answer

| Question | Answer |
| --- | --- |
| Are any assets third-party? | **No.** |
| Are there licence obligations attached to any asset? | **No.** |
| Is there attribution to include? | **No.** |
| Can the assets be redistributed freely? | **Yes.** |
| Are the binary assets committed to the repository? | **Yes** — `public/assets/` is not gitignored, so a fresh clone runs without an asset build step. |
| Can they be regenerated? | `npm run assets` — deterministically, byte for byte, so committing them costs nothing in review burden. |

## Why it works this way

Sourcing a model or a sound effect raises licensing and redistribution questions immediately. A tank model
downloaded from an asset library carries terms that must be checked, recorded, and complied with in every build
that ships it. For a prototype whose entire purpose is to be replaced later, that is a poor trade: the licence
obligations outlive the asset.

Generating everything in-project costs modelling and synthesis effort, and buys a property no downloaded asset
can offer — the obligation is zero, and it stays zero.

## What that costs

Stated plainly, because the upside is not free:

- These are **prototypes, not production assets.** Primitive topology, low triangle counts, no animation rig,
  synthesised sound. They must not be presented as finished art.
- Procedural geometry is **tunable rather than commissioned.** A silhouette problem is fixed by changing a
  number and re-running, not by a modelling session — genuinely valuable at this stage.
- Replacing them with real art is **a real cost, not a swap.** The pipeline is the deliverable that makes the
  swap possible; see `docs/asset-pipeline.md`.

## How to verify this for yourself

Three commands, none of which require trusting this document:

```bash
npm run assets        # rebuild everything from source
git status            # clean: the output is byte-identical
npm run assets:audit  # the shipped files load and satisfy the contract
```

`tests/tools/asset-pipeline.test.ts` additionally asserts that `manifest.json` records the provenance string,
and that every file the manifest lists exists on disk.

## Provenance by category

| Category | Source | File |
| --- | --- | --- |
| Vehicle models | `tools/lib/tank-model.mjs` + `tools/lib/mesh.mjs` | `models/ct-*.glb` |
| Environment props | `tools/lib/prop-models.mjs` | `models/props.glb` |
| Textures | `tools/lib/textures.mjs`, `texture-lib.mjs` | `textures/*.png` |
| Audio | `tools/lib/sounds.mjs`, `wav.mjs` | `audio/*.wav` |
| Manifest | `tools/build-assets.mjs` | `manifest.json` |

## Determinism

The generators use seeded value noise and fixed sample rates, with no clock, no `Math.random`, and no
environment lookups. Two runs produce byte-identical output, which is what makes `git status` above a
meaningful check rather than a formality.

This matters beyond tidiness: an asset that changes on every build cannot be reviewed in a diff, and a reviewer
who sees a 6 MB binary churn cannot tell a deliberate change from noise.

## Fonts and text

The game draws no text in 3D. All typography is HTML in the HUD, rendered with system font stacks. No font
files are bundled, so none are licensed.