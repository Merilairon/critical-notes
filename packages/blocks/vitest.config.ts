import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'blocks', include: ['test/**/*.test.ts'] },
});
