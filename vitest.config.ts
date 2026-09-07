import { defineConfig } from 'vitest/config';

/**
 * The fast suite: unit tests, a local HTTP server, and the two bundlers that run on Node 18.
 *
 * `test/bundlers/` is deliberately excluded. Vite, webpack and rspack all require Node 20.19 or
 * newer, and letting them into this suite would drag the supported floor of the whole package up
 * with them — for fixtures, not for anything a user runs.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/*.test.ts'],
  },
});
