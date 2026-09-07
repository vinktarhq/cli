import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { existingDebugId, REGISTRY_GLOBAL } from '../../src/debug-id.js';
import { vinktarRspack } from '../../src/bundler/rspack.js';

/**
 * rspack, built for real.
 *
 * It was claimed as supported on the grounds that rspack reimplements webpack's plugin API, and
 * that claim had never been tested against an actual rspack build. "Reimplements" covers a lot of
 * ground: the stage constants, `compilation.getAsset`, `compilation.updateAsset` and the shape of
 * `compiler.webpack.sources` all have to line up, and the plugin reaches for every one of them.
 */

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-rspack-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/greet.js'), 'export const greet = (who) => `hi ${who}`;\n', 'utf8');
  await writeFile(
    join(dir, 'src/main.js'),
    "import { greet } from './greet.js';\nconsole.log(greet('world'));\n",
    'utf8',
  );

  return dir;
}

async function build(root: string, out: string, stamped: boolean): Promise<string> {
  const { rspack } = await import('@rspack/core');
  const path = join(root, out);

  await new Promise<void>((resolve, reject) => {
    rspack(
      {
        mode: 'production',
        entry: join(root, 'src/main.js'),
        devtool: 'hidden-source-map',
        output: { path, filename: 'main.js' },
        plugins: stamped ? [new vinktarRspack({ uploadSourcemaps: false, silent: true })] : [],
      },
      (error, stats) => {
        if (error) return reject(error);
        if (stats?.hasErrors() === true) return reject(new Error(stats.toString()));
        resolve();
      },
    );
  });

  return path;
}

async function read(dir: string): Promise<{ code: string; mappings: string }> {
  const names = await readdir(dir);
  const code = await readFile(join(dir, names.find((name) => name.endsWith('.js'))!), 'utf8');
  const map = names.find((name) => name.endsWith('.map'));

  return {
    code,
    mappings: map === undefined ? '' : (JSON.parse(await readFile(join(dir, map), 'utf8')) as { mappings: string }).mappings,
  };
}

describe('the rspack plugin', () => {
  it('stamps a chunk and leaves its map exactly one line out of step', async () => {
    const root = await project();
    const stamped = await read(await build(root, 'with', true));
    const plain = await read(await build(root, 'without', false));

    expect(existingDebugId(stamped.code)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // The comment is for the uploader; the registry is what the SDK reads at capture time. A
    // chunk with one and not the other resolves nothing.
    expect(stamped.code).toContain(REGISTRY_GLOBAL);

    // The map is corrected in the same `processAssets` stage as the chunk, from the same bytes.
    expect(stamped.mappings).toBe(`;${plain.mappings}`);
  });

  it('accounts for the snippet in the content hash, so the filename still describes the file', async () => {
    const root = await project();

    const names = async (out: string, stamped: boolean): Promise<string[]> => {
      const path = await new Promise<string>((resolve, reject) => {
        void (async () => {
          const { rspack } = await import('@rspack/core');
          const target = join(root, out);
          rspack(
            {
              mode: 'production',
              entry: join(root, 'src/main.js'),
              devtool: 'hidden-source-map',
              output: { path: target, filename: 'main.[contenthash].js' },
              plugins: stamped ? [new vinktarRspack({ uploadSourcemaps: false, silent: true })] : [],
            },
            (error, stats) => {
              if (error) return reject(error);
              if (stats?.hasErrors() === true) return reject(new Error(stats.toString()));
              resolve(target);
            },
          );
        })();
      });

      return (await readdir(path)).filter((name) => name.endsWith('.js'));
    };

    // Injecting at OPTIMIZE_HASH means the content hash covers the snippet. Later, and these names
    // would match while the bytes differed — the state that makes a service worker serve a stale
    // chunk forever.
    expect(await names('hwith', true)).not.toEqual(await names('hwithout', false));
  });
});
