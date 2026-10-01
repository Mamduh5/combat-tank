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
    requirePositive(powertrain, 'maxSpeedMps', `${label}.powertrain`, errors);
    requirePositive(powertrain, 'maxReverseSpeedMps', `${label}.powertrain`, errors);
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
    // A traverse arc is an angle, so it may legitimately exceed 180, but it must stay below a full
    // turn: 360 or more would make "the turret's limit" meaningless.
    requireRange(turret, 'maxTraverseDeg', 0.1, 359, `${label}.turret`, errors);
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
  }

  return { valid: errors.length === 0, errors };
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
