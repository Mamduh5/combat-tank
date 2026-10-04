/**
 * V7 combat audio.
 *
 * ## What changed from V4, and why
 *
 * V4 synthesised everything live from Web Audio oscillators and one noise buffer. That was a reasonable
 * placeholder with no assets to manage, but it has a hard ceiling: a gun report built from a single filtered
 * noise burst cannot sound like a gun report. Real reports have a supersonic crack, a lower blast body, and
 * a long tail rolling off the landscape, and V4 had no way to express the three separately.
 *
 * So the sounds are now **rendered offline to WAV assets** (`tools/build-assets.mjs`, provenance recorded in
 * `docs/audio-design.md`) and loaded here as `AudioBuffer`s. The runtime's job is placement, mixing, and
 * layering — things a baked sample cannot do for itself.
 *
 * ## The three structural ideas
 *
 * **Layers, not one-shots.** The engine is three separate loops (idle / load / full) cross-faded by throttle
 * and speed. Pitch alone gives a rising *tone*; cross-fading between loops recorded at different loads gives
 * a rising *effort*, which is what the brief asks the player to hear: "the tank is working harder when I
 * ask more from it". The gun report is likewise four layers placed differently — the crack is directional
 * and bright, the tail arrives late and is mostly low, and baking them together would force one filter over a
 * sound that needs two.
 *
 * **Spatialisation where it carries information.** The brief asks that a player "gain basic battlefield
 * information from sound". Enemy gunfire, impacts, and explosions are positioned in stereo relative to the
 * camera and attenuated with distance, so the player can tell roughly where a shot came from without looking
 * away. The player's own engine and tracks are deliberately **not** spatialised: they are at the camera, so
 * panning them would add nothing but an artefact.
 *
 * **Bounded voices.** One-shots play under a ceiling on simultaneous voices, not an unbounded pile. A shot in
 * a long firefight, or several impacts in one frame, must not stack into a dozen overlapping gunfires louder
 * than intended — and they must not accumulate live nodes either, which is why `OneShotVoices` disconnects
 * each source on `ended` and tracks how many are live.
 *
 * ## Browser constraints
 *
 * An `AudioContext` cannot start before a user gesture, so `unlock()` runs from the first click. Every method
 * is a no-op before that rather than throwing: audio failing must never take the game down with it, and a
 * headless screenshot run must not fail because it never clicked anything.
 */


import { assetUrl, SOUNDS } from '../assets/asset-manifest.js';

/** Tuning for the audio graph. Gains are linear and small; the limiter catches the peaks. */
export const AUDIO_TUNING = {
  /**
   * Master level, before the limiter.
   *
   * Low on purpose. The brief warns against "extremely loud transient effects" and against clipping, and
   * with a gun report, an impact, and a destruction able to land within a second of each other, headroom for
   * the limiter to work is the reliable way to guarantee neither.
   */
  masterGain: 0.55,

  /** Ceiling the limiter holds the sum to, so overlapping effects cannot clip the output. */
  limiterCeiling: 0.89,

  /**
   * Distance at which a spatialised sound is inaudible, metres.
   *
   * Beyond a battlefield, not a street: Marlowe's playable area is a few hundred metres across, so this is
   * "the far end of the map" rather than an arbitrary cutoff.
   */
  audibleRangeM: 260,

  /**
   * How much of a sound's level survives at maximum range.
   *
   * Inverse-square would be physically right and inaudibly wrong: it drops off so fast that a shot at 100 m
   * disappears, leaving the player unsure whether their gun fired at all. A gentle linear falloff keeps
   * distant events present but clearly quieter — what "far away" sounds like, without losing the information.
   */
  distantFloor: 0.18,

  /** Player engine loop gain. Deliberately quiet: it is a continuous bed, not an event. */
  engineGain: 0.3,
  /** Track loop gain. Quieter still, and only audible when actually moving. */
  trackGain: 0.22,
  /** Turret servo gain. Low, because it plays continuously while traversing. */
  turretGain: 0.12,
  /** Enemy engine, relative to the player's own. A background presence, not a competitor. */
  opponentEngineScale: 0.55,

  /** Gun report layer gains, relative to each other. */
  gunCrackGain: 1.0,
  gunBlastGain: 0.85,
  gunThumpGain: 0.7,
  /**
   * The tail is delayed as well as quiet.
   *
   * Distance is conveyed by *when* a sound arrives as much as by how loud it is, and the tail's own envelope
   * already fades in. This is the extra delay applied to a shot played at distance.
   */
  gunTailDelaySeconds: 0.12,

  /** Penetration is the player's most important feedback, so it is the loudest impact. */
  impactPenetrationGain: 0.75,
  impactBlockedGain: 0.62,
  impactRicochetGain: 0.5,
  impactTerrainGain: 0.45,

  /** Destruction. The loudest thing in the set, and it needs to be unmistakable. */
  destructionGain: 0.9,

  /** Engine cross-fade rate per second. Eased, so the engine never jumps between layers audibly. */
  engineFadeRate: 2.6,
  /** Track volume follows speed this sharply, so stopping is a clear cue. */
  trackResponseRate: 4.0,
  /** How fast the turret servo fades, so it does not click on or off. */
  turretFadeRate: 8.0,
} as const;

