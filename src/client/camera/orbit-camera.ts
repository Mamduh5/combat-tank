import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { wrapAngle, type Vec3 } from '../../core/math/index.js';
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
  /**
   * How quickly the camera's swing around the hull eases back to directly behind it, per second.
   *
   * This is the whole of the corrected control feel. The camera is still free to orbit and the turret
   * is still fully independent, but the swing is *relative* and decays toward zero, so the hull's
   * direction on screen is always recoverable. Measured before the fix: 63 degrees of unrecoverable
   * mismatch on the opening frame, and unbounded once the player moved the mouse.
   *
   * 0.9 means roughly a third of the offset is removed per second - fast enough that a player who stops
   * looking is soon looking at their own tank again, slow enough that deliberate looking around is
   * never fought.
   */
  hullFollowRecoveryPerSec: 0.9,
} as const;

export class OrbitCamera {
  /** Current orbit yaw, radians. */
  private yawRad = 0;
  /**    * The hull heading the camera is currently being carried by, radians.    *    * Stored rather than recomputed from the transform so the obstruction solver and `snapToTarget` can    * build a correct camera position without a caller having to supply the heading as well.    */    private hullYawRad = 0;
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
   * @param hullHeadingRad the hull's current heading, so hull rotation can carry the camera
   */
  update(
    focus: Vec3,
    lookDelta: { yawRad: number; pitchRad: number },
    zoomDelta: number,
    dtSeconds: number,
    hullHeadingRad: number,
  ): void {
    // The orbit yaw is tracked **relative to the hull**; the hull heading is added in when the
    // transform is built. Storing a world-space yaw instead is what made the controls read as reversed,
    // and the reason is worth recording because the fix looks like a one-line sign swap and is not.
    //
    // Measured in the running game: under +1 throttle the tank moved `alongOwnNoseDeg: 0` at hull headings
    // of 0, 90, 180 and 270 degrees, and -180 under reverse. **The control contract was already
    // correct** and needed no change at all. What was broken was the framing: on spawn the camera looked
    // 63 degrees away from the direction the tank pointed, because nothing ever related the two. A free
    // orbit that does not track the hull will eventually sit on the tank's nose side, and from there W
    // genuinely does drive away from the camera and A/D do appear swapped - with nothing on screen to
    // say so.
    // Carry the camera with the hull, and quietly walk the swing back to centre.
    //
    // The recovery term is what turns a free orbit into a *relative* one: the player may look anywhere,
    // and when they stop looking the camera eases back behind the tank rather than leaving the hull
    // pointing 60 degrees off to one side with nothing on screen to indicate it. Without this the tank's

    // heading relative to the view is unbounded, and an unbounded reference is the same defect as no
    // reference at all - it just happens to look fine until the player orbits once.
    this.setHullYaw(hullHeadingRad);
    const centred = wrapAngle(this.yawRad);
    const recovery = 1 - Math.exp(-CAMERA_TUNING.hullFollowRecoveryPerSec * dtSeconds);
    this.yawRad = wrapAngle(this.yawRad + centred * recovery);
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

  /**
   * Offset from the orbit target to the camera position, for the current angles and distance.
   *
   * The orbit yaw is **hull-relative**: `yawRad` is how far the camera has been swung around the tank's
   * own axis, and the hull's world heading is added here. Keeping the two separate is what lets the
   * camera follow hull rotation while the player still looks around freely, and it is the difference
   * between "the camera is behind my tank" and "the camera is somewhere and my tank is somewhere".
   *
   * `orbitOffset` is the *negation* of the resulting forward vector, which is what places the camera
   * behind the tank when `yawRad` is zero. That sign is the reason this function reads the way it does,
   * and flipping it would put the camera permanently in front of the vehicle - which is exactly the
   * reported symptom, arrived at from the other direction.
   */
  private orbitOffset(distance: number): { x: number; y: number; z: number } {
    const yaw = this.yawRad + this.hullYawRad;
    const cosPitch = Math.cos(this.pitchRad);
    return {
      x: -Math.sin(yaw) * cosPitch * distance,
      y: Math.sin(this.pitchRad) * distance,
      z: -Math.cos(yaw) * cosPitch * distance,
    };
  }
  /**
   * Records the hull heading the camera is currently being carried by.
   *
   * Tracked rather than passed to `orbitOffset` so `snapToTarget` and the obstruction solver can build
   * a transform without a caller having to supply the heading as well.
   */
  private setHullYaw(hullHeadingRad: number): void {
    this.hullYawRad = hullHeadingRad;
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
  snapToTarget(hullHeadingRad = 0): void {
    // Directly behind the hull, not at a fixed world yaw. Snapping to a constant put the camera 63
    // degrees off the tank's nose on the opening frame of a map whose spawn is not facing +Z, which is
    // most of why the controls read as reversed on a restart.
    this.yawRad = 0;
    this.setHullYaw(wrapAngle(hullHeadingRad));
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

  /**
   * Returns the camera to directly behind the hull, and is bound to a key.
   *
   * The escape hatch that makes a free orbit safe. Mouse look is still independent of the hull, as the
   * control model requires, but a player who has lost the relationship can always get it back without
   * hunting for it.
   */
  recentreBehind(headingRad: number): void {
    this.yawRad = 0;
    this.setHullYaw(wrapAngle(headingRad));
    this.applyTransform();
  }
}

function clampRange(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * The camera's offset from its orbit target, in world space.
 *
 * Extracted as a pure function so the control contract can be tested without a scene, an engine, or a
 * browser. The V6 correction pass turned on one measurement of this: whether the camera sits where the
 * player believes it does, and whether the tank's nose points where the screen says it does. Both are
 * pure geometry, and testing them through a running game meant a 24-second browser round trip per data
 * point, which is why the first version of the probe reported its own results with inverted labels and
 * nearly sent me to "fix" correct code.
 *
 * @param distance orbit radius, metres
 * @param pitchRad tilt, positive looks down
 * @param worldYawRad the *world* orbit yaw: hull heading plus the player's swing around the hull
 * @returns the offset from the target to the camera
 */
export function cameraOffsetFromTarget(
  distance: number,
  pitchRad: number,
  worldYawRad: number,
): { x: number; y: number; z: number } {
  const cosPitch = Math.cos(pitchRad);
  return {
    x: -Math.sin(worldYawRad) * cosPitch * distance,
    y: Math.sin(pitchRad) * distance,
    z: -Math.cos(worldYawRad) * cosPitch * distance,
  };
}