/**
 * V8 regression tests: two tanks of the same type must coexist.
 *
 * ## The bug these exist to prevent
 *
 * The owner played the roster and found that picking the same tank on both sides made **both tanks
 * disappear**. That is not a cosmetic defect and not a balance question, so this file pins the
 * ownership invariant that was violated:
 *
 * > A vehicle *definition* may be shared. A live vehicle *instance* may not.
 *
 * The rig cache used to hold live rigs, keyed by `scene:modelPath`, so the second `loadVehicleRig`
 * for a vehicle returned the first one's `TransformNode`s. Both `VehicleVisual`s then wrote to one
 * root node every frame. The opponent's `apply()` ran second and won, so the single shared tank was
 * drawn on the *enemy's* spawn while the camera followed the *player's* simulated hull to empty
 * ground. From the player's seat both tanks were gone.
 *
 * ## Why every existing gate was green
 *
 * This is the part worth stating plainly, because it is the reason the suite needed strengthening
 * rather than just extending. The shared rig was not broken in any way the old assertions could see:
 *
 * - both "tanks" had healthy world matrices, `isVisible === true`, `isEnabled === true`;
 * - the model contract passed, because it is checked once per *model* and both sides used one model;
 * - the roster walk switched `ct-medium -> ct-heavy -> ct-light` and passed ~39 checks on each, because
 *   it only ever inspected `playerVisual` and asked "is this vehicle drawn correctly?" -- never "are
 *   these two vehicles *different*?";
 * - the disposal mesh-count check passed, because one shared rig is exactly as many meshes as the
 *   limit allowed;
 * - every core matchup test passed, because the simulation was never wrong.
 *
 * A single-rig-per-vehicle assumption is invisible to every question phrased about one vehicle at a
 * time. So the assertions below are deliberately about *pairs*: two roots, two turrets, two sets of
 * transforms, two independent fates.
 *
 * ## What runs here
 *
 * The rig cache and the instantiation path are exercised against real Babylon geometry built by the
 * same loader code, using a `NullEngine` so the whole thing is headless and fast. The cache itself is
 * scene-scoped and keyed by model path, which is what made it collide, so it is reproduced rather
 * than mocked: two loads of the *same* definition must produce two disjoint rigs.
 *
 * The simulation half is asserted separately and cheaply: `Simulation` is given two tanks of one
 * definition and must produce two distinct, independently mutable vehicles. That is the "do not assume
 * the issue is purely rendering" half of the brief.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { instantiateVehicleRig } from '../../src/client/assets/vehicle-rig-instance.js';
import type { VehicleSource } from '../../src/client/assets/vehicle-rig-instance.js';
import { VehicleVisual } from '../../src/client/render/vehicle-visual.js';
import { Simulation } from '../../src/core/sim/world.js';
import { CT_HEAVY, CT_LIGHT, CT_MEDIUM } from '../../src/shared/roster.js';
import type { VehicleDefinition } from '../../src/shared/vehicle-definition.js';

/**
 * Every roster vehicle, in the order the brief names them: Sabre, Anvil, Vex.
 *
 * The mirror matchups are the three the owner reported, and they are asserted individually rather than
 * through a loop, so a failure says *which* tank broke instead of "the third case".
 */
const MIRROR_CASES = [
  { player: CT_MEDIUM, opponent: CT_MEDIUM, label: 'Sabre vs Sabre' },
  { player: CT_HEAVY, opponent: CT_HEAVY, label: 'Anvil vs Anvil' },
  { player: CT_LIGHT, opponent: CT_LIGHT, label: 'Vex vs Vex' },
] as const;

/**
 * Builds a contract-shaped *template* for a vehicle: a `Tank` driver over a `TankModel` root, with
 * `Hull`, `Turret`, `Gun`, `Muzzle`, wheels and track segments underneath.
 *
 * Deliberately shaped like the real loader's output, with real geometry and real materials, so the
 * instantiation code under test resolves genuine contract names and does genuine per-instance cloning.
 * A stand-in that skipped the names or used a single shared material would pass while the real path
 * failed -- which is precisely the kind of test that let this bug through in the first place.
 *
 * The template is left **out of the scene**, mirroring the loader: it must never be drawn.
 */
