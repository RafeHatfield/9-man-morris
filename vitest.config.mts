import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // `skipFull` is passed explicitly: without it this reporter hides every file
      // that is fully covered, which is all of them, and prints an empty table.
      // One consequence worth knowing when reading the output: `index.ts` is
      // re-exports only, so it has nothing to cover and renders as `0 | 0 | 0 | 0`
      // while contributing 0/0 to a 100% total. That row is not a hole — the
      // summary line and `coverage-summary.json` both record it at 100%.
      reporter: [['text', { skipFull: false }], 'json-summary'],
      include: ['src/lib/engine/**/*.ts'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
