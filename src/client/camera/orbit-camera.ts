import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import type { Vec3 } from '../../core/math/index.js';
import type { PhysicsWorld } from '../physics/rapier-terrain.js';

/**
 * Third-person orbit camera.
 *
 * The camera orbits a point above the vehicle and is driven entirely by the mouse. Critically, it
 * is **independent of the hull's heading**: the owner settled direct WASD hull control (OD-02), so
 * the camera never snaps behind the tank and never steers it. Looking somewhere and facing
 * somewhere else is a legitimate and intended state, and one the player must be able to hold while
 * reversing or traversing on the spot.
 *
 * Obstruction handling pulls the camera in when terrain would come between it and the vehicle,
 * using a Rapier ray cast. Without this the camera ends up inside a hillside on any slope, which is
 * the most common way a third-person camera makes a game unplayable.
 */

/**
 * Camera tuning. Named parameters rather than unexplained constants, so feel can be adjusted
 * without hunting through the maths.
 */
export const CAMERA_TUNING = {
  /**
   * Default distance behind the vehicle, metres.
   *
   * Raised from 17 in V4, after a screenshot showed the player's tank filling the lower third of the
   * screen at the V3R distance. A duel needs **both** tanks comfortably in frame at once: at 17 m the
   * player's own hull dominated the view and the opponent was a speck near the horizon, which is the
   * opposite of what the player needs when deciding whether to advance or hold.
   */
  defaultDistanceM: 22,
  /** Closest the camera may be pulled in by obstruction, metres. */
  minDistanceM: 4.5,
  /** Furthest the player may zoom out, metres. */
  maxDistanceM: 40,
  /**
   * Metres the camera target sits above the vehicle origin.
   *
   * Aimed at the turret roof rather than the hull floor. Pointing at the floor put the camera nearly
   * level with the tracks, so the vehicle read as a slab and its own hull occluded the ground the
   * player was aiming at.
   */
  targetHeightM: 2.8,
  /**
   * Initial downward tilt, radians. Positive looks down.
   *
   * Raised from 0.32 to 0.42 in V3R to show the ground ahead. V4 lowered it again to 0.34, for the
   * opposite reason to the one that raised it: with a moving opponent in the frame, too much downward
   * tilt puts the horizon off the top of the screen and leaves the player judging range against bare
   * ground. At 0.34 both the tank and the horizon where the enemy is sit comfortably in frame.
   */
  initialPitchRad: 0.34,
  /** Vertical look limits, radians. Prevents flipping over the top. */
  minPitchRad: -0.2,
  maxPitchRad: 1.25,
  /** How quickly the camera position chases its target, in units of 1/second. */
  followStiffness: 14,
  /**
   * How quickly an obstruction-induced pull-in is released, in units of 1/second.
   *
   * Deliberately slower than the pull-in, so the camera eases out from behind cover instead of
   * springing back the instant the obstruction clears.
   */
  obstructionReleaseStiffness: 3.2,
  /** How much distance one wheel notch changes, metres. */
  zoomStepM: 2.2,
  /**
   * How far short of an obstruction the camera stops, metres.
   *
   * Without this margin the near plane crosses into the surface, which reads as the camera
   * clipping through the world.
   */
  surfacePaddingM: 0.45,
  /** Minimum height the camera keeps above the ground directly beneath it, metres. */
  groundClearanceM: 1.1,
} as const;

export class OrbitCamera {
  /** Current orbit yaw, radians. */
  private yawRad = 0;
  private pitchRad: number = CAMERA_TUNING.initialPitchRad;
  private distanceM: number = CAMERA_TUNING.defaultDistanceM;

  /** Smoothed follow position, so the camera trails the vehicle rather than being welded to it. */
  private readonly smoothedTarget = new Vector3();
  private currentDistanceM: number = CAMERA_TUNING.defaultDistanceM;

  private initialised = false;

  constructor(
    private readonly camera: UniversalCamera,
    private readonly physics: PhysicsWorld,
  ) {}

  get orbitYawRad(): number {
    return this.yawRad;
  }

  get orbitPitchRad(): number {
    return this.pitchRad;
  }

  get currentDistance(): number {
    return this.currentDistanceM;
  }