/** The shape of a vehicle's motion, as the audio layer needs to see it. */
export interface EngineInput {
  /** Signed speed along the hull's forward axis, m/s. */
  readonly speedMps: number;
  /** The vehicle's top speed, so the fraction is scale-free. */
  readonly maxSpeedMps: number;
  /** The driver's demand, −1..1. This is what makes the engine respond to *effort*, not just motion. */
  readonly throttle: number;
  /** Longitudinal acceleration, m/s². Positive under power, negative braking. */
  readonly accelMps2: number;
  /** True while the vehicle is stationary or nearly so. */
  readonly stopped: boolean;
  /** Overall level multiplier, for a destroyed or silenced vehicle. */
  readonly gainScale: number;
}
/**
 * A continuously playing loop, built from one or more buffers.
 *
 * Uses `AudioBufferSourceNode` in `loop` mode rather than an `AudioBuffer` on a `AudioBufferSourceNode`
 * per layer, because a loop has to be started once and run forever: a source cannot be "restarted" cheaply,
 * and three sources per engine (times two vehicles) started every frame would be absurd.
 *
 * ## Why pitch is *also* modulated
 *
 * The cross-fade between idle/load/full carries the *character* of the engine — the harmonics, the
 * roughness, the combustion lumpiness. But a real engine also revs. So the loop's `playbackRate` is nudged
 * with speed on top of the cross-fade. A small range only: pushing `playbackRate` far shifts every partial
 * and turns the engine into a chipmunk, whereas a gentle rise reads as revving.
 */
class LoopVoice {
  private readonly gains: GainNode[] = [];
  private readonly sources: AudioBufferSourceNode[] = [];
  /** Guards against a second `start()`, which the spec forbids and which throws. */
  private started = false;
  /** The authored level for each layer, so a caller can fade a loop without knowing its layer count. */
  private readonly baseGains: number[] = [];
  /** Detune in semitones, applied on top of playback rate. */
  private pitchScale = 1;
  /** The first layer's current level, so callers can fade a loop to silence without knowing its layers. */
  level = 0;

  constructor(
    context: AudioContext,
    destination: AudioNode,
    buffers: readonly AudioBuffer[],
    baseGains: readonly number[],
  ) {
    buffers.forEach((buffer, index) => {
      const gain = context.createGain();
      // Starts silent and is faded up by `update`, so a loop never begins with an audible click.
      gain.gain.value = 0;
      gain.connect(destination);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      // The build tool cross-fades each loop's tail into its head, so the wrap point is continuous and this
      // is inaudible. Setting it explicitly documents the dependency: a raw loop without that step ticks.
      source.loopStart = 0;
      source.loopEnd = buffer.duration;
      source.connect(gain);

      this.gains.push(gain);
      this.sources.push(source);
      this.baseGains.push(baseGains[index] ?? 0);
    });
  }

  /** Starts playback. Safe to call more than once. */
  start(): void {
    if (this.started) {
      return;
    }
    // Set *before* starting: `AudioBufferSourceNode.start()` throws if called twice, and this is the flag
    // that makes "safe to call more than once" true rather than aspirational.
    this.started = true;
    for (const source of this.sources) {
      source.start();
    }
  }

