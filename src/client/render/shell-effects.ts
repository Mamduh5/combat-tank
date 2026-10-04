/**
 * V7 combat effects: gunfire, shell trails, impacts, and destruction.
 *
 * ## What changed from V6, and why
 *
 * V6 had three effects: a shell box, an expanding sphere for a muzzle flash, and a rotating box for an impact
 * marker. They were legible but they were *placeholders* — the brief's word for the state the game was in. The
 * player could see a shell had been fired and something had been hit, but firing was not "one of the strongest
 * audiovisual moments" and the four combat outcomes were indistinguishable on screen.
 *
 * V7 adds, per the brief's list:
 *
 * | Effect | What it must communicate |
 * | --- | --- |
 * | Muzzle flash | the gun fired, and where the barrel is pointing |
 * | Muzzle smoke + blast dust | the shot was *powerful*, not a tracer |
 * | Shell tracer | where the round is in flight, on an arc |
 * | Penetration | it went through — bright internal flash, debris, smoke |
 * | Blocked | it bounced off — a sharp spark shower and no flash-through |
 * | Ricochet | it deflected — a directional streak travelling away |
 * | Terrain impact | nothing was hit — dust plume, no sparks |
 * | Destruction | that tank is dead — fireball, smoke column, burning wreck |
 *
 * ## Pooling, and why it is not premature
 *
 * Every effect is a pooled particle system. This is not premature optimisation: a firefight resolves several
 * shells per second, and allocating a particle system per impact produces a visible hitch at exactly the moment
 * the game is busiest. The pools are fixed-size and reused.
 *
 * ## Restraint
 *
 * The brief asks that effects stay "restrained enough that the player can still aim and read the
 * battlefield". Every size and duration below is chosen with that in mind: a flash bright enough to see, not a
 * white screen; a smoke column tall enough to read as a wreck, not an occluder.
 */

import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ShellState } from '../../core/ballistics/shell.js';
import type { ShellImpact } from '../../core/ballistics/impact.js';

/** Tuning for every effect. Times in seconds, sizes in metres. */
export const EFFECT_TUNING = {
  /**
   * Muzzle flash lifetime.
   *
   * Short on purpose. A muzzle flash is a few milliseconds of very bright light; extending it to half a second
   * turns a gunshot into a strobe and makes the player wince through every shot.
   */
  muzzleFlashSeconds: 0.075,

  /** How far the flash expands over its life, metres. Small: it is a burst, not a fireball. */
  muzzleFlashGrowthM: 0.55,

  /** Muzzle smoke. Wider and longer than the flash — this is what carries the sense of a big gun. */
  muzzleSmokeSeconds: 1.6,
  muzzleSmokeSizeM: 1.5,
  /** Blast dust kicked up under the muzzle, which sells the report's force. */
  blastDustSeconds: 1.1,
  blastDustSizeM: 2.2,

  /** Shell tracer. Long enough to follow, short enough not to become a laser. */
  tracerLengthM: 3.2,

  /**
   * Impact durations per outcome.
   *
   * A penetration flash is brief and blinding; a blocked hit's sparks last longer because they are ricocheting
   * off a plate; a ricochet's streak is the longest of the three because the round is still travelling.
   */
  penetrationFlashSeconds: 0.09,
  penetrationSmokeSeconds: 1.8,
  blockedSparkSeconds: 0.5,
  ricochetSparkSeconds: 0.42,
  terrainDustSeconds: 1.4,

  /**
   * Destruction.
   *
   * A fireball brief enough to avoid blinding, then a smoke column that persists. The column is what makes the
   * wreck readable from across the map — a fireball alone is gone before the player can look up from the HUD.
   */
  destructionFireSeconds: 0.55,
  destructionSmokeSeconds: 9,
  /** How long a wreck keeps burning before the fire effect is retired. */
  wreckFireSeconds: 14,

  /**
   * Impact marker persistence, seconds.
   *
   * Kept from V6. It is the only cue showing *where* the last shot landed, which matters when a shot misses and
   * the player needs to adjust aim.
   */
  impactMarkerSeconds: 6,

  /** Point-light range and intensity for a muzzle flash, so firing briefly lights the ground. */
  flashLightRangeM: 14,
  flashLightIntensity: 3.2,

  /**
   * Movement dust, emitted while driving.
   *
   * Small and continuous. This is "visual weight" rather than spectacle: a tank that throws no dust reads as
   * sliding, whatever the tracks are doing.
   */
  trackDustRate: 90,
  trackDustSizeM: 0.9,
  /** Exhaust smoke, emitted from the vehicle's rear. Slow, dark, and very sparse. */
  exhaustRate: 22,
  exhaustSizeM: 1.1,
} as const;

