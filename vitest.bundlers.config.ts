import { defineConfig } from 'vitest/config';

/**
 * The slow suite: real builds through Vite, webpack and rspack.
 *
 * Separate because of Node, not because of duration. Each of these bundlers requires Node 20.19 or
 * newer, so they run on a narrower matrix while `pnpm test` keeps the full 18–24 one — the floor
 * this package actually promises.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/bundlers/*.test.ts'],
    // A cold Vite or rspack build is seconds, and a CI runner under load is more than that.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