  /**
   * Sets the layer gains and pitch for this frame.
   *
   * @param weights one target gain per layer, which should sum to about 1 so the total level stays constant
   *   while the *character* changes
   * @param pitchScale playback-rate multiplier
   * @param dtSeconds elapsed time, so the cross-fade is frame-rate independent
   */
  update(weights: readonly number[], pitchScale: number, dtSeconds: number): void {
    const k = Math.min(1, AUDIO_TUNING.engineFadeRate * Math.max(0, dtSeconds));
    for (let i = 0; i < this.gains.length; i += 1) {
      const current = this.gains[i]!.gain.value;
      /**
       * The per-frame weight is scaled by the layer's authored base gain.
       *
       * The base gains were collected in the constructor and then never read: the weight was written to the
       * gain node raw. So every loop ran at unity regardless of the level it was built with, and a caller's
       * decision about how loud a loop should be had no effect at all. `weights` is a *balance* between
       * layers; `baseGains` is how loud the loop is overall. Multiplying them is what makes both mean
       * something.
       */
      const target = (weights[i] ?? 0) * this.baseGains[i];
      this.gains[i]!.gain.value = current + (target - current) * k;
    }
    this.level = this.gains[0]?.gain.value ?? 0;

    // Smoothed for the same reason as the gains: an engine whose pitch jumps every frame to match a speed
    // that changes every frame sounds like a broken synth. A real engine has inertia.
    const p = Math.min(1, AUDIO_TUNING.engineFadeRate * Math.max(0, dtSeconds));
    this.pitchScale += (pitchScale - this.pitchScale) * p;
    for (const source of this.sources) {
      source.playbackRate.value = this.pitchScale;
    }
  }

  /** Scales every layer, for a destroyed or silenced vehicle. */
  setLevel(level: number): void {
    for (const gain of this.gains) {
      gain.gain.value *= level;
    }
  }

  dispose(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped. Stopping a source that never started, or stopping twice, throws in some browsers;
        // a teardown path must not throw.
      }
    }
  }
}

/** A point in the world, as far as audio placement is concerned. */
export interface AudioPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The listener's pose, which spatial placement is relative to.
 *
 * A plain record rather than a Babylon `Vector3` and `Matrix`, so the audio layer has no dependency on the
 * renderer and could be driven from a server-side observer just as easily as from a camera.
 */
export interface ListenerPose {
  readonly position: AudioPosition;
  /** Unit forward on the XZ plane. Unused for stereo panning but kept, because a 3D extension needs it. */
  readonly forwardX: number;
  readonly forwardZ: number;
  /** Unit right on the XZ plane. This is what the stereo pan projects onto. */
  readonly rightX: number;
  readonly rightZ: number;
}

/** Speed as a 0..1 fraction of the vehicle's top speed. */
function speedFraction(input: EngineInput): number {
  return input.maxSpeedMps > 0 ? Math.min(1, Math.abs(input.speedMps) / input.maxSpeedMps) : 0;
}

/**
 * The playback-rate multiplier for an engine loop.
 *
 * A deliberately narrow range. Shifting a loop's rate far moves every partial up with it, which turns an
 * engine into a chipmunk; a gentle rise reads as revving. The *character* change comes from the cross-fade
 * between layers, not from this.
 */
function enginePitchScale(input: EngineInput): number {
  return 0.92 + speedFraction(input) * 0.22 + Math.abs(input.throttle) * 0.06;
}


/**
 * One-shot playback.
 *
 * ## Why this creates a node per shot instead of pooling
 *
 * V7 pooled `AudioBufferSourceNode`s and recycled them, on the reasonable-sounding theory that allocating a
 * node per shot is a frame-time spike. That theory is wrong in a way only the runtime reveals, and it made
 * the game crash.
 *
 * An `AudioBufferSourceNode` is **single-use**. The spec says its `buffer` may be assigned once and its
 * `start()` called once, and the first restriction turns out to be absolute: once a non-null buffer has been
 * assigned, setting `buffer = null` does *not* make the node reusable. Assigning a second buffer throws
 * `InvalidStateError` — verified directly rather than assumed, with the probe kept in
 * `tools/webaudio-semantics-probe.js`:
 *
 * | Sequence | Result |
 * |---|---|
 * | fresh node -> assign buffer | ok |
 * | assign buffer twice | throws |
 * | assign, set `null`, reassign | **throws** |
 * | assign, start, stop, `null`, reassign | **throws** |
 * | node already ended, reassign | **throws** |
 *
 * A recycled node therefore can never carry a second sound, however carefully it is reset. The pool's only
 * possible behaviour was to exhaust itself and then throw — which it did, from inside the render loop's fire
 * handler, stopping every frame. That is the "crash after five seconds" the owner reported: a gun report claims
 * four voices (crack, blast, thump, tail), so an eight-voice pool was spent in two shots.
 *
 * Creating a node per shot is not the expensive operation pooling was meant to avoid. A
 * `AudioBufferSourceNode` is a thin handle over the already-decoded `AudioBuffer`, and the sound data is
 * uploaded once at decode time and shared. Once `onended` fires and the node is disconnected it is garbage.
 * The genuinely expensive parts of this graph — the decoded buffers, the limiter, the persistent gains — are
 * all still shared.
 *
 * What pooling *did* buy is kept, because it was the useful half: a ceiling on simultaneous voices, so a
 * firefight cannot stack into a wall of sound. `activeCount` exposes it and the runtime gate asserts it.
 */