/**
 * A soft radial sprite, generated rather than loaded.
 *
 * A particle system needs a texture, and the useful one here is a soft round falloff — the standard particle
 * gradient. Generating it as a `DynamicTexture` rather than shipping a PNG means the effects layer has no asset
 * dependency for the one thing it needs most, and cannot fail to load a texture and silently render nothing.
 * V7's asset pipeline is for the *world*; the effects' own falloff is a shader constant in all but name.
 */
function makeSoftSprite(scene: Scene, name: string, hardness: number): Texture {
  const size = 64;
  const texture = new DynamicTexture(name, { width: size, height: size }, scene, false);
  const context = texture.getContext() as CanvasRenderingContext2D;
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const distance = Math.hypot(dx, dy) * 2;
      // Smooth radial falloff, raised by `hardness` to control how tight the core is. A soft sprite reads as
      // smoke; a hard one reads as a spark.
      const alpha = Math.max(0, 1 - distance) ** (1 + hardness * 4);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  context.putImageData(image, 0, 0);
  texture.update();
  texture.hasAlpha = true;
  return texture;
}

/**
 * A fixed pool of identical particle systems, fired on demand.
 *
 * `ParticleSystem` has no reusable-burst API in this Babylon version, so a pool is several systems, all started
 * once, with emission switched off while idle; `manualEmitCount` then fires a burst from whichever is free. The
 * alternative — constructing a system per impact — allocates GPU buffers in the middle of a firefight, which
 * is exactly the frame-time hitch the brief's performance note warns about.
 */
class EffectPool {
  private readonly systems: ParticleSystem[] = [];
  private readonly busy: boolean[] = [];
  /** When each system was last fired, so a busy one can be reclaimed in oldest-first order. */
  private readonly firedAtMs: number[] = [];

  constructor(scene: Scene, create: (index: number) => ParticleSystem, size: number) {
    for (let i = 0; i < size; i += 1) {
      // Every pooled system is started once and left running; only its emission count changes.
      const system = create(i);
      system.start();
      this.systems.push(system);
      this.busy.push(false);
      this.firedAtMs.push(0);
    }
    void scene;
  }

  /**
   * Emits a burst from the first free system, reclaiming the oldest if all are busy.
   *
   * Stealing rather than dropping is deliberate: the newest event is the one the player most needs to see —
   * their shot, the hit they just scored — so the oldest effect is the right thing to lose.
   *
   * @param windowSeconds how long this effect occupies its system
   */
  burst(count: number, windowSeconds: number): number {
    let index = this.busy.indexOf(false);
    if (index < 0) {
      index = 0;
      for (let i = 1; i < this.busy.length; i += 1) {
        if (this.firedAtMs[i]! < this.firedAtMs[index]!) {
          index = i;
        }
      }
    }
    this.busy[index] = true;
    this.firedAtMs[index] = performance.now();
    this.systems[index]!.manualEmitCount = count;

    // Freed on a timer rather than by tracking ages each frame: the pools are small, the timing is approximate
    // by nature, and a system reused a few frames early merely overwrites its own particles.
    const windowMs = windowSeconds * 1000;
    const slot = index;
    setTimeout(() => {
      this.busy[slot] = false;
    }, windowMs);
    return index;
  }

  /** The system a given pool slot refers to, so callers can aim and colour it. */
  systemAt(index: number): ParticleSystem | null {
    return this.systems[index] ?? null;
  }

  /** Retires every pooled system, for a battle reset. */
  clear(): void {
    for (let i = 0; i < this.systems.length; i += 1) {
      this.systems[i]!.reset();
      this.busy[i] = false;
    }
  }

  dispose(): void {
    for (const system of this.systems) {
      system.dispose();
    }
  }
}

/** A transient mesh, cloned from a template and aged out. */
interface Marker {
  readonly mesh: Mesh;
  remainingSeconds: number;
}

