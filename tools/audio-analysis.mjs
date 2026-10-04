/**
 * Offline audio analysis: measures the *waveform* of every shipped sound, not just whether it decodes.
 *
 * ## Why this exists
 *
 * The V7 audit proved that 17 audio buffers decode. Every one of those buffers also decodes perfectly while
 * sounding like a broken television. "It decoded" is a statement about the container, not about the sound.
 *
 * So this measures the things that actually make audio sound corrupt:
 *
 * | Metric | What it catches |
 * |---|---|
 * | `peak` | amplitude at or over full scale — clipping, which is what a square-ish wave reads as |
 * | `rms` | how much signal there is at all; a near-zero RMS is silence, a near-peak RMS is a wall |
 * | `crestFactor` (peak/rms) | the diagnostic number. Speech and gunfire are ~4-12; white noise is ~1.4-2 |
 * | `clippedSamples` | how many samples are pinned at full scale |
 * | `zeroCrossingRate` | a proxy for brightness and harshness |
 * | `dominantHz` | what pitch the loop actually sits at, to catch a runaway oscillator |
 * | `wrapDiscontinuity` | a loop whose ends do not meet, which ticks audibly every cycle |
 *
 * A crest factor near 1 is the "broken TV" signature: noise-like, flat amplitude, no transient structure.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'public/assets/audio');

/** Decodes a 16-bit PCM WAV to a Float32Array in [-1, 1]. */
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') {
      fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.format !== 1) throw new Error(`format ${fmt.format} is not PCM`);
  if (fmt.bits !== 16) throw new Error(`${fmt.bits}-bit is not 16-bit PCM`);
  const n = Math.floor(data.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = data.readInt16LE(i * 2) / 32768;
  return { samples: out, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

/** Coarse log-spaced Goertzel sweep, to find which frequency band actually carries the energy. */
function dominantFrequency(samples, sampleRate) {
  let bestHz = 0;
  let bestEnergy = -1;
  const step = Math.max(1, Math.floor(samples.length / 8000));
  for (let hz = 20; hz < Math.min(12000, sampleRate / 2); hz = Math.round(hz * 1.15)) {
    const w = (2 * Math.PI * hz) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < samples.length; i += step) {
      const s0 = samples[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const energy = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    if (energy > bestEnergy) { bestEnergy = energy; bestHz = hz; }
  }
  return bestHz;
}
function analyse(name, samples, sampleRate) {
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let crossings = 0;
  let dc = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped += 1;
    sumSq += v * v;
    dc += v;
    if (i > 0 && (samples[i - 1] < 0 !== v < 0)) crossings += 1;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  const seconds = samples.length / sampleRate;
  return {
    name,
    seconds: Number(seconds.toFixed(3)),
    sampleRate,
    peak: Number(peak.toFixed(4)),
    rms: Number(rms.toFixed(4)),
    /** The broken-TV detector: ~1 means noise-like with no transient structure. */
    crestFactor: Number((peak / Math.max(1e-6, rms)).toFixed(2)),
    clippedPercent: Number(((clipped / samples.length) * 100).toFixed(3)),
    dcOffset: Number((dc / samples.length).toFixed(5)),
    zeroCrossingRate: Number((crossings / seconds).toFixed(0)),
    dominantHz: dominantFrequency(samples, sampleRate),
    /** A loop with a discontinuity at the wrap point ticks audibly every cycle. */
    wrapDiscontinuity: Number(Math.abs(samples[0] - samples[samples.length - 1]).toFixed(5)),
  };
}

const rows = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.wav')).sort()) {
  try {
    const { samples, sampleRate } = decodeWav(readFileSync(join(DIR, file)));
    rows.push(analyse(file.replace('.wav', ''), samples, sampleRate));
  } catch (e) {
    rows.push({ name: file, error: e.message });
  }
}

console.log(
  ['sound'.padEnd(20), 'sec'.padStart(6), 'peak'.padStart(7), 'rms'.padStart(7), 'crest'.padStart(7),
   'clip%'.padStart(7), 'zcr/s'.padStart(8), 'domHz'.padStart(7), 'wrap'.padStart(8)].join(' '),
);
console.log('-'.repeat(88));
for (const r of rows) {
  if (r.error) { console.log(`${r.name.padEnd(20)} ERROR: ${r.error}`); continue; }
  console.log(
    [r.name.padEnd(20), r.seconds.toFixed(3).padStart(6), r.peak.toFixed(3).padStart(7),
     r.rms.toFixed(3).padStart(7), r.crestFactor.toFixed(2).padStart(7),
     r.clippedPercent.toFixed(2).padStart(7), r.zeroCrossingRate.toFixed(0).padStart(8),
     String(r.dominantHz).padStart(7), r.wrapDiscontinuity.toFixed(3).padStart(8)].join(' '),
  );
}

console.log('\n--- flags ---');
for (const r of rows) {
  if (r.error) continue;
  const flags = [];
  if (r.crestFactor < 2.0) flags.push(`NOISE-LIKE crest=${r.crestFactor} (broken-TV signature)`);
  if (r.clippedPercent > 0.5) flags.push(`CLIPPING ${r.clippedPercent}%`);
  if (r.peak > 0.99) flags.push('AT FULL SCALE');
  if (r.rms > 0.3) flags.push(`LOUD rms=${r.rms} (stacks into a wall when mixed)`);
  if (r.wrapDiscontinuity > 0.3) flags.push(`LOOP CLICK wrap=${r.wrapDiscontinuity}`);
  if (r.dominantHz > 4000) flags.push(`HARSH dominant=${r.dominantHz}Hz`);
  if (flags.length) console.log(`${r.name}: ${flags.join('; ')}`);
}