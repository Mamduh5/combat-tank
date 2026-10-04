/**
 * The V7 sound set, rendered offline to WAV.
 *
 * ## What a tank actually sounds like, and why each layer exists
 *
 * The brief's requirement is that the player "hear the tank is working harder when I ask more from it".
 * A single loop cannot do that: raising its pitch with speed gives a rising tone, not a rising *load*. So
 * the engine is three separate loops — idle, mid, and full-load growl — cross-faded at runtime by
 * throttle, speed, and acceleration. Layering is what makes an engine read as machinery; a lone sample
 * always reads as a recording of one moment.
 *
 * The gun report is layered for the same physical reason. A real tank report has three distinct parts:
 *
 *  - **crack** — the supersonic snap of the shell passing. A few milliseconds, very bright, very fast.
 *    This is what makes a gun sound *large* rather than merely loud.
 *  - **blast** — the muzzle blast proper: broadband, hard, with a rapid downward sweep.
 *  - **tail** — the report rolling off the landscape and returning, low and slow-decaying over a second or
 *    two, arriving *after* the crack. That delay is most of why a distant gun feels distant.
 *
 * Impacts are separated by outcome because the brief requires the player to distinguish them by ear:
 * penetration is a heavy low crunch, a blocked hit is a bright armour clang with no low end, a ricochet is
 * a descending metallic scrape, terrain is dry and dull. Reusing one impact sound would destroy the
 * distinction the armour model exists to teach.
 *
 * ## Provenance
 *
 * Every sound here is **generated in-project** by this file. No samples are recorded, downloaded, or
 * licensed. See `docs/audio-design.md`.
 */

export const SAMPLE_RATE = 44100;

/** Deterministic noise, so a regenerated asset is byte-identical and reviewable in a diff. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** One-pole lowpass, in place. Cheap, and enough to shape noise into something with body. */
function lowpass(samples, cutoffHz, sampleRate = SAMPLE_RATE) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  let prev = 0;
  for (let i = 0; i < samples.length; i += 1) {
    prev += alpha * (samples[i] - prev);
    samples[i] = prev;
  }
  return samples;
}

/** One-pole highpass, in place. Removes the DC and rumble that would otherwise muddy a transient. */
function highpass(samples, cutoffHz, sampleRate = SAMPLE_RATE) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt);
  let prevIn = samples[0] ?? 0;
  let prevOut = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const input = samples[i];
    prevOut = alpha * (prevOut + input - prevIn);
    prevIn = input;
    samples[i] = prevOut;
  }
  return samples;
}

/** A resonant bandpass by cascading lowpasses and subtracting, which gives a metallic "ring". */
function bandpass(samples, centreHz, q, sampleRate = SAMPLE_RATE) {
  const width = Math.max(20, centreHz / q);
  const copy = Float32Array.from(samples);
  lowpass(copy, centreHz + width, sampleRate);
  lowpass(copy, centreHz - width, sampleRate);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] -= copy[i] * 0.85;
  }
  return samples;
}

/** Multiplies by an exponential decay with a short attack, so the sound does not click on start. */
function decay(samples, timeConstantSeconds, attackSeconds = 0.001, sampleRate = SAMPLE_RATE) {
  const attack = Math.max(1, Math.floor(sampleRate * attackSeconds));
  for (let i = 0; i < samples.length; i += 1) {
    const env = i < attack ? i / attack : Math.exp(-(i - attack) / (sampleRate * timeConstantSeconds));
    samples[i] *= env;
  }
  return samples;
}

/** Allocates a mono buffer of `seconds`, optionally pre-filled with deterministic noise. */
function buffer(seconds, { noise = false, seed = 1 } = {}) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  if (noise) {
    const rng = makeRng(seed);
    for (let i = 0; i < n; i += 1) {
      out[i] = rng();
    }
  }
  return out;
}

/** Adds `src` into `dst` at an offset with a gain. The mixer every layered sound is built from. */
function mixInto(dst, src, offsetSeconds, gain = 1) {
  const offset = Math.floor(offsetSeconds * SAMPLE_RATE);
  for (let i = 0; i < src.length; i += 1) {
    const j = offset + i;
    if (j < 0 || j >= dst.length) {
      continue;
    }
    dst[j] += src[i] * gain;
  }
  return dst;
}

/**
 * The main gun report, returned as separately-usable layers rather than one file.
 *
 * The runtime needs to place the crack and the tail differently: the crack is directional and bright, the
 * tail arrives late and is mostly low. Baking them together would force one filter over a sound that needs
 * two, and the whole reason for reporting them apart is so the audio layer can treat them apart.
 */
