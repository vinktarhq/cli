import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';

import { vinktar } from '../../src/vite.js';
import { existingDebugId, REGISTRY_GLOBAL } from '../../src/debug-id.js';

/**
 * A real Vite build, not a hook called in isolation.
 *
 * Everything that was wrong with this plugin was invisible to a unit test of its `config` hook:
 * it injected into files Vite had already written and hashed, so the bytes on disk no longer
 * matched the hash in their own filename, and any plugin that had recorded that hash — a PWA
 * precache manifest, an integrity attribute, a precompressed copy — was pointing at content that
 * no longer existed. The only way to see that is to build.
 */

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-vite-'));
  await mkdir(join(dir, 'src'), { recursive: true });

  await writeFile(
    join(dir, 'src/main.ts'),
    `import { greet } from './greet.ts';\n`
      + `console.log(greet('world'));\n`
      + `globalThis.addEventListener('click', () => { void import('./lazy.ts'); });\n`,
    'utf8',
  );
  await writeFile(join(dir, 'src/greet.ts'), `export const greet = (who: string) => \`hi \${who}\`;\n`, 'utf8');
  await writeFile(join(dir, 'src/lazy.ts'), `export const answer = () => 42;\n`, 'utf8');

  return dir;
}

interface Built {
  chunks: Array<{ name: string; code: string }>;
  maps: Array<{ name: string; body: Record<string, unknown> }>;
  warnings: string[];
}

async function run(
  root: string,
  withPlugin: boolean,
  outDir = 'dist',
  overrides: { sourcemap?: boolean } = {},
  pluginOptions: Record<string, unknown> = {},
): Promise<Built> {
  const warnings: string[] = [];

  await build({
    root,
    logLevel: 'silent',
    configFile: false,
    plugins: withPlugin ? [vinktar({ uploadSourcemaps: false, silent: true, ...pluginOptions })] : [],
    build: {
      outDir,
      // Without the plugin there is nothing to turn sourcemaps on, and the comparison needs both
      // sides emitting them.
      ...(overrides.sourcemap === true
        ? { sourcemap: true as const }
        : withPlugin
          ? {}
          : { sourcemap: 'hidden' as const }),
      rollupOptions: {
        input: join(root, 'src/main.ts'),
        onwarn(warning: Rollup.RollupLog) {
          warnings.push(`${warning.code ?? ''}: ${warning.message}`);
        },
      },
    },
  });

  const assets = join(root, outDir, 'assets');
  const names = await readdir(assets);
  const chunks: Built['chunks'] = [];
  const maps: Built['maps'] = [];

  for (const name of names.sort()) {
    const body = await readFile(join(assets, name), 'utf8');
    if (name.endsWith('.map')) maps.push({ name, body: JSON.parse(body) as Record<string, unknown> });
    else if (name.endsWith('.js')) chunks.push({ name, code: body });
  }

  return { chunks, maps, warnings };
}

