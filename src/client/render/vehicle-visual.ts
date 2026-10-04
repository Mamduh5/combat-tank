/**
 * Drives a loaded vehicle rig from simulation state.
 *
 * ## The division of labour
 *
 * `VehicleVisual` knows about **simulation** â€” hull attitude, turret traverse, gun elevation, wheel rotation,
 * track conforming, destruction. `vehicle-asset.ts` knows about **assets** â€” axes, scale, pivots, naming. This
 * file contains no glTF knowledge at all, which is what the brief means by "normalise those cleanly rather
 * than spreading special-case offsets throughout gameplay code".
 *
 * ## What it preserves from V6, deliberately
 *
 * The brief requires that accepted gameplay not regress. Two V6 behaviours in particular are *not*
 * presentation and are carried over unchanged:
 *
 * - **The hull's attitude is the simulation's**, not a visual guess. Pitch and roll come from the core's
 *   smoothed values (`docs/gameplay-systems.md`), so slope behaviour stays simulated.
 * - **The tracks conform to the ground per segment.** This was a substantial V6 fix and the reason Marlowe
 *   Crossing feels solid: the hull presents an average plane, which floats over dips and buries in rises,
 *   so each track segment is offset by the *residual* between the ground beneath it and the hull's own
 *   bottom plane. Rigid hull, conforming running gear â€” which is also what a real tank does.
 *
 * Everything below that line â€” wheel spin, track scroll, destruction state, recoil â€” is new in V7.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { VehicleState } from '../../core/vehicle/vehicle-state.js';
import type { VehicleRig } from '../assets/vehicle-asset.js';

/**
 * The turret and gun state the renderer needs.
 *
 * Declared here rather than imported from the core because the core's `TurretState` carries the *simulation's*
 * concerns — traverse limits, rate, arcs — while the renderer needs only the two resulting angles. Restating
 * the minimum keeps the renderer from depending on turret internals it does not use, which is the same
 * boundary discipline ADR-0001 sets out for the rest of the client.
 */
export interface TurretVisualState {
  /** Turret angle relative to the hull, radians. */
  readonly localAngleRad: number;
  /** Gun elevation above the turret's horizontal plane, radians. Positive is up. */
  readonly elevationRad: number;
}

/** Tuning for the presentation behaviours V7 adds on top of the V6 grounding. */
export const VEHICLE_VISUAL_TUNING = {
  /**
   * How quickly a track segment closes on the ground beneath it, per second.
   *
   * Faster than the hull's ride height settles, deliberately. The hull is a heavy body and should look like
   * it has mass; the track is a lighter assembly and should look like it is already in contact. Making the
   * two rates equal is what produces the "settling into place" look that reads as a vehicle bouncing.
   */
  conformRatePerSecond: 22,

  /**
   * Maximum vertical travel of a track segment from its authored height, metres.
   *
   * Just over the largest ground residual measured on Marlowe Crossing, so on real ground the limit never
   * binds and exists only to stop a spike beyond the surveyed surfaces from tearing a segment off the fender
   * above it. A real suspension has finite travel for the same reason.
   */
  conformTravelM: 0.55,

  /**
   * Recoil stroke, metres. The barrel slides back along its own axis and returns.
   *
   * Modest on purpose. The brief asks that firing "become one of the strongest audiovisual moments in the
   * prototype" but also that effects stay restrained enough to aim and read the battlefield; a metre of
   * barrel travel would be neither.
   */
  recoilStrokeM: 0.42,
  /** How fast the barrel returns after recoil, per second. Slower than the stroke, so it settles. */
  recoilReturnRate: 3.4,
  /** How fast the barrel is driven back on firing, per second. Fast: recoil is violent. */
  recoilDriveRate: 14,

  /**
   * How far the hull drops on recoil, metres.
   *
   * A fraction of the barrel's stroke. A tank's hull barely moves, but "barely" is what sells it â€” the
   * reaction is most visible through the camera, which shakes by the same amount.
   */
  hullRecoilDipM: 0.045,
  /** Camera shake magnitude on firing, metres. Small; the player must keep their aim. */
  fireShakeM: 0.055,
  fireShakeSeconds: 0.22,

  /**
   * Camera shake when the player is penetrated, metres. Larger than firing's, because it is *their* hull
   * being hit rather than their own gun going off.
   */
  hitShakeM: 0.32,
  hitShakeSeconds: 0.28,

  /** Wheel angular velocity per metre travelled, as a multiplier on `distance / radius`. */
  wheelSpinFromRadius: true,

  /**
   * Track scroll speed, UV units per metre travelled.
   *
   * Scrolling the track texture is what makes a moving tank look like it is *moving its tracks* rather than
   * sliding. It is the cheapest possible animation and, with the texture's cleat pattern, a convincing one.
   */
  trackScrollPerMetre: 0.42,

  /** Seconds the destruction fade takes after a tank dies. */
  destructionFadeSeconds: 1.1,
} as const;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Eases a value toward its target at a fixed rate, independent of frame rate.
 *
 * `1 - exp(-rate * dt)` rather than a fixed fraction per frame, so the conforming looks the same at 30 Hz
 * and at 144 Hz. A per-frame constant would make the track snap instantly on a fast machine and crawl on a
 * slow one â€” the same class of bug as using a per-frame lerp for the simulation's own ride height.
 */
