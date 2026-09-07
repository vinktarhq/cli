import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { existingDebugId, REGISTRY_GLOBAL } from '../src/debug-id.js';
import { vinktarRollup } from '../src/bundler/rollup.js';
import { vinktarEsbuild } from '../src/bundler/esbuild.js';

/**
 * One fixture, two bundlers, one assertion: every emitted chunk carries a debug id in its final
 * bytes, and the runtime registry the SDK reads is in there with it.
 *
 * These are real builds. A plugin for a bundler nobody ever ran it against is a plugin that
 * compiles, and the failures in this area are never type errors — they are hook-ordering
 * (a minifier eating the comment) and asset-API details, which only a build shows.
 *
 * Rollup and esbuild only, and they live in the FAST suite because both run on Node 18. Vite,
 * webpack and rspack need Node 20.19 or newer, so their fixtures are in `test/bundlers/` and run
 * on a narrower matrix — see `test:bundlers`.
 *
 * Uploads are off throughout: `uploadSourcemaps: false` keeps every one of these offline.
 */

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-bundlers-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/greet.js'), 'export const greet = (who) => `hi ${who}`;\n', 'utf8');
  await writeFile(
    join(dir, 'src/main.js'),
    "import { greet } from './greet.js';\nconsole.log(greet('world'));\n",
    'utf8',
  );

  return dir;
}

async function scripts(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (name.isFile() && name.name.endsWith('.js')) {
      found.push(await readFile(join(name.parentPath ?? dir, name.name), 'utf8'));
    }
  }

  return found;
}

/** Every `.map` under a directory, keyed by the chunk it belongs to. */
async function maps(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.map')) continue;
    const body = JSON.parse(await readFile(join(entry.parentPath ?? dir, entry.name), 'utf8')) as {
      mappings?: string;
    };
    found[entry.name.replace(/-[A-Za-z0-9_]+\.js\.map$/, '.js.map')] = body.mappings ?? '';
  }

  return found;
}

/**
 * The map must gain exactly one empty group, at the line the snippet took, and nothing else.
 *
 * A map that is one line out is worse than no map: every frame resolves, to its neighbour, and
 * nobody doubts a source map that answered.
 */
function expectShifted(stamped: Record<string, string>, plain: Record<string, string>): void {
  expect(Object.keys(stamped).sort()).toEqual(Object.keys(plain).sort());
  expect(Object.keys(stamped).length).toBeGreaterThan(0);

  for (const [name, mappings] of Object.entries(stamped)) {
    expect(mappings, `${name} was not shifted`).toBe(`;${plain[name]}`);
  }
}

function expectStamped(codes: string[]): void {
  expect(codes.length).toBeGreaterThan(0);
  for (const code of codes) {
    expect(existingDebugId(code)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // The comment is for the uploader; the registry is what the SDK reads at capture time. A
    // chunk with one and not the other resolves nothing.
    expect(code).toContain(REGISTRY_GLOBAL);
  }
}

describe('the bundler plugins', () => {
  it(
    'stamps a rollup build',
    async () => {
      const root = await project();
      const { rollup } = await import('rollup');

      const build = await rollup({
        input: join(root, 'src/main.js'),
        plugins: [vinktarRollup({ uploadSourcemaps: false, silent: true })],
      });
      await build.write({ dir: join(root, 'dist'), format: 'es', sourcemap: 'hidden' });
      await build.close();

      expectStamped(await scripts(join(root, 'dist')));
    },
    60_000,
  );

  it(
    'leaves a rollup map exactly one line out of step, and registers the id when the chunk runs',
    async () => {
      const root = await project();
      const { rollup } = await import('rollup');

      const build = async (stamped: boolean, out: string): Promise<string> => {
        const bundle = await rollup({
          input: join(root, 'src/main.js'),
          plugins: stamped ? [vinktarRollup({ uploadSourcemaps: false, silent: true })] : [],
        });
        await bundle.write({ dir: join(root, out), format: 'es', sourcemap: 'hidden' });
        await bundle.close();

        return join(root, out);
      };

      const stamped = await build(true, 'with');
      const plain = await build(false, 'without');

      expectShifted(await maps(stamped), await maps(plain));

      // And the whole point of the snippet: running the chunk puts its id in the registry the SDK
      // reads, keyed on a stack whose bottom frame is the chunk's own location.
      const registry = (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] as
        | Record<string, string>
        | undefined;
      const before = Object.keys(registry ?? {}).length;

      await import(pathToFileURL(join(stamped, 'main.js')).href);

      const after = (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] as Record<string, string>;
      expect(Object.keys(after).length).toBe(before + 1);
      const key = Object.keys(after).at(-1)!;
      expect(key).toContain('main.js');
      expect(await readFile(join(stamped, 'main.js'), 'utf8')).toContain(after[key]!);
    },
    60_000,
  );

  it(
    'stamps an esbuild build, after minification',
    async () => {
      const root = await project();
      const esbuild = await import('esbuild');

      await esbuild.build({
        entryPoints: [join(root, 'src/main.js')],
        bundle: true,
        minify: true,
        format: 'esm',
        sourcemap: true,
        metafile: true,
        outdir: join(root, 'dist'),
        plugins: [vinktarEsbuild({ uploadSourcemaps: false, silent: true })],
      });

      expectStamped(await scripts(join(root, 'dist')));
    },
    60_000,
  );

  it(
    'leaves an esbuild map exactly one line out of step',
    async () => {
      const root = await project();
      const esbuild = await import('esbuild');

      const build = async (stamped: boolean, out: string): Promise<string> => {
        await esbuild.build({
          entryPoints: [join(root, 'src/main.js')],
          bundle: true,
          minify: true,
          format: 'esm',
          sourcemap: true,
          metafile: true,
          outdir: join(root, out),
          plugins: stamped ? [vinktarEsbuild({ uploadSourcemaps: false, silent: true })] : [],
        });

        return join(root, out);
      };

      expectShifted(await maps(await build(true, 'ewith')), await maps(await build(false, 'ewithout')));
    },
    60_000,
  );
});
