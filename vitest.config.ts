import { defineConfig } from 'vitest/config';

/**
 * Tests run in a plain Node environment.
 *
 * The simulation core is deliberately free of DOM and rendering dependencies (ADR-0001), so its
 * tests need no browser, no jsdom, and no Babylon. Tests that touch Rapier initialise the WASM
 * module explicitly in `beforeAll`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Rapier's WASM module is inlined as base64 in the `-compat` build; the first test that
    // initialises it pays a one-off decode cost.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
