import { makeInput, type InputCommand } from '../../shared/input.js';
import type { Vec3 } from '../../shared/vec3.js';

/**
 * Keyboard and mouse capture, converted into `InputCommand` values.
 *
 * The client reads devices; the core never does (ADR-0001). This is the only place in the project
 * that knows a "W" key exists, which is what allows the AI arriving in V5 to produce input through
 * the same interface without touching any device code.
 *
 * Controls follow the owner's decision on OD-02 — **direct WASD hull control**:
 *   - W / S: forward and reverse throttle.
 *   - A / D: rotate the hull.
 *   - Mouse: look direction, which moves the camera only.
 *   - C: return the camera directly behind the hull.
 *
 * The camera swings freely and is tracked *relative* to the hull, so mouse-look stays independent while
 * the player always has a recoverable relationship between where the tank points and where they are
 * looking. See camera/orbit-camera.ts for why that distinction was measured rather than assumed.
 *
 * The hull is never rotated toward where the camera is pointing. Camera and hull are genuinely
 * independent, which is the control model the genre asks for: where you look and where your tank
 * faces are two different decisions.
 */

/** Radians of camera rotation per pixel of mouse movement. A tuning parameter, not a constant. */
const LOOK_SENSITIVITY_RAD_PER_PIXEL = 0.0022;

/**
 * How quickly the control axes reach their target, in units of 1/second.
 *
 * A value of 6 means a key held from rest reaches full deflection in roughly 0.4 s. Tank controls
 * are not binary, and an instant jump from 0 to full throttle is the most effective way to make a
 * heavy vehicle feel like a shopping trolley. Derived from dt, so the feel is frame-rate
 * independent.
 */
const INPUT_SMOOTHING_PER_SECOND = 6;

/** Keys whose default browser behaviour (scrolling) would interfere with driving. */
const TRACKED_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  // V6: returns the camera behind the tank. The escape hatch that makes a free orbit safe.
  'KeyC',
]);

export interface LookDelta {
  /** Horizontal look movement in radians, positive is right. */
  readonly yawRad: number;
  /** Vertical look movement in radians, positive is up. */
  readonly pitchRad: number;
}

export class InputManager {
  private readonly keys = new Set<string>();
  private readonly pressedKeys = new Set<string>();

  private pendingYawRad = 0;
  private pendingPitchRad = 0;
  private pendingZoom = 0;

  private smoothedThrottle = 0;
  private smoothedTurn = 0;

  private onLockChange: (locked: boolean) => void = () => {};

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Only treat a key as held once, so auto-repeat cannot double-count.
    if (!this.keys.has(event.code)) {
      this.pressedKeys.add(event.code);
    }
    this.keys.add(event.code);

    if (TRACKED_CODES.has(event.code)) {
      // Stop the page scrolling out from under the game while driving.
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  /** Releasing focus must clear held keys, or the tank drives on forever after an alt-tab. */
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.firing = false;
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    // Only the primary button fires. Without the check, a right-click to dismiss a context menu
    // would also shoot.
    if (event.button === 0) {
      this.firing = true;
    }
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) {
      this.firing = false;
    }
  };

  /** True while the primary mouse button is held down. */
  private firing = false;

  private readonly onMouseMove = (event: MouseEvent): void => {
    // movementX/Y are unreliable when the cursor is not locked, so they are only used while the
    // pointer is captured. Otherwise the camera would jump when the cursor re-enters the window.
    if (document.pointerLockElement === null) {
      return;
    }
    this.pendingYawRad += event.movementX * LOOK_SENSITIVITY_RAD_PER_PIXEL;
    this.pendingPitchRad -= event.movementY * LOOK_SENSITIVITY_RAD_PER_PIXEL;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Normalise across the three deltaMode units browsers report, so zoom feels the same
    // regardless of device or platform.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    this.pendingZoom += (event.deltaY * unit) / 400;
  };

  private readonly onPointerLockChange = (): void => {
    this.onLockChange(document.pointerLockElement !== null);
  };

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('contextmenu', preventContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  /** Registers a callback fired when the pointer is captured or released. */
  setLockListener(listener: (locked: boolean) => void): void {
    this.onLockChange = listener;
  }

  /** Requests mouse capture, so mouse movement drives the camera without a visible cursor. */
  requestPointerLock(): void {
    void this.target.requestPointerLock();
  }

  /**
   * Reads the current driving input.
   *
   * Keyboard axes are smoothed toward their target rather than applied instantly, because a tank's
   * controls are not binary. The *simulation* still applies its own acceleration curve on top of
   * this, so the smoothing adds presentational weight rather than substituting for the core model.
   *
   * @param aimPoint world point the gun should train on, resolved from the camera's view ray by the
   *   caller. `null` means "hold the current gun orientation".
   */
  readDrivingInput(dtSeconds: number, aimPoint: Vec3 | null = null): InputCommand {
    const throttleTarget = axis(
      this.isDown('KeyW') || this.isDown('ArrowUp'),
      this.isDown('KeyS') || this.isDown('ArrowDown'),
    );
    const turnTarget = axis(
      this.isDown('KeyD') || this.isDown('ArrowRight'),
      this.isDown('KeyA') || this.isDown('ArrowLeft'),
    );

    const step = Math.min(1, INPUT_SMOOTHING_PER_SECOND * dtSeconds);
    this.smoothedThrottle += (throttleTarget - this.smoothedThrottle) * step;
    this.smoothedTurn += (turnTarget - this.smoothedTurn) * step;

    // Snap to zero once the residual is small enough to be invisible, so the vehicle settles
    // instead of asymptotically approaching a stop.
    if (Math.abs(this.smoothedThrottle) < 1e-3) {
      this.smoothedThrottle = 0;
    }
    if (Math.abs(this.smoothedTurn) < 1e-3) {
      this.smoothedTurn = 0;
    }

    // Aiming is a *continuous* input and is passed straight through, unsmoothed. The turret's own
    // rate limit is the mechanism that makes the movement feel weighted; smoothing it here as well
    // would only stack extra lag on a limit that already exists.
    return makeInput(this.smoothedThrottle, this.smoothedTurn, aimPoint, this.firing);
  }

  /** Returns and clears the accumulated look delta, tying mouse input to frames. */
  consumeLookDelta(): LookDelta {
    const delta = { yawRad: this.pendingYawRad, pitchRad: this.pendingPitchRad };
    this.pendingYawRad = 0;
    this.pendingPitchRad = 0;
    return delta;
  }

  /** Returns and clears the accumulated zoom delta. */
  consumeZoomDelta(): number {
    const zoom = this.pendingZoom;
    this.pendingZoom = 0;
    return zoom;
  }

  /** True once, on the frame a key is first pressed. Used for one-shot actions. */
  consumeKeyPress(code: string): boolean {
    if (this.pressedKeys.has(code)) {
      this.pressedKeys.delete(code);
      return true;
    }
    return false;
  }

  /** Clears per-frame state. Call at the end of each frame. */
  endFrame(): void {
    this.pressedKeys.clear();
  }

  private isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Removes every listener. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.target.removeEventListener('wheel', this.onWheel);
    this.target.removeEventListener('contextmenu', preventContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }
}

/** Builds a signed axis from a positive and a negative key state. */
function axis(positive: boolean, negative: boolean): number {
  if (positive === negative) {
    return 0;
  }
  return positive ? 1 : -1;
}

/**
 * Suppresses the browser context menu over the canvas.
 *
 * Right-click is not bound to anything, so the menu would only ever appear as an interruption in the
 * middle of a mouse-look.
 */
function preventContextMenu(event: Event): void {
  event.preventDefault();
}