  /**
   * Applies mouse input and repositions the camera.
   *
   * @param focus      the point to orbit, normally just above the vehicle
   * @param lookDelta  mouse movement accumulated this frame
   * @param zoomDelta  wheel movement accumulated this frame
   */
  update(
    focus: Vec3,
    lookDelta: { yawRad: number; pitchRad: number },
    zoomDelta: number,
    dtSeconds: number,
  ): void {
    this.yawRad += lookDelta.yawRad;
    this.pitchRad = clampRange(
      this.pitchRad + lookDelta.pitchRad,
      CAMERA_TUNING.minPitchRad,
      CAMERA_TUNING.maxPitchRad,
    );

    if (zoomDelta !== 0) {
      this.distanceM = clampRange(
        this.distanceM + zoomDelta * CAMERA_TUNING.zoomStepM,
        CAMERA_TUNING.minDistanceM,
        CAMERA_TUNING.maxDistanceM,
      );
    }

    // The orbit target is a point above the vehicle, not its origin, so the camera looks slightly
    // over the hull rather than through the tracks.
    const desiredTarget = new Vector3(focus.x, focus.y + CAMERA_TUNING.targetHeightM, focus.z);

    if (!this.initialised) {
      // On the first frame, snap rather than easing in from the origin, which would otherwise show
      // a fast fly-in on every launch.
      this.smoothedTarget.copyFrom(desiredTarget);
      this.currentDistanceM = this.distanceM;
      this.initialised = true;
    } else {
      // Exponential follow, derived from dt so the lag is identical at any frame rate.
      const follow = 1 - Math.exp(-CAMERA_TUNING.followStiffness * dtSeconds);
      this.smoothedTarget.x += (desiredTarget.x - this.smoothedTarget.x) * follow;
      this.smoothedTarget.y += (desiredTarget.y - this.smoothedTarget.y) * follow;
      this.smoothedTarget.z += (desiredTarget.z - this.smoothedTarget.z) * follow;
    }

    this.currentDistanceM = this.resolveObstruction(dtSeconds);
    this.ageShake(dtSeconds);
    this.applyTransform();
  }

  /**
   * Advances the shake decay, clearing it once it has elapsed.
   *
   * The amplitude follows the *square* of the remaining fraction rather than the fraction itself. A
   * linear decay is perceptible as a single jolt followed by a slow drift; squaring it spends most of the
   * effect in the first third, which reads as an impact rather than as the camera being knocked.
   */
  private ageShake(dtSeconds: number): void {
    if (this.shakeRemainingSeconds <= 0) {
      this.shakeMagnitudeM = 0;
      return;
    }
    this.shakeRemainingSeconds = Math.max(0, this.shakeRemainingSeconds - dtSeconds);
    const fraction = this.shakeTotalSeconds > 0 ? this.shakeRemainingSeconds / this.shakeTotalSeconds : 0;
    this.shakeMagnitudeM *= fraction * fraction;
    if (this.shakeRemainingSeconds <= 0) {
      this.shakeMagnitudeM = 0;
      this.shakeTotalSeconds = 1;
    }
  }

  /**
   * The current positional shake offset, metres.
   *
   * Uses `Math.random` freely: this is **client presentation**, not simulation state, so it is outside
   * the determinism rules the core obeys (ADR-0005) and is not part of anything a test can assert.
   */
  private shakeOffset(): { x: number; y: number; z: number } {
    if (this.shakeMagnitudeM <= 0) {
      return { x: 0, y: 0, z: 0 };
    }
    return {
      x: (Math.random() * 2 - 1) * this.shakeMagnitudeM,
      y: (Math.random() * 2 - 1) * this.shakeMagnitudeM * 0.7,
      z: (Math.random() * 2 - 1) * this.shakeMagnitudeM,
    };
  }

  /** Remaining shake time, seconds. Zero when not shaking. */
  private shakeRemainingSeconds = 0;
  /** Total shake duration, used to compute the decay curve. */
  private shakeTotalSeconds = 1;
  /** Peak shake displacement, metres. */
  private shakeMagnitudeM = 0;

