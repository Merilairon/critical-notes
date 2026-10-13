import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'fivetools', include: ['test/**/*.test.ts'] },
});
