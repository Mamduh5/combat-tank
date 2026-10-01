import type { VehicleTelemetry } from '../../core/vehicle/vehicle-state.js';

/**
 * Minimal heads-up display.
 *
 * V1 scope is a speed readout plus a couple of diagnostics, and this stays inside that. The
 * elements exist to make the simulation *legible* (vision principle P6): the player should be able
 * to see that the tank is heavy, that traverse is rate-limited, and that it is on a slope, without
 * guessing.
 *
 * Text is written to the DOM only when it changes. Assigning `textContent` on a node the browser
 * has already laid out forces style recalculation, so a HUD updated every frame at 60 Hz is a
 * measurable cost for no benefit.
 *
 * Elements are looked up once and cached, and a missing element is tolerated rather than throwing,
 * so the HUD degrades instead of breaking the frame loop.
 */
export class Hud {
  private readonly speedValue: HTMLElement | null;
  private readonly gearValue: HTMLElement | null;
  private readonly traverseValue: HTMLElement | null;
  private readonly aimRange: HTMLElement | null;
  private readonly status: HTMLElement | null;
  private readonly hint: HTMLElement | null;

  private lastSpeedText = '';
  private lastGearText = '';
  private lastTraverseText = '';
  private lastRangeText = '';
  private lastStatusText = '';

  constructor(root: Document = document) {
    this.speedValue = root.getElementById('speed-value');
    this.gearValue = root.getElementById('gear-value');
    this.traverseValue = root.getElementById('traverse-value');
    this.aimRange = root.getElementById('aim-range');
    this.status = root.getElementById('hud-status');
    this.hint = root.getElementById('hud-hint');
  }

  /**
   * Updates the driving readouts.
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

    const traverseText = `TRAVERSE ${telemetry.traverseRateDegPerSec.toFixed(0)}°/s`;
    if (traverseText !== this.lastTraverseText) {
      setText(this.traverseValue, traverseText);
      this.lastTraverseText = traverseText;
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