function segmentEasingFactor(ratePerSecond: number, deltaSeconds: number): number {
  return 1 - Math.exp(-ratePerSecond * Math.max(0, deltaSeconds));
}

/** World-space pose the camera needs in order to place sounds. */
export interface VehiclePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class VehicleVisual {
  /** The rig's root, posed from simulation state each frame. Exposed for the grounding probes. */
  readonly root: TransformNode;

  /** Terrain sampler, or null when the vehicle is inspected without a battlefield. */
  private readonly groundAt: ((x: number, z: number) => number) | null;

  /** Current vertical offset of each track segment, metres. Indexed in step with `rig.tracks`. */
  private readonly segmentOffsetsM: number[];

  /** How far the vehicle has travelled, for wheel spin and track scroll. Monotonic; never decreases. */
  private distanceTravelledM = 0;
  /** The heading at the last frame, so travelled distance follows the actual path rather than the chord. */
  private lastPosition = { x: 0, z: 0 };
  /** False until the first frame has seeded `lastPosition`, so the spawn point is not read as movement. */
  private hasPosition = false;

  /** Current recoil displacement along the barrel's axis, metres. Positive is backwards. */
  private recoilM = 0;
  /** Whether a recoil is in progress, so the drive and return phases are distinguishable. */
  private recoiling = false;

  /** True once destroyed, so the tint is only applied on change. */
  private destroyed = false;
  /** Materials captured before destruction, so the tint can be undone. */
  private readonly baseMaterials = new Map<AbstractMesh, Material | null>();

  /** Measured ground-contact offset, metres. See `debugContactOffsetM`. */
  private contactOffsetM = 0;

  /** Distance the gun pivots for recoil, so the hull dip is applied at the turret ring, not the hull centre. */
  private readonly recoilPivotZ: number;

  /**
   * @param rig the loaded, normalised vehicle rig
   * @param scene the scene, for materials created here
   * @param groundAt terrain height sampler, for track conforming. Null keeps the vehicle rigid, which is
   *   correct when it is being inspected away from a battlefield.
   */
  constructor(
    private readonly rig: VehicleRig,
    scene: Scene,
    groundAt?: (x: number, z: number) => number,
  ) {
    this.root = rig.root;
    this.groundAt = groundAt ?? null;
    this.segmentOffsetsM = new Array<number>(rig.tracks.length).fill(0);
    this.recoilPivotZ = rig.gun.position.z;

    this.measureContactOffset();
    // Materials are captured before any destruction tint, so the wreck state can be undone on a restart.
    for (const mesh of rig.meshes) {
      this.baseMaterials.set(mesh, mesh.material);
    }
    void scene;
  }