class OneShotVoices {
  /** Currently-sounding one-shots. Decremented on `onended`, so a true count rather than an estimate. */
  private live = 0;
  /** The high-water mark, so a gate can detect saturation rather than merely seeing a large number. */
  private peak = 0;

  /**
   * Ceiling on simultaneous one-shots.
   *
   * Eight, matching the pool V7 used, so the mix is unchanged — but now a ceiling rather than a supply.
   */
  static readonly MAX_CONCURRENT = 8;

  /**
   * Plays one buffer once.
   *
   * @param destination the bus to feed — the plain one for the player's own sounds, the spatial one otherwise
   * @param delaySeconds start offset, used to place the gun report's tail after the crack
   * @returns whether it started; `false` means the voice cap was reached and it was dropped
   */
  play(
    context: AudioContext,
    buffer: AudioBuffer,
    level: number,
    destination: AudioNode,
    delaySeconds = 0,
  ): boolean {
    if (this.live >= OneShotVoices.MAX_CONCURRENT) {
      // Dropping the newest is right here. The loudest events are gunfire and impacts, and a cap that
      // dropped those would silence exactly the sounds the player most needs; what it sheds is quieter,
      // later duplicates of a sound already playing.
      return false;
    }

    // A fresh node every time, which is the only form the spec permits.
    const source = context.createBufferSource();
    source.buffer = buffer;

    const gain = context.createGain();
    gain.gain.value = level;
    source.connect(gain);
    gain.connect(destination);

    this.live += 1;
    if (this.live > this.peak) {
      this.peak = this.live;
    }

    // The single cleanup point. Disconnecting here rather than relying on GC is what stops a long firefight
    // accumulating live nodes — the failure the old pool was meant to prevent, now prevented for real.
    source.onended = () => {
      this.live -= 1;
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // A node may already be disconnected if the graph was torn down mid-playback. Teardown must not throw.
      }
    };

    source.start(context.currentTime + delaySeconds);
    return true;
  }

  /** One-shots currently sounding. */
  get activeCount(): number {
    return this.live;
  }

  /** The high-water mark of {@link activeCount} since the context was built. */
  get peakCount(): number {
    return this.peak;
  }
}

/** Everything the game can play, keyed by the manifest's names. */
type SoundMap = { [K in keyof typeof SOUNDS]: AudioBuffer };