function buildTemplate(scene: Scene, definition: VehicleDefinition): VehicleSource {
  const material = new PBRMaterial(`mat-${definition.id}`, scene);
  material.albedoTexture = RawTexture.CreateRGBATexture(
    new Uint8Array([128, 128, 128, 255]),
    1,
    1,
    scene,
    false,
    false,
    0,
  );

  // Tracked so the template can take *its own* meshes back out of the scene at the end, and only its
  // own: two vehicles' templates live in the same scene, and one must not unsit the other.
  const created: Mesh[] = [];
  const part = (name: string, parent: TransformNode, size: number): TransformNode => {
    const mesh = MeshBuilder.CreateBox(name, { size }, scene);
    mesh.material = material;
    mesh.parent = parent;
    mesh.computeWorldMatrix(true);
    mesh.refreshBoundingInfo({});
    created.push(mesh);
    return mesh;
  };

  const driver = new TransformNode('Tank', scene);
  const gltfRoot = new TransformNode('TankModel', scene);
  gltfRoot.parent = driver;

  const hull = part('Hull', gltfRoot, 2);
  const turret = part('Turret', hull, 1);
  const gun = part('Gun', turret, 0.5);
  const muzzle = new TransformNode('Muzzle', scene);
  muzzle.parent = gun;
  muzzle.position.z = 2;

  for (const side of ['L', 'R'] as const) {
    for (let i = 0; i < 2; i += 1) {
      part(`Wheel${side}${i}`, hull, 0.6);
    }
    for (let i = 0; i < 2; i += 1) {
      part(`Track${side}${i}`, hull, 0.4);
    }
  }

  // A template is a blueprint, not a vehicle: it must never be drawn and must never appear in
  // `scene.meshes`. Removing it here is what lets these tests tell "two live instances exist" apart from
  // "one rig plus its template is still hanging around", which is the whole bug.
  for (const mesh of created) {
    scene.removeMesh(mesh);
  }

  return {
    templateRoot: driver,
    vehicleId: definition.id,
    normalisationNote: `test template for ${definition.id}`,
  };
}

/**
 * A scene with one off-scene template for a vehicle, plus the engine to dispose afterwards.
 *
 * The template is returned rather than buried, because every test here needs to instantiate from it
 * itself -- and instantiating twice from *one* template is the whole point of the exercise.
 */
function mirrorSetup(definition: VehicleDefinition): {
  scene: Scene;
  engine: NullEngine;
  source: VehicleSource;
} {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const source = buildTemplate(scene, definition);
  expect(scene.meshes).toHaveLength(0);
  return { scene, engine, source };
}

/** Distance between two world points, without pulling Babylon's vector maths into the assertions. */
function Vector3Distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('instantiation measures a clone, not a stale bounding box', () => {
  // A regression the live browser audit caught, which no amount of node-identity reasoning would have.
  //
  // The loader used to measure wheels and track segments against a model that had been added to the scene
  // and rendered, so its cached bounding info was real. Instantiation measures against a *clone*, and a
  // freshly cloned Babylon mesh still carries the zero-sized bounding box it was constructed with until
  // something forces a refresh. Every radius therefore collapsed to the 0.05 m floor, every track segment
  // to its 0.1 m default, and the running gear animated from numbers describing nothing -- while every
  // other check stayed green, because a tank with plausible-shaped boxes at the wrong scale is not a
  // visible failure from the player's seat.
  //
  // This is recorded here because it is exactly the class of defect that hides: it degrades motion rather
  // than breaking the render, and it only shows up in a real browser.
  for (const definition of [CT_MEDIUM, CT_HEAVY, CT_LIGHT]) {
    it(`measures real running-gear dimensions for ${definition.displayName}`, () => {
      const { engine, source } = mirrorSetup(definition);
      try {
        const rig = instantiateVehicleRig(source);

        // Real road wheels on a real tank are hundreds of millimetres across, never the 50 mm floor.
        const radii = rig.wheels.map((w) => w.radiusM);
        expect(radii.length).toBeGreaterThan(0);
        const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
        expect(mean).toBeGreaterThan(0.2);
        expect(mean).toBeLessThan(definition.dimensions.widthM * 0.6);

        // Track segments likewise: a real segment is a fraction of a metre tall, not the 0.1 m default.
        const heights = rig.tracks.map((t) => t.halfHeightM);
        expect(heights.length).toBeGreaterThan(0);
        for (const height of heights) {
          expect(height).toBeGreaterThan(0.15);
        }

        // Both sides must agree, since they are the same model: a per-instance measurement that varied
        // would mean one of the two was measuring something stale.
        const second = instantiateVehicleRig(source);
        expect(second.wheels.map((w) => w.radiusM)).toEqual(radii);
        expect(second.tracks.map((t) => t.halfHeightM)).toEqual(heights);
      } finally {
        engine.dispose();
      }
    });
  }
});

