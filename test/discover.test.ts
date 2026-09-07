import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { discover, isEmptyMap } from '../src/discover.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-discover-'));

  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }

  return dir;
}

const MAP = '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}';

describe('finding the map for a chunk', () => {
  it('asks the chunk before guessing a sibling', async () => {
    // A build with `sourcemapFileNames`, webpack's `sourceMapFilename`, or any output that puts
    // maps in their own directory has no `<file>.map` sibling at all — so guessing alone found
    // nothing, uploaded nothing, and said nothing.
    const dir = await fixture({
      'js/app.js': 'x();\n//# sourceMappingURL=../maps/app.map\n',
      'maps/app.map': MAP,
    });

    const { artifacts } = await discover(dir);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.map).toBe(join(dir, 'maps/app.map'));
  });

  it('falls back to the sibling when the chunk names nothing', async () => {
    const dir = await fixture({ 'app.js': 'x();\n', 'app.js.map': MAP });

    expect((await discover(dir)).artifacts[0]!.map).toBe(join(dir, 'app.js.map'));
  });

  it('strips the query and fragment a cache-busting build appends', async () => {
    const dir = await fixture({
      'app.js': 'x();\n//# sourceMappingURL=app.js.map?v=2#x\n',
      'app.js.map': MAP,
    });

    expect((await discover(dir)).artifacts[0]!.map).toBe(join(dir, 'app.js.map'));
  });

  it('takes the LAST reference, because a concatenated bundle carries its inputs\' comments', async () => {
    const dir = await fixture({
      'app.js': 'a();\n//# sourceMappingURL=old.map\nb();\n//# sourceMappingURL=app.js.map\n',
      'old.map': MAP,
      'app.js.map': MAP,
    });

    const app = (await discover(dir)).artifacts.find((entry) => entry.relative === 'app.js');
    expect(app!.map).toBe(join(dir, 'app.js.map'));
  });

  it('ignores a remote URL instead of joining it to the chunk\'s directory', async () => {
    // Joining produced paths like `dist/https:/cdn.example.com/app.js.map`, which exist nowhere.
    const dir = await fixture({
      'app.js': 'x();\n//# sourceMappingURL=https://cdn.example.com/app.js.map\n',
      'app.js.map': MAP,
    });

    expect((await discover(dir)).artifacts[0]!.map).toBe(join(dir, 'app.js.map'));
  });

  it('warns about an inline map rather than uploading the chunk without one', async () => {
    const dir = await fixture({ 'app.js': 'x();\n//# sourceMappingURL=data:application/json;base64,e30=\n' });

    const { artifacts, warnings } = await discover(dir);

    expect(artifacts[0]!.map).toBeNull();
    expect(warnings.join('\n')).toContain('inline source map');
  });

  it('refuses a map that two chunks both claim, and says which', async () => {
    // Two chunks pointing at one map is not one map serving two chunks: it is a stale reference or
    // a copied file. Writing a debug id into it makes the last writer win, and then the id in the
    // map disagrees with the id in every chunk but one.
    const dir = await fixture({
      'a.js': 'a();\n//# sourceMappingURL=shared.map\n',
      'b.js': 'b();\n//# sourceMappingURL=shared.map\n',
      'shared.map': MAP,
    });

    const { artifacts, warnings } = await discover(dir);

    expect(artifacts.every((entry) => entry.map === null)).toBe(true);
    expect(warnings.join('\n')).toContain('claimed by 2 chunks');
  });

  it('gives a contested map to the chunk that actually names it', async () => {
    const dir = await fixture({
      'a.js': 'a();\n//# sourceMappingURL=b.js.map\n',
      'b.js': 'b();\n',
      'b.js.map': MAP,
    });

    const { artifacts } = await discover(dir);
    const owner = artifacts.find((entry) => entry.map !== null);

    expect(owner!.relative).toBe('a.js');
  });
});

describe('walking the output', () => {
  it('follows a symlinked chunk, which readdir reports as neither file nor directory', async () => {
    const dir = await fixture({ 'real/app.js': 'x();\n', 'real/app.js.map': MAP });
    await mkdir(join(dir, 'linked'), { recursive: true });
    await symlink(join(dir, 'real/app.js'), join(dir, 'linked/app.js'));
    await symlink(join(dir, 'real/app.js.map'), join(dir, 'linked/app.js.map'));

    const { artifacts } = await discover(dir);

    expect(artifacts.map((entry) => entry.relative).sort()).toEqual(['linked/app.js', 'real/app.js']);
  });

  it('does not walk a directory twice through a loop', async () => {
    const dir = await fixture({ 'app.js': 'x();\n', 'app.js.map': MAP });
    await symlink(dir, join(dir, 'self'));

    const { artifacts } = await discover(dir);

    expect(artifacts).toHaveLength(1);
  });

  it('uses forward slashes, because a URL is not a Windows path', async () => {
    const dir = await fixture({ 'nested/deep/app.js': 'x();\n', 'nested/deep/app.js.map': MAP });

    expect((await discover(dir)).artifacts[0]!.relative).toBe('nested/deep/app.js');
  });
});

/**
 * "Empty" means the MAP is empty and never that the code is short.
 *
 * Skipping chunks under a size threshold would be the wrong rule: a small single-page entry chunk
 * is real code whose frames matter.
 */
describe('an empty map', () => {
  it('is one with neither mappings nor sources', () => {
    expect(isEmptyMap('{"version":3,"sources":[],"mappings":""}')).toBe(true);
    expect(isEmptyMap('{"version":3,"sections":[]}')).toBe(true);
  });

  it('is not one that merely resolves little', () => {
    expect(isEmptyMap('{"version":3,"sources":["a.ts"],"mappings":""}')).toBe(false);
    expect(isEmptyMap('{"version":3,"sources":[],"mappings":"AAAA"}')).toBe(false);
    expect(isEmptyMap('not json')).toBe(false);
  });
});