  /**
   * Measures how far the built geometry sits above the root origin, by reading the track meshes.
   *
   * Measured rather than hard-coded because the asset contract only says the origin is at the track contact
   * line â€” it does not guarantee a particular asset honours it to the millimetre, and a future model authored
   * by hand might not. Only the tracks are considered, because they are what meets the ground: a gun barrel
   * dipping below the track line on a slope is a gun over a crest, not a vehicle in a hole.
   */
  private measureContactOffset(): void {
    let lowest = Infinity;
    for (const mesh of this.rig.meshes) {
      const trackNames = this.rig.tracks.some((t) => t.node === mesh.parent);
      if (!trackNames) {
        continue;
      }
      mesh.computeWorldMatrix(true);
      const world = Vector3.TransformCoordinates(
        mesh.getBoundingInfo().boundingBox.minimum,
        mesh.getWorldMatrix(),
      );
      lowest = Math.min(lowest, world.y);
    }
    this.contactOffsetM = Number.isFinite(lowest) ? lowest : 0;
  }

  /**
   * The measured ground-contact offset, for the grounding probe.
   *
   * Read-only and deliberately narrow. The V6 grounding investigation needed the renderer's *actual* offset
   * rather than a restatement of it â€” a probe that recomputes the value it is investigating cannot detect the
   * value being wrong.
   */
  debugContactOffsetM(): number {
    return this.contactOffsetM;
  }

  /** The rig, for callers that need a specific part â€” the effects layer, for instance. */
  get vehicleRig(): VehicleRig {
    return this.rig;
  }

  /** World position of the muzzle exit, read from the asset's own marker rather than re-derived. */
  getMuzzleWorldPosition(): Vector3 {
    this.rig.muzzle.computeWorldMatrix(true);
    return this.rig.muzzle.getAbsolutePosition();
  }

  /** World position of the hull centre, for range readouts and spatial audio. */
  getHullWorldPosition(): VehiclePose {
    return { x: this.root.position.x, y: this.root.position.y, z: this.root.position.z };
  }

  /** Every mesh, so the caller can enable shadows or collect render statistics. */
  get meshes(): readonly AbstractMesh[] {
    return this.rig.meshes;
  }

  /**
   * Writes simulation state onto the transform.
   *
   * The *only* place simulation state reaches the scene graph, and strictly one-way: the renderer reads state
   * and never writes it (ADR-0001).
   *
   * Hull, turret, and gun are set from three separate pieces of simulation state, which is what makes the
   * independence visible: the hull follows its own heading, the turret its own local angle, the barrel its own
   * elevation. Nothing here derives one from another.
   */
  apply(state: VehicleState, turret: TurretVisualState, deltaSeconds = 1 / 60): void {
    this.advanceRecoil(deltaSeconds);
    this.trackDistance(state);

    // ## Where the hull sits, and why this is not `position.y`
    //
    // The simulation places the vehicle origin at `groundHeight + rideHeightM`, converging on the definition's
    // `groundClearanceM` of 0.48 m. That is a sensible place for a vehicle *origin* â€” it is the hull floor,
    // and a hull floor does float above the ground. But the asset contract puts this model's origin at the
    // **track contact line**, so drawing it at `position.y` would leave the track bottoms 0.48 m in the air:
    // the flat-ground float the V6 pass diagnosed.
    //
    // So the visual is placed at the ground and the ride height is dropped. `contactOffsetM` still subtracts,
    // and is still measured rather than hard-coded, because an asset authored with its origin above the
    // contact line would need it and a future one might not.
    this.root.position.set(
      state.position.x,
      state.position.y - state.rideHeightM - this.contactOffsetM - this.recoilDipM(),
      state.position.z,
    );

    // ## Why the heading is applied **positively**
    //
    // This was `-state.headingRad` during V3-V6, on the reasoning that Babylon is left-handed and therefore
    // needs the sign flipped. That reasoning is wrong, and the comment recorded it as settled fact, which is
    // exactly what let it survive: every automated test compared movement against the *simulation's own*
    // forward vector, and the simulation was never wrong. Only the rendered tank was. At a heading of 90Â° the
    // visible nose pointed exactly backwards, and the error grew linearly with heading in between.
    //
    // The model is authored nose-at-local-**+Z** (glacis, idler, and muzzle all sit at +Z, and the loader has
    // already verified that after every coordinate conversion). The simulation's forward vector is
    // `(sin h, cos h)`. Checked against Babylon's own `Matrix.RotationY`, `RotationY(+h)` maps local +Z to
    // exactly `(sin h, cos h)`, while `RotationY(-h)` maps it to `(-sin h, cos h)` â€” the nose *reflected*
    // rather than rotated.
    //
    // This is the most heavily tested line in the renderer; see `tests/client/controls.test.ts`.
    this.root.rotation.set(state.bodyPitchRad, state.headingRad, state.bodyRollRad);

    // ## Why the track is conformed *after* the root is posed
    //
    // Order matters and is not incidental. The conforming pass measures where the hull's bottom plane sits at
    // each station, which it can only know once the root's pitch, roll, and position are final. Running it
    // first would offset the segments against last frame's attitude and leave a visible lag between the hull's
    // tilt and the track's contact â€” the vehicle would look like it were steering before it leaned.
    this.conformTracks(state, deltaSeconds);

    // The turret's *local* angle, positively. Because it is a child of the hull, the hull's rotation is
    // inherited automatically, so rotating the hull carries the turret with it â€” which is what a real turret
    // ring does. The gun's world bearing then works out as `hull heading + local angle`, matching `gunDirection`
    // in the core exactly.
    this.rig.turret.rotation.y = turret.localAngleRad;

    // Elevation is a pitch about the barrel's own pivot, at the trunnion. The gun node's origin *is* the
    // trunnion by contract, so no offset maths is needed here â€” which is precisely what the contract buys.
    this.rig.gun.rotation.x = -turret.elevationRad;

    // Recoil slides the barrel backwards along its own axis, applied as a position offset rather than a
    // rotation because a real recoil is a translation of the barrel in its cradle.
    this.rig.gun.position.z = this.recoilPivotZ - this.recoilM;
  }

