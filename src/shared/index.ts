/**
 * Types and data shared by the simulation core and its shells.
 *
 * Nothing here imports from the core, the client, or the server, so both the core and the shells
 * can depend on it without creating a cycle.
 */
export * from './vec3.js';
export * from './input.js';
export * from './vehicle-definition.js';
export * from './vehicle-definition-schema.js';
export * from './placeholder-tank.js';
