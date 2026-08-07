import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@/*` -> repo root, read from tsconfig.json's paths. Vite resolves this natively as of
  // Vite 8 / vitest 4; until 2026-08-07 this was the `vite-tsconfig-paths` plugin, which
  // printed a deprecation notice on every single test run. The alias is needed even though no
  // test file uses `@/` itself — the components under test import each other that way.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
  },
});