export function gunFire() {
  // Crack: a few milliseconds of very bright noise. The gap between "a snap" and "a bang" is the gap
  // between a starter pistol and a tank gun, and the ear uses it to judge weapon size.
  const crack = buffer(0.05, { noise: true, seed: 11 });
  highpass(crack, 2200);
  decay(crack, 0.006, 0.0004);

  // Blast: broadband with a rapid downward sweep, which is what a muzzle blast physically is.
  const blast = buffer(0.45, { noise: true, seed: 23 });
  lowpass(blast, 4200);
  for (let i = 0; i < blast.length; i += 1) {
    blast[i] *= 1 - (i / blast.length) * 0.92;
  }
  decay(blast, 0.11, 0.0015);

  // The low thump: what carries at range. Felt more than heard.
  const thump = buffer(0.6, { noise: true, seed: 37 });
  lowpass(thump, 130);
  decay(thump, 0.17, 0.004);

  // Tail: the report rolling off the valley and back. Long, low, quiet, and swelling rather than starting —
  // a distant report arrives gradually, and that is most of why it sounds distant.
  const tail = buffer(2.4, { noise: true, seed: 53 });
  lowpass(tail, 380);
  const tailIn = Math.floor(SAMPLE_RATE * 0.06);
  const tailOut = Math.floor(SAMPLE_RATE * 1.1);
  for (let i = 0; i < tail.length; i += 1) {
    tail[i] *= Math.min(1, i / tailIn) * Math.min(1, (tail.length - i) / tailOut) * 0.55;
  }

  return { crack, blast, thump, tail };
}

/**
 * A round penetrating armour: heavy, low, and internal.
 *
 * The character is a *crunch* — low-mid noise with a metallic edge — rather than a ring. A penetrator
 * punching through plate is an energy event, not a struck bell, and a clang here would wrongly tell the
 * player it bounced.
 */
export function armourPenetration() {
  const out = buffer(0.9, { noise: true, seed: 71 });
  lowpass(out, 900);
  // Crush the top end: dull and heavy, which is the audible difference from a bounce.
  decay(out, 0.13, 0.002);

  // The internal spall tearing through the fighting compartment, a moment later and higher.
  const spall = buffer(0.7, { noise: true, seed: 73 });
  bandpass(spall, 1700, 2.5);
  decay(spall, 0.1, 0.001);
  mixInto(out, spall, 0.035, 0.7);

  // Low thump underneath, so it has weight.
  const body = buffer(0.8, { noise: true, seed: 79 });
  lowpass(body, 110);
  decay(body, 0.2, 0.004);
  mixInto(out, body, 0, 0.9);

  return out;
}

/**
 * A round stopped by armour: a bright, ringing clang with no low end.
 *
 * Deliberately the opposite spectral shape to a penetration. "Did my shell go through or not" is the single
 * most important piece of information a shot produces, so it is encoded in *timbre* and not only in HUD
 * text — which is precisely what the brief asks for.
 */
export function armourBlocked() {
  const out = buffer(1.1, { noise: true, seed: 83 });
  // A plate struck rings at several frequencies at once, so two metallic partials plus a transient.
  bandpass(out, 2600, 14);
  decay(out, 0.3, 0.0008);
  const partial = buffer(1.1, { noise: true, seed: 89 });
  bandpass(partial, 1450, 18);
  decay(partial, 0.42, 0.0008);
  mixInto(out, partial, 0, 0.8);
  const hit = buffer(0.06, { noise: true, seed: 97 });
  highpass(hit, 1800);
  decay(hit, 0.008, 0.0003);
  mixInto(out, hit, 0, 0.9);
  return out;
}

/**
 * A ricochet: a sharp metallic scrape that falls away.
 *
 * The pitch *descends* across the sound, the audible signature of a projectile losing energy as it
 * deflects. A rising version would read as something accelerating away, which is the opposite event.
 */
export function ricochet() {
  const out = buffer(0.8, { noise: true, seed: 101 });
  // Sweep the bandpass down the buffer in blocks: cheaper and more controllable than a time-varying
  // filter, and the stepping is inaudible at this block size.
  const block = 512;
  for (let start = 0; start < out.length; start += block) {
    const t = start / out.length;
    const centre = 3400 * Math.pow(0.18, t);
    const end = Math.min(out.length, start + block);
    const slice = out.slice(start, end);
    bandpass(slice, centre, 12);
    decay(slice, 0.05, 0.0005);
    out.set(slice, start);
  }
  return out;
}

