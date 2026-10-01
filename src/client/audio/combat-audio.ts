/**
 * Prototype combat audio, synthesised in the browser.
 *
 * ## Asset provenance — generated in-project, no audio files
 *
 * Every sound here is **synthesised** with the Web Audio API from oscillators and a noise buffer. There
 * are no imported audio files, which means no licensing, no redistribution question, and no binary assets
 * to keep in step with the repository. The brief allowed audio if it could be obtained cleanly; this is
 * the cleanly-obtainable option, and it also means the sounds can be *tuned* as numbers.
 *
 * That is a real advantage. A tank gun is a very short, very loud transient with a long low tail, and
 * expressing it as code — a noise burst through a fast-closing lowpass, plus a pitched sine thump — makes
 * it adjustable in a way an imported sample is not.
 *
 * ## Scope, honestly stated
 *
 * These are **placeholder sounds**, not a sound pass. The brief asked not to spend V4 on audio, and that
 * was right: they exist so firing, being hit and destroying something have *weight*, because a silent
 * game gives the player no confirmation that an action happened at all. Functional cues, not atmosphere.
 *
 * ## Browser constraints this works within
 *
 * An `AudioContext` cannot start before a user gesture, so `unlock()` is called from the first click.
 * Every method is a no-op before that rather than throwing: audio failing must never take the game down
 * with it, and a headless screenshot run must not fail because it never clicked anything.
 */

/** Tuning for the synthesised sounds. Durations in seconds, gains linear. */
export const AUDIO_TUNING = {
  /**
   * Main gun report. `crack` is the initial transient: bright, very short, loud. `body` is the low
   * thump that follows, which is what carries at distance. Without the body a tank gun sounds like a
   * starter pistol.
   */
  gunCrackSeconds: 0.09,
  gunBodySeconds: 0.55,
  gunGain: 0.5,
  /** Peak cutoff of the crack's noise burst. High and hissy, as a muzzle blast is. */
  gunCrackHz: 1400,

  /**
   * Armour impact: shorter and duller than the gun report, and deliberately distinct from it. The
   * player must be able to tell "my shell hit something" from "my gun went off" without looking at the
   * HUD, and reusing one sound for both destroys that distinction.
   */
  impactSeconds: 0.3,
  impactGain: 0.4,
  impactHz: 700,

  /** Ricochet: a descending whine. A falling pitch marks a deflected shot from a stopped one. */
  ricochetSeconds: 0.35,
  ricochetGain: 0.22,
  ricochetStartHz: 2600,
  ricochetEndHz: 700,

  /** A round striking dirt or rock with nothing hit: dry and short. */
  dirtSeconds: 0.22,
  dirtGain: 0.2,

  /**
   * Vehicle destruction: longer, lower and noisier than any impact. Must be unmistakable — it is the
   * only sound that means "this is over", and it plays for whichever side was destroyed, so the player
   * knows the outcome by ear before reading the banner.
   */
  destroySeconds: 1.2,
  destroyGain: 0.5,
  destroyHz: 220,

  /** Engine loop. A low sawtooth pair, detuned so it beats against itself. */
  engineGain: 0.055,
  /** Engine pitch scales with speed across this range; a stationary tank idles. */
  engineMinHz: 34,
  engineMaxHz: 66,

  /** Distance beyond which a sound is silent. */
  maxAudibleRangeM: 220,
} as const;

/** One continuous engine sound. */
class EngineVoice {
  private readonly oscillator: OscillatorNode;
  private readonly gain: GainNode;
  private started = false;

  constructor(context: AudioContext, destination: AudioNode, detuneCents: number) {
    this.oscillator = context.createOscillator();
    this.oscillator.type = 'sawtooth';
    this.oscillator.frequency.value = AUDIO_TUNING.engineMinHz;
    // Two engines a few cents apart beat against each other, which reads as machinery rather than as a
    // single tone. At zero detune two identical oscillators sum to one louder, flatter tone.
    this.oscillator.detune.value = detuneCents;

    this.gain = context.createGain();
    this.gain.gain.value = 0;

    this.oscillator.connect(this.gain);
    this.gain.connect(destination);
  }

  start(): void {
    if (!this.started) {
      this.oscillator.start();
      this.started = true;
    }
  }

