import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat configuration.
 *
 * The most important rule set here enforces the core-purity boundary described in
 * `docs/technical-direction.md` §3 and ADR-0001: the simulation core must never import
 * rendering, networking, or platform code. That boundary is what lets the same code run in the
 * browser, in a headless test, and eventually on an authoritative server, so it has to be
 * mechanically enforced rather than merely documented.
 */

const FORBIDDEN_IN_CORE = [
  {
    group: ['@babylonjs/*', 'colyseus', '@colyseus/*', 'colyseus.js'],
    message:
      'src/core is the pure simulation core and must not import rendering or networking code (ADR-0001). Put this in src/client or src/server.',
  },
  {
    group: ['fs', 'node:fs', 'path', 'node:path', 'os', 'node:os', 'crypto', 'node:crypto'],
    message:
      'src/core must stay platform-independent so it can run headless and on a server. Use a core module (e.g. src/core/math) instead.',
  },
];

/**
 * Non-deterministic built-ins. Rapier's own documentation notes that JavaScript's transcendentals
 * are not guaranteed to be identical across platforms, so the core uses its own implementations
 * in `src/core/math/trig.ts` (ADR-0005).
 */
const NON_DETERMINISTIC_GLOBALS = [
  {
    name: 'Math.random',
    message: 'Use the seeded RNG in src/core/rng so battles stay reproducible (ADR-0005).',
  },
  {
    name: 'Date.now',
    message: 'The core advances by fixed ticks and must not read a wall clock (ADR-0001).',
  },
  {
    name: 'performance.now',
    message: 'The core advances by fixed ticks and must not read a wall clock (ADR-0001).',
  },
];

const NON_DETERMINISTIC_MATH = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'exp',
  'log',
  'pow',
  'cbrt',
  'hypot',
  'log2',
  'log10',
  'expm1',
  'log1p',
  'fround',
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },

  // --- Core purity: the hard boundary ---------------------------------------------
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_CORE }],
      'no-restricted-globals': ['error', ...NON_DETERMINISTIC_GLOBALS],
      'no-restricted-properties': [
        'error',
        // Math.random and Date.now are *properties* of a global object rather than bare globals, so
        // `no-restricted-globals` alone silently permits them. Without these entries the rule set
        // looks complete while allowing the two calls most damaging to the core's guarantees.
        {
          object: 'Math',
          property: 'random',
          message: 'Use the seeded RNG in src/core/rng so battles stay reproducible (ADR-0005).',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'The core advances by fixed ticks and must not read a wall clock (ADR-0001).',
        },
        {
          object: 'performance',
          property: 'now',
          message: 'The core advances by fixed ticks and must not read a wall clock (ADR-0001).',
        },
        ...NON_DETERMINISTIC_MATH.map((property) => ({
          object: 'Math',
          property,
          message: `Math.${property} is not cross-platform deterministic. Use src/core/math/trig.ts instead (ADR-0005).`,
        })),
      ],
    },
  },

  // --- Shared code: no wall clock or unseeded randomness, but it may reference platform
  //     types, since it exists to be consumed by the client and server shells. ----------
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...NON_DETERMINISTIC_GLOBALS],
    },
  },
);