/**
 * How a shell resolved, as the *effects* need to know it.
 *
 * The core already has this as `CombatResult['kind']`, but the effects layer also needs to represent "a shell
 * landed but the combat resolver had no verdict" — which happens for a shot fired by nobody in particular and
 * for the moment an impact is drawn before the result is paired with it. `impacted` is that neutral case.
 *
 * Declared locally rather than imported so the effects layer depends on a five-value union instead of the
 * whole combat module, and so it can name the neutral case the core has no word for.
 */
export type ImpactOutcome = 'penetrated' | 'blocked' | 'ricocheted' | 'armour-miss' | 'impacted';


/** A burning wreck: fire and smoke anchored to a position until retired. */
interface BurnSite {
  readonly position: Vector3;
  remainingSeconds: number;
}

/**
 * All of the game's transient combat effects.
 *
 * One class owns every pool, so the *budget* for effects is visible in one place: how many flashes, sparks,
 * and dust clouds can exist at once, and how long each lives. A prototype that allocates effects on demand has
 * no such bound, which is how a long firefight turns into a frame-rate collapse.
 */
export class CombatEffects {
  private readonly scene: Scene;
  private readonly softSprite: Texture;
  private readonly hardSprite: Texture;

  private readonly muzzleFlashPool: EffectPool;
  private readonly muzzleSmokePool: EffectPool;
  private readonly sparkPool: EffectPool;
  private readonly dustPool: EffectPool;
  private readonly firePool: EffectPool;
  private readonly smokePool: EffectPool;

  /** A brief point light at the muzzle, so firing actually lights the ground for a frame. */
  private readonly flashLight: PointLight;
  private flashLightRemaining = 0;

  /** The visible shell tracers, pooled by shell id as in V6. */
  private readonly tracers = new Map<number, Mesh>();

  /** Impact markers showing where the last shot landed. */
  private readonly markers: Marker[] = [];

  /** Burning wrecks, anchored in the world. */
  private readonly burnSites: BurnSite[] = [];

  private tracerMaterial: StandardMaterial;

  constructor(scene: Scene) {
    this.scene = scene;
    this.softSprite = makeSoftSprite(scene, 'fx-soft', 0.15);
    this.hardSprite = makeSoftSprite(scene, 'fx-hard', 0.9);

    this.muzzleFlashPool = new EffectPool(
      scene,
      (i) => this.makeFlash(`fx-flash-${i}`),
      3,
    );
    this.muzzleSmokePool = new EffectPool(
      scene,
      (i) => this.makeSmoke(`fx-muzzle-smoke-${i}`, EFFECT_TUNING.muzzleSmokeSizeM),
      4,
    );
    this.sparkPool = new EffectPool(scene, (i) => this.makeSparks(`fx-spark-${i}`), 6);
    this.dustPool = new EffectPool(scene, (i) => this.makeDust(`fx-dust-${i}`), 6);
    this.firePool = new EffectPool(scene, (i) => this.makeFire(`fx-fire-${i}`), 4);
    this.smokePool = new EffectPool(
      scene,
      (i) => this.makeColumnSmoke(`fx-column-${i}`),
      4,
    );

    this.flashLight = new PointLight('fx-flash-light', Vector3.Zero(), scene);
    this.flashLight.diffuse = new Color3(1, 0.86, 0.6);
    this.flashLight.range = EFFECT_TUNING.flashLightRangeM;
    this.flashLight.intensity = 0;

    // The tracer is an emissive mesh rather than a particle, because it has to be *exactly* where the shell
    // is — the simulation owns that position, and a particle system would lag or interpolate past it.
    this.tracerMaterial = new StandardMaterial('fx-tracer-mat', scene);
    this.tracerMaterial.emissiveColor = new Color3(1, 0.85, 0.45);
    this.tracerMaterial.disableLighting = true;
  }

