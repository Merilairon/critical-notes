import { defineProject } from 'vitest/config';

export default defineProject({
  // testTimeout 20 s is the general margin for API tests on a busy machine. The homebrew schema compile that used to eat
  // it (16 s under load) now runs in the beforeAll of homebrew, transfer and mcp (warmHomebrewValidator, test/helpers.ts).
  test: { name: 'server', include: ['test/**/*.test.ts'], pool: 'forks', testTimeout: 20_000 },
});