/**
 * A vehicle being destroyed: an internal cook-off, not just an explosion.
 *
 * Layered deliberately — a bright flash-over, a long low roar, and a metallic collapse as the hull gives
 * way. The brief requires destruction to be unmistakable, and this is the one sound that ends a battle, so
 * it is allowed to be the longest and loudest thing in the set.
 */
export function vehicleDestroyed() {
  const out = buffer(3.2, { noise: true, seed: 131 });
  lowpass(out, 1400);
  // A slow, heavy decay rather than a sharp one: a burning hull, not a hand grenade.
  for (let i = 0; i < out.length; i += 1) {
    const t = i / out.length;
    out[i] *= Math.exp(-t * 3.4) * (1 - t * 0.5);
  }
  const flash = buffer(0.4, { noise: true, seed: 137 });
  highpass(flash, 900);
  decay(flash, 0.06, 0.001);
  mixInto(out, flash, 0, 0.8);
  // The deep roar underneath, felt rather than heard.
  const roar = buffer(2.8, { noise: true, seed: 139 });
  lowpass(roar, 90);
  decay(roar, 0.9, 0.01);
  mixInto(out, roar, 0, 1.0);
  // Armour and tracks collapsing inward, offset so it reads as a *sequence* of failures.
  const collapse = buffer(1.4, { noise: true, seed: 149 });
  bandpass(collapse, 800, 3);
  decay(collapse, 0.35, 0.003);
  mixInto(out, collapse, 0.22, 0.6);
  return out;
}

/**
 * One engine loop, at a given load.
 *
 * A stack of detuned partials over a low rumble rather than a single oscillator, because one tone reads as
 * a synth and a stack reads as an engine. Three loads are rendered so the runtime can cross-fade between
 * them and get a genuinely different *character* at full load, not merely a faster version of idle.
 *
 * @param {number} load 0 for idle, 1 for full load. Sets pitch, harmonic content, and roughness.
 */
export function engineLoop(load, seconds = 1.0) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);

  // Base firing frequency. Idle sits near 32 Hz with lumpy combustion; full load is faster and harder.
  const baseHz = 32 + load * 26;

  // Harmonics: idle has almost nothing above the fundamental, while full load brings the upper partials up
  // sharply. That brightening is the "load" cue more than the pitch rise is, which is why every harmonic's
  // gain scales with load rather than being constant.
  const partials = [
    { ratio: 1, gain: 1.0 },
    { ratio: 2, gain: 0.28 + load * 0.5 },
    { ratio: 3, gain: 0.06 + load * 0.34 },
    { ratio: 4, gain: 0.02 + load * 0.26 },
    { ratio: 5, gain: 0.01 + load * 0.18 },
    { ratio: 6, gain: load * 0.12 },
  ];

  for (const p of partials) {
    for (const detune of [-1, 1]) {
      const hz = baseHz * p.ratio * (1 + detune * 0.004 * p.ratio);
      const omega = (2 * Math.PI * hz) / SAMPLE_RATE;
      for (let i = 0; i < n; i += 1) {
        // A sine plus six harmonics: a band-limited approximation of the exhaust pulse's buzz, without the
        // aliasing a raw sawtooth would produce at these frequencies and sample rates.
        let v = 0;
        for (let k = 1; k <= 6; k += 1) {
          v += Math.sin(omega * k * i) / k;
        }
        out[i] += v * p.gain * 0.12;
      }
    }
  }

  // Combustion lumpiness at the cylinder firing rate: what makes the loop sound like an engine turning over
  // rather than a drone.
  const cylinders = 8;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] *= 1 + Math.sin(2 * Math.PI * baseHz * cylinders * t) * (0.08 + load * 0.16);
  }

  // Mechanical noise floor: valves, fans, and the rattle of a running engine. More of it under load.
  const rng = makeRng(151 + Math.round(load * 10));
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    noise[i] = rng();
  }
  lowpass(noise, 900 + load * 1400);
  highpass(noise, 120);
  for (let i = 0; i < n; i += 1) {
    out[i] += noise[i] * (0.16 + load * 0.3);
  }

  return out;
}


/**
 * A round hitting dirt, ballast, or stone: dry, dull, and short.
 *
 * Shorter and lower than any armour sound on purpose. It has to say "nothing was hit" immediately, and the
 * fastest way to say that is to lack the metallic ring every armour impact has.
 */
