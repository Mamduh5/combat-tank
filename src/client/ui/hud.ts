import { radToDeg, wrapAngle } from '../../core/math/index.js';
import type { VehicleTelemetry } from '../../core/vehicle/vehicle-state.js';

/**
 * Minimal heads-up display.
 *
 * The V1 scope was a speed readout plus diagnostics; V2 adds the gunnery state. The elements exist
 * to make the simulation *legible* (vision principle P6): the player should be able to see that the
 * tank is heavy, that the turret is genuinely slewing rather than snapping, and that the gun is
 * reloading, without guessing.
 *
 * Text is written to the DOM only when it changes. Assigning `textContent` on a node the browser has
 * already laid out forces style recalculation, so a HUD updated every frame at 60 Hz is a measurable
 * cost for no benefit.
 *
 * Elements are looked up once and cached, and a missing element is tolerated rather than thrown, so
 * the HUD degrades instead of breaking the frame loop.
 */
export class Hud {
  private readonly speedValue: HTMLElement | null;
  private readonly gearValue: HTMLElement | null;
  private readonly traverseValue: HTMLElement | null;
  private readonly turretValue: HTMLElement | null;
  private readonly gunValue: HTMLElement | null;
  private readonly aimRange: HTMLElement | null;
  private readonly reloadFill: HTMLElement | null;
  private readonly status: HTMLElement | null;
  private readonly hint: HTMLElement | null;

  private lastSpeedText = '';
  private lastGearText = '';
  private lastTraverseText = '';
  private lastTurretText = '';
  private lastGunText = '';
  private lastRangeText = '';
  private lastStatusText = '';
  private lastReloadPercent = -1;
  private lastReloading = false;

  constructor(root: Document = document) {
    this.speedValue = root.getElementById('speed-value');
    this.gearValue = root.getElementById('gear-value');
    this.traverseValue = root.getElementById('traverse-value');
    this.turretValue = root.getElementById('turret-value');
    this.gunValue = root.getElementById('gun-value');
    this.aimRange = root.getElementById('aim-range');
    this.reloadFill = root.getElementById('reload-fill');
    this.status = root.getElementById('hud-status');
    this.hint = root.getElementById('hud-hint');
  }

  /**
   * Updates the driving and gunnery readouts.
   *
   * Speed is shown in m/s to match the units used throughout the simulation, rather than km/h,
   * because the number on screen should be directly comparable to the vehicle definition.
   */
  updateDriving(telemetry: VehicleTelemetry): void {
    const speedText = telemetry.speedMps.toFixed(1);
    if (speedText !== this.lastSpeedText) {
      setText(this.speedValue, speedText);
      this.lastSpeedText = speedText;
    }

    const gearText = gearLabel(telemetry);
    if (gearText !== this.lastGearText) {
      setText(this.gearValue, gearText);
      this.lastGearText = gearText;
    }

    const traverseText = `HULL ${telemetry.traverseRateDegPerSec.toFixed(0)}°/s`;
    if (traverseText !== this.lastTraverseText) {
      setText(this.traverseValue, traverseText);
      this.lastTraverseText = traverseText;
    }

    // --- V2 gunnery -------------------------------------------------------------------
    // The reload indicator is the one thing the player cannot infer from the vehicle itself: a shot
    // refused during a reload is otherwise completely silent, and looks like a broken gun.
    const loaded = telemetry.gunLoadState === 'loaded';
    const gunText = loaded
      ? `GUN READY · ${telemetry.gunElevationDeg.toFixed(0)}°`
      : `RELOADING ${telemetry.reloadRemainingSeconds.toFixed(1)}s`;
    if (gunText !== this.lastGunText) {
      setText(this.gunValue, gunText);
      this.gunValue?.classList.toggle('reloading', !loaded);
      this.lastGunText = gunText;
    }

    // The turret's offset from the hull is what makes "the tank turned on its own" legible: it
    // shows how far the gun currently sits from the vehicle's nose.
    const offsetDeg = radToDeg(wrapAngle(telemetry.turretWorldHeadingRad - telemetry.headingRad));
    const offsetText = `TURRET ${offsetDeg.toFixed(0)}°`;
    if (offsetText !== this.lastTurretText) {
      setText(this.turretValue, offsetText);
      this.lastTurretText = offsetText;
    }
  }

  /**
   * Updates the reload progress bar.
   *
   * Driven by the core's own reload timer rather than by a client-side countdown, so the bar cannot
   * disagree with whether the gun will actually accept a shot.
   */
  updateReloadProgress(progress: number, reloading: boolean): void {
    const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    if (percent !== this.lastReloadPercent) {
      if (this.reloadFill !== null) {
        this.reloadFill.style.width = `${percent}%`;
      }
      this.lastReloadPercent = percent;
    }
    if (reloading !== this.lastReloading) {
      this.reloadFill?.classList.toggle('reloading', reloading);
      this.lastReloading = reloading;
    }
  }

  /**
   * Updates the aim range readout.
   *
   * This is the distance from the camera along its view direction to the terrain, which is the
   * information a gunner needs and the thing a V2 reticle will be built around. Passing `null`
   * shows a dash, which is the honest answer when the view is pointing at the sky.
   */
  updateAimRange(distanceM: number | null): void {
    const text = distanceM === null ? '--' : Math.round(distanceM).toString();
    if (text !== this.lastRangeText) {
      setText(this.aimRange, text);
      this.lastRangeText = text;
    }
  }

  /** Sets the status line. `isError` tints it, for startup failures. */
  setStatus(message: string, isError = false): void {
    if (message === this.lastStatusText) {
      return;
    }
    setText(this.status, message);
    this.status?.classList.toggle('error', isError);
    this.lastStatusText = message;
  }

  /** Fades the control hint once the player has clearly started driving. */
  hideHint(): void {
    this.hint?.classList.add('hidden');
  }
}

/** Shows the control hint again, e.g. after resetting. */
export function showHint(hud: Hud): void {
  hud.setStatus('Click to capture mouse');
}

/** Derives a gear-style label from current speed and throttle, for a quick read of intent. */
function gearLabel(telemetry: VehicleTelemetry): string {
  if (telemetry.stalled) {
    return 'STALL';
  }
  if (telemetry.speedMps > 0.15) {
    return 'DRIVE';
  }
  if (telemetry.speedMps < -0.15) {
    return 'REV';
  }
  if (Math.abs(telemetry.requestedThrottle) > 0.05) {
    return telemetry.requestedThrottle > 0 ? 'DRIVE' : 'REV';
  }
  return 'N';
}

function setText(element: HTMLElement | null, text: string): void {
  if (element !== null && element.textContent !== text) {
    element.textContent = text;
  }
}
