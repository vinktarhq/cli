import { writeFile } from 'node:fs/promises';

/**
 * Mark `dist/cjs` as CommonJS.
 *
 * Node decides a `.js` file's module format from the nearest `package.json`, and this package's
 * own says `"type": "module"` — so without this file every `require('@vinktarhq/cli/webpack')` would
 * parse CommonJS output as ESM and throw. One file, and it is the whole reason a webpack config
 * (which is CommonJS unless its project opted out) can load the plugin at all.
 */
await writeFile(
  new URL('../dist/cjs/package.json', import.meta.url),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);
