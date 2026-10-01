export * from './trig.js';

/**
 * Re-exported from `src/shared/vec3.ts`.
 *
 * The vector type lives in `shared` because `InputCommand` carries an aim point and both the core
 * and the shells need to read it. Keeping one definition avoids two structurally-identical `Vec3`
 * types that would not be assignable to each other, and it preserves the dependency direction
 * (core -> shared, never the reverse).
 */
export * from '../../shared/vec3.js';

/**
 * Re-exported so the core has one import for its arithmetic helpers.
 *
 * `moveToward` is defined in `vehicle/locomotion.ts` because that is where it was first needed, but
 * the turret servo needs it too. Rather than duplicate a four-line function, or invert a dependency
 * between vehicle modules, it is surfaced here alongside the other maths it belongs with.
 */
export { moveToward } from '../vehicle/locomotion.js';
