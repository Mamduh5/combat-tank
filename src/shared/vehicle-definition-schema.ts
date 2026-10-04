import type { VehicleDefinition } from './vehicle-definition.js';

/**
 * Load-time validation for vehicle definitions (ADR-0003).
 *
 * A typo in an armour value or a negative mass must fail loudly at startup, not produce a vehicle
 * that quietly behaves wrongly and gets debugged through the renderer. This validator is
 * hand-written rather than pulled from a schema library, because the rule from
 * `docs/technical-direction.md` §10 is not to add dependencies without a stated problem, and the
 * problem here is small enough that a dependency would cost more than it saves.
 *
 * Every check names the exact path that failed, so the message is actionable without a debugger.
 */

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Validates a vehicle definition, returning every problem found rather than only the first. */
export function validateVehicleDefinition(
  definition: unknown,
  label = 'vehicle definition',
): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(definition)) {
    return { valid: false, errors: [`${label}: expected an object`] };
  }

  requireString(definition, 'id', errors);
  requireString(definition, 'displayName', errors);
  requireString(definition, 'visualId', errors);

  const dimensions = requireSection(definition, 'dimensions', errors);
  if (dimensions) {
    requirePositive(dimensions, 'lengthM', `${label}.dimensions`, errors);
    requirePositive(dimensions, 'widthM', `${label}.dimensions`, errors);
    requirePositive(dimensions, 'heightM', `${label}.dimensions`, errors);
    requireNonNegative(dimensions, 'groundClearanceM', `${label}.dimensions`, errors);
  }

  const powertrain = requireSection(definition, 'powertrain', errors);
  if (powertrain) {
    requirePositive(powertrain, 'massKg', `${label}.powertrain`, errors);
    requirePositive(powertrain, 'driveForceN', `${label}.powertrain`, errors);
    // **Non-negative, not positive.** V3 introduces a stationary test target, and a zero top speed is
    // a legitimate description of a vehicle that does not drive. It was previously rejected because
    // every vehicle in V1 moved; that is no longer true, and encoding "everything drives" into the
    // schema would block any future static vehicle or emplacement.
    requireNonNegative(powertrain, 'maxSpeedMps', `${label}.powertrain`, errors);
    requireNonNegative(powertrain, 'maxReverseSpeedMps', `${label}.powertrain`, errors);
    requirePositive(powertrain, 'brakeDecelMps2', `${label}.powertrain`, errors);
    requireNonNegative(powertrain, 'coastDecelMps2', `${label}.powertrain`, errors);
  }

  const traversal = requireSection(definition, 'traversal', errors);
  if (traversal) {
    requirePositive(traversal, 'hullTraverseDegPerSec', `${label}.traversal`, errors);
    requirePositive(traversal, 'hullTraverseAccelDegPerSec2', `${label}.traversal`, errors);
    requireUnitInterval(traversal, 'traverseSpeedPenalty', `${label}.traversal`, errors);
  }

  const ground = requireSection(definition, 'ground', errors);
  if (ground) {
    requirePositive(ground, 'maxClimbDeg', `${label}.ground`, errors);
    requirePositive(ground, 'maxDescendDeg', `${label}.ground`, errors);
    requireUnitInterval(ground, 'climbSpeedRetention', `${label}.ground`, errors);
    requirePositive(ground, 'suspensionStiffness', `${label}.ground`, errors);
    requirePositive(ground, 'suspensionDamping', `${label}.ground`, errors);
  }

  const turret = requireSection(definition, 'turret', errors);
  if (turret) {
    requirePositive(turret, 'traverseDegPerSec', `${label}.turret`, errors);
    requirePositive(turret, 'traverseAccelDegPerSec2', `${label}.turret`, errors);
    requirePositive(turret, 'ringHeightM', `${label}.turret`, errors);
    // A traverse arc may be anything up to a full turn. 360 is explicitly allowed: the owner's V3
    // decision gives the placeholder tank a full ring, and the model still supports restricted arcs for
    // casemate-style vehicles. What it must never exceed is a full turn, which would make the limit
    // meaningless.
    requireRange(turret, 'maxTraverseDeg', 0.1, 360, `${label}.turret`, errors);
  }

  const mainGun = requireSection(definition, 'mainGun', errors);
  if (mainGun) {
    requireRange(mainGun, 'maxElevationDeg', 0, 90, `${label}.mainGun`, errors);
    requireRange(mainGun, 'maxDepressionDeg', 0, 90, `${label}.mainGun`, errors);
    requirePositive(mainGun, 'elevateRateDegPerSec', `${label}.mainGun`, errors);
    requirePositive(mainGun, 'barrelLengthM', `${label}.mainGun`, errors);
    // A zero reload would make the gun a continuous-fire button, which is not what a main gun is.
    requirePositive(mainGun, 'reloadSeconds', `${label}.mainGun`, errors);
  }

  const mainShell = requireSection(definition, 'mainShell', errors);
  if (mainShell) {
    requireString(mainShell, 'id', errors);
    requireString(mainShell, 'displayName', errors);
    requirePositive(mainShell, 'muzzleVelocityMps', `${label}.mainShell`, errors);
    requirePositive(mainShell, 'massKg', `${label}.mainShell`, errors);
    requirePositive(mainShell, 'maxRangeM', `${label}.mainShell`, errors);
    requirePositive(mainShell, 'maxLifetimeSeconds', `${label}.mainShell`, errors);
    // The sub-step size bounds how far a shell can pass through terrain undetected. A large value
    // silently reintroduces tunnelling, so it is validated rather than trusted.
    requireRange(mainShell, 'maxSubstepM', 0.05, 50, `${label}.mainShell`, errors);
    requirePositive(mainShell, 'nominalPenetrationMm', `${label}.mainShell`, errors);
    requireUnitInterval(mainShell, 'normalization', `${label}.mainShell`, errors);
  }

  const survivability = requireSection(definition, 'survivability', errors);
  if (survivability) {
    requirePositive(survivability, 'hitPoints', `${label}.survivability`, errors);
    requirePositive(
      survivability,
      'damagePerPenetration',
      `${label}.survivability`,
      errors,
    );
    requireArray(survivability, 'modules', `${label}.survivability`, errors);
  }

  requireArray(definition, 'armor', `${label}`, errors);

  const penetration = requireSection(definition, 'penetration', errors);
  if (penetration) {
    requirePositive(penetration, 'referenceVelocityMps', `${label}.penetration`, errors);
    // Capped below 90 because the effective-armour formula divides by cos(90) = 0. A ricochet rule
    // that could never fire would leave that division reachable from real gameplay.
    requireRange(penetration, 'ricochetThresholdDeg', 1, 90, `${label}.penetration`, errors);
  }

  // --- Audio, added in V8 ------------------------------------------------------------------
  // Required, and range-checked rather than merely checked for presence. An unbounded pitch scale is the
  // interesting failure here: `enginePitchScale: 40` is a finite number, passes any "is it a number" test,
  // and produces an audio graph that is technically running and completely unusable. The bounds are the
  // ones documented on `VehicleAudioProfile` — wide enough for a genuinely different engine character,
  // narrow enough that the result still reads as the same family.
  const audio = requireSection(definition, 'audio', errors);
  if (audio) {
    requireRange(audio, 'enginePitchScale', 0.5, 2, `${label}.audio`, errors);
    requireRange(audio, 'gunPitchScale', 0.5, 2, `${label}.audio`, errors);
    for (const gain of ['engineGainScale', 'trackGainScale', 'gunGainScale', 'turretGainScale']) {
      requireRange(audio, gain, 0, 2, `${label}.audio`, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Requires an array field to be present and actually an array. */
function requireArray(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(parent[key])) {
    errors.push(`${path}.${key}: expected an array`);
  }
}

/**
 * Validates and returns the definition, throwing on failure.
 *
 * Used at module load for the shipped definitions so an invalid one cannot reach the simulation.
 */
export function assertValidVehicleDefinition(
  definition: unknown,
  label?: string,
): asserts definition is VehicleDefinition {
  const result = validateVehicleDefinition(definition, label);
  if (!result.valid) {
    throw new Error(`Invalid ${label ?? 'vehicle definition'}:\n  - ${result.errors.join('\n  - ')}`);
  }
}

// --- small helpers -------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  parent: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (typeof parent[key] !== 'string' || parent[key] === '') {
    errors.push(`${key}: expected a non-empty string`);
  }
}

function requireSection(
  parent: Record<string, unknown>,
  key: string,
  errors: string[],
): Record<string, unknown> | null {
  const section = parent[key];
  if (!isRecord(section)) {
    errors.push(`${key}: expected an object`);
    return null;
  }
  return section;
}

function requirePositive(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${path}.${key}: expected a finite number greater than 0`);
  }
}

function requireNonNegative(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${path}.${key}: expected a finite number of 0 or more`);
  }
}

function requireUnitInterval(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${path}.${key}: expected a finite number in [0, 1]`);
  }
}

/** Requires a finite number within an inclusive range. */
function requireRange(
  parent: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  path: string,
  errors: string[],
): void {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${path}.${key}: expected a finite number in [${min}, ${max}]`);
  }
}
