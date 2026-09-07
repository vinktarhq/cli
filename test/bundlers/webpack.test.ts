import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { existingDebugId, REGISTRY_GLOBAL } from '../../src/debug-id.js';
import { vinktarWebpack } from '../../src/bundler/webpack.js';

/**
 * webpack, for real, because everything that goes wrong here is an asset-API detail.
 *
 * In the slow suite: webpack 5.110 needs Node 20.19 or newer, and the fast suite still runs the
 * whole 18–24 matrix.
 */

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-webpack-'));
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
    expect(code).toContain(REGISTRY_GLOBAL);
  }
}

describe('the webpack plugin', () => {
  it(
    'stamps a webpack build at the stage that still owns the hash',
    async () => {
      const root = await project();
      const { default: webpack } = await import('webpack');

      await new Promise<void>((resolve, reject) => {
        webpack(
          {
            mode: 'production',
            entry: join(root, 'src/main.js'),
            devtool: 'hidden-source-map',
            output: { path: join(root, 'dist'), filename: 'main.[contenthash].js' },
            plugins: [new vinktarWebpack({ uploadSourcemaps: false, silent: true })],
          },
          (error, stats) => {
            if (error) return reject(error);
            if (stats?.hasErrors() === true) return reject(new Error(stats.toString()));
            resolve();
          },
        );
      });

      expectStamped(await scripts(join(root, 'dist')));
    },
    120_000,
  );

  it(
    'gives webpack a filename whose hash still describes the file',
    async () => {
      const root = await project();
      const { default: webpack } = await import('webpack');

      const run = async (stamped: boolean): Promise<string[]> => {
        const out = join(root, stamped ? 'with' : 'without');
        await new Promise<void>((resolve, reject) => {
          webpack(
            {
              mode: 'production',
              entry: join(root, 'src/main.js'),
              devtool: 'hidden-source-map',
              output: { path: out, filename: 'main.[contenthash].js' },
              plugins: stamped ? [new vinktarWebpack({ uploadSourcemaps: false, silent: true })] : [],
            },
            (error, stats) => {
              if (error) return reject(error);
              if (stats?.hasErrors() === true) return reject(new Error(stats.toString()));
              resolve();
            },
          );
        });

        return (await readdir(out)).filter((name) => name.endsWith('.js'));
      };

      const [withPlugin, withoutPlugin] = [await run(true), await run(false)];

      // Injecting at OPTIMIZE_HASH means the content hash accounts for the snippet. If the plugin
      // ran later, these names would match while the bytes differed — which is the state that
      // makes a service worker serve a stale chunk forever.
      expect(withPlugin).not.toEqual(withoutPlugin);
    },
    120_000,
  );

  it(
    'leaves a webpack map exactly one line out of step',
    async () => {
      const root = await project();
      const { default: webpack } = await import('webpack');

      const build = async (stamped: boolean, out: string): Promise<string> => {
        const path = join(root, out);
        await new Promise<void>((resolve, reject) => {
          webpack(
            {
              mode: 'production',
              entry: join(root, 'src/main.js'),
              devtool: 'hidden-source-map',
              output: { path, filename: 'main.js' },
              plugins: stamped ? [new vinktarWebpack({ uploadSourcemaps: false, silent: true })] : [],
            },
            (error, stats) => {
              if (error) return reject(error);
              if (stats?.hasErrors() === true) return reject(new Error(stats.toString()));
              resolve();
            },
          );
        });

        return path;
      };

      // The map is corrected in the same `processAssets` stage as the chunk, from the same bytes:
      // a fix in a later hook would land after webpack had already hashed and written it.
      expectShifted(await maps(await build(true, 'wwith')), await maps(await build(false, 'wwithout')));
    },
    120_000,
  );
});