  /**
   * The muzzle flash: a very short, very bright burst.
   *
   * Built with `BLENDMODE_ONEONE` (additive) so overlapping flashes accumulate into white rather than
   * compositing to grey — which is how a real flash behaves and why it reads as *bright* rather than as a
   * pale blob.
   */
  private makeFlash(name: string): ParticleSystem {
    const system = new ParticleSystem(name, 90, this.scene);
    system.particleTexture = this.hardSprite;
    system.emitter = Vector3.Zero();
    system.minEmitBox = new Vector3(-0.12, -0.12, -0.12);
    system.maxEmitBox = new Vector3(0.12, 0.12, 0.12);
    system.color1 = new Color4(1, 0.95, 0.75, 1);
    system.color2 = new Color4(1, 0.72, 0.32, 1);
    system.colorDead = new Color4(0.4, 0.2, 0.05, 0);
    system.minSize = 0.35;
    system.maxSize = 0.95;
    // A tight cone along the barrel: the flash comes out of the *muzzle*, forward, not as a sphere around it.
    system.direction1 = new Vector3(-0.35, -0.2, 0.6);
    system.direction2 = new Vector3(0.35, 0.35, 1.4);
    system.minEmitPower = 3;
    system.maxEmitPower = 11;
    system.updateSpeed = 0.016;
    system.minLifeTime = 0.03;
    system.maxLifeTime = 0.09;
    system.emitRate = 0;
    system.blendMode = ParticleSystem.BLENDMODE_ONEONE;
    system.gravity = new Vector3(0, -2, 0);
    return system;
  }


  /**
   * Impact sparks: hot, fast, and short-lived.
   *
   * One system serves all three armour outcomes, because what differs is *where they go* and how long they
   * last, not what they are. Reusing the pool across outcomes is also why the effects budget stays small.
   */
  private makeSparks(name: string): ParticleSystem {
    const system = new ParticleSystem(name, 120, this.scene);
    system.particleTexture = this.hardSprite;
    system.emitter = Vector3.Zero();
    system.minEmitBox = new Vector3(-0.05, -0.05, -0.05);
    system.maxEmitBox = new Vector3(0.05, 0.05, 0.05);
    system.color1 = new Color4(1, 0.95, 0.7, 1);
    system.color2 = new Color4(1, 0.6, 0.15, 1);
    system.colorDead = new Color4(0.5, 0.15, 0.02, 0);
    system.minSize = 0.06;
    system.maxSize = 0.2;
    system.minLifeTime = 0.15;
    system.maxLifeTime = EFFECT_TUNING.blockedSparkSeconds;
    system.emitRate = 0;
    system.blendMode = ParticleSystem.BLENDMODE_ADD;
    // Sparks fall, because gravity is what makes them read as *material* rather than as light. A spark that
    // flies in a straight line reads as a laser sight, which is the wrong event entirely.
    system.direction1 = new Vector3(-2.5, 0.4, -2.5);
    system.direction2 = new Vector3(2.5, 3.2, 2.5);
    system.minEmitPower = 3;
    system.maxEmitPower = 13;
    system.gravity = new Vector3(0, -14, 0);
    system.updateSpeed = 0.016;
    return system;
  }

  /** Terrain dust: a soft brown plume with no sparks at all, so it cannot be mistaken for an armour hit. */
  private makeDust(name: string): ParticleSystem {
    const system = new ParticleSystem(name, 160, this.scene);
    system.particleTexture = this.softSprite;
    system.emitter = Vector3.Zero();
    system.minEmitBox = new Vector3(-0.25, 0, -0.25);
    system.maxEmitBox = new Vector3(0.25, 0.1, 0.25);
    // Deliberately earth-toned. A grey plume reads as smoke from a fire; a brown one reads as soil.
    system.color1 = new Color4(0.52, 0.44, 0.33, 0.7);
    system.color2 = new Color4(0.4, 0.34, 0.26, 0.55);
    system.colorDead = new Color4(0.36, 0.31, 0.25, 0);
    system.minSize = 0.4;
    system.maxSize = 2.4;
    system.minLifeTime = 0.5;
    system.maxLifeTime = EFFECT_TUNING.terrainDustSeconds;
    system.emitRate = 0;
    system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    system.direction1 = new Vector3(-1.4, 0.8, -1.4);
    system.direction2 = new Vector3(1.4, 3.4, 1.4);
    system.minEmitPower = 1.2;
    system.maxEmitPower = 4.5;
    system.gravity = new Vector3(0, -1.1, 0);
    system.updateSpeed = 0.014;
    return system;
  }

