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
  /** Default distance behind the vehicle, metres. */
  defaultDistanceM: 13,
  /** Closest the camera may be pulled in by obstruction, metres. */
  minDistanceM: 3.2,
  /** Furthest the player may zoom out, metres. */
  maxDistanceM: 34,
  /** Metres the camera target sits above the vehicle origin. */
  targetHeightM: 2.4,
  /** Initial downward tilt, radians. Positive looks down. */
  initialPitchRad: 0.32,
  /** Vertical look limits, radians. Prevents flipping over the top. */
  minPitchRad: -0.25,
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
    this.applyTransform();
  }

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
    this.camera.position.set(
      this.smoothedTarget.x + offset.x,
      this.smoothedTarget.y + offset.y,
      this.smoothedTarget.z + offset.z,
    );
    this.camera.setTarget(this.smoothedTarget);
  }

  /** Snaps the orbit behind the vehicle, bound to a recentre key. */
  recentreBehind(headingRad: number): void {
    this.yawRad = headingRad;
  }
}

function clampRange(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

