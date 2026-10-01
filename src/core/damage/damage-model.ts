import type { ModuleDefinition, ModuleEffect, VehicleDefinition } from '../../shared/vehicle-definition.js';
import type { Vec3 } from '../../shared/vec3.js';
import { localToWorld } from '../armor/geometry.js';

/**
 * Vehicle damage: hit points, modules, and destruction.
 *
 * Kept separate from the armour geometry and the penetration maths because it answers a different
 * question. Penetration asks *can the shell get through this plate*; this asks *what did that do to the
 * vehicle afterwards*. Keeping them apart lets the penetration arithmetic be tested against
 * hand-computed numbers with no damage model in the way.
 *
 * ## Prototype scope, deliberately
 *
 * Damage is a **fixed amount per penetration**, not scaled by how much capability the shell had left.
 * That is a real simplification and it is a choice: the owner preferred deterministic fixed values
 * absent a gameplay reason, and a margin-scaled formula would make every HUD number depend on a
 * calculation the player cannot predict. What *is* modelled is that the outcome differs by where the
 * shell went, which is the property V3 exists to prove.
 *
 * Module damage has **spatial meaning**: a penetration damages a module only if it passed within that
 * module's radius. Shooting the engine bay hurts the engine; shooting the front plate does not.
 */

/** Runtime state of one module. */
export interface ModuleState {
  readonly id: string;
  readonly label: string;
  readonly effect: ModuleEffect;
  /** Remaining hit points. Never negative. */
  hitPoints: number;
  /** True once hit points reached zero. */
  destroyed: boolean;
}

/** Runtime damage state of a whole vehicle. */
export interface DamageState {
  /** Remaining vehicle hit points. Never negative. */
  hitPoints: number;
  /** The vehicle's starting hit points, so the HUD can show a fraction. */
  readonly maxHitPoints: number;
  /** True once vehicle hit points reached zero. */
  destroyed: boolean;
  readonly modules: ModuleState[];
}

/** What a single penetrating hit did. */
export interface DamageReport {
  /** Damage applied to the vehicle, hit points. Zero for a blocked or ricocheted shot. */
  readonly vehicleDamage: number;
  /** Damage applied to each module that was in range, keyed by module id. */
  readonly moduleDamage: Readonly<Record<string, number>>;
  /** Modules whose hit points reached zero as a result of this hit. */
  readonly modulesDestroyed: readonly string[];
  /** True when this hit destroyed the vehicle. */
  readonly vehicleDestroyed: boolean;
}

/** Creates a fresh damage state from a vehicle definition. */
export function createDamageState(definition: VehicleDefinition): DamageState {
  return {
    hitPoints: definition.survivability.hitPoints,
    maxHitPoints: definition.survivability.hitPoints,
    destroyed: false,
    modules: definition.survivability.modules.map((module) => ({
      id: module.id,
      label: module.label,
      effect: module.effect,
      hitPoints: module.hitPoints,
      destroyed: false,
    })),
  };
}

/**
 * Applies a penetration to a vehicle.
 *
 * A single penetration damages **at most one module**: the nearest still-living one whose radius
 * contains the penetration point. Choosing one rather than every overlapping module keeps a single
 * shell from destroying the whole vehicle in one hit, and makes the outcome predictable.
 *
 * @param penetrationPoint where the shell entered the vehicle, world space
 */
export function applyPenetration(
  definition: VehicleDefinition,
  damage: DamageState,
  penetrationPoint: Vec3,
  hullPosition: Vec3,
  hullHeadingRad: number,
  turretWorldHeadingRad: number,
): DamageReport {
  // A destroyed vehicle absorbs nothing further. Without this a wreck could still be "damaged" by a
  // late-arriving shell, reporting damage on something that no longer exists.
  if (damage.destroyed) {
    return { vehicleDamage: 0, moduleDamage: {}, modulesDestroyed: [], vehicleDestroyed: false };
  }

  const vehicleDamage = definition.survivability.damagePerPenetration;
  damage.hitPoints = Math.max(0, damage.hitPoints - vehicleDamage);

  const { moduleDamage, modulesDestroyed } = damageNearestModule(
    definition.survivability.modules,
    damage,
    penetrationPoint,
    hullPosition,
    hullHeadingRad,
    turretWorldHeadingRad,
    vehicleDamage,
  );

  const vehicleDestroyed = damage.hitPoints <= 0;
  if (vehicleDestroyed) {
    damage.destroyed = true;
  }

  return { vehicleDamage, moduleDamage, modulesDestroyed, vehicleDestroyed };
}

/** Damages the single nearest living module within range, if any. */
function damageNearestModule(
  definitions: readonly ModuleDefinition[],
  damage: DamageState,
  penetrationPoint: Vec3,
  hullPosition: Vec3,
  hullHeadingRad: number,
  turretWorldHeadingRad: number,
  amount: number,
): { moduleDamage: Record<string, number>; modulesDestroyed: string[] } {
  const moduleDamage: Record<string, number> = {};
  const modulesDestroyed: string[] = [];

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < definitions.length; i += 1) {
    const module = definitions[i]!;
    const state = damage.modules[i]!;

    // An already-destroyed module is skipped, so a later hit there damages only the vehicle.
    if (state.destroyed) {
      continue;
    }

    // Modules are positioned in local space exactly like plates. A gun module follows the turret,
    // because that is where the gun is; everything else follows the hull.
    const heading = module.effect === 'gun' ? turretWorldHeadingRad : hullHeadingRad;
    const worldCentre = localToWorld(hullPosition, heading, module.centerM);

    const distance = distanceBetween(penetrationPoint, worldCentre);
    if (distance <= module.radiusM && distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  if (bestIndex >= 0) {
    const state = damage.modules[bestIndex]!;
    state.hitPoints = Math.max(0, state.hitPoints - amount);
    if (state.hitPoints <= 0 && !state.destroyed) {
      state.destroyed = true;
      modulesDestroyed.push(state.id);
    }
    moduleDamage[state.id] = amount;
  }

  return { moduleDamage, modulesDestroyed };
}

/** Euclidean distance between two points. */
function distanceBetween(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Remaining hit-point fraction in `[0, 1]`, for the HUD. */
export function healthFraction(damage: DamageState): number {
  if (damage.maxHitPoints <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, damage.hitPoints / damage.maxHitPoints));
}

/** Reads a module's state by id, or `null` if the vehicle has no such module. */
export function findModule(damage: DamageState, id: string): ModuleState | null {
  for (const module of damage.modules) {
    if (module.id === id) {
      return module;
    }
  }
  return null;
}

/** True when a module with this effect is destroyed, for the movement and weapon consequences. */
export function isEffectDestroyed(damage: DamageState, effect: ModuleEffect): boolean {
  for (const module of damage.modules) {
    if (module.effect === effect && module.destroyed) {
      return true;
    }
  }
  return false;
}