/** Flat ground at a constant height, so track conforming cannot confound a position assertion. */
const flatGround = () => 0;

/** Two distinct simulation vehicles, one per side, for a given matchup. */
function duel(player: VehicleDefinition, opponent: VehicleDefinition): Simulation {
  return new Simulation({ vehicle: player, target: opponent });
}

/** The turret and gun angles, in the shape `VehicleVisual.apply` reads. */
const pointingAt = (localAngleRad: number, elevationRad = 0) => ({
  localAngleRad,
  elevationRad,
});

/**
 * The three reported matchups, each asserted against the full list of ownership properties.
 *
 * Requirements 1-8 of the roster retest, run against every mirror case:
 * 1. two distinct simulation vehicles exist;
 * 2. two distinct visual roots exist;
 * 3. both are enabled and visible;
 * 4. their world positions differ appropriately;
 * 5. moving the player does not move the opponent;
 * 6. enemy turret movement does not move the player's turret;
 * 7. damaging one does not visually damage the other;
 * 8. destroying one does not dispose or hide the other.
 *
 * The visual half runs through real `VehicleVisual`s driven by the real simulation, because the bug was
 * never in the nodes alone -- it was in the `apply()` calls fighting over them. A test that only compared
 * node identity would pass while the rendered game still showed one tank.
 */
