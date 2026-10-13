import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '5etools-data/**', 'var/**'],
  },
  server: { watch: { ignored: ['**/5etools-data/**', '**/var/**'] } },
});
