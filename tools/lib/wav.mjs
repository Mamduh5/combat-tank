/**
 * A minimal PCM WAV writer.
 *
 * ## Why files rather than only Web Audio oscillators
 *
 * V4's audio was synthesised live from oscillators and noise (`src/client/audio/combat-audio.ts`). That was
 * a reasonable placeholder choice with no assets, but it has a hard ceiling: a gun report built from one
 * filtered noise burst cannot sound like a gun report. Real reports have a sharp supersonic crack, a
 * lower-frequency blast body, and a long rolling tail off the landscape, and the difference between "a
 * noise burst" and "a tank gun" is exactly the difference between a prototype and a game.
 *
 * So the sounds are **rendered offline into WAV files**, committed as assets, and loaded by the runtime.
 * They are still generated in-project — provenance stays clean under ADR-0015 — but the runtime gets a
 * real asset it can layer, filter, and spatialize with `AudioBufferSourceNode`, which an oscillator graph
 * cannot provide without re-deriving the same waveform on every machine anyway.
 *
 * 16-bit mono PCM at 44.1 kHz: mono because every sound here is placed in stereo or 3D by the runtime, so
 * stereo files would double the size for information nothing uses. 44.1 kHz because it is what the Web
 * Audio API resamples to anyway.
 */

/**
 * Encodes mono float samples in [-1, 1] as a 16-bit PCM WAV file.
 *
 * @param {Float32Array} samples interleaved-by-1 mono samples
 * @param {number} sampleRate samples per second
 * @returns {Buffer} the complete WAV file
 */
export function encodeWav(samples, sampleRate = 44100) {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const out = Buffer.alloc(44 + dataBytes);

  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');

  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16); // PCM header size
  out.writeUInt16LE(1, 20); // format 1 = PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  out.writeUInt16LE(bytesPerSample, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample

  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    // Clamped, not wrapped: a sample above 1.0 must not fold round into a loud opposite-polarity spike,
    // which is how an over-driven render turns into a click.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample);
  }

  return out;
}

/**
 * Normalises a rendered buffer to a target peak.
 *
 * Rendering is additive and can drift above full scale; the alternative is hand-tuning every generator to
 * land under 1.0, which fails silently the moment a value changes. Normalising afterwards means the
 * *relative* balance between sounds is authored, and the absolute level is a separate, adjustable step.
 */
export function normalize(samples, peak = 0.92) {
  let max = 0;
  for (const s of samples) {
    max = Math.max(max, Math.abs(s));
  }
  if (max < 1e-6) {
    return samples;
  }
  const scale = peak / max;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= scale;
  }
  return samples;
}

/** Applies a short fade at each end, so a sound neither clicks on start nor cuts off abruptly. */
export function fadeEdges(samples, sampleRate, seconds = 0.004) {
  const n = Math.min(Math.floor(sampleRate * seconds), Math.floor(samples.length / 2));
  for (let i = 0; i < n; i += 1) {
    const g = i / n;
    samples[i] *= g;
    samples[samples.length - 1 - i] *= g;
  }
  return samples;
}

/**
 * Cross-fades a loop's tail into its head.
 *
 * A loop that simply stops where it started has a discontinuity at the wrap point, which is audible as a
 * periodic tick. Mixing the tail over the head and shortening the result makes the seam continuous, at the
 * cost of a slightly shorter loop — the standard technique, and the reason the engine sounds like a
 * continuous engine rather than a loop restarting every two seconds.
 */
export function makeSeamless(samples, sampleRate, fadeSeconds = 0.12) {
  const fade = Math.floor(sampleRate * fadeSeconds);
  if (fade * 2 >= samples.length) {
    return samples;
  }
  const out = new Float32Array(samples.length - fade);
  out.set(samples.subarray(0, out.length));
  for (let i = 0; i < fade; i += 1) {
    const t = i / fade;
    out[i] = out[i] * t + samples[samples.length - fade + i] * (1 - t);
  }
  return out;
}