describe('same-vehicle matchups render two independent tanks', () => {
  for (const { player, opponent, label } of MIRROR_CASES) {
    describe(label, () => {
      it('gives each side its own simulation vehicle, with independent state', () => {
        // Requirement 1. Sharing the *definition* is fine and intended; sharing mutable combat state is
        // not. This asserts the simulation half was never wrong, so a future failure here is a new bug
        // rather than a relapse of the old one.
        const sim = duel(player, opponent);

        expect(sim.vehicle).not.toBe(sim.target);
        expect(sim.vehicle.definition).toBe(sim.target?.definition);
        expect(sim.vehicle.damage).not.toBe(sim.target?.damage);
        expect(sim.vehicle.gunState).not.toBe(sim.target?.gunState);
        expect(sim.vehicle.state).not.toBe(sim.target?.state);
        expect(sim.vehicle.state.position.x).not.toBeCloseTo(sim.target!.state.position.x, 1);

        // Both start whole, and each reports the shared definition's hit points -- equal numbers, two
        // separate states.
        expect(sim.vehicle.damage.hitPoints).toBe(player.survivability.hitPoints);
        expect(sim.target!.damage.hitPoints).toBe(opponent.survivability.hitPoints);
      });

      it('builds two distinct visual roots, both enabled and visible, at different world positions', () => {
        // Requirements 2, 3 and 4. This is the assertion the old suite was missing: it is about a
        // *pair* of vehicles, and nothing in the roster walk ever asked it.
        const { scene, engine, source } = mirrorSetup(player);
        try {
          const playerRig = instantiateVehicleRig(source);
          const targetRig = instantiateVehicleRig(source);

          // 2: two distinct roots. The original bug made these the *same* node.
          expect(playerRig.root).not.toBe(targetRig.root);
          expect(playerRig.turret).not.toBe(targetRig.turret);
          expect(playerRig.gun).not.toBe(targetRig.gun);
          expect(playerRig.meshes[0]).not.toBe(targetRig.meshes[0]);

          // Both sets of meshes are really in the scene, and are not merely sharing one set.
          const inScene = (rig: typeof playerRig): number =>
            rig.meshes.filter((m) => scene.meshes.includes(m)).length;
          expect(inScene(playerRig)).toBe(playerRig.meshes.length);
          expect(inScene(targetRig)).toBe(targetRig.meshes.length);
          expect(playerRig.meshes.some((m) => targetRig.meshes.includes(m))).toBe(false);

          // 3: enabled and visible.
          for (const rig of [playerRig, targetRig]) {
            for (const mesh of rig.meshes) {
              expect(mesh.isEnabled()).toBe(true);
              expect(mesh.isVisible).toBe(true);
            }
            expect(rig.root.isEnabled()).toBe(true);
          }

          // 4: posed apart, and each root really is where its own vehicle was put.
          playerRig.root.position.set(-40, 0, 80);
          targetRig.root.position.set(30, 0, -10);
          playerRig.root.computeWorldMatrix(true);
          targetRig.root.computeWorldMatrix(true);
          const playerAt = playerRig.root.getAbsolutePosition();
          const targetAt = targetRig.root.getAbsolutePosition();
          expect(playerAt.x).toBeCloseTo(-40, 3);
          expect(targetAt.x).toBeCloseTo(30, 3);
          expect(Vector3Distance(playerAt, targetAt)).toBeGreaterThan(1);
        } finally {
          engine.dispose();
        }
      });

      it('moves the player without moving the opponent, and traverses without cross-talk', () => {
        // Requirements 5 and 6, driven through the real `VehicleVisual.apply` the frame loop calls.
        //
        // This is the test that actually pins the original symptom. Node identity alone would not have
        // caught it: the two rigs were "distinct objects" in one sense while being the same transforms in
        // another. What matters is that applying the player's state and then the opponent's leaves both
        // tanks where each belongs.
        const { scene, engine, source } = mirrorSetup(player);
        try {
          const sim = duel(player, opponent);
          const playerVisual = new VehicleVisual(instantiateVehicleRig(source), scene, flatGround);
          const targetVisual = new VehicleVisual(instantiateVehicleRig(source), scene, flatGround);

          for (let frame = 0; frame < 30; frame += 1) {
            playerVisual.apply(sim.vehicle.state, sim.vehicle.turretState, 1 / 60);
            targetVisual.apply(sim.target!.state, sim.target!.turretState, 1 / 60);
          }

          const playerRig = playerVisual.vehicleRig;
          const targetRig = targetVisual.vehicleRig;

          // Each visual is at its own vehicle's simulated position.
          expect(playerRig.root.position.x).toBeCloseTo(sim.vehicle.state.position.x, 3);
          expect(playerRig.root.position.z).toBeCloseTo(sim.vehicle.state.position.z, 3);
          expect(targetRig.root.position.x).toBeCloseTo(sim.target!.state.position.x, 3);
          expect(targetRig.root.position.z).toBeCloseTo(sim.target!.state.position.z, 3);
          // World matrices are computed explicitly before reading absolute positions. Instantiation
          // measures each mesh, which computes and caches world matrices at the origin; reading an
          // absolute position without refreshing would report that stale origin rather than the pose.
          playerRig.root.computeWorldMatrix(true);
          targetRig.root.computeWorldMatrix(true);
          expect(
            Vector3Distance(playerRig.root.getAbsolutePosition(), targetRig.root.getAbsolutePosition()),
          ).toBeGreaterThan(1);

          // Displace the player hard and re-apply only the player. The opponent must not budge.
          // Read through the getters: `root.position` is a Vector3 whose components live behind
          // `_x`/`_y`/`_z`, so spreading it into a plain object would silently snapshot undefineds.
          const beforeTargetX = targetRig.root.position.x;
          const beforeTargetZ = targetRig.root.position.z;
          const beforeTargetTurret = targetRig.turret.rotation.y;
          playerRig.root.position.x += 25;
          playerVisual.apply(sim.vehicle.state, sim.vehicle.turretState, 1 / 60);
          expect(targetRig.root.position.x).toBeCloseTo(beforeTargetX, 6);
          expect(targetRig.root.position.z).toBeCloseTo(beforeTargetZ, 6);
          expect(targetRig.turret.rotation.y).toBeCloseTo(beforeTargetTurret, 6);

          // Point each turret somewhere different and confirm the two are independent.
          playerVisual.apply(sim.vehicle.state, pointingAt(0.6), 1 / 60);
          targetVisual.apply(sim.target!.state, pointingAt(-0.9), 1 / 60);
          expect(playerRig.turret.rotation.y).toBeCloseTo(0.6, 6);
          expect(targetRig.turret.rotation.y).toBeCloseTo(-0.9, 6);

          // Turret movement on one side must not rotate the other side's turret. This is the assertion
          // that would have failed with a shared turret node even if the roots had somehow differed.
          targetVisual.apply(sim.target!.state, pointingAt(1.4), 1 / 60);
          expect(playerRig.turret.rotation.y).toBeCloseTo(0.6, 6);
          expect(targetRig.turret.rotation.y).toBeCloseTo(1.4, 6);
        } finally {
          engine.dispose();
        }
      });

      it('keeps the wreck state of one tank off the other', () => {
        // Requirements 7 and 8. Destruction is the sharpest test of ownership, because
        // `VehicleVisual.dispose` frees materials *and their textures*: a shared material is not merely
        // recoloured, it is disposed out from under the other tank.
        const { scene, engine, source } = mirrorSetup(player);
        try {
          const playerRig = instantiateVehicleRig(source);
          const targetRig = instantiateVehicleRig(source);
          const playerVisual = new VehicleVisual(playerRig, scene, flatGround);
          const targetVisual = new VehicleVisual(targetRig, scene, flatGround);

          // 7: each instance owns its materials, so tinting one cannot tint the other.
          const playerMaterials = playerRig.meshes.map((m) => m.material);
          const targetMaterials = targetRig.meshes.map((m) => m.material);
          for (const [i, material] of playerMaterials.entries()) {
            if (material !== null) {
              expect(targetMaterials[i]).not.toBe(material);
            }
          }

          const targetBefore = targetRig.meshes.map((m) => m.material);
          playerVisual.setDestroyed(true);
          expect(targetRig.meshes.map((m) => m.material)).toEqual(targetBefore);

          // The player's own tint really did apply, or the assertion above would prove nothing.
          const playerHullMaterial = playerRig.meshes.find((m) => m.name === 'Hull')?.material as
            | { albedoColor?: { r: number; g: number; b: number } }
            | null
            | undefined;
          expect(playerHullMaterial?.albedoColor?.r).toBeCloseTo(0.09, 3);

          // Restoring the player must not have disturbed the opponent either.
          playerVisual.setDestroyed(false);
          expect(targetRig.meshes.map((m) => m.material)).toEqual(targetBefore);

          // 8: disposing the player's rig must leave the opponent's nodes, meshes and materials intact.
          // Babylon reference-counts geometry, so this holds only because disposal releases one
          // reference rather than freeing buffers another mesh still points at.
          playerVisual.dispose();
          for (const mesh of targetRig.meshes) {
            expect(mesh.isDisposed()).toBe(false);
            expect(mesh.isEnabled()).toBe(true);
            expect(mesh.isVisible).toBe(true);
            expect(scene.meshes.includes(mesh)).toBe(true);
            expect(mesh.geometry).not.toBeNull();
          }
          expect(targetRig.root.isDisposed()).toBe(false);
          expect(targetRig.root.isEnabled()).toBe(true);
          for (const material of targetMaterials) {
            if (material !== null) {
              expect(scene.materials.includes(material)).toBe(true);
            }
          }

          // And the survivor is still poseable, which is what "not disposed" has to mean in practice.
          const sim = duel(player, opponent);
          expect(() => targetVisual.apply(sim.target!.state, pointingAt(0), 1 / 60)).not.toThrow();
        } finally {
          engine.dispose();
        }
      });

      it('restores both tanks after a restart, and never reuses a disposed instance', () => {
        // Requirements 9 and 10.
        //
        // Restart tears the encounter down and builds a new one, which is exactly when a cache that
        // hands out live rigs returns something already disposed -- the failure the old `releaseVehicleRigFor`
        // existed to paper over. Switching away and back is the other moment it misbehaved. Both are
        // asserted here over the real source/template cycle, so the paper-over is no longer load-bearing.
        const { scene, engine, source } = mirrorSetup(player);
        try {
          const sim = duel(player, opponent);

          const first = [
            new VehicleVisual(instantiateVehicleRig(source), scene, flatGround),
            new VehicleVisual(instantiateVehicleRig(source), scene, flatGround),
          ];
          first[0]!.apply(sim.vehicle.state, sim.vehicle.turretState, 1 / 60);
          first[1]!.apply(sim.target!.state, sim.target!.turretState, 1 / 60);
          const firstRoots = first.map((v) => v.vehicleRig.root);

          // Restart: both rigs are disposed, and two brand new ones are built from the same source.
          for (const visual of first) {
            visual.dispose();
          }
          for (const root of firstRoots) {
            expect(root.isDisposed()).toBe(true);
          }

          const afterRestart = [
            new VehicleVisual(instantiateVehicleRig(source), scene, flatGround),
            new VehicleVisual(instantiateVehicleRig(source), scene, flatGround),
          ];
          const restartedRoots = afterRestart.map((v) => v.vehicleRig.root);

          // 9: both are back, alive, and not the old nodes.
          for (const [i, root] of restartedRoots.entries()) {
            expect(root.isDisposed()).toBe(false);
            expect(root.isEnabled()).toBe(true);
            expect(root).not.toBe(firstRoots[i]);
          }
          expect(restartedRoots[0]).not.toBe(restartedRoots[1]);

          // 10: switch away and back. Still fresh nodes, never a disposed instance handed out again.
          const switchedAway = new VehicleVisual(instantiateVehicleRig(source), scene, flatGround);
          const awayRoot = switchedAway.vehicleRig.root;
          switchedAway.dispose();
          expect(awayRoot.isDisposed()).toBe(true);

          const switchedBack = [
            new VehicleVisual(instantiateVehicleRig(source), scene, flatGround),
            new VehicleVisual(instantiateVehicleRig(source), scene, flatGround),
          ];
          for (const root of switchedBack.map((v) => v.vehicleRig.root)) {
            expect(root.isDisposed()).toBe(false);
            expect(root).not.toBe(awayRoot);
          }
          expect(switchedBack[0]!.vehicleRig.root).not.toBe(switchedBack[1]!.vehicleRig.root);

          // The mesh budget proves nothing leaked across the whole sequence. Four instances were created
          // and two disposed, so the scene must hold exactly the survivors' meshes -- no residue from the
          // first pair, and no doubled-up geometry from the template.
          const survivors = [...afterRestart, ...switchedBack];
          const expected = survivors.reduce((sum, v) => sum + v.meshes.length, 0);
          expect(scene.meshes.length).toBe(expected);
        } finally {
          engine.dispose();
        }
      });
    });
  }
});

