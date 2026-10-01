import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ShellState } from '../../core/ballistics/shell.js';
import type { ShellImpact } from '../../core/ballistics/impact.js';
import { makeMaterial } from './tank-proportions.js';

/**
 * Placeholder visuals for shells, muzzle flashes, and impacts.
 *
 * Functional and readable, not polished — the owner asked for enough feedback to understand what is
 * happening and explicitly not for VFX direction. Each effect exists to make one fact legible:
 *
 *  - a **shell** is a small bright box, so travel time and the arc are visible;
 *  - a **muzzle flash** is a brief expanding sphere, so the player can see *when* the gun fired even
 *    if they were not watching the barrel;
 *  - an **impact** marker sits at the point of impact long enough to read where the last shot went.
 *
 * All of this is presentation: it reads simulation state and never writes it (ADR-0001).
 */

/** Visual tuning for the placeholder effects. */
export const EFFECT_TUNING = {
  shellSizeM: 0.28,
  /** How long an impact marker persists before fading, seconds. */
  impactMarkerSeconds: 6,
  /** How long the muzzle flash is visible, seconds. */
  muzzleFlashSeconds: 0.09,
  /** How far the flash expands over its life, metres. */
  muzzleFlashGrowthM: 0.9,
  impactMarkerSizeM: 1.5,
} as const;

interface ImpactMarker {
  readonly mesh: Mesh;
  remainingSeconds: number;
}

interface MuzzleFlash {
  readonly mesh: Mesh;
  remainingSeconds: number;
  readonly totalSeconds: number;
}

export class ShellEffects {
  private readonly scene: Scene;
  private readonly shellMeshes = new Map<number, Mesh>();
  private readonly shellMaterial: StandardMaterial;
  private readonly flashMaterial: StandardMaterial;
  private readonly impactMaterial: StandardMaterial;
  private readonly flashTemplate: Mesh;
  private readonly impactTemplate: Mesh;
  private readonly impacts: ImpactMarker[] = [];
  private readonly flashes: MuzzleFlash[] = [];

  constructor(scene: Scene) {
    this.scene = scene;

    this.shellMaterial = makeMaterial(scene, 'shell-mat', new Color3(1, 0.85, 0.4));
    // Emissive so a shell stays visible against dark terrain without needing a light on it.
    this.shellMaterial.emissiveColor = new Color3(0.9, 0.7, 0.2);
    this.flashMaterial = makeMaterial(scene, 'flash-mat', new Color3(1, 0.8, 0.35));
    this.flashMaterial.emissiveColor = new Color3(1, 0.75, 0.3);
    this.impactMaterial = makeMaterial(scene, 'impact-mat', new Color3(0.75, 0.3, 0.22));
    this.impactMaterial.emissiveColor = new Color3(0.4, 0.12, 0.08);

    // Templates are built once and hidden, then cloned per use, so the geometry is shared rather
    // than rebuilt for every shot in flight.
    this.flashTemplate = MeshBuilder.CreateSphere(
      'muzzle-flash-template',
      { diameter: 1, segments: 6 },
      scene,
    );
    this.flashTemplate.material = this.flashMaterial;
    this.flashTemplate.setEnabled(false);

    this.impactTemplate = MeshBuilder.CreateBox(
      'impact-marker-template',
      { size: EFFECT_TUNING.impactMarkerSizeM },
      scene,
    );
    this.impactTemplate.material = this.impactMaterial;
    this.impactTemplate.setEnabled(false);
  }

  /**
   * Shows a muzzle flash at a world position.
   *
   * Driven by the simulation reporting a shot, not by the player pressing the button, so a flash
   * always corresponds to a shot that genuinely happened.
   */
  showMuzzleFlash(position: { x: number; y: number; z: number }): void {
    const mesh = this.flashTemplate.clone(`muzzle-flash-${this.flashes.length}`);
    mesh.material = this.flashMaterial;
    mesh.setEnabled(true);
    mesh.position.set(position.x, position.y, position.z);

    this.flashes.push({
      mesh,
      remainingSeconds: EFFECT_TUNING.muzzleFlashSeconds,
      totalSeconds: EFFECT_TUNING.muzzleFlashSeconds,
    });
  }