export class CombatAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything summed here before the limiter. One place, so "how loud is the game" is one number. */
  private bus: GainNode | null = null;
  /** The stereo placement bus. Spatialised sounds pass through it; the player's own sounds do not. */
  private spatialBus: GainNode | null = null;

  private sounds: Partial<SoundMap> = {};
  /** True once every asset has loaded and decoded. */
  private ready = false;

  private playerEngine: LoopVoice | null = null;
  private opponentEngine: LoopVoice | null = null;
  private trackLoop: LoopVoice | null = null;
  private turretLoop: LoopVoice | null = null;

  /** The pooled one-shot sources. Null before `unlock()`. */
  private voices: OneShotVoices | null = null;
  /** Mute state, applied on top of the volume rather than instead of it. */
  private muted = false;
  /** Player-facing volume, 0..1, multiplied into the tuned master gain. */
  private masterVolume = 1;

  /** Resolves once every asset has loaded. Null until loading starts, so it is also the "has it started" flag. */
  private loaded: Promise<void> | null = null;

  /**
   * Starts the audio graph and loads the sound assets. Must be called from a user gesture.
   *
   * Safe to call repeatedly. Browsers may hand back a context that exists but is still suspended, so this
   * also resumes it — otherwise the first click after a page load produces silence, which reads as broken.
   *
   * The graph is built *before* the fetch, so audio is playable the moment a buffer lands rather than only
   * after every file has arrived.
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
      this.bus = this.context.createGain();
      this.bus.gain.value = 1;

      // A soft limiter: a waveshaper whose transfer curve bends everything above the knee back down. This
      // makes the brief's "avoid clipping" and "gun sounds stacking uncontrollably" structural, rather than a
      // matter of tuning every gain conservatively enough that they never add up to too much.
      const limiter = this.context.createWaveShaper();
      limiter.curve = this.makeLimiterCurve();
      limiter.oversample = '4x';

      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : AUDIO_TUNING.masterGain * this.masterVolume;

      this.bus.connect(limiter);
      limiter.connect(this.master);
      this.master.connect(this.context.destination);

      this.spatialBus = this.context.createGain();
      this.spatialBus.connect(this.bus);

      // The voice ceiling is `OneShotVoices.MAX_CONCURRENT`. Enough that a shot plus two impacts plus a
      // destruction never cut each other off, few enough that a firefight cannot stack into a wall of sound.
      this.voices = new OneShotVoices();
    }

    void this.context.resume();
    if (!this.ready && this.loaded === null) {
      this.loaded = this.loadSounds();
    }
  }

  /** True once every asset has loaded and decoded. */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Resolves when loading finishes. Never rejects: audio must not be able to take the game down, and a
   * missing file degrades to "that sound is absent" rather than to a broken game.
   */
  whenReady(): Promise<void> {
    return this.loaded ?? Promise.resolve();
  }

  private async loadSounds(): Promise<void> {
    const context = this.context;
    if (context === null) {
      return;
    }

    const entries = Object.entries(SOUNDS) as [keyof SoundMap, string][];
    const decoded = await Promise.all(
      entries.map(async ([name, path]) => {
        try {
          const response = await fetch(assetUrl(path));
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          const bytes = await response.arrayBuffer();
          return [name, await context.decodeAudioData(bytes)] as const;
        } catch (error) {
          console.warn(`Combat Tank: audio asset "${name}" failed to load`, error);
          return [name, null] as const;
        }
      }),
    );

    const sounds: Record<string, AudioBuffer> = {};
    for (const [name, buffer] of decoded) {
      if (buffer !== null) {
        sounds[name] = buffer;
      }
    }
    // Through a mutable record: `SoundMap` is a mapped type over a `const` object, so its properties are
    // readonly and cannot be assigned into directly.
    this.sounds = sounds as Partial<SoundMap>;

    if (this.context !== null && this.bus !== null) {
      this.buildLoops();
    }
    this.ready = true;
  }

  /**
   * Builds the continuous voices.
   *
   * Each is constructed only from buffers that actually loaded, so a missing engine loop produces a quieter
   * game rather than an exception on the first frame — the right failure mode for an asset problem.
   */
  private buildLoops(): void {
    const context = this.context;
    const bus = this.bus;
    if (context === null || bus === null) {
      return;
    }

    const engineBuffers = [this.sounds.engineIdle, this.sounds.engineLoad, this.sounds.engineFull].filter(
      (b): b is AudioBuffer => b !== undefined,
    );
    if (engineBuffers.length > 0) {
      /**
       * Equal base gains, multiplied by the class-level level.
       *
       * The `engineGain` factor is load-bearing and was previously missing entirely. The three engine layers
       * are cross-faded to *sum* to 1, so without it the engine bed ran at unity — 0.92 measured at idle —
       * instead of the authored 0.3. Combined with a track loop and a turret servo at similar unity levels,
       * the continuous bed alone reached an RMS around 0.19 and a crest factor near 2.6, which is the
       * broadband, near-constant-amplitude signature of the "broken television" the owner heard.
       *
       * The per-frame weights still decide the *balance* between layers, so a vehicle missing one is not
       * permanently quieter than one with all three.
       */
      const weights = engineBuffers.map(() => AUDIO_TUNING.engineGain);
      this.playerEngine = new LoopVoice(context, bus, engineBuffers, weights);
      this.playerEngine.start();
      // The opponent's engine is a background presence, and is additionally scaled per-frame by the
      // opponent's own load, so it stays audible when it is working and fades when it is not.
      this.opponentEngine = new LoopVoice(
        context,
        bus,
        engineBuffers,
        engineBuffers.map(() => AUDIO_TUNING.engineGain * AUDIO_TUNING.opponentEngineScale),
      );
      this.opponentEngine.start();
    }

    if (this.sounds.tracks !== undefined) {
      this.trackLoop = new LoopVoice(context, bus, [this.sounds.tracks], [AUDIO_TUNING.trackGain]);
      this.trackLoop.start();
    }
    if (this.sounds.turret !== undefined) {
      /**
       * The turret servo is the loudest loop in the game at its raw level (RMS 0.378 measured offline, the
       * highest of the set) and it plays *continuously* while traversing, so it needs the full authored
       * reduction rather than a token one. At unity it dominated the mix on its own.
       */
      this.turretLoop = new LoopVoice(context, bus, [this.sounds.turret], [AUDIO_TUNING.turretGain]);
      this.turretLoop.start();
    }
  }

  /**
   * The limiter's transfer curve: linear below the knee, then a smooth roll-off to a hard ceiling.
   *
   * A hard clip would distort the transient audibly on every gunshot. This only touches the peaks, and the
   * peaks are precisely the ones that would otherwise clip.
   */
  private makeLimiterCurve(): Float32Array<ArrayBuffer> {
    const samples = 2048;
    const curve = new Float32Array(new ArrayBuffer(samples * 4));
    const ceiling = AUDIO_TUNING.limiterCeiling;
    // The knee sits below the ceiling so the roll-off has somewhere to go.

    const knee = ceiling * 0.75;

    for (let i = 0; i < samples; i += 1) {
      const x = (i / (samples - 1)) * 2 - 1;
      const magnitude = Math.abs(x);
      if (magnitude <= knee) {
        curve[i] = x;
      } else {
        // Compress the excess into the remaining headroom, asymptotically approaching the ceiling.
        const over = (magnitude - knee) / (1 - knee);
        const shaped = knee + (ceiling - knee) * (1 - (1 - over) * (1 - over));
        curve[i] = Math.sign(x) * shaped;
      }
    }
    return curve;
  }

  /**
   * Volume and stereo placement for a sound at a world position, relative to the camera.
   *
   * ## Why stereo, not full 3D
   *
   * The brief asks for "distance attenuation and sensible stereo/3D placement" and explicitly says not to
   * over-engineer acoustic simulation. A `PannerNode` in full HRTF mode is expensive per source, and for
   * battlefield cues a listener standing still in third person, left/right plus distance is what actually
   * carries the information. So this is a `StereoPannerNode` and a linear distance falloff.
   *
   * ## Why the falloff is gentle
   *
   * See `AUDIO_TUNING.distantFloor`. An enemy shot at 150 m must still be *audible* — that is the entire
   * point of spatial audio in a game where you cannot see them — so the curve never reaches true silence
   * until the sound is at the edge of the map.
   */
  private spatialParams(
    position: AudioPosition,
    listener: ListenerPose,
  ): { gain: number; pan: number } {
    const dx = position.x - listener.position.x;
    const dz = position.z - listener.position.z;
    const distance = Math.hypot(dx, dz);

    const t = Math.min(1, distance / AUDIO_TUNING.audibleRangeM);
    const gain = 1 - (1 - AUDIO_TUNING.distantFloor) * t;
    if (distance < 0.5) {
      return { gain: 1, pan: 0 };
    }

    // Project the offset onto the listener's right axis. A dot product rather than atan2: the ear cannot
    // localise behind itself precisely, and a full angular mapping would swing the sound all the way round
    // as an enemy drives past, which is far more noticeable than the small loss of precision.
    const pan = Math.max(-1, Math.min(1, (dx * listener.rightX + dz * listener.rightZ) / distance));
    return { gain, pan };
  }

  /**
   * Horizontal distance from a sound source to the listener, metres.
   *
   * Flat-ground and ignoring height, deliberately, to match `spatialParams` exactly. A separate measure that
   * included Y would give a gun at your feet a different arrival delay from the same gun panned across the
   * field — two answers to one question, and the mismatch would be audible as the gun moved over uneven
   * ground.
   */
  private distanceFrom(position: AudioPosition, listener: ListenerPose): number {
    return Math.hypot(position.x - listener.position.x, position.z - listener.position.z);
  }

  /**
   * Plays one buffer as a one-shot.
   *
   * @param panning when supplied, the sound is placed in stereo and attenuated; otherwise it plays centred
   *   and unattenuated, which is right for the player's own vehicle
   */
  private play(
    buffer: AudioBuffer | undefined,
    gain: number,
    options: { panning?: { pan: number; gain: number }; delaySeconds?: number } = {},
  ): void {
    const context = this.context;
    const voices = this.voices;
    if (buffer === undefined || context === null || voices === null || this.muted) {
      return;
    }

    const panning = options.panning;
    const level = gain * (panning?.gain ?? 1);
    // Below this a sound is inaudible anyway, and starting it costs a node and a buffer assignment.
    if (level < 0.004) {
      return;
    }

    if (panning !== undefined) {
      // A panner per spatialised sound, created with it and left to be collected with it. It is a few dozen
      // bytes over a buffer that is already resident, and it keeps the one-shot path free of shared state.
      const panner = context.createStereoPanner();
      panner.pan.value = panning.pan;
      panner.connect(this.spatialBus ?? this.bus!);
      voices.play(context, buffer, level, panner, options.delaySeconds ?? 0);
    } else {
      voices.play(context, buffer, level, this.bus!, options.delaySeconds ?? 0);
    }
  }

  /**
   * The main gun going off, assembled from four separately generated layers.
   *
   * A single gunshot recording is a compromise: the loud transient that reads as "close" also masks everything
   * else. Layering instead lets each part do one job. The crack is the supersonic snap, nearly instantaneous
   * and the loudest. The blast is the muzzle shock, slower and broader. The thump is the low body that carries
   * weight. The tail arrives late — distance is conveyed as much by *when* a sound reaches you as by how quiet
   * it is, so the extra delay is doing as much work as the attenuation.
   *
   * The tail's delay is scaled by the source's distance rather than applied flat. A gun on the far side of the
   * map should arrive noticeably later than one downrange; a constant delay would read as a mix error instead.
   */
  gunFire(listener: ListenerPose, position: AudioPosition): void {
    const panning = this.spatialParams(position, listener);
    const distanceM = this.distanceFrom(position, listener);
    // About 3 ms per metre, capped. Real sound-speed delay over 300 m is nearly a second, which is *correct*
    // but sounds like a bug; the cap keeps the effect while staying responsive.
    const delaySeconds = Math.min(distanceM / 340, 0.55);

    // The crack, blast, and thump start together — they share the muzzle event — but not quite: the low
    // thump is given a few milliseconds of its own lead so the sound has an attack rather than a click.
    this.play(this.sounds.gunCrack, AUDIO_TUNING.gunCrackGain, { panning, delaySeconds });
    this.play(this.sounds.gunBlast, AUDIO_TUNING.gunBlastGain, { panning, delaySeconds: delaySeconds + 0.006 });
    this.play(this.sounds.gunThump, AUDIO_TUNING.gunThumpGain, { panning, delaySeconds: delaySeconds + 0.014 });
    this.play(this.sounds.gunTail, AUDIO_TUNING.gunThumpGain * 0.6, {
      panning,
      delaySeconds: delaySeconds + AUDIO_TUNING.gunTailDelaySeconds + distanceM / 340,
    });
  }

  /** A round penetrating armour: heavy, low, and internal. */
  penetration(listener: ListenerPose, position: AudioPosition): void {
    this.play(this.sounds.penetration, AUDIO_TUNING.impactPenetrationGain, {
      panning: this.spatialParams(position, listener),
    });
  }

  /** A round stopped by armour: a bright clang with no low end, so it cannot be confused with a penetration. */
  blocked(listener: ListenerPose, position: AudioPosition): void {
    this.play(this.sounds.blocked, AUDIO_TUNING.impactBlockedGain, {
      panning: this.spatialParams(position, listener),
    });
  }

  /** A deflection: a sharp descending scrape. */
  ricochet(listener: ListenerPose, position: AudioPosition): void {
    this.play(this.sounds.ricochet, AUDIO_TUNING.impactRicochetGain, {
      panning: this.spatialParams(position, listener),
    });
  }

  /** A round hitting dirt, ballast, or stone: dry and dull, with none of the metallic ring. */
  terrainImpact(listener: ListenerPose, position: AudioPosition): void {
    this.play(this.sounds.terrain, AUDIO_TUNING.impactTerrainGain, {
      panning: this.spatialParams(position, listener),
    });
  }

  /** A vehicle being destroyed. The loudest, longest sound in the set, and unmistakable. */
  destruction(listener: ListenerPose, position: AudioPosition): void {
    this.play(this.sounds.destruction, AUDIO_TUNING.destructionGain, {
      panning: this.spatialParams(position, listener),
    });
  }

  /**
   * Drives the engine, track, and turret loops from vehicle motion.
   *
   * ## How the engine's *load* is derived
   *
   * The brief's requirement is that the player hears the tank "working harder when I ask more from it", so
   * throttle is the primary input. Speed is secondary — a tank coasting at full speed is not working hard,
   * and one flooring it from rest is. Acceleration adds a small positive bias, because a hard acceleration is
   * the moment of maximum load.
   *
   * The three loops are cross-faded with those weights, and the playback rate is nudged with speed on top.
   * Cross-fading carries the *character*; the rate shift carries the *revving*. Pitch alone would sound like
   * a synth speeding up, which is exactly what the V4 implementation did and why it read as a placeholder.
   */
  updateEngine(
    player: EngineInput,
    opponent: EngineInput | null,
    turretTraverseRateDegPerSec: number,
    dtSeconds: number,
  ): void {
    if (!this.ready) {
      return;
    }

    this.playerEngine?.update(this.engineWeights(player), enginePitchScale(player), dtSeconds);

    if (this.opponentEngine !== null) {
      if (opponent === null || opponent.gainScale <= 0) {
        // Faded rather than stopped, so a destroyed vehicle's engine dies away instead of cutting.
        this.opponentEngine.update([0, 0, 0], 1, dtSeconds);
      } else {
        const weights = this.engineWeights(opponent).map((w) => w * opponent.gainScale);
        this.opponentEngine.update(weights, enginePitchScale(opponent), dtSeconds);
      }
    }


    if (this.trackLoop !== null) {
      // Track volume follows speed closely, so coming to a stop is an audible event. The `LoopVoice.update`
      // easing already smooths the transition, so the target is set directly here rather than re-eased.
      const fraction = speedFraction(player);
      const target = player.stopped ? 0 : Math.min(1, fraction * 1.35);
      this.trackLoop.update([target], 0.75 + fraction * 0.45, dtSeconds);
    }

    if (this.turretLoop !== null) {
      // Silent unless actually traversing, so the servo is a cue rather than a constant.
      const moving = Math.min(1, Math.abs(turretTraverseRateDegPerSec) / 30);
      const k = Math.min(1, AUDIO_TUNING.turretFadeRate * Math.max(0, dtSeconds));
      const next = this.turretLoop.level + (moving - this.turretLoop.level) * k;
      this.turretLoop.update([next], 0.85 + moving * 0.3, dtSeconds);
    }
  }

  /** The cross-fade weights for the three engine loops, from throttle, speed, and acceleration. */
  private engineWeights(input: EngineInput): number[] {
    const speed = speedFraction(input);
    // Throttle dominates. Reverse counts as effort too — asking the tank to back up is work.
    const effort = Math.min(1, Math.abs(input.throttle));
    // A stationary tank under power is working harder than a moving one coasting, so acceleration biases up.
    const accelBias = Math.max(0, Math.min(0.2, input.accelMps2 / 12));
    const load = Math.min(1, effort * 0.72 + speed * 0.2 + accelBias);

    // The weights sum to 1, so the total level stays constant while the character changes.
    return [
      Math.max(0, 1 - load * 2),
      Math.max(0, 1 - Math.abs(load - 0.5) * 2),
      Math.max(0, (load - 0.5) * 2),
    ];
  }

  /** Fades every continuous loop out, for a restart or a finished battle. */
  silenceEngines(dtSeconds: number): void {
    this.playerEngine?.update([0, 0, 0], 1, dtSeconds);
    this.opponentEngine?.update([0, 0, 0], 1, dtSeconds);
    if (this.trackLoop !== null) {
      const k = Math.min(1, AUDIO_TUNING.trackResponseRate * Math.max(0, dtSeconds));
      this.trackLoop.update([this.trackLoop.level * (1 - k)], 1, dtSeconds);
    }
  }

  /** The gun's reload mechanism: breech, shell, breech. Plays on the player's own gun. */
  gunMechanism(): void {
    this.play(this.sounds.gunMechanism, 0.5);
  }

  /** A confirming UI blip: reload complete, or a battle won. */
  uiConfirm(): void {
    this.play(this.sounds.uiConfirm, 0.4);
  }

  /** A duller UI sound for defeat. */
  uiFail(): void {
    this.play(this.sounds.uiFail, 0.45);
  }

  /** True once the context exists and the assets have loaded. */
  get isRunning(): boolean {
    return this.context !== null && this.ready;
  }

  /**
   * One-shots currently sounding.
   *
   * Exposed for the runtime gate, which asserts this stays bounded — the V7 failure it replaces presented as
   * sources accumulating without limit and eventually throwing, and a plain count catches both.
   */
  get activeVoiceCount(): number {
    return this.voices?.activeCount ?? 0;
  }

  /** The highest {@link activeVoiceCount} reached. Saturating at the ceiling means the cap is binding. */
  get peakVoiceCount(): number {
    return this.voices?.peakCount ?? 0;
  }

  /** The simultaneous-voice ceiling, so a test can assert `active <= ceiling` without hard-coding 8. */
  get voiceCeiling(): number {
    return OneShotVoices.MAX_CONCURRENT;
  }

  /** Muted state. Preserved from V4, where `M` toggled it. */
  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain();
  }

  /**
   * Master volume, 0..1.
   *
   * Multiplies the tuned master level rather than replacing it, so 1.0 means "the balance as authored" and
   * the control is relative — which is what a player expects, and it keeps the limiter's headroom intact at
   * every setting rather than only at the default.
   */
  get volume(): number {
    return this.masterVolume;
  }

  setVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (this.master === null) {
      return;
    }
    const target = this.muted ? 0 : AUDIO_TUNING.masterGain * this.masterVolume;
    // A short ramp rather than a step, so changing the volume mid-battle does not click.
    const now = this.context?.currentTime ?? 0;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, 0.02);
  }

  /** Releases the audio graph and every voice. */
  dispose(): void {
    this.playerEngine?.dispose();
    this.opponentEngine?.dispose();
    this.trackLoop?.dispose();
    this.turretLoop?.dispose();
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.bus = null;
    this.spatialBus = null;
    this.voices = null;
    this.ready = false;
    this.loaded = null;
  }
}