  /** How far the hull dips under recoil, metres. */
  private recoilDipM(): number {
    return this.recoilM * VEHICLE_VISUAL_TUNING.hullRecoilDipM * 3;
  }

  /**
   * Starts a recoil stroke.
   *
   * Called on the frame a shot is actually fired, derived from the simulation's own shot count rather than
   * from the fire button â€” so a request the gun refused during a reload produces no recoil, exactly as it
   * produces no flash and no sound.
   */
  fireRecoil(): void {
    this.recoiling = true;
  }

  /** Advances the recoil stroke: a fast drive back, then a slower settle. */
  private advanceRecoil(deltaSeconds: number): void {
    const tuning = VEHICLE_VISUAL_TUNING;
    if (this.recoiling) {
      this.recoilM += tuning.recoilDriveRate * tuning.recoilStrokeM * deltaSeconds;
      if (this.recoilM >= tuning.recoilStrokeM) {
        this.recoilM = tuning.recoilStrokeM;
        this.recoiling = false;
      }
    } else if (this.recoilM > 0) {
      // Exponentially eased, so the return looks mechanical rather than linear.
      const k = 1 - Math.exp(-tuning.recoilReturnRate * Math.max(0, deltaSeconds));
      this.recoilM += (0 - this.recoilM) * k;
      if (this.recoilM < 0.0005) {
        this.recoilM = 0;
      }
    }
  }

  /**
   * Accumulates travelled distance and applies the wheel and track animation that depends on it.
   *
   * Distance is integrated from the *path*, by differencing successive positions, rather than by summing
   * `speed * dt`: the latter drifts whenever a frame runs long, and the wheels would slowly desynchronise
   * from the ground they are rolling over.
   */
  private trackDistance(state: VehicleState): void {
    if (!this.hasPosition) {
      // The first frame has no previous position to difference against, so seed it rather than treating the
      // vehicle's spawn point as a movement from the origin.
      this.lastPosition = { x: state.position.x, z: state.position.z };
      this.hasPosition = true;
      return;
    }

    const step = Math.hypot(state.position.x - this.lastPosition.x, state.position.z - this.lastPosition.z);
    this.lastPosition = { x: state.position.x, z: state.position.z };
    if (step <= 0) {
      return;
    }
    this.distanceTravelledM += step;

    // Wheels turn by arc length over radius. A wheel pinned to the wrong node would spin at a plausible but
    // wrong rate, so the radius is measured from the wheel's own bound at load time.
    const deltaAngle = step / this.averageWheelRadiusM();
    for (const wheel of this.rig.wheels) {
      wheel.node.rotation.x += deltaAngle;
    }

    // Track scroll. Scrolling the texture along the track is what makes a moving tank look like it is moving
    // its tracks rather than sliding; the cleat pattern in the texture gives the eye something to read the
    // motion against.
    this.scrollTrackTexture(step);
  }