  /**
   * Reduces the orbit distance so terrain does not come between the camera and the vehicle.
   *
   * Two mechanisms are combined, because neither alone is sufficient:
   *  - A ray cast along the view direction, which handles a hill between camera and vehicle.
   *  - A floor derived from the terrain height under the camera, which handles the camera sinking
   *    into a slope it is looking across even when no ray was blocked.
   */
  private resolveObstruction(dtSeconds: number): number {
    const target = this.smoothedTarget;
    const offset = this.orbitOffset(this.distanceM);
    const from = { x: target.x, y: target.y, z: target.z };
    const to = {
      x: target.x + offset.x,
      y: target.y + offset.y,
      z: target.z + offset.z,
    };

    let allowed = this.distanceM;

    // 1. Line from the orbit target to the desired camera position.
    const hit = this.physics.raycast(from, offset, this.distanceM);
    if (hit !== null) {
      // Stop short of the surface so the near plane does not cross into it.
      allowed = Math.max(CAMERA_TUNING.minDistanceM, hit.distanceM - CAMERA_TUNING.surfacePaddingM);
    }

    // 2. Keep the camera above the ground it is over.
    const groundUnderCamera = this.physics.groundHeightAt(to.x, to.z);
    if (groundUnderCamera !== null) {
      const requiredHeight = groundUnderCamera.point.y + CAMERA_TUNING.groundClearanceM;
      const verticalExcess = to.y - requiredHeight;
      if (verticalExcess < 0) {
        // Convert the vertical shortfall into a distance along the view ray, so it is comparable
        // with the ray-cast result above.
        const verticalComponent = Math.abs(offset.y);
        if (verticalComponent > 1e-3) {
          const alongRay = (-verticalExcess * this.distanceM) / verticalComponent;
          allowed = Math.max(CAMERA_TUNING.minDistanceM, allowed - alongRay);
        }
      }
    }

    // Pull in immediately, ease back out. Snapping outward the instant the obstruction clears is
    // jarring and reads as a bug.
    if (allowed < this.currentDistanceM) {
      this.currentDistanceM = allowed;
    } else {
      const release = 1 - Math.exp(-CAMERA_TUNING.obstructionReleaseStiffness * dtSeconds);
      this.currentDistanceM += (allowed - this.currentDistanceM) * release;
    }

    return this.currentDistanceM;
  }

  /** Offset from the orbit target to the camera position, for the current angles and distance. */
  private orbitOffset(distance: number): { x: number; y: number; z: number } {
    const cosPitch = Math.cos(this.pitchRad);
    return {
      x: -Math.sin(this.yawRad) * cosPitch * distance,
      y: Math.sin(this.pitchRad) * distance,
      z: -Math.cos(this.yawRad) * cosPitch * distance,
    };
  }

  private applyTransform(): void {
    const offset = this.orbitOffset(this.currentDistanceM);
    const shake = this.shakeOffset();
    this.camera.position.set(
      this.smoothedTarget.x + offset.x + shake.x,
      this.smoothedTarget.y + offset.y + shake.y,
      this.smoothedTarget.z + offset.z + shake.z,
    );
    // The aim target is deliberately **not** shaken: shaking where the camera looks would make the
    // reticle jump, and the player is often lining up a shot while under fire. Only the camera body
    // moves, so the hit is felt without the aim being disturbed.
    this.camera.setTarget(this.smoothedTarget);
  }

  /**
   * Snaps the camera back to its default framing of the vehicle.
   *
   * Added in V4 for restart. Without it, restarting after a fight leaves the camera wherever the last
   * battle ended: possibly zoomed in on a rock, or looking at the sky, or at a completely different
   * distance. The simulation resets but the *view* does not, and the encounter appears to start from an
   * arbitrary angle — which reads as a broken restart rather than as a reset.
   *
   * The orbit angles themselves are restored to the default, not just the distance.
   */
  snapToTarget(): void {
    this.yawRad = 0;
    this.pitchRad = CAMERA_TUNING.initialPitchRad;
    this.distanceM = CAMERA_TUNING.defaultDistanceM;
    this.currentDistanceM = CAMERA_TUNING.defaultDistanceM;
    this.applyTransform();
  }

  /**
   * Adds a short, decaying positional shake, for taking a hit.
   *
   * Deliberately **displacement, not rotation**: a rotational shake fights the camera's own controls
   * and makes aiming during the effect unpleasant, whereas a brief positional jolt is felt without
   * being in the way. The player is often under fire *and* trying to line up a shot, so anything that
   * degrades aiming during a hit is the wrong choice.
   *
   * Randomised per axis with a decay, which reads as an impact rather than as a wobble.
   */
  shake(durationSeconds: number, magnitudeM: number): void {
    this.shakeRemainingSeconds = Math.max(this.shakeRemainingSeconds, durationSeconds);
    this.shakeTotalSeconds = Math.max(this.shakeTotalSeconds, durationSeconds);
    this.shakeMagnitudeM = Math.max(this.shakeMagnitudeM, magnitudeM);
  }

  recentreBehind(headingRad: number): void {
    this.yawRad = headingRad;
  }
}

function clampRange(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

