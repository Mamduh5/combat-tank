/**
 * Public surface of the simulation core.
 *
 * Everything exported here is guaranteed free of rendering, networking, DOM, and wall-clock
 * dependencies, so it can be imported from a test, a browser client, or a server unchanged.
 * The ESLint configuration fails the build if that guarantee is broken.
 */
export * from './math/index.js';
export * from './rng/index.js';
export * from './world/terrain.js';
export * from './world/terrain-grid.js';
export * from './vehicle/vehicle-state.js';
export * from './vehicle/locomotion.js';
export * from './vehicle/turret.js';
export * from './vehicle/main-gun.js';
export * from './vehicle/tank.js';
export * from './ballistics/impact.js';
export * from './ballistics/shell.js';
export * from './ballistics/flight-system.js';
export * from './sim/world.js';