  /** Shows a persistent marker where a shell struck. */
  showImpact(impact: ShellImpact): void {
    const mesh = this.impactTemplate.clone(`impact-${impact.shellId}-${this.impacts.length}`);
    mesh.material = this.impactMaterial;
    mesh.setEnabled(true);
    mesh.position.set(impact.position.x, impact.position.y, impact.position.z);
    // Sits just above the surface so it does not z-fight with the terrain it landed on.
    mesh.position.y += EFFECT_TUNING.impactMarkerSizeM * 0.5;

    this.impacts.push({ mesh, remainingSeconds: EFFECT_TUNING.impactMarkerSeconds });
  }

  /**
   * Syncs shell meshes to the shells in flight, and ages the transient effects.
   *
   * Called once per frame. Meshes are pooled by shell id, so a shell in flight for many ticks keeps
   * the same mesh and is only moved.
   */
  update(shellStates: readonly ShellState[], dtSeconds: number): void {
    this.syncShellMeshes(shellStates);
    this.ageMuzzleFlashes(dtSeconds);
    this.ageImpactMarkers(dtSeconds);
  }

  private syncShellMeshes(shellStates: readonly ShellState[]): void {
    const live = new Set<number>();

    for (const shell of shellStates) {
      live.add(shell.id);

      let mesh = this.shellMeshes.get(shell.id);
      if (mesh === undefined) {
        mesh = MeshBuilder.CreateBox(
          `shell-${shell.id}`,
          { size: EFFECT_TUNING.shellSizeM },
          this.scene,
        );
        mesh.material = this.shellMaterial;
        this.shellMeshes.set(shell.id, mesh);
      }
      // A shell is a physical object, so it lives in world space exactly where the simulation says.
      mesh.position.set(shell.position.x, shell.position.y, shell.position.z);
    }

    for (const [id, mesh] of this.shellMeshes) {
      if (!live.has(id)) {
        mesh.dispose();
        this.shellMeshes.delete(id);
      }
    }
  }

  private ageMuzzleFlashes(dtSeconds: number): void {
    for (let i = this.flashes.length - 1; i >= 0; i -= 1) {
      const flash = this.flashes[i]!;
      flash.remainingSeconds -= dtSeconds;
      if (flash.remainingSeconds <= 0) {
        flash.mesh.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      // Expands over its life, so it reads as a burst rather than a static ball.
      const t = 1 - flash.remainingSeconds / flash.totalSeconds;
      const scale = 0.4 + t * EFFECT_TUNING.muzzleFlashGrowthM;
      flash.mesh.scaling.set(scale, scale, scale);
    }
  }

  private ageImpactMarkers(dtSeconds: number): void {
    for (let i = this.impacts.length - 1; i >= 0; i -= 1) {
      const marker = this.impacts[i]!;
      marker.remainingSeconds -= dtSeconds;
      if (marker.remainingSeconds <= 0) {
        marker.mesh.dispose();
        this.impacts.splice(i, 1);
        continue;
      }
      // Fades over its final second so markers do not vanish abruptly.
      marker.mesh.visibility = Math.min(1, marker.remainingSeconds);
    }
  }

  /** Number of live impact markers, for tests and debug overlays. */
  get impactMarkerCount(): number {
    return this.impacts.length;
  }

  /** Number of shell meshes currently drawn, for tests and debug overlays. */
  get shellMeshCount(): number {
    return this.shellMeshes.size;
  }

  /** Removes every effect. Used when a battle resets. */
  clear(): void {
    for (const mesh of this.shellMeshes.values()) {
      mesh.dispose();
    }
    this.shellMeshes.clear();
    for (const flash of this.flashes) {
      flash.mesh.dispose();
    }
    this.flashes.length = 0;
    for (const marker of this.impacts) {
      marker.mesh.dispose();
    }
    this.impacts.length = 0;
  }

  /** The scene these effects belong to. Exposed so tests can confirm ownership. */
  get owningScene(): Scene {
    return this.scene;
  }
}
