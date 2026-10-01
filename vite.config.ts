import { defineConfig } from 'vite';

/**
 * Client build configuration.
 *
 * Combat Tank is a single package (ADR-0002): Vite builds the Babylon client from `src/client`,
 * while the pure simulation core in `src/core` is imported by both the client and the test suite.
 * The server shell (`src/server`) does not exist until V9.
 */
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
