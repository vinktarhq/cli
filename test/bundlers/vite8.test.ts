import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MARKER_GLOBAL, REGISTRY_GLOBAL, existingDebugId } from '../../src/debug-id.js';
import { vinktar } from '../../src/vite.js';

/**
 * Vite 8, which is a different bundler wearing the same config.
 *
 * Vite 8 is Rolldown, and its minifier is Oxc, which runs AFTER `renderChunk` and strips comments
 * while leaving executable code alone. Everything this plugin does about ids has to survive that:
 *
 * - the `//# debugId=` comment is deleted, and put back in `generateBundle`;
 * - the id is still readable in between, from the string literal inside the snippet, which is why
 *   the snippet carries one at all;
 * - and the snippet is APPENDED rather than put at the top, because Oxc rebuilds the chunk's map
 *   from the code it is handed and there is no hook in between to account for an inserted line.
 *
 * Aliased as `vite8` in devDependencies so this and the Vite 7 fixtures can both run. 8.2.2 is
 * current stable, so this is the default path for a new project rather than a future concern.
 */

interface Built {
  chunks: Array<{ name: string; code: string }>;
  maps: Array<{ name: string; mappings: string; debugId: unknown }>;
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-vite8-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/greet.ts'), 'export const greet = (who: string) => `hi ${who}`;\n', 'utf8');
  await writeFile(join(dir, 'src/lazy.ts'), 'export const answer = () => 42;\n', 'utf8');
  await writeFile(
    join(dir, 'src/main.ts'),
    "import { greet } from './greet.ts';\n" +
      "console.log(greet('world'));\n" +
      "globalThis.addEventListener('click', () => { void import('./lazy.ts'); });\n",
    'utf8',
  );

  return dir;
}

async function run(root: string, outDir: string, withPlugin: boolean): Promise<Built> {
  const { build } = await import('vite8');

  await build({
    root,
    logLevel: 'silent',
    configFile: false,
    plugins: withPlugin
      ? [vinktar({ uploadSourcemaps: false, silent: true, deleteSourcemapsAfterUpload: false }) as never]
      : [],
    build: {
      outDir,
      ...(withPlugin ? {} : { sourcemap: 'hidden' as const }),
      rollupOptions: { input: join(root, 'src/main.ts') },
    },
  });

  const assets = join(root, outDir, 'assets');
  const chunks: Built['chunks'] = [];
  const maps: Built['maps'] = [];

  for (const name of (await readdir(assets)).sort()) {
    const body = await readFile(join(assets, name), 'utf8');
    if (name.endsWith('.map')) {
      const parsed = JSON.parse(body) as { mappings?: string; debugId?: unknown };
      maps.push({ name, mappings: parsed.mappings ?? '', debugId: parsed.debugId });
    } else if (name.endsWith('.js')) {
      chunks.push({ name, code: body });
    }
  }

  return { chunks, maps };
}

describe('the vite plugin, on vite 8 (rolldown)', () => {
  it('keeps the id readable after a minifier that deletes comments', async () => {
    const root = await project();
    const { chunks } = await run(root, 'dist', true);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    for (const chunk of chunks) {
      // The registration itself, which no minifier removes because it is executable code.
      expect(chunk.code, `${chunk.name} lost the snippet`).toContain(REGISTRY_GLOBAL);
      // The durable copy of the id: a string literal inside that code. Without it the uploader
      // read no id here, derived a fresh one from the minified bytes, and filed the map under an
      // id no stack frame would ever report.
      expect(chunk.code, `${chunk.name} lost the marker`).toContain(MARKER_GLOBAL);
      expect(existingDebugId(chunk.code)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // And the comment, put back after the minifier took it, because every other tool reads that.
      expect(chunk.code, `${chunk.name} has no debugId comment`).toContain('//# debugId=');
    }
  });

  /**
   * The snippet is APPENDED here, not prepended, and the map is left exactly as Rolldown made it.
   *
   * Rolldown's Oxc minifier runs after every `renderChunk` hook and rebuilds the chunk's map from
   * the code it is handed, composed against a base that knows nothing about a line this plugin
   * inserted — so a prepend there does not shift the map, it destroys it. Measured before this
   * was fixed: the first segment of a Vite 8 chunk pointed at generated column 1, which is the
   * middle of the injected IIFE. There is no hook between the two steps in which to correct it.
   *
   * So the assertion is that the map is UNTOUCHED: byte for byte what a build without the plugin
   * produced.
   */
  it('leaves the map exactly as the bundler made it, because it appends here', async () => {
    const root = await project();
    const stamped = await run(root, 'dist-with', true);
    const plain = await run(root, 'dist-without', false);

    expect(stamped.maps.length).toBeGreaterThanOrEqual(2);
    expect(stamped.maps.map((map) => map.mappings).sort()).toEqual(plain.maps.map((map) => map.mappings).sort());

    for (const map of stamped.maps) expect(map.debugId).toMatch(/^[0-9a-f]{8}-/);
  });
});