describe('the vite plugin, through a real build', () => {
  it(
    'stamps every chunk, including one that is code-split out',
    async () => {
      const { chunks } = await run(await project(), true);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(existingDebugId(chunk.code), `${chunk.name} carries no debug id`).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        // The id has to reach the runtime registry, not just a comment: the comment is for the
        // upload, the registry is what the SDK reads when a frame needs resolving.
        expect(chunk.code).toContain(REGISTRY_GLOBAL);
      }
    },
    60_000,
  );

  it(
    'injects before the content hash is computed, so the filename still describes the file',
    async () => {
      const root = await project();
      const stamped = await run(root, true, 'dist-with');
      const plain = await run(root, false, 'dist-without');

      const hash = (name: string): string => /-([A-Za-z0-9_-]+)\.js$/.exec(name)?.[1] ?? '';
      const stampedHashes = stamped.chunks.map((c) => hash(c.name)).sort();
      const plainHashes = plain.chunks.map((c) => hash(c.name)).sort();

      expect(stampedHashes.every((h) => h !== '')).toBe(true);
      // The regression: injecting after the write left these identical while the bytes differed,
      // which is exactly the state that makes a service worker serve a chunk forever.
      expect(stampedHashes).not.toEqual(plainHashes);
    },
    60_000,
  );

  it(
    'shifts the map by exactly the line it inserted, and nothing else',
    async () => {
      const root = await project();
      const stamped = await run(root, true, 'dist-with', {}, { deleteSourcemapsAfterUpload: false });
      const plain = await run(root, false, 'dist-without');

      expect(stamped.maps.length).toBeGreaterThanOrEqual(2);
      expect(stamped.warnings.filter((w) => /sourcemap/i.test(w))).toEqual([]);

      // The snippet goes in as one whole line at the top, so the exact repair is one empty group
      // spliced into `mappings` — an empty group carries no segments and therefore no deltas.
      // Strip that group back off and what is left must be byte-for-byte the unstamped build's.
      const mappings = (built: Built): string[] => built.maps.map((m) => String(m.body['mappings']));
      const shifted = mappings(stamped);

      expect(shifted.every((value) => value.startsWith(';'))).toBe(true);
      expect(shifted.map((value) => value.slice(1)).sort()).toEqual(mappings(plain).sort());

      for (const map of stamped.maps) {
        expect(Array.isArray(map.body['sourcesContent'])).toBe(true);
        // Written by the plugin as the chunk is rendered, so a map that is kept rather than
        // deleted still names its own chunk.
        expect(map.body['debugId']).toMatch(/^[0-9a-f]{8}-/);
      }
    },
    60_000,
  );

  it(
    'resolves a real position through the shifted map',
    async () => {
      // The end-to-end version of the assertion above: decode the mapping for the line the
      // snippet pushed down and confirm it still points at the original source. A map that is one
      // line out resolves every frame to its neighbour, which is worse than no map at all —
      // nobody doubts a source map that answered.
      const root = await project();
      const stamped = await run(root, true, 'dist-resolve', {}, { deleteSourcemapsAfterUpload: false });
      const plain = await run(root, false, 'dist-resolve-plain');

      const anchor = (built: Built): Array<{ line: number; segment: number[] }> =>
        built.maps
          .map((map) => {
            const groups = String(map.body['mappings']).split(';');
            const line = groups.findIndex((group) => group !== '');

            return { line, segment: decodeFirst(groups[line] ?? '') };
          })
          .sort((a, b) => JSON.stringify(a.segment).localeCompare(JSON.stringify(b.segment)));

      const shifted = anchor(stamped);
      const original = anchor(plain);

      expect(shifted).toHaveLength(original.length);
      for (const [index, entry] of shifted.entries()) {
        const was = original[index]!;
        // The same original position, from one generated line further down. Anything else and
        // every frame resolves to its neighbour — which is worse than no map, because nobody
        // doubts a source map that answered.
        expect(entry.segment).toEqual(was.segment);
        expect(entry.line).toBe(was.line + 1);
      }
    },
    60_000,
  );

  it(
    'keeps sourceMappingURL last, so devtools still find the map',
    async () => {
      // `sourcemap: true` (not 'hidden') is the case where the comment is actually emitted, and
      // the plugin must leave it as the last line — devtools stop looking after it. Keeping the
      // maps is what makes `true` mean `true`; with deletion on the plugin forces 'hidden'.
      const { chunks } = await run(await project(), true, 'dist-visible', { sourcemap: true }, {
        deleteSourcemapsAfterUpload: false,
      });

      for (const chunk of chunks) {
        const lines = chunk.code.trimEnd().split('\n');
        expect(lines.at(-1)).toMatch(/^\/\/# sourceMappingURL=/);
        expect(chunk.code).toContain('//# debugId=');
      }
    },
    60_000,
  );

  it(
    'deletes the maps by default, because the plugin is what asked for them',
    async () => {
      const { maps, chunks } = await run(await project(), true, 'dist-deleted', {}, {
        // Not `uploadSourcemaps: false`, which turns the whole feature off, deletion included.
        // This is the shape that bit a real deploy: uploading is on, the key is missing, and the
        // maps must not be left sitting in a directory that is about to be served.
        uploadSourcemaps: undefined,
        key: '',
      });

      expect(maps).toEqual([]);
      // And nothing is left pointing at a file that is gone: a dangling sourceMappingURL is a 404
      // in every devtools session and reads as a broken build.
      for (const chunk of chunks) expect(chunk.code).not.toContain('sourceMappingURL=');
    },
    60_000,
  );
});

/** Base64 VLQ, enough of it to read one segment. */
function decodeFirst(group: string): number[] {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const segment = group.split(',')[0] ?? '';
  const values: number[] = [];
  let shift = 0;
  let value = 0;

  for (const character of segment) {
    const digit = ALPHABET.indexOf(character);
    value += (digit & 31) << shift;

    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }

    values.push((value & 1) === 1 ? -(value >> 1) : value >> 1);
    shift = 0;
    value = 0;
  }

  return values;
}
