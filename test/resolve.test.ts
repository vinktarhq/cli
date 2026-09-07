import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rollup } from 'rollup';

import { vinktarRollup } from '../src/bundler/rollup.js';
import { resolvePosition } from '../src/commands/resolve.js';

/**
 * "Would this frame resolve, and to what" is the question everyone actually has, and before this
 * command the only way to answer it was to cause a real error in production and look at what came
 * back. These build a real bundle and ask.
 */

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-resolve-'));
  await writeFile(
    join(dir, 'main.js'),
    'export function boom(who) {\n  throw new Error(`no ${who}`);\n}\n\nboom("thanks");\n',
    'utf8',
  );

  return dir;
}

async function bundle(root: string, stamped: boolean): Promise<{ code: string; map: string }> {
  const build = await rollup({
    input: join(root, 'main.js'),
    plugins: stamped ? [vinktarRollup({ uploadSourcemaps: false, silent: true })] : [],
  });
  await build.write({ dir: join(root, stamped ? 'with' : 'without'), format: 'es', sourcemap: 'hidden' });
  await build.close();

  const out = join(root, stamped ? 'with' : 'without');

  return { code: join(out, 'main.js'), map: join(out, 'main.js.map') };
}

describe('resolving a position locally', () => {
  it(
    'lands on the same original position as the unstamped build, one generated line lower',
    async () => {
      const root = await project();
      const stamped = await bundle(root, true);
      const plain = await bundle(root, false);

      // The generated line the throw is on differs by exactly the line the snippet took.
      const before = await resolvePosition(plain.map, 2, 3);
      const after = await resolvePosition(stamped.map, 3, 3);

      expect(before.position).not.toBeNull();
      expect(after.position?.line).toBe(before.position!.line);
      expect(after.position?.column).toBe(before.position!.column);
      expect(after.position?.source).toContain('main.js');
    },
    60_000,
  );

  it(
    'prints the source line and its neighbours, and the map\'s debug id',
    async () => {
      const root = await project();
      const stamped = await bundle(root, true);

      const found = await resolvePosition(stamped.map, 3, 3);

      expect(found.debugId).toMatch(/^[0-9a-f]{8}-/);
      expect(found.position?.text).toContain('throw new Error');
      expect(found.context.some((entry) => entry.here)).toBe(true);
    },
    60_000,
  );

  it('says nothing resolves rather than inventing a position', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-resolve-'));
    const path = join(dir, 'a.js.map');
    await writeFile(path, '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}', 'utf8');

    const found = await resolvePosition(path, 99, 1);

    expect(found.position).toBeNull();
    expect(found.warnings.join('\n')).toContain('may belong to a different build');
  });

  it('says an empty map resolves nothing, which is a different problem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-resolve-'));
    const path = join(dir, 'a.js.map');
    await writeFile(path, '{"version":3,"sources":[],"mappings":""}', 'utf8');

    expect((await resolvePosition(path, 1, 1)).warnings.join('\n')).toContain('no mappings');
  });

  /**
   * The LAST segment at or before the column, not the nearest.
   *
   * A source map names where each run of generated code starts, so a column in the middle of a run
   * belongs to the run that began before it. Searching for the closest instead resolves the second
   * half of every minified line to whatever comes next — which looks plausible and is wrong.
   */
  it('takes the segment that starts before the column, not the nearest one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-resolve-'));
    const path = join(dir, 'a.js.map');
    // Two segments on generated line 0: column 0 → source line 0, column 10 → source line 5.
    // Written out by hand because the point is the lookup rule, not a bundler's output.
    await writeFile(
      path,
      JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA,UAKA' }),
      'utf8',
    );

    expect((await resolvePosition(path, 1, 5))?.position?.line).toBe(1);
    expect((await resolvePosition(path, 1, 40))?.position?.line).toBe(6);
  });
});