  /**
   * Scrolls the track material along the vehicle's length.
   *
   * The offset is applied once per *side* rather than once per segment, and to a single material rather than
   * to each segment's own: every segment on a side shares one material, so writing it repeatedly would
   * advance the pattern several times over and tear it apart at every joint.
   */
  private scrollTrackTexture(distanceM: number): void {
    const scroll = distanceM * VEHICLE_VISUAL_TUNING.trackScrollPerMetre;
    for (const side of [-1, 1]) {
      const segment = this.rig.tracks.find((t) => t.side === side);
      if (segment === undefined) {
        continue;
      }
      for (const mesh of this.rig.meshes) {
        if (mesh.parent !== segment.node) {
          continue;
        }
        offsetMaterialTextures(mesh.material, -scroll * side);
      }
    }
  }

  /**
   * Moves each track segment to the ground beneath it.
   *
   * ## What this is for
   *
   * The hull presents the fitted support plane, which is the *average* of the ground under the vehicle. That
   * is the right attitude and the wrong shape: a plane through a rolling landscape is a chord, so it floats
   * over every dip and buries itself in every rise. Measured across Marlowe Crossing, the residual was up to
   * 0.52 m of daylight even after the attitude was corrected, and it was this residual â€” not the attitude â€”
   * that produced the owner's report of a vehicle "most of which floats" on non-flat ground.
   *
   * So each segment is offset vertically by the local difference between the ground beneath it and the hull's
   * own bottom plane. The hull stays rigid, which is correct: real tanks have a rigid hull. Only the running
   * gear conforms, which is also correct: real tracks do.
   *
   * ## Why it is smoothed, and why it is clamped
   *
   * **Smoothed** because the target changes by tens of centimetres between frames at driving speed, and a
   * track that jumps to meet the ground reads as a rendering fault rather than as contact. The easing is
   * derived from elapsed time, so behaviour is identical at 30 Hz and 144 Hz â€” the same rule the core follows
   * for ride height.
   *
   * **Clamped** because a real suspension has finite travel, and because an unclamped spike beyond the
   * surveyed surfaces would tear a segment away from the fender above it.
   */
  private conformTracks(state: VehicleState, deltaSeconds: number): void {
    const terrain = this.groundAt;
    if (terrain === null) {
      return;
    }

    const ease = segmentEasingFactor(VEHICLE_VISUAL_TUNING.conformRatePerSecond, deltaSeconds);

    // Where the track's lower edge sits at the vehicle's centre, before any conforming. The root has already
    // been lowered by `contactOffsetM`, so this is the *nominal* contact line: where the track would rest if
    // the vehicle were perfectly rigid and the ground beneath it perfectly flat.
    const rootBottomY = this.root.position.y;

    // The vehicle's world position, which the per-segment ground samples are taken around. Taken from the
    // state rather than from `this.root.position`, because the conforming runs after the root is posed and
    // this must describe the same point the simulation considers the vehicle's centre.
    const { x, z } = state.position;

    // The hull's axes on the XZ plane, for mapping a segment's local station into the world.
    const heading = state.headingRad;
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);