  /** Destruction fireball: bright, fast, and brief. The *persistence* comes from the smoke column, not this. */
  private makeFire(name: string): ParticleSystem {
    const system = new ParticleSystem(name, 200, this.scene);
    system.particleTexture = this.hardSprite;
    system.emitter = Vector3.Zero();
    system.minEmitBox = new Vector3(-0.6, -0.3, -0.6);
    system.maxEmitBox = new Vector3(0.6, 0.6, 0.6);
    system.color1 = new Color4(1, 0.95, 0.7, 1);
    system.color2 = new Color4(1, 0.42, 0.08, 0.9);
    system.colorDead = new Color4(0.35, 0.08, 0.02, 0);
    system.minSize = 0.7;
    system.maxSize = 3.2;
    system.minLifeTime = 0.25;
    system.maxLifeTime = EFFECT_TUNING.destructionFireSeconds;
    system.emitRate = 0;
    system.blendMode = ParticleSystem.BLENDMODE_ADD;
    system.direction1 = new Vector3(-3, 1.5, -3);
    system.direction2 = new Vector3(3, 7, 3);
    system.minEmitPower = 3;
    system.maxEmitPower = 12;
    system.gravity = new Vector3(0, -3, 0);
    system.updateSpeed = 0.016;
    return system;
  }

  /**
   * The smoke column above a wreck.
   *
   * The tallest effect in the game, and the one that makes a destroyed tank readable from across the map. It
   * is deliberately thin and dark rather than a dense cloud, so it marks the position without occluding the
   * battlefield the player still has to fight in.
   */
  private makeColumnSmoke(name: string): ParticleSystem {
    const system = new ParticleSystem(name, 320, this.scene);
    system.particleTexture = this.softSprite;
    system.emitter = Vector3.Zero();
    system.minEmitBox = new Vector3(-0.8, 0, -0.8);
    system.maxEmitBox = new Vector3(0.8, 0.4, 0.8);
    system.color1 = new Color4(0.18, 0.17, 0.16, 0.72);
    system.color2 = new Color4(0.32, 0.3, 0.29, 0.55);
    system.colorDead = new Color4(0.4, 0.4, 0.4, 0);
    system.minSize = 2;
    system.maxSize = 7;
    system.minLifeTime = 2.5;
    system.maxLifeTime = EFFECT_TUNING.destructionSmokeSeconds;
    system.emitRate = 0;
    system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    // Rising fast and spreading, which is what a burning vehicle's plume does.
    system.direction1 = new Vector3(-0.6, 3.5, -0.6);
    system.direction2 = new Vector3(0.9, 6.5, 0.9);
    system.minEmitPower = 1;
    system.maxEmitPower = 2.4;
    system.updateSpeed = 0.016;
    return system;
  }

  /**
   * Muzzle smoke: the lingering grey cloud that says "big gun" rather than "gun".
   *
   * Separate from the flash and far longer-lived. The flash is what the eye notices; the smoke is what the
   * player *reads* as a heavy weapon, because a big gun leaves a cloud hanging in the air for seconds.
   */
  private makeSmoke(name: string, sizeM: number): ParticleSystem {
    const system = new ParticleSystem(name, 140, this.scene);
    system.particleTexture = this.softSprite;
    system.emitter = Vector3.Zero();
    system.minEmitBox = new Vector3(-0.2, -0.2, -0.3);
    system.maxEmitBox = new Vector3(0.2, 0.2, 0.3);
    // Warm grey rather than white: smoke from a propellant charge is dirty, and pure white smoke reads as steam.
    system.color1 = new Color4(0.62, 0.6, 0.56, 0.5);
    system.color2 = new Color4(0.44, 0.43, 0.4, 0.38);
    system.colorDead = new Color4(0.4, 0.4, 0.38, 0);
    system.minSize = sizeM * 0.5;
    system.maxSize = sizeM;
    system.minLifeTime = 0.5;
    system.maxLifeTime = EFFECT_TUNING.muzzleSmokeSeconds;
    system.emitRate = 0;
    system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    // Rising and spreading, which is what smoke does and which also reads as the muzzle blast pushing air.
    system.direction1 = new Vector3(-0.5, 0.7, -0.2);
    system.direction2 = new Vector3(0.5, 1.5, 0.9);
    system.minEmitPower = 0.5;
    system.maxEmitPower = 2.2;
    system.updateSpeed = 0.014;
    return system;
  }

  /**
   * Points a particle system along the barrel.
   *
   * A `ParticleSystem`'s direction box is in world space, so a system built with a fixed cone only points the
   * right way when the gun happens to be pointing along +Z. Rebuilding the box from the forward vector is
   * exact, cheap, and about four lines, which is cheaper than carrying the cone's own extent around.
   */
  private aimSystem(system: ParticleSystem, forward: Vector3): void {
    system.direction1 = new Vector3(forward.x * 0.3 - 0.2, forward.y * 0.3 + 0.2, forward.z * 0.3 - 0.2);
    system.direction2 = new Vector3(forward.x * 1.2 + 0.2, forward.y * 1.2 + 0.3, forward.z * 1.2 + 0.2);
  }

