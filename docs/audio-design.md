# Audio design

Combat audio is generated in-project (see `docs/asset-provenance.md`) and mixed at runtime through the Web
Audio API. This document covers what each sound is for, and why the layering and cross-fading work the way
they do.

## Design goals

Three, in priority order. Everything below follows from them.

1. **The player learns the four combat outcomes by ear.** A ricochet, a blocked hit, a penetration and a miss
   must be distinguishable without looking at the HUD. This is why each is a separate asset with its own
   spectrum rather than one impact sound played at four volumes — the ear cannot reliably tell volume
   differences apart, but it distinguishes a bright clang from a low crunch immediately.
2. **The tank sounds like it is working.** The engine responds to throttle, speed and acceleration separately,
   not to a single blended "loudness" value. Flooring it against a slope it cannot climb should sound like
   effort, because it is.
3. **Nothing is a surprise.** Distance is conveyed by level *and* arrival time. There is a limiter on the bus
   so a burst of simultaneous events clips gracefully rather than distorting.

## Categories

### Weapon

| Sound | Role |
| --- | --- |
| `gun-crack` | The supersonic snap. Fastest transient, loudest layer. |
| `gun-blast` | The muzzle shock. Broader and slower than the crack. |
| `gun-thump` | The low body that gives the report weight. |
| `gun-tail` | Arrives late and is mostly low-end. |
| `gun-mechanism` | Breech, shell, breech. Plays on the player's own gun only. |

A single gunshot recording is a compromise: the loud transient that reads as "close" also masks everything
else. Layering lets each part do one job. The tail's delay is scaled by source distance — a gun on the far
side of the map should arrive noticeably later, and a *constant* delay would read as a mix error instead.

Sound-speed delay is capped at 0.55 s. Real propagation over 300 m is nearly a second, which is correct and
sounds like a bug.

### Impacts

| Sound | Outcome |
| --- | --- |
| `impact-penetration` | Round through armour: heavy, low, internal. The loudest impact, because it is the most important feedback in the game. |
| `impact-blocked` | Stopped by armour: bright clang, no low end, so it cannot be confused with a penetration. |
| `impact-ricochet` | Deflected. High, with a rising tail. |
| `impact-terrain` | Dirt or masonry. Dull, short. |

### Vehicle

| Sound | Role |
| --- | --- |
| `engine-idle` / `engine-load` / `engine-full` | Three layers cross-faded by throttle and speed. |
| `tracks` | Continuous, volume follows speed. |
| `turret` | Servo whine while traversing. |
| `destruction` | The loudest thing in the set. It needs to be unmistakable. |

### UI

| Sound | Role |
| --- | --- |
| `ui-confirm` | Reload complete, or a battle won. |
| `ui-fail` | Reload refused, or a battle lost. |

## Engine cross-fading

Three loops of equal base gain, so a vehicle missing a layer is not permanently quieter than one that has all
three. Per-frame weights decide the balance: **idle** at rest, **load** as throttle rises, **full** at speed
under load.

Weights are eased at 2.6/s, so the engine never jumps between layers audibly. Base gains are deliberately low:
this is a continuous bed, not an event. The opponent's engine sits at 0.55 of the player's — a background
presence, not a competitor.

Throttle comes from the vehicle's own telemetry rather than the raw input command, so the engine responds to
the *demand* even while the drive is traction-limited or the tank is stalled. That distinction is the whole
point.

## Spatialisation

Stereo panning with linear distance attenuation, not full 3D HRTF — two reasons:

- A `StereoPannerNode` costs a fraction of a `PannerNode`, and there can be many voices.
- The ear cannot localise *behind itself* precisely. A full angular mapping swings a sound all the way round as
  an enemy drives past, which is far more noticeable than the small loss of precision.

Attenuation is linear to a floor of 0.18 over 260 m, not inverse-square. Inverse-square is physically right and
inaudibly wrong: a shot at 100 m disappears, leaving the player unsure whether their gun fired. The gentle
falloff keeps distant events present but clearly quieter.

The listener pose is derived from the camera each frame. The right vector is `forward` rotated a quarter turn
about +Y, which in Babylon's left-handed space is `(forwardZ, −forwardX)` — the same basis the simulation's
heading uses, so audio pans the way the world turns. Getting this backwards is audible, and worse than no
spatialisation at all.

## Mixing

```
voices --+-- gain -- stereo panner --+
         +-- gain --------------------+--> bus --> limiter --> master --> out
loops --------------------------------+
```

The limiter uses a `WaveShaperNode` with a soft knee rather than hard clipping, which would distort the
transient audibly on every gunshot. It only touches peaks, and the peaks are precisely the ones that would
otherwise clip.

One-shot sounds come from a fixed voice pool. A pool rather than unbounded allocation because a tank fight can
request several impacts in one frame, and node churn shows up as a click.

## Controls

| Input | Effect |
| --- | --- |
| `M` | Mute. Works at any volume, so reaching zero is never a trap. |
| `-` / `=` | Master volume in ten-point steps. |
| `0` | Reset to the authored balance, **not** to silence. Silencing is what `M` is for. |

The `AudioContext` is created on the first click on the canvas, because browsers refuse to start one before a
gesture. Audio loads in the background from that point. A silent game that only becomes audible after the first
click reads as broken, which is why the unlock is on the click the player makes anyway to capture the mouse.

## Known limitations

- **No music.** The engine and weapon sounds carry it; adding a score is a later decision.
- **No distance-dependent filtering.** Real distant gunfire loses its high end; linear attenuation here keeps
  the spectrum. It would need a lowpass on the spatial bus, costing a node per voice.
- **No reverb.** Marlowe Crossing is open country, so this is defensible, but the town would benefit.
- **Mono throughout.** Stereo placement is done with panning, not by rendering the assets in stereo.
- **The opponent's engine is not spatialised.** It uses a fixed relative gain, so it does not pan. Acceptable
  because the player usually knows roughly where the enemy is; wrong when they do not.