    for (let index = 0; index < this.rig.tracks.length; index += 1) {
      const track = this.rig.tracks[index]!;
      const localZ = track.node.position.z;
      const localX = Math.abs(track.node.position.x);

      // Where this segment sits in the world, given the pose the root has just been given.
      const worldX = x + forwardX * localZ + rightX * localX;
      const worldZ = z + forwardZ * localZ + rightZ * localX;
      const groundY = terrain(worldX, worldZ);

      // ## Why the residual, and not the full height, is what the segment moves by
      //
      // The root has already been lowered by `contactOffsetM`, which places the *nominal* track contact line
      // on the ground at the vehicle's centre. What is left is the difference between that nominal line and
      // the ground under this particular station: the residual. An earlier version offset by the whole
      // ground-to-plane distance, which dragged every segment down by the full ride height and left the tracks
      // hanging a metre below the hull — the vehicle stopped floating and started coming apart, and every gap
      // measurement still read zero because it only ever looked at the track against the ground, never the
      // track against the hull.
      //
      // `nominalBottomY` is where this station's track bottom sits under the current root transform with no
      // conforming at all, so the residual is exactly the correction needed. It is measured from the segment's
      // *lower edge*, not its centre — comparing the ground against the node centre would leave every segment
      // sitting half a track height too high. The pitch and roll terms account for the root's own tilt, which
      // is why the conforming must run after the root is posed.
      const nominalBottomY =
        rootBottomY + (track.authoredY - track.halfHeightM)
        - Math.sin(state.bodyPitchRad) * localZ
        + Math.sin(state.bodyRollRad) * localX;

      // Positive means the ground is above the nominal track line, so the segment must rise to meet it.
      const travel = VEHICLE_VISUAL_TUNING.conformTravelM;
      const target = clamp(groundY - nominalBottomY, -travel, travel);

      const current = this.segmentOffsetsM[index] ?? 0;
      const next = current + (target - current) * ease;
      this.segmentOffsetsM[index] = next;
      track.node.position.y = track.authoredY + next;
    }
  }

  /**
   * Marks the vehicle destroyed or restored.
   *
   * ## What "destroyed" looks like now, and why
   *
   * V6 tinted the whole tank a flat dark colour, which read as "painted dark" rather than as "burnt". The
   * brief asks that the player understand immediately that the tank is dead, and lists scorched material and a
   * disabled gun among the options. So V7 does three things:
   *
   * 1. Swaps in a **charred** material rather than tinting the paint. Nearly black, but with an oxidised-steel
   *    response rather than a matte one â€” the difference that separates burnt from merely dark.
   * 2. **Droops the turret and gun**, so the wreck has a disabled-gun pose rather than a gun still at attention.
   * 3. Leaves the **tracks and running gear** largely intact, because a burnt-out hull on working tracks is
   *    both true and a better silhouette than a uniformly black lump.
   *
   * The fire and smoke that sell it are the effects layer's job, because they are transient and pooled there
   * rather than owned by the vehicle.
   */
  setDestroyed(destroyed: boolean): void {
    if (this.destroyed === destroyed) {
      return;
    }
    this.destroyed = destroyed;

    if (destroyed) {
      for (const mesh of this.rig.meshes) {
        const name = mesh.name.toLowerCase();
        // Tracks and wheels keep their own materials: a burnt hull on intact running gear reads better than a
        // uniformly black lump, and it keeps the wreck's silhouette legible at range.
        if (name.includes('track') || name.includes('wheel') || name.includes('sprocket') || name.includes('idler')) {
          continue;
        }
        const base = this.baseMaterials.get(mesh);
        if (base === null || base === undefined) {
          continue;
        }
        // A cloned charred material per mesh, so a wreck can be undone on restart and two wrecks never share
        // material state.
        const cloner = (base as { clone?: (name: string) => Material }).clone;
        if (cloner === undefined) {
          continue;
        }
        const charred = cloner.call(base, `${mesh.name}-charred`);
        applyCharredLook(charred);
        mesh.material = charred;
      }
      // The gun droops: a disabled turret is one of the clearest "this is dead" cues there is, and it costs one
      // rotation.
      this.rig.gun.rotation.x = 0.34;
      this.rig.turret.rotation.y += 0.12;
    } else {
      for (const mesh of this.rig.meshes) {
        const base = this.baseMaterials.get(mesh);
        if (base !== undefined) {
          mesh.material = base;
        }
      }
      this.rig.gun.rotation.x = 0;
    }
  }

  /** Enables shadow receiving on every part. */
  setShadowsEnabled(enabled: boolean): void {
    for (const mesh of this.rig.meshes) {
      mesh.receiveShadows = enabled;
    }
  }

  /** Disposes the vehicle's nodes. */
  dispose(): void {
    this.root.dispose(false, true);
  }

  /** The mean wheel radius, used for the spin rate. Averaged so one odd wheel cannot skew the rest. */
  private averageWheelRadiusM(): number {
    let total = 0;
    for (const wheel of this.rig.wheels) {
      total += wheel.radiusM;
    }
    return this.rig.wheels.length > 0 ? total / this.rig.wheels.length : 0.4;
  }
}
/**
 * Advances a material's textures along one axis, for the track scroll.
 *
 * Written against the minimal structural shape rather than a concrete material class, because the scroll has to
 * work on whatever material the asset came with â€” a glTF PBR material today, something else after an art pass.
 * A missing texture is skipped rather than being an error.
 */
