import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * Placeholder tank proportions and materials, kept apart from the geometry that consumes them.
 *
 * Every proportion is a *fraction of the vehicle definition's dimensions* rather than an absolute
 * measurement. That is deliberate: it means the same proportions hold for a small light tank and a
 * large heavy one, so adding a vehicle in V8 does not require a new model. Only the barrel radius is
 * absolute, because it is a silhouette detail with no gameplay meaning yet.
 *
 * These are tuning surfaces. Adjusting a proportion here changes the model for every vehicle, which
 * is the desired behaviour while every vehicle is a placeholder.
 */
export const TANK_PROPORTIONS = {
  /** Fraction of hull length taken by the track units. */
  trackLengthFraction: 0.94,
  /** Track height as a fraction of hull height. */
  trackHeightFraction: 0.92,
  /** Fraction of hull width taken by each track. */
  trackWidthFraction: 0.28,
  /** Turret length as a fraction of hull length. */
  turretLengthFraction: 0.5,
  /** Turret width as a fraction of hull width. */
  turretWidthFraction: 0.66,
  /** Turret height above the hull roof, as a fraction of hull height. */
  turretHeightFraction: 0.62,
  /** Barrel height above the hull roof, as a fraction of hull height. */
  barrelHeightFraction: 0.38,
  /** Barrel length as a fraction of hull length. */
  barrelLengthFraction: 0.72,
  /** Barrel radius, metres. A silhouette detail with no gameplay meaning in V1. */
  barrelRadiusM: 0.09,
} as const;

/** Placeholder colours. Replaced by real materials in V12. */
export const TANK_COLORS = {
  hull: new Color3(0.32, 0.35, 0.28),
  track: new Color3(0.17, 0.17, 0.18),
  turret: new Color3(0.36, 0.39, 0.31),
  barrel: new Color3(0.24, 0.25, 0.22),
} as const;

/** Creates a matte material. Specular highlights on untextured primitives look like plastic. */
export function makeMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  return material;
}