export function terrainImpact() {
  const out = buffer(0.5, { noise: true, seed: 113 });
  lowpass(out, 1100);
  decay(out, 0.055, 0.001);
  // A scatter of brighter grit thrown up, which makes it read as soil rather than as a thud.
  const grit = buffer(0.35, { noise: true, seed: 127 });
  bandpass(grit, 3000, 1.6);
  decay(grit, 0.04, 0.001);
  mixInto(out, grit, 0.01, 0.5);
  return out;
}

/**
 * Track and ground movement.
 *
 * Two components: a broadband grind (steel links dragging on soil) and a low rumble (the vehicle''s mass
 * moving). Looped and pitch-shifted at runtime by speed, so one sample covers the whole speed range rather
 * than needing a sample per speed.
 */
export function trackLoop() {
  const n = Math.floor(SAMPLE_RATE * 1.0);
  const out = new Float32Array(n);

  const rng = makeRng(163);
  const grind = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    grind[i] = rng();
  }
  lowpass(grind, 3200);
  highpass(grind, 180);
  for (let i = 0; i < n; i += 1) {
    out[i] += grind[i] * 0.55;
  }

  // Link impacts: short metallic taps at a regular interval, because a track *is* a chain of plates slapping
  // down. Without these it is just noise and does not read as a track at all.
  const linkSamples = Math.floor(SAMPLE_RATE / 9);
  for (let start = 0; start < n; start += linkSamples) {
    const tap = buffer(0.05, { noise: true, seed: 167 + start });
    bandpass(tap, 1400, 4);
    decay(tap, 0.012, 0.0004);
    mixInto(out, tap, start / SAMPLE_RATE, 0.5);
  }

  // Mass rumble underneath.
  const rng2 = makeRng(173);
  const rumble = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    rumble[i] = rng2();
  }
  lowpass(rumble, 120);
  for (let i = 0; i < n; i += 1) {
    out[i] += rumble[i] * 1.1;
  }

  return out;
}

/** Turret traverse: a servo whine plus the ring grinding round as the turret moves. */
export function turretTraverse() {
  const n = Math.floor(SAMPLE_RATE * 1.0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    // The pitch wobble is gear mesh, not vibrato: a servo whine that never changes at all sounds synthetic.
    out[i] = Math.sin(2 * Math.PI * (420 + Math.sin(2 * Math.PI * 3 * t) * 60) * t) * 0.35;
  }
  const rng = makeRng(179);
  const grind = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    grind[i] = rng();
  }
  bandpass(grind, 900, 2);
  const fade = Math.floor(SAMPLE_RATE * 0.05);
  for (let i = 0; i < n; i += 1) {
    out[i] += grind[i] * 0.5 * Math.min(1, i / fade) * Math.min(1, (n - i) / fade);
  }
  return out;
}

/** The gun''s mechanical action: breech open, shell in, breech close and lock. */
export function gunMechanism() {
  const out = buffer(1.4);
  // Three mechanical events in sequence. A single metallic click reads as a UI sound; a short *sequence*
  // reads as a mechanism cycling, which is what a loader doing his job actually sounds like.
  const events = [
    { at: 0.0, hz: 1800, len: 0.14, gain: 0.7 },
    { at: 0.42, hz: 1200, len: 0.2, gain: 0.6 },
    { at: 0.78, hz: 2400, len: 0.18, gain: 0.8 },
  ];
  for (const e of events) {
    const len = Math.floor(SAMPLE_RATE * e.len);
    const rng = makeRng(191 + Math.round(e.at * 100));
    const part = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      part[i] = rng();
    }
    bandpass(part, e.hz, 5);
    decay(part, 0.03, 0.0006);
    mixInto(out, part, e.at, e.gain);
  }
  const thud = buffer(0.5, { noise: true, seed: 193 });
  lowpass(thud, 200);
  decay(thud, 0.06, 0.002);
  mixInto(out, thud, 0.02, 0.5);
  return out;
}

/** Basic UI feedback: a short confirming blip for reload-complete and battle result. */
export function uiConfirm() {
  const out = buffer(0.28);
  const n = out.length;
  // A two-note rise, which reads as "something good happened" rather than as an error.
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] = Math.sin(2 * Math.PI * (t < 0.09 ? 620 : 830) * t) * 0.5;
  }
  decay(out, 0.09, 0.004);
  return out;
}

/** A duller, descending variant for defeat. */
export function uiFail() {
  const out = buffer(0.5);
  const n = out.length;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] = Math.sin(2 * Math.PI * (420 - t * 320) * t) * 0.5;
  }
  decay(out, 0.2, 0.006);
  return out;
}