function offsetMaterialTextures(material: Material | null, deltaV: number): void {
  if (material === null) {
    return;
  }
  const candidate = material as unknown as {
    albedoTexture?: { vOffset: number } | null;
    bumpTexture?: { vOffset: number } | null;
  };
  if (candidate.albedoTexture !== undefined && candidate.albedoTexture !== null) {
    candidate.albedoTexture.vOffset += deltaV;
  }
  if (candidate.bumpTexture !== undefined && candidate.bumpTexture !== null) {
    candidate.bumpTexture.vOffset += deltaV;
  }
}

/**
 * Gives a cloned material the scorched-wreck look.
 *
 * Assigns to the PBR fields when they exist and to the legacy fields otherwise, so a wreck on a material this
 * function does not fully recognise is still a wreck â€” it just does not gain the oxidised sheen.
 */
function applyCharredLook(material: Material): void {
  const candidate = material as unknown as {
    albedoColor?: { r: number; g: number; b: number };
    metallic?: number;
    roughness?: number;
    diffuseColor?: { r: number; g: number; b: number };
    specularColor?: { r: number; g: number; b: number };
  };
  if (candidate.albedoColor !== undefined) {
    candidate.albedoColor.r = 0.09;
    candidate.albedoColor.g = 0.085;
    candidate.albedoColor.b = 0.085;
    candidate.metallic = 0.5;
    candidate.roughness = 0.94;
  }
  if (candidate.diffuseColor !== undefined) {
    candidate.diffuseColor.r = 0.09;
    candidate.diffuseColor.g = 0.085;
    candidate.diffuseColor.b = 0.085;
  }
}

/**
 * The yaw the renderer applies to the hull, from the simulation's heading.
 *
 * ## This one function is the whole orientation contract
 *
 * It is the identity, and that is the point. The model is authored nose-at-`+Z` and Babylon's left-handed
 * `Matrix.RotationY(h)` maps local `+Z` to `(sin h, cos h)` â€” which is already the simulation's forward
 * vector. No sign correction is required, and the previous `-headingRad` was not a correction but a
 * reflection.
 *
 * If this ever needs a non-identity value, the *asset* is what should move, not the locomotion: the
 * simulation's forward vector is what the vehicle actually drives along, and the brief is explicit that
 * locomotion must not be bent to match a rendering.
 */
export function hullVisualYawRad(headingRad: number): number {
  return headingRad;
}

/**
 * Where the **rendered** tank's nose points, for a hull heading.
 *
 * ## Why this function exists at all
 *
 * Because a vector-only test cannot catch that class of bug, and it shipped through a fully green suite once.
 * Every existing control test compared movement against the *simulation's* forward vector, which was always
 * correct; nothing compared that against what the player could see. At a heading of 90 degrees the visible
 * nose pointed exactly backwards, so W drove the tank out of its own tail, and every numeric assertion still
 * passed.
 *
 * Computed with Babylon's own matrix rather than by restating `sin`/`cos`, so this measures the actual engine
 * convention instead of re-asserting the algebra that produced the mistake.
 */
export function modelNoseWorldDirection(headingRad: number): { x: number; y: number; z: number } {
  const nose = Vector3.TransformNormal(new Vector3(0, 0, 1), Matrix.RotationY(hullVisualYawRad(headingRad)));
  return { x: nose.x, y: nose.y, z: nose.z };
}

/**
 * The simulation's forward vector for a hull heading, as a unit direction.
 *
 * Restated from `tank.ts`'s integration step rather than imported from it, on purpose: the point of this
 * function is to be an *independent* statement of what the simulation believes, so a test comparing the two
 * compares two implementations rather than one implementation with itself.
 */
export function simulationForward(headingRad: number): { x: number; y: number; z: number } {
  return { x: Math.sin(headingRad), y: 0, z: Math.cos(headingRad) };
}

