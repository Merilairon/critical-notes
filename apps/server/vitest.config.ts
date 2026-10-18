import { defineProject } from 'vitest/config';

export default defineProject({
  // testTimeout: three older API tests (transfer, homebrew, mcp) take about 4.1 s alone, so they hit the 5 s default whenever
  // the machine is busy; 20 s is one place instead of editing those tests (docs/PLAN.md)
  test: { name: 'server', include: ['test/**/*.test.ts'], pool: 'forks', testTimeout: 20_000 },
});