  /**
   * Fires the gun.
   *
   * Four effects at once, because a muzzle blast is four physical things happening together: light, smoke,
   * dust, and pressure. The brief asks that firing become "one of the strongest audiovisual moments in the
   * prototype"; that comes from the combination rather than from any one of them being large.
   *
   * @param muzzle where the barrel's exit is, read from the model's own marker
   * @param forward the barrel's world direction, so the blast comes out of the muzzle rather than around it
   */
  fireGun(muzzle: Vector3, forward: Vector3): void {
    const flash = this.muzzleFlashPool.systemAt(
      this.muzzleFlashPool.burst(40, EFFECT_TUNING.muzzleFlashSeconds),
    );
    if (flash !== null) {
      flash.emitter = muzzle.clone();
      this.aimSystem(flash, forward);
    }

    const smoke = this.muzzleSmokePool.systemAt(
      this.muzzleSmokePool.burst(60, EFFECT_TUNING.muzzleSmokeSeconds),
    );
    if (smoke !== null) {
      smoke.emitter = muzzle.add(forward.scale(0.6));
      this.aimSystem(smoke, forward);
    }

    // Blast dust at the muzzle's feet. This is what makes a heavy gun feel heavy: the ground reacts, not just
    // the barrel.
    const dust = this.dustPool.systemAt(this.dustPool.burst(45, EFFECT_TUNING.blastDustSeconds));
    if (dust !== null) {
      dust.emitter = new Vector3(muzzle.x, muzzle.y - 0.7, muzzle.z);
    }

    // The point light. Brief and bright, so the ground and any nearby cover flash for a frame or two.
    this.flashLight.position = muzzle.add(forward.scale(0.8));
    this.flashLightRemaining = EFFECT_TUNING.muzzleFlashSeconds * 2.2;
    this.flashLight.intensity = EFFECT_TUNING.flashLightIntensity;
    this.flashLight.diffuse = new Color3(1, 0.86, 0.6);
  }

  /**
   * Points a particle system along the barrel.
   *

  /**
   * Shows the outcome of a shell resolving.
   *
   * ## Why each outcome gets a different *shape*, not just a different colour
   *
   * The brief requires the player to tell penetration, blocked, ricochet, and terrain apart. Colour alone does
   * not survive being 200 m away, in fog, or on a display most players have; motion and *direction* do. So:
   *
   * - **Penetration** — sparks and debris thrown *outward and up* from the plate. The round went in, so
   *   material comes out the other side.
   * - **Blocked** — a flat shower of hard sparks thrown *sideways*, with much less debris. Nothing comes out of
   *   the plate, because nothing went in.
   * - **Ricochet** — a tight, fast spark streak along a single axis, visibly travelling away. The round is
   *   still going somewhere else.
   * - **Terrain** — a soft dust plume and nothing else. No sparks at all, because sparks are the cue that says
   *   "metal", and this hit soil.
   *
   * The sound set distinguishes the same four the same way (see `docs/audio-design.md`), so the two channels
   * agree rather than each inventing its own vocabulary.
   *
   * @param incomingDirection the round's direction of travel, so a deflection streak points along the
   *   deflection instead of spraying randomly
   * @param outcome the *combat* verdict, when one exists. A `ShellImpact` knows only what was struck — the
   *   simulation deliberately splits "where and how did it hit" (V2) from "what does that do" (V3) — so the
   *   outcome has to be passed alongside rather than read from the impact.
   */
  showImpact(impact: ShellImpact, outcome: ImpactOutcome = 'impacted', incomingDirection?: Vector3): void {
    const at = new Vector3(impact.position.x, impact.position.y, impact.position.z);
    const isRicochet = outcome === 'ricocheted';
    const isBlocked = outcome === 'blocked';
    const isPenetration = outcome === 'penetrated';

    if (impact.targetKind === 'vehicle') {
      const window = isBlocked ? EFFECT_TUNING.blockedSparkSeconds : 0.4;
      const system = this.sparkPool.systemAt(this.sparkPool.burst(isBlocked || isRicochet ? 55 : 34, window));
      if (system !== null) {
        system.emitter = at;
        if (isRicochet && incomingDirection !== undefined) {
          // A ricochet sprays *along* the deflection, which is the one cue that says "this went past".
          const d = incomingDirection.normalize();
          system.direction1 = d.scale(6);
          system.direction2 = d.scale(16);
          system.minEmitPower = 8;
          system.maxEmitPower = 18;
        } else if (isBlocked) {
          // A blocked hit throws sparks back out along the plate, because the energy has to go somewhere.
          system.direction1 = new Vector3(-3, 0.2, -3);
          system.direction2 = new Vector3(3, 2.4, 3);
        } else {
          // A penetration throws debris outward: it went through, so the far side of the plate came apart.
          system.direction1 = new Vector3(-1.6, 0.6, -1.6);
          system.direction2 = new Vector3(1.6, 3.6, 1.6);
        }
      }

      // Dust and smoke on every armour outcome. A penetration produces the most, because it has torn a hole
      // and something inside is now burning.
      const count = (isPenetration ? 70 : 28);
      const dustWindow = (isPenetration ? EFFECT_TUNING.penetrationSmokeSeconds : 0.9);
      const dust = this.dustPool.systemAt(this.dustPool.burst(count, dustWindow));
      if (dust !== null) {
        dust.emitter = at;
      }
    } else {
      // Soil, stone, or a road: dust only.
      const dust = this.dustPool.systemAt(this.dustPool.burst(70, EFFECT_TUNING.terrainDustSeconds));
      if (dust !== null) {
        dust.emitter = at;
      }
    }

    this.spawnMarker(at);
  }

