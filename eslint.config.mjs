// ESLint 9 flat config.
//
// `npm run lint` had NO config file of any kind until 2026-08-07 — not a flat config, not a
// legacy .eslintrc — so it exited 2 on every invocation ("ESLint couldn't find an
// eslint.config.(js|mjs|cjs) file"). eslint + eslint-config-next were installed doing nothing.
// eslint-config-next 16.x exports ready-made flat-config arrays, so this is just wiring.
//
// Scope note: `scripts/tools/*.mjs` are offline one-shot analysis scripts run by hand with
// `node`, not part of the app build — they're linted too (they're real code), but the Next.js
// rules that assume a React/browser context don't apply there, hence the narrowing block below.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      // Generated data modules: long literal arrays produced by scripts/tools/*, not hand-edited.
      'lib/irradiance-data.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // `const { dropMe, ...rest } = obj` is the idiomatic way to build an object MINUS a key —
      // the named binding is unused on purpose. Used in tests that assert a validator rejects a
      // payload with a field removed. `_`-prefixed names stay exempt for the same reason.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Offline analysis scripts: plain Node ESM, no React, no Next.js page conventions.
    files: ['scripts/tools/**/*.mjs'],
    rules: {
      '@next/next/no-assign-module-variable': 'off',
    },
  },
];

export default config;
