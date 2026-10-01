# The headless battle harness

`npm run sim` runs real battles with no renderer, no browser and no client: the same `Simulation`,
`Battle` and `EnemyController` the game itself uses, advanced as fast as the CPU allows. It exists so
that questions about the opponent and about balance can be answered with **numbers** instead of with
impressions from one playthrough.

## Quick start

```
npm run sim                                    10 mixed battles, seeds 1-10
npm run sim -- --help                          every option
npm run sim -- --scenario parked              the frontal-armour case from ADR-0016
npm run sim -- --battles 50 --seed 1000        a wider sweep from seed 1000
npm run sim -- --seed 4242 --battles 1        replay exactly one seed
npm run sim -- --battles 5 --json > r.json     save the full report
```

## Options

| Option | Meaning | Default |
| --- | --- | --- |
| `--battles <n>` | How many battles to run. | 10 |
| `--seed <n>` | First seed. Seeds are **consecutive**, so `--battles 5 --seed 100` runs 100-104. | 1 |
| `--scenario <s>` | Player behaviour: `parked`, `circling`, `charging`, `retreating`, `mixed`. | `mixed` |
| `--ticks <n>` | Tick budget per battle. | 7200 (2 min) |
| `--seconds <n>` | The same budget in seconds, which is easier to read. | — |
| `--json` | Print the full report as JSON instead of a summary. | off |
| `--help` | Usage. | — |

A bad argument is **rejected**, not ignored. A batch that silently ran with a default the caller did not
intend would produce numbers that look valid and describe a different experiment, which is worse than
refusing to start.

## Player scenarios

The player is a **script**, not a stub, and it produces the same `InputCommand` a keyboard does — so the
player side of every battle obeys exactly the same rules as the opponent's. No script ever fires, so
every shell in a batch belongs to the opponent.

| Scenario | What the player does | What it is for |
| --- | --- | --- |
| `parked` | Nothing at all. | The frontal-armour case: can the opponent defeat someone who never moves? |
| `circling` | A steady lateral arc. | The hardest case for a finite turret traverse, and the one that exposed the loss-of-contact defect. |
| `charging` | Full throttle, hull steered at the opponent. | The fastest possible approach; the case that exposed the opponent closing out of its own firing range. |
| `retreating` | Reverses and steers away. | Whether the opponent can keep up. Surfaces OD-15. |
| `mixed` | A scripted sequence of all of the above. | The default. One battle contains several kinds of exchange. |

Note that driving toward something means commanding `turn`, **not** supplying an aim point. In this game
the aim point servos the turret and does not move the hull — a distinction the harness learned the hard
way, and one `tests/tools/batch-runner.test.ts` now pins.

## Reading the output

```
Combat Tank - headless battles   scenario=mixed  seeds=1..10  budget=120s

  outcome      victory  defeat  timeout
  battles          10       0       2       8

  opponent shooting
    shells fired        98
    struck the player   82   (hit rate 84%)
    penetrations        46   (of strikes 56%)
    damage dealt        6900
```

- **outcome** — `victory` means the player destroyed the opponent, `defeat` the player was destroyed,
  `timeout` the clock ran out. No scripted player ever fires, so **`victory` is always 0**: the harness has
  no player gunnery to measure. A batch of timeouts means the opponent did not finish the player off
  within the budget, which is a fact about the budget as much as about the opponent.
- **hit rate** — shells fired that reached the player at all, whether or not they penetrated. This is the
  gunnery measure.
- **penetration rate** — of those that struck, how many got through. This is the **armour model's**
  verdict, not the opponent's choice, and it is the number to watch when armour is being changed.
- **decided battle** — mean length of battles that reached a decision. Timeouts are excluded: a timeout
  lasted exactly as long as it was allowed to, so including it would make a batch of stalled fights look
  like a batch of long ones.
- **seen, gun idle** — ticks where the opponent could see the player, its gun was loaded, and it did not
  fire. Some of this is normal gun-laying time; a lot of it is not.
- **max range** — the furthest the two tanks got apart. A sudden growth means contact was lost.
- **ended in** — the opponent's intent on the last tick. `engage` is healthy; a run of `search` at the end
  means it lost the player.

## Suspect seeds

A battle is flagged when it looks like a **defect** rather than a hard fight:

| Flag | Means |
| --- | --- |
| `saw the player and did not fire for Ns` | The gun was never laid. A convergence failure. |
| `never fired` | No shells in the whole battle. |
| `fired N shells and struck the player with none` | The aim solution is wrong, not the gunner unlucky. |

The bar is deliberately high. A battle the opponent lost is **not** flagged, however lopsided — flagging
ordinary hard fights would train everyone to ignore the list.

Each flag prints the seed and a command to replay it:

```
seed 2 (retreating): saw the player and did not fire for 93.0s (5581 ticks)
```

## Determinism

A battle is a pure function of `(seed, scenario, tick budget)` (ADR-0005), and nothing in the runner reads
a clock. The same options always produce a byte-identical report, so a seed that looks wrong can be
replayed rather than merely described. `tests/tools/batch-runner.test.ts` asserts this on the full report
object, not on a summary, and separately asserts that *different* seeds produce *different* battles — a
"reproducibility" that was really a constant would pass the first test and be worthless.

## Where the code is

| File | Role |
| --- | --- |
| `src/tools/headless/scenarios.ts` | The scripted players. Pure functions of tick and context. |
| `src/tools/headless/batch-runner.ts` | Runs battles and aggregates them. Imports the real game. |
| `src/tools/headless/report.ts` | Text and JSON rendering. |
| `tools/sim.mjs` | The CLI. Argument parsing and Node glue only; the rest is game code. |
| `tests/tools/batch-runner.test.ts` | Reproducibility, aggregation, and suspect detection. |

The split exists so the runner is covered by the same typecheck, lint and tests as everything else. The
CLI is JavaScript because argument parsing and stdout are genuinely Node's job; the runner is TypeScript
because it is game code. `src/tools/**` may import both core and shells, which is what
`docs/technical-direction.md` §3 reserves it for.