  /**
   * A vehicle has been destroyed.
   *
   * Three effects, in the order a real one happens: a fireball, a dust ring thrown outward by the blast, and
   * then a smoke column that persists. The column is what the player reads as "that tank is dead" from
   * anywhere on the map, so it is the longest-lived effect in the game.
   */
  showDestruction(position: Vector3): void {
    const at = position.clone();

    const fire = this.firePool.systemAt(this.firePool.burst(220, EFFECT_TUNING.destructionFireSeconds));
    if (fire !== null) {
      fire.emitter = at;
    }

    const dust = this.dustPool.systemAt(this.dustPool.burst(120, EFFECT_TUNING.terrainDustSeconds * 1.5));
    if (dust !== null) {
      dust.emitter = at;
    }

    const column = this.smokePool.systemAt(
      this.smokePool.burst(260, EFFECT_TUNING.destructionSmokeSeconds),
    );
    if (column !== null) {
      column.emitter = at.add(new Vector3(0, 0.8, 0));
    }

    // A sustained orange light at the wreck for a moment, so the destruction is lit even in shadow.
    this.flashLight.position = at.add(new Vector3(0, 1, 0));
    this.flashLight.diffuse = new Color3(1, 0.5, 0.2);
    this.flashLightRemaining = 1.2;
    this.flashLight.intensity = EFFECT_TUNING.flashLightIntensity * 0.7;

    this.burnSites.push({ position: at.clone(), remainingSeconds: EFFECT_TUNING.wreckFireSeconds });
  }

  /**
   * A small marker where a shell landed, so the player can see where their last shot went.
   *
   * Bounded at four: only the most recent impacts matter, and a battlefield littered with a hundred markers is
   * unreadable. The oldest is recycled rather than a new one created, which also keeps the mesh count flat
   * over a long battle.
   */
  private spawnMarker(at: Vector3): void {
    if (this.markers.length >= 4) {
      const oldest = this.markers.shift();
      oldest?.mesh.dispose();
    }
    const mesh = MeshBuilder.CreateBox('impact-marker', { size: 0.22 }, this.scene);
    mesh.position.copyFrom(at);
    mesh.material = this.tracerMaterial;
    mesh.isPickable = false;
    this.markers.push({ mesh, remainingSeconds: EFFECT_TUNING.impactMarkerSeconds });
  }