/**
 * The full 3x3 matchup matrix, not just the mirror cells.
 *
 * The bug was reachable only where the two sides shared a model, but the *repair* is general: one
 * template can back any number of instances. Testing only the diagonal would leave the off-diagonal
 * path -- two different vehicles in one scene, which is what the game does by default -- unverified
 * against the new instantiation code. It is cheap, so it is asserted.
 *
 *       AI:   Sabre  Anvil  Vex
 * Player Sabre   *      *      *
 *        Anvil   *      *      *
 *        Vex     *      *      *
 */
describe('every matchup builds two independent visible rigs', () => {
  const ROSTER = [CT_MEDIUM, CT_HEAVY, CT_LIGHT] as const;

  for (const player of ROSTER) {
    for (const opponent of ROSTER) {
      it(`${player.displayName} vs ${opponent.displayName}`, () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        try {
          // One shared template when the vehicles match, two when they differ. Both paths must produce
          // two independent rigs, which is the invariant in either case.
          const playerSource = buildTemplate(scene, player);
          const opponentSource = player === opponent ? playerSource : buildTemplate(scene, opponent);

          const playerRig = instantiateVehicleRig(playerSource);
          const targetRig = instantiateVehicleRig(opponentSource);

          expect(playerRig.vehicleId).toBe(player.id);
          expect(targetRig.vehicleId).toBe(opponent.id);
          expect(playerRig.root).not.toBe(targetRig.root);
          expect(playerRig.meshes.some((m) => targetRig.meshes.includes(m))).toBe(false);

          // Both visible at once. Counted as *distinct* meshes, never as "the scene has meshes", so a
          // shared template or a shared node cannot be mistaken for a second tank.
          for (const rig of [playerRig, targetRig]) {
            for (const mesh of rig.meshes) {
              expect(scene.meshes.includes(mesh)).toBe(true);
              expect(mesh.isVisible).toBe(true);
              expect(mesh.isEnabled()).toBe(true);
            }
          }

          // A shared model still yields two rigs whose geometry is reference-counted rather than
          // duplicated: same buffers, different nodes and different materials.
          if (player === opponent) {
            expect(playerRig.meshes[0]!.geometry).toBe(targetRig.meshes[0]!.geometry);
            expect(playerRig.meshes[0]).not.toBe(targetRig.meshes[0]);
            expect(playerRig.meshes[0]!.material).not.toBe(targetRig.meshes[0]!.material);
          }
        } finally {
          engine.dispose();
        }
      });
    }
  }
});