  /**
   * Sets pitch and volume from a vehicle's speed.
   *
   * Pitch tracks speed so a moving tank sounds different from a stationary one, and volume rises with
   * it so the player's own engine fades as they come to rest — which is the cue that they have stopped.
   */
  update(speedMps: number, maxSpeedMps: number, gainScale: number, dtSeconds: number): void {
    const fraction = maxSpeedMps > 0 ? Math.min(1, Math.abs(speedMps) / maxSpeedMps) : 0;
    const targetHz =
      AUDIO_TUNING.engineMinHz + (AUDIO_TUNING.engineMaxHz - AUDIO_TUNING.engineMinHz) * fraction;
    const targetGain = AUDIO_TUNING.engineGain * gainScale * (0.45 + 0.55 * fraction);

    // Smoothed rather than set directly. An engine whose pitch jumps every frame to match a speed that
    // changes every frame sounds like a broken synth; a real engine has inertia.
    const k = Math.min(1, 6 * dtSeconds);
    this.oscillator.frequency.value += (targetHz - this.oscillator.frequency.value) * k;
    this.gain.gain.value += (targetGain - this.gain.gain.value) * Math.min(1, 4 * dtSeconds);
  }

  /** Fades the loop out, for a destroyed vehicle or a restart. */
  silence(dtSeconds: number): void {
    this.gain.gain.value += (0 - this.gain.gain.value) * Math.min(1, 6 * dtSeconds);
  }
}