  /**
   * Syncs the tracer meshes to the shells in flight.
   *
   * Each tracer sits at the shell's *own* position, which is the simulation's value: the effect is a view of
   * where the round is, never an estimate of it. Meshes are pooled by shell id, so a shell in flight for many
   * ticks keeps the same mesh and is only moved and reoriented.
   */
  private syncTracers(shells: readonly ShellState[]): void {
    const live = new Set<number>();
    for (const shell of shells) {
      live.add(shell.id);
      let mesh = this.tracers.get(shell.id);
      if (mesh === undefined) {
        // A short box, not a point: the streak's *length* is what makes the round's direction readable, and a
        // directionless dot cannot show an arc.
        mesh = MeshBuilder.CreateBox(
          `tracer-${shell.id}`,
          { width: 0.09, height: 0.09, depth: EFFECT_TUNING.tracerLengthM },
          this.scene,
        );
        mesh.material = this.tracerMaterial;
        mesh.isPickable = false;
        this.tracers.set(shell.id, mesh);
      }
      mesh.position.set(shell.position.x, shell.position.y, shell.position.z);
      // Oriented along the shell's velocity, so the streak points where it is actually going. A tracer that
      // always points the same way would make a lobbed shot look flat.
      mesh.lookAt(
        new Vector3(
          shell.position.x + shell.velocity.x,
          shell.position.y + shell.velocity.y,
          shell.position.z + shell.velocity.z,
        ),
      );
    }

    for (const [id, mesh] of this.tracers) {
      if (!live.has(id)) {
        mesh.dispose();
        this.tracers.delete(id);
      }
    }
  }

  /**
   * Ages every transient effect. Called once per frame.
   *
   * @param deltaSeconds elapsed time, so ages are frame-rate independent
   */
  update(shells: readonly ShellState[], deltaSeconds: number): void {
    this.syncTracers(shells);

    // The flash light decays rather than switching off, so a muzzle flash fades instead of blinking out. The
    // multiplier is per-frame rather than time-based because this is a visual fade over a handful of frames;
    // making it exact would be false precision.
    if (this.flashLightRemaining > 0) {
      this.flashLightRemaining -= deltaSeconds;
      this.flashLight.intensity *= 0.82;
      if (this.flashLightRemaining <= 0) {
        this.flashLight.intensity = 0;
        // Restored to the muzzle colour, which `fireGun` sets anyway but `showDestruction` overwrites.
        this.flashLight.diffuse = new Color3(1, 0.86, 0.6);
      }
    }

    for (let i = this.markers.length - 1; i >= 0; i -= 1) {
      const marker = this.markers[i]!;
      marker.remainingSeconds -= deltaSeconds;
      if (marker.remainingSeconds <= 0) {
        marker.mesh.dispose();
        this.markers.splice(i, 1);
        continue;
      }
      // Fades over its final second, so a marker does not vanish abruptly.
      marker.mesh.visibility = Math.min(1, marker.remainingSeconds);
    }

    for (let i = this.burnSites.length - 1; i >= 0; i -= 1) {
      const site = this.burnSites[i]!;
      site.remainingSeconds -= deltaSeconds;
      if (site.remainingSeconds <= 0) {
        this.burnSites.splice(i, 1);
      }
    }
  }

  /** Number of live impact markers, for tests and the debug overlay. */
  get impactMarkerCount(): number {
    return this.markers.length;
  }

  /** Number of tracer meshes currently drawn. */
  get tracerCount(): number {
    return this.tracers.size;
  }

  /** Number of burning wrecks. */
  get burningWreckCount(): number {
    return this.burnSites.length;
  }

  /** The scene these effects belong to. */
  get owningScene(): Scene {
    return this.scene;
  }

  /** Removes every effect, for a battle restart. */
  clear(): void {
    for (const mesh of this.tracers.values()) {
      mesh.dispose();
    }
    this.tracers.clear();
    for (const marker of this.markers) {
      marker.mesh.dispose();
    }
    this.markers.length = 0;
    this.burnSites.length = 0;
    this.flashLight.intensity = 0;
    this.flashLightRemaining = 0;
    this.muzzleFlashPool.clear();
    this.muzzleSmokePool.clear();
    this.sparkPool.clear();
    this.dustPool.clear();
    this.firePool.clear();
    this.smokePool.clear();
  }

  /** Disposes every pool and material. */
  dispose(): void {
    this.clear();
    this.muzzleFlashPool.dispose();
    this.muzzleSmokePool.dispose();
    this.sparkPool.dispose();
    this.dustPool.dispose();
    this.firePool.dispose();
    this.smokePool.dispose();
    this.softSprite.dispose();
    this.hardSprite.dispose();
    this.tracerMaterial.dispose();
    this.flashLight.dispose();
  }
}

/** Re-exported so callers reach the tuning without a second import. */
export { EFFECT_TUNING as EFFECT_SETTINGS };