/**
 * Selector-style reselection sequences, including restarts.
 *
 * The brief is explicit that this bug may be lifecycle-related rather than a pure construction
 * failure, and it is right. The *first* same-type encounter of a session is the only place a shared rig
 * is visible with no cache involved at all, whereas switching and restarting are where a stale or
 * disposed instance resurfaces. A construction-only test would pass while the selector path stayed broken.
 *
 * The sequence is the one the owner will actually play:
 *
 *   Sabre vs Anvil -> Sabre vs Sabre -> Vex vs Sabre -> Vex vs Vex -> Anvil vs Anvil
 *
 * with a restart between some transitions.
 */
describe('selector reselection keeps both tanks alive', () => {
  const SEQUENCE: readonly { player: VehicleDefinition; opponent: VehicleDefinition }[] = [
    { player: CT_MEDIUM, opponent: CT_HEAVY },
    { player: CT_MEDIUM, opponent: CT_MEDIUM },
    { player: CT_LIGHT, opponent: CT_MEDIUM },
    { player: CT_LIGHT, opponent: CT_LIGHT },
    { player: CT_HEAVY, opponent: CT_HEAVY },
  ];

  it('survives the full switch sequence with two live rigs at every step', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      // Templates stand in for the loader's cache: one per vehicle, created lazily as a first-time
      // selection would, and reused for every later selection of that vehicle -- including a vehicle
      // appearing on both sides, which is the case that used to hand out one rig twice.
      const templates = new Map<string, VehicleSource>();
      const sourceFor = (definition: VehicleDefinition): VehicleSource => {
        const existing = templates.get(definition.id);
        if (existing !== undefined) {
          return existing;
        }
        const created = buildTemplate(scene, definition);
        templates.set(definition.id, created);
        return created;
      };

      // Whatever is currently on screen, rebuilt the way `startEncounter` does it.
      let live: VehicleVisual[] = [];
      const tearDown = (): void => {
        for (const visual of live) {
          visual.dispose();
        }
        live = [];
      };

      for (const [index, { player, opponent }] of SEQUENCE.entries()) {
        tearDown();
        const playerVisual = new VehicleVisual(
          instantiateVehicleRig(sourceFor(player)),
          scene,
          flatGround,
        );
        const targetVisual = new VehicleVisual(
          instantiateVehicleRig(sourceFor(opponent)),
          scene,
          flatGround,
        );
        live = [playerVisual, targetVisual];

        const sim = duel(player, opponent);
        playerVisual.apply(sim.vehicle.state, sim.vehicle.turretState, 1 / 60);
        targetVisual.apply(sim.target!.state, sim.target!.turretState, 1 / 60);

        const label = `step ${index}: ${player.displayName} vs ${opponent.displayName}`;
        const playerRig = playerVisual.vehicleRig;
        const targetRig = targetVisual.vehicleRig;

        expect(playerRig.root.isDisposed(), label).toBe(false);
        expect(targetRig.root.isDisposed(), label).toBe(false);
        expect(playerRig.root, label).not.toBe(targetRig.root);
        expect(playerRig.root.position.x, label).toBeCloseTo(sim.vehicle.state.position.x, 3);
        expect(targetRig.root.position.z, label).toBeCloseTo(sim.target!.state.position.z, 3);

        for (const rig of [playerRig, targetRig]) {
          const visible = rig.meshes.filter((m) => scene.meshes.includes(m) && m.isVisible).length;
          expect(visible, label).toBe(rig.meshes.length);
        }

        // A restart mid-sequence must clear the scene completely: the next step builds fresh rigs, and
        // the disposed ones leave nothing behind to masquerade as a tank.
        if (index === 1 || index === 3) {
          expect(scene.meshes.length, `${label} before restart`).toBeGreaterThan(0);
          tearDown();
          expect(scene.meshes.length, `${label} after restart`).toBe(0);
        }
      }
    } finally {
      engine.dispose();
    }
  });

  it('keeps the simulation sides distinct through the same sequence', () => {
    // The non-rendering half of reselection. Restarting an encounter resets battle state; it must never
    // collapse the two vehicles into one object, which would make a mirror matchup unwinnable by
    // construction rather than by damage.
    for (const { player, opponent } of SEQUENCE) {
      const sim = duel(player, opponent);
      expect(sim.vehicle).not.toBe(sim.target);
      expect(sim.vehicle.state).not.toBe(sim.target!.state);
      expect(sim.vehicle.state.position).not.toBe(sim.target!.state.position);
    }
  });
});