export class CombatAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly playerEngine: EngineVoice[] = [];
  private readonly opponentEngine: EngineVoice[] = [];
  private muted = false;

  /**
   * Starts the audio graph. Must be called from a user gesture.
   *
   * Safe to call repeatedly. Browsers may hand back a context that exists but is still suspended, so
   * this also resumes it — otherwise the first click after a page load produces silence.
   */
  unlock(): void {
    if (this.context === null) {
      const Ctor =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      // No Web Audio at all (headless harness, old browser): stay silent rather than failing to start.
      if (Ctor === undefined) {
        return;
      }

      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      this.master.connect(this.context.destination);
      this.noiseBuffer = this.createNoiseBuffer(this.context);

      for (const detune of [-7, 7]) {
        this.playerEngine.push(new EngineVoice(this.context, this.master, detune));
        this.opponentEngine.push(new EngineVoice(this.context, this.master, detune * 2));
      }
    }

    void this.context.resume();
  }

  /** True once audio is actually running. Read by tests. */
  get isRunning(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Silences everything without tearing down the graph, for the pause in a restart. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master !== null) {
      this.master.gain.value = muted ? 0 : MASTER_GAIN;
    }
  }

  /**
   * A short burst of noise, the transient part of every impact and report.
   *
   * One buffer, reused for every sound. Generating noise per shot would allocate an `AudioBuffer` each
   * time, which is wasteful and a source of frame-time spikes at exactly the moment the game should be
   * smoothest.
   */
  private createNoiseBuffer(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * 0.5);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * Volume for a sound at a given distance.
   *
   * Inverse-square would be physically right and inaudibly wrong: it drops off so fast that a shot at
   * 100 m disappears, leaving the player unsure whether their gun fired at all. A gentle linear falloff
   * keeps distant impacts present but clearly quieter — what "far away" sounds like, without losing the
   * information.
   */
  private distanceGain(rangeM: number): number {
    if (!Number.isFinite(rangeM) || rangeM < 0) {
      return 1;
    }
    const t = Math.min(1, rangeM / AUDIO_TUNING.maxAudibleRangeM);
    return 1 - t * 0.85;
  }

  /** Plays a noise burst through a closing filter: the shape shared by most impacts. */
  private burst(durationSeconds: number, gainValue: number, cutoffHz: number): void {
    const context = this.context;
    const master = this.master;
    if (context === null || master === null || this.noiseBuffer === null || this.muted) {
      return;
    }

    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;

    // Lowpass sweeping down: the filter closing is what makes a burst read as an explosion rather than
    // as static. A fixed filter reads as a click.
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoffHz, context.currentTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(60, cutoffHz * 0.15),
      context.currentTime + durationSeconds,
    );

    const gain = context.createGain();
    gain.gain.setValueAtTime(gainValue, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + durationSeconds);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start();
    source.stop(context.currentTime + durationSeconds);
  }

  /** Plays a pitched tone with an exponential decay, for the low body of a report. */
  private thump(
    frequencyHz: number,
    endFrequencyHz: number,
    durationSeconds: number,
    gainValue: number,
    type: OscillatorType = 'sine',
  ): void {
    const context = this.context;
    const master = this.master;
    if (context === null || master === null || this.muted) {
      return;
    }

    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequencyHz, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, endFrequencyHz),
      context.currentTime + durationSeconds,
    );

    const gain = context.createGain();
    gain.gain.setValueAtTime(gainValue, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + durationSeconds);

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start();
    oscillator.stop(context.currentTime + durationSeconds);
  }

  /**
   * The main gun firing.
   *
   * @param rangeM distance to whatever fired, so a distant shot is quieter without disappearing.
   */
  fire(rangeM = 0): void {
    const scale = this.distanceGain(rangeM);
    if (scale <= 0.02) {
      return;
    }
    this.burst(AUDIO_TUNING.gunCrackSeconds, AUDIO_TUNING.gunGain * scale, AUDIO_TUNING.gunCrackHz);
    this.thump(110, 38, AUDIO_TUNING.gunBodySeconds, AUDIO_TUNING.gunGain * 0.8 * scale);
  }

  /** A round striking armour and being stopped. */
  impact(rangeM = 0): void {
    const scale = this.distanceGain(rangeM);
    this.burst(AUDIO_TUNING.impactSeconds, AUDIO_TUNING.impactGain * scale, AUDIO_TUNING.impactHz);
    this.thump(180, 60, AUDIO_TUNING.impactSeconds * 0.7, AUDIO_TUNING.impactGain * 0.5 * scale);
  }

  /** A round striking the ground with nothing hit. Dry, and clearly not an armour hit. */
  dirt(rangeM = 0): void {
    this.burst(AUDIO_TUNING.dirtSeconds, AUDIO_TUNING.dirtGain * this.distanceGain(rangeM), 380);
  }

  /** A shell deflecting. Descending, so it is recognisable as a ricochet and nothing else. */
  ricochet(rangeM = 0): void {
    const scale = this.distanceGain(rangeM);
    this.thump(
      AUDIO_TUNING.ricochetStartHz * scale,
      AUDIO_TUNING.ricochetEndHz,
      AUDIO_TUNING.ricochetSeconds,
      AUDIO_TUNING.ricochetGain * scale,
      'sawtooth',
    );
  }

  /** A vehicle being destroyed. Deliberately unlike every other sound. */
  destroy(rangeM = 0): void {
    const scale = this.distanceGain(rangeM);
    this.burst(AUDIO_TUNING.destroySeconds, AUDIO_TUNING.destroyGain * scale, AUDIO_TUNING.destroyHz);
    this.thump(90, 25, AUDIO_TUNING.destroySeconds, AUDIO_TUNING.destroyGain * scale);
  }

  /** Starts and updates both engine loops. Called once per frame. */
  updateEngines(
    playerSpeedMps: number,
    playerMaxSpeedMps: number,
    opponentSpeedMps: number,
    opponentMaxSpeedMps: number,
    opponentAlive: boolean,
    dtSeconds: number,
  ): void {
    if (this.context === null || this.muted) {
      return;
    }

    for (const voice of this.playerEngine) {
      voice.start();
      voice.update(playerSpeedMps, playerMaxSpeedMps, 1, dtSeconds);
    }
    for (const voice of this.opponentEngine) {
      voice.start();
      if (opponentAlive) {
        // Quieter than the player's own engine: a background presence, not something competing with it.
        voice.update(opponentSpeedMps, opponentMaxSpeedMps, 0.7, dtSeconds);
      } else {
        voice.silence(dtSeconds);
      }
    }
  }

  /** Fades both engines out, for a restart or a finished battle. */
  silenceEngines(dtSeconds: number): void {
    for (const voice of [...this.playerEngine, ...this.opponentEngine]) {
      voice.silence(dtSeconds);
    }
  }

  /** Releases the audio graph. */
  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.master = null;
  }
}

/** Master output level. Kept below 1 so a shot plus an impact cannot clip on a quiet system. */
const MASTER_GAIN = 0.6